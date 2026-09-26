/* ===================================================================== *
 *  Household tab — your wives and who is expecting, on one page.
 *
 *  Rober, 2026-09-13: "All pieces exist. SkyManager dedicated auto
 *  populating wife and pregnant women page, that shows how far along,
 *  hooks to profile pictures, highly polished."
 *
 *  ---- "all pieces exist" is the whole architecture ---------------------
 *  This pane owns NO bridge, asks C++ for NOTHING, and adds no DLL code.
 *  Every fact on it is already being pushed to this view, for the Followers
 *  tab, on rails that have been live for weeks:
 *
 *      fdState      Follower Organizer's roster — who exists, her category,
 *                   her notes, and the Relationship field YOU typed
 *      fdNff        per-actor `rel` slice: M.A.R.A.S marriage (src/maras.cpp)
 *                   and the engine's RELA rank (src/relationship.cpp)
 *      fdFertility  Fertility Mode pregnancy + cycle, read out of FM's own
 *                   storage quest (src/fertility_bridge.cpp) — day, term,
 *                   percent, trimester, father, births
 *      portraits    a captured photo when there is one, otherwise her
 *                   facegen head render (icons/npcs/…), already resolved
 *
 *  So "auto populating" is literal: the page is a VIEW of the roster, and
 *  anyone who becomes a wife or becomes pregnant appears on it the moment
 *  the mod that owns that fact says so. Nothing to add her to, nothing to
 *  keep in step.
 *
 *  It reaches all of it through ONE call — FolPane.householdRoster() — and
 *  re-derives none of it. That is deliberate and it is the house rule: the
 *  Wardrobe's People card calls the Wardrobe modules' own verbs for exactly
 *  this reason. A second copy of "what counts as pregnant" is a second
 *  thing to drift from Fertility Mode's MCM.
 *
 *  ---- the one rule this page DOES own: what counts as a wife -----------
 *  Two independent facts, and the page never flattens them into one:
 *    · M.A.R.A.S says you are married to her (`spouse`) — the GAME's answer
 *    · her Relationship field says "wife" — YOUR answer, typed by you
 *  Either one puts her on the page, and the card says which one it was.
 *  They genuinely disagree in this playthrough (a harem of twelve against a
 *  mod that tracks the ones it married), and a page that picked a side
 *  would be wrong half the time. See spouseChip() in followers-pane.js.
 *
 *  ---- renderer constraints, learned the hard way ----------------------
 *  · ULTRALIGHT HAS NO conic-gradient (charsheet-pane.css carries an
 *    @supports fallback for exactly this) — so "how far along" is a linear
 *    bar with trimester ticks, never a progress ring.
 *  · Portraits are painted through HDFaceFit.paintPortraitsIn, so a head
 *    render is framed on the FACE and a hand crop still wins — one
 *    implementation, shared with the roster medallions and Finder tiles.
 *  · Own CSS file (household-pane.css), not a .frag — sync_view_frags
 *    truncates.
 * ===================================================================== */

window.HouseholdPane = (function () {
  'use strict';

  const DEV = location.search.indexOf('dev=1') !== -1;

  /* ------------------------------------------------------------ state -- */

  const ui = {
    filter: '',
    scope: 'household',
    sel: -1,          // keyboard selection into the CURRENT visible list
    toastT: 0,
  };

  let mounted = false;
  let lastRows = [];   // what the last render drew, so onKey can act on it

  /* The scopes. "Household" is the page's reason to exist — wives and the
     expecting, together — so it leads and is the default. "Everyone" is the
     escape hatch for checking someone who is neither yet. */
  const SCOPES = [
    { key: 'household', label: 'Household',
      title: 'Your wives and anyone expecting' },
    { key: 'wives', label: 'Wives',
      title: 'Married per M.A.R.A.S, or filed as a wife in her Relationship field' },
    { key: 'expecting', label: 'Expecting',
      title: 'Pregnant right now, per Fertility Mode' },
    { key: 'all', label: 'Everyone',
      title: 'The whole Follower Organizer roster' },
  ];

  /* ------------------------------------------------------------- DOM ---- */

  function $(id) { return document.getElementById(id); }

  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v);
      });
    }
    if (kids !== null && kids !== undefined) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
        if (k === null || k === undefined || k === false) return;
        el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
      });
    }
    return el;
  }

  /* --------------------------------------------------------- the data -- */

  /* ⚠ The Followers pane exports itself as `FolPane`; `FollowersPane` is a
     legacy alias some panes still reach for (bases-pane.js documents the
     trap). Accept both, prefer the real one. */
  function folPane() { return window.FolPane || window.FollowersPane || null; }

  function roster() {
    const fp = folPane();
    if (!fp || typeof fp.householdRoster !== 'function') return [];
    try { return fp.householdRoster() || []; } catch (e) { return []; }
  }

  /* Whether Fertility Mode answered at all. The difference between "nobody
     is pregnant" and "the mod that would know is not talking" is the whole
     difference between good news and a broken page, so the pane says which. */
  function fertStatus() {
    const fp = folPane();
    if (!fp || typeof fp.fertilityStatus !== 'function') {
      return { answered: false, available: false, tracked: null, loaded: false };
    }
    try { return fp.fertilityStatus(); }
    catch (e) { return { answered: false, available: false, tracked: null, loaded: false }; }
  }

  /* ------------------------------------------------- wife / expecting --- */

  /* YOUR word for her. Deliberately generous — this playthrough files people
     as "wife", and a consort or a bride is the same relationship for the
     purpose of this page. Matched on word boundaries so "housewife" or a
     note about someone else's wife cannot drag her in. */
  const WIFE_RE = /(^|[^a-z])(wife|wives|spouse|husband|consort|bride)([^a-z]|$)/;

  function wifeByField(r) {
    return WIFE_RE.test(String((r && r.relationship) || '').toLowerCase());
  }
  function isWife(r) { return !!(r && (r.spouse || wifeByField(r))); }
  function isPregnant(r) { return !!(r && r.fert && r.fert.pregnant); }
  function isMother(r) { return !!(r && r.fert && r.fert.births > 0); }
  function inHousehold(r) { return isWife(r) || isPregnant(r); }

  function inScope(r, scope) {
    if (scope === 'all') return true;
    if (scope === 'wives') return isWife(r);
    if (scope === 'expecting') return isPregnant(r);
    return inHousehold(r);
  }

  /* --------------------------------------------------------- search ----- */

  function haystack(r) {
    const bits = [
      r.name, r.original, r.relationship, r.category, r.note, r.fieldsText,
      r.rankLabel, r.where, r.homeText,
      (r.fert && r.fert.father) ? ('father ' + r.fert.father) : '',
      /* The words someone would actually TYPE to find these people. "wife"
         must find a MARAS spouse whose Relationship field is blank, and
         "pregnant" must find her whether or not anyone wrote it down. */
      isWife(r) ? 'wife wives spouse married maras household' : '',
      isPregnant(r) ? 'pregnant expecting with child carrying baby heir' : '',
      isMother(r) ? 'mother children born births' : '',
      (r.fert && r.fert.ovulating) ? 'ovulating fertile' : '',
      r.dead ? 'dead' : '',
    ];
    return bits.filter(Boolean).join(' ').toLowerCase();
  }

  /* ---------------------------------------------------------- sorting --- */

  /* Closest to term FIRST. That is the actionable order — the page exists to
     answer "who is about to give birth", and a name sort buries her. Wives
     who are not expecting follow, then everyone else, each alphabetical. */
  function rank(r) {
    if (isPregnant(r)) return 0;
    if (isWife(r)) return 1;
    return 2;
  }

  function progressOf(r) {
    const f = r.fert;
    if (!f || !f.pregnant) return -1;
    if (f.termDays && typeof f.percent === 'number') return f.percent;
    return f.day || 0;   // no term: the day is the only honest ordering key
  }

  function compare(a, b) {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const pa = progressOf(a), pb = progressOf(b);
      if (pa !== pb) return pb - pa;      // furthest along first
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  }

  /* Everything the page is about to draw, in order. */
  function visibleRows() {
    const q = ui.filter.trim().toLowerCase();
    const out = [];
    roster().forEach(function (r) {
      if (!inScope(r, ui.scope)) return;
      if (q && haystack(r).indexOf(q) === -1) return;
      out.push(r);
    });
    out.sort(compare);
    return out;
  }

  function counts() {
    const all = roster();
    let wives = 0, preg = 0, household = 0;
    all.forEach(function (r) {
      const w = isWife(r), p = isPregnant(r);
      if (w) wives++;
      if (p) preg++;
      if (w || p) household++;
    });
    return { all: all.length, wives: wives, preg: preg, household: household };
  }

  /* ------------------------------------------------------- rendering ---- */

  /* Highlight the matched run in her name, built as NODES rather than
     innerHTML — a follower's display name is user data and this pane is not
     the place to learn that the hard way. */
  function nameNode(text, q) {
    const el = h('span', { class: 'hh-name', title: text });
    const t = String(text || '');
    const needle = String(q || '').trim();
    const i = needle ? t.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    if (i === -1) { el.textContent = t; return el; }
    el.appendChild(document.createTextNode(t.slice(0, i)));
    el.appendChild(h('mark', { text: t.slice(i, i + needle.length) }));
    el.appendChild(document.createTextNode(t.slice(i + needle.length)));
    return el;
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* Her face. A captured photo outranks the facegen head render, and that
     choice was already made for us by portraitFor() inside the Followers
     pane — this only draws whatever it handed over. On a load error the
     <img> is dropped for initials, so a stale path costs nothing. */
  function faceEl(r) {
    const wrap = h('span', {
      class: 'hh-face' + (r.facePending && !r.portraitUrl ? ' is-loading' : ''),
    });
    if (r.portraitUrl) {
      const img = h('img', {
        src: r.portraitUrl,
        /* An explicit box so the card cannot reflow when the image decodes —
           the wrapper is already fixed-size, this is belt and braces. */
        width: '104', height: '104',
        alt: r.name ? ('Portrait of ' + r.name) : 'Portrait',
      });
      img.onerror = function () {
        if (img.parentNode === wrap) wrap.removeChild(img);
        if (!wrap.querySelector('.hh-initials')) {
          wrap.appendChild(h('span', { class: 'hh-initials', text: initialsOf(r.name) }));
        }
      };
      wrap.appendChild(img);
    } else {
      wrap.appendChild(h('span', { class: 'hh-initials', text: initialsOf(r.name) }));
    }
    /* The glanceable number, over the face. Only when there is a real
       denominator — "46%" of an unknown term would be invented. */
    const f = r.fert;
    if (f && f.pregnant && f.termDays && typeof f.percent === 'number') {
      wrap.appendChild(h('span', { class: 'hh-face-pct', text: f.percent + '%' }));
    }
    return wrap;
  }

  function TRI_WORD(n) {
    return n === 1 ? 'first trimester'
         : n === 2 ? 'second trimester'
         : n === 3 ? 'third trimester' : '';
  }

  /* HOW FAR ALONG — the headline of the page.

     The bar is drawn ONLY when Fertility Mode gave us a term length; its
     PregnancyDuration is an MCM setting the bridge reads rather than
     assumes, and when it cannot be read the honest answer is the day count
     and no bar at all. A bar against a guessed denominator is a lie with a
     progress indicator on it. */
  function termBlock(r) {
    const f = r.fert;
    if (!f || !f.pregnant) return null;

    const box = h('div', { class: 'hh-term' });

    if (!f.termDays) {
      box.appendChild(h('div', {
        class: 'hh-term-nobar',
        title: r.fertTitle || '',
        text: 'Day ' + f.day + ' — Fertility Mode did not report a term length',
      }));
      return box;
    }

    const pct = Math.max(0, Math.min(100, typeof f.percent === 'number' ? f.percent : 0));
    const head = h('div', { class: 'hh-term-head' }, [
      h('span', { text: 'Day ' + f.day + ' of ' + f.termDays }),
      f.trimester ? h('span', { class: 'hh-term-tri', text: TRI_WORD(f.trimester) }) : null,
    ]);
    box.appendChild(head);

    const track = h('div', {
      class: 'hh-track',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(pct),
      'aria-label': (r.name || 'She') + ' is ' + pct + '% through her term',
      title: r.fertTitle || '',
    });
    const fill = h('div', { class: 'hh-fill' });
    fill.style.width = pct + '%';
    track.appendChild(fill);
    /* Trimester ticks. FM splits the term in equal thirds
       (FMValues[0] = PregnancyDuration / 3), so the marks are at 1/3 and
       2/3 — the same split the trimester number above comes from. */
    [33.333, 66.667].forEach(function (at) {
      const tick = h('div', { class: 'hh-tick' });
      tick.style.left = at + '%';
      track.appendChild(tick);
    });
    box.appendChild(track);

    const footBits = [];
    if (typeof f.daysLeft === 'number') {
      footBits.push(f.daysLeft <= 0 ? 'due now'
        : (f.daysLeft + (f.daysLeft === 1 ? ' day to go' : ' days to go')));
    }
    const foot = h('div', { class: 'hh-term-foot' });
    foot.appendChild(document.createTextNode(footBits.join(' · ')));
    if (f.father) {
      if (footBits.length) foot.appendChild(document.createTextNode(' · father: '));
      else foot.appendChild(document.createTextNode('father: '));
      foot.appendChild(h('span', { class: 'hh-father', text: f.father }));
    }
    if (foot.childNodes.length) box.appendChild(foot);
    return box;
  }

  /* The chips. Married and pregnant use the ROSTER'S OWN hues (violet /
     rose) so the two surfaces cannot contradict each other. */
  function chipsFor(r) {
    const out = [];
    if (r.spouse) {
      out.push(h('span', {
        class: 'hh-chip is-spouse',
        title: 'Married to you — M.A.R.A.S' +
               (r.relHas ? '\nThe game ranks her ' + r.rankLabel : ''),
        text: '♥ Married',
      }));
    }
    /* Her Relationship field, when it says something the marriage chip does
       not already say. Both chips together is the honest reading of "MARAS
       married her AND you filed her as a wife"; only one means only one is
       true, which is worth seeing. */
    if (r.relationship && !(r.spouse && wifeByField(r))) {
      out.push(h('span', {
        class: 'hh-chip is-field',
        title: 'Her Relationship field — what YOU wrote about her',
        text: r.relationship,
      }));
    } else if (r.spouse && wifeByField(r) && r.relationship) {
      out.push(h('span', {
        class: 'hh-chip is-field',
        title: 'Her Relationship field — what YOU wrote about her\n' +
               'M.A.R.A.S agrees: you are married',
        text: r.relationship,
      }));
    }
    if (isMother(r)) {
      const n = r.fert.births;
      out.push(h('span', {
        class: 'hh-chip',
        title: 'Fertility Mode: previous births',
        text: n + (n === 1 ? ' born' : ' born'),
      }));
    }
    if (r.relHas && r.rankLabel) {
      out.push(h('span', {
        class: 'hh-chip is-rank',
        title: "Skyrim's own relationship rank — what the GAME believes,\n" +
               'which is a different fact from anything you typed',
        text: r.rankLabel,
      }));
    }
    if (r.dead) {
      out.push(h('span', { class: 'hh-chip is-warn', text: 'dead' }));
    }
    return out;
  }

  function subLine(r) {
    const bits = [];
    if (r.category) bits.push(r.category);
    if (r.following) bits.push('with you now');
    else if (r.waiting) bits.push('waiting');
    else if (r.where) bits.push(r.where);
    else if (r.homeText) bits.push(r.homeText);
    if (!bits.length && r.note) bits.push(r.note);
    return bits.join(' · ');
  }

  /* Someone tracked by Fertility Mode but not pregnant — quiet context, and
     only when FM actually has something to say. */
  function cycleLine(r) {
    const f = r.fert;
    if (!f || f.pregnant) return null;
    const bits = [];
    if (f.cycleDay) bits.push('cycle day ' + f.cycleDay);
    if (f.ovulating) bits.push('ovulating');
    if (!bits.length) return null;
    return h('div', {
      class: 'hh-cycle',
      title: r.fertTitle || '',
      text: bits.join(' · '),
    });
  }

  function cardFor(r, i, q) {
    const preg = isPregnant(r), wife = isWife(r);
    const card = h('button', {
      class: 'hh-card' + (wife ? ' is-wife' : '') + (preg ? ' is-preg' : '') +
             (i === ui.sel ? ' is-sel' : ''),
      type: 'button',
      'data-original': r.original || '',
      title: 'Open her card in the Followers tab',
    });
    card.appendChild(faceEl(r));

    const main = h('div', { class: 'hh-main' });
    const nameRow = h('div', { class: 'hh-name-row' }, [nameNode(r.name, q)]);
    const chips = chipsFor(r);
    if (chips.length) nameRow.appendChild(h('div', { class: 'hh-chips' }, chips));
    main.appendChild(nameRow);

    const sub = subLine(r);
    if (sub) main.appendChild(h('div', { class: 'hh-sub', text: sub, title: sub }));

    const term = termBlock(r);
    if (term) main.appendChild(term);
    else {
      const cyc = cycleLine(r);
      if (cyc) main.appendChild(cyc);
    }

    card.appendChild(main);
    card.addEventListener('click', function () { openPerson(r); });
    return card;
  }

  /* ----------------------------------------------------- empty states --- */

  /* NEVER an empty page with no sentence on it. "Nobody is expecting" and
     "the mod that would know is not answering" look identical if the page
     just draws nothing, and only one of them means everything is fine. */
  function emptyState(c, fs) {
    const q = ui.filter.trim();
    if (q) {
      return h('div', { class: 'hh-empty' }, [
        h('div', { class: 'hh-empty-glyph', 'aria-hidden': 'true', text: '⌕' }),
        h('div', { class: 'hh-empty-title',
          text: 'Nobody matches \u201c' + q + '\u201d' }),
        h('div', { class: 'hh-empty-note',
          text: 'Try a name, a category, \u201cwife\u201d, \u201cpregnant\u201d, '
              + 'or clear the box to see everyone in scope.' }),
      ]);
    }
    if (!fs.loaded) {
      return h('div', { class: 'hh-empty' }, [
        h('div', { class: 'hh-empty-glyph', 'aria-hidden': 'true', text: '◌' }),
        h('div', { class: 'hh-empty-title', text: 'Reading the roster…' }),
        h('div', { class: 'hh-empty-note',
          text: 'Follower Organizer has not answered yet. This page fills itself in as soon as it does.' }),
      ]);
    }
    if (!c.all) {
      return h('div', { class: 'hh-empty' }, [
        h('div', { class: 'hh-empty-glyph', 'aria-hidden': 'true', text: '⌂' }),
        h('div', { class: 'hh-empty-title', text: 'The roster is empty' }),
        h('div', { class: 'hh-empty-note',
          text: 'This page is a view of Follower Organizer. File someone into it — from the Followers tab, or FO’s own menu — and she appears here.' }),
      ]);
    }
    if (ui.scope === 'expecting') {
      return h('div', { class: 'hh-empty' }, [
        h('div', { class: 'hh-empty-glyph', 'aria-hidden': 'true', text: '◍' }),
        h('div', { class: 'hh-empty-title',
          text: fs.available ? 'Nobody is expecting right now' : 'Pregnancies cannot be read' }),
        h('div', { class: 'hh-empty-note',
          text: fs.available
            ? 'Fertility Mode is answering — it simply has no pregnancy on the roster at the moment.'
            : 'Fertility Mode is not installed, or its storage quest has not started yet. Marriages still show on the other scopes.' }),
      ]);
    }
    if (ui.scope === 'wives') {
      return h('div', { class: 'hh-empty' }, [
        h('div', { class: 'hh-empty-glyph', 'aria-hidden': 'true', text: '♥' }),
        h('div', { class: 'hh-empty-title', text: 'No wives on the roster' }),
        h('div', { class: 'hh-empty-note',
          text: 'Someone counts as a wife here when M.A.R.A.S has you married to her, or when her Relationship field says so. Set that field from her card in the Followers tab.' }),
      ]);
    }
    return h('div', { class: 'hh-empty' }, [
      h('div', { class: 'hh-empty-glyph', 'aria-hidden': 'true', text: '⌂' }),
      h('div', { class: 'hh-empty-title', text: 'Nobody in the household yet' }),
      h('div', { class: 'hh-empty-note',
        text: 'Wives and anyone expecting land here on their own. ' +
              (c.all + ' ' + (c.all === 1 ? 'person is' : 'people are') +
               ' on the roster — switch to Everyone to see them.') }),
    ]);
  }

  /* The honest banner above the grid, when something the page depends on is
     not answering. It never replaces the list — marriages still work with
     Fertility Mode absent, so the page stays useful and merely says less. */
  function noteFor(c, fs) {
    if (!fs.loaded) return null;
    if (!fs.answered) {
      return 'Fertility Mode has not reported yet — pregnancies will fill in when it does. ' +
             'Marriages below are unaffected.';
    }
    if (!fs.available) {
      return 'Fertility Mode is not answering (not installed, or its storage quest has not started), ' +
             'so nobody can be shown as expecting. Everything else on this page is live.';
    }
    if (fs.tracked === 0) {
      return 'Fertility Mode is running but is not tracking anyone on this roster yet.';
    }
    return null;
  }

  /* ------------------------------------------------------------ paint --- */

  function render() {
    const pane = $('hh-pane');
    if (!pane) return;
    ensureSkeleton();

    const c = counts();
    const fs = fertStatus();
    const q = ui.filter.trim();
    const rows = visibleRows();
    lastRows = rows;
    if (ui.sel >= rows.length) ui.sel = rows.length - 1;

    /* ---- header counts */
    const cts = $('hh-counts');
    if (cts) {
      cts.textContent = '';
      cts.appendChild(h('span', {
        class: 'hh-count is-wife',
        title: 'Married per M.A.R.A.S, or filed as a wife in her Relationship field',
        text: c.wives + (c.wives === 1 ? ' wife' : ' wives'),
      }));
      cts.appendChild(h('span', {
        class: 'hh-count is-preg',
        title: 'Pregnant right now, per Fertility Mode',
        text: c.preg + ' expecting',
      }));
      cts.appendChild(h('span', {
        class: 'hh-count',
        title: 'Everyone on the Follower Organizer roster',
        text: c.all + ' on the roster',
      }));
    }

    /* ---- the scope segments, each carrying its own live tally */
    const seg = $('hh-seg');
    if (seg) {
      seg.textContent = '';
      SCOPES.forEach(function (s) {
        const n = s.key === 'all' ? c.all
                : s.key === 'wives' ? c.wives
                : s.key === 'expecting' ? c.preg : c.household;
        const b = h('button', {
          class: 'hh-seg-btn' + (ui.scope === s.key ? ' is-on' : ''),
          type: 'button',
          title: s.title,
          'aria-pressed': ui.scope === s.key ? 'true' : 'false',
        }, [
          h('span', { text: s.label }),
          h('span', { class: 'hh-seg-n', text: String(n) }),
        ]);
        b.addEventListener('click', function () {
          ui.scope = s.key;
          ui.sel = -1;
          render();
        });
        seg.appendChild(b);
      });
    }

    /* ---- the note */
    const noteHost = $('hh-note-host');
    if (noteHost) {
      noteHost.textContent = '';
      const msg = noteFor(c, fs);
      if (msg) noteHost.appendChild(h('div', { class: 'hh-note', text: msg }));
    }

    /* ---- the grid */
    const body = $('hh-body');
    if (!body) return;
    body.textContent = '';
    if (!rows.length) {
      body.appendChild(emptyState(c, fs));
      return;
    }
    const grid = h('div', { class: 'hh-grid' });
    rows.forEach(function (r, i) { grid.appendChild(cardFor(r, i, q)); });
    body.appendChild(grid);

    /* Face-fit every portrait through the SHARED module, so a head render is
       framed on the face and a hand crop still wins — the roster medallions
       and the Finder tiles go through the same door. */
    try {
      if (window.HDFaceFit && HDFaceFit.paintPortraitsIn) {
        HDFaceFit.paintPortraitsIn(grid, '.hh-face img');
      }
    } catch (e) {}
  }

  /* The static skeleton lives in index.html; this only fills it the first
     time, so a harness that mounts a bare <section id="hh-pane"> works too. */
  function ensureSkeleton() {
    const pane = $('hh-pane');
    if (!pane || mounted) return;
    if ($('hh-body')) { mounted = true; wireChrome(); return; }

    pane.appendChild(h('div', { class: 'hh-head' }, [
      h('div', { class: 'hh-title', text: 'Household' }),
      h('div', { class: 'hh-counts', id: 'hh-counts' }),
      h('div', { class: 'hh-head-right' }, [
        h('button', { class: 'hh-btn', id: 'hh-refresh', type: 'button',
          title: 'Re-read the roster, marriages and pregnancies' }, '⟳ Refresh'),
      ]),
    ]));
    pane.appendChild(h('div', { class: 'hh-bar' }, [
      h('div', { class: 'hh-search-wrap' }, [
        h('span', { class: 'hh-search-glyph', 'aria-hidden': 'true', text: '⌕' }),
        h('input', { id: 'hh-search', type: 'text', autocomplete: 'off',
          spellcheck: 'false',
          'aria-label': 'Search the household',
          placeholder: 'Search — a name, \u201cwife\u201d, \u201cpregnant\u201d, a category…' }),
        h('button', { class: 'hh-clear', id: 'hh-clear', type: 'button',
          'aria-hidden': 'false',
          'aria-label': 'Clear the search', title: 'Clear' }, '✕'),
      ]),
      h('div', { class: 'hh-seg', id: 'hh-seg', role: 'group',
        'aria-label': 'Who to show' }),
    ]));
    pane.appendChild(h('div', { id: 'hh-note-host' }));
    pane.appendChild(h('div', { class: 'hh-body', id: 'hh-body' }));
    /* The toast is the only thing on this page that speaks after the fact
       (a refusal to open someone who has left the roster), so it announces
       itself rather than only appearing. */
    pane.appendChild(h('div', { id: 'hh-toast', class: 'hidden',
      role: 'status', 'aria-live': 'polite' }));
    mounted = true;
    wireChrome();
  }

  function wireChrome() {
    const s = $('hh-search');
    if (s && !s.__hhWired) {
      s.__hhWired = true;
      s.addEventListener('input', function () {
        ui.filter = s.value || '';
        ui.sel = -1;
        render();
      });
    }
    const clr = $('hh-clear');
    if (clr && !clr.__hhWired) {
      clr.__hhWired = true;
      clr.addEventListener('click', function () {
        ui.filter = '';
        ui.sel = -1;
        const box = $('hh-search');
        if (box) { box.value = ''; box.focus(); }
        render();
      });
    }
    const rf = $('hh-refresh');
    if (rf && !rf.__hhWired) {
      rf.__hhWired = true;
      rf.addEventListener('click', function () { refresh(true); });
    }
  }

  /* ---------------------------------------------------------- actions --- */

  function toast(msg) {
    const t = $('hh-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }

  /* Open her where her VERBS live. This page deliberately implements none of
     them: summon, dress, order, photograph and the rest are the Followers
     tab's, and re-hosting a copy here is how two surfaces start disagreeing
     about what a button does. Land on that tab, then address the card at her
     by the durable roster identity — the same call the crew strip's faces
     and the Wheel's party wedges make. */
  function openPerson(r) {
    if (!r || !r.original) return false;
    const fp = folPane();
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
    if (fp && typeof fp.quickPick === 'function') {
      const ok = fp.quickPick(r.original, r.name);
      if (!ok) toast('Could not open ' + (r.name || 'her') + ' — she is no longer on the roster');
      return ok;
    }
    return false;
  }

  /* Ask the Followers tab's own bridge to re-read. fdRefresh is what its
     onShow sends, and C++ answers it with fdState + fdNff + fdFertility — so
     one request refreshes every fact on this page, through the pane that
     owns the rail. */
  function refresh(loud) {
    try {
      if (typeof window.toGame === 'function') window.toGame('fdRefresh');
      else if (window.hdBridge && window.hdBridge.toGame) window.hdBridge.toGame('fdRefresh');
    } catch (e) {}
    if (loud) toast('Re-reading the household…');
  }

  /* ------------------------------------------------------------- keys --- */

  function onKey(e) {
    if (!e) return false;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (!lastRows.length) return false;
      ui.sel = (k === 'ArrowDown')
        ? Math.min(lastRows.length - 1, ui.sel + 1)
        : Math.max(0, ui.sel <= 0 ? 0 : ui.sel - 1);
      render();
      const sel = document.querySelector('#hh-body .hh-card.is-sel');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (k === 'Enter') {
      /* Enter takes the TOP hit when nothing is selected — the deck's
         standing rule for every filterable surface (fd-ctx-menu idiom). */
      const r = lastRows[ui.sel >= 0 ? ui.sel : 0];
      if (!r) return false;
      openPerson(r);
      return true;
    }
    if (k === 'Escape') {
      /* Esc peels back one layer: a typed filter first, the deck only when
         there is nothing left to clear. Same as every other pane here. */
      if (ui.filter) {
        ui.filter = '';
        ui.sel = -1;
        const box = $('hh-search');
        if (box) box.value = '';
        render();
        return true;
      }
      return false;
    }
    return false;
  }

  /* ------------------------------------------------------------- API ---- */

  return {
    init() { ensureSkeleton(); },

    onShow() {
      ensureSkeleton();
      ui.sel = -1;
      /* Re-query every show: someone can marry, conceive or be filed into the
         roster between two looks at this page, and a stale household is
         exactly what it exists to prevent. */
      refresh(false);
      render();
      setTimeout(function () {
        const s = $('hh-search');
        if (s) s.focus();
      }, 30);
    },

    onHide() {
      const t = $('hh-toast');
      if (t) t.classList.add('hidden');
    },

    onKey: onKey,

    /* Called by followers-pane.js when fdState / fdFertility land, because
       this tab cannot see those pushes itself. */
    dataChanged() {
      if (window.__hdActiveTab === 'household') render();
    },

    /* Omni / deep-open entry: land on the page with a scope and query
       already set (used by the search provider's jump). */
    show(scope, q) {
      if (scope && SCOPES.some(function (s) { return s.key === scope; })) ui.scope = scope;
      if (typeof q === 'string') {
        ui.filter = q;
        const box = $('hh-search');
        if (box) box.value = q;
      }
      ui.sel = -1;
      render();
    },

    setFilter(q) {
      ui.filter = String(q || '');
      ui.sel = -1;
      const box = $('hh-search');
      if (box) box.value = ui.filter;
      render();
    },

    /* ---- test hooks (household-pane.test.html drives the SHIPPED code) -- */
    _ui: ui,
    _SCOPES: SCOPES,
    _isWife: isWife,
    _wifeByField: wifeByField,
    _isPregnant: isPregnant,
    _isMother: isMother,
    _inHousehold: inHousehold,
    _inScope: inScope,
    _haystack: haystack,
    _compare: compare,
    _progressOf: progressOf,
    _visibleRows: visibleRows,
    _counts: counts,
    _render: render,
    _cardFor: cardFor,
    _termBlock: termBlock,
    _chipsFor: chipsFor,
    _noteFor: noteFor,
    _emptyState: emptyState,
    _nameNode: nameNode,
    _initialsOf: initialsOf,
    _openPerson: openPerson,
    _omniIndex: omniIndex,
    _DEV: DEV,
  };

  /* ----------------------------------------------------------- omni ----- */
  /* Declared after the return on purpose — a function declaration hoists, so
     the API object above can reference it while the reader meets it here,
     next to the registration it exists for. */

  function omniIndex() {
    const items = [];
    const c = counts();

    /* The page itself, and each scope as its own row — the scopes ARE the
       questions ("who is pregnant"), so each gets a row rather than one row
       that lands on whatever scope was last used. The Finder's own provider
       makes the same call. */
    SCOPES.forEach(function (s) {
      const n = s.key === 'all' ? c.all
              : s.key === 'wives' ? c.wives
              : s.key === 'expecting' ? c.preg : c.household;
      items.push({
        label: s.key === 'household' ? 'Household' : ('Household: ' + s.label.toLowerCase()),
        detail: s.title + ' — ' + n,
        kind: 'page',
        keywords: 'household wives wife pregnant expecting harem family '
                + 'spouse married pregnancy who is pregnant how far along',
        run: function () {
          if (typeof window.__omniSetTab === 'function') window.__omniSetTab('household');
          const hp = window.HouseholdPane;
          if (hp) hp.show(s.key, '');
        },
      });
    });

    /* And every person on the page, so "pregnant" or "wife" typed into the
       omni finds the PEOPLE, not just the page. The marker rides in `kind`,
       which is the chip the result row already draws. */
    roster().forEach(function (r) {
      if (!inHousehold(r)) return;
      const preg = isPregnant(r);
      const f = r.fert;
      const pct = (preg && f && f.termDays && typeof f.percent === 'number')
        ? (f.percent + '%') : '';
      items.push({
        label: r.name || r.original,
        detail: [
          isWife(r) ? '♥ wife' : '',
          preg ? ('◍ expecting' + (pct ? ' — ' + pct : '') +
                  (f && f.termDays ? ' (day ' + f.day + ' of ' + f.termDays + ')' : '')) : '',
          r.category,
        ].filter(Boolean).join(' · '),
        kind: preg ? 'expecting' : 'wife',
        keywords: haystack(r),
        run: function () { openPerson(r); },
      });
    });
    return items;
  }

})();

/* Register with the omni (Ctrl+F / the Super Searcher) once it exists. The
   guard matters in the harness, where HDOmni is absent by design. */
(function () {
  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'household',
      label: 'Household',
      tab: 'household',
      setFilter: function (q) {
        if (window.HouseholdPane) HouseholdPane.setFilter(q);
      },
      index: function () {
        return (window.HouseholdPane && window.HouseholdPane._omniIndex)
          ? window.HouseholdPane._omniIndex() : [];
      },
    });
  }
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.HouseholdPane.init(); });
} else {
  window.HouseholdPane.init();
}
