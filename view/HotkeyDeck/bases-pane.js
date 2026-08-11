'use strict';

/* ====================================================================== *
 *  Bases — Nether's Follower Framework's home bases, inside the Domains tab.
 *
 *  Rober's ask (2026-08-11): he runs a plugin that raises NFF's base cap to
 *  64, and NFF only exposes bases through its MCM's Bases page — three
 *  dropdowns you cycle (which base · which resident · which destination)
 *  and a column of enabled/disabled text options. At 64 bases that stops
 *  being usable. So: the same operations, as a real list with a real
 *  search, on the tab that already means "places I care about".
 *
 *  A MODE, not a tab. The Domains tab grows a segmented switch — 🗺 Places
 *  (the existing Mark & Recall pane) ‖ 🏰 Bases (this) — because both
 *  answer "where in Skyrim", and F15 already lands here.
 *
 *  SELF-MOUNTING. Every node here is built in JS and appended to #dm-pane
 *  at first show; index.html gains only a <link> and a <script>. That is
 *  deliberate — five sessions edit this view concurrently, and a pane that
 *  needs no structural markup cannot lose a merge. Own stylesheet
 *  (bases-pane.css, linked from index.html), never app.css: the
 *  sync_view_frags truncation trap is why every new surface ships its own.
 *
 *  Bridge, one name per direction (the deck law — a shared name silently
 *  unplugs the handler):
 *      JS -> C++   nbGet(json) · nbOp(json)
 *      C++ -> JS   nbOpen(state) · nbResult({ok,msg})
 *  Every mutation is answered immediately by nbResult (the sentence, or
 *  the refusal) and then by a fresh nbOpen ~700 ms later, once NFF's own
 *  Papyrus function has actually landed. So a control that fails springs
 *  back to the engine's truth instead of lying.
 *
 *  NOTHING here re-implements NFF. Assigning a follower is NFF's
 *  SetFollowerHome; registering a spot is its SetBaseLocation; the caps,
 *  the names and the residents are read out of its own quest properties.
 *
 *  Ultralight rules honoured: no prompt/confirm (inline inputs + armed
 *  two-click for anything destructive), no native tooltips (title= is
 *  drawn by app.js's #hd-tip layer), no <select> (hours are ◀ ▶ steppers).
 * ====================================================================== */

(function () {

  const KINDS = [
    { k: 0, key: 'home', icon: '⌂', label: 'Home',
      hint: 'Where she goes when you dismiss her, and where she sleeps' },
    { k: 1, key: 'work', icon: '⚒', label: 'Work',
      hint: 'Where she spends working hours' },
    { k: 2, key: 'relax', icon: '♨', label: 'Relax',
      hint: 'Where she spends her off hours' },
  ];

  const TIMES = [
    { key: 'workStart', label: 'Work starts' },
    { key: 'workEnd', label: 'Work ends' },
    { key: 'relaxStart', label: 'Relax starts' },
    { key: 'relaxEnd', label: 'Relax ends' },
    { key: 'sleepStart', label: 'Sleep starts' },
    { key: 'sleepEnd', label: 'Sleep ends' },
  ];

  const ARM_MS = 2600;      // how long an armed destructive button stays armed
  const SEARCH_AT = 8;      // show a filter box once a list can exceed this

  const S = {
    mounted: false,
    mode: 'places',         // places | bases
    data: null,             // last nbOpen payload
    loading: false,
    sel: -1,                // selected base index
    q: '',                  // base-list filter
    who: '',                // resident / candidate filter
    armed: { key: '', at: 0 },
    claimCell: false,       // "claim the cell" for the next Set-home
    claimBeds: false,
    settingsOpen: false,
    renaming: '',           // '' | 'name' | 'home' | 'work' | 'relax'
    justSet: '',            // "<base>:<kind>" — one-shot gold sweep after a set
    picking: '',            // formId whose "move to a base" picker is open
    pickWho: '',            // that person's name, for the picker heading
    pickQ: '',              // the picker's own filter
    autoName: -1,           // base index awaiting an auto-name from its location
  };

  let bar = null, body = null, railList = null, main = null, statusChip = null;

  /* ============================================================ helpers == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }

  function say(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
    else console.log('[toast]', msg);
  }

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, String(attrs[k]));
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  /* ------------------------------------------------------ crests & faces -- */

  /* Initials, the deck's own rule (first + last word, uppercased) — shared with
     the Followers rail so a crest and a medallion read as the same object. */
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }

  /* A base's crest hue. NOT the Followers rail's `(i * 47) % 360` rainbow: a
     base sits inside a gold panel next to gold chrome, and a full-spectrum
     cyan or magenta crest fights it. This is a fixed earthen wheel — amber,
     bronze, moss, slate-blue, plum, rust, teal, sand — that stays in the
     deck's own register no matter how many bases exist. */
  const CREST_HUES = [38, 22, 96, 212, 292, 12, 176, 46];
  function hueOf(i) { return CREST_HUES[((i % CREST_HUES.length) + CREST_HUES.length) % CREST_HUES.length]; }

  /* A follower's portrait, resolved through the Followers pane's OWN store —
     the one C++ keeps fresh via fdPortraits, including the newest-file-wins
     `~<n>` suffixes a re-capture creates. Deliberately not a second index:
     two portrait resolvers would drift the first time somebody re-shoots a
     face. Returns null when the pane is absent (harness) or she has no
     portrait, and every caller falls back to initials. */
  /* ⚠ The Followers pane exports itself as `FolPane`, NOT `FollowersPane`.
     The first cut of this file reached for the latter, which simply does not
     exist — so portraitOf() returned null for EVERYBODY and every face in the
     game fell back to initials, while the harness (which stubs whatever name
     it is told to) looked perfect. `FollowersPane` is kept only as a
     belt-and-braces alias in case the pane is ever renamed. */
  function portraitOf(name) {
    const fp = window.FolPane || window.FollowersPane;
    if (!fp || typeof fp._portraitFor !== 'function') return null;
    try { return fp._portraitFor({ name: name }) || null; } catch (_) { return null; }
  }

  /* A round face, or initials when there is no portrait.
     Two Ultralight rules are baked in and must not be "simplified":
       * ?v=<mtime> busts the cache so a re-captured face actually changes —
         but Ultralight's loader can also treat the query as part of the
         FILENAME, so a failure retries the PLAIN path once before giving up.
       * A broken <img> must be REMOVED, not left as an empty box. */
  function faceEl(name, hue, extraClass) {
    const wrap = h('span', { class: 'nb-face' + (extraClass ? ' ' + extraClass : '') },
      h('span', { class: 'nb-face-ini' }, initialsOf(name)));
    wrap.style.setProperty('--nb-hue', String(hue));
    const p = portraitOf(name);
    if (!p || !p.file) return wrap;

    /* `p.url` is an explicit, already-resolved image. The Followers pane never
       sets it — only the standalone harness does, so the face LAYOUT can be
       looked at without inventing files inside the real portraits/ folder. */
    const plain = p.url || ('portraits/' + p.file);
    const img = h('img', {
      class: 'nb-face-img', alt: '', draggable: 'false',
      src: p.url ? p.url : (plain + '?v=' + (p.mtime || 0)),
    });
    let retried = false;
    img.addEventListener('error', function () {
      if (!retried) { retried = true; img.src = plain; return; }
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    wrap.appendChild(img);
    return wrap;
  }

  /* A base's crest: same object as a face, wearing initials of the base. */
  function crestEl(b, extraClass) {
    const el = h('span', { class: 'nb-crest' + (extraClass ? ' ' + extraClass : '') + (b.used ? '' : ' empty') },
      h('span', { class: 'nb-crest-ini' }, b.used ? initialsOf(baseTitle(b)) : '+'));
    el.style.setProperty('--nb-hue', String(hueOf(b.i)));
    return el;
  }

  function hourLabel(v) {
    const n = ((Number(v) || 0) % 24 + 24) % 24;
    if (n === 0) return '12 am';
    if (n === 12) return '12 pm';
    return (n > 12 ? n - 12 : n) + (n > 12 ? ' pm' : ' am');
  }

  /* Filter-as-you-type match: every whitespace-separated term must appear.
     Same rule as the deck's other searches, so "riv keep" finds "Riverwood
     Keep" and typing more never widens the result set. */
  function matches(hay, q) {
    if (!q) return true;
    const s = String(hay || '').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => s.indexOf(t) !== -1);
  }

  function baseTitle(b) {
    return b.name || (b.home && b.home.place) || ('Base ' + (b.i + 1));
  }

  /* NFF stamps a fresh base "New Base"; a never-named one reads "None"/"". Any
     of those is a placeholder we may auto-replace with the real location. */
  function isPlaceholderName(name) {
    const s = String(name || '').trim().toLowerCase();
    return s === '' || s === 'new base' || s === 'none';
  }

  /* Give a just-created base the name of the place it sits in, so 64 bases are
     not a wall of "New Base" — and so NFF's own MCM and the Omni search show
     the real name too. Fired once, when NFF has reported the home location
     back; left pending across the intermediate repaint until then. */
  function resolveAutoName() {
    if (S.autoName < 0) return;
    const b = baseAt(S.autoName);
    if (!b || !b.used) return;                       // not landed yet — keep waiting
    const place = b.home && (b.home.place || b.home.label);
    if (!place) return;                              // location not reported yet — wait
    S.autoName = -1;                                 // one-shot, whatever we decide now
    if (isPlaceholderName(b.name) && !S.renaming) {
      op({ op: 'rename', base: b.i, name: String(place).slice(0, 48) });
    }
  }

  function bases() { return (S.data && S.data.bases) || []; }

  function baseAt(i) { return bases().find((b) => b.i === i) || null; }

  function usedBases() { return bases().filter((b) => b.used); }

  /* The slot a new base would claim: the lowest unused index. null when the
     player has filled every base the installed NFF exposes. */
  function firstFree() {
    const b = bases().find((x) => !x.used);
    return b ? b.i : null;
  }

  /* Armed two-click: PrismaUI has no confirm(). First click arms and relabels,
     second within ARM_MS commits, and anything else disarms. */
  function isArmed(key) {
    return S.armed.key === key && (Date.now() - S.armed.at) < ARM_MS;
  }
  function arm(key) {
    S.armed = { key: key, at: Date.now() };
    render();
    setTimeout(() => { if (isArmed(key) === false && S.armed.key === key) { S.armed = { key: '', at: 0 }; render(); } }, ARM_MS + 60);
  }
  function disarm() { S.armed = { key: '', at: 0 }; }

  function op(payload) {
    S.loading = true;
    disarm();
    toGame('nbOp', JSON.stringify(payload));
    render();
  }

  function refresh() {
    S.loading = true;
    toGame('nbGet', '{}');
  }

  /* ============================================================== mount == */

  function ensureDom() {
    if (S.mounted && bar && bar.isConnected) return true;
    const pane = document.getElementById('dm-pane');
    const dmBody = document.getElementById('dm-body');
    if (!pane || !dmBody) return false;

    bar = h('div', { id: 'nb-modebar' },
      h('div', { class: 'nb-seg-wrap', role: 'tablist' },
        h('button', {
          class: 'nb-seg', id: 'nb-seg-places', type: 'button',
          title: 'Places you marked — click one to travel back',
          onclick: () => setMode('places'),
        }, '🗺 Places'),
        h('button', {
          class: 'nb-seg', id: 'nb-seg-bases', type: 'button',
          title: "Nether's Follower Framework home bases — where dismissed followers live",
          onclick: () => setMode('bases'),
        }, '🏰 Bases')),
      statusChip = h('span', { id: 'nb-status', class: 'hidden' }));

    body = h('section', { id: 'nb-body', class: 'hidden', 'aria-label': 'Home bases' },
      h('nav', { id: 'nb-rail', 'aria-label': 'Bases' },
        h('div', { id: 'nb-rail-head' },
          h('div', { class: 'nb-search-wrap' },
            h('span', { class: 'nb-search-ic', 'aria-hidden': 'true' }, '⌕'),
            h('input', {
              id: 'nb-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
              placeholder: 'Search bases, places, residents…',
              oninput: onSearchInput, onkeydown: onSearchKey,
            }))),
        railList = h('div', { id: 'nb-rail-list', role: 'listbox' }),
        h('div', { id: 'nb-rail-foot' })),
      main = h('section', { id: 'nb-main' }));

    pane.insertBefore(bar, dmBody);
    pane.insertBefore(body, dmBody.nextSibling);
    S.mounted = true;

    /* Re-measure when the window is resized OR when the deck's own resize
       grip / menu-size slider changes the panel — both end in a layout, and
       neither sends us an event, so a cheap rAF-debounced listener on the
       window plus the render path covers it. */
    window.addEventListener('resize', queueWidth);
    return true;
  }

  let widthPending = false;
  function queueWidth() {
    if (widthPending) return;
    widthPending = true;
    const run = () => { widthPending = false; applyWidth(); applyFit(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode;
    disarm();
    applyMode();
    if (mode === 'bases') {
      if (!S.data) refresh();
      render();
      const s = document.getElementById('nb-search');
      if (s) setTimeout(() => { try { s.focus(); } catch (_) {} }, 0);
    }
  }

  function applyMode() {
    const dmBody = document.getElementById('dm-body');
    const bases = S.mode === 'bases';
    if (dmBody) dmBody.classList.toggle('hidden', bases);
    if (body) body.classList.toggle('hidden', !bases);
    const p = document.getElementById('nb-seg-places');
    const b = document.getElementById('nb-seg-bases');
    if (p) p.classList.toggle('on', !bases);
    if (b) b.classList.toggle('on', bases);
    if (statusChip) statusChip.classList.toggle('hidden', !bases);
    /* The Domains pane's own footer/capture belong to Places only — leaving
       the mark button under the Bases list would fire the wrong feature. */
    const foot = document.getElementById('dm-foot');
    if (foot) foot.classList.toggle('nb-suppressed', bases);
  }

  function onSearchInput(e) {
    S.q = e.target.value || '';
    renderRail();
  }

  /* Enter takes the top hit — the deck's fd-ctx-menu idiom, so a search is
     always a complete interaction without reaching for the mouse. */
  function onSearchKey(e) {
    if (e.key !== 'Enter') return;
    const list = filteredBases();
    if (list.length) select(list[0].i);
    e.preventDefault();
  }

  function filteredBases() {
    const q = S.q;
    return bases().filter((b) => {
      if (!q) return true;
      const hay = [baseTitle(b), b.name,
        b.home && b.home.place, b.home && b.home.label,
        b.work && b.work.place, b.relax && b.relax.place,
        (b.residents || []).map((r) => r.name).join(' ')].join(' ');
      return matches(hay, q);
    });
  }

  function select(i) {
    S.sel = i;
    disarm();
    S.renaming = '';
    S.who = '';
    render();
  }

  /* ============================================================= render == */

  const NARROW_AT = 720;   // px of #nb-body width; mirrored in bases-pane.css

  /* The deck window is resizable and scalable independently of the render
     target, so "is this pane narrow" is a MEASUREMENT, not a media query — at
     2560×1440 with the panel dragged to its 640px floor, a viewport query is
     still reading 2560 and never fires. */
  function applyWidth() {
    if (!body) return;
    const w = body.getBoundingClientRect().width;
    if (!w) return;                       // hidden: keep whatever we had
    body.classList.toggle('nb-narrow', w < NARROW_AT);
    document.body.classList.toggle('nb-narrow-bar', w < NARROW_AT);
  }

  /* ⚠ THE DOMAINS TAB IS SCALED, AND ONLY ITS WIDTH IS COMPENSATED.
   *
   *  app.css gives #dm-pane `transform: scale(var(--dm-ui-scale))` together
   *  with `width: calc(100% / var(--dm-ui-scale))` — the width is divided back
   *  out, the HEIGHT never is. So at any Domains UI size above 100% the pane
   *  renders taller than its layout box and the surplus falls outside #panel,
   *  which clips it. Worse, a scroller inside it computes its range from the
   *  UNSCALED layout height, so scrolling to the very end still leaves the
   *  overflow off-screen: the bottom is simply unreachable.
   *
   *  Measured on the rig's own numbers (scale 1.3): layout 681px, visual
   *  885px, 203px of it below the panel — exactly the "can't scroll all the
   *  way down to the residents" Rober hit.
   *
   *  Fix, scoped to this pane rather than app.css (which every other session
   *  is editing): cap our own height to `layoutHeight / scale`, so the SCALED
   *  result is exactly the layout box the flex parent allotted. At scale 1
   *  this is a no-op, which is why it can be applied unconditionally.
   */
  function applyFit() {
    if (!body || !bar) return;
    const pane = document.getElementById('dm-pane');
    if (!pane) return;
    const layoutH = pane.offsetHeight;                 // unscaled, the allotment
    if (!layoutH) return;                              // hidden — nothing to fit
    const visualH = pane.getBoundingClientRect().height;
    const scale = visualH > 0 ? (visualH / layoutH) : 1;
    if (!(scale > 0.05) || !isFinite(scale)) return;   // nonsense: leave it alone
    const usable = layoutH / scale;
    const h = Math.max(140, Math.floor(usable - (bar.offsetHeight || 0)));
    body.style.maxHeight = h + 'px';
  }

  function render() {
    if (!ensureDom()) return;
    applyMode();
    if (S.mode !== 'bases') return;
    applyWidth();
    applyFit();
    renderStatus();
    renderRail();
    renderMain();
  }

  function renderStatus() {
    if (!statusChip) return;
    const d = S.data;
    if (!d || !d.nff) { statusChip.textContent = ''; return; }
    const used = usedBases().length;
    const cap = d.maxBases || 0;
    const res = d.residents || 0;
    const slots = d.maxHomeSlots || 0;
    statusChip.textContent = used + ' of ' + cap + ' bases · ' + res + (slots ? '/' + slots : '') + ' residents';
    statusChip.setAttribute('title',
      'You have set up ' + used + ' of the ' + cap + ' bases this NFF build exposes, '
      + 'and ' + res + ' follower(s) live at them'
      + (slots ? ' out of ' + slots + ' resident slots' : ''));
  }

  function renderRail() {
    if (!railList) return;
    const d = S.data;
    railList.textContent = '';

    const search = document.getElementById('nb-search');
    const head = document.getElementById('nb-rail-head');
    if (head) head.classList.toggle('hidden', !d || !d.nff || bases().length < SEARCH_AT);
    if (search && search.value !== S.q) search.value = S.q;

    if (!d) {
      for (let i = 0; i < 5; i++) railList.append(h('div', { class: 'nb-row nb-skel' }));
      renderRailFoot();
      return;
    }
    if (!d.nff) { renderRailFoot(); return; }

    const list = filteredBases();
    const used = list.filter((b) => b.used);
    const free = list.filter((b) => !b.used);

    if (!used.length && !S.q) {
      railList.append(h('div', { class: 'nb-railempty' },
        h('div', { class: 'nb-railempty-t' }, 'No bases yet'),
        h('div', { class: 'nb-railempty-s' },
          'Stand where you want followers to live and use the button below.')));
    }

    if (used.length) {
      railList.append(h('div', { class: 'nb-grouphead' }, 'Your bases', h('span', {}, String(used.length))));
      used.forEach((b) => railList.append(railRow(b)));
    }
    /* Free slots are collapsed to one line, not 61 empty rows: a base that
       has never been set up is not a thing you browse, it is capacity. */
    if (free.length) {
      railList.append(h('div', { class: 'nb-grouphead nb-grouphead-dim' },
        'Free slots', h('span', {}, String(free.length))));
      if (S.q) free.slice(0, 12).forEach((b) => railList.append(railRow(b)));
    }
    if (!list.length && S.q) {
      railList.append(h('div', { class: 'nb-railempty' },
        h('div', { class: 'nb-railempty-t' }, 'Nothing matches'),
        h('div', { class: 'nb-railempty-s' }, '“' + S.q + '” isn’t any base, place or resident.')));
    }
    renderRailFoot();
  }

  function railRow(b) {
    const on = b.i === S.sel;
    const n = (b.residents || []).length;
    const marks = [];
    if (b.work && b.work.set) marks.push('⚒');
    if (b.relax && b.relax.set) marks.push('♨');

    return h('div', {
      class: 'nb-row' + (on ? ' on' : '') + (b.used ? '' : ' free'),
      role: 'option', 'aria-selected': on ? 'true' : 'false',
      title: b.used
        ? baseTitle(b) + (b.home && b.home.place ? ' — ' + b.home.place : '')
          + ' · ' + n + ' resident' + (n === 1 ? '' : 's')
        : 'Base slot ' + (b.i + 1) + ' — not set up yet',
      onclick: () => select(b.i),
    },
      crestEl(b, 'nb-crest-sm'),
      h('span', { class: 'nb-row-num' }, String(b.i + 1)),
      h('span', { class: 'nb-row-text' },
        h('span', { class: 'nb-row-name' }, b.used ? baseTitle(b) : 'Free slot'),
        h('span', { class: 'nb-row-sub' },
          b.used ? ((b.home && b.home.place) || 'Somewhere in Skyrim') : 'Never set up')),
      marks.length ? h('span', { class: 'nb-row-marks', title: 'Has a work / relax spot' }, marks.join(' ')) : null,
      b.used ? h('span', { class: 'nb-row-pop' + (n ? '' : ' zero'), title: n + ' resident' + (n === 1 ? '' : 's') }, String(n)) : null);
  }

  function renderRailFoot() {
    const foot = document.getElementById('nb-rail-foot');
    if (!foot) return;
    foot.textContent = '';
    const d = S.data;
    if (!d || !d.nff) return;

    const free = firstFree();
    const btn = h('button', {
      class: 'nb-new', type: 'button', disabled: free == null,
      title: free == null
        ? 'Every base this NFF build exposes is already set up'
        : 'Register where you are standing right now as base ' + (free + 1),
      onclick: () => {
        if (free == null) return;
        op({ op: 'setLoc', base: free, kind: 0, own: S.claimCell, ownBeds: S.claimBeds });
        S.sel = free;
        S.autoName = free;   // name it after its location, once NFF reports it back
      },
    }, free == null ? 'All bases used' : '★ New base here');

    foot.append(btn,
      h('div', { class: 'nb-claims' },
        claimToggle('claimCell', 'Claim the cell',
          "Set you as the owner of this cell, so it stops counting as trespassing — NFF's own option"),
        claimToggle('claimBeds', 'Claim the beds',
          'Also set you as the owner of every bed here')));
  }

  function claimToggle(key, label, hint) {
    return h('button', {
      class: 'nb-claim' + (S[key] ? ' on' : ''), type: 'button', title: hint,
      onclick: () => { S[key] = !S[key]; renderRailFoot(); },
    }, h('span', { class: 'nb-claim-box' }, S[key] ? '✓' : ''), label);
  }

  /* ------------------------------------------------------------- detail -- */

  function renderMain() {
    if (!main) return;
    main.textContent = '';
    const d = S.data;

    if (!d) { main.append(loadingCard()); return; }
    if (!d.nff) { main.append(missingCard(d)); return; }

    const b = baseAt(S.sel) || usedBases()[0] || null;
    if (!b) { main.append(introCard()); return; }
    if (S.sel !== b.i) S.sel = b.i;

    main.append(headCard(b), locCard(b), residentCard(b), settingsCard(d));
  }

  function loadingCard() {
    return h('div', { class: 'nb-card' },
      h('div', { class: 'nb-skelline w60' }), h('div', { class: 'nb-skelline w90' }),
      h('div', { class: 'nb-skelline w40' }));
  }

  function missingCard(d) {
    return h('div', { class: 'nb-card nb-missing' },
      h('div', { class: 'nb-missing-ic' }, '🏰'),
      h('div', { class: 'nb-missing-t' }, 'No home bases to manage'),
      h('div', { class: 'nb-missing-s' },
        d.msg || "Nether's Follower Framework isn't answering."),
      h('button', {
        class: 'nb-btn', type: 'button',
        title: 'Ask the game again — NFF answers once a save is loaded',
        onclick: refresh,
      }, '⟳ Check again'));
  }

  function introCard() {
    const free = firstFree();
    return h('div', { class: 'nb-card nb-intro' },
      h('div', { class: 'nb-missing-ic' }, '🏰'),
      h('div', { class: 'nb-missing-t' }, 'No bases set up yet'),
      h('div', { class: 'nb-missing-s' },
        'A home base is where a follower goes when you dismiss her — she lives there, '
        + 'and can be given a place to work and a place to relax. '
        + 'Stand somewhere you own and make it the first one.'),
      h('button', {
        class: 'nb-btn nb-btn-hero', type: 'button', disabled: free == null,
        title: free == null
          ? 'Every base this NFF build exposes is already set up'
          : 'Register the cell you are standing in right now as base ' + (free + 1),
        onclick: () => { if (free != null) { op({ op: 'setLoc', base: free, kind: 0, own: S.claimCell, ownBeds: S.claimBeds }); S.sel = free; S.autoName = free; } },
      }, '★ Make this my first base'));
  }

  function headCard(b) {
    const editing = S.renaming === 'name';
    const title = editing
      ? h('input', {
          class: 'nb-nameinput', type: 'text', value: b.name || '', maxlength: '48',
          spellcheck: 'false', autocomplete: 'off',
          onkeydown: (e) => {
            if (e.key === 'Enter') { commitName(b, e.target.value); e.preventDefault(); }
            else if (e.key === 'Escape') { S.renaming = ''; render(); e.preventDefault(); }
          },
          onblur: (e) => commitName(b, e.target.value),
        })
      : h('h2', {
          class: 'nb-title', title: 'Click to rename this base',
          onclick: () => { S.renaming = 'name'; render(); focusRename(); },
        }, baseTitle(b), h('span', { class: 'nb-title-pen' }, '✎'));

    const clearKey = 'clear:' + b.i;
    const res = b.residents || [];
    const place = (b.home && (b.home.place || b.home.label)) || '';

    /* The overlapping face stack — the one glance that answers "who lives
       here" before you read a word. Capped at six with a +N cap, because a
       base can hold dozens and a row of forty faces is not information. */
    const STACK = 6;
    const stack = res.length
      ? h('span', { class: 'nb-stack', title: res.map((r) => r.name).join(', ') },
          ...res.slice(0, STACK).map((r, i) => {
            const f = faceEl(r.name, hueOf(b.i + i), 'nb-face-sm');
            f.style.zIndex = String(STACK - i);
            return f;
          }),
          res.length > STACK
            ? h('span', { class: 'nb-stack-more' }, '+' + (res.length - STACK))
            : null)
      : null;

    const hero = h('div', { class: 'nb-card nb-hero' },
      h('div', { class: 'nb-hero-wash', 'aria-hidden': 'true' }),
      crestEl(b, 'nb-crest-lg'),
      h('div', { class: 'nb-hero-text' },
        h('div', { class: 'nb-hero-line' },
          h('span', { class: 'nb-head-num', title: 'NFF base slot ' + (b.i + 1) }, '#' + (b.i + 1)),
          title),
        h('div', { class: 'nb-hero-sub' },
          place ? h('span', { class: 'nb-hero-place', title: 'Where this base is' }, '⌂ ' + place)
            : h('span', { class: 'nb-hero-place unset' }, 'No home location yet'),
          stack,
          occupancyMeter())),
      h('div', { class: 'nb-head-actions' },
        h('button', {
          class: 'nb-btn', type: 'button',
          disabled: !(b.home && b.home.placed),
          title: b.home && b.home.placed
            ? 'Travel to this base'
            : 'This base has no placed home marker to travel to',
          onclick: () => op({ op: 'visit', base: b.i, kind: 0 }),
        }, '➤ Visit'),
        h('button', {
          class: 'nb-btn nb-danger' + (isArmed(clearKey) ? ' armed' : ''), type: 'button',
          title: isArmed(clearKey)
            ? 'Click again to remove this base for good'
            : 'Remove this base — everyone living here is unassigned too',
          onclick: () => {
            if (isArmed(clearKey)) op({ op: 'clearLoc', base: b.i, kind: 0 });
            else arm(clearKey);
          },
        }, isArmed(clearKey) ? 'Really remove?' : '✕ Remove base')));

    return hero;
  }

  /* How full NFF's resident pool is, ACROSS every base — the number that
     actually stops you adding somebody. Hidden when the build reports no cap,
     because a meter with no ceiling is decoration. */
  function occupancyMeter() {
    const d = S.data || {};
    const cap = d.maxHomeSlots || 0;
    if (!cap) return null;
    const used = Math.min(d.residents || 0, cap);
    const pct = Math.max(2, Math.round((used / cap) * 100));
    const fill = h('span', { class: 'nb-meter-fill' });
    fill.style.width = pct + '%';
    return h('span', {
      class: 'nb-meter',
      title: used + ' of NFF’s ' + cap + ' resident slots are taken, across all bases',
    },
      h('span', { class: 'nb-meter-track' }, fill),
      h('span', { class: 'nb-meter-txt' }, used + '/' + cap));
  }

  function commitName(b, value) {
    const v = String(value || '').trim();
    S.renaming = '';
    if (!v || v === (b.name || '')) { render(); return; }
    op({ op: 'rename', base: b.i, name: v });
  }

  function focusRename() {
    setTimeout(() => {
      const i = main && main.querySelector('.nb-nameinput, .nb-labelinput');
      if (i) { try { i.focus(); i.select(); } catch (_) {} }
    }, 0);
  }

  function locCard(b) {
    const limit = (S.data && S.data.workFlagLimit) || 0;
    const rows = KINDS.map((kd) => locRow(b, kd, limit));
    return h('div', { class: 'nb-card' },
      h('div', { class: 'nb-card-head' }, 'Locations',
        h('span', { class: 'nb-card-hint' }, 'Stand where you want it, then set it')),
      h('div', { class: 'nb-locs' }, ...rows));
  }

  function locRow(b, kd, limit) {
    const loc = b[kd.key] || { set: false };
    /* Above NFF's twenty scalar work/relax flags the spot still works — C++
       moves the marker and skips the broken flag write — but its "is it set"
       state is then remembered by the LABEL alone, which is worth saying once
       rather than letting it look like a glitch. */
    const offBook = kd.k !== 0 && b.i >= limit;
    const editing = S.renaming === kd.key;

    const nameNode = editing
      ? h('input', {
          class: 'nb-labelinput', type: 'text', value: loc.label || '', maxlength: '48',
          spellcheck: 'false', autocomplete: 'off',
          onkeydown: (e) => {
            if (e.key === 'Enter') { commitLabel(b, kd, e.target.value); e.preventDefault(); }
            else if (e.key === 'Escape') { S.renaming = ''; render(); e.preventDefault(); }
          },
          onblur: (e) => commitLabel(b, kd, e.target.value),
        })
      : h('span', {
          class: 'nb-loc-name' + (loc.set ? '' : ' unset'),
          title: loc.set ? 'Click to rename this location' : kd.hint,
          onclick: () => { if (loc.set) { S.renaming = kd.key; render(); focusRename(); } },
        }, loc.set ? (loc.label || loc.place || 'Set') : 'Not set');

    const where = loc.set && loc.place && loc.place !== loc.label
      ? h('span', { class: 'nb-loc-where', title: 'Where the marker actually stands' }, loc.place)
      : null;

    const setKey = 'set:' + b.i + ':' + kd.k;
    const clrKey = 'clr:' + b.i + ':' + kd.k;
    const needsHome = kd.k !== 0 && !(b.home && b.home.set);

    /* One gold sweep on the row that was just registered, then the flag is
       consumed — so it fires on the change and never again on a repaint. */
    const justSet = S.justSet === (b.i + ':' + kd.k);
    if (justSet) S.justSet = '';

    return h('div', {
      class: 'nb-loc' + (loc.set ? ' is-set' : '') + (offBook ? ' is-offbook' : '')
        + (justSet ? ' nb-justset' : ''),
    },
      h('span', { class: 'nb-loc-ic', 'aria-hidden': 'true' }, kd.icon),
      h('span', { class: 'nb-loc-text' },
        h('span', { class: 'nb-loc-kind' }, kd.label),
        h('span', { class: 'nb-loc-val' }, nameNode, where)),
      h('span', { class: 'nb-loc-acts' },
        h('button', {
          class: 'nb-btn nb-btn-sm' + (isArmed(setKey) ? ' armed' : ''), type: 'button',
          disabled: needsHome,
          title: needsHome ? 'Set this base’s home location first'
            : loc.set ? 'Move it to where you are standing now'
              : 'Register where you are standing right now',
          onclick: () => {
            if (loc.set && !isArmed(setKey)) { arm(setKey); return; }
            S.justSet = b.i + ':' + kd.k;
            op({
              op: 'setLoc', base: b.i, kind: kd.k,
              own: kd.k === 0 && S.claimCell, ownBeds: kd.k === 0 && S.claimBeds,
            });
          },
        }, isArmed(setKey) ? 'Move it here?' : (loc.set ? '⌖ Move here' : '⌖ Set here')),
        loc.set ? h('button', {
          class: 'nb-btn nb-btn-sm', type: 'button', disabled: !loc.placed,
          title: loc.placed ? 'Travel there now' : 'Nothing placed to travel to',
          onclick: () => op({ op: 'visit', base: b.i, kind: kd.k }),
        }, '➤') : null,
        loc.set && kd.k !== 0 ? h('button', {
          class: 'nb-btn nb-btn-sm nb-danger' + (isArmed(clrKey) ? ' armed' : ''), type: 'button',
          title: isArmed(clrKey) ? 'Click again to clear it' : 'Clear this spot',
          onclick: () => { if (isArmed(clrKey)) op({ op: 'clearLoc', base: b.i, kind: kd.k }); else arm(clrKey); },
        }, isArmed(clrKey) ? 'Sure?' : '✕') : null),
      offBook ? h('span', { class: 'nb-loc-warn' },
        'NFF only tracks this spot’s on/off state for the first ' + limit
        + ' bases, so up here the deck remembers it by its name — the spot itself works normally.') : null);
  }

  function commitLabel(b, kd, value) {
    const v = String(value || '').trim();
    S.renaming = '';
    const loc = b[kd.key] || {};
    if (!v || v === (loc.label || '')) { render(); return; }
    op({ op: 'label', base: b.i, kind: kd.k, name: v });
  }

  /* ---------------------------------------------------------- residents -- */

  function residentCard(b) {
    const res = b.residents || [];
    const d = S.data || {};
    const cands = (d.candidates || []).filter((c) => c.base !== b.i);
    const target = d.target && d.target.base !== b.i ? d.target : null;
    const canAdd = !!(b.home && b.home.set);
    const full = d.maxHomeSlots > 0 && d.residents >= d.maxHomeSlots;

    const kids = [
      h('div', { class: 'nb-card-head' }, 'Residents',
        h('span', { class: 'nb-card-hint' },
          res.length ? res.length + ' living here' : 'Nobody lives here yet')),
    ];

    if ((res.length + cands.length) >= SEARCH_AT) {
      kids.push(h('div', { class: 'nb-search-wrap nb-search-inline' },
        h('span', { class: 'nb-search-ic', 'aria-hidden': 'true' }, '⌕'),
        h('input', {
          class: 'nb-whosearch', type: 'text', value: S.who, spellcheck: 'false',
          autocomplete: 'off', placeholder: 'Filter people…',
          oninput: (e) => { S.who = e.target.value || ''; renderMain(); refocusWho(); },
        })));
    }

    if (res.length) {
      const shown = res.filter((r) => matches(r.name, S.who));
      kids.push(h('div', { class: 'nb-people' },
        ...shown.map((r, ri) => personChip(r, {
          action: '✕', danger: true,
          title: 'Send ' + r.name + ' back to having no base',
          key: 'un:' + r.formId, hue: b.i + ri, elsewhere: b.i,
          armLabel: 'Remove?',
          onact: () => op({ op: 'unassign', formId: r.formId }),
        })),
        shown.length ? null : h('div', { class: 'nb-nomatch' }, 'No resident matches “' + S.who + '”')));
    } else {
      kids.push(h('div', { class: 'nb-empty' },
        canAdd ? 'Assign a follower below and she’ll live here when you dismiss her.'
          : 'Set this base’s home location first — then you can move people in.'));
    }

    /* Add block: the crosshair NPC first (looking at someone IS the intent),
       then everyone currently following you. */
    const addKids = [];
    if (target) {
      addKids.push(h('div', { class: 'nb-addlead' }, 'Looking at'),
        h('div', { class: 'nb-people' },
          personChip(target, {
            action: '＋', title: 'Move ' + target.name + ' into this base',
            key: 'add:' + target.formId, hue: 3,
            onact: () => op({ op: 'assign', base: b.i, formId: target.formId }),
            disabled: !canAdd || full,
            elsewhere: target.base,
          })));
    }
    const shownCands = cands.filter((c) => matches(c.name, S.who));
    if (shownCands.length) {
      addKids.push(h('div', { class: 'nb-addlead' }, 'Following you now'),
        h('div', { class: 'nb-people' },
          ...shownCands.map((c, ci) => personChip(c, {
            action: '＋', title: 'Move ' + c.name + ' into this base',
            key: 'add:' + c.formId, hue: ci + 5,
            onact: () => op({ op: 'assign', base: b.i, formId: c.formId }),
            disabled: !canAdd || full,
            elsewhere: c.base,
          }))));
    } else if (!target) {
      addKids.push(h('div', { class: 'nb-empty nb-empty-sm' },
        cands.length ? 'Nobody matches “' + S.who + '”'
          : 'Nobody is following you right now — recruit someone, then file her here.'));
    }
    if (full) {
      addKids.push(h('div', { class: 'nb-warn' },
        'Every one of NFF’s ' + d.maxHomeSlots + ' resident slots is taken — free one before adding anybody.'));
    }
    kids.push(h('div', { class: 'nb-add' }, ...addKids));

    /* The base picker lives at the BOTTOM of this card, so opening it never
       reflows the roster you were just looking at. */
    const pick = pickerPanel();
    if (pick) kids.push(pick);

    return h('div', { class: 'nb-card' }, ...kids);
  }

  /* The "move her to…" panel: every base as a tile you pick BY ITS CREST.
     Rendered inline inside the Residents card rather than as a floating
     popover — Ultralight has no positioning help worth trusting, and an
     in-flow panel can never land off-screen or under another layer. */
  function pickerPanel() {
    if (!S.picking) return null;
    const all = bases().filter((b) => b.used);
    const q = S.pickQ;
    const shown = all.filter((b) => !q || matches(baseTitle(b) + ' ' + ((b.home && b.home.place) || ''), q));
    const cur = (S.data && (S.data.candidates || []).concat(
      (baseAt(S.sel) || {}).residents || []).find((p) => p.formId === S.picking)) || null;
    const at = cur && cur.base != null ? cur.base : -1;

    return h('div', { class: 'nb-picker' },
      h('div', { class: 'nb-picker-head' },
        h('span', { class: 'nb-picker-t' }, 'Move ' + (S.pickWho || 'her') + ' to…'),
        h('button', {
          class: 'nb-btn nb-btn-sm', type: 'button', title: 'Close without moving anyone',
          onclick: () => { S.picking = ''; S.pickWho = ''; renderMain(); },
        }, 'Cancel')),

      all.length >= SEARCH_AT
        ? h('div', { class: 'nb-search-wrap nb-search-inline' },
            h('span', { class: 'nb-search-ic', 'aria-hidden': 'true' }, '⌕'),
            h('input', {
              class: 'nb-pickinput', type: 'text', value: S.pickQ, spellcheck: 'false',
              autocomplete: 'off', placeholder: 'Which base…',
              oninput: (e) => { S.pickQ = e.target.value || ''; renderMain(); focusPick(); },
              onkeydown: (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (shown.length) moveTo(shown[0].i);
              },
            }))
        : null,

      h('div', { class: 'nb-picker-grid' },
        ...shown.map((b) => h('button', {
          class: 'nb-picktile' + (b.i === at ? ' current' : ''), type: 'button',
          disabled: b.i === at,
          title: b.i === at
            ? (S.pickWho || 'She') + ' already lives at ' + baseTitle(b)
            : 'Move ' + (S.pickWho || 'her') + ' to ' + baseTitle(b),
          onclick: () => moveTo(b.i),
        },
          crestEl(b, 'nb-crest-sm'),
          h('span', { class: 'nb-picktile-text' },
            h('span', { class: 'nb-picktile-name' }, baseTitle(b)),
            h('span', { class: 'nb-picktile-sub' },
              ((b.residents || []).length) + ' living · ' + ((b.home && b.home.place) || '—'))))),
        at >= 0 ? h('button', {
          class: 'nb-picktile nb-picktile-none', type: 'button',
          title: 'Take ' + (S.pickWho || 'her') + '’s home base away entirely',
          onclick: () => {
            const id = S.picking;
            S.picking = ''; S.pickWho = '';
            op({ op: 'unassign', formId: id });
          },
        },
          h('span', { class: 'nb-crest empty nb-crest-sm' }, h('span', { class: 'nb-crest-ini' }, '⌂')),
          h('span', { class: 'nb-picktile-text' },
            h('span', { class: 'nb-picktile-name' }, 'No base'),
            h('span', { class: 'nb-picktile-sub' }, 'She stops living anywhere'))) : null),

      shown.length ? null
        : h('div', { class: 'nb-empty nb-empty-sm' },
            all.length ? 'No base matches “' + S.pickQ + '”'
              : 'You have no bases set up to move her to yet.'));
  }

  function moveTo(index) {
    const id = S.picking;
    S.picking = ''; S.pickWho = ''; S.pickQ = '';
    if (!id) return;
    op({ op: 'assign', base: index, formId: id });
  }

  function focusPick() {
    setTimeout(() => {
      const i = main && main.querySelector('.nb-pickinput');
      if (i) { try { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} }
    }, 0);
  }

  function refocusWho() {
    setTimeout(() => {
      const i = main && main.querySelector('.nb-whosearch');
      if (i) { try { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} }
    }, 0);
  }

  function personChip(p, o) {
    const armedNow = o.armLabel ? isArmed(o.key) : false;
    /* The old "#2" text badge is gone — the crest on the base button says the
       same thing in the same place, with the base's own colour. */
    const badge = null;
    return h('span', {
      class: 'nb-chip' + (p.dead ? ' dead' : '') + (o.disabled ? ' disabled' : '') + (armedNow ? ' armed' : ''),
      title: p.dead ? p.name + ' is dead' : (armedNow ? 'Click again to confirm' : o.title),
    },
      faceEl(p.name, hueOf(o.hue || 0), 'nb-face-sm'),
      h('span', { class: 'nb-chip-name' }, p.name),
      /* "Match her to a base" — the base is chosen BY ITS CREST, and from
         anywhere, so moving somebody to base 41 no longer means navigating to
         base 41 first. Shows her current base's crest when she has one, so the
         control doubles as the badge that says where she lives. */
      h('button', {
        class: 'nb-chip-base' + (S.picking === p.formId ? ' on' : ''), type: 'button',
        title: (o.elsewhere != null && o.elsewhere >= 0)
          ? p.name + ' lives at base ' + (o.elsewhere + 1) + ' — click to move her somewhere else'
          : 'Give ' + p.name + ' a home base',
        onclick: () => {
          if (S.picking === p.formId) { S.picking = ''; S.pickWho = ''; }
          else { S.picking = p.formId; S.pickWho = p.name; S.pickQ = ''; }
          disarm();
          renderMain();
          focusPick();
        },
      }, (o.elsewhere != null && o.elsewhere >= 0)
        ? crestEl(baseAt(o.elsewhere) || { i: o.elsewhere, used: true, name: '' }, 'nb-crest-xs')
        : h('span', { class: 'nb-chip-basehome' }, '⌂')),
      p.following ? h('span', { class: 'nb-chip-dot', title: 'Following you right now' }, '●') : null,
      badge,
      h('button', {
        /* `armed` belongs on the BUTTON, not only the chip: the pulse and the
           red fill are keyed off .nb-chip-act.armed, and the chip-only version
           of this styled nothing at all. */
        class: 'nb-chip-act' + (o.danger ? ' danger' : '') + (armedNow ? ' armed' : ''),
        type: 'button',
        disabled: o.disabled || p.dead,
        title: o.title,
        onclick: () => {
          if (o.armLabel && !isArmed(o.key)) { arm(o.key); return; }
          o.onact();
        },
      }, armedNow ? o.armLabel : o.action));
  }

  /* ----------------------------------------------------------- settings -- */

  function settingsCard(d) {
    const head = h('div', {
      class: 'nb-card-head nb-collapse' + (S.settingsOpen ? ' open' : ''),
      title: 'Settings every base shares',
      onclick: () => { S.settingsOpen = !S.settingsOpen; renderMain(); },
    }, h('span', { class: 'nb-caret' }, S.settingsOpen ? '▾' : '▸'), 'Shared base settings',
      h('span', { class: 'nb-card-hint' }, 'Ownership and the daily hours'));

    if (!S.settingsOpen) return h('div', { class: 'nb-card' }, head);

    const owner = h('button', {
      class: 'nb-toggle' + (d.allowOwner ? ' on' : ''), type: 'button',
      title: 'When on, setting a base can make you the owner of the cell and its beds '
        + '(NFF’s own option — it stops your own house counting as trespassing)',
      onclick: () => op({ op: 'owner', on: !d.allowOwner }),
    }, h('span', { class: 'nb-toggle-box' }, d.allowOwner ? '✓' : ''),
      'Bases may claim ownership');

    const times = d.times || {};
    const rows = TIMES.filter((t) => times[t.key] != null).map((t) =>
      h('div', { class: 'nb-time' },
        h('span', { class: 'nb-time-lbl' }, t.label),
        h('button', {
          class: 'nb-step', type: 'button', title: 'An hour earlier',
          onclick: () => op({ op: 'time', which: t.key, value: (times[t.key] + 23) % 24 }),
        }, '◀'),
        h('span', { class: 'nb-time-val' }, hourLabel(times[t.key])),
        h('button', {
          class: 'nb-step', type: 'button', title: 'An hour later',
          onclick: () => op({ op: 'time', which: t.key, value: (times[t.key] + 1) % 24 }),
        }, '▶')));

    return h('div', { class: 'nb-card' }, head,
      h('div', { class: 'nb-settings' }, owner,
        rows.length ? h('div', { class: 'nb-times' }, ...rows)
          : h('div', { class: 'nb-empty nb-empty-sm' }, 'This NFF build exposes no hour settings.')));
  }

  /* ============================================================ bridge === */

  window.nbOpen = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    S.data = d;
    S.loading = false;
    /* Land on something real the first time: the base the player most likely
       means is the first one they actually set up. */
    if (S.sel < 0) {
      const first = (d.bases || []).find((b) => b.used);
      S.sel = first ? first.i : -1;
    }
    resolveAutoName();
    if (S.mode === 'bases') render();
  };

  window.nbResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    S.loading = false;
    if (d.msg) say(d.msg);
    if (S.mode === 'bases') render();
  };

  /* ============================================================== host === */

  /* Chain the Domains pane's own lifecycle rather than asking app.js for a
     hook: this file loads after domains-pane.js, so wrapping its onShow /
     onHide is the least invasive way in — and if the pane is ever absent,
     the wrap simply never happens and nothing here runs. */
  function chainHost() {
    const dp = window.DomainsPane;
    if (!dp || dp.__nbChained) return false;
    const show = dp.onShow, hide = dp.onHide;
    dp.onShow = function () {
      const r = typeof show === 'function' ? show.apply(this, arguments) : undefined;
      ensureDom();
      applyMode();
      /* Always re-ask on show: bases, residents and the crosshair target all
         change while the deck is closed, and a stale roster is how you file
         someone at a base that no longer exists. */
      if (S.mode === 'bases') refresh();
      render();
      return r;
    };
    dp.onHide = function () {
      disarm();
      S.renaming = '';
      return typeof hide === 'function' ? hide.apply(this, arguments) : undefined;
    };
    dp.__nbChained = true;
    return true;
  }

  function boot() {
    if (!chainHost()) setTimeout(boot, 60);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Exposed for the harness and for the Omni provider below. */
  window.BasesPane = {
    setMode: setMode,
    refresh: refresh,
    state: function () { return S; },
    render: render,
    _mount: ensureDom,
    _ingest: function (d) { window.nbOpen(d); },
  };

  /* Omni: bases are findable from the universal search like every other
     surface. Indexed LIVE at query time, so a base registered this session is
     searchable without any omni edit (the provider contract in hd-omni.js). */
  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'bases',
      label: 'Bases',
      index: function () {
        return (S.data && S.data.bases ? S.data.bases : []).filter((b) => b.used).map((b) => ({
          key: 'base:' + b.i,
          label: baseTitle(b),
          detail: 'NFF base · ' + ((b.home && b.home.place) || '?')
            + ' · ' + ((b.residents || []).length) + ' resident(s)',
          kind: 'base',
          run: function () {
            if (typeof window.hdSetTab === 'function') window.hdSetTab('domains');
            setMode('bases');
            select(b.i);
            return true;
          },
          snap: { i: b.i, name: baseTitle(b) },
        }));
      },
      pinRun: function (snap) {
        if (typeof window.hdSetTab === 'function') window.hdSetTab('domains');
        setMode('bases');
        if (snap && typeof snap.i === 'number') select(snap.i);
        return true;
      },
    });
  }
})();
