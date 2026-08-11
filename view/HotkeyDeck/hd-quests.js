'use strict';

/* ====================================================================== *
 *  NPC Quests modal — the F7 card's 📜 button.
 *
 *  Rober's ask (2026-08-11): "f7 on an npc needs a new button, a quest
 *  button - same idea of the quest tab but a really highly polished list /
 *  searchable list of quests of that npc in a popup modal".
 *
 *  So: the Quests tab's ANSWER, on the surface you are already on. You are
 *  looking at someone, you press F7, and "what is she caught up in" is one
 *  click away instead of a tab switch that re-asks for the crosshair and
 *  loses the card.
 *
 *  Two surfaces, one modal:
 *
 *    LIST    a big search box, scope chips (Hers ⇄ Every quest) and status
 *            filters with live counts, over rows that say the four things
 *            that matter at a glance — is it running, which stage of how
 *            many, which alias holds her, and whether an alias is EMPTY
 *            (the usual real reason a quest is stuck).
 *    DETAIL  aliases with fill state, the whole stage list, objectives,
 *            and the repair verbs — Go to target · Start · Stop ·
 *            Complete · Reset.
 *
 *  WHY THE SCOPE CHIP MATTERS: aliases only resolve while a quest RUNS, so
 *  the NPC lookup structurally cannot see a quest whose alias never filled
 *  — which is exactly the broken quest you are hunting. "Every quest" is
 *  the same free-text search the tab has, reachable without leaving her.
 *
 *  OWNERSHIP: this file owns the surface only. Every fact and every verb is
 *  the EXISTING quest bridge (quest_tools.cpp) — hdQuestList / hdQuestSearch
 *  / hdQuestGet / hdQuestSetStage / hdQuestAction — so there is one
 *  implementation of "fire a stage" and the tab and the modal can never
 *  disagree. The only C++ addition is an optional formId on hdQuestList,
 *  because THIS card's subject may be a picked party member rather than the
 *  crosshair snapshot the tab assumes.
 *
 *  REPLIES ARE SHARED, so this module takes FIRST REFUSAL on them the way
 *  HDOmni does: it only claims a reply it actually asked for, and app.js
 *  hands it the payload before the Quests tab sees it.
 *
 *  Shape: a sibling of the Outfit dock — a root INSIDE #panel, so it
 *  inherits --ui-scale and clips to the deck window. Own sheet
 *  hd-quests.css linked from index.html; NEVER merged into app.css (the
 *  sync_view_frags truncation trap).
 *
 *  Ultralight rules honoured: no prompt()/confirm() (armed two-click),
 *  title= tooltips drawn by app.js's #hd-tip layer, hdCapture claimed while
 *  open so typing a quest name never quick-fires a hotkey.
 * ====================================================================== */

(function () {

  /* Status vocabulary is the engine's, verbatim from QuestTools::StatusOf:
     "running" | "completed" | "inactive". Nothing here invents a state —
     `broken` below is a DERIVED view of "inactive/running with an empty
     required alias", not a fourth engine status. */
  var FILTERS = [
    { id: 'all',     label: 'All',         ic: '≡', title: 'Every quest in the list' },
    { id: 'running', label: 'Running',     ic: '▶', title: 'Started and not finished — the ones actually in play' },
    { id: 'idle',    label: 'Not started', ic: '◇', title: 'Never started, or stopped. Includes quests she is merely NAMED in' },
    { id: 'done',    label: 'Completed',   ic: '✓', title: 'Finished' },
    { id: 'broken',  label: 'Broken',      ic: '⚠', title: 'At least one REQUIRED alias is empty — far more often the reason a quest is stuck than the stage number' },
  ];

  var OBJ_STATE = { 0: 'dormant', 1: 'displayed', 2: 'completed', 3: 'failed' };

  /* Beyond this many stages the grid gets its own typeable jump box. MQ101
     has 125 — hunting for 210 by eye in a wall of numbers is the kind of list
     standing UI rule #4 exists for. */
  var STAGE_SEARCH_AT = 24;

  var S = {
    open: false,
    view: 'list',        // 'list' | 'detail'
    ctx: null,           // what the Followers card handed us (see open())
    scope: 'npc',        // 'npc' (hers) | 'all' (free-text over every quest)
    q: '',               // the search box
    status: 'all',       // one of FILTERS[].id
    sel: 0,              // keyboard cursor into the FILTERED list
    list: null,          // last hdQuests payload we claimed
    listFor: '',         // whose list that is ('' = the all-quests search)
    loading: false,
    detail: null,        // last hdQuestInfo payload we claimed
    detailFor: '',       // its formId, so a late reply for another quest is dropped
    note: '',            // the last verdict (hdQuestResult), shown in place
    noteOk: true,
    armStage: null,      // replaying an EARLIER stage asks twice
    armVerb: '',         // so does Reset
    stageQ: '',          // the stage jump box
    want: { list: false, detail: false, result: false },   // what we asked for
    sig: '',             // last painted signature — see maybeRender()
    fresh: false,
    animFor: '',
  };

  var root = null;
  var searchTimer = 0;

  /* ------------------------------------------------------------ plumbing -- */

  function toGameSafe(fn, arg) {
    if (typeof window.toGame === 'function') window.toGame(fn, arg);
  }

  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'style') n.style.cssText = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      if (Array.isArray(kid)) {
        kid.forEach(function (c) {
          if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
        });
        continue;
      }
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function ctx() { return S.ctx || {}; }
  function who() { return String(ctx().who || 'this NPC'); }

  function parse(p) {
    if (p == null) return null;
    if (typeof p !== 'string') return p;
    try { return JSON.parse(p); } catch (e) { return null; }
  }

  /* Match-highlighting that cannot inject: the text is split on the query and
     reassembled as TEXT nodes with <mark> around the hits. */
  function marked(text, q) {
    var s = String(text == null ? '' : text);
    var needle = String(q || '').trim().toLowerCase();
    if (!needle) return document.createTextNode(s);
    var frag = document.createDocumentFragment();
    var low = s.toLowerCase(), from = 0, at;
    while ((at = low.indexOf(needle, from)) !== -1) {
      if (at > from) frag.append(document.createTextNode(s.slice(from, at)));
      frag.append(h('mark', { class: 'hdq-hit' }, s.substr(at, needle.length)));
      from = at + needle.length;
      if (needle.length === 0) break;
    }
    if (from < s.length) frag.append(document.createTextNode(s.slice(from)));
    return frag;
  }

  /* ------------------------------------------------------------- data ----- */

  function quests() {
    return (S.list && Array.isArray(S.list.quests)) ? S.list.quests : [];
  }

  function isBroken(qu) { return Number(qu && qu.unfilledAliases || 0) > 0; }

  function statusOf(qu) {
    var st = String((qu && qu.status) || '');
    if (st === 'running') return 'running';
    if (st === 'completed') return 'done';
    return 'idle';
  }

  function matches(qu, needle) {
    if (!needle) return true;
    var hit = function (v) { return String(v == null ? '' : v).toLowerCase().indexOf(needle) !== -1; };
    return hit(qu.name) || hit(qu.editorId) || hit(qu.plugin) || hit(qu.formId)
        || hit(qu.aliasName) || hit(qu.type);
  }

  /* Rank so the list ANSWERS a question rather than listing alphabetically:
     what is live comes first, and inside every band the ones with an empty
     required alias lead — that is the quest you opened this for. */
  function rank(qu) {
    var band = statusOf(qu) === 'running' ? 0 : (statusOf(qu) === 'idle' ? 1 : 2);
    return band * 2 + (isBroken(qu) ? 0 : 1);
  }

  function filtered() {
    var needle = String(S.q || '').trim().toLowerCase();
    /* In "every quest" scope C++ has ALREADY matched the text (it searches the
       whole load order and truncates), so filtering the reply by the same
       string again would only drop rows it matched on a field we do not
       carry. Local text filtering is for HER list, which arrives whole. */
    var out = quests().filter(function (qu) {
      if (S.scope === 'npc' && !matches(qu, needle)) return false;
      if (S.status === 'broken') return isBroken(qu);
      if (S.status !== 'all' && statusOf(qu) !== S.status) return false;
      return true;
    });
    return out.sort(function (a, b) {
      var d = rank(a) - rank(b);
      if (d) return d;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function counts() {
    var c = { all: 0, running: 0, idle: 0, done: 0, broken: 0 };
    var needle = String(S.q || '').trim().toLowerCase();
    quests().forEach(function (qu) {
      if (S.scope === 'npc' && !matches(qu, needle)) return;
      c.all++;
      c[statusOf(qu)]++;
      if (isBroken(qu)) c.broken++;
    });
    return c;
  }

  /* ------------------------------------------------------------- asking --- */

  function askList() {
    S.loading = true;
    S.want.list = true;
    if (S.scope === 'all') {
      var q = String(S.q || '').trim();
      if (q.length < 2) {           // C++ refuses under two chars; don't pretend
        S.loading = false;
        S.want.list = false;
        S.list = { quests: [] };
        S.listFor = '';
        return;
      }
      S.listFor = '';
      toGameSafe('hdQuestSearch', q);
      return;
    }
    var hex = String(ctx().hex || '');
    S.listFor = hex;
    /* JSON, not the bare hex, so C++ can tell "an explicit actor" from "the
       crosshair snapshot" — this card's subject is a picked party member
       whenever you clicked a face on the party strip. An older DLL ignores the
       payload and answers about the crosshair, which for the common case IS
       the same person, so a partial deploy degrades instead of breaking. */
    toGameSafe('hdQuestList', JSON.stringify({ formId: hex }));
  }

  function askListSoon() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { searchTimer = 0; askList(); render(); }, 260);
  }

  function askDetail(formId) {
    if (!formId) return;
    S.detailFor = String(formId);
    S.detail = null;
    S.want.detail = true;
    S.armStage = null;
    S.armVerb = '';
    S.stageQ = '';
    toGameSafe('hdQuestGet', String(formId));
  }

  /* ------------------------------------------------------------ the root -- */

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.getElementById('hdq-layer');
    if (!root) {
      root = h('div', { id: 'hdq-layer', class: 'hidden' });
      var host = document.getElementById('panel') || document.body;
      host.append(root);
    }
    /* Click the scrim (never a click INSIDE the box) to close — the same
       affordance the rest of the deck's modals have. */
    root.addEventListener('mousedown', function (e) {
      if (e.target === root) { e.stopPropagation(); close(); }
    });
    return root;
  }

  /* --------------------------------------------------------- fragments ---- */

  function facePlate(glyph) {
    var shot = String(ctx().portrait || '');
    if (!shot) return h('div', { class: 'hdq-plate' }, glyph);
    var plate = h('div', { class: 'hdq-plate is-face' });
    var img = h('img', { class: 'hdq-face-img', src: shot, alt: '' });
    /* Remove-on-error, never a broken-image box: the portrait file can be gone
       while the roster still remembers it. Plain path, no ?v= — Ultralight can
       treat the query as part of the filename. */
    img.addEventListener('error', function () {
      try { plate.removeChild(img); } catch (e) {}
      plate.classList.remove('is-face');
      plate.append(document.createTextNode(glyph));
    });
    plate.append(img, h('span', { class: 'hdq-face-badge' }, glyph));
    return plate;
  }

  function chip(text, kind, title) {
    return h('span', { class: 'hdq-chip is-' + (kind || 'dim'), title: title || null }, text);
  }

  function statusChip(status) {
    var st = String(status || '');
    if (st === 'running') return chip('running', 'run', 'Started and not finished');
    if (st === 'completed') return chip('completed', 'done', 'Finished');
    return chip(st || 'inactive', 'idle', 'Not started, or stopped');
  }

  function head() {
    var wrap = h('div', { class: 'hdq-headwrap' });
    var isDetail = S.view === 'detail';
    var row = h('div', { class: 'hdq-head' });

    if (isDetail) {
      row.append(h('button', {
        class: 'hdq-icon-btn', type: 'button', title: 'Back to her quests (Esc)',
        onClick: function (e) { e.stopPropagation(); toList(); },
      }, '←'));
    }
    row.append(facePlate('📜'));

    var d = S.detail;
    /* The title says WHOSE, because that is the question the F7 card asked —
       "Quests" alone made the one thing this modal is about live in the grey
       subline under it. */
    var title = isDetail ? ((d && d.name) || 'Quest')
              : (S.scope === 'npc' ? (who() + '’s quests') : 'Every quest');
    var sub;
    if (isDetail) {
      sub = h('div', { class: 'hdq-sub' },
        (d && d.plugin) ? chip(d.plugin, 'dim', 'The plugin this quest lives in') : null,
        (d && d.type) ? chip(d.type, 'dim', 'Quest type') : null,
        (d && d.formId) ? chip(d.formId, 'dim', 'FormID') : null,
        (d && d.editorId) ? chip(d.editorId, 'dim', 'EditorID') : null);
    } else {
      var c = counts();
      sub = h('div', { class: 'hdq-sub' },
        h('span', { class: 'hdq-sub-who' }, S.scope === 'npc'
          ? 'Every quest she is caught up in'
          : 'Every quest in the load order'),
        S.loading ? chip('reading…', 'dim') : chip(c.all + (c.all === 1 ? ' quest' : ' quests'), 'dim'),
        c.running ? chip(c.running + ' running', 'run') : null,
        c.broken ? chip('⚠ ' + c.broken + ' with an empty alias', 'warn',
          'A required alias is empty — usually the real reason a quest is stuck') : null);
    }

    row.append(h('div', { class: 'hdq-title' },
      h('div', { class: 'hdq-title-t', title: title }, title), sub));

    if (isDetail && d && d.status) row.append(statusChip(d.status));

    row.append(h('button', {
      class: 'hdq-icon-btn hdq-close', type: 'button', title: 'Close (Esc)',
      onClick: function (e) { e.stopPropagation(); close(); },
    }, '✕'));

    wrap.append(row);
    return wrap;
  }

  function note() {
    if (!S.note) return null;
    return h('div', { class: 'hdq-note' + (S.noteOk ? '' : ' is-bad') },
      h('span', { class: 'hdq-note-ic' }, S.noteOk ? '✓' : '⚠'),
      h('span', null, S.note));
  }

  /* ============================================================ the LIST == */

  function toolbar() {
    var bar = h('div', { class: 'hdq-tools' });

    var input = h('input', {
      class: 'hdq-search', type: 'text', spellcheck: 'false', autocomplete: 'off',
      value: S.q,
      placeholder: S.scope === 'npc'
        ? 'Search ' + who() + '’s quests — name, alias, plugin, EditorID, FormID…'
        : 'Search every quest in the load order — two letters or more…',
      onClick: function (e) { e.stopPropagation(); },
      onInput: function (e) {
        S.q = e.target.value;
        S.sel = 0;
        if (S.scope === 'all') { askListSoon(); paintList(); repaintFilters(); }
        else { paintList(); repaintFilters(); }
      },
      onKeydown: function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); step(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); return; }
        if (e.key === 'Enter') { e.preventDefault(); openSel(); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation();
          if (S.q) { S.q = ''; e.target.value = ''; S.sel = 0;
            if (S.scope === 'all') askListSoon();
            paintList(); repaintFilters(); return; }
          close(); }
      },
    });
    bar.append(h('div', { class: 'hdq-search-row' },
      h('span', { class: 'hdq-search-ic', 'aria-hidden': 'true' }, '🔎'), input));

    /* SCOPE — the escape hatch that makes this modal complete. A quest whose
       alias never filled is structurally invisible to the NPC lookup, and that
       is precisely the broken quest you came here for. */
    var scopes = h('div', { class: 'hdq-scope' },
      h('span', { class: 'hdq-lbl' }, 'Look in'));
    [
      { id: 'npc', label: 'Hers', ic: '☺',
        title: 'Quests ' + who() + ' is in — live alias holds, plus quests that merely NAME her' },
      { id: 'all', label: 'Every quest', ic: '🌐',
        title: 'Free-text search over every quest in the load order. Use this when a quest is '
             + 'missing from her list: aliases only resolve while a quest RUNS, so a quest whose '
             + 'alias never filled cannot be found from the NPC — and that is the usual shape of a '
             + 'broken quest.' },
    ].forEach(function (sc) {
      scopes.append(h('button', {
        class: 'hdq-tab' + (S.scope === sc.id ? ' on' : ''), type: 'button',
        title: sc.title, 'aria-pressed': String(S.scope === sc.id),
        onClick: function (e) { e.stopPropagation(); setScope(sc.id); },
      }, h('span', { class: 'hdq-tab-ic', 'aria-hidden': 'true' }, sc.ic), sc.label));
    });
    bar.append(scopes);

    bar.append(filterRow());
    return bar;
  }

  function filterRow() {
    var c = counts();
    var row = h('div', { class: 'hdq-filters', id: 'hdq-filters' },
      h('span', { class: 'hdq-lbl' }, 'Show'));
    FILTERS.forEach(function (f) {
      var n = c[f.id] || 0;
      var off = n === 0 && f.id !== 'all';
      row.append(h('button', {
        class: 'hdq-fchip f-' + f.id + (S.status === f.id ? ' on' : '') + (off ? ' is-off' : ''),
        type: 'button', disabled: off ? true : null,
        'aria-pressed': String(S.status === f.id),
        title: off ? f.title + ' — none here' : f.title,
        onClick: function (e) {
          e.stopPropagation();
          S.status = f.id; S.sel = 0;
          paintList(); repaintFilters();
        },
      },
        h('span', { class: 'hdq-fchip-ic', 'aria-hidden': 'true' }, f.ic),
        h('span', { class: 'hdq-fchip-l' }, f.label),
        h('span', { class: 'hdq-fchip-n' }, String(n))));
    });
    return row;
  }

  /* The filter chips carry live counts, so they must repaint when the search
     text changes — but repainting the WHOLE surface would take the focus and
     the caret out of the box being typed in. */
  function repaintFilters() {
    var old = document.getElementById('hdq-filters');
    if (!old || !old.parentNode) return;
    old.parentNode.replaceChild(filterRow(), old);
  }

  function rowEl(qu, i) {
    var st = statusOf(qu);
    var broken = isBroken(qu);
    var needle = S.scope === 'npc' ? S.q : '';
    var glyph = st === 'running' ? '▶' : (st === 'done' ? '✓' : '◇');

    var meta = h('div', { class: 'hdq-row-s' });
    meta.append(h('span', { class: 'hdq-dim' }, qu.plugin || '?'));
    if (qu.type) meta.append(h('span', { class: 'hdq-dot' }, '·'), document.createTextNode(qu.type));
    meta.append(h('span', { class: 'hdq-dot' }, '·'), h('span', { class: 'hdq-dim' }, String(qu.formId || '')));
    if (qu.editorId) {
      meta.append(h('span', { class: 'hdq-dot' }, '·'),
        h('span', { class: 'hdq-dim' }, marked(qu.editorId, needle)));
    }

    var pills = h('div', { class: 'hdq-pills' });
    if (qu.involvement === 'static') {
      pills.append(chip('not live', 'dim',
        'Named in this quest’s alias data, but not currently held by it — the quest has not '
        + 'started, or its alias never filled'));
    } else if (qu.aliasName) {
      pills.append(chip(qu.aliasName, 'alias', who() + ' currently fills this alias'));
    }
    if (broken) {
      pills.append(chip('⚠ ' + qu.unfilledAliases + ' unfilled',
        'warn', qu.unfilledAliases + ' required alias(es) are EMPTY — a far more likely cause of a '
        + 'stuck quest than the stage number'));
    }

    var stageN = Number(qu.stageCount || 0);
    var right = h('div', { class: 'hdq-row-r' },
      statusChip(qu.status),
      h('span', { class: 'hdq-stage', title: 'Current stage of ' + stageN + ' defined' },
        'stage ', h('b', null, String(qu.currentStage)),
        h('small', null, '/' + stageN)));

    return h('button', {
      class: 'hdq-row st-' + st + (broken ? ' is-broken' : '') + (i === S.sel ? ' sel' : ''),
      type: 'button', 'data-qid': String(qu.formId || ''), 'data-i': String(i),
      title: 'Open ' + (qu.name || 'this quest') + ' — stages, aliases and the repair verbs',
      onClick: function (e) { e.stopPropagation(); S.sel = i; openQuest(qu.formId); },
      onMouseenter: function () {
        if (S.sel === i) return;
        S.sel = i;
        var host = document.getElementById('hdq-list');
        if (!host) return;
        host.querySelectorAll('.hdq-row.sel').forEach(function (n) { n.classList.remove('sel'); });
        var me = host.querySelector('.hdq-row[data-i="' + i + '"]');
        if (me) me.classList.add('sel');
      },
    },
      h('span', { class: 'hdq-row-ic', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'hdq-row-txt' },
        h('span', { class: 'hdq-row-t' }, marked(qu.name || '(unnamed quest)', needle)),
        meta,
        pills.childNodes.length ? pills : null),
      right);
  }

  function skeleton() {
    var box = h('div', { class: 'hdq-skels' });
    for (var i = 0; i < 5; i++) box.append(h('div', { class: 'hdq-skel' }));
    return box;
  }

  function emptyEl() {
    var wrap = h('div', { class: 'hdq-empty' });
    var c = counts();

    if (S.scope === 'all' && String(S.q || '').trim().length < 2) {
      wrap.append(h('div', { class: 'hdq-empty-ic' }, '🌐'),
        h('div', { class: 'hdq-empty-t' }, 'Search every quest'),
        h('div', { class: 'hdq-empty-s' },
          'Type at least two letters. This searches the WHOLE load order by name, EditorID, '
          + 'FormID or plugin — mod-added and ESL quests included. It is how you find a quest '
          + 'that is missing from ' + who() + '’s own list, which happens when its alias never '
          + 'filled.'));
      return wrap;
    }

    /* The list HAS quests but this query/filter shows none. Two different
       sentences, because two different controls are to blame — and each empty
       state offers the control that undoes it, rather than just saying "no
       results" and leaving you to work out which of the two did it. */
    if (quests().length) {
      var typed = String(S.q).trim();
      var byText = !c.all;                       // the search box emptied it
      var fname = (FILTERS.filter(function (f) { return f.id === S.status; })[0] || {}).label || '';
      wrap.append(h('div', { class: 'hdq-empty-ic' }, '∅'),
        h('div', { class: 'hdq-empty-t' },
          byText ? ('Nothing matches “' + typed + '”')
                 : ('No “' + fname + '” quest' + (typed ? ' matches “' + typed + '”' : ' here'))),
        h('div', { class: 'hdq-empty-s' },
          byText ? 'None of her ' + quests().length + ' quests match that text.'
                 : 'She has ' + c.all + ' matching quest' + (c.all === 1 ? '' : 's')
                   + ', but none in that state.'));
      var acts = h('div', { class: 'hdq-empty-acts' });
      if (typed) {
        acts.append(h('button', {
          class: 'hdq-btn', type: 'button', title: 'Clear the search box',
          onClick: function (e) { e.stopPropagation(); S.q = ''; S.sel = 0; render(); },
        }, '✕ Clear search'));
      }
      if (S.status !== 'all') {
        acts.append(h('button', {
          class: 'hdq-btn', type: 'button', title: 'Show every state again',
          onClick: function (e) { e.stopPropagation(); S.status = 'all'; S.sel = 0; render(); },
        }, '≡ Show all states'));
      }
      if (S.scope === 'npc') {
        acts.append(h('button', {
          class: 'hdq-btn is-key', type: 'button',
          title: 'Search every quest in the load order instead',
          onClick: function (e) { e.stopPropagation(); setScope('all'); },
        }, '🌐 Search every quest'));
      }
      wrap.append(acts);
      return wrap;
    }

    if (S.scope === 'all') {
      wrap.append(h('div', { class: 'hdq-empty-ic' }, '∅'),
        h('div', { class: 'hdq-empty-t' }, 'No quest matches “' + String(S.q).trim() + '”'),
        h('div', { class: 'hdq-empty-s' },
          'Nothing in the load order matches that name, EditorID, FormID or plugin.'));
      return wrap;
    }

    var known = S.list && S.list.hasTarget === false;
    wrap.append(h('div', { class: 'hdq-empty-ic' }, known ? '⌖' : '∅'),
      h('div', { class: 'hdq-empty-t' },
        known ? 'The game could not resolve ' + who()
              : 'No quests found for ' + who()),
      h('div', { class: 'hdq-empty-s' },
        known
          ? 'Her reference did not resolve — she may have been unloaded since the deck '
            + 'snapshotted her. Close, look at her again, and reopen.'
          : 'Quest aliases only resolve while a quest is RUNNING. If a quest is stuck '
            + 'BECAUSE its alias never filled, it cannot be found from the NPC at all — '
            + 'search every quest by name instead.'),
      h('div', { class: 'hdq-empty-acts' },
        h('button', {
          class: 'hdq-btn is-key', type: 'button',
          title: 'Switch to the free-text search over every quest in the load order',
          onClick: function (e) { e.stopPropagation(); setScope('all'); },
        }, '🌐 Search every quest'),
        h('button', {
          class: 'hdq-btn', type: 'button', title: 'Ask the game again',
          onClick: function (e) { e.stopPropagation(); askList(); render(); },
        }, '⟳ Try again')));
    return wrap;
  }

  /* Only the LIST repaints on a keystroke — the search box keeps its focus and
     its caret because it is not rebuilt. */
  function paintList() {
    var host = document.getElementById('hdq-list');
    if (!host) return;
    host.textContent = '';
    if (S.loading) { host.append(skeleton()); return; }
    var rows = filtered();
    if (!rows.length) { host.append(emptyEl()); return; }
    if (S.sel >= rows.length) S.sel = rows.length - 1;
    if (S.sel < 0) S.sel = 0;
    rows.forEach(function (qu, i) { host.append(rowEl(qu, i)); });
  }

  function step(d) {
    var rows = filtered();
    if (!rows.length) return;
    S.sel = Math.max(0, Math.min(rows.length - 1, S.sel + d));
    paintList();
    var host = document.getElementById('hdq-list');
    var me = host && host.querySelector('.hdq-row.sel');
    if (me && me.scrollIntoView) { try { me.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  function openSel() {
    var rows = filtered();
    var qu = rows[S.sel];
    if (qu) openQuest(qu.formId);
  }

  function openQuest(formId) {
    if (!formId) return;
    S.view = 'detail';
    S.note = '';
    askDetail(formId);
    render();
  }

  function renderList() {
    var r = ensureRoot();
    var box = h('div', { class: 'hdq-box hdq-list-box' });
    r.append(box);
    box.append(head());

    var body = h('div', { class: 'hdq-body' });
    box.append(body);
    body.append(toolbar());
    var n = note();
    if (n) body.append(n);
    body.append(h('div', { class: 'hdq-list', id: 'hdq-list' }));
    paintList();

    box.append(h('div', { class: 'hdq-foot' },
      h('span', { class: 'hdq-hint' }, '↑ ↓ move · Enter opens · Esc closes'),
      h('span', { class: 'hdq-hint hdq-hint-r' },
        'Stages fire through Papyrus, so their script fragments actually run')));

    /* Focus the box, not the first row: you came here to type. */
    setTimeout(function () {
      var i = box.querySelector('.hdq-search');
      if (i) { try { i.focus(); i.selectionStart = i.selectionEnd = i.value.length; } catch (e) {} }
    }, 0);
  }

  /* ========================================================== the DETAIL == */

  function section(title, hint, danger) {
    var sec = h('div', { class: 'hdq-sec' + (danger ? ' is-danger' : '') });
    sec.append(h('div', { class: 'hdq-sec-h' },
      h('span', { class: 'hdq-sec-t' }, title),
      hint ? h('span', { class: 'hdq-sec-hint' }, hint) : null));
    return sec;
  }

  function aliasSection(d) {
    var aliases = (d && d.aliases) || [];
    var bad = aliases.filter(function (a) { return a.filled === false && !a.optional; }).length;
    var sec = section('Aliases',
      bad ? bad + ' required alias(es) EMPTY — check this before touching a stage'
          : 'Who and what this quest is holding right now');
    if (bad) sec.classList.add('has-bad');
    if (!aliases.length) {
      sec.append(h('div', { class: 'hdq-dim hdq-pad' }, 'This quest has no aliases.'));
      return sec;
    }
    var listEl = h('div', { class: 'hdq-aliases' });
    aliases.forEach(function (a) {
      var unfilled = a.filled === false;
      listEl.append(h('div', {
        class: 'hdq-alias' + (unfilled ? (a.optional ? ' is-opt' : ' is-bad') : ''),
        title: unfilled
          ? (a.optional ? 'Empty, but optional — the quest can run without it'
                        : 'EMPTY and required — this is the kind of thing that stalls a quest')
          : 'Filled',
      },
        h('span', { class: 'hdq-alias-n' }, a.name || ('alias ' + a.id)),
        h('span', { class: 'hdq-alias-f' },
          String(a.fill || a.kind || '') + (a.optional ? ' · optional' : '')),
        h('span', { class: 'hdq-alias-v' + (unfilled ? ' is-empty' : '') },
          unfilled ? (a.wants ? 'EMPTY — wants ' + a.wants : 'EMPTY')
                   : (a.refName || a.refId || '—'))));
    });
    sec.append(listEl);
    return sec;
  }

  function stageSection(d) {
    var stages = (d && d.stages) || [];
    var sec = section('Stages',
      stages.length
        ? 'Current ' + d.currentStage + ' of ' + stages.length
          + ' · click one to fire it through Papyrus'
        : '');
    if (!stages.length) {
      sec.append(h('div', { class: 'hdq-dim hdq-pad' }, 'This quest defines no stages.'));
      return sec;
    }

    var grid = h('div', { class: 'hdq-stages' });

    function paintStages() {
      grid.textContent = '';
      var needle = String(S.stageQ || '').trim();
      var shown = stages.filter(function (s) {
        return !needle || String(s.index).indexOf(needle) === 0;
      });
      if (!shown.length) {
        grid.append(h('div', { class: 'hdq-dim hdq-pad' }, 'No stage starts with “' + needle + '”.'));
        return;
      }
      shown.forEach(function (s) {
        var back = s.index < d.currentStage;
        var armed = S.armStage === s.index;
        grid.append(h('button', {
          class: 'hdq-st' + (s.current ? ' is-cur' : '') + (back ? ' is-back' : '')
                 + (armed ? ' is-armed' : ''),
          type: 'button',
          title: armed ? 'Click again to fire stage ' + s.index + ' — it is BEHIND the current one'
               : s.current ? 'The current stage — firing it again re-runs its fragment'
               : back ? 'Stage ' + s.index + ' is earlier than the current one. Replaying a stage '
                        + 'can make things worse, so this asks twice.'
               : 'Fire stage ' + s.index,
          onClick: function (e) { e.stopPropagation(); fireStage(s.index, d, paintStages); },
        }, armed ? '?' : String(s.index)));
      });
    }

    if (stages.length > STAGE_SEARCH_AT) {
      /* Standing UI rule #4: past ~10 things, an unsearchable list is a defect.
         MQ101 defines 125 stages. */
      sec.append(h('div', { class: 'hdq-stage-find' },
        h('span', { class: 'hdq-lbl' }, 'Jump to'),
        h('input', {
          class: 'hdq-stage-in', type: 'text', spellcheck: 'false', autocomplete: 'off',
          placeholder: 'stage number…', value: S.stageQ,
          onClick: function (e) { e.stopPropagation(); },
          onInput: function (e) {
            S.stageQ = e.target.value.replace(/[^0-9]/g, '');
            if (e.target.value !== S.stageQ) e.target.value = S.stageQ;
            paintStages();
          },
          onKeydown: function (e) {
            if (e.key === 'Escape' && S.stageQ) {
              e.preventDefault(); e.stopPropagation();
              S.stageQ = ''; e.target.value = ''; paintStages();
            }
          },
        }),
        h('span', { class: 'hdq-dim' }, stages.length + ' stages')));
    }

    sec.append(grid);
    paintStages();
    sec.append(h('div', { class: 'hdq-hint hdq-pad' },
      'Fired through Papyrus (Quest.SetStage), so the stage’s script fragments run — writing the '
      + 'number directly would change the number and repair nothing. Stages BEFORE the current one '
      + 'ask for a second click.'));
    return sec;
  }

  function objectiveSection(d) {
    var objs = (d && d.objectives) || [];
    if (!objs.length) return null;
    var sec = section('Objectives', 'What the journal is showing');
    var listEl = h('div', { class: 'hdq-objs' });
    objs.forEach(function (o) {
      listEl.append(h('div', { class: 'hdq-obj s' + o.state },
        h('span', { class: 'hdq-obj-i' }, String(o.index)),
        h('span', { class: 'hdq-obj-t' }, o.text || '(no text)'),
        h('span', { class: 'hdq-dim' },
          OBJ_STATE[o.state] !== undefined ? OBJ_STATE[o.state] : String(o.state))));
    });
    sec.append(listEl);
    return sec;
  }

  function fireStage(stage, d, repaint) {
    if (!d || !d.formId) return;
    if (stage < d.currentStage && S.armStage !== stage) {
      S.armStage = stage;                       // backwards is the dangerous direction
      if (repaint) repaint();
      setTimeout(function () {
        if (S.armStage === stage) { S.armStage = null; if (S.view === 'detail') render(); }
      }, 2800);
      return;
    }
    S.armStage = null;
    S.want.result = true;
    S.want.detail = true;                       // C++ re-pushes the detail after a stage
    S.note = 'Firing stage ' + stage + '…';
    S.noteOk = true;
    toGameSafe('hdQuestSetStage', JSON.stringify({ formId: d.formId, stage: stage }));
    render();
  }

  function runVerb(verb, d) {
    if (!d || !d.formId) return;
    S.want.result = true;
    /* Every verb but movetoqt re-pushes the detail; movetoqt either refuses
       (result only) or CLOSES the palette and jumps. Arming want.detail for it
       would leave a flag set for a reply that never comes. */
    S.want.detail = verb !== 'movetoqt';
    S.note = verb + '…';
    S.noteOk = true;
    toGameSafe('hdQuestAction', JSON.stringify({ formId: d.formId, verb: verb }));
    render();
  }

  function actionRow(d) {
    var row = h('div', { class: 'hdq-acts' });
    row.append(h('button', {
      class: 'hdq-btn is-key', type: 'button',
      title: 'Teleport to the current objective target (console movetoqt). It checks the target '
           + 'is live FIRST — movetoqt fails silently otherwise — then closes the deck and jumps.',
      onClick: function (e) { e.stopPropagation(); runVerb('movetoqt', d); },
    }, '◎ Go to target'));
    [
      { verb: 'start', label: 'Start', title: 'Start the quest (Quest.Start)' },
      { verb: 'stop', label: 'Stop', title: 'Stop the quest (Quest.Stop)' },
      { verb: 'complete', label: 'Complete', title: 'Papyrus CompleteQuest — marks every objective done' },
    ].forEach(function (a) {
      row.append(h('button', {
        class: 'hdq-btn', type: 'button', title: a.title,
        onClick: function (e) { e.stopPropagation(); runVerb(a.verb, d); },
      }, a.label));
    });

    /* Reset WIPES progress. The tab fires it on one click; here it is armed,
       because "resetquest" on the wrong quest in a 400-hour save is not a
       thing you get to undo. */
    var armed = S.armVerb === 'reset';
    row.append(h('button', {
      class: 'hdq-btn is-danger' + (armed ? ' is-armed' : ''), type: 'button',
      title: armed ? 'Click again to wipe this quest’s progress'
                   : 'ResetAndUpdate — wipes quest progress, like the console’s resetquest. '
                     + 'Asks twice.',
      onClick: function (e) {
        e.stopPropagation();
        if (!armed) {
          S.armVerb = 'reset'; render();
          setTimeout(function () {
            if (S.armVerb === 'reset') { S.armVerb = ''; if (S.view === 'detail') render(); }
          }, 4200);
          return;
        }
        S.armVerb = '';
        runVerb('reset', d);
      },
    }, armed ? '⟲ Sure? Wipes progress' : '⟲ Reset'));
    return row;
  }

  function renderDetail() {
    var r = ensureRoot();
    var box = h('div', { class: 'hdq-box hdq-detail-box' });
    r.append(box);
    box.append(head());

    var body = h('div', { class: 'hdq-body' });
    box.append(body);

    var d = S.detail;

    if (!d) {                       // waiting on hdQuestInfo
      body.append(h('div', { class: 'hdq-sec' },
        h('div', { class: 'hdq-skel is-tall' }),
        h('div', { class: 'hdq-skel' }),
        h('div', { class: 'hdq-skel' })));
      box.append(h('div', { class: 'hdq-foot' }, h('span', { class: 'hdq-hint' }, 'Reading the quest…')));
      return;
    }

    if (d.ok === false) {
      body.append(h('div', { class: 'hdq-err' },
        h('span', { class: 'hdq-err-ic' }, '⚠'),
        h('span', null, d.message || 'Quest not found')));
      box.append(h('div', { class: 'hdq-foot' },
        h('span', { class: 'hdq-hint' }, 'Esc goes back to the list')));
      return;
    }

    var n = note();
    if (n) body.append(n);

    /* A one-line verdict strip, so the state of the quest is readable before
       you scroll: is it running, which stage, and is an alias empty. */
    var bad = ((d.aliases || []).filter(function (a) { return a.filled === false && !a.optional; })).length;
    body.append(h('div', { class: 'hdq-strip' },
      chip((d.stages || []).length + ' stages', 'dim'),
      chip('current ' + d.currentStage, 'dim'),
      d.enabled === false ? chip('disabled', 'warn', 'The quest form itself is disabled') : null,
      bad ? chip('⚠ ' + bad + ' empty alias' + (bad === 1 ? '' : 'es'), 'warn',
        'A required alias is empty — fix this before firing stages') : null));

    body.append(aliasSection(d));
    body.append(stageSection(d));
    var objs = objectiveSection(d);
    if (objs) body.append(objs);

    var sec = section('Do something about it',
      'These run the quest’s own script, exactly as the Quests tab does', true);
    sec.append(actionRow(d));
    body.append(sec);

    var foot = h('div', { class: 'hdq-foot' },
      h('span', { class: 'hdq-hint' }, 'Esc goes back to ' + who() + '’s list'));
    /* The full tab is still one click away — same quest, more room. */
    if (typeof window.__omniOpenQuest === 'function') {
      foot.append(h('button', {
        class: 'hdq-link', type: 'button',
        title: 'Close this and open the Quests tab on the same quest',
        onClick: function (e) {
          e.stopPropagation();
          var payload = { name: d.name, formId: d.formId, status: d.status,
                          currentStage: d.currentStage };
          close();
          try { window.__omniOpenQuest(payload); } catch (err) {}
        },
      }, '↗ Open in the Quests tab'));
    }
    box.append(foot);
  }

  /* ============================================================== render == */

  /* Everything the current surface is DRAWN FROM, as one short string. Replies
     land whenever the game gets round to them, and a repaint is a full teardown
     that re-runs the entrance animation — so a repaint has to EARN it. Same
     lesson as the Outfit dock's flashing dropdown. */
  function sig() {
    var parts = [S.view, String(ctx().hex || ''), S.scope, S.status, S.q,
      String(S.sel), S.loading ? 'L' : '', S.note, S.noteOk ? '1' : '0',
      String(S.armStage), S.armVerb, S.stageQ];
    if (S.view === 'list') {
      parts.push(String(quests().length));
      parts.push(quests().map(function (qu) {
        return qu.formId + ':' + qu.currentStage + ':' + qu.status + ':' + qu.unfilledAliases;
      }).join('|'));
    } else {
      var d = S.detail;
      parts.push(d ? (d.formId + ':' + d.currentStage + ':' + d.status + ':'
        + ((d.stages || []).length) + ':'
        + ((d.aliases || []).map(function (a) { return a.filled === false ? '0' : '1'; }).join(''))) : 'none');
    }
    return parts.join('');
  }

  function maybeRender() {
    if (!S.open) return false;
    if (sig() === S.sig) return false;
    render();
    return true;
  }

  function render() {
    if (!S.open) return;
    var r = ensureRoot();
    r.textContent = '';
    r.classList.remove('hidden');
    var key = S.view + '|' + String(ctx().hex || '') + '|' + S.detailFor;
    S.fresh = (S.animFor !== key);
    S.animFor = key;
    if (S.view === 'detail') renderDetail(); else renderList();
    if (S.fresh) {
      var box = r.querySelector('.hdq-box');
      if (box) box.classList.add('is-fresh');
    }
    S.sig = sig();
  }

  /* ============================================================ public ==== */

  function setScope(id) {
    if (S.scope === id) return;
    S.scope = id;
    S.sel = 0;
    S.status = 'all';
    S.list = null;
    S.note = '';
    askList();
    render();
  }

  function toList() {
    S.view = 'list';
    S.detail = null;
    S.detailFor = '';
    S.armStage = null;
    S.armVerb = '';
    S.note = '';
    render();
  }

  /* open(anchorEl, ctx)
     ctx: { who, portrait, formId, hex, dead }
     anchorEl is accepted for symmetry with the other card popouts and is
     deliberately unused — this one is a centred modal, not a floater. */
  function open(anchorEl, c) {
    var next = c || {};
    var sameOne = S.ctx && String(S.ctx.hex || '') === String(next.hex || '');
    S.ctx = next;
    S.open = true;
    if (!sameOne) {                 // a different person is a different question
      S.scope = 'npc';
      S.q = '';
      S.status = 'all';
      S.list = null;
      S.detail = null;
      S.detailFor = '';
    }
    S.view = 'list';
    S.sel = 0;
    S.note = '';
    S.armStage = null;
    S.armVerb = '';
    S.animFor = '';
    /* Only one popout owns the card at a time — the Outfit dock draws in the
       same corner of #panel and both claim hdCapture. */
    if (window.HDOutfit && HDOutfit.isOpen()) HDOutfit.close();
    ensureRoot().classList.remove('hidden');
    toGameSafe('hdCapture', '1');   // typing a quest name must never quick-fire a hotkey
    askList();
    render();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.want.list = S.want.detail = S.want.result = false;
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = 0; }
    if (root) { root.textContent = ''; root.classList.add('hidden'); }
    S.sig = '';
    S.animFor = '';
    toGameSafe('hdCapture', '0');
    var cb = ctx().onClose;
    if (typeof cb === 'function') { try { cb(); } catch (e) {} }
  }

  function onKey(e) {
    if (!S.open) return false;
    var k = e.key || e.code;
    if (k === 'Escape') {
      /* Let an input's own Escape (clear the box) win first — those handlers
         stopPropagation, so reaching here means nothing else claimed it. */
      if (S.view === 'detail') toList(); else close();
      return true;
    }
    if (S.view === 'list') {
      if (k === 'ArrowDown') { step(1); return true; }
      if (k === 'ArrowUp') { step(-1); return true; }
      if (k === 'Enter') { openSel(); return true; }
    }
    return false;   // the search boxes keep every other key
  }

  /* ------------------------------------------------- replies (first refusal) */
  /* Each of these returns TRUE when it has consumed the payload, and app.js
     stops there. We only ever claim a reply we ASKED for — the Quests tab and
     omni share these three channels. */

  function takeList(payload) {
    if (!S.open || !S.want.list) return false;
    S.want.list = false;
    S.loading = false;
    var p = parse(payload);
    S.list = p || { quests: [] };
    S.sel = 0;
    /* Unconditional, not maybeRender(): an empty list arriving over an empty
       list moves nothing in the signature, and the loading SKELETON must still
       go. This fires once per ask, and the entrance animation is gated on the
       view/subject key rather than on the repaint, so it cannot flash. */
    render();
    return true;
  }

  function takeDetail(payload) {
    if (!S.open || !S.want.detail) return false;
    S.want.detail = false;
    var p = parse(payload);
    /* Drop a late reply for a quest we have already navigated away from. */
    if (p && p.formId && S.detailFor && String(p.formId) !== S.detailFor) return true;
    S.detail = p || { ok: false, message: 'Bad payload — see HotkeyDeck.log' };
    render();
    return true;
  }

  function takeResult(payload) {
    if (!S.open || !S.want.result) return false;
    S.want.result = false;
    var p = parse(payload);
    S.note = (p && p.message) || '';
    S.noteOk = !p || p.ok !== false;
    render();
    return true;
  }

  window.HDQuests = {
    open: open,
    close: close,
    isOpen: function () { return !!S.open; },
    view: function () { return S.view; },
    onKey: onKey,
    takeList: takeList,
    takeDetail: takeDetail,
    takeResult: takeResult,
    refresh: maybeRender,
    /* harness / introspection only */
    _state: S,
    _render: render,
    _filtered: filtered,
    _counts: counts,
    _statusOf: statusOf,
    _isBroken: isBroken,
    _rank: rank,
    _setScope: setScope,
    _openQuest: openQuest,
    _toList: toList,
    _filters: FILTERS,
  };
})();
