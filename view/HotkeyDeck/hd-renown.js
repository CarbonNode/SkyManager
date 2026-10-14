'use strict';
/* ====================================================================== *
 *  HDRenown — the Renown page: the player's deeds, how far each has spread,
 *  and exactly who in CHIM therefore knows it.
 *
 *  ONE module, TWO hosts (the "one system, both decks" rule):
 *    · the deck's Character tab mounts it in #ps-renown (charsheet-pane.js),
 *      data through deck_ask.php's renown_* modes (HDOmni.chimCall);
 *    · the Deck Portal mounts it under its Sheet tab, data through
 *      /api/renown* (server.js), served from this same file.
 *  The host passes an adapter; nothing in here knows which one it is in
 *  except for the `surface` string it uses for wording.
 *
 *  The data is the court ext's Renown ledger (roleplay/chim-prompts/ext/court/
 *  renown_lib.php, `court.php renown`): every deed with its REACH (secret ·
 *  witnesses · household · hold · realm), the NPCs who know it and WHY, and the
 *  exact line it puts into each knower's <renown> prompt block. The page never
 *  decides who knows anything; it shows what CHIM will do and edits the ledger.
 *
 *  Adapter:
 *    load(cb)                    cb(err, doc)        doc = `court.php renown`
 *    op(name, payload, cb)       cb(err, result)     set | knows | drop | preview
 *    icon(stem)                  -> url               gl-sun -> image
 *    face(name)                  -> url | null        her portrait, when one exists
 *    capture(on)                 deck: claim / release the modal capture (app.js hdPopoutCapture)
 *    escaped()                   deck: a native Esc closed the popout (app.js hdPopoutNativeEsc)
 *    surface                     'deck' | 'portal'
 *
 *  Deck laws honoured here: anything that reveals more opens as a body-anchored
 *  POPOUT (never an inline expander), the popout owns Escape (capture listener +
 *  isOpen() for app.js onKeyDown), no colour-mix / conic-gradient, explicit
 *  rgba, every class namespaced `rn-`, no text below 13px, a typeable search
 *  bar on every list (Enter takes the top hit).
 *
 *  Marker: HDRenown (view identity).
 * ====================================================================== */
(function () {

  /* ---------------------------------------------------------- vocabulary -- */

  var REACH = [
    { id: 'secret',    label: 'Secret',        icon: 'gl-eye',    note: 'Only the people named below. They are told to keep it close.' },
    { id: 'witnesses', label: 'Witnesses',     icon: 'gl-people', note: 'Only those who were there — name them below.' },
    { id: 'household', label: 'His household', icon: 'gl-house',  note: 'Everyone who stands in his household, from thrall to companion.' },
    { id: 'hold',      label: 'The hold',      icon: 'gl-castle', note: 'His household, and anyone last heard speaking in the chosen holds.' },
    { id: 'realm',     label: 'All Skyrim',    icon: 'gl-globe',  note: 'Every soul in Skyrim has heard of it.' }
  ];
  var REACH_IX = {}; REACH.forEach(function (r, i) { REACH_IX[r.id] = i; });

  var TIERS = [
    { id: 'legend',  label: 'Legends',       one: 'Legend' },
    { id: 'great',   label: 'Great Deeds',   one: 'Great deed' },
    { id: 'notable', label: 'Notable Deeds', one: 'Notable deed' },
    { id: 'minor',   label: 'Lesser Deeds',  one: 'Lesser deed' }
  ];
  var TIER_IX = {}; TIERS.forEach(function (t, i) { TIER_IX[t.id] = i; });

  var FILTERS = [
    { id: 'all',      label: 'All deeds' },
    { id: 'titles',   label: 'Titles' },
    { id: 'hidden',   label: 'Kept close' },
    { id: 'canon',    label: 'Story canon' }
  ];

  /* The gold-medallion set (icons/custom/gl-*.png) — the deck's own art. Listed
     here because neither host can list a folder from the view. */
  /* The Renown set (icons/custom/rn-*.png, generated 2026-10-12 to match the
     gl-* medallions): one emblem per kind of deed, offered first in the picker. */
  var RN = ['rn-dawnbreaker', 'rn-dragonborn', 'rn-duke', 'rn-thane', 'rn-lichslayer', 'rn-raid', 'rn-three-rings',
    'rn-treaty', 'rn-curator', 'rn-oath', 'rn-sea-crown', 'rn-blood-crown', 'rn-bound-knight', 'rn-laurel'];
  var GL = ('alembic amulet axe backpack book-open book bow brain broom candle castle chains chair cloud ' +
    'coins comet crown dagger dance door dove dragon drop eagle eye flame footprints gem globe gloves ' +
    'hammers hand healing helmet herb horse hourglass house ice key lantern ledger lock magnifier map ' +
    'masks moon notepad orb palette paw people person picture pin potion pouch puzzle ring scales scroll ' +
    'shield skull snowflake sparkle speech stone stopwatch sun swords tag tankard target tent tree unlock ' +
    'wolf').split(' ').map(function (s) { return 'gl-' + s; });
  var EMBLEMS = RN.concat(GL);

  /* ------------------------------------------------------------ state ----- */

  var A = null;          // adapter
  var host = null;       // mount element
  var st = {
    doc: null, state: 'idle', msg: '',
    q: '', filter: 'all',
    pop: null,           // the open popout's controller
    revealed: false
  };

  /* ---------------------------------------------------------- helpers ----- */

  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!attrs.hasOwnProperty(k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(e) { while (e && e.firstChild) e.removeChild(e.firstChild); }
  function norm(s) { return String(s || '').toLowerCase(); }
  function initials(n) {
    var p = String(n || '?').split(/\s+/).filter(Boolean);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function slug(s) { return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'deed'; }
  function icon(stem, cls, alt) {
    var url = stem && A && A.icon ? A.icon(stem) : '';
    var wrap = h('span', { class: 'rn-medal' + (cls ? ' ' + cls : '') });
    if (url) {
      var img = h('img', { src: url, alt: alt || '', draggable: 'false', width: '128', height: '128' });
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); });
      wrap.appendChild(img);
    }
    return wrap;
  }
  function face(name, cls) {
    var wrap = h('span', { class: 'rn-face' + (cls ? ' ' + cls : '') }, h('span', { class: 'rn-face-ini' }, initials(name)));
    var url = A && A.face ? A.face(name) : null;
    if (url) {
      var img = h('img', { src: url, alt: '', draggable: 'false' });
      /* A broken image is REMOVED, never left as an empty box (the deck's
         Ultralight rule); the initials underneath are the fallback. */
      img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); });
      wrap.appendChild(img);
    }
    return wrap;
  }
  function reachOf(d) { return REACH[REACH_IX[d.reach] !== undefined ? REACH_IX[d.reach] : 1]; }
  function tierOf(d) { return TIERS[TIER_IX[d.tier] !== undefined ? TIER_IX[d.tier] : 2]; }
  function people() { return (st.doc && st.doc.people) || []; }
  function totalPeople() { return people().length; }
  function deeds() { return (st.doc && st.doc.deeds) || []; }
  function findDeed(key) { var ds = deeds(); for (var i = 0; i < ds.length; i++) if (ds[i].deed_key === key) return ds[i]; return null; }
  function reachLine(d) {
    var r = reachOf(d);
    var holds = String(d.holds || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (r.id === 'hold' && holds.length) return holds.join(' · ');
    return r.label;
  }
  function knowText(d) {
    var n = d.known_by || 0;
    if (d.reach === 'realm' && n >= totalPeople() && n > 0) return 'everyone';
    return n === 0 ? 'no one yet' : n + (n === 1 ? ' knows' : ' know');
  }

  /* ---------------------------------------------------------- loading ----- */

  function load(quiet) {
    if (!A) return;
    if (!quiet) { st.state = st.doc ? 'ok' : 'loading'; render(); }
    A.load(function (err, doc) {
      /* No court plugin in this CHIM (anyone but Rober's install): the page
         has nothing to show and says nothing — it is not a broken feature. */
      if (doc && doc.absent) { st.state = 'absent'; if (host) { clear(host); host.style.display = 'none'; } return; }
      if (host) host.style.display = '';
      if (err || !doc || doc.ok === false) {
        st.state = st.doc ? 'ok' : 'error';
        st.msg = err || (doc && (doc.error || doc.why)) || 'The Renown ledger did not answer.';
      } else {
        st.doc = doc; st.state = 'ok'; st.msg = doc.msg || '';
      }
      render();
      if (st.pop && st.pop.refresh) st.pop.refresh();
    });
  }

  function op(name, payload, done) {
    A.op(name, payload, function (err, res) {
      if (err || (res && res.ok === false)) {
        done && done(err || (res && (res.error || res.why)) || 'That did not take.');
        return;
      }
      if (res && res.deeds) { st.doc = res; render(); if (st.pop && st.pop.refresh) st.pop.refresh(); done && done(null, res); }
      else { done && done(null, res); load(true); }
    });
  }

  /* ------------------------------------------------------------ render ---- */

  function matches(d, q) {
    if (!q) return true;
    var hay = [d.title, d.honorific, d.summary, d.story, d.era, reachLine(d), tierOf(d).one]
      .concat((d.knowers || []).map(function (k) { return k.name; })).join(' \n ');
    return q.split(/\s+/).filter(Boolean).every(function (w) { return norm(hay).indexOf(w) !== -1; });
  }
  function passes(d) {
    if (st.filter === 'titles') return !!d.honorific;
    if (st.filter === 'hidden') return d.reach === 'secret' || d.reach === 'witnesses';
    if (st.filter === 'canon') return d.status === 'canon';
    return true;
  }
  function visible() {
    var q = norm(st.q).trim();
    return deeds().filter(function (d) { return passes(d) && matches(d, q); });
  }

  function render() {
    if (!host) return;
    clear(host);
    host.classList.add('rn-host');

    if (st.state === 'loading' && !st.doc) {
      host.appendChild(h('div', { class: 'rn-wait' }, icon('gl-scroll', 'rn-medal-wait'), h('p', null, 'Unrolling the chronicle…')));
      return;
    }
    if (!st.doc) {
      host.appendChild(h('div', { class: 'rn-wait rn-wait-err' }, icon('gl-scroll', 'rn-medal-wait'),
        h('div', null,
          h('p', { class: 'rn-wait-head' }, 'The chronicle is closed'),
          h('p', null, st.msg || 'Renown lives in CHIM, which only runs while the game and the CHIM launcher are up.'),
          h('button', { type: 'button', class: 'rn-btn', onClick: function () { load(); } }, 'Try again'))));
      return;
    }

    host.appendChild(masthead());
    host.appendChild(titlePlates());
    host.appendChild(toolbar());
    host.appendChild(deedList());
    if (st.msg) host.appendChild(h('p', { class: 'rn-note rn-note-warn' }, st.msg));
    reveal();
  }

  function masthead() {
    var ds = deeds();
    var titles = ds.filter(function (d) { return d.honorific; }).length;
    var close = ds.filter(function (d) { return d.reach === 'secret' || d.reach === 'witnesses'; }).length;
    var player = (st.doc && st.doc.player) || 'the Dragonborn';
    return h('header', { class: 'rn-mast rn-rv rn-rv-mast' },
      h('div', { class: 'rn-mast-words' },
        h('p', { class: 'rn-kicker' }, 'The Chronicle of ' + player),
        h('h2', { class: 'rn-h' }, 'Renown'),
        h('p', { class: 'rn-sub' }, 'What Skyrim knows of his deeds, how far each has travelled, and exactly who in CHIM carries it.'),
        h('p', { class: 'rn-tally-line' },
          h('b', null, String(ds.length)), ' deeds', h('i', null, '·'), h('b', null, String(titles)), ' titles', h('i', null, '·'),
          h('b', null, String(close)), ' kept close', h('i', null, '·'), h('b', null, String(totalPeople())), ' souls in CHIM')),
      famePanel());
  }

  /* Fame: one rank for how far his name has travelled (renown_fame() in the
     court ext). The bar is ruled at every rank; gold to where his public renown
     stands, and a ghost of what the secrets would add if they came out. */
  function famePanel() {
    var f = (st.doc && st.doc.fame) || null;
    if (!f) return h('div', { class: 'rn-fame rn-fame-none' });
    var ranks = f.ranks || [];
    var top = ranks.length ? ranks[ranks.length - 1].at : 1;
    var span = Math.max(top * 1.12, f.score + f.hidden, 1);
    function pct(v) { return Math.max(0, Math.min(100, v / span * 100)); }
    var bar = h('div', { class: 'rn-fame-bar', 'aria-hidden': 'true' },
      h('span', { class: 'rn-fame-ghost', style: 'left:' + pct(f.score) + '%;width:' + (pct(f.score + f.hidden) - pct(f.score)) + '%' }),
      h('span', { class: 'rn-fame-fill', style: 'width:' + pct(f.score) + '%' }));
    ranks.forEach(function (r, i) {
      if (i === 0) return;
      bar.appendChild(h('span', { class: 'rn-fame-tick' + (f.score >= r.at ? ' on' : ''), style: 'left:' + pct(r.at) + '%', title: r.rank + ' at ' + r.at }));
    });
    var toNext = f.next_at !== null && f.next_at !== undefined ? Math.max(0, Math.ceil(f.next_at - f.score)) : 0;
    return h('div', { class: 'rn-fame', title: 'Fame is every deed’s greatness × how far it has spread. Secrets add nothing until they come out.' },
      icon('rn-laurel', 'rn-medal-fame'),
      h('div', { class: 'rn-fame-words' },
        h('p', { class: 'rn-fame-k' }, 'Fame · rank ' + (f.level + 1) + ' of ' + ranks.length),
        h('p', { class: 'rn-fame-rank' }, f.rank),
        h('p', { class: 'rn-fame-desc' }, f.desc),
        bar,
        h('p', { class: 'rn-fame-foot' },
          h('b', null, String(Math.round(f.score))), ' renown',
          f.next ? [h('i', null, '·'), String(toNext) + ' to ', h('b', null, f.next)] : [h('i', null, '·'), 'the highest rank'],
          f.hidden ? [h('i', null, '·'), h('span', { class: 'rn-fame-hid' }, '+' + Math.round(f.hidden) + ' hidden')] : null)));
  }

  /* The titles he is styled by — every honorific, most renowned first, each a
     gilded plate that says how far that title has carried. */
  function titlePlates() {
    var ds = deeds().filter(function (d) { return d.honorific; });
    var wrap = h('section', { class: 'rn-plates', 'aria-label': 'Titles' });
    if (!ds.length) {
      wrap.appendChild(h('p', { class: 'rn-note' }, 'No deed grants a title yet. Give one an honorific and it is styled here — and in the standing of everyone who knows it.'));
      return wrap;
    }
    ds.forEach(function (d, i) {
      var r = reachOf(d);
      wrap.appendChild(h('button', {
        type: 'button', class: 'rn-plate rn-rv rn-rv-plate rn-reach-' + r.id, style: 'animation-delay:' + (60 + i * 55) + 'ms',
        title: d.honorific + ' — ' + (d.reach === 'realm' ? 'known across Skyrim' : (d.known_by ? knowText(d) + ' it' : 'known to no one yet')) + '. Open the deed.',
        onClick: function () { openFolio(d.deed_key); }
      },
        icon(d.icon, 'rn-medal-plate'),
        h('span', { class: 'rn-plate-words' },
          h('span', { class: 'rn-plate-name' }, d.honorific),
          h('span', { class: 'rn-plate-reach' }, reachLine(d) + ' · ' + knowText(d)))));
    });
    return wrap;
  }

  function toolbar() {
    var input = h('input', {
      class: 'rn-search', type: 'text', placeholder: 'Search deeds, titles, people…',
      'aria-label': 'Search deeds', autocomplete: 'off', spellcheck: 'false', value: st.q
    });
    input.addEventListener('input', function () {
      st.q = input.value;
      var list = host.querySelector('.rn-list');
      if (list) { var fresh = deedList(); list.parentNode.replaceChild(fresh, list); }
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = visible();
        if (v.length) { e.preventDefault(); openFolio(v[0].deed_key); }
      } else if (e.key === 'Escape' && input.value) {
        e.preventDefault(); e.stopPropagation(); input.value = ''; st.q = '';
        var list = host.querySelector('.rn-list');
        if (list) list.parentNode.replaceChild(deedList(), list);
      }
    });
    var clearBtn = h('button', { type: 'button', class: 'rn-search-x', 'aria-label': 'Clear search', title: 'Clear',
      onClick: function () { input.value = ''; st.q = ''; render(); var i = host.querySelector('.rn-search'); if (i) i.focus(); } }, '×');

    var seg = h('div', { class: 'rn-seg', role: 'tablist', 'aria-label': 'Show' });
    FILTERS.forEach(function (f) {
      seg.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': st.filter === f.id ? 'true' : 'false',
        class: 'rn-seg-b' + (st.filter === f.id ? ' on' : ''),
        onClick: function () { st.filter = f.id; render(); } }, f.label));
    });
    return h('div', { class: 'rn-tools rn-rv rn-rv-tools' },
      h('div', { class: 'rn-search-wrap' }, icon('gl-magnifier', 'rn-medal-search'), input, clearBtn),
      seg,
      h('div', { class: 'rn-tools-acts' },
        h('button', { type: 'button', class: 'rn-btn rn-btn-ghost', title: 'See exactly what one person in CHIM has heard of him', onClick: openLens },
          icon('gl-speech', 'rn-medal-btn'), 'What does someone know?'),
        h('button', { type: 'button', class: 'rn-btn rn-btn-gold', onClick: function () { openFolio(null); } },
          icon('gl-notepad', 'rn-medal-btn'), 'Inscribe a deed')));
  }

  function meter(d) {
    var ix = REACH_IX[d.reach] !== undefined ? REACH_IX[d.reach] : 1;
    var bar = h('span', { class: 'rn-meter', 'aria-hidden': 'true' });
    for (var i = 0; i < REACH.length; i++) bar.appendChild(h('span', { class: 'rn-meter-step' + (i <= ix ? ' lit' : '') + (i === ix ? ' tip' : '') }));
    return h('span', { class: 'rn-spread', title: reachOf(d).note },
      bar,
      h('span', { class: 'rn-spread-words' },
        h('b', null, reachLine(d)), h('span', null, knowText(d))));
  }

  function deedRow(d, i) {
    var r = reachOf(d);
    return h('button', {
      type: 'button', class: 'rn-row rn-rv rn-rv-row rn-reach-' + r.id + (d.status === 'canon' ? ' rn-canon' : ''),
      style: 'animation-delay:' + Math.min(40 + i * 45, 600) + 'ms',
      'aria-label': d.title + ' — open the deed', onClick: function () { openFolio(d.deed_key); }
    },
      icon(d.icon, 'rn-medal-row'),
      h('span', { class: 'rn-row-words' },
        h('span', { class: 'rn-row-head' },
          h('span', { class: 'rn-row-title' }, d.title),
          d.honorific && d.honorific !== d.title ? h('span', { class: 'rn-ribbon' }, d.honorific) : null,
          d.status === 'canon' ? h('span', { class: 'rn-chip rn-chip-canon', title: 'Written into the story; not yet played in the save' }, 'Story canon') : null,
          d.reach === 'secret' ? h('span', { class: 'rn-chip rn-chip-secret' }, 'Secret') : null),
        h('span', { class: 'rn-row-sum' }, d.summary ? cap(d.summary) + '.' : 'No line written yet — open it to say what people are told.')),
      meter(d),
      h('span', { class: 'rn-chev', 'aria-hidden': 'true' }, '›'));
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function deedList() {
    var v = visible();
    var list = h('div', { class: 'rn-list' });
    if (!v.length) {
      list.appendChild(h('div', { class: 'rn-empty' }, icon('gl-magnifier', 'rn-medal-wait'),
        h('p', null, st.q ? 'No deed matches “' + st.q + '”.' : 'Nothing here under this filter.'),
        st.q || st.filter !== 'all' ? h('button', { type: 'button', class: 'rn-btn', onClick: function () { st.q = ''; st.filter = 'all'; render(); } }, 'Show every deed') : null));
      return list;
    }
    var n = 0;
    TIERS.forEach(function (t) {
      var inTier = v.filter(function (d) { return (TIER_IX[d.tier] !== undefined ? d.tier : 'notable') === t.id; });
      if (!inTier.length) return;
      list.appendChild(h('h3', { class: 'rn-tier rn-rv rn-rv-tier rn-tier-' + t.id },
        h('span', { class: 'rn-tier-rule' }), h('span', { class: 'rn-tier-name' }, t.label),
        h('span', { class: 'rn-tier-n' }, String(inTier.length)), h('span', { class: 'rn-tier-rule' })));
      inTier.forEach(function (d) { list.appendChild(deedRow(d, n++)); });
    });
    return list;
  }

  /* Scroll reveals. Each kind arrives its own way (masthead settles, plates
     rise in a stagger, tier rules draw out, rows slide in from the medal side).
     Only where IntersectionObserver exists AND motion is welcome; otherwise
     everything is simply there — the static page is the same page. */
  function reveal() {
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || !('IntersectionObserver' in window)) { host.classList.add('rn-still'); return; }
    host.classList.add('rn-anim');
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('rn-shown'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -6% 0px' });
    var els = host.querySelectorAll('.rn-rv');
    for (var i = 0; i < els.length; i++) {
      if (st.revealed) els[i].classList.add('rn-shown'); else io.observe(els[i]);
    }
    st.revealed = true;
  }

  /* ------------------------------------------------------------ popouts --- */

  /* Body-anchored, fills the viewport (so bare vh/vw are right and it must NOT
     wear the deck's ui-scale), owns Escape through a capture listener, and
     tells app.js it is up through isOpen(). */
  function popout(cls, labelText, build) {
    if (st.pop) st.pop.close();
    var back = h('div', { class: 'rn-back ' + (A && A.surface === 'portal' ? 'rn-on-portal' : 'rn-on-deck'), role: 'dialog', 'aria-modal': 'true', 'aria-label': labelText });
    var card = h('article', { class: 'rn-pop ' + cls });
    back.appendChild(card);
    var ctl = { back: back, card: card, refresh: null, guard: null };
    function key(e) {
      if (e.key !== 'Escape') return;
      if (ctl.guard && ctl.guard(e)) return;   // an inner list ate it (cleared its search)
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      e._fdDossierHandled = true;
      if (A && A.escaped) A.escaped();   // deck: stamp it, so C++'s forwarded Esc stands down
      close();
    }
    function close() {
      window.removeEventListener('keydown', key, true);
      if (back.parentNode) back.parentNode.removeChild(back);
      if (st.pop === ctl) st.pop = null;
      if (A && A.capture) A.capture(false);
      var rows = host ? host.querySelectorAll('.rn-row.rn-opened') : [];
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('rn-opened');
    }
    ctl.close = close;
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    window.addEventListener('keydown', key, true);
    st.pop = ctl;
    build(ctl);
    document.body.appendChild(back);
    if (A && A.capture) A.capture(true);
    setTimeout(function () { back.classList.add('rn-back-in'); }, 16);
    return ctl;
  }

  /* ---- the deed folio: one deed, everything about it, editable ---------- */

  function openFolio(key) {
    var creating = !key;
    var base = creating ? {
      deed_key: '', title: '', honorific: '', tier: 'notable', reach: 'witnesses', holds: '', houses: '',
      summary: '', story: '', icon: 'gl-scroll', source: 'rp', status: 'played', era: '', knowers: [], explicit: [], known_by: 0, line: ''
    } : findDeed(key);
    if (!base) return;
    if (!creating && host) {
      var rows = host.querySelectorAll('.rn-row');
      for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('aria-label') === base.title + ' — open the deed') rows[i].classList.add('rn-opened');
    }
    var draft = JSON.parse(JSON.stringify(base));
    var dirty = false, busy = '', note = '', armed = false, whoQ = '', iconQ = '', pickIcon = false;

    popout('rn-folio', creating ? 'Inscribe a deed' : base.title, function (ctl) {
      ctl.guard = function (e) {
        var t = e.target;
        if (t && t.tagName === 'INPUT' && t.value && /rn-who-q|rn-icon-q/.test(t.className)) {
          e.preventDefault(); e.stopPropagation(); t.value = ''; whoQ = ''; iconQ = ''; paint(); return true;
        }
        if (pickIcon) { e.preventDefault(); e.stopPropagation(); pickIcon = false; paint(); return true; }
        return false;
      };
      ctl.refresh = function () {
        if (creating) return;
        var fresh = findDeed(base.deed_key);
        if (!fresh) { ctl.close(); return; }
        base = fresh;
        if (!dirty) draft = JSON.parse(JSON.stringify(fresh));
        else { draft.knowers = fresh.knowers; draft.explicit = fresh.explicit; draft.known_by = fresh.known_by; draft.line = fresh.line; }
        paint();
      };

      function set(k, v) { draft[k] = v; dirty = true; paintFoot(); }
      function field(label, k, opts) {
        opts = opts || {};
        var tag = opts.area ? 'textarea' : 'input';
        var inp = h(tag, { class: 'rn-in' + (opts.area ? ' rn-in-area' : '') + (opts.small ? ' rn-in-area-sm' : ''), placeholder: opts.ph || '', maxlength: String(opts.max || 120),
          spellcheck: opts.area ? 'true' : 'false', autocomplete: 'off', 'aria-label': label });
        inp.value = draft[k] || '';
        inp.addEventListener('input', function () { set(k, inp.value); if (k === 'summary') paintLine(); });
        return h('label', { class: 'rn-field' + (opts.wide ? ' rn-field-wide' : '') },
          h('span', { class: 'rn-field-l' }, label, opts.hint ? h('em', null, opts.hint) : null), inp);
      }

      var body = h('div', { class: 'rn-folio-body' });
      var foot = h('footer', { class: 'rn-folio-foot' });
      var head = h('header', { class: 'rn-folio-head' });
      ctl.card.appendChild(head);
      ctl.card.appendChild(body);
      ctl.card.appendChild(foot);

      function paintHead() {
        clear(head);
        var t = tierOf(draft), r = reachOf(draft);
        head.appendChild(h('button', { type: 'button', class: 'rn-folio-medal', title: 'Choose the deed’s emblem',
          onClick: function () { pickIcon = !pickIcon; paint(); } }, icon(draft.icon, 'rn-medal-hero'), h('span', { class: 'rn-folio-medal-cue' }, 'Emblem')));
        head.appendChild(h('div', { class: 'rn-folio-id' },
          h('p', { class: 'rn-kicker' }, t.one + (draft.era ? ' · ' + draft.era : '') + (draft.status === 'canon' ? ' · story canon' : '')),
          h('h2', { class: 'rn-folio-title' }, draft.title || 'An untold deed'),
          draft.honorific ? h('p', { class: 'rn-folio-hon' }, h('span', null, 'Styles him'), ' ' + draft.honorific) : null,
          h('p', { class: 'rn-folio-reach rn-reach-' + r.id }, icon(r.icon, 'rn-medal-inline'), r.label + ' · ' + knowText(draft))));
        head.appendChild(h('button', { type: 'button', class: 'rn-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: ctl.close }, '×'));
      }

      function iconPicker() {
        var q = h('input', { class: 'rn-in rn-icon-q', type: 'text', placeholder: 'Find an emblem — sun, crown, skull…', 'aria-label': 'Find an emblem', autocomplete: 'off', spellcheck: 'false', value: iconQ });
        var grid = h('div', { class: 'rn-icon-grid' });
        function fill() {
          clear(grid);
          var hits = EMBLEMS.filter(function (s) { return !iconQ || s.indexOf(norm(iconQ).trim()) !== -1; });
          hits.forEach(function (s) {
            grid.appendChild(h('button', { type: 'button', class: 'rn-icon-b' + (draft.icon === s ? ' on' : ''), title: s.slice(3),
              onClick: function () { set('icon', s); pickIcon = false; paint(); } }, icon(s, 'rn-medal-pick'), h('span', null, s.slice(3).replace(/-/g, ' ')), s.indexOf('rn-') === 0 ? h('em', null, 'renown') : null));
          });
          if (!hits.length) grid.appendChild(h('p', { class: 'rn-note' }, 'No emblem called “' + iconQ + '”.'));
        }
        q.addEventListener('input', function () { iconQ = q.value; fill(); });
        q.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { var first = grid.querySelector('.rn-icon-b'); if (first) { e.preventDefault(); first.click(); } }
        });
        fill();
        setTimeout(function () { try { q.focus(); } catch (_) {} }, 30);
        return h('section', { class: 'rn-sect rn-icon-pick' }, h('h3', { class: 'rn-sect-h' }, 'Emblem'), q, grid);
      }

      function reachSection() {
        var seg = h('div', { class: 'rn-reach-seg', role: 'radiogroup', 'aria-label': 'How far it has spread' });
        REACH.forEach(function (r, i) {
          var on = draft.reach === r.id;
          seg.appendChild(h('button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
            class: 'rn-reach-b rn-reach-' + r.id + (on ? ' on' : '') + (i < (REACH_IX[draft.reach] || 0) ? ' under' : ''),
            title: r.note, onClick: function () { setReach(r.id); } },
            icon(r.icon, 'rn-medal-reach'), h('span', { class: 'rn-reach-l' }, r.label)));
        });
        var r = reachOf(draft);
        var sect = h('section', { class: 'rn-sect' },
          h('h3', { class: 'rn-sect-h' }, 'How far it has spread'),
          seg,
          h('p', { class: 'rn-reach-note' }, r.note));
        if (draft.reach === 'hold') sect.appendChild(chipEditor('Holds', 'holds', (st.doc && st.doc.holds) || [], 'Add a hold — Whiterun, Haafingar…'));
        sect.appendChild(chipEditor('Whole houses who know', 'houses', (st.doc && st.doc.houses) || [], 'Add a house — Battle-Born…'));
        return sect;
      }

      function setReach(id) {
        draft.reach = id;
        if (creating) { dirty = true; paint(); return; }
        busy = 'reach'; paint();
        op('set', { key: base.deed_key, fields: { reach: id, holds: draft.holds } }, function (err) {
          busy = ''; note = err ? String(err) : 'Spread changed. CHIM tells the new circle from the next line on.'; paint();
        });
      }

      function chipEditor(label, k, known, ph) {
        var vals = String(draft[k] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        var row = h('div', { class: 'rn-chips' });
        vals.forEach(function (v) {
          row.appendChild(h('span', { class: 'rn-chip rn-chip-ed' }, v,
            h('button', { type: 'button', class: 'rn-chip-x', 'aria-label': 'Remove ' + v,
              onClick: function () { set(k, vals.filter(function (x) { return x !== v; }).join(', ')); paint(); } }, '×')));
        });
        var inp = h('input', { class: 'rn-in rn-chip-in', type: 'text', placeholder: ph, 'aria-label': label, autocomplete: 'off', spellcheck: 'false' });
        var sug = h('div', { class: 'rn-sug' });
        function suggest() {
          clear(sug);
          var q = norm(inp.value).trim();
          var hits = known.filter(function (x) { return vals.indexOf(x) === -1 && (!q || norm(x).indexOf(q) !== -1); }).slice(0, 8);
          hits.forEach(function (x) { sug.appendChild(h('button', { type: 'button', class: 'rn-sug-b', onClick: function () { pick(x); } }, x)); });
        }
        function pick(x) { x = String(x || '').trim(); if (!x || vals.indexOf(x) !== -1) return; set(k, vals.concat([x]).join(', ')); paint(); }
        inp.addEventListener('input', suggest);
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); var first = sug.querySelector('.rn-sug-b'); pick(first ? first.textContent : inp.value); }
        });
        suggest();
        return h('div', { class: 'rn-chip-ed-wrap' }, h('span', { class: 'rn-field-l' }, label), row, inp, sug);
      }

      function whoSection() {
        var explicit = {}; (draft.explicit || []).forEach(function (x) { explicit[norm(x.name)] = x.knows; });
        var knowers = draft.knowers || [];
        var kept = (draft.explicit || []).filter(function (x) { return !x.knows; });
        var list = h('div', { class: 'rn-who-list' });
        var q = h('input', { class: 'rn-in rn-who-q', type: 'text', placeholder: 'Find someone — or name a new witness and press Enter',
          'aria-label': 'Find or add a witness', autocomplete: 'off', spellcheck: 'false', value: whoQ });

        function personRow(name, why, state) {
          return h('div', { class: 'rn-who' + (state === 'no' ? ' rn-who-kept' : '') },
            face(name, 'rn-face-who'),
            h('span', { class: 'rn-who-words' }, h('span', { class: 'rn-who-name' }, name),
              h('span', { class: 'rn-who-why' }, state === 'no' ? 'kept from her' : why)),
            creating ? null : h('span', { class: 'rn-who-acts' },
              state === 'yes'
                ? h('button', { type: 'button', class: 'rn-mini', title: 'She knows because she was named. Let the reach decide instead.', onClick: function () { knows(name, 'clear'); } }, 'Unname')
                : state === 'no'
                  ? h('button', { type: 'button', class: 'rn-mini', title: 'Let the reach decide whether she knows', onClick: function () { knows(name, 'clear'); } }, 'Restore')
                  : h('button', { type: 'button', class: 'rn-mini rn-mini-warn', title: 'Keep this from her even though the reach would tell her', onClick: function () { knows(name, 'no'); } }, 'Keep from her')));
        }
        function fill() {
          clear(list);
          var w = norm(whoQ).trim();
          var shown = 0, CAP = 80;
          knowers.forEach(function (k) {
            if (w && norm(k.name).indexOf(w) === -1 && norm(k.why).indexOf(w) === -1) return;
            if (shown++ >= CAP) return;
            list.appendChild(personRow(k.name, k.why, explicit[norm(k.name)] === true ? 'yes' : 'reach'));
          });
          kept.forEach(function (k) {
            if (w && norm(k.name).indexOf(w) === -1) return;
            list.appendChild(personRow(k.name, '', 'no'));
          });
          var known = {}; knowers.forEach(function (k) { known[norm(k.name)] = 1; });
          if (w && !creating) {
            var cands = people().filter(function (p) { return !known[norm(p.name)] && norm(p.name).indexOf(w) !== -1; }).slice(0, 6);
            if (cands.length) list.appendChild(h('p', { class: 'rn-who-sub' }, 'Does not know it yet'));
            cands.forEach(function (p) {
              list.appendChild(h('div', { class: 'rn-who rn-who-cand' }, face(p.name, 'rn-face-who'),
                h('span', { class: 'rn-who-words' }, h('span', { class: 'rn-who-name' }, p.name),
                  h('span', { class: 'rn-who-why' }, [p.kind || (p.rung === null ? 'outside his household' : ''), p.hold ? 'last heard in ' + p.hold : ''].filter(Boolean).join(' · ') || 'no word of where she is')),
                h('span', { class: 'rn-who-acts' }, h('button', { type: 'button', class: 'rn-mini rn-mini-gold', onClick: function () { knows(p.name, 'yes'); } }, 'Tell her'))));
            });
          }
          if (!list.firstChild) list.appendChild(h('p', { class: 'rn-note' }, creating
            ? 'Save the deed first, then name who was there.'
            : (w ? 'No one by that name in CHIM. Talk to her once in-game and she appears.' : 'No one in CHIM knows this yet. Name a witness above, or widen its spread.')));
          if (shown > CAP) list.appendChild(h('p', { class: 'rn-note' }, '…and ' + (shown - CAP) + ' more. Search to find one.'));
        }
        q.addEventListener('input', function () { whoQ = q.value; fill(); });
        q.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' || creating) return;
          var v = norm(q.value).trim(); if (!v) return;
          e.preventDefault();
          var exact = people().filter(function (p) { return norm(p.name) === v; })[0]
            || people().filter(function (p) { return norm(p.name).indexOf(v) !== -1; })[0];
          if (exact) knows(exact.name, 'yes');
        });
        fill();
        var total = totalPeople();
        return h('section', { class: 'rn-sect rn-who-sect' },
          h('h3', { class: 'rn-sect-h' }, 'Who knows', h('span', { class: 'rn-sect-n' }, knowers.length + (total ? ' of ' + total + ' in CHIM' : ''))),
          h('div', { class: 'rn-search-wrap rn-search-sm' }, icon('gl-magnifier', 'rn-medal-search'), q),
          list);
      }

      function knows(name, v) {
        busy = 'knows'; paint();
        op('knows', { key: base.deed_key, npc: name, v: v }, function (err) {
          busy = '';
          note = err ? String(err) : (v === 'yes' ? name + ' knows it now.' : v === 'no' ? 'Kept from ' + name + '.' : name + ' follows the spread again.');
          whoQ = ''; paint();
        });
      }

      var lineBox = null;
      function paintLine() {
        if (!lineBox) return;
        clear(lineBox);
        var t = (draft.title || '').trim(), s = (draft.summary || '').trim();
        var line = t && s ? t + ': ' + s : (s || t || '—');
        if (draft.reach === 'secret') line += ' (Few know this. You do not speak of it before others.)';
        lineBox.appendChild(h('span', { class: 'rn-code-tag' }, '<renown>'));
        lineBox.appendChild(h('span', { class: 'rn-code-line' }, '- ' + line));
        if (draft.honorific) lineBox.appendChild(h('span', { class: 'rn-code-std' }, '<standing> … ' + draft.honorific + ' …'));
      }
      function chimSection() {
        lineBox = h('div', { class: 'rn-code', 'aria-label': 'The exact line CHIM injects' });
        paintLine();
        var n = draft.known_by || 0;
        return h('section', { class: 'rn-sect rn-chim' },
          h('h3', { class: 'rn-sect-h' }, 'What CHIM tells them'),
          h('p', { class: 'rn-chim-where' },
            'Rides in the ', h('b', null, '<renown>'), ' block of the character section for ',
            h('b', null, n === totalPeople() && n > 0 ? 'every NPC in CHIM' : plural(n, 'NPC')),
            draft.honorific ? [', and its title joins the ', h('b', null, '<standing>'), ' line that names him'] : null,
            '. Each NPC carries her ', String((st.doc && st.doc.max_lines) || 9), ' most renowned deeds.'),
          lineBox);
      }

      function editSection() {
        var tierSeg = h('div', { class: 'rn-seg rn-seg-tier' });
        TIERS.forEach(function (t) {
          tierSeg.appendChild(h('button', { type: 'button', class: 'rn-seg-b' + (draft.tier === t.id ? ' on' : ''),
            onClick: function () { set('tier', t.id); paint(); } }, t.one));
        });
        var statusSeg = h('div', { class: 'rn-seg' });
        [['played', 'Played in the save'], ['canon', 'Story canon']].forEach(function (p) {
          statusSeg.appendChild(h('button', { type: 'button', class: 'rn-seg-b' + (draft.status === p[0] ? ' on' : ''),
            onClick: function () { set('status', p[0]); paint(); } }, p[1]));
        });
        return h('section', { class: 'rn-sect rn-edit' },
          h('h3', { class: 'rn-sect-h' }, creating ? 'The deed' : 'Edit the deed'),
          h('div', { class: 'rn-fields' },
            field('Name of the deed', 'title', { ph: 'The Break of Dawn', max: 120 }),
            field('Title it grants', 'honorific', { ph: 'Champion of Meridia — or leave empty', max: 120, hint: 'optional' }),
            field('What people are told', 'summary', { ph: 'he relit Meridia’s temple at Kilkreath…', max: 400, wide: true, area: true, small: true, hint: 'one sentence, lowercase start — this is the CHIM line' }),
            field('The tale', 'story', { ph: 'The whole story, for you. CHIM never sees this.', max: 4000, area: true, wide: true }),
            field('When', 'era', { ph: '4E 202', max: 60 }),
            h('div', { class: 'rn-field' }, h('span', { class: 'rn-field-l' }, 'Standing of the deed'), tierSeg),
            h('div', { class: 'rn-field' }, h('span', { class: 'rn-field-l' }, 'In the save'), statusSeg)));
      }

      function paintFoot() {
        clear(foot);
        foot.appendChild(h('p', { class: 'rn-foot-note' + (/did not|refused|fail|error|no deed|needs/i.test(note) ? ' warn' : '') }, busy ? 'Writing to CHIM…' : note));
        if (!creating) {
          foot.appendChild(h('button', { type: 'button', class: 'rn-btn rn-btn-danger' + (armed ? ' armed' : ''),
            title: armed ? 'Press again to strike it from the chronicle' : 'Delete this deed',
            onClick: function () {
              if (!armed) { armed = true; paintFoot(); setTimeout(function () { armed = false; if (foot.parentNode) paintFoot(); }, 3500); return; }
              busy = 'drop'; paintFoot();
              op('drop', { key: base.deed_key }, function (err) { busy = ''; if (err) { note = String(err); paintFoot(); } else ctl.close(); });
            } }, armed ? 'Strike it — sure?' : 'Strike from the chronicle'));
        }
        foot.appendChild(h('button', { type: 'button', class: 'rn-btn rn-btn-gold', disabled: (!dirty || !!busy || !(draft.title || '').trim()) ? 'disabled' : null,
          onClick: save }, creating ? 'Inscribe it' : 'Save changes'));
      }

      function save() {
        var key = creating ? slug(draft.title) : base.deed_key;
        if (creating && findDeed(key)) key = (key + '-' + Date.now().toString(36).slice(-4)).slice(0, 48);
        var fields = {};
        ['title', 'honorific', 'tier', 'reach', 'holds', 'houses', 'summary', 'story', 'icon', 'source', 'status', 'era'].forEach(function (k) {
          if (creating || String(draft[k] || '') !== String(base[k] || '')) fields[k] = String(draft[k] || '');
        });
        busy = 'save'; paintFoot();
        op('set', { key: key, fields: fields }, function (err) {
          busy = '';
          if (err) { note = String(err); paintFoot(); return; }
          dirty = false; note = creating ? 'Inscribed. Name who was there below.' : 'Saved. CHIM uses it from the next line on.';
          if (creating) { creating = false; base = findDeed(key) || base; base.deed_key = key; draft = JSON.parse(JSON.stringify(findDeed(key) || draft)); }
          paint();
        });
      }

      function paint() {
        paintHead();
        clear(body);
        if (pickIcon) body.appendChild(iconPicker());
        if (!creating && draft.story) body.appendChild(h('section', { class: 'rn-sect rn-tale' }, h('h3', { class: 'rn-sect-h' }, 'The tale'),
          String(draft.story).split(/\n{2,}/).map(function (p) { return h('p', null, p); })));
        /* Two balanced rows: the tale beside what CHIM is told of it, then the
           spread beside who it reached. With no tale yet, CHIM's line pairs
           with the spread instead and the people list takes the row below. */
        if (!creating && draft.story) body.appendChild(chimSection());
        body.appendChild(reachSection());
        body.appendChild(whoSection());
        if (creating || !draft.story) body.appendChild(chimSection());
        body.appendChild(editSection());
        paintFoot();
      }
      paint();
    });
  }

  /* ---- the lens: one NPC, exactly what she has heard ------------------- */

  function openLens() {
    var q = '', chosen = null, res = null, busy = false, err = '';
    popout('rn-lens', 'What does someone know?', function (ctl) {
      var head = h('header', { class: 'rn-folio-head' },
        icon('gl-speech', 'rn-medal-hero'),
        h('div', { class: 'rn-folio-id' },
          h('p', { class: 'rn-kicker' }, 'The lens'),
          h('h2', { class: 'rn-folio-title' }, 'What does someone know?'),
          h('p', { class: 'rn-sub' }, 'Pick anyone CHIM knows. You see the titles she calls him by and every deed she has heard of — word for word what she is told.')),
        h('button', { type: 'button', class: 'rn-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: ctl.close }, '×'));
      var body = h('div', { class: 'rn-folio-body rn-lens-body' });
      ctl.card.appendChild(head); ctl.card.appendChild(body);
      var input = h('input', { class: 'rn-in rn-who-q', type: 'text', placeholder: 'Who? Type a name and press Enter', 'aria-label': 'Who', autocomplete: 'off', spellcheck: 'false' });
      var list = h('div', { class: 'rn-lens-list' });
      var out = h('div', { class: 'rn-lens-out' });
      ctl.guard = function (e) {
        if (e.target === input && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; q = ''; fill(); return true; }
        return false;
      };
      function fill() {
        clear(list);
        var w = norm(q).trim();
        var hits = people().filter(function (p) { return !w || norm(p.name).indexOf(w) !== -1; }).slice(0, 40);
        hits.forEach(function (p) {
          list.appendChild(h('button', { type: 'button', class: 'rn-lens-p' + (chosen === p.name ? ' on' : ''), onClick: function () { choose(p.name); } },
            face(p.name, 'rn-face-lens'), h('span', null, p.name)));
        });
        if (!hits.length) list.appendChild(h('p', { class: 'rn-note' }, 'No one called “' + q + '” in CHIM.'));
      }
      function choose(name) {
        chosen = name; busy = true; err = ''; res = null; fill(); paintOut();
        op('preview', { npc: name }, function (e, r) { busy = false; if (e) err = String(e); else res = r; paintOut(); });
      }
      function paintOut() {
        clear(out);
        if (!chosen) { out.appendChild(h('div', { class: 'rn-lens-empty' }, icon('gl-eye', 'rn-medal-wait'), h('p', null, 'Choose someone, and read exactly what CHIM tells her about him: the titles she uses and every deed that has reached her.'))); return; }
        out.appendChild(h('div', { class: 'rn-lens-who' }, face(chosen, 'rn-face-hero'), h('h3', null, chosen)));
        if (busy) { out.appendChild(h('p', { class: 'rn-note' }, 'Asking CHIM…')); return; }
        if (err) { out.appendChild(h('p', { class: 'rn-note rn-note-warn' }, err)); return; }
        var titles = (res && res.titles) || [];
        out.appendChild(h('p', { class: 'rn-field-l' }, 'She calls him'));
        out.appendChild(titles.length
          ? h('div', { class: 'rn-chips' }, titles.slice(0, 4).map(function (t) { return h('span', { class: 'rn-chip rn-chip-title' }, t); }))
          : h('p', { class: 'rn-note' }, 'No titles — she knows him only as a lord.'));
        out.appendChild(h('p', { class: 'rn-field-l' }, 'Her <renown> block'));
        var block = (res && res.block) || '';
        out.appendChild(block ? h('pre', { class: 'rn-code rn-code-pre' }, block) : h('p', { class: 'rn-note' }, 'She has heard of none of his deeds.'));
      }
      input.addEventListener('input', function () { q = input.value; fill(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { var first = list.querySelector('.rn-lens-p'); if (first) { e.preventDefault(); first.click(); } }
      });
      body.appendChild(h('div', { class: 'rn-lens-pick' }, h('div', { class: 'rn-search-wrap rn-search-sm' }, icon('gl-magnifier', 'rn-medal-search'), input), list));
      body.appendChild(out);
      fill(); paintOut();
      setTimeout(function () { try { input.focus(); } catch (_) {} }, 40);
    });
  }

  /* ------------------------------------------------------------ public ---- */

  window.HDRenown = {
    mount: function (el, adapter) {
      A = adapter; host = el;
      if (!host) return;
      if (st.doc) render(); else load();
    },
    refresh: function () { load(true); },
    isOpen: function () { return !!st.pop; },
    close: function () { if (st.pop) st.pop.close(); },
    open: openFolio,
    _state: st, _gl: EMBLEMS
  };
})();
