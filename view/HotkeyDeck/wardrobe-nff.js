'use strict';

/* ====================================================================== *
 *  NFF outfits — the SECOND dressing backend, as a sub-tab of Wardrobe.
 *
 *  The Wardrobe tab is a layer over SOES-NG. Nether's Follower Framework has
 *  a complete outfit system of its own: per follower, up to THREE wardrobes
 *  of real items kept in hidden chests, swapped as the PLAYER's location type
 *  changes (Adventure / Town / Home). This pane is the front-end for that —
 *  named, iconed, searchable — living beside the SOES one so "her clothes" is
 *  one place, not two.
 *
 *  ⛔ ONE ACTOR, ONE BACKEND. SOES-NG hooks ActorEquipManager::EquipObject and
 *  drops any equip outside its own outfit for a TRACKED actor
 *  (AllowExternalEquipment=false on this rig). NFF re-dresses through exactly
 *  that path, so on a doubly-managed follower the strip lands and the re-dress
 *  does not — and every location change costs a full strip/re-equip of every
 *  slot, which is the signature of the documented White Hearth crash. So this
 *  pane never lets both hold the same person: it shows the clash loudly, and
 *  handing someone to NFF (⇄) clears her Wardrobe assignment first.
 *
 *  INTEGRATION. Self-registering: it hands WardrobePane a sub-tab descriptor at
 *  parse time and owns everything under it — its rows, its two overlays, its
 *  own bridge. It never reads or writes the host's state. Every id/class is
 *  nf- prefixed, and the styles live in their own wardrobe-nff.css (NOT in
 *  app.css, whose tail tools/sync_view_frags.py rewrites from the wardrobe
 *  fragment — anything appended after that marker would be silently dropped).
 *
 *  Bridge — C++ registers these JS->C++ listeners on the DECK view:
 *    nfGet() · nfSave(json) · nfWear(json) · nfBuild(json) · nfClear(json) ·
 *    nfSatchel(json) · nfClaim(json) · nfPieces(json) · nfLog(str)
 *  C++ calls back (names deliberately disjoint, because PrismaUI installs each
 *  JS listener as a global of that name and a shared name clobbers the handler):
 *    nfOpen(json) · nfResult(json) · nfPieceList(json)
 *
 *  Icons ride the deck's ONE icon pool. Rather than duplicate the enumeration
 *  we CHAIN app.js's own hdIcons / hdIconIndex globals — the same trick the
 *  Wardrobe pane uses for window.hdClosed — so a file dropped into
 *  Desktop\Spell Deck Icons appears here on the same ⟳ Refresh as everywhere
 *  else, with no extra C++ and no edit to app.js.
 *
 *  Laws inherited from the other panes, because they cost real debugging:
 *    - There is no window.prompt and no window.confirm in PrismaUI. Text is an
 *      inline <input>; destructive actions are an armed two-click.
 *    - A re-render must preserve scroll, focus, caret AND uncommitted text.
 *      Every editable input carries data-k, which is what the HOST's
 *      snapshotUi()/restoreUi() key off — they sweep the whole #wd-pane, so our
 *      fields are covered by that pass with no duplicated machinery.
 *    - Long lists page. PAGE rows at a time with a tail that says how many are
 *      hidden; a silent cap reads as "that's everyone".
 * ====================================================================== */

window.WardrobeNff = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  const SAVE_DEBOUNCE = 350;
  const ICON_PAGE = 96;
  const PAGE = 60;

  /* NFF's own numbering — its dialogue fragments pass exactly these as myOpt
   * (nwsFollower_OutfitCommand -> nwsFollowerSetsScript.DialogueCmd), so this is
   * the mod's public API, not our invention. Type 3 ("her own clothes") is a
   * wear target, never a set, so it is deliberately not in SETS. */
  const SETS = [
    { t: 0, name: 'Adventure', hue: 12, hint: 'worn in the wild and in dungeons' },
    { t: 1, name: 'Town', hue: 200, hint: 'worn in towns, cities and inns' },
    { t: 2, name: 'Home', hue: 145, hint: 'worn inside a house you own' },
  ];
  const BASE_TYPE = 3;
  const setTypeName = (t) => (SETS[t] ? SETS[t].name : (t === BASE_TYPE ? 'her own clothes' : '?'));

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }

  /* ============================================================= state == */

  const state = {
    /* view-owned — round-trips through nfSave */
    enabled: true,
    meta: [],        // {formId,plugin,name,sets:[{label,icon,note}x3],note,claimed}
    /* C++-owned mirror (nfOpen); never sent back */
    nff: false,
    /* NFF's Outfit Preview Mode, read LIVE off its quest by C++ (it is a plain
       Int property) with our stored mirror as the fallback. System-wide, not
       per-follower. */
    preview: false,
    slotsUsed: 0,
    slotsMax: 128,
    npcs: [],
    conflicts: [],
    /* chained off app.js's icon pool */
    icons: { custom: [], catalog: [] },
    /* chained off the Followers pane's own feeds — see chainFollowerFeeds() */
    portraits: {},   // slug -> {file,ext,mtime}
    target: null,    // the crosshair NPC snapshotted at palette open
    pieces: null,    // {key,type,items[],error?,loading?} — an opened chest
    /* NFF's four per-follower COMBAT-GEAR switches, keyed by keyOf(npc):
       {known,helm:'off'|'combat'|'never',shield,weapon,ammo}. C++-owned (they
       are faction state on the actor), pulled per person on sheet open and
       re-pushed by C++ after every write, so a Papyrus hop that never landed
       shows as the control springing back rather than a lie. */
    gear: Object.create(null),
    gearAsked: Object.create(null),
  };

  const ui = {
    inited: false,
    loading: true,
    filter: '',
    limit: PAGE,
    sheetKey: null,
    armed: null,
    picker: null,       // {key,type}
    pickFilter: '',
    pickShown: ICON_PAGE,
    onlyNff: false,
    sheetScroll: 0,
    chestFor: null,     // row key whose "open which chest?" chooser is expanded
    combo: null,        // {key,type,q,sel} while the outfit combobox is open
    /* {key,name} while another tab has asked us to focus someone we have not
     * been told about yet — nfGet is asynchronous, so the jump can arrive
     * before the roster does. Applied (once) by the next nfOpen. */
    pendingFocus: null,
  };

  /* SOES-NG's outfit catalogue, handed over read-only by the host pane on every
   * render. Only used to offer "copy this outfit's clothes into an NFF set" —
   * we never write to SOES from here. */
  let soesOutfits = [];
  let comboTimer = 0;

  let host = null;
  let saveTimer = 0;
  const els = {};

  /* ============================================================= utils == */

  /* Canonical when C++ provides it (see the host pane's keyOf for the whole
     story) — both modules must spell one person identically or the People
     join draws her twice. */
  const keyOf = (n) => String(n.key || (String(n.formId || '') + '|' + String(n.plugin || ''))).toLowerCase();
  const lc = (s) => String(s == null ? '' : s).toLowerCase();

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      });
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach((x) => { if (x) el.append(x); });
      else el.append(c);
    }
    return el;
  }

  /* Match highlighting, same shape as the host pane's nameNodes(). */
  function markNodes(text, q) {
    const s = String(text == null ? '' : text);
    if (!q) return [document.createTextNode(s)];
    const i = lc(s).indexOf(q);
    if (i === -1) return [document.createTextNode(s)];
    return [document.createTextNode(s.slice(0, i)),
      h('mark', null, s.slice(i, i + q.length)),
      document.createTextNode(s.slice(i + q.length))];
  }

  /* Defence in depth, same rule as app.js's hkIconSrc: an icon path only ever
   * comes from the picker or from a C++-validated portal op, but a hand-edited
   * hotkeys.json must not be able to hand the webview a filesystem path or an
   * escape out of the view root. */
  function iconSrc(p) {
    p = String(p == null ? '' : p).replace(/\\/g, '/');
    if (!p) return '';
    if (p.indexOf('..') !== -1) return '';
    if (p.charAt(0) === '/') return '';
    if (/^[A-Za-z]:/.test(p)) return '';
    if (/^(?:file|https?):/i.test(p)) return '';
    return p;
  }

  const hueCss = (hue, sat, light) => 'hsl(' + hue + ' ' + sat + '% ' + light + '%)';

  function metaFor(key) { return state.meta.find((m) => keyOf(m) === key) || null; }

  function blankSets() { return SETS.map(() => ({ label: '', icon: '', note: '' })); }

  function ensureMeta(npc) {
    const k = keyOf(npc);
    let m = metaFor(k);
    if (!m) {
      m = { formId: npc.formId, plugin: npc.plugin, name: npc.name || '',
        sets: blankSets(), note: '', claimed: false };
      state.meta.push(m);
    }
    /* A row written by an older build, or by the portal before it knew about a
     * third set, must not throw when indexed. */
    while (m.sets.length < SETS.length) m.sets.push({ label: '', icon: '', note: '' });
    return m;
  }

  /* What you actually see for a set: what you called it, else NFF's own name. */
  function setLabel(m, t) {
    const own = m && m.sets && m.sets[t] && m.sets[t].label;
    return own ? own : SETS[t].name;
  }

  const npcByKey = (k) => state.npcs.find((n) => keyOf(n) === String(k || '').toLowerCase()) || null;

  /* One canonical spelling for a form id, so "0x0001A6A1", "1A6A1" and
   * "0x1a6a1" compare equal — the same rule as followers-pane.js canonFormId().
   * '' means "no usable id", and must NEVER match, or every idless row would
   * answer to every lookup. */
  function canonFormId(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(s)) return '';
    return s.replace(/^0+/, '') || '0';
  }
  /* keyOf() with the id canonicalised and the plugin case-folded, for the ONE
   * place a key crosses a tab boundary (focusNpc). Everything else inside this
   * pane compares keys it minted itself, where the raw form is already exact. */
  function canonKey(n) {
    const id = canonFormId(n && n.formId);
    return id ? id + '|' + String((n && n.plugin) || '').toLowerCase() : '';
  }
  function npcByCanonKey(k) {
    const parts = String(k || '').split('|');
    const want = canonKey({ formId: parts[0], plugin: parts.slice(1).join('|') });
    if (!want) return null;
    return state.npcs.find((n) => canonKey(n) === want) || null;
  }

  /* ----------------------------------------------------------- portraits --
   * A face is NOT a field on the row: Follower Organizer does not carry one.
   * It is RESOLVED — slugOf(original || name) looked up in the portraits
   * listing C++ pushes as fdPortraits. The Followers tab already does exactly
   * this, so we call ITS resolver whenever it is loaded; a second copy of the
   * slug rule would silently drift from portal/server.js and
   * portraits/README.txt, which all three have to agree on.
   *
   * The local path below is the standalone harness (and a hypothetical view
   * without the Followers pane), and is a deliberate mirror of
   * followers-pane.js slugOf() — keep them identical if either ever changes. */
  function slugOf(name) {
    const F = window.FolPane;
    if (F && typeof F._slugOf === 'function') return F._slugOf(name);
    let s2 = String(name == null ? '' : name);
    // Ultralight's JS engine does have normalize(), but a missing normalize
    // must degrade to "no accent folding", never to a thrown render.
    try { s2 = s2.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep s2 */ }
    return s2.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function portraitFor(npc) {
    const F = window.FolPane;
    if (F && typeof F._portraitFor === 'function') {
      const p = F._portraitFor({ original: npc.original, name: npc.name });
      if (p) return p;
    }
    const slug = slugOf(npc.original || npc.name);
    const p = slug ? state.portraits[slug] : null;
    return p ? { slug: slug, file: p.file, ext: p.ext, mtime: p.mtime } : null;
  }

  /* The face, with the retry the Followers pane had to learn: Ultralight's view
   * loader can treat "?v=<mtime>" as part of the FILENAME (proven in-game
   * 2026-07-28), so try the cache-busted URL, retry the plain path ONCE, and
   * only then fall back to initials. `file` is authoritative — a re-capture of
   * an already-drawn face lands as `<slug>~<n>.png`, so never rebuild it from
   * slug + ext. */
  function faceEl(npc) {
    const p = portraitFor(npc);
    const initials = () => h('span', { class: 'nf-face ph', 'aria-hidden': 'true' },
      ((npc.name || '?').trim().charAt(0) || '?').toUpperCase());
    if (!p) return initials();
    const plain = 'portraits/' + p.file;
    const img = h('img', {
      class: 'nf-face', src: plain + '?v=' + (p.mtime || 0), alt: '',
      title: npc.name || '', draggable: 'false',
    });
    let retried = false;
    img.addEventListener('error', function () {
      if (!retried) { retried = true; img.src = plain; return; }
      toGame('nfLog', 'portrait failed to load: ' + plain);
      if (img.parentNode) img.parentNode.replaceChild(initials(), img);
    });
    return img;
  }

  /* ============================================================== save == */

  /* A meta row carries nothing worth persisting once every field is blank and
   * she is not claimed. ensureMeta() creates a row the moment a sheet OPENS, so
   * without this a config would grow one entry per follower you merely looked
   * at. C++ prunes the same way (NffOutfits::IsEmptyMeta) — both ends, because
   * either can be the one that writes. */
  function isEmptyMeta(m) {
    if (m.claimed || (m.note || '').trim()) return false;
    return !m.sets.some((s) => (s.label || '').trim() || (s.icon || '').trim() || (s.note || '').trim());
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.meta = state.meta.filter((m) => !isEmptyMeta(m));
      toGame('nfSave', JSON.stringify({ enabled: state.enabled, npcs: state.meta }));
    }, SAVE_DEBOUNCE);
  }
  function touch() { save(); rerender(); }
  function rerender() { if (host && typeof host.render === 'function') host.render(); }
  function toast(msg) {
    if (host && typeof host.toast === 'function') { host.toast(msg); return; }
    console.log('[nff toast]', msg);
  }

  /* ============================================================ search == */

  function matches(npc, q) {
    if (ui.onlyNff && npc.slot < 0) return false;
    if (!q) return true;
    if (lc(npc.name).indexOf(q) !== -1) return true;
    const m = metaFor(keyOf(npc));
    if (!m) return false;
    if (lc(m.note).indexOf(q) !== -1) return true;
    return m.sets.some((s) => lc(s.label).indexOf(q) !== -1 || lc(s.note).indexOf(q) !== -1);
  }

  /* ============================================================ render == */

  function render(ctx) {
    host = ctx;
    soesOutfits = (ctx.soes && Array.isArray(ctx.soes.outfits)) ? ctx.soes.outfits : [];
    ensureOverlays(ctx.pane);
    const list = ctx.list;

    if (ui.loading) {
      for (let i = 0; i < 5; i++) list.append(h('div', { class: 'wd-skel row', 'aria-hidden': 'true' }));
      renderOverlays();
      return -1;   // -1 = "no count yet"
    }

    list.append(banner());

    const q = ui.filter;
    const rows = state.npcs.filter((n) => matches(n, q));
    const total = rows.length;
    const shown = Math.min(total, ui.limit);
    for (let i = 0; i < shown; i++) list.append(npcRow(rows[i], q));
    if (total > shown) {
      const rest = total - shown;
      list.append(h('button', {
        class: 'wd-more', type: 'button',
        onclick: () => { ui.limit += PAGE; rerender(); },
      }, 'Show ' + Math.min(rest, PAGE) + ' more — ' + rest + ' still hidden'));
    }
    if (!total) list.append(emptyState(q));

    renderOverlays();
    return total;
  }

  /* ------------------------------------------------------------ banner -- */

  function banner() {
    const bar = h('div', { class: 'nf-bar' });

    if (!state.nff) {
      bar.append(h('div', { class: 'nf-note warn' },
        h('strong', null, 'Nether’s Follower Framework isn’t answering. '),
        'Either it isn’t installed, or no save is loaded yet. Nothing here can act until it is.'));
      return bar;
    }

    const clashes = state.conflicts.length;
    if (clashes) {
      bar.append(h('div', { class: 'nf-note bad' },
        h('strong', null, clashes + (clashes === 1 ? ' person is' : ' people are') + ' dressed by BOTH systems. '),
        'SOES blocks every piece NFF puts on, so they wear whatever SOES decided — and ' +
        're-dress on every load door. Give each of them one backend; the ⇄ button does it.',
        h('button', {
          class: 'ghost-btn', type: 'button',
          onclick: () => {
            const first = state.npcs.find((n) => n.conflict);
            if (first) openSheet(first); else toast('Nothing is clashing any more');
          },
        }, 'Fix the first')));
    }

    /* "Open the container from anywhere": whoever you are LOOKING at, without
     * finding her in the list first. C++ snapshots the crosshair NPC at palette
     * open and pushes it as fdTarget, which we chain — so this costs no new
     * bridge. Filling a set that does not exist yet is exactly how you MAKE one,
     * so all three are always offered. */
    if (state.target) {
      const known = state.npcs.find((n) => n.formId.toUpperCase() === state.target.formId.toUpperCase());
      const who = known || { formId: state.target.formId, plugin: '', name: state.target.name,
        wardrobe: false, have: [false, false, false], counts: [-1, -1, -1], worn: -1, slot: -1 };
      bar.append(h('div', { class: 'nf-quick' },
        h('span', { class: 'nf-quick-who', title: 'The NPC you were looking at when the deck opened' },
          '\u2316 ' + (state.target.name || 'that NPC')),
        h('span', { class: 'nf-hint' }, 'open a clothes chest:'),
        SETS.map((sp) => h('button', {
          class: 'ghost-btn', type: 'button',
          title: 'Open her ' + sp.name + ' chest \u2014 drop clothes in, close it, done. ' +
            'If she has no ' + sp.name + ' outfit yet, this is what makes one.',
          onclick: () => build(who, sp.t),
        }, sp.name))));
    }

    bar.append(h('div', { class: 'nf-stats' },
      h('span', null, h('b', null, String(state.slotsUsed)),
        ' of ' + state.slotsMax + ' NFF outfit slots used'),
      h('button', {
        class: 'ghost-btn' + (ui.onlyNff ? ' on' : ''), type: 'button',
        'aria-pressed': ui.onlyNff ? 'true' : 'false',
        title: 'Show only the people NFF already dresses',
        onclick: () => { ui.onlyNff = !ui.onlyNff; ui.limit = PAGE; rerender(); },
      }, ui.onlyNff ? '✓ In NFF only' : 'In NFF only'),
      h('button', {
        class: 'ghost-btn' + (state.enabled ? '' : ' on'), type: 'button',
        title: state.enabled
          ? 'Stop the deck acting on NFF outfits. NFF itself keeps running — this only gags the deck.'
          : 'Let the deck act on NFF outfits again',
        onclick: () => { state.enabled = !state.enabled; touch(); },
      }, state.enabled ? 'Deck control: on' : 'Deck control: OFF')));
    return bar;
  }

  function emptyState(q) {
    if (q) {
      return h('div', { class: 'nf-empty' },
        h('p', null, 'Nobody matches “' + q + '”.'),
        h('p', { class: 'dim' }, 'Search covers names, the names you gave their outfits, and your notes.'));
    }
    if (ui.onlyNff) {
      return h('div', { class: 'nf-empty' },
        h('p', null, 'NFF isn’t dressing anyone yet.'),
        h('p', { class: 'dim' }, 'Turn the filter off, pick someone, and use “Fill it…” on one of their three outfits.'));
    }
    return h('div', { class: 'nf-empty' },
      h('p', null, 'No followers to show.'),
      h('p', { class: 'dim' }, 'The roster comes from Follower Organizer — the same list the Followers tab shows.'));
  }

  /* ------------------------------------------------------------- a row -- */

  function npcRow(npc, q) {
    const k = keyOf(npc);
    const m = metaFor(k);

    const face = faceEl(npc);

    const badges = h('span', { class: 'nf-badges' });
    if (npc.conflict) {
      badges.append(h('span', { class: 'nf-badge bad', title: 'The Wardrobe (SOES) dresses her too — they fight' }, '⚠ clash'));
    } else if (npc.wardrobe) {
      badges.append(h('span', { class: 'nf-badge dim', title: 'Dressed by the Wardrobe (SOES), not by NFF' }, 'Wardrobe'));
    }
    if (m && m.claimed) {
      badges.append(h('span', { class: 'nf-badge good', title: 'Handed to NFF — the Wardrobe leaves her alone' }, 'NFF'));
    }
    if (npc.slot >= 0) {
      badges.append(h('span', { class: 'nf-badge', title: 'Her NFF storage slot' }, '#' + (npc.slot + 1)));
    }
    if (!npc.resolved) {
      badges.append(h('span', { class: 'nf-badge dim', title: 'Not loaded in the game right now, so her live state is unknown' }, 'not loaded'));
    }

    const chips = h('div', { class: 'nf-chips' });
    SETS.forEach((s) => chips.append(setChip(npc, m, s.t, q)));
    if (npc.slot >= 0) {
      chips.append(h('button', {
        class: 'nf-chip base' + (npc.worn === BASE_TYPE ? ' worn' : ''), type: 'button',
        title: 'Put her own original clothes back on. The three sets stay where they are.',
        onclick: (e) => { e.stopPropagation(); wear(npc, BASE_TYPE); },
      }, h('span', { class: 'nf-chip-n' }, 'Her own')));
    }

    /* The chest button. NFF's "put things in this outfit" is a ContainerMenu it
     * opens for you, and it was previously only reachable two clicks deep in the
     * sheet. One click reveals which of the three, the second opens it. */
    const chestOpen = ui.chestFor === k;
    const chestBtn = h('button', {
      class: 'nf-chest' + (chestOpen ? ' on' : ''), type: 'button',
      'aria-expanded': chestOpen ? 'true' : 'false',
      title: 'Open one of her clothes chests \u2014 this is also how you make a new outfit',
      onclick: (e) => { e.stopPropagation(); ui.chestFor = chestOpen ? null : k; rerender(); },
    }, '\uD83D\uDCE6');

    const chooser = chestOpen ? h('div', { class: 'nf-chest-row' },
      h('span', { class: 'nf-hint' }, 'Open which chest?'),
      SETS.map((sp) => h('button', {
        class: 'ghost-btn', type: 'button',
        title: (npc.have && npc.have[sp.t])
          ? 'Change what is in her ' + sp.name + ' outfit'
          : 'She has no ' + sp.name + ' outfit \u2014 opening this chest is what makes one',
        onclick: (e) => { e.stopPropagation(); ui.chestFor = null; build(npc, sp.t); },
      }, sp.name + ((npc.have && npc.have[sp.t]) ? '' : ' \uFF0B')))) : null;

    return h('div', {
      class: 'nf-row' + (npc.conflict ? ' clash' : ''),
      role: 'listitem', tabindex: '0', 'data-npc': k,
      onclick: () => openSheet(npc),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(npc); }
      },
    },
    face,
    h('div', { class: 'nf-id' },
      h('div', { class: 'nf-name' }, markNodes(npc.name || '(unnamed)', q), badges),
      m && m.note ? h('div', { class: 'nf-note-line' }, markNodes(m.note, q)) : null,
      chips,
      chooser),
    chestBtn);
  }

  /* The row's CONTROLS for one person, without the row: badges, the three set
     chips, the chest chooser and the open-a-chest button. This is what the
     host's People sheet embeds when a person is in NFF mode — her face and
     name are already the sheet's header, so repeating them here would just be
     clutter. Everything routes through the same helpers as the row, so the
     sheet's copy and the (retired) tab's copy cannot drift. */
  function controlsFor(key) {
    const k = String(key || '').toLowerCase();
    const npc = state.npcs.find((n) => keyOf(n).toLowerCase() === k);
    if (!npc) {
      return h('div', { class: 'nf-note dim' }, ui.loading
        ? 'Reading her NFF state…'
        : 'NFF doesn’t know her yet — recruit her, or open her dialogue once.');
    }
    const m = metaFor(keyOf(npc));
    const wrap = h('div', { class: 'nf-embed' });

    const chips = h('div', { class: 'nf-chips' });
    SETS.forEach((s) => chips.append(setChip(npc, m, s.t, '')));
    if (npc.slot >= 0) {
      chips.append(h('button', {
        class: 'nf-chip base' + (npc.worn === BASE_TYPE ? ' worn' : ''), type: 'button',
        title: 'Put her own original clothes back on. The three sets stay where they are.',
        onclick: (e) => { e.stopPropagation(); wear(npc, BASE_TYPE); },
      }, h('span', { class: 'nf-chip-n' }, 'Her own')));
    }
    wrap.append(chips);

    const chest = h('div', { class: 'nf-chest-row' },
      h('span', { class: 'nf-hint' }, 'Open a chest (this is how you fill a set):'),
      SETS.map((sp) => h('button', {
        class: 'ghost-btn', type: 'button',
        title: (npc.have && npc.have[sp.t])
          ? 'Change what is in her ' + sp.name + ' outfit'
          : 'She has no ' + sp.name + ' outfit — opening this chest is what makes one',
        onclick: (e) => { e.stopPropagation(); build(npc, sp.t); },
      }, sp.name + ((npc.have && npc.have[sp.t]) ? '' : ' ＋'))));
    wrap.append(chest);

    if (npc.slot >= 0) {
      wrap.append(h('div', { class: 'nf-chest-row' },
        h('button', { class: 'ghost-btn', type: 'button',
          title: 'Open her NFF satchel',
          onclick: (e) => { e.stopPropagation(); toGame('nfSatchel', req(npc, {})); } }, '🎒 Satchel'),
        /* NFF's own Copy Outfit. Nothing comes OFF her — you get a copy of what
           she has on, which is how you build the same look for somebody else. */
        h('button', { class: 'ghost-btn', type: 'button',
          title: 'Put a copy of what she is wearing into YOUR pack — she keeps hers',
          onclick: (e) => { e.stopPropagation(); toGame('nfClone', req(npc, {})); } },
          '⎘ Copy her outfit to me')));
    }
    wrap.append(systemRow());
    return wrap;
  }

  /* ------------------------------------------------- NFF's system controls --
   *
   * Four things NFF's outfit engine has that only its MCM could reach, none of
   * which takes a follower — so they sit once under the per-person controls
   * rather than being repeated on every card.
   *
   *   Preview mode   fill a set through a hidden chest (off) or by dressing
   *                  HER, frozen, in her own inventory (on).
   *   Re-check       re-evaluate where you are and re-dress everyone. The
   *                  answer to "she is in my house still wearing her armour".
   *   Switch         NFF's own outfit-switch hotkey: a three-way chooser on
   *                  Manual switch style, a flip on Toggle, a re-evaluate on
   *                  Automatic. Which of those you get is NFF's MCM setting,
   *                  which is why the tooltip says so instead of promising one.
   *   Player chest   the shared container every cleared outfit set and every
   *                  dismissed follower's leftovers drain INTO.
   */
  function systemRow() {
    const row = h('div', { class: 'nf-sysrow' });
    row.append(h('span', { class: 'nf-hint' }, 'All followers:'));

    row.append(h('button', {
      class: 'ghost-btn', type: 'button',
      title: 'Re-check where you are and re-dress everyone NFF dresses',
      onclick: (e) => { e.stopPropagation(); toGame('nfSwitch', '{"mode":"recheck"}'); },
    }, '↻ Re-check outfits'));

    row.append(h('button', {
      class: 'ghost-btn', type: 'button',
      title: 'Fires NFF’s outfit-switch hotkey — the same one its MCM binds.\n'
        + 'Which behaviour you get is NFF’s “Switch Style” setting (its MCM ▸ Outfits):\n'
        + '  • Manual — a three-way chooser pops: pick Adventure / Town / Home\n'
        + '  • Toggle — flips town+home dressing off, press again to restore\n'
        + '  • Automatic — just re-checks location, same as ↻\n'
        + 'The deck cannot read that setting (NFF keeps it in its own MCM state),\n'
        + 'so if the click seems to do nothing, your style is likely Automatic.',
      onclick: (e) => { e.stopPropagation(); toGame('nfSwitch', '{"mode":"switch"}'); },
    }, '⇄ Switch outfits'));

    row.append(h('button', {
      class: 'ghost-btn' + (state.preview ? ' on' : ''), type: 'button',
      'aria-pressed': state.preview ? 'true' : 'false',
      title: state.preview
        ? 'Preview mode is ON — filling a set strips her and hands you HER inventory. Click for the chest instead.'
        : 'Preview mode is OFF — filling a set opens a hidden chest. Click to dress her body instead.',
      onclick: (e) => {
        e.stopPropagation();
        toGame('nfPreview', JSON.stringify({ on: !state.preview }));
      },
    }, (state.preview ? '◉' : '○') + ' Preview mode'));

    row.append(h('button', {
      class: 'ghost-btn', type: 'button',
      title: 'Open NFF’s shared player chest — where cleared outfits and a dismissed follower’s leftovers end up',
      onclick: (e) => { e.stopPropagation(); toGame('nfChest', '{"op":"chestOpen"}'); },
    }, '🧰 Player chest'));

    row.append(h('button', {
      class: 'ghost-btn', type: 'button',
      title: 'Move that chest to a spot beside you. NFF refuses in a dungeon and '
        + 'charges a cooldown away from a town or one of your homes — it will say so.',
      onclick: (e) => { e.stopPropagation(); toGame('nfChest', '{"op":"chestPlace"}'); },
    }, '⇩ Bring the chest here'));

    return row;
  }

  /* One person's NFF facts, for the host's People row: is she claimed by NFF,
     is there a clash, which set is she wearing. Null when NFF has never heard
     of her, which the host renders as silence rather than a warning. */
  function infoFor(key) {
    const k = String(key || '').toLowerCase();
    const npc = state.npcs.find((n) => keyOf(n).toLowerCase() === k);
    if (!npc) return null;
    const m = metaFor(keyOf(npc));
    return {
      claimed: !!(m && m.claimed),
      conflict: !!npc.conflict,
      resolved: !!npc.resolved,
      slot: npc.slot,
      worn: npc.worn,
      wornLabel: (npc.worn >= 0 && npc.worn < SETS.length) ? setLabel(m, npc.worn)
        : (npc.worn === BASE_TYPE ? 'her own clothes' : ''),
      /* Added for the Followers tab's F7 quick card, which draws the three sets
         as chips of its own rather than embedding controlsFor(): it needs the
         same facts the chips here are built from. Additive on purpose — the
         host's People row reads only the keys above and is untouched. */
      name: npc.name || '',
      have: [0, 1, 2].map((t) => !!(npc.have && npc.have[t])),
      counts: [0, 1, 2].map((t) => (npc.counts ? npc.counts[t] : -1)),
      labels: [0, 1, 2].map((t) => setLabel(m, t)),
      enabled: !!state.enabled,
      nff: !!state.nff,
      wardrobeOwned: !!npc.wardrobe,
    };
  }

  /* ---- the F7 quick card's half of these same controls -------------------
   *
   * The Followers tab's LOOKING-AT card offers "wear that set now" and "open
   * her satchel" for whoever is under the crosshair. Those must fire the SAME
   * ops as the People sheet — a second nfWear/nfSatchel path would drift the
   * first time either side changes — so the implementation stays here and the
   * card owns only the buttons.
   *
   * Addressed by a RUNTIME form id because that is all the crosshair snapshot
   * carries (fdTarget sends a bare numeric id, no plugin), and nfGet's own
   * `formId` is deliberately that same runtime id — see the comment in
   * nff_outfits.cpp ExportState.
   *
   * They answer {ok,msg} instead of calling guard(): guard() opens OUR sheet on
   * a refusal, which on the Followers tab would throw a Wardrobe overlay over a
   * pane that does not own it. Same rule, said rather than acted on. */
  function keyForActor(formIdLike) {
    const want = canonFormId(formIdLike);
    if (!want) return '';
    const n = state.npcs.find((x) => canonFormId(x.formId) === want);
    return n ? keyOf(n) : '';
  }
  function npcForKey(key) {
    const k = String(key || '').toLowerCase();
    return state.npcs.find((n) => keyOf(n).toLowerCase() === k) || null;
  }
  /* The view half of the one-backend rule, as a SENTENCE. Mirrors guard(). */
  function refuse(npc, what) {
    if (!state.enabled) return { ok: false, msg: 'Deck control of NFF outfits is off' };
    const m = metaFor(keyOf(npc));
    if (m && m.claimed) return null;
    if (npc.wardrobe)
      return { ok: false, msg: 'The Wardrobe dresses her — switch her to NFF before you ' + what };
    return null;
  }
  function wearSet(key, t) {
    const npc = npcForKey(key);
    if (!npc) return { ok: false, msg: 'NFF doesn’t know her yet' };
    const no = refuse(npc, 'change her clothes');
    if (no) return no;
    const type = Number(t);
    if (type !== BASE_TYPE && !(npc.have && npc.have[type]))
      return { ok: false, msg: 'That set is empty — fill it first' };
    wear(npc, type);
    return { ok: true, msg: type === BASE_TYPE ? 'Putting her own clothes back on…'
      : 'Dressing her in ' + setLabel(metaFor(keyOf(npc)), type) + '…' };
  }
  function openChest(key, t) {
    const npc = npcForKey(key);
    if (!npc) return { ok: false, msg: 'NFF doesn’t know her yet' };
    const no = refuse(npc, 'give her an outfit');
    if (no) return no;
    build(npc, Number(t));
    return { ok: true, msg: '' };
  }
  function openSatchel(key) {
    const npc = npcForKey(key);
    if (!npc) return { ok: false, msg: 'NFF doesn’t know her yet' };
    if (npc.slot < 0)
      return { ok: false, msg: 'She has no NFF storage slot — give her an outfit first' };
    toGame('nfSatchel', req(npc, {}));
    return { ok: true, msg: 'Opening her satchel…' };
  }

  /* Hand her to NFF / release her. The C++ Claim op is the ONE place the two
     backends touch: claiming clears her Wardrobe assignment and untracks her
     from SOES in the same breath, so exactly one system holds her. */
  function setClaim(key, on) {
    const k = String(key || '').toLowerCase();
    const npc = state.npcs.find((n) => keyOf(n).toLowerCase() === k);
    if (!npc) return false;
    toGame('nfClaim', req(npc, { on: !!on }));
    return true;
  }

  /* Inject a named wardrobe outfit into one of her sets — the same nfCopy the
     old tab's combo used, callable from the host's chevron picker. */
  function copyOutfit(key, t, outfitName) {
    const k = String(key || '').toLowerCase();
    const npc = state.npcs.find((n) => keyOf(n).toLowerCase() === k);
    if (!npc || !outfitName) return false;
    if (!guard(npc, 'change her clothes')) return false;
    toGame('nfCopy', req(npc, { type: t, outfit: outfitName }));
    return true;
  }

  function refreshData() { toGame('nfGet', ''); }

  /* One of the three sets. Clicking WEARS it — the thing you want almost every
   * time; everything else lives in the sheet. */
  function setChip(npc, m, t, q) {
    const have = !!(npc.have && npc.have[t]);
    const count = npc.counts ? npc.counts[t] : -1;
    const worn = npc.worn === t;
    const icon = m && m.sets && m.sets[t] ? iconSrc(m.sets[t].icon) : '';

    const title = have
      ? (worn ? 'She is wearing this now' : 'Put this on her now') + ' — ' + SETS[t].hint +
        (count >= 0 ? ' · ' + count + ' piece' + (count === 1 ? '' : 's') : '')
      : 'No ' + SETS[t].name + ' outfit yet — open her to make one';

    const kids = [];
    if (icon) {
      kids.push(h('img', { class: 'nf-chip-ic', src: icon, alt: '', draggable: 'false' }));
    } else {
      kids.push(h('span', {
        class: 'nf-chip-dot', 'aria-hidden': 'true',
        style: 'background:' + hueCss(SETS[t].hue, have ? 55 : 12, have ? 46 : 72),
      }));
    }
    kids.push(h('span', { class: 'nf-chip-n' }, markNodes(setLabel(m, t), q)));
    if (have && count > 0) kids.push(h('span', { class: 'nf-chip-c' }, String(count)));
    if (worn) kids.push(h('span', { class: 'nf-chip-w', 'aria-hidden': 'true' }, '●'));

    return h('button', {
      class: 'nf-chip' + (have ? '' : ' off') + (worn ? ' worn' : ''),
      type: 'button', title: title, 'aria-current': worn ? 'true' : null,
      onclick: (e) => {
        e.stopPropagation();
        if (!have) { openSheet(npc); return; }
        wear(npc, t);
      },
    }, kids);
  }

  /* ========================================================== overlays == */
  /* Our own, not the host's #wd-sheet / #wd-picker: borrowing those would mean
   * teaching the host to defer to us on every dialog path. These are children
   * of #wd-pane, so the host's snapshotUi()/restoreUi() sweep (which queries
   * the whole pane for [data-k]) still restores our caret and in-flight text. */

  function ensureOverlays(pane) {
    if (els.sheet || !pane) return;
    els.sheet = h('div', {
      class: 'nf-ov hidden', id: 'nf-sheet', role: 'dialog', 'aria-modal': 'true',
      'aria-label': 'Outfits for this follower',
      onclick: (e) => { if (e.target === els.sheet) closeSheet(); },
    }, h('div', { class: 'nf-ov-card' },
      h('header', { class: 'nf-ov-head' },
        h('h2', { id: 'nf-sheet-name' }, ''),
        h('span', { id: 'nf-sheet-sub', class: 'nf-hint' }, ''),
        h('button', { class: 'ghost-btn', type: 'button', title: 'Done (Esc)', onclick: closeSheet }, 'Done')),
      h('div', { class: 'nf-ov-body', id: 'nf-sheet-body' })));

    els.picker = h('div', {
      class: 'nf-ov hidden', id: 'nf-picker', role: 'dialog', 'aria-modal': 'true',
      'aria-label': 'Choose an icon',
      onclick: (e) => { if (e.target === els.picker) closePicker(); },
    }, h('div', { class: 'nf-ov-card narrow' },
      h('header', { class: 'nf-ov-head' },
        h('h2', null, 'Icon'),
        h('span', { id: 'nf-picker-sub', class: 'nf-hint' }, ''),
        h('button', { class: 'ghost-btn', type: 'button', title: 'Done (Esc)', onclick: closePicker }, 'Done')),
      h('div', { class: 'nf-ov-body', id: 'nf-picker-body' })));

    pane.append(els.sheet, els.picker);
    els.sheetBody = els.sheet.querySelector('#nf-sheet-body');
    els.sheetName = els.sheet.querySelector('#nf-sheet-name');
    els.sheetSub = els.sheet.querySelector('#nf-sheet-sub');
    els.pickerBody = els.picker.querySelector('#nf-picker-body');
    els.pickerSub = els.picker.querySelector('#nf-picker-sub');
  }

  function renderOverlays() {
    if (!els.sheet) return;
    renderSheet();
    renderPicker();
  }

  function openSheet(npc) {
    ui.sheetKey = keyOf(npc);
    ui.armed = null;
    ui.sheetScroll = 0;
    state.pieces = null;
    /* Re-ask for her gear on every open: it is faction state on a live actor,
       so NFF's own MCM (or a script) can have changed it since we last looked.
       Keeping the previous answer is what would make the pills quietly stale. */
    delete state.gearAsked[keyOf(npc)];
    rerender();
  }
  /* ------------------------------------------------------- focus a person --
   * The host's entry point: the SOES NPC tab's "◇ NFF outfits" quick action
   * switches to this sub-tab and then calls this, so the jump lands ON the
   * person you right-clicked instead of on an unfiltered roster you have to
   * search again.
   *
   * `who` is { formId, plugin, name } — the SAME identity the whole Wardrobe
   * tab keys on, so no name matching is involved. Three real cases:
   *   - we already hold her  -> open her sheet
   *   - nfGet has not answered yet -> remember it; nfOpen applies it
   *   - she is genuinely not on NFF's roster -> say so, and stay put
   * `onlyNff` is cleared when it is the ONLY reason she would be off screen —
   * landing on a tab that does not show the person you asked for is worse than
   * quietly widening a filter. */
  function focusNpc(who) {
    const key = (String((who && who.formId) || '') + '|' + String((who && who.plugin) || '')).toLowerCase();
    const name = String((who && who.name) || 'They');
    if (ui.loading) { ui.pendingFocus = { key: key, name: name }; return; }
    ui.pendingFocus = { key: key, name: name };
    applyPendingFocus();
  }

  function applyPendingFocus() {
    const want = ui.pendingFocus;
    if (!want) return;
    /* Exact key first, then a CANONICALISED compare. Both rosters are built
     * from the same Follower Organizer JSON, so the keys normally match byte
     * for byte — but a form id genuinely reaches this view spelled several
     * ways ("0x0001A6A1", "0x1a6a1", "1A6A1"): FO's own JSON, wardrobe.cpp's
     * HexOf, nff_outfits.cpp's row, a hand-edited config. followers-pane.js
     * hit this and grew canonFormId() for exactly this reason, and the C++
     * lowercases every one of these comparisons (Lower(ActorKey(…))).
     * A raw string compare that misses turns the jump into a confident lie —
     * "she isn't on NFF's roster" about someone who is right there — so match
     * the way the rest of the deck already does. */
    const npc = npcByKey(want.key) || npcByCanonKey(want.key) || null;
    if (!npc) {
      ui.pendingFocus = null;
      toast(want.name + ' isn’t on NFF’s roster — she has to be an NFF follower first.');
      return;
    }
    ui.pendingFocus = null;
    if (ui.onlyNff && npc.slot < 0) ui.onlyNff = false;
    ui.limit = PAGE;
    openSheet(npc);
  }

  function closeSheet() {
    if (!ui.sheetKey) return;
    ui.sheetKey = null; ui.armed = null; state.pieces = null;
    clearTimeout(comboTimer);
    ui.combo = null;
    rerender();
  }

  function renderSheet() {
    const open = !!ui.sheetKey;
    els.sheet.classList.toggle('hidden', !open);
    if (!open) { els.sheetBody.textContent = ''; return; }
    const npc = npcByKey(ui.sheetKey);
    if (!npc) { ui.sheetKey = null; els.sheet.classList.add('hidden'); return; }
    const m = ensureMeta(npc);

    /* Keep the reading position across the rebuild that every edit triggers. */
    const keep = els.sheetBody.scrollTop || ui.sheetScroll;
    const head = els.sheet.querySelector('.nf-ov-head');
    const oldFace = head.querySelector('.nf-face');
    if (oldFace) oldFace.remove();
    head.insertBefore(faceEl(npc), head.firstChild);
    els.sheetName.textContent = npc.name || '(unnamed)';
    els.sheetSub.textContent = npc.slot >= 0
      ? 'NFF slot #' + (npc.slot + 1) + (npc.worn >= 0 ? ' · wearing ' + setTypeName(npc.worn) : '')
      : 'NFF holds no outfits for her yet';

    els.sheetBody.textContent = '';
    els.sheetBody.append(ownerBlock(npc, m));
    SETS.forEach((s) => els.sheetBody.append(setBlock(npc, m, s.t)));
    els.sheetBody.append(gearBlock(npc));
    els.sheetBody.append(noteBlock(npc, m));
    if (npc.slot >= 0) els.sheetBody.append(dropBlock(npc));
    els.sheetBody.scrollTop = keep;
    ui.sheetScroll = keep;
  }

  function ownerBlock(npc, m) {
    const claimed = !!m.claimed;
    const line = npc.conflict
      ? h('span', { class: 'nf-hint bad' },
        'Both systems hold her right now. SOES blocks NFF’s pieces, so she is wearing what ' +
        'SOES decided — and re-dressing on every load door.')
      : h('span', { class: 'nf-hint' },
        claimed ? 'NFF dresses her. The Wardrobe leaves her alone.'
          : (npc.wardrobe
            ? 'The Wardrobe (SOES) dresses her. Hand her over to use NFF outfits instead.'
            : 'Nothing is claiming her. Either backend can take her.'));

    return h('div', { class: 'nf-block' + (npc.conflict ? ' danger' : '') },
      h('span', { class: 'nf-k' }, 'Who dresses her'),
      line,
      h('div', { class: 'nf-seg' },
        h('button', {
          type: 'button', class: claimed ? 'on' : '',
          title: 'Hand her to NFF — clears her Wardrobe assignment and untracks her from SOES, so they cannot fight',
          onclick: () => claim(npc, true),
        }, '⇄ NFF dresses her'),
        h('button', {
          type: 'button', class: claimed ? '' : 'on',
          title: 'Release the claim. Leaves both systems exactly as they are.',
          onclick: () => claim(npc, false),
        }, 'Leave it to the Wardrobe')));
  }

  /* ------------------------------------- the Wardrobe -> NFF combobox -- */
  /* The bridge between the two backends, and the ONLY place they meet. It
   * copies a SOES outfit's PIECES into an NFF chest — items only. She is not
   * tracked in SOES, her Wardrobe assignment is untouched, and NFF still
   * dresses her afterwards, which is what keeps the one-actor-one-backend rule
   * intact. The header says so, because "apply a Wardrobe outfit" is exactly
   * the phrase that would otherwise read as "hand her to the Wardrobe".
   *
   * A searchable combobox, not a <select>: the catalogue only grows, and a bare
   * dropdown past ~10 entries is unusable. Filter-as-you-type (debounced),
   * <mark>ed matches, ArrowUp/Down + Enter, Esc to close. */

  function comboMatches() {
    const q = lc(ui.combo ? ui.combo.q : '');
    return soesOutfits.filter((o) => !q || lc(o.name).indexOf(q) !== -1);
  }

  function openCombo(key, t) {
    /* Case-folded at the door: every comparison downstream is against keyOf(),
       which is canonical/lowercase — a caller's raw spelling must not decide
       whether the options render. */
    ui.combo = { key: String(key || '').toLowerCase(), type: t, q: '', sel: 0 };
    rerender();
    /* Focus after the rebuild, and select nothing — the caret sits in an empty
       field so the first keystroke filters instead of replacing a selection. */
    setTimeout(() => {
      const el = document.getElementById('nf-combo-q');
      if (el) el.focus();
    }, 20);
  }
  function closeCombo() {
    if (!ui.combo) return;
    clearTimeout(comboTimer);
    ui.combo = null;
    rerender();
  }

  function comboApply(npc, t, name) {
    if (!name) return;
    if (!guard(npc, 'change her clothes')) return;
    closeCombo();
    toGame('nfCopy', req(npc, { type: t, outfit: name }));
  }

  function comboKey(e, npc) {
    if (!ui.combo) return;
    const rows = comboMatches();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      ui.combo.sel = (ui.combo.sel + d + rows.length) % rows.length;
      rerender();
      setTimeout(() => {
        const el = document.getElementById('nf-combo-q');
        if (el) el.focus();
        const opt = document.querySelector('.nf-combo-opt.sel');
        if (opt && opt.scrollIntoView) opt.scrollIntoView({ block: 'nearest' });
      }, 0);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = rows[ui.combo.sel];
      if (pick) comboApply(npc, ui.combo.type, pick.name);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCombo(); }
  }

  function comboEl(npc, t) {
    const c = ui.combo;
    const rows = comboMatches();
    if (c.sel >= rows.length) c.sel = 0;

    const list = h('div', { class: 'nf-combo-list', role: 'listbox', id: 'nf-combo-list' });
    if (!soesOutfits.length) {
      list.append(h('div', { class: 'nf-hint' },
        'The Wardrobe has no outfits yet — or SOES has not exported since this save loaded. ' +
        'Open the Outfits sub-tab once and give it a moment.'));
    } else if (!rows.length) {
      list.append(h('div', { class: 'nf-hint' }, 'No outfit matches “' + c.q + '”.'));
    } else {
      rows.forEach((o, i) => {
        list.append(h('button', {
          class: 'nf-combo-opt' + (i === c.sel ? ' sel' : ''), type: 'button',
          role: 'option', 'aria-selected': i === c.sel ? 'true' : 'false',
          onmousemove: () => { if (c.sel !== i) { c.sel = i; rerender(); } },
          onclick: (e) => { e.stopPropagation(); comboApply(npc, t, o.name); },
        },
        h('span', { class: 'nf-combo-n' }, markNodes(o.name, lc(c.q))),
        h('span', { class: 'nf-combo-c' },
          typeof o.items === 'number' ? o.items + (o.items === 1 ? ' piece' : ' pieces') : '')));
      });
    }

    return h('div', { class: 'nf-combo', onclick: (e) => e.stopPropagation() },
      h('div', { class: 'nf-hint' },
        'Copies that outfit’s CLOTHES into her ' + SETS[t].name + ' chest. ' +
        'NFF keeps dressing her — nothing is handed to the Wardrobe.'),
      h('input', {
        id: 'nf-combo-q', class: 'nf-in', type: 'text', value: c.q,
        placeholder: 'Type to find an outfit…', spellcheck: 'false',
        autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true',
        'aria-controls': 'nf-combo-list', 'data-k': 'nf-comboq',
        oninput: (e) => {
          const v = e.target.value;
          clearTimeout(comboTimer);
          /* Debounced: the catalogue is small today but this is the pattern
             every deck search uses, and re-rendering per keystroke on a paused
             UI reads as lag. */
          comboTimer = setTimeout(() => { c.q = v; c.sel = 0; rerender();
            setTimeout(() => { const el = document.getElementById('nf-combo-q'); if (el) el.focus(); }, 0);
          }, 120);
        },
        onkeydown: (e) => comboKey(e, npc),
      }),
      list,
      h('button', { class: 'ghost-btn', type: 'button', onclick: (e) => { e.stopPropagation(); closeCombo(); } }, 'Cancel'));
  }

  function setBlock(npc, m, t) {
    const k = keyOf(npc);
    const have = !!(npc.have && npc.have[t]);
    const count = npc.counts ? npc.counts[t] : -1;
    const worn = npc.worn === t;
    const s = m.sets[t];
    const icon = iconSrc(s.icon);

    const thumb = h('button', {
      class: 'nf-thumb' + (icon ? '' : ' empty'), type: 'button',
      title: icon ? 'Change this outfit’s icon' : 'Give this outfit an icon',
      onclick: () => openPicker(k, t),
    }, icon ? h('img', { src: icon, alt: '', draggable: 'false' }) : '＋');

    const countLine = h('span', { class: 'nf-hint' },
      (!have ? 'Empty'
        : (count < 0 ? 'Contents unreadable right now'
          : count + ' piece' + (count === 1 ? '' : 's'))) + ' · ' + SETS[t].hint + '.');

    const acts = h('div', { class: 'nf-acts' },
      h('button', {
        class: 'ghost-btn', type: 'button', disabled: have ? null : 'disabled',
        title: have ? 'Put it on her now' : 'Nothing in it yet',
        onclick: () => wear(npc, t),
      }, worn ? '● Worn' : 'Wear now'),
      h('button', {
        class: 'ghost-btn', type: 'button',
        title: 'Opens NFF’s own chest for this outfit — drop clothes in, close it, done. ' +
          'The palette closes first, because NFF answers with a container menu.',
        onclick: () => build(npc, t),
      }, have ? 'Change what’s in it…' : 'Fill it…'),
      h('button', {
        class: 'ghost-btn', type: 'button', disabled: have ? null : 'disabled',
        onclick: () => pieces(npc, t),
      }, 'See the pieces'),
      have ? armedBtn('clr:' + k + ':' + t, 'Clear', 'Really clear — click again', () => clear(npc, t)) : null,
      h('button', {
        class: 'ghost-btn', type: 'button', disabled: have ? null : 'disabled',
        title: have
          ? 'Fill this outfit from one you built in the Wardrobe. Clothes only — NFF still dresses her.'
          : 'Make the outfit first (Fill it…) — NFF has to know a set exists before anything can go in it',
        onclick: () => openCombo(k, t),
      }, '\u21c4 From a Wardrobe outfit\u2026'));

    const comboOpen = ui.combo && ui.combo.key === k && ui.combo.type === t;
    const opened = state.pieces && state.pieces.key === k && state.pieces.type === t;

    return h('div', { class: 'nf-block set' + (worn ? ' worn' : '') },
      h('div', { class: 'nf-set-head' },
        thumb,
        h('div', { class: 'nf-set-id' },
          h('input', {
            class: 'nf-in name', type: 'text', value: s.label || '', placeholder: SETS[t].name,
            maxlength: '60', spellcheck: 'false', 'data-k': 'nf-label:' + k + ':' + t,
            title: 'What you call this outfit. Blank falls back to “' + SETS[t].name + '”.',
            onchange: (e) => { s.label = e.target.value.trim(); touch(); },
          }),
          countLine),
        h('span', { class: 'nf-set-tag', style: 'color:' + hueCss(SETS[t].hue, 45, 40) }, SETS[t].name)),
      h('input', {
        class: 'nf-in', type: 'text', value: s.note || '', placeholder: 'Note (optional)',
        maxlength: '300', spellcheck: 'false', 'data-k': 'nf-snote:' + k + ':' + t,
        onchange: (e) => { s.note = e.target.value.trim(); touch(); },
      }),
      acts,
      comboOpen ? comboEl(npc, t) : null,
      opened ? piecesList(state.pieces) : null);
  }

  function piecesList(p) {
    if (p.loading) return h('div', { class: 'nf-hint' }, 'Reading the chest…');
    if (p.error) return h('div', { class: 'nf-hint bad' }, p.error);
    if (!p.items.length) return h('div', { class: 'nf-hint' }, 'The chest is empty.');
    return h('ul', { class: 'nf-pieces' }, p.items.map((it) => h('li', null,
      h('span', { class: 'nf-piece-n' }, it.name),
      it.count > 1 ? h('span', { class: 'nf-piece-c' }, '×' + it.count) : null,
      h('span', { class: 'nf-piece-p' }, it.plugin || ''))));
  }

  function noteBlock(npc, m) {
    return h('div', { class: 'nf-block' },
      h('span', { class: 'nf-k' }, 'Note'),
      h('input', {
        class: 'nf-in', type: 'text', value: m.note || '', maxlength: '300', spellcheck: 'false',
        placeholder: 'Anything worth remembering about how she dresses',
        'data-k': 'nf-note:' + keyOf(npc),
        onchange: (e) => { m.note = e.target.value.trim(); touch(); },
      }),
      npc.slot >= 0 ? h('button', {
        class: 'ghost-btn', type: 'button',
        title: 'NFF stows her own gear in a satchel while one of its outfits is on',
        onclick: () => toGame('nfSatchel', req(npc, {})),
      }, 'Open her satchel') : null);
  }

  /* ------------------------------------------------------- combat gear -- *
   * NFF's four per-follower gear switches — the "helmet only in combat" Rober
   * asked for, and its three siblings. They are FACTION state on the actor
   * (nwsFF_HelmFac and co.), not properties, which is why the deck can READ
   * them straight off the engine and must WRITE them through the Papyrus
   * executor: rank is what encodes helmet's third state, and AddToFaction on a
   * live actor is NFF's own route.
   *
   * Deliberately NOT behind guard(): these dress nobody. A follower SOES is
   * tracking has a head too, and refusing here would make the most-asked-for
   * control unavailable on exactly the people the Wardrobe tab manages.
   *
   * `known:false` (NFF's variable quest unbound — no save loaded, or NFF
   * absent) renders as an honest "—" and disabled controls. Four confident
   * OFFs for state we never read is how a UI starts lying, and helmet is the
   * one you would then click twice trying to make it stick. */

  const HELM_STATES = [
    { v: 'off', op: 'helmOff', label: 'As she likes',
      hint: 'NFF leaves her headwear alone' },
    { v: 'combat', op: 'helmCombat', label: 'Only in combat',
      hint: 'Helmet goes on when she fights and comes off afterwards' },
    { v: 'never', op: 'helmNever', label: 'Never',
      hint: 'She never wears a helmet, even in a fight' },
  ];
  const GEAR_TOGGLES = [
    { k: 'shield', on: 'shieldOn', off: 'shieldOff', label: 'Shield only in combat',
      hint: 'She slings her shield when there is nothing to fight' },
    { k: 'weapon', on: 'weaponOn', off: 'weaponOff', label: 'Weapons follow yours',
      hint: 'She draws when you draw and sheathes when you sheathe' },
    { k: 'ammo', on: 'ammoOn', off: 'ammoOff', label: 'Arrows away out of combat',
      hint: 'Unnocks her arrows when the fight is over' },
  ];

  function gearFor(npc) { return state.gear[keyOf(npc)] || null; }

  /* Ask once per person per open. The read is cheap engine work, but a request
     per render would fire on every keystroke in the note field. */
  function askGear(npc) {
    const key = keyOf(npc);
    if (state.gearAsked[key]) return;
    state.gearAsked[key] = true;
    toGame('nfGear', JSON.stringify({ formId: npc.formId, plugin: npc.plugin }));
  }

  function setGear(npc, op) {
    toGame('nfSetGear', JSON.stringify({ formId: npc.formId, plugin: npc.plugin, op: op }));
    /* C++ re-reads after the executor has had its beat and pushes nfGearState,
       so the control springs back if the Papyrus hop never landed rather than
       showing a state nobody applied. */
    return { ok: true, msg: '' };
  }

  function gearBlock(npc) {
    askGear(npc);
    const g = gearFor(npc);
    const known = !!(g && g.known);
    const helm = (g && g.helm) || 'off';

    const helmRow = h('div', { class: 'nf-gear-row' },
      h('span', { class: 'nf-gear-k', title: 'When NFF should put her helmet on' }, 'Helmet'));
    HELM_STATES.forEach((st) => {
      helmRow.append(h('button', {
        class: 'nf-gear-pill' + (known && helm === st.v ? ' on' : ''),
        type: 'button', disabled: known ? null : 'disabled',
        'aria-pressed': known && helm === st.v ? 'true' : 'false',
        title: known ? st.hint : 'NFF is not answering yet — open the tab with a save loaded',
        onclick: (e) => { e.stopPropagation(); if (known && helm !== st.v) setGear(npc, st.op); },
      }, st.label));
    });

    const block = h('div', { class: 'nf-block' },
      h('span', { class: 'nf-k' }, 'Combat gear'),
      h('span', { class: 'nf-hint' }, known
        ? 'What she puts on and takes off around a fight.'
        : '— NFF has not answered yet; these need a loaded save.'),
      helmRow);

    GEAR_TOGGLES.forEach((t) => {
      const on = !!(g && g[t.k]);
      block.append(h('div', { class: 'nf-gear-row' },
        h('span', { class: 'nf-gear-k', title: t.hint }, t.label),
        h('button', {
          class: 'nf-gear-pill' + (known && on ? ' on' : ''),
          type: 'button', disabled: known ? null : 'disabled',
          'aria-pressed': known && on ? 'true' : 'false',
          title: known ? (on ? 'Turn off — ' : 'Turn on — ') + t.hint
            : 'NFF is not answering yet — open the tab with a save loaded',
          onclick: (e) => { e.stopPropagation(); if (known) setGear(npc, on ? t.off : t.on); },
        }, known ? (on ? 'On' : 'Off') : '—')));
    });
    return block;
  }

  function dropBlock(npc) {
    return h('div', { class: 'nf-block danger' },
      h('span', { class: 'nf-k' }, 'Stop NFF dressing her'),
      h('span', { class: 'nf-hint' },
        'Clears all three outfits, gives her own clothes back and frees her storage slot.'),
      armedBtn('drop:' + keyOf(npc), 'Drop from NFF', 'Really drop — click again',
        () => { clear(npc, BASE_TYPE); closeSheet(); }));
  }

  /* An armed two-click destructive button — PrismaUI has no window.confirm, and
   * every other deck pane already works this way. Disarms after 4 s, on Esc, or
   * when something else arms. */
  function armedBtn(key, label, armedLabel, run) {
    const isArmed = ui.armed === key;
    return h('button', {
      class: 'ghost-btn danger' + (isArmed ? ' armed' : ''), type: 'button',
      onclick: (e) => {
        e.stopPropagation();
        if (isArmed) { ui.armed = null; run(); return; }
        ui.armed = key;
        rerender();
        setTimeout(() => { if (ui.armed === key) { ui.armed = null; rerender(); } }, 4000);
      },
    }, isArmed ? armedLabel : label);
  }

  /* --------------------------------------------------------- icon picker -- */

  function openPicker(key, type) {
    ui.picker = { key: key, type: type };
    ui.pickFilter = '';
    ui.pickShown = ICON_PAGE;
    rerender();
  }
  function closePicker() {
    if (!ui.picker) return;
    ui.picker = null;
    rerender();
  }

  function pickIcon(path) {
    if (!ui.picker) return;
    const npc = npcByKey(ui.picker.key);
    if (npc) ensureMeta(npc).sets[ui.picker.type].icon = path || '';
    ui.picker = null;
    touch();
  }

  const iconMatches = (q) => (c) => !q ||
    lc(c.label).indexOf(q) !== -1 || lc(c.file).indexOf(q) !== -1 || lc(c.atlas || '').indexOf(q) !== -1;

  function renderPicker() {
    const open = !!ui.picker;
    els.picker.classList.toggle('hidden', !open);
    if (!open) { els.pickerBody.textContent = ''; return; }

    const q = lc(ui.pickFilter);
    const npc = npcByKey(ui.picker.key);
    const m = npc ? ensureMeta(npc) : null;
    const cur = m ? iconSrc(m.sets[ui.picker.type].icon) : '';

    els.pickerSub.textContent = (npc ? npc.name + ' · ' : '') + SETS[ui.picker.type].name;

    const grid = h('div', { class: 'nf-icons' });
    grid.append(h('button', {
      class: 'nf-icon none' + (cur ? '' : ' on'), type: 'button', title: 'No icon',
      onclick: () => pickIcon(''),
    }, 'None'));

    /* Yours first, then the library — the same order the Spell Deck's picker
     * uses, and chunked for the same reason: opening it must not decode ~1,900
     * images at once. */
    const all = state.icons.custom.filter(iconMatches(q))
      .concat(state.icons.catalog.filter(iconMatches(q)));
    const shown = Math.min(all.length, ui.pickShown);
    for (let i = 0; i < shown; i++) {
      const c = all[i];
      grid.append(h('button', {
        class: 'nf-icon' + (cur === c.file ? ' on' : ''), type: 'button', title: c.label || c.file,
        onclick: () => pickIcon(c.file),
      }, h('img', { src: iconSrc(c.file), alt: '', draggable: 'false' })));
    }

    els.pickerBody.textContent = '';
    els.pickerBody.append(
      h('div', { class: 'nf-picker-top' },
        h('input', {
          class: 'nf-in', type: 'text', value: ui.pickFilter, placeholder: 'Filter icons…',
          spellcheck: 'false', 'data-k': 'nf-pickq',
          oninput: (e) => { ui.pickFilter = e.target.value; ui.pickShown = ICON_PAGE; rerender(); },
        }),
        h('button', {
          class: 'ghost-btn', type: 'button',
          title: 'Re-scan the icon folders — picks up anything you just dropped in',
          onclick: () => { toGame('hdIconList', ''); toast('Re-scanning icons…'); },
        }, '⟳ Refresh'),
        h('span', { class: 'nf-hint' },
          state.icons.custom.length + ' yours · ' + state.icons.catalog.length + ' library' +
          (all.length > shown ? ' · showing ' + shown : ''))),
      grid,
      all.length > shown ? h('button', {
        class: 'wd-more', type: 'button',
        onclick: () => { ui.pickShown += ICON_PAGE; rerender(); },
      }, 'Show ' + Math.min(all.length - shown, ICON_PAGE) + ' more — ' +
         (all.length - shown) + ' still hidden') : null);
  }

  /* ============================================================ actions == */

  const req = (npc, extra) =>
    JSON.stringify(Object.assign({ formId: npc.formId, plugin: npc.plugin }, extra || {}));

  function wear(npc, t) {
    if (!guard(npc, 'change her clothes')) return;
    toGame('nfWear', req(npc, { type: t }));
    /* Optimistic, and corrected by the next nfOpen. Without it the chip does not
     * move until the round trip lands, and the click reads as ignored. */
    npc.worn = t;
    rerender();
  }

  function build(npc, t) {
    if (!guard(npc, 'give her an outfit')) return;
    toGame('nfBuild', req(npc, { type: t }));
  }

  function clear(npc, t) { toGame('nfClear', req(npc, { type: t })); }

  function pieces(npc, t) {
    state.pieces = { key: keyOf(npc), type: t, items: [], loading: true };
    toGame('nfPieces', req(npc, { type: t }));
    rerender();
  }

  function claim(npc, on) { toGame('nfClaim', req(npc, { on: !!on })); }

  /* The view half of the one-backend rule. C++ enforces it too — the portal
   * never reaches this code — but catching it here means the message explains
   * the fix instead of reporting the failure. */
  function guard(npc, what) {
    if (!state.enabled) { toast('Deck control of NFF outfits is off'); return false; }
    const m = metaFor(keyOf(npc));
    if (m && m.claimed) return true;
    if (npc.wardrobe) {
      toast('The Wardrobe dresses her — hand her to NFF (⇄) before you ' + what);
      openSheet(npc);
      return false;
    }
    return true;
  }

  /* ========================================================== C++ -> us == */

  function receive(fn, payload) {
    try {
      const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      if (fn === 'nfOpen') {
        state.enabled = j.enabled !== false;
        state.preview = !!j.preview;
        state.nff = !!j.nff;
        state.slotsUsed = j.slotsUsed || 0;
        state.slotsMax = j.slotsMax || 128;
        state.npcs = Array.isArray(j.npcs) ? j.npcs : [];
        state.conflicts = Array.isArray(j.conflicts) ? j.conflicts : [];
        /* Rebuild the editable mirror from the authoritative rows, so a rename
         * in Follower Organizer or an edit made on the phone shows up without a
         * reload. Only people who actually carry metadata get a row — the config
         * must not grow one entry per follower just by being looked at. */
        state.meta = state.npcs
          .filter((n) => n.meta && n.meta.sets)
          .map((n) => ({
            formId: n.formId, plugin: n.plugin, name: n.name || '',
            sets: n.meta.sets.length === SETS.length
              ? n.meta.sets.map((s) => ({ label: s.label || '', icon: s.icon || '', note: s.note || '' }))
              : blankSets(),
            note: n.meta.note || '', claimed: !!n.meta.claimed,
          }));
        ui.loading = false;
        /* A jump from another tab may have arrived before this roster did —
         * honour it now that we can actually find the person. */
        applyPendingFocus();
        rerender();
        /* Fresh facts belong to whoever is LOOKING. The tab this rerender()
           painted is retired; the People rows/sheet and the F7 quick card are
           the live consumers now, and neither owns our receiver. Notify,
           guarded, so the harness (no host) stays standalone. */
        if (window.WardrobePane && typeof window.WardrobePane.nffDataChanged === 'function')
          window.WardrobePane.nffDataChanged();
        return true;
      }
      if (fn === 'nfResult') {
        if (j.msg) toast(j.msg);
        /* Every nf op mutates state the view holds (claimed flags, set counts,
           what she is wearing, the assignment a claim just cleared) — and the
           reply itself carries none of it. Re-pull. Without this, "handing X
           to NFF" showed nothing until the deck was closed and reopened
           (Rober, 2026-08-03): the People sheet kept painting the pre-claim
           snapshot. One nfGet per op is cheap; being visibly wrong is not. */
        refreshData();
        return true;
      }
      if (fn === 'nfGearState') {
        /* Keyed the same way keyOf() spells it, so a reply can actually find
           the row that asked (the pieces drawer was bitten by exactly this
           when keyOf went canonical/lowercase, 2026-08-03). */
        const gkey = (String(j.formId || '') + '|' + String(j.plugin || '')).toLowerCase();
        state.gear[gkey] = j;
        rerender();
        return true;
      }
      if (fn === 'nfPieceList') {
        // Same spelling keyOf() produces, or the pieces drawer compares its own
        // reply against a key that can never match (bit exactly this way when
        // keyOf went canonical/lowercase, 2026-08-03).
        const key = (String(j.formId || '') + '|' + String(j.plugin || '')).toLowerCase();
        state.pieces = j.ok
          ? { key: key, type: j.type, items: j.items || [] }
          : { key: key, type: j.type, items: [], error: j.msg || 'Could not read it' };
        rerender();
        return true;
      }
    } catch (e) {
      console.log('[nff] receive error', fn, e);
      toGame('nfLog', 'nff receive error ' + fn + ' ' + e);
    }
    return false;
  }

  /* Chain app.js's icon globals rather than duplicate the C++ enumeration —
   * the same pattern the Wardrobe pane uses for window.hdClosed. This file
   * loads after app.js, so the previous handler always exists in the game; the
   * typeof guard is for the standalone harness, where it does not. */
  function chainIcons() {
    const prevIdx = window.hdIconIndex;
    window.hdIconIndex = function (idx) {
      try {
        const o = typeof idx === 'string' ? JSON.parse(idx) : (idx || {});
        state.icons.catalog = (Array.isArray(o.catalog) ? o.catalog : []).map((c) => ({
          file: String(c.file || '').replace(/\\/g, '/'), label: c.label || '', atlas: c.atlas || '',
        })).filter((c) => c.file);
        if (ui.picker) rerender();
      } catch (e) { /* app.js logs its own parse failures */ }
      if (typeof prevIdx === 'function') return prevIdx.apply(this, arguments);
      return undefined;
    };
    const prevIcons = window.hdIcons;
    window.hdIcons = function (r) {
      try {
        const o = typeof r === 'string' ? JSON.parse(r) : (r || {});
        state.icons.custom = ((o && o.custom) || []).map((c) => ({
          file: String(c.file || '').replace(/\\/g, '/'), label: c.label || '',
        })).filter((c) => c.file);
        if (ui.picker) rerender();
      } catch (e) { /* as above */ }
      if (typeof prevIcons === 'function') return prevIcons.apply(this, arguments);
      return undefined;
    };
  }

  /* The Followers pane installs window.fdPortraits and window.fdTarget as plain
   * globals (C++ pushes both at palette open and on every fdRefresh, so nobody
   * asks for them). Chain rather than replace: whichever pane loads second must
   * not silently gag the first. Same pattern as chainIcons(). */
  function chainFollowerFeeds() {
    const prevP = window.fdPortraits;
    window.fdPortraits = function (list) {
      try {
        const raw = typeof list === 'string' ? JSON.parse(list) : list;
        const arr = Array.isArray(raw) ? raw
          : (raw && Array.isArray(raw.portraits) ? raw.portraits : []);
        const map = {};
        arr.forEach(function (e) {
          if (!e || !e.slug) return;
          const slug = String(e.slug).toLowerCase();
          const ext = String(e.ext || 'png').toLowerCase().replace(/^\./, '');
          /* `file` is authoritative and must not be rebuilt from slug+ext: a
             re-capture of a face the renderer already holds open lands as
             `<slug>~<n>.png`. Anything with a path separator is refused rather
             than sanitised — it names a sibling in portraits/, and a value that
             walks out of it is a bug, never a portrait. */
          const rawFile = typeof e.file === 'string' ? e.file.trim() : '';
          const file = (rawFile && !/[\\/]/.test(rawFile) && rawFile !== '.' && rawFile !== '..')
            ? rawFile : (slug + '.' + ext);
          const mt = typeof e.mtime === 'number' ? e.mtime : parseInt(e.mtime, 10);
          map[slug] = { file: file, ext: ext, mtime: (isFinite(mt) && mt > 0) ? mt : 0 };
        });
        state.portraits = map;
        if (ui.shown) rerender();
      } catch (e) { /* the Followers pane logs its own parse failures */ }
      if (typeof prevP === 'function') return prevP.apply(this, arguments);
      return undefined;
    };

    const prevT = window.fdTarget;
    window.fdTarget = function (t) {
      try {
        const o = typeof t === 'string' ? JSON.parse(t) : t;
        state.target = (o && o.name)
          ? { formId: '0x' + ((o.formId >>> 0)).toString(16).toUpperCase(), name: String(o.name) }
          : null;
        if (ui.shown) rerender();
      } catch (e) { /* as above */ }
      if (typeof prevT === 'function') return prevT.apply(this, arguments);
      return undefined;
    };
  }

  /* ============================================================== host == */

  function onEnter() { toGame('nfGet', ''); }
  function count() { return state.npcs.length; }
  function setFilter(q) { ui.filter = lc(q); }

  function init() {
    if (ui.inited) return;
    ui.inited = true;
    chainIcons();
    chainFollowerFeeds();
    window.nfOpen = (p) => receive('nfOpen', p);
    window.nfResult = (p) => receive('nfResult', p);
    window.nfPieceList = (p) => receive('nfPieceList', p);
    window.nfGearState = (p) => receive('nfGearState', p);

    /* Esc closes OUR overlays first and stops there — otherwise the same press
     * also reaches app.js and closes the whole palette, which is never what you
     * meant while an icon grid is open. Capture phase, for the same reason. */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (ui.combo) { closeCombo(); e.stopPropagation(); e.preventDefault(); return; }
      if (ui.picker) { closePicker(); e.stopPropagation(); e.preventDefault(); return; }
      if (ui.chestFor) { ui.chestFor = null; rerender(); e.stopPropagation(); e.preventDefault(); return; }
      if (ui.armed) { ui.armed = null; rerender(); e.stopPropagation(); e.preventDefault(); return; }
      if (ui.sheetKey) { closeSheet(); e.stopPropagation(); e.preventDefault(); }
    }, true);

    if (DEV) devBoot();
  }

  /* ============================================================== dev === */

  function devBoot() {
    state.nff = true;
    state.slotsUsed = 11;
    state.enabled = true;
    state.npcs = [
      { formId: '0x1A6A1', plugin: 'Skyrim.esm', name: 'Camilla Valerius', portrait: '',
        resolved: true, slot: 0, have: [true, true, false], worn: 1, counts: [7, 5, -1],
        wardrobe: false, conflict: false,
        meta: { sets: [{ label: 'Travelling leathers', icon: '', note: '' },
          { label: 'Riverwood green', icon: '', note: 'the one he likes' },
          { label: '', icon: '', note: '' }], note: '', claimed: true } },
      { formId: '0x1A6A2', plugin: 'Skyrim.esm', name: 'Ysolda', portrait: '',
        resolved: true, slot: 3, have: [true, false, true], worn: 0, counts: [4, -1, 9],
        wardrobe: true, conflict: true, meta: {} },
      { formId: '0x1A6A3', plugin: 'Skyrim.esm', name: 'Mjoll Lioness', portrait: '',
        resolved: true, slot: -1, have: [false, false, false], worn: -1, counts: [-1, -1, -1],
        wardrobe: false, conflict: false, meta: {} },
      { formId: '0x1A6A4', plugin: 'Skyrim.esm', name: 'Vex', portrait: '',
        resolved: false, slot: -1, have: [false, false, false], worn: -1, counts: [-1, -1, -1],
        wardrobe: true, conflict: false, meta: {} },
    ];
    state.conflicts = ['0x1A6A2|Skyrim.esm'];
    state.icons = {
      custom: [{ file: 'icons/custom/wheel.png', label: 'wheel' },
        { file: 'icons/custom/dev-rune.png', label: 'dev-rune' }],
      catalog: [{ file: 'icons/sh/alt/A.png', label: 'alteration', atlas: 'alt' }],
    };
    state.meta = state.npcs.filter((n) => n.meta && n.meta.sets).map((n) => ({
      formId: n.formId, plugin: n.plugin, name: n.name,
      sets: n.meta.sets.map((s) => Object.assign({ label: '', icon: '', note: '' }, s)),
      note: n.meta.note || '', claimed: !!n.meta.claimed,
    }));
    ui.loading = false;
  }

  /* ============================================================ export == */

  const api = {
    id: 'nff',
    label: 'NFF',
    /* Since the People redesign (2026-08-03) this module no longer OWNS a tab:
       the host embeds controlsFor() in the People sheet and reads infoFor() on
       the rows, so "what does she wear" lives in exactly one place. The tab
       machinery below (render/onEnter/count) is kept intact for the harness
       and for an older host that predates `hidden`. */
    /* Hidden in the game since the People redesign. `nfftab=1` (harness only)
       re-registers the old tab so its 100-check suite keeps exercising the row
       renderers this module still provides to the sheet — the host's own
       harness asserts the hidden-in-prod half. */
    hidden: location.search.indexOf('nfftab=1') === -1,
    controlsFor: controlsFor,
    infoFor: infoFor,
    setClaim: setClaim,
    copyOutfit: copyOutfit,
    refreshData: refreshData,
    /* Shared with the Followers tab's F7 quick card — see keyForActor above. */
    keyForActor: keyForActor,
    wearSet: wearSet,
    openChest: openChest,
    openSatchel: openSatchel,
    sets: SETS,
    init: init,
    onEnter: onEnter,
    count: count,
    render: render,
    setFilter: setFilter,
    /* Optional plug-in hook: the host draws its "◇ NFF outfits" affordance only
     * for a sub-tab that offers this, so an older host simply never calls it. */
    focusNpc: focusNpc,
    /* exposed for the harness */
    _state: state, _ui: ui, _sets: SETS, _els: els,
    _iconSrc: iconSrc, _matches: matches, _setLabel: setLabel, _ensureMeta: ensureMeta,
    _devBoot: devBoot, _receive: receive, _openSheet: openSheet, _closeSheet: closeSheet,
    _openPicker: openPicker, _closePicker: closePicker, _guard: guard, _keyOf: keyOf,
    _isEmptyMeta: isEmptyMeta, _slugOf: slugOf, _portraitFor: portraitFor, _faceEl: faceEl,
    _applyPendingFocus: applyPendingFocus,
    _openCombo: openCombo, _closeCombo: closeCombo, _comboMatches: comboMatches,
    _soes: () => soesOutfits, _flushSave: () => { clearTimeout(saveTimer); state.meta = state.meta.filter((m) => !isEmptyMeta(m)); },
  };

  /* Self-register. This file loads after wardrobe-pane.js, so the host's IIFE
   * has finished and registering here creates the sub-tab before init() runs. */
  if (window.WardrobePane && typeof window.WardrobePane.registerSub === 'function') {
    window.WardrobePane.registerSub(api);
  }

  return api;
})();
