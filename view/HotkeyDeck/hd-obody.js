'use strict';
/* ============================ HDObody — the body on the F7 card ============================ *
 *
 *  Rober, 2026-10-15, circling the empty space right of the Equipped tiles:
 *  "carve out this little space to show the name of the obody body they are
 *  using if they are 3ba or UBE, and a button to change it opens obody picker".
 *
 *  panel(subject) -> the right-hand column of the Equipped box: which body she
 *  is (UBE / 3BA / Male, from her race — see src/obody_bridge.h), the OBody
 *  preset she wears, and "Change body…", which opens a centred, searchable
 *  popout of every preset OBody offers HER (its own GetAllPossiblePresets — the
 *  female or male set). Picking one assigns it through OBody's own
 *  AssignPresetToActor; the panel then shows what OBody holds afterwards.
 *
 *  Bridge: request obReq {op:'get'|'list'|'set', formId, preset} -> reply
 *  obState (response-style: this module always asks first, so hd-boot needs no
 *  STUB_FNS entry). Replies patch the panel IN PLACE — the quick card repaints
 *  constantly, and a reply that re-rendered the card would ask again (the
 *  fdEquipped loop followers-pane.js warns about).
 *
 *  Keyboard: the popout is a modal popout under app.js's popout-modal-escape
 *  contract (isOpen / onKey / close + hdPopoutCapture), like the Room-ban picker.
 *  Marker: obody-panel (view identity).
 * =========================================================================================== */
(function () {
  var ASK_GAP = 4000;      // ms: one get per person per paint burst
  var LIST_CAP = 150;      // rows drawn at once; the search narrows the rest

  var cache = {};          // hex id -> last obState envelope (op get/set)
  var asked = {};          // hex id -> ms of the last get
  var pick = null;         // the open popout: { id, name, back, input, list, presets, current, busy, status }

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  function send(obj) {
    if (typeof window.toGame === 'function') window.toGame('obReq', JSON.stringify(obj));
  }

  /* The roster speaks "0x…" hex; the crosshair target's id is a NUMBER. */
  function hexId(v) {
    if (typeof v === 'number') return v ? '0x' + (v >>> 0).toString(16).toUpperCase() : '';
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^0x[0-9a-f]+$/i.test(s)) return '0x' + s.slice(2).replace(/^0+(?=.)/, '').toUpperCase();
    if (/^\d+$/.test(s)) return '0x' + (Number(s) >>> 0).toString(16).toUpperCase();
    if (/^[0-9a-f]+$/i.test(s)) return '0x' + s.replace(/^0+(?=.)/, '').toUpperCase();
    return '';
  }
  function keyOf(env) { return hexId(env && (env.asked != null ? env.asked : env.formId)); }

  function ask(id, force) {
    if (!id) return;
    var now = Date.now();
    if (!force && asked[id] && now - asked[id] < ASK_GAP) return;
    asked[id] = now;
    send({ op: 'get', formId: id });
  }

  /* ------------------------------------------------------------- the panel -- */

  function kindChip(body) {
    if (!body || !body.label) return null;
    var tip = body.kind === 'ube' ? 'UBE body — she wears one of UBE’s races'
      : body.kind === '3ba' ? 'CBBE 3BA body'
      : 'Male body (OBody’s male presets)';
    return el('span', { class: 'fq-obody-kind k-' + body.kind, title: tip + (body.race ? '\n' + body.race : '') }, body.label);
  }

  function fill(node, env, name) {
    node.textContent = '';
    var id = node.getAttribute('data-fid');
    node.append(el('div', { class: 'fq-obody-top' },
      el('span', { class: 'fq-obody-cap' }, 'Body'),
      env ? kindChip(env.body) : null));
    if (!env) {
      node.append(el('div', { class: 'fq-obody-name wait' }, 'Reading OBody…'));
      return;
    }
    if (env.missing) {
      node.classList.add('off');
      node.append(el('div', { class: 'fq-obody-note' }, env.msg || 'OBody NG isn’t loaded.'));
      return;
    }
    if (!env.ok && env.preset == null) {
      node.append(el('div', { class: 'fq-obody-note' }, env.msg || 'Could not read her body.'));
      return;
    }
    var preset = String(env.preset || '');
    node.append(el('div', {
      class: 'fq-obody-name' + (preset ? '' : ' none'),
      title: preset ? 'OBody preset: ' + preset : 'OBody has not given ' + name + ' a preset yet',
    }, preset || 'No preset yet'));
    node.append(el('button', {
      class: 'fq-obody-change', type: 'button',
      title: 'Pick ' + name + '’s OBody preset — searchable',
      onClick: function (e) { e.stopPropagation(); open(id, name, env.body); },
    }, 'Change body…'));
  }

  /* subject: { formId (hex string or number; '' = the crosshair NPC), name }.
     Returns the column, or null when OBody has said she is not a person. */
  function panel(subject) {
    var id = hexId(subject && subject.formId);
    var name = (subject && subject.name) || 'them';
    var env = id ? cache[id] : null;
    if (env && env.applies === false) return null;
    var node = el('div', { class: 'fq-obody', 'data-fid': id, 'data-name': name });
    fill(node, env, name);
    if (id) ask(id, false);
    return node;
  }

  /* Patch every drawn panel for this person, in place. */
  function repaint(id) {
    var env = cache[id];
    var nodes = document.querySelectorAll('.fq-obody[data-fid="' + id + '"]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (env && env.applies === false) { n.remove(); continue; }
      n.classList.remove('off');
      fill(n, env, n.getAttribute('data-name') || 'them');
    }
  }

  /* ------------------------------------------------------------ the popout -- */

  function claim() { if (typeof window.hdPopoutCapture === 'function') window.hdPopoutCapture(); }

  function close() {
    if (!pick) return;
    var back = pick.back;
    pick = null;
    try { back.remove(); } catch (e) {}
    claim();
  }

  function isOpen() { return !!pick; }

  /* app.js asks this BEFORE its palette-close Escape. Escape closes the
     popout (or clears a typed search first); every other key belongs to the
     search box and goes no further. */
  function onKey(e) {
    if (!pick) return false;
    if (e && (e.key === 'Escape' || e.code === 'Escape')) {
      if (pick.input && pick.input.value) { pick.input.value = ''; renderList(); return true; }
      close();
      return true;
    }
    if (pick.input && document.activeElement !== pick.input && e && e.key && e.key.length === 1 &&
        !e.ctrlKey && !e.altKey) {
      try { pick.input.focus(); } catch (err) {}
    }
    return false;
  }

  function open(id, name, body) {
    close();
    var input = el('input', {
      class: 'obd-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search presets… (Enter takes the top hit)',
    });
    var list = el('div', { class: 'obd-list', role: 'listbox' });
    var status = el('div', { class: 'obd-status', role: 'status', 'aria-live': 'polite' });
    var current = el('div', { class: 'obd-current' });
    var card = el('div', { class: 'obd-card', role: 'dialog', 'aria-label': 'Body preset for ' + name },
      el('div', { class: 'obd-head' },
        el('div', { class: 'obd-title' }, 'Body preset — ' + name),
        el('button', { class: 'obd-x', type: 'button', title: 'Close (Esc)',
          onClick: function (e) { e.stopPropagation(); close(); } }, 'Close')),
      current, input, status, list);
    var back = el('div', { id: 'obd-back', class: 'obd-back',
      onMousedown: function (e) { if (e.target === back) close(); } }, card);
    document.body.append(back);
    pick = { id: id, name: name, body: body, back: back, input: input, list: list, status: status,
             currentEl: current, presets: null, current: (cache[id] && cache[id].preset) || '', busy: '' };
    input.addEventListener('input', renderList);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var top = list.querySelector('.obd-row:not([disabled])');
        if (top) top.click();
      }
    });
    renderCurrent();
    renderList();
    send({ op: 'list', formId: id });
    claim();
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 20);
  }

  function renderCurrent() {
    if (!pick) return;
    var c = pick.currentEl;
    c.textContent = '';
    c.append(kindChip(pick.body) || el('span'),
      el('span', { class: 'obd-current-lbl' }, 'Now'),
      el('b', { class: 'obd-current-name' + (pick.current ? '' : ' none') }, pick.current || 'No preset yet'));
  }

  function matches(name, words) {
    var n = name.toLowerCase();
    for (var i = 0; i < words.length; i++) if (n.indexOf(words[i]) === -1) return false;
    return true;
  }

  function renderList() {
    if (!pick) return;
    var list = pick.list;
    list.textContent = '';
    if (!pick.presets) { list.append(el('div', { class: 'obd-empty' }, 'Asking OBody for her presets…')); return; }
    if (!pick.presets.length) { list.append(el('div', { class: 'obd-empty' }, 'OBody has no presets for this body.')); return; }
    var q = String(pick.input.value || '').trim().toLowerCase();
    var words = q ? q.split(/\s+/) : [];
    var rows = [];
    for (var i = 0; i < pick.presets.length; i++) if (!words.length || matches(pick.presets[i], words)) rows.push(pick.presets[i]);
    /* Her current preset leads, so Enter on an empty search is a no-op pick
       of what she already wears rather than a surprise. */
    var cur = pick.current;
    if (cur) {
      var at = rows.indexOf(cur);
      if (at > 0) { rows.splice(at, 1); rows.unshift(cur); }
    }
    if (!rows.length) { list.append(el('div', { class: 'obd-empty' }, 'No preset matches “' + q + '”.')); return; }
    var shown = Math.min(rows.length, LIST_CAP);
    for (var r = 0; r < shown; r++) list.append(row(rows[r]));
    if (rows.length > shown)
      list.append(el('div', { class: 'obd-more' }, (rows.length - shown) + ' more — type to narrow'));
  }

  function row(name) {
    var on = name === pick.current, busy = name === pick.busy;
    return el('button', {
      class: 'obd-row' + (on ? ' on' : '') + (busy ? ' busy' : ''), type: 'button', role: 'option',
      'aria-selected': on ? 'true' : 'false', title: name,
      disabled: pick.busy ? true : null,
      onClick: function () { choose(name); },
    }, el('span', { class: 'obd-row-name' }, name),
      on ? el('span', { class: 'obd-row-tag' }, 'current') : null,
      busy ? el('span', { class: 'obd-row-tag' }, 'applying…') : null);
  }

  function choose(name) {
    if (!pick || pick.busy) return;
    if (name === pick.current) { close(); return; }
    pick.busy = name;
    pick.status.textContent = 'Giving ' + pick.name + ' “' + name + '”…';
    pick.status.className = 'obd-status';
    renderList();
    send({ op: 'set', formId: pick.id, preset: name });
  }

  /* ------------------------------------------------------------- replies -- */

  window.obState = function (env) {
    if (!env || typeof env !== 'object') return;
    var id = keyOf(env);
    if (!id) return;
    /* Every reply that says something about HER (her preset, OBody missing,
       not a person) updates the panel. A refused `set` still carries the
       preset OBody holds afterwards, so the panel stays truthful. */
    if (env.op === 'get' || env.preset != null || env.missing || env.applies === false) {
      var prev = cache[id];
      cache[id] = {
        ok: env.preset != null ? true : !!env.ok,
        body: env.body || (prev && prev.body) || null,
        preset: env.preset != null ? String(env.preset) : (prev ? prev.preset : null),
        applies: env.applies, missing: !!env.missing, msg: env.msg || '',
      };
      repaint(id);
    }
    if (!pick || pick.id !== id) return;
    if (env.body) pick.body = env.body;
    if (env.preset != null) pick.current = String(env.preset || '');
    if (env.op === 'list') {
      if (env.missing || !env.ok) {
        pick.presets = [];
        pick.status.textContent = env.msg || 'OBody did not answer.';
        pick.status.className = 'obd-status bad';
      } else {
        pick.presets = (env.presets || []).slice().sort(function (a, b) {
          var x = a.toLowerCase(), y = b.toLowerCase();
          return x < y ? -1 : x > y ? 1 : 0;
        });
      }
      renderCurrent();
      renderList();
      return;
    }
    if (env.op === 'set') {
      var wanted = env.wanted || pick.busy;
      pick.busy = '';
      if (env.ok && pick.current === wanted) {
        var who = pick.name;
        close();
        if (typeof window.toast === 'function') window.toast(who + '’s body: ' + wanted);
        return;
      }
      pick.status.textContent = env.msg || 'OBody did not take that preset.';
      pick.status.className = 'obd-status bad';
      renderCurrent();
      renderList();
    }
  };

  window.HDObody = {
    panel: panel, open: open, close: close, isOpen: isOpen, onKey: onKey,
    _hexId: hexId, _cache: cache,
  };
})();
