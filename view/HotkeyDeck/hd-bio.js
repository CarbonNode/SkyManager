/* hd-bio.js — Bio Blocks on the person page (2026-10-04), after SeverActions'
   Bio Blocks page, hooked to CHIM only (Rober: "bio editor could be nice if it
   hooks to chim only").

   A block is a short titled trait ("Raised in the Rift", "Sworn to the Duke")
   kept in ONE library and given to NPCs — by name, to a whole race, or to
   everyone. CHIM renders the blocks that reach the speaking NPC into her
   <character> section on every request (roleplay/chim-prompts/ext/bioblocks),
   so a block changes how she TALKS; her CHIM profile fields are never touched.

   Surfaces:
     HDBio.mount(host, ctx)   the section on the dossier's CHIM page: what is on
                              her, the library to add from (filter-as-you-type,
                              Enter gives the top hit), and the exact text CHIM
                              reads.
     HDBio.openLibrary(ctx)   the whole library as a popout (also an Omni row).
     editor popout            title, tab, text with a byte meter, and who
                              carries it (everyone / races / people).

   Every call rides HDOmni.chimCall → ext/deck_ask/ask.php mode=bio_*.
   Popouts are body-anchored, fill the viewport (bare vh/vw are right, no
   ui-scale), claim hdCapture while up so typing never quick-fires a hotkey,
   and own Escape/Enter through one stack so the topmost answers. */
(function () {
  'use strict';

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach(function (c) {
        if (c == null || c === false) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }
  function coerce(v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } } return v; }
  function bytes(s) { try { return unescape(encodeURIComponent(String(s || ''))).length; } catch (e) { return String(s || '').length; } }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function chip(text, cls) { return el('span', { class: 'pn-chip' + (cls ? ' ' + cls : '') }, text); }
  function low(s) { return String(s || '').toLowerCase(); }
  // The same fold as bio_lib.php's bio_race_key(): "Dark Elf" / "DarkElfRace" / "dunmer" → "darkelf".
  function raceKey(r) {
    var k = low(r).replace(/[^a-z]/g, '');
    if (k.length > 4 && k.slice(-4) === 'race') k = k.slice(0, -4);
    return ({ dunmer: 'darkelf', altmer: 'highelf', bosmer: 'woodelf', orsimer: 'orc' })[k] || k;
  }
  function stop(e) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); e._fdDossierHandled = true; }

  var LIMITS = { title: 80, content: 2000, prompt: 4000 };

  /* ---------------------------------------------------------------- CHIM -- */
  function call(mode, params, cb) {
    if (!window.HDOmni || typeof HDOmni.chimCall !== 'function') { cb({ ok: false, why: 'CHIM is not available in this view.' }); return; }
    var qs = 'mode=' + mode;
    for (var k in params) if (params[k] != null && params[k] !== '') qs += '&' + k + '=' + encodeURIComponent(params[k]);
    HDOmni.chimCall(qs, function (env) {
      env = coerce(env) || {};
      var j = coerce(env.json) || {};
      if (env.ok === false && !j.ok) cb({ ok: false, why: 'CHIM did not answer — it only runs while the game and the CHIM launcher are up.' });
      else if (j.ok === false) cb({ ok: false, why: j.why || j.error || 'CHIM refused that.' });
      else cb(j);
    }, false);
  }

  // The library is shared by every surface; one fetch fills all of them.
  var lib = { data: null, state: 'idle', why: '', at: 0, waiters: [] };
  var listeners = [];
  function changed() { listeners.slice().forEach(function (f) { try { f(); } catch (e) {} }); }
  function loadLibrary(force, done) {
    if (done) lib.waiters.push(done);
    if (lib.state === 'loading') return;
    if (lib.data && !force) { flush(); return; }
    lib.state = 'loading'; changed();
    call('bio_library', {}, function (j) {
      if (j.ok === false) { lib.state = 'error'; lib.why = j.why; }
      else { lib.state = 'ok'; lib.data = j; lib.why = ''; lib.at = Date.now(); if (j.limits) LIMITS = j.limits; }
      flush(); changed();
    });
    function flush() { var w = lib.waiters; lib.waiters = []; w.forEach(function (f) { try { f(); } catch (e) {} }); }
  }
  function blocks() { return (lib.data && lib.data.blocks) || []; }
  function blockByKey(k) { return blocks().filter(function (b) { return b.key === k; })[0] || null; }
  function carriers(b) {
    var bits = [];
    if (b.all) bits.push('everyone');
    (b.races || []).forEach(function (r) { bits.push('every ' + r.label); });
    if ((b.npcs || []).length) bits.push(b.npcs.length <= 3 ? b.npcs.join(', ') : b.npcs.slice(0, 2).join(', ') + ' and ' + (b.npcs.length - 2) + ' more');
    return bits.length ? 'On ' + bits.join(' · ') : 'On no one yet';
  }
  function viaLabel(a, race) {
    return a.via === 'all' ? 'Everyone' : a.via === 'race' ? 'Every ' + (race || 'of her race') : 'Just her';
  }

  /* ------------------------------------------------------- popout stack -- */
  var stack = [];
  function onStackKey(e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') { stop(e); top.close(); return; }
    if (top.onKey && top.onKey(e)) { stop(e); return; }
    // Anything else: the popout is modal. Let it reach a focused text field
    // (no preventDefault, so it types), but never the deck behind us.
    if (e.stopPropagation) e.stopPropagation();
    e._fdDossierHandled = true;
  }
  function pushPop(p) {
    if (!stack.length) {
      if (window.addEventListener) window.addEventListener('keydown', onStackKey, true);
      if (typeof window.toGame === 'function') window.toGame('hdCapture', '1');   // digits must not quick-fire under us
    }
    stack.push(p);
  }
  function popPop(p) {
    var i = stack.indexOf(p);
    if (i !== -1) stack.splice(i, 1);
    if (!stack.length) {
      if (window.removeEventListener) window.removeEventListener('keydown', onStackKey, true);
      if (typeof window.toGame === 'function') window.toGame('hdCapture', '0');
    }
  }
  function popout(cls, label) {
    var back = el('div', { class: 'pn-pop-back pn-bio-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
    var card = el('article', { class: 'pn-bio-pop ' + cls });
    back.appendChild(card);
    var p = { back: back, card: card, onKey: null, onClose: null,
      close: function () {
        if (!back.parentNode) return;
        back.parentNode.removeChild(back); popPop(p);
        if (p.onClose) try { p.onClose(); } catch (e) {}
      } };
    back.addEventListener('mousedown', function (e) { if (e.target === back) p.close(); });
    document.body.appendChild(back);
    pushPop(p);
    return p;
  }
  function popHead(p, title, sub) {
    return el('header', { class: 'pn-bio-pop-head' },
      el('div', null, el('h2', null, title), sub ? el('p', { class: 'pn-bio-pop-sub' }, sub) : null),
      el('button', { type: 'button', class: 'pn-pop-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: function () { p.close(); } }, '×'));
  }

  /* ------------------------------------------------------------- editor -- */
  // block = a library row to edit, or null for a new one. ctx.name (optional)
  // = the person the page is about: a new block can go straight onto her.
  function openEditor(block, ctx, after) {
    ctx = ctx || {};
    var editing = !!block;
    var p = popout('pn-bio-editor', editing ? 'Edit bio block' : 'New bio block');
    var title = el('input', { type: 'text', class: 'pn-bio-input', maxlength: String(LIMITS.title), value: block ? block.title : '',
      placeholder: 'Raised in the Rift', 'aria-label': 'Title' });
    var tab = el('input', { type: 'text', class: 'pn-bio-input', maxlength: '40', value: block ? block.tab : (ctx.tab || 'General'),
      placeholder: 'General', 'aria-label': 'Tab' });
    var text = el('textarea', { class: 'pn-bio-text', rows: '8', 'aria-label': 'What CHIM should know',
      placeholder: 'Write it as a fact about her, in a sentence or three: “You grew up in Riften’s Ratway and still count the exits of every room.”' });
    text.value = block ? block.content : '';
    var meter = el('span', { class: 'pn-bio-meter' });
    var msg = el('p', { class: 'pn-bio-msg', role: 'status' });
    var give = null;
    if (!editing && ctx.name) { give = el('input', { type: 'checkbox', id: 'pn-bio-give' }); give.checked = true; }
    var tabsKnown = ((lib.data && lib.data.tabs) || []).filter(function (t) { return t && t !== tab.value; });
    function paintMeter() {
      var n = bytes(text.value);
      meter.textContent = fmt(n) + ' / ' + fmt(LIMITS.content) + ' bytes';
      meter.className = 'pn-bio-meter' + (n > LIMITS.content ? ' over' : n > LIMITS.content * 0.8 ? ' near' : '');
    }
    text.addEventListener('input', paintMeter); paintMeter();

    // ---- who carries it (an existing block only: a rule needs a key)
    var whoBox = null;
    if (editing) {
      whoBox = el('section', { class: 'pn-bio-who' });
      paintWho();
    }
    function paintWho() {
      if (!whoBox) return;
      var b = blockByKey(block.key) || block;
      whoBox.textContent = '';
      var everyone = el('button', { type: 'button', class: 'pn-bio-toggle' + (b.all ? ' on' : ''), 'aria-pressed': b.all ? 'true' : 'false',
        onClick: function () { rule('all', '', !b.all); } },
        el('b', null, b.all ? 'Everyone carries it' : 'Give it to everyone'),
        el('span', null, 'Every NPC CHIM voices reads it — use this for things that are true of the whole world.'));
      var raceChips = el('div', { class: 'pn-bio-chips' }, (b.races || []).map(function (r) {
        return el('span', { class: 'pn-bio-carrier' }, 'Every ' + r.label,
          el('button', { type: 'button', 'aria-label': 'Stop giving it to every ' + r.label, onClick: function () { rule('race', r.label, false); } }, '×'));
      }));
      var raceFind = el('input', { type: 'search', class: 'pn-bio-input', placeholder: 'Add a race — type to search…', 'aria-label': 'Add a race', autocomplete: 'off' });
      var raceHits = el('div', { class: 'pn-bio-racehits' });
      function paintRaces() {
        raceHits.textContent = '';
        var q = low(raceFind.value).trim();
        if (!q) return;
        var have = (b.races || []).map(function (r) { return r.key; });
        ((lib.data && lib.data.races) || []).filter(function (r) { return have.indexOf(r.key) === -1 && low(r.label).indexOf(q) !== -1; })
          .slice(0, 6).forEach(function (r) {
            raceHits.appendChild(el('button', { type: 'button', class: 'pn-bio-racehit', onClick: function () { rule('race', r.label, true); } },
              r.label, el('span', null, r.count + (r.count === 1 ? ' NPC' : ' NPCs'))));
          });
      }
      raceFind.addEventListener('input', paintRaces);
      raceFind.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { var first = raceHits.querySelector('.pn-bio-racehit'); if (first) first.click(); stop(e); }
      });
      var people = el('div', { class: 'pn-bio-chips' }, (b.npcs || []).length ? b.npcs.map(function (n) {
        return el('span', { class: 'pn-bio-carrier' }, n,
          el('button', { type: 'button', 'aria-label': 'Take it off ' + n, onClick: function () { unapply(n); } }, '×'));
      }) : el('span', { class: 'pn-empty' }, 'No one by name. Give it from a person’s CHIM page.'));
      whoBox.append(
        el('h3', { class: 'pn-bio-sub' }, 'Who carries it'),
        everyone,
        el('div', { class: 'pn-bio-field' }, el('span', { class: 'pn-bio-label' }, 'Races'), raceChips, raceFind, raceHits),
        el('div', { class: 'pn-bio-field' }, el('span', { class: 'pn-bio-label' }, 'People'), people));
    }
    function rule(kind, target, on) {
      say('…', '');
      call('bio_rule', { key: block.key, kind: kind, target: target, on: on ? '1' : '0' }, function (j) {
        if (j.ok === false) { say(j.why, 'err'); return; }
        say(j.message || 'Saved.', 'ok');
        loadLibrary(true, function () { paintWho(); if (after) after(); });
      });
    }
    function unapply(npc) {
      say('…', '');
      call('bio_unapply', { npc: npc, key: block.key }, function (j) {
        if (j.ok === false) { say(j.why, 'err'); return; }
        say(j.message || 'Taken off.', 'ok');
        loadLibrary(true, function () { paintWho(); if (after) after(); });
      });
    }
    function say(t, cls) { msg.textContent = t || ''; msg.className = 'pn-bio-msg' + (cls ? ' ' + cls : ''); }

    var armedDelete = false;
    var del = editing ? el('button', { type: 'button', class: 'pn-act danger', onClick: function () {
      if (!armedDelete) { armedDelete = true; del.textContent = 'Click again to delete it from everyone'; return; }
      say('Deleting…', '');
      call('bio_delete', { key: block.key }, function (j) {
        if (j.ok === false) { say(j.why, 'err'); return; }
        loadLibrary(true, function () { if (after) after(j.message); });
        p.close();
      });
    } }, 'Delete') : null;
    function save() {
      var t = title.value.trim(), c = text.value.trim();
      if (!t) { say('Give it a title.', 'err'); title.focus(); return; }
      if (!c) { say('Write what CHIM should know.', 'err'); text.focus(); return; }
      if (bytes(c) > LIMITS.content) { say('That is ' + fmt(bytes(c)) + ' bytes; keep it under ' + fmt(LIMITS.content) + ' — every block costs tokens on every line she speaks.', 'err'); return; }
      say('Saving to CHIM…', '');
      call('bio_save', { key: editing ? block.key : '', title: t, tab: tab.value.trim() || 'General', content: c }, function (j) {
        if (j.ok === false) { say(j.why, 'err'); return; }
        function done() { loadLibrary(true, function () { if (after) after(j.message); }); p.close(); }
        if (give && give.checked && j.key) call('bio_apply', { npc: ctx.original || ctx.name, key: j.key }, function () { done(); });
        else done();
      });
    }
    p.onKey = function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || document.activeElement === title || document.activeElement === tab)) { save(); return true; }
      return false;
    };
    // (null parts are left out: a real DOM append() would print the word "null")
    [
      popHead(p, editing ? 'Edit “' + block.title + '”' : 'A new bio block',
        editing ? 'Changes reach everyone who carries it on their next line.' : 'A trait CHIM reads as part of whoever carries it. Her own profile stays as it is.'),
      el('div', { class: 'pn-bio-form' },
        el('label', { class: 'pn-bio-field' }, el('span', { class: 'pn-bio-label' }, 'Title'), title),
        el('div', { class: 'pn-bio-field' }, el('label', { class: 'pn-bio-label', 'for': 'pn-bio-tab' }, 'Tab'), tab,
          tabsKnown.length ? el('div', { class: 'pn-bio-chips' }, tabsKnown.map(function (t) {
            return el('button', { type: 'button', class: 'pn-bio-tabpick', onClick: function () { tab.value = t; } }, t);
          })) : null),
        el('div', { class: 'pn-bio-field wide' },
          el('span', { class: 'pn-bio-label' }, 'What CHIM should know', meter), text,
          el('p', { class: 'pn-hint' }, 'Write it to her, as fact: “You…”. Keep it short — CHIM reads every block on every line she speaks.'))),
      whoBox,
      give ? el('label', { class: 'pn-bio-give', 'for': 'pn-bio-give' }, give, el('span', null, 'Give it to ' + ctx.name + ' once it is saved')) : null,
      msg,
      el('footer', { class: 'pn-bio-pop-foot' },
        del || el('span', null),
        el('div', { class: 'pn-acts' },
          el('button', { type: 'button', class: 'pn-act', onClick: function () { p.close(); } }, 'Cancel'),
          el('button', { type: 'button', class: 'pn-act primary', onClick: save }, editing ? 'Save changes' : 'Save to the library')))
    ].forEach(function (part) { if (part) p.card.appendChild(part); });
    tab.id = 'pn-bio-tab';
    try { title.focus(); } catch (e) {}
    return p;
  }

  /* ------------------------------------------------------------ library -- */
  function openLibrary(ctx) {
    ctx = ctx || {};
    var p = popout('pn-bio-library', 'Bio library');
    var q = '', tabSel = '';
    var search = el('input', { type: 'search', class: 'pn-bio-input pn-bio-libsearch', autocomplete: 'off',
      placeholder: 'Search every block — title, words or tab…', 'aria-label': 'Search the library' });
    var tabs = el('div', { class: 'pn-bio-chips pn-bio-libtabs' });
    var list = el('div', { class: 'pn-bio-liblist' });
    var count = el('span', { class: 'pn-bio-pop-sub' });
    search.addEventListener('input', function () { q = low(search.value).trim(); paint(); });
    p.onKey = function (e) {
      if (e.key === 'Enter' && document.activeElement === search) { var first = list.querySelector('.pn-bio-librow'); if (first) first.click(); return true; }
      return false;
    };
    function paint() {
      tabs.textContent = ''; list.textContent = '';
      if (lib.state === 'loading' && !lib.data) { list.appendChild(el('p', { class: 'pn-empty' }, 'Reading the library from CHIM…')); return; }
      if (lib.state === 'error' && !lib.data) { list.appendChild(el('p', { class: 'pn-bio-msg err' }, lib.why)); return; }
      var all = blocks();
      var names = ['All'].concat((lib.data && lib.data.tabs) || []);
      names.forEach(function (t) {
        var on = (t === 'All' && !tabSel) || t === tabSel;
        tabs.appendChild(el('button', { type: 'button', class: 'pn-bio-tabpick' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
          onClick: function () { tabSel = t === 'All' ? '' : t; paint(); } }, t));
      });
      var shown = all.filter(function (b) {
        return (!tabSel || b.tab === tabSel) && (!q || low(b.title + ' ' + b.content + ' ' + b.tab).indexOf(q) !== -1);
      });
      count.textContent = all.length ? (shown.length === all.length ? fmt(all.length) + (all.length === 1 ? ' block' : ' blocks') : fmt(shown.length) + ' of ' + fmt(all.length)) : '';
      if (!all.length) {
        list.appendChild(el('div', { class: 'pn-bio-emptylib' },
          el('p', null, 'The library is empty. A block is a short fact CHIM reads as part of whoever carries it — a past, an oath, a habit, a secret.'),
          el('button', { type: 'button', class: 'pn-act primary', onClick: function () { openEditor(null, ctx, function () { paint(); }); } }, 'Write the first block')));
        return;
      }
      if (!shown.length) { list.appendChild(el('p', { class: 'pn-empty' }, 'No block matches.')); return; }
      shown.forEach(function (b) {
        // Already hers by name, by her race, or because everyone carries it.
        var herRace = raceKey(typeof ctx.race === 'function' ? ctx.race() : ctx.race);
        var byName = ctx.name && (b.npcs || []).some(function (n) { return low(n) === low(ctx.original || ctx.name); });
        var byRule = ctx.name && (b.all || (herRace && (b.races || []).some(function (r) { return r.key === herRace; })));
        var onHer = byName || byRule;
        list.appendChild(el('div', { class: 'pn-bio-libitem' },
          el('button', { type: 'button', class: 'pn-bio-librow', title: 'Edit, or change who carries it',
            onClick: function () { openEditor(blockByKey(b.key) || b, ctx, function () { paint(); }); } },
            el('span', { class: 'pn-bio-librow-head' }, el('b', null, b.title), chip(b.tab)),
            el('span', { class: 'pn-bio-librow-text' }, b.content),
            el('span', { class: 'pn-bio-librow-who' }, carriers(b))),
          ctx.name ? el('button', { type: 'button', class: 'pn-act' + (onHer ? '' : ' primary'), disabled: onHer ? true : null,
            onClick: function () {
              call('bio_apply', { npc: ctx.original || ctx.name, key: b.key }, function (j) {
                loadLibrary(true, function () { paint(); if (ctx.onChange) ctx.onChange(j); });
              });
            } }, byName ? 'On ' + ctx.name : byRule ? (b.all ? 'Everyone has it' : 'Her race has it') : 'Give to ' + ctx.name) : null));
      });
    }
    listeners.push(paint);
    p.onClose = function () { var i = listeners.indexOf(paint); if (i !== -1) listeners.splice(i, 1); };
    p.card.append(
      popHead(p, 'Bio library', 'Traits CHIM reads as part of whoever carries them'),
      el('div', { class: 'pn-bio-libbar' }, search, count,
        el('button', { type: 'button', class: 'pn-act primary', onClick: function () { openEditor(null, ctx, function () { paint(); }); } }, 'New block')),
      tabs, list);
    paint();
    loadLibrary(false, paint);
    try { search.focus(); } catch (e) {}
    return p;
  }

  /* ------------------------------------------------- the person section -- */
  var mounted = [];
  function mount(host, ctx) {
    ctx = ctx || {};
    var name = ctx.name || '', who = ctx.original || name;
    var st = { state: 'loading', data: null, msg: '', cls: '' };
    var query = '';
    var box = el('div', { class: 'pn-bio' });
    host.textContent = '';
    host.appendChild(box);
    var search = el('input', { type: 'search', class: 'pn-bio-input', autocomplete: 'off',
      placeholder: 'Search your library — Enter gives ' + name + ' the top hit', 'aria-label': 'Search the bio library' });
    search.addEventListener('input', function () { query = low(search.value).trim(); paintAdd(); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var first = addList.querySelector('.pn-bio-pick'); if (first) first.click(); stop(e); }
    });
    var onBox = el('div', { class: 'pn-bio-onlist' }), addList = el('div', { class: 'pn-bio-picks' });
    var meter = el('span', { class: 'pn-bio-budget' }), reads = el('div', { class: 'pn-bio-preview' }), msg = el('p', { class: 'pn-bio-msg', role: 'status' });
    var raceName = '';
    function race() { var r = typeof ctx.race === 'function' ? ctx.race() : ctx.race; return r ? String(r) : ''; }

    function refresh() {
      call('bio_npc', { npc: who, race: race() }, function (j) {
        if (j.ok === false) { st.state = st.data ? 'ok' : 'error'; st.msg = j.why; st.cls = 'err'; }
        else { st.state = 'ok'; st.data = j; }
        paint();
      });
    }
    function give(key) {
      say('Giving it to ' + name + '…', '');
      call('bio_apply', { npc: who, key: key }, function (j) {
        if (j.ok === false) { say(j.why, 'err'); return; }
        st.data = j; say(j.message || '', 'ok'); paint(); loadLibrary(true);
      });
    }
    function takeOff(key) {
      say('Taking it off…', '');
      call('bio_unapply', { npc: who, key: key }, function (j) {
        if (j.ok === false) { say(j.why, 'err'); return; }
        st.data = j; say(j.message || '', 'ok'); paint(); loadLibrary(true);
      });
    }
    function say(t, cls) { st.msg = t; st.cls = cls; msg.textContent = t || ''; msg.className = 'pn-bio-msg' + (cls ? ' ' + cls : ''); }
    function after(m) { if (m) say(m, 'ok'); refresh(); }

    function paintOn() {
      onBox.textContent = '';
      var d = st.data;
      if (!d) { onBox.appendChild(el('p', { class: 'pn-empty' }, st.state === 'error' ? '' : 'Asking CHIM what is on ' + name + '…')); return; }
      raceName = d.race || '';
      if (!d.applied.length) {
        onBox.appendChild(el('div', { class: 'pn-bio-none' },
          el('p', null, 'Nothing from your library is on ' + name + ' yet.'),
          el('p', { class: 'pn-hint' }, 'Pick a block on the right, or write a new one. CHIM reads it on her next line.')));
        return;
      }
      d.applied.forEach(function (a) {
        onBox.appendChild(el('article', { class: 'pn-bio-row' },
          el('div', { class: 'pn-bio-row-head' }, el('b', null, a.title), chip(a.tab), chip(viaLabel(a, raceName), a.via === 'npc' ? '' : 'wide')),
          el('p', { class: 'pn-bio-row-text' }, a.content),
          el('div', { class: 'pn-acts' },
            el('button', { type: 'button', class: 'pn-act', onClick: function () { openEditor(blockByKey(a.key) || a, ctx, after); } }, 'Edit'),
            a.via === 'npc'
              ? el('button', { type: 'button', class: 'pn-act', onClick: function () { takeOff(a.key); } }, 'Take it off ' + name)
              : el('span', { class: 'pn-hint' }, a.via === 'all' ? 'Everyone carries this — change it in the library.' : 'Every ' + (raceName || 'one of her race') + ' carries this — change it in the library.'))));
      });
    }
    function paintAdd() {
      addList.textContent = '';
      if (lib.state === 'loading' && !lib.data) { addList.appendChild(el('p', { class: 'pn-empty' }, 'Reading the library…')); return; }
      if (lib.state === 'error' && !lib.data) { addList.appendChild(el('p', { class: 'pn-bio-msg err' }, lib.why)); return; }
      var on = ((st.data && st.data.applied) || []).map(function (a) { return a.key; });
      var all = blocks();
      if (!all.length) {
        addList.appendChild(el('p', { class: 'pn-empty' }, 'Your library is empty. Write the first block — a past, an oath, a habit, a secret.'));
        return;
      }
      var hits = all.filter(function (b) { return on.indexOf(b.key) === -1 && (!query || low(b.title + ' ' + b.content + ' ' + b.tab).indexOf(query) !== -1); });
      if (!hits.length) { addList.appendChild(el('p', { class: 'pn-empty' }, query ? 'No block matches.' : 'Everything in your library is already on ' + name + '.')); return; }
      hits.slice(0, 40).forEach(function (b) {
        addList.appendChild(el('button', { type: 'button', class: 'pn-bio-pick', title: 'Give “' + b.title + '” to ' + name, onClick: function () { give(b.key); } },
          el('span', { class: 'pn-bio-pick-head' }, el('b', null, b.title), chip(b.tab)),
          el('span', { class: 'pn-bio-pick-text' }, b.content)));
      });
      if (hits.length > 40) addList.appendChild(el('p', { class: 'pn-hint' }, (hits.length - 40) + ' more — narrow the search, or open the library.'));
    }
    function paintReads() {
      var d = st.data;
      reads.textContent = '';
      var cap = (d && d.cap) || LIMITS.prompt, used = (d && d.chars) || 0;
      meter.textContent = d ? (d.applied.length ? d.applied.length + (d.applied.length === 1 ? ' block · ' : ' blocks · ') + fmt(used) + ' of ' + fmt(cap) + ' characters' : 'No blocks') : '';
      meter.className = 'pn-bio-budget' + (used > cap * 0.85 ? ' near' : '');
      reads.appendChild(d && d.preview ? el('pre', null, d.preview)
        : el('p', { class: 'pn-empty' }, 'Nothing yet — CHIM reads ' + name + '’s profile alone.'));
    }
    function paint() { paintOn(); paintAdd(); paintReads(); if (st.msg) say(st.msg, st.cls); }

    box.append(
      el('header', { class: 'pn-bio-head' },
        el('div', null,
          el('p', { class: 'pn-bio-intro' }, 'Traits from your library that CHIM reads as part of ' + name + ', every time she speaks. Her profile itself is never changed.')),
        meter),
      el('div', { class: 'pn-bio-cols' },
        el('section', { class: 'pn-bio-col' }, el('h3', { class: 'pn-bio-sub' }, 'On ' + name), onBox),
        el('section', { class: 'pn-bio-col' },
          el('h3', { class: 'pn-bio-sub' }, 'From your library'),
          search, addList,
          el('div', { class: 'pn-acts' },
            el('button', { type: 'button', class: 'pn-act primary', onClick: function () { openEditor(null, ctx, after); } }, 'Write a new block'),
            el('button', { type: 'button', class: 'pn-act', onClick: function () { openLibrary(Object.assign({}, ctx, { onChange: function () { refresh(); } })); } }, 'Open the library')))),
      el('section', { class: 'pn-bio-reads' }, el('h3', { class: 'pn-bio-sub' }, 'What CHIM reads'), reads),
      msg);

    var ctl = { host: host, destroy: function () { var i = listeners.indexOf(paintAdd); if (i !== -1) listeners.splice(i, 1); box.remove(); } };
    listeners.push(paintAdd);
    mounted.push(ctl);
    paint();
    loadLibrary(false, paintAdd);
    refresh();
    return ctl;
  }
  function unmount(root) {
    mounted = mounted.filter(function (c) {
      var inside = !root || root === c.host || (root.contains && root.contains(c.host)) || !c.host.isConnected;
      if (inside) c.destroy();
      return !inside;
    });
  }

  window.HDBio = {
    mount: mount,
    unmount: unmount,
    openLibrary: openLibrary,
    openEditor: openEditor,
    _state: function () { return { lib: lib, stack: stack.length, mounted: mounted.length }; },
    _reset: function () { while (stack.length) stack[stack.length - 1].close(); unmount(null); lib = { data: null, state: 'idle', why: '', at: 0, waiters: [] }; listeners = []; }
  };

  /* Omni: the library, and every block in it, are searchable from anywhere. */
  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'bio',
      label: 'Bio blocks',
      tab: '',
      warm: function () { loadLibrary(false); },
      index: function () {
        var items = [{ label: 'Bio library', detail: 'The traits CHIM reads as part of the NPCs who carry them', kind: 'page',
          keywords: 'bio blocks library traits chim character background personality', run: function () { openLibrary({}); } }];
        blocks().forEach(function (b) {
          items.push({ label: 'Bio block: ' + b.title, detail: b.tab + ' · ' + carriers(b), kind: 'item',
            keywords: 'bio block ' + b.tab + ' ' + b.content, run: function () { openEditor(b, {}, null); } });
        });
        return items;
      }
    });
  }
})();
