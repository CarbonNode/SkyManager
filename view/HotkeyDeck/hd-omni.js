'use strict';

/* ====================================================================== *
 *  Omni — the deck's universal Search + Ask surface (v0.14.0).
 *
 *  One overlay, two modes:
 *    SEARCH — everything every tab holds, in one box. Hotkeys (all
 *             categories), tabs themselves, notes, followers, domains,
 *             rooms, wardrobe outfits, finance lines, spells & combos
 *             (via C++), quests (lazy, via the existing quest bridge).
 *             Enter fires the top result's default action; every result
 *             can also jump to its owning tab with that pane's own
 *             filter pre-filled.
 *    ASK    — a question about an NPC ("what is Lydia's personality?").
 *             Rides the C++ HTTP pipe (sharmat.cpp ask
 *             channel) to CHIM's deck_ask endpoint. Structured facets
 *             come back instantly; "Think about it" runs the LLM layer.
 *
 *  ---- how it scales automatically -------------------------------------
 *  Search is a PROVIDER REGISTRY. Anything can call
 *      HDOmni.register({ id, label, tab, index() {...}, ... })
 *  and its items are searchable from that moment — the omni core never
 *  needs editing. Three levels of automatic coverage:
 *    1. registered providers — panes register themselves (bottom of each
 *       pane file, or the built-ins below), indexing LIVE state at query
 *       time, so new entries/categories/fields are searchable the moment
 *       they exist;
 *    2. the tab fallback — every button in the top nav becomes a jump
 *       result by its rendered label, so a brand-new tab is findable by
 *       name the day it lands, before anyone writes it a provider;
 *    3. lazy providers — quests (and anything else engine-side) query
 *       their bridge per keystroke and merge in asynchronously.
 *
 *  Provider contract:
 *    id       unique string
 *    label    group heading in the results ("Hotkeys", "Followers", …)
 *    tab      the setTab() token results jump to ('' = none)
 *    index()  -> [{ label, detail?, kind?, keywords?, run?, jump? }]
 *               called on every query — return LIVE data, never cache.
 *    warm()   optional — called once when the omni opens (ask a bridge
 *             for data that only arrives on demand)
 *    lazy(q)  optional — fire an async lookup for this query; call
 *             HDOmni.lazyResults(id, items) when the answer lands.
 *    setFilter(q) optional — pre-fill the pane's own search on jump.
 *    pinRun(snap, item?) optional — the Favorites Shelf's activation hook:
 *             called with a pin's stored `snap` when the shelf fires a pin
 *             whose live item has no run() (followers → open her menu), or
 *             whose live item cannot be found at all (quests before their
 *             lazy search, spells before the warm data lands). `item` is
 *             the live item when one was found, null otherwise.
 *
 *  Item contract:
 *    label    row title (matched + highlighted)
 *    detail   dim second line
 *    kind     small chip text ("hotkey", "spell", "follower", …)
 *    keywords extra haystack, never displayed
 *    run()    default action (fire / cast / travel / open). Omitted =
 *             jump is the default.
 *    jump()   override the provider-level jump for this item.
 *    pin      optional DURABLE identity (provider-scoped string, e.g.
 *             'hk:<entryId>', 'sp:<plugin>:<localId>'). Its presence is
 *             what puts the ☆ on the row — the Favorites Shelf
 *             (hd-shelf.js) stores {prov,key} and re-resolves against
 *             index() live, so the key must survive renames and reloads.
 *    snap     optional JSON-SAFE payload stored WITH the pin, for
 *             activation when the live item is unavailable (see pinRun).
 *    icon     optional VIEW-RELATIVE image path (an entry's icons/… file,
 *             a follower's portraits/… face, a domain's photo). The shelf
 *             renders it on the pin's plate, falling back to the glyph on
 *             load error — so a guessed path costs nothing.
 * ====================================================================== */

var HDOmni = (function () {
  var DEV = location.search.indexOf('dev=1') !== -1;

  var providers = [];
  var st = {
    open: false,
    mode: 'search',      // 'search' | 'ask'
    q: '',
    sel: 0,
    flat: [],            // flattened result rows, in render order
    lazy: {},            // providerId -> items merged from async lookups
    lazyPending: {},     // providerId -> true while a lookup is in flight
    ask: {
      busy: false,
      phase: '',         // '', 'asking', 'thinking'
      reply: null,       // last structured envelope from CHIM
      err: '',
      lastNpc: '',       // carried into follow-ups ("what's her personality")
      reqId: 0,
    },
  };
  var inputTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (DEV) console.log('[omni dev->game]', fn, arg);
  }

  /* ------------------------------------------------------------ registry */

  function register(p) {
    if (!p || !p.id || typeof p.index !== 'function') return;
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === p.id) { providers[i] = p; return; }   // re-register replaces
    }
    providers.push(p);
  }

  function providerById(id) {
    for (var i = 0; i < providers.length; i++)
      if (providers[i].id === id) return providers[i];
    return null;
  }

  /* Favorites Shelf resolution: find the LIVE item behind a stored pin key.
     `indexed` distinguishes "the provider answered and the item is gone"
     from "the provider's data has not arrived yet" (warm/lazy providers
     return [] until their bridge replies) — the shelf greys only the first. */
  function resolvePin(provId, key) {
    var p = providerById(provId);
    if (!p) return { provider: null, item: null, indexed: false };
    var items = [];
    try { items = p.index() || []; } catch (e) { items = []; }
    if (st.lazy[provId]) items = items.concat(st.lazy[provId]);
    for (var i = 0; i < items.length; i++)
      if (items[i] && items[i].pin === key)
        return { provider: p, item: items[i], indexed: true };
    var indexed = items.length > 0 || !(p.warm || p.lazy);
    return { provider: p, item: null, indexed: indexed };
  }

  /* ------------------------------------------------------------- scoring */
  /* Plain, predictable ranking: exact label > label prefix > word prefix >
     substring > subsequence; keywords/detail count at a discount. */

  function scoreText(text, q) {
    if (!text) return 0;
    var t = String(text).toLowerCase();
    if (t === q) return 100;
    if (t.indexOf(q) === 0) return 60;
    var words = t.split(/[\s\/\-_·.,:]+/);
    for (var i = 0; i < words.length; i++) if (words[i].indexOf(q) === 0) return 40;
    if (t.indexOf(q) !== -1) return 25;
    /* subsequence — "frb" finds "Firebolt", but only for queries 3+ chars */
    if (q.length >= 3) {
      var ti = 0;
      for (var qi = 0; qi < q.length; qi++) {
        ti = t.indexOf(q[qi], ti);
        if (ti === -1) return 0;
        ti++;
      }
      return 8;
    }
    return 0;
  }

  function scoreItem(item, q) {
    var s = scoreText(item.label, q);
    var s2 = Math.max(scoreText(item.detail, q), scoreText(item.keywords, q),
                      scoreText(item.kind, q)) * 0.6;
    return Math.max(s, s2);
  }

  /* Multi-word queries: every word must land somewhere on the item. */
  function scoreItemMulti(item, words) {
    var total = 0;
    for (var i = 0; i < words.length; i++) {
      var s = scoreItem(item, words[i]);
      if (s <= 0) return 0;
      total += s;
    }
    return total / words.length;
  }

  function highlight(text, words) {
    var t = String(text == null ? '' : text);
    if (!words.length) return esc(t);
    var lower = t.toLowerCase();
    var best = -1, len = 0;
    for (var i = 0; i < words.length; i++) {
      var at = lower.indexOf(words[i]);
      if (at !== -1 && (best === -1 || at < best)) { best = at; len = words[i].length; }
    }
    if (best === -1) return esc(t);
    return esc(t.slice(0, best)) + '<mark>' + esc(t.slice(best, best + len)) + '</mark>' +
           esc(t.slice(best + len));
  }

  /* -------------------------------------------------------- search query */

  var GROUP_LIMIT = 6;   // rows shown per provider before "show all"
  var expanded = {};     // providerId -> true after "show all"

  function collect() {
    var q = st.q.trim().toLowerCase();
    var words = q.split(/\s+/).filter(function (w) { return w; });
    var groups = [];
    if (!words.length) return groups;

    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var items = [];
      try { items = p.index() || []; } catch (e) { items = []; }
      if (st.lazy[p.id]) items = items.concat(st.lazy[p.id]);
      var hits = [];
      for (var j = 0; j < items.length; j++) {
        var s = scoreItemMulti(items[j], words);
        if (s > 0) hits.push({ item: items[j], score: s, provider: p });
      }
      if (!hits.length && !st.lazyPending[p.id]) continue;
      hits.sort(function (a, b) { return b.score - a.score; });
      groups.push({ provider: p, hits: hits,
                    top: hits.length ? hits[0].score : 0,
                    pending: !!st.lazyPending[p.id] });
    }
    groups.sort(function (a, b) { return b.top - a.top; });
    return groups;
  }

  function runLazy() {
    var q = st.q.trim();
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      if (typeof p.lazy !== 'function') continue;
      delete st.lazy[p.id];
      if (q.length < 2) { delete st.lazyPending[p.id]; continue; }
      st.lazyPending[p.id] = true;
      try { p.lazy(q); } catch (e) { delete st.lazyPending[p.id]; }
    }
  }

  function lazyResults(providerId, items) {
    delete st.lazyPending[providerId];
    st.lazy[providerId] = items || [];
    if (st.open && st.mode === 'search') renderResults();
  }

  /* ------------------------------------------------------------ actions */

  function jumpTo(provider, item, q) {
    close();
    if (item && typeof item.jump === 'function') { item.jump(); return; }
    if (!provider.tab) return;
    /* setTab FIRST: several panes reset their own filter inside onShow()
       (Finances calls setFilter('') there), so pre-filling before the switch
       would be silently wiped. After setTab returns, onShow has run. */
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab(provider.tab);
    if (typeof provider.setFilter === 'function') {
      try { provider.setFilter(q); } catch (e) {}
    }
  }

  function activate(row, viaJump) {
    if (!row) return;
    var item = row.item, p = row.provider;
    if (!viaJump && typeof item.run === 'function') {
      close();
      try { item.run(); } catch (e) {}
      return;
    }
    jumpTo(p, item, st.q.trim());
  }

  /* ------------------------------------------------------------- render */

  function ensureDom() {
    if ($('omni-modal')) return;
    var el = document.createElement('div');
    el.id = 'omni-modal';
    el.className = 'hidden';
    el.innerHTML =
      '<div class="omni-box">' +
        '<div class="omni-head">' +
          '<div class="omni-modes">' +
            '<button class="omni-mode on" data-omode="search">⌕ Search</button>' +
            '<button class="omni-mode" data-omode="ask">✦ Ask</button>' +
            '<button class="omni-mode" data-omode="direct">⚡ Direct</button>' +
          '</div>' +
          '<span id="omni-hint" class="omni-hint"></span>' +
          '<button id="omni-close" class="omni-x" title="Close (Esc)">✕</button>' +
        '</div>' +
        '<div class="omni-inrow">' +
          '<input id="omni-input" type="text" autocomplete="off" spellcheck="false">' +
          '<button id="omni-go" class="omni-go hidden" title="Ask (Enter)">Ask</button>' +
        '</div>' +
        '<div id="omni-results" class="omni-results"></div>' +
      '</div>';
    document.body.appendChild(el);

    el.addEventListener('mousedown', function (e) {
      if (e.button === 0 && e.target === el) close();
    });
    $('omni-close').addEventListener('click', close);
    $('omni-go').addEventListener('click', submitAsk);
    el.querySelector('.omni-modes').addEventListener('click', function (e) {
      var b = e.target.closest('.omni-mode');
      if (b) setMode(b.dataset.omode);
    });
    $('omni-input').addEventListener('input', function (e) {
      if (st.mode !== 'search') { st.q = e.target.value; return; }
      st.q = e.target.value;
      st.sel = 0;
      expanded = {};
      clearTimeout(inputTimer);
      inputTimer = setTimeout(function () { runLazy(); renderResults(); }, 120);
      renderResults();   // local providers are instant; lazy merges later
    });
    $('omni-results').addEventListener('click', onResultsClick);
  }

  function setMode(m) {
    if (m !== 'search' && m !== 'ask' && m !== 'direct') return;
    st.mode = m;
    st.sel = 0;
    var box = $('omni-modal');
    if (!box) return;
    box.querySelectorAll('.omni-mode').forEach(function (b) {
      b.classList.toggle('on', b.dataset.omode === m);
    });
    var inp = $('omni-input');
    inp.placeholder =
      m === 'ask' ? 'Ask about anyone… e.g. what is Lydia’s personality?' :
      m === 'direct' ? 'Direct the scene… e.g. Jenassa storms in, furious about last night' :
      'Search everything — hotkeys, spells, people, places…';
    var go = $('omni-go');
    go.classList.toggle('hidden', m === 'search');
    go.textContent = m === 'direct' ? 'Send' : 'Ask';
    $('omni-hint').textContent =
      m === 'ask' ? 'answers come from CHIM’s own data' :
      m === 'direct' ? 'a director instruction — nearby NPCs act on it' :
      '↑↓ select · Enter run · Shift+Enter jump to tab';
    if (m === 'search') renderResults(); else renderAsk();
    inp.focus();
  }

  function renderResults() {
    if (st.mode !== 'search') return;
    var host = $('omni-results');
    if (!host) return;
    var q = st.q.trim();
    var words = q.toLowerCase().split(/\s+/).filter(function (w) { return w; });

    if (!q) {
      var provNames = providers.map(function (p) { return p.label; }).join(' · ');
      host.innerHTML = '<div class="omni-blank">' +
        '<div class="omni-blank-ic">⌕</div>' +
        '<div class="omni-blank-t">Search everything</div>' +
        '<div class="omni-blank-s">' + esc(provNames || 'no providers registered') + '</div></div>';
      st.flat = [];
      return;
    }

    var groups = collect();
    st.flat = [];
    var html = '';
    var anyPending = false;
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var show = expanded[grp.provider.id] ? grp.hits : grp.hits.slice(0, GROUP_LIMIT);
      if (grp.pending) anyPending = true;
      if (!show.length && !grp.pending) continue;
      html += '<div class="omni-sect">' + esc(grp.provider.label) +
        (grp.pending ? ' <span class="omni-spin">…</span>' : '') + '</div>';
      for (var h = 0; h < show.length; h++) {
        var row = show[h];
        var idx = st.flat.length;
        st.flat.push(row);
        var it = row.item;
        var runnable = typeof it.run === 'function';
        /* the ☆ — every item with a durable pin key can join the Favorites
           Shelf from right here; filled when it already has */
        var pinnable = !!it.pin && window.HDShelf;
        var pinned = pinnable && window.HDShelf.isPinned(row.provider.id, it.pin);
        html += '<div class="omni-row' + (idx === st.sel ? ' selected' : '') + '" data-idx="' + idx + '">' +
          '<div class="omni-row-main">' +
            '<div class="omni-row-l">' + highlight(it.label, words) + '</div>' +
            (it.detail ? '<div class="omni-row-d">' + highlight(it.detail, words) + '</div>' : '') +
          '</div>' +
          (it.kind ? '<span class="omni-kind">' + esc(it.kind) + '</span>' : '') +
          (pinnable
            ? '<button class="omni-pin' + (pinned ? ' on' : '') + '" data-idx="' + idx + '" title="' +
              (pinned ? 'Unpin from the Favorites shelf' : 'Pin to the Favorites shelf') + '">' +
              (pinned ? '★' : '☆') + '</button>'
            : '') +
          (row.provider.tab || typeof it.jump === 'function'
            ? '<button class="omni-jump" data-idx="' + idx + '" title="' +
              (runnable ? 'Open in its tab (Shift+Enter)' : 'Open in its tab') + '">↗</button>'
            : '') +
        '</div>';
      }
      if (!expanded[grp.provider.id] && grp.hits.length > GROUP_LIMIT) {
        html += '<button class="omni-more" data-more="' + esc(grp.provider.id) + '">show all ' +
          grp.hits.length + '</button>';
      }
    }
    if (!st.flat.length) {
      host.innerHTML = anyPending
        ? '<div class="omni-blank"><div class="omni-blank-t">Searching…</div></div>'
        : '<div class="omni-blank"><div class="omni-blank-ic">∅</div>' +
          '<div class="omni-blank-t">Nothing matches “' + esc(q) + '”</div>' +
          '<div class="omni-blank-s">Try a name, a place, a spell, or switch to ✦ Ask for a question.</div></div>';
      return;
    }
    host.innerHTML = html;
    var sel = host.querySelector('.omni-row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function onResultsClick(e) {
    var more = e.target.closest('.omni-more');
    if (more) { expanded[more.dataset.more] = true; renderResults(); return; }
    var pinBtn = e.target.closest('.omni-pin');
    if (pinBtn) {
      e.stopPropagation();
      var prow = st.flat[Number(pinBtn.dataset.idx)];
      if (prow && window.HDShelf) {
        window.HDShelf.togglePin(prow.provider, prow.item);
        renderResults();   // repaint ☆ → ★ without losing the query
      }
      return;
    }
    var jump = e.target.closest('.omni-jump');
    if (jump) { e.stopPropagation(); activate(st.flat[Number(jump.dataset.idx)], true); return; }
    var row = e.target.closest('.omni-row');
    if (row) { activate(st.flat[Number(row.dataset.idx)], false); return; }
    /* ask-mode delegated buttons */
    var think = e.target.closest('#omni-think');
    if (think) { submitAsk(true); return; }
    var cand = e.target.closest('.omni-cand');
    if (cand) {
      $('omni-input').value = 'who is ' + cand.dataset.name + '?';
      st.q = $('omni-input').value;
      submitAsk(false);
      return;
    }
    var fold = e.target.closest('.omni-fold-h');
    if (fold) {
      var body = fold.nextElementSibling;
      if (body) body.classList.toggle('hidden');
      fold.classList.toggle('folded');
    }
  }

  /* ------------------------------------------------------------ ask mode */

  function submitAsk(thinkHarder) {
    var q = ($('omni-input') ? $('omni-input').value : st.q).trim();
    if (!q && !(thinkHarder && st.ask.reply)) return;
    st.ask.busy = true;
    st.ask.err = '';
    var direct = st.mode === 'direct';
    st.ask.phase = direct ? 'directing' : (thinkHarder === true ? 'thinking' : 'asking');
    st.ask.reqId++;
    /* C++ (ask.cpp) is a dumb pipe: it appends `query` verbatim to the endpoint
       URL, so the ENCODING happens here — same division of labour as Sharmat. */
    var qs = direct
      ? 'q=' + encodeURIComponent(q) + '&mode=direct'
      : 'q=' + encodeURIComponent(q) +
        '&npc=' + encodeURIComponent(st.ask.lastNpc || '') +
        '&mode=' + (thinkHarder === true ? 'llm' : 'structured');
    var payload = { id: 'ask-' + st.ask.reqId, query: qs, llm: thinkHarder === true };
    renderAsk();
    toGame('haAsk', JSON.stringify(payload));
    if (DEV && typeof window.__omniDevAsk === 'function') window.__omniDevAsk(payload);
  }

  /* C++ -> view: the ask channel's reply envelope
     { id, ok, status?, json?|error?, chimDown? } — json is deck_ask's body */
  function onAnswer(payload) {
    var env = payload;
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || env.id !== 'ask-' + st.ask.reqId) return;   // stale reply
    st.ask.busy = false;
    st.ask.phase = '';
    if (!env.ok) {
      st.ask.err = env.chimDown
        ? 'CHIM isn’t reachable — is the server up?'
        : (env.error || 'ask failed');
      renderAsk();
      return;
    }
    var body = env.json;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body) { st.ask.err = 'bad reply from CHIM'; renderAsk(); return; }
    if (body.ok === false) {
      st.ask.err = body.error + (body.hint ? ' — ' + body.hint : '');
      renderAsk();
      return;
    }
    st.ask.reply = body;
    if (body.npc && body.npc.name) st.ask.lastNpc = body.npc.name;
    renderAsk();
  }

  var FACET_LABELS = {
    bio: 'Background', personality: 'Personality', relationships: 'Relationships',
    goals: 'Goals', appearance: 'Appearance', skills: 'Skills', occupation: 'Occupation',
    speechstyle: 'Speech style', intimacy: 'Intimacy', diary: 'Diary', speech: 'Recent lines',
    pregnancy: 'Pregnancy', memories: 'Memories', events: 'Recent scenes', deaths: 'Recent deaths',
    chronicle: 'Chronicle — your canon', mentions: 'Mentions', knowledge: 'What she knows',
    whereabouts: 'Whereabouts',
  };

  function factRow(k, v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
    if (Array.isArray(v)) v = v.join(', ');
    if (typeof v === 'object') v = JSON.stringify(v);
    if (typeof v === 'boolean') v = v ? 'yes' : 'no';
    return '<div class="omni-fact"><span class="omni-fact-k">' + esc(k) +
           '</span><span class="omni-fact-v">' + esc(String(v)) + '</span></div>';
  }

  function facetCard(key, val, focused, labelOverride) {
    var label = labelOverride || FACET_LABELS[key] || key;
    var body = '';
    if (key === 'intimacy' && val && typeof val === 'object') {
      body += factRow('orientation', val.orientation);
      body += factRow('preference', val.preference);
      body += factRow('spousal status', val.spousal_status);
      body += factRow('spouses', val.spouse_names);
      body += factRow('kinks', val.kinks);
      body += factRow('secret kinks', val.secret_kinks);
      if (val.is_slave) body += factRow('slave', true);
      if (val.is_prostitute) body += factRow('sex worker', true);
      if (val.is_slut) body += factRow('uninhibited', true);
      body += factRow('pricing', val.pricing && typeof val.pricing === 'object'
        ? Object.keys(val.pricing).map(function (k) { return k + ' ' + val.pricing[k]; }).join(' · ')
        : val.pricing);
      if (val.sex_prompt) body += '<div class="omni-prose">' + esc(val.sex_prompt) + '</div>';
    } else if (key === 'pregnancy' && val && typeof val === 'object') {
      body += factRow('pregnant', !!val.pregnant);
      if (val.pregnant) {
        body += factRow('father', val.father);
        if (val.progress != null && val.progress !== '') body += factRow('progress', val.progress);
      }
    } else if (Array.isArray(val) && val.length && val[0] && typeof val[0] === 'object' &&
               'text' in val[0]) {
      /* any {d, text} line-list — diary/speech/memories/events/deaths/
         chronicle/mentions/knowledge/whereabouts and whatever the endpoint
         grows next; the facet arrives, the card renders, no view change */
      for (var i = 0; i < val.length; i++) {
        var e2 = val[i];
        body += '<div class="omni-line"><span class="omni-when">' + esc(e2.d || '') + '</span>' +
          (key === 'speech' ? '<span class="omni-who">' + esc(e2.speaker || '') + ' → ' + esc(e2.listener || '') + '</span>' : '') +
          '<span class="omni-text">' + esc(e2.text || '') + '</span></div>';
      }
    } else {
      body = '<div class="omni-prose">' + esc(typeof val === 'string' ? val : JSON.stringify(val)) + '</div>';
    }
    if (!body) return '';
    return '<div class="omni-facet' + (focused ? ' focus' : '') + '">' +
      '<div class="omni-fold-h' + (focused ? '' : ' folded') + '">' + esc(label) +
        (focused ? '' : ' <span class="omni-chev">▸</span>') + '</div>' +
      '<div class="omni-fold-b' + (focused ? '' : ' hidden') + '">' + body + '</div></div>';
  }

  function renderAsk() {
    if (st.mode === 'search') return;
    var host = $('omni-results');
    if (!host) return;
    var a = st.ask;
    var html = '';

    /* Direct mode has its own empty state; replies of kind 'direct' render in
       whichever mode is up (the confirmation must not vanish on a chip flip). */
    if (st.mode === 'direct' && !a.busy && !a.err &&
        !(a.reply && a.reply.kind === 'direct')) {
      host.innerHTML = '<div class="omni-blank"><div class="omni-blank-ic">⚡</div>' +
        '<div class="omni-blank-t">Direct the scene</div>' +
        '<div class="omni-blank-s">Whatever you type is handed to the nearby NPCs as a ' +
        'director instruction:<br>“Jenassa storms in, furious about last night” · ' +
        '“a courier arrives with an urgent letter from Solitude” · ' +
        '“Lydia quietly asks to speak with me alone”</div></div>';
      return;
    }

    if (a.busy) {
      html = '<div class="omni-blank"><div class="omni-blank-t">' +
        (a.phase === 'thinking' ? 'Thinking about it…' :
         a.phase === 'directing' ? 'Sending the direction…' : 'Asking CHIM…') +
        '</div><div class="omni-blank-s">' +
        (a.phase === 'thinking' ? 'running the LLM over her profile — a few seconds' :
         a.phase === 'directing' ? 'handing it to the director pipe' : 'reading the database') +
        '</div></div>';
      host.innerHTML = html;
      return;
    }
    if (a.err) {
      html = '<div class="omni-blank"><div class="omni-blank-ic">✦</div>' +
        '<div class="omni-blank-t">' + esc(a.err) + '</div></div>';
      host.innerHTML = html;
      return;
    }
    if (!a.reply) {
      html = '<div class="omni-blank"><div class="omni-blank-ic">✦</div>' +
        '<div class="omni-blank-t">Ask about anyone — or everyone</div>' +
        '<div class="omni-blank-s">“what is Lydia’s personality?” · ' +
        '“who is following me?” · “where is Jenassa?” · ' +
        '“does Faendal know about the dragon at Kynesgrove?” · ' +
        '“who mentioned the Elder Scroll?” · “what happened lately?”' +
        (a.lastNpc ? '<br>asking about <b>' + esc(a.lastNpc) + '</b> — “her goals?”, “where is she?” just work' : '') +
        '</div></div>';
      host.innerHTML = html;
      return;
    }

    var r = a.reply;

    /* ---- direct reply: confirmation the instruction was handed off ---- */
    if (r.kind === 'direct') {
      host.innerHTML =
        '<div class="omni-npc"><span class="omni-npc-n">⚡ ' + esc(r.title || 'Direction sent') + '</span></div>' +
        '<div class="omni-answer">' + esc(r.message || '') + '</div>' +
        (r.note ? '<div class="omni-blank-s" style="padding:0 14px 10px">' + esc(r.note) + '</div>' : '') +
        (r.output ? '<div class="omni-facet"><div class="omni-fold-h folded">Pipe output ' +
          '<span class="omni-chev">▸</span></div><div class="omni-fold-b hidden">' +
          '<div class="omni-prose">' + esc(r.output) + '</div></div></div>' : '');
      return;
    }

    /* ---- aggregate reply: a roster list ("Your followers (11)") ---- */
    if (r.kind === 'aggregate') {
      html += '<div class="omni-npc"><span class="omni-npc-n">' + esc(r.title || 'Results') + '</span></div>';
      if (r.answer) {
        html += '<div class="omni-answer">' + esc(r.answer) +
          (r.model ? '<div class="omni-model">' + esc(r.model) + '</div>' : '') + '</div>';
      }
      var ppl = r.people || [];
      if (!ppl.length) {
        html += '<div class="omni-blank"><div class="omni-blank-t">Nobody matches</div></div>';
      } else {
        html += '<div class="omni-people">';
        for (var pi = 0; pi < ppl.length; pi++) {
          html += '<div class="omni-person"><button class="omni-cand" data-name="' + esc(ppl[pi].name) + '">' +
            esc(ppl[pi].name) + '</button>' +
            (ppl[pi].detail ? '<span class="omni-person-d">' + esc(ppl[pi].detail) + '</span>' : '') + '</div>';
        }
        html += '</div>';
        if (!r.answer) {
          html += '<button id="omni-think" class="omni-think">🧠 Think about it</button>';
        }
      }
      host.innerHTML = html;
      return;
    }

    /* ---- world reply: recent scenes / deaths / diary, no NPC ---- */
    if (r.kind === 'world') {
      html += '<div class="omni-npc"><span class="omni-npc-n">' + esc(r.title || 'The world, lately') + '</span></div>';
      if (r.answer) {
        html += '<div class="omni-answer">' + esc(r.answer) +
          (r.model ? '<div class="omni-model">' + esc(r.model) + '</div>' : '') + '</div>';
      }
      var wfocus = r.focus || [];
      var wf = r.facets || {};
      var wkeys = Object.keys(wf);
      wkeys.sort(function (x, y) {
        return (wfocus.indexOf(x) !== -1 ? 0 : 1) - (wfocus.indexOf(y) !== -1 ? 0 : 1);
      });
      for (var wi = 0; wi < wkeys.length; wi++) {
        html += facetCard(wkeys[wi], wf[wkeys[wi]], wfocus.indexOf(wkeys[wi]) !== -1);
      }
      if (!r.answer) html += '<button id="omni-think" class="omni-think">🧠 Think about it</button>';
      host.innerHTML = html;
      return;
    }

    html += '<div class="omni-npc"><span class="omni-npc-n">' + esc(r.npc.name) + '</span>' +
      ((r.npc.race || r.npc.gender) ? '<span class="omni-npc-m">' +
        esc([r.npc.race, r.npc.gender].filter(Boolean).join(' · ')) + '</span>' : '') +
      (r.matchedBy ? '<span class="omni-npc-how" title="How the name was matched">' + esc(r.matchedBy) + '</span>' : '') +
      '</div>';

    if (r.answer) {
      html += '<div class="omni-answer">' + esc(r.answer) +
        (r.model ? '<div class="omni-model">' + esc(r.model) + '</div>' : '') + '</div>';
    }

    var focus = r.focus || [];
    var facets = r.facets || {};
    var keys = Object.keys(facets);
    /* focused facets first, open; the rest folded below */
    keys.sort(function (x, y) {
      var fx = focus.indexOf(x) !== -1 ? 0 : 1;
      var fy = focus.indexOf(y) !== -1 ? 0 : 1;
      return fx - fy;
    });
    for (var i = 0; i < keys.length; i++) {
      html += facetCard(keys[i], facets[keys[i]], focus.indexOf(keys[i]) !== -1,
        keys[i] === 'speech' && r.speechNote ? r.speechNote : null);
    }

    if (!r.answer) {
      html += '<button id="omni-think" class="omni-think" title="Run the LLM over this profile for a synthesized answer">' +
        '🧠 Think about it</button>';
    }
    if (r.candidates && r.candidates.length > 1) {
      html += '<div class="omni-cands">Did you mean: ';
      for (var c = 0; c < r.candidates.length; c++) {
        if (r.candidates[c] === r.npc.name) continue;
        html += '<button class="omni-cand" data-name="' + esc(r.candidates[c]) + '">' +
          esc(r.candidates[c]) + '</button>';
      }
      html += '</div>';
    }
    host.innerHTML = html;
  }

  /* ------------------------------------------------------------ open/close */

  function open(mode, seed) {
    ensureDom();
    if (st.open && st.mode === (mode || st.mode)) { close(); return; }   // toggle
    st.open = true;
    st.sel = 0;
    expanded = {};
    st.lazy = {};
    st.lazyPending = {};
    $('omni-modal').classList.remove('hidden');
    /* claim the "a modal owns this view" channel — digits must not quick-fire
       behind us, and a live portal push must not yank the overlay shut
       (same contract as the icon picker). */
    toGame('hdCapture', '1');
    /* The crosshair NPC becomes Ask's implicit subject: look at someone, open,
       type just "what are her kinks?". The palette snapshots the target at
       open (fdTarget → FolPane state), and the physical act of looking at her
       is a stronger signal than whoever the LAST answer was about. */
    try {
      var tgt = window.FolPane && FolPane._state && FolPane._state.target;
      if (tgt && tgt.name && !tgt.dead) st.ask.lastNpc = String(tgt.name);
    } catch (e) {}
    for (var i = 0; i < providers.length; i++) {
      if (typeof providers[i].warm === 'function') { try { providers[i].warm(); } catch (e) {} }
    }
    var inp = $('omni-input');
    if (typeof seed === 'string') { inp.value = seed; st.q = seed; }
    setMode(mode || 'search');
    if (st.q) { runLazy(); }
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }

  function close() {
    if (!st.open) return;
    st.open = false;
    var m = $('omni-modal');
    if (m) m.classList.add('hidden');
    toGame('hdCapture', '0');
  }

  /* Open Ask about a SPECIFIC npc and run it immediately. Used by the quick
     card's CHIM button ("CHIM Background"): unlike a bare open('ask', q),
     this pins the subject explicitly (not the crosshair, which may differ
     from a picked roster member) and submits, so the dossier lands without a
     second Enter. */
  function askAbout(npc, question) {
    var q = question || ('Tell me about ' + (npc || 'her')
      + ' — background, personality, relationships and goals.');
    if (!st.open) { open('ask', q); }
    else {
      setMode('ask');
      var inp = $('omni-input');
      if (inp) inp.value = q;
      st.q = q;
    }
    if (npc) st.ask.lastNpc = String(npc);   // override the crosshair subject
    submitAsk(false);
  }

  /* Key handling — called from app.js's capture-phase keydown handler while
     the overlay is open. Returns true when the key was consumed. */
  function onKey(e, code) {
    if (!st.open) return false;
    if (code === 'Escape') { close(); return true; }
    if (st.mode === 'search') {
      if (code === 'ArrowDown') { st.sel = Math.min(st.sel + 1, Math.max(0, st.flat.length - 1)); renderResults(); return true; }
      if (code === 'ArrowUp') { st.sel = Math.max(0, st.sel - 1); renderResults(); return true; }
      if (code === 'Enter') { activate(st.flat[st.sel], e.shiftKey); return true; }
      if (code === 'Tab') { setMode('ask'); return true; }
    } else {
      if (code === 'Enter') { submitAsk(false); return true; }
      if (code === 'Tab') { setMode(st.mode === 'ask' ? 'direct' : 'search'); return true; }
    }
    /* single characters land in the input naturally; make sure it has focus */
    var inp = $('omni-input');
    if (inp && document.activeElement !== inp && e.key && e.key.length === 1) inp.focus();
    return false;
  }

  /* ----------------------------------------------------------- built-ins */
  /* Registered from app.js after its state exists — see hookInto(). The
     pane-owned providers live at the bottom of each pane file. */

  function hookInto(env) {
    /* env: { state, ui, tabOrder, setTab, fireEntry, requestClose } supplied
       by app.js — omni never reaches into app.js internals uninvited. */
    window.__omniSetTab = env.setTab;

    /* 1) hotkey entries — every category, every device kind, live state */
    register({
      id: 'hotkeys', label: 'Hotkeys', tab: 'all',
      setFilter: function (q) { env.setSearch(q); },
      index: function () {
        return (env.state.entries || []).map(function (en) {
          return {
            label: en.name || '(unnamed)',
            detail: [en.desc, en.category, en.label].filter(Boolean).join(' · '),
            kind: en.device === 'action' ? 'action' : 'hotkey',
            keywords: [en.category, en.action, en.label].filter(Boolean).join(' '),
            pin: 'hk:' + en.id,   // entry ids survive rename/rebind/re-file
            icon: en.icon || '',  // the row's own icons/… art, shelf shows it
            run: function () { env.fireEntry(en.id); },
            jump: function () {
              env.setTab(en.category ? 'cat:' + en.category : 'all');
              env.setSearch(en.name || '');
            },
          };
        });
      },
    });

    /* 2) the tabs themselves — the automatic fallback that makes every NEW
       tab findable by its rendered label the day it lands. Panes with real
       providers still win because their items score on content. */
    register({
      id: 'tabs', label: 'Tabs', tab: '',
      /* shelf fallback: a pinned tab whose button is not rendered right now
         (the deck repaints the nav per render) still opens from its snap */
      pinRun: function (snap) {
        if (snap && snap.act === 'spells') { env.openSpells(); return; }
        if (snap && snap.tok) env.setTab(snap.tok);
      },
      index: function () {
        var items = [];
        var tabsEl = document.getElementById('tabs');
        if (!tabsEl) return items;
        var btns = tabsEl.querySelectorAll('.tab[data-tab]');
        for (var i = 0; i < btns.length; i++) {
          (function (tok, label) {
            items.push({
              label: label, kind: 'tab', detail: 'open the ' + label + ' tab',
              pin: 'tab:' + tok, snap: { tok: tok },
              run: function () { env.setTab(tok); },
            });
          })(btns[i].dataset.tab, btns[i].textContent.replace(/[✕✎◂▸]+/g, '').trim());
        }
        /* the Spell Deck launcher is data-act, not data-tab — add it by hand */
        items.push({ label: 'Spells', kind: 'tab', detail: 'open the Spell Deck (F18)',
                     pin: 'tab:spells!', snap: { act: 'spells' },
                     run: function () { env.openSpells(); } });
        return items;
      },
    });

    /* 3) notes — one blob, matched by line so the hit shows its context */
    register({
      id: 'notes', label: 'Notes', tab: 'notes',
      index: function () {
        var lines = String(env.state.notes || '').split('\n');
        var items = [];
        for (var i = 0; i < lines.length; i++) {
          var t = lines[i].trim();
          if (t.length < 2) continue;
          /* the line IS the identity — edit the line and the pin greys with
             the honest reason, which beats silently pointing at other text */
          items.push({ label: t, kind: 'note', pin: 'note:' + t,
                       run: null });
        }
        return items;
      },
    });

    /* 4) deck actions catalog — "full save", "portrait" find the built-ins
       even when no entry exists for them yet */
    register({
      id: 'deck-actions', label: 'Deck actions', tab: '',
      pinRun: function (snap) { if (snap && snap.action) env.fireAction(snap.action); },
      index: function () {
        return (env.deckActions || []).map(function (a) {
          return {
            label: a.name, detail: a.desc, kind: 'action',
            pin: 'act:' + a.action, snap: { action: a.action },
            run: function () { env.fireAction(a.action); },
          };
        });
      },
    });

    /* 5) quests — lazy, through the existing hdQuestSearch bridge. app.js
       gives omni first refusal on the hdQuests reply via takeQuestReply(). */
    register({
      id: 'quests', label: 'Quests', tab: 'quests',
      lazy: function (q) {
        questWanted = true;
        toGame('hdQuestSearch', q);
      },
      index: function () { return []; },
      /* index() is always empty here (results are lazy), so a pinned quest
         ALWAYS activates from its snap — the same detail-open the omni jump
         does, off the stored identity */
      pinRun: function (snap) {
        if (snap && typeof window.__omniOpenQuest === 'function') window.__omniOpenQuest(snap);
      },
    });

    /* 6) spells & combos — the Spell Deck lives in ANOTHER PrismaUI view, so
       its data arrives from C++ (the magic config slice) on demand: warm()
       asks once per omni-open, hdSpellsData below stores it. Casting goes
       back through hdOmniCast (deck-view twin of the Spell Deck's own fire). */
    register({
      id: 'spells', label: 'Spells & Combos', tab: '',
      warm: function () { toGame('hdSpellsIndex', ''); },
      /* shelf fallback: the snap IS the cast payload, so a pinned spell fires
         even before the warm hdSpellsData reply lands. Combos re-resolve live
         first (membership drifts as the player edits them); the snap is the
         cast-at-pin-time membership, honest but frozen. */
      pinRun: function (snap) {
        if (snap && snap.kind) toGame('hdOmniCast', JSON.stringify(snap));
        else env.openSpells();
      },
      index: function () {
        var items = [];
        var i, s;
        for (i = 0; i < spellIndex.spells.length; i++) {
          s = spellIndex.spells[i];
          (function (s) {
            var cast = { kind: 'spell', name: s.name,
              plugin: s.plugin || '', localId: s.localId >>> 0, formId: s.formId >>> 0 };
            items.push({
              label: s.name || '(unnamed spell)',
              detail: [s.school, s.tier, s.category].filter(Boolean).join(' · '),
              kind: s.mode === 'equip' ? 'spell · equip' : 'spell',
              keywords: [s.element, s.archetype, s.plugin].filter(Boolean).join(' '),
              /* plugin+localId — the ESL-safe durable identity, never the
                 runtime formId (see [[esl-runtime-formids-shift-with-load-order]]) */
              pin: 'sp:' + (s.plugin || '') + ':' + (s.localId >>> 0),
              /* The real Spell Hotbar art, resolved against the DECK view's own
                 mirrored copy of the icon library (app.js hdSpellIconPath).
                 Emitted here rather than in each consumer so the wheel AND the
                 Favorites Shelf both get it from one place — the shelf drew a
                 bare ✦ for spells until this existed. '' falls back to the
                 glyph exactly as before. */
              icon: (typeof window.hdSpellIconPath === 'function'
                ? window.hdSpellIconPath(s) : ''),
              snap: cast,
              run: function () { toGame('hdOmniCast', JSON.stringify(cast)); },
              jump: function () { env.openSpells(); },
            });
          })(s);
        }
        for (i = 0; i < spellIndex.combos.length; i++) {
          (function (c) {
            var cast = { kind: 'combo', name: c.name,
              spells: (c.spells || []).map(function (m) {
                return { plugin: m.plugin || '', localId: m.localId >>> 0, formId: m.formId >>> 0 };
              }) };
            items.push({
              label: c.name || '(combo)',
              detail: (c.spells || []).map(function (m) { return m.name; }).filter(Boolean).join(' + '),
              kind: 'combo',
              pin: 'combo:' + (c.id || c.name || ''),
              snap: cast,
              run: function () { toGame('hdOmniCast', JSON.stringify(cast)); },
              jump: function () { env.openSpells(); },
            });
          })(spellIndex.combos[i]);
        }
        return items;
      },
    });
  }

  /* the magic slice, as last pushed by C++ (hdSpellsData) */
  var spellIndex = { spells: [], combos: [] };
  window.hdSpellsData = function (payload) {
    var p = payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return; } }
    if (!p || typeof p !== 'object') return;
    spellIndex.spells = Array.isArray(p.spells) ? p.spells : [];
    spellIndex.combos = Array.isArray(p.combos) ? p.combos : [];
    if (st.open && st.mode === 'search' && st.q.trim()) renderResults();
  };

  var questWanted = false;
  function takeQuestReply(payload) {
    if (!questWanted || !st.open) { questWanted = false; return false; }
    questWanted = false;
    var p = payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
    var quests = (p && p.quests) || [];
    lazyResults('quests', quests.map(function (qu) {
      return {
        label: qu.name || qu.editorId || qu.formId,
        detail: [qu.plugin, qu.status, 'stage ' + qu.currentStage].filter(Boolean).join(' · '),
        kind: 'quest',
        keywords: [qu.editorId, qu.formId].filter(Boolean).join(' '),
        pin: 'q:' + (qu.formId || qu.editorId || qu.name || ''),
        /* just the identity fields __omniOpenQuest reads — status/stage would
           freeze at pin time and lie later */
        snap: { name: qu.name || '', formId: qu.formId, editorId: qu.editorId || '',
                plugin: qu.plugin || '' },
        jump: function () {
          if (typeof window.__omniOpenQuest === 'function') window.__omniOpenQuest(qu);
        },
      };
    }));
    return true;
  }

  /* ------------------------------------------------- dev-preview mocks */
  /* ?dev=1 only — never runs in-game. Gives the harness a CHIM that answers
     and a spell index to search, exercising both bridge directions. */
  if (DEV) {
    var DEV_NPCS = {
      'uthgerd': { name: 'Uthgerd the Unbroken', race: 'Nord', gender: 'Female',
        focusFacets: { intimacy: { orientation: 'bisexual', preference: 'monogamous',
          kinks: ['praise', 'wrestling'], is_slave: false },
        personality: 'Proud, sharp-tongued, quick to a brawl. Refuses to be anyone\'s trophy.',
        bio: 'Whiterun brawler, drinks at the Bannered Mare and takes on all comers.' } },
      'jenassa': { name: 'Jenassa', race: 'Dunmer', gender: 'Female',
        focusFacets: { intimacy: { orientation: 'heterosexual', preference: 'unattached',
          kinks: ['danger', 'coin'], is_slave: false },
        personality: 'Dry, unsentimental, enjoys the work more than she admits.',
        pregnancy: { pregnant: false, father: '', progress: 0 },
        memories: [{ d: 'Sun\'s Dawn 14', text: 'Hired out of the Drunken Huntsman for 500 gold.' }],
        diary: [{ d: 'Sun\'s Dawn 19', text: 'Cleared a bandit camp near Riverwood. The pay was fair.' }] } },
    };
    window.__omniDevAsk = function (payload) {
      setTimeout(function () {
        var qlow = decodeURIComponent((payload.query.match(/q=([^&]*)/) || [])[1] || '').toLowerCase();
        if (/mode=direct/.test(payload.query)) {
          window.haAnswer({ id: payload.id, ok: true, status: 200, json: {
            ok: true, kind: 'direct', title: 'Direction sent', message: decodeURIComponent((payload.query.match(/q=([^&]*)/) || [])[1] || ''),
            note: 'Nearby NPCs act on this.', output: '[MANAGER] Forking task rolemaster' } });
          return;
        }
        /* aggregate + world mocks mirror deck_ask.php's reply kinds */
        if (/\b(who|which|how many|list|all of|every)\b/.test(qlow) && /(follower|following|companion|household)/.test(qlow)) {
          window.haAnswer({ id: payload.id, ok: true, status: 200, json: {
            ok: true, kind: 'aggregate', title: 'Your followers (3)',
            people: [
              { name: 'Lydia', detail: 'NORD · housecarl · sworn to carry your burdens' },
              { name: 'Jenassa', detail: 'Dunmer · sellsword · hired in Whiterun' },
              { name: 'Faendal', detail: 'Bosmer · archer · Riverwood' },
            ],
          } });
          return;
        }
        if (/(happened|lately|died|news|recap)/.test(qlow) && !/uthgerd|jenassa/.test(qlow)) {
          window.haAnswer({ id: payload.id, ok: true, status: 200, json: {
            ok: true, kind: 'world', title: 'Lately, in the world',
            focus: /died/.test(qlow) ? ['deaths'] : ['events'],
            facets: {
              events: [{ d: 'Loredas, 10:07 PM, Last Seed 31st, 4E 201',
                         text: 'At the Bannered Mare, a tense confrontation…' }],
              deaths: [{ d: 'Last Seed 30th', text: 'A bandit chief died — Halted Stream Camp' }],
              diary:  [{ d: 'Last Seed 29th', text: '[Jenassa] Cleared the barrow. The pay was fair.' }],
            },
          } });
          return;
        }
        var hit = null;
        Object.keys(DEV_NPCS).forEach(function (k) { if (qlow.indexOf(k) !== -1) hit = DEV_NPCS[k]; });
        if (!hit && /her|his/.test(qlow)) hit = DEV_NPCS['uthgerd'];
        if (!hit) {
          window.haAnswer({ id: payload.id, ok: true,
            json: { ok: false, error: 'no NPC recognized in the question',
                    hint: 'name someone — e.g. "what is Lydia\'s personality?"' } });
          return;
        }
        var body = {
          ok: true,
          npc: { name: hit.name, race: hit.race, gender: hit.gender },
          matchedBy: 'name word in question',
          candidates: [hit.name],
          focus: qlow.indexOf('personality') !== -1 ? ['personality'] : ['intimacy'],
          facets: hit.focusFacets,
        };
        if (payload.llm) {
          body.answer = '(dev LLM) ' + hit.name + ' — a synthesized in-world answer would appear here.';
          body.model = 'dev/mock-model';
        }
        window.haAnswer({ id: payload.id, ok: true, status: 200, json: body });
      }, payload.llm ? 600 : 150);
    };
    /* mocked spell slice: hdSpellsIndex → hdSpellsData */
    window.hdSpellsIndex = function () {
      setTimeout(function () {
        window.hdSpellsData({
          spells: [
            { id: 'sp1', name: 'Firebolt', plugin: 'Skyrim.esm', localId: 0x12FCD, formId: 0x12FCD,
              mode: 'cast', school: 'Destruction', tier: 'apprentice', category: 'Attack' },
            { id: 'sp2', name: 'Healing Hands', plugin: 'Skyrim.esm', localId: 0x12D5F, formId: 0x12D5F,
              mode: 'cast', school: 'Restoration', tier: 'novice', category: 'Support' },
            { id: 'sp3', name: 'Frost Cloak', plugin: 'Skyrim.esm', localId: 0x3AE9F, formId: 0x3AE9F,
              mode: 'equip', school: 'Destruction', tier: 'adept', category: 'Defense' },
          ],
          combos: [
            { id: 'combo-1', name: 'Battlemage Opener',
              spells: [{ plugin: 'Skyrim.esm', localId: 0x12FCD, formId: 0x12FCD, name: 'Firebolt' },
                       { plugin: 'Skyrim.esm', localId: 0x3AE9F, formId: 0x3AE9F, name: 'Frost Cloak' }] },
          ],
        });
      }, 60);
    };
  }

  /* --------------------------------------------------------------- boot */

  window.haAnswer = onAnswer;

  return {
    register: register,
    providerById: providerById,
    /* The whole registry, for a SECOND consumer that browses rather than
       searches — the Wheel Menu's picker walks every provider's index() to
       build its category chips. A copy, so a caller cannot splice the live
       registry out from under the search. */
    providers: function () { return providers.slice(); },
    resolvePin: resolvePin,
    open: open,
    close: close,
    askAbout: askAbout,
    isOpen: function () { return st.open; },
    onKey: onKey,
    hookInto: hookInto,
    takeQuestReply: takeQuestReply,
    lazyResults: lazyResults,
    /* exposed for the test harness */
    _state: st,
    _collect: collect,
    _score: scoreItemMulti,
  };
})();
window.HDOmni = HDOmni;
