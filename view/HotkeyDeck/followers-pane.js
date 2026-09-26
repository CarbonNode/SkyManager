'use strict';

/* ====================================================================== *
 *  Followers tab — the Follower Organizer front-end living INSIDE the
 *  Hotkey Deck view (ported from the standalone FollowerDeck view in
 *  v0.9.0; same fd* bridge, now registered on the deck view).
 *
 *  Contract with app.js (the deck shell):
 *    FolPane.init()            — wire pane-local listeners (once, at boot)
 *    FolPane.onShow()          — tab became visible: refresh data + chrome
 *    FolPane.onHide()          — tab left
 *    FolPane.onKey(e)          — keydown while our tab is active; return
 *                                true when consumed
 *    FolPane.syncChrome()      — own the shared header (count chip, Edit)
 *    FolPane.openKeyLabel()    — current open-key label for settings rows
 *  The deck shell owns: overlay/panel, tab bar, capture modal (our
 *  open-key rebind routes through it via startFolCapture in app.js),
 *  uiScale, pause semantics (we're a "deck"-class paused tab).
 *
 *  C++ → JS globals (invoked on the deck view): fdState(envelope) ·
 *  fdTarget(npc|null) · fdSaved(ok). JS → C++: fdApply/fdWorld/fdRefresh/
 *  fdSave/fdLog (fdClose/fdCapture retired with the standalone view).
 * ====================================================================== */

(function () {
  const state = {
    openKey: { device: 'keyboard', code: 101, label: 'F14' },  // F14 = extended F-key bridge
    cats: [],
    total: 0,
    target: null,
    /* Has C++ told us about the crosshair yet THIS open? `target: null` alone
       cannot say — it means both "nobody is targeted" and "no answer yet", and
       showing "look at an NPC first" while we simply do not know is a wrong
       message, not a slow one. Reset on hdOpen, set by the first fdTarget. */
    targetKnown: false,
    foMissing: '',
    loaded: false,   // got at least one fdState this session
    /* slug -> { file, ext, mtime }: the WINNING portrait for each follower.
       Pushed by C++ (fdPortraits) at palette open and on every fdRefresh; we
       never ask for it, so a rig with no portraits folder simply leaves this
       empty and every row keeps its initials medallion. `file` is the real
       filename and is what the <img> loads — several files can resolve to one
       slug (a re-capture the game had locked lands as `<slug>~<n>.png`) and C++
       has already picked the newest. */
    portraits: {},
    /* facegen head renders, keyed by the member's lowercased formId — the
       DEFAULT face for anyone on the roster without a captured portrait
       (Rober, 2026-08-14). Values are view-relative paths under icons/npcs/
       (the NPC finder's render pool, so both features share one PNG). Filled
       by fdFaceIconsData; empty on a rig that never renders faces. */
    faceIcons: {},
    faceWhy: {},     // formId hex -> why no head render can ever land (fdFaceIconsData.why); cleared when one does
    /* ORIGINAL name (lowercased) -> [{ group, id, cls }]: which Loadouts
       group(s) this follower is in and the class she plays in each. Filled by
       loGroupsData, asked once per onShow. Joined by `original` because that is
       the key BOTH sides file people under — a runtime FormID is not stable
       between the FO roster and loadouts.json. */
    groupsByOriginal: {},
    /* file name -> { z, x, y }: the DISPLAY crop for one portrait FILE, pushed
       by C++ as `fdCrops` on the same rail as fdPortraits. Keyed by the file and
       never by the follower, so a fresh capture (which always lands under a new
       versioned name) is drawn as shot — see the crop section below for why
       that is the load-bearing property and not a detail. */
    crops: {},
    /* Read-only facts from two mods the deck does not own, pushed by C++ as
       `fdNff` at palette open and with every fdRefresh (src/nff_bridge.cpp):
       Nether's Follower Framework's assigned home base, and My Home is Your
       Home NG's house. Keyed by the SAME formId string the FO envelope carries,
       lowercased. Both mods are soft — with neither installed `members` is
       simply empty and every row renders exactly as it did before. */
    nff: { nff: false, mhiyh: false, members: {}, bases: [] },
    /* Fertility Mode pregnancy / cycle, pushed as `fdFertility`
       (src/fertility_bridge.cpp) and keyed by the same lowercased formId. Soft
       exactly like `nff`: with FM absent `actors` is empty and no row changes.
       Only actors FM actually TRACKS appear, so a missing entry is normal. */
    fert: { available: false, actors: {} },
    /* The worn set per actor, keyed by lowercased formId (the crosshair target
       caches under ''). Filled on demand by `fdEquipped` when a member menu
       opens — never at roster load, because it is one inventory walk per actor
       and a ~70-member roster does not need 70 of them.
       Each value: { ok, who, following, dead, outfit, items:[…], at:ms }. */
    equipped: {},
    dayStatus: {},
    /* Row avatar diameter. 0 = "use the stylesheet's default" — kept as 0
       rather than 40 so the default is defined in exactly one place. */
    avatarPx: 0,
    dossierSizePct: 100,
    dossierFrames: {}, // Page-only portrait positions, keyed by the actual image file.
    /* Quick-card action labels: false = icons that name themselves on hover
       (the default), true = every label pinned open. Persisted via saveCfg. */
    fqLabels: false,
    /* Left category rail collapsed to a thin icon strip. Persisted via saveCfg. */
    railCollapsed: false,
    /* Whole-tab zoom, independent of the deck's menu scale. 1 = unset. */
    uiScale: 1,
    /* Category-icon size, as a PERCENT of the size the avatar slider derives.
       100 = ride the avatar slider exactly (the pre-slider look). Independent so
       the rail glyphs can be scaled up on their own — bigger also reads crisper
       because Ultralight aliases the 256px art less on a gentler downscale.
       Persisted via saveCfg. */
    railIconPct: 100,
    /* Category SLOT INDEX (as a string key) -> view-relative icon path. Lives
       in the followers config slice, arrives with fdConfig, and is keyed by
       INDEX rather than by name because the label is renameable in the very
       same rail row — keying by "Housecarls" would drop the shield the moment
       Rober typed "Housecarls (Whiterun)". An index with no entry is the
       pre-icons look, so an untouched rail renders exactly as it always did. */
    catIcons: {},
    /* Live-detected followers (teammate/faction), from the C++ HUD scan via
       fdLiveParty. Merged into the party bar so non-FO-roster followers show. */
    liveParty: [],
    /* The icon library, chained off app.js's own hdIconIndex / hdIcons globals
       (see chainIcons below) rather than asked for a second time: C++ pushes
       both at every palette open, and a second request name would be a second
       thing to keep in sync for no new data. */
    icons: { catalog: [], custom: [] },
    /* PARTY SHEET — one snapshot of everyone who is with you, from
       src/party_sheet.cpp via ptyScan -> ptyData. Never merged into `cats`:
       this is LIVE engine truth about actors loaded right now, and the roster
       is a durable filing cabinet that also lists people three holds away.
       Keeping them apart is what lets the sheet say "4 too far away to read"
       instead of quietly showing eight of twelve. */
    party: { at: 0, asking: false, ok: true, msg: '', unloaded: 0,
             members: [], skillNames: [] },
    /* Who's here (nh-): the last cell scan. TWO questions, one scan (Rober,
       2026-09-20): in ROSTER mode rows = Follower Organizer people near the
       player with the facts a missing picture turns on (see nhChips); in
       EVERYONE mode rows = every actor loaded around you, each carrying
       `roster` so a stranger reads as one and can be filed on the spot.
       `all` is what the last reply answered — never what the switch says, so
       the header cannot claim a mode the rows are not. */
    here: { at: 0, asking: false, ok: false, msg: '', rows: [], cell: null,
            rosterTotal: 0, seen: 0, shown: 0, queued: 0, mrf: true,
            nearMeters: 0, all: false },
    /* Recall roster (rr-): the last prRosterData — who the F17 recall would
       answer for, who it leaves alone and why, and the register. */
    recall: { at: 0, asking: false, ok: false, msg: '', rows: [], answer: 0, flagged: 0,
              registered: 0, key: null },
  };

  const ALL = 0;
  /* Follower Organizer owns 25 category slots (1..25); 0 is the master list,
     which the rail draws as "All followers". Mirrored in main.cpp's
     kFolCatMax — both sides validate a category-icon index against it. */
  const CAT_MAX = 25;

  /* ======================================================== NPC fields ==== *
   *  THE curated field spec — one list, here. Storage on FO's side is a
   *  free-form string->string map (`Member::fields`, persisted under "Fields"
   *  in FollowerOrganizer.json), and every op that writes it is key-agnostic,
   *  so adding a row below is a VIEW edit: no DLL rebuild, no migration, and
   *  data already stored under a key nobody has spec'd yet still renders (see
   *  fieldRows) instead of quietly vanishing.
   *
   *  `chip: true` promotes a field to a subtitle chip on the roster row. Keep
   *  that to ONE field — the row already carries note + category + née and a
   *  second chip is where it stops being scannable.
   * ======================================================================== */
  const FIELDS = [
    { key: 'relationship', label: 'Relationship', chip: true,
      hint: 'housecarl · companion · steward · friend · rival …' },
    { key: 'home',       label: 'Home',       hint: 'where they live / are stationed' },
    { key: 'occupation', label: 'Occupation', hint: 'what they do all day' },
    { key: 'faction',    label: 'Faction',    hint: 'who they answer to' },
  ];

  /* Mirrored in DeckAPI.cpp ValidFieldKey() and portal/server.js FIELD_KEY_RE.
     A key is a JSON object key compared case-sensitively across three
     languages, so it is refused rather than normalised. */
  const FIELD_KEY_RE = /^[a-z0-9_-]{1,32}$/;
  const FIELD_VALUE_MAX = 300;   // DeckAPI.cpp kFieldValueMax

  const CHIP_FIELD = FIELDS.filter(function (f) { return f.chip; })[0] || null;

  const ui = {
    cat: ALL,
    /* Who the quick card is about when it is NOT the crosshair: the original
       name of someone picked from the party strip, or '' for the crosshair.
       A NAME rather than the member object, because fdState rebuilds the
       roster wholesale and a held reference would quietly go stale. */
    fqPick: '',
    fqPickPinned: false,  // Explicit F7-on-this-person choice survives a crosshair refresh.
    tuneOpen: false,         // the Stats block, collapsed by default
    fqCrewFold: false,       // "Current party" folded? (session only)
    fqEveryoneFold: false,   // "Everyone" folded?
    /* The waiting group starts COLLAPSED: they are not with you, so they are
       reference rather than the thing you came for. Sticky for the session so
       opening it once does not have to be done again on every repaint. */
    fqWaitOpen: false,
    editing: false,
    filter: '',
    sel: -1,
    menuFor: null,
    /* Whether the worn-set readout in the member menu is expanded. Sticky
       across menu opens (and across members) so a preference set once holds —
       collapsed by default because expanded it makes the menu scroll. */
    eqOpen: false,
    /* Whether the card's NFF outfit-set picker is revealed. Not sticky — it is
       a "which of the three" question, not a preference. */
    fqSets: false,
    /* Whether the 💡 Facelight control row is revealed. Session-only like
       fqSets — "do something about her light right now", not a preference. */
    fqLight: false,
    /* Whether the 📦 SPID Gear grant list is revealed. Session-only like
       fqLight — "what does she permanently get", not a preference. */
    fqSpid: false,
    /* Whether the 🔍 Debug dossier is revealed. Session-only — it answers
       "why is she acting broken right now", not a preference. */
    fqDebug: false,
    /* Roster opened from a rail category click (Rober, 2026-08-05). Default
       false: with a crosshair target the roster is HIDDEN and the card owns the
       pane; clicking a category on the left opens its roster, clicking the open
       one again returns to dedicated. Session-only — a "browsing right now",
       not a preference. */
    rosterOpen: false,
    /* Card folded to just the identity line. Session-only on purpose: it is a
       "not right now" rather than a preference, and the followers config slice
       is round-tripped whole by C++, so persisting it would mean a DLL change
       for a toggle you flip a few times an hour. */
    fqFold: false,
    /* Note / relationship editor revealed on the card. */
    fqEdit: false,
    /* Last category someone was filed into, so the card can offer a one-click
       repeat. Session-only, like fqFold: filing a run of new people into the
       same category is a burst, not a standing preference, and persisting it
       would mean a DLL change for a value that costs nothing to relearn. */
    fqLastCat: -1,
    /* Armed state of the destructive "stop using NFF" button. */
    fqArmReset: false,
    /* Armed state of the destructive "forget her home" button. */
    fqArmHome: false,
    /* Portrait framing panel revealed on the card. Not sticky: it is a "let me
       fix this shot" mode, not a preference. */
    fqFraming: false,
    /* Category-icon picker: the slot index it is choosing FOR, or -1 when it
       is shut. An index (not the category object) because fdState rebuilds the
       roster wholesale and a held reference would go stale mid-pick. */
    catIconFor: -1,
    catIconFilter: '',
    catIconShown: 0,
    /* ---- Party sheet. Session-only, every one of them, and deliberately:
       the followers config slice is round-tripped WHOLE by C++, so persisting
       a layout preference here would cost a DLL change for a control you flip
       a few times an hour (the same bargain fqFold and fqLastCat already
       take). ptMode is the one a case could be made for; it is cheap to
       re-pick and expensive to schema. */
    ptOpen: false,      // the sheet is showing instead of the roster
    ptMode: 'cards',    // 'cards' | 'table'
    ptSort: 'issues',
    ptScope: 'all',     // PT_SCOPES key
    ptFilter: '',
    ptSel: -1,
    nhOpen: false,      // Who's here is showing instead of the roster
    rrOpen: false,      // Recall roster is showing instead of the roster
    rrFilter: '', rrSel: -1,
    nhMode: 'roster',   // 'roster' (FO people here) | 'all' (every NPC in the cell)
    nhFilter: '',
    nhSel: -1,
    ptSummons: false,   // show conjured teammates too
    ptSkills: false,    // ask C++ for the 18 skill values (nothing draws them yet)
  };

  let dragKind = null, dragFrom = null;

  const $ = (id) => document.getElementById(id);

  /* h() mirrors the standalone view's DOM helper (app.js uses innerHTML
     templating instead — the pane keeps the element style it was built with). */
  function h(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'data') { for (const d in v) e.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach((c) => {
        if (c == null || c === false) return;
        e.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }

  /* Consistent stroke-based line icons for the card's group headers (Rober,
     2026-08-05: "nicer SVGs that feel consistent"), replacing the mixed emoji
     glyphs. stroke=currentColor so each inherits its header's gold. */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(paths, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (Array.isArray(paths) ? paths : [paths]).forEach((d) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      s.append(p);
    });
    return s;
  }
  const GROUP_ICONS = {
    order:   ['M6 3v18', 'M6 4h11l-3.5 3.5L17 11H6'],                 // pennant flag — a command
    move:    ['M12 4v16', 'M4 12h16', 'M9 7l3-3 3 3', 'M9 17l3 3 3-3',
              'M7 9l-3 3 3 3', 'M17 9l3 3-3 3'],                       // 4-way move arrows
    home:    ['M3 11l9-7 9 7', 'M5 10v9h14v-9', 'M10 19v-5h4v5'],     // house
    equip:   ['M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z'],  // shield — armour
  };
  function groupIcon(key) { return svgIcon(GROUP_ICONS[key] || GROUP_ICONS.order); }

  function nameNodes(name, q) {
    name = String(name || '');
    if (!q) return [document.createTextNode(name)];
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [document.createTextNode(name)];
    return [
      document.createTextNode(name.slice(0, i)),
      h('mark', null, name.slice(i, i + q.length)),
      document.createTextNode(name.slice(i + q.length)),
    ];
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ---- bridge senders (toGame + toast come from app.js globals) ---- */

  function sendApply(op, extra) {
    noteRecent(op, extra && extra.cat, extra && extra.idx);
    toGame('fdApply', JSON.stringify(Object.assign({ op }, extra || {})));
  }
  function sendWorld(op, cat, idx, label) {
    noteRecent(op, cat, idx);
    toGame('fdWorld', JSON.stringify({ op, cat, idx, label: label || '' }));
  }

  /* ---- Recents strip -------------------------------------------------
     Recorded at the THREE senders every member action funnels through —
     sendApply, sendWorld and sendNpc — rather than at each call site, so a new
     action lands in the strip the day it is written instead of the day
     somebody remembers to
     add a hook. Category-level ops (rename a rail entry, etc.) carry no
     cat/idx pair and are filtered out by Recents itself.
     Wrapped in a guard so the pane still works if recents-strip.js is
     missing — it is a shortcut, never a dependency. */
  function noteRecent(op, cat, idx) {
    if (typeof Recents === 'undefined' || cat == null || idx == null) return;
    const c = catByIndex(cat);
    const m = c && c.members ? c.members[idx] : null;
    if (!m) return;
    const p = portraitFor(m);
    Recents.touch(m, op, {
      cat: cat, idx: idx, hue: hueOf(cat),
      file: p ? p.file : '', mtime: p ? p.mtime : 0, abs: !!(p && p.abs),
    });
    renderRecents();
  }

  /* The strip lives above the roster and is created on demand — it is not in
     index.html so that adding it costs no edit to a file three other panes
     share. Empty = nothing rendered at all, not an empty labelled box. */
  function renderRecents() {
    if (typeof Recents === 'undefined') return;
    const main = $('fd-main');
    if (!main) return;
    let host = $('fd-recents');
    if (!host) {
      host = document.createElement('div');
      host.id = 'fd-recents';
      host.className = 'hidden';
      // After the search box, before the status line and the list.
      const anchor = $('fd-search-wrap');
      if (anchor && anchor.parentNode === main) main.insertBefore(host, anchor.nextSibling);
      else main.insertBefore(host, main.firstChild);
    }
    /* Faces resolved HERE, not at touch() time. The strip stores the file it
       saw when you interacted with someone; photograph her afterwards and the
       chip would go on drawing the old one until she happened to be touched
       again. Re-resolving on every render means a new capture reaches the strip
       in the same repaint that reaches the roster.
       Guarded on the map being populated: pushing an empty resolver result would
       blank faces that are drawing fine, and fdPortraits can legitimately arrive
       after the first render. */
    if (Recents.refreshFaces) {
      Recents.refreshFaces(function (id) {
        /* Resolve against the REAL roster row, not a synthetic {original,name}.
           portraitFor falls back to the facegen head render keyed by FORMID —
           and a stand-in member object carries no formId, so that branch could
           never fire and a chip stayed on initials even after her face had
           rendered (Rober, 2026-09-21: "melana had her face generated
           automatically but recent doesnt update"). hd-face.js's header names
           this exact half-door. The stand-in is still the fallback for someone
           who has LEFT the roster: her captured photo is filed by slug and
           resolves without a row. */
        const hit = rosterEntryFor(id);
        const p = portraitFor(hit ? hit.m : { original: id, name: id });
        if (!p) return null;
        return {
          file: p.file, mtime: p.mtime, abs: !!p.abs,
          /* hue follows a re-file, since the chip is drawn from it */
          hue: hit ? hueOf(hit.cat.index) : null,
        };
      });
    }
    Recents.render(host, pickFromRecents, {
      /* ONE URL builder for the whole deck — portraits/ vs a head render's own
         path — so the strip can never disagree with the roster row. */
      src: (e) => portraitSrc({ file: e.file, abs: e.abs }),
      /* Two framing lanes, and they are NOT interchangeable: a captured photo
         wears the crop the user saved (a transform), a head render needs the
         measured face-fit (a layout crop — a transform on a 26px tile samples
         26 effective pixels and reads as blocks). Backwards is a pixelated or
         a giant face; see hd-face.js. */
      fit: (img, url, e) => {
        if (e.abs) faceFitEnsure(img, url);
        else if (window.HDFaceFit) HDFaceFit.paintPortrait(img, url);
      },
      /* Her head render is queued but has not landed: the chip says so with a
         ring rather than sitting on bare initials. Same source of truth as the
         roster medallion, so the two can never disagree about who is loading. */
      pending: (e) => {
        const hit = rosterEntryFor(e.id);
        return !!(hit && facePendingFor(hit.m));
      },
      onAlt: openFromRecents,
      hint: 'Click: open her card · Right-click (or Shift+click): her menu',
    });
  }

  /* ===================================== Followers HUD control card ======
     The on-screen portrait strip (a SECOND PrismaUI view, hud.html) is driven
     by C++; this card is its only settings surface — enable, orientation,
     name captions, the show/hide key, and Reposition (which Focuses the HUD so
     it can be dragged/resized). State comes in on window.hudCfgState; every
     button sends one op on hudCfg and the reply refreshes the card. */
  let hudState = null;
  // The card is a disclosure: COLLAPSED to a chevron by default so it never eats
  // the top of the Followers tab. Session-scoped (resets closed each deck open,
  // which is exactly "closed by default").
  let hudCardOpen = false;

  function hudCfg(op, extra) {
    const p = Object.assign({ op: op }, extra || {});
    toGame('hudCfg', JSON.stringify(p));
  }

  /* The HUD control used to be a full-width disclosure card at the top of the
     pane. Rober (2026-08-05): "don't take up so much room with the follower
     HUD — it should be a small button somewhere that opens a popout modal for
     settings." So #fd-hud is now a small pill in the search row; its settings
     live in a modal (openHudModal), rebuilt live from hudCfgState. */
  function renderHudCard() {
    const main = $('fd-main');
    if (!main) return;
    let host = $('fd-hud');
    if (!host) {
      host = document.createElement('div');
      host.id = 'fd-hud';
      /* Lives INSIDE the search row (right-aligned) so it costs no line of its
         own (Rober, 2026-08-05: "the hud thing is taking an entire line to
         itself"). Falls back to the top of the pane if the search row is not
         in this host (the Hotkeys-tab quick card has no search). */
      const sw = $('fd-search-wrap');
      if (sw) sw.appendChild(host);
      else main.insertBefore(host, main.firstChild);
    }
    const s = hudState || {};
    const on = !!s.enabled;
    host.innerHTML = '';
    /* One small button. A dot shows enabled/off at a glance; clicking opens the
       settings modal. Compact by design so it costs the pane almost no height. */
    host.append(h('button', {
      class: 'fd-hud-open' + (on ? ' on' : ''), type: 'button',
      title: 'Followers HUD settings — the on-screen portrait strip',
      onClick: () => openHudModal(),
    },
      h('span', { class: 'fd-hud-dot' }),
      h('span', { class: 'fd-hud-open-lbl' }, '👥 HUD'),
      h('span', { class: 'fd-hud-open-state' }, on ? 'on' : 'off')));
    /* If the modal is open, keep its contents in step with fresh state. */
    if ($('fd-hud-modal')) fillHudModal();
  }

  /* The settings themselves, shared by the modal. Returns a row of buttons. */
  function hudSettingsRow() {
    const s = hudState || {};
    const on = !!s.enabled;
    const vert = (s.orient === 'vert');
    const names = (s.showNames !== false);
    const visible = (s.visible !== false);
    const arming = !!s.arming;
    const keyLabel = (s.key && s.key.label) || '';
    const row = h('div', { class: 'fd-hud-row' });

    row.append(h('button', {
      class: 'fd-hud-btn' + (on ? ' on' : ''), type: 'button',
      title: on ? 'Hide the HUD entirely' : 'Show a portrait strip of your current followers',
      onClick: () => hudCfg('enable', { on: !on }),
    }, on ? '◉ Enabled' : '◯ Enable'));

    if (on) {
      row.append(h('button', {
        class: 'fd-hud-btn', type: 'button',
        title: 'Drag / resize / flip the HUD in-game, then lock it',
        onClick: () => hudCfg('reposition'),
      }, '✥ Reposition'));
      row.append(h('button', {
        class: 'fd-hud-btn' + (vert ? ' on' : ''), type: 'button',
        title: 'Lay the strip out as a row or a column',
        onClick: () => hudCfg('orient', { orient: vert ? 'horiz' : 'vert' }),
      }, vert ? '↕ Vertical' : '↔ Horizontal'));
      const aH = (s.anchorH === 'right') ? 'right' : 'left';
      const aV = (s.anchorV === 'bottom') ? 'bottom' : 'top';
      const corner = { 'top-left': '↘', 'top-right': '↙', 'bottom-left': '↗', 'bottom-right': '↖' }[aV + '-' + aH] || '↘';
      row.append(h('button', {
        class: 'fd-hud-btn', type: 'button',
        title: 'Flip which corner it anchors to / grows from (currently ' + aV + ' ' + aH + ')',
        onClick: () => hudCfg('grow'),
      }, '⤢ Grows ' + corner));
      row.append(h('button', {
        class: 'fd-hud-btn' + (names ? ' on' : ''), type: 'button',
        title: 'Show or hide the name under each face',
        onClick: () => hudCfg('names', { on: !names }),
      }, names ? 'Aa Names on' : 'Aa Names off'));
      /* Per-face extras (Party Sheet catch-up, 2026-08-17): level badge,
         direction + distance, and the three pool bars — each its own toggle,
         each one `part` op. Defaults mirror the DLL (level/dir/health on,
         magicka/stamina off), so a missing field from an older DLL still
         paints the button in its true default state. */
      [['level', 'Lv badge', 'A level badge on each portrait', s.showLevel !== false],
       ['dir', '➤ Direction', 'A chevron pointing at her, with the distance in meters', s.showDir !== false],
       ['hp', '♥ Health', 'A live health bar under each face', s.showHp !== false],
       ['mk', '✦ Magicka', 'A live magicka bar under each face', s.showMk === true],
       ['st', '➶ Stamina', 'A live stamina bar under each face', s.showSt === true],
      ].forEach(function (d) {
        row.append(h('button', {
          class: 'fd-hud-btn' + (d[3] ? ' on' : ''), type: 'button',
          title: d[2] + (d[3] ? ' — shown' : ' — hidden'),
          onClick: () => hudCfg('part', { key: d[0], on: !d[3] }),
        }, (d[3] ? '◉ ' : '◯ ') + d[1]));
      });
      /* Portrait shape (2026-08-17 wave 2.1): four cuts, one active. Typographic
         marks, not emoji — the 2026-08-16 icon law. */
      const shape = ['circle', 'rounded', 'square', 'diamond']
        .indexOf(s.faceShape) !== -1 ? s.faceShape : 'circle';
      /* The WIDGETS door (Rober, 2026-08-18: the widget system "should be …
         configurable in that popout"): one button into the on-screen editor —
         the same surface the Home card opens, closing the deck so the editor
         has the screen. */
      row.append(h('button', {
        class: 'fd-hud-btn', type: 'button',
        title: 'Open the on-screen widget editor — readouts, vitals, potions, the four slot cards; drag anything, toggle everything',
        onClick: () => toGame('hdFire', 'hd-widgets-edit'),
      }, '⌗ Widgets…'));
      [['circle', '◯', 'Round portraits (the classic strip)'],
       ['rounded', '▢', 'Rounded-corner squares'],
       ['square', '■', 'Sharp squares'],
       ['diamond', '◆', 'Rotated diamonds, Party Sheet style'],
      ].forEach(function (d) {
        row.append(h('button', {
          class: 'fd-hud-btn' + (shape === d[0] ? ' on' : ''), type: 'button',
          title: d[2] + (shape === d[0] ? ' — current' : ''),
          onClick: () => hudCfg('shape', { shape: d[0] }),
        }, d[1] + ' ' + d[0].charAt(0).toUpperCase() + d[0].slice(1)));
      });
      /* Compact + the browse activator (Rober, 2026-08-18: "auto compacted to
         just the faces … press an activator then use wasd or arrows and enter
         to navigate"). Honest caveat in the titles: the deck's input sink
         cannot consume keys, so WASD still moves you while browsing. */
      const compactOn = s.compact === true;
      row.append(h('button', {
        class: 'fd-hud-btn' + (compactOn ? ' on' : ''), type: 'button',
        title: compactOn
          ? 'Compact is ON — the strip shows faces only until you browse it'
          : 'Show faces only; level, bars and names appear when you browse a chip',
        onClick: () => hudCfg('compact', { on: !compactOn }),
      }, (compactOn ? '◉ ' : '◯ ') + '▣ Compact'));
      const navArming = !!s.navArming;
      const navLabel = (s.navKey && s.navKey.label) || '';
      row.append(h('button', {
        class: 'fd-hud-btn' + (navArming ? ' arming' : ''), type: 'button',
        title: 'Bind the BROWSE key: press it to highlight the strip, WASD/arrows to step '
          + 'through your followers, Enter to expand one, Esc or the key again to close. '
          + '⚠ movement keys still move you while browsing — the game stays live.',
        onClick: () => hudCfg(navArming ? 'state' : 'bindnav'),
      }, navArming ? '⌨ Press a key…' : (navLabel ? ('⌨ Browse: ' + navLabel) : '⌨ Set browse key')));
      if (navLabel && !navArming) {
        row.append(h('button', {
          class: 'fd-hud-btn fd-hud-x', type: 'button', title: 'Clear the browse key',
          onClick: () => hudCfg('clearnav'),
        }, '✕'));
      }
      row.append(h('button', {
        class: 'fd-hud-btn' + (visible ? ' on' : ''), type: 'button',
        title: visible ? 'Temporarily hide without disabling' : 'Show it again',
        onClick: () => hudCfg('visible', { on: !visible }),
      }, visible ? '👁 Shown' : '👁 Hidden'));
      row.append(h('button', {
        class: 'fd-hud-btn' + (arming ? ' arming' : ''), type: 'button',
        title: 'Bind a keyboard/mouse key that toggles the HUD on and off',
        onClick: () => hudCfg(arming ? 'state' : 'bindkey'),
      }, arming ? '⌨ Press a key…' : (keyLabel ? ('⌨ ' + keyLabel) : '⌨ Set key')));
      if (keyLabel && !arming) {
        row.append(h('button', {
          class: 'fd-hud-btn fd-hud-x', type: 'button', title: 'Clear the toggle key',
          onClick: () => hudCfg('clearkey'),
        }, '✕'));
      }
    }
    return row;
  }

  function fillHudModal() {
    const body = $('fd-hud-modal-body');
    if (!body) return;
    body.innerHTML = '';
    body.append(hudSettingsRow());
  }

  function closeHudModal() {
    const m = $('fd-hud-modal');
    if (m) m.remove();
    document.removeEventListener('keydown', hudModalEsc, true);
  }

  /* Esc closes THIS modal first — capture phase, so the deck's own Esc (which
     closes the whole palette) never sees the key while the modal is up. The
     2026-08-18 play-test: "followers hud popout x does nothing" — the law is
     Esc closes every popout and so does its ✕, so both are wired twice here
     (property + delegated listener): whatever ate the property click in-game,
     the delegated path still lands. */
  function hudModalEsc(e) {
    if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
      e.stopPropagation();
      e.preventDefault();
      closeHudModal();
    }
  }
  function openHudModal() {
    if ($('fd-hud-modal')) { closeHudModal(); return; }
    /* Off document.body like the lightbox, so it sits above the whole deck and
       is not clipped by the pane's overflow. Backdrop click / ✕ closes it. */
    const modal = h('div', { id: 'fd-hud-modal', class: 'fd-modal-back',
      onClick: (e) => { if (e.target && e.target.id === 'fd-hud-modal') closeHudModal(); } });
    const card = h('div', { class: 'fd-modal' },
      h('div', { class: 'fd-modal-head' },
        h('span', { class: 'fd-modal-title' }, '👥 Followers HUD'),
        h('button', { class: 'fd-modal-x', type: 'button', title: 'Close',
          onClick: () => closeHudModal() }, '✕')),
      h('div', { class: 'fd-modal-sub' },
        'The on-screen portrait strip of your current followers.'),
      h('div', { id: 'fd-hud-modal-body' }));
    modal.append(card);
    modal.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.fd-modal-x')) {
        e.stopPropagation();
        closeHudModal();
      }
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', hudModalEsc, true);
    fillHudModal();
  }

  /* Click a face → her action menu, next to the chip.
     Resolved by IDENTITY first: cat/idx are a hint that goes stale the moment
     anyone is re-filed or removed, and opening the menu on whoever happens to
     occupy that slot now would be worse than not opening one. */
  /* Resolve a chip back to a live roster row. Shared by BOTH chip actions so
     they can never disagree about who "Camilla" is: the hint (cat/idx) stored
     at touch() time shifts the moment anything is re-filed, so identity wins
     and the hint is not consulted at all. */
  function recentsRow(entry) {
    let found = null;
    state.cats.forEach((c) => {
      (c.members || []).forEach((m, i) => {
        if (found) return;
        if ((m.original || m.name) === entry.id) found = { cat: c.index, idx: i, m: m, catName: catLabel(c) };
      });
    });
    if (!found) toast('“' + entry.name + '” is no longer in the roster');
    return found;
  }

  /* LEFT click on a recent chip: open her card — exactly what F7-on-her does
     (Rober, 2026-09-21: "recent clicking should ... open as if you hit f7 on
     them"). It dispatches through pickCrew, the verb the Current-party strip
     already fires, so the strip implements no behaviour of its own: one
     subject-picking path, play-proven, and the card, the equipped ask and the
     status line all keep agreeing about who they are about. The popout member
     menu is still one press away, on the RIGHT button (openFromRecents). */
  function pickFromRecents(entry) {
    const found = recentsRow(entry);
    if (!found) return;
    pickCrew(found.m);
  }

  function openFromRecents(entry, chipEl) {
    const found = recentsRow(entry);
    if (!found) return;
    const r = chipEl ? chipEl.getBoundingClientRect() : null;
    openMemberMenu(found, r ? r.left : 120, r ? r.bottom + 6 : 120);
  }
  /* The followers slice is round-tripped WHOLE by the C++ side, so every save
     must carry every field — sending only openKey would silently reset the
     avatar size to its default on the next write.

     catIcons is sent for exactly that reason. C++ ALSO preserves it when a
     payload omits it (an older view, or the portal, saving only the chrome
     fields) — belt and braces, because the two halves fail in opposite
     directions: forget it here and the icons die on the next size nudge;
     forget it there and any other writer wipes them. */
  function saveCfg() {
    toGame('fdSave', JSON.stringify({
      openKey: state.openKey,
      avatarPx: state.avatarPx | 0,
      dossierSizePct: clampDossierSize(state.dossierSizePct),
      dossierFrames: state.dossierFrames,
      uiScale: curUi(),
      catIcons: state.catIcons,
      fqLabels: !!state.fqLabels,
      railCollapsed: !!state.railCollapsed,
      railIconPct: curIc(),
    }));
  }
  function saveOpenKey() { saveCfg(); }

  /* ---- avatar size ----------------------------------------------------
     Rober asked for much bigger faces on the roster, with a scaler. The size
     drives one CSS variable; the stylesheet scales the initials and the row
     height off it, so nothing here needs to know about layout. 0 means
     "unset" all the way down to the config, so the default lives only in the
     CSS fallback and cannot drift between the three layers. */
  const AV_MIN = 28, AV_MAX = 128, AV_STEP = 8, AV_DEF = 40;

  function clampAv(px) {
    px = Math.round(Number(px) || 0);
    if (px <= 0) return 0;
    return Math.max(AV_MIN, Math.min(AV_MAX, px));
  }
  function curAv() { return state.avatarPx > 0 ? clampAv(state.avatarPx) : AV_DEF; }

  /* ---- category-icon size (independent of the face slider) -------------
     Rober: the rail glyphs read pixely. They ARE 256px art — Ultralight just
     aliases the ~10x downscale to rail size. Scaling them UP shrinks that ratio
     and reads crisper, so this stepper is both the "make them bigger" and the
     "make them sharper" control. A PERCENT of what the avatar slider derives,
     so 100% is byte-for-byte the pre-slider look. */
  const IC_MIN = 60, IC_MAX = 260, IC_STEP = 20, IC_DEF = 100;

  function clampIc(v) {
    v = Math.round(Number(v) || 0);
    if (v <= 0) return IC_DEF;
    return Math.max(IC_MIN, Math.min(IC_MAX, v));
  }
  function curIc() { return clampIc(state.railIconPct); }

  /* Type scales WITH the faces. Rober runs 72 px avatars, and at the old fixed
     13.5/11/10 px the words next to a 72 px portrait read half-size — the row
     looked like a big picture with a caption. Every ramp is anchored so that
     AV_DEF (40) reproduces the previous sizes exactly, then grows from there,
     so nobody at the default sees a change and the slider now scales the ROW,
     not just the circle.

     Computed here rather than in CSS on purpose: this has to survive
     Ultralight, whose calc() is fine but whose min()/max()/clamp() are not
     worth betting the pane on. Each var carries the AV_DEF value as its CSS
     fallback, so if this function never runs the pane still looks right. */
  function ramp(base, k, lo, hi, px) {
    const v = base + (px - AV_DEF) * k;
    return Math.round(Math.max(base * lo, Math.min(base * hi, v)) * 10) / 10;
  }
  function oddPx(v) { return 2 * Math.round((v - 1) / 2) + 1; }

  /* ---- member-menu geometry ----
     The two numbers app.css cannot own. The label COLUMN has to be wide
     enough for the longest label in the spec ("Relationship") at whatever
     type size the slider is on, and the menu WIDTH has to be clamped against
     the viewport — neither is expressible without min()/max(), which is the
     one bit of CSS this pane refuses to trust in Ultralight.

     Both are floored rather than merely scaled: a 250px menu at 28px avatars
     was just as cramped as at 72px — the complaint was never really about
     the slider, it was that a form full of text inputs was living in a
     tooltip-sized box. So the floor IS the fix, and the ramp keeps it in
     proportion from there.

     Round two: 410px still read as a wide tooltip. Rober's whole reply was
     "wider". The floor is now 500 and the day allowance 90, which puts the
     plain menu at ~538px and a day-bearing one at ~644px at his 72px faces —
     a dialog, with a text input you can see a whole sentence in (~480px of
     field once the label column and the paddings are paid for). The ramp is
     correspondingly gentler (1.2/px, was 1.55): with a floor this high, a
     steep slope is what would send 128px avatars off the edge of a 1080p
     screen, and the floor is doing the work anyway. */
  function ctxLabelPx(px) { return Math.round(ramp(96, 0.55, 1, 1.5, px)); }
  function ctxWidthPx(px, hasDay) {
    /* USE THE ROOM. Rober, 2026-08-03: "way more horizontal space usage, its
       too compact, make it centered, make text and UI bigger."
       The old target was a fixed ~500px ramp — a column down the middle of a
       1700px panel, with every long value ellipsized against acres of empty
       deck either side. It is now a SHARE of the surface it opens over, with
       the old ramp as the floor so a small window is unchanged.
       A day carries two lines per stop and place names like "The Sleeping
       Giant Inn", so a menu that has one asks for more of that share. */
    const vp = ctxViewport();
    const ramped = Math.round(ramp(500, 1.20, 1, 1.45, px)) +
      (hasDay ? Math.round(ramp(90, 0.50, 1, 1.5, px)) : 0);
    const share = Math.round(vp.w * (hasDay ? 0.82 : 0.72));
    /* Never wider than the surface it has to be positioned on — the whole
       reason this width lives in JS rather than CSS. 24 = the 6px clampCtx
       keeps at each edge, doubled for a little air. Capped at 1180 so it stops
       being a menu and starts being a page on an ultrawide. The vp cap is
       divided by --ui-scale: this is a LAYOUT width and the menu is painted at
       ×scale, so at ⛶ Fill an uncapped share would overflow the screen. */
    return Math.max(260, Math.min(Math.max(ramped, share), (vp.w - 24) / deckScale(), 1180));
  }

  /* Put it in the MIDDLE, not under the cursor.
     A menu this size anchored at the click lands hard against one edge and
     covers the row you were reading. Centred horizontally, and high in the
     upper third vertically rather than dead-centre, so a tall one still has
     room to grow downward before the clamp starts fighting it. Still
     draggable — this is only where it starts. */
  function centerCtx() {
    const vp = ctxViewport();
    /* PAINTED size (× --ui-scale) is what has to be centred in the real-px
       viewport — the box grows down-right from its top-left origin. */
    const s = deckScale();
    const w = ctxEl.offsetWidth * s, h = ctxEl.offsetHeight * s;
    clampCtx(Math.round((vp.w - w) / 2), Math.round(Math.max(6, (vp.h - h) * 0.32)));
  }

  function applyAvatarSize() {
    const px = curAv();
    // Set on the ROOT, not the pane: the same variables are read by rules that
    // live outside this subtree (the row min-height), and a pane-scoped custom
    // property would leave those on the fallback.
    const root = document.documentElement.style;
    root.setProperty('--fd-medal-px', px + 'px');

    root.setProperty('--fd-name-fs',    ramp(13.5, 0.050, 0.92, 1.5, px) + 'px');
    root.setProperty('--fd-sub-fs',     ramp(11,   0.038, 0.92, 1.5, px) + 'px');
    root.setProperty('--fd-chip-fs',    ramp(10,   0.032, 0.92, 1.5, px) + 'px');
    root.setProperty('--fd-tag-fs',     ramp(9.5,  0.028, 0.92, 1.5, px) + 'px');
    // chips must widen with their own text or the bigger font just truncates
    // sooner — a "housecarl" chip that says "house…" is worse than no chip.
    root.setProperty('--fd-chip-max',   Math.round(ramp(120, 0.9, 1, 1.6, px)) + 'px');
    root.setProperty('--fd-nowchip-max', Math.round(ramp(190, 1.4, 1, 1.6, px)) + 'px');
    root.setProperty('--fd-home-max',    Math.round(ramp(170, 1.3, 1, 1.6, px)) + 'px');
    root.setProperty('--fd-homesrc-fs',  ramp(9, 0.028, 1, 1.4, px) + 'px');

    /* The rail and the search box are CHROME, not row content, so they follow
       the slider at roughly half the rate the rows do. Left frozen they read
       as stunted beside 128 px faces (13 px rail against a 17.9 px name); made
       to track fully they would eat the roster's width for no information. */
    root.setProperty('--fd-rail-fs',    ramp(13,   0.024, 1, 1.3, px) + 'px');
    root.setProperty('--fd-railct-fs',  ramp(10.5, 0.018, 1, 1.3, px) + 'px');
    root.setProperty('--fd-search-fs',  ramp(13.5, 0.024, 1, 1.3, px) + 'px');
    /* The category glyph is chrome too, and it tracks the rail text so the row
       keeps its proportions at every avatar size. Rounded to a WHOLE pixel:
       a 17.4px box scaling a 64px source lands the sample grid off-pixel and
       the glyph reads soft — the one thing a 20px icon cannot afford. */
    /* ×curIc(): the independent category-icon stepper. Still rounded to a WHOLE
       pixel AFTER the scale so the sample grid stays on-pixel at every size. */
    root.setProperty('--fd-railic-px', Math.round(ramp(26, 0.05, 1, 1.4, px) * (curIc() / 100)) + 'px');   // 20->26 base (Rober: rail glyphs hard to make out); ×icon-size stepper; plate+brightness in .fd-rail-ic help too

    /* ---- the member menu ----
       Sized on its own terms, like the day stepper below: it lives in
       #overlay, so --fd-ui-scale never reaches it and the avatar slider is
       the only thing that can grow it. Rober's note was "way larger /
       spacious" — at 72px faces the old menu settled at 292px with 31px rows
       and a 10px label column, which is a form squeezed into a tooltip. The
       anchors here are the NEW baseline (13.5px controls, 7px rhythm, a
       96px label column), not the old sizes, so the default gets the room
       too; the ramps then keep it in step with the faces beside it. */
    /* 2026-08-03, Rober: "its too compact ... make text and UI bigger." Every
       anchor below moved up one notch — the DEFAULT is what he actually looks
       at, so raising only the ramp's slope would have fixed it just for people
       running huge avatars. Controls 13.5 -> 15.5, header 14 -> 16.5, labels
       11 -> 12; rhythm 7 -> 10, inset 9 -> 13, pad 8 -> 12. The ramps are
       unchanged, so it still tracks the faces beside it. */
    root.setProperty('--fd-ctx-fs',      ramp(15.5, 0.045, 1, 1.40, px) + 'px');
    root.setProperty('--fd-ctx-head-fs', ramp(16.5, 0.050, 1, 1.40, px) + 'px');
    root.setProperty('--fd-ctx-lab-fs',  ramp(12,   0.028, 1, 1.35, px) + 'px');
    /* Whole pixels: these feed calc()s that add 2 and 3, and a fractional
       rhythm unit makes every row in the menu land on a different subpixel. */
    root.setProperty('--fd-ctx-gap',   Math.round(ramp(10, 0.045, 1, 1.6, px)) + 'px');
    root.setProperty('--fd-ctx-inset', Math.round(ramp(13, 0.035, 1, 1.5, px)) + 'px');
    root.setProperty('--fd-ctx-pad',   Math.round(ramp(12, 0.030, 1, 1.5, px)) + 'px');
    root.setProperty('--fd-ctx-lab',   ctxLabelPx(px) + 'px');

    // The day stepper is a menu, not a row, so it gets a deliberate one-notch
    // bump at the default too (14/12.5 vs the old 13/11.5) — it is the densest
    // information in the tab and was the smallest type in it.
    root.setProperty('--fd-day-lab',    ramp(14,   0.050, 1, 1.45, px) + 'px');
    root.setProperty('--fd-day-place',  ramp(12.5, 0.040, 1, 1.45, px) + 'px');
    /* The dot is forced ODD. Its centre is the day panel's x-padding + the
       row's x-padding + half a dot; with an odd dot that lands on a
       half-pixel, so the 1px spine below sits exactly on it. An even dot puts
       the centre on a whole pixel, where a 1px rule is unavoidably half a
       pixel off. */
    const dot = oddPx(ramp(23, 0.060, 1, 1.4, px));
    root.setProperty('--fd-day-dot',    dot + 'px');
    root.setProperty('--fd-day-dot-fs', ramp(12.5, 0.035, 1, 1.4, px) + 'px');
    root.setProperty('--fd-day-badge',  ramp(9.5,  0.025, 1, 1.4, px) + 'px');
    /* The stepper's own padding, and the spine derived FROM it. app.css reads
       both from these vars precisely so the two can never drift apart: the
       spine is only correct while it equals padx + rowpx + half a dot. */
    const dayPadX = Math.round(ramp(9, 0.035, 1, 1.5, px));
    const dayRowX = Math.round(ramp(6, 0.030, 1, 1.5, px));
    const dayRowY = Math.round(ramp(6, 0.040, 1, 1.6, px));
    root.setProperty('--fd-day-padx',  dayPadX + 'px');
    root.setProperty('--fd-day-padt',  Math.round(dayRowY / 2) + 'px');
    root.setProperty('--fd-day-padb',  (Math.round(dayRowY / 2) + 2) + 'px');
    root.setProperty('--fd-day-rowpx', dayRowX + 'px');
    root.setProperty('--fd-day-rowpy', dayRowY + 'px');
    /* Spine left = the dot centre minus half the 1px rule, which with an odd
       dot is exact. Its end caps inset by half a row so the rule starts AT the
       first dot instead of floating past it. Derived here rather than as CSS
       calc() so there is no division for Ultralight to get wrong. */
    root.setProperty('--fd-day-spine', (dayPadX + dayRowX + (dot - 1) / 2) + 'px');
    root.setProperty('--fd-day-cap',   Math.round((dot + 2 * dayRowY) / 2) + 'px');

    const out = $('fd-av-val');
    if (out) out.textContent = String(px);
    syncLimits();
  }

  /* A − that still looks live at the minimum is a lie: you press it, nothing
     moves, and you cannot tell whether the control is broken or you are at the
     end of the range. Both steppers go properly disabled at their bounds, and
     reset dims when there is nothing to reset to. */
  /* The 1px rules between the edit row's control groups look right on one line
     and look like a rendering fault the moment the row wraps — the last one
     ends up dangling off the end of a line with nothing after it. CSS cannot
     see a line break, so measure: if the groups no longer share a vertical
     band, the row has wrapped and the rules are hidden (the Open key / Faces /
     Tab labels already delimit the groups on their own). */
  function syncEditRowWrap() {
    const row = $('fd-openkey-row');
    if (!row) return;
    if (row.classList.contains('hidden')) { row.classList.remove('wrapped'); return; }
    const grps = row.querySelectorAll('.fd-ok-grp');
    let wrapped = false;
    if (grps.length > 1) {
      const first = grps[0].getBoundingClientRect();
      for (let i = 1; i < grps.length; i++) {
        const b = grps[i].getBoundingClientRect();
        // no vertical overlap with the first group => it fell to another line
        if (!(first.top < b.bottom - 0.5 && b.top < first.bottom - 0.5)) { wrapped = true; break; }
      }
    }
    row.classList.toggle('wrapped', wrapped);
  }

  function syncLimits() {
    const px = curAv(), sc = curUi(), ic = curIc();
    const set = (id, off) => {
      const b = $(id);
      if (!b) return;
      b.disabled = !!off;
      b.classList.toggle('is-off', !!off);
    };
    set('fd-av-dec', px <= AV_MIN);
    set('fd-av-inc', px >= AV_MAX);
    set('fd-av-reset', px === AV_DEF);
    set('fd-ui-dec', sc <= UI_MIN + 1e-9);
    set('fd-ui-inc', sc >= UI_MAX - 1e-9);
    set('fd-ui-reset', Math.abs(sc - UI_DEF) < 1e-9);
    const icOut = $('fd-ic-val');
    if (icOut) icOut.textContent = ic + '%';
    set('fd-ic-dec', ic <= IC_MIN);
    set('fd-ic-inc', ic >= IC_MAX);
    set('fd-ic-reset', ic === IC_DEF);
    syncEditRowWrap();   // a scale change is exactly what makes the row wrap
  }

  /* ---- whole-tab scale ------------------------------------------------
     Separate from the deck's menu scale on purpose: this tab is a 70-row
     roster and wants a different density from the Quests or Notes tabs.
     Scaling DOWN is the useful direction — it is how you get "more room". */
  const UI_MIN = 0.6, UI_MAX = 1.6, UI_STEP = 0.1, UI_DEF = 1;

  function clampUi(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return UI_DEF;
    // Rounded to the step so repeated +/- cannot drift into 0.7999999.
    v = Math.round(v * 10) / 10;
    return Math.max(UI_MIN, Math.min(UI_MAX, v));
  }
  function curUi() { return clampUi(state.uiScale); }

  function applyUiScale() {
    const v = curUi();
    document.documentElement.style.setProperty('--fd-ui-scale', String(v));
    const out = $('fd-ui-val');
    if (out) out.textContent = Math.round(v * 100) + '%';
    syncLimits();
  }

  function nudgeUi(delta) {
    state.uiScale = delta === 0 ? UI_DEF : clampUi(curUi() + delta);
    applyUiScale();
    saveCfg();
  }

  function nudgeAvatar(delta) {
    // Step from the EFFECTIVE size, so the first press off the default moves
    // by one step rather than jumping from 0.
    const next = delta === 0 ? 0 : clampAv(curAv() + delta);
    state.avatarPx = next;
    applyAvatarSize();
    saveCfg();
    if (isActive()) renderList();   // rows re-measure at the new size
  }

  function nudgeIcon(delta) {
    // Only --fd-railic-px depends on it, and applyAvatarSize is where that var
    // is set, so re-run it — no separate paint path to keep in sync.
    state.railIconPct = delta === 0 ? IC_DEF : clampIc(curIc() + delta);
    applyAvatarSize();
    saveCfg();
  }

  /* ==================================== portrait crop (WYSIWYG framing) === *
   *  TWO DIFFERENT THINGS ARE CALLED "FRAMING" HERE, and confusing them is the
   *  whole reason this exists.
   *
   *  1. capture.ini's zoom/offset (the ⛶ Adjust panel on the LOOKING AT card)
   *     frames the NEXT capture — a screen grab of a live actor. At the moment
   *     you set it the photo does not exist yet, so it is inherently blind, and
   *     it stays: it is the only way to stop a head being clipped BEFORE the
   *     shutter. Rober's words: "too hard to use / preview in game".
   *  2. THIS is a DISPLAY crop on a photo that already exists. The deck cannot
   *     re-cut the pixels — portrait_capture.cpp ships a hand-rolled PNG
   *     ENCODER and no decoder at all, so the plugin literally cannot open
   *     ysolda.jpg, crop it and write it back. So we do what the web portal's
   *     canvas does, only without baking: pan/zoom the SAME <img> the deck
   *     already draws, with a CSS transform, and remember the numbers. The
   *     preview is therefore not a preview — it IS the result.
   *
   *  THE MODEL. { z, x, y }:
   *    z  display zoom, 1 = the whole (cover-fitted) frame, up to CROP_ZMAX.
   *    x,y  pan, in fractions of the FRAME's own width/height. Fractions rather
   *         than pixels so one crop is correct at every size the face is drawn
   *         — a 40 px roster medallion, a 38 px card medal and a 512 px
   *         lightbox all read the same numbers.
   *
   *  THE INVARIANT that makes it safe: at zoom z the image overhangs the frame
   *  by (z-1)/2 on each side, so a pan beyond that would show the well behind
   *  the photo. clampCrop enforces |x|,|y| <= (z-1)/2 — so a crop can never be
   *  off-screen or empty, whether it came from a drag, from an older config or
   *  from a hand-edited hotkeys.json. z=1 therefore allows no pan at all, which
   *  is correct: there is nothing to pan into.
   *
   *  IDENTITY IS THE FILE NAME, never the follower. Portraits are versioned
   *  `<slug>~<unixtime>.png` (PortraitCapture::SlugFromFileStem), so a fresh
   *  capture — or a crop the portal has BAKED into new pixels — arrives under a
   *  name this map has never seen and is drawn uncropped. That is what makes
   *  double-cropping structurally impossible rather than merely unlikely.
   * ======================================================================== */
  const CROP_ZMIN = 1, CROP_ZMAX = 4;
  const CROP_ZSTEP = 1.15;    // multiplicative: one click feels the same at 1.1x and at 3x
  const CROP_PAN_STEP = 0.03; // per nudge click, in frame fractions
  /* A bound on the whole map, mirrored in main.cpp kMaxPortraitCrops. C++
     prunes against the real directory on every save, so this only ever bites a
     hand-edited config — but an unbounded map in a file the plugin re-reads at
     every load is worth a ceiling on both sides. */
  const CROP_MAX_ENTRIES = 400;

  function isIdentityCrop(c) { return !c || (c.z === 1 && c.x === 0 && c.y === 0); }

  /* The one place the invariant lives. Returns a valid crop, or null for
     "nothing to apply" — identity crops are deliberately NOT stored, so the map
     holds only faces you actually re-framed. */
  function clampCrop(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : Number(v);
    let z = num(raw.z);
    if (!isFinite(z)) z = 1;
    z = Math.max(CROP_ZMIN, Math.min(CROP_ZMAX, z));
    const lim = (z - 1) / 2;
    let x = num(raw.x), y = num(raw.y);
    if (!isFinite(x)) x = 0;
    if (!isFinite(y)) y = 0;
    x = Math.max(-lim, Math.min(lim, x));
    y = Math.max(-lim, Math.min(lim, y));
    // Round to the precision the config stores, so a value that survives a
    // round trip through JSON compares equal to the one we sent.
    z = Math.round(z * 1e4) / 1e4;
    x = Math.round(x * 1e4) / 1e4;
    y = Math.round(y * 1e4) / 1e4;
    const c = { z: z, x: x, y: y };
    return isIdentityCrop(c) ? null : c;
  }

  /* ONE URL builder for a resolved portrait. A real capture lives under
     portraits/; a facegen head render (the roster's fallback face) carries
     `abs: true` with its full view-relative path under icons/npcs/. Every
     consumer builds its src through here, so the fallback lights up on the
     roster, the quick card, the crew strip, the shelf and the domains export
     at once instead of only where someone remembered to handle it. */
  function portraitSrc(p) {
    if (!p) return '';
    if (p.abs) return p.file;
    return 'portraits/' + (p.file || ((p.slug || '') + '.' + (p.ext || 'png')));
  }

  /* ---- face-fit: auto-frame a facegen head render -----------------------
     MRF frames the whole 512px canvas, so the head floats small inside big
     transparent margins. Measure the opaque bounding box ONCE per file (a
     canvas readback) and synthesize the same {z,x,y} crop shape the hand-made
     framings use, so applyCropTo needs no second code path. Kept in a SESSION
     map, not the config store: the portrait crop map is pruned against the
     portraits/ folder, which would silently drop keys that live under
     icons/npcs/ — and the fit is deterministic, so recomputing costs one scan
     per file per session. A hand crop (state.crops) always wins. */
  const faceFit = {};       // file key -> {z,x,y}
  let faceFitRepaint = 0;

  /* A creature BODY render (icons/mounts/…) rather than a facegen HEAD
     (icons/npcs/…). C++ falls a creature companion — a summoned atronach, a
     beast follower — back to a body silhouette when no head exists. A body
     must never be face-fitted (no skull to hone in on) and must show WHOLE
     rather than cover-cropped, so it gets contain-fit and a neutral position
     wherever a portrait is painted. */
  function isBodyRender(file) {
    return String(file || '').indexOf('icons/mounts/') !== -1;
  }

  /* Show a body render whole: contain-fit, centred, no crop transform. Used
     wherever a portrait <img> turns out to be a creature body. */
  function applyBodyFit(img) {
    if (!img || !img.style) return;
    img.style.transform = '';
    img.style.objectFit = 'contain';
    img.style.objectPosition = '50% 50%';
  }

  function faceFitEnsure(img, key) {
    /* Measurement lives in hd-facefit.js (shared with the Finder tiles) —
       this wrapper only mirrors the result into the session map that cropFor
       reads, and repaints the surfaces that drew the same file before the
       measure landed. Standalone harnesses load this pane without the module;
       the render then simply shows unfitted, which is honest. */
    if (!img || !key || !window.HDFaceFit) return;
    if (isBodyRender(key)) { applyBodyFit(img); return; }   // whole silhouette, not a face crop
    const ready = window.HDFaceFit.cssFor(key);
    if (ready) {
      faceFit[key] = ready;
      window.HDFaceFit.paint(img, key);   // layout crop — never a transform on a tiny raster
      return;
    }
    window.HDFaceFit.ensure(img, key, function (url) {
      const c = window.HDFaceFit.cssFor(url);
      if (!c) return;
      faceFit[url] = c;
      /* Other rows drawing the same file repaint on one debounced pass —
         a roster of twenty new faces must not trigger twenty renders. */
      clearTimeout(faceFitRepaint);
      faceFitRepaint = setTimeout(function () {
        portraitsChanged();
      }, 180);
    });
  }

  function cropFor(file) {
    const f = String(file || '');
    if (!f) return null;
    return state.crops[f] || faceFit[f] || null;
  }

  /* Paint a crop onto the <img> that carries the face, through the ONE shared
     crop->CSS mapping (HDFaceFit.cropCss) so the editor preview and every
     surface that draws this face agree on the pixels. The medallion's identity
     baseline is '' — no crop means fall back to the stylesheet's 50% 22% bias,
     because faces sit high in a screen grab. A deliberate crop forces 50% 50%
     inside cropCss so the transform is the only thing steering; otherwise the
     editor and the row would disagree by 28% of the frame. */
  const MEDAL_IDENTITY_BASELINE = '';   // inherit .medal-face { object-position: 50% 22% }
  function applyCropTo(face, file) {
    if (!face) return face;
    if (window.HDFaceFit && HDFaceFit.applyBrightness) HDFaceFit.applyBrightness(face, file);
    if (isBodyRender(file)) { applyBodyFit(face); return face; }   // whole creature, never cropped
    paintCrop(face, cropFor(file), MEDAL_IDENTITY_BASELINE);
    return face;
  }

  /* Local mirror of HDFaceFit.cropCss's application — used ONLY when the shared
     module is absent (a bare harness). Kept beside applyCropTo so the two can
     never silently diverge; production always takes the shared path above. */
  function cropCssLocal(c, baseline) {
    const base = String(baseline || '');
    if (!c || !isFinite(c.z) || (c.z === 1 && !c.x && !c.y)) {
      return { transform: '', transformOrigin: '50% 50%', objectPosition: base };
    }
    return {
      transform: 'translate(' + ((c.x || 0) * 100).toFixed(3) + '%,' +
        ((c.y || 0) * 100).toFixed(3) + '%) scale(' + c.z.toFixed(4) + ')',
      transformOrigin: '50% 50%', objectPosition: '50% 50%',
    };
  }
  function applyCropCssLocal(img, c, baseline) {
    if (!img || !img.style) return;
    const css = cropCssLocal(c, baseline);
    img.style.transformOrigin = css.transformOrigin;
    img.style.transform = css.transform;
    img.style.objectPosition = css.objectPosition;
  }
  /* The single funnel both applyCropTo and the editor preview use, so "the
     shared module if present, the mirror if not" is decided in one place. */
  function paintCrop(img, c, baseline) {
    if (window.HDFaceFit && HDFaceFit.applyCrop) HDFaceFit.applyCrop(img, c, baseline);
    else applyCropCssLocal(img, c, baseline);
  }

  /* "180% · ↑12% ←4%" — the numbers as a human reads them, not as they are
     stored. Up/left are negative offsets; saying "y -0.12" out loud is how you
     end up nudging the wrong way twice. */
  function cropPhrase(c) {
    if (!c) return 'original framing';
    const parts = [Math.round(c.z * 100) + '%'];
    if (c.y) parts.push((c.y < 0 ? '↑' : '↓') + Math.round(Math.abs(c.y) * 100) + '%');
    if (c.x) parts.push((c.x < 0 ? '←' : '→') + Math.round(Math.abs(c.x) * 100) + '%');
    return parts.join(' · ');
  }

  // f7-portrait-crop: the dedicated circle owns its framing, separately from roster/page art.
  const f7FallbackPrefs = {};
  function f7CropMap() {
    const prefs=typeof facefitPrefs==='function'?facefitPrefs():f7FallbackPrefs;
    if(!prefs.f7 || typeof prefs.f7!=='object' || Array.isArray(prefs.f7))prefs.f7={};
    return prefs.f7;
  }
  function f7CropFor(file) {
    const own=f7CropMap()[file];
    return own || (window.HDFaceFit && /^icons\/npcs\//.test(file)?HDFaceFit.cssFor(file):cropFor(file)) || {z:1,x:0,y:0};
  }
  function saveF7Crop(file,c) {
    f7CropMap()[file]=clampCrop(c)||{z:1,x:0,y:0};
    if(typeof saveSoon==='function')saveSoon();
    portraitsChanged();
    toast('F7 portrait framing saved');
  }
  function paintF7Crop(img,file,head) {
    if(!img || !f7CropMap()[file])return;
    img._hdPreviewOwned=true; // A pending global head fit must not replace this surface's crop.
    if(head && window.HDFaceFit && HDFaceFit.paintHeadCrop)HDFaceFit.paintHeadCrop(img,f7CropFor(file));
    else paintCrop(img,f7CropFor(file),MEDAL_IDENTITY_BASELINE);
  }

  /* ---- portrait lightbox ----------------------------------------------
     A 40 px circle cannot show a face. Clicking one opens the full capture,
     which is why the plugin now writes 512 px rather than 320. Deliberately
     dependency-free and self-closing: one overlay node, removed on any click,
     on Esc, and on tab change — an overlay that outlives its pane is the
     classic way to end up with an unclickable deck.

     Since v0.14.3 the photo sits in a SQUARE frame with the same cover fit the
     roster medallion uses, rather than free-aspect. That is not decoration: the
     crop editor's promise is that what you see here is what the row will draw,
     and that can only be true if both surfaces frame the image identically. */
  let lightbox = null;
  /* Live edit state, or null when the lightbox is only showing. Kept beside the
     node rather than inside it so onKey can ask "are we editing?" without
     digging through the DOM. */
  let lbEdit = null;

  function closeLightbox() {
    if (!lightbox) return;
    /* The drag listens on the DOCUMENT, so closing without unwiring leaves a
       mousemove handler alive for the rest of the session — and the deck opens
       this overlay many times. Every exit path goes through here or through
       endCropMode, and both drop the listeners. */
    if (lbEdit && lbEdit.unwire) lbEdit.unwire();
    if (lightbox.parentNode) lightbox.parentNode.removeChild(lightbox);
    lightbox = null;
    lbEdit = null;
  }

  /* The frame is sized in JS, in px, on purpose. app.css already leans on
     min() for .fd-lb-inner, but the editor's drag maths divides by this number
     — and a frame whose size came from a CSS function Ultralight computes
     differently would make the pan gain silently wrong in game and right in the
     harness. Read it once, from a number we chose. */
  function lbFrameSize() {
    const w = window.innerWidth || 1280, hgt = window.innerHeight || 720;
    return Math.max(200, Math.round(Math.min(512, w * 0.78, hgt * 0.62)));
  }

  /* The editor frame's px size for a given aspect (frame WIDTH / HEIGHT). The
     editor MUST match the consumer surface's aspect — a square medallion vs the
     156x200 character portrait cover-fit a square source PNG differently, so a
     square editor over a non-square consumer is the "reframe doesn't match the
     thumbnail" bug. We keep the long edge inside the same budget lbFrameSize
     picks, then derive the short edge from the aspect. */
  function lbFrameDims(aspect) {
    const budget = lbFrameSize();
    let a = Number(aspect);
    if (!isFinite(a) || a <= 0) a = 1;   // square: the follower medallion default
    if (a >= 1) return { w: budget, h: Math.max(120, Math.round(budget / a)) };
    return { w: Math.max(120, Math.round(budget * a)), h: budget };
  }

  let lbOpenedAt = 0;   // backdrop-close arming (see the onClick below)
  function openLightbox(d, startEditing) {
    closeLightbox();
    if (!d || !d.slug) return;
    lbOpenedAt = Date.now();
    /* `file` is the real filename — a re-capture of someone the deck has already
       drawn lands as `<slug>~<n>.png`, so slug + ext no longer rebuilds it. The
       old form stays as the fallback for a dataset written before that change. */
    const file = d.file || (d.slug + '.' + (d.ext || 'png'));
    if (/^icons\/(npcs|mounts)\//.test(file)) d = Object.assign({},d,{abs:true});
    if(d.cropScope==='f7'){
      d=Object.assign({},d,{_startCrop:f7CropFor(file),_onCommit:function(c){saveF7Crop(file,c);}});
    }
    const base = portraitSrc(d.abs ? d : { file: file });
    const img = h('img', {
      class: 'fd-lb-img',
      src: base + (d.abs ? '' : '?v=' + (d.mtime || 0)),
      alt: d.name || '',
      draggable: 'false',
    });
    // Same query-hostile-loader retry the row medallion needs.
    let retried = false;
    img.addEventListener('error', function () {
      if (!lightbox || !lightbox.contains(img)) return; // stale image must not close a newer lightbox
      if (retried) { closeLightbox(); return; }
      retried = true;
      img.src = base;
    });

    /* The roster medallion is a circle — square — so the lightbox frame is
       square here. (lbFrameDims(1) is that square; using it keeps ONE frame
       sizer for both the follower lightbox and the generic crop editor.) */
    const dims = lbFrameDims(1);
    const frame = h('div', { class: 'fd-lb-frame' }, img);
    frame.style.width = dims.w + 'px';
    frame.style.height = dims.h + 'px';
    /* A captured photo gets its saved framing; a head render deliberately
       does NOT get the face fit here — the lightbox's job is the whole
       render, and skipping applyCropTo is what keeps cropFor's session fit
       off this img. */
    if (!d.abs) applyCropTo(img, file);
    else {
      // The large viewer shows the complete render; only its mini preview is fitted.
      img._hdPreviewOwned = true;
      img.style.objectFit = 'contain';
      img.style.objectPosition = '50% 50%';
      if (window.HDFaceFit) HDFaceFit.applyBrightness(img, file);
    }
    if(d.cropScope==='f7')paintF7Crop(img,file,d.abs);

    const foot = h('div', { class: 'fd-lb-foot' });

    lightbox = h('div', {
      class: 'fd-lb',
      /* Backdrop click closes — but ONLY while not editing. A pan that ends
         with the pointer outside the frame releases on the backdrop, and
         throwing the edit away for that would be indistinguishable from a bug.
         And ONLY once it has been up for a beat: Ultralight synthesises a click
         on mouse-release for whatever is under the pointer by then, so a face
         clicked on Domains mounted this overlay and the same press closed it
         (Rober, 2026-09-21: "it opens then immediately closes"). The flyouts
         arm their outside-click on a tick for the same reason. */
      onClick: function () { if (!lbEdit && Date.now() - lbOpenedAt > 350) closeLightbox(); },
      title: 'Click anywhere to close',
    },
      h('div', {
        class: 'fd-lb-inner',
        // The controls live in here; a click on any of them must not reach the
        // backdrop handler above.
        onClick: function (e) { e.stopPropagation(); },
      },
        frame,
        d.name ? h('div', { class: 'fd-lb-cap' }, d.name) : null,
        foot,
      ),
    );
    document.body.appendChild(lightbox);

    lbEdit = null;
    renderLbFoot(d, file, img, frame, foot);
    if (startEditing) {
      if (d.cropScope!=='f7' && d.abs && !isBodyRender(file) && window.HDFaceFit) {
        d._startCrop = HDFaceFit.overrideFor(file) || HDFaceFit.cssFor(file) || cropFor(file);
        d._onCommit = function(c){facefitSaveOverride(file,c);};
      }
      beginCrop(d, file, img, frame, foot);
    }
  }

  /* GENERIC crop editor — the SAME lightbox + pan/zoom UI the follower roster
     uses, decoupled from follower state so another tab can reuse it verbatim.
     The Character tab drives its portrait framing through this: one code path,
     one crop invariant, one gesture set — no second copy to drift.

     opts = {
       src        image URL to edit (already view-relative, e.g.
                  'portraits/player-sheet.png?v=…')
       crop       { z, x, y } seed, or null for original framing
       name       caption under the photo (optional)
       aspect     the CONSUMER frame's width/height — the editor sizes its own
                  frame to match, so cover-fit crops the source the SAME way the
                  surface will (default 1 = square, the follower medallion). The
                  character portrait is 156x200, so it passes 156/200; without
                  this the square editor lies about a non-square thumbnail.
       baseline   the object-position the consumer shows with NO crop (default
                  '' = inherit the medallion's 50% 22% bias; the character
                  portrait shows '50% 50%'). The editor uses this at zoom 1 so
                  reframing an unmoved photo matches the thumbnail exactly.
       onSave(c)  called with the clamped crop, or null for "reset to original".
                  The caller OWNS storage and redraw; this closes on save/cancel.
     }
     Returns nothing; self-closing on Save, Cancel, backdrop click and Esc. */
  function openCropEditor(opts) {
    opts = opts || {};
    const src = String(opts.src || '');
    if (!src) return;
    closeLightbox();

    const img = h('img', { class: 'fd-lb-img', src: src, alt: opts.name || '', draggable: 'false' });
    /* A load failure here means the photo the caller thinks exists does not —
       close rather than leave a blank frame the user can drag emptily. */
    img.addEventListener('error', function () { closeLightbox(); });

    const dims = lbFrameDims(opts.aspect);
    const frame = h('div', { class: 'fd-lb-frame' }, img);
    frame.style.width = dims.w + 'px';
    frame.style.height = dims.h + 'px';

    const foot = h('div', { class: 'fd-lb-foot' });
    lightbox = h('div', {
      class: 'fd-lb',
      onClick: function () { if (!lbEdit) closeLightbox(); },
      title: 'Click anywhere to close',
    },
      h('div', { class: 'fd-lb-inner', onClick: function (e) { e.stopPropagation(); } },
        frame,
        opts.name ? h('div', { class: 'fd-lb-cap' }, opts.name) : null,
        foot,
      ),
    );
    document.body.appendChild(lightbox);
    lbEdit = null;

    /* A synthetic follower-shaped record. `file` is a stable synthetic key the
       roster's crop map will never hold, so nothing collides; _startCrop seeds
       the edit and _onCommit hands the result back to the owner. */
    const d = {
      _startCrop: opts.crop || null,
      _onCommit: typeof opts.onSave === 'function' ? opts.onSave : function () {},
      /* baseline threads to lbEdit.baseline so previewCrop shows the consumer's
         uncropped object-position; aspect is already baked into the frame px
         above, kept on d for the harness to assert the plumbing. */
      _baseline: (opts.baseline != null ? String(opts.baseline) : null),
      _aspect: (isFinite(Number(opts.aspect)) && Number(opts.aspect) > 0) ? Number(opts.aspect) : 1,
      name: opts.name || '',
    };
    const file = '__crop-editor__';
    beginCrop(d, file, img, frame, foot);
  }

  /* Not editing: one button, and the current framing spelled out so you can see
     at a glance whether this face carries a crop at all. */
  function renderLbFoot(d, file, img, frame, foot) {
    foot.textContent = '';
    const c = cropFor(file);
    if(d.cropScope==='f7'){
      foot.append(h('button',{class:'fd-lb-btn fd-lb-crop-btn',type:'button',onClick:function(e){e.stopPropagation();beginCrop(d,file,img,frame,foot);}},'Adjust F7 portrait'));
      if (d.abs && !isBodyRender(file)) foot.append(facefitAutoToggle(function () {
        d._startCrop = f7CropFor(file); paintF7Crop(img,file,true);
        renderLbFoot(d,file,img,frame,foot);
      }));
      appendRetakePhoto(d,foot);
      foot.append(h('span',{class:'fd-lb-val'},'F7 circle only · separate from roster and fullscreen crops'));
      return;
    }
    /* A facegen head render: its framing persists in the SHELF blob
       (facefitPrefs — the portrait crop store is pruned against portraits/
       and would drop icons/npcs keys), so the editor is real here. Two
       controls: ✎ Adjust HER framing (a per-NPC override, beats everything),
       and the DEFAULT framing dials (hd-facefit.js K/S, every un-overridden
       render on every tab follows them). The mini tile previews the effective
       framing live — the in-game twin of facefit.preview.html. */
    if (d && d.abs) {
      renderFaceFitFoot(d, file, img, frame, foot);
      const br = brightRow(file);
      if (br) foot.append(br);
      appendRetakePhoto(d, foot);
      return;
    }
    foot.append(h('button', {
      class: 'fd-lb-btn fd-lb-crop-btn', type: 'button',
      title: 'Pan and zoom this photo. Nothing is re-saved to disk — the deck '
           + 'remembers the framing and draws it everywhere this face appears.',
      onClick: function (e) { e.stopPropagation(); beginCrop(d, file, img, frame, foot); },
    }, 'Crop photo'));
    appendRetakePhoto(d, foot);
    foot.append(h('span', { class: 'fd-lb-val' }, c ? cropPhrase(c) : 'original framing'));
    const br = brightRow(file);
    if (br) foot.append(br);
  }

  /* ---- per-face BRIGHTNESS (Rober, 2026-09-23) -------------------------
     "the ability to turn up brightnes would be cool too". A per-FILE value in
     the facefit shelf slice (`bright`, keyed by bare file name), pushed into
     hd-facefit.js, which applies it wherever the face is drawn — roster, F7
     card, crew strip, and every other pane through ensure()/paintPortrait().
     ± buttons in 10% steps (the deck's no-range-input law), live: every image
     in the open lightbox repaints on each press, the rest on one debounced
     portraitsChanged(). Independent of the framing edit — it saves at once. */
  function setFaceBright(file, b) {
    const FF = window.HDFaceFit;
    if (!FF || !FF.setBrightness) return;
    b = FF.clampBrightness(b);
    const ff = (typeof facefitPrefs === 'function') ? facefitPrefs() : null;
    if (ff) {
      if (!ff.bright || typeof ff.bright !== 'object' || Array.isArray(ff.bright)) ff.bright = {};
      const k = FF.portraitKey(file);
      if (k) { if (b !== 1) ff.bright[k] = b; else delete ff.bright[k]; }
    }
    FF.setBrightness(file, b);
    if (typeof saveSoon === 'function') saveSoon();
    clearTimeout(faceFitRepaint);
    faceFitRepaint = setTimeout(function () { portraitsChanged(); }, 180);
  }

  function brightRow(file) {
    const FF = window.HDFaceFit;
    if (!FF || !FF.setBrightness || !file) return null;
    const val = h('b', { class: 'fd-lb-bright-val' });
    const btn = (glyph, tip, fn) => h('button', {
      class: 'fd-lb-btn', type: 'button', title: tip,
      onClick: function (e) { e.stopPropagation(); fn(); },
    }, glyph);
    const sync = function () {
      const b = FF.brightnessFor(file);
      val.textContent = Math.round(b * 100) + '%';
      rst.disabled = b === 1;
      dn.disabled = b <= FF.BRIGHT_MIN;
      up.disabled = b >= FF.BRIGHT_MAX;
      if (lightbox) Array.prototype.forEach.call(lightbox.querySelectorAll('img'),
        function (im) { FF.applyBrightness(im, file); });
    };
    const step = function (dv) { setFaceBright(file, FF.brightnessFor(file) + dv); sync(); };
    /* Worded, not ＋/－: the crop pad's zoom buttons already own those
       glyphs in the same overlay, and two identical "＋" a few pixels apart
       is a coin flip for the thumb (and for any script that finds them). */
    const dn = btn('Darker', 'Darker by 10%', function () { step(-0.1); });
    const up = btn('Brighter', 'Brighter by 10% — for a face that rendered too dark', function () { step(0.1); });
    const rst = btn('As rendered', 'Back to the brightness it was rendered at',
      function () { setFaceBright(file, 1); sync(); });
    const row = h('div', { class: 'fd-lb-bright' },
      h('span', { class: 'fd-lb-bright-lbl' }, 'Brightness'), dn, val, up, rst);
    sync();
    return row;
  }

  /* ---- the live "how it will look" column, beside the editor -----------
     Rober, 2026-09-23: "i would like if the popout reframe, would show to the
     right or something how the reframe will show in the little profile pic".
     Two circles at the sizes the deck actually draws her (the F7 card medal
     and a roster row), each a scaled copy of the editor frame: same image,
     same .fd-lb-frame .fd-lb-img cover fit, same paintCrop — percentage
     translate/scale is size-independent, so the small copy IS the medallion.
     Repainted by previewCrop on every drag, wheel and nudge. Follower faces
     only — the generic editor (Character portrait) is not a circle. */
  const PV_SIZES = [{ px: 92, label: 'F7 portrait' }, { px: 56, label: 'Roster row' }];
  function buildPreviewSide(img, file, scope) {
    const src = img.getAttribute('src') || img.src || '';
    const items = (scope==='f7'?PV_SIZES.slice(0,1):PV_SIZES.slice(1)).map(function (s2) {
      const pv = h('img', { class: 'fd-lb-img fd-lb-pv-img', src: src, alt: '', draggable: 'false' });
      if (window.HDFaceFit && HDFaceFit.applyBrightness) HDFaceFit.applyBrightness(pv, file);
      const fr = h('div', { class: 'fd-lb-frame fd-lb-pv' }, pv);
      const live = s2.label === 'F7 portrait' && document.querySelector('.fq-medal');
      const rect = live && live.getBoundingClientRect();
      const size = rect && rect.width > 0 ? rect.width : s2.px;
      fr.style.width = size + 'px';
      fr.style.height = size + 'px';
      return h('div', { class: 'fd-lb-pv-item' }, fr, h('div', { class: 'fd-lb-pv-lbl' }, s2.label));
    });
    const side = h('div', { class: 'fd-lb-side', onClick: function (e) { e.stopPropagation(); } },
      h('div', { class: 'fd-lb-side-t' }, 'How it will look'), items);
    const br = brightRow(file);
    if (br) side.append(br);
    return side;
  }

  // portrait-retake-setup: capture settings are a draft until Capture is pressed.
  let captureSetup = null, captureSerial = 0;
  function closePortraitCapture() {
    if (!captureSetup) return;
    const old=captureSetup;captureSetup=null;clearTimeout(old.timer);
    document.removeEventListener('keydown',old.key,true);
    if(old.root.parentNode)old.root.parentNode.removeChild(old.root);
    if(old.focus && old.focus.focus && document.contains(old.focus))old.focus.focus();
  }
  function openPortraitCapture(subject) {
    if(!subject || !subject.formId){toast('No NPC selected for the portrait');return;}
    closePortraitCapture();
    const focus=document.activeElement, inputs={}, outputs={}, modes={};let values=null,defaults=null,lighting=null,busy=false;
    const status=h('p',{class:'fd-capture-status',role:'status'},'Reading capture settings…');
    const take=h('button',{type:'button',class:'fd-lb-btn fd-capture-take',disabled:true,onClick:function(){
      if(!values||busy)return;
      busy=true;sync();status.textContent='Preparing capture…';
      toGame('fdPortrait',JSON.stringify({formId:subject.formId,framing:values,lighting:lighting,requestId:captureSetup.id}));
    }},'Start portrait');
    function sync(){
      Object.keys(inputs).forEach(function(k){inputs[k].disabled=!values||busy;if(values){inputs[k].value=String(k==='zoom'?Math.round(100/values.zoom):values[k]*100);outputs[k].textContent=k==='zoom'?(1/values.zoom).toFixed(1)+'×':Math.round(values[k]*100)+'%';}});
      take.disabled=!values||busy;
      Object.keys(modes).forEach(function(k){modes[k].disabled=!lighting||busy;modes[k].setAttribute('aria-pressed',String(!!lighting&&lighting.mode===k));});
      strength.disabled=!lighting||busy||lighting.mode==='natural';
      if(lighting){strength.value=String(Math.round(lighting.strength*100));strengthValue.textContent=Math.round(lighting.strength*100)+'%';}
      lightNote.textContent=!lighting?'Face-light controls need the updated SkyManager plugin.':lighting.mode==='natural'?'Use the room’s existing lighting.':'Temporary light follows your camera while you frame the face. It disappears after the shot or when you cancel.';
    }
    function dial(key,label,min,max){
      const input=h('input',{type:'range',min:String(min),max:String(max),step:'1',disabled:true,'aria-label':label,
        onInput:function(){if(!values||busy)return;values[key]=key==='zoom'?Math.max(.15,100/Number(input.value)):Number(input.value)/100;sync();}});
      const output=h('output');inputs[key]=input;outputs[key]=output;
      return h('label',{class:'fd-capture-dial'},h('span',null,label),input,output);
    }
    const lightModes=h('div',{class:'fd-capture-modes',role:'group','aria-label':'Face light'});
    [['natural','Natural','No added light'],['soft','Soft','Gentle face light'],['bright','Bright','Stronger fill']].forEach(function(m){
      modes[m[0]]=h('button',{type:'button',class:'fd-lb-btn',disabled:true,'aria-pressed':'false',onClick:function(){if(!lighting||busy)return;lighting.mode=m[0];sync();}},h('strong',null,m[1]),h('span',null,m[2]));
      lightModes.appendChild(modes[m[0]]);
    });
    const strength=h('input',{type:'range',min:'25',max:'300',step:'25',disabled:true,'aria-label':'Face-light brightness',onInput:function(){if(!lighting||busy||lighting.mode==='natural')return;lighting.strength=Number(strength.value)/100;sync();}});
    const strengthValue=h('output',null,'100%'),lightNote=h('p',{class:'fd-capture-note'});
    const cancel=h('button',{type:'button',class:'fd-lb-btn',onClick:function(){if(!busy)closePortraitCapture();}},'Cancel');
    const reset=h('button',{type:'button',class:'fd-lb-btn',onClick:function(){if(defaults&&!busy){values=Object.assign({},defaults);if(lighting)lighting={mode:'soft',strength:1};sync();}}},'Reset');
    const panel=h('div',{class:'fd-capture-panel',role:'dialog','aria-modal':'true','aria-label':'Portrait capture settings'},
      h('h2',null,'Retake '+(subject.name||'portrait')),
      h('div',{class:'fd-capture-body'},
        h('p',{class:'fd-capture-intro'},'Keep the NPC visible in front of you. Choose the light and framing, then line up the shot.'),
        h('div',{class:'fd-capture-columns'},
          h('section',{class:'fd-capture-framing'},h('h3',null,'Framing'),
            dial('zoom','Zoom',100,667),dial('offsetX','Horizontal position',-50,50),dial('offsetY','Vertical position',-50,50)),
          h('section',{class:'fd-capture-lighting'},h('h3',null,'Face light'),lightModes,
            h('label',{class:'fd-capture-dial'},h('span',null,'Light brightness'),strength,strengthValue),lightNote)),
        h('p',{class:'fd-capture-note'},'These settings affect the new photograph. Your F7 and fullscreen display crops stay separate.')),
      h('div',{class:'fd-capture-footer'},status,h('div',{class:'fd-capture-actions'},reset,cancel,take)));
    const root=h('div',{class:'fd-capture-setup',onClick:function(e){e.stopPropagation();}},panel);
    function key(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy)closePortraitCapture();}else if(e.key==='Tab'){
      const nodes=Array.from(panel.querySelectorAll('button,input')).filter(x=>!x.disabled);
      const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}e.stopPropagation();}}
    captureSetup={root:root,focus:focus,key:key,id:'portrait-'+(++captureSerial),load:function(f){
      if(values)return;clearTimeout(captureSetup.timer);
      values={zoom:f.zoom,offsetX:f.offsetX,offsetY:f.offsetY};defaults={zoom:f.defZoom,offsetX:f.defOffsetX,offsetY:f.defOffsetY};
      lighting=f.lighting?{mode:f.lighting.mode,strength:f.lighting.strength}:null;
      status.textContent='Start closes SkyManager. Frame the face, then Enter takes the photo. Esc cancels and returns.';sync();inputs.zoom.focus();
    },result:function(r){busy=false;status.textContent=r.message||'Capture could not start.';sync();}};
    document.body.appendChild(root);document.addEventListener('keydown',key,true);cancel.focus();
    captureSetup.timer=setTimeout(function(){if(captureSetup&&!values)status.textContent='No settings received. Cancel and reopen Retake to retry.';},8000);
    sync();
    toGame('fdFraming','{}');
  }
  window.fdCaptureSetupResult=function(raw){const r=coerce(raw);if(!r||!captureSetup||r.requestId!==captureSetup.id)return;
    if(r.ok)closePortraitCapture();else captureSetup.result(r);
  };

  function appendRetakePhoto(d, foot) {
    /* Retake (Rober, 2026-09-21: "a button would be nice to (retake image)"):
       the same fdPortrait verb the roster's ◉ menu item and the F7 card use —
       the deck closes, photographs her, and the new file lands as <slug>~n.png
       (a drawn portrait is memory-mapped and cannot be overwritten). Needs her
       formId; a caller that has none (an old harness) simply gets no button. */
    const fidHex = d && d.formId
      ? (typeof d.formId === 'number' ? '0x' + (d.formId >>> 0).toString(16).toUpperCase() : String(d.formId))
      : '';
    if (fidHex) {
      foot.append(h('button', {
        class: 'fd-lb-btn fd-lb-retake-btn', type: 'button',
        title: 'Choose zoom and position, then frame ' + (d.name || 'this NPC') + ' and press Enter to take the new portrait (Esc cancels).',
        onClick: function (e) {
          e.stopPropagation();
          closeLightbox();
          openPortraitCapture({formId:fidHex,name:d.name});
        },
      }, '◉ Retake photo'));
    }
  }

  /* ---- head-render framing foot (face-fit v3) -------------------------- */
  function facefitAutoToggle(onChange) {
    const FF = window.HDFaceFit;
    const enabled = !FF || !FF.isAutoEnabled || FF.isAutoEnabled();
    return h('button', {
      class:'fd-lb-btn fd-lb-auto-fit',type:'button',role:'switch',
      'aria-checked':String(enabled),'aria-label':'Auto-frame faces',
      title:'Adapt generated faces to their shape throughout SkyManager. Off shows complete heads. Your saved crops stay in place.',
      disabled:!FF || !FF.setAutoEnabled || typeof facefitPrefs !== 'function',
      onClick:function(e){
        e.stopPropagation();
        if (!FF || !FF.setAutoEnabled || typeof facefitPrefs !== 'function') return;
        const next = !FF.isAutoEnabled();
        facefitPrefs().auto = next;
        FF.setAutoEnabled(next);
        Object.keys(faceFit).forEach(function(key){if(!FF.overrideFor(key))delete faceFit[key];});
        if (typeof saveSoon === 'function') saveSoon();
        portraitsChanged();
        if (onChange) onChange();
        const control = lightbox && lightbox.querySelector('.fd-lb-auto-fit');
        if (control) control.focus();
      }
    }, 'Auto-frame faces: ' + (enabled ? 'On' : 'Off'));
  }

  function facefitSaveOverride(file, c) {
    const ff = (typeof facefitPrefs === 'function') ? facefitPrefs() : null;
    if (ff) {
      if (c) ff.files[file] = c;
      else delete ff.files[file];
    }
    if (window.HDFaceFit) window.HDFaceFit.setOverride(file, c || null);
    /* mirror the EFFECTIVE framing into the session map so applyCropTo
       (medallions, crew strip) agrees with the module immediately */
    const eff = window.HDFaceFit ? window.HDFaceFit.cssFor(file) : c;
    if (eff) faceFit[file] = eff; else delete faceFit[file];
    if (typeof saveSoon === 'function') saveSoon();
    portraitsChanged();
  }

  function renderFaceFitFoot(d, file, img, frame, foot) {
    const FF = window.HDFaceFit;
    /* mini live preview — a 56px roster-shaped tile framed like the rows */
    const mini = h('span', { class: 'fd-lb-mini' });
    mini.style.cssText = 'display:inline-block;width:56px;height:56px;border-radius:12px;' +
      'overflow:hidden;background:#101015;border:1px solid #2c2a24;flex:0 0 auto;';
    const mimg = h('img', { src: portraitSrc(d), alt: '', draggable: 'false' });
    mimg.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    mini.append(mimg);
    const paintMini = function () {
      if (FF) FF.ensure(mimg, file);   // measures once, then layout-paints
    };

    const adjust = h('button', {
      class: 'fd-lb-btn', type: 'button',
      title: 'Pan and zoom this face. Saved for this render only and remembered ' +
             'across sessions — it takes priority over automatic framing.',
      onClick: function (e) {
        e.stopPropagation();
        d._startCrop = (FF && (FF.overrideFor(file) || FF.cssFor(file))) || cropFor(file) || null;
        d._onCommit = function (c) { facefitSaveOverride(file, c); };
        beginCrop(d, file, img, frame, foot);
      },
    }, '✎ Adjust framing');

    foot.append(facefitAutoToggle(function(){renderLbFoot(d,file,img,frame,foot);}));

    /* default dials — ± buttons per the deck's no-range-input law */
    const dials = h('span', { class: 'fd-lb-val' });
    dials.style.cssText = 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;';
    const dialBtn = function (label, title, fn) {
      return h('button', { class: 'fd-lb-btn', type: 'button', title: title,
        onClick: function (e) { e.stopPropagation(); fn(); } }, label);
    };
    const readout = h('b', {});
    const syncReadout = function () {
      const p = FF ? FF.params() : { k: 0, s: 0 };
      readout.textContent = 'K ' + Number(p.k).toFixed(2) + ' · S ' + Number(p.s).toFixed(2);
    };
    const bump = function (dk, ds) {
      if (!FF || typeof facefitPrefs !== 'function') return;
      const cur = FF.params();
      const ff = facefitPrefs();
      ff.k = Math.round(Math.max(0.30, Math.min(0.90, cur.k + dk)) * 100) / 100;
      ff.s = Math.round(Math.max(0.70, Math.min(1.60, cur.s + ds)) * 100) / 100;
      FF.tune(ff.k, ff.s);            // clears measured fits; overrides survive
      if (typeof saveSoon === 'function') saveSoon();
      /* the pane's session map holds stale computed fits — drop those so
         cropFor re-mirrors the re-measured framing (overrides stay) */
      Object.keys(faceFit).forEach(function (k2) {
        if (!(FF.overrideFor(k2))) delete faceFit[k2];
      });
      syncReadout();
      paintMini();
      clearTimeout(faceFitRepaint);
      faceFitRepaint = setTimeout(function () {
        portraitsChanged();
      }, 220);
    };
    dials.append(
      h('span', {}, 'Default:'),
      dialBtn('▲', 'Face window higher on the head', function () { bump(-0.02, 0); }),
      dialBtn('▼', 'Face window lower on the head', function () { bump(+0.02, 0); }),
      dialBtn('−', 'Tighter on the face', function () { bump(0, -0.05); }),
      dialBtn('＋', 'More hair around the face', function () { bump(0, +0.05); }),
      readout,
      dialBtn('Reset', 'Back to the shipped framing defaults', function () {
        if (!FF || typeof facefitPrefs !== 'function') return;
        const d0 = FF.defaults();
        const ff = facefitPrefs();
        delete ff.k; delete ff.s;
        FF.tune(d0.k, d0.s);
        if (typeof saveSoon === 'function') saveSoon();
        Object.keys(faceFit).forEach(function (k2) {
          if (!(FF.overrideFor(k2))) delete faceFit[k2];
        });
        syncReadout();
        paintMini();
        portraitsChanged();
      }));
    if (FF && FF.isAutoEnabled && !FF.isAutoEnabled()) {
      Array.prototype.forEach.call(dials.querySelectorAll('button'),function(button){button.disabled=true;});
    }

    const row = h('div', {});
    row.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;';
    row.append(mini, adjust, dials);
    foot.append(row);
    const hint = h('div', { class: 'fd-lb-val' },
      (FF && FF.overrideFor(file))
        ? 'Saved framing — default adjustments leave it unchanged'
        : (FF && FF.isAutoEnabled && !FF.isAutoEnabled())
          ? 'Automatic framing is off — showing complete heads'
          : 'Adapts to each head — default adjustments apply across SkyManager');
    hint.style.marginTop = '6px';
    hint.style.whiteSpace = 'normal';
    hint.style.lineHeight = '1.4';
    foot.append(hint);
    syncReadout();
    paintMini();
  }

  /* ---- the crop editor -------------------------------------------------
     Everything is a BUTTON or a drag; there is no <input type=range> and no
     <select>, because in Ultralight the first is a poor target and the second
     renders but never opens (see rankRow for the same reasoning). The wheel is
     wired as a convenience only — every gesture it offers has a button beside
     it, so a click-only (gamepad-ish) flow reaches every value. */
  function beginCrop(d, file, img, frame, foot) {
    /* The starting crop is normally this FILE's stored crop. A GENERIC caller
       (openCropEditor — the Character tab's portrait editor) has no entry in
       state.crops for its file, so it hands us the seed on d._startCrop and the
       save destination on d._onCommit; both are absent for the follower path,
       which keeps its exact behaviour. */
    const start = (d && d._startCrop) ? clampCrop(d._startCrop) : cropFor(file);
    lbEdit = { file: file, z: start ? start.z : 1, x: start ? start.x : 0, y: start ? start.y : 0 };
    /* The target surface's identity object-position — the editor must show the
       SAME uncropped baseline the consumer shows, or reframing lies at zoom 1.
       Follower path: absent -> the medallion's '' (stylesheet 50% 22% bias).
       Character portrait: openCropEditor sets d._baseline = '50% 50%'. */
    lbEdit.baseline = (d && d._baseline != null) ? d._baseline : MEDAL_IDENTITY_BASELINE;
    /* Everything the keyboard path needs to finish the edit. onKey sees only
       `lbEdit`, and re-deriving these five from the DOM would be a second,
       drift-prone way of naming the same nodes. onCommit rides along so
       commitCrop can route a generic edit to its owner instead of state.crops. */
    lbEdit.ctx = { d: d, file: file, img: img, frame: frame, foot: foot,
                   onCommit: (d && typeof d._onCommit === 'function') ? d._onCommit : null };
    img._hdPreviewOwned = true;
    frame.classList.add('editing');
    if (file !== '__crop-editor__' && frame.parentNode && !lbEdit.side) {
      const inner = frame.parentNode;
      const stage = h('div', { class: 'fd-lb-stage' });
      inner.insertBefore(stage, frame);
      lbEdit.side = buildPreviewSide(img, file, d.cropScope);
      stage.append(frame, lbEdit.side);
      if (inner.classList) inner.classList.add('has-side');
    }
    renderCropFoot(d, file, img, frame, foot);
    wireCropGestures(d, file, img, frame, foot);
    /* Paint the seed so the image opens already showing lbEdit's framing. A
       no-op for the follower path (openLightbox applied the same crop first),
       and the one thing that makes a generic seed visible on open. */
    previewCrop(img, foot);
  }

  /* Apply lbEdit to the on-screen image WITHOUT re-rendering anything. Same
     rule as rankRow's preview: rebuilding the UI mid-gesture would replace the
     element the pointer is on and the drag would die on its first pixel. */
  function previewCrop(img, foot) {
    if (!lbEdit) return;
    const c = clampCrop(lbEdit);
    lbEdit.z = c ? c.z : 1;
    lbEdit.x = c ? c.x : 0;
    lbEdit.y = c ? c.y : 0;
    /* WYSIWYG: preview through the exact same funnel the consumers use, with
       the SAME identity baseline the target surface shows when uncropped
       (lbEdit.baseline — '' for the round medallion's 50% 22% bias, '50% 50%'
       for the character portrait). The editor frame's aspect is matched to the
       surface in openLightbox/openCropEditor, so identical {z,x,y} => identical
       picture. Kept off the roster's cropFor path — the editor drives the img
       directly from lbEdit. */
    const head = lbEdit.ctx.d.abs && !isBodyRender(lbEdit.file) && window.HDFaceFit && HDFaceFit.paintHeadCrop;
    const paintPreview = function(node){
      if (head) HDFaceFit.paintHeadCrop(node,c);
      else paintCrop(node,c,(lbEdit.baseline != null ? lbEdit.baseline : MEDAL_IDENTITY_BASELINE));
    };
    paintPreview(img);
    if (lbEdit.side) Array.prototype.forEach.call(lbEdit.side.querySelectorAll('.fd-lb-pv-img'), function (pv) {
      paintPreview(pv);
    });
    const val = foot.querySelector('.fd-lb-val');
    if (val) val.textContent = cropPhrase(c);
    const rst = foot.querySelector('.fd-lb-reset');
    if (rst) rst.disabled = !c;
  }

  function nudgeCrop(img, foot, dz, dx, dy) {
    if (!lbEdit) return;
    if (dz) lbEdit.z = lbEdit.z * dz;
    if (dx) lbEdit.x = lbEdit.x + dx;
    if (dy) lbEdit.y = lbEdit.y + dy;
    previewCrop(img, foot);
  }

  function renderCropFoot(d, file, img, frame, foot) {
    foot.textContent = '';
    const btn = (glyph, tip, fn, cls) => h('button', {
      class: 'fd-lb-btn' + (cls ? ' ' + cls : ''), type: 'button', title: tip,
      onClick: function (e) { e.stopPropagation(); fn(); },
    }, glyph);

    const pad = h('div', { class: 'fd-lb-pad' },
      btn('＋', 'Zoom in — closer on the face', () => nudgeCrop(img, foot, CROP_ZSTEP, 0, 0)),
      btn('－', 'Zoom out — more of the photo', () => nudgeCrop(img, foot, 1 / CROP_ZSTEP, 0, 0)),
      btn('◀', 'Move the photo left', () => nudgeCrop(img, foot, 0, -CROP_PAN_STEP, 0)),
      btn('▲', 'Move the photo up', () => nudgeCrop(img, foot, 0, 0, -CROP_PAN_STEP)),
      btn('▼', 'Move the photo down', () => nudgeCrop(img, foot, 0, 0, CROP_PAN_STEP)),
      btn('▶', 'Move the photo right', () => nudgeCrop(img, foot, 0, CROP_PAN_STEP, 0)),
    );

    const reset = btn('⟲ Reset', 'Back to the photo as it was taken',
      () => { lbEdit.z = 1; lbEdit.x = 0; lbEdit.y = 0; previewCrop(img, foot); }, 'fd-lb-reset');
    reset.disabled = !clampCrop(lbEdit);

    foot.append(pad, reset,
      btn('✓ Save', d.cropScope==='f7'?'Save only this F7 circle’s framing':'Use this framing everywhere this face is drawn',
        () => commitCrop(d, file, img, frame, foot), 'ok'),
      btn('✕ Cancel', 'Leave the framing as it was',
        () => cancelCrop(d, file, img, frame, foot)),
      h('span', { class: 'fd-lb-val' }, cropPhrase(clampCrop(lbEdit))),
      h('div', { class: 'fd-lb-hint' },
        d.cropScope==='f7'?'Drag or zoom to frame the F7 circle. Roster and fullscreen crops stay unchanged.':
        'Drag the photo to move it · wheel or ＋/－ to zoom · this changes how the '
        + 'deck DRAWS it, the file on disk is untouched'));
  }

  function wireCropGestures(d, file, img, frame, foot) {
    let dragging = false, lastX = 0, lastY = 0;
    /* Gain: one pixel of pointer travel moves the photo one pixel, which is the
       only mapping that feels like dragging a photo. x is a fraction of the
       frame's WIDTH and y a fraction of its HEIGHT, so the divisors are
       PER-AXIS — for the square follower frame they are equal, but the 156x200
       character portrait frame would drag vertically twice as fast as
       horizontally if it used one number for both. offset* first, the lbFrameDims
       fallback (from lbEdit's aspect) for the harness where layout is 0. */
    const fbDims = lbFrameDims(lbEdit && lbEdit.ctx && lbEdit.ctx.d && lbEdit.ctx.d._aspect);
    const fw = frame.offsetWidth || fbDims.w;
    const fh = frame.offsetHeight || fbDims.h;

    frame.addEventListener('mousedown', function (e) {
      if (!lbEdit) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      frame.classList.add('dragging');
    });
    /* Listened on the DOCUMENT, not the frame: at high zoom the pointer leaves
       the frame long before the pan hits its limit, and a move handler bound to
       the frame would stop tracking exactly when the gesture gets interesting. */
    const onMove = function (e) {
      if (!dragging || !lbEdit) return;
      const dx = (e.clientX - lastX) / fw;
      const dy = (e.clientY - lastY) / fh;
      lastX = e.clientX; lastY = e.clientY;
      /* At 1x zoom there is no slack to pan into — the live clamp zeroes every
         move, so the drag felt silently dead (Rober, 2026-08-14: "reframe
         didn't [move] when I tried to edit my character's face"). Say so once
         instead of eating the gesture. */
      if (lbEdit.z <= 1.0001) {
        lbEdit.panTravel = (lbEdit.panTravel || 0) + Math.abs(dx) + Math.abs(dy);
        if (lbEdit.panTravel > 0.04 && !lbEdit.panHint) {
          lbEdit.panHint = true;
          toast('Zoom in first — mouse wheel or the ＋ button — then drag to reframe');
        }
      }
      lbEdit.x += dx; lbEdit.y += dy;
      previewCrop(img, foot);
    };
    const onUp = function () {
      if (!dragging) return;
      dragging = false;
      frame.classList.remove('dragging');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    /* The listeners outlive the frame unless we take them off — and the deck
       reopens this overlay many times a session. Hang the teardown off lbEdit
       so every exit path (Save, Cancel, Esc, tab change) runs it exactly once. */
    lbEdit.unwire = function () {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    frame.addEventListener('wheel', function (e) {
      if (!lbEdit) return;
      e.preventDefault(); e.stopPropagation();
      nudgeCrop(img, foot, e.deltaY < 0 ? CROP_ZSTEP : 1 / CROP_ZSTEP, 0, 0);
    });
  }

  function endCropMode(frame) {
    if (lbEdit && lbEdit.ctx) lbEdit.ctx.img._hdPreviewOwned = false;
    if (lbEdit && lbEdit.unwire) lbEdit.unwire();
    lbEdit = null;
    if (frame) frame.classList.remove('editing', 'dragging');
    /* Unwrap the preview column: the view foot is framed around the photo
       alone, and a stale column would show a crop that was just cancelled. */
    const stage = frame && frame.parentNode;
    if (stage && stage.classList && stage.classList.contains('fd-lb-stage') && stage.parentNode) {
      const inner = stage.parentNode;
      inner.insertBefore(frame, stage);
      inner.removeChild(stage);
      if (inner.classList) inner.classList.remove('has-side');
    }
  }

  function cancelCrop(d, file, img, frame, foot) {
    /* GENERIC caller opens straight into edit mode and owns no lightbox chrome
       of its own — cancelling means "leave the framing as it was and close",
       not "drop back to a view foot that reads state.crops (empty here)". */
    if (d && typeof d._onCommit === 'function') { endCropMode(frame); closeLightbox(); return; }
    endCropMode(frame);
    applyCropTo(img, file);        // back to whatever is stored
    renderLbFoot(d, file, img, frame, foot);
  }

  function commitCrop(d, file, img, frame, foot) {
    const c = clampCrop(lbEdit);
    const onCommit = lbEdit && lbEdit.ctx && lbEdit.ctx.onCommit;
    endCropMode(frame);
    /* GENERIC caller (Character tab portrait): it owns the storage and the
       redraw. Hand it the clamped crop (or null for "reset to original"),
       repaint the lightbox image, and stop — none of the follower-roster
       machinery below applies. */
    if (onCommit) {
      onCommit(c);         // owner stores + redraws its own portrait
      closeLightbox();     // save-and-close; the owning tab shows the result
      return;
    }
    /* Optimistic: the map is updated here and every drawn face repaints now.
       C++ owns the file, so it will push the authoritative map back as fdCrops
       — including a prune we cannot compute here — and that push wins. */
    if (c) state.crops[file] = c;
    else delete state.crops[file];
    /* Same beat as the store itself, so a crop the user just set is live on
       every other surface without waiting for a config round-trip. */
    if (window.HDFaceFit && HDFaceFit.setPortraitCrop) HDFaceFit.setPortraitCrop(file, c);
    window.dispatchEvent(new CustomEvent('hd-portrait-crops-changed'));
    portraitsChanged();
    /* `clear` rather than a z=1 crop, so C++ never has to decide whether an
       identity crop means "remove me" — the two are the same thing and saying
       so explicitly keeps the map free of no-op rows. */
    toGame('fdCropSave', JSON.stringify(c
      ? { file: file, z: c.z, x: c.x, y: c.y }
      : { file: file, clear: true }));
    applyCropTo(img, file);
    renderLbFoot(d, file, img, frame, foot);
    toast(c ? 'Framing saved' : 'Framing reset');
  }

  /* ---- model helpers ---- */

  function catByIndex(i) { return state.cats.find((c) => c.index === i) || null; }
  function catLabel(c) { return c.name || c.original || ('Category ' + c.index); }

  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }
  function hueOf(catIndex) { return (catIndex * 47) % 360; }

  /* ---- NPC field helpers ---- */

  /* "home_town" -> "Home town". Only ever used for a key the spec above does
     NOT know: something typed by a future version of this list, by the Deck
     Portal, or by hand in the JSON. It still gets a labelled, editable row. */
  function prettyKey(k) {
    const s = String(k || '').replace(/[_-]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(k || '');
  }

  /* Every row the member's field editor should show: the spec in spec order
     first (blank when unset), then anything else already stored, alphabetically.
     Nothing the user ever typed is dropped, whatever the spec looks like now. */
  function fieldRows(m) {
    const have = (m && m.fields) || {};
    const seen = {};
    const out = FIELDS.map(function (f) {
      seen[f.key] = true;
      return { key: f.key, label: f.label, hint: f.hint || '', spec: true,
               value: typeof have[f.key] === 'string' ? have[f.key] : '' };
    });
    Object.keys(have).sort().forEach(function (k) {
      if (seen[k]) return;
      out.push({ key: k, label: prettyKey(k), hint: '', spec: false, value: have[k] });
    });
    return out;
  }

  function fieldValue(m, key) {
    const have = (m && m.fields) || {};
    return typeof have[key] === 'string' ? have[key] : '';
  }

  /* One field write. "" erases the key on FO's side, so clearing the box is a
     delete and never leaves a dangling "" in FollowerOrganizer.json. */
  /* Name and Note travel the same road as every NPC field — into FO's own
     JSON, written by FO's serializer — but DeckAPI's renameMember/setDesc pass
     the string through with NO bound, while setField clamps to 300 and says
     why in its own comment (a stray byte there lands invalid UTF-8 in the file
     FO writes, and FO's dump() does not replace it the way ours does). Same
     road, same limit: cap here so the view can never be the thing that sends
     an unbounded string, and cut on a whole code point so a clamp can't split
     a surrogate pair into two invalid halves.
     NOTE: this is the UI half of the fix. The C++ side is still unbounded —
     the portal and a hand-edited JSON can both reach it. */
  function clampText(raw) {
    let v = String(raw == null ? '' : raw).trim();
    if (v.length <= FIELD_VALUE_MAX) return v;
    let cut = FIELD_VALUE_MAX;
    // never end on a lone high surrogate
    const c = v.charCodeAt(cut - 1);
    if (c >= 0xD800 && c <= 0xDBFF) cut -= 1;
    return v.slice(0, cut).trim();
  }

  function saveField(row, key, raw) {
    if (!FIELD_KEY_RE.test(key)) {
      toast('⚠ “' + key + '” isn\'t a usable field key (a–z, 0–9, _ and -)');
      return false;
    }
    let value = String(raw == null ? '' : raw).trim();
    if (value.length > FIELD_VALUE_MAX) value = value.slice(0, FIELD_VALUE_MAX);
    sendApply('setField', { cat: row.cat, idx: row.idx, key: key, value: value });
    return true;
  }

  /* Portrait file slug. MUST stay identical to the two other implementations
     of this rule — portal/server.js slugOf() and the names in
     portraits/README.txt:
       lowercase -> strip diacritics -> each run of non [a-z0-9] becomes one
       '-' -> trim leading/trailing '-'.
     Always computed from the ORIGINAL name, never the display name: people
     get renamed in the deck constantly, and the file must keep matching. */
  /* ==================================== NFF / My Home Is Your Home ======= *
   *  Strictly READ-ONLY, and strictly separate from the hand-typed `home`
   *  FIELD above. Those are two different facts — what the game thinks and
   *  what you wrote — and one must never overwrite the other. The typed field
   *  stays in the member menu; this one gets its own row chip and its own
   *  place in the search haystack.
   * ======================================================================= */

  const HOME_SRC = { nff: 'NFF', mhiyh: 'MHIYH' };

  /* Where she is, as a PICTURE (Rober, 2026-09-17: "need to show a icon for
     house and icon for location currently"). Byte-identical vocabulary to
     hud.js's own `loc` map — one shipped icon set, two readouts, and a kind the
     set has no art for keeps the glyph rather than painting the wrong house.
     `loc-ruin`, `loc-wild` and `loc-shipwreck` do not exist, so interior /
     wilderness / stronghold / mill / town / settlement / dragon fall through. */
  const WHERE_ICON = {
    inn: 'loc-inn', house: 'loc-home', home: 'loc-home', store: 'loc-shop',
    city: 'loc-city', cave: 'loc-cave', barrow: 'loc-dungeon', dungeon: 'loc-dungeon',
    jail: 'loc-jail', fort: 'loc-fort', palace: 'loc-palace', temple: 'loc-temple',
    mine: 'loc-mine', camp: 'loc-camp', ship: 'loc-ship', farm: 'loc-farm',
  };

  /* ===================================== My Home is Your Home: the day ==== *
   *  THE activity spec — one list, here, exactly like FIELDS above. C++ sends
   *  only MHiYH's own kind NUMBER (MMTYHNative.psc's public numbering) plus a
   *  place and a now-flag, so relabelling, reordering or re-glyphing the day
   *  is a VIEW edit: no DLL rebuild.
   *
   *    k     MHiYH kind number — the wire key. Do not renumber.
   *    label what the stop is called in the stepper (a noun)
   *    verb  what she is DOING, for the "now" chip (a phrase)
   *    ic    glyph, drawn from the set the deck already uses elsewhere
   *    pri   headline tie-break when several are in force at once
   *
   *  Order in this array IS the order of the day. It is the natural arc
   *  (sleep -> breakfast -> work -> lunch -> dinner -> guard -> home) rather
   *  than MHiYH's numbering, because the stepper is read top-to-bottom as a
   *  day. Home sits last: it is the base state she falls back to, not an
   *  appointment.
   *
   *  `pri`: NG can legitimately have several kinds in force at once (Home is
   *  usually in force underneath everything else). The chip names the most
   *  SPECIFIC one, so Home is lowest and Sleep highest.
   * ======================================================================== */
  const ACTS = [
    { k: 1, label: 'Sleep',     verb: 'Sleeping',      ic: '☾', pri: 7 },
    { k: 4, label: 'Breakfast', verb: 'At breakfast',  ic: '☀', pri: 6 },
    { k: 2, label: 'Work',      verb: 'Working',       ic: '⚒', pri: 4 },
    { k: 5, label: 'Lunch',     verb: 'At lunch',      ic: '◑', pri: 6 },
    { k: 6, label: 'Dinner',    verb: 'At dinner',     ic: '✦', pri: 6 },
    { k: 3, label: 'Guard',     verb: 'On guard',      ic: '⚔', pri: 3 },
    { k: 7, label: 'Watch',     verb: 'Keeping watch', ic: '⚐', pri: 2 },
    { k: 0, label: 'Home',      verb: 'At home',       ic: '⌂', pri: 1 },
  ];

  /* kind number -> spec entry, plus its position in the day. Built once. */
  const ACT_BY_K = {};
  ACTS.forEach(function (a, i) { a.order = i; ACT_BY_K[a.k] = a; });

  /* A kind C++ sent that this build's spec doesn't know (a future NG activity)
     still gets a row rather than vanishing — same principle as an unknown NPC
     field key. It sorts to the end and is labelled honestly. */
  function actSpec(k) {
    return ACT_BY_K[k] || { k: k, label: 'Activity ' + k, verb: 'Busy',
                            ic: '•', pri: 0, order: 100 + k };
  }

  /* The entry C++ sent for one member, or null. FO formats formIds as
     "0x%08X"; we lowercase both sides so a future casing change can't quietly
     turn every chip off. */
  function nffEntry(formId) {
    const k = String(formId || '').toLowerCase();
    if (!k) return null;
    const e = state.nff.members[k];
    return (e && typeof e === 'object') ? e : null;
  }

  /* Fold the entry onto a normalised member: one displayed home (NFF wins,
     because an NFF base is an explicit assignment, while MHiYH's linked ref is
     often just wherever they were last told to sleep), plus the other one kept
     for the tooltip, plus BOTH names in the search text. Called from
     normMember AND again from fdNff, so the two pushes may arrive in either
     order and the result is the same. */
  function mergeHome(m) {
    const e = nffEntry(m.formId);
    const nffHome = (e && e.nff && e.nff.home && e.nff.home.name) ? String(e.nff.home.name) : '';
    const mhHome = (e && e.mhiyh && e.mhiyh.home && e.mhiyh.home.name) ? String(e.mhiyh.home.name) : '';
    const nffIdx = (e && e.nff && e.nff.home && typeof e.nff.home.i === 'number') ? e.nff.home.i : -1;

    /* The REFERENCE C++ actually read this entry off. Normally the same id we
       asked with — but for a row whose stored form is a BASE record (a follower
       spawned at runtime: FO cannot persist a 0xFF ref and files her NPC_
       instead) it is the live actor nff_bridge found for that base. Every
       actor-keyed op must send THIS, because the base id addresses nobody. */
    m.liveFormId = (e && typeof e.liveId === 'string') ? e.liveId : '';

    m.nffManaged = !!(e && e.nff && e.nff.managed);
    m.nffOutfit = !!(e && e.nff && e.nff.outfit && e.nff.outfit.has);
    /* Her own sandbox checkbox (NFF's per-follower MCM one, a rank on
       nwsFF_BoxFaction). Absent means the payload predates it OR NFF is not
       here — both read as NFF's own default, which is allowed. */
    /* Told to wait — following you on paper, but parked somewhere. The party
       strip separates them, because "who is at my back" and "who is on the
       roster" are different questions and the first one is why you opened it. */
    m.waiting = !!(e && e.waiting);
    m.sandboxOn = !(e && e.nff && e.nff.sandbox === false);
    m.sandboxKnown = !!(e && e.nff && typeof e.nff.sandbox === 'boolean');

    /* What she is to the PLAYER — two different mods' answers, kept apart.
       `relHas` and `relRank` are the ENGINE's RELA rank; the pair is not one
       fact, because a stranger with no record and a deliberate Acquaintance
       both read 0 and only one of them is an opinion (see src/relationship.h).
       `spouse` is M.A.R.A.S's marriage state, which knows nothing about rank —
       you can be married at Foe, and MARAS's own MCM will tell you so.
       C++ only emits the slice when there is something to say, so absent means
       "stranger", never "the read failed". */
    const rl = (e && e.rel && typeof e.rel === 'object') ? e.rel : null;
    m.relHas = !!(rl && rl.has);
    m.relRank = (rl && typeof rl.rank === 'number') ? rl.rank : 0;
    m.spouse = !!(rl && rl.spouse);
    /* Searchable. "lover" finds the people the GAME ranks that way and "spouse"
       / "married" finds the ones MARAS has you wed to — neither of which is
       necessarily what you typed in her Relationship field. */
    m.relText = ((m.relHas ? rankLabel(m.relRank) : '') +
                 (m.spouse ? ' spouse married wife husband maras' : '')).toLowerCase();

    /* Where she is, or was last seen. NOT the same question as her home, and
       not the same as the MHiYH "doing now" chip — those only exist for
       followers that mod manages. `whereLoaded` false means the cell is her
       last known one rather than somewhere she is standing in front of you,
       which is precisely the case worth saying out loud. */
    m.where = (e && typeof e.where === 'string') ? e.where : '';
    m.whereLoaded = !!(e && e.loaded);
    /* What KIND of place that is, so the chip can wear the shipped loc-* icon
       instead of a bare diamond. Same closed vocabulary as the HUD's place
       readout (C++ Widgets::PlaceKindOf); '' when the game had no answer. */
    m.whereKind = (e && typeof e.whereKind === 'string') ? e.whereKind : '';
    /* MHiYH's home specifically, kept apart from the DISPLAYED home above —
       which may be NFF's. Every write action in the day panel hangs off this
       one fact (MHiYH's own SetAreaMarker refuses every other stop until the
       home exists), and an NFF base is not a MHiYH home. */
    m.mhHome = mhHome;
    /* Kept SEPARATELY as well as folded into homeName below. The "send her
       to…" picker has to offer the two homes as two different destinations
       (they are different markers, resolved by different mods), and homeName
       deliberately collapses them to whichever wins the chip. Reading homeSrc
       to work out which one homeName currently means is the kind of inference
       that silently sends someone to the wrong province. */
    m.nffHome = nffHome;
    m.homeName = nffHome || mhHome;
    m.homeSrc = nffHome ? HOME_SRC.nff : (mhHome ? HOME_SRC.mhiyh : '');
    m.homeIdx = nffHome ? nffIdx : -1;
    // The one not shown, only when it says something different — a chip that
    // repeats itself in its own tooltip is noise.
    m.homeAlt = (nffHome && mhHome && mhHome !== nffHome) ? mhHome : '';

    /* ---- the day (My Home is Your Home NG only) ----
       Tolerant of everything: a missing "acts", a non-array, an entry with no
       place, a kind this build has never heard of. Anything unusable is
       dropped rather than propagated, so every reader below can assume a
       plain sorted array of { k, spec, place, now }. */
    const rawActs = (e && e.mhiyh && Array.isArray(e.mhiyh.acts)) ? e.mhiyh.acts : [];
    const acts = [];
    rawActs.forEach(function (a) {
      if (!a || typeof a !== 'object') return;
      const k = (typeof a.k === 'number') ? a.k : parseInt(a.k, 10);
      if (!isFinite(k) || k < 0) return;
      acts.push({
        k: k,
        spec: actSpec(k),
        place: typeof a.place === 'string' ? a.place : '',
        now: !!a.now,
      });
    });
    acts.sort(function (x, y) { return x.spec.order - y.spec.order; });
    m.acts = acts;

    /* The headline: the most SPECIFIC activity in force. Home is in force
       under almost everything, so a plain "first now wins" would say "At
       home" while she is asleep in it. */
    let now = null;
    acts.forEach(function (a) {
      if (a.now && (!now || a.spec.pri > now.spec.pri)) now = a;
    });
    m.nowAct = now;

    /* Places are searchable — typing a tavern finds whoever EATS there, not
       just whoever lives there. */
    const places = acts.map(function (a) { return a.place; }).filter(Boolean);
    /* m.where joins the same haystack, so "who is in Whiterun right now"
       is a search rather than a scroll. */
    m.homeText = (m.homeName + '\n' + m.homeAlt + '\n' + m.where + '\n'
                  + places.join('\n')).toLowerCase();
    return m;
  }

  /* Re-apply over the roster already in memory. */
  function remergeHomes() {
    state.cats.forEach(function (c) { c.members.forEach(mergeHome); });
  }

  function homeTitle(m) {
    if (!m.homeName) return '';
    const lead = m.homeSrc === HOME_SRC.nff
      ? ("Nether's Follower Framework home base" + (m.homeIdx >= 0 ? ' ' + (m.homeIdx + 1) : ''))
      : 'My Home is Your Home';
    let t = lead + ': ' + m.homeName;
    if (m.homeAlt) t += '\nMy Home is Your Home: ' + m.homeAlt;
    return t + '\n(read from the mod — not the Home field you type here)';
  }

  /* ONE quiet chip. Neutral .fd-chip palette on purpose: the gold is already
     spoken for by Relationship, and a second gold chip would flatten the row's
     hierarchy. The ⌂ glyph (borrowed from the Domains pane's place chips) is
     what tells it apart from the category chip at a glance, and the small
     source tag says which mod is talking. */
  /* WHERE SHE IS — the plain question the roster could not answer.
   *
   *  Deliberately not merged into the home chip: home is where she LIVES and
   *  where "send her home" goes, this is where she is standing, and conflating
   *  them would make both untrustworthy. Suppressed when it merely repeats the
   *  home name, since a chip that duplicates its neighbour is noise.
   *
   *  A DIMMED chip means the actor is not 3D-loaded — so the cell is her last
   *  known one, not a live sighting. Saying that visually is the whole point:
   *  "Riverwood" for someone three holds away would otherwise read as fact. */
  /* An icon box: the glyph always, with the shipped painting layered over it
     when the place's kind has art. A dead path removes itself and uncovers the
     glyph, so a missing PNG is never a broken-image box — the same idiom
     hud.js uses for its own loc-* set. */
  function placeIcon(kind, glyph, cls) {
    const box = h('span', { class: cls, 'aria-hidden': 'true' }, glyph);
    const file = WHERE_ICON[kind];
    if (!file) return box;
    const img = h('img', {
      class: 'fd-loc-img', src: 'icons/custom/' + file + '.png', alt: '', draggable: 'false',
    });
    img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); });
    box.append(img);
    return box;
  }

  function whereChip(m, q) {
    if (!m.where) return null;
    if (m.homeName && m.where === m.homeName) return null;
    const chip = h('span', {
      class: 'fd-chip fd-chip-where' + (m.whereLoaded ? '' : ' stale'),
      title: m.whereLoaded ? ('Here now: ' + m.where)
                           : ('Last known: ' + m.where + '\nNot loaded right now, so this is where '
                              + 'the game still has them — not a live sighting.'),
    });
    chip.append(placeIcon(m.whereKind, m.whereLoaded ? '◈' : '◇', 'fd-where-ic'));
    /* ⚠ SAY IT IN WORDS. Live and last-known used to differ by a hollow vs a
       filled diamond and a 20% shift in the icon's colour, which at chip size
       on a couch is no difference at all (Rober, 2026-09-17, on the same class
       of complaint as the chevron). The distinction is fact vs guess, so it
       gets a word — a guess must never read as a sighting. */
    if (!m.whereLoaded)
      chip.append(h('span', { class: 'fd-where-last' }, 'last'));
    chip.append(h('span', { class: 'fd-where-name' }, nameNodes(m.where, q)));
    return chip;
  }

  function homeChip(m, q) {
    if (!m.homeName) return null;
    const chip = h('span', {
      class: 'fd-chip fd-chip-home',
      data: { src: m.homeSrc },
      title: homeTitle(m),
    });
    chip.append(placeIcon('home', '⌂', 'fd-home-ic'));
    const nm = h('span', { class: 'fd-home-name' }, nameNodes(m.homeName, q));
    chip.append(nm);
    chip.append(h('span', { class: 'fd-home-src' }, ' · ' + m.homeSrc));
    /* Palette, width and the source tag's type all live in app.css now. They
       were inline, which pinned the chip at a hardcoded 170px — so it ignored
       the avatar scale, and because the whole chip ellipsized as one blob the
       part that got cut was the TAIL: "The Bannered Mare · M…". The source tag
       is the one thing here that must never truncate — it says which mod is
       talking — so the CSS makes the PLACE the shrinkable part instead. */
    /* app.css styles <mark> per container and has no global reset, so a search
       hit in a NEW container would paint the browser's default yellow block —
       same neutralisation the relationship chip does. */
    const marks = chip.querySelectorAll ? chip.querySelectorAll('mark') : [];
    for (let mi = 0; mi < marks.length; mi++) {
      marks[mi].style.background = 'transparent';
      marks[mi].style.color = '#ecd9a0';
      marks[mi].style.fontWeight = '700';
    }
    return chip;
  }

  /* ---- EVERYONE Fertility Mode tracks (2026-09-14) ----------------------
     fmAllResult is the whole-map twin of fdFertility: keyed by reference
     (runtime formId) AND by base record ("<plugin>|<LOCAL6HEX>", the NPC
     Finder's row id), so a person with no Follower Organizer row — a Finder
     row, or whoever is in the crosshair — can still wear the ◍. Asked for on
     demand (ensureFertAll, 8 s throttle), never pushed unprompted. */
  const fertAll = { byRef: Object.create(null), byBase: Object.create(null),
                    list: [], known: false, available: false, at: 0 };
  const FERT_ALL_TTL = 8000;
  function ensureFertAll(force) {
    const now = Date.now();
    if (!force && fertAll.at && (now - fertAll.at) < FERT_ALL_TTL) return;
    fertAll.at = now;
    toGame('fmAll', '');
  }
  /* { formId?, base? } -> status | null (known, not tracked) | undefined (nothing answered yet) */
  function fertFor(ident) {
    if (!fertAll.known) return undefined;
    if (!ident) return null;
    const fid = Number(ident.formId) >>> 0;
    if (fid && fertAll.byRef[fid]) return fertAll.byRef[fid];
    const b = String(ident.base || '').trim().toLowerCase();
    if (b && fertAll.byBase[b]) return fertAll.byBase[b];
    return null;
  }
  window.fmAllResult = function (env) {
    env = coerce(env);
    if (!env || !env.ok) return;
    const actors = (env.actors && typeof env.actors === 'object') ? env.actors : {};
    const byRef = Object.create(null), byBase = Object.create(null), list = [];
    Object.keys(actors).forEach(function (k) {
      const v = actors[k];
      if (!v || typeof v !== 'object') return;
      const fid = Number(v.ref || k) >>> 0;
      if (fid) byRef[fid] = v;
      const b = String(v.base || '').trim().toLowerCase();
      /* two refs sharing one base (a non-unique NPC) — the base key is then
         ambiguous, so it is dropped rather than pointing at the wrong woman */
      if (b) byBase[b] = Object.prototype.hasOwnProperty.call(byBase, b) ? null : v;
      list.push(v);
    });
    fertAll.byRef = byRef; fertAll.byBase = byBase; fertAll.list = list;
    fertAll.known = true; fertAll.available = !!env.available; fertAll.at = Date.now();
    try { window.dispatchEvent(new CustomEvent('hd-fert-all')); } catch (e) {}
    try { renderQuickCard(); } catch (e) {}
  };

  /* Fertility Mode, folded on the same way as the NFF/MHiYH snapshot: fdState
     and fdFertility can land in either order, so both receivers re-merge. */
  function mergeFert(m) {
    if (!m) return m;
    const map = (state.fert && state.fert.actors) || {};
    m.fert = map[String(m.formId || '').toLowerCase()] || null;
    return m;   // chainable, so normMember can wrap mergeHome()'s result
  }

  function remergeFert() {
    state.cats.forEach(function (c) { c.members.forEach(mergeFert); });
  }

  function fertTitle(f) {
    if (!f) return '';
    if (f.pregnant) {
      let t = 'Fertility Mode: pregnant';
      t += '\nDay ' + f.day + (f.termDays ? ' of ' + f.termDays : '');
      if (f.trimester) t += '  (trimester ' + f.trimester + ')';
      if (typeof f.daysLeft === 'number') t += '\n' + f.daysLeft + ' day(s) to go';
      if (f.father) t += '\nFather: ' + f.father;
      if (f.births) t += '\nPrevious births: ' + f.births;
      return t + '\n(read from the mod — matches its MCM)';
    }
    let t = 'Fertility Mode: not pregnant';
    if (f.cycleDay) t += '\nCycle day ' + f.cycleDay;
    if (f.ovulating) t += '\nOvulating';
    if (f.spermCount) t += '\nSperm count ' + f.spermCount;
    return t;
  }

  /* ==================================== the engine's relationship rank ==== *
   *  Skyrim's RELA rank is a nine-step scale from -4 to +4, and it is the
   *  number the GAME branches on: vanilla dialogue, most follower frameworks,
   *  marriage and a great deal of mod content all gate on GetRelationshipRank.
   *  It is a different fact from the Relationship you TYPE into her fields —
   *  that one is your note to yourself, this one is what Skyrim believes.
   *
   *  Read: rides on the worn-set dossier (`about.rank` / `about.relHas`), so it
   *  costs no round trip of its own. Write: `fdRank` → C++ → Papyrus
   *  Actor.SetRelationshipRank. See src/relationship.h for why the write cannot
   *  be synchronous and what that means for what the card is allowed to claim.
   * ======================================================================== */
  /* Portrait framing, as capture.ini currently holds it. Populated by the
     fdFramingInfo reply; `null` until C++ has answered, so the panel can say
     "reading…" instead of inventing numbers it would then save back. */
  let framing = null;

  const RANK_MIN = -4;
  const RANK_MAX = 4;
  /* The Creation Kit's own words, so the card agrees with every other place in
     Skyrim the player has seen these. Keyed by string because a JS object key
     of -1 is "-1" anyway and being explicit stops a stray "-0". */
  const RANK_LABELS = {
    '4': 'Lover', '3': 'Ally', '2': 'Confidant', '1': 'Friend',
    '0': 'Acquaintance',
    '-1': 'Rival', '-2': 'Foe', '-3': 'Enemy', '-4': 'Archnemesis',
  };

  function clampRank(r) {
    const n = (typeof r === 'number' && isFinite(r)) ? Math.round(r) : 0;
    return Math.max(RANK_MIN, Math.min(RANK_MAX, n));
  }
  function rankLabel(r) { return RANK_LABELS[String(clampRank(r))] || 'Acquaintance'; }
  /* "+2" / "0" / "-3" — the console's own notation, because setrelationshiprank
     is how most people have met this number and the sign carries the meaning. */
  function rankNum(r) { const n = clampRank(r); return (n > 0 ? '+' : '') + n; }

  /* MARRIED, per M.A.R.A.S. Its own answer, and NOT derivable from the rank:
     the mod will happily keep you wed to someone the engine ranks as a Foe, and
     plenty of Lovers are not spouses. Violet, because the row's gold is spoken
     for by the Relationship field, its green by "doing now" and its rose by
     pregnancy — a fourth hue is the only way this stays scannable.

     The rank itself deliberately gets NO row chip. This file's own rule is that
     a sixth chip is where a roster row stops being readable, and a "Friend"
     badge on forty followers is noise; the rank lives on the card (where the
     slider is) and in the search haystack, which is where it is actually
     asked for. Marriage is rare and therefore worth a row. */
  function spouseChip(m) {
    if (!m.spouse) return null;
    const chip = h('span', {
      class: 'fd-chip fd-chip-spouse',
      title: 'Married to you — M.A.R.A.S' +
             (m.relHas ? '\nThe game ranks her ' + rankLabel(m.relRank) +
                         ' (' + rankNum(m.relRank) + ')' : ''),
    }, '♥ Married');
    chip.style.color = '#b79ad9';
    chip.style.borderColor = '#b79ad955';
    chip.style.background = 'rgba(183,154,217,.07)';
    return chip;
  }

  /* PREGNANCY ONLY, and deliberately terse. The row already carries up to five
     things (relationship, now, home, category, née) and this file's own rule is
     that a second chip is where it stops being scannable — so the cycle-day /
     ovulation detail stays in the tooltip and never takes row space. Rose, to
     collide with neither the gold Relationship chip nor the green "now" one.

     "◍ 46%" over "day 14 of 30" because the percentage is the glanceable
     number; the days are one hover away. */
  function fertChip(m) {
    const f = m.fert;
    if (!f || !f.pregnant) return null;
    const label = (typeof f.percent === 'number' && f.termDays)
      ? f.percent + '%'
      : 'day ' + f.day;
    const chip = h('span', {
      class: 'fd-chip fd-chip-fert',
      title: fertTitle(f),
    }, '◍ ' + label);
    chip.style.color = '#d98aa6';
    chip.style.borderColor = '#d98aa655';
    chip.style.background = 'rgba(217,138,166,.07)';
    return chip;
  }

  /* The second row chip: what she is doing THIS MOMENT. Green, because the
     deck already means "live" by green (.fd-tag.following) and the gold is
     spoken for by Relationship — the row still has exactly one gold chip.

     The place is suppressed when it just repeats the home chip beside it: on
     a roster row "☾ Sleeping · Breezehome ⌂ Breezehome" is the same word
     twice, and the row has five other things competing for the eye. */
  function nowChip(m, q) {
    const a = m.nowAct;
    if (!a) return null;
    const showPlace = a.place && a.place !== m.homeName;
    const chip = h('span', {
      class: 'fd-chip fd-chip-now',
      data: { k: String(a.k) },
      title: nowTitle(m),
    });
    chip.append(h('span', { class: 'fd-now-ic', 'aria-hidden': 'true' }, a.spec.ic + ' '));
    chip.append(h('span', { class: 'fd-now-verb' }, a.spec.verb));
    if (showPlace) {
      chip.append(h('span', { class: 'fd-now-at' }, ' · '));
      chip.append(h('span', { class: 'fd-now-at' }, nameNodes(a.place, q)));
    }
    /* app.css styles <mark> per container and has no global reset, so a search
       hit in a NEW container would paint the browser's default yellow block —
       same neutralisation the relationship and home chips do. */
    const marks = chip.querySelectorAll ? chip.querySelectorAll('mark') : [];
    for (let mi = 0; mi < marks.length; mi++) {
      marks[mi].style.background = 'transparent';
      marks[mi].style.color = '#d8f0d9';
      marks[mi].style.fontWeight = '700';
    }
    return chip;
  }

  function nowTitle(m) {
    const a = m.nowAct;
    if (!a) return '';
    let t = a.spec.verb + (a.place ? ' at ' + a.place : '');
    const rest = m.acts.filter(function (x) { return !x.now; });
    if (rest.length) {
      t += '\n\nAlso today: ' + rest.map(function (x) {
        return x.spec.label + (x.place ? ' · ' + x.place : '');
      }).join('\n');
    }
    return t + '\n(My Home is Your Home NG — click for the full day)';
  }

  /* ==================================== telling MHiYH where to put her ==== *
   *  The day above is what the mod already decided. THIS is how you change
   *  it, and every action is one message to C++ (`fdMhiyh`), which turns it
   *  into a call to My Home is Your Home's OWN global script — the same
   *  entry point its dialogue uses. We never write the linked ref ourselves;
   *  see the long why in src/mhiyh_control.h.
   *
   *  Which kinds can be SET is the mod's rule, not ours:
   *    0        home — MarkHome (first time) / MoveHome (after), its own action
   *    1 … 6    sleep, work, guard, breakfast, lunch, dinner — SetAreaMarker,
   *             and every one of them refused until the home exists
   *    7        Watch has NO place of its own: it shares the guard post's
   *             marker (keyword 0x804). Nothing to set, so no buttons.
   *  Anything else (a kind a future NG grows) gets no buttons either — the
   *  read path still lists it, we just do not pretend to be able to move it.
   * ======================================================================== */
  const SETTABLE_KINDS = [0, 1, 2, 3, 4, 5, 6];
  const KIND_HOME = 0;
  const DAY_ICONS = { 0: 'hm-home', 1: 'ns-moon', 2: 'cat-utilities', 3: 'cat-guards',
    4: 'wx-clear', 5: 'sv-eat', 6: 'wx-clear-night', 7: 'cat-guards' };
  function dayStatusKey(id) { return canonFormId(fidHexOf(id)); }
  function updateDayStatus(env) {
    const key = dayStatusKey(env.formId);
    if (!key) return;
    state.dayStatus[key] = { msg: env.msg || '', ok: env.ok !== false, pending: env.phase === 'sent' };
    if (ctxEl && ctxEl._dossier) ctxEl._dossier.paintDayStatus();
  }

  function canSetKind(k) { return SETTABLE_KINDS.indexOf(k) >= 0; }

  function sendMhiyh(op, m, kind) {
    /* `liveFormId` first: C++ fills it for a roster row whose stored form is a
       BASE record rather than a reference (a spawned follower — see
       actorSubjectOf and nff_bridge's base-form repair). MHiYH is handed a
       reference or nothing; the base id would be refused. */
    const msg = { op: op, formId: m.liveFormId || m.formId || '', name: m.name || '' };
    if (typeof kind === 'number') msg.kind = kind;
    updateDayStatus({ formId: msg.formId, phase: 'sent', ok: true, msg: 'Waiting for My Home is Your Home to confirm…' });
    toGame('fdMhiyh', JSON.stringify(msg));
  }

  /* ============================ recruit · dismiss · open their inventory === *
   *  Three quick acts on ONE person, sent as `fdNpc` and answered on the same
   *  name. C++ (src/nff_control.cpp) turns each into a call to Nether's
   *  Follower Framework's own controller — RecruitFollower / RemoveFollower —
   *  which is verbatim what NFF's override of vanilla's DialogueFollowerScript
   *  runs when you say "Follow me, I need your help". NFF is the default and
   *  the reply says `via:"nff"`; the vanilla DialogueFollower quest is the
   *  fallback and says `via:"vanilla"`, so a recruit can never quietly go
   *  through the wrong framework.
   *
   *  `m` may be omitted entirely — then C++ acts on whoever was under the
   *  crosshair when the palette opened, which is what makes these "quick".
   *  That is the SAME snapshot the ＋Add flow uses, so the two always agree
   *  about who "the targeted NPC" is.
   * ======================================================================== */
  function whoOf(m) {
    /* No member => no formId => C++ falls back to the crosshair snapshot.
       Deliberately NOT sending formId:"" here versus omitting it: the C++ side
       distinguishes "you named someone who isn't loaded" from "you named
       nobody", and the two need different words on screen. */
    if (!m) return {};
    /* `liveFormId` first, for the same reason sendMhiyh prefers it: a roster
       row whose stored form is a BASE record (a follower spawned at runtime —
       Follower Organizer cannot persist a 0xFF ref, so it files her NPC_)
       carries an id that resolves to a form but never to an actor. C++ fills
       liveFormId with the reference it actually found for that base. */
    return { formId: String(m.liveFormId || m.formId || ''), name: String(m.name || '') };
  }

  /* Who the last recruit was aimed at, so a `guarded` refusal can re-send the
     SAME person with force:true. null legitimately means "the crosshair
     target", which is why this is a separate variable rather than a falsy
     check on a member. */
  let lastRecruitTarget = null;
  /* Which verb was aimed at them, so a `guarded` refusal re-arms the SAME
     one — see armForceRecruit. */
  let lastRecruitOp = 'recruit';

  function sendNpc(op, m, extra) {
    if (op === 'recruit' || op === 'forceFollower') { lastRecruitTarget = m || null; lastRecruitOp = op; }
    if (op === 'dismiss') lastDismissTarget = m || null;
    /* The recents strip. sendApply and sendWorld have always recorded, and the
       note above them claims those are "the two calls every member action
       funnels through" — which stopped being true the day sendNpc was added as
       a third sender and never got the hook. So opening someone's inventory
       left no trace at all (opening a follower's inventory should put her in the
       recents strip above, and did not), and the same went for
       recruit, dismiss, wait, follow, place, send-home and the spare chest.

       `m` is null for the crosshair card, which is the common case here, so
       fall back to resolving whoever the target is by name. */
    noteRecentFor(op, m);
    toGame('fdNpc', JSON.stringify(Object.assign({ op: op }, whoOf(m), extra || {})));
  }

  /* Record against a MEMBER rather than a (cat, idx) pair — sendNpc is handed
     the member itself, or nothing at all when it is acting on the crosshair. */
  function noteRecentFor(op, m) {
    let hit = null;
    if (m && m.name) hit = rosterEntryFor(m.original || m.name);
    if (!hit && !m && state.target && state.target.name) hit = rosterEntryFor(state.target.name);
    // Someone Follower Organizer has never heard of has no row to point back
    // at, so there is nothing to put in the strip. Not an error.
    if (hit && hit.cat) noteRecent(op, hit.cat.index, hit.idx);
  }

  /* ---- the guarded-NPC second click ----
     A guarded refusal (her own mod already owns her following) has to be
     overridable with one more click. It deliberately does NOT go through
     arm(): arm() fires only when arm() is called a SECOND time on the same
     element, so a plain click on a recruit button would run the button's
     ordinary handler instead — which sends no force flag and, worse, aims at
     whoever that affordance normally targets rather than the person who was
     just refused.

     So the pending force is a small piece of state holding the ACTUAL target,
     and every recruit affordance funnels through recruitClick(). While it is
     armed, any recruit click means "yes, that person, anyway". */
  /* STATE, not a mutated DOM node. It used to stash the button and rewrite its
     textContent, which was fine while nothing else repainted — but the card now
     re-renders on every reply, and a render would quietly restore the idle
     label while the pending force was still live. The button would then read
     "Recruit" and force-recruit anyway: a control lying about what it does.
     Rendering the armed label FROM this state makes that impossible. */
  /* { target, msg, timer, op } — op is 'recruit' or 'forceFollower'. The VERB
     is part of the arm because both can be refused as `guarded`, and a second
     click must repeat the verb that was refused: letting a refused
     force-follower decay into a plain recruit would run a different Papyrus
     path than the one the warning was about. */
  let forceRecruit = null;

  function clearForceRecruit(repaint) {
    if (!forceRecruit) return;
    if (forceRecruit.timer) clearTimeout(forceRecruit.timer);
    forceRecruit = null;
    if (repaint !== false) { renderQuickCard(); refreshOpenMenu(); }
  }

  function armForceRecruit(target, msg, op) {
    if (forceRecruit && forceRecruit.timer) clearTimeout(forceRecruit.timer);
    forceRecruit = {
      target: target || null,
      msg: msg || 'Click again to recruit them into NFF regardless',
      op: op === 'forceFollower' ? 'forceFollower' : 'recruit',
      timer: setTimeout(function () { clearForceRecruit(); }, 6000),
    };
    renderQuickCard();
    refreshOpenMenu();
  }

  /* THE one path every recruit click takes. An arm for the OTHER verb is
     cleared rather than consumed, so it can never be spent on this one. */
  function recruitClick(m) {
    if (forceRecruit && forceRecruit.op === 'recruit') {
      const target = forceRecruit.target;
      clearForceRecruit(false);
      sendNpc('recruit', target, { force: true });
      renderQuickCard();
      return;
    }
    clearForceRecruit(false);
    sendNpc('recruit', m);
  }

  /* Same shape for "Make recruitable": guarded for a companion who runs her
     own follower system, because this writes the vanilla follower factions
     onto her permanently and the deck cannot undo the relationship change. */
  function makeFollowableClick(m) {
    if (forceRecruit && forceRecruit.op === 'forceFollower') {
      const target = forceRecruit.target;
      clearForceRecruit(false);
      sendNpc('forceFollower', target, { force: true });
      renderQuickCard();
      return;
    }
    clearForceRecruit(false);
    sendNpc('forceFollower', m);
  }

  /* ---- the quest-held second click (Dismiss) ----
     The same shape as the guarded recruit, for the opposite verb. C++ refuses
     a Dismiss with `held:true` when NFF does not hold her but a quest alias
     runs a follow package on her (src/nff_control.cpp RecoverFollower). Before
     2026-09-26 that refusal was a dead end: a toast reading "held by a quest"
     over Ambrelie, who had no active quest at all (Rober: "dismiss needs to
     force dismiss ... but i have no active quest for her"). Now the refusal
     NAMES the quest and arms this: the next Dismiss click on any surface
     (ORDER button, NFF-disagrees chip, roster row) sends force:true, which
     clears her teammate flag and follower factions underneath that quest and
     still verifies the result on three reads. Rendered FROM state, for the
     same reason forceRecruit is. */
  let lastDismissTarget = null;
  let forceDismiss = null;

  function clearForceDismiss(repaint) {
    if (!forceDismiss) return;
    if (forceDismiss.timer) clearTimeout(forceDismiss.timer);
    forceDismiss = null;
    if (repaint !== false) { renderQuickCard(); refreshOpenMenu(); }
  }

  function armForceDismiss(target, msg) {
    if (forceDismiss && forceDismiss.timer) clearTimeout(forceDismiss.timer);
    forceDismiss = {
      target: target || null,
      msg: msg || 'Click again to dismiss them regardless of the quest holding them',
      /* Longer than the recruit arm: the message names a quest and says what
         the force does, and it has to be readable from a couch. */
      timer: setTimeout(function () { clearForceDismiss(); }, 9000),
    };
    renderQuickCard();
    refreshOpenMenu();
  }

  /* THE one path every dismiss click takes once its two-click arm has fired.
     Armed, it aims at the person who was REFUSED, not at whoever the control
     normally targets — the swap the recruit check exists for. */
  function dismissClick(m) {
    if (forceDismiss) {
      const target = forceDismiss.target;
      clearForceDismiss(false);
      sendNpc('dismiss', target, { force: true });
      renderQuickCard();
      return;
    }
    sendNpc('dismiss', m);
  }

  /* Add to / remove from NFF — its own Import/Export pair, NOT recruitment.
     No arming and no force flag, because neither half is destructive and each
     is the other's undo: import lends her NFF's features (gear, tweaks,
     storage, sandbox) while her own follow package keeps running, export
     takes it back. C++ refuses honestly when the state is already what the
     click asks for, so there is nothing here to second-guess. */
  function frameworkClick(m, imported) {
    sendNpc(imported ? 'export' : 'import', m);
  }


  /* Ask for the worn set. Answered on `fdEquipped`; cached per formId so
     reopening a menu paints instantly and only re-asks in the background. The
     crosshair target caches under the empty key.

     THE GUARD IS LOAD-BEARING, not an optimisation. fdEquipped calls
     refreshOpenMenu(), refreshOpenMenu() rebuilds via openMemberMenu(), and
     openMemberMenu() calls askEquipped() — so an unconditional ask is an
     infinite request loop that pins the VM. Re-asking for the same actor
     inside a short window is suppressed, which breaks the cycle at exactly one
     round trip while still letting a genuinely later open refresh. */
  let equippedAsked = { key: null, at: 0 };
  let equippedPending = null;
  const EQUIPPED_MIN_GAP = 1500;

  /* `force` skips the same-key gate. ONLY safe from something that is not
     itself downstream of an fdWorn reply — today that is the rank verify timer,
     which fires once, ~1 s after a deliberate click. Calling it from a receiver
     would rebuild exactly the request loop the gate exists to break. */
  function askEquipped(m, force) {
    const k = equippedKey(m);
    const now = Date.now();
    if (!force && equippedAsked.key === k && (now - equippedAsked.at) < EQUIPPED_MIN_GAP) return;
    equippedAsked = { key: k, at: now };
    equippedPending = k;
    toGame('fdEquipped', JSON.stringify(whoOf(m)));
  }
  function equippedKey(m) { return m ? String(m.formId || '').toLowerCase() : ''; }
  function equippedFor(m) { return state.equipped[equippedKey(m)] || null; }

  /* ---- Better FaceLight Redux — the 💡 on the quick card ---------------- *
   *  Cache: hex formId -> the last bflState envelope from C++ (live truth off
   *  the actor: the SPID applicator ability + which light-level abilities she
   *  carries). `bflPresent` starts UNKNOWN (null) and the button is simply not
   *  drawn until the DLL answers once — so a rig without the mod, or an older
   *  DLL that never replies, shows nothing rather than a dead control.
   * ----------------------------------------------------------------------- */
  let bflPresent = null;               // null = unknown · false = mod absent
  const bflCache = {};                 // key -> { at, env }
  let bflAsked = { key: null, at: 0 };
  const BFL_MIN_GAP = 1500;
  function bflKey(fid) { return '0x' + ((Number(fid) || 0) >>> 0).toString(16); }
  function askFacelight(fid, force) {
    if (bflPresent === false || !fid) return;
    const k = bflKey(fid);
    const now = Date.now();
    if (!force && bflAsked.key === k && (now - bflAsked.at) < BFL_MIN_GAP) return;
    bflAsked = { key: k, at: now };
    toGame('bflGet', JSON.stringify({ formId: (Number(fid) || 0) >>> 0 }));
  }
  function bflFor(fid) { const r = bflCache[bflKey(fid)]; return r ? r.env : null; }

  /* The hover text IS the feature (Rober, 2026-08-06: "an icon that on hover
     opens into text that shows state"): one glance answers on/off, which
     levels, and why she might look dark anyway. */
  function bflTitle(env, who) {
    if (!env) return 'Facelight — checking ' + who + '…';
    if (env.ok === false) return 'Facelight: ' + (env.msg || 'unknown');
    let s;
    if (env.lit) {
      const lv = (env.levels || []).join('+');
      s = '💡 Facelight: ON for ' + who + (lv !== '' ? ' — light level ' + lv : '');
      if (!env.running)
        s += '\n⚠ The light ability looks wedged (its script is not running) — Re-light.';
      else
        s += '\nLooks dark anyway? A door/cell change strips the light while the '
           + 'game still counts it as on — Re-light fixes that.';
    } else {
      s = '○ Facelight: OFF for ' + who;
      if (env.excluded)
        s += '\nShe is on Better FaceLight’s own exclude list (its MCM).';
      if (env.applicator && !env.lit)
        s += '\nThe mod knows her but lit no levels — check the MCM’s light levels.';
    }
    if (env.modEnabled === false)
      s += '\n⚠ Better FaceLight’s master switch is OFF in its MCM.';
    return s + '\nClick for controls.';
  }

  /* The icon itself. Gold (active) = she is LIT — the glanceable half of the
     ask; the full sentence lives in the hover title above. Not drawn at all
     until the DLL has confirmed the mod is in the load order. */
  function bflQuickBtn(t, who, dead) {
    if (bflPresent !== true || !t || !t.formId) return null;
    const env = bflFor(t.formId);
    if (env && env.present === false) return null;
    const lit = !!(env && env.lit);
    return quickBtn('💡', lit ? 'Light: on' : 'Light: off', bflTitle(env, who),
      () => {
        ui.fqLight = !ui.fqLight;
        if (ui.fqLight) askFacelight(t.formId, true);   // fresh truth under the controls
        renderQuickCard();
      },
      { disabled: dead, active: lit, pressed: ui.fqLight });
  }

  /* The revealed control row (fq-sets idiom, same as Wear/Fill). Re-light is
     deliberately FIRST — it is the one that fixes the mod's known bug (cell
     change strips the ENB light while the ability stays on). */
  function bflBlock(t, who) {
    const env = bflFor(t.formId);
    const lit = !!(env && env.lit);
    const send = function (op) {
      toGame('bflSet', JSON.stringify({ formId: (Number(t.formId) || 0) >>> 0, op: op }));
    };
    const lbl = !env ? '💡 Facelight · checking…'
      : lit ? '💡 Facelight · ON' + ((env.levels || []).length ? ' · level ' + env.levels.join('+') : '')
            : '💡 Facelight · OFF';
    const box = h('div', { class: 'fq-sets is-light' },
      h('span', { class: 'fq-sets-lbl', title: bflTitle(env, who) }, lbl));
    box.append(h('button', {
      class: 'fq-set', type: 'button',
      disabled: env ? null : true,
      title: 'Fix a vanished light: strip Better FaceLight off ' + who + ' and '
           + 're-apply it a second later, so its script re-attaches the ENB light. '
           + 'Use when the state says ON but her face is dark — doors do that.',
      onClick: (e) => { e.stopPropagation(); send('relight'); },
    }, '✸ Re-light'));
    if (lit) {
      box.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Turn ' + who + '’s facelight off. Honest limit: it comes back on '
             + 'the next game load — the mod re-hands the light to everyone then.',
        onClick: (e) => { e.stopPropagation(); send('off'); },
      }, 'Turn off'));
    } else {
      const mcmOff = !!(env && env.modEnabled === false);
      box.append(h('button', {
        class: 'fq-set', type: 'button',
        disabled: (env && !mcmOff) ? null : true,
        title: mcmOff
          ? 'Better FaceLight’s master switch is OFF in its MCM — flip it there first'
          : 'Light ' + who + ' up — gives her the mod’s own light ability, exactly '
            + 'as if the mod had picked her itself',
        onClick: (e) => { e.stopPropagation(); send('on'); },
      }, 'Turn on'));
    }
    box.append(h('button', {
      class: 'fq-set', type: 'button',
      title: 'Re-read her light state now',
      onClick: (e) => { e.stopPropagation(); askFacelight(t.formId, true); },
    }, '⟳'));
    return box;
  }

  /* ---- ✨ Effects — the quick-card modal (fx* bridge, 2026-08-14) -------- *
   *  Rober: "f7 on a npc have a new button (effects) with a modal popout —
   *  this could be one of the features to remove the skin oil or add it."
   *  Visual effects OTHER mods implement as ability spells (first tenant:
   *  Oily Skin — NiOverride gloss), listed by C++'s registry and toggled per
   *  person. Cache/ask discipline is the bfl idiom exactly: `fxPresent`
   *  starts UNKNOWN (null) and the ✨ is not drawn until the DLL confirms at
   *  least one effect's mod is in the load order — an older DLL, or a rig
   *  with none of the mods, shows nothing rather than a dead control.
   * ----------------------------------------------------------------------- */
  let fxPresent = null;               // null = unknown · false = no effect's mod present
  const fxCache = {};                 // key -> { at, env } (env = fxState payload)
  let fxAsked = { key: null, at: 0 };
  const FX_MIN_GAP = 1500;
  let fxModalCtx = null;              // { formId, who } while the modal is up
  let fxTab = 'fx';                   // '✨ Effects' | '🎨 Skins' | Pubes | Zaz — kept for the session
  /* fx-global-search (Rober, 2026-08-17: "add searchability to the entire
     effects thing"). ONE box, in the modal chrome rather than inside any tab,
     for two reasons: every tab is searchable with no duplicated widget, and
     because fillFxModal() only redraws the BODY, typing never destroys and
     recreates the input — which is what the old per-tab filters had to paper
     over with a re-focus-and-restore-caret dance after every keystroke. */
  let fxSearch = '';
  let fxTopHit = null;                // set by the active tab while it renders
  let fxPubesType = 'all';            // 'all' | 'normal' | 'stylish' | 'hairy'
  let fxEffMod = 'all';               // Effects tab: which mod's rows to show
  let fxZazCat = 'all';               // Zaz tab: which zbfWorn* category
  let fxZazPage = 0;                  // Zaz tab: paged so we never bulk-render
  let fxZazWorn = false;              // Zaz tab: show only what she is wearing
  let fxZazSort = 'cat';              // Zaz tab: 'cat' | 'name' | 'worn'
  /* Every device key we have already asked C++ to render this session, and the
     settle timer that batches the ask. Session-scoped, never persisted: a
     render lands on disk and the next payload carries its path, so the only
     thing this has to prevent is asking twice for the same in-flight piece. */
  const fxZazAsked = {};
  let   fxZazAskTimer = 0;
  let   fxZazAskRun = null;           // the settled ask itself, so it can be flushed
  const FX_ZAZ_SETTLE_MS = 400;
  /* HOW BIG A PAGE. The original 7 was picked when every page turn queued its
     tiles' mesh renders straight onto the game's D3D device — 202 devices at 7
     a page is 29 page turns, which is not a catalogue, it is a filing cabinet.
     Two things changed on 2026-08-17: the ask is once-per-key-per-session
     behind a settle gate, and C++ paces renders while a menu is up. So the
     page size is now a LAYOUT question with a first-visit cost attached.
     The layout answer: the modal is 1120px wide and the grid is 52vh, so at
     2560x1440 about 7 columns x 4 rows ≈ 28 tiles are on screen at once — 24
     could not even fill the visible band, and the pager was doing work the
     screen did not need. 56 fills it with one comfortable scroll and turns 202
     devices into 4 pages. The picker is offered because the trade is real and
     personal: a bigger page is fewer turns but a longer FIRST fill (renders are
     kept forever, so every later visit is free either way). No "All" — every
     tile decodes a PNG in a compositor-off engine, and 202 at once is a memory
     bet nobody has measured. */
  const FX_ZAZ_SIZES = [28, 56, 112];
  let   fxZazSize = 56;
  /* Renders land minutes after the ask, and the only thing that carries a new
     icon path into the view is a fresh fxState — which C++ sends only in reply
     to fxGet/fxSet. So while a page still has pictures coming, re-read her on
     a slow clock (and immediately when a render batch lands), bounded so a
     device whose mesh never renders cannot leave a poll running forever. */
  const FX_ZAZ_POLL_MS = 3000;
  const FX_ZAZ_REFRESH_MAX = 24;
  let   fxZazPollT = 0;
  let   fxZazRefreshN = 0;
  function fxKey(fid) { return '0x' + ((Number(fid) || 0) >>> 0).toString(16); }
  function askEffects(fid, force) {
    if (fxPresent === false || !fid) return;
    const k = fxKey(fid);
    const now = Date.now();
    if (!force && fxAsked.key === k && (now - fxAsked.at) < FX_MIN_GAP) return;
    fxAsked = { key: k, at: now };
    toGame('fxGet', JSON.stringify({ formId: (Number(fid) || 0) >>> 0 }));
  }
  function fxFor(fid) { const r = fxCache[fxKey(fid)]; return r ? r.env : null; }
  function fxActiveList(env) {
    return (env && env.effects || []).filter((e) => e.active);
  }

  function fxTitle(env, who) {
    if (!env) return 'Effects — checking ' + who + '…';
    const on = fxActiveList(env).map((e) => e.label);
    /* 3ba-body-tab: her physics mode belongs in the hover too — it is the one
       thing in this modal that is ALWAYS in some state, so a tooltip listing
       only ability-spell effects reads as "nothing here" on a 3BA rig. */
    const b = env.body;
    if (b && b.available && b.mode === 'smp')
      on.push('SMP physics' + (b.cupLabel ? ' (cup ' + b.cupLabel + ')' : ''));
    let s = on.length
      ? '✨ Effects on ' + who + ': ' + on.join(', ')
      : '○ No effects on ' + who;
    return s + '\nClick for the list — apply or remove each one.';
  }

  function fxQuickBtn(t, who, dead) {
    if (fxPresent !== true || !t || !t.formId) return null;
    const env = fxFor(t.formId);
    if (env && env.anyPresent === false) return null;
    const lit = fxActiveList(env).length > 0;
    const open = !!document.getElementById('fd-fx-modal');
    return quickBtn('✨', 'Effects', dead ? who + ' is dead' : fxTitle(env, who),
      () => {
        if (document.getElementById('fd-fx-modal')) { closeFxModal(); return; }  // toggle, like every other reveal
        openFxModal(t, who);
        renderQuickCard();   // light the button while the modal is up
      },
      { disabled: dead, active: lit, pressed: open });
  }

  function closeFxModal() {
    const m = $('fd-fx-modal');
    if (m) m.remove();
    fxModalCtx = null;
    fxSearch = '';                       // the active TAB is kept for the session
    fxTopHit = null;
    /* Context resets with the person; PREFERENCES (sort, page size) do not.
       A category or a worn-only filter left over from the last woman is a trap
       — you reopen on someone else, see three devices, and believe that is her
       whole catalogue. Sort order and page size say nothing about anyone. */
    fxZazPage = 0;
    fxZazCat = 'all';
    fxZazWorn = false;
    fxZazStopWatch();
    if (fxZazAskTimer) { clearTimeout(fxZazAskTimer); fxZazAskTimer = 0; }
    fxZazAskRun = null;
    if (isActive()) renderQuickCard();   // un-press the ✨
  }

  /* The popout (fd-modal idiom, off document.body like the HUD modal so the
     pane's overflow never clips it). Rows re-fill in place whenever a fresh
     fxState lands, so Apply/Remove flips the row without reopening. */
  function openFxModal(t, who) {
    if ($('fd-fx-modal')) { closeFxModal(); return; }
    fxModalCtx = { formId: (Number(t.formId) || 0) >>> 0, who: who };
    fxZazRefreshN = 0;                   // a fresh budget of re-reads per opening
    askEffects(t.formId, true);          // fresh truth under the list
    const modal = h('div', { id: 'fd-fx-modal', class: 'fd-modal-back',
      onClick: (e) => { if (e.target && e.target.id === 'fd-fx-modal') closeFxModal(); } });
    const card = h('div', { class: 'fd-modal' },
      h('div', { class: 'fd-modal-head' },
        h('span', { class: 'fd-modal-title' }, '✨ Effects — ' + who),
        h('button', { class: 'fd-modal-x', type: 'button', title: 'Close',
          onClick: () => closeFxModal() }, '✕')),
      h('div', { class: 'fd-modal-sub' },
        'Looks other mods can put on ' + who + ' — applied and removed through '
        + 'each mod’s own machinery, so it persists (and cleans up) exactly '
        + 'as that mod intends.'),
      /* Built ONCE, outside the body fillFxModal() clears — see fxSearch. */
      h('input', {
        class: 'fx-search', type: 'text', value: fxSearch,
        placeholder: 'Search every effect, skin, style and restraint… (Enter takes the top hit)',
        onInput: (e) => { fxSearch = e.target.value; fxZazPage = 0; fillFxModal(); },
        onKeyDown: (e) => {
          if (e.key === 'Escape') {
            /* Escape clears the search before it closes the modal — losing a
               half-typed query is annoying, losing the whole modal is worse. */
            if (fxSearch) { e.stopPropagation(); fxSearch = ''; e.target.value = ''; fillFxModal(); }
            return;
          }
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (typeof fxTopHit === 'function') fxTopHit();
        },
      }),
      h('div', { id: 'fd-fx-modal-body' }));
    modal.append(card);
    document.body.appendChild(modal);
    fxEnsureModalStyles();
    fillFxModal();
  }

  function fillFxModal() {
    const body = $('fd-fx-modal-body');
    if (!body || !fxModalCtx) return;
    const env = fxFor(fxModalCtx.formId);
    body.textContent = '';
    if (!env) {
      body.append(h('div', { class: 'fx-empty' }, 'Reading her effects…'));
      return;
    }
    if (env.ok === false) {
      body.append(h('div', { class: 'fx-empty' }, env.msg || 'Couldn’t read her effects.'));
      return;
    }
    /* skinshift-skins-tab — the 🎨 Skins tab exists only when the DLL reports
       a skins block AND SkinShift.dll is actually loaded; a one-tab seg row is
       pointless chrome, so with no Skins tab the modal stays exactly as it
       was (an older DLL sends no `skins` key at all and lands here too). */
    fxEnsureSkinStyles();
    fxEnsureBodyStyles();
    /* Unconditional: the Effects tab itself now uses the chip/tile
       vocabulary these sheets define (mod chips), so loading them only
       when Pubes or Restraints opens would leave the DEFAULT tab
       rendering unstyled chips. */
    fxEnsurePubesStyles();
    fxEnsureModalStyles();
    const skins = env.skins;
    const bodyEnv = env.body;
    const modalWho = fxModalCtx.who;
    /* The tab row builds itself from what the DLL says is on the load order,
       so a rig with only one kind of change never sees a one-tab seg row. An
       older DLL sends neither `skins` nor `body` and lands on Effects alone. */
    const tabs = [{ id: 'fx', label: '✨ Effects',
      title: 'Looks other mods can put on ' + modalWho }];
    if (skins && skins.available !== undefined && skins.present)
      tabs.push({ id: 'skins', label: '🎨 Skins',
        title: 'Change ' + modalWho + '’s skin — '
          + (skins.provider === 'skymanager'
            ? 'your own skin packs, written as RaceMenu texture overrides'
            : 'SkinShift’s preset skins')
          + ', or back to her own' });
    if (bodyEnv && bodyEnv.present)
      tabs.push({ id: 'body', label: '🫧 Body',
        title: 'CBBE 3BA’s body physics for ' + modalWho + ' — CBPC or SMP, '
          + 'and which jiggle profile' });
    /* pubes-tab — OPubes NG's catalogue, DETECTED from the load order. Label
       is plain text on purpose: the no-emoji UI rule (CLAUDE.md) forbids new
       colour emoji, and the siblings' ✨🎨🫧 are pre-existing debt, not a
       licence to add a fourth. */
    const pubesEnv = env.pubes;
    if (pubesEnv && pubesEnv.present)
      tabs.push({ id: 'pubes', label: 'Pubes',
        title: 'Pick ' + modalWho + '’s pubic hair by looking at it — every '
          + 'style OPubes can actually apply on this load order' });
    const zazEnv = env.zaz;
    if (zazEnv && zazEnv.present)
      tabs.push({ id: 'zaz', label: 'Restraints',
        title: 'ZaZ restraints — the same catalogue the Animations tab drives, '
          + 'here with rendered mesh icons' });

    const q = fxSearch.trim().toLowerCase();
    const tab = tabs.some((t) => t.id === fxTab) ? fxTab : 'fx';
    fxTopHit = null;                       // each tab re-arms this as it renders

    if (tabs.length > 1) {
      body.append(h('div', { class: 'fx-tabs' }, ...tabs.map((t) => {
        /* While a search is live every tab shows how many of ITS rows match,
           so a query that hits nothing here but plenty next door is visible
           rather than looking like "no results anywhere". */
        const n = q ? fxMatchCount(t.id, env, q) : -1;
        return h('button', {
          class: 'fx-tab' + (tab === t.id ? ' on' : '') + (n === 0 ? ' none' : ''),
          type: 'button', title: t.title,
          onClick: () => { fxTab = t.id; fillFxModal(); },
        }, t.label, n >= 0 ? h('span', { class: 'fx-tab-n' }, String(n)) : null);
      })));
    }
    if (tab === 'skins') { fillFxSkins(body, skins); return; }
    if (tab === 'body') { fillFxBody(body, bodyEnv); return; }
    if (tab === 'pubes') { fxEnsurePubesStyles(); fillFxPubes(body, pubesEnv); return; }
    if (tab === 'zaz') { fxEnsureZazStyles(); fillFxZaz(body, zazEnv); return; }

    let list = (env.effects || []).filter((e) => fxRowMatches(e, q));

    /* Mod chips — Rober, 2026-08-17: other oil / skin mods "need to be
       separated by mod". The registry now mixes spell-driven and worn effects
       from several mods, so the flat list stopped being readable. Chips appear
       only once there IS more than one mod to separate. */
    const mods = [];
    (env.effects || []).forEach((e) => {
      const m = e.mod || 'Other';
      if (!mods.some((x) => x.id === m)) mods.push({ id: m, n: 0 });
    });
    list.forEach((e) => {
      const row = mods.find((x) => x.id === (e.mod || 'Other'));
      if (row) row.n += 1;
    });
    if (mods.length > 1) {
      if (!mods.some((m) => m.id === fxEffMod)) fxEffMod = 'all';
      body.append(h('div', { class: 'fxp-chips fx-mod-chips' },
        h('button', {
          class: 'fxp-chip' + (fxEffMod === 'all' ? ' on' : ''), type: 'button',
          title: 'Every mod', onClick: () => { fxEffMod = 'all'; fillFxModal(); },
        }, 'All', h('span', { class: 'fxp-chip-n' }, String(list.length))),
        ...mods.map((m) => h('button', {
          class: 'fxp-chip' + (fxEffMod === m.id ? ' on' : '') + (m.n === 0 ? ' none' : ''),
          type: 'button', title: 'Only ' + m.id,
          onClick: () => { fxEffMod = m.id; fillFxModal(); },
        }, m.id, h('span', { class: 'fxp-chip-n' }, String(m.n))))));
      if (fxEffMod !== 'all')
        list = list.filter((e) => (e.mod || 'Other') === fxEffMod);
    }

    if (!list.length) {
      body.append(h('div', { class: 'fx-empty' }, fxSearch
        ? 'Nothing matches “' + fxSearch + '”.'
        : 'No effects are available on this load order.'));
      fxRenderWearMods(body, env);
      return;
    }
    /* Enter applies the top hit, like every other searchable list in the deck. */
    fxTopHit = () => {
      const first = list.find((e) => e.present);
      if (!first) return;
      toGame('fxSet', JSON.stringify({
        formId: fxModalCtx.formId, id: first.id, on: !first.active }));
    };
    list.forEach((e) => {
      const row = h('div', { class: 'fx-row' + (e.present ? '' : ' is-missing') },
        h('span', { class: 'fx-glyph', 'aria-hidden': 'true' }, e.glyph || '✨'),
        h('span', { class: 'fx-main' },
          h('span', { class: 'fx-label' }, e.label,
            h('span', { class: 'fx-chip' + (e.active ? ' on' : '') },
              e.active ? 'ON' : 'off')),
          h('span', { class: 'fx-detail' },
            e.present ? (e.detail || '') : (e.reason || 'not available'))));
      if (e.present) {
        row.append(h('button', {
          class: 'fx-act' + (e.active ? ' danger' : ''), type: 'button',
          title: e.active
            ? 'Take ' + e.label.toLowerCase() + ' off ' + (fxModalCtx ? fxModalCtx.who : 'her')
            + ' — the mod’s own cleanup runs, nothing lingers'
            : 'Put ' + e.label.toLowerCase() + ' on ' + (fxModalCtx ? fxModalCtx.who : 'her')
            + ' — exactly as if the mod’s own applicator had done it',
          onClick: (ev) => {
            ev.stopPropagation();
            toGame('fxSet', JSON.stringify({
              formId: fxModalCtx.formId, id: e.id, on: !e.active }));
          },
        }, e.active ? 'Remove' : 'Apply'));
      }
      body.append(row);
    });
    fxRenderWearMods(body, env);
  }

  /* Does one effect row match the global query? Mod name is included on
     purpose — typing "liquid" should find the Liquid Pack's pieces even
     though none of them says "liquid pack" in its own label. */
  function fxRowMatches(e, q) {
    if (!q) return true;
    return ((e.label || '') + ' ' + (e.detail || '') + ' ' + (e.mod || '') + ' ' +
            (e.reason || '')).toLowerCase().indexOf(q) >= 0;
  }

  /* How many rows in a given tab match — drives the tab strip's count badges.
     Kept deliberately cheap: it counts, it does not build anything. */
  function fxMatchCount(tabId, env, q) {
    if (tabId === 'fx')
      return (env.effects || []).filter((e) => fxRowMatches(e, q)).length;
    if (tabId === 'skins') {
      const p = (env.skins && env.skins.presets) || [];
      return p.filter((s) => ((s.name || '') + ' ' + (s.key || ''))
        .toLowerCase().indexOf(q) >= 0).length;
    }
    if (tabId === 'pubes') {
      const s = (env.pubes && env.pubes.styles) || [];
      return s.filter((x) => ((x.name || '') + ' ' + (x.pack || '') + ' ' + (x.type || ''))
        .toLowerCase().indexOf(q) >= 0).length;
    }
    if (tabId === 'zaz') {
      const d = (env.zaz && env.zaz.devices) || [];
      return d.filter((x) => ((x.name || '') + ' ' + (x.cat || ''))
        .toLowerCase().indexOf(q) >= 0).length;
    }
    if (tabId === 'body') return 0;   // a settings pane, nothing to search
    return 0;
  }

  /* The per-mod detection report for WORN cosmetic mods. Same job the Pubes
     tab's packs report does: a registered mod that is not installed says so
     ONCE, instead of contributing a category of dead rows. */
  function fxRenderWearMods(body, env) {
    const mods = (env && env.wearMods) || [];
    const missing = mods.filter((m) => !m.present);
    if (!missing.length) return;
    body.append(h('div', { class: 'fxp-packs' },
      h('details', {},
        h('summary', {}, 'Wearable skin mods not installed',
          h('span', { class: 'fxp-warn' }, String(missing.length))),
        ...missing.map((m) => h('div', { class: 'fxp-pack is-bad' },
          h('span', { class: 'fxp-pack-n' }, m.mod),
          h('span', { class: 'fxp-pack-d' }, m.plugin + ' isn’t in the load order'))))));
  }

  /* ---- 🎨 Skins — the SkinShift tab of the Effects modal ---------------- *
   *  skinshift-skins-tab (2026-08-15). Rober: change the NPC's skin (body /
   *  hands / feet / head textures) from the quick card. C++ drives SkinShift's
   *  OWN internal store by RVA behind a version gate — the view only paints
   *  what the `skins` block of fxState says and fires fxSet with
   *  id "skinshift:<presetKey>" / "skinshift:clear"; the fresh fxState riding
   *  every fxResult repaints this tab exactly like the effects rows. */
  function fillFxSkins(body, skins) {
    const who = fxModalCtx ? fxModalCtx.who : 'her';
    /* skin-native-provider (2026-09-06). TWO providers now feed this one tab:
       "skymanager" = our own RaceMenu/skee override route (skin_actions.cpp,
       public interface, user-made packs), "skinshift" = the older RVA route.
       C++ picks; the view follows `idPrefix` and never hardcodes an id family
       again. Everything below that reads `skins.*` is shared by both. */
    const native = skins.provider === 'skymanager';
    const P = skins.idPrefix || 'skinshift:';
    if (!skins.available) {
      /* Whichever provider answered, it says why it can't work — SkinShift's
         bytes aren't the build we verified, or RaceMenu never answered the
         interface exchange. Calling in anyway is a crash, so we say why not. */
      body.append(h('div', { class: 'fx-empty fx-skin-gate' },
        skins.reason || 'the Skins tab has no working provider on this rig'));
      if (skins.nativeReason)
        body.append(h('div', { class: 'fx-skin-note' },
          'SkyManager’s own skin route is off too: ' + skins.nativeReason));
      return;
    }
    const unknown = !!skins.unknown;
    const cur = (typeof skins.current === 'string' && skins.current) ? skins.current : null;
    const curName = skins.currentName || cur;

    /* Current state up top. The deck's own applied-record ("source":"deck")
       is what usually answers; absence means "the deck hasn't applied one" —
       SkinShift's F1 menu may still have (its internal store can't be read
       reliably: first play-test 2026-08-15), so the copy claims only what
       the deck actually knows. */
    const curLine = h('div', { class: 'fx-skin-cur' },
      cur ? 'Current: ' + curName
        : (unknown ? 'Current: unknown'
                   : 'No skin applied from the deck'));
    /* Which engine is actually driving this tab, on the tab — during the first
       play-test that is the single most useful fact on screen, and afterwards
       it is how "why did nothing happen" gets answered without a log dive. */
    if (native)
      curLine.append(h('span', {
        class: 'fx-skin-prov',
        title: 'SkyManager writes RaceMenu texture overrides itself.\n'
          + 'Route: ' + (skins.route || 'unknown')
          + ' (RaceMenu Override interface v' + (skins.interfaceVersion || '?') + ')\n'
          + 'Reading: ' + ((skins.roots || []).map((r) => r.path + ' — '
              + r.packs + ' pack' + (r.packs === 1 ? '' : 's')).join('\n') || 'no roots'),
      }, 'SkyManager · ' + (skins.presets || []).length + ' skins'));
    body.append(curLine);

    /* skinshift-readback — THE verdict surface (diagnosis instrument,
       2026-08-15). `skins.live` is read by C++ straight off her LOADED 3D
       model: which diffuse texture each skin geometry is actually wearing,
       plus the engine's race/gender tint. Everything above says what was
       ASKED for; this one line says what her body IS wearing — a
       …removenormals… path means the SkinShift swap really landed, a
       vanilla/BnP path means she's in her normal skin no matter what
       ok=true claimed. Absent `live` (older DLL) renders nothing. */
    const live = skins.live;
    if (live && live.loaded === false) {
      body.append(h('div', { class: 'fx-skin-live' },
        'her model isn’t loaded — nothing to read'));
    } else if (live) {
      const parts = live.parts || [];
      /* The body-skin entry: first kind:"skin" whose geometry name says
         "body"; any skin entry as fallback (hands/feet share the set). */
      const skinParts = parts.filter((p) => p && p.kind === 'skin');
      const pick = skinParts.filter((p) =>
        String(p.geom || '').toLowerCase().indexOf('body') >= 0)[0] || skinParts[0];
      if (!pick) {
        body.append(h('div', { class: 'fx-skin-live' },
          'no skin geometry readable on her model right now'));
      } else {
        const path = String(pick.diffuse || '');
        const file = path ? (path.split(/[\\/]/).pop() || path) : '(no diffuse)';
        /* Both providers leave a recognisable fingerprint in the path: ours
           writes under textures\SkyManagerSkins\, SkinShift's presets live
           under removenormals\. Either one means the swap really landed. */
        const lowPath = path.toLowerCase();
        const isOurs = lowPath.indexOf('skymanagerskins') >= 0;
        const isPreset = isOurs || lowPath.indexOf('removenormals') >= 0;
        const title = 'Body diffuse: ' + (path || '(none)') + '\n\nAll parts:\n' +
          parts.map((p) => (p.geom || '?') + ' [' + (p.kind || '?') + '] ' +
            (p.diffuse || '(no diffuse)') +
            (p.tint ? ' · tint ' + p.tint : '')).join('\n');
        const line = h('div', { class: 'fx-skin-live', title: title },
          'On her body right now: ' + file);
        if (pick.tint) {
          line.append(' · tint ');
          line.append(h('span', { class: 'fx-skin-swatch',
            style: 'background:' + pick.tint }));
          line.append(' ' + pick.tint);
        }
        if (isPreset)
          line.append(h('span', { class: 'fx-skin-live-chip' },
            isOurs ? '(a SkyManager skin)' : '(a SkinShift preset)'));
        else
          line.append(' · her normal skin');
        body.append(line);
      }
    }

    /* ✕ back to her own skin — ALWAYS clickable (play-test fix 2026-08-15):
       the deck can't see skins applied outside it, so gating this on our own
       record locked Rober out of resetting. Clearing with nothing applied is
       a safe no-op with an honest toast from C++. */
    /* One toolbar ROW, not a stack of full-width bars: two stacked bars ate
       the vertical space the list wants, and the deck's rule is to spend the
       screen on content. They share the row evenly and wrap at the 640px
       floor rather than squashing their labels. */
    const tools = h('div', { class: 'fx-skin-tools' });
    tools.append(h('button', {
      class: 'fx-skin-clear', type: 'button',
      title: native
        ? 'Back to ' + who + '’s own skin — removes only the texture channels '
          + 'SkyManager put on her, so anything another mod owns is untouched'
        : 'Back to ' + who + '’s own skin — SkinShift forgets the '
          + 'assignment and re-scans, so it reverts without a reload '
          + '(harmless if nothing is applied)',
      onClick: (ev) => {
        ev.stopPropagation();
        toGame('fxSet', JSON.stringify({
          formId: fxModalCtx.formId, id: P + 'clear', on: false }));
      },
    }, '✕ Her own skin'));

    /* The native provider reads packs off disk, so it can gain one mid-session
       — and an empty catalogue has to be re-checkable without a relaunch. */
    if (native)
      tools.append(h('button', {
        class: 'fx-skin-clear fx-skin-rescan', type: 'button',
        title: 'Re-read the skin packs from disk — after dropping a new pack '
          + 'into Data\\Textures\\SkyManagerSkins or Data\\BodySkin',
        onClick: (ev) => {
          ev.stopPropagation();
          toGame('fxSet', JSON.stringify({
            formId: fxModalCtx.formId, id: P + 'rescan', on: true }));
        },
      }, '⟳ Rescan packs'));
    body.append(tools);

    const all = skins.presets || [];
    if (!all.length) {
      if (native) {
        /* WHERE it looked, always — "no skins" with no path reads as broken
           rather than as empty, and the answer is usually a missing folder. */
        const roots = skins.roots || [];
        const box = h('div', { class: 'fx-empty' },
          'No skin packs found. Drop one into either of these and hit '
          + '⟳ Rescan packs:');
        roots.forEach((r) => box.append(h('div', { class: 'fx-skin-note' },
          r.path + (r.layout === 'native'
            ? '\\<pack name>\\actors\\character\\female\\femalebody_1.dds …'
            : '\\<pack name>\\Textures\\actors\\character\\… (Body Change NG layout)'))));
        body.append(box);
      } else {
        body.append(h('div', { class: 'fx-empty' },
          'No skin presets found — SkinShift reads them from '
          + 'Data/textures/removenormals/presets/Preset01…Preset99, each with '
          + 'Body / Hands / Feet / Head texture folders.'));
      }
      return;
    }

    /* Search is the modal's ONE box now (fx-global-search) — this tab reads
       it rather than owning a second input. Enter still applies the top hit,
       armed through fxTopHit instead of an onKeydown of our own. */
    const q = fxSearch.trim().toLowerCase();
    const hay = (p) => (p.name + ' ' + p.key + ' ' + (p.pack || '') + ' ' +
      (p.race || '') + ' ' + (p.sex || '') + ' ' + (p.layout || '')).toLowerCase();
    const rows = q ? all.filter((p) => hay(p).indexOf(q) >= 0) : all;

    fxTopHit = () => {
      const top = document.querySelector(
        '#fd-fx-modal .fx-skins-list .fx-act:not([disabled])');
      if (top) top.click();
    };

    const list = h('div', { class: 'fx-skins-list' });
    if (!rows.length) {
      list.append(h('div', { class: 'fx-empty' },
        'Nothing matches \u201c' + fxSearch + '\u201d.'));
    }
    rows.forEach((p) => {
      const isCur = !unknown && !!cur &&
        (cur.toLowerCase() === p.key.toLowerCase() ||
         cur.toLowerCase() === String(p.name).toLowerCase());
      /* A pack for another race/sex is SHOWN and disabled with the reason,
         never hidden: "my pack isn't in the list" is a worse bug report than
         "that pack is for a male argonian". C++ decides `fits`; an older DLL
         omits the key, and an absent key means the old always-enabled row. */
      const fits = p.fits !== false;
      const parts = (p.parts || []).join(' · ');
      const detail = (parts ? parts + ' — ' : '') +
        (p.files || 0) + ' texture file' + (p.files === 1 ? '' : 's');
      const row = h('div', { class: 'fx-row fx-skin-row' + (isCur ? ' is-current' : '') +
          (fits ? '' : ' is-unfit') },
        h('span', { class: 'fx-glyph', 'aria-hidden': 'true' }, '🎨'),
        h('span', { class: 'fx-main' },
          /* The chip earns its place only when it SAYS something the name
             doesn't: "Sunkiss Skin 4K — Female" beside a chip reading
             "female" is noise. Beast and UBE rows keep theirs, because that
             is the part a pack name never tells you. */
          h('span', { class: 'fx-label' }, p.name,
            (p.layout && p.layout !== 'female' && p.layout !== 'male')
              ? h('span', { class: 'fx-chip fx-key-chip' }, p.layout)
              : (native ? null : h('span', { class: 'fx-chip fx-key-chip' }, p.key))),
          h('span', { class: 'fx-detail' }, fits ? detail : (p.reason || detail))),
        h('button', {
          class: 'fx-act', type: 'button',
          disabled: (isCur || !fits) ? true : null,
          title: isCur
            ? p.name + ' is already applied to ' + who
            : (!fits
              ? (p.reason || 'that pack doesn’t match ' + who + '’s race or sex')
              : 'Change ' + who + '’s skin to ' + p.name + (native
                ? ' — written as RaceMenu texture overrides on her live body, '
                  + 'hands, feet and face; her meshes, armour and inventory are '
                  + 'never touched'
                : ' — through SkinShift’s own store, so it persists across '
                  + 'saves exactly as the mod intends')),
          onClick: (ev) => {
            ev.stopPropagation();
            toGame('fxSet', JSON.stringify({
              formId: fxModalCtx.formId, id: P + p.key, on: true }));
          },
        }, isCur ? 'applied' : 'Apply'));
      list.append(row);
    });
    body.append(list);

    /* The dark-elf lesson (play-test 2026-08-15): a preset is a flat texture
       set applied verbatim — human-tone skins show untinted (yellowish) on
       elf and beast races. The native provider answers half of that by
       refusing cross-race rows outright, so it earns a different footnote. */
    body.append(h('div', { class: 'fx-skin-note' }, native
      ? ('Skins are texture overrides on her live body — beast races only ever '
        + 'see beast packs, and a channel another mod already owns is left '
        + 'alone rather than painted over. Route: ' + (skins.route || '?') + '.')
      : ('Presets apply as-is: human-tone skins look untinted on elf/beast '
        + 'races — those want their own race-toned preset slot.')));
  }

  /* Styles for the tab row + skins list, injected once (the ostim-pane
     precedent) — app.css owns the base fx-* classes but is another session's
     in-flight file, so the ADDITIONS live here beside the code that uses
     them. The list's vh cap divides by --ui-scale because the .fd-modal card
     is transform-scaled (the popup vh/vw audit rule). */
  /* ---- Restraints — the ZaZ tab of the Effects modal -------------------- *
   *  zaz-effects-tab (2026-08-17). Rober: "Add Zaz Items (with mesh icons) —
   *  we have zaz in animation already but zaz if detected would be nice here
   *  as well, using mesh render framework to show the icons. Paginate please,
   *  so we dont do huge loading."
   *
   *  The catalogue is NOT rebuilt here: C++ hands over the same device list
   *  the Animations tab drives (zaz_deck owns it), so the two surfaces can
   *  never disagree. What this adds is icons and paging.
   *
   *  PAGING IS ABOUT RENDERS, NOT ROWS. A few hundred {key,name,cat} rows is
   *  a few KB — nothing. Rendering a few hundred restraint meshes through the
   *  Mesh Rendering Framework is minutes. So the whole list ships, the view
   *  pages it, and only the VISIBLE page's icons are ever requested. Renders
   *  are keep-forever, so a page revisited is instant.
   *
   *  2026-08-17 (second pass). 202 devices on Rober's install. Three things
   *  the first cut lacked, all of them the deck's own standing UI law rather
   *  than taste: a page that fills the screen (see FX_ZAZ_SIZES), a way to see
   *  ONLY what she is wearing (the tab could strip everything and could not
   *  show you anything), and a sort. Filter, category, sort and page all
   *  COMPOSE: query narrows, worn-only narrows, the category chip narrows,
   *  the sort orders what is left, and the page cuts it. Every chip's count is
   *  computed against everything upstream of it, so a chip reading 0 is the
   *  truth and not a stale tally.
   * ---------------------------------------------------------------------- */
  /* Total order, never a partial one: two devices with the same name in the
     same category must compare 0 by every route, or Array.sort is free to
     shuffle them differently on each repaint. */
  function fxZazCmp() {
    const nm = (d) => String(d.name || '').toLowerCase();
    const ct = (d) => String(d.cat || '').toLowerCase();
    const byName = (a, b) => (nm(a) < nm(b) ? -1 : nm(a) > nm(b) ? 1 : 0);
    const byCat = (a, b) => (ct(a) < ct(b) ? -1 : ct(a) > ct(b) ? 1 : byName(a, b));
    if (fxZazSort === 'name') return (a, b) => byName(a, b) || byCat(a, b);
    if (fxZazSort === 'worn')
      return (a, b) => ((a.worn ? 0 : 1) - (b.worn ? 0 : 1)) || byCat(a, b);
    return byCat;                        // 'cat' — C++'s own order, made explicit
  }

  /* The worn-only toggle, the sort and the page size, in one wrapping row.
     Everything here is a .fxp-chip: the tab already owns that vocabulary's
     hover / active / dim states, and a second button look in the same modal
     would be a near-duplicate for no reason (the design-token rule). */
  function fxZazTools(who, wornN, poolN) {
    const seg = (label, opts, cur, pick) => h('div', { class: 'fx-zaz-seg' },
      h('span', { class: 'fx-zaz-seg-l' }, label),
      ...opts.map((o) => h('button', {
        class: 'fxp-chip' + (cur === o.id ? ' on' : ''), type: 'button', title: o.title,
        onClick: () => { if (cur !== o.id) pick(o.id); },
      }, o.label)));

    const row = h('div', { class: 'fx-zaz-tools' });
    row.append(h('button', {
      class: 'fxp-chip fx-zaz-worn' + (fxZazWorn ? ' on' : '') + (wornN ? '' : ' none'),
      type: 'button',
      title: fxZazWorn
        ? 'Showing only what ' + who + ' has on — click to show the whole catalogue again'
        : (wornN
            ? 'Show only the ' + wornN + ' device' + (wornN === 1 ? '' : 's') + ' ' + who + ' is wearing'
            : who + ' is wearing nothing from this catalogue right now'),
      onClick: () => { fxZazWorn = !fxZazWorn; fxZazPage = 0; fillFxModal(); },
    }, 'Worn only', h('span', { class: 'fxp-chip-n' }, String(wornN))));

    row.append(seg('Sort', [
      { id: 'cat', label: 'Category', title: 'Grouped by kind (wrist, gag, collar…), name within each' },
      { id: 'name', label: 'Name', title: 'Straight A→Z across every kind' },
      { id: 'worn', label: 'Worn first', title: 'What ' + who + ' has on floats to the top, the rest follows by kind' },
    ], fxZazSort, (id) => { fxZazSort = id; fxZazPage = 0; fillFxModal(); }));

    /* Only worth the space once there is more than the smallest page to show. */
    if (poolN > FX_ZAZ_SIZES[0]) {
      row.append(seg('Per page', FX_ZAZ_SIZES.map((n) => ({
        id: n, label: String(n),
        title: n + ' at a time — fewer page turns, but the first visit to each '
          + 'page draws that many meshes (they are kept, so every later visit '
          + 'is instant)',
      })), fxZazSize, (n) => {
        /* Keep your place: the first tile of the page you are looking at stays
           on the page you land on, so changing the size never teleports you. */
        const first = fxZazPage * fxZazSize;
        fxZazSize = n;
        fxZazPage = Math.floor(first / n);
        fillFxModal();
      }));
    }
    return row;
  }

  /* --- the render-watch ------------------------------------------------- *
   *  A settled ask queues real mesh work; the pictures arrive whenever the
   *  framework gets to them. Nothing pushes them at the view on its own — the
   *  `icon` path rides fxState, and C++ sends fxState only in REPLY. So while
   *  a drawn page still has holes, re-read her: immediately when a render
   *  batch drains (the hd-item-icons event the Wardrobe receiver raises), and
   *  on a slow clock as the backstop for a batch that is still draining.
   *  Bounded by FX_ZAZ_REFRESH_MAX, because a device whose mesh never renders
   *  would otherwise poll for the rest of the session.
   * ---------------------------------------------------------------------- */
  function fxZazStopWatch() {
    if (fxZazPollT) { clearInterval(fxZazPollT); fxZazPollT = 0; }
  }
  function fxZazRefresh() {
    if (!fxModalCtx || fxTab !== 'zaz') { fxZazStopWatch(); return; }
    if (fxZazRefreshN >= FX_ZAZ_REFRESH_MAX) { fxZazStopWatch(); return; }
    fxZazRefreshN += 1;
    askEffects(fxModalCtx.formId, true);
  }
  function fxZazWatch(pending) {
    if (!pending || !fxModalCtx || fxZazRefreshN >= FX_ZAZ_REFRESH_MAX) {
      fxZazStopWatch();
      return;
    }
    if (fxZazPollT) return;              // already watching this fill
    fxZazPollT = setInterval(fxZazRefresh, FX_ZAZ_POLL_MS);
  }
  /* A finished render batch re-pushes the icon index; the Wardrobe receiver
     raises this only when it actually CHANGED, so this is a free "something
     landed" tick rather than a poll. */
  document.addEventListener('hd-item-icons', function () {
    if (fxModalCtx && fxTab === 'zaz') fxZazRefresh();
  });

  /* The settled icon ask, kept as a function so it can be flushed (the harness
     runs synchronously and cannot wait out a 400 ms settle). */
  function fxZazFlushAsk() {
    if (fxZazAskTimer) { clearTimeout(fxZazAskTimer); fxZazAskTimer = 0; }
    const run = fxZazAskRun;
    fxZazAskRun = null;
    if (!run) return false;
    run();
    return true;
  }

  function fillFxZaz(body, env) {
    const who = fxModalCtx ? fxModalCtx.who : 'her';
    if (!env || !env.present) {
      body.append(h('div', { class: 'fx-empty' },
        (env && env.reason) || 'ZaZ Animation Pack isn’t in the load order.'));
      return;
    }
    const all = env.devices || [];
    if (!all.length) {
      body.append(h('div', { class: 'fx-empty' },
        'ZaZ is installed but no wearable devices were found.'));
      return;
    }

    /* Category chips, from ZAP's OWN zbfWorn* taxonomy (Wrist, Gag, Collar…),
       counted against everything upstream of them — the query AND the
       worn-only toggle — so a chip showing 0 tells the truth about what
       clicking it would give you. */
    const q = fxSearch.trim().toLowerCase();
    const matches = (d) => !q ||
      ((d.name || '') + ' ' + (d.cat || '')).toLowerCase().indexOf(q) >= 0;
    const searched = all.filter(matches);
    const wornN = searched.filter((d) => d.worn).length;
    const wornAll = all.filter((d) => d.worn).length;
    const pool = fxZazWorn ? searched.filter((d) => d.worn) : searched;
    const cats = (env.cats || []).map((c) => ({
      id: c.cat, n: pool.filter((d) => d.cat === c.cat).length }));
    if (!cats.some((c) => c.id === fxZazCat)) fxZazCat = 'all';

    body.append(h('div', { class: 'fxp-chips fx-zaz-chips' },
      h('button', {
        class: 'fxp-chip' + (fxZazCat === 'all' ? ' on' : ''), type: 'button',
        title: 'Every kind of device',
        onClick: () => { fxZazCat = 'all'; fxZazPage = 0; fillFxModal(); },
      }, 'All', h('span', { class: 'fxp-chip-n' }, String(pool.length))),
      ...cats.map((c) => h('button', {
        class: 'fxp-chip' + (fxZazCat === c.id ? ' on' : '') + (c.n === 0 ? ' none' : ''),
        type: 'button', title: 'Only ' + c.id,
        onClick: () => { fxZazCat = c.id; fxZazPage = 0; fillFxModal(); },
      }, c.id, h('span', { class: 'fxp-chip-n' }, String(c.n))))));

    body.append(fxZazTools(who, wornN, pool.length));

    const shown = (fxZazCat === 'all' ? pool : pool.filter((d) => d.cat === fxZazCat))
      .slice().sort(fxZazCmp());         // slice: env.devices is the cached payload
    if (!shown.length) {
      /* An empty grid always carries the way OUT of whatever emptied it — a
         filter that hides everything and offers no escape reads as a broken
         tab, and with three filters stacked it is not obvious which one did
         it. So: say which, and give the one click that undoes it. */
      body.append(h('div', { class: 'fx-empty' },
        fxZazWorn && !wornAll ? who + ' isn’t wearing anything from this catalogue.'
          : fxZazWorn ? 'Nothing ' + who + ' is wearing matches that.'
          : q ? 'Nothing matches “' + fxSearch + '”' +
              (fxZazCat === 'all' ? '.' : ' in ' + fxZazCat + '.')
          : 'Nothing in that category.'));
      const esc = [];
      if (fxZazWorn) esc.push(h('button', {
        class: 'fx-act', type: 'button',
        title: 'Drop the worn-only filter and show the whole catalogue again',
        onClick: () => { fxZazWorn = false; fxZazPage = 0; fillFxModal(); },
      }, 'Show everything' + (searched.length ? ' (' + searched.length + ')' : '')));
      if (fxZazCat !== 'all' && pool.length) esc.push(h('button', {
        class: 'fx-act', type: 'button',
        title: 'Stop narrowing to ' + fxZazCat,
        onClick: () => { fxZazCat = 'all'; fxZazPage = 0; fillFxModal(); },
      }, 'Every kind (' + pool.length + ')'));
      if (esc.length) body.append(h('div', { class: 'fxp-acts fx-zaz-esc' }, ...esc));
      fxZazWatch(false);
      return;
    }

    const pages = Math.max(1, Math.ceil(shown.length / fxZazSize));
    if (fxZazPage >= pages) fxZazPage = pages - 1;
    if (fxZazPage < 0) fxZazPage = 0;
    const start = fxZazPage * fxZazSize;
    const page = shown.slice(start, start + fxZazSize);

    fxTopHit = () => {
      const first = page[0];
      if (!first || !fxModalCtx) return;   // the modal owns the Enter key only while it is up
      toGame('fxSet', JSON.stringify({
        formId: fxModalCtx.formId, id: 'zaz:' + first.key, on: !first.worn }));
    };

    /* Ask C++ to render just this page's meshes.
       ⛔ ONCE PER KEY PER SESSION, and only after the list has stopped moving.
       The comment here used to say firing on every repaint was safe because
       anything on disk is free — it is not: a repaint re-asks for the pieces
       that are still RENDERING, and each ask queues real mesh work on the
       game's D3D device. Rober's log, 2026-08-17: five identical
       'zaz: effects view' requests inside 72 ms, each queueing seven renders,
       with the game frozen while they ran. This is the Items tab's
       settle-gate lesson (items-icon-settle) arriving late. */
    const need = page.filter((d) => !d.icon && !fxZazAsked[d.key]).map((d) => d.key);
    if (need.length && env.iconsAvailable !== false) {
      const fid = fxModalCtx ? fxModalCtx.formId : 0;
      fxZazAskRun = () => {
        /* ⛔ The modal can be closed — or reopened on someone else — inside the
           settle window. This used to read fxModalCtx.formId unguarded and
           threw an uncaught TypeError every time that happened; in this engine
           an uncaught error is never merely a lost ask. */
        if (!fxModalCtx || fxModalCtx.formId !== fid || fxTab !== 'zaz') return;
        const still = need.filter((k) => !fxZazAsked[k]);
        if (!still.length) return;
        still.forEach((k) => { fxZazAsked[k] = 1; });
        fxZazRefreshN = 0;               // a new page earns a fresh watch budget
        toGame('fxSet', JSON.stringify({
          formId: fid, id: 'zaz:icons:' + still.join(','), on: true }));
      };
      if (fxZazAskTimer) clearTimeout(fxZazAskTimer);
      fxZazAskTimer = setTimeout(fxZazFlushAsk, FX_ZAZ_SETTLE_MS);
    } else if (fxZazAskRun) {
      /* This page needs nothing — so neither does the ask armed by whatever
         the list looked like a moment ago. Dropping it here is what makes the
         gate a SETTLE gate rather than a delay: only the list you stopped on
         ever queues work. */
      fxZazAskRun = null;
      if (fxZazAskTimer) { clearTimeout(fxZazAskTimer); fxZazAskTimer = 0; }
    }

    /* The loading line Rober asked for ("needs a loading indicator or a speed
       up or something"). Honest and specific: how many of THIS page are still
       being drawn, not a spinner that cannot say whether anything is happening.
       It counts down and disappears by itself because of the render-watch
       below: a fresh fxState is the only thing that can carry a new icon path
       into the view, and nothing sends one unless we ask. */
    const pending = page.filter((d) => !d.icon).length;
    const live = pending > 0 && env.iconsAvailable !== false;
    if (live) {
      body.append(h('div', { class: 'fxp-loading' },
        h('span', { class: 'fxp-spin' }, '⟳'),
        fxZazRefreshN >= FX_ZAZ_REFRESH_MAX
          /* Honest ending: the watch is spent. Some of these have no mesh the
             framework can draw, and a line that says "drawing…" forever about
             a picture that is never coming is the lie the loading line exists
             to avoid. */
          ? pending + ' of ' + page.length + ' still have no picture — turn the '
            + 'page and back to look again'
          : 'Drawing ' + pending + ' of ' + page.length
            + ' — first look at a page only, they are kept after that'));
    }
    /* Re-read her while pictures are still coming (see the render-watch). */
    fxZazWatch(live);

    body.append(h('div', { class: 'fxp-grid fx-zaz-grid' }, ...page.map((d) => {
      const tile = h('button', {
        class: 'fxp-tile' + (d.worn ? ' on' : ''), type: 'button', 'data-key': d.key,
        title: (d.worn ? 'Take off ' + who + ': ' : 'Put on ' + who + ': ') + d.name
          + '\n' + d.cat
          + (Array.isArray(d.slots) && d.slots.length
              ? '\nBody slot' + (d.slots.length > 1 ? 's' : '') + ': ' + d.slots.join(', ')
                + ' — anything else on those is displaced'
              : '')
          + '\napplied through ZAP’s own equip event, so its pose '
          + 'and effect fire when the deck closes',
        onClick: () => {
          toGame('fxSet', JSON.stringify({
            formId: fxModalCtx.formId, id: 'zaz:' + d.key, on: !d.worn }));
        },
      });
      const shot = h('div', { class: 'fxp-shot' });
      if (d.icon) {
        const img = h('img', { src: d.icon, alt: d.name, loading: 'lazy' });
        img.onerror = function () {
          this.remove();
          shot.append(h('span', { class: 'fxp-noshot' }, '⛓'));
        };
        shot.append(img);
      } else {
        /* Not "no preview" — it is very likely still rendering, and saying
           "missing" about something that is about to appear is a lie. */
        shot.append(h('span', { class: 'fxp-noshot' },
          env.iconsAvailable === false ? '⛓' : 'rendering…'));
      }
      /* ⛔ h() skips null children; Element.append() STRINGIFIES them, so the
         old `d.worn ? … : null` in this call printed the word "null" under
         every device that was not worn. Rober saw it on all 202 of them. */
      const slots = Array.isArray(d.slots) ? d.slots : [];
      tile.append(shot,
        h('div', { class: 'fxp-name' }, d.name),
        /* The ON pill sits INLINE beside the category now. It used to be
           absolutely positioned over the top-right of the tile, where it
           landed on the render — an overlap that only appeared once something
           was actually worn, which is why it survived the overlap pass. */
        h('div', { class: 'fxp-sub' },
          h('span', { class: 'fxp-cat' }, d.cat),
          slots.length ? h('span', { class: 'fxp-slots', title: 'Uses body slot'
            + (slots.length > 1 ? 's' : '') + ': ' + slots.join(', ')
            + '\nAnything else on the same slot is displaced when this goes on.' },
            '⛶ ' + (slots.length > 2 ? slots.length + ' slots' : slots.join(' · '))) : null,
          d.worn ? h('span', { class: 'fxp-on' }, 'ON') : null));
      return tile;
    })));

    /* Pager. Always rendered when there is more than one page, with the range
       spelled out — "showing 25–48 of 312" is the thing that tells you the
       list is big without you having to count. */
    if (pages > 1) {
      body.append(h('div', { class: 'fx-pager' },
        h('button', {
          class: 'fx-act', type: 'button', disabled: fxZazPage === 0,
          title: 'Previous page',
          onClick: () => { fxZazPage -= 1; fillFxModal(); },
        }, '‹ Prev'),
        h('span', { class: 'fx-pager-n' },
          'Showing ' + (start + 1) + '–' + (start + page.length) +
          ' of ' + shown.length + '  ·  page ' + (fxZazPage + 1) + '/' + pages +
          (fxZazWorn ? '  ·  worn only' : '')),
        h('button', {
          class: 'fx-act', type: 'button', disabled: fxZazPage >= pages - 1,
          title: 'Next page',
          onClick: () => { fxZazPage += 1; fillFxModal(); },
        }, 'Next ›')));
    }

    body.append(h('div', { class: 'fxp-acts' },
      h('button', {
        class: 'fx-act danger', type: 'button', disabled: !wornAll,
        title: wornAll
          ? 'Strip every ZaZ device ' + who + ' is wearing, in one go — ' + wornAll
            + ' piece' + (wornAll === 1 ? '' : 's')
          : who + ' is wearing nothing from this catalogue',
        onClick: () => {
          if (!fxModalCtx) return;
          toGame('fxSet', JSON.stringify({
            formId: fxModalCtx.formId, id: 'zaz:free', on: false }));
        },
      }, 'Free ' + who),
      /* The companion to the strip button: it is the only way to SEE what that
         button would take off, so it belongs beside it as well as in the tools
         row — one click from "what is she wearing" to "take it all off". */
      wornAll && !fxZazWorn ? h('button', {
        class: 'fx-act', type: 'button',
        title: 'List only the ' + wornAll + ' device' + (wornAll === 1 ? '' : 's')
          + ' ' + who + ' has on',
        onClick: () => { fxZazWorn = true; fxZazCat = 'all'; fxZazPage = 0; fillFxModal(); },
      }, 'Show what’s on (' + wornAll + ')') : null));

    body.append(h('div', { class: 'fxp-note' },
      env.iconsAvailable === false
        ? 'Mesh Rendering Framework isn’t loaded, so these stay as glyphs.'
        : 'Icons render a page at a time and are kept, so pages you have '
          + 'already seen open instantly — a bigger page is fewer turns, at the '
          + 'cost of a longer first fill.'));
  }

  /* ---- Pubes — the OPubes NG tab of the Effects modal ------------------- *
   *  pubes-tab (2026-08-17). Rober: "new detection based tab … of the picker
   *  that you can apply to an npc and it saves", with "a preview of the
   *  pubes". OPubes itself can only roll RANDOMLY or cycle — there is no way
   *  to say "give her THAT one" — so this tab is the picker the mod lacks.
   *
   *  Everything painted here comes from the `pubes` block of fxState, which
   *  C++ built by reading OPubes' OWN catalogue files. Choosing fires fxSet
   *  with id "pubes:<key>"; "pubes:clear" shaves; "pubes:rescan" re-reads.
   *  Each tile's picture is a PNG baked from that style's overlay texture,
   *  so you pick by looking rather than by parsing a filename.
   * ---------------------------------------------------------------------- */
  function fillFxPubes(body, env) {
    const who = fxModalCtx ? fxModalCtx.who : 'her';
    if (!env) {
      body.append(h('div', { class: 'fx-empty' }, 'Reading the OPubes catalogue…'));
      return;
    }
    if (env.scanning) {
      /* A skeleton sized like the real grid, so the panel does not jump when
         the tiles land (the UI rules' loading-state requirement). */
      body.append(h('div', { class: 'fxp-note' },
        'Reading OPubes’ catalogue and drawing previews — this happens once.'));
      body.append(h('div', { class: 'fxp-grid' }, ...Array.from({ length: 8 }, () =>
        h('div', { class: 'fxp-tile fxp-skel' },
          h('div', { class: 'fxp-shot' }), h('div', { class: 'fxp-name' })))));
      return;
    }
    if (!env.available) {
      body.append(h('div', { class: 'fx-empty' },
        env.reason || 'No pube styles are available on this load order.'));
      fxPubesPacks(body, env);
      return;
    }

    const styles = env.styles || [];
    const counts = env.counts || {};
    const cur = env.current || null;

    /* Type chips with live counts — the four states of the one filter that is
       not free text. `all` first because it is the common case. */
    const chips = [
      { id: 'all', label: 'All', n: styles.length },
      { id: 'normal', label: 'Normal', n: counts.normal || 0 },
      { id: 'stylish', label: 'Stylish', n: counts.stylish || 0 },
      { id: 'hairy', label: 'Hairy', n: counts.hairy || 0 },
    ].filter((c) => c.n > 0);
    if (!chips.some((c) => c.id === fxPubesType)) fxPubesType = 'all';

    body.append(h('div', { class: 'fxp-head' },
      h('div', { class: 'fxp-chips' }, ...chips.map((c) => h('button', {
        class: 'fxp-chip' + (fxPubesType === c.id ? ' on' : ''), type: 'button',
        title: c.id === 'all' ? 'Every style' : 'Only the ' + c.label.toLowerCase() + ' ones',
        onClick: () => { fxPubesType = c.id; fillFxModal(); },
      }, c.label, h('span', { class: 'fxp-chip-n' }, String(c.n)))))));

    const q = fxSearch.trim().toLowerCase();
    const shown = styles.filter((s) =>
      (fxPubesType === 'all' || s.type === fxPubesType) &&
      (!q || (s.name + ' ' + (s.pack || '') + ' ' + s.type).toLowerCase().indexOf(q) >= 0));

    /* Enter applies the top hit — armed here rather than owned by an input,
       because the search box lives in the modal chrome now (see fxSearch). */
    fxTopHit = () => {
      const top = document.querySelector('#fd-fx-modal .fxp-tile[data-key]');
      if (top) top.click();
    };

    if (!shown.length) {
      body.append(h('div', { class: 'fx-empty' }, q
        ? 'Nothing matches “' + fxSearch + '”.'
        : 'Nothing in that category.'));
    } else {
      body.append(h('div', { class: 'fxp-grid' }, ...shown.map((s) => {
        const on = cur && cur === s.key;
        const tile = h('button', {
          class: 'fxp-tile' + (on ? ' on' : ''), type: 'button', 'data-key': s.key,
          title: (on ? 'Already on ' + who + ' — ' : 'Put on ' + who + ': ')
            + s.name + ' · ' + s.type + ' · from ' + (s.pack || 'unknown pack')
            + '\nApplied through OPubes’ own machinery, so it persists exactly as that mod intends.',
          onClick: () => {
            toGame('fxSet', JSON.stringify({
              formId: fxModalCtx.formId, id: 'pubes:' + s.key, on: true }));
          },
        });
        const shot = h('div', { class: 'fxp-shot' });
        if (s.icon) {
          /* An <img> with a text fallback that removes ITSELF on error, so a
             tile whose PNG never baked degrades to a word rather than a
             broken-image box (the deck's standing icon rule). */
          const img = h('img', { src: s.icon, alt: s.name, loading: 'lazy' });
          img.onerror = function () {
            this.remove();
            shot.append(h('span', { class: 'fxp-noshot' }, 'no preview'));
          };
          shot.append(img);
        } else {
          shot.append(h('span', { class: 'fxp-noshot' }, 'no preview'));
        }
        tile.append(shot,
          h('div', { class: 'fxp-name' }, s.name),
          h('div', { class: 'fxp-sub' }, s.type),
          on ? h('span', { class: 'fxp-on' }, 'ON') : null);
        /* Zoom — Rober asked for "a lightbox popout so I can see better". The
           deck already owns one (HDLightbox, built for exactly this on the
           Items/NPC rows), so this reuses it rather than inventing a second.
           It is its OWN control, not the tile's click: the tile applies, and
           an accidental apply while browsing is the annoying failure. */
        if (s.icon && window.HDLightbox) {
          tile.append(h('button', {
            class: 'fxp-zoom', type: 'button', title: 'Look at ' + s.name + ' bigger',
            'aria-label': 'Enlarge ' + s.name,
            onClick: (ev) => {
              ev.stopPropagation();          // never apply just because they looked
              window.HDLightbox.open({
                /* Mount on the modal BACKDROP, not the card: the backdrop is
                   fixed inset:0, so the popout fills the screen instead of
                   being clipped to the card's rounded box. */
                host: document.getElementById('fd-fx-modal') || document.body,
                src: s.icon,
                title: s.name,
                sub: s.type + ' · ' + (s.pack || 'unknown pack')
                  + ' · tinted in game from her hair colour',
                glyph: '·',
              });
            },
          }, '⌕'));
        }
        return tile;
      })));
    }

    /* Actions. "Shaved" is OPubes' own removal path, not a bare strip. */
    body.append(h('div', { class: 'fxp-acts' },
      h('button', {
        class: 'fx-act' + (cur ? ' danger' : ''), type: 'button', disabled: !cur,
        title: cur
          ? 'Shave ' + who + ' — OPubes’ own removal, so its bookkeeping stays in step'
          : 'Nothing of ours is on ' + who,
        onClick: () => toGame('fxSet', JSON.stringify({
          formId: fxModalCtx.formId, id: 'pubes:clear', on: false })),
      }, 'Shaved'),
      h('button', {
        class: 'fx-act', type: 'button',
        title: 'Re-read OPubes’ catalogue and draw any missing preview — after installing a new pack',
        onClick: () => toGame('fxSet', JSON.stringify({
          formId: fxModalCtx.formId, id: 'pubes:rescan', on: false })),
      }, 'Rescan')));

    body.append(h('div', { class: 'fxp-note' },
      cur
        ? 'Wearing ' + (env.currentName || cur) + '. OPubes tints it from ' + who
          + '’s hair colour, so the shade on the body follows her, not the tile.'
        : 'OPubes can only roll these at random — this picker is the deck’s. '
          + 'The tile is the raw overlay; in game it is tinted from her hair colour.'));

    fxPubesPacks(body, env);
  }

  /* The detection report. This is the POINT of a detection-based tab: it says
     what the load order actually offers, and names what it found broken —
     on this rig two of OPubes' three shipped packs are dead, which is
     invisible in game and would otherwise read as "the mod is just like
     that". */
  function fxPubesPacks(body, env) {
    const packs = (env && env.packs) || [];
    if (!packs.length) return;
    const bad = packs.filter((p) => !p.ok);
    const wrap = h('details', { class: 'fxp-packs' },
      h('summary', {},
        'Packs detected: ' + packs.filter((p) => p.ok).length + ' of ' + packs.length,
        bad.length ? h('span', { class: 'fxp-warn' }, bad.length + ' skipped') : null));
    packs.forEach((p) => {
      wrap.append(h('div', { class: 'fxp-pack' + (p.ok ? '' : ' is-bad') },
        h('span', { class: 'fxp-pack-n' }, p.name),
        h('span', { class: 'fxp-pack-d' }, p.ok
          ? (p.count + ' ' + (p.sex === 'male' ? 'male ' : '') + 'styles')
          : (p.reason || 'skipped'))));
    });
    body.append(wrap);
  }

  /* The modal's own chrome: it is no longer a narrow list of three toggles but
     a browser over hundreds of things, so it gets its own size rather than the
     shared .fd-modal 560px (Rober, 2026-08-17: "we may want to increase the
     modal popout width vertically and horizontally as well").
     ⚠ Scoped to #fd-fx-modal — .fd-modal is shared with the settings modal and
     widening that too would be an unrelated change nobody asked for.
     ⚠ Both caps are DIVIDED by --ui-scale: .fd-modal carries
     transform:scale(var(--ui-scale)), so a bare vw/vh would overflow the real
     viewport at any scale above 1 (CLAUDE.md's vh rule). */
  function fxEnsureModalStyles() {
    if (document.getElementById('fx-modal-style')) return;
    const st = document.createElement('style');
    st.id = 'fx-modal-style';
    st.textContent =
      '#fd-fx-modal .fd-modal{width:min(1120px, calc(95vw / var(--ui-scale,1)));' +
        'max-height:calc(90vh / var(--ui-scale,1));}' +
      '.fx-search{width:100%;box-sizing:border-box;font:inherit;font-size:17px;' +
        'padding:13px 16px;margin:12px 0 4px;border-radius:10px;color:#f6ecc8;' +
        'background:#16161c;border:1px solid #3a382f;' +
        'transition:border-color .12s ease,background .12s ease;}' +
      '.fx-search::placeholder{color:#6f6a5d;}' +
      '.fx-search:hover{border-color:#5a5647;}' +
      '.fx-search:focus{outline:none;border-color:#c9a24b;background:#1a1a20;}' +
      /* Tab count badges while a search is live. A zero-match tab dims rather
         than disappearing — a tab that vanishes as you type is disorienting. */
      '.fx-tab{display:inline-flex;align-items:center;justify-content:center;gap:8px;}' +
      '.fx-tab-n{font-size:12px;font-weight:800;padding:1px 7px;border-radius:999px;' +
        'background:rgba(240,214,140,.16);color:#f0d68c;}' +
      '.fx-tab.none{opacity:.45;}' +
      '.fx-tab.none .fx-tab-n{background:rgba(255,255,255,.07);color:#8a8577;}' +
      '.fxp-chip.none{opacity:.5;}' +
      '.fx-mod-chips,.fx-zaz-chips{margin-bottom:14px;}' +
      /* Pager */
      '.fx-pager{display:flex;align-items:center;gap:14px;margin-top:14px;' +
        'flex-wrap:wrap;}' +
      '.fx-pager-n{font-size:13px;color:#8a8577;}' +
      /* The Zaz grid can be taller than the pubes one — the modal is bigger
         now and a restraint tile is the thing you scan through most. */
      '.fx-zaz-grid{max-height:calc(52vh / var(--ui-scale,1));}' +
      '@media (max-width:820px){#fd-fx-modal .fd-modal{width:calc(96vw / var(--ui-scale,1));}' +
        '.fx-search{font-size:16px;}}';
    document.head.appendChild(st);
  }

  function fxEnsureZazStyles() {
    /* The Zaz tab reuses the Pubes tab's tile/grid/chip vocabulary wholesale —
       same shape of problem, same widgets. Only the grid height differs, and
       that lives in fxEnsureModalStyles. So this guarantees the shared sheets
       are present when Restraints is the first tab opened, and adds the one
       row of chrome only this tab has. */
    fxEnsurePubesStyles();
    fxEnsureModalStyles();
    if (document.getElementById('fx-zaz-style')) return;
    const st = document.createElement('style');
    st.id = 'fx-zaz-style';
    st.textContent =
      /* One wrapping row: worn-only, then Sort, then Per page. It WRAPS rather
         than shrinking — at the deck's narrow floor each group drops to its own
         line intact, which is the difference between three readable groups and
         three squashed ones (the eleven-button quick-card row lesson). */
      '.fx-zaz-tools{display:flex;align-items:center;flex-wrap:wrap;' +
        'gap:10px 18px;margin:0 0 14px;}' +
      '.fx-zaz-seg{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;}' +
      '.fx-zaz-seg-l{font-size:12.5px;font-weight:800;letter-spacing:.06em;' +
        'text-transform:uppercase;color:#6f6a5d;white-space:nowrap;}' +
      /* Nothing under 12px, and the chips here sit a touch tighter than the
         category rail above so the two rows read as chrome, not as one soup. */
      '.fx-zaz-tools .fxp-chip{font-size:13.5px;padding:7px 13px;}' +
      '.fx-zaz-worn.on{color:#1a1a12;background:#f0d68c;border-color:#f0d68c;}' +
      '.fx-zaz-worn.on .fxp-chip-n{color:#1a1a12;opacity:.7;}' +
      '.fx-zaz-worn.on:hover{background:#f6e2a6;border-color:#f6e2a6;color:#1a1a12;}' +
      '.fx-zaz-esc{flex-wrap:wrap;}' +
      /* A dead control must LOOK dead, and must not light up on hover. */
      '#fd-fx-modal .fx-act[disabled]{opacity:.42;cursor:default;}' +
      '#fd-fx-modal .fx-act.danger[disabled]:hover{background:rgba(214,118,96,.08);' +
        'border-color:rgba(214,118,96,.35);}' +
      '#fd-fx-modal .fx-act[disabled]:active{transform:none;}' +
      /* The tools row costs the card ~44px of height, which at the deck's
         narrow floor was enough to push "Free her" past the card's own 90vh
         cap and into a second, nested scrollbar. Give the grid that height
         back at narrow widths — it is the one thing on this tab that scrolls
         on purpose. */
      '@media (max-width:820px){.fx-zaz-grid{max-height:calc(40vh / var(--ui-scale,1));}' +
        '.fx-zaz-tools{gap:8px 12px;margin-bottom:12px;}}';
    document.head.appendChild(st);
  }

  function fxEnsurePubesStyles() {
    if (document.getElementById('fx-pubes-style')) return;
    const st = document.createElement('style');
    st.id = 'fx-pubes-style';   /* pubes-tab styles — every class namespaced
       .fxp-* because a pane sharing a class with the deck's skeleton is the
       bug that laid out the survival search box seven pixels tall. */
    st.textContent =
      '.fxp-head{display:flex;flex-direction:column;gap:10px;margin-bottom:14px;}' +
      '.fxp-filter{font:inherit;font-size:16px;padding:12px 14px;border-radius:9px;' +
        'color:#f6ecc8;background:#16161c;border:1px solid #3a382f;width:100%;' +
        'box-sizing:border-box;transition:border-color .12s ease;}' +
      '.fxp-filter::placeholder{color:#6f6a5d;}' +
      '.fxp-filter:hover{border-color:#5a5647;}' +
      '.fxp-filter:focus{outline:none;border-color:#c9a24b;}' +
      '.fxp-chips{display:flex;gap:8px;flex-wrap:wrap;}' +
      '.fxp-chip{font:inherit;font-size:14px;font-weight:700;padding:8px 14px;' +
        'border-radius:999px;cursor:pointer;color:#8a8577;background:#16161c;' +
        'border:1px solid #3a382f;display:inline-flex;align-items:center;gap:7px;' +
        'transition:background .12s ease,border-color .12s ease,color .12s ease;}' +
      '.fxp-chip:hover{border-color:#c9a24b;color:#ecd9a0;background:#1e1c16;}' +
      '.fxp-chip.on{color:#f6ecc8;background:rgba(240,214,140,.14);' +
        'border-color:rgba(240,214,140,.55);}' +
      '.fxp-chip-n{font-size:12px;opacity:.75;}' +
      /* auto-fill keeps the tiles a readable size whether there are 3 or 300,
         and the grid scrolls INSIDE the modal rather than stretching it.
         ⚠ The vh cap is DIVIDED by --ui-scale: .fd-modal carries
         `transform: scale(var(--ui-scale))`, so this element has that
         transform on an ancestor and a bare vh would be wrong at any scale
         but 1 — the same reason .fx-skins-list divides (CLAUDE.md's vh rule). */
      '.fxp-grid{display:grid;gap:12px;overflow-y:auto;padding:2px;' +
        'max-height:calc(46vh / var(--ui-scale,1));' +
        'grid-template-columns:repeat(auto-fill,minmax(132px,1fr));}' +
      '.fxp-tile{position:relative;font:inherit;text-align:left;cursor:pointer;' +
        'padding:10px;border-radius:11px;color:#cfc7ae;background:#16161c;' +
        'border:1px solid #3a382f;display:flex;flex-direction:column;gap:8px;' +
        'transition:background .12s ease,border-color .12s ease,transform .12s ease;}' +
      '.fxp-tile:hover{border-color:#c9a24b;background:#1e1c16;transform:translateY(-1px);}' +
      '.fxp-tile:focus-visible{outline:2px solid #c9a24b;outline-offset:2px;}' +
      '.fxp-tile:active{transform:translateY(0);}' +
      '.fxp-tile.on{border-color:rgba(240,214,140,.7);background:rgba(240,214,140,.12);' +
        'color:#f6ecc8;}' +
      '.fxp-shot{height:96px;border-radius:8px;overflow:hidden;background:#0f0f13;' +
        'display:flex;align-items:center;justify-content:center;}' +
      '.fxp-shot img{max-width:100%;max-height:100%;display:block;}' +
      '.fxp-noshot{font-size:12px;color:#6f6a5d;}' +
      '.fxp-name{font-size:15px;font-weight:700;line-height:1.25;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.fxp-sub{font-size:12px;color:#8a8577;text-transform:capitalize;' +
        'display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;}' +
      '.fxp-cat{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}' +
      /* Which biped slots the piece occupies. Muted until hover — it is the
         answer to "what will this displace", which you want when you are
         deciding, not while you are scanning names. */
      '.fxp-loading{display:flex;align-items:center;gap:8px;margin:0 0 8px;' +
        'font-size:13px;color:#a79a72;}' +
      /* No @keyframes: hud.css's no-looping-animation law applies to every
         always-on surface, and a spinning glyph in a paused menu is exactly the
         kind of forever-animation that keeps Ultralight repainting. */
      '.fxp-spin{font-size:14px;color:#c9a24b;}' +
      '.fxp-slots{font-size:11px;color:#6f6a5d;white-space:nowrap;' +
        'padding:1px 6px;border-radius:999px;border:1px solid #34322b;}' +
      '.fxp-tile:hover .fxp-slots{color:#a79a72;border-color:#4a4638;}' +
      '.fxp-on{font-size:11px;font-weight:800;margin-left:auto;' +
        'letter-spacing:.06em;padding:2px 8px;border-radius:999px;color:#1a1a12;' +
        'background:#f0d68c;}' +
      /* Zoom sits bottom-right of the picture, opposite the ON chip so the two
         can never collide. Always visible (not hover-only): the deck is driven
         from a couch with a mouse that is often not moving, and a control you
         have to discover by hovering is a control that does not exist. */
      '.fxp-zoom{position:absolute;top:78px;right:14px;width:26px;height:26px;' +
        'display:flex;align-items:center;justify-content:center;font:inherit;' +
        'font-size:14px;line-height:1;border-radius:7px;cursor:pointer;' +
        'color:#cfc7ae;background:rgba(12,12,16,.72);border:1px solid #3a382f;' +
        'transition:background .12s ease,border-color .12s ease,color .12s ease;}' +
      '.fxp-zoom:hover{color:#f6ecc8;border-color:#c9a24b;background:rgba(30,28,22,.95);}' +
      '.fxp-zoom:focus-visible{outline:2px solid #c9a24b;outline-offset:2px;}' +
      /* The popout mounts into the modal backdrop, which is already z-index 60;
         lift it over the card that sits in the same stacking context. */
      '#fd-fx-modal .hdlb{z-index:70;}' +
      '.fxp-acts{display:flex;gap:10px;margin-top:14px;}' +
      '.fxp-acts .fx-act{flex:0 0 auto;}' +
      '.fxp-note{font-size:13px;line-height:1.5;color:#8a8577;margin-top:12px;}' +
      '.fxp-packs{margin-top:14px;border-top:1px solid #2c2a24;padding-top:12px;}' +
      '.fxp-packs summary{font-size:14px;color:#8a8577;cursor:pointer;' +
        'display:flex;align-items:center;gap:10px;}' +
      '.fxp-packs summary:hover{color:#ecd9a0;}' +
      '.fxp-warn{font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;' +
        'color:#f0c98c;background:rgba(240,160,90,.16);' +
        'border:1px solid rgba(240,160,90,.4);}' +
      '.fxp-pack{display:flex;gap:10px;justify-content:space-between;' +
        'font-size:13px;padding:7px 2px;border-bottom:1px solid #232119;}' +
      '.fxp-pack:last-child{border-bottom:none;}' +
      '.fxp-pack-n{color:#cfc7ae;font-weight:600;}' +
      '.fxp-pack-d{color:#8a8577;text-align:right;}' +
      '.fxp-pack.is-bad .fxp-pack-n{color:#8a8577;}' +
      '.fxp-pack.is-bad .fxp-pack-d{color:#c9955f;}' +
      /* Skeleton: sized like a real tile so nothing shifts when data lands. */
      '.fxp-skel{pointer-events:none;}' +
      '.fxp-skel .fxp-shot{background:#1a1a20;}' +
      '.fxp-skel .fxp-name{height:15px;border-radius:4px;background:#1a1a20;}' +
      '@media (max-width:700px){.fxp-grid{grid-template-columns:repeat(auto-fill,minmax(108px,1fr));}}';
    document.head.appendChild(st);
  }

  function fxEnsureSkinStyles() {
    if (document.getElementById('fx-skins-style')) return;
    const st = document.createElement('style');
    st.id = 'fx-skins-style';   /* skinshift-skins-tab styles */
    st.textContent =
      '.fx-tabs{display:flex;gap:8px;margin-bottom:12px;}' +
      '.fx-tab{flex:1;font:inherit;font-size:14px;font-weight:700;' +
        'padding:10px 12px;border-radius:9px;cursor:pointer;' +
        'color:#8a8577;background:#16161c;border:1px solid #3a382f;' +
        'transition:background .12s ease,border-color .12s ease,color .12s ease;}' +
      '.fx-tab:hover{border-color:#c9a24b;color:#ecd9a0;background:#1e1c16;}' +
      '.fx-tab.on{color:#f6ecc8;background:rgba(240,214,140,.14);' +
        'border-color:rgba(240,214,140,.55);}' +
      '.fx-skin-cur{font-size:14.5px;font-weight:700;color:#e9e2cf;' +
        'padding:2px 2px 10px;}' +
      '.fx-skin-gate{color:#d6a860;}' +
      /* 13.5px: this line is the verdict surface — "what is she ACTUALLY
         wearing" — so it is read on every apply. Nothing read that often
         gets to be small (Rober's standing UI rule). */
      '.fx-skin-live{font-size:13.5px;color:#a9a08a;line-height:1.5;' +
        'padding:0 2px 10px;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;}' +
      '.fx-skin-swatch{display:inline-block;width:12px;height:12px;' +
        'border-radius:3px;border:1px solid rgba(255,255,255,.25);' +
        'vertical-align:-1px;}' +
      '.fx-skin-live-chip{color:#ecd9a0;font-weight:700;margin-left:6px;}' +
      /* 13.5px, not 12.5: this foot-note is real copy that answers "why did
         nothing happen", and the deck's standing rule is that nothing a
         person has to READ gets to be small. */
      '.fx-skin-note{font-size:13.5px;color:#a9a08a;line-height:1.5;' +
        'padding:12px 2px 2px;}' +
      /* The two toolbar buttons share one row and wrap instead of squashing
         at the deck's 640px floor. */
      '.fx-skin-tools{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.fx-skin-tools .fx-skin-clear{flex:1 1 220px;margin-bottom:0;}' +
      /* Which engine is live, as a chip on the header line. */
      '.fx-skin-prov{margin-left:10px;padding:3px 9px;border-radius:999px;' +
        'font-size:12.5px;font-weight:700;letter-spacing:.02em;' +
        'color:#e6d6a6;background:rgba(240,214,140,.10);' +
        'border:1px solid rgba(240,214,140,.30);white-space:nowrap;}' +
      '.fx-skin-clear{display:block;width:100%;box-sizing:border-box;' +
        'margin-bottom:10px;padding:11px 12px;border-radius:9px;cursor:pointer;' +
        'font:inherit;font-size:13.5px;font-weight:700;text-align:left;' +
        'color:#e7b7ad;background:rgba(214,118,96,.07);' +
        'border:1px solid rgba(214,118,96,.3);' +
        'transition:background .12s ease,border-color .12s ease;}' +
      '.fx-skin-clear:hover:not([disabled]){background:rgba(214,118,96,.15);' +
        'border-color:rgba(214,118,96,.6);}' +
      '.fx-skin-clear[disabled]{opacity:.5;cursor:default;}' +
      /* Rescan is the same shape as "her own skin" but reads as a utility,
         not a revert — parchment gold instead of the clear button's red. */
      '.fx-skin-rescan{color:#e6d6a6;background:rgba(240,214,140,.06);' +
        'border-color:rgba(240,214,140,.28);}' +
      '.fx-skin-rescan:hover:not([disabled]){background:rgba(240,214,140,.14);' +
        'border-color:rgba(240,214,140,.55);}' +
      /* A pack that can't go on this actor stays visible and LEGIBLE. Dimming
         the whole row was the easy way and the wrong one — the row's job in
         that state is to be read, because it carries the reason. So: mute the
         plate, keep the text at full strength, and let the reason italicise
         itself. */
      '.fx-skin-row.is-unfit{background:rgba(255,255,255,.02);' +
        'border-color:rgba(255,255,255,.07);}' +
      '.fx-skin-row.is-unfit .fx-glyph{opacity:.45;}' +
      '.fx-skin-row.is-unfit .fx-detail{color:#b9a98a;font-style:italic;}' +
      /* A disabled Apply MUST NOT look like an enabled one. Measured from the
         2026-09-06 screenshot: the incompatible row's button rendered pixel-
         identical to a live one (max luma 222 both), because the generic
         `#fd-fx-modal .fx-act[disabled]` rule lives in a sheet this surface
         cannot count on. So the skins sheet states it itself: gold means
         clickable, grey means it will not do anything. */
      '.fx-skin-row .fx-act[disabled]{cursor:not-allowed;}' +
      '.fx-skin-row.is-unfit .fx-act[disabled]{color:#7e7767;' +
        'background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.10);}' +
      '.fx-skin-row.is-unfit .fx-act[disabled]:hover{' +
        'background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.10);' +
        'color:#7e7767;}' +
      '.fx-skins-list{max-height:calc(44vh / var(--ui-scale,1));' +
        'overflow-y:auto;padding-right:2px;}' +
      '.fx-skin-row .fx-key-chip{flex:none;}' +
      '.fx-row.is-current{background:rgba(240,214,140,.14);' +
        'border-color:rgba(240,214,140,.6);}' +
      '.fx-row.is-current .fx-act[disabled]{opacity:.7;cursor:default;' +
        'color:#f6ecc8;background:rgba(240,214,140,.14);' +
        'border-color:rgba(240,214,140,.5);}';
    document.head.appendChild(st);
  }

  /* ---- 🫧 Body — the CBBE 3BA tab of the Effects modal ------------------ *
   *  Rober (2026-08-16): "add to the f7 on npc effects menu dll integration
   *  support for CBBE 3BA (specifically the toggle npc physics) - change cup,
   *  - also im not sure how OSMP 3BA plays into account".
   *
   *  3BA gives every female body two physics engines and one switch: CBPC
   *  (cheap, always running) or HDT-SMP (cloth sim). The switch is an
   *  invisible armor she wears; the CUP (A–D) picks which of four SMP configs
   *  that armor carries. It is a JIGGLE PROFILE — 3BA's own MCM says in so
   *  many words "This does NOT affect breast size!" — and the tab says so too,
   *  because "cup" reads as size to everyone who has not read the script.
   *
   *  The view paints only what `body` in fxState reports and fires fxSet with
   *  "3ba:…" ids; C++ drives 3BA's OWN MCM functions, and the fresh fxState
   *  riding every fxResult repaints this tab exactly like the effects rows. */
  function fillFxBody(body, env) {
    const who = fxModalCtx ? fxModalCtx.who : 'her';
    if (!env || !env.available) {
      body.append(h('div', { class: 'fx-empty fx-skin-gate' },
        (env && env.reason) || 'CBBE 3BA’s MCM didn’t answer.'));
      return;
    }
    const smp = env.mode === 'smp';
    const blocked = env.blocked || '';
    const isPlayer = !!env.isPlayer;

    /* Where she is right now — the sentence the whole tab exists to answer. */
    const head = h('div', { class: 'fxb-state' + (smp ? ' is-smp' : '') },
      h('span', { class: 'fxb-mode' }, smp ? 'HDT-SMP' : 'CBPC'),
      h('span', { class: 'fxb-mode-sub' }, smp
        ? (env.cupLabel ? 'cloth simulation · cup ' + env.cupLabel : 'cloth simulation')
        : 'the always-on bone physics'));
    if (smp && env.slot)
      head.append(h('span', { class: 'fxb-slot',
        title: 'The switch is an invisible armor in biped slot ' + (env.wornSlot || env.slot)
          + '. 3BA picks the slot in its own MCM — change it there if another '
          + 'mod wants the same one.' }, 'slot ' + (env.wornSlot || env.slot)));
    body.append(head);

    if (env.stranded) {
      body.append(h('div', { class: 'fxb-warn' },
        '⚠ ' + who + ' carries 3BA’s switch but nothing is wearing it — an outfit '
        + 'claimed the same biped slot, so she is on CBPC no matter what 3BA’s '
        + 'own count says. Turning it on again re-equips it.'));
    } else if (env.slotStale && smp) {
      body.append(h('div', { class: 'fxb-warn' },
        '⚠ she is wearing the slot ' + env.wornSlot + ' switch, but 3BA’s MCM is set '
        + 'to slot ' + env.slot + ' now. Re-apply to move her onto the current slot.'));
    }
    if (blocked) body.append(h('div', { class: 'fxb-warn' }, '⚠ ' + blocked));

    /* The one big control. Disabled only for a refusal we can state. */
    body.append(h('button', {
      class: 'fxb-toggle' + (smp ? ' is-on' : ''), type: 'button',
      disabled: !!blocked,
      title: blocked || (smp
        ? 'Hand ' + who + '’s body back to CBPC — 3BA strips its switch and '
          + 'restarts the bone physics it had stopped'
        : 'Put ' + who + ' on HDT-SMP — 3BA equips its switch and stops CBPC on '
          + 'the same bones, so the two never fight'),
      onClick: (ev) => {
        ev.stopPropagation();
        toGame('fxSet', JSON.stringify({
          formId: fxModalCtx.formId, id: '3ba:physics', on: !smp }));
      },
    }, smp ? '⏻ Back to CBPC' : '✨ Switch to SMP physics'));

    /* The cup. Four tiles, not a dropdown — there are exactly four and each
       wants its sentence (the house "no range input" habit, and a picker of
       four hides three of them behind a click). */
    if (!isPlayer) {
      body.append(h('div', { class: 'fxb-head' }, 'Jiggle profile'));
      body.append(h('div', { class: 'fxb-note' },
        'Which of 3BA’s four SMP configs the switch carries. A is stiffest, C the '
        + 'bounciest, D the heaviest. It does NOT change her body — 3BA’s own MCM '
        + 'says so: the cup is physics, not size.'));
      const grid = h('div', { class: 'fxb-cups' });
      (env.cups || []).forEach((c) => {
        const cur = smp && env.cup === c.n;
        grid.append(h('button', {
          class: 'fxb-cup' + (cur ? ' is-current' : ''), type: 'button',
          disabled: !!blocked,
          title: blocked || (cur
            ? who + ' is on cup ' + c.label + ' — ' + c.detail
            : (smp ? 'Move ' + who + ' to cup ' + c.label : 'Turn SMP on at cup ' + c.label)
              + ' — ' + c.detail),
          onClick: (ev) => {
            ev.stopPropagation();
            toGame('fxSet', JSON.stringify({
              formId: fxModalCtx.formId, id: '3ba:cup:' + c.n, on: true }));
          },
        }, h('span', { class: 'fxb-cup-letter' }, c.label),
           h('span', { class: 'fxb-cup-detail' }, c.detail)));
      });
      body.append(grid);
      if (!smp && env.defaultCupLabel)
        body.append(h('div', { class: 'fxb-note' },
          'With SMP off, a cup turns it on. 3BA’s own default is ' + env.defaultCupLabel
          + ' — the plain switch above uses that one.'));
    } else {
      body.append(h('div', { class: 'fxb-note' },
        '3BA ships a single SMP setup for the player, with no cup choice — the '
        + 'switch above is the whole control.'));
    }

    /* Which parts actually change hands. All six off is the honest answer to
       "I flipped it and nothing moved", so it is stated rather than hidden. */
    const parts = env.parts || [];
    if (parts.length) {
      const on = parts.filter((p) => p.on).map((p) => p.label);
      if (env.partsOn === 0) {
        body.append(h('div', { class: 'fxb-warn' },
          '⚠ 3BA is set to hand over NO body parts, so the switch equips but '
          + 'nothing changes. Turn parts on in 3BA’s MCM → Physics Manage.'));
      } else {
        body.append(h('div', { class: 'fxb-parts',
          title: 'Set in 3BA’s own MCM (Physics Manage). Parts not listed keep '
            + 'running on CBPC even while she is on SMP.' },
          h('span', { class: 'fxb-parts-label' }, 'Hands over to SMP:'),
          on.length ? on.join(' · ') : 'unknown'));
      }
    }

    /* OSmp — the OStim bridge. It drives the SAME switch objects through the
       SAME MCM, so this tab already tells the truth during and after a scene;
       what Rober cannot see from here is whether a scene will overwrite his
       choice, which is exactly what these four settings decide. */
    const o = env.osmp;
    if (o && o.present) {
      body.append(h('div', { class: 'fxb-head' }, 'OSmp — during OStim scenes'));
      body.append(h('div', { class: 'fxb-note' },
        'OSmp flips the same switch automatically when a scene starts. It uses '
        + '3BA’s own machinery, so what this tab shows stays true throughout.'));
      const rows = [
        { key: 'disabled', label: 'Don’t touch physics at scene start',
          on: !!o.disabled,
          hint: 'On: OSmp leaves everyone exactly as you set them. Off: it puts '
            + 'every female in the scene on SMP.' },
        { key: 'keepNpc', label: 'NPCs keep SMP after the scene', on: !!o.keepNpc,
          hint: 'On: SMP you applied yourself survives the scene ending. Off: '
            + 'OSmp puts her back on CBPC afterwards — including a switch you '
            + 'set from here.' },
        { key: 'keepPlayer', label: 'You keep SMP after the scene', on: !!o.keepPlayer,
          hint: 'The same rule for the player.' },
        { key: 'autoCup', label: 'Pick the cup from her weight', on: !!o.autoCup,
          hint: (o.weights && o.weights.length === 4)
            ? 'On: at scene start OSmp overwrites the cup from her weight (A up to '
              + o.weights[0] + ', B to ' + o.weights[1] + ', C to ' + o.weights[2]
              + ', else D) — so a cup you choose here holds only until then.'
            : 'On: at scene start OSmp overwrites the cup from her weight, so a cup '
              + 'you choose here holds only until then.' },
      ];
      rows.forEach((r) => {
        body.append(h('div', { class: 'fxb-osmp-row', title: r.hint },
          h('span', { class: 'fxb-osmp-label' }, r.label,
            h('span', { class: 'fxb-osmp-hint' }, r.hint)),
          h('button', {
            class: 'fxb-sw' + (r.on ? ' is-on' : ''), type: 'button',
            'aria-pressed': r.on ? 'true' : 'false',
            title: (r.on ? 'Turn off' : 'Turn on') + ' — ' + r.label,
            onClick: (ev) => {
              ev.stopPropagation();
              toGame('fxSet', JSON.stringify({
                formId: fxModalCtx.formId, id: '3ba:osmp:' + r.key, on: !r.on }));
            },
          }, r.on ? 'ON' : 'off')));
      });
    }
  }

  function fxEnsureBodyStyles() {
    if (document.getElementById('fx-body-style')) return;
    const st = document.createElement('style');
    st.id = 'fx-body-style';   /* 3ba-body-tab styles */
    st.textContent =
      '.fxb-state{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;' +
        'padding:14px 16px;margin-bottom:12px;border-radius:10px;' +
        'background:#16161c;border:1px solid #3a382f;}' +
      '.fxb-state.is-smp{background:rgba(240,214,140,.10);' +
        'border-color:rgba(240,214,140,.45);}' +
      '.fxb-mode{font-size:19px;font-weight:800;color:#8a8577;letter-spacing:.4px;}' +
      '.fxb-state.is-smp .fxb-mode{color:#f6ecc8;}' +
      '.fxb-mode-sub{font-size:13.5px;color:#8a8577;}' +
      '.fxb-slot{margin-left:auto;font-size:12px;font-weight:700;color:#9a927e;' +
        'padding:3px 9px;border-radius:20px;border:1px solid #3a382f;' +
        'background:#12121a;white-space:nowrap;}' +
      '.fxb-warn{font-size:13px;line-height:1.5;color:#e7b7ad;' +
        'background:rgba(214,118,96,.08);border:1px solid rgba(214,118,96,.3);' +
        'border-radius:9px;padding:11px 13px;margin-bottom:12px;}' +
      '.fxb-toggle{display:block;width:100%;box-sizing:border-box;' +
        'margin-bottom:16px;padding:15px 14px;border-radius:10px;cursor:pointer;' +
        'font:inherit;font-size:15.5px;font-weight:800;' +
        'color:#ecd9a0;background:#1a1a22;border:1px solid #4a4636;' +
        'transition:background .14s ease,border-color .14s ease,color .14s ease;}' +
      '.fxb-toggle:hover:not([disabled]){background:rgba(240,214,140,.16);' +
        'border-color:rgba(240,214,140,.6);color:#f6ecc8;}' +
      '.fxb-toggle:active:not([disabled]){transform:translateY(1px);}' +
      '.fxb-toggle.is-on{color:#e7b7ad;background:rgba(214,118,96,.08);' +
        'border-color:rgba(214,118,96,.35);}' +
      '.fxb-toggle.is-on:hover:not([disabled]){background:rgba(214,118,96,.16);' +
        'border-color:rgba(214,118,96,.6);color:#f0cdc4;}' +
      '.fxb-toggle[disabled]{opacity:.45;cursor:default;}' +
      '.fxb-head{font-size:13px;font-weight:800;letter-spacing:.6px;' +
        'text-transform:uppercase;color:#9a927e;padding:4px 2px 6px;}' +
      '.fxb-note{font-size:12.5px;color:#9a927e;line-height:1.5;' +
        'padding:0 2px 10px;}' +
      '.fxb-cups{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;}' +
      '.fxb-cup{flex:1 1 96px;min-width:96px;display:flex;flex-direction:column;' +
        'gap:5px;align-items:flex-start;text-align:left;' +
        'padding:13px 13px;border-radius:10px;cursor:pointer;font:inherit;' +
        'color:#c9c3b2;background:#16161c;border:1px solid #3a382f;' +
        'transition:background .12s ease,border-color .12s ease,color .12s ease;}' +
      '.fxb-cup:hover:not([disabled]){background:#1e1c16;border-color:#c9a24b;' +
        'color:#ecd9a0;}' +
      '.fxb-cup:active:not([disabled]){transform:translateY(1px);}' +
      '.fxb-cup.is-current{background:rgba(240,214,140,.14);' +
        'border-color:rgba(240,214,140,.6);color:#f6ecc8;}' +
      '.fxb-cup[disabled]{opacity:.45;cursor:default;}' +
      '.fxb-cup-letter{font-size:22px;font-weight:800;line-height:1;}' +
      '.fxb-cup-detail{font-size:12px;color:#8a8577;line-height:1.4;}' +
      '.fxb-cup.is-current .fxb-cup-detail{color:#c3b68c;}' +
      '.fxb-parts{font-size:12.5px;color:#9a927e;line-height:1.5;' +
        'padding:10px 13px;margin-bottom:12px;border-radius:9px;' +
        'background:#14141a;border:1px solid #2e2c26;}' +
      '.fxb-parts-label{font-weight:700;color:#c9c3b2;margin-right:7px;}' +
      '.fxb-osmp-row{display:flex;align-items:center;gap:14px;' +
        'padding:11px 13px;margin-bottom:8px;border-radius:9px;' +
        'background:#16161c;border:1px solid #3a382f;}' +
      '.fxb-osmp-row:hover{border-color:rgba(240,214,140,.3);' +
        'background:rgba(240,214,140,.06);}' +
      '.fxb-osmp-label{flex:1;min-width:0;display:flex;flex-direction:column;' +
        'gap:3px;font-size:14px;font-weight:700;color:#f2ecdc;}' +
      '.fxb-osmp-hint{font-size:12px;font-weight:400;color:#8a8577;' +
        'line-height:1.45;}' +
      '.fxb-sw{flex:none;min-width:56px;padding:8px 12px;border-radius:20px;' +
        'cursor:pointer;font:inherit;font-size:12px;font-weight:800;' +
        'letter-spacing:.6px;color:#8a8577;background:#12121a;' +
        'border:1px solid #3a382f;' +
        'transition:background .12s ease,border-color .12s ease,color .12s ease;}' +
      '.fxb-sw:hover{border-color:#c9a24b;color:#ecd9a0;}' +
      '.fxb-sw:active{transform:translateY(1px);}' +
      '.fxb-sw.is-on{color:#f6ecc8;background:rgba(240,214,140,.16);' +
        'border-color:rgba(240,214,140,.6);' +
        'box-shadow:0 0 8px rgba(240,214,140,.25);}';
    document.head.appendChild(st);
  }

  /* ---- SPID Gear — the 📦 on the quick card ----------------------------- *
   *  Container → SPID pipeline (Rober, 2026-08-09): the inbox chest records
   *  whatever you drop as PERMANENT gear for the person in front of you —
   *  real SPID ini lines, re-applied by Spell Perk Item Distributor at every
   *  launch. Cache/ask discipline is the bfl idiom exactly: `sgPresent`
   *  starts UNKNOWN and the button draws nothing until the DLL answers once,
   *  so an older DLL shows no dead control. */
  let sgPresent = null;                // null = unknown · false = DLL too old
  const sgCache = {};                  // key -> { at, env } (env = sgState payload)
  let sgAsked = { key: null, at: 0 };
  const SG_MIN_GAP = 1500;
  const sgChanceTimers = {};           // itemKey -> debounce for the card slider
  function sgKeyOf(fid) { return '0x' + ((Number(fid) || 0) >>> 0).toString(16); }
  function askSpid(fid, force) {
    if (sgPresent === false || !fid) return;
    const k = sgKeyOf(fid);
    const now = Date.now();
    if (!force && sgAsked.key === k && (now - sgAsked.at) < SG_MIN_GAP) return;
    sgAsked = { key: k, at: now };
    toGame('sgGet', JSON.stringify({ formId: (Number(fid) || 0) >>> 0 }));
  }
  function sgFor(fid) { const r = sgCache[sgKeyOf(fid)]; return r ? r.env : null; }

  function sgTitle(env, who) {
    if (!env) return 'SPID gear — checking ' + who + '…';
    if (env.ok === false) return 'SPID gear: ' + (env.msg || 'not available for her');
    const n = (env.items || []).length;
    let s = n
      ? '📦 SPID gear: ' + who + ' is granted ' + n + ' item' + (n === 1 ? '' : 's')
        + ' at every game launch.'
      : '📦 SPID gear: nothing granted to ' + who + ' yet.';
    s += '\nClick and the deck closes onto a chest: drop items in, close the '
      + 'chest, done — the deck writes real SPID ini lines and hands your items '
      + 'straight back. Additive: her own gear is never replaced. Takes effect '
      + 'at the NEXT launch.';
    return s;
  }

  /* The icon itself, and it IS the container (Rober, 2026-08-11: "should be
     with the other inventory buttons and should close the menu and open a
     container that i can put stuff in — then on close its done"). One click =
     ClosePalette + the inbox chest, exactly like ☰ Inventory / ⛃ Spare beside
     it; the harvest happens when you close the chest. Gold when she already
     has grants. Not drawn until the DLL has answered once (matched-set
     safety, same as 💡) so an older DLL shows no dead control. */
  function sgQuickBtn(t, who, dead) {
    if (sgPresent !== true || !t || !t.formId) return null;
    const env = sgFor(t.formId);
    const has = !!(env && (env.items || []).length);
    const barred = !!(env && env.ok === false);
    return quickBtn('📦', has ? 'SPID gear · ' + (env.items || []).length : 'SPID gear',
      sgTitle(env, who),
      () => { toGame('sgInbox', JSON.stringify({ formId: (Number(t.formId) || 0) >>> 0 })); },
      { disabled: dead || barred, active: has });
  }

  /* The grant LIST is now its own button, drawn only once she actually has
     grants — with the chest promoted to one click there is nothing to review
     until something has been granted. Keeps every management verb (chance
     slider, ✕ removal, the all-NPCs manager) one click from the card. */
  function sgListBtn(t, who, dead) {
    if (sgPresent !== true || !t || !t.formId) return null;
    const env = sgFor(t.formId);
    const items = (env && env.items) || [];
    if (!items.length) return null;
    return quickBtn('📋', 'SPID list · ' + items.length,
      'What ' + who + ' is granted at every launch — ' + items.length + ' item'
        + (items.length === 1 ? '' : 's') + '. Change the chance of each, remove '
        + 'one, or open the all-NPCs manager.',
      () => {
        ui.fqSpid = !ui.fqSpid;
        if (ui.fqSpid) askSpid(t.formId, true);   // fresh truth under the list
        renderQuickCard();
      },
      { disabled: dead, active: ui.fqSpid, pressed: ui.fqSpid });
  }

  /* The revealed grant list (fq-sets idiom): her items with a chance slider
     and removal each, plus the inbox opener and the all-NPCs manager
     (HDSpidGear, hd-spidgear.js). Row styles live in hd-spidgear.css. */
  function sgBlock(t, who) {
    const env = sgFor(t.formId);
    const items = (env && env.items) || [];
    const lbl = !env ? '📦 SPID gear · checking…'
      : (env.ok === false ? '📦 SPID gear'
        : '📦 SPID gear · ' + (items.length ? items.length + ' granted' : 'none yet'));
    const box = h('div', { class: 'fq-sets is-spid' },
      h('span', { class: 'fq-sets-lbl', title: sgTitle(env, who) }, lbl));

    box.append(h('button', {
      class: 'fq-set', type: 'button',
      disabled: (env && env.ok !== false) ? null : true,
      title: 'Open the inbox chest: whatever you put in becomes ' + who + '’s '
        + 'permanent gear (SPID, next launch) — and your items come straight '
        + 'back to you. The deck closes for the chest.',
      onClick: (e) => { e.stopPropagation();
        toGame('sgInbox', JSON.stringify({ formId: (Number(t.formId) || 0) >>> 0 })); },
    }, '＋ Add items…'));
    /* ＋ By name (2026-08-20). The chest above needs you to be standing here
       AND to own the thing; this grants from the item's identity, so a wig you
       have never crafted can be enforced on her from this card. Same verb, same
       grant, different door — WardrobeSpid owns the sgAdd contract so it is
       written in exactly one place. */
    if (window.HDItemPick && window.WardrobeSpid &&
        typeof WardrobeSpid.enforce === 'function') {
      box.append(h('button', {
        class: 'fq-set', type: 'button',
        disabled: (env && env.ok !== false) ? null : true,
        title: 'Search every item in the load order and enforce one on ' + who +
          ' — no chest, and you do not have to own it',
        onClick: (e) => { e.stopPropagation(); sgAddByName(t, who); },
      }, '＋ By name…'));
    }
    box.append(h('button', {
      class: 'fq-set', type: 'button',
      title: 'Every NPC with SPID grants — items, dates, chances, removal',
      onClick: (e) => { e.stopPropagation();
        if (window.HDSpidGear) HDSpidGear.open(); },
    }, '⚙ All grants…'));
    /* The Wardrobe's SPID page is the superset of this block — her card, her
       faces, every other person's grants beside hers. Deep-linking to it
       FILTERED to her name is the difference between "go find her" and "here
       she is"; the page owns that landing (showSub), including the sub-tab
       switch the host's own repaint would otherwise wipe. */
    if (window.WardrobeSpid && typeof WardrobeSpid.show === 'function') {
      box.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Open the Wardrobe’s permanent-gear page on ' + who,
        onClick: (e) => { e.stopPropagation(); WardrobeSpid.show(t.name || ''); },
      }, '↗ Manage…'));
    }
    box.append(h('button', {
      class: 'fq-set', type: 'button',
      title: 'Re-read her grant list now',
      onClick: (e) => { e.stopPropagation(); askSpid(t.formId, true); },
    }, '⟳'));

    if (env && env.ok === false) {
      box.append(h('div', { class: 'fqsg-note' }, env.msg || 'Not available for her'));
      return box;
    }

    if (items.length) {
      const rows = h('div', { class: 'fqsg-rows' });
      for (const it of items) rows.append(sgItemRow(env, it));
      box.append(rows);
      box.append(h('div', { class: 'fqsg-note' },
        'Applies at the next game launch — SPID reads the ini at startup.'));
    }
    return box;
  }

  /* The picker mounts into the followers pane itself (the ix-sheet idiom:
     inset 0 INSIDE the panel, so it inherits the deck's scale and clips to its
     corners). `multi` keeps it open, because granting a whole outfit is one
     trip; each pick is answered by the DLL with a fresh sgState, which repaints
     the card underneath. */
  function sgAddByName(t, who) {
    const host = document.getElementById('fol-pane');
    if (!host || !window.HDItemPick || !window.WardrobeSpid) return;
    const env = sgFor(t.formId);
    const already = ((env && env.items) || []).map((it) => ({
      plugin: it.plugin, localId: parseInt(String(it.localId), 16) >>> 0,
    }));
    HDItemPick.open({
      host: host,
      title: 'Enforce on ' + who,
      hint: 'She is handed this at every launch, forever, until you pause or forget it.',
      confirm: 'Enforce',
      multi: true,
      chosen: () => already,
      onPick: (item) => {
        WardrobeSpid.enforce({
          formId: (Number(t.formId) || 0) >>> 0,
          item: { plugin: item.plugin, localId: item.localId, name: item.name || '' },
        });
        already.push({ plugin: item.plugin, localId: (item.localId >>> 0) });
        if (typeof toast === 'function')
          toast('Enforcing ' + (item.name || 'that item') + ' on ' + who);
      },
      onClose: () => { askSpid(t.formId, true); },
    });
  }

  function sgItemRow(env, it) {
    const ikey = String(it.plugin || '').toLowerCase() + '|' + String(it.localId || '');
    const pct = h('span', { class: 'fqsg-pct' }, String(it.chance) + '%');
    const range = h('input', {
      type: 'range', class: 'fqsg-range', min: '5', max: '100', step: '5',
      value: String(it.chance),
      title: 'Chance she receives this per launch — 100% = always',
    });
    range.addEventListener('input', () => {
      const v = parseInt(range.value, 10) || 100;
      pct.textContent = String(v) + '%';
      it.chance = v;
      clearTimeout(sgChanceTimers[ikey]);
      sgChanceTimers[ikey] = setTimeout(() => {
        toGame('sgChance', JSON.stringify({
          npcPlugin: env.npcPlugin, npcLocalId: env.npcLocalId,
          plugin: it.plugin, localId: it.localId, chance: v,
        }));
      }, 300);
    });
    if (typeof window.hdSmoothRange === 'function') window.hdSmoothRange(range);
    return h('div', { class: 'fqsg-row' },
      h('span', { class: 'fqsg-name', title: (it.name || '(unnamed item)')
        + (it.when ? '\nRecorded ' + it.when : '') }, it.name || '(unnamed item)'),
      it.count > 1 ? h('span', { class: 'fqsg-count' }, '×' + it.count) : null,
      range, pct,
      h('button', {
        class: 'fqsg-x', type: 'button',
        title: 'Stop granting this (what she already carries stays)',
        onClick: (e) => { e.stopPropagation();
          toGame('sgRemove', JSON.stringify({
            formId: (Number(env.formId) || 0) >>> 0,
            npcPlugin: env.npcPlugin, npcLocalId: env.npcLocalId,
            plugin: it.plugin, localId: it.localId,
          })); },
      }, '✕'));
  }

  /* NFF's three outfit sets. The type numbers are the mod's own public API
     (nwsFollowerSetsScript.DialogueCmd), mirrored from wardrobe-nff.js SETS —
     type 3 is "her own clothes", a wear target rather than a set, so it is
     deliberately absent. */
  /* Is the crosshair NPC someone Follower Organizer already knows? The roster
     is already in memory (fdState), so this costs nothing and turns a bare
     name into context: which category she is filed under, and whatever you
     wrote in her Relationship field. Matched on the DISPLAY name, because that
     is all fdTarget carries and it is what FO shows on the row. */
  /* ---- one card per PERSON, not per filing (2026-09-20) ---------------
     A person filed in multiple categories must appear only once.

     Follower Organizer stores someone filed in two categories as TWO member
     objects, each with its own fields, and householdRoster walked categories
     and pushed a row per (category, member) pair. So she rendered twice, and
     the header counts double-counted her.

     Merging must be GENEROUS, not first-wins. The two objects are independent
     FO entries whose fields can genuinely disagree (her "Wifes" row may say
     relationship "wife" while her "Servants" row says "servant"), and
     household-pane's isWife() tests that very field — so keeping whichever
     copy happened to come first could quietly stop counting her as a wife.
     Instead every truth is unioned: booleans OR, rank takes the max, strings
     keep the first non-empty, and the two fields a person can legitimately
     hold twice — category and relationship — are joined. She IS both things,
     and saying so is the honest card.

     Identity is formId when there is one (two people can share a name) and
     the durable un-renamed `original` otherwise — the same precedence the
     rest of this file uses. */
  function mergeHouseholdRows(rows) {
    const byKey = Object.create(null);
    const order = [];

    const addWord = (list, v) => {
      const t = String(v || '').trim();
      if (!t) return;
      if (list.some((x) => x.toLowerCase() === t.toLowerCase())) return;
      list.push(t);
    };
    const firstOf = (a, b) => (String(a || '').trim() ? a : b);

    rows.forEach(function (r) {
      const fid = String(r.formId || '').trim().toLowerCase();
      const key = fid || ('name:' + String(r.original || r.name || '').trim().toLowerCase());
      if (!key || key === 'name:') return;

      let m = byKey[key];
      if (!m) {
        m = byKey[key] = Object.assign({}, r);
        m._cats = [];
        m._rels = [];
        addWord(m._cats, r.category);
        addWord(m._rels, r.relationship);
        order.push(key);
        return;
      }
      addWord(m._cats, r.category);
      addWord(m._rels, r.relationship);
      // Booleans: if any filing says yes, it is yes.
      m.spouse = m.spouse || r.spouse;
      m.relHas = m.relHas || r.relHas;
      m.following = m.following || r.following;
      m.waiting = m.waiting || r.waiting;
      m.dead = m.dead || r.dead;
      m.facePending = m.facePending || r.facePending;
      // Rank: the best one she holds, with the label that belongs to it.
      if ((r.relRank || 0) > (m.relRank || 0)) {
        m.relRank = r.relRank;
        m.rankLabel = r.rankLabel;
      }
      // Facts that are per-ACTOR, not per-filing: first one that answered.
      if (!m.fert && r.fert) { m.fert = r.fert; m.fertTitle = r.fertTitle; }
      if (!m.portraitUrl && r.portraitUrl) m.portraitUrl = r.portraitUrl;
      m.note = firstOf(m.note, r.note);
      m.fieldsText = firstOf(m.fieldsText, r.fieldsText);
      m.where = firstOf(m.where, r.where);
      m.homeText = firstOf(m.homeText, r.homeText);
      m.name = firstOf(m.name, r.name);
    });

    return order.map(function (k) {
      const m = byKey[k];
      m.category = m._cats.join(', ');
      m.relationship = m._rels.join(', ');
      /* Kept so a surface can show the filings separately without re-splitting
         a joined string (which would break on a category containing a comma). */
      m.categories = m._cats.slice();
      delete m._cats;
      delete m._rels;
      return m;
    });
  }

  function rosterEntryFor(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    for (const c of state.cats) {
      if (c.index === ALL) continue;
      for (let i = 0; i < c.members.length; i++) {
        const m = c.members[i];
        const n = String(m.name || '').trim().toLowerCase();
        const o = String(m.original || '').trim().toLowerCase();
        if (n === want || o === want) return { m: m, cat: c, idx: i };
      }
    }
    return null;
  }

  /* Form id -> the hex TEXT the nf* bridges want (nfBuild/nfClear/nfCopy all
     parse a string; addMember wants a number - see fileInto). Same shape the
     existing fillNffOutfit builds inline. */
  /* ================================== 🔍 DEBUG (Rober, 2026-08-10) ======= *
   *  "a debug option when pressing f7 on an npc could be handy."
   *
   *  The raw engine truth about the card's subject: flags (teammate,
   *  essential, …), EVERY faction with its rank, the follower-framework
   *  probe, the quests holding her in aliases, and the AI package in force.
   *  Born from a real autopsy — a custom-follower-mod companion was wedged half-recruited inside
   *  NFF (in "Disallow Player Interaction", teammate false, her own mod's
   *  dialogue hidden) and nothing on any screen could SAY so; this reveal
   *  is that faction dump, on the card, one click deep.
   *
   *  Bridge: fdDebug {formId} out, fdDebugInfo back (one name per
   *  direction). Pure read — nothing here mutates the game.
   */
  let dbgData = null;   // last dossier, verbatim from C++
  let dbgFor = 0;       // formId that dossier answers for
  let dbgAsked = 0;     // formId we last ASKED about (loop guard, see below)
  let dbgBusy = false;

  function askDebug(fid) {
    if (!fid) return;
    dbgAsked = (Number(fid) || 0) >>> 0;
    dbgBusy = true;
    toGame('fdDebug', JSON.stringify({ formId: hexOf(fid) }));
  }

  window.fdDebugInfo = function (d) {
    if (!d || typeof d !== 'object') return;
    dbgBusy = false;
    dbgData = d;
    dbgFor = d.refId ? ((parseInt(d.refId, 16) || 0) >>> 0) : 0;
    renderQuickCard();
  };

  /* Its own class, NOT `.fq-sets`: that class is the card's set-picker row and
     several places (including the harness) ask "is a set picker open?" with a
     bare `.fq-sets` query. Sharing it made an open Debug reveal read as an open
     Outfit picker. Same look, own name. */
  function debugBlock(t, who) {
    const box = h('div', { class: 'fq-dbg' },
      h('span', { class: 'fq-sets-lbl' }, '🔍 Debug · the engine’s truth about ' + who));
    box.append(h('div', { class: 'fqdbg-bar' },
      h('button', {
        class: 'fq-set', type: 'button', title: 'Re-read her state now',
        onClick: (e) => { e.stopPropagation(); askDebug(t.formId); },
      }, '⟳ Refresh')));

    const d = dbgData;
    const fid = (Number(t.formId) || 0) >>> 0;
    const stale = !d || dbgFor !== fid;
    if (stale) {
      /* Leave the reveal open, walk up to someone else, and the dossier must
         follow the card — showing the PREVIOUS person's factions under this
         person's name is the exact lie this whole feature exists to stop.
         Asked at most once per person (dbgAsked), so the reply's re-render
         cannot turn into a loop. */
      if (dbgAsked !== fid) askDebug(fid);
      box.append(h('div', { class: 'fqsg-note' },
        dbgBusy ? 'Reading her state…' : 'No data yet — hit ⟳ Refresh'));
      return box;
    }
    if (d.ok === false) {
      box.append(h('div', { class: 'fqsg-note' }, d.msg || 'Not available for her'));
      return box;
    }

    const kv = (k, v, warn) => h('div', { class: 'fqdbg-row' + (warn ? ' warn' : '') },
      h('span', { class: 'fqdbg-k', title: String(k) }, String(k)),
      h('span', { class: 'fqdbg-v', title: String(v) }, String(v)));

    box.append(h('div', { class: 'fqdbg-sec' }, 'Identity'));
    box.append(kv('Ref', d.refId + (d.refPlugin ? ' · ' + d.refPlugin : '')));
    if (d.baseId)
      box.append(kv('Base', d.baseId + (d.basePlugin ? ' · ' + d.basePlugin : '')));

    const f = d.flags || {};
    const chip = (name, on) => h('span',
      { class: 'fqdbg-chip' + (on ? ' on' : '') }, name + ': ' + (on ? 'yes' : 'no'));
    box.append(h('div', { class: 'fqdbg-sec' }, 'Flags'));
    box.append(h('div', { class: 'fqdbg-chips' },
      chip('teammate', f.teammate), chip('essential', f.essential),
      chip('protected', f.protected), chip('ghost', f.ghost),
      chip('dead', f.dead), chip('in combat', f.inCombat),
      chip('commanded', f.commanded)));

    const fw = d.framework || {};
    box.append(h('div', { class: 'fqdbg-sec' }, 'Follower framework'));
    box.append(kv('Probe', fw.summary || '—'));
    if (d.ownedBy)
      box.append(kv('Ships with', d.ownedBy + ' — her own mod owns her following', true));

    if (d.package) {
      const p = d.package;
      box.append(h('div', { class: 'fqdbg-sec' }, 'AI package in force'));
      box.append(kv(p.follow ? 'Follow-type' : 'Package',
        (p.quest ? p.quest + ' · ' : '')
          + (p.questPlugin || p.plugin || '?') + ' · ' + p.formId, !!p.follow));
    }

    const al = d.aliases || [];
    box.append(h('div', { class: 'fqdbg-sec' }, 'Held in quest aliases (' + al.length + ')'));
    if (al.length) {
      const rows = h('div', { class: 'fqdbg-scroll' });
      for (const a of al)
        rows.append(kv(a.plugin || '?',
          (a.quest || a.questName || '?') + (a.follow ? ' · FOLLOW package' : ''), !!a.follow));
      box.append(rows);
    }

    /* The payload: every faction, follower-state rows called out in gold.
       "Disallow Player Interaction" is NFF's dialogue blocker — being stuck
       in it is exactly the "only four dialogue options" symptom. */
    const facs = d.factions || [];
    box.append(h('div', { class: 'fqdbg-sec' }, 'Factions (' + facs.length + ')'));
    if (facs.length) {
      const rows = h('div', { class: 'fqdbg-scroll' });
      for (const fa of facs) {
        const nm = String(fa.name || '');
        const plug = String(fa.plugin || '');
        const low = nm.toLowerCase();
        const warn = low.indexOf('disallow') >= 0
          || low.indexOf('current follower') >= 0
          || low.indexOf('player follower') >= 0
          || plug.toLowerCase() === 'nwsfollowerframework.esp'
          || low.indexOf('aiagentfaction') === 0;
        rows.append(kv(nm || '(unnamed)',
          (plug ? plug + ' · ' : '') + fa.formId + ' · rank ' + fa.rank, warn));
      }
      box.append(rows);
      box.append(h('div', { class: 'fqsg-note' },
        'Gold rows are follower-state factions. An NFF row on someone who '
        + 'ships with her OWN follower mod means two systems think they own '
        + 'her — dismiss her from NFF to give her back.'));
    }
    return box;
  }

  function hexOf(formId) { return '0x' + (formId >>> 0).toString(16).toUpperCase(); }

  /* Pick which of the player's NFF home bases she belongs to. Sends the INDEX,
     which is the faction rank NFF stores and reads back — see NffBridge::SetBase.
     "No base" is offered too, because un-assigning was equally unreachable. */
  function openNffBase(anchorEl, known, who) {
    closeCtx();
    const bases = state.nff.bases;
    const cur = known.m.nffHome || '';
    const items = [h('div', { class: 'fd-ctx-head', title: who }, who + '’s home base…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });

    items.push(h('div', { class: 'fd-ctx-field' },
      h('input', {
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter bases…',
        onInput: (e) => paint(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      })));
    items.push(listBox);

    function send(index, label) {
      closeCtx();
      fqStatus = { msg: index < 0 ? 'Clearing her home base…'
                                  : 'Setting her home base to ' + label + '…', ok: true, pending: true };
      sendNpc('setBase', known.m, { index: index, baseName: label });
      renderQuickCard();
    }

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      let n = 0;
      bases.forEach((b) => {
        if (f && b.name.toLowerCase().indexOf(f) === -1) return;
        listBox.append(h('button', {
          class: 'fd-ctx-item',
          onClick: (e) => { e.stopPropagation(); send(b.index, b.name); },
        },
          h('span', { class: 'fd-ctx-check' }, b.name === cur ? '\u2713' : '\u2302'),
          h('span', { class: 'fd-ctx-lbl' }, b.name),
          b.placed ? null : h('span', { class: 'fd-ctx-count' }, 'no marker')));
        n++;
      });
      if (!f) {
        listBox.append(h('button', {
          class: 'fd-ctx-item',
          onClick: (e) => { e.stopPropagation(); send(-1, ''); },
        },
          h('span', { class: 'fd-ctx-check' }, cur ? '\u2715' : '\u2713'),
          h('span', { class: 'fd-ctx-lbl' }, 'No home base')));
        n++;
      }
      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' }, 'No base matches \u201c' + q + '\u201d.'));
      }
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  /* Her DAY, from the card. My Home is Your Home NG keeps a marker per activity
     — where she sleeps, works, stands guard and eats each meal — and until now
     the card could only set the HOME. Everything else was reachable only by
     opening her member menu on the Followers tab, which is the wrong place to
     be standing when the answer to "where should she work" is "right here".

     The verbs are the mod's, not ours (src/mhiyh_control.h): SetAreaMarker for
     a stop, ClearAreaMarker to forget one, and every one of them REFUSED until
     she has a home — which is why the button that opens this is disabled with
     that sentence rather than opening a picker that can only fail.

     Home (kind 0) is deliberately absent: it already has its own button on the
     same row, and two controls doing one thing is how you end up with two
     behaviours. Watch (kind 7) is absent because the MOD has no place for it —
     it stands at the guard post — which canSetKind already encodes. */
  const SPOT_PHRASE = {
    1: 'Sleeps here', 2: 'Works here', 3: 'Stands guard here',
    4: 'Eats breakfast here', 5: 'Eats lunch here', 6: 'Eats dinner here',
  };
  function spotPhrase(k) {
    return SPOT_PHRASE[k] || (actSpec(k).label + ' here');
  }

  function openSpotPicker(anchorEl, known, who) {
    closeCtx();
    const m = known.m;
    /* Only the stops the MOD actually holds a marker for can be cleared, so the
       clear list is built from what C++ sent rather than from the spec. */
    const have = {};
    (m.acts || []).forEach(function (a) { if (a.place) have[a.k] = a.place; });
    const clearable = SETTABLE_KINDS.filter(function (k) {
      return k !== KIND_HOME && canSetKind(k) && have[k];
    });

    let mode = 'set';
    const head = h('div', { class: 'fd-ctx-head', title: who }, who + '’s day — set a spot');
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    const filter = h('input', {
      class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Type to filter…',
      onInput: (e) => paint(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const first = listBox.querySelector('.fd-ctx-item');
          if (first) first.click();
        }
      },
    });

    function send(op, k, label) {
      closeCtx();
      fqStatus = {
        msg: op === 'setSpot' ? 'Marking this as where ' + who + ' ' + label.toLowerCase() + '…'
                              : 'Forgetting ' + who + '’s ' + label.toLowerCase() + ' spot…',
        ok: true, pending: true,
      };
      sendMhiyh(op, m, k);
      renderQuickCard();
    }

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      let n = 0;
      const kinds = (mode === 'clear') ? clearable
        : SETTABLE_KINDS.filter(function (k) { return k !== KIND_HOME && canSetKind(k); });

      kinds.forEach(function (k) {
        const spec = actSpec(k);
        const phrase = spotPhrase(k);
        const place = have[k] || '';
        if (f && (phrase + ' ' + spec.label + ' ' + place).toLowerCase().indexOf(f) === -1) return;
        listBox.append(h('button', {
          class: 'fd-ctx-item',
          title: mode === 'clear'
            ? 'Forget it — she keeps her home and every other stop'
            : (place ? 'Move it here from ' + place + '. The old marker is deleted by the mod itself.'
                     : 'Mark where you are standing right now'),
          onClick: (e) => {
            e.stopPropagation();
            send(mode === 'clear' ? 'clearSpot' : 'setSpot', k, phrase);
          },
        },
          h('span', { class: 'fd-ctx-check' }, mode === 'clear' ? '✕' : spec.ic),
          h('span', { class: 'fd-ctx-lbl' }, phrase),
          place ? h('span', { class: 'fd-ctx-count', title: place }, place) : null));
        n++;
      });

      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          f ? 'Nothing matches “' + q + '”.'
            : (mode === 'clear' ? 'She has no stops to clear yet.' : 'No settable stops.')));
      }

      /* The other half, as the last row rather than a second control on every
         line: a ✕ inside each item would be a button inside a button, which is
         invalid markup and, in this webview, an unreliable click target. */
      if (mode === 'set' && clearable.length && !f) {
        listBox.append(h('button', {
          class: 'fd-ctx-item is-clear-spot',
          title: 'Forget one of her stops instead',
          onClick: (e) => {
            e.stopPropagation();
            mode = 'clear';
            head.textContent = who + '’s day — clear a spot';
            paint('');
          },
        },
          h('span', { class: 'fd-ctx-check' }, '✕'),
          h('span', { class: 'fd-ctx-lbl' }, 'Clear a spot…'),
          h('span', { class: 'fd-ctx-count' }, String(clearable.length))));
      }
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' },
      head, h('div', { class: 'fd-ctx-field' }, filter), listBox);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(head);
    setTimeout(() => {
      if (ctxEl && filter.focus) filter.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  /* "centred" / "3% left, 6% up" — the offsets as a human reads a photo, since
     the raw signed fractions say nothing about which way the picture moves. */
  function fmtOff(x, y) {
    const bits = [];
    if (Math.abs(x) >= 0.005) bits.push(Math.round(Math.abs(x) * 100) + '% ' + (x < 0 ? 'left' : 'right'));
    if (Math.abs(y) >= 0.005) bits.push(Math.round(Math.abs(y) * 100) + '% ' + (y < 0 ? 'up' : 'down'));
    return bits.length ? bits.join(', ') : 'centred';
  }

  /* Send a PARTIAL framing change. C++ merges it onto whatever capture.ini
     currently holds and echoes back the CLAMPED result, so the panel never has
     to guess whether a nudge was accepted — and a value the portal changed
     underneath us is not overwritten by a stale copy here. */
  function setFraming(patch) {
    toGame('fdSetFraming', JSON.stringify(patch || {}));
  }

  /* Forget one NFF set, or (type 3 = kBase) drop her from NFF outfits entirely.
     Same nfClear bridge the Wardrobe tab uses. C++ answers on nfResult, which
     this pane CHAINS (see chainNfResult) so the reply reaches the card — it did
     not until 2026-08-02, and the pending status hung forever. */
  function clearNffOutfit(type, label) {
    const t = state.target;
    if (!t || !t.formId) return;
    const hex = hexOf(t.formId);
    fqStatus = { msg: 'Clearing ' + label + '…', ok: true, pending: true };
    toGame('nfClear', JSON.stringify({ formId: hex, plugin: '', type: type }));
    renderQuickCard();
  }

  /* Your wardrobe outfits, offered on the card. The names live on the Wardrobe
     pane (SOES owns them), so they are read from it at OPEN time rather than
     copied into this pane's state — one source of truth, and a newly built
     outfit is offered here the moment it exists. Absent pane / no outfits is a
     sentence, not an empty menu. */
  function wardrobeOutfitNames() {
    const wp = window.WardrobePane;
    const st = wp && wp._state;
    const list = (st && st.soes && Array.isArray(st.soes.outfits)) ? st.soes.outfits : [];
    return list.map((o) => (o && typeof o === 'object') ? o.name : o)
               .filter((n) => typeof n === 'string' && n);
  }

  /* ---- what the Wardrobe tab knows about the person in front of you -------
   *
   * The Wardrobe tab's People card is the OTHER surface about one person, and
   * on 2026-08-03 it was the only one that could answer "who dresses her" or
   * put a set on her. Everything below reaches into the two Wardrobe modules
   * for that, and fires THEIR ops - never a second copy. The rule for this
   * whole block: this card owns the buttons, wardrobe-pane.js / wardrobe-nff.js
   * own the verbs and the data.
   *
   * The crosshair snapshot carries a bare runtime form id and no plugin, which
   * is exactly what both modules' lookups take (nfGet's own `formId` is that
   * same runtime id - see nff_outfits.cpp), so no identity is invented here.
   * Either module absent (harness, older view) reads as "no answer" and the
   * whole block simply is not drawn - never as a row of dead controls. */
  const NFF_BASE = 3;                      // NffOutfits' kBase: "her own clothes"
  function wardrobeApi() {
    const w = window.WardrobePane;
    return (w && typeof w.quickAbout === 'function') ? w : null;
  }
  function nffApi() {
    const n = window.WardrobeNff;
    return (n && typeof n.keyForActor === 'function') ? n : null;
  }
  /* One read, both modules, per render. Cheap (two array scans) and always
     LIVE, so a mode changed on the Wardrobe tab shows here without a push. */
  function clothesAbout() {
    const t = state.target;
    if (!t || !t.formId) return null;
    const hex = hexOf(t.formId);
    const wp = wardrobeApi(), nfp = nffApi();
    const w = wp ? wp.quickAbout(hex) : null;
    const key = nfp ? nfp.keyForActor(hex) : '';
    const nf = (key && nfp.infoFor) ? nfp.infoFor(key) : null;
    if (!w && !nf) return null;
    return {
      hex: hex, w: w, nf: nf, key: key,
      /* Who dresses her, in one word. The Wardrobe pane already resolves this
         (its own claim-beats-assignment rule); NFF's claim flag is the fallback
         for a view where only the NFF module answered. */
      mode: w ? w.mode : (nf && nf.claimed ? 'nff' : 'off'),
    };
  }
  /* Ask C++ for both slices, ONCE per palette open. The Wardrobe tab asks on
     every onShow, but this card is reached without ever going there - so
     without this the whole block would be empty on the surface it matters on.
     Gated on the tab having answered at all, not on a timer, so a rig with no
     SOES and no NFF asks once and then stays quiet. */
  let clothesAsked = false;
  function askClothes() {
    if (clothesAsked) return;
    const wp = window.WardrobePane;
    if (!wp || typeof wp.quickRefresh !== 'function') return;
    clothesAsked = true;
    wp.quickRefresh();
    /* Two paints rather than a subscription: nfOpen/wdOpen are the Wardrobe
       modules' OWN receivers and re-chaining them from here is how bridge names
       get unplugged (see [[prismaui-one-name-per-direction]]). Bounded, and the
       block is drawn from live module state on every later render anyway. */
    setTimeout(function () { renderQuickCard(); }, 260);
    setTimeout(function () { renderQuickCard(); }, 900);
  }

  /* Put an answer from a shared op onto the card. The two Wardrobe modules
     answer {ok,msg} instead of toasting precisely so the verdict lands HERE,
     where you are still looking - a refusal ("the Wardrobe dresses her") is the
     most useful sentence on screen. */
  function clothesSay(r) {
    if (!r) return;
    fqStatus = { msg: r.msg || (r.ok ? 'Done' : 'Refused'), ok: r.ok !== false, pending: false };
    renderQuickCard();
  }

  /* ---- what the ⛨ Outfit dock is handed (hd-outfit.js, 2026-08-11) --------
   *
   * The dock owns the three popouts; this pane owns the four things only it
   * can do, so they cross as callbacks rather than as a second implementation
   * over there:
   *   equipped/askEquipped — her WORN set, which arrives on fdEquipped and is
   *                          cached in this pane's state (the Copy floater is
   *                          built from it)
   *   eqIcon               — the one slot/kind icon rule, so the floater's rows
   *                          and the card's Equipped block never disagree
   *   say                  — put a verdict on the CARD, so it survives the
   *                          popout closing
   *   fillChest/clearSet   — nfBuild / nfClear go through this pane because it
   *                          is the one that closes the palette and chains
   *                          nfResult back onto the card
   * Everything else the dock needs (who dresses her, the sets, SOES) it reads
   * live from WardrobePane / WardrobeNff itself — the same two modules this
   * pane reads, so there is exactly one source of truth either way.
   *
   * `hex` is the crosshair snapshot's bare runtime id, which is precisely what
   * both modules' lookups take; no identity is invented here. */
  function outfitDockCtx(subj, t, whoName, dead, face) {
    const fid = subj ? (Number(subj.formId) || 0)
                     : (t ? (Number(t.formId) || 0) : 0);
    /* Her FACE, so the dock is about a person rather than about a form id. The
       roster's own resolver, so a face means the same thing on every surface —
       and the PLAIN path with no `?v=` cache-buster, because Ultralight eats the
       query string (see [[hotkey-deck-favorites-shelf]]). */
    const shot = face ? portraitFor(face) : null;
    return {
      who: whoName,
      portrait: shot ? portraitSrc(shot) : '',
      formId: fid,
      hex: fid ? hexOf(fid) : '',
      dead: !!dead,
      equipped: () => equippedFor(subj || null),
      askEquipped: () => askEquipped(subj || null),
      eqIcon: eqIcon,
      say: clothesSay,
      fillChest: (type) => fillNffOutfit(type),
      clearSet: (type, label) => clearNffOutfit(type, label),
      /* The ⛨ is drawn gold while the dock is up, so the card has to hear about
         a close it did not cause (Esc, the backdrop, a click outside). */
      onClose: () => { if (isActive()) renderQuickCard(); },
    };
  }

  function openWardrobeInto(anchorEl, t, who) {
    closeCtx();
    const names = wardrobeOutfitNames();
    const items = [h('div', { class: 'fd-ctx-head', title: who }, 'Dress ' + who + ' in…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });

    items.push(h('div', { class: 'fd-ctx-field' },
      h('input', {
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter outfits…',
        onInput: (e) => paint(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      })));
    items.push(listBox);

    /* Second step: nfCopy needs the DESTINATION set, because NFF wears a
       different one in the wild, in town and at home. Guessing would put the
       clothes on somewhere she is not. */
    function pickSet(outfit) {
      listBox.textContent = '';
      items[0].textContent = outfit + ' — worn when?';
      NFF_SETS.forEach((sset) => {
        listBox.append(h('button', {
          class: 'fd-ctx-item',
          onClick: (e) => {
            e.stopPropagation(); closeCtx();
            const tgt = state.target;
            if (!tgt || !tgt.formId) return;
            fqStatus = { msg: 'Giving her “' + outfit + '” for ' + sset.name + '…', ok: true, pending: true };
            toGame('nfCopy', JSON.stringify({
              formId: hexOf(tgt.formId), plugin: '', type: sset.t, outfit: outfit }));
            renderQuickCard();
          },
        },
          h('span', { class: 'fd-ctx-check' }, '⛨'),
          h('span', { class: 'fd-ctx-lbl' }, sset.name),
          h('span', { class: 'fd-ctx-count' }, sset.hint)));
      });
    }

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      let n = 0;
      names.forEach((nm) => {
        if (f && nm.toLowerCase().indexOf(f) === -1) return;
        listBox.append(h('button', {
          class: 'fd-ctx-item',
          onClick: (e) => { e.stopPropagation(); pickSet(nm); },
        },
          h('span', { class: 'fd-ctx-check' }, '⛨'),
          h('span', { class: 'fd-ctx-lbl' }, nm)));
        n++;
      });
      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          names.length ? 'No outfit matches “' + q + '”.'
                       : 'No wardrobe outfits yet — build one on the Wardrobe tab.'));
      }
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  const NFF_SETS = [
    { t: 0, name: 'Adventure', hint: 'worn in the wild and in dungeons' },
    { t: 1, name: 'Town',      hint: 'worn in towns, cities and inns' },
    { t: 2, name: 'Home',      hint: 'worn inside a house you own' },
  ];

  /* Open one of the crosshair NPC's NFF outfit chests. Reuses the Wardrobe
     tab's EXISTING bridge (nfBuild -> NffOutfits::Build) rather than adding a
     second path to the same mod: that handler already enforces the one-actor-
     one-backend rule (it refuses anyone SOES-NG is dressing and says why on
     nfResult), closes the palette itself, and lets NFF answer with its own
     container menu. So this needs no DLL change at all.

     formId is sent as HEX TEXT because that is what NffOutfits::ParseHex
     expects; fdTarget hands it to us as a number. No plugin: a full runtime
     form id resolves through LookupByID, which is the fallback ResolveActor
     already takes when plugin is empty. */
  function fillNffOutfit(type) {
    const t = state.target;
    if (!t || !t.formId) { toast('⚠ No NPC targeted'); return; }
    const hex = '0x' + (t.formId >>> 0).toString(16).toUpperCase();
    ui.fqSets = false;
    toGame('nfBuild', JSON.stringify({ formId: hex, plugin: '', type: type }));
  }

  /* Photograph the crosshair NPC. Prefers the FO entry's own formId when they
     are filed (it is already the hex string the plugin parses); otherwise
     formats the target's numeric id, so a stranger can be photographed too. */
  function capturePortrait(known, t) {
    const hex = (known && known.m.formId)
      ? String(known.m.formId)
      : (t && t.formId ? '0x' + (t.formId >>> 0).toString(16).toUpperCase() : '');
    if (!hex) { toast('⚠ No form id for that NPC'); return; }
    openPortraitCapture({formId:hex,name:(t && t.name) || (known && known.m.name)});
  }

  const KIND_IC = { armor: '⛨', weapon: '⚔', ammo: '➶', light: '✦', other: '◆' };
  const KIND_LBL = { armor: 'Armour', weapon: 'Weapon', ammo: 'Ammo', light: 'Light', other: 'Worn' };
  /* Per-SLOT icons for armour pieces (C++ sends `slot`); a weapon/ammo/torch has
     no biped slot so it keeps its KIND icon. Emoji render in-game (the deck already
     ships 🎭 👥 🧥 🛡). */
  const SLOT_IC = { head: '⛑', circlet: '👑', body: '🧥', hands: '🧤', feet: '🥾', shield: '🛡', amulet: '📿', ring: '💍' };
  const SLOT_LBL = { head: 'Head', circlet: 'Circlet', body: 'Body', hands: 'Hands', feet: 'Feet', shield: 'Shield', amulet: 'Amulet', ring: 'Ring' };
  /* One rule, used by both the equipped list and the Copy-Outfit checklist, so
     they never disagree: prefer the slot icon, fall back to the kind icon. */
  function eqIcon(it) {
    const slot = String((it && it.slot) || '');
    if (slot && SLOT_IC[slot]) return { ic: SLOT_IC[slot], lbl: SLOT_LBL[slot] || 'Worn' };
    const kind = String((it && it.kind) || 'other');
    return { ic: KIND_IC[kind] || KIND_IC.other, lbl: KIND_LBL[kind] || 'Worn' };
  }

  /* The worn set, rendered. This is the "enforce" half of the feature: the
     ContainerMenu is entitled to hide or lock items that belong to an actor's
     default OUTFIT, and on this rig three systems (SOES-NG, NFF's own outfit
     sets, Tailor) dress people by owning exactly that form. So the deck does
     not ask the container what she is wearing — C++ reads it off the engine
     with InventoryEntryData::IsWorn() and we show all of it, flagging the
     outfit-owned rows so a locked row in the container is explained instead of
     mysterious.

     Always present when a menu is open, never behind a click: a readout you
     have to go and find is not an enforcement. Internally scrolled, because a
     heavily-kitted follower can wear twenty things and the menu already has a
     height it must not exceed. */
  /* ================================================= her stats, remembered ==
   *  "id like more control over followers on the followers tab, set essential,
   *   set health or hp, share spells (all persistent and remembered)"
   *   — Rober, 2026-08-03. The parenthesis is the point: these write to the
   *   ACTOR, and an actor gets rebuilt. C++ keeps the intent and re-applies it
   *   on every load (src/follower_tune.h explains why that is necessary).
   *
   *  Bridge: fdTune {op,...} -> fdTuneInfo. One reply name for every op
   *  including the read, and the payload always carries LIVE engine state
   *  beside what is REMEMBERED — so this block can show the two disagreeing
   *  rather than asserting a promise the game has since undone.
   * ===================================================================== */

  const tuneCache = Object.create(null);   // reqId -> last fdTuneInfo payload
  let tuneAsked = Object.create(null);
  let tuneSpells = null;                   // the player's book, once asked for
  let tunePerks = null;                    // the load order's perks, once asked for

  /* Always a HEX string. fdTarget delivers the crosshair id as a NUMBER, and
     String() alone spells it in DECIMAL — which C++ then parses as hex, lands
     on the wrong FormID, and refuses with "couldn't find that person in the
     game right now" on the very NPC under the crosshair (reported 2026-08-04:
     F7 on the NPC herself). The first fix stringified; the number
     needed to be RESPELLED. Roster subjects already carry "0x…" strings and
     pass through untouched. */
  function tuneIdOf(m) {
    const v = m && m.formId;
    if (typeof v === 'number' && isFinite(v) && v > 0) return '0x' + v.toString(16);
    return String(v || '');
  }
  function tuneKeyOf(m) { return tuneIdOf(m).toLowerCase(); }
  function tuneFor(m) { return tuneCache[tuneKeyOf(m)] || null; }
  function forgetTuneAsks() { tuneAsked = Object.create(null); }

  function askTune(m) {
    /* Never from a card nobody can see. Both callers (the Stats pill and the
       corpse's Stats row) are built during the ⌕ search's reveal probe and the
       omni snapshot, which construct the whole card into a DETACHED node — and
       a card that is thrown away must not put a request on the wire. The three
       nudges at the foot of the action row take the same guard at their call
       sites; this one takes it here because two buttons share it. */
    if (fqProbing) return;
    const k = tuneKeyOf(m);
    if (!k || tuneAsked[k]) return;
    tuneAsked[k] = true;
    toGame('fdTune', JSON.stringify({ op: 'state', formId: tuneIdOf(m), plugin: m.plugin || '' }));
  }

  function sendTune(m, op, extra) {
    const req = { op: op, formId: tuneIdOf(m), plugin: m.plugin || '' };
    if (extra) Object.keys(extra).forEach(function (kk) { req[kk] = extra[kk]; });
    fqStatus = { msg: '', ok: true, pending: true };
    toGame('fdTune', JSON.stringify(req));
    renderQuickCard();
  }

  /* ---- the card's entry point --------------------------------------------
     A one-line button, not the panel. "i feel like stats should be its own
     pop out menu" — and the measurement agrees: with three pools, her whole
     castable list and perks, the panel is taller than the card it was living
     inside, and it was pushing the party rows off the bottom exactly like the
     settings card did to the hotkey list.

     The head still carries the fact worth seeing without opening anything:
     whether she can die. */
  function tuneRow(subj, t) {
    const m = subj || (t && t.formId ? { formId: t.formId, name: t.name } : null);
    if (!m || !m.formId) return null;
    askTune(m);                                   // so the chip is true on arrival
    const data = tuneFor(m);
    const live = (data && data.live) || null;
    const chip = !live ? '…'
      : (live.essential ? 'essential' : (live.protected ? 'protected' : 'mortal'));
    return h('button', {
      class: 'fd-tune-head', type: 'button',
      title: 'Her stats — whether she can be killed, her health / magicka / '
           + 'stamina, the spells she can cast, and any perks you have granted. '
           + 'All of it is remembered and put back after a load.',
      onClick: (e) => { e.stopPropagation(); openTunePanel(e.currentTarget, m); },
    },
      h('span', { class: 'fd-tune-caret' }, '⚙'),
      h('span', { class: 'fd-tune-title' }, 'Stats'),
      h('span', { class: 'fd-tune-count' }, chip));
  }

  /* The Stats button, as a CONTINUATION OF THE ACTION ROW (Rober,
     2026-08-07, final): its own bordered .fq-igroup at the end of the
     hover-label icon row — same quickBtn (icon grows its label on hover),
     separate border. Opens the tune modal; the mortality chip rides inside
     and shows with the label. Future buttons: append more quickBtns into
     this group. Not on a corpse — the old bottom Stats row serves there. */
  function quickHeadPills(subj, t) {
    const m = subj || (t && t.formId ? { formId: t.formId, name: t.name } : null);
    if (!m || !m.formId) return null;
    askTune(m);                                   // fdTuneInfo re-renders the card on arrival
    const data = tuneFor(m);
    const live = (data && data.live) || null;
    const chip = !live ? '\u2026'
      : (live.essential ? 'essential' : (live.protected ? 'protected' : 'mortal'));
    const b = quickBtn('\u2699', 'Stats',
      'Her stats \u2014 whether she can be killed, her health / magicka / stamina, '
      + 'spells and perks (' + chip + '). Opens the full panel; everything set there '
      + 'is remembered and put back after a load.',
      (e) => openTunePanel(e.currentTarget, m));
    b.classList.add('fq-side-stats');
    /* no chip on the button (Rober: 'just the stats name') — the mortality
       word lives in the hover title instead */
    return h('span', { class: 'fq-igroup fq-igroup-x' }, b);
  }

  /* The pop-out. The deck's own menu chrome, like every other picker here, so
     it scrolls, clamps to the viewport and drags by its head for free. */
  function openTunePanel(anchorEl, m) {
    closeCtx();
    tunePanelFor = m;
    const items = [h('div', { class: 'fd-ctx-head', title: m.name },
      (m.name || 'Her') + ' — stats')];
    const body = h('div', { class: 'fd-tune-body' });
    items.push(body);
    paintTunePanel(body, m);

    /* .fd-tune-panel scopes the bigger-text pass to THIS centered pop-out, so
       the compact inline "Stats" readout on the card is untouched (Rober,
       2026-08-06: "stats popout could be bigger text and more screenspace"). */
    ctxEl = h('div', { id: 'fd-ctx-menu', class: 'fd-tune-panel', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), true);   // ask for the wider share — easier to read
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(240) + 'px';
    ctxEl.style.overflowY = 'auto';
    /* CENTERED on screen, not anchored to the ⚙ Stats button (Rober,
       2026-08-05: "stats needs to open centered on screen"). Measure the built
       panel, then clamp it to the middle of the viewport. */
    const vp = ctxViewport();
    const sc = deckScale();
    const wP = w * sc, h0 = (ctxEl.offsetHeight || 320) * sc;   // PAINTED extent
    clampCtx(Math.max(8, (vp.w - wP) / 2), Math.max(8, (vp.h - h0) / 2));
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => { document.addEventListener('mousedown', ctxOutside, true); }, 0);
  }

  /* Which person the open panel is about, so a reply can repaint it in place
     instead of the panel going stale the moment you change anything. */
  let tunePanelFor = null;

  function repaintTunePanel() {
    if (!ctxEl || !tunePanelFor) return;
    const body = ctxEl.querySelector('.fd-tune-body');
    if (body) paintTunePanel(body, tunePanelFor);
  }

  /* The panel's contents. A function of (live state, remembered state) only —
     rebuilt whole on every reply, so nothing on screen can disagree with what
     the game just told us. */
  function paintTunePanel(box, m) {
    box.textContent = '';
    const data = tuneFor(m);
    if (!data) {
      const sk = h('div', { class: 'fd-eq-list fd-tune-wait' });
      for (let i = 0; i < 4; i++) sk.append(h('div', { class: 'fd-eq-row skel' }, h('span', { class: 'fd-eq-sk' })));
      box.append(sk);
      return;
    }
    if (data.durable === false) {
      box.append(h('div', { class: 'fd-eq-empty' },
        (m.name || 'She') + ' was spawned this session, so nothing set here could '
        + 'be remembered. The controls are hidden rather than lying to you.'));
      return;
    }
    const live = data.live || {};
    const kept = data.kept || {};

    /* ---- can she die ---- */
    const mortalRow = h('div', { class: 'fd-tune-row' },
      h('span', { class: 'fd-tune-lbl' }, 'Death'));
    mortalRow.append(tuneChip('Mortal', '☠', !live.essential && !live.protected,
      'Anything can kill her.',
      () => sendTune(m, live.essential ? 'essential' : 'protected', { on: false })));
    mortalRow.append(tuneChip('Protected', '⛨', !!live.protected && !live.essential,
      'Only YOU can land the killing blow — anything else knocks her down instead.',
      () => sendTune(m, 'protected', { on: true })));
    mortalRow.append(tuneChip('Essential', '✦', !!live.essential,
      'She cannot be killed at all. Overrides protected, which is why picking one '
      + 'clears the other.',
      () => sendTune(m, 'essential', { on: true })));
    box.append(mortalRow);

    /* ---- the three pools ---- *
       All three, because a follower given 2000 hit points and left with a
       mage's stamina is not tougher, she is a punching bag that cannot
       sprint. Each row can also be RELEASED — the deck stops maintaining the
       number and the game keeps whatever she has. */
    POOLS.forEach(function (pool) {
      const cur = live[pool.key] || 0;
      const now = live[pool.key + 'Now'];
      const heldByUs = !!kept[pool.key];
      const row = h('div', { class: 'fd-tune-row' },
        h('span', { class: 'fd-tune-lbl' }, pool.label),
        h('span', { class: 'fd-tune-val' + (heldByUs ? ' kept' : '') },
          String(cur) + (typeof now === 'number' && now < cur ? ' (' + now + ' now)' : '')));
      pool.steps.forEach((v) => row.append(tuneChip(String(v), '', cur === v,
        'Set her ' + pool.label.toLowerCase() + ' to ' + v + ' and fill it.',
        () => sendTune(m, 'av', { which: pool.key, value: v }))));
      if (heldByUs) {
        row.append(tuneChip('Release', '↺', false,
          'Stop maintaining her ' + pool.label.toLowerCase() + ' — the game keeps '
          + 'whatever she has now, and the deck will not put it back after a load.',
          () => sendTune(m, 'av', { which: pool.key, value: 0 })));
      }
      box.append(row);
    });

    const actRow = h('div', { class: 'fd-tune-row' }, h('span', { class: 'fd-tune-lbl' }, ''));
    actRow.append(tuneChip('Heal now', '✚', false,
      'Top up health, magicka and stamina. A one-off, not a setting.',
      () => sendTune(m, 'heal')));
    actRow.append(tuneChip('Stop managing', '⊘', false,
      'Forget everything remembered about her, and take back the spells and perks '
      + 'the deck gave her. Her flags and pools are left exactly as they are.',
      () => sendTune(m, 'clear')));
    box.append(actRow);

    /* ---- what she can cast ---- */
    const known = data.known || [];
    /* A spell we are SUPPOSED to have given her that she does not have is the
       one thing this panel exists to surface — Reapply will put it back, and
       until then it must not look like everything is fine. It rides on the
       HEADER rather than under the list, where it read as a footnote to a
       spell that was also listed above it as present. */
    const lost = (data.spells || []).filter((sp) => !sp.has);
    box.append(h('div', { class: 'fd-tune-row spells' },
      h('span', { class: 'fd-tune-lbl' }, 'Spells'),
      tuneChip('Share a spell…', '✚',  false,
        'Give her something out of your own spellbook. She keeps it across loads.',
        (e) => openSpellShare(e.currentTarget, m)),
      h('span', { class: 'fd-tune-val' }, known.length + ' castable'),
      lost.length
        ? h('span', {
            class: 'fd-tune-warn',
            title: lost.map((sp) => sp.name).join(', ') + ' — she has lost '
                 + (lost.length === 1 ? 'it' : 'them') + '. The deck puts '
                 + (lost.length === 1 ? 'it' : 'them') + ' back on the next load.',
          }, '⚠ ' + lost.length + ' missing')
        : null));

    if (known.length) {
      /* CHIPS that wrap, not one full-width row each. A real follower knows
         15-40 spells; as rows that was 40 lines of mostly-empty width and it
         buried the perks section under a scroll. As chips the same list is
         three or four lines, and the two facts that matter — which ones are
         OURS, and the take-back — still fit on the chip itself. */
      const list = h('div', { class: 'fd-tune-chips' });
      known.forEach(function (sp) {
        const chip = h('span', {
          class: 'fd-tune-sp' + (sp.given ? ' given' : ''),
          title: sp.given
            ? sp.name + ' — the deck gave her this one and will put it back after a load'
            : sp.name + ' — she came with this one',
        }, h('span', { class: 'fd-tune-sp-n' }, sp.name));
        if (sp.given) {
          chip.append(h('button', {
            class: 'fd-tune-x', type: 'button', title: 'Take ' + sp.name + ' back',
            onClick: (e) => {
              e.stopPropagation();
              sendTune(m, 'spellRemove', { spell: sp.formId, spellPlugin: sp.plugin });
            },
          }, '✕'));
        }
        list.append(chip);
      });
      box.append(list);
    } else {
      box.append(h('div', { class: 'fd-tune-none' }, 'She knows no spells.'));
    }

    /* ---- perks ---- */
    const perks = data.perks || [];
    box.append(h('div', { class: 'fd-tune-row spells' },
      h('span', { class: 'fd-tune-lbl' }, 'Perks'),
      tuneChip('Grant a perk…', '✚', false,
        'Give her any perk in the load order. Remembered and re-applied like a spell.',
        (e) => openPerkGrant(e.currentTarget, m))));
    if (perks.length) {
      const list = h('div', { class: 'fd-tune-spells' });
      perks.forEach(function (pk) {
        list.append(h('div', { class: 'fd-tune-spell' + (pk.has ? ' given' : ' lost') },
          h('span', { class: 'fd-tune-spell-n', title: pk.name }, pk.name || '(unknown perk)'),
          pk.missing
            ? h('span', { class: 'fd-tune-spell-warn', title: 'This perk is not in the load order any more.' }, '⚠ gone')
            : (pk.has ? null : h('span', { class: 'fd-tune-spell-warn' }, '⚠ lost')),
          h('button', {
            class: 'fd-tune-x', type: 'button', title: 'Take ' + pk.name + ' back',
            onClick: (e) => {
              e.stopPropagation();
              sendTune(m, 'perkRemove', { perk: pk.formId, perkPlugin: pk.plugin });
            },
          }, '✕')));
      });
      box.append(list);
    } else {
      box.append(h('div', { class: 'fd-tune-none' }, 'No granted perks.'));
    }
  }

  /* The three pools and the steps each one is worth offering. Magicka and
     stamina get smaller numbers than health because they are spent, not
     absorbed — 2000 magicka is not "a mage", it is infinite casting. */
  const POOLS = [
    { key: 'health',  label: 'Health',  steps: [100, 250, 500, 1000, 2000] },
    { key: 'magicka', label: 'Magicka', steps: [100, 250, 500, 1000] },
    { key: 'stamina', label: 'Stamina', steps: [100, 250, 500, 1000] },
  ];

  function tuneChip(label, glyph, on, tip, onPick) {
    return h('button', {
      class: 'fd-tune-chip' + (on ? ' on' : ''), type: 'button', title: tip,
      onClick: (e) => { e.stopPropagation(); onPick(e); },
    }, glyph ? h('span', { class: 'fd-tune-glyph' }, glyph) : null, label);
  }

  /* Your spellbook, filtered as you type — the deck's menu idiom, because the
     list is ~100 rows on a real save and an unsearchable one is a defect. */
  function openSpellShare(anchorEl, m) {
    closeCtx();
    if (!tuneSpells) toGame('fdTune', JSON.stringify({ op: 'spells' }));

    const items = [h('div', { class: 'fd-ctx-head' }, 'Share a spell with ' + (m.name || 'her'))];
    items.push(h('div', { class: 'fd-ctx-field' },
      h('input', {
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter your spells…',
        onInput: (e) => paint(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      })));
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    items.push(listBox);

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      if (!tuneSpells) {
        listBox.append(h('div', { class: 'fd-ctx-empty' }, 'Reading your spellbook…'));
        return;
      }
      const hits = tuneSpells.filter((sp) => !f ||
        String(sp.name || '').toLowerCase().indexOf(f) !== -1 ||
        String(sp.school || '').toLowerCase().indexOf(f) !== -1);
      if (!hits.length) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          tuneSpells.length ? 'No spell matches “' + q + '”.' : 'You know no shareable spells.'));
        return;
      }
      hits.slice(0, 200).forEach(function (sp) {
        listBox.append(h('button', {
          class: 'fd-ctx-item', type: 'button', title: sp.name,
          onClick: (e) => {
            e.stopPropagation(); closeCtx();
            sendTune(m, 'spellAdd', { spell: sp.formId, spellPlugin: sp.plugin });
          },
        },
          h('span', { class: 'fd-ctx-check' }, '✦'),
          h('span', { class: 'fd-ctx-lbl' }, sp.name),
          sp.school ? h('span', { class: 'fd-ctx-count' }, sp.school) : null));
      });
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  /* Grant a perk. The spell picker's twin, and filtered for the same reason:
     the load order carries ~700 named perks. */
  function openPerkGrant(anchorEl, m) {
    const back = tunePanelFor;                 // reopen the panel behind us on close
    closeCtx();
    if (!tunePerks) toGame('fdTune', JSON.stringify({ op: 'perks' }));

    const items = [h('div', { class: 'fd-ctx-head' }, 'Grant a perk to ' + (m.name || 'her'))];
    items.push(h('div', { class: 'fd-ctx-field' },
      h('input', {
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter perks…',
        onInput: (e) => paint(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      })));
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    items.push(listBox);

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      if (!tunePerks) {
        listBox.append(h('div', { class: 'fd-ctx-empty' }, 'Reading the perk list…'));
        return;
      }
      const hits = tunePerks.filter((pk) => !f ||
        String(pk.name || '').toLowerCase().indexOf(f) !== -1);
      if (!hits.length) {
        listBox.append(h('div', { class: 'fd-ctx-empty' }, 'No perk matches “' + q + '”.'));
        return;
      }
      /* Capped like the spell picker: a 700-row list is a scroll, not a
         choice, and the filter above it is the actual answer. */
      hits.slice(0, 200).forEach(function (pk) {
        listBox.append(h('button', {
          class: 'fd-ctx-item', type: 'button', title: pk.plugin || pk.name,
          onClick: (e) => {
            e.stopPropagation(); closeCtx();
            sendTune(m, 'perkAdd', { perk: pk.formId, perkPlugin: pk.plugin });
          },
        },
          h('span', { class: 'fd-ctx-check' }, '✧'),
          h('span', { class: 'fd-ctx-lbl' }, pk.name),
          pk.plugin ? h('span', { class: 'fd-ctx-count' }, pk.plugin.replace(/\.es[lmp]$/i, '')) : null));
      });
      if (hits.length > 200)
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          (hits.length - 200) + ' more — keep typing to narrow it.'));
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    tunePanelFor = back;
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  /* The rendered-mesh icon for a worn item, from the Wardrobe pane's ItemIcons
     index (Mesh Rendering Framework 169708 → icons/items/<file>.png). Both
     panes live in the same HotkeyDeck view, so the path resolves and we can
     read WardrobePane's index directly rather than push a second copy. */
  function wornKey(it) {
    if (!it || !it.formId || !it.plugin) return '';
    return String(it.formId).toUpperCase() + '|' + String(it.plugin).toLowerCase();
  }
  function wornIconFor(it) {
    if (!it) return '';
    /* PREFER the path the DLL stamped onto this worn piece (C++
       ItemIcons::IconPathIfRendered, carried on the fdWorn item as `icon`):
       an ALREADY-rendered piece then paints its picture on the card's FIRST
       paint, instead of glyph-then-swap after the wdItemIcons index round-trips
       (Rober, 2026-08-14: "dont have to load every single time (save?)"). The
       DLL only stamps pieces that already have a PNG on disk, so a not-yet-
       rendered piece has no `it.icon` and falls through to the wardrobe index —
       which is empty for it until its LAZY whIcons render lands, at which point
       upgradeEquippedIconsInPlace mounts it with no flash. */
    const pane = window.WardrobePane;
    // A manual regeneration invalidates the DLL's eager stamp too. Otherwise
    // a new PNG lands but this tile and its lightbox keep opening the old one.
    if (pane && pane.itemIconAttempt && pane.itemIconAttempt(it)) return pane.itemIconFor(it);
    if (it.icon) return it.icon;
    const key = wornKey(it);
    if (!key) return '';
    const wp = (typeof window !== 'undefined') ? window.WardrobePane : null;
    const idx = wp && wp._state && wp._state.itemIcons;
    if (!idx) return '';
    return idx[key] || '';
  }

  /* Worn-mesh renders are LAZY (Rober, 2026-08-14: F7-on-an-NPC stutter).
     The `fdEquipped` data fetch used to burst a mesh render for every worn
     piece the instant the card opened — MRF renders ~0.5-1s each on the render
     thread, so a fresh NPC's whole kit hitched the frame you pressed F7 on. The
     eager path (C++ EnsureIconsForWorn) now only registers the worn keys +
     hands back the index (cheap — it names pieces that already have a PNG); the
     actual render REQUEST is deferred to when the equipped GRID is on screen and
     off the open critical path, via `requestWornRenders` below. It routes
     through the wheel's `whIcons` → EnsureIconsForList, i.e. the SAME paced
     (Pump 400ms/1s) render-once/persisted (item-icons.json) queue everything
     else uses, so pieces trickle in instead of bursting and never re-render.

     `wornAsked` dedupes per session so the many renderQuickCard() calls (every
     fdEquipped/fdTarget reply re-renders the card) don't re-send the same list;
     a render only fires for a piece with no PNG yet, and only once per key. */
  const wornAsked = Object.create(null);   // "FORMID|plugin" -> true, requested this session
  let wornReqTimer = 0;
  let wornReqBuf = [];                      // items accumulated for the next flush
  function requestWornRenders(items) {
    if (!Array.isArray(items) || !items.length) return;
    items.forEach(function (it) {
      if (!it || !it.formId || !it.plugin) return;
      const key = String(it.formId).toUpperCase() + '|' + String(it.plugin).toLowerCase();
      if (wornAsked[key]) return;            // already asked this session
      if (wornIconFor(it)) { wornAsked[key] = true; return; }   // already rendered
      wornAsked[key] = true;
      wornReqBuf.push({ formId: it.formId, plugin: it.plugin, name: it.name || '' });
    });
    if (!wornReqBuf.length) return;
    /* OFF the F7 frame. buildQuickCard runs synchronously on the press that
       opens the deck; queuing the render request behind a 0ms timer lets that
       frame present before C++ starts any MRF work, and coalesces the several
       renderQuickCard() calls a single open provokes (and any two subjects in
       the same tick) into one send. The buffer accumulates across calls so a
       second person's pieces are never stranded by the coalescing guard. */
    if (wornReqTimer) return;
    wornReqTimer = setTimeout(function () {
      wornReqTimer = 0;
      const want = wornReqBuf; wornReqBuf = [];
      if (!want.length) return;
      try { toGame('whIcons', JSON.stringify({ items: want })); } catch (e) {}
    }, 0);
  }

  /* Rendered gear pictures land ASYNCHRONOUSLY: `requestWornRenders` queues
     Mesh Rendering Framework renders and each finished batch re-pushes the
     wdItemIcons index. The Wardrobe receiver fires this event only when the
     index actually changed, and renderQuickCard self-guards when no card is
     mounted — so tiles upgrade glyph → picture as renders arrive, and a
     no-change push repaints nothing. */
  document.addEventListener('hd-item-icons', function () {
    /* Upgrade the equipped tiles IN PLACE instead of rebuilding the whole card.
       A full renderQuickCard() destroys and recreates every tile's DOM, and in
       these compositor-off Ultralight views recreating an already-drawn
       background-image tile forces a re-decode — so the entire equipped grid
       flashed each time ONE mesh render landed (Rober, 2026-08-14). This is the
       Finder's upgradeIconsInPlace pattern (npcs-pane.js): touch only the tiles
       that gained art, and never rebuild a tile already showing its picture. If
       no equipped grid is on screen (or the mount fails), fall back to the old
       full repaint so a card that is not yet built still catches up. */
    try {
      if (!upgradeEquippedIconsInPlace()) renderQuickCard();
    } catch (e) {
      try { renderQuickCard(); } catch (e2) { /* card not mounted yet */ }
    }
  });

  /* Patch the on-screen equipped tiles to reflect freshly-landed worn-mesh
     renders WITHOUT rebuilding the card — the anti-flash path (mirrors
     npcs-pane's upgradeIconsInPlace). For each tile whose render now resolves
     but which still shows the glyph, replace the glyph with the picture and mark
     it clickable; a tile already showing its image (or still pending) is left
     exactly as it is, so Ultralight never re-decodes a tile that is already on
     screen. Returns true when it found an equipped grid to work on (so the
     caller knows the in-place path handled it), false when there was none. */
  function upgradeEquippedIconsInPlace() {
    if (!quickHost) return false;
    const grid = quickHost.querySelector('.fq-equip .fq-equip-grid');
    if (!grid) return false;
    grid.querySelectorAll('.fq-equip-tile[data-wkey]').forEach(function (tile) {
      if (tile._wornItem) syncEquippedTile(tile, tile._wornItem);
    });
    paintEquippedRenderStatus(grid.parentNode);
    return true;
  }

  function positionEquippedFly(tile) {
    const tray = tile.querySelector('.fq-equip-fly');
    const box = tile.closest('.fq-equip');
    if (!tray || !box || !tile.offsetWidth) return;
    const rect = tile.getBoundingClientRect(), bounds = box.getBoundingClientRect();
    const scale = rect.width / tile.offsetWidth || 1;
    const right = rect.left + tray.offsetWidth * scale;
    // Clamp inside the card even at its right edge and under deck UI scaling.
    const shift = Math.max(bounds.left + 8 - rect.left, Math.min(0, bounds.right - 8 - right));
    tray.style.left = (shift / scale) + 'px';
  }

  function syncEquippedTile(tile, it) {
    const url = wornIconFor(it);
    const wp = window.WardrobePane;
    const attempt = wp && wp.itemIconAttempt && wp.itemIconAttempt(it);
    const why = (attempt && attempt.why) || (wp && wp.itemIconFailed && wp.itemIconFailed(it)) || '';
    let img = tile.querySelector('.fq-equip-img');
    let glyph = tile.querySelector('.fq-equip-glyph');
    // Preserve every unchanged image node (Ultralight's anti-flash contract).
    if (url && tile.getAttribute('data-icon-url') !== url) {
      if (!img) { img = h('span', { class: 'fq-equip-img' }); tile.insertBefore(img, tile.firstChild); }
      img.style.backgroundImage = 'url("' + url + '")';
      if (glyph) glyph.remove();
      tile.setAttribute('data-icon-url', url);
    } else if (!url && img) {
      img.remove(); tile.removeAttribute('data-icon-url');
      if (!glyph) { const ei = eqIcon(it); tile.insertBefore(h('span', { class: 'fq-equip-glyph' }, ei.ic), tile.firstChild); }
    }
    tile.classList.toggle('haslb', !!url);
    tile.setAttribute('title', it.name + (it.plugin ? '\n' + it.plugin : '') +
      (url ? '\nClick to see it large — then drag to turn it' : (why ? '\n' + why : '')));
    const btn = tile.querySelector('.fq-equip-regenerate');
    if (btn) {
      btn.disabled = !!(attempt && attempt.phase === 'pending');
      btn.textContent = btn.disabled ? '…' : '⟳';
      btn.title = btn.disabled ? 'Rendering ' + it.name + '…'
        : 'Regenerate image' + (why ? ' — ' + why : ' — make a new picture of ' + it.name);
      btn.setAttribute('aria-label', (btn.disabled ? 'Rendering ' : 'Regenerate image of ') + it.name);
    }
    tile.setAttribute('aria-busy', String(!!(attempt && attempt.phase === 'pending')));
    if (attempt && attempt.phase !== 'ready') delete wornSpinCache[wornKey(it)];
  }

  function paintEquippedRenderStatus(box) {
    const msg = box.querySelector('.fq-equip-render-status');
    if (!msg) return;
    const wp = window.WardrobePane;
    const messages = [];
    box.querySelectorAll('.fq-equip-tile[data-wkey]').forEach(function (tile) {
      const it = tile._wornItem;
      const a = it && wp && wp.itemIconAttempt && wp.itemIconAttempt(it);
      if (!a) return;
      messages.push(it.name + ': ' + (a.phase === 'pending' ? 'Regenerating image…' :
        a.phase === 'ready' ? 'Image updated.' : a.why || 'Image unavailable. Try again.'));
    });
    msg.textContent = messages.join(' · ');
    msg.hidden = !messages.length;
  }

  function regenerateEquippedImage(it, tile) {
    const wp = window.WardrobePane;
    if (!wp || !wp.rerenderItemIcon || !wp.rerenderItemIcon(it)) {
      const a = wp && wp.itemIconAttempt && wp.itemIconAttempt(it);
      if (!a || a.phase !== 'pending') toast('Could not start the image. Open SkyManager in game and try again.');
      return;
    }
    wornAsked[wornKey(it)] = true; // only the explicit retry owns this request
    delete wornSpinCache[wornKey(it)];
    syncEquippedTile(tile, it);
    paintEquippedRenderStatus(tile.parentNode.parentNode);
  }

  /* ── worn-item lightbox: a drag-to-orbit TURNTABLE ──────────────────────
     Ported from Dragon Roost's proven spin lightbox. Mesh Rendering Framework
     renders the piece at 4 angles (90° apart, spun about Z) into
     icons/items/<file>-a090/-a180/-a270.png siblings of the frame-0 icon; the
     DLL bakes them only when we send `fdItemSpin` — which this controller does
     LAZILY, on the first drag, NOT on open (~6s/frame, one subject, never
     bulk). So opening a piece to look costs zero renders; only turning it
     spends any. Frame 0 shows instantly; the 3 others stream in with a dot per
     angle. Mouse only (this view is in-game; the phone is the Deck Portal), and
     mouse-on-document — Ultralight has no PointerEvents. */
  const WSPIN_N = 4, WSPIN_STEP = 90, WSPIN_DEG_PER_PX = 0.8;
  const WSPIN_SLOP = 4, WSPIN_POLL_MS = 3000, WSPIN_POLL_TRIES = 30;
  let wornSpin = null;               // live lightbox state, or null when closed
  const wornSpinCache = {};          // key -> {base, frames[]} so a re-open is instant

  function wspinCount() { let n = 0; if (wornSpin) for (let i = 0; i < WSPIN_N; i++) if (wornSpin.frames[i]) n++; return n; }
  function wspinDelta(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }
  function wspinNearest(deg) {
    let best = -1, bestD = 1e9;
    for (let i = 0; i < WSPIN_N; i++) {
      if (!wornSpin.frames[i]) continue;
      const d = Math.abs(wspinDelta(deg, i * WSPIN_STEP));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best < 0 ? 0 : best;
  }
  function wspinShow(i) {
    const src = wornSpin.frames[i]; if (!src) return;
    wornSpin.idx = i;
    if (wornSpin.el.img.getAttribute('src') !== src) wornSpin.el.img.src = src;
    wspinPaint();
  }
  function wspinPaint() {
    if (!wornSpin) return;
    const n = wspinCount(), hasKey = !!wornSpin.key;
    // The grab cursor + hint advertise the affordance as soon as the piece has
    // an identity — BEFORE any angle is baked — because baking is lazy: it only
    // starts on the first drag (see onMove). A piece with no identity is a
    // still picture and says nothing.
    wornSpin.el.back.classList.toggle('is-spinnable', hasKey);
    const hint = wornSpin.el.hint, dots = wornSpin.el.dots;
    if (!hasKey) { hint.textContent = ''; dots.innerHTML = ''; return; }
    hint.textContent = !wornSpin.asked
      ? 'Drag to turn'                                   // not baking yet — advertise only
      : (n >= WSPIN_N ? 'Drag to turn' : 'Turning… ' + n + ' of ' + WSPIN_N + ' angles');
    if (!wornSpin.asked) { dots.innerHTML = ''; return; } // no dots until a bake is underway
    let html = '';
    for (let i = 0; i < WSPIN_N; i++)
      html += '<i class="fq-lb-dot' + (wornSpin.frames[i] ? ' is-on' : '') + (i === wornSpin.idx ? ' is-now' : '') + '"></i>';
    dots.innerHTML = html;
  }
  // Kick off the lazy bake the first time a real drag begins. Idempotent — one
  // fdItemSpin per subject per lightbox — so merely opening a piece never
  // renders anything; only turning it does.
  function wspinBeginBake() {
    if (!wornSpin || wornSpin.asked || !wornSpin.key) return;
    wornSpin.asked = true;
    toGame('fdItemSpin', JSON.stringify({ formId: wornSpin.fid, plugin: wornSpin.plug }));
    wspinPoll();
    wspinPaint();
  }
  function wspinLand(key, i, url) {
    if (wornSpinCache[key]) wornSpinCache[key].frames[i] = url;
    if (!wornSpin || wornSpin.key !== key || wornSpin.frames[i]) return;
    wornSpin.frames[i] = url; wspinPaint();
  }
  /* Frames land through the hdSpinState push, never Image() probes: the old
     probe loop cache-busted its retries with ?sp=N, and Ultralight does not
     load query-string URLs at all — the frames baked to disk and this view
     polled dead URLs for 90 s, which is why the worn spin never turned for
     anyone (found 2026-08-19: zero -aNNN files ever on the rig). C++ answers
     fdItemSpin/hdSpin with the frames that EXIST; polling = re-sending the
     ask (every leg is dedup-safe). */
  document.addEventListener('hd-spin-state', function () {
    if (!wornSpin || !window.HDLightbox || typeof HDLightbox._spinState !== 'function') return;
    const d = HDLightbox._spinState();
    if (!d || d.kind !== 'item' || !d.frames) return;
    if (String(d.formId || '').toUpperCase() !== String(wornSpin.fid).toUpperCase() ||
        String(d.plugin || '').toLowerCase() !== String(wornSpin.plug).toLowerCase()) return;
    for (let i = 1; i < WSPIN_N; i++) {
      const url = d.frames[String(i * WSPIN_STEP)];
      if (url) wspinLand(wornSpin.key, i, url);
    }
  });
  function wspinPoll() {
    if (!wornSpin) return;
    const sp = wornSpin;
    if (sp.poll) { clearTimeout(sp.poll); sp.poll = null; }
    if (wspinCount() >= WSPIN_N || sp.tries >= WSPIN_POLL_TRIES) return;
    sp.tries++;
    // Re-ask; the reply is the hdSpinState push the listener above consumes.
    toGame('fdItemSpin', JSON.stringify({ formId: sp.fid, plugin: sp.plug }));
    sp.poll = setTimeout(wspinPoll, WSPIN_POLL_MS);
  }

  function closeWornLightbox() {
    if (wornSpin) {
      if (wornSpin.poll) clearTimeout(wornSpin.poll);
      window.removeEventListener('mousemove', wornSpin.onMove, true);
      window.removeEventListener('mouseup', wornSpin.onUp, true);
      wornSpin = null;
    }
    const e = document.getElementById('fq-worn-lightbox');
    if (e) e.remove();
  }
  function openWornLightbox(url, name, it) {
    closeWornLightbox();
    const fid = it && it.formId ? String(it.formId) : '';
    const plug = it && it.plugin ? String(it.plugin) : '';
    const key = fid && plug ? (fid.toUpperCase() + '|' + plug.toLowerCase()) : '';

    const img = h('img', { class: 'fq-lb-img', src: url, alt: name, draggable: 'false' });
    const stage = h('div', { class: 'fq-lb-stage' }, img);
    const hint = h('div', { class: 'fq-lb-hint' });
    const dots = h('div', { class: 'fq-lb-dots' });
    const back = h('div', {
      id: 'fq-worn-lightbox', class: 'fq-lb-back', role: 'dialog', 'aria-label': name,
      title: 'Click to close · drag the item to turn it',
    }, stage, h('div', { class: 'fq-lb-name' }, name), h('div', { class: 'fq-lb-spin' }, hint, dots));

    const frames = new Array(WSPIN_N).fill(''); frames[0] = url;
    wornSpin = {
      key: key, fid: fid, plug: plug, base: url, frames: frames,
      idx: 0, deg: 0, drag: null, tries: 0, poll: 0, asked: false, ateClick: false,
      el: { back: back, img: img, hint: hint, dots: dots },
      onMove: null, onUp: null,
    };
    // A subject seen this session comes back with whatever had already landed.
    if (key) {
      const cached = wornSpinCache[key];
      if (cached && cached.base === url) for (let i = 1; i < WSPIN_N; i++) wornSpin.frames[i] = cached.frames[i] || '';
      else wornSpinCache[key] = { base: url, frames: wornSpin.frames.slice() };
    }

    // Close on click — unless the press was a drag (turning the item must not
    // dismiss it). A frame-0-only URL with no identity is a still picture.
    back.addEventListener('click', () => {
      if (wornSpin && wornSpin.ateClick) { wornSpin.ateClick = false; return; }
      closeWornLightbox();
    });
    // A drag CAN start with only frame 0 present — that first movement is what
    // triggers the lazy bake. So the guard is "has identity", not "has frames".
    back.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !wornSpin || !wornSpin.key) return;
      wornSpin.drag = { x: e.clientX, deg: wornSpin.deg, moved: false };
      back.classList.add('is-dragging');
      e.preventDefault();               // no browser image-drag ghost
    });
    wornSpin.onMove = (e) => {
      const d = wornSpin && wornSpin.drag; if (!d) return;
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < WSPIN_SLOP) return;
      if (!d.moved) { d.moved = true; wspinBeginBake(); }   // first real drag → start rendering
      wornSpin.deg = ((d.deg + dx * WSPIN_DEG_PER_PX) % 360 + 360) % 360;
      wspinShow(wspinNearest(wornSpin.deg));
      e.preventDefault();
    };
    wornSpin.onUp = () => {
      if (!wornSpin || !wornSpin.drag) return;
      const moved = wornSpin.drag.moved;
      wornSpin.drag = null;
      back.classList.remove('is-dragging');
      if (moved) wornSpin.ateClick = true;   // swallow the click that follows the release
    };
    window.addEventListener('mousemove', wornSpin.onMove, true);
    window.addEventListener('mouseup', wornSpin.onUp, true);

    document.body.appendChild(back);

    // NOTHING is rendered on open — baking is LAZY, kicked off by the first
    // drag (wspinBeginBake in onMove). So merely opening a piece to look at it
    // costs zero renders; only turning it spends any. A subject re-opened after
    // its frames already baked this session shows them straight from the cache
    // above, so a second turn is instant.
    if (key && wornSpin.frames.some((f, i) => i > 0 && f)) { wornSpin.asked = true; wspinPoll(); }
    wspinPaint();
  }

  /* Which Gear-Toggle slot group a worn item belongs to, so a tile's Hide can
     cull the right slot. Gear Toggle works on the four biped groups only, so a
     non-armour piece (weapon / torch) gets no Hide — just Delete. Inferred from
     the name because the equipped read carries kind, not the biped slot. */
  function gearGroupFor(it) {
    if (!it || String(it.kind || '') !== 'armor') return '';
    const n = String(it.name || '').toLowerCase();
    if (/shield/.test(n)) return 'shield';
    if (/cloak|cape|shroud|mantle/.test(n)) return 'cloak';
    if (/helm|hood|circlet|mask|\bhat\b|crown|coif|\bcap\b/.test(n)) return 'head';
    return 'body';
  }

  /* EQUIPPED as a framed CONTAINER (Rober, 2026-08-05): each worn piece is a
     rendered-mesh SQUARE — click for a lightbox, hover to remove it — with
     Hide gear on the header line. The mesh comes from ItemIcons (169708); a
     piece that has not been rendered yet falls back to its slot glyph. */
  /* Tile scale for the EQUIPPED grid (Rober, 2026-08-18: "lets add a scaling
     slider for this element … to make the equipment larger"). A −/＋ stepper
     per the no-range-input law; persisted in the shelf blob (the raw slice
     C++ round-trips whole — a new settings key would be dropped). */
  function eqScale() {
    const s = window.__hdShelfSlice ? window.__hdShelfSlice('fqEquip') : {};
    const v = Number(s.scale);
    return (isFinite(v) && v >= 0.75 && v <= 2) ? v : 1;
  }
  function setEqScale(v) {
    if (!window.__hdShelfSlice) return;
    window.__hdShelfSlice('fqEquip').scale = v;
    if (window.__hdShelfSave) window.__hdShelfSave();
  }

  function equippedContainer(m, who) {
    const data = equippedFor(m);
    /* NOT .fq-sets — that class is the Outfit set-picker's identifier; this is a
       cgroup like Order/Move/Home. */
    const box = h('div', { class: 'fq-cgroup fq-equip' });
    const count = data && data.ok ? String((data.items || []).length) : '…';
    /* Label + count, then the size stepper on the same line. */
    const scaleNow = eqScale();
    const head = h('span', { class: 'fq-sets-lbl fq-equip-head' },
      h('span', { class: 'fq-cg-ic' }, groupIcon('equip')), 'Equipped',
      h('span', { class: 'fq-equip-ct' }, count));
    const stepBtn = function (glyph, delta, title) {
      return h('button', {
        class: 'fq-eqstep', type: 'button', title: title,
        onClick: (e) => {
          e.stopPropagation();
          const v = Math.round(Math.min(2, Math.max(0.75, eqScale() + delta)) * 100) / 100;
          setEqScale(v);
          renderQuickCard(); refreshOpenMenu();
        },
      }, glyph);
    };
    head.append(h('span', { class: 'fq-eqsize' },
      stepBtn('−', -0.25, 'Smaller equipment tiles'),
      h('b', { class: 'fq-eqsize-v', title: 'Equipment tile size — saved' },
        Math.round(scaleNow * 100) + '%'),
      stepBtn('＋', 0.25, 'Larger equipment tiles')));
    box.append(head);
    /* Ensure we have the hidden-slot state to light the tile Hide toggles. */
    if (data && data.ok) {
      const fid = gearSubjectId();
      const haveSt = gearState && gearState.formId && parseInt(gearState.formId, 16) === fid;
      if (fid && !haveSt && !gearBusy) toGame('fdGear', JSON.stringify({ op: 'state', formId: fid }));
    }

    if (!data) {
      const grid = h('div', { class: 'fq-equip-grid' });
      for (let i = 0; i < 4; i++) grid.append(h('div', { class: 'fq-equip-tile skel' }));
      box.append(grid);
      return box;
    }
    if (!data.ok) {
      box.append(h('div', { class: 'fq-equip-msg' }, data.msg || 'Could not read what they are wearing.'));
      return box;
    }
    const items = data.items || [];
    if (!items.length) {
      box.append(h('div', { class: 'fq-equip-msg' },
        data.dead ? 'Nothing equipped — they are dead.' : 'Nothing equipped.'));
      return box;
    }
    /* The grid is on screen now, so the meshes are worth rendering — request
       them LAZILY (deferred off the open frame, paced by the shared queue).
       This is the only worn-mesh consumer; equippedBlock's list uses glyphs. */
    requestWornRenders(items);
    const grid = h('div', { class: 'fq-equip-grid' });
    grid.style.setProperty('--fq-eqs', String(eqScale()));
    items.forEach(function (it) {
      const url = wornIconFor(it);
      const wk = wornKey(it);
      /* data-wkey lets the in-place upgrade pass (upgradeEquippedIconsInPlace)
         find THIS tile when its mesh render lands, and swap only its glyph for
         the picture — instead of rebuilding the whole card, which in these
         compositor-off Ultralight views re-decodes every already-drawn tile and
         makes the equipped grid flash (2026-08-14). The item itself is captured
         in the tile's click closure below, so the upgrade pass only needs to
         patch the glyph→image and toggle .haslb. */
      const tile = h('div', {
        class: 'fq-equip-tile' + (url ? ' haslb' : '') + (it.outfit ? ' outfit' : ''),
        title: it.name + (it.plugin ? '\n' + it.plugin : '')
             + (url ? '\nClick to see it large — then drag to turn it' : ''),
        'data-wkey': wk,
        'data-icon-url': url,
      });
      tile._wornItem = it;
      tile.addEventListener('mouseenter', function () { positionEquippedFly(tile); });
      tile.addEventListener('focusin', function () { positionEquippedFly(tile); });
      /* Clicking a tile opens the worn-mesh lightbox — but ONLY once it has art.
         Reading the CURRENT url through wornIconFor at click time (not the stale
         `url` closed over at build) means a tile upgraded in place afterwards is
         immediately clickable without a rebuild. */
      tile.addEventListener('click', function () {
        const u = wornIconFor(it);
        if (u) openWornLightbox(u, it.name, it);
      });
      if (url) {
        const img = h('span', { class: 'fq-equip-img' });
        img.style.backgroundImage = 'url("' + url + '")';
        img.addEventListener('error', function () {});   // background-image: no error event, harmless
        tile.append(img);
      } else {
        const ei = eqIcon(it);
        tile.append(h('span', { class: 'fq-equip-glyph', title: ei.lbl }, ei.ic));
      }
      if (it.count > 1) tile.append(h('span', { class: 'fq-equip-ct2' }, '×' + it.count));
      if (it.outfit) tile.append(h('span', { class: 'fq-equip-tag' }, 'outfit'));
      /* The stat pill (Rober, 2026-08-18): armour in steel, damage in blood —
         the gear-tiles-v2 idiom, inside the tile's corner (the tile clips). */
      if (typeof it.armor === 'number' && it.armor > 0) {
        tile.append(h('b', { class: 'fq-eqpill arm', title: 'Armour rating ' + it.armor }, String(it.armor)));
      } else if (typeof it.dmg === 'number' && it.dmg > 0) {
        tile.append(h('b', { class: 'fq-eqpill dmg', title: 'Damage ' + it.dmg }, String(it.dmg)));
      }
      /* A hover FLYOUT on the tile itself (Rober, 2026-08-05): Hide (cull the
         3D, keeps it equipped) + Delete. No separate button. */
      const fly = h('div', { class: 'fq-equip-fly' });
      /* Regenerate image — an icon in the same row as Hide/Strip/Remove, not a
         full-width text button (Rober, 2026-09-26: it took way too much room). */
      if (wk) fly.append(h('button', {
        class: 'fq-equip-act regen fq-equip-regenerate', type: 'button',
        title: 'Regenerate image — make a new picture of ' + it.name,
        'aria-label': 'Regenerate image of ' + it.name,
        onClick: function (e) { e.stopPropagation(); regenerateEquippedImage(it, tile); },
      }, '⟳'));
      const grp = gearGroupFor(it);
      if (grp) {
        const hidNow = !!(gearState && gearState.hidden && gearState.hidden[grp]
          && gearState.formId && parseInt(gearState.formId, 16) === gearSubjectId());
        fly.append(h('button', {
          class: 'fq-equip-act hide' + (hidNow ? ' on' : ''), type: 'button',
          title: (hidNow ? 'Show ' : 'Hide ') + it.name + ' — culls the 3D, keeps it '
               + 'equipped (Gear Toggle). Acts on its ' + grp + ' slot.',
          onClick: (e) => {
            e.stopPropagation();
            const fid = gearSubjectId(); if (!fid || gearBusy) return;
            gearBusy = true;
            fqStatus = { msg: (hidNow ? 'Showing ' : 'Hiding ') + it.name + '…', ok: true, pending: true };
            toGame('fdGear', JSON.stringify({ op: 'toggle', formId: fid, group: grp }));
            renderQuickCard();
          },
        }, hidNow ? '🚫' : '⛑'));
      }
      /* Strip / take off — UNEQUIP it (any slot). Frees the slot so it stops
         showing, keeps it in her bag (reversible), and — unlike Remove — cannot
         freeze on a broken-inventory follower, because unequip is slot-targeted,
         not a whole-bag walk (Rober, 2026-08-08: the safe way off a stuck cloak/
         hat). */
      fly.append(h('button', {
        class: 'fq-equip-act strip', type: 'button',
        title: 'Take ' + it.name + ' off — unequips it (any slot); it stops showing '
             + 'and stays in her bag. Safe: no freeze, and you can re-equip it.',
        onClick: (e) => {
          e.stopPropagation();
          fqStatus = { msg: 'Taking ' + it.name + ' off…', ok: true, pending: true };
          sendNpc('unequipItem', m, { item: it.formId, itemPlugin: it.plugin || '' });
          renderQuickCard();
        },
      }, '✂'));
      /* Remove it — armed two-click; the C++ removeItem SEH-guards RemoveItem. */
      fly.append(h('button', {
        class: 'fq-equip-act del', type: 'button',
        title: 'Remove ' + it.name + ' — destroys it',
        onClick: (e) => {
          e.stopPropagation();
          arm(e.currentTarget, '✕?', 'Click again to destroy ' + it.name, () => {
            sendNpc('removeItem', m, { item: it.formId, itemPlugin: it.plugin || '', count: it.count || 1 });
          });
        },
      }, '🗑'));
      tile.append(fly);
      syncEquippedTile(tile, it);
      grid.append(tile);
    });
    box.append(grid, h('div', { class: 'fq-equip-render-status', role: 'status', 'aria-live': 'polite' }));
    paintEquippedRenderStatus(box);
    return box;
  }

  function equippedBlock(m, expanded) {
    const isOpen = expanded || ui.eqOpen;
    const box = h('div', { class: 'fd-eq' + (isOpen ? ' open' : '') });
    const data = equippedFor(m);

    /* COLLAPSIBLE, and collapsed by default — a measured decision, not a
       default. Expanded, this block is ~199px, and it turned a member menu
       that fitted on screen (≈768px of 776px available) into a 1040px
       scroller, which pushed the readout itself below the fold: the opposite
       of enforcing that you can see it.

       The COUNT is what stays visible unconditionally. "Equipped 7" is the
       load-bearing fact — it tells you at a glance whether the container menu
       is showing you everything — and one click gives you the full list with
       nothing filtered. */
    const count = data && data.ok ? String((data.items || []).length) : '…';
    const head = h(expanded ? 'div' : 'button', {
      class: 'fd-eq-head', type: expanded ? null : 'button',
      'aria-expanded': expanded ? null : String(!!isOpen),
      title: 'Everything they have on, read off the engine — including pieces the '
           + 'container menu may hide because they belong to an outfit.',
      onClick: (e) => {
        e.stopPropagation();
        if (expanded) return;
        ui.eqOpen = !ui.eqOpen;
        /* BOTH hosts, because this block is rendered into two of them and the
           click has no idea which one it is in. refreshOpenMenu() redraws the
           member menu and returns early when none is open — which is always
           true for the Hotkeys-tab card, so on its own it made the header a
           dead control there. renderQuickCard() is the mirror-image no-op when
           the card is not mounted. */
        refreshOpenMenu();
        renderQuickCard();
      },
    },
      h('span', { class: 'fd-eq-caret' }, expanded ? '' : ui.eqOpen ? '▾' : '▸'),
      h('span', { class: 'fd-eq-title' }, 'Equipped'),
      h('span', { class: 'fd-eq-count' }, count));
    box.append(head);

    if (!isOpen) return box;

    if (!data) {
      /* Skeleton sized like the real rows, so the menu does not jump when the
         answer lands (and does not re-clamp itself off-screen). */
      const sk = h('div', { class: 'fd-eq-list' });
      for (let i = 0; i < 3; i++) sk.append(h('div', { class: 'fd-eq-row skel' }, h('span', { class: 'fd-eq-sk' })));
      box.append(sk);
      return box;
    }
    if (!data.ok) {
      box.append(h('div', { class: 'fd-eq-empty' }, data.msg || 'Could not read what they are wearing.'));
      return box;
    }
    const items = data.items || [];
    if (!items.length) {
      box.append(h('div', { class: 'fd-eq-empty' },
        data.dead ? 'Nothing equipped — they are dead.' : 'Nothing equipped.'));
      return box;
    }

    const list = h('div', { class: 'fd-eq-list' });
    items.forEach(function (it) {
      const kind = String(it.kind || 'other');
      const row = h('div', { class: 'fd-eq-row' + (it.outfit ? ' outfit' : '') },
        (function () { const ei = eqIcon(it); return h('span', { class: 'fd-eq-ic', title: ei.lbl }, ei.ic); })(),
        h('span', { class: 'fd-eq-nm', title: it.name + (it.plugin ? '\n' + it.plugin : '') }, it.name));
      if (it.count > 1) row.append(h('span', { class: 'fd-eq-ct' }, '×' + it.count));
      if (it.outfit) {
        row.append(h('span', {
          class: 'fd-eq-tag',
          title: 'Part of their default outfit' +
                 (data.outfit ? ' (' + data.outfit + ')' : '') +
                 ' — the container menu may not let you take it.',
        }, 'outfit'));
      }
      /* Destroy it. The case this exists for is the "<Missing Name>" leftovers
         an uninstalled mod strands on a long-lived follower — the container
         menu will not even show you a name to click. Armed, because the same
         button is one row away from her actual armour. */
      /* Destroy it. The case this exists for is the "<Missing Name>" leftovers
         an uninstalled mod strands on a long-lived follower — the container
         menu will not even show you a name to click. The C++ removeItem handler
         SEH-guards the native RemoveItem (SafeRemoveItem), so a broken base form
         is skipped cleanly instead of freezing the game — safe for every row.
         Armed, because the same button is one row away from her actual armour. */
      row.append(h('button', {
        class: 'fd-eq-x', type: 'button',
        title: 'Remove ' + it.name + ' from ' + (data.who || 'them') + ' — destroys it',
        onClick: (e) => {
          e.stopPropagation();
          arm(e.currentTarget, '✕?', 'Click again to destroy ' + it.name, () => {
            sendNpc('removeItem', m, {
              item: it.formId, itemPlugin: it.plugin || '', count: it.count || 1,
            });
          });
        },
      }, '✕'));
      list.append(row);
    });
    box.append(list);
    return box;
  }

  /* Armed two-click, because PrismaUI views have no window.confirm — the deck
     learned that the hard way (it is dead in-game and fine in the harness, so
     it fails only where it matters). One click arms and re-labels, a second
     within 4s fires, anything else disarms. Same shape the Domains pane uses
     for Forget. */
  let armedBtn = null, armedTimer = 0;
  function disarm() {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = 0; }
    if (armedBtn && armedBtn.isConnected) {
      armedBtn.classList.remove('armed');
      armedBtn.textContent = armedBtn.dataset.idle || armedBtn.textContent;
      armedBtn.title = armedBtn.dataset.idleTitle || armedBtn.title;
    }
    armedBtn = null;
  }
  function arm(btn, label, title, fire) {
    if (armedBtn === btn) { disarm(); fire(); return; }
    disarm();
    armedBtn = btn;
    btn.dataset.idle = btn.textContent;
    btn.dataset.idleTitle = btn.title || '';
    btn.classList.add('armed');
    btn.textContent = label;
    btn.title = title;
    armedTimer = setTimeout(disarm, 4000);
  }

  function dayBtn(label, title, on, opts) {
    const b = h('button', {
      class: 'fd-day-act' + ((opts && opts.danger) ? ' danger' : '') +
             ((opts && opts.primary) ? ' primary' : ''),
      type: 'button',
      title: title,
      disabled: (opts && opts.disabled) ? true : null,
      onClick: function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (opts && opts.disabled) return;
        on(e);
      },
    }, label);
    return b;
  }

  /* The action cluster for one stop of the day. `a` is a real act (from C++)
     or a placeholder we synthesised for a stop she has no marker for yet. */
  function dayActions(m, a) {
    const wrap = h('span', { class: 'fd-day-acts' });
    if (!canSetKind(a.k)) {
      // Watch, or a kind we have no verb for. Say why rather than showing a
      // button that would be refused three layers down.
      if (a.k === 7) {
        wrap.append(h('span', { class: 'fd-day-shared', title:
          'Watch has no place of its own — it stands at the guard post. Set Guard to move it.' }, 'shares Guard'));
      }
      return wrap;
    }

    const isHome = a.k === KIND_HOME;
    const has = !!a.place;

    wrap.append(dayBtn(has ? '⌖ Move here' : '⌖ Set here',
      (has ? 'Move ' : 'Mark ') + (isHome ? 'her home' : 'her ' + a.spec.label.toLowerCase() + ' spot') +
        ' to where you are standing right now.' +
        (has ? '\nThe old spot is deleted by the mod itself.' : ''),
      /* No kind rides with setHome. MarkHome/MoveHome take an Actor and
         nothing else, and a stray "kind":0 on the wire would read as if the
         home were the zeroth STOP — which is exactly the confusion this
         whole file exists to avoid. */
      function () { disarm(); if (isHome) sendMhiyh('setHome', m); else sendMhiyh('setSpot', m, a.k); },
      { primary: !has }));

    if (has) {
      if (isHome) {
        // ForgetHome wipes EVERY stop and unregisters her from the mod. That
        // is not a "clear one field" button, so it is armed and it says so.
        wrap.append(dayBtn('✕', 'Forget her home — this also clears every other stop and takes her out of ' +
          'My Home is Your Home entirely.\nClick twice.',
          function (e) {
            arm(e.currentTarget, 'Forget all?', 'Click again to wipe her whole day.',
              function () { sendMhiyh('forgetHome', m); });
          }, { danger: true }));
      } else {
        wrap.append(dayBtn('✕', 'Clear this stop — she keeps her home and everything else.',
          function () { disarm(); sendMhiyh('clearSpot', m, a.k); }, { danger: true }));
      }
    }
    return wrap;
  }

  /* The day, as an ordered stepper in the member menu. Read top-to-bottom as
     a day; the stop in force is the one the eye lands on.

     Returns null when there is nothing at all to say AND nothing that could
     be said — a follower NG has never heard of who is not even following you
     gets no empty section, because with ~70 followers and a handful settled an
     empty "HER DAY" block on every other menu is pure noise. Someone who IS
     following you gets the one row that matters: give her a home. */
  function dayBlock(m) {
    if (!state.nff.mhiyh) return null;           // the mod isn't even installed
    const acts = m.acts || [];
    /* MHiYH's home, not the DISPLAYED home — an NFF base is not a MHiYH home,
       and every write below is gated on the mod's own rule that the other six
       stops hang off it. */
    const hasHome = !!m.mhHome;
    /* Nothing to show AND nothing that could be done — someone whose actor is
       not in the world cannot be handed to MHiYH at all, so they get no
       section rather than a dead button. Anyone who IS in the world gets the
       offer, disabled with its reason when the mod's own gate is shut: the
       rule ("she has to be following you") is worth learning once, and this
       is a popout you opened for one person, not a line on a 70-row roster. */
    /* `liveFormId` counts as being in the world, and it is the whole point of
       it: FO says inWorld:false for a row holding a BASE record, which is what
       it falls back to for a follower spawned at runtime — but C++ went and
       found her actual reference, and MHiYH can be handed that. Gating on FO's
       answer alone denied the day panel to somebody standing right there. */
    if (!acts.length && !hasHome && !m.inWorld && !m.liveFormId) return null;

    const rows = [h('div', { class: 'fd-ctx-sep' }),
                  h('div', { class: 'fd-ctx-field' }, h('label', { title: 'My Home is Your Home NG' }, 'Her day'))];

    /* ---- nothing yet: the one action that unlocks all the others ---- */
    if (!hasHome) {
      rows.push(h('div', { class: 'fd-day-empty' },
        h('b', null, acts.length ? 'No home in My Home is Your Home' : 'No home set'),
        'Stand where she should live and mark it — every other stop in her day hangs off the home.'));
      rows.push(h('div', { class: 'fd-day-setup' },
        dayBtn('★ Make this her home',
          m.following
            ? 'Marks the spot you are standing on as her home, and registers her with My Home is Your Home.'
            : 'Marks the spot you are standing on as her home.\nShe is not following you, and MHiYH '
              + 'only takes a home from someone who is — so the deck will ask her to follow for a '
              + 'moment, set it, and dismiss her again.',
          function () { disarm(); sendMhiyh('setHome', m); },
          { primary: true })));
      /* No longer disabled. MHiYH's follower gate is real, but it is now
         SATISFIED rather than reported: C++ borrows her through NFF, marks the
         home, and puts her back (src/mhiyh_control.cpp). Saying what will
         happen beats a dead button and a rule to go obey by hand. */
      if (!m.following) {
        rows.push(h('div', { class: 'fd-day-empty' },
          'Not following you — she will be asked to, just long enough for MHiYH to take the home, '
          + 'then dismissed again.'));
      }
      return rows;
    }

    /* ---- she has a home: show the WHOLE day, including the stops she has
       no marker for, so an empty one can be filled in place. C++ only sends
       stops that exist (or are in force), which is right for the read path
       and useless for the write one — so the placeholders are synthesised
       HERE, never folded into m.acts, and search / the row chip keep seeing
       exactly what the mod actually holds. ---- */
    const have = {};
    acts.forEach(function (a) { have[a.k] = true; });
    const all = acts.slice();
    SETTABLE_KINDS.forEach(function (k) {
      if (have[k]) return;
      all.push({ k: k, spec: actSpec(k), place: '', now: false, unset: true });
    });
    all.sort(function (x, y) { return x.spec.order - y.spec.order; });

    /* NG routinely has SEVERAL kinds in force at once — Home sits under almost
       everything. Lighting them all up equally gives the eye no focal point and
       reads as "she is working AND at home?", so only the headline gets the
       full treatment; the others get a lit dot and normal-weight text to say
       "also true" without competing. */
    const day = h('div', { class: 'fd-day' });
    all.forEach(function (a) {
      const headline = a === m.nowAct;
      const alsoOn = a.now && !headline;
      day.append(h('div', {
        class: 'fd-day-row' + (headline ? ' is-now' : (alsoOn ? ' is-on' : '')) +
               (a.unset ? ' is-unset' : ''),
        title: a.spec.label + (a.place ? ' — ' + a.place : ' — no place set') +
               (headline ? '\nHappening now.' : (alsoOn ? '\nAlso in force right now.' : '')),
      },
        h('span', { class: 'fd-day-dot', 'aria-hidden': 'true' },
          h('img', { class: 'fd-day-icon', src: 'icons/custom/' + (DAY_ICONS[a.k] || 'hm-time') + '.png', alt: '', width: '28', height: '28' }),
          h('span', { class: 'fd-day-glyph' }, a.spec.ic)),
        h('span', { class: 'fd-day-txt' },
          h('span', { class: 'fd-day-label' }, a.spec.label),
          h('span', { class: 'fd-day-place' + (a.place ? '' : ' none') },
            a.place || 'no place set')),
        headline ? h('span', { class: 'fd-day-now' }, 'now') : null,
        dayActions(m, a),
      ));
    });
    rows.push(day);

    rows.push(h('div', { class: 'fd-day-hint' },
      'Each spot is marked where YOU are standing — walk there first, then set it.'));

    /* Configured but nothing in force is a real, legible state — NG simply
       has no window covering this hour. Say that instead of leaving the
       stepper looking like it failed to highlight anything. */
    if (!m.nowAct) {
      rows.push(h('div', { class: 'fd-day-empty' },
        'Nothing scheduled for this hour — she is between stops.'));
    }
    return rows;
  }

  function slugOf(name) {
    let s = String(name == null ? '' : name);
    // Ultralight's JS engine does have normalize(), but a missing normalize
    // must degrade to "no accent folding", never to a thrown render.
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep s */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* One canonical spelling for a form id, so "0x0001A6A1", "1A6A1" and
     "0x1a6a1" compare equal. Different senders write it differently (FO's own
     JSON, wardrobe.cpp's HexOf, a hand-edited config) and a string compare on
     the raw value silently misses. '' means "no usable id" — never match on it. */
  function canonFormId(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(s)) return '';
    const t = s.replace(/^0+/, '');
    return t || '0';
  }

  /* The crosshair target's formId is a NUMBER (fdTarget stores `t.formId >>> 0`),
     but every face path — the roster's own formIds, the fdFaceIcons request, the
     fdFaceIconsData cache key, and portraitFor's lookup — speaks a `0x…` HEX
     string. C++ even parses the request ids base-16 (std::strtoul(...,16)) and
     echoes them verbatim as the reply's icon keys, so a decimal string would
     both mis-resolve the NPC and never match the medallion's lookup. This is the
     one canonical hex form for a numeric/hex target id, used by BOTH the request
     and the pseudo so they always agree. Returns '' for a missing/0 id. */
  /* Why the DLL could not bake a head for this member, or '' (fdFaceIconsData.why). */
  function faceWhyFor(m) {
    if (!m) return '';
    const k = fidHexOf(m.formId) || fidHexOf(m.liveFormId);
    return (k && state.faceWhy[k]) || '';
  }

  function fidHexOf(v) {
    if (v == null || v === '') return '';
    /* A NUMBER (the common case: state.target.formId) must be rendered in base
       16 — canonFormId would read its DECIMAL digits as hex. A hex STRING
       ('0x…' or bare hex) is normalised through canonFormId. */
    if (typeof v === 'number') {
      const n = v >>> 0;
      return n ? '0x' + n.toString(16) : '';
    }
    const c = canonFormId(v);
    return (c && c !== '0') ? '0x' + c : '';
  }

  function sameFid(a, b) {
    const x = canonFormId(a), y = canonFormId(b);
    return !!x && x === y;
  }

  /* ============ who the card's actor is, as THE GAME can address her ======= *
   *  Not always the id Follower Organizer stored. FO persists an EditorID or
   *  "localId~Plugin.esp", and a DYNAMICALLY SPAWNED follower has NEITHER: for
   *  a 0xFF runtime reference FO's FormToString() returns "", so Member's
   *  serializer falls back to her BASE NPC_ record.
   *
   *  Proven 2026-09-20 with Kali — filed as "00_DemonKali", which is the NPC_
   *  in Demon Kali.esp, not the ACHR; the roster row therefore resolves to a
   *  base form, FO answers `inWorld:false` for someone standing in front of
   *  you, and both card groups gated on that (Move, Home) silently vanished.
   *  Rober: "weirdly no home tab options for this f7 on an npc?".
   *
   *  The crosshair snapshot always carries a REAL reference (C++ FolTargetJson
   *  sends NpcActions::TargetFormID()), so while the card is LOOKING at
   *  someone, that id is the truth and the roster's is decoration. A card
   *  opened on a PICKED roster face has no crosshair behind it and keeps the
   *  stored id — there is nothing better to use.
   * ======================================================================== */
  function liveTargetFid(t) {
    return (t && !t.picked) ? fidHexOf(t.formId) : '';
  }

  /* The member object every ACTOR-KEYED op on the card should address. A CLONE
     when the live id differs, never a mutation of the roster row: that object
     is shared state the pushes own, and `formId` is the key mergeHome and the
     portrait store look her up by. `storedFormId` is kept so a caller can still
     tell what FO holds (the Move ops address THAT, not this). */
  function actorSubjectOf(known, t, who) {
    const live = liveTargetFid(t);
    if (known) {
      if (!live || sameFid(live, known.m.formId)) return known.m;
      const c = Object.assign({}, known.m);
      c.formId = live;
      c.storedFormId = known.m.formId;
      return c;
    }
    if (!live) return null;
    return { name: who, original: who, formId: live };
  }

  function portraitFor(m) {
    /* The portrait STORE wins over a live-party row's own file. fdLiveParty's
       file/mtime were resolved by C++ once, at push time — but a re-capture or
       an Adjust lands a NEW filename mid-session (Ultralight locks every image
       it has drawn, so newest-file-wins under a `~<n>` suffix) and fdPortraits
       refreshes the store immediately. Honouring the frozen row first left the
       party strip showing the pre-adjust face while the card, resolving through
       the store, showed the new one. The row's file is still the fallback it
       was added to be: a follower whose portrait is filed under a base/original
       name the view's slug can't reach (C++ matched her via the FO original)
       draws her real face instead of initials. */
    const slug = slugOf(m.original || m.name);
    const p = slug ? state.portraits[slug] : null;
    if (p) return { slug: slug, file: p.file, ext: p.ext, mtime: p.mtime };
    if (m && m.file) return { slug: slug || (m.name || ''), file: m.file, ext: m.ext, mtime: m.mtime };
    /* No captured photo anywhere: fall back to the facegen head render, keyed
       by formId (the one identity every roster row carries). `abs` routes the
       URL through portraitSrc; mtime 0 keeps the cache-bust query off a path
       Ultralight has never seen change. A later real capture outranks this on
       the next repaint because the store checks run first. */
    const fk = fidHexOf(m && m.formId);
    const fi = fk ? state.faceIcons[fk] : null;
    if (fi) return { slug: slug || (m.name || ''), file: fi, ext: 'png', mtime: 0, abs: true };
    return null;
  }

  /* The original medallion, unchanged — now also the fallback for a portrait
     that fails to load. */
  function initialsMedal(m, hue) {
    const el = h('span', { class: 'medal' + (m.following ? ' following' : '') + (m.dead ? ' dead' : '') }, initialsOf(m.name));
    el.style.setProperty('--medal-hue', hue);
    return el;
  }

  /* The portrait medallion is a WRAPPER around the <img>, not the <img> itself.
     That is forced by the crop: a transform on the image element scales its own
     rounded clip too, so a zoomed face would grow a bigger circle and shoulder
     the row apart instead of filling the same hole. The wrapper owns the
     circle, the hue, the state classes and the click dataset; the inner image
     owns the cover fit and the crop transform, and is clipped by the wrapper's
     overflow:hidden. Shape is the same with and without a crop on purpose —
     one medallion to reason about, not two. */
  function medalEl(m, catIndex, cropScope) {
    const hue = String(hueOf(catIndex));
    const p = portraitFor(m);
    if (!p) {
      /* No portrait YET is not the same as no portrait: while this head's
         render is queued in-game (facePending), the initials medallion wears
         a spinning ring so the blank state reads as "loading her face", not
         "she has no face" (Rober, 2026-08-19). The ring is a border-arc
         animation on purpose — conic-gradient computes to none in Ultralight
         (the LAWS), a border spinner does not. */
      const el = initialsMedal(m, hue);
      if (facePendingFor(m)) {
        el.classList.add('wait');
        el.appendChild(h('span', { class: 'medal-spin' }));
      }
      return el;
    }
    /* ?v=<mtime> is the cache-bust that makes "replace a portrait mid-session"
       show (Ultralight caches view-relative images by URL). But Ultralight's
       view loader can also treat the query as part of the FILENAME — proven
       in-game 2026-07-28: the C++ scan found a follower's .jpg and pushed it,
       yet the img errored to initials. So: try the query form first, retry the
       plain path once on error, and only then fall back to the medallion. */
    const plain = portraitSrc(p);
    const face = h('img', {
      class: 'medal-face',
      src: plain + (p.abs ? '' : '?v=' + p.mtime),
      alt: '',
      draggable: 'false',
    });
    const wrap = h('span', {
      class: 'medal img' + (m.following ? ' following' : '') + (m.dead ? ' dead' : ''),
    }, face);
    /* Fit the head render AFTER the face is inside its frame — hd-facefit.js's
       layout crop positions the image ABSOLUTELY and must be able to force the
       frame (.medal.img, static + overflow:hidden in CSS) to contain it. Fit a
       detached img and the absolute layout would escape to the pane and paint
       huge over the roster (the 2026-08-14 "giant face" bug). A captured photo
       keeps the transform crop path — it never goes absolute. */
    if (p.abs && cropScope === 'f7') face._hdHeadCrop = function () { return f7CropFor(p.file); };
    if (p.abs) faceFitEnsure(face, p.file);
    else applyCropTo(face, p.file);
    if(cropScope==='f7'){paintF7Crop(face,p.file,p.abs);wrap.dataset.cropScope='f7';}
    wrap.style.setProperty('--medal-hue', hue);
    /* Click the face to see it properly. A 40 px circle is unreadable — Rober's
       first words on the captured portrait were "too small to see, can't click
       to do a lightbox". Marked so the row's own click handler can ignore it,
       and carried on the WRAPPER because the inner image is pointer-transparent
       (the row is draggable and the photo must not compete for the gesture). */
    wrap.dataset.act = 'portrait';
    wrap.dataset.slug = p.slug;
    wrap.dataset.file = p.file;
    wrap.dataset.ext = p.ext;
    wrap.dataset.mtime = String(p.mtime || 0);
    wrap.dataset.name = m.name || '';
    /* Her formId rides too (Rober, 2026-09-21: "f7 on an npc the popout if i
       click their profile pic should give me an option to retake image"): the
       lightbox only offers ◉ Retake photo when it knows whom to photograph,
       and openLightbox(medal.dataset) is how the roster rows and the F7 card
       open it. Set only when known — an empty string means no button. */
    const fidForRetake = fidHexOf(m.formId);
    if (fidForRetake) wrap.dataset.formId = fidForRetake;
    /* The abs flag MUST ride the dataset: openLightbox(medal.dataset) is how
       both the roster rows and the F7 card open this. Without it a facegen
       head render (abs path under icons/npcs/) was rebuilt as
       "portraits/icons/npcs/…" — a path that exists nowhere — so the lightbox
       opened, errored, retried the same wrong path, and self-closed (Rober's
       2026-08-19 "opens for a second then closes"). Set only when true: a
       dataset value is a STRING, and "false" would read truthy. */
    if (p.abs) wrap.dataset.abs = '1';
    wrap.title = m.name ? (m.name + ' — click to enlarge') : 'Click to enlarge';
    wrap.style.cursor = 'zoom-in';
    let retried = false;
    face.addEventListener('error', function () {
      if (!retried) {
        retried = true;
        face.src = plain;   // query-hostile loader: the raw path is the one that works
        return;
      }
      /* Really unloadable (deleted since the scan, or an undecodable file):
         swap the initials medallion in, and say so in HotkeyDeck.log so the
         next "didn't show" report isn't silent. */
      toGame('fdLog', 'portrait failed to load: ' + plain);
      if (wrap.parentNode) wrap.parentNode.replaceChild(initialsMedal(m, hue), wrap);
    });
    return wrap;
  }

  function visibleRows() {
    const q = ui.filter.trim().toLowerCase();
    const rows = [];
    state.cats.forEach((c) => {
      if (ui.cat !== ALL && c.index !== ui.cat) return;
      const cl = catLabel(c).toLowerCase();
      c.members.forEach((m, idx) => {
        if (q) {
          // fieldsText is the joined field VALUES, lowercased once at normalize
          // time — searching "housecarl" or "Riverwood" finds people by what you
          // wrote about them, not just by name.
          // homeText is the NFF / MHiYH home name(s) PLUS every activity place
          // — typing a place finds the people the GAME has sleeping, working or
          // eating there, alongside fieldsText's typed values.
          // relText is the ENGINE's rank word plus MARAS's marriage — "lover",
          // "spouse", "married" find people by what the GAME thinks they are,
          // which is a different question from the Relationship you typed.
          const hay = (m.name + '\n' + (m.original || '') + '\n' + (m.desc || '') +
                       '\n' + (m.fieldsText || '') + '\n' + (m.homeText || '') +
                       '\n' + (m.relText || '')).toLowerCase();
          if (!hay.includes(q) && !cl.includes(q)) return;
        }
        rows.push({ cat: c.index, idx, m, catName: catLabel(c) });
      });
    });
    return rows;
  }

  /* =========================================================== render ==== */

  /* ===================== F7 NPC-FOCUS MODE ============================
     Press F7 while looking at someone and the deck DEDICATES the pane to that
     NPC (Rober, 2026-08-05): the global tab bar and the category rail hide, the
     crosshair card drops its 46% cap and takes the whole pane, and the roster
     plus a Hotkeys jump collapse into a chevron bar at the bottom. State is two
     body classes read by the hd-npcfocus rules in app.css, plus the bar this
     fills. The ▴ on the card and the Hotkeys chevron are the ways out; a fresh
     F7 open re-enters (see maybeAutoFocus, driven from app.js setTab). */
  function renderFocusBar() {
    const bar = $('fd-focusbar');
    if (!bar) return;
    bar.textContent = '';
    if (!ui.npcFocus) return;
    const total = state.total || visibleRows().length || 0;
    /* Rober, 2026-08-06: this must NOT unfold a mini-roster under the card —
       it goes BACK to the full Followers view (rail + All Followers roster).
       rosterOpen is set BEFORE exitFocus so the dedicate-to-NPC default
       (roster hidden, card fills) does not immediately swallow the roster
       again while the crosshair target is still live. */
    bar.append(h('button', {
      class: 'fd-fbar-btn', type: 'button',
      title: 'Back to your full follower view',
      onClick: (e) => { e.stopPropagation();
        ui.cat = ALL;
        ui.rosterOpen = true;
        exitFocus();
        setTimeout(() => { const s = $('fd-search'); if (s) s.focus(); }, 30);
      },
    },
      h('span', { class: 'fd-fbar-chev' }, '▸'),
      h('span', null, 'Followers'),
      h('span', { class: 'fd-fbar-ct' }, String(total))));
    bar.append(h('span', { class: 'fd-fbar-spring' }));
    bar.append(h('button', {
      class: 'fd-fbar-btn', type: 'button',
      title: 'Leave the NPC view and jump to your hotkeys',
      onClick: (e) => { e.stopPropagation();
        exitFocus();
        if (typeof window.__omniSetTab === 'function') window.__omniSetTab('all');
      },
    },
      h('span', null, 'Hotkeys'),
      h('span', { class: 'fd-fbar-arr' }, '↗')));
  }

  function applyFocusChrome() {
    const on = !!ui.npcFocus;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('hd-npcfocus', on);
      document.body.classList.toggle('hd-focusroster', on && !!ui.focusRosterOpen);
      /* DEDICATE-TO-NPC retired on the normal tab (Rober, 2026-08-06): the main
         Followers tab keeps its roster + party bar; the crosshair dossier is
         F7-only (see syncQuickHere). So hd-npcded — which hid the roster to let
         the card fill — is never applied now. Kept as an explicit clear so any
         stale class from a prior build is stripped. */
      document.body.classList.remove('hd-npcded');
      /* Rail collapse — the « / » strip. Persisted; never in fullscreen focus. */
      document.body.classList.toggle('hd-railcol', !on && !!state.railCollapsed);
    }
    renderFocusBar();
  }

  /* Enter focus — needs someone to focus ON: the crosshair NPC, or a person
     you PICKED (a row's F7 Controls, a Current-party face). A pick used to get
     only the capped card above the roster — cut off at HOME, with her own row
     still listed underneath — never this view (Rober, 2026-09-23: "not the
     dedicated f7" / "no reason to show caraleth at bottom... and cut off the
     main f7"). */
  function enterFocus() {
    const picked = !!(ui.fqPick && quickSubject());
    if (!picked && (!state.target || !state.target.name)) return false;
    ui.npcFocus = true;
    ui.focusRosterOpen = false;
    ui.fqFold = false;   // the dedicated view wants the WHOLE dossier, not name-only
    applyFocusChrome();
    /* The card IS the focus view, so it has to be MOUNTED here, not merely
       repainted: renderQuickCard() self-guards on a null quickHost, and both
       exitFocus() and render() leave #fd-quick hidden with quickHost null. So
       entering focus from the roster (app.js's fresh-open maybeAutoFocus, and
       the fdTarget "last-closed tab was Followers" branch) painted the chrome —
       tabs, rail and roster all hidden — over nothing at all. syncQuickHere()
       is the single path that un-hides the host and mounts into it. */
    syncQuickHere();
    /* Off our tab the card lives on the deck's own #fq-card (app.js owns that
       mount) and syncQuickHere leaves it alone — it still needs the repaint,
       since focus swaps its ⤢ fullscreen button for the way back out. */
    if (quickHost !== $('fd-quick')) renderQuickCard();
    return true;
  }

  /* Leave focus — the normal deck (tabs + rail + roster) comes back. Marks the
     open "dismissed" so auto-focus does not immediately snap back in; the next
     fresh F7 open re-arms it. */
  function exitFocus() {
    ui.focusDismissed = true;
    if (!ui.npcFocus) { applyFocusChrome(); return; }
    ui.npcFocus = false;
    ui.focusRosterOpen = false;
    /* A pick lives exactly as long as its dedicated view: leaving it must not
       leave her card behind in the capped slot above the roster. */
    ui.fqPick = ''; ui.fqPickPinned = false;
    applyFocusChrome();
    render();
  }

  /* Called by app.js when the Followers tab is shown. `fresh` is true only when
     the show is the tail of a brand-new F7 open (app.js measures it against
     ui.openedAt), so a MANUAL Followers-tab click never yanks you into focus —
     only opening the deck while looking at someone does. */
  function maybeAutoFocus(fresh) {
    if (fresh) ui.focusDismissed = false;   // a new open re-arms auto-focus
    /* AUTHORITATIVE on every Followers show, not just entry: closing the deck
       while in NPC-focus leaves ui.npcFocus TRUE (hdClosed only strips the body
       class, not the flag). Re-open WITHOUT a crosshair NPC and the stale flag
       re-paints hd-npcfocus over an empty card — the "weird state" Rober hit
       (F7 on an NPC, close, re-open on nothing). So if there is no valid target,
       force focus OFF and repaint normal chrome before deciding to enter. */
    const canFocus = !!(state.target && state.target.name && state.targetKnown)
      || !!(ui.npcFocus && ui.fqPick && quickSubject());
    if (!canFocus) {
      if (ui.npcFocus) {
        ui.npcFocus = false;
        ui.focusRosterOpen = false;
        applyFocusChrome();
        render();
      }
      return;
    }
    if (!fresh || ui.focusDismissed) return;
    enterFocus();
  }

  /* EVERYONE bar, ABOVE the dossier card (Rober, 2026-08-05: "move everyone to
     above the targeted npc stuff"). Its own container in #fd-main, so the card
     host (#fd-quick / #fq-card) stays a single clean card — the party controls
     do not depend on who you are pointing at. Only shows on the Followers tab,
     and only when there IS a crosshair target (the no-target card is already
     all-party). partyBlock() is reused, so one implementation of the row. */
  function renderEveryoneBar() {
    const box = $('fd-everyone');
    if (!box) return;                       // absent on the Hotkeys-tab quick card
    box.textContent = '';
    /* Everyone + Current party are the MAIN tab's party controls now (Rober,
       2026-08-06: "current party and everyone stays") — they no longer depend
       on a crosshair target, since the "looking at" card that used to sit below
       them is F7-only. Show whenever the tab is up and you have followers. */
    const show = isActive() && partyList().length;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    /* ONE master chevron collapses the WHOLE bar — Everyone + Current party
       together (Rober, 2026-08-05: "one chevron to close the entire thing").
       The two sections keep their labels but not their own folds (ebNoFold). */
    const open = !ui.fqEbFold;
    box.append(h('button', {
      class: 'fq-eb-master' + (open ? ' open' : ''), type: 'button',
      'aria-expanded': String(open),
      title: open ? 'Hide the party controls' : 'Show the party controls',
      onClick: (e) => { e.stopPropagation(); ui.fqEbFold = !ui.fqEbFold; renderEveryoneBar(); },
    }, h('span', { class: 'fq-eb-master-chev' }, open ? '▾' : '▸'), 'Party'));
    if (!open) return;                        // collapsed: just the master chevron
    /* Everyone actions and the Current-party portraits share ONE line: Everyone
       on the left, the party faces as a horizontal SCROLL on the right. */
    ebNoFold = true;
    const row = h('div', { class: 'fq-eb-row' });
    const bar = partyBlock();
    bar.classList.add('fq-everyone-top', 'fq-eb-col');
    row.append(bar);
    const strip = partyStrip();
    if (strip) {
      strip.classList.add('fq-everyone-crew', 'fq-eb-col', 'fq-eb-party');
      row.append(strip);
    }
    ebNoFold = false;
    box.append(row);
  }

  /* A full render is the tab's "something structural changed" path — the row
     cache is dropped there, so only the keystroke path (which calls renderList
     directly) reuses nodes. */
  function render() { dropRowCache(); renderHudCard(); renderRail(); renderList(); renderAdd(); syncQuickHere(); syncChrome(); applyFocusChrome(); renderEveryoneBar(); renderParty(); renderHere(); }

  /* The quick-action card, on OUR tab.
   *
   *  Rober's ask (2026-08-02): press F7 while looking at someone and land on
   *  the Followers tab with that person's dismiss / inventory / outfit / wait
   *  buttons right there. Those buttons already existed — but only on the deck
   *  tab, and only while a category with "follower" in its name was selected,
   *  so the tab actually named Followers was the one place they weren't.
   *
   *  There is ONE card. It is mounted into whichever host is currently on
   *  screen (#fq-card on the deck tab, #fd-quick here), never both, because
   *  quickHost is a single variable and two live copies would fight over every
   *  fdTarget / fdEquipped reply. app.js unmounts only when IT owns the card,
   *  so its render pass can no longer yank ours out from under us.
   *
   *  Shown with NO target too, since the idle card stopped being idle: it now
   *  carries the party orders (teleport all / follow / wait / sandbox). It was
   *  hidden while that state was just the sentence "look at an NPC", which
   *  above a 70-row roster was noise. A row of live controls is not. */
  function syncQuickHere() {
    if (ctxEl && ctxEl._dossier) {
      if (ctxEl._dossier.controlsActive()) mountQuick(ctxEl._dossier.controlsHost);
      return;
    }
    const host = $('fd-quick');
    if (!host) return;
    /* The dossier card needs an EXPLICIT subject now (Rober, 2026-08-06): the
       passive "Looking at <NPC>" card is gone from the normal Followers tab —
       that tab keeps Everyone + Current party (#fd-everyone) and the roster.
       The card shows only when you've chosen someone: F7 NPC-focus on the
       crosshair NPC, OR a party-member pick (ui.fqPick, from the crew strip).
       A bare crosshair target alone no longer mounts it. */
    const want = !!(isActive() && !ui.editing
      && ((ui.npcFocus && state.targetKnown) || ui.fqPick));
    host.classList.toggle('hidden', !want);
    if (want) {
      if (quickHost !== host) mountQuick(host);
      else renderQuickCard();
    } else if (quickHost === host) {
      quickHost = null;
      host.textContent = '';
    }
  }

  /* The shared header count. ONE writer: renderList() and syncChrome() each
     used to format this themselves, so the two copies drifted — a search runs
     through renderList only, which is why searching kept the old wording
     after the new one was added to syncChrome.

     "1 follower" while a search narrows 70 people down reads like the roster
     shrank, so say what it is a fraction OF whenever the view is narrowed (by
     a search or by a category) and stay terse when it is showing everything. */
  function syncCount() {
    const chip = $('count-chip');
    if (!chip || !isActive()) return;
    const shown = visibleRows().length;
    const total = state.total || shown;
    const noun = total === 1 ? ' follower' : ' followers';
    chip.textContent = (shown === total) ? String(shown) + noun
                                         : shown + ' of ' + total + noun;
  }

  function syncChrome() {
    // Own the shared header while our tab is up.
    syncCount();
    const eb = $('edit-btn');
    if (eb) {
      eb.classList.toggle('on', ui.editing);
      eb.textContent = ui.editing ? 'Done' : 'Edit';
    }
    $('fd-rail-note').classList.toggle('hidden', !ui.editing);
    $('fd-openkey-row').classList.toggle('hidden', !ui.editing);
    /* mirrored onto <body> so CSS can carve edit-only exceptions into the
       focus-mode chrome — the tab's ONLY size controls (Tab %, Faces px)
       live on #fd-openkey-row, and focus mode display:none'd it even in
       edit, leaving Edit with nothing to scale (Rober, 2026-08-07) */
    document.body.classList.toggle('fd-editing', !!ui.editing);
    const kb = $('fd-openkey-btn');
    if (kb) kb.textContent = state.openKey.label || 'F14';
    syncEditRowWrap();

    const sn = $('fd-status');
    if (state.foMissing) {
      sn.textContent = '';
      sn.append(h('b', null, '⚠ ' + state.foMissing));
      sn.append(h('div', null, 'The deck needs the patched FollowerOrganizer.dll (v0.2.0+, with the Deck API) enabled in MO2.'));
      sn.classList.remove('hidden');
    } else {
      sn.classList.add('hidden');
    }
  }

  /* ================================================ category icons ====== *
   *  Rober asked for a glyph beside each category in the rail — a shield for
   *  Housecarls, a sword for Mercenaries, a crown for Nobles. The icons themselves
   *  are the deck's EXISTING library: the ~1,900 Spell Hotbar PNGs under
   *  icons/sh/ plus whatever the player dropped in icons/custom/, exactly the
   *  same tree the per-hotkey picker and the NFF set picker draw from. Nothing
   *  new is scanned, nothing new is stored on disk, and an icon chosen here
   *  renders in every other picker too.
   * ====================================================================== */

  // How many tiles the picker paints per chunk. Same number as app.js's
  // HK_ICON_PAGE, for the same reason: opening the grid must not decode the
  // whole library at once (Ultralight will happily try, and stall the frame).
  const CATIC_PAGE = 96;

  /* Defence in depth, byte-identical in intent to app.js's hkIconSrc and
     wardrobe-nff.js's iconSrc: the stored value only ever comes from this
     picker (whose choices are C++-supplied) or from a C++-validated config, but
     a hand-edited hotkeys.json must never be able to hand the webview a
     filesystem path or an escape out of the view root. '' = draw nothing. */
  function iconSrc(p) {
    p = String(p == null ? '' : p).replace(/\\/g, '/');
    if (!p) return '';
    if (p.indexOf('..') !== -1) return '';        // no escaping the view dir
    if (p.charAt(0) === '/') return '';           // no server-absolute
    if (/^[A-Za-z]:/.test(p)) return '';          // no drive letters
    if (/^(?:file|https?):/i.test(p)) return '';  // no schemes
    return p;
  }

  /* Shipped DEFAULT category icons, keyed by LOWERCASE category NAME (not the
     FO slot index — a name survives a slot being renumbered, and the same name
     in two profiles should get the same glyph). This curated default map uses
     common-spelling aliases so a renamed category still adopts the expected
     glyph. A
     user's own assignment (state.catIcons[index]) ALWAYS wins; clearing it
     falls back here; renaming a category to a name in this table adopts its
     glyph. Every value below is a file that exists in icons/custom, so a
     default never draws a broken box. Keep names lowercased. */
  const CAT_ICON_DEFAULTS = {
    'follower organizer':    'icons/custom/cat-organizer.png',
    'my followers':          'icons/custom/cat-organizer.png',
    'utilities':             'icons/custom/cat-utilities.png',
    'companions':            'icons/custom/cat-companions.png',
    'friends':               'icons/custom/cat-friends.png',
    'merchant':              'icons/custom/cat-merchant.png',
    'merchants':             'icons/custom/cat-merchant.png',
    'demons':                'icons/custom/cat-demons.png',
    'cult':                  'icons/custom/cat-cult.png',
    'servants':              'icons/custom/cat-servants.png',
    'mercanaries':           'icons/custom/cat-mercenaries.png',
    'mercenaries':           'icons/custom/cat-mercenaries.png',
    'necromancy':            'icons/custom/cat-necromancy.png',
    'conscripts/bannermen':  'icons/custom/cat-bannermen.png',
    'bannermen':             'icons/custom/cat-bannermen.png',
  };

  /* The default glyph for a category slot, by its display name, '' when none.
     Kept separate from catIconOf so anyCatIcon can ask "does this rig have a
     user icon" without the defaults masking that (defaults are ALWAYS present,
     so folding them into anyCatIcon would make every rail claim the icon
     column even on a rig that never touched the feature — but that is exactly
     the behaviour we DO want here, see anyCatIcon). */
  function catIconDefaultFor(index) {
    const c = catByIndex(index);
    if (!c) return '';
    const name = String(catLabel(c) || '').trim().toLowerCase();
    return iconSrc(CAT_ICON_DEFAULTS[name] || '');
  }

  /* The icon set for one category slot, '' when it has none. Reads through
     iconSrc so a poisoned config draws nothing rather than a broken box.
     A user's own assignment (by slot index) wins; with none set, the shipped
     name-keyed default applies — so a fresh install gets a polished rail out
     of the box, and clearing an assignment returns to the default rather than to
     bare initials. An assignment of '' is stored as a DELETE (setCatIcon), so
     there is no "assigned to nothing" state to distinguish from unset. */
  function catIconOf(index) {
    const own = iconSrc(state.catIcons[String(index)] || '');
    if (own) return own;
    return catIconDefaultFor(index);
  }

  /* Does ANY category carry an icon (own OR default)? Drives whether the
     un-iconed rows reserve an empty slot so the names stay on one vertical
     line. Now that defaults ship, a stock rail DOES carry icons, so it should
     reserve the column — checking through catIconOf makes that automatic. */
  function anyCatIcon() {
    for (const c of state.cats) if (c && c.index !== ALL && catIconOf(c.index)) return true;
    return false;
  }

  /* The rail's icon slot. Returns null when there is nothing to draw AND
     nothing to align against, so the pre-icons markup is reproduced exactly.
     `forEdit` always yields a slot: in edit mode the empty box IS the
     affordance (CSS grows a ＋ into it), the same idiom as the hotkey list. */
  function railIconEl(c, forEdit) {
    const src = catIconOf(c.index);
    if (!src && !forEdit && !anyCatIcon()) return null;
    const label = catLabel(c);
    if (!src) {
      const box = h('span', {
        class: 'fd-rail-ic empty' + (forEdit ? ' pick' : ''),
        title: forEdit ? 'Choose an icon for “' + label + '”' : null,
        'aria-hidden': forEdit ? null : 'true',
      });
      if (forEdit) {
        box.dataset.caticon = String(c.index);
        box.setAttribute('role', 'button');
      }
      return box;
    }
    /* No ?v= cache-bust: Ultralight's view loader can treat the query as part
       of the FILENAME (proven in-game 2026-07-28, see medalEl above), and unlike
       a portrait an icon is never rewritten in place — the picker's ⟳ Refresh
       re-scans instead. */
    const img = h('img', { class: 'fd-rail-ic-img', src: src, alt: '', draggable: 'false' });
    const wrap = h('span', {
      class: 'fd-rail-ic' + (forEdit ? ' pick' : ''),
      /* View mode: name the category AND surface the otherwise-hidden way to
         change its icon without entering Edit — right-click. This was the
         "no way to apply an icon" report: the picker existed, but nothing on a
         resting rail hinted the right-click opened it. */
      title: forEdit ? 'Change the icon for “' + label + '”' : (label + ' — right-click to change icon'),
    }, img);
    if (forEdit) {
      wrap.dataset.caticon = String(c.index);
      wrap.setAttribute('role', 'button');
    }
    /* A file deleted since the last scan must not leave a torn box in the rail:
       collapse to the reserved empty slot and say so in HotkeyDeck.log, so the
       next "my icon vanished" report is not silent. */
    img.addEventListener('error', function () {
      toGame('fdLog', 'category icon failed to load: ' + src);
      wrap.classList.add('empty');
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    return wrap;
  }

  /* Write one category's icon and persist. '' clears — the picker's None tile
     and a right-click Clear are the same instruction, so they share this path
     and there is no second place that has to agree about what empty means. */
  function setCatIcon(index, path) {
    const key = String(index);
    const clean = iconSrc(path);
    if (clean) state.catIcons[key] = clean;
    else delete state.catIcons[key];
    saveCfg();
    if (isActive()) renderRail();
    return clean;
  }

  /* The picker. Deliberately NOT a new widget: it is the pane's own overlay
     menu (openFileInto's shape — filter input, Enter takes the top hit, Esc
     closes, drag handle, viewport clamping) with an icon GRID where that one
     has buttons, and the tiles come from the same library app.js's picker
     shows. Mounted on #overlay for the reason that has now bitten twice this
     week: #fol-pane is overflow:hidden, so a menu parented inside it is
     CLIPPED, not merely mispositioned. */
  function openCatIconPicker(anchorEl, c) {
    closeCtx();
    ui.catIconFor = c.index;
    ui.catIconFilter = '';
    ui.catIconShown = CATIC_PAGE;

    const label = catLabel(c);
    const grid = h('div', { class: 'fd-catic-grid' });
    const hint = h('span', { class: 'fd-catic-hint' });

    const items = [
      h('div', { class: 'fd-ctx-head', title: label }, 'Icon for “' + label + '”'),
      h('div', { class: 'fd-ctx-field' },
        h('input', {
          class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
          placeholder: 'Type to filter icons…',
          title: 'Filters by icon name and by the atlas it came from',
          onInput: (e) => { ui.catIconFilter = e.target.value; ui.catIconShown = CATIC_PAGE; paint(); },
          onKeyDown: (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
            if (e.key === 'Enter') {
              e.preventDefault(); e.stopPropagation();
              /* Top hit, skipping the None tile — Enter after typing means
                 "the thing I searched for", never "clear it". */
              const first = grid.querySelector('.fd-catic-tile:not(.none)');
              if (first) first.click();
            }
          },
        }),
        h('button', {
          class: 'fd-ctx-mini', type: 'button',
          title: 'Re-scan icons/custom — picks up anything you just dropped in',
          onClick: (e) => { e.stopPropagation(); toGame('hdIconList'); toast('Re-scanning icons…'); },
        }, '⟳')),
      h('div', { class: 'fd-catic-top' }, hint),
      grid,
    ];

    const matches = (q) => (ic) => !q ||
      String(ic.label || '').toLowerCase().indexOf(q) !== -1 ||
      String(ic.file || '').toLowerCase().indexOf(q) !== -1 ||
      String(ic.atlas || '').toLowerCase().indexOf(q) !== -1;

    function paint() {
      const q = String(ui.catIconFilter || '').trim().toLowerCase();
      const cur = catIconOf(c.index);
      /* What Auto lands on — the shipped default for this NAME, if any. Shown on
         the Auto tile so the user sees WHAT clearing gives back, not a blank. */
      const def = catIconDefaultFor(c.index);
      /* Auto is "active" when there is no user override (whether or not a default
         then fills in), so it reflects the real stored state, not the picture. */
      const hasOwn = !!iconSrc(state.catIcons[String(c.index)] || '');
      grid.textContent = '';

      /* "Auto" first and always visible — clearing an override must never be
         behind a scroll. Auto = drop your pick and use the shipped default for
         this category (or the plain rail row when there is no default). */
      const none = h('button', {
        class: 'fd-catic-tile none' + (hasOwn ? '' : ' on'), type: 'button',
        title: def
          ? 'Auto — use the built-in icon for “' + label + '”'
          : 'No icon — “' + label + '” goes back to the plain rail row',
        onClick: (e) => { e.stopPropagation(); closeCtx(); setCatIcon(c.index, ''); },
      }, def
          ? h('img', { class: 'fd-catic-auto-img', src: def, alt: '', draggable: 'false' })
          : h('span', { class: 'fd-catic-x' }, '⦸'),
         h('span', { class: 'fd-catic-lbl' }, 'Auto'));
      grid.append(none);

      /* Yours first, then the library — the same order (and the same chunking)
         as the hotkey and NFF pickers, so the three feel like one control. */
      const all = state.icons.custom.filter(matches(q)).concat(state.icons.catalog.filter(matches(q)));
      const shown = Math.min(all.length, ui.catIconShown);
      for (let i = 0; i < shown; i++) {
        const ic = all[i];
        const src = iconSrc(ic.file);
        if (!src) continue;
        grid.append(h('button', {
          class: 'fd-catic-tile' + (cur === src ? ' on' : ''), type: 'button',
          title: ic.label || ic.file,
          onClick: (e) => { e.stopPropagation(); closeCtx(); setCatIcon(c.index, src); },
        },
          h('img', { src: src, alt: '', draggable: 'false' }),
          h('span', { class: 'fd-catic-lbl' }, ic.label || '')));
      }

      if (all.length > shown) {
        grid.append(h('button', {
          class: 'fd-catic-more', type: 'button',
          onClick: (e) => { e.stopPropagation(); ui.catIconShown += CATIC_PAGE; paint(); },
        }, 'Show ' + Math.min(all.length - shown, CATIC_PAGE) + ' more — ' +
           (all.length - shown) + ' still hidden'));
      } else if (!all.length) {
        grid.append(h('div', { class: 'fd-ctx-empty' },
          (state.icons.custom.length + state.icons.catalog.length)
            ? 'No icon matches “' + ui.catIconFilter + '”.'
            : 'No icons found. Drop PNGs into the deck’s icons/custom folder, then hit ⟳.'));
      }

      hint.textContent = state.icons.custom.length + ' yours · ' +
        state.icons.catalog.length + ' library' +
        (all.length > shown ? ' · showing ' + shown : '');
    }
    paint();

    ctxEl = h('div', { id: 'fd-ctx-menu', class: 'fd-catic-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    /* Exactly the member menu's box — ctxWidthPx already takes a share of the
       surface and already caps itself at the viewport, so the grid inherits
       "use the room" and the three menus stay one family. The tiles wrap into
       whatever that width allows (auto-fill in CSS), so nothing here has to
       know how many columns fit. */
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  /* Find a category by rail index for the delegated handlers below. */
  function catForIcon(index) {
    const n = Number(index);
    return state.cats.find((c) => c.index === n) || null;
  }

  /* CHAIN app.js's icon globals, never reassign them: app.js owns hdIconIndex /
     hdIcons for the hotkey picker and wardrobe-nff.js already chains them too.
     Replacing either would silently unplug whoever registered first — the exact
     class of bug [[prismaui-one-name-per-direction]] is about, one layer up.
     This file loads after app.js, so the previous handler exists in the game;
     the typeof guard is for the standalone harness, where it may not. */
  function chainIcons() {
    const prevIdx = window.hdIconIndex;
    window.hdIconIndex = function (idx) {
      try {
        const o = typeof idx === 'string' ? JSON.parse(idx) : (idx || {});
        state.icons.catalog = (Array.isArray(o.catalog) ? o.catalog : []).map((c) => ({
          file: String(c.file || '').replace(/\\/g, '/'),
          label: c.label || '', atlas: c.atlas || '',
        })).filter((c) => c.file);
        if (ui.catIconFor >= 0) refreshCatIconPicker();
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
        if (ui.catIconFor >= 0) refreshCatIconPicker();
      } catch (e) { /* as above */ }
      if (typeof prevIcons === 'function') return prevIcons.apply(this, arguments);
      return undefined;
    };
  }

  /* A ⟳ Refresh answer landed while the picker is up: rebuild it in place at
     the same anchor, so newly-dropped icons appear without a second click.
     Re-opening (rather than repainting) keeps ONE code path for the grid — the
     alternative is a second painter that has to stay in step with the first. */
  function refreshCatIconPicker() {
    const idx = ui.catIconFor;
    const c = catForIcon(idx);
    if (!c) return;
    const q = ui.catIconFilter, shown = ui.catIconShown;
    const anchor = ctxEl;   // reopen where it already is, not back at the rail
    const at = anchor ? { left: anchor.offsetLeft, top: anchor.offsetTop } : null;
    openCatIconPicker(null, c);
    ui.catIconFilter = q;
    ui.catIconShown = shown;
    const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
    if (inp) { inp.value = q; inp.dispatchEvent(new Event('input')); }
    if (at && ctxEl) { clampCtx(at.left, at.top); reclampCtx(); }
  }

  function railRow(c) {
    const selected = ui.cat === c.index;
    const isAll = c.index === ALL;
    const count = isAll ? state.total : c.members.length;

    if (ui.editing && !isAll) {
      return h('div', { class: 'fd-rail-item edit' + (selected ? ' sel' : ''), data: { cat: String(c.index) } },
        /* The icon slot leads the row in edit mode, in the same place it
           occupies in view mode, so turning Edit on moves nothing sideways. */
        railIconEl(c, true),
        h('input', {
          class: 'fd-rail-rename', type: 'text', value: catLabel(c), spellcheck: 'false',
          maxlength: String(FIELD_VALUE_MAX),
          title: 'Rename category slot ' + c.index + ' — blank restores "' + (c.original || 'Category ' + c.index) + '"',
          onFocus: () => { if (ui.cat !== c.index) { ui.cat = c.index; ui.sel = -1; renderList(); } },
          onChange: (e) => sendApply('renameCategory', { cat: c.index, name: clampText(e.target.value) }),
          onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
        }),
        h('button', {
          class: 'fd-icon-btn magic' + (c.inMagicMenu ? ' on' : ''),
          title: c.inMagicMenu ? 'Shown in the Magic Menu (category spell) — click to hide'
                               : 'Hidden from the Magic Menu — click to show',
          onClick: (e) => { e.stopPropagation(); sendApply('setMagicMenu', { cat: c.index, on: !c.inMagicMenu }); },
        }, '✦'),
      );
    }

    return h('div', {
      class: 'fd-rail-item' + (isAll ? ' all' : '') + (selected ? ' sel' : ''),
      data: { cat: String(c.index) },
      /* Clicking a category OPENS its roster (leaving dedicate-to-NPC mode);
         clicking the one that is already open again returns to the dedicated
         card (Rober, 2026-08-05). With no crosshair target the roster is the
         normal view, so opening it is the only effect. */
      onClick: () => {
        /* Picking a category is going BACK to the roster, so an open F7 card
           (a pinned pick from a row's F7 button or the party strip, or NPC
           focus) closes with it. It used to stay mounted above the list,
           clipped to its cap, over a roster that no longer had anything to do
           with it (Rober, 2026-09-23: "if i go to a category it still shows
           the f7 cut off"). The search text is his and is left alone. */
        const hadCard = !!(ui.fqPick || ui.npcFocus);
        if (hadCard) {
          ui.fqPick = ''; ui.fqPickPinned = false;
          ui.cat = c.index; ui.rosterOpen = true;
          ui.sel = -1;
          if (ui.npcFocus) { exitFocus(); } else { render(); }
          syncQuickHere();
          return;
        }
        if (ui.rosterOpen && ui.cat === c.index) { ui.rosterOpen = false; }
        else { ui.cat = c.index; ui.rosterOpen = true; }
        ui.sel = -1;
        render();
      },
      /* Right-click a real category = choose its icon, without going through
         Edit. One entry, so it opens the picker directly rather than a menu
         with a single item in it — the picker's own header names the category
         and its Auto tile is the clear. "All followers" is not a slot FO owns,
         so it has no icon and no menu. */
      onContextmenu: isAll ? null : (e) => {
        e.preventDefault(); e.stopPropagation();
        openCatIconPicker(e.currentTarget, c);
      },
      // (member drops onto this row are hit-scanned by the member row's PDrag.arm)
    },
      railIconEl(c, false),
      // The rail is narrow and category names are user-typed, so the label
      // ellipsizes often. Without the title the full name is unrecoverable
      // without entering edit mode — the note and home chips already carry one.
      h('span', { class: 'fd-rail-name', title: isAll ? 'Every follower, across all categories' : catLabel(c) },
        isAll ? 'All followers' : catLabel(c)),
      h('span', { class: 'fd-rail-count', title: count + (count === 1 ? ' follower' : ' followers') },
        String(count)),
    );
  }

  /* The crosshair NPC pinned atop the rail (Rober, 2026-08-05): "above the
     categories on the left show the targeted npc's icon and their name so you
     can click back easily to the targeted view." Clicking it returns to the
     dedicated card (rosterOpen=false); it lights up when that view is active. */
  function renderRailTarget() {
    const host = $('fd-rail-target');
    if (!host) return;
    host.textContent = '';
    const tgt = quickSubject() || (state.targetKnown ? state.target : null);
    if (!tgt || !tgt.name) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const who = tgt.name;
    const known = rosterEntryFor(who);
    const pseudo = known ? known.m : { name: who, original: who, following: !!tgt.following, dead: !!tgt.dead };
    const medal = medalEl(pseudo, known ? known.cat.index : 0, 'f7');
    medal.classList.add('fd-railtgt-medal');
    const active = !ui.rosterOpen;   // dedicated view is showing
    host.append(h('button', {
      class: 'fd-railtgt' + (active ? ' sel' : ''), type: 'button',
      title: active ? 'Showing ' + who + '’s card' : 'Back to ' + who + '’s card',
      onClick: () => { ui.rosterOpen = false; ui.fqPick = ''; render(); },
    },
      medal,
      h('span', { class: 'fd-railtgt-txt' },
        /* Just the name — no "Looking at" eyebrow (Rober, 2026-08-05). */
        h('span', { class: 'fd-railtgt-name', title: who }, who))));
  }

  function renderRail() {
    const rl = $('fd-rail-list');
    /* GIVE THE COLUMN BACK. The icon slot costs the rail ~28px, and at the
       fixed 168px that turned "All followers" into "All follo…" the moment the
       first glyph was set — a feature that quietly truncates the labels beside
       it is a bad trade. So the rail widens by exactly the slot it grew, and
       ONLY while icons are in use: a rail nobody has decorated keeps its
       original width to the pixel. */
    const rail = $('fd-rail');
    if (rail) rail.classList.toggle('caticons', anyCatIcon() || ui.editing);
    /* Keep the « / » collapse toggle's glyph in step with the persisted state
       (it loads from config, so the button must reflect it after fdConfig). */
    const railTgl = $('fd-rail-toggle');
    if (railTgl) {
      railTgl.textContent = state.railCollapsed ? '»' : '«';
      railTgl.title = state.railCollapsed ? 'Show categories' : 'Collapse categories';
    }
    renderRailTarget();   // the crosshair NPC atop the rail — click = dedicated view
    rl.textContent = '';
    rl.append(railRow({ index: ALL, members: [] }));
    state.cats.forEach((c) => {
      if (!ui.editing && !c.members.length) return;
      rl.append(railRow(c));
    });
    if (ui.cat !== ALL && !ui.editing) {
      const c = catByIndex(ui.cat);
      if (!c || (!c.members.length)) { ui.cat = ALL; }
    }
  }

  function badgeEls(m) {
    const out = [];
    if (m.following) out.push(h('span', { class: 'fd-tag following', title: 'Currently following you' }, 'Following'));
    if (m.dead) out.push(h('span', { class: 'fd-tag dead', title: 'Dead' }, '☠ Dead'));
    if (m.tracked) out.push(h('span', { class: 'fd-tag tracked', title: 'Tracked on the map (quest marker)' }, '⚑'));
    if (!m.resolved) out.push(h('span', { class: 'fd-tag missing', title: 'Their plugin is not loaded this session (entry is kept)' }, 'plugin missing'));
    /* The Loadouts group(s) she rides with, and the class she plays there.
       Read-only here: the Loadouts tab owns the editing, this only closes the
       loop so her card stops pretending the squad does not exist. */
    groupsFor(m).forEach(function (g) {
      const label = String(g.group || '');
      if (!label) return;
      out.push(h('span', {
        class: 'fd-tag group', title: 'In the Loadouts group "' + label + '"' +
          (g.cls ? ' — plays ' + g.cls + ' there' : ' — no class set in that group'),
      }, label + (g.cls ? ' · ' + g.cls : '')));
    });
    return out;
  }

  /* ---- keyed row reuse -------------------------------------------------
     A roster row is a medallion, six possible chips, badges and four listeners;
     the list used to be emptied and rebuilt on every keystroke (200 followers =
     14,970 element creations and 4,500 listeners for ten letters typed, and a
     fresh <img> per medallion each time — an <img> recreated is an <img>
     re-decoded, which is the whole cost in Ultralight). Rows are cached by
     category:index and kept while their SIGNATURE holds; a keystroke only
     rewrites the search highlight and the .sel class.

     Everything a row draws that does NOT live on the member object — portraits,
     crops, NFF/MHiYH state — arrives through a push, and each of those pushes
     drops the cache at the source. */
  const fdRowCache = new Map();
  const fdSecCache = new Map();
  function dropRowCache() {
    fdRowCache.clear(); fdSecCache.clear();
    /* The party sheet's cards live under exactly the same law and are fed by
       exactly the same pushes (portraits, crops, face renders): whatever
       invalidates a roster row invalidates a card. Routed through the hoisted
       ptDropCache() rather than touching its Map here, so this line is valid
       however the two blocks are later reordered. */
    ptDropCache();
  }

  /* The spans whose whole content is nameNodes() output. textContent is
     lossless across a highlight (nameNodes splits the string, it never edits
     it), so the source text can be read straight back off the node — no sink
     to thread through nowChip/homeChip/whereChip. */
  const FD_HL_SEL = '.fd-name, .fd-note, .fd-chip-field, .fd-home-name, .fd-now-at, .fd-where-name';

  function fdCollectHl(rowEl) {
    const out = [];
    const els = rowEl.querySelectorAll(FD_HL_SEL);
    for (let i = 0; i < els.length; i++) {
      if (els[i].classList.contains('empty')) continue;   // the "No note yet" placeholder
      out.push([els[i], els[i].textContent]);
    }
    rowEl.__fdHl = out;
  }

  function fdReHighlight(rowEl, q) {
    if (rowEl.__fdQ === q) return;
    const hl = rowEl.__fdHl;
    if (hl) {
      for (let i = 0; i < hl.length; i++) {
        const el = hl[i][0];
        el.textContent = '';
        nameNodes(hl[i][1], q).forEach((n) => el.append(n));
        /* app.css styles <mark> per container and the gold field chip is a NEW
           container, so its marks are neutralised the same way memberRow does
           when it builds one. */
        if (el.classList.contains('fd-chip-field')) {
          const marks = el.querySelectorAll('mark');
          for (let mi = 0; mi < marks.length; mi++) {
            marks[mi].style.background = 'transparent';
            marks[mi].style.color = '#ecd9a0';
            marks[mi].style.fontWeight = '700';
          }
        }
      }
    }
    rowEl.__fdQ = q;
  }

  /* Every field the row draws off the member, in one shot — cheaper and far
     safer than enumerating them, and it cannot miss one a later feature adds. */
  function fdRowSig(row) {
    let body;
    try { body = JSON.stringify(row.m); } catch (e) { body = String(row.m && row.m.name); }
    return row.cat + ':' + row.idx + '\u0000' + row.catName + '\u0000' +
      (ui.cat === ALL ? 1 : 0) + '\u0000' + body;
  }

  function memberRow(row, i) {
    const q = ui.filter.trim();
    const m = row.m;
    /* FO leaves OriginalName EMPTY until a rename actually happens, while Name
       always carries the current display name. So `override && override !== original`
       was true for EVERY follower and the row rendered "nee ?" for all of them —
       the `|| '?'` fallback below was the tell. A rename needs BOTH sides. */
    const renamed = m.original && m.override && m.override !== m.original;

    const subKids = [];
    if (m.desc) {
      subKids.push(h('span', { class: 'fd-note', title: m.desc }, nameNodes(m.desc, q)));
    } else {
      subKids.push(h('span', { class: 'fd-note empty' }, 'No note yet — click to add one'));
    }
    /* Exactly one field earns a place on the row (Relationship). It is tinted
       with the deck's existing gold accent — the same token .fd-tag.tracked
       uses — so it never reads as a second category chip. Inline because the
       Followers pane owns no stylesheet of its own. */
    if (CHIP_FIELD) {
      const rel = fieldValue(m, CHIP_FIELD.key);
      if (rel) {
        const chip = h('span', {
          class: 'fd-chip fd-chip-field',
          title: CHIP_FIELD.label + ': ' + rel,
        }, nameNodes(rel, q));
        chip.style.color = '#c9a24b';
        chip.style.borderColor = '#c9a24b55';
        chip.style.background = 'rgba(201,162,75,.06)';
        /* app.css styles <mark> per container (.fd-name mark, .fd-note mark …)
           and has no global reset, so a search hit inside a NEW container would
           paint the browser's default yellow block. Neutralise it here. */
        const marks = chip.querySelectorAll ? chip.querySelectorAll('mark') : [];
        for (let mi = 0; mi < marks.length; mi++) {
          marks[mi].style.background = 'transparent';
          marks[mi].style.color = '#ecd9a0';
          marks[mi].style.fontWeight = '700';
        }
        subKids.push(chip);
      }
    }
    // What they are doing RIGHT NOW (My Home is Your Home NG) — the single
    // most useful read-only fact, so it goes ahead of the static home.
    const nc = nowChip(m, q);
    if (nc) subKids.push(nc);
    // Married, per M.A.R.A.S. Ahead of pregnancy and home because it is the
    // rarest and most defining thing a row can say about who someone is to you.
    const sc = spouseChip(m);
    if (sc) subKids.push(sc);
    // Pregnant, per Fertility Mode. Ahead of the static home for the same
    // reason "now" is: it changes, and it is the thing being looked for.
    const fc = fertChip(m);
    if (fc) subKids.push(fc);
    // Where the GAME says they live (NFF base / MHiYH house) — read-only, and
    // distinct from the Home field you can type in the member menu.
    const hc = homeChip(m, q);
    if (hc) subKids.push(hc);
    const wc = whereChip(m, q);
    if (wc) subKids.push(wc);
    // .fd-chip-cat is the row's designated shock absorber — see the squeeze
    // rebalance in app.css. It is the one chip whose text is already on screen
    // (the rail names the category), so it is the one allowed to ellipsize.
    if (ui.cat === ALL) subKids.push(h('span', { class: 'fd-chip fd-chip-cat' }, row.catName));
    if (renamed) subKids.push(h('span', { class: 'fd-chip orig', title: 'Original name' }, 'née ' + (m.original || '?')));

    return h('div', {
      class: 'fd-member' + (i === ui.sel ? ' sel' : '') + (m.dead ? ' is-dead' : ''),
      role: 'option', data: { k: row.cat + ':' + row.idx },
      onClick: (e) => {
        /* A click on the FACE means "let me see it", not "open the menu".
           closest(), not e.target: the medallion is a wrapper around the image
           since the crop landed, so the literal target depends on which of the
           two is pointer-transparent — a question the row has no business
           knowing the answer to. */
        const t = e.target && e.target.closest
          ? e.target.closest('[data-act="portrait"]') : null;
        if (t) { openLightbox(t.dataset); return; }
        openMemberMenu(row);
      },
      onContextmenu: (e) => { e.preventDefault(); openMemberMenu(row, e.clientX, e.clientY); },
      // pointer-drag: onto another category's rail row (move) or between rows
      // of the same category (reorder; not in All / while searching). The
      // engine swallows the drop's click so it never opens the member menu.
      onMousedown: (e) => {
        /* ⚠ RIGHT-CLICK IS READ FROM MOUSEDOWN, not from `contextmenu`.
           Ultralight does not reliably fire the DOM contextmenu event in-game
           — the same law domains-pane follows for its rows — so the handler
           above is a no-op where it matters, and mousedown only ever armed a
           drag. The result was that right-clicking a follower did NOTHING in
           game, which put the Category dropdown and "Remove from this
           category" at the bottom of this very menu out of reach (Rober,
           2026-09-20: "no easy way to right click and move category or remove
           from category either"). Left button still falls through to the drag
           arm below, so reorder and move-by-drag are untouched. */
        if (e.target && e.target.closest && e.target.closest('button')) return;
        if (e.button === 2) {
          e.preventDefault();
          openMemberMenu(row, e.clientX, e.clientY);
          return undefined;
        }
        return PDrag.arm(e, {
        onStart: () => { dragKind = 'member'; dragFrom = { cat: row.cat, idx: row.idx }; closeCtx(); },
        onMove: (ev) => pdScan(ev, [
          { sel: '.fd-rail-item:not(.all)', mode: 'into',
            eligible: (el) => dragFrom && String(dragFrom.cat) !== el.dataset.cat },
          (ui.cat === ALL || ui.filter.trim()) ? null : { sel: '.fd-member', mode: 'ba',
            eligible: (el) => el.dataset.k !== (row.cat + ':' + row.idx) },
        ]),
        onDrop: () => {
          const t = pdTake();
          const from = dragFrom;
          dragKind = null; dragFrom = null;
          if (!t || !from) { renderList(); return; }
          if (t.mode === 'into') {
            const toCat = parseInt(t.el.dataset.cat, 10);
            if (isNaN(toCat) || toCat === from.cat) { renderList(); return; }
            closeCtx();
            sendApply('moveMember', { cat: from.cat, idx: from.idx, to: toCat });
            toast('Moved');
          } else {
            const parts = String(t.el.dataset.k || '').split(':');
            const tCat = parseInt(parts[0], 10), tIdx = parseInt(parts[1], 10);
            if (tCat !== from.cat) { renderList(); return; }
            const to = tIdx + (t.after ? 1 : 0);
            if (from.idx === to || from.idx === to - 1) { renderList(); return; }
            sendApply('reorderMember', { cat: from.cat, idx: from.idx, to });
          }
        },
        onCancel: () => { dragKind = null; dragFrom = null; renderList(); },
        });
      },
    },
      medalEl(m, row.cat),
      h('div', { class: 'fd-body' },
        // Renamed followers and long Nord surnames both ellipsize here; the
        // note beside it has always had a title, so the NAME having none was
        // the odd one out. Show the original underneath when there is one.
        h('div', { class: 'fd-name', title: m.original && m.original !== m.name
          ? m.name + '\n(originally ' + m.original + ')' : m.name },
          nameNodes(m.name, q)),
        h('div', { class: 'fd-sub' }, subKids),
      ),
      h('div', { class: 'fd-right' }, badgeEls(m),
        h('div', { class: 'fd-row-views', role: 'group', 'aria-label': 'Open ' + m.name },
          h('button', { type: 'button', class: 'fd-row-open', title: 'Full character page for ' + m.name,
            onClick: (e) => { e.stopPropagation(); openMemberMenu(row); } },
            h('img', { src: 'icons/custom/hk-portrait.png', alt: '', 'aria-hidden': 'true' }), 'Full page'),
          h('button', { type: 'button', class: 'fd-row-quick', title: 'F7 controls for ' + m.name,
            onClick: (e) => { e.stopPropagation(); omniOpenMember(m.original || m.name, row.cat, 'quick'); } },
            h('span', { class: 'fd-row-key', 'aria-hidden': 'true' }, 'F7'), 'Controls'))),
    );
  }

  /* Build-or-reuse for one roster row. */
  function memberRowCached(row, i, q) {
    const key = row.cat + ':' + row.idx;
    const sig = fdRowSig(row);
    let node = fdRowCache.get(key);
    if (!node || node.__fdSig !== sig) {
      node = memberRow(row, i);
      node.__fdSig = sig;
      node.__fdQ = q;
      fdCollectHl(node);
      fdRowCache.set(key, node);
      return node;
    }
    fdReHighlight(node, q);
    node.classList.toggle('sel', i === ui.sel);
    return node;
  }

  /* Keyed reconcile against a host's live children. */
  function fdReconcile(host, nodes) {
    let cur = host.firstChild;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (cur === node) { cur = cur.nextSibling; continue; }
      host.insertBefore(node, cur);        // insertBefore MOVES an attached node
    }
    while (cur) { const nx = cur.nextSibling; host.removeChild(cur); cur = nx; }
  }

  /* A sticky "Housecarls 24" bar that rides above its run of rows.
     Only earns its place when the list is actually mixed: filing by category is
     what the rail is for, so on a single-category view a header would just be
     the rail label repeated. */
  function groupHeader(name, n) {
    return h('div', { class: 'fd-group', 'data-cat': name },
      h('span', { class: 'fd-group-name' }, name),
      h('span', { class: 'fd-group-count' }, String(n)),
    );
  }

  function renderList() {
    renderRecents();          // faces/names in the strip track the roster
    const list = $('fd-list');
    const vis = visibleRows();
    if (ui.sel >= vis.length) ui.sel = vis.length - 1;
    syncCount();

    const empty = $('fd-empty');
    if (!vis.length) {
      list.textContent = '';
      list.classList.add('hidden');
      showEmpty(empty);
    } else {
      empty.classList.add('hidden');
      list.classList.remove('hidden');

      // Count per category up front so the header can say how many are BELOW it
      // right now — under a filter that is the number of matches, not the
      // category's total, which is the number the eye is checking against.
      const runs = new Map();
      vis.forEach((r) => runs.set(r.catName, (runs.get(r.catName) || 0) + 1));
      const grouped = ui.cat === ALL && runs.size > 1;

      // Each run gets its OWN section, and that is load-bearing rather than
      // tidiness: sticky positions against the nearest scrolling ancestor, so
      // header-as-sibling means every header sticks at top:0 and they PILE UP
      // — scroll into Nobles and you are looking at "Housecarls / Mercenaries /
      // Nobles" stacked. Boxing each run makes a header scroll away when its
      // own rows run out, which is the behaviour people expect.
      /* Reconciled, not rebuilt: rows come out of the cache and are MOVED into
         place, and a section keeps its own identity so its sticky header does
         not flicker as the filter narrows. */
      const q = ui.filter.trim();
      if (!grouped) {
        fdReconcile(list, vis.map((r, i) => memberRowCached(r, i, q)));
      } else {
        const order = [];
        const secRows = new Map();
        vis.forEach((r, i) => {
          if (!secRows.has(r.catName)) { order.push(r.catName); secRows.set(r.catName, []); }
          secRows.get(r.catName).push(memberRowCached(r, i, q));
        });
        const secs = order.map((cat) => {
          let sec = fdSecCache.get(cat);
          if (!sec) { sec = h('div', { class: 'fd-sec' }, groupHeader(cat, runs.get(cat))); fdSecCache.set(cat, sec); }
          else {
            const cnt = sec.querySelector('.fd-group-count');
            if (cnt) cnt.textContent = String(runs.get(cat));
          }
          const head = sec.firstChild;
          fdReconcile(sec, [head].concat(secRows.get(cat)));
          return sec;
        });
        fdReconcile(list, secs);
      }

      if (ui.sel >= 0) {
        // Ask for the selected ROW, not children[sel] — with group headers in
        // the list those indices no longer line up, and the old form would have
        // scrolled to whatever element happened to sit at that offset.
        const sel = list.querySelector('.fd-member.sel');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function showEmpty(el) {
    el.classList.remove('hidden');
    el.textContent = '';
    const searching = !!ui.filter.trim();
    el.append(h('div', { class: 'fd-em-ic' }, searching ? '⌕' : '⚔'));
    if (!state.loaded) {
      el.append(h('div', { class: 'fd-em-title' }, 'Loading followers…'));
      el.append(h('div', { class: 'fd-em-sub' }, 'Asking Follower Organizer for the roster.'));
    } else if (searching) {
      el.append(h('div', { class: 'fd-em-title' }, 'No follower matches'));
      el.append(h('div', { class: 'fd-em-sub' }, 'Nothing matches “' + ui.filter.trim() + '” — names, notes and categories are all searched.'));
    } else if (state.foMissing) {
      el.append(h('div', { class: 'fd-em-title' }, 'Follower Organizer unavailable'));
      el.append(h('div', { class: 'fd-em-sub' }, 'Once the patched FollowerOrganizer.dll is loaded, your whole retinue appears here.'));
    } else if (ui.cat !== ALL) {
      const c = catByIndex(ui.cat);
      el.append(h('div', { class: 'fd-em-title' }, '“' + (c ? catLabel(c) : '?') + '” is empty'));
      el.append(h('div', { class: 'fd-em-sub' }, 'Drag followers here, use “Category” in a follower\'s menu, or look at an NPC before opening the deck and add them below.'));
    } else {
      el.append(h('div', { class: 'fd-em-title' }, 'No followers yet'));
      el.append(h('div', { class: 'fd-em-sub' }, 'Look at an NPC, open the deck, and add them to a category — or use Follower Organizer\'s own add key.'));
    }
  }

  function renderAdd() {
    const btn = $('fd-add-btn');
    const shot = $('fd-shot-btn');
    const hint = $('fd-add-hint');
    if (state.target && state.target.name) {
      btn.textContent = '＋ Add “' + state.target.name + '” to a category…';
      btn.classList.remove('hidden');
      /* The legacy bottom Portrait bar is redundant now — the card has a
         Portrait group (◉ / ⛶). Keep it hidden so the footer is just the one
         "+ Add … to a category" bar under STATS (Rober, 2026-08-05). */
      if (shot) shot.classList.add('hidden');
      hint.classList.add('hidden');
    } else {
      btn.classList.add('hidden');
      if (shot) shot.classList.add('hidden');
      hint.classList.toggle('hidden', !!state.foMissing || !state.loaded);
    }
  }

  /* ================== the quick-follower card (Hotkeys ▸ Followers) ======= *
   *  Recruit · Dismiss · Open inventory for whoever is under the crosshair,
   *  as a card ABOVE the hotkey list — sitting with the follower hotkeys it
   *  belongs to (Follower Control (NFF), Teleport, Abduction-Add-Follower).
   *
   *  It lives HERE rather than in app.js because everything it needs already
   *  does: whoOf/sendNpc/recruitClick (including the guarded-NPC second
   *  click), the equipped cache, and the fdTarget/fdNpc/fdEquipped receivers.
   *  app.js owns only the decision to mount it — see mountQuickCard.
   *
   *  The person is the palette-open crosshair SNAPSHOT, the same one the
   *  Followers tab's ＋Add uses, so the two can never disagree about who the
   *  targeted NPC is.
   * ======================================================================== */
  let quickHost = null;
  let targetWait = 0;
  /* Last fdNpcResult, shown inline on the card. Cleared when the target
     changes — a verdict about someone else is noise. */
  let fqStatus = { msg: '', ok: true, pending: false };
  /* The 🔧 flyout lives in its own module and can outlive itself — you fire a
     fix, dismiss the flyout, and the answer arrives after it is gone. It hands
     the result HERE so the card's own status line carries it, the same
     courtesy Add-as-mount gets. Named on window because fixes-flyout.js loads
     independently and must not reach into this closure. */
  window.fqFixStatus = function (r) {
    fqStatus = { msg: (r && r.msg) || '', ok: !r || r.ok !== false, pending: false };
    if (isActive()) renderQuickCard();
  };

  /* ------------------------------------------- M.A.R.A.S marriage state ---
     `about.maras` is the dossier slice C++ sends when the mod is installed:
     { on:true, spouse:bool }. Absent means either the mod is not there or the
     DLL predates this feature — indistinguishable from the view, and in both
     cases the honest answer is to say nothing rather than "not married".
     The roster's own flag is the fallback so a stale DLL paired with a fresh
     fdNff still lights the chip for someone FO knows. */
  function marasSpouse(about, known) {
    const ma = (about && about.maras && typeof about.maras === 'object') ? about.maras : null;
    if (ma && typeof ma.spouse === 'boolean') return ma.spouse;
    return !!(known && known.m && known.m.spouse);
  }

  /* ------------------------------------------------------------- TRADE ------
     Rober's ask (2026-08-17): "a open merchant / trade button when hitting f7
     on an npc", modelled on Skyrim QuickTrade — barter for a non-hostile NPC on
     at least neutral terms, her PACK for a companion or a spouse.

     This PREDICTS which of the two the press will open, and nothing more. C++
     (src/trade_actions.cpp) is the only thing that decides, on the live actor,
     the instant you press — the view cannot see hostility or combat at all. The
     prediction exists so the button's hover title names the real menu instead
     of a generic word, because "barter with a stranger" and "here is your
     wife's bag" are very different things to press by accident.

     ⚠ Keep the three facts below in step with IsCompanionOrSpouse() in
     trade_actions.cpp. When they disagree the button lies, which is worse than
     having no title at all. Unknown is BARTER on purpose: that is what the rule
     gives everyone the deck knows nothing special about, so a dossier that has
     not landed yet under-promises rather than over-promises. */
  const TRADE_LOVER_RANK = 4;   // +4 Lover — what a vanilla wedding writes (src/relationship.h)

  function tradePlan(about, known, following) {
    const spouse = marasSpouse(about, known);
    const rankKnown = !!(about && about.relHas && typeof about.rank === 'number');
    const rank = rankKnown ? clampRank(about.rank) : 0;
    const lover = rankKnown && rank >= TRADE_LOVER_RANK;
    const pack = !!following || spouse || lover;
    return {
      mode: pack ? 'inventory' : 'barter',
      why: following ? 'she follows you'
         : (spouse ? 'she is your spouse'
         : (lover ? 'the game has her as your Lover' : '')),
      /* Below Acquaintance and NOT a companion: C++ will refuse the barter.
         Say so up front — a button that opens nothing reads as broken. A rank
         the engine has never recorded is not a negative one, which is why this
         needs `relHas` and not just a number. */
      lowRank: (!pack && rankKnown && rank < 0) ? rankLabel(rank) : '',
    };
  }

  function tradeTitle(who, dead, plan) {
    if (dead) return 'Loot them in the world instead';
    if (plan.mode === 'inventory')
      return 'Open ' + who + '’s pack — ' + (plan.why || 'she is one of yours')
           + ', so Trade hands you her inventory rather than a barter window '
           + '(the deck closes)';
    let t = 'Trade with ' + who + ' — the vanilla barter menu, buying and selling '
          + 'against what she carries (the deck closes)';
    if (plan.lowRank)
      t += '\n⚠ The game has her as your ' + plan.lowRank + ', which is below the '
         + 'neutral footing trading needs — she will refuse, and say so.';
    return t;
  }

  /* ------------------------------------------------- the rank, in flight ---
     The card's rank comes from `about` (the engine, read on the worn-set call).
     This is the OVERRIDE that covers the gap between committing a change and
     the engine having applied it: the write goes through the Papyrus VM, so
     nothing can hand back the new value on the spot (src/relationship.h).

     `key` is the target formId the edit belongs to — an override with no owner
     would follow the crosshair onto the next person and show them someone
     else's rank. Cleared whenever a fresh, non-pending engine read lands, so
     `about` is the authority for all but the ~1 s the VM needs. */
  let rankEdit = { key: null, has: false, rank: 0, pending: false };
  let rankVerify = 0;

  /* Which rank the card should DRAW, and where it came from. */
  function rankView(t) {
    const key = hexOf(Number((t && t.formId) || 0)).toLowerCase();
    const entry = Object.keys(state.equipped).find(k => Number(k) === Number(t && (t.readFormId || t.formId)));
    const about = (entry ? state.equipped[entry] : !quickSubject() ? equippedFor(null) : null) || {};
    const detail = about.about || null;
    if (rankEdit.key !== null && rankEdit.key === key) {
      return { known: true, has: rankEdit.has, rank: clampRank(rankEdit.rank),
               pending: rankEdit.pending };
    }
    /* No `rank` on the dossier means the DLL is older than this feature. That
       is not "Acquaintance" — it is no answer, and drawing a slider parked at 0
       would invite you to "confirm" a rank the game never reported. */
    if (!detail || typeof detail.rank !== 'number') return { known: false };
    return { known: true, has: !!detail.relHas, rank: clampRank(detail.rank), pending: false };
  }

  /* Commit a rank. Optimistic on purpose — the slider must not snap back to the
     old value for the second the VM takes — but the optimism is BOUNDED: a
     verify read is scheduled, and whatever the engine says then wins. */
  function sendRank(v, t) {
    t = t || state.target;
    if (!t || !t.formId) return;
    const r = clampRank(v);
    rankEdit = { key: hexOf(Number(t.formId)).toLowerCase(), has: true, rank: r, pending: true };
    fqStatus = { msg: 'Making ' + (t.name || 'them') + ' ' + rankLabel(r) + '…',
                 ok: true, pending: true };
    toGame('fdRank', JSON.stringify({ formId: hexOf(t.formId), rank: r }));
    renderQuickCard();
    refreshOpenMenu();

    /* Re-read the ENGINE once the VM has plausibly run. Without this a stack
       the VM silently dropped would leave the card showing a rank that was
       never applied — the exact class of lie the NPC-actions work was about.
       Forced past askEquipped's same-key gate because this is a TIMER, not an
       fdWorn reply, so it cannot re-enter the request loop that gate exists to
       break. */
    if (rankVerify) clearTimeout(rankVerify);
    rankVerify = setTimeout(function () {
      rankVerify = 0;
      askEquipped({ formId: t.readFormId || t.formId, liveFormId: t.formId }, true);
    }, 900);
  }

  /* The rank control: a nine-segment diverging bar, centre-anchored on
     Acquaintance, with a nudge either side.

     WHY NOT <input type=range>: it was one, and it read as a stray browser
     widget bolted onto a hand-made deck — but the stronger reason is that this
     view runs in Ultralight, where native form controls have a history of
     rendering and then doing nothing (the dead <select> that had to become our
     own menu is the precedent). A range input's ONLY affordance is dragging its
     thumb, so if the drag does not work the control is inert. Segments are
     plain divs: every one is a click target for its own rank, so the whole
     scale is reachable in one click each, and dragging is a bonus rather than
     the only way in.

     WHY DIVERGING RATHER THAN LEFT-TO-RIGHT FILL: the scale has a real centre.
     0 is not "none of it", it is Acquaintance — the neutral the game starts
     everyone at. Filling from the left would draw Archnemesis as empty and
     Acquaintance as half-full, which is exactly backwards from how the number
     reads. So the fill grows OUT of the middle, warm to the right, cold to the
     left, and how far it has travelled from centre is the strength of the
     feeling in either direction. */
  /* One class per STEP, so the readout can be coloured by the exact rank rather
     than by which side of zero it is on (Rober, 2026-09-21: "rank should be
     color coded below?"). Built here and not in CSS because the value is a
     number: nine rules keyed off a class beat nine :nth-child selectors that
     would have to know the bar's geometry. `rkp0` is Acquaintance — the
     neutral centre, deliberately given a colour of its own rather than left to
     inherit, so "no feeling either way" reads as a verdict too. */
  function rankTone(r) {
    const n = clampRank(r);
    return 'rk' + (n < 0 ? 'm' : 'p') + Math.abs(n);
  }

  function rankRow(t, who) {
    const subject = quickSubject();
    if (subject && [subject.formId, subject.liveFormId].some(id => id && Number(id) === Number(t && t.formId))) {
      t = {formId:subject.liveFormId || subject.formId, readFormId:subject.formId, name:who};
    }
    const rv = rankView(t);
    if (!rv.known) return null;

    const row = h('div', { class: 'fq-rank' + (rv.has ? '' : ' unset') },
      h('span', { class: 'fq-sets-lbl', title:
        'What SKYRIM thinks of you — the relationship rank the game itself branches on '
        + '(dialogue, followers, marriage). Not the Relationship you typed in her fields.' },
        'Rank'));

    const val = h('span', {
      class: 'fq-rank-val ' + rankTone(rv.rank)
        + (rv.rank > 0 ? ' good' : (rv.rank < 0 ? ' bad' : '')),
    }, h('b', { class: 'fq-rank-name' }, rankLabel(rv.rank)),
       h('span', { class: 'fq-rank-num' }, rankNum(rv.rank)));

    /* Live preview during a hover or a drag. Text and segment classes only —
       NEVER a re-render, because rebuilding the card would replace the very
       element the pointer is on and the gesture would die on the first pixel.
       The commit happens on release. */
    function preview(n) {
      const c = clampRank(n);
      val.firstChild.textContent = rankLabel(c);
      val.lastChild.textContent = rankNum(c);
      val.className = 'fq-rank-val ' + rankTone(c)
        + (c > 0 ? ' good' : (c < 0 ? ' bad' : ''));
      segs.forEach((el, i) => {
        const r = RANK_MIN + i;
        // "Lit" means between the centre and the value, inclusive — the reach
        // of the feeling. `r === 0` is always lit so the centre never looks
        // like a gap in the bar.
        const lit = (r === 0) || (c > 0 && r > 0 && r <= c) || (c < 0 && r < 0 && r >= c);
        el.className = 'fq-rank-seg'
          + (r < 0 ? ' cold' : (r > 0 ? ' warm' : ' zero'))
          // Intensity by DISTANCE from centre, so the bar reads as strength of
          // feeling and not just as "how many boxes are on". A CSS-only version
          // of this needs one rule per adjacency depth, which tops out at two
          // shades; a class carries all four.
          + ' mag' + Math.abs(r)
          + (lit ? ' lit' : '') + (r === c ? ' cur' : '');
      });
    }

    const segs = [];
    const track = h('div', {
      /* Keeps the class the CSS and its build marker key off: this IS the
         slider, it is simply ours rather than the browser's. */
      class: 'fq-rank-slider', role: 'slider', tabindex: '0',
      'aria-valuemin': String(RANK_MIN), 'aria-valuemax': String(RANK_MAX),
      'aria-valuenow': String(rv.rank), 'aria-valuetext': rankLabel(rv.rank),
      'aria-label': 'Relationship rank with ' + who,
      title: 'Click a step, or drag across, to set ' + who + '’s relationship rank\n'
           + '+4 Lover  +3 Ally  +2 Confidant  +1 Friend  0 Acquaintance\n'
           + '−1 Rival  −2 Foe  −3 Enemy  −4 Archnemesis',
      onClick: (e) => e.stopPropagation(),
      onMouseLeave: () => { if (!dragging) preview(rv.rank); },
      onKeyDown: (e) => {
        const d = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1
                : (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ? -1 : 0;
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        const n = clampRank(rv.rank + d);
        if (n !== rv.rank) { rankFocus = true; sendRank(n, t); }
      },
    });

    let dragging = false;
    let dragTo = rv.rank;

    for (let r = RANK_MIN; r <= RANK_MAX; r++) {
      const seg = h('div', {
        class: 'fq-rank-seg', 'data-r': String(r),
        title: rankLabel(r) + '  ' + rankNum(r),
        onMouseEnter: () => { if (dragging) { dragTo = r; } preview(dragging ? dragTo : r); },
        onMouseDown: (e) => {
          e.preventDefault(); e.stopPropagation();
          dragging = true; dragTo = r; preview(r);
        },
        onMouseUp: (e) => {
          e.stopPropagation();
          if (!dragging) return;
          dragging = false;
          if (dragTo === rv.rank) { preview(rv.rank); return; }  // put back: nothing to say
          rankFocus = true;            // survive the re-render this triggers
          sendRank(dragTo, t);
        },
      }, h('i', { class: 'fq-rank-tick' }));
      segs.push(seg);
      track.append(seg);
    }
    /* Released off the bar: end the gesture without committing. Without this a
       drag that wandered off would leave `dragging` true and the next hover
       anywhere on the track would silently keep previewing. */
    track.addEventListener('mouseleave', () => { dragging = false; });

    const nudge = (delta, glyph, tip) => h('button', {
      class: 'fq-rank-nudge', type: 'button',
      disabled: (delta < 0 ? rv.rank <= RANK_MIN : rv.rank >= RANK_MAX) ? true : null,
      title: tip,
      onClick: (e) => { e.stopPropagation(); rankFocus = true; sendRank(rv.rank + delta, t); },
    }, glyph);

    row.append(nudge(-1, '◂', 'One step colder — towards Archnemesis'));
    row.append(track);
    row.append(nudge(1, '▸', 'One step warmer — towards Lover'));
    row.append(val);
    if (!rv.has) {
      row.append(h('span', { class: 'fq-rank-note', title:
        'The game has no relationship record for the two of you at all, which is '
        + 'not the same as a deliberate Acquaintance. Moving this creates one.' },
        'no record yet'));
    } else if (rv.pending) {
      row.append(h('span', { class: 'fq-rank-note' }, 'applying…'));
    }
    preview(rv.rank);          // paint the segment classes for the current value
    return row;
  }

  /* Was the slider the thing you were holding when the card redrew? Only ever
     set by the slider's own commit, so focus is restored exactly once and never
     stolen from a text field you were typing in. */
  let rankFocus = false;

  /* ---- party orders (no crosshair target) ----------------------------
   *  Every one is an NFF entry point, not a loop we invented — see
   *  src/nff_control.h for which. Teleport and the relax pair reach even
   *  UNLOADED followers (NFF walks its own aliases); Follow/Wait only reach
   *  the loaded ones, because those orders mean nothing for an actor the game
   *  is not simulating. That difference is in the tooltips rather than hidden,
   *  since "why did she not come" is otherwise unanswerable from the UI. */
  /* NFF's own four, verbatim from its translation file (nwsFollowerFramework
     _english.txt: $FF_Sandbox_0..3, dropdown labelled $FF_AllowSandbox =
     "Sandbox Style"). Using its words means the deck and its MCM cannot
     disagree about what a mode does. The global is nwsAllowSandbox; C++ has
     always accepted an explicit level (nff_control.cpp allSandboxSet) — only
     the view was pretending it was a boolean. */
  const SANDBOX_STYLES = [
    { level: 0, short: 'off', label: 'Off', ic: '\u25cb',
      help: 'Nobody sandboxes; followers stay in formation.' },
    { level: 1, short: 'allow', label: 'Allow', ic: '\u25c9',
      help: 'They may settle when you stand still, but never on their own.' },
    { level: 2, short: 'town', label: 'Allow / Autobox in Town', ic: '\u2302',
      help: 'As Allow, and they start relaxing by themselves in towns.' },
    { level: 3, short: 'home', label: 'Allow / Autobox at Home', ic: '\u2691',
      help: 'As Allow, and they start relaxing by themselves at home.' },
  ];

  /* The picker. The deck's menu idiom rather than a <select>, which in
     Ultralight renders and never opens. Four fixed options, so no filter box:
     the standing "make it typable" rule is about lists that GROW, and this one
     is defined by NFF. */
  function openSandboxStyle(anchorEl, cur) {
    closeCtx();
    const items = [h('div', { class: 'fd-ctx-head' }, 'Sandbox style'),
      h('div', { class: 'fd-ctx-empty' },
        'NFF\u2019s own setting, for EVERYONE. Whether she is included is her '
        + 'own switch on her card.')];
    SANDBOX_STYLES.forEach(function (st) {
      items.push(h('button', {
        class: 'fd-ctx-item' + (st.level === cur ? ' on' : ''),
        type: 'button', title: st.help,
        onClick: (e) => {
          e.stopPropagation(); closeCtx();
          if (st.level === cur) return;          // already there: say nothing, do nothing
          sendParty('allSandboxSet', { level: st.level });
        },
      },
        h('span', { class: 'fd-ctx-check' }, st.level === cur ? '\u2713' : st.ic),
        h('span', { class: 'fd-ctx-lbl' }, st.label),
        h('span', { class: 'fd-ctx-count' }, String(st.level))));
    });
    /* Mounted exactly like the pane's other menus — same node id, same clamp,
       same outside-click teardown. No filter box and no focus grab: four fixed
       options, and stealing focus here would fight the card behind it. */
    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => { document.addEventListener('mousedown', ctxOutside, true); }, 0);
  }

  const PARTY_ACTS = [
    { op: 'allSummon',  ic: '\u2935', label: 'Teleport',
      title: 'Bring active followers from every framework, including distant companions. Waiting or busy followers stay put; residents and dismissed NPCs are left alone.' },
    /* 'Follow all' removed at Rober's request (2026-08-05). */
    { op: 'allWait',    ic: '\u270b', label: 'Wait',
      title: 'Everyone nearby waits where they stand.' },
    /* Attack (Rober, 2026-09-23: "everyone attack target button integrated
       into this?"). Not an NFF verb — it fires the deck's own seeded Sic 'em
       entry, the play-proven NpcActions::DoSicEm, so there is ONE
       implementation whether it is pressed here, bound to a key or pinned to
       the Hotbar. `fire` is the ENTRY id (hdFire looks entries up by id, never
       by action verb). C++ closes the deck and does not reopen it: the fight
       must not stay paused under the palette. */
    { fire: 'npc-attack-target', ic: '\u2694', label: 'Attack',
      title: 'Every follower attacks the enemy you are aiming at, right now.\n'
           + 'The one under your crosshair when you opened the deck, else the nearest '
           + 'hostile along your aim out to ~115 m, else the nearest enemy already '
           + 'fighting you — never one of your own — plus any enemies fighting '
           + 'near it. Skips the follower detection lag.\n'
           + 'The deck closes so the fight is not paused.' },
    { op: 'allRelax',   ic: '\u263e', label: 'Sandbox',
      title: 'Start NFF\u2019s group sandbox now instead of waiting for it.\n'
           + 'Relaxing is group-wide in NFF — there is no per-follower version.' },
    { op: 'allUnrelax', ic: '\u21ba', label: 'Stop',
      title: 'End the sandbox and put everyone back on you.' },
  ];

  /* Party orders carry no formId at all — that absence IS the message. Same
     bridge and same reply handler as the single-person verbs, so a refusal
     ("needs NFF", "nobody is following you") lands in the same status line. */
  function sendParty(op, extra) {
    fqStatus = { msg: '', ok: true, pending: true };
    const req = { op: op };
    if (extra && typeof extra === 'object')
      Object.keys(extra).forEach(function (k) { req[k] = extra[k]; });
    toGame('fdNpc', JSON.stringify(req));
    renderQuickCard();
  }

  function quickBtn(icon, label, title, on, opts) {
    return h('button', {
      class: 'fq-btn' + ((opts && opts.danger) ? ' danger' : '')
                      + ((opts && opts.active) ? ' active' : '')
                      + ((opts && opts.armed) ? ' armed' : ''),
      type: 'button',
      disabled: (opts && opts.disabled) ? true : null,
      'aria-pressed': (opts && typeof opts.pressed === 'boolean') ? String(opts.pressed) : null,
      /* The full name behind an abbreviated face ("Distr" → "Distributions").
         Read by screen readers AND by the card's ⌕ action search, which
         completes a clipped face from it — see fqFaceOf. */
      'aria-label': (opts && opts.aria) ? String(opts.aria) : null,
      title: title,
      onClick: (e) => { e.stopPropagation(); on(e); },
    }, h('span', { class: 'fq-btn-ic', 'aria-hidden': 'true' }, icon),
       h('span', { class: 'fq-btn-lbl' }, label));
  }

  /* The party row, shared by both shapes of the card.
   *
   *  It used to render ONLY in the no-target state, which turned out to hide
   *  it almost always: F7 while looking at someone now lands on the Followers
   *  tab WITH a target, so the one surface carrying "sandbox all" was the one
   *  Rober never saw ("i also dont see an NFF sandbox button either").
   *  Orders about EVERYONE do not depend on who you are pointing at, so the
   *  row belongs on both. */
  /* ---- CURRENT PARTY: who is actually following, as clickable faces ------
   *  "add a like current party (current followers) with like a shortcut to
   *  click them in UI and have our normal actions as if we hit f7 on them."
   *
   *  Sits beside the EVERYONE row on the no-target card. The point is reach:
   *  the per-person actions were previously gated on physically looking at
   *  someone, which is impossible for the follower walking behind you and
   *  merely annoying for the rest. Click a face and the card becomes HER card
   *  — same buttons, same behaviour, addressed to her instead of the
   *  crosshair.
   *
   *  Only people who are actually FOLLOWING: this is the party, not the
   *  roster. The roster is the list below, and duplicating 70 rows up here
   *  would bury the thing it is meant to shortcut.
   */
  function partyList() {
    const out = [];
    const fids = new Set();   // formIds already in the party (roster side)
    const norm = (v) => Number(v) >>> 0;
    state.cats.forEach((c) => {
      if (c.index === ALL) return;
      (c.members || []).forEach((m) => {
        if (!m.following || m.dead) return;
        const key = (m.original || m.name || '').toLowerCase();
        if (!key || out.some((x) => (x.original || x.name || '').toLowerCase() === key)) return;
        if (m.formId) fids.add(norm(m.formId));
        out.push(m);   // filed twice = one face
      });
    });
    /* Merge the live scan: a real teammate/follower the FO roster never lists
       (framework-driven companions from custom follower mods, CHIM soft-follow). De-dup by
       formId first (the reliable key — an FO member already shown is skipped),
       then by name as a fallback. Synthesised as a normal member so crewPair /
       portraitFor treat it exactly like a roster face; `live:true` marks it for
       anything that wants to know it has no FO row to act on. */
    (state.liveParty || []).forEach((r) => {
      if (!r || r.dead || r.following === false) return;
      const fid = r.formId ? norm(r.formId) : 0;
      const nm = (r.name || '').trim();
      if (fid && fids.has(fid)) return;
      const nkey = nm.toLowerCase();
      if (!nm || out.some((x) => (x.original || x.name || '').toLowerCase() === nkey)) return;
      if (fid) fids.add(fid);
      out.push({
        name: nm, original: nm, formId: r.formId,
        following: true, dead: !!r.dead, waiting: false, live: true,
        file: r.file, ext: r.ext, mtime: r.mtime,
      });
    });
    return out;
  }

  /* Pick this party member as the card's subject — the F7-on-her behaviour.
     Shared so the face AND the name fire the exact same thing. */
  function pickCrew(m, e) {
    if (e) e.stopPropagation();
    ui.fqPick = m.original || m.name;
    /* On the Followers tab a pick opens the DEDICATED F7 view for her — the
       same full-pane card F7-on-her gives you — pinned so a crosshair refresh
       cannot swap her out. Elsewhere (the Hotkeys tab's quick card) the card
       simply becomes hers, as before. */
    const fq = typeof document !== 'undefined' ? document.getElementById('fq-card') : null;
    if (isActive() && !(fq && quickHost === fq)) {
      if (enterFocus()) return;
    }
    renderQuickCard();
    syncQuickHere();
  }

  /* One face + name, shared by both groups so a waiting follower is visibly
     the SAME control as an active one, only dimmed.
     The face is an <img> INSIDE the button, not a background-image: a saved
     crop is a transform applyCropTo paints onto the image element, and a
     background can't take it — the strip was the one surface still showing
     everyone's uncropped framing after an Adjust. The button owns the circle
     and clips (same wrapper-vs-face split as .medal.img / .medal-face). */
  function crewFace(m, dim) {
    const p = portraitFor(m);
    const btn = h('button', {
      class: 'fq-crew-face' + (p ? '' : ' initials') + (dim ? ' waiting' : ''),
      type: 'button',
      title: m.name + (dim ? ' — waiting' + (m.where ? ' at ' + m.where : '') +
                             '. Click to act on her anyway.'
                           : ' — act on her without looking at her'),
      onClick: (e) => pickCrew(m, e),
    }, p ? null : String(m.name || '?').trim().charAt(0).toUpperCase());
    if (p) {
      const plain = portraitSrc(p);
      const face = h('img', {
        class: 'fq-crew-img',
        src: plain + (!p.abs && p.mtime ? '?v=' + p.mtime : ''),
        alt: '',
        draggable: 'false',
      });
      /* Same two-step fallback as medalEl: Ultralight's loader can treat the
         cache-bust query as part of the filename, so retry the plain path
         once; a file that is really gone degrades to the initial letter. */
      let retried = false;
      face.addEventListener('error', function () {
        if (!retried) { retried = true; face.src = plain; return; }
        face.remove();
        btn.classList.add('initials');
        btn.textContent = String(m.name || '?').trim().charAt(0).toUpperCase();
      });
      btn.append(face);
      /* Fit AFTER the face is inside .fq-crew-face (static + overflow:hidden in
         CSS) — hd-facefit's layout crop goes absolute and must be able to force
         the button to contain it, or it escapes to the pane. See medalEl. */
      if (p.abs) faceFitEnsure(face, p.file);
      else applyCropTo(face, p.file);
    }
    return btn;
  }

  function crewPair(m, dim) {
    const pair = h('span', { class: 'fq-crew-pair' + (dim ? ' waiting' : '') });
    pair.append(crewFace(m, dim));
    /* The NAME is a second hit-target for the same pick — Rober, 2026-08-06:
       "make the name / text also trigger this." A button, so it carries the
       keyboard focus/Enter path and hover for free; styled flat so the strip
       still reads as face + label, not two buttons. */
    const name = h('button', {
      class: 'fq-crew-name',
      type: 'button',
      title: m.name + (dim ? ' — waiting. Click to act on her anyway.'
                           : ' — act on her without looking at her'),
      onClick: (e) => pickCrew(m, e),
    }, m.name);
    pair.append(name);
    return pair;
  }

  /* A section eyebrow that folds. "ability to close current party stuff (close
     chevron)" — Rober, 2026-08-03: with a real party the strip plus the
     EVERYONE row is most of the card, and when you came for the person under
     the crosshair it is all in the way. Session state, not config: a fold is a
     glance-level preference, and one that survived a restart would hide a
     whole block from someone who had forgotten they closed it. */
  function foldEyebrow(key, label, extra) {
    const open = !ui[key];
    const head = h('button', {
      class: 'fq-eyebrow fq-fold' + (open ? ' open' : ''),
      type: 'button', 'aria-expanded': String(open),
      title: open ? 'Hide this section' : 'Show this section',
      /* Toggle from the CURRENT state, not from the `open` this node was built
         with: the click re-renders and replaces this button, so a second click
         on a node something still holds a reference to would otherwise re-send
         the same value and the section would never come back. */
      onClick: (e) => { e.stopPropagation(); ui[key] = !ui[key]; renderQuickCard(); },
    },
      h('span', { class: 'fq-fold-caret' }, open ? '\u25be' : '\u25b8'),
      label,
      extra || null);
    return head;
  }

  /* When the Everyone bar and Current-party strip share ONE master chevron
     (Rober, 2026-08-05: "everyone and current party chevron is pointless, one
     chevron to close the entire thing"), their own per-section folds are
     suppressed: this flag turns their foldEyebrow into a plain label and stops
     them honouring their individual fold state. */
  let ebNoFold = false;
  function sectionLabel(label, extra) {
    return h('div', { class: 'fq-eyebrow fq-section-lbl' }, label, extra || null);
  }

  function partyStrip() {
    const list = partyList();
    if (!list.length) return null;

    /* WITH YOU vs WAITING. Someone told to wait is still "following" as far as
       the game is concerned, so an undivided strip put the follower at your
       back and the one parked in an inn three holds away side by side, looking
       equally available. They are not the same thing. */
    const here = list.filter((m) => !m.waiting);
    const away = list.filter((m) => m.waiting);

    const wrap = h('div', { class: 'fq-party fq-crew' });
    /* Count-responsive sizing (Rober, 2026-08-06): a small party gets big,
       readable faces + names; the strip COMPACTS as the party grows so a large
       retinue still fits. Tier is by who is AT YOUR BACK — the row always shown
       — so telling one follower to wait doesn't shrink the rest. */
    const nHere = here.length;
    wrap.classList.add(nHere <= 2 ? 'crew-xl'
                     : nHere <= 4 ? 'crew-lg'
                     : nHere <= 7 ? 'crew-md' : 'crew-sm');
    const crewExtra = h('span', null,
      h('span', { class: 'fq-crew-n' }, ' ' + here.length),
      away.length ? h('span', { class: 'fq-crew-n dim' }, ' \u00b7 ' + away.length + ' waiting') : null);
    wrap.append(ebNoFold ? sectionLabel('Current party', crewExtra)
                         : foldEyebrow('fqCrewFold', 'Current party', crewExtra));
    if (!ebNoFold && ui.fqCrewFold) return wrap;   // folded: the eyebrow IS the section

    if (here.length) {
      const row = h('div', { class: 'fq-crew-row' });
      here.forEach((m) => row.append(crewPair(m, false)));
      wrap.append(row);
    } else {
      wrap.append(h('div', { class: 'fq-crew-none' },
        'Nobody at your back — everyone is waiting.'));
    }

    /* The waiting group, behind a chevron. Collapsed by default and never
       shown at all when nobody is waiting, so the control only exists when it
       has something to reveal. */
    if (away.length) {
      const open = !!ui.fqWaitOpen;
      const toggle = h('button', {
        class: 'fq-crew-toggle' + (open ? ' open' : ''),
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        title: open ? 'Hide the ones waiting' : 'Show the ' + away.length + ' waiting',
        onClick: (e) => { e.stopPropagation(); ui.fqWaitOpen = !ui.fqWaitOpen; renderQuickCard(); },
      },
        h('span', { class: 'fq-crew-chev', 'aria-hidden': 'true' }, open ? '\u25be' : '\u25b8'),
        h('span', null, 'Waiting'),
        h('span', { class: 'fq-crew-n' }, ' ' + away.length));
      wrap.append(toggle);
      if (open) {
        const row = h('div', { class: 'fq-crew-row waiting' });
        away.forEach((m) => row.append(crewPair(m, true)));
        wrap.append(row);
      }
    }
    return wrap;
  }

  function partyBlock() {
    const wrap = h('div', { class: 'fq-party' });
    wrap.append(ebNoFold ? sectionLabel('Everyone')
                         : foldEyebrow('fqEveryoneFold', 'Everyone'));
    if (!ebNoFold && ui.fqEveryoneFold) return wrap;
    /* fq-party-acts: an even three-across grid — orders on the first row
       (Teleport · Wait · Attack), the sandbox trio on the second. */
    const acts = h('div', { class: 'fq-acts fq-party-acts' });
    PARTY_ACTS.forEach(function (p) {
      acts.append(quickBtn(p.ic, p.label, p.title, function () {
        if (p.fire) toGame('hdFire', p.fire);
        else sendParty(p.op);
      }));
    });

    /* NFF's own allow-sandboxing setting — a different question from "relax
       now", which is what the two buttons above ask. Shown only when NFF
       actually answered: -1 means we do not know, and a control that guessed
       "off" would invite turning ON something already on.
       FOUR modes, not two (Rober, 2026-08-03: "shouldnt sandbox be a dropdown
       with multiple options?" — yes). It is NFF's `Sandbox Style` dropdown,
       and a two-state toggle could not reach the autobox modes at all AND
       silently flattened a save set to one of them down to plain Allow on the
       next off->on. So: a picker, with NFF's own words. */
    const lvl = (state.nff && typeof state.nff.sandbox === 'number') ? state.nff.sandbox : -1;
    if (lvl >= 0) {
      const style = SANDBOX_STYLES[lvl] || SANDBOX_STYLES[0];
      acts.append(quickBtn(lvl > 0 ? '\u25c9' : '\u25cb', 'Sandbox: ' + style.short,
        'NFF\u2019s Sandbox Style, currently "' + style.label + '".\n'
        + style.help + '\nClick to choose another.',
        function (e) { openSandboxStyle(e.currentTarget, lvl); },
        { active: lvl > 0, pressed: lvl > 0 }));
    }
    wrap.append(acts);
    return wrap;
  }

  /* THE SUBJECT of the quick card. Normally whoever is under the crosshair;
     when you pick someone off the party strip it is her instead, and every
     action addresses her rather than passing null (which means "the crosshair
     snapshot C++ took at open"). Re-resolved from the roster on every call so
     a pick cannot outlive a refresh.

     A FUNCTION, not a local inside buildQuickCard, because the renderer is no
     longer the only thing that needs to know who the card is about: the
     equipped ask has to name the same person, and when those two disagreed the
     card showed a skeleton forever (2026-08-03 — picking someone off the party
     strip asked for the CROSSHAIR's worn set and then waited for hers). */
  function quickSubject() {
    if (ctxEl && ctxEl._dossier) return ctxEl._dossier.subject();
    const hit = ui.fqPick ? rosterEntryFor(ui.fqPick) : null;
    if (hit) return hit.m;
    /* Not on the roster: a LIVE party member (partyList's engine-scan merge —
       a companion run by her own follower mod, CHIM soft-follow). Her chip is
       on the party strip, so clicking it must open HER card, not quietly drop
       the pick and fall back to the idle Everyone card (Rober, 2026-09-23, on
       Caraleth: "i clicked cataleth and this is all i get current party again
       plus everyone???"). She carries a real formId, which is all the card's
       per-person actions address; every roster lookup the card does already
       treats a missing row as "unfiled", so she gets the filing button rather
       than Move controls — the same card an unfiled crosshair NPC gets. */
    const live = ui.fqPick ? liveMemberFor(ui.fqPick) : null;
    if (live) return live;
    if (ui.fqPick) ui.fqPick = '';    // she left the roster AND the party; fall back
    return null;
  }

  function liveMemberFor(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    const list = partyList();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.live || !m.formId) continue;
      if (String(m.original || m.name || '').trim().toLowerCase() === want) return m;
    }
    return null;
  }

  /* One fdEquipped per subject per palette open — no more, and never none.
     Bounded by a SET rather than by a time window: the reply re-renders the
     card, so a time gate turns into a slow poll, and the old "ask once when
     the host element changes" gate never fired again after the first mount
     (the card re-mounts into the SAME node), which is why the readout stopped
     loading at all once its cache had been dropped. */
  let eqAsked = Object.create(null);
  function forgetEquippedAsks() { eqAsked = Object.create(null); }
  function syncQuickEquipped(subj) {
    if (!quickHost) return;
    const k = equippedKey(subj);
    if (state.equipped[k] || eqAsked[k]) return;
    eqAsked[k] = true;
    askEquipped(subj, true);
  }

  /* Whose card the status line belongs to. A refusal about one follower sitting
     under ANOTHER's name is worse than no message at all — it reads as a fact about
     the person you are looking at (2026-08-03, and it was on screen in the
     report). Cleared the moment the subject changes. */
  let fqSubjKey = null;
  function syncQuickStatus(subj) {
    const k = subj ? String(subj.formId || '').toLowerCase()
                   : String((state.target && state.target.formId) || '').toLowerCase();
    if (fqSubjKey !== null && fqSubjKey !== k)
      fqStatus = { msg: '', ok: true, pending: false };
    fqSubjKey = k;
  }

  /* COPY OUTFIT — the checklist reveal under the ⧉ button (Rober, 2026-08-05).
     Reads her worn set (the same fdEquipped items the Equipped block shows,
     each carrying formId+plugin), lets you tick the pieces to keep, names the
     outfit, and hands the survivors to WardrobePane.createOutfitFromItems — one
     implementation, the same wdBuild path a Wardrobe-tab duplicate uses.
     Armour is pre-ticked and non-armour (a torch, a drawn sword) is not: a
     Wardrobe outfit only carries armour, so ticking a weapon is a no-op the
     label warns about rather than a silent drop. */
  function copyOutfitBlock(subj, who) {
    const box = h('div', { class: 'fq-copy' });
    const wp = (typeof window !== 'undefined' && window.WardrobePane
                && typeof window.WardrobePane.createOutfitFromItems === 'function')
               ? window.WardrobePane : null;

    box.append(h('div', { class: 'fq-copy-head' },
      h('span', { class: 'fq-copy-title' }, '⧉ Copy ' + who + '’s outfit'),
      h('span', { class: 'fq-copy-sub' }, 'into a new Wardrobe outfit')));

    if (!wp) {
      box.append(h('div', { class: 'fq-copy-msg bad' },
        'The Wardrobe system isn’t loaded, so there’s nowhere to copy the outfit to.'));
      return box;
    }

    const eq = equippedFor(subj || null);
    if (!eq) {
      box.append(h('div', { class: 'fq-copy-msg' }, 'Reading what ' + who + ' is wearing…'));
      return box;
    }
    if (!eq.ok) {
      box.append(h('div', { class: 'fq-copy-msg bad' },
        eq.msg || 'Could not read what ' + who + ' is wearing.'));
      return box;
    }
    const items = eq.items || [];

    /* (Re)seed the tick-map, name and any result line when the SUBJECT changes —
       keyed by form id so a fresh crosshair target starts clean rather than
       inheriting the last person's ticks. */
    const key = String((subj && subj.formId) || (state.target && state.target.formId) || '');
    if (ui.fqCopyFor !== key) {
      ui.fqCopyFor = key;
      ui.fqCopyKeep = Object.create(null);
      items.forEach((it, n) => { ui.fqCopyKeep[n] = (String(it.kind || '') === 'armor'); });
      ui.fqCopyName = who + '’s outfit';
      ui.fqCopyMsg = null;
    }
    if (!ui.fqCopyKeep) ui.fqCopyKeep = Object.create(null);

    if (ui.fqCopyMsg)
      box.append(h('div', { class: 'fq-copy-msg' + (ui.fqCopyMsg.ok ? ' ok' : ' bad') },
        ui.fqCopyMsg.text));

    if (!items.length) {
      box.append(h('div', { class: 'fq-copy-msg' },
        eq.dead ? who + ' has nothing on.' : who + ' has nothing worn to copy.'));
      return box;
    }

    box.append(h('label', { class: 'fq-copy-name' },
      h('span', { class: 'fq-copy-name-lbl' }, 'Name'),
      h('input', {
        class: 'fq-copy-in', type: 'text', spellcheck: 'false',
        value: ui.fqCopyName || '', maxlength: '80',
        placeholder: who + '’s outfit',
        onClick: (e) => e.stopPropagation(),
        onInput: (e) => { ui.fqCopyName = e.target.value; },
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));

    const setAll = (fn) => { items.forEach((it, n) => { ui.fqCopyKeep[n] = !!fn(it, n); }); renderQuickCard(); };
    box.append(h('div', { class: 'fq-copy-presets' },
      h('span', { class: 'fq-copy-presets-lbl' }, 'Include'),
      h('button', { class: 'fq-copy-preset', type: 'button', title: 'Tick every worn piece',
        onClick: (e) => { e.stopPropagation(); setAll(() => true); } }, 'All'),
      h('button', { class: 'fq-copy-preset', type: 'button',
        title: 'Tick only the armour / clothing — what a Wardrobe outfit is made of',
        onClick: (e) => { e.stopPropagation(); setAll((it) => String(it.kind || '') === 'armor'); } }, 'Armour only'),
      h('button', { class: 'fq-copy-preset', type: 'button', title: 'Untick everything',
        onClick: (e) => { e.stopPropagation(); setAll(() => false); } }, 'None')));

    const list = h('div', { class: 'fq-copy-list' });
    items.forEach((it, n) => {
      const on = !!ui.fqCopyKeep[n];
      const kind = String(it.kind || 'other');
      const nonArmor = kind !== 'armor';
      const row = h('button', {
        class: 'fq-copy-row' + (on ? ' on' : '') + (nonArmor ? ' nonarmor' : ''),
        type: 'button',
        title: (on ? 'Included — click to exclude' : 'Excluded — click to include')
             + (nonArmor ? '\nNot clothing: a Wardrobe outfit only carries armour, so this piece won’t apply.' : ''),
        onClick: (e) => { e.stopPropagation(); ui.fqCopyKeep[n] = !ui.fqCopyKeep[n]; renderQuickCard(); },
      },
        h('span', { class: 'fq-copy-check', 'aria-hidden': 'true' }, on ? '☑' : '☐'),
        (function () { const ei = eqIcon(it); return h('span', { class: 'fq-copy-ic', title: ei.lbl }, ei.ic); })(),
        h('span', { class: 'fq-copy-nm' }, it.name));
      if (it.count > 1) row.append(h('span', { class: 'fq-copy-ct' }, '×' + it.count));
      if (it.outfit) row.append(h('span', { class: 'fq-copy-tag', title: 'Part of her default outfit' }, 'outfit'));
      list.append(row);
    });
    box.append(list);

    const nPick = items.filter((it, n) => ui.fqCopyKeep[n]).length;
    box.append(h('div', { class: 'fq-copy-foot' },
      h('button', {
        class: 'fq-copy-create', type: 'button',
        disabled: nPick ? null : true,
        title: nPick ? 'Create a Wardrobe outfit from the ' + nPick + ' ticked piece'
                        + (nPick === 1 ? '' : 's')
                     : 'Tick at least one piece first',
        onClick: (e) => {
          e.stopPropagation();
          const nm = (ui.fqCopyName || '').trim() || (who + '’s outfit');
          const pick = items.filter((it, i) => ui.fqCopyKeep[i]);
          const res = wp.createOutfitFromItems(nm, pick);
          if (res && res.ok) {
            ui.fqCopyMsg = { ok: true,
              text: '✓ Saved “' + res.name + '” to the Wardrobe — ' + res.count
                  + ' piece' + (res.count === 1 ? '' : 's') + '.' };
          } else {
            ui.fqCopyMsg = { ok: false, text: (res && res.msg) ? res.msg : 'Nothing to copy.' };
          }
          renderQuickCard();
        },
      },
        h('span', { class: 'fq-btn-ic', 'aria-hidden': 'true' }, '⧉'),
        h('span', null, 'Create outfit' + (nPick ? ' (' + nPick + ')' : '')))));

    return box;
  }

  /* ======================================================================== *
   *  ⌕ FIND AN ACTION — the quick card's own typeable search  (2026-08-19)
   *
   *  Rober: "NEED A TYPEABLE search bar here that populates with EVERYTHING in
   *  the buttons below, including their popouts, that allows you to quickly do
   *  a button call from the search, typing pops out a nicely polished ui popout
   *  modal."
   *
   *  ---- WHY IT WALKS THE DOM RATHER THAN A HAND-WRITTEN LIST --------------
   *  This card is ~1,400 lines of buttons and it grows every week (Trade,
   *  Distr, Tune and Add-as-mount all landed inside a fortnight). A list of
   *  actions maintained beside it would be wrong the day after it was written,
   *  and nothing would say so. So the index is READ OFF THE RENDERED CARD:
   *  every <button> the card drew is an action, its label is its label and its
   *  `title` — the same string app.js's #hd-tip layer already draws on hover —
   *  is its description AND its search keywords. A button added tomorrow is
   *  searchable tomorrow, with no edit here. Same law as the HDOmni providers,
   *  one surface down.
   *
   *  ---- THE POPOUTS ------------------------------------------------------
   *  Two different kinds hang off this card, and they are indexed differently
   *  on purpose:
   *
   *   · A MODULE MODAL (⛨ Outfit's dock, 📜 Quests, ⚒ Tune, 💬 CHIM, ⛔ Room
   *     ban, ⛬ Formation, ⮌ Send back…, ⚑ Set a spot…, ＋ File…). Its opener
   *     IS a button on the card, so the live walk already has it; running it
   *     opens that module exactly as clicking would — anchored on the real
   *     button, which is what those APIs measure themselves against. We do not
   *     reach inside them: each owns its own searchable UI already.
   *
   *   · A REVEAL the card draws ITSELF when a ui flag is set (the framing pad,
   *     the note fields, the facelight/SPID/debug blocks, and — only on a view
   *     where hd-outfit.js failed to load — the inline clothes rows). Those
   *     buttons are real card buttons that simply are not on screen yet, so
   *     they ARE indexed: the card is rebuilt once into a DETACHED node with
   *     the flag flipped, walked, and thrown away. Firing one sets the flag
   *     for real, re-renders, and clicks the button that then exists. No verb
   *     is re-implemented anywhere in here — every hit ends in a .click() on
   *     the card's own control.
   *
   *  ⚠ The inline clothes reveal is probed ONLY when window.HDOutfit is
   *  missing. With the dock present those rows are the retired path (see the
   *  ⛨ Outfit button); surfacing them through search would put two
   *  implementations of "wear this set" on screen at once.
   *
   *  ---- WHY THE POPOUT IS AN #overlay CHILD ------------------------------
   *  #fd-quick is `overflow-y: auto`, so a dropdown mounted inside the card is
   *  clipped by it and scrolls away with the content. It therefore mounts
   *  beside #fd-ctx-menu, wears `transform: scale(--ui-scale)` itself and
   *  multiplies its clamps by deckScale() — the same three rules that keep
   *  every other menu on this pane on screen at ⛶ Fill.
   *
   *  ---- WHY TYPING NEVER RE-RENDERS THE CARD -----------------------------
   *  renderQuickCard() replaces the whole card, taking the focused input with
   *  it (the lesson the rank slider and the preset search already taught this
   *  file). So a keystroke repaints ONLY the popout; the card is re-read for
   *  the index when something else re-renders it, and fqFindRestore() puts the
   *  caret back.
   *
   *  Marker: fq-find-actions (view identity).
   * ======================================================================== */

  const FQF = {
    open: false, q: '', sel: 0, rows: [], partial: false,
    popEl: null, listEl: null, headEl: null,
    probe: [], probeKey: '', probeAt: 0,
  };
  /* True while a DETACHED card is being built for the reveal probe. The three
     ask* nudges at the foot of the action row are throttled, not free, and a
     probe must not put bridge traffic on the wire for a card nobody sees. */
  let fqProbing = false;

  function fqTidy(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function fqHasWord(s) { return /[0-9A-Za-z]/.test(String(s || '')); }

  /* ---- what you CALL it vs what the button SAYS (fq-find-aliases) ---------
     Rober, 2026-09-14, typing "teleport back" on Elana's card: "No action
     matches" — when ⤵ Summon, ➜ Go to and ⮌ Send back… were all right there
     on the MOVE row. The card names its buttons in its own voice ("Summon",
     "Send back…") and the search only knew that voice, so the word a player
     reaches for first — teleport — found nothing except the Everyone row.

     Keyed by the button's label with its glyph, trailing "…" and ": On/Off"
     state stripped (fqLabelKey), so a state chip and its plain twin share one
     entry. The value is the vocabulary a person might type INSTEAD of the
     label — never a second implementation of anything, just words. A hit
     here ranks under a label hit and over a section hit: "teleport" lists
     Summon / Go to / Send back… under the literal ⤵ Teleport (Everyone). */
  const FQ_ALIASES = {
    'summon':            'teleport bring call fetch come here to me',
    'go to':             'teleport travel warp visit jump find',
    'send back':         'teleport return undo send to where they were home domain',
    'where they were':   'teleport back return undo summon previous location',
    'teleport':          'summon everyone all bring party gather to me',
    'wait':              'stay hold stop everyone',
    'wait here':         'stay hold stop stand',
    'follow me':         'come follow',
    'stop':              'halt everyone',
    'sandbox':           'relax idle wander chill everyone',
    'her sandbox':       'relax idle wander',
    'dismiss':           'fire release go home leave remove follower',
    'recruit':           'follow hire join take',
    'freeze':            'hold still stop statue pause pin',
    'grab':              'drag move carry pick up drop',
    'formation':         'arrange spacing line walk with me',
    'track':             'map marker locate find where',
    'stop tracking':     'map marker untrack',
    'track on map':      'marker locate find where',
    'stop tracking on map': 'marker untrack',
    'home is here':      'set home live here mhiyh my home is your home',
    'set a spot':        'spot marker home',
    'nff base':          'base nether follower framework home',
    'her home':          'mhiyh my home is your home',
    'her nff base':      'nether follower framework home',
    'add to framework':  'nff nether import',
    'remove from framework': 'nff nether',
    'inventory':         'items loot bag carry',
    'trade':             'give take gold items barter',
    'spare':             'chest storage stash',
    'outfit':            'clothes wardrobe wear dress armor gear',
    'portrait':          'photo picture face capture screenshot',
    'full stats':        'sheet skills level stats',
    'debug':             'dump engine factions',
    'adjust':            'tune scale size',
    'quests':            'journal quest',
    'chim':              'ai talk prompt voice',
    'notes':             'edit fields note',
    'tune':              'adjust stats',
    'dismiss all':       'everyone release',
  };

  /* The lookup key for a label: lowercase, glyph off the front, "…" and a
     ": state" tail off the back. "☾ Her sandbox: Off" → "her sandbox". */
  function fqLabelKey(label) {
    let t = fqTidy(label).toLowerCase();
    t = t.replace(/^[^0-9a-z]+/, '');
    t = t.replace(/\s*[:：].*$/, '');
    t = t.replace(/[…]+$/, '').replace(/\.\.\.$/, '');
    return fqTidy(t);
  }
  function fqAliasFor(label) {
    const k = fqLabelKey(label);
    if (!k) return '';
    if (FQ_ALIASES[k]) return FQ_ALIASES[k];
    /* "Send Lydia to…" / "Stop tracking Lydia on the map": the longest key
       the label STARTS with, so a name baked into a label still lands. */
    let best = '';
    Object.keys(FQ_ALIASES).forEach(function (key) {
      if (k.indexOf(key + ' ') === 0 && key.length > best.length) best = key;
    });
    return best ? FQ_ALIASES[best] : '';
  }

  /* Light stemming for the query: "teleporting" / "teleports" / "summoned"
     should find the same buttons as the bare verb. Returns the term and its
     shorter forms, longest first; nothing shorter than three letters. */
  function fqStems(t) {
    const out = [t];
    const push = function (x) { if (x.length >= 3 && out.indexOf(x) < 0) out.push(x); };
    if (/ing$/.test(t)) push(t.slice(0, -3));
    if (/ies$/.test(t)) push(t.slice(0, -3) + 'y');
    if (/es$/.test(t))  push(t.slice(0, -2));
    if (/ed$/.test(t))  push(t.slice(0, -2));
    if (/s$/.test(t))   push(t.slice(0, -1));
    return out;
  }

  /* One typo of slack — a letter wrong, missing, extra, or two swapped —
     between a typed term and a word on the card. Only for terms of four
     letters or more (with three, everything is one edit from everything),
     and only word-vs-word, never against a whole sentence. Bounded
     Damerau–Levenshtein; bails as soon as the answer is "more than one". */
  function fqNear(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (la < 4 || Math.abs(la - lb) > 1) return false;
    if (la === lb) {
      let d = 0, first = -1;
      for (let i = 0; i < la; i++) {
        if (a.charAt(i) !== b.charAt(i)) { d++; if (first < 0) first = i; if (d > 2) return false; }
      }
      if (d <= 1) return true;
      return d === 2 && first + 1 < la && a.charAt(first) === b.charAt(first + 1)
        && a.charAt(first + 1) === b.charAt(first);          // transposition
    }
    const s = la < lb ? a : b, l = la < lb ? b : a;         // l is one longer
    let i = 0, j = 0, skipped = false;
    while (i < s.length && j < l.length) {
      if (s.charAt(i) === l.charAt(j)) { i++; j++; continue; }
      if (skipped) return false;
      skipped = true; j++;
    }
    return true;
  }
  function fqWordsOf(text) {
    return String(text || '').toLowerCase().split(/[^0-9a-z]+/).filter(function (w) { return !!w; });
  }

  /* A title is a sentence (often several). The row's SUBTITLE is the whole
     thing on one line, clamped by CSS; a label derived from a title takes only
     its first clause, because "Replace Lydia's portrait" is a name and the
     rest is the explanation under it. */
  function fqFirstClause(title) {
    let t = fqTidy(String(title || '').split('\n')[0]);
    const dash = t.indexOf(' — ');
    if (dash > 8) t = t.slice(0, dash);
    const dot = t.indexOf('. ');
    if (dot > 8) t = t.slice(0, dot);
    if (t.length > 64) t = t.slice(0, 63).replace(/[\s,;:]+\S*$/, '') + '…';
    return t;
  }

  /* Section names for buttons that do not sit under a labelled group. Order
     matters: the first class that matches wins, so the specific ones lead. */
  const FQ_SECT_CLASS = [
    ['fq-headacts', 'This person'],
    ['fq-wedge', 'Repair'],
    ['fq-crew', 'Party'],
    ['fq-everyone-top', 'Everyone'],
    ['fq-party', 'Everyone'],
    ['fq-eqs', 'Equipped'],
    ['fq-equip', 'Equipped'],
    ['fq-copy', 'Copy outfit'],
    ['fq-framing', 'Frame'],
    ['fq-edit', 'Notes'],
    ['fq-rank', 'Relationship'],
    ['fq-acts', 'Actions'],
    ['fq-sets', 'Clothes'],
    ['fq-orders', 'Orders'],
  ];

  /* A group label reads as a NAME ("Order", "Fill", "Everyone") — but the
     elements that carry it also hold carets, counts and whole sentences
     ("Equipped" wraps a − 100% ＋ stepper; the debug eyebrow is a sentence).
     Take the element's OWN text nodes, cut at the first separator, drop a
     leading glyph, and refuse anything still long enough to be prose — a bad
     section name is worse than falling through to the class map. */
  function fqSectText(el) {
    let t = '';
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 3) t += kids[i].nodeValue;
    t = fqTidy(t) || fqTidy(el.textContent);
    const dot = t.indexOf(' · ');
    if (dot > 0) t = t.slice(0, dot);
    const dash = t.indexOf(' — ');
    if (dash > 0) t = t.slice(0, dash);
    const m = /^[^\s0-9A-Za-z]{1,2}\s*(.+)$/.exec(t);
    if (m) t = m[1];
    t = fqTidy(t).replace(/[…:]+$/, '');
    return (t.length && t.length <= 22) ? t : '';
  }

  /* The group a button belongs to, read off the card the same way a human
     reads it: the labelled chip at the head of its row wins, and only when
     there is none do we fall back to the row's class. */
  function fqSectOf(btn, card) {
    let n = btn.parentNode, guard = 0;
    while (n && n !== card && n.nodeType === 1 && guard++ < 8) {
      const kids = n.children || [];
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (!c.classList) continue;
        if (c.classList.contains('fq-sets-lbl') || c.classList.contains('fq-section-lbl')
            || c.classList.contains('fq-eyebrow')) {
          const lbl = fqSectText(c);
          if (lbl) return lbl;
        }
      }
      for (let j = 0; j < FQ_SECT_CLASS.length; j++) {
        if (n.classList && n.classList.contains(FQ_SECT_CLASS[j][0])) return FQ_SECT_CLASS[j][1];
      }
      n = n.parentNode;
    }
    return 'Card';
  }

  /* icon + label, from whichever shape of button this is: the icon-mode action
     buttons (.fq-btn-ic + .fq-btn-lbl), the chip buttons whose whole label is
     "⚔ Recruit", the party faces, and the head's glyph-only icon buttons —
     which have no words at all and borrow the first clause of their tooltip. */
  function fqFaceOf(btn) {
    const icEl = btn.querySelector ? btn.querySelector('.fq-btn-ic, .fq-cg-ic') : null;
    const lblEl = btn.querySelector
      ? btn.querySelector('.fq-btn-lbl, .fd-ctx-lbl, .fq-crew-name') : null;
    let icon = icEl ? fqTidy(icEl.textContent) : '';
    let label = fqTidy(lblEl ? lblEl.textContent : btn.textContent);
    if (!lblEl && icon && label.indexOf(icon) === 0) label = fqTidy(label.slice(icon.length));
    if (!icon) {
      /* ⚠ `\s*`, not `\s+` (2026-08-19 design pass). A button that renders its
         chevron as its own <span> and the word as a bare text node has NO
         space between them, so the old rule could not split it and the results
         list showed "▾Everyone" — a caret welded to the word, in a list whose
         every other row is a clean name. The tail is pinned to an alphanumeric
         so a label that legitimately opens on punctuation is never carved up. */
      const m = /^([^\s0-9A-Za-z]{1,2})\s*([0-9A-Za-z].*)$/.exec(label);
      if (m) { icon = m[1]; label = fqTidy(m[2]); }
    }
    const title = fqTidy(btn.getAttribute && btn.getAttribute('title'));
    /* A glyph-only control (the head's ◉ ⚭ ✎ ⤢, a party face's initial, the
       "Aa" labels toggle) has no words to search — so it borrows the first
       clause of the tooltip app.js already draws on hover, and the glyph
       becomes its icon. That is what makes those buttons findable at all. */
    if (!fqHasWord(label) || label.length <= 2) {
      const aria = fqTidy(btn.getAttribute && btn.getAttribute('aria-label'));
      /* aria-label BEFORE the tooltip: a tooltip is written for the state the
         button is in ("Lydia is dead"), so a disabled glyph button would be
         indexed under its refusal instead of its name. The head's icon buttons
         carry an aria-label for exactly this reason. */
      if (aria || title) {
        if (!icon || icon === '·') icon = label || '·';
        label = aria || fqFirstClause(title);
      }
    }
    /* …and a face that is an ABBREVIATION of its own accessible name takes the
       full word (2026-08-19 design pass). The card's buttons are small, so some
       wear a clipped face — "Distr" for Distributions — which is fine ON the
       card, beside its icon, and useless in a search whose entire job is to
       find things BY NAME (measured: "Distr" sat in a 640px-wide results row
       with three lines of room). Gated on the aria-label STARTING with the
       face, so this can only ever complete a word, never rename a button to
       something unrelated — and the aria-label is the honest place for it,
       because a screen reader was reading "Distr" too. */
    const ariaFull = fqTidy(btn.getAttribute && btn.getAttribute('aria-label'));
    if (ariaFull && ariaFull.length > label.length &&
        ariaFull.toLowerCase().indexOf(label.toLowerCase()) === 0) label = ariaFull;
    return { icon: icon || '·', label: label, title: title };
  }

  function fqFindCard() {
    return (quickHost && quickHost.querySelector) ? quickHost.querySelector('.fq') : null;
  }

  /* Walk one card (live or probe) and hand back its actions. */
  function fqScan(card, reveal) {
    const rows = [];
    if (!card || !card.querySelectorAll) return rows;
    const btns = card.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      /* our own chrome is not an action */
      if (b.closest && b.closest('.fq-find')) continue;
      const face = fqFaceOf(b);
      if (!face.label && !face.title) continue;
      if (!fqHasWord(face.label)) continue;      // a glyph with no words and no tooltip
      const sect = fqSectOf(b, card);
      const off = !!(b.disabled || b.getAttribute('aria-disabled') === 'true');
      rows.push({
        key: sect + '' + face.label + '' + face.icon,
        icon: face.icon,
        label: face.label,
        sub: face.title,
        sect: sect,
        disabled: off,
        /* A disabled control on this card always says WHY in its tooltip —
           that is the card's own law ("the inapplicable one is disabled with a
           reason"), so the reason is already written and we just show it. */
        why: off ? (face.title || 'Not available for this person right now') : '',
        opens: /…$/.test(face.label) || b.getAttribute('aria-haspopup') === 'true',
        reveal: reveal || '',
        el: b,
      });
    }
    return rows;
  }

  /* Which self-drawn reveals are worth probing on THIS build. */
  function fqRevealFlags() {
    const inlineClothes = !window.HDOutfit;   // the dock replaced these rows
    const out = ['fqEdit', 'fqLight', 'fqSpid', 'fqDebug', 'fqFraming'];
    if (inlineClothes) { out.push('fqSets'); out.push('fqCopy'); }
    return out;
  }

  /* Build the card once per closed reveal, walk it, throw it away. Bounded to
     one pass per 1.5 s per subject: the card re-renders on every bridge push
     and re-probing on each of them would build the whole card five times for
     nothing. */
  function fqProbeRows(subjKey) {
    const now = Date.now();
    if (FQF.probeKey === subjKey && (now - FQF.probeAt) < 1500) return FQF.probe;
    const rows = [];
    fqRevealFlags().forEach(function (flag) {
      if (ui[flag]) return;                     // already on screen: the live walk has it
      let node = null;
      ui[flag] = true;
      fqProbing = true;
      try { node = buildQuickCard(); } catch (e) { node = null; }
      fqProbing = false;
      ui[flag] = false;
      if (node) fqScan(node, flag).forEach(function (r) { rows.push(r); });
    });
    FQF.probe = rows;
    FQF.probeKey = subjKey;
    FQF.probeAt = now;
    return rows;
  }

  /* Who the card is about, as a cache key for the reveal probe. NOT the
     module-level `fqSubjKey` above — that one is the equipped-ask's own state
     and means something else. */
  function fqFindSubjKey() {
    const s = quickSubject();
    if (s) return 'p:' + (s.original || s.name || '');
    return 'c:' + ((state.target && (state.target.name + ':' + state.target.formId)) || '');
  }

  /* ---- actions the card cannot DRAW right now --------------------------
     The ORDER row is one status button deep on purpose: it shows the single
     thing that is actually available, so the slot never offers a control the
     game would refuse. That is right on screen and wrong in SEARCH — you type
     a verb to find out whether it exists at all, and a word that returns
     nothing reads as "this deck cannot do that" rather than "not for her".

     Rober hit exactly that on 2026-09-10: searching "dismiss" on a wife who
     was at home answered "No action matches “dismiss”", when the deck has
     driven NFF's RemoveFollower since the ORDER row was built.

     So these rows exist for every subject and carry their own refusal. A
     disabled row already renders its reason and never fires (fqFindFire), so
     this adds an ANSWER, never a dead button. */
  function fqVirtualRows() {
    const t = state.target;
    if (!t || !t.name || t.dead) return [];
    const who = t.name;
    const known = rosterEntryFor(who);   /* same lookup buildQuickCard uses */
    const nffManaged = !!(known && known.m && known.m.nffManaged);
    const rows = [];

    /* ⊘ Dismiss. When she IS following, the ORDER row draws the real button
       and the live scan indexes it — this one dedupes away by key. */
    let why = '';
    /* nffFollower draws a REAL chip in ORDER now, so there is nothing to
       explain — and the live row would win the dedupe anyway. */
    if (!t.following && !t.nffFollower) {
      if (t.wedged) {
        why = who + '\u2019s follower state is broken, so NFF has nothing to '
          + 'dismiss \u2014 use \u201cRepair follower state\u201d in Order first.';
      } else if (nffManaged) {
        why = 'NFF has ' + who + ' in its framework, but does not list her as one of '
          + 'your followers \u2014 there is nothing to dismiss. Use Remove from '
          + 'framework to take her out of NFF.';
      } else if (t.canFollow === false) {
        why = who + ' is not following you, and cannot be asked to \u2014 she is not '
          + 'one of the game\u2019s potential followers.';
      } else {
        why = who + ' is not following you, so there is nothing to dismiss. '
          + '\u2694 Recruit is in Order.';
      }
      rows.push({
        key: 'Order\u0001Dismiss\u0001\u2298',
        icon: '\u2298',
        label: 'Dismiss',
        sub: 'Send her home through Nether\u2019s Follower Framework',
        sect: 'Order',
        disabled: true,
        why: why,
        opens: false,
        reveal: '',
        el: null,
      });
    }
    return rows;
  }

  /* ---- the ⮌ Send back… picker, flattened (fq-find-sendto) --------------
     The picker is a module modal, and the rule above says we do not reach
     inside those — but its rows are the ONE place the deck can put someone
     back where she stood before a summon, and "teleport back" / "where she
     was" / "send her home" are exactly what gets typed. So its destinations
     are indexed as rows of their own, gated the way the MOVE row is (someone
     Follower Organizer has, in the world), and fire the same senders the
     picker's own buttons call — through `run`, since there is no card button
     to click until the picker is open. Not in the world: the rows stay,
     disabled, and say why. Domain marks ride along, capped, because the
     picker is typeable for a reason. */
  function fqSendToRows() {
    const t = state.target;
    if (!t || !t.name || t.dead) return [];
    const known = rosterEntryFor(t.name);
    if (!known || !known.m) return [];
    const m = known.m, cat = known.cat.index, idx = known.idx, who = m.name || t.name;
    const off = !m.inWorld;
    const why = off ? who + ' is not in the world right now \u2014 nothing to move.' : '';
    const mk = function (icon, label, sub, run) {
      return { key: 'Send to\u0001' + label + '\u0001' + icon, icon: icon, label: label,
               sub: sub, sect: 'Send to', disabled: off, why: why, opens: false,
               reveal: '', el: null, run: off ? null : run };
    };
    const rows = [];
    rows.push(mk('\u2B8C', 'Where they were',
      'Back where ' + who + ' stood before you summoned them \u2014 undo the summon',
      function () { sendWorld('sendback', cat, idx, '\u2B8C ' + who + ' returns'); }));
    if (m.mhHome)
      rows.push(mk('\u2302', 'Her home', 'Send ' + who + ' to ' + String(m.mhHome) + ' (My Home Is Your Home)',
        function () { sendNpc('sendHome', m, { dest: 'mhiyh' }); }));
    if (m.nffHome)
      rows.push(mk('\u2302', 'Her NFF base', 'Send ' + who + ' to ' + String(m.nffHome) + ' (Nether\u2019s Follower Framework)',
        function () { sendNpc('sendHome', m, { dest: 'nff' }); }));
    domainMarks().slice(0, 60).forEach(function (mark) {
      if (!mark || !mark.name) return;
      rows.push(mk(mark.interior ? '\u2302' : '\u25B2', String(mark.name),
        'Send ' + who + ' to this domain' + (mark.category ? ' \u00B7 ' + mark.category : ''),
        function () { sendToDomain(m, mark); }));
    });
    return rows;
  }

  /* The whole index: what is on screen, then what a reveal would draw, then
     what this person's state has taken off the card entirely. */
  function fqFindIndex() {
    const card = fqFindCard();
    const live = fqScan(card, '');
    const seen = Object.create(null);
    const out = [];
    const push = function (r) {
      if (seen[r.key]) return;
      seen[r.key] = 1;
      if (r.alias == null) r.alias = fqAliasFor(r.label);
      out.push(r);
    };
    live.forEach(push);
    fqProbeRows(fqFindSubjKey()).forEach(push);
    fqVirtualRows().forEach(push);
    fqSendToRows().forEach(push);
    fqFixRows().forEach(push);
    fqChimRows().forEach(push);
    fqWigRows().forEach(push);
    fqCategoryRows().forEach(push);
    return out;
  }

  /* ---- Wigs… (2026-09-23) --------------------------------------------------
     Rober: "we have a pretty indepth wig picker, id like to add that as a
     popout to a specific npc if i search wig. and the wig i pick immedietly
     gets forced into inventory and equipped for that npc". One row; it opens
     the Wigs pane as a popout aimed at THIS card's subject (WigsPane.openFor),
     where a click wears the wig on her by FormID. The pane is a deferred
     script, so until it has landed the row says so instead of vanishing. */
  function fqWigRows() {
    const t = state.target;
    if (!t || !t.name || t.dead) return [];
    const formId = Number(t.formId) || 0;
    if (!formId) return [];
    const who = t.name;
    const loaded = !!(window.WigsPane && typeof WigsPane.openFor === 'function');
    return [{
      key: 'Look\u0001Wigs\u0001💇',
      icon: h('img', { src: 'icons/custom/hk-wigs.png', width: 28, height: 28, alt: '' }),
      label: 'Wigs\u2026',
      sub: 'Pick a wig \u2014 it goes straight into ' + who + '\u2019s inventory and onto their head',
      sect: 'Look',
      alias: 'wig wigs hair hairstyle hairdo haircut head hair salon try on ks hairdos',
      disabled: !loaded,
      why: loaded ? '' : 'The Wigs pane is still loading \u2014 try again in a moment',
      opens: true,
      reveal: '',
      el: null,
      run: function () {
        if (window.WigsPane && typeof WigsPane.openFor === 'function') WigsPane.openFor({ formId: formId, name: who });
      },
    }];
  }

  /* ---- Change category… (2026-09-23) --------------------------------------
     Rober, with the card's search open on "follower organizer": "not in f7
     menu either". The category chip is scanned as a button, but its words
     are the category's NAME — "change", "move", "group" and "organizer" hit
     nothing. One row that carries those words, opening the same move picker
     the chip does. Unfiled subjects have the chip's own "file them" row. */
  function fqCategoryRows() {
    const t = state.target;
    if (!t || !t.name || t.dead) return [];
    const who = t.name;
    const known = rosterEntryFor(t.original || who) || rosterEntryFor(who);
    if (!known || !known.cat) return [];
    const here = catLabel(known.cat);
    const others = state.cats.filter((c) => c.index !== ALL && c.index !== known.cat.index).length;
    return [{
      key: 'Card\u0001Change category\u0001\u203a',
      icon: '\u203a',
      label: 'Change category\u2026',
      sub: 'Move ' + who + ' out of ' + here + ' into another Follower Organizer group',
      sect: 'Card',
      alias: 'category categories change move switch group folder file filed roster organizer '
           + 'follower organizer recategorize reassign transfer put her in another ' + here.toLowerCase(),
      disabled: !others,
      why: others ? '' : 'Follower Organizer has no other category to move ' + who + ' to',
      opens: true,
      reveal: '',
      el: null,
      run: function () {
        const chip = document.querySelector('.fq-chip-cat');
        openMoveTo(chip && chip.isConnected ? chip : null, known, who, known.m);
      },
    }];
  }

  /* The dropdown is mounted outside this card, so its controls need the same
     explicit search adapter as Fixes. The CHIM module owns the actual action. */
  function fqChimRows() {
    const t = quickSubject() || state.target;
    if (!t || !t.name || !window.ChimBtn || typeof ChimBtn.conversationAction !== 'function') return [];
    const known = rosterEntryFor(t.name);
    const ctx = { original: t.original || (known && known.m && known.m.original) || t.name,
      who: t.name, formId: Number(t.formId) || 0, dead: !!t.dead };
    const actions = [ChimBtn.conversationAction(ctx)];
    if (ChimBtn.conversationReleaseAction) actions.push(ChimBtn.conversationReleaseAction(ctx));
    return actions.map(a => Object.assign({}, a, { sect: 'CHIM', opens: true, reveal: '', el: null,
      icon: h('img', { src: a.iconPath, width: 28, height: 28, alt: '' }) }));
  }

  /* ---- the Fixes verbs, flattened (fq-find-fixes) -----------------------
     The Fixes flyout is a module modal whose buttons exist only while it is
     open, so the live scan never saw them: typing "reset a" returned Preset,
     Lamae's Rest and Grab and nothing else (Rober, 2026-09-21: "it should be
     searchable..."). Past ~10 items an unsearchable list is a defect, and
     this card is at ninety.

     Built FROM FixBtn._fixes rather than restated here - two copies of a verb
     table drift within the hour, and the flyout owns the labels, subs and the
     deadOnly / needsBody gating, which this applies unchanged.

     Stop her following OPENS instead of running: its refusal IS the feature,
     so it goes through the flyout that can show the diagnosis. The other five
     are one-shot engine verbs the flyout already fires on a single click, so
     the search box fires them the same way and the card's status line
     answers. */
  function fqFixRows() {
    const t = state.target;
    if (!t || !t.name) return [];
    if (!window.FixBtn || !Array.isArray(FixBtn._fixes)) return [];
    const formId = Number(t.formId) || 0;
    if (!formId) return [];
    const dead = !!t.dead;
    const ctx = { who: t.name, formId: formId, dead: dead };
    const SEP = String.fromCharCode(1);

    /* What a player actually types when this is what they want. The flyout's
       labels are plain English ("Rebuild her"); the symptom is not. */
    const ALIAS = {
      unfollow:  'unfollow stop following trailing stuck teammate not a follower unstick',
      resetai:   'reset ai resetai re-evaluate evaluate package routine stale stuck unstick',
      recycle:   'recycle recycleactor rebuild t-pose tpose invisible wedged broken glitched',
      calm:      'calm stop fighting combat aggression attacking hostile peace pacify',
      resurrect: 'resurrect revive raise bring back dead corpse',
      noclip:    'noclip tcl collision clip stuck in geometry walk through walls',
    };

    const rows = [];
    FixBtn._fixes.forEach(function (f) {
      if (f.deadOnly && !dead) return;
      if (f.needsBody && dead) return;
      const opens = f.id === 'unfollow';
      rows.push({
        key: ['Fixes', f.label, f.ic].join(SEP),
        icon: f.ic,
        label: f.label,
        sub: f.sub,
        sect: 'Fixes',
        alias: ALIAS[f.id] || '',
        disabled: false,
        why: '',
        opens: opens,
        reveal: '',
        el: null,
        run: opens
          ? function () {
              /* Anchor it under the search bar the query was typed into. */
              const card = fqFindCard();
              const bar = card ? card.querySelector('.fq-find') : null;
              FixBtn.open(bar, ctx);
            }
          : function () { FixBtn.run(ctx, f.id); },
      });
    });
    return rows;
  }

  /* ---- ranking -----------------------------------------------------------
     Label beats section beats tooltip, a word-start beats a mid-word hit, and
     a disabled action sinks below every live one — you are searching for
     something to DO, and an unavailable row that outranked a working one would
     be the search actively getting in the way. Every term must match
     somewhere, so "wait here" and "here wait" both find the same button. */
  /* How well ONE term lands on a row, best hit wins:
       120 label starts with it · 90 a label word starts with it · 80 an alias
       word starts with it · 62 inside a label word · 46 section · 24 tooltip ·
       40 one typo away from a label/alias word. A stemmed form of the term
       ("summoning" → "summon") scores the same tier minus 4, so the exact
       spelling still wins a tie. 0 = this term found nothing on this row. */
  function fqTermScore(r, t) {
    const lbl = r.label.toLowerCase();
    const sect = r.sect.toLowerCase();
    const sub = String(r.sub || '').toLowerCase();
    const alias = String(r.alias || '').toLowerCase();
    const forms = fqStems(t);
    for (let f = 0; f < forms.length; f++) {
      const x = forms[f];
      const dock = f ? 4 : 0;
      const li = lbl.indexOf(x);
      if (li === 0) return 120 - dock;
      if (li > 0) return (/[\s([/·—-]/.test(lbl.charAt(li - 1)) ? 90 : 62) - dock;
      if (alias) {
        const ai = alias.indexOf(x);
        if (ai === 0 || (ai > 0 && alias.charAt(ai - 1) === ' ')) return 80 - dock;
      }
      if (sect.indexOf(x) >= 0) return 46 - dock;
      if (sub.indexOf(x) >= 0) return 24 - dock;
    }
    if (t.length >= 4) {
      const words = fqWordsOf(lbl).concat(fqWordsOf(alias));
      for (let i = 0; i < words.length; i++) if (fqNear(t, words[i])) return 40;
    }
    return 0;
  }

  /* Every term against one row: how many landed, and the summed score. */
  function fqScoreTerms(r, terms) {
    let n = 0, score = 0;
    for (let i = 0; i < terms.length; i++) {
      const s = fqTermScore(r, terms[i]);
      if (s) { n++; score += s; }
    }
    if (r.reveal) score -= 6;                   // an on-screen twin wins the tie
    /* A menu OPENER ("Send back…") sits just under the concrete action it
       leads to when both land: "teleport back" should run the undo, not open
       the picker that lists it. Small enough that the opener still wins on
       its own name ("send back"). */
    if (r.opens) score -= 12;
    return { n: n, score: score };
  }

  /* The strict score: every term must land, else 0. Kept as the exported
     shape the harness scores rows with. */
  function fqScoreRow(r, terms) {
    if (!terms.length) return 1;
    const x = fqScoreTerms(r, terms);
    return x.n === terms.length ? Math.max(1, x.score) : 0;
  }

  /* Highlighting for a MULTI-WORD query. nameNodes() takes one needle, so
     "crop up" would highlight nothing at all — pick the term that lands
     EARLIEST in this particular string, which is hd-omni's own rule. */
  function fqHl(text, q) {
    const terms = fqTidy(q).toLowerCase().split(' ').filter(function (t) { return !!t; });
    if (terms.length < 2) return nameNodes(text, fqTidy(q));
    const low = String(text == null ? '' : text).toLowerCase();
    let best = '', at = -1;
    terms.forEach(function (t) {
      const i = low.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) { at = i; best = t; }
    });
    return nameNodes(text, best);
  }

  function fqRank(rows, q) {
    const terms = fqTidy(q).toLowerCase().split(' ').filter(function (t) { return !!t; });
    const hits = [];
    FQF.partial = false;
    if (!terms.length) {
      rows.forEach(function (r, i) { hits.push({ r: r, s: 1, i: i, off: r.disabled ? 1 : 0 }); });
    } else {
      const scored = [];
      let full = 0;
      rows.forEach(function (r, i) {
        const x = fqScoreTerms(r, terms);
        if (!x.n) return;
        if (x.n === terms.length) full++;
        scored.push({ r: r, s: x.score, n: x.n, i: i, off: r.disabled ? 1 : 0 });
      });
      /* Every term landed somewhere on at least one row: those rows, only.
         Otherwise the query is HALF right — "teleport her" — and a blank
         answer would say the deck cannot do it. Show the rows the most
         terms landed on instead, flagged as near misses (fq-find-near). */
      if (full) {
        scored.forEach(function (x) { if (x.n === terms.length) hits.push(x); });
      } else if (terms.length > 1) {
        FQF.partial = true;
        scored.forEach(function (x) { hits.push(x); });
        hits.sort(function (a, b) { return (a.off - b.off) || (b.n - a.n) || (b.s - a.s) || (a.i - b.i); });
        return hits.map(function (x) { return x.r; });
      }
    }
    /* Unavailable LAST, never GONE. Sorting on the flag rather than docking the
       score is the whole point: a docked score can go negative and drop the row
       out of the results entirely — which is how "inventory" on a corpse
       briefly returned nothing at all instead of the greyed button that says
       "Loot them in the world instead". */
    hits.sort(function (a, b) { return (a.off - b.off) || (b.s - a.s) || (a.i - b.i); });
    return hits.map(function (x) { return x.r; });
  }

  /* ---- the bar, in the card head ---------------------------------------- */

  function fqFindBar(who) {
    const first = fqTidy(String(who || '').split(' ')[0]) || 'her';
    const wrap = h('div', {
      class: 'fq-find' + (FQF.q ? ' has-q' : '') + (FQF.open ? ' is-open' : ''),
      title: 'Search everything this card can do — including the controls '
           + 'behind its popouts. Type, then ↑↓ and Enter.',
      onClick: (e) => e.stopPropagation(),
    });
    const inp = h('input', {
      class: 'fq-find-in', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search ' + first + '’s actions…',
      value: FQF.q,
      'aria-label': 'Search this card’s actions',
      onInput: (e) => {
        FQF.q = e.target.value;
        FQF.sel = 0;
        if (FQF.open) fqFindPaint(); else fqFindOpen('');
      },
      /* The pane's onKey (capture phase, from app.js) is what actually drives
         the popout in game — this is the same handling for the harness and for
         any build where the key router never reaches us. Both are idempotent. */
      onKeydown: (e) => { if (fqFindKey(e)) { e.stopPropagation(); } },
      onFocus: () => { if (!FQF.open) fqFindOpen(''); },
    });
    wrap.append(h('span', { class: 'fq-find-ic', 'aria-hidden': 'true' }, '⌕'), inp);
    wrap.append(h('button', {
      class: 'fq-find-x', type: 'button', title: 'Clear the search (Esc)',
      onClick: (e) => {
        e.stopPropagation();
        FQF.q = ''; FQF.sel = 0;
        const i = fqFindInput();
        if (i) { i.value = ''; i.focus(); }
        wrap.classList.remove('has-q');
        if (FQF.open) fqFindPaint();
      },
    }, '✕'));
    return wrap;
  }

  function fqFindInput() {
    const card = fqFindCard();
    return card ? card.querySelector('.fq-find-in') : null;
  }

  /* ---- the popout -------------------------------------------------------- */

  function fqFindOutside(e) {
    if (!FQF.popEl) return;
    if (FQF.popEl.contains(e.target)) return;
    const card = fqFindCard();
    const bar = card ? card.querySelector('.fq-find') : null;
    if (bar && bar.contains(e.target)) return;
    fqFindClose();
  }

  function fqFindOpen(seed) {
    const card = fqFindCard();
    if (!card || card.querySelector('.fq-find') === null) return false;
    if (seed) { FQF.q = String(seed); FQF.sel = 0; }
    if (!FQF.open) {
      FQF.open = true;
      FQF.listEl = h('div', { class: 'fqf-list', role: 'listbox' });
      FQF.headEl = h('div', { class: 'fqf-head' });
      FQF.popEl = h('div', { id: 'fq-find-pop' }, FQF.headEl, FQF.listEl);
      const host = $('overlay') || document.body;
      host.append(FQF.popEl);
      setTimeout(function () {
        document.addEventListener('mousedown', fqFindOutside, true);
      }, 0);
    }
    const bar = card.querySelector('.fq-find');
    if (bar) bar.classList.add('is-open');
    const inp = fqFindInput();
    if (inp) {
      if (inp.value !== FQF.q) inp.value = FQF.q;
      if (document.activeElement !== inp) {
        inp.focus();
        try { inp.setSelectionRange(FQF.q.length, FQF.q.length); } catch (e) {}
      }
    }
    fqFindPaint();
    return true;
  }

  function fqFindClose() {
    if (!FQF.open) return;
    FQF.open = false;
    FQF.q = '';
    FQF.sel = 0;
    FQF.rows = [];
    if (FQF.popEl && FQF.popEl.remove) FQF.popEl.remove();
    FQF.popEl = null; FQF.listEl = null; FQF.headEl = null;
    document.removeEventListener('mousedown', fqFindOutside, true);
    const card = fqFindCard();
    const bar = card ? card.querySelector('.fq-find') : null;
    if (bar) { bar.classList.remove('is-open', 'has-q'); }
    const inp = fqFindInput();
    if (inp) inp.value = '';
  }

  /* Place it under the bar, in #overlay's own coordinate space, with every
     measurement multiplied by the deck scale — the clampCtx rules, applied to
     a box that is anchored rather than free. */
  function fqFindPlace() {
    if (!FQF.popEl) return;
    const card = fqFindCard();
    const bar = card ? card.querySelector('.fq-find') : null;
    const s = deckScale();
    const vp = ctxViewport();
    const r = (bar && bar.getBoundingClientRect) ? bar.getBoundingClientRect()
                                                 : { left: 40, top: 100, bottom: 140, width: 320 };
    /* Bound it to the DECK WINDOW, not just the screen, when the bar is inside
       one. #fd-ctx-menu clamps to the viewport and is happy to overhang the
       panel — it is a menu torn off a row. This is a dropdown belonging to a
       control INSIDE the window, and a dropdown that spills past the window's
       own edge reads as a rendering fault rather than a layer. Falls back to
       the viewport when there is no panel (the harness mounts the card
       standalone) and never lets the panel push it off screen. */
    const panel = document.getElementById('panel');
    let boundL = 0, boundR = vp.w, boundB = vp.h;
    if (panel && bar && bar.closest && bar.closest('#panel')) {
      const pr2 = panel.getBoundingClientRect();
      if (pr2.width > 40) {
        boundL = Math.max(0, pr2.left);
        boundR = Math.min(vp.w, pr2.right);
        /* The card head is always near the TOP of the window, so bounding the
           bottom to the panel costs nothing and keeps the whole popout inside
           the deck. Never below 240px of room, though — a squeezed list is
           worse than a slight overhang. */
        if (pr2.bottom - r.bottom > 240) boundB = Math.min(vp.h, pr2.bottom);
      }
    }
    /* Layout px (pre-transform), because that is what width/max-height mean to
       the element itself; the PAINTED box is this × scale. */
    const wantW = Math.max(360, Math.min(640, (r.width || 320) / s * 1.6));
    const capW = Math.max(300, (boundR - boundL - 12) / s);
    const w = Math.min(wantW, capW);
    FQF.popEl.style.width = w + 'px';
    FQF.popEl.style.maxWidth = w + 'px';
    /* 560 layout px ≈ nine rows. The list scrolls past that rather than
       growing into a full-height wall of forty buttons — and it still has to
       fit the room actually left under the bar, whichever is smaller. */
    const room = Math.max(160, (boundB - r.bottom - 16) / s);
    FQF.popEl.style.maxHeight = Math.min(560, Math.max(220, ctxMaxHpx(220)), room) + 'px';
    let x = r.left;
    let y = r.bottom + 6;
    const pw = FQF.popEl.offsetWidth * s;
    const ph = FQF.popEl.offsetHeight * s;
    if (x + pw > boundR - 6) x = boundR - pw - 6;
    if (x < boundL + 6) x = boundL + 6;
    /* No room under the bar? Sit ABOVE it rather than off the bottom — the one
       case where "anchored under" has to give way to "on screen". */
    if (y + ph > boundB - 6) {
      const above = r.top - 6 - ph;
      y = above > 6 ? above : Math.max(6, boundB - ph - 6);
    }
    FQF.popEl.style.left = Math.max(6, x) + 'px';
    FQF.popEl.style.top = Math.max(6, y) + 'px';
  }

  function fqFindPaint() {
    if (!FQF.open || !FQF.listEl) return;
    const card = fqFindCard();
    const bar = card ? card.querySelector('.fq-find') : null;
    if (bar) bar.classList.toggle('has-q', !!FQF.q);
    const all = fqFindIndex();
    const rows = fqRank(all, FQF.q);
    FQF.rows = rows;
    if (FQF.sel >= rows.length) FQF.sel = Math.max(0, rows.length - 1);
    if (FQF.sel < 0) FQF.sel = 0;

    FQF.headEl.textContent = '';
    FQF.headEl.append(
      h('span', { class: 'fqf-count' },
        FQF.partial ? rows.length + ' close match' + (rows.length === 1 ? '' : 'es')
                    : rows.length + ' of ' + all.length + ' action' + (all.length === 1 ? '' : 's')),
      h('span', { class: 'fqf-hint' }, '↑↓ move · Enter run · Esc close'));

    FQF.listEl.textContent = '';
    if (rows.length && FQF.partial) {
      FQF.listEl.append(h('div', { class: 'fqf-near', role: 'note' },
        'Nothing matches all of “' + FQF.q + '” — closest actions:'));
    }
    if (!rows.length) {
      FQF.listEl.append(h('div', { class: 'fqf-empty' },
        h('div', { class: 'fqf-empty-ic', 'aria-hidden': 'true' }, '⌕'),
        h('div', { class: 'fqf-empty-txt' },
          h('div', { class: 'fqf-empty-l1' },
            FQF.q ? 'No action matches “' + FQF.q + '”.' : 'Nothing on this card yet.'),
          h('div', { class: 'fqf-empty-l2' },
            'Try “teleport”, “freeze”, “dismiss”, “outfit”, “inventory”, “home” '
            + 'or “portrait”.'))));
      fqFindPlace();
      return;
    }
    rows.forEach(function (r, i) {
      /* A glyph-only button's LABEL was taken from its tooltip, so the row
         would otherwise print the same sentence twice ("Collapse to just the
         name" over "Collapse to just the name"). Show only what the tooltip
         adds; when it adds nothing, the row is just the label. */
      let sub = r.sub || '';
      if (sub && sub.toLowerCase().indexOf(r.label.toLowerCase()) === 0)
        sub = fqTidy(sub.slice(r.label.length).replace(/^[\s—:.,-]+/, ''));
      const row = h('button', {
        class: 'fqf-row' + (i === FQF.sel ? ' sel' : '') + (r.disabled ? ' off' : ''),
        type: 'button',
        role: 'option',
        'aria-selected': String(i === FQF.sel),
        title: r.disabled ? r.why : (r.sub || r.label),
        onMousemove: () => {
          if (FQF.sel === i) return;
          FQF.sel = i;
          fqFindMark();
        },
        onClick: (e) => { e.stopPropagation(); fqFindFire(r); },
      },
        h('span', { class: 'fqf-ic', 'aria-hidden': 'true' }, r.icon),
        h('span', { class: 'fqf-txt' },
          h('span', { class: 'fqf-lbl' }, fqHl(r.label, FQF.q)),
          sub ? h('span', { class: 'fqf-sub' }, fqHl(sub, FQF.q)) : null,
          r.disabled ? h('span', { class: 'fqf-why' }, '⚠ ' + fqFirstClause(r.why)) : null),
        h('span', { class: 'fqf-tags' },
          r.opens ? h('span', { class: 'fqf-tag' }, 'opens') : null,
          r.reveal ? h('span', { class: 'fqf-tag' }, 'reveals') : null,
          h('span', { class: 'fqf-sect' }, r.sect)));
      FQF.listEl.append(row);
    });
    fqFindPlace();
    fqFindScrollTo();
  }

  /* Move the highlight without rebuilding the list — a rebuild on every arrow
     press would throw away the row under the mouse and cost a paint. */
  function fqFindMark() {
    if (!FQF.listEl) return;
    const kids = FQF.listEl.children;
    for (let i = 0; i < kids.length; i++) {
      const on = (i === FQF.sel);
      kids[i].classList.toggle('sel', on);
      kids[i].setAttribute('aria-selected', String(on));
    }
    fqFindScrollTo();
  }

  function fqFindScrollTo() {
    if (!FQF.listEl) return;
    const el = FQF.listEl.children[FQF.sel];
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  /* Put the caret back after something else re-rendered the card underneath
     the open search — the index's element refs are all detached now, so this
     re-reads them too. */
  function fqFindRestore() {
    if (!FQF.open) return;
    const card = fqFindCard();
    const bar = card ? card.querySelector('.fq-find') : null;
    if (!bar) { fqFindClose(); return; }        // folded / no target: nothing to search
    bar.classList.add('is-open');
    const inp = fqFindInput();
    if (inp) {
      if (inp.value !== FQF.q) inp.value = FQF.q;
      inp.focus();
      try { inp.setSelectionRange(FQF.q.length, FQF.q.length); } catch (e) {}
    }
    fqFindPaint();
  }

  /* The live element behind a row. For a reveal, the flag is set and the card
     re-rendered FIRST — so what gets clicked is the card's own button, in the
     card, exactly as if you had opened the reveal and clicked it yourself. */
  function fqFindResolve(row) {
    if (!row) return null;
    if (row.reveal && !ui[row.reveal]) {
      ui[row.reveal] = true;
      renderQuickCard();
    }
    if (!row.reveal && row.el && row.el.isConnected) return row.el;
    const card = fqFindCard();
    const live = fqScan(card, '');
    for (let i = 0; i < live.length; i++) if (live[i].key === row.key) return live[i].el;
    return null;
  }

  function fqFindFire(row) {
    if (!row) return false;
    if (row.disabled) {
      /* Deliberately NOT closed: the reason is the useful thing on screen and
         you are about to read it. Flash the row so the press is not silent. */
      const el = FQF.listEl ? FQF.listEl.children[FQF.rows.indexOf(row)] : null;
      if (el) {
        el.classList.remove('nope');
        void el.offsetWidth;
        el.classList.add('nope');
      }
      return false;
    }
    if (typeof row.run === 'function') {   // a picker row: no card button to click
      fqFindClose();
      row.run();
      return true;
    }
    const el = fqFindResolve(row);
    fqFindClose();
    if (el && el.isConnected) { el.click(); return true; }
    /* The card changed under the search (she died, the roster refreshed) —
       say so rather than doing nothing. */
    if (typeof toast === 'function') toast('“' + row.label + '” is not on the card any more');
    return false;
  }

  /* Key handling, shared by the input's own listener and the pane's onKey. */
  function fqFindKey(e) {
    if (!FQF.open) return false;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); fqFindClose(); return true; }
    if (k === 'ArrowDown') {
      e.preventDefault();
      FQF.sel = Math.min(FQF.rows.length - 1, FQF.sel + 1);
      fqFindMark();
      return true;
    }
    if (k === 'ArrowUp') {
      e.preventDefault();
      FQF.sel = Math.max(0, FQF.sel - 1);
      fqFindMark();
      return true;
    }
    if (k === 'Home' && FQF.rows.length) { e.preventDefault(); FQF.sel = 0; fqFindMark(); return true; }
    if (k === 'End' && FQF.rows.length) {
      e.preventDefault(); FQF.sel = FQF.rows.length - 1; fqFindMark(); return true;
    }
    if (k === 'Enter') {
      e.preventDefault();
      fqFindFire(FQF.rows[FQF.sel] || FQF.rows[0]);
      return true;
    }
    return false;   // every other key belongs to the input
  }

  /* Does plain typing belong to THIS search?
     Only when the card is the surface you are looking at: in F7 focus the
     roster and its own search box are hidden, so a letter has nowhere else to
     go. With the roster on screen the tab's existing law stands — typing finds
     a PERSON — and quietly stealing it would break a reflex that predates this
     feature. Measured off the roster search's visibility rather than guessed
     from a flag, so it stays true if the chrome rules change. */
  function fqFindClaimsTyping() {
    if (FQF.open) return false;
    const card = fqFindCard();
    if (!card || !card.querySelector('.fq-find')) return false;
    if (ctxEl) return false;                       // a menu owns the keyboard
    const s = $('fd-search');
    if (s && s.offsetParent !== null) return false;   // the roster search is on screen
    return true;
  }

  function buildQuickCard() {
    const subj = quickSubject();
    /* PICKED (you clicked a face on the party strip) vs the crosshair target.
       The picked object is built from the ROSTER row, because that is the only
       record we have for someone who is not under your crosshair.

       ⚠ But the roster's `dead` / `inWorld` are Follower Organizer's cached
       view, and they can be stale — a follower whose stored reference no longer
       resolves comes back dead AND not-in-world even while she is walking
       beside you. Every control group is gated on those two (Order on !dead,
       Move and Home on inWorld), so a stale pair rendered a card with a name, a
       green FOLLOWING chip and NOTHING ELSE. That is what Rober hit on Vayne:
       "i clicked vayne in current party and its just opening a blank area".

       So when the engine is talking about the SAME person, the engine wins.
       state.target is a live read; the roster row is a cache. Matched on form
       id when both have one, falling back to the name. */
    const liveSame = (function () {
      if (!subj || !state.target || !state.target.name) return false;
      const a = fidHexOf(subj.formId), b = fidHexOf(state.target.formId);
      if (a && b) return a === b;
      return String(subj.name || '').toLowerCase() === String(state.target.name || '').toLowerCase();
    })();
    const t = subj
      ? { name: subj.name, formId: subj.formId,
          following: liveSame ? !!state.target.following : !!subj.following,
          dead: liveSame ? !!state.target.dead : !!subj.dead,
          picked: true }
      : state.target;
    const card = h('div', { class: 'fq' + (subj ? ' picked' : '') });

    if (!state.targetKnown && !subj) {
      /* Loading, NOT empty. Sized like the real card - eyebrow line plus a
         button row - so the list below does not jump when the answer lands. */
      card.classList.add('loading');
      card.append(h('div', { class: 'fq-head' }, h('span', { class: 'fq-sk fq-sk-name' })));
      card.append(h('div', { class: 'fq-acts' },
        [0, 1, 2, 3].map(() => h('div', { class: 'fq-sk fq-sk-btn' }))));
      return card;
    }

    if (!t || !t.name) {
      /* No target is not nothing to do — it is the WHOLE PARTY.
         Rober (2026-08-02): "i'd like it if this gave me some options when not
         hovering an npc as well, teleport all, sandbox all, follow all, wait
         all etc". The card used to spend this state telling him to go look at
         someone, which is a sentence, not a control.

         Order is by blast radius, gentlest first, so the destructive-feeling
         one is not under the thumb: gather, then the two order verbs, then the
         relax pair. Every one goes through NFF's own entry points — see
         src/nff_control.h. */
      card.classList.add('empty', 'party');
      /* The party first: it is about specific people and therefore the more
         likely thing you came for. EVERYONE is the blunter instrument. */
      const crew = partyStrip();
      if (crew) card.append(crew);
      card.append(partyBlock());
      if (fqStatus.msg) {
        card.append(h('div', { class: 'fq-status' + (fqStatus.ok ? '' : ' bad') },
          h('span', { class: 'fq-status-ic' }, fqStatus.ok ? (fqStatus.pending ? '⋯' : '✓') : '⚠'),
          h('span', null, fqStatus.msg)));
      }
      /* The "look at an NPC" line is advice about the FOLLOWERS tab, so it
         only earns its space there. On the Hotkeys tab you came for hotkeys
         and this card is riding along under the Followers category — the
         party row is the useful part and the footnote is just a sentence in
         the way (Rober, 2026-08-03). Host tells us which surface we are on. */
      if (quickHost && quickHost.id === 'fd-quick') {
        card.append(h('div', { class: 'fq-empty' },
          h('span', { class: 'fq-empty-ic' }, '⌖'),
          h('span', null, 'Look at an NPC before opening the deck for their own '
                        + 'recruit, dismiss and inventory.')));
      }
      return card;
    }

    const who = t.name;
    const following = !!t.following;
    const dead = !!t.dead;

    /* Portrait if the deck has one, initials if not — the same medallion the
       roster draws, so a face means the same thing on both surfaces.

       The pseudo MUST carry the crosshair NPC's runtime formId (from t): that
       is the identity portraitFor()'s facegen fallback keys on. Without it a
       looking-at target that is NOT on the FO roster (`known` null) had no
       formId, so portraitFor found no face render and the medallion stayed
       blank — even though the Finder and roster render the very same face. The
       card's own face request (requestFaceIcons) is what fetches/queues it. */
    const known = rosterEntryFor(who);
    const pseudo = known ? known.m
                         : { name: who, original: who, formId: fidHexOf(t && t.formId),
                             following: following, dead: dead };
    const medal = medalEl(pseudo, known ? known.cat.index : 0);
    medal.classList.add('fq-medal');
    /* The card's medal is the same element the roster row draws, but the card
       has no row click handler behind it — so wire the lightbox here too.
       Without this the card is the one surface showing a face you cannot open,
       and it is the surface you are looking at when you take the photo. */
    if (medal.dataset && medal.dataset.act === 'portrait') {
      medal.addEventListener('click', function (e) {
        e.stopPropagation();
        openLightbox(medal.dataset);
      });
    } else if (!dead) {
      /* No picture yet (the initials medal): clicking it TAKES one. The
         lightbox's ◉ Retake photo only exists once there is a photo to open,
         so a face-less NPC had no door to a portrait from here at all (Rober,
         2026-09-23: "i should be able to click the profile pic to retake
         image"). Same fdPortrait verb Retake uses. */
      medal.classList.add('fq-medal-take');
      medal.title = 'No picture yet — click, frame ' + who + ', then press Enter to take the portrait (Esc cancels)';
      medal.style.cursor = 'pointer';
      medal.addEventListener('click', function (e) {
        e.stopPropagation();
        toast('◉ Portrait armed — frame ' + who + ', then press Enter');
        capturePortrait(known, t);
      });
    }

    /* One wrapping dossier row, ordered by how much you care: who she is to
       YOU first (relationship, category), then what she IS (level, race,
       essential), then what the other mods know (home, what she is doing now,
       pregnancy). Everything except the engine facts is re-used from the
       roster's own helpers, so a chip means the same thing on both surfaces. */
    const sub = h('div', { class: 'fq-sub' });
    if (known) {
      const rel = CHIP_FIELD ? fieldValue(known.m, CHIP_FIELD.key) : '';
      if (rel) sub.append(h('span', { class: 'fq-chip rel', title: CHIP_FIELD.label }, rel));
      /* The category chip is a BUTTON, and it is the card's way into filing.
         Rober, 2026-09-20: typing "add" on a card offered only "Add to
         framework" — NFF's import, which has no categories — and he expected
         to be asked which category. The roster add already asks exactly that
         (every category listed, the ones she is in ticked and disabled), it
         just had no door on this surface. A button is also the only thing the
         card's own search indexes (fqScan walks <button>), so this is what
         makes "category" and "file" findable from that box. */
      /* Rober, 2026-09-23, with the card's search open on "follower
         organizer": "not in f7 menu either". The chip only ADDED her to a
         second category; changing the one she is in was a dossier-only move.
         It now opens the move picker (openMoveTo), whose last row is still
         the old "also add" door. */
      sub.append(h('button', {
        class: 'fq-chip fq-chip-cat', type: 'button',
        title: 'Filed in Follower Organizer under ' + catLabel(known.cat)
             + '\nClick to change her category \u2014 move her to another group',
        onClick: (e) => { e.stopPropagation(); openMoveTo(e.currentTarget || e.target, known, who, pseudo); },
      }, catLabel(known.cat)));
    } else {
      sub.append(h('button', {
        class: 'fq-chip new fq-chip-cat', type: 'button',
        title: 'Not in Follower Organizer yet\nClick to file them under a category',
        onClick: (e) => { e.stopPropagation(); openAddMenu(pseudo); },
      }, 'unfiled — file them'));
    }

    /* Engine facts, from the same read that fetches the worn set. */
    const about = (equippedFor(null) || {}).about || null;
    if (about) {
      if (about.level) sub.append(h('span', { class: 'fq-chip', title: 'Level' }, 'Lv ' + about.level));
      if (about.race)  sub.append(h('span', { class: 'fq-chip', title: 'Race' }, String(about.race)));
      if (about.essential)
        sub.append(h('span', { class: 'fq-chip warn', title: 'Essential — the game will not let them die' }, 'essential'));
      else if (about.protected)
        sub.append(h('span', { class: 'fq-chip', title: 'Protected — only you can kill them' }, 'protected'));
      if (about.healthMax > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((about.health / about.healthMax) * 100)));
        if (pct < 100)
          sub.append(h('span', { class: 'fq-chip hurt', title: about.health + ' / ' + about.healthMax + ' health' },
            '♥ ' + pct + '%'));
      }
    }

    /* MARRIED, per M.A.R.A.S. Read from the SAME dossier as the engine facts so
       it works for anyone under the crosshair, not only for someone Follower
       Organizer already has — you can be married to a townsperson who has never
       been on the roster. The roster's own answer is the fallback for the case
       where the DLL is older than this view. */
    if (marasSpouse(about, known)) {
      const ma = (about && about.maras && typeof about.maras === 'object') ? about.maras : null;
      /* MARAS ranks your spouses, so "1st wife" is a real fact and not our
         invention — hierarchy 4 is its own "4th or later" bucket. */
      const order = (ma && typeof ma.hierarchy === 'number') ? ma.hierarchy : -1;
      /* NO ♥ on this one, unlike the roster row's twin. The card already spends
         ♥ on the health chip two chips to the left, and one glyph meaning two
         things in one row is worse than no glyph at all — the violet and the
         word carry it. A roster row has no health chip, so the heart is
         unambiguous there and it keeps its scannability. */
      let label = 'Married';
      if (order === 0) label = '1st spouse';
      else if (order === 1) label = '2nd spouse';
      else if (order === 2) label = '3rd spouse';
      else if (order >= 3) label = '4th+ spouse';
      let tip = 'Married to you — M.A.R.A.S (Marry Anyone Rule All Skyrim)';
      if (ma && typeof ma.affection === 'number') {
        tip += '\nAffection ' + ma.affection + '/100'
             + (ma.mood ? ' — ' + ma.mood : '');
      }
      sub.append(h('span', { class: 'fq-chip spouse', title: tip }, label));
    }

    /* What the OTHER mods know, via the roster's own chip builders so the
       wording and colours match the Followers tab exactly. */
    if (known) {
      const hc = homeChip(known.m, '');
      if (hc) sub.append(hc);
      const nc = nowChip(known.m, '');
      if (nc) sub.append(nc);
      const fc = fertChip(known.m);
      if (fc) sub.append(fc);
    }
    /* No roster row (or one FM has not been merged onto): read the whole-map
       answer by her reference, so a crosshair NPC who was never filed still
       shows ◍ when Fertility Mode says she is expecting (Rober, 2026-09-14). */
    if (!(known && known.m && known.m.fert) && t && t.formId && !dead) {
      const fa = fertFor({ formId: t.formId });
      if (fa && fa.pregnant) sub.append(fertChip({ fert: fa }));
      if (fa === undefined && !fqProbing) ensureFertAll();
    }

    /* WHO DRESSES HER, as a chip — the Wardrobe tab's People row leads with
       exactly this, and it is the one fact about her clothes worth reading
       before you open anything. The two warnings beside it are the People
       row's own, verbatim: a person both systems hold gets dressed twice and
       they fight, and Tailor is a third engine that does not know about
       either. Silent when neither Wardrobe module has heard of her. */
    const clChip = clothesAbout();
    if (clChip) {
      if (clChip.mode === 'nff') {
        const wl = clChip.nf && clChip.nf.wornLabel;
        sub.append(h('span', { class: 'fq-chip', title:
          'Nether’s Follower Framework dresses her — the Wardrobe leaves her alone' },
          'NFF' + (wl ? ' · ' + wl : '')));
      } else if (clChip.mode === 'wardrobe') {
        sub.append(h('span', { class: 'fq-chip rel', title:
          'The deck’s Wardrobe dresses her, through SOES-NG'
          + (clChip.w && clChip.w.cadence ? '\nChanges every ' + clChip.w.cadence : '') },
          '◇ ' + ((clChip.w && clChip.w.label) || 'Wardrobe')));
      }
      if (clChip.w && clChip.w.twoSystems)
        sub.append(h('span', { class: 'fq-chip warn', title:
          'The Wardrobe and NFF are BOTH dressing her — they fight. Pick one, '
          + 'under ⛨ Outfit.' }, '⚠ two systems'));
      if (clChip.w && clChip.w.conflict)
        sub.append(h('span', { class: 'fq-chip warn', title:
          'Tailor is assigned an outfit for her too — clear one of the two' }, 'Tailor clash'));
    }

    if (known && known.m.desc)
      sub.append(h('span', { class: 'fq-note', title: known.m.desc }, known.m.desc));

    card.append(h('div', { class: 'fq-head' },
      medal,
      h('div', { class: 'fq-who' },
        h('div', { class: 'fq-line' },
          h('span', { class: 'fq-eyebrow' }, 'Looking at'),
          h('span', { class: 'fq-name', title: who }, who),
          dead ? h('span', { class: 'fq-tag dead' }, '☠ Dead')
               : (following ? h('span', { class: 'fq-tag following' }, 'Following') : null),
          /* The squad she rides with, if any — the F7 card is reached without
             ever opening the Loadouts tab, so it has to say so itself. */
          ...groupsFor(((rosterEntryFor(who) || {}).m) || { original: who, name: who }).map(function (g) {
            return h('span', {
              class: 'fq-tag group',
              title: 'In the Loadouts group "' + g.group + '"' +
                (g.cls ? ' — plays ' + g.cls + ' there' : ' — no class set in that group'),
            }, g.group + (g.cls ? ' · ' + g.cls : ''));
          })),
        ui.fqFold ? null : sub),
      /* ⌕ FIND AN ACTION — the empty space beside the name, spent (Rober,
         2026-08-19). Not drawn while the card is FOLDED: folding builds no
         action rows at all, so a search box there would be a control with
         nothing to find. See the fq-find block above for how it indexes. */
      ui.fqFold ? null : fqFindBar(who),
      /* Identity actions live in the HEAD, beside who they are, rather than as
         more rows: they are all "about this person" rather than things you do
         to them, and the card has enough rows. */
      h('div', { class: 'fq-headacts' },
        /* The way OUT of a pick. Only when the card is about someone you
           CLICKED rather than someone you are looking at — on the crosshair
           card there is nothing to go back to, and a permanent dead button
           would be worse than none. */
        subj ? h('button', {
          class: 'fq-iconbtn', type: 'button',
          /* aria-label on every head icon: it is the button's NAME, which is
             what the ⌕ action search indexes for a control whose whole face is
             a glyph (its tooltip is state, and would read "Lydia is dead"). */
          'aria-label': 'Back to the party',
          title: 'Back to the party — stop acting on ' + who,
          onClick: (e) => { e.stopPropagation();
            /* A pick's dedicated view has nothing to fall back to without a
               crosshair NPC — step back out to the roster instead of leaving
               an empty dedicated shell. */
            if (ui.npcFocus && !(state.target && state.target.name)) { exitFocus(); return; }
            ui.fqPick = ''; ui.fqPickPinned = false; renderQuickCard(); syncQuickHere(); },
        }, '\u2190') : null,
        /* Photograph them. Same bridge the roster's menu uses, and it names its
           subject explicitly, so it captures whoever you are looking at rather
           than whatever the crosshair drifts onto. "Replace" once one exists —
           a portrait the deck has drawn is memory-mapped and cannot be
           overwritten, so the capture lands versioned and the newest wins. */
        h('button', {
          class: 'fq-iconbtn', type: 'button',
          disabled: dead ? true : null,
          'aria-label': (portraitFor(pseudo) ? 'Replace' : 'Capture') + ' their portrait',
          title: dead ? who + ' is dead'
               : (portraitFor(pseudo) ? 'Replace ' : 'Capture ') + who + '’s portrait'
                 + ' — hides the HUD, frames their face, saves it. They must be on screen.',
          onClick: (e) => { e.stopPropagation(); capturePortrait(known, t); },
        }, '◉'),
        /* CHIM's per-NPC intimacy profile. Keyed by the ORIGINAL name, because
           CHIM stores rows under the real one — a follower renamed in the deck
           must not quietly grow a second profile under her nickname. */
        (typeof SmPane !== 'undefined') ? h('button', {
          class: 'fq-iconbtn', type: 'button',
          'aria-label': 'Sharmat profile (CHIM)',
          title: 'Sharmat profile — CHIM’s kinks / speak style / status for ' + who + '.\nEdits are LIVE.',
          onClick: (e) => { e.stopPropagation();
            SmPane.open((known && known.m.original) || who, who); },
        }, '⚭') : null,
        /* Annotate someone you just met without going to the Followers tab.
           Filed followers only — the fields live on an FO entry. */
        known ? h('button', {
          class: 'fq-iconbtn' + (ui.fqEdit ? ' on' : ''), type: 'button',
          'aria-pressed': String(!!ui.fqEdit),
          'aria-label': 'Write a note / set their relationship',
          title: 'Write a note / set their relationship',
          onClick: (e) => { e.stopPropagation(); ui.fqEdit = !ui.fqEdit; renderQuickCard(); },
        }, '✎') : null,
        /* FULLSCREEN — the way BACK INTO the dedicated NPC page without closing
           and reopening the deck (Rober, 2026-08-05: "how do i get back to the
           fullscreen view?"). Shown only OUT of focus; in focus the ▴ beside it
           is the way out. A plain toggle either way is friendlier than "press
           F7 again", which needs a close first. */
        !ui.npcFocus ? h('button', {
          class: 'fq-iconbtn', type: 'button',
          'aria-label': 'Fullscreen — dedicate the deck to them',
          title: 'Fullscreen — dedicate the deck to ' + who
               + ' (hide the tabs, rail and roster)',
          onClick: (e) => { e.stopPropagation(); enterFocus(); },
        }, '⤢') : null,
        /* LABELS toggle (Rober, 2026-08-05): the action buttons are icons that
           grow into labelled pills on hover; this pins every label open for
           people who would rather always read the words. Persisted so the
           choice sticks across opens. */
        h('button', {
          class: 'fq-iconbtn' + (state.fqLabels ? ' fq-labels-on' : ''), type: 'button',
          'aria-pressed': String(!!state.fqLabels),
          'aria-label': state.fqLabels ? 'Hide the action labels' : 'Always show the action labels',
          title: state.fqLabels ? 'Hide the action labels — icons only, names on hover'
                                : 'Always show the action labels (instead of on hover)',
          onClick: (e) => { e.stopPropagation();
            state.fqLabels = !state.fqLabels; saveCfg(); renderQuickCard(); },
        }, 'Aa'),
        /* Fold it away. The card has grown into a dossier and sometimes you
           just want the hotkey list — this keeps the identity line (who you
           are looking at, and whether they follow you) and drops the rest.
           IN FOCUS MODE this button means something bigger: "reset the view"
           (Rober, 2026-08-05) — one click leaves the dedicated NPC page and
           brings the normal deck (tabs, rail, roster) back. A fresh F7 open
           re-enters focus. */
        h('button', {
          class: 'fq-fold' + (ui.npcFocus ? ' is-exit' : ''), type: 'button',
          'aria-expanded': String(ui.npcFocus ? true : !ui.fqFold),
          title: ui.npcFocus ? 'Back to the full deck (tabs, rail, roster)'
               : (ui.fqFold ? 'Show the controls' : 'Collapse to just the name'),
          onClick: (e) => { e.stopPropagation();
            if (ui.npcFocus) { exitFocus(); return; }
            ui.fqFold = !ui.fqFold; renderQuickCard(); },
        }, ui.npcFocus ? '▴' : (ui.fqFold ? '▾' : '▴')))));

    if (ui.fqFold) {
      /* A folded card is a name, a follow chip and nothing else — which is
         exactly what a BROKEN card looks like, and it got reported as one
         (Rober, 2026-09-21: "i clicked vayne in current party and its just
         opening a blank area….."). The fold is session state, so it survives
         switching subject: you collapse it once and every follower you click
         afterwards looks dead. Say it, and offer the way out as a real button
         rather than leaving the ▾ in the corner to be noticed. A button is also
         the only thing the card's own ⌕ search indexes (fqScan walks <button>),
         so "show"/"controls"/"expand" find it. */
      card.append(h('button', {
        class: 'fq-folded-hint', type: 'button',
        title: 'This card is collapsed to just the name. Click to bring back Order, '
             + 'Move, Home and the rest.',
        onClick: (e) => { e.stopPropagation(); ui.fqFold = false; renderQuickCard(); },
      },
        h('span', { class: 'fq-folded-ic', 'aria-hidden': 'true' }, '▾'),
        h('span', null, 'Collapsed to just the name — show ' + who + '\u2019s controls')));
      return card;
    }

    /* Inline annotate. Saves on change through the SAME ops the member menu
       uses, so a note written here and one written there are the same field.
       Enter commits (blur), because a PrismaUI view swallows form semantics. */
    if (known && ui.fqEdit) {
      const row = { cat: known.cat.index, idx: known.idx };
      const field = (label, value, hint, commit) => h('label', { class: 'fq-edit-row' },
        h('span', { class: 'fq-edit-lbl' }, label),
        h('input', {
          class: 'fq-edit-in', type: 'text', value: value || '', spellcheck: 'false',
          maxlength: String(FIELD_VALUE_MAX), placeholder: hint,
          onClick: (e) => e.stopPropagation(),
          onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
          onChange: (e) => commit(e.target.value),
        }));
      card.append(h('div', { class: 'fq-edit' },
        CHIP_FIELD ? field(CHIP_FIELD.label, fieldValue(known.m, CHIP_FIELD.key),
          CHIP_FIELD.hint || '', (v) => saveField(row, CHIP_FIELD.key, v)) : null,
        field('Note', known.m.desc, 'A few words to remember them by…',
          (v) => sendApply('setDesc', { cat: row.cat, idx: row.idx, desc: clampText(v) }))));
    }

    /* All three verbs are always PRESENT and the inapplicable one is disabled
       with a reason, rather than one button that changes meaning underneath
       you — a control that silently becomes "Dismiss" is how you dismiss
       someone you meant to recruit. */
    /* ICON MODE (Rober, 2026-08-05): the per-person actions render as labelled
       ICONS — the visible word is dropped and the button's `title` becomes a
       drawn hover bubble via app.js's #hd-tip layer (Ultralight ignores native
       title bubbles, but that delegate turns every title into one). Squares
       pack far tighter than word-buttons, so the whole toolset fits without
       scrolling and reads as a palette rather than a wall of buttons. The
       reveals below (Outfit sets, Copy checklist) keep their labels. */
    /* Recruit/Dismiss (a single status button) and Freeze moved into the ORDER
       group (Rober, 2026-08-05) — they are behaviour orders, not one-shot
       actions. See the ORDER control-group below. */
    const iconRowCls = 'fq-acts fq-acts-icons' + (state.fqLabels ? ' fq-acts-labels' : '');

    /* ==== THE HALF-RECRUIT, named on the card (Rober, 2026-08-10) =========
       "she seems broken … her dialogue options only four now and none
       follower related or dismiss" / "it seems to be at random sometimes".
       It is not random: her FACTIONS say current follower while the engine
       says she is not a teammate, so the game conditions away BOTH "Follow
       me" (you already are one) and "Wait here / part ways" (you are not a
       teammate) and leaves the generic greetings. Nothing in the game shows
       that state, which is why it reads as random breakage.

       The card must say so, and must offer the repair — the old card offered
       RECRUIT here, which is the very call that produced the state. */
    if (!dead && t && t.wedged) {
      const wedge = h('div', { class: 'fq-wedge' },
        h('div', { class: 'fq-wedge-head' },
          h('span', { class: 'fq-wedge-ic', 'aria-hidden': 'true' }, '⚠'),
          h('span', { class: 'fq-wedge-title' }, who + '’s follower state is broken')),
        h('div', { class: 'fq-wedge-body' },
          'The game still has her in the current-follower faction, but she is not '
          + 'actually your teammate. That hides BOTH halves of her dialogue — '
          + '“Follow me” (she counts as already following) and “Wait here” / '
          + '“Time to part ways” (she is not a teammate) — so she is left with '
          + 'only her generic lines.'));
      wedge.append(h('button', {
        class: 'fq-set fq-wedge-fix', type: 'button',
        title: 'Hand her back to nobody: dismiss her through NFF, then clear the '
          + 'leftover follower factions. Then ask her to follow in her OWN dialogue.',
        onClick: (e) => { e.stopPropagation(); sendNpc('unwedge', subj); },
      }, '🔧 Repair her follower state'));
      wedge.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Show the raw factions and flags this is read from',
        onClick: (e) => { e.stopPropagation();
          ui.fqDebug = true; askDebug(t.formId); renderQuickCard(); },
      }, '🔍 Show me'));
      card.append(wedge);
    }

    /* ONE action row, with the related tools boxed inline (Rober, 2026-08-05:
       "keep them on the same line but a highlight around them"): a GEAR group
       (Inventory · Spare · Outfit · Copy outfit · Hide gear) and a PORTRAIT
       group (Portrait · Adjust) each get a subtle highlight wrapper, sitting on
       the same row as the loose File / Preset pills. */
    card.append(h('div', { class: iconRowCls },
      h('span', { class: 'fq-igroup' },
        quickBtn('☰', 'Inventory', dead ? 'Loot them in the world instead'
            : 'Force-open ' + who + '’s full container (the deck closes)',
          () => sendNpc('inventory', subj), { disabled: dead }),
        /* ⚖ TRADE (Rober, 2026-08-17: "a open merchant / trade button when
           hitting f7 on an npc") — Skyrim QuickTrade's job, on the card. The
           title names the menu it will open FOR THIS PERSON rather than a
           generic word, because barter and "here is her pack" are two very
           different things to press by accident. tradePlan() only PREDICTS
           (C++ decides on the live actor); see the note above it. */
        quickBtn('⚖', 'Trade', tradeTitle(who, dead, tradePlan(about, known, following)),
          () => sendNpc('trade', subj), { disabled: dead }),
        quickBtn('⛃', 'Spare', dead ? 'Loot them in the world instead'
            : 'Open ' + who + '’s NFF spare inventory — the extra storage chest, '
              + 'separate from her own pack and from her outfits (the deck closes)',
          () => sendNpc('storage', subj), { disabled: dead }),
        /* SPID Gear (Rober, 2026-08-11): it belongs HERE, with the other
           containers — 📦 closes the deck onto the inbox chest, you drop gear
           in, and closing the chest is the whole commit. 📋 (only once she has
           grants) reveals the list to tune chances / remove. */
        sgQuickBtn(t, who, dead),
        sgListBtn(t, who, dead),
        /* ⛨ OUTFIT — the dock (Rober, 2026-08-11). It used to expand three
           cramped chip rows inside the card, and ⧉ Copy outfit sat loose
           beside it as a fourth. Both are now one button opening
           hd-outfit.js's dock: ⚡ Quick apply · ⧉ Copy outfit · ⚙ Settings,
           each its own popout. The inline reveals below still exist and are
           still reachable — but ONLY on a view where the module failed to
           load, so a partial deploy degrades to the old UI instead of
           leaving a dead button. */
        (window.HDOutfit)
          ? quickBtn('⛨', 'Outfit', dead ? who + ' is dead'
              : 'Everything about ' + who + '’s clothes: quick-apply an outfit '
                + '(searchable, wears it on the spot), copy what she is wearing '
                + 'into a new Wardrobe outfit, or open the full settings — who '
                + 'dresses her, her three NFF sets, chests and SOES tracking.',
            (e) => {
              if (HDOutfit.isOpen()) { HDOutfit.close(); return; }   // toggle, like every other reveal here
              HDOutfit.open(e.currentTarget, outfitDockCtx(subj, t, who, dead, pseudo));
              renderQuickCard();   // light the button while the dock is up
            },
            { disabled: dead, active: HDOutfit.isOpen(), pressed: HDOutfit.isOpen() })
          : quickBtn('⛨', 'Outfit', dead ? who + ' is dead'
              : 'Everything about ' + who + '’s clothes, in one place: who dresses '
                + 'her (Wardrobe / NFF / nobody), wear a set now, fill a chest, her '
                + 'satchel, reset, and SOES tracking. The same controls as her card '
                + 'on the Wardrobe tab.',
            () => { ui.fqSets = !ui.fqSets; renderQuickCard(); },
            { disabled: dead, active: ui.fqSets, pressed: ui.fqSets }),
        (window.HDOutfit) ? null
          : quickBtn('⧉', 'Copy outfit', dead ? who + ' is dead'
              : 'Copy ' + who + '’s worn outfit into a NEW Wardrobe outfit — tick '
                + 'which pieces to include first, then create it.',
            () => {
              ui.fqCopy = !ui.fqCopy;
              if (ui.fqCopy) askEquipped(subj);   // ensure her worn set is loading
              renderQuickCard();
            },
            { disabled: dead, active: ui.fqCopy, pressed: ui.fqCopy })),
        /* Hide gear moved onto the EQUIPPED container header (Rober,
           2026-08-05: "move hide gear to its own inline with Equipped"). */
      h('span', { class: 'fq-igroup' },
        quickBtn('◉', 'Portrait', dead ? 'Photograph ' + who + ' anyway'
            : 'Hide the HUD, frame ' + who + ' and save it as their portrait',
          () => { openPortraitCapture({name:who,
            formId: subj ? (Number(subj.formId) || 0) : (state.target ? state.target.formId : 0) }); }),
        quickBtn('⛶', 'Adjust',
          'Open ' + who + '’s portrait large and drag to pan / scroll to zoom — sets how the '
            + 'deck DRAWS this face everywhere (the file on disk is never rewritten). '
            + 'No photo yet? this frames the NEXT capture instead.',
          () => {
            /* The better, already-built UX (Rober, 2026-08-09): pop the portrait
               in the lightbox crop editor, same as the roster's "Re-frame photo…"
               and the card face's own click. Resolve through `pseudo` — the SAME
               object medalEl draws the card face from (roster member if known,
               else {name,original}) — so it works for a live/non-FO NPC from a
               custom follower mod exactly as the visible face does. startEditing=true opens
               straight into the drag/zoom crop editor. Fall back to the blind
               capture.ini framing only when there is genuinely no photo. */
            const shot = portraitFor(pseudo);
            if (shot) {
              openLightbox({ slug: shot.slug, file: shot.file, ext: shot.ext,
                             mtime: shot.mtime, name: who, cropScope:'f7',
                             formId: subj ? (Number(subj.formId) || 0) : (state.target ? state.target.formId : 0) }, true);
              return;
            }
            ui.fqFraming = !ui.fqFraming;
            if (ui.fqFraming) toGame('fdFraming', '{}');   // no photo — frame the next capture
            renderQuickCard();
          },
          { active: ui.fqFraming, pressed: ui.fqFraming }),
        /* RaceMenu preset, through the Preset Director mod (deep-links the Faces tab). */
      quickBtn('🎭', 'Preset', dead ? who + ' is dead'
          : 'Open the Faces tab aimed at ' + who + ' — browse RaceMenu presets '
            + 'and apply one. Needs the Preset Director mod.',
        () => {
          const fid = subj ? (Number(subj.formId) || 0)
                           : (state.target ? Number(state.target.formId) || 0 : 0);
          if (window.FacesPane && window.FacesPane.aimAt) window.FacesPane.aimAt(fid, who);
          else if (window.__omniSetTab) window.__omniSetTab('faces');
        },
        { disabled: dead }),
      window.NpcScene ? NpcScene.button({
        formId: subj ? Number(subj.formId) : (state.target ? Number(state.target.formId) : 0),
        name: who, dead: dead
      }) : quickBtn('›', 'Animate', 'Open animations', () => {
        if (window.OStimPane) OStimPane.smartLand();
      }, { disabled: dead }),
      /* ▥ FULL STATS (Rober, 2026-08-17, the Party Sheet catch-up: "main
         thing missing is a dedicated more info or stats page … you can get
         to by doing f7 then another button"). Opens the Finder's INSPECT
         sheet aimed at this person — live health pools, resistances, weapon
         damage, temperament, active effects and worn gear. Passed as `ref`
         (the runtime formId this card already holds), so it reads anyone on
         screen, rostered or not. Deliberately NOT disabled on the dead:
         reading a corpse is exactly when you wonder what killed her. */
      /* ▥ is a typographic mark, not colour emoji — the 2026-08-16 icon law. */
      quickBtn('▥', 'Full stats',
        'Open ' + who + '’s full stats sheet — live health, resistances, '
          + 'weapon damage, temperament, active effects and worn gear',
        () => {
          const fid = subj ? (Number(subj.formId) || 0)
                           : (state.target ? Number(state.target.formId) || 0 : 0);
          const shot = portraitFor(pseudo);
          if (window.__hdFinderGo) window.__hdFinderGo('npcs', '');
          else if (window.__omniSetTab) window.__omniSetTab('npcs');
          if (window.NpcsPane && window.NpcsPane._openInspect) {
            window.NpcsPane._openInspect('', {
              ref: fid ? fidHexOf(fid) : '',
              name: who,
              portrait: shot ? portraitSrc(shot) : '',
              /* Hand the SHEET her framing too. This is a portrait PHOTO, whose
                 crop lives in this pane's store — without it the sheet fell back
                 to a centre crop and disagreed with every other surface showing
                 the same face. */
              crop: shot ? cropFor(shot) : null,
              portraitKind: 'photo',   // a screen grab, not a FaceGen head render
            });
          }
        }),
      /* ◈ DISTRIBUTIONS (Rober, 2026-08-18: "hit f7 on an npc and inspect
         them for any SPID/SkyPatcher's that effect them"). Opens the
         Distributions tab PINNED to this person (DistrPane.openFor rides the
         same runtime-formId `ref` the Full-stats sheet uses), so it reads
         whoever this card is about even if the crosshair has moved on.
         Works on the dead too — "what could she have been wearing" is a
         record-level question, not a live one. ◈ is a typographic mark,
         per the 2026-08-16 icon law. NOT gated on window.DistrPane: its
         script sits later in the boot manifest than this one, so a fast
         first F7 could race it — the fallback plain tab-switch still lands
         on the right person, because in F7-focus the crosshair snapshot IS
         this NPC. */
      quickBtn('◈', 'Distr',
        'What SPID and SkyPatcher could give ' + who + ' — the outfits, '
          + 'items, spells and perks whose distribution filters they pass, '
          + 'searchable, with each outfit expandable into its pieces',
        () => {
          const fid = subj ? (Number(subj.formId) || 0)
                           : (state.target ? Number(state.target.formId) || 0 : 0);
          if (window.DistrPane && DistrPane.openFor)
            DistrPane.openFor({ ref: fid ? fidHexOf(fid) : '', name: who });
          else if (window.__omniSetTab) window.__omniSetTab('distr');
        },
        /* The face stays "Distr" — it is a narrow icon button and that is what
           fits. The full word lives here, which is what a screen reader reads
           and what the ⌕ action search completes the row title from. */
        { aria: 'Distributions' }),
      /* ⚒ TUNE (Rober, 2026-08-18: "this would be nice as a f7 button with a
         really polished nice UI modal popout, spacious") — the PROTEUS NPC
         editor as HDNpcTune's modal: level, stats, size, the temperament
         dials, Essential/Protected/Killable. Full stats READS her; this one
         REWRITES her. ⚒ is a typographic mark, per the 2026-08-16 icon law.
         Works on the dead too — making a corpse essential is meaningless,
         but tuning someone right after a fight (or before a resurrect from
         the console) is real; the modal shows a Dead chip. */
      (window.HDNpcTune)
        ? quickBtn('⚒', 'Tune',
            'Tune ' + who + ' — level, health and stats, size, temperament '
              + '(aggression, confidence…), and Essential / Protected / Killable. '
              + 'Stats save with your game; level and protection are kept across launches.',
            () => {
              const fid = subj ? (Number(subj.formId) || 0)
                               : (state.target ? Number(state.target.formId) || 0 : 0);
              const shot = portraitFor(pseudo);
              HDNpcTune.open({ formId: fid, name: who,
                portrait: shot ? portraitSrc(shot) : '' });
            })
        : null),
      /* (File / Add-to-category moved to the bottom bar under STATS — Rober,
         2026-08-05: the top ⊞ File icon duplicated the prominent "+ Add … to a
         category" footer, so the icon is dropped and the footer is the one way.) */
      
      /* Better FaceLight (Rober, 2026-08-06): gold when her facelight is ON,
         the hover title is the state sentence, click reveals the controls.
         Null until the DLL confirms the mod — nothing renders on a rig
         without it. */
      bflQuickBtn(t, who, dead),
      /* ✨ Effects (Rober, 2026-08-14): looks other mods can put on her —
         first tenant: Oily Skin's NiOverride gloss. Gold when any effect is
         ON; the modal lists each with Apply/Remove. Not drawn until the DLL
         confirms at least one effect's mod is in the load order. */
      fxQuickBtn(t, who, dead),
      /* (📦 SPID Gear moved into the GEAR group above — it is a container,
         and it sits with the other containers. 2026-08-11.) */
      /* CHIM (Rober, 2026-08-06): one emoji button opening a flyout — CHIM
         Background (the dossier, via Omni Ask), Sharmat Background (the live
         editor), and Activate/Disable NPC (manual AI activation). Owned by
         chim-flyout.js; the button is ours so it matches the row. */
      (window.ChimBtn) ? (function () {
        const ident = {
          original: (known && known.m && known.m.original) || who,
          name: who,
          formId: subj ? (Number(subj.formId) || 0)
                       : (state.target ? (Number(state.target.formId) || 0) : 0),
        };
        /* Lit GOLD when she is a CHIM agent right now (2026-09-14) — read
           from the whole-set answer chim-flyout.js keeps, so the card shows
           it without opening the flyout. Unknown (nothing answered yet)
           draws the neutral button; ensureAgents() is throttled, so a
           repaint storm costs one chAgents at most every few seconds. */
        const on = !dead && typeof ChimBtn.isAgent === 'function'
                   && ChimBtn.isAgent(ident) === true;
        if (!dead && !fqProbing && typeof ChimBtn.ensureAgents === 'function') ChimBtn.ensureAgents();
        return quickBtn('💬', on ? 'CHIM: on' : 'CHIM', dead ? who + ' is dead'
            : (on ? 'CHIM AI is ON for ' + who + ' — she is a live CHIM agent. '
                  : 'CHIM AI is off for ' + who + '. ')
              + 'Opens CHIM tools — background, Sharmat profile, and '
              + (on ? 'Disable' : 'Activate') + ' NPC (manual AI)',
          (e) => ChimBtn.open(e.currentTarget, {
            original: ident.original, who: who, dead: dead, formId: ident.formId,
          }),
          { disabled: dead, active: on, pressed: on });
      })() : null,
      /* Room ban (Rober, 2026-08-09: "just hit f7 on an npc … blacklist from —
         then pops up with a typable search bar"). Blacklist the person in
         front of you from a claimed Room Guard room — or protect her
         everywhere — without visiting the Rooms tab. The flyout, the typable
         room search and the identity resolution (runtime formId → durable
         plugin+localId via rgNpcs) all live in RoomsPane.banMenu; this button
         only hands over the crosshair snapshot. Absent when the Rooms pane
         isn't loaded, so nothing dangles on a partial deploy. */
      (window.RoomsPane && RoomsPane.banMenu) ? quickBtn('⛔', 'Room ban',
        dead ? who + ' is dead'
          : 'Ban ' + who + ' from one of your claimed rooms — Room Guard shows '
            + 'her out even if she is a follower — or mark her never-moved '
            + 'anywhere. Searchable list of your rooms.',
        (e) => RoomsPane.banMenu(e.currentTarget, {
          formId: subj ? (Number(subj.formId) || 0)
                       : (state.target ? (Number(state.target.formId) || 0) : 0),
          name: who,
        }),
        { disabled: dead }) : null,
      /* 📜 QUESTS (Rober, 2026-08-11: "f7 on an npc needs a new button, a quest
         button - same idea of the quest tab but a really highly polished list /
         searchable list of quests of that npc in a popup modal"). Opens
         hd-quests.js: her quests, searchable, with the stages and the repair
         verbs behind each one. Deliberately available on a corpse — "why is
         this quest stuck" is often asked ABOUT a body. Absent when the module
         didn't load, so a partial deploy shows no button rather than a dead
         one. Identity is the CARD's subject, not the crosshair: pick someone
         off the party strip and this must answer about HER. */
      (window.HDQuests) ? quickBtn('📜', 'Quests',
        'Every quest ' + who + ' is caught up in — searchable, with each quest’s '
          + 'stages, its aliases (an EMPTY one is usually the real reason a quest '
          + 'is stuck) and the repair verbs. Can also search every quest in the '
          + 'load order without leaving her.',
        (e) => {
          if (HDQuests.isOpen()) { HDQuests.close(); return; }   // toggle, like every other reveal here
          const fid = subj ? (Number(subj.formId) || 0)
                           : (t ? (Number(t.formId) || 0) : 0);
          HDQuests.open(e.currentTarget, {
            who: who,
            portrait: (function () {
              const shot = portraitFor(pseudo);
              return shot ? portraitSrc(shot) : '';
            })(),
            formId: fid,
            hex: fid ? hexOf(fid) : '',
            dead: dead,
            /* The 📜 draws itself gold while the modal is up, so the card has to
               hear about a close it did not cause (Esc, the scrim, ✕). */
            onClose: () => { if (isActive()) renderQuickCard(); },
          });
          renderQuickCard();
        },
        { active: HDQuests.isOpen(), pressed: HDQuests.isOpen() }) : null,
      /* 🐴 ADD AS MOUNT (Rober, 2026-08-14: "if i hit f7 on an npc (add as
         mount) should be a quick button as well in the f7 npc menu"). Fires the
         Mounts module's OWN add-crosshair verb (MountsPane.addLookingAt →
         mtAct addLook), which snapshots the crosshair ref at palette open —
         exactly what the Mounts tab does. NOTHING about mounts is reimplemented
         here: the module owns the plausibility check (it refuses a corpse, a
         fully-dynamic ref, a duplicate) and hands the honest {ok,msg} straight
         back onto THIS card via fqStatus. Only on the crosshair card (subj null)
         because addLook is about who you are LOOKING at, not a party-strip pick;
         absent when the Mounts pane didn't load, so a partial deploy shows no
         dead button. Disabled on a corpse with the reason the verb would give. */
      /* ENLIST — its own bordered group (Rober, 2026-09-20: "we also have a
         add as mount button, group that with another button add to follower
         framework"). Both buttons answer the same question — "take this
         person on" — and they were a lone 🐴 next to five unrelated verbs.
         The group is the .fq-igroup idiom Stats already uses. */
      (function () {
        const canMount = !!(window.MountsPane && typeof MountsPane.addLookingAt === 'function' && !subj);
        const mountBtn = canMount ? quickBtn('🐴', 'Add as mount', dead
            ? who + ' is dead — not much of a mount'
            : 'Add ' + who + ' to your Mounts stable (whoever is under your '
              + 'crosshair). If she is not something you can ride or register, '
              + 'the stable says why right here.',
          () => {
            fqStatus = { msg: 'Adding ' + who + ' to your mounts…', ok: true, pending: true };
            renderQuickCard();
            MountsPane.addLookingAt((r) => {
              fqStatus = { msg: (r && r.msg) || (r && r.ok ? 'Added to your mounts' : 'Could not add'),
                ok: !r || r.ok !== false, pending: false };
              if (isActive()) renderQuickCard();
            });
          },
          { disabled: dead }) : null;
        /* The framework add ASKS WHICH GROUP — that was the whole point of the
           ask. openFrameworkMenu lists Follower Organizer's categories (the
           ones she is already in ticked and disabled) and NFF's group-less
           import underneath, labelled as the different thing it is. */
        const fwBtn = quickBtn('👥', 'Add to framework',
          dead ? who + ' is dead'
            : 'File ' + who + ' under one of your Follower Organizer groups — it asks which — '
              + 'or lend her Nether\u2019s Follower Framework. Neither is recruitment: '
              + 'this is filing, not "follow me".',
          (e) => { e.stopPropagation(); openFrameworkMenu(pseudo); },
          { disabled: dead });
        if (!mountBtn) return h('span', { class: 'fq-igroup' }, fwBtn);
        return h('span', { class: 'fq-igroup' }, mountBtn, fwBtn);
      })(),
      /* 🔧 FIXES (Rober, 2026-09-20: "maybe a new button (like chim with
         dropdown) with fixes"). The CHIM button's flyout shape, holding the
         repair verbs that until now existed only as palette hotkeys — plus
         the new one he asked for, Stop her following. It PROBES first and
         prints what it found, because "she keeps following me" is four
         different faults and three of them are invisible from here; see the
         banner in fixes-flyout.js. Absent when the module didn't load, so a
         partial deploy shows no dead button. Available on a corpse — that is
         where Bring her back lives. */
      (window.FixBtn) ? quickBtn('🔧', 'Fixes',
        'Repair ' + who + ' when she is misbehaving — still following you when she is not your '
          + 'follower, stuck in an old routine, T-posing, swinging at someone, or dead. '
          + 'It reads the engine first and tells you which of those it actually is.',
        (e) => {
          FixBtn.open(e.currentTarget, {
            who: who,
            formId: subj ? (Number(subj.formId) || 0) : (t ? (Number(t.formId) || 0) : 0),
            dead: dead,
          });
          renderQuickCard();
        },
        { active: FixBtn.isOpen(), pressed: FixBtn.isOpen() }) : null,
      /* 🔍 Debug (Rober, 2026-08-10: "a debug option when pressing f7 on an
         npc could be handy"). The raw engine dossier — teammate flag, every
         faction, follower frameworks, alias holds, the package in force —
         for when she is acting broken. Deliberately available on a corpse. */
      quickBtn('🔍', 'Debug',
        'The engine’s raw truth about ' + who + ' — teammate flag, every '
          + 'faction with rank, follower frameworks, quest-alias holds, and '
          + 'the AI package in force. For when she is acting broken: wrong '
          + 'dialogue, won’t follow, won’t stay.',
        () => {
          ui.fqDebug = !ui.fqDebug;
          if (ui.fqDebug && t && t.formId) askDebug(t.formId);
          renderQuickCard();
        },
        { active: ui.fqDebug, pressed: ui.fqDebug }),
      /* NEW GROUP (Rober, 2026-08-07): 'a continuation of the buttons that
         you hover and the text extends, just a separate border' - its own
         boxed .fq-igroup at the row's end, same hover-label buttons. First
         tenant: Stats -> the tune modal. Future buttons append here. */
      dead ? null : quickHeadPills(subj, t)));

    /* Keep her light state current while the card is about her (throttled to
       one ask per 1.5 s per person — same loop-breaking gate as askEquipped).
       Skipped while fqProbing: the ⌕ search builds this card into a DETACHED
       node to index the reveals, and a card nobody sees must not put bridge
       traffic on the wire. */
    if (!fqProbing && bflPresent !== false && t && t.formId && !dead) askFacelight(t.formId);

    /* Same discipline for her effects — the ✨ draws itself the moment the
       DLL answers, and stays current while the card is hers. */
    if (!fqProbing && fxPresent !== false && t && t.formId && !dead) askEffects(t.formId);

    /* Same discipline for her SPID grants — the 📦 draws itself the moment
       the DLL answers, and stays current while the card is hers. */
    if (!fqProbing && sgPresent !== false && t && t.formId && !dead) askSpid(t.formId);

    /* COPY OUTFIT reveal — the checklist of her worn pieces + a name + Create. */
    if (ui.fqCopy && !dead) card.append(copyOutfitBlock(subj, who));

    /* FACELIGHT reveal — Re-light / on / off for the person in front of you. */
    if (ui.fqLight && !dead && bflPresent === true && t && t.formId)
      card.append(bflBlock(t, who));

    /* SPID GEAR reveal — her permanent grant list + the inbox chest. */
    if (ui.fqSpid && !dead && sgPresent === true && t && t.formId)
      card.append(sgBlock(t, who));

    /* DEBUG reveal — the raw engine dossier. Works on a corpse too: "why is
       she dead" starts with the same flags and factions. */
    if (ui.fqDebug && t && t.formId) card.append(debugBlock(t, who));

    /* What the GAME thinks of you, and the one control that changes it. Placed
       directly under the action row because it is the same kind of thing — a
       thing you do to the person in front of you — and above the NFF order
       chips because it outlasts them: an order holds until she is told
       otherwise, a rank holds until you move it back.
       Not offered on a corpse: SetRelationshipRank on the dead succeeds and
       means nothing, which is the definition of a control that lies. */
    if (!dead) {
      const rr = rankRow(t, who);
      if (rr) card.append(rr);
    }

    /* ORDER — how she behaves: a single Recruit/Dismiss status button, Freeze,
       Wait/Follow, and her per-follower Sandbox (Rober, 2026-08-05: recruit &
       dismiss as ONE status-based button, freeze here too, sandbox here). All
       are behaviour orders, so they live together rather than in the action
       palette. Shown for any living NPC (Recruit/Freeze always apply). */
    const nffSand = known && known.m.nffManaged;
    if (!dead) {
      const order = h('div', { class: 'fq-orders is-order fq-cgroup' },
        h('span', { class: 'fq-sets-lbl' }, h('span', { class: 'fq-cg-ic' }, groupIcon('order')), 'Order'));
      /* ONE button, meaning set by status — the deck's status-button idiom,
         now four states deep (Rober asked for the last one on 2026-08-11):
             following            ⊘ Dismiss            (armed two-click)
             wedged               🔧 Repair follower state
             cannot be asked      ✚ Make recruitable   (grants eligibility)
             can be asked         ⚔ Recruit            (honours forceRecruit)
         Each state offers the ONE thing that is actually available, so the
         slot never shows a control the game would refuse. */
      if (following) {
        /* A quest-held refusal arms the FORCE (see armForceDismiss): the button
           then says so, and one click fires — the refusal was the warning. */
        const dsArmed = !!forceDismiss;
        order.append(h('button', {
          class: 'fq-set danger' + (dsArmed ? ' armed' : ''), type: 'button',
          title: dsArmed ? forceDismiss.msg : 'Send ' + who + ' home through NFF — click twice',
          onClick: (e) => { e.stopPropagation();
            if (dsArmed) { dismissClick(subj); return; }
            arm(e.currentTarget, 'Dismiss ' + who + '?', 'Click again to send them home',
              () => dismissClick(subj)); },
        }, dsArmed ? '⊘ Force dismiss?' : '⊘ Dismiss'));
      } else if (t && t.wedged) {
        /* Recruiting a half-recruited NPC is what broke her — offer the
           repair in that slot instead, and say why the usual button is gone.
           (The full explanation is the ⚠ banner above.) */
        order.append(h('button', {
          class: 'fq-set fq-wedge-fix', type: 'button',
          title: 'Her follower state is broken — recruiting again is what causes '
            + 'this. Hand her back to nobody first, then ask her in her own dialogue.',
          onClick: (e) => { e.stopPropagation(); sendNpc('unwedge', subj); },
        }, '🔧 Repair follower state'));
      } else if (t.canFollow === false) {
        /* THE SAME SLOT, one step earlier (Rober, 2026-08-11: "can make
           recruitable and recruit be one dynamic button?"). She is not in
           PotentialFollowerFaction, so ⚔ Recruit would be asking someone the
           game will not let you ask. The button names the step that IS
           available; granting it flips this to ⚔ Recruit in place (the reply
           carries canFollow), so it reads as one control advancing rather
           than two buttons where only one ever works.
           Deliberately NOT chained into an automatic recruit: making her
           eligible is a durable change to her record and is worth wanting on
           its own, and a click that silently did both could not be stopped
           halfway when the voice check refuses. */
        const mfArmed = forceRecruit && forceRecruit.op === 'forceFollower';
        order.append(h('button', {
          class: 'fq-set' + (mfArmed ? ' armed' : ''), type: 'button',
          title: mfArmed ? forceRecruit.msg
            : who + ' cannot be asked to follow at all — she is not one of the '
              + 'game\'s potential followers.\n'
              + 'Click to make her eligible (NFF\'s MCM "Force Follower"): it adds her '
              + 'to PotentialFollowerFaction so the "follow me" dialogue works on her. '
              + 'This button then becomes ⚔ Recruit.\n'
              + 'Refused if her voice type has no follower dialogue, which would leave '
              + 'her recruitable but mute. Undoable afterwards (↩), except for the '
              + 'relationship change.',
          onClick: (e) => { e.stopPropagation(); makeFollowableClick(subj); },
        }, mfArmed ? '✚ Make recruitable anyway?' : '✚ Make recruitable'));
      } else {
        const recArmed = forceRecruit && forceRecruit.op === 'recruit';
        order.append(h('button', {
          class: 'fq-set' + (recArmed ? ' armed' : ''), type: 'button',
          title: recArmed ? forceRecruit.msg
            : 'Ask ' + who + ' to follow you — through Nether\'s Follower Framework',
          onClick: (e) => { e.stopPropagation(); recruitClick(subj); },
        }, recArmed ? '⚔ Recruit anyway?' : '⚔ Recruit'));
        /* THE UNDO, and the reason it is a second chip rather than another
           state of the one above: at this point ⚔ Recruit is the thing you
           almost always want, and burying it behind a toggle would cost the
           common action to serve the rare one.
           Shown ONLY for someone the deck (or NFF's MCM) put in the pool —
           `forcedFollow` is the rank -1 fingerprint, not merely "is a
           potential follower", because Lydia is one too and stripping it
           from her would break a vanilla companion. Two-click: it is the one
           permanent change in this group. */
        if (t.forcedFollow) {
          order.append(h('button', {
            class: 'fq-set', type: 'button',
            title: 'Take ' + who + ' back out of the follower pool — undoes '
              + '✚ Make recruitable, so she can no longer be asked to follow.\n'
              + 'Her opinion of you is NOT reverted: the deck never recorded what '
              + 'her relationship rank was before, and inventing one would be worse '
              + 'than leaving it.\nClick twice.',
            onClick: (e) => { e.stopPropagation();
              arm(e.currentTarget, 'Un-recruitable?',
                'Click again — ' + who + ' can no longer be asked to follow',
                () => sendNpc('unforceFollower', subj)); },
          }, '↩ Undo recruitable'));
        }
      }

      /* ⊘ Dismiss, a SECOND chip, when NFF disagrees with the engine.
         Rober, 2026-09-10: "this could use a dismiss button under order as
         well, if NFF detects they are following."

         The status button above keys off `following`, which is
         IsPlayerTeammate(). NFF keeps its followers in nwsFF_FollowerFac
         through states the engine does not count as a teammate — and in that
         state the card offered ⚔ Recruit (or ✚ Make recruitable) and hid the
         one control that would release her. So the disagreement gets its own
         chip rather than another state of that button: both facts are true at
         once, and collapsing them would have to throw one away.

         Not shown when she is simply following — the status button IS the
         Dismiss then, and two of them would be the same click twice. */
      if (!following && t.nffFollower) {
        const dsArmed = !!forceDismiss;
        order.append(h('button', {
          class: 'fq-set danger' + (dsArmed ? ' armed' : ''), type: 'button',
          title: dsArmed ? forceDismiss.msg
            : 'Nether\'s Follower Framework still lists ' + who + ' as one of '
            + 'your followers, even though the game does not have her as a '
            + 'teammate.\nDismissing releases her from NFF — the same call its '
            + 'own dismiss dialogue makes.\nClick twice.',
          onClick: (e) => { e.stopPropagation();
            if (dsArmed) { dismissClick(subj); return; }
            arm(e.currentTarget, 'Dismiss ' + who + '?',
              'Click again to release her from NFF',
              () => dismissClick(subj)); },
        }, dsArmed ? '⊘ Force dismiss?' : '⊘ Dismiss'));
      }

      /* Add to / remove from the framework — NFF's own "[Add to Framework
         (Import)]" verb, offered on ANY NPC (Rober, 2026-08-11: "force import
         (add to framework) … under the ORDER tab"). NFF only shows that
         dialogue when its own checks pass, so this button is the only way to
         reach someone it will not offer it for.

         Said as STATE, like Her sandbox: the label names what she IS and the
         tooltip says what one click changes it TO — the deck's idiom for a
         toggle, and the reason the old Recruit/Dismiss pair became one button.

         ⚠ This is NOT recruiting, and the wording must never imply it is.
         Import gives her NFF's FEATURES (gear, tweaks, spare storage,
         sandbox) and leaves her own follow package alone — which is exactly
         why it suits a custom follower mod's own companion, who Recruit warns about.
         It does not make her follow, and NFF cannot dismiss an imported
         follower; Remove (Export) is the way back. */
      {
        const imported = !!t.imported;
        order.append(h('button', {
          class: 'fq-set' + (imported ? ' on' : ''), type: 'button',
          title: imported
            ? who + ' is IN Nether\'s Follower Framework (imported), so she can '
              + 'use its gear, tweaks, spare storage and sandbox settings.\n'
              + 'Click to remove her from the framework (NFF\'s own Export). '
              + 'That does not dismiss her — it just stops NFF managing her.'
            : 'Add ' + who + ' to Nether\'s Follower Framework — NFF\'s own '
              + '"Add to Framework (Import)", forced through on anyone, even '
              + 'someone NFF would never offer it for.\n'
              + 'This does NOT recruit her and does not change who she follows: '
              + 'it lends her NFF\'s features (gear, tweaks, spare storage, '
              + 'sandbox) while her own follow package keeps running — which is '
              + 'what makes it the right tool for a companion with her own '
              + 'follower mod.\nClick again later to remove her.',
          onClick: (e) => { e.stopPropagation(); frameworkClick(subj, imported); },
        }, imported ? '⚑ In framework' : '⚑ Add to framework'));
      }
      /* (Make recruitable is no longer a button of its own — it is the first
         state of the Recruit button above.) */
      /* Freeze — hold her where she stands; toggles (same click releases). */
      order.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Hold ' + who + ' where she stands — click again to release',
        onClick: (e) => { e.stopPropagation(); toGame('hdFire', 'npc-freeze'); },
      }, '❄ Freeze'));
      /* Grab — Groovatron carry (Rober, 2026-08-05: "move grab to order"). The
         deck closes and C++ grabs the palette-open snapshot. */
      order.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Pick ' + who + ' up (Object Manipulation Overhaul): they follow your '
          + 'crosshair — walk & look to steer.\n'
          + 'Place · put back: Left click · Right click (or F7)\n'
          + 'Rotate: hold Middle Mouse or L-Ctrl + mouse\n'
          + 'Push · pull · raise: hold Shift + mouse\n'
          + 'More axes: Spacebar · Reset pose: Tab\nThe deck closes while you carry.',
        onClick: (e) => { e.stopPropagation(); toGame('hdFire', 'npc-grab'); },
      }, '✥ Grab'));
      /* Attack — send HER at the enemy (Rober, 2026-09-23: "a npc specific
         attack order as well"). The Everyone row's Attack, for one person:
         NpcActions::SicEmOne over fdNpc, addressed by formId so a pick off the
         party strip sends the picked follower, not the crosshair. The target
         is never her and never one of yours: the enemy under your crosshair,
         else along your aim, else the nearest one already fighting you — so
         it works while you are looking at her. The deck closes (Papyrus). */
      order.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Send ' + who + ' to attack, right now — skips the detection lag.\n'
          + 'Target: the enemy you are aiming at, or, if you are looking at '
          + who + ', the nearest enemy already fighting you.\n'
          + 'Frees her from a deck Freeze / Sit / Bed first. The deck closes.',
        onClick: (e) => { e.stopPropagation(); sendNpc('attack', subj); },
      }, '⚔ Attack'));
      if (window.GetAway) order.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Select nearby NPCs and give yourself 20–30 feet of space',
        onClick: (e) => { e.stopPropagation(); GetAway.open(whoOf(subj).formId); },
      }, 'Get away from me…'));
      /* ⚡ Direct — hand the scene a director instruction ABOUT THIS PERSON
         (Rober, 2026-09-21: "add a direct here as well if i search direct" and
         "how do i know im sending it to right person to be direct?").

         The Omni ⚡ Direct chip already exists but is scene-wide, so from there
         you are typing a name and hoping. Opening it from HER card seeds her
         name, which is the only steering the director pipe takes — and because
         this is a <button>, the card's own ⌕ search indexes it, so typing
         "direct" on the card finds it (fqScan walks buttons only, which is why
         searching "direct" previously surfaced Preset and Formation and not
         this).

         ⚠ Honest limit, stated in the tooltip rather than implied by the
         button: the DIRECTOR chooses who actually speaks. Naming her is a
         nudge, not a guarantee, and it only reaches NPCs CHIM is driving. */
      if (window.HDOmni && typeof HDOmni.open === 'function') {
        order.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Direct the scene with ' + who + ' named — opens the ⚡ Direct box '
               + 'seeded with her name.\n'
               + 'e.g. "' + who + ' brings up the baby over dinner".\n'
               + '⚠ The director LLM decides who actually speaks, and it only '
               + 'reaches NPCs CHIM is currently driving — the box lists them.',
          onClick: (e) => { e.stopPropagation(); HDOmni.open('direct', who + ' '); },
        }, '⚡ Direct…'));
      }
      /* Formation — Rober, 2026-08-06: Formation with Followers captured as a
         deck surface. The button opens the CENTERED modal (hd-formation.js);
         everything in it is the mod's own Papyrus state, driven live. Always
         present like Freeze/Grab — an absent/unfixed mod is said honestly
         INSIDE the modal (with the MO2 way forward) instead of a hidden
         button nobody can discover. */
      order.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Where ' + who + ' walks in your group — direction pad, spacing, '
          + 'and the whole formation’s settings (Formation with Followers)',
        onClick: (e) => { e.stopPropagation();
          if (window.HDFormation) HDFormation.open(whoOf(subj), who); },
      }, '⛬ Formation…'));
      if (following) {
        order.append(h('button', { class: 'fq-set', type: 'button',
          title: 'Tell ' + who + ' to wait here — NFF\'s own "wait" order',
          onClick: (e) => { e.stopPropagation(); sendNpc('wait', subj); } }, 'Wait here'));
        order.append(h('button', { class: 'fq-set', type: 'button',
          title: 'Tell ' + who + ' to follow you again',
          onClick: (e) => { e.stopPropagation(); sendNpc('follow', subj); } }, 'Follow me'));
      }
      if (nffSand) {
        /* Her per-follower sandbox checkbox, said as STATE. The old labels
           ("☾ Sandboxes" / "⊘ No sandbox") were the state too, but they read
           as commands, so the chip looked like a static button that always
           said no (Rober, 2026-08-09: "show if sandbox is enabled or disabled
           per npc and change the button based on that" — it did, invisibly).
           Now the label names her current setting outright, the tooltip says
           what one click changes it TO, and a payload that never carried the
           boolean (older DLL) is an honest unlabelled state, not a guess.
           "Her sandbox", never bare "Sandbox:" — the party strip's Sandbox
           Style chip also reads "Sandbox: off", and the two being findable by
           the same words is exactly how they were confused before. */
        const sbKnown = !!known.m.sandboxKnown;
        const sbOn = !!known.m.sandboxOn;
        /* NFF's GLOBAL Sandbox Style: 0 means nobody settles at all, so her
           own switch is dormant — say so, or an "On" that visibly does
           nothing reads as this button being broken. */
        const glvl = (state.nff && typeof state.nff.sandbox === 'number') ? state.nff.sandbox : -1;
        const globalNote = (glvl === 0)
          ? '\n⚠ NFF’s group Sandbox Style is Off, so nobody settles right now regardless — her switch waits until it is turned back on (the Everyone strip’s Sandbox button).'
          : '';
        order.append(h('button', {
          class: 'fq-set' + (sbKnown && sbOn ? ' on' : ''), type: 'button',
          title: !sbKnown
            ? 'Whether ' + who + ' may join in when the group sandboxes — NFF has not said which way her switch is set.\nClick to exclude her; click again to re-allow.'
            : sbOn
              ? who + '’s sandbox is ON: when the group settles, she joins in — wanders, sits, lives a little.' + globalNote + '\nClick to switch her to Off (she keeps formation instead).'
              : who + '’s sandbox is OFF: she stays in formation while the others settle.' + globalNote + '\nClick to switch her to On.',
          onClick: (e) => { e.stopPropagation(); sendNpc('sandboxActor', known.m, { on: !known.m.sandboxOn }); },
        }, !sbKnown ? '☾ Her sandbox' : sbOn ? '☾ Her sandbox: On' : '⊘ Her sandbox: Off'));
      }
      card.append(order);
    }

    /* MOVE — only for someone Follower Organizer already has, because these are
       its ops and they are addressed by (category, index), not by form id.
       Also gated on being in the world: FO keeps the entry for a follower whose
       plugin is not loaded, and teleporting to a base record is nonsense. */
    if (known && known.m.inWorld) {
      card.append(h('div', { class: 'fq-orders is-move fq-cgroup' },
        h('span', { class: 'fq-sets-lbl' }, h('span', { class: 'fq-cg-ic' }, groupIcon('move')), 'Move'),
        h('button', { class: 'fq-set', type: 'button',
          title: 'Bring ' + who + ' to you',
          onClick: (e) => { e.stopPropagation();
            sendWorld('summon', known.cat.index, known.idx, '⤵ ' + who + ' is on their way'); } }, '⤵ Summon'),
        h('button', { class: 'fq-set', type: 'button',
          title: 'Travel to ' + who,
          onClick: (e) => { e.stopPropagation();
            sendWorld('goto', known.cat.index, known.idx, '➜ ' + who); } }, '➜ Go to'),
        /* The DESTINATION picker, not a bare undo. The member menu has offered
           "Send back / send to…" since it was asked for; this button did not,
           so on the card - which is where you actually are when someone is in
           front of you - Send back looked like a one-trick control with no
           options. Same picker, same first row ("Where they were"), so the
           plain undo is still one click away.
           NOTE the shape: openSendTo wants `cat` as an INDEX, while `known`
           carries the category OBJECT. Passing `known` straight through would
           send cat=[object] and file the op against nothing. */
        h('button', { class: 'fq-set', type: 'button',
          title: 'Send ' + who + ' somewhere — back where they were, their'
               + ' MHIYH home, their NFF base, or any domain you have marked',
          onClick: (e) => { e.stopPropagation();
            openSendTo(e.currentTarget, { m: known.m, cat: known.cat.index, idx: known.idx }); } },
          '⮌ Send back…'),
        h('button', {
          class: 'fq-set' + (known.m.tracked ? ' on' : ''), type: 'button',
          title: known.m.tracked ? 'Stop tracking ' + who + ' on the map'
                                 : 'Put a map marker on ' + who,
          onClick: (e) => { e.stopPropagation();
            sendApply('setTracked', { cat: known.cat.index, idx: known.idx, on: !known.m.tracked }); } },
          known.m.tracked ? '✓ Tracked' : '⚑ Track')));
    }
    else if (known && liveTargetFid(t)) {
      /* She IS on the roster and she IS standing here — but Follower Organizer
         cannot address her, so its four ops are genuinely unavailable rather
         than merely hidden. This happens to a follower who was SPAWNED: her
         reference is a runtime 0xFF form with no source file, FO's
         FormToString() returns "" for it, and Member's serializer falls back to
         her BASE record (Kali, filed as "00_DemonKali"). FO then resolves that
         base, which is a form but never an actor.
         Say it, with the fix — re-filing her from this card stores whatever FO
         can see of her now. Everything that speaks to the GAME rather than to
         FO (Order, Home, her day) keeps working, because those address the
         crosshair reference. */
      card.append(h('div', { class: 'fq-orders is-move fq-cgroup is-noaddr' },
        h('span', { class: 'fq-sets-lbl' },
          h('span', { class: 'fq-cg-ic' }, groupIcon('move')), 'Move'),
        h('span', { class: 'fq-noaddr-note', title:
          'Follower Organizer stored ' + who + '’s BASE record rather than the '
          + 'reference standing here — which is what it falls back to for someone '
          + 'spawned at runtime. Summon, Go to, Send back and Track all go through '
          + 'FO and address that stored form, so they have nobody to act on.' },
          'Follower Organizer is holding ' + who + '’s base record, not the person '
          + 'standing here — its Summon / Go to / Send back have nothing to aim at.')));
    }

    /* FILE — the other half of the "unfiled" chip. Saying someone is not on the
       roster and offering no way to put them there is a dead end; this is the
       same addMember op the Followers tab's ＋Add uses, and it wants the form
       id as a NUMBER (unlike nfBuild, which wants hex text).
       A <select> rather than chips: FO has up to 25 categories, which is far
       too many to spell out in a row, and a native select is type-to-jump and
       keyboard-operable for free. */
    if (!known && state.cats.length) {
      /* A <select> used to live here and it was DEAD: Ultralight draws the
         closed control but has no native dropdown popup, so clicking it did
         nothing at all — the same class of gap as the missing window.prompt.
         Buttons and our own menu are the only controls this webview really
         has, so that is what this is now.
         Two of them, because filing someone is nearly always into the same
         category twice in a row: the left one is a ONE-CLICK repeat of
         wherever you filed someone last, the right one opens the picker. */
      const rosterRow = h('div', { class: 'fq-orders is-roster' },
        h('span', { class: 'fq-sets-lbl' }, 'Roster'));

      const lastCat = state.cats.filter((c) => c.index !== ALL
        && c.index === ui.fqLastCat)[0];
      if (lastCat) {
        rosterRow.append(h('button', {
          class: 'fq-set is-file-quick', type: 'button',
          title: 'Add ' + who + ' straight to ' + catLabel(lastCat)
               + ' — where you filed someone last',
          onClick: (e) => { e.stopPropagation(); fileInto(lastCat); },
        }, '＋ ' + catLabel(lastCat)));
      }

      rosterRow.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Add ' + who + ' to the roster, choosing the category',
        onClick: (e) => { e.stopPropagation(); openFileInto(e.currentTarget, t, who); },
      }, lastCat ? '＋ File elsewhere…' : '＋ Add to followers…'));

      card.append(rosterRow);
    }

    /* The set picker. NFF keeps THREE outfits per follower and the chest you
       open is a different one for each, so a single "Outfit" button would have
       to guess — and guessing wrong drops your clothes into the set she wears
       somewhere else entirely. One extra click buys certainty.
       Revealed rather than always shown, so the card stays three buttons wide
       until you actually want it. */
    if (ui.fqSets) {
      /* ---- PARITY WITH THE WARDROBE TAB'S PEOPLE CARD (2026-08-03) --------
         Everything from here to the Reset row answers the same questions the
         People card answers, in this card's denser idiom: one labelled row of
         chips per question, revealed rather than always on screen.
         `cl` is null when neither Wardrobe module has heard of her - then the
         rows below are simply not drawn, and the NFF Fill/Wear/Reset rows this
         card always had are unchanged. */
      const cl = clothesAbout();

      /* WHO DRESSES HER - the People card's LEAD control, and the one thing
         this card could never say. Three exclusive states; clicking a different
         one runs the Wardrobe pane's OWN handover (which clears the losing
         side in C++, so the two backends can never both hold her). */
      if (cl && cl.w) {
        const modeRow = h('div', { class: 'fq-sets is-managed' },
          h('span', { class: 'fq-sets-lbl', title:
            'Exactly one system dresses her. Switching hands her over — the '
            + 'losing side is cleared for you.' }, 'Dressed by'));
        [['wardrobe', '◇ Wardrobe', 'The deck assigns her outfits, through SOES-NG'],
         ['nff', '⛨ NFF', 'Nether’s Follower Framework dresses her — the three sets below'],
         ['off', '○ Nobody', 'Nobody manages her clothes — she wears what she wears'],
        ].forEach(function (row) {
          modeRow.append(h('button', {
            class: 'fq-set' + (cl.mode === row[0] ? ' on' : ''), type: 'button',
            'aria-pressed': String(cl.mode === row[0]),
            title: row[2],
            onClick: (e) => {
              e.stopPropagation();
              const wp = wardrobeApi();
              if (!wp) return;
              clothesSay(wp.quickSetManaged(cl.key || cl.w.key, row[0]));
            },
          }, row[1]));
        });
        card.append(modeRow);
      }

      /* WEAR IT NOW. "Fill" opens a chest to put clothes IN; this puts a set
         ON, which is what the People card's set chips do and what you actually
         want while she is standing in front of you. Piece counts and the ●
         come from NFF's own export, so a chip cannot claim a set that is empty.
         "Her own" is NFF's kBase — her original clothes back, sets untouched;
         it is NOT the destructive Reset below, which forgets them. */
      if (cl && cl.nf) {
        const wearRow = h('div', { class: 'fq-sets is-wear' },
          h('span', { class: 'fq-sets-lbl', title:
            'Put one of her NFF sets on right now' }, 'Wear'));
        NFF_SETS.forEach(function (sset) {
          const have = !!(cl.nf.have && cl.nf.have[sset.t]);
          const n = (cl.nf.counts && cl.nf.counts[sset.t] >= 0) ? cl.nf.counts[sset.t] : -1;
          const worn = cl.nf.worn === sset.t;
          const label = (cl.nf.labels && cl.nf.labels[sset.t]) || sset.name;
          wearRow.append(h('button', {
            class: 'fq-set' + (worn ? ' on' : ''), type: 'button',
            disabled: have ? null : true,
            'aria-current': worn ? 'true' : null,
            title: have
              ? (worn ? 'She is wearing this now — click to put it on again' : 'Put this on her now')
                + ' — ' + sset.hint + (n >= 0 ? ' · ' + n + ' piece' + (n === 1 ? '' : 's') : '')
              : 'Her ' + sset.name + ' set is empty — fill it first, with the row below',
            onClick: (e) => {
              e.stopPropagation();
              const nfp = nffApi();
              if (nfp) clothesSay(nfp.wearSet(cl.key, sset.t));
            },
          }, (worn ? '● ' : '') + label + (n > 0 ? ' ' + n : '')));
        });
        if (cl.nf.slot >= 0) {
          wearRow.append(h('button', {
            class: 'fq-set' + (cl.nf.worn === NFF_BASE ? ' on' : ''), type: 'button',
            title: 'Put her OWN original clothes back on. The three sets stay '
                 + 'exactly where they are — this is not the Reset row below.',
            onClick: (e) => {
              e.stopPropagation();
              const nfp = nffApi();
              if (nfp) clothesSay(nfp.wearSet(cl.key, NFF_BASE));
            },
          }, 'Her own'));
        }
        card.append(wearRow);
      }

      const fillRow = h('div', { class: 'fq-sets' },
        h('span', { class: 'fq-sets-lbl' }, 'Fill'),
        NFF_SETS.map((s) => h('button', {
          class: 'fq-set', type: 'button',
          title: 'Open ' + who + '’s ' + s.name + ' chest — ' + s.hint
               + '.\nThe deck closes, because NFF answers with a container menu.',
          onClick: (e) => { e.stopPropagation(); fillNffOutfit(s.t); },
        }, s.name)));
      /* Her SATCHEL — a FOURTH container, and the last one with no button here.
         NFF stows her own gear in it while one of its outfits is on, so it is
         where her real clothes went; it is not her pack (☰ Inventory), not
         the spare storage (⛃ Spare) and not the three outfit chests beside
         it. The People card has offered it since the redesign. */
      if (cl && cl.nf && cl.nf.slot >= 0) {
        fillRow.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Open ' + who + '’s NFF satchel — where NFF stows her own gear '
               + 'while one of its outfits is on. The deck closes.',
          onClick: (e) => {
            e.stopPropagation();
            const nfp = nffApi();
            if (nfp) clothesSay(nfp.openSatchel(cl.key));
          },
        }, '🎒 Satchel'));
      }
      /* The wardrobe half of Fill, moved here on 2026-08-03: it fills a set
         too, just from an outfit you already built instead of by hand. It used
         to be its own row labelled "Wear", which collided with the real Wear
         row above once that landed — two rows, one word, different verbs. */
      fillRow.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Fill one of ' + who + '’s NFF sets from a wardrobe outfit you '
             + 'already built — searchable. Pick the outfit, then which set.',
        onClick: (e) => { e.stopPropagation(); openWardrobeInto(e.currentTarget, t, who); },
      }, '⛨ From a wardrobe outfit…'));
      card.append(fillRow);

      /* WEAR — the wardrobe half. "Fill" only ever opened an EMPTY chest to put
         clothes in by hand; every outfit already built on the Wardrobe tab was
         unreachable from the card, which is why this area looked like NFF-only.
         nfCopy is the existing bridge (it is what the Wardrobe tab's own combo
         uses) and it copies a named wardrobe outfit INTO one of her three sets,
         so the destination has to be picked too — hence outfit first, then set. */

      /* RESET — "stop using NFF outfits", which used to exist in NFF's own
         dialogue and had no equivalent here. Type 3 (kBase) is not a set: it is
         NffOutfits::Clear's "drop her from the outfit system entirely, she has
         her own clothes back". The per-set ✕ is the narrower version.
         Armed, because it is the one control here that DESTROYS something. */
      const resetRow = h('div', { class: 'fq-sets' },
        h('span', { class: 'fq-sets-lbl' }, 'Reset'));
      NFF_SETS.forEach((sset) => {
        resetRow.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Forget ' + who + '’s ' + sset.name + ' outfit — that set only',
          onClick: (e) => { e.stopPropagation(); clearNffOutfit(sset.t, sset.name); },
        }, '✕ ' + sset.name));
      });
      resetRow.append(h('button', {
        class: 'fq-set' + (ui.fqArmReset ? ' on' : ''), type: 'button',
        title: ui.fqArmReset
          ? 'Click again to drop ' + who + ' from NFF outfits entirely'
          : 'Stop NFF dressing ' + who + ' at all — she goes back to her own clothes.'
            + '\nThis is the "reset outfit" that lives in NFF’s dialogue.',
        onClick: (e) => {
          e.stopPropagation();
          if (!ui.fqArmReset) { ui.fqArmReset = true; renderQuickCard(); return; }
          ui.fqArmReset = false;
          clearNffOutfit(3, 'NFF outfits');   // 3 = kBase, "her own outfit"
        },
      }, ui.fqArmReset ? '⟲ Sure?' : '⟲ Stop using NFF'));
      card.append(resetRow);

      /* SOES — the Wardrobe side of the same person, and the other half of the
         People card. Only drawn when the Wardrobe pane has heard of her, so a
         rig without SOES-NG never sees a row it cannot use.
           · Dress now  — apply her assigned outfit this second (SOES's own op)
           · Tracked    — whether SOES manages her equipment AT ALL. Refuses to
                          turn on with nothing assigned, in words, because SOES
                          STRIPS a tracked actor it cannot dress.
           · Her card   — the full assignment (outfit vs pool, cadence, per-place
                          overrides) is a page of controls, not a chip; this
                          jumps to it rather than reproducing it here. */
      if (cl && cl.w) {
        const soesRow = h('div', { class: 'fq-sets is-soes' },
          h('span', { class: 'fq-sets-lbl', title: cl.w.label
            ? 'Assigned: ' + cl.w.label + (cl.w.cadence ? ' · changes every ' + cl.w.cadence : '')
            : 'Skyrim Outfit System — the deck’s own outfit backbone' }, 'SOES'));
        soesRow.append(h('button', {
          class: 'fq-set', type: 'button',
          disabled: cl.w.canDress ? null : true,
          title: cl.w.canDress
            ? 'Put ' + who + '’s assigned outfit on her right now'
            : (cl.w.soes ? 'Nothing is assigned to her — pick ◇ Wardrobe above, then her card'
                         : 'SOES-NG isn’t answering, so there is nothing to dress her with'),
          onClick: (e) => {
            e.stopPropagation();
            const wp = wardrobeApi();
            if (wp) clothesSay(wp.quickDress(cl.w.key));
          },
        }, '✦ Dress now'));
        soesRow.append(h('button', {
          class: 'fq-set' + (cl.w.tracked ? ' on' : ''), type: 'button',
          'aria-pressed': String(!!cl.w.tracked),
          title: cl.w.tracked
            ? 'SOES-NG manages ' + who + '’s equipment. Click to leave her alone.'
            : 'Let SOES-NG manage ' + who + '’s equipment. It refuses while nothing '
              + 'is assigned — a tracked actor it cannot dress gets STRIPPED.',
          onClick: (e) => {
            e.stopPropagation();
            const wp = wardrobeApi();
            if (wp) clothesSay(wp.quickTrack(cl.w.key, !cl.w.tracked));
          },
        }, cl.w.tracked ? '✓ Tracked' : '◇ Track'));
        soesRow.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Open ' + who + '’s full Wardrobe card — which outfit or pool, how '
               + 'often it changes, and what she wears in each kind of place',
          onClick: (e) => {
            e.stopPropagation();
            const wp = wardrobeApi();
            if (!wp) return;
            /* setTab BEFORE focusing: the Wardrobe pane's onShow re-reads its
               state and re-renders, which would wipe a sheet opened first. */
            if (typeof window.__omniSetTab === 'function') window.__omniSetTab('wardrobe');
            wp.quickFocus(cl.w.key);
          },
        }, '◇ Her card…'));
        card.append(soesRow);
      }
    }

    /* ---- 🎭 RaceMenu preset (Preset Director) ---------------------------
       A reveal like ⛨ Outfit. Everything inside repaints ITSELF (pdPaint)
       rather than the whole card, because the search box would lose keyboard
       focus on every keystroke otherwise — the rank slider taught this card
       that lesson already. Modes are chips: Apply (default), Summon (clicking
       a tile spawns a NEW person wearing it), Assign (clicking a tile picks
       which image file represents it). */
    /* HOME (My Home is Your Home NG). The card could READ her day since the
       dayBlock landed, but not change any of it — so "where does she live" was
       a read-only fact you had to go and set through her dialogue. These are
       the same setHome / forgetHome ops the member menu already sends, on the
       person standing in front of you, which is exactly when you know where
       you want her to live: you are standing in it.
       ⚠ THE GATE. This used to be `known && known.m.inWorld` — Follower
       Organizer's own answer — and that is a different question from the one
       being asked. FO says inWorld only when the form it STORED resolves to a
       reference, and for a follower spawned at runtime it cannot store one: a
       0xFF ref has no source file, so FO falls back to her BASE NPC_ record
       and then truthfully reports "not in the world" about somebody standing
       in front of you (Kali, 2026-09-20 — "weirdly no home tab options for
       this f7 on an npc?"). The whole Home group vanished, and the answer was
       her dialogue instead.
       What MHiYH actually needs is a REFERENCE, and the crosshair always has
       one. So the gate is "do we have an actor to hand it", and the ops are
       addressed at `homeM` — the live reference when the card is looking at
       her, the roster's stored id when it is showing a picked face. Someone FO
       has never heard of gets the group too: MHiYH's own gates (and the borrow
       that satisfies the follower one) are what decide, in words. */
    const homeM = actorSubjectOf(known, t, who);
    /* `!dead` guards only the WIDENING. The FO-addressable case is left exactly
       as it was, corpse included: forgetting a dead follower's home is still a
       thing you may want to do, and taking that away would be a regression
       hiding inside a fix. */
    if (homeM && ((liveTargetFid(t) && !dead) || (known && known.m.inWorld))) {
      const homeRow = h('div', { class: 'fq-sets fq-cgroup' },
        h('span', { class: 'fq-sets-lbl' }, h('span', { class: 'fq-cg-ic' }, groupIcon('home')), 'Home'));
      homeRow.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Make where you are standing ' + who + '’s MHIYH home'
             + (homeM.mhHome ? '\nReplaces: ' + homeM.mhHome : ''),
        onClick: (e) => {
          e.stopPropagation();
          fqStatus = { msg: 'Setting ' + who + '’s home here…', ok: true, pending: true };
          sendMhiyh('setHome', homeM, KIND_HOME);
          renderQuickCard();
        },
      }, '⌂ Home is here'));
      if (homeM.mhHome) {
        homeRow.append(h('button', {
          class: 'fq-set' + (ui.fqArmHome ? ' on' : ''), type: 'button',
          title: ui.fqArmHome ? 'Click again to forget it'
                              : 'Forget ' + who + '’s home (' + homeM.mhHome + ')',
          onClick: (e) => {
            e.stopPropagation();
            if (!ui.fqArmHome) { ui.fqArmHome = true; renderQuickCard(); return; }
            ui.fqArmHome = false;
            fqStatus = { msg: 'Forgetting ' + who + '’s home…', ok: true, pending: true };
            sendMhiyh('forgetHome', homeM, KIND_HOME);
            renderQuickCard();
          },
        }, ui.fqArmHome ? '✕ Sure?' : '✕ Forget home'));
      }
      /* The REST of her day. "⌂ Home is here" was the only MHiYH control the
         card ever had, so where she sleeps, works, stands guard and eats each
         meal was reachable only from her member menu on the Followers tab —
         the one place you are NOT standing when the answer to "where should she
         work" is "right here, this room".
         Disabled rather than hidden when she has no home: MHiYH refuses every
         stop until the home exists (its rule, not ours), and a control that
         quietly vanishes teaches nothing, while one that says why teaches the
         rule once. */
      const canSpot = !!homeM.mhHome;
      homeRow.append(h('button', {
        class: 'fq-set', type: 'button',
        disabled: canSpot ? null : true,
        title: canSpot
          ? 'Mark where you are standing as where ' + who + ' sleeps, works, '
            + 'stands guard or eats — or clear one of those stops'
          : 'My Home is Your Home refuses every other stop until she has a HOME. '
            + 'Set that first, with the button beside this one.',
        onClick: (e) => {
          e.stopPropagation();
          if (!canSpot) return;
          /* `homeM`, not `known` — the pickers only read `.m`, and the one they
             must read is the actor we can actually address (see the gate). */
          openSpotPicker(e.currentTarget, { m: homeM }, who);
        },
      }, '⚑ Set a spot…'));
      /* Her NFF BASE — the other home, and until now read-only here. Only
         offered when NFF is actually answering AND the player has bases set
         up; an empty picker would be a button that can only disappoint. */
      if (state.nff.nff && state.nff.bases.length) {
        homeRow.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Set ' + who + '’s NFF home base'
               + (homeM.nffHome ? '\nCurrently: ' + homeM.nffHome : ''),
          onClick: (e) => { e.stopPropagation(); openNffBase(e.currentTarget, { m: homeM }, who); },
        }, '⌂ NFF base…'));
      }
      /* A little inline card showing WHERE she actually lives — her assigned
         MHIYH home and/or NFF base, with her portrait if the deck has one
         (Rober, 2026-08-05). On the same line as the Home buttons, so the
         answer to "where is she stationed" sits right beside the controls that
         set it. Silent when no home is assigned. */
      if (homeM.homeName) {
        /* A CLICKABLE card showing WHERE she lives — her MHIYH home / NFF base,
           her portrait, and a jump to the Domains tab (Rober, 2026-08-05:
           "show the domain icon etc and clicking it takes you to that domain
           tab"). Pre-fills the Domains filter with the home name so the marked
           place, if you have one, is the top hit. */
        const info = h('button', { class: 'fq-homeinfo', type: 'button', title:
          homeM.homeSrc + ' home: ' + homeM.homeName
          + (homeM.homeAlt ? '\nAlso ' + (homeM.homeSrc === HOME_SRC.nff ? 'MHIYH' : 'NFF')
                                       + ': ' + homeM.homeAlt : '')
          + '\nClick → Domains tab',
          onClick: (e) => {
            e.stopPropagation();
            if (window.DomainsPane && window.DomainsPane.openWithFilter)
              window.DomainsPane.openWithFilter(homeM.homeName);
            else if (window.__omniSetTab) window.__omniSetTab('domains');
          } });
        const p = portraitFor(homeM);
        if (p) {
          const face = h('span', { class: 'fq-homeinfo-face' });
          face.style.backgroundImage = 'url("' + portraitSrc(p) + (!p.abs && p.mtime ? '?v=' + p.mtime : '') + '")';
          info.append(face);
        } else {
          info.append(h('span', { class: 'fq-homeinfo-ic' }, '⌂'));
        }
        info.append(h('span', { class: 'fq-homeinfo-txt' },
          h('span', { class: 'fq-homeinfo-src' }, homeM.homeSrc),
          h('span', { class: 'fq-homeinfo-name' }, homeM.homeName)));
        info.append(h('span', { class: 'fq-homeinfo-go' }, '↗'));
        homeRow.append(info);
      } else if (known) {
        /* No MHIYH/NFF home assigned yet — a muted placeholder so the domain
           slot is VISIBLE (Rober, 2026-08-05: "i see nothing in home that shows
           a domain"). It becomes the live domain pill once a home is set.
           Only for someone ON THE ROSTER: her home is read off the entry C++
           builds per roster member, so for an unfiled NPC "No home" would not
           be a fact, it would be us not having looked. Say nothing instead. */
        homeRow.append(h('span', { class: 'fq-homeinfo empty' },
          h('span', { class: 'fq-homeinfo-ic' }, groupIcon('home')),
          h('span', { class: 'fq-homeinfo-txt' },
            h('span', { class: 'fq-homeinfo-src' }, 'No home'),
            h('span', { class: 'fq-homeinfo-name' }, 'Set one above'))));
      }
      card.append(homeRow);
    }

    /* The framing panel. Deliberately NOT a live preview: a portrait is a
       screen grab with the HUD hidden and the palette closed, so there is
       nothing to preview while the panel is open. The loop is nudge → Portrait
       → look → nudge, and the panel stays open across it because it is stored
       in ui, not in the button. */
    /* (Hide gear is per-tile in the EQUIPPED container now — no card-level
       gear panel.) */

    if (ui.fqFraming) {
      const pan = h('div', { class: 'fq-sets fq-framing' },
        h('span', { class: 'fq-sets-lbl', title:
          'The crop the next portrait will use. Saved to capture.ini, the same '
          + 'file the web portal edits.' }, 'Frame'));

      if (!framing) {
        pan.append(h('span', { class: 'fq-rank-note' }, 'reading capture.ini…'));
        card.append(pan);
      } else {
        /* Zoom is the fraction of the frame KEPT, so smaller = closer. The
           labels say "in"/"out" rather than the number's direction, because
           "zoom in" meaning "smaller number" is exactly the sort of thing that
           makes you click the wrong one twice. */
        const nudgeF = (glyph, tip, patch, dis) => h('button', {
          class: 'fq-set', type: 'button', disabled: dis ? true : null, title: tip,
          onClick: (e) => { e.stopPropagation(); setFraming(patch); },
        }, glyph);

        pan.append(nudgeF('＋ In', 'Tighter crop — more of the face',
          { zoom: framing.zoom - 0.05 }, framing.zoom <= 0.16));
        pan.append(nudgeF('－ Out', 'Wider crop — less chance of clipping the head',
          { zoom: framing.zoom + 0.05 }, framing.zoom >= 0.995));
        pan.append(nudgeF('▲', 'Move the crop UP', { offsetY: framing.offsetY - 0.02 },
          framing.offsetY <= -0.495));
        pan.append(nudgeF('▼', 'Move the crop DOWN', { offsetY: framing.offsetY + 0.02 },
          framing.offsetY >= 0.495));
        pan.append(nudgeF('◀', 'Move the crop LEFT', { offsetX: framing.offsetX - 0.02 },
          framing.offsetX <= -0.495));
        pan.append(nudgeF('▶', 'Move the crop RIGHT', { offsetX: framing.offsetX + 0.02 },
          framing.offsetX >= 0.495));
        pan.append(h('span', { class: 'fq-frame-val', title:
          'zoom ' + framing.zoom.toFixed(2) + ' · offsetx ' + framing.offsetX.toFixed(2)
          + ' · offsety ' + framing.offsetY.toFixed(2) },
          Math.round(framing.zoom * 100) + '%',
          h('i', null, fmtOff(framing.offsetX, framing.offsetY))));
        pan.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Back to the shipped framing (' + Math.round(framing.defZoom * 100) + '%)',
          disabled: (framing.zoom === framing.defZoom && framing.offsetX === framing.defOffsetX
            && framing.offsetY === framing.defOffsetY) ? true : null,
          onClick: (e) => { e.stopPropagation();
            setFraming({ zoom: framing.defZoom, offsetX: framing.defOffsetX,
                         offsetY: framing.defOffsetY }); },
        }, '⟲ Default'));
        card.append(pan);
      }
    }

    /* What the last order actually did, ON THE CARD. A toast is easy to miss
       and gone in seconds, and a refusal ("she has her own follower system",
       "SOES-NG is dressing her") is the most useful sentence on screen —
       exactly the one you want still there while you decide what to do. */
    if (fqStatus.msg) {
      card.append(h('div', { class: 'fq-status' + (fqStatus.ok ? '' : ' bad') },
        h('span', { class: 'fq-status-ic' }, fqStatus.ok ? (fqStatus.pending ? '⋯' : '✓') : '⚠'),
        h('span', null, fqStatus.msg)));
    }

    /* The worn set, for the same person. Collapsed by default with the count
       visible — see equippedBlock.

       buildQuickCard deliberately does NOT ask for it. Every fdEquipped reply
       re-renders this card, so asking here means each reply provokes another
       request — a slow poll once the same-key gate expires. The ask belongs to
       the two moments the ANSWER can actually be stale: mounting the card, and
       a new person under the crosshair. */
    /* EQUIPPED — the framed mesh-square container on the card (the collapsible
       list `equippedBlock` is still what the member menu uses). Not on a
       corpse: nothing to hide/photograph and removeItem on the dead is looting. */
    if (!dead) card.append(equippedContainer(subj, who));
    /* Stats moved onto the name line (quickHeadPills) for the living;
       a corpse has no side panel, so the old bottom row still serves it */
    if (dead) card.append(tuneRow(subj, t));
    /* The party row, UNDER this one person's controls — but ONLY on the
       Hotkeys-tab quick card (#fq-card), which has no #fd-everyone bar of its
       own. On the Followers tab the Everyone controls already ride ABOVE the
       card (renderEveryoneBar → #fd-everyone), so rendering them here too put a
       second copy at the BOTTOM (Rober, 2026-08-05: "everyone still at bottom
       of list too"). */
    if (!quickHost || (quickHost.id !== 'fd-quick' && quickHost.id !== 'fd-dossier-controls')) card.append(partyBlock());

    /* A card with a name and NO controls is the one output this builder must
       never produce — it reads as the deck being broken, which is exactly how
       it was reported ("its just opening a blank area"). Every control group is
       gated, and the gates can all close at once: Order on !dead, Move and Home
       on inWorld. When that happens, say which gate shut and what it is reading
       from, so the card is a diagnosis instead of a blank box. */
    if (!card.querySelector('.fq-orders')) {
      const why = [];
      if (dead) why.push('as DEAD');
      if (known && known.m && !known.m.inWorld) why.push('as not loaded in the world');
      card.append(h('div', { class: 'fq-empty fq-empty-why' },
        h('span', { class: 'fq-empty-ic' }, '⚠'),
        h('span', null, why.length
          ? ('Follower Organizer reports ' + who + ' ' + why.join(' and ')
             + ', so none of her controls apply. If she is standing next to you that '
             + 'record is stale — look at her directly and the card rebuilds from the '
             + 'engine instead.')
          : ('No controls apply to ' + who + ' right now.'))));
    }
    return card;
  }

  /* Point the one card at `host` and fill it. Shared by both mount sites (the
     deck tab's #fq-card via app.js, and our own #fd-quick), so the one-ask-per-
     mount rule and the give-up timer below cannot drift between them. */
  function mountQuick(host) {
    const fresh = quickHost !== host;
    quickHost = host || null;
    renderQuickCard();
    /* Who dresses her, and what her NFF sets hold. Owned by the Wardrobe
       modules; this card only asks, and askClothes' own gate makes it once per
       (palette open x person) rather than once per render. Deliberately OUTSIDE
       the `fresh` branch below: the card is re-mounted into the SAME host
       element every time, so `fresh` is false on a re-open and the block would
       be built from whatever was true when the deck last opened. Without any
       ask at all it is empty until you have visited the Wardrobe tab — which is
       the one errand this card exists to save you. */
    if (quickHost) askClothes();
    if (fresh && quickHost) {
      /* The ask itself now lives in renderQuickCard (see syncQuickEquipped) —
         it has to, because the subject can change without a re-mount. */
      /* Bounded wait. The skeleton is honest only while an answer is still
         plausibly coming; a DLL older than the fdTarget-at-open push will
         never send one, and a permanent skeleton is a worse lie than "look
         at an NPC". After this we give up and say the useful thing. */
      if (!state.targetKnown) {
        if (targetWait) clearTimeout(targetWait);
        targetWait = setTimeout(function () {
          targetWait = 0;
          if (state.targetKnown) return;
          state.targetKnown = true;
          renderQuickCard();
        }, 1200);
      }
    }
  }

  /* Render (or re-render) the card into `host`. Idempotent: called on mount,
     and again whenever fdTarget / fdNpc / fdEquipped land. */
  function renderQuickCard() {
    if (!quickHost || !quickHost.isConnected) return;
    /* BEFORE the build, so the card that gets painted and the request that
       goes out are about the same person, and a stale status line from the
       previous subject never reaches the DOM at all. */
    const subj = quickSubject();
    syncQuickStatus(subj);
    syncQuickEquipped(subj);
    quickHost.textContent = '';
    quickHost.append(buildQuickCard());
    renderEveryoneBar();   // the framed party bar ABOVE the card (Followers tab)
    /* The rank slider is the one control here whose element is DESTROYED by its
       own commit — you let go, the card redraws, and the thing under your
       fingers is gone along with the keyboard focus that made ←/→ work. Put it
       back exactly once, and only when the slider itself asked for it. */
    if (rankFocus) {
      rankFocus = false;
      const s = quickHost.querySelector('.fq-rank-slider');
      if (s && s.focus) s.focus();
    }
    /* The ⌕ search bar is DESTROYED by the same wipe — and its index holds
       element refs into the card that just went away. Put the caret back and
       re-read the card, or the first Enter after any bridge push would click a
       detached button (i.e. nothing at all). */
    if (FQF.open) fqFindRestore();
    if (ctxEl && ctxEl._dossier && quickHost === ctxEl._dossier.controlsHost) ctxEl._dossier.refreshSearch();
  }

  /* ================================================== member action menu == */

  let ctxEl = null;
  function ctxOutside(e) { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }
  function closeCtx() {
    if (!ctxEl) return;
    disarm();           // an armed Forget must never survive its own menu
    const dossier = ctxEl._dossier;
    ctxEl.remove(); ctxEl = null;
    if (dossier) dossier.close();
    ui.menuFor = null;
    ui.catIconFor = -1;   // the icon picker rides this same element
    document.removeEventListener('mousedown', ctxOutside, true);
  }

  /* Redraw the OPEN member menu in place, at the same corner.
     The day panel is the one thing in the menu a C++ push can invalidate: fire
     "set her work spot here", and half a second later fdNff arrives with a
     different day than the menu is showing. Rebuilding via openMemberMenu
     rather than patching keeps exactly one code path constructing the menu —
     and it is cheap, since the menu is built from `m` from scratch every time
     anyway. A no-op when no menu is open, or when the roster moved underneath
     it (the row is looked up again, never cached). */
  function refreshOpenMenu() {
    if (!ctxEl || !ui.menuFor) return;
    const at = { x: parseFloat(ctxEl.style.left), y: parseFloat(ctxEl.style.top) };
    const saved = ctxEl._dossier ? ctxEl._dossier.snapshot() : null;
    const want = ui.menuFor;
    const row = visibleRows().filter(function (r) {
      return r.cat === want.cat && (want.formId
        ? r.m.formId === want.formId && (r.m.original || r.m.name) === want.original
        : r.idx === want.idx);
    })[0];
    if (!row) { closeCtx(); return; } // Never leave stale action indices on screen.
    if (ctxEl._dossier && ctxEl._dossier.keepEditing && ctxEl._dossier.keepEditing()) { ctxEl._dossier.paintDayStatus(); return; }
    openMemberMenu(row, isFinite(at.x) ? at.x : 120, isFinite(at.y) ? at.y : 120, saved);
  }
  function clampCtx(x, y) {
    /* offsetWidth/Height, NOT getBoundingClientRect(). The menu opens under
       `animation: fdCtxIn` which includes `scale(.98)`, and getBoundingClientRect
       reports the TRANSFORMED box — so measuring here, one frame into the
       animation, returned 586px for a menu that settles at 598px and the clamp
       placed it 12px too low, hanging 6px off the bottom of the screen at the
       sizes where the menu is tallest. The layout box is transform-independent
       and already final on the frame the element is inserted. */
    /* PAINTED size = layout offset × --ui-scale (transform-origin: top left),
       and left/top are real viewport px — so clamp the SCALED extent. */
    const s = deckScale();
    const w = ctxEl.offsetWidth * s, hgt = ctxEl.offsetHeight * s;
    const vp = ctxViewport();
    let nx = x, ny = y;
    if (nx + w > vp.w - 6) nx = vp.w - w - 6;
    if (ny + hgt > vp.h - 6) ny = vp.h - hgt - 6;
    ctxEl.style.left = Math.max(6, nx) + 'px';
    ctxEl.style.top = Math.max(6, ny) + 'px';
  }

  /* The box the menu is actually positioned inside.
   *
   * It used to clamp against window.innerWidth/Height. That is an ASSUMPTION —
   * that the window and the painted surface are the same box — and it holds in
   * a browser but is not guaranteed under Ultralight, where the view's logical
   * size is set by the host. #overlay is position:fixed inset:0 and is the
   * menu's offsetParent, so its own rect is the coordinate space the menu is
   * placed in, by construction. Measure that instead of trusting the window.
   */
  function ctxViewport() {
    const host = document.getElementById('overlay');
    if (host) {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }

  /* The deck-wide Menu scale (#panel's transform: scale(--ui-scale), driven by
   * ⛶ Fill). #fd-ctx-menu is an #overlay child OUTSIDE that transform, so it now
   * wears --ui-scale itself (see #fd-ctx-menu in app.css). Everything the menu
   * measures with offsetWidth/Height is PRE-transform layout px; multiply by
   * this before comparing to the real-px viewport, or a Filled deck's menu is
   * clamped as if it were 1× and hangs off-screen. Falls back to 1. */
  function deckScale() {
    try {
      const v = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--ui-scale'));
      if (isFinite(v) && v > 0) return v;
    } catch (e) {}
    return 1;
  }
  /* Layout-px height cap so the PAINTED height (cap × scale) fits the viewport. */
  function ctxMaxHpx(floor) {
    return Math.max(floor || 220, (ctxViewport().h - 24) / deckScale());
  }

  /* Drag the menu by its header.
   *
   * The clamp keeps it on screen, but "on screen" and "where you want it" are
   * not the same thing — it can still land over the row you were reading. So
   * let it be moved. The HEADER is the handle, not the whole menu: dragging
   * from anywhere would fight the item clicks, the text inputs and the internal
   * scroll.
   *
   * Two things this must not break: the click-outside-to-close listener (it is
   * on mousedown, so a drag starting on the header must not look like an
   * outside click), and item activation (a press that MOVED is a drag, not a
   * click, so we swallow the click that follows it).
   */
  function makeCtxDraggable(head) {
    if (!head) return;
    head.classList.add('fd-ctx-drag');
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !ctxEl) return;
      e.preventDefault();
      e.stopPropagation();                 // never read as an outside-click
      const startX = e.clientX, startY = e.clientY;
      const baseX = parseFloat(ctxEl.style.left) || 0;
      const baseY = parseFloat(ctxEl.style.top) || 0;
      let moved = false;

      const move = (ev) => {
        if (!ctxEl) return;
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;   // tolerate a shaky click
        moved = true;
        head.classList.add('dragging');
        const vp = ctxViewport();
        const sc = deckScale();
        const w = ctxEl.offsetWidth * sc, hgt = ctxEl.offsetHeight * sc;   // PAINTED extent
        // clamp while dragging, so it cannot be thrown off the edge
        const nx = Math.min(Math.max(6, baseX + dx), Math.max(6, vp.w - w - 6));
        const ny = Math.min(Math.max(6, baseY + dy), Math.max(6, vp.h - hgt - 6));
        ctxEl.style.left = nx + 'px';
        ctxEl.style.top = ny + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        head.classList.remove('dragging');
        // a press that moved is a drag: eat the click it would otherwise fire
        if (moved) {
          const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
          document.addEventListener('click', eat, { capture: true, once: true });
          setTimeout(() => document.removeEventListener('click', eat, true), 0);
        }
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  /* Re-clamp once the frame has settled. The menu is measured the instant it is
   * inserted; anything that changes its height afterwards (a late fdNff/
   * fdFertility repaint, a font or portrait landing) would otherwise leave it
   * hanging off the bottom with a stale position. Cheap, and idempotent. */
  function reclampCtx() {
    if (!ctxEl) return;
    const at = { x: parseFloat(ctxEl.style.left) || 0, y: parseFloat(ctxEl.style.top) || 0 };
    requestAnimationFrame(() => {
      if (!ctxEl) return;
      const vp = ctxViewport();
      const hgt = ctxEl.offsetHeight, w = ctxEl.offsetWidth;
      let ny = at.y, nx = at.x;
      if (ny + hgt > vp.h - 6) ny = vp.h - hgt - 6;
      if (nx + w > vp.w - 6) nx = vp.w - w - 6;
      ctxEl.style.top = Math.max(6, ny) + 'px';
      ctxEl.style.left = Math.max(6, nx) + 'px';
    });
  }

  function clampDossierSize(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(75, Math.min(130, Math.round(n / 5) * 5)) : 100;
  }

  // dossier-portrait-frame: page-only, layout-sized, draggable framing.
  function dossierFrameValue(raw) {
    const c = raw || {}, bound = (n, lo, hi, fallback) => typeof n === 'number' && isFinite(n) ? Math.max(lo,Math.min(hi,n)) : fallback;
    const value = {z:bound(c.z,1,3,1), x:bound(c.x,0,1,.5), y:bound(c.y,0,1,.3)};
    if (c.fit === 'contain') value.fit = 'contain';
    return value;
  }
  function dossierPortraitFrame(frame, img, wrap, seed, commit) {
    let value = dossierFrameValue(seed), savedValue = dossierFrameValue(seed), editing = false, drag = null;
    const btn = (label,fn) => h('button',{type:'button',class:'fd-ds-button',onClick:function(e){e.stopPropagation();fn();}},label);
    const adjust = btn('Adjust framing',function(){editing=true;paint();frame.focus();});
    adjust.classList.add('fd-ds-frame-toggle');
    adjust.setAttribute('aria-expanded','false');
    const zoom = h('input',{type:'range',min:'100',max:'300',step:'5','aria-label':'Portrait zoom',onInput:function(e){value.z=Number(e.target.value)/100;value=dossierFrameValue(value);paint();}});
    const output = h('output');
    const hint = h('p',{class:'fd-ds-frame-hint'},'Drag the portrait or use arrow keys. Zoom in to move further.');
    const tools = h('div',{class:'fd-ds-frame-tools'},h('label',null,'Zoom',zoom,output),
      btn('Reset',function(){value=dossierFrameValue(seed && seed.fit === 'contain' ? {fit:'contain',y:.5} : null);paint();}),
      btn('Cancel',function(){value=dossierFrameValue(savedValue);editing=false;drag=null;paint();adjust.focus();}),
      btn('Save framing',function(){savedValue=dossierFrameValue(value);editing=false;drag=null;commit(savedValue);paint();adjust.focus();}),hint);
    wrap.append(adjust,tools);
    frame.setAttribute('tabindex','0');frame.setAttribute('aria-label','Portrait framing');
    function paint() {
      // At z=1, object-position pans the source's natural cover overflow.
      img.style.position='absolute'; img.style.maxWidth='none';img.style.maxHeight='none';
      img.style.width=(value.z*100)+'%';img.style.height=(value.z*100)+'%';
      img.style.left=(-(value.z-1)*value.x*100)+'%';img.style.top=(-(value.z-1)*value.y*100)+'%';
      img.style.objectFit=value.fit || 'cover';img.style.objectPosition=(value.x*100)+'% '+(value.y*100)+'%';img.style.transform='none';
      tools.hidden=!editing;adjust.hidden=editing;adjust.setAttribute('aria-expanded',String(editing));
      frame.classList.toggle('fd-ds-framing',editing);zoom.value=String(Math.round(value.z*100));output.textContent=zoom.value+'%';
    }
    function down(e){
      if(!editing || (e.button !== undefined && e.button !== 0))return;
      const r=frame.getBoundingClientRect(), iw=img.naturalWidth||r.width, ih=img.naturalHeight||r.height;
      const scale=(value.fit === 'contain' ? Math.min(r.width/iw,r.height/ih) : Math.max(r.width/iw,r.height/ih))*value.z;
      drag={x:e.clientX,y:e.clientY,vx:value.x,vy:value.y,ox:Math.max(0,iw*scale-r.width),oy:Math.max(0,ih*scale-r.height)};
      e.preventDefault();e.stopPropagation();frame.focus();
    }
    function move(e){if(!drag)return;
      value.x=drag.ox>0?drag.vx-(e.clientX-drag.x)/drag.ox:value.x;
      value.y=drag.oy>0?drag.vy-(e.clientY-drag.y)/drag.oy:value.y;
      value=dossierFrameValue(value);paint();e.preventDefault();
    }
    function up(){drag=null;}
    function key(e){if(!editing || (e.key!=='Escape' && e.target!==frame))return;
      const step=e.shiftKey?.1:.025;
      if(e.key==='ArrowLeft')value.x+=step;else if(e.key==='ArrowRight')value.x-=step;
      else if(e.key==='ArrowUp')value.y+=step;else if(e.key==='ArrowDown')value.y-=step;
      else if(e.key==='Escape'){value=dossierFrameValue(savedValue);editing=false;drag=null;}
      else return;
      value=dossierFrameValue(value);paint();e.preventDefault();e.stopPropagation();e._fdDossierHandled=true;return true;
    }
    frame.addEventListener('mousedown',down);frame.addEventListener('keydown',key);
    document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
    paint();
    return {key:key,snapshot:function(){return {value:dossierFrameValue(value),editing:editing};},
      restore:function(s){value=dossierFrameValue(s.value);editing=!!s.editing;paint();},
      destroy:function(){drag=null;document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);}};
  }

  /* Full-screen character dossier. Existing action nodes keep their closures,
     guards and bridge verbs; only the composition changes. fd-dossier-v1 */
  function buildMemberDossier(row, groups, saved) {
    const m = row.m;
    const returnTo = saved ? saved.returnTo : document.activeElement;
    let page = saved ? saved.page : 'overview';
    let query = saved ? saved.query : '';
    const root = h('div', { id: 'fd-ctx-menu', class: 'fd-dossier', role: 'dialog',
      'aria-modal': 'true', 'aria-labelledby': 'fd-dossier-name' });
    let panelObserver = null, styleObserver = null;
    function fitPanel() {
      const panel = $('panel'), overlay = $('overlay');
      if (!panel || !overlay) return;
      const p = panel.getBoundingClientRect(), o = overlay.getBoundingClientRect();
      if (!(p.width > 0 && p.height > 0 && o.width > 0 && o.height > 0)) return;
      // p already includes the deck's scale transform. Apply those painted
      // bounds once, as an unscaled overlay sibling, rather than scaling twice.
      const left = Math.max(0, p.left - o.left), top = Math.max(0, p.top - o.top);
      root.style.left = left + 'px'; root.style.top = top + 'px';
      root.style.width = Math.max(0, Math.min(p.width, o.width - left)) + 'px';
      root.style.height = Math.max(0, Math.min(p.height, o.height - top)) + 'px';
    }
    const button = (label, fn, cls, title) => h('button', { type: 'button',
      class: cls || 'fd-ds-button', title: title || label, 'aria-label': title || label,
      onClick: function (e) { e.stopPropagation(); fn(e); } }, label);
    const tabs = [];
    const sections = [];
    let dossierClosed = false, socialMounted = null, socialPage = '', pinsMounted = null, galleryMounted = null, outfitMounted = null;
    let personNavigation = 0;
    const familyActorIds = Object.create(null), familyActorAsked = Object.create(null);
    let galleryPhotos = [], libraryLoaded = false, libraryLoading = false, libraryError = '';
    const dsClient = window.HDDossierClient ? HDDossierClient.session({formId:fidHexOf(m.liveFormId || m.formId),name:m.original || m.name}) : null;
    function moduleModal() { return !!((socialMounted && socialMounted.hasModal()) || (window.HDDossierTools && HDDossierTools.isOpen())); }
    function dsPerson() { return dsClient && dsClient.person() || {}; }
    // Reuse the deck's shipped gold artwork; icons never replace action names.
    const actionIcons = { '⤵': 'hk-party-summon', '➜': 'hk-follower-teleport',
      '✥': 'hk-follower-teleport', '⮌': 'hk-her-home', '✓': 'hm-domains', '⚑': 'hm-domains',
      '◉': 'sn-camera', '🎭': 'hm-faces', '⛶': 'hk-portrait', '⊘': 'sn-stop',
      '⚔': 'hk-party-follow', '☰': 'hk-trade-inventory', '⛃': 'hm-containers',
      '⚭': 'hd-heart', '🗑': 'sn-stop' };
    function goldIcon(name) {
      return h('img', { class: 'fd-ds-icon', src: 'icons/custom/' + name + '.png',
        alt: '', 'aria-hidden': 'true', width: '32', height: '32', draggable: 'false',
        onError: function (e) { e.target.style.visibility = 'hidden'; } });
    }
    function section(key, title, hint, nodes, pages) {
      const body = h('section', { class: 'fd-ds-section fd-ds-' + key, 'aria-label': title },
        title ? h('div', { class: 'fd-ds-sectionhead' }, h('h2', null, title),
          hint ? h('p', null, hint) : null) : null);
      (nodes || []).forEach(function (el) {
        const oldIcon = el.querySelector('.fd-ctx-check');
        const iconName = oldIcon && actionIcons[oldIcon.textContent];
        if (iconName) {
          oldIcon.textContent = ''; oldIcon.append(goldIcon(iconName));
          oldIcon.classList.add('fd-ds-action-icon');
        }
        if (!el.classList.contains('fd-ctx-sep') && !el.classList.contains('fd-ctx-head')) body.append(el);
      });
      sections.push({ body: body, pages: pages, key: key });
      return body;
    }
    const rows = visibleRows();
    const index = rows.findIndex(function (r) { return r.cat === row.cat && r.idx === row.idx; });
    function navigate(delta) {
      const next = rows[index + delta];
      if (!next) return;
      const snapshot = root._dossier.snapshot();
      snapshot.portraitFrame = null; snapshot.draft = null; snapshot.focus = ''; snapshot.scroll = 0; snapshot.query = '';
      openMemberMenu(next, 0, 0, snapshot);
      askEquipped(next.m);
    }
    const prev = button('‹', () => navigate(-1), 'fd-ds-step', 'Previous character');
    const next = button('›', () => navigate(1), 'fd-ds-step', 'Next character');
    prev.disabled = index <= 0; next.disabled = index < 0 || index >= rows.length - 1;
    const back = button('‹  Followers', () => closeCtx(), 'fd-ds-back', 'Return to your roster (Escape)');
    let editing = !!(saved && saved.editing);
    const edit = button('Page size', function () {
      editing = !editing; sizeTools.hidden = !editing;
      edit.setAttribute('aria-expanded', String(editing));
      if (editing) sizeInput.focus();
    }, 'fd-ds-button', 'Edit page appearance');
    edit.setAttribute('aria-expanded', String(editing)); edit.setAttribute('aria-controls', 'fd-ds-size-tools');
    const sizeValue = h('output', { for: 'fd-ds-size', class: 'fd-ds-size-value' });
    const sizeInput = h('input', { id: 'fd-ds-size', type: 'range', min: '75', max: '130', step: '5',
      'aria-label': 'Character page size',
      onInput: function (e) { state.dossierSizePct = clampDossierSize(e.target.value); applySize(); },
      onChange: function () { saveCfg(); } });
    const resetSize = button('Reset', function () { state.dossierSizePct = 100; applySize(); saveCfg(); }, 'fd-ds-button');
    const sizeTools = h('div', { id: 'fd-ds-size-tools', class: 'fd-ds-size-tools' },
      h('label', { for: 'fd-ds-size' }, 'Page size'), sizeInput, sizeValue, resetSize,
      h('span', { class: 'fd-ds-size-hint' }, 'Smaller fits more · Larger is easier to read'));
    sizeTools.hidden = !editing;
    function applySize() {
      const pct = clampDossierSize(state.dossierSizePct);
      root.style.setProperty('--ds-size', String(pct / 100));
      sizeInput.value = String(pct); sizeInput.setAttribute('aria-valuetext', pct + ' percent');
      sizeValue.textContent = pct + '%'; resetSize.disabled = pct === 100;
    }
    applySize();
    const search = h('input', { id: 'fd-ds-search', type: 'search', value: query,
      class: 'fd-ds-search', placeholder: 'Find an action, detail or item…',
      'aria-label': 'Search this character’s actions, details and equipment', autocomplete: 'off',
      onInput: function (e) { query = e.target.value; paint(); } });
    root.append(h('header', { class: 'fd-ds-top' }, back,
      h('span', { class: 'fd-ds-brand' }, 'SKYMANAGER / PEOPLE'), search,
      h('div', { class: 'fd-ds-pagination' }, prev,
        h('span', null, (index + 1) + ' / ' + rows.length), next),
      edit, button('Close ×', () => closeCtx(), 'fd-ds-close', 'Close character (Escape)')), sizeTools);

    const portrait = h('div', { class: 'fd-ds-portrait' });
    const portraitWrap = h('div', {class:'fd-ds-portrait-wrap'}, portrait);
    const defaultShot = portraitFor(m);
    let shot = defaultShot, frameEdit = null;
    function paintPortrait(selectedFile) {
    if (frameEdit) { frameEdit.destroy(); frameEdit = null; }
    portraitWrap.textContent = ''; portrait.textContent = ''; portraitWrap.append(portrait);
    shot = selectedFile ? {file:selectedFile.replace(/^portraits\//,''),abs:selectedFile.indexOf('portraits/') !== 0,mtime:0} : defaultShot;
    if (shot) {
      const src = portraitSrc(shot);
      const img = h('img', { src: src + (!shot.abs && shot.mtime ? '?v=' + shot.mtime : ''),
        alt: m.name, width: '640', height: '800', draggable: 'false' });
      let retry = false;
      img.addEventListener('error', function () {
        if (!portrait.contains(img)) return;
        if (!retry) { retry = true; img.src = src; return; }
        if (frameEdit) frameEdit.destroy();
        portraitWrap.textContent = ''; portraitWrap.append(h('span', { class: 'fd-ds-monogram' }, m.name.charAt(0)),
          h('span', { class: 'fd-ds-photo-note' }, 'Portrait unavailable'));
      });
      portrait.append(img);
      // A generated head already has transparent framing. Cover would cut its
      // chin off in this wide panel. Preserve existing hand-framed pages exactly.
      const pageFrame = state.dossierFrames[shot.file] || (shot.abs ? {z:1,x:.5,y:.5,fit:'contain'} : null);
      if (window.HDFaceFit) HDFaceFit.applyBrightness(img, shot.file);
      frameEdit = dossierPortraitFrame(portrait, img, portraitWrap, pageFrame, function (value) {
        state.dossierFrames[shot.file] = value; saveCfg();
      });
      if (saved && saved.portraitFrame && saved.portraitFrame.file === shot.file) frameEdit.restore(saved.portraitFrame);
    } else {
      const faceWhy = faceWhyFor(m);
      portrait.append(h('span', { class: 'fd-ds-monogram' }, m.name.charAt(0)),
        h('span', { class: 'fd-ds-photo-note', title: faceWhy || '' },
          faceWhy ? ('No head render possible: ' + faceWhy) : 'No portrait yet / Capture one in Actions'));
    }
    }
    paintPortrait('');
    const linkedHome = window.DomainsPane && DomainsPane.homeFor ? DomainsPane.homeFor({
      home: m.fields && m.fields.home, nffHome: m.nffHome, mhHome: m.mhHome }) : null;
    const facts = h('dl', { class: 'fd-ds-facts' });
    function fact(label, value) { facts.append(h('div', null, h('dt', null, label), h('dd', null, value))); }
    fact('Status', m.dead ? 'Deceased' : m.following ? 'Following you' : m.inWorld ? 'In the world' : 'Not located');
    fact('Location', m.where || 'Not reported');
    fact('Home', linkedHome ? linkedHome.mark.name : m.homeName || (m.fields && m.fields.home) || 'No assigned home');
    if (m.fields && m.fields.relationship) fact('Relationship', m.fields.relationship);
    if (m.tracked) fact('Map', 'Tracking enabled');
    const identity = h('aside', { class: 'fd-ds-identity' }, portraitWrap,
      h('div', { class: 'fd-ds-identity-text' },
        /* The category label is the door: click it and the workspace narrows
           to the Category control with its finder focused (Rober, 2026-09-23:
           "no option to change that category in follower organizer they are
           in while searching?"). */
        h('button', { type: 'button', class: 'fd-ds-eyebrow fd-ds-eyebrow-btn',
          title: 'Change category — move ' + m.name + ' to another Follower Organizer group',
          onClick: function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            query = 'category'; search.value = query; paint();
            const finder = root.querySelector('.fd-ds-category input');
            if (finder) { try { finder.focus(); } catch (err) { /* no focus in a harness */ } }
          } }, (row.catName || 'Follower Organizer') + ' ›'),
        h('h1', { id: 'fd-dossier-name' }, m.name),
        m.original && m.original !== m.name ? h('p', { class: 'fd-ds-original' }, m.original) : null,
        h('p', { class: 'fd-ds-note' }, m.desc || 'Every person has a story. Add yours in Editor.'),
        h('div', { class: 'fd-ds-statuses' }, spouseChip(m), fertChip(m)),
        m.fert ? h('p', { class: 'fd-ds-family', title: fertTitle(m.fert) },
          m.fert.pregnant ? 'Expecting · ' + (typeof m.fert.percent === 'number' ? m.fert.percent + '%' : 'day ' + m.fert.day)
            : 'Pregnancy: not pregnant') : h('p', { class: 'fd-ds-family' }, 'Pregnancy: not reported'), facts,
        h('div', { class: 'fd-ds-bond' }, h('h2', null, 'Your relationship'),
          rankRow({formId: m.liveFormId || m.formId, readFormId:m.formId, name: m.name}, m.name) ||
            h('p', {class:'fd-ds-empty'}, 'Waiting for the game’s relationship rank…'))));
    let homeCover = null;
    if (linkedHome) {
      const home = linkedHome.mark;
      const cover = button('', function () { closeCtx(); DomainsPane.openWithFilter(home.name); }, 'fd-ds-home', 'Open ' + home.name + ' in Domains');
      if (home.image) cover.append(h('img', {src:home.image, alt:'', onError:function(e){e.target.hidden=true;}}));
      cover.append(h('span', {class:'fd-ds-home-copy'}, h('span', {class:'fd-ds-eyebrow'}, 'HOME · ' + linkedHome.source),
        h('strong', null, home.name), h('span', null, 'Open domain ›')));
      homeCover = cover;
    }
    const pinsHost = h('div', {class:'fd-ds-pins-host'});
    identity.querySelector('.fd-ds-identity-text').append(pinsHost);
    const nav = h('nav', { class: 'fd-ds-tabs', 'aria-label': 'Character sections' });
    [['overview', 'Overview', 'hm-followers'], ['profile', 'Editor', 'hm-sheet'], ['chim', 'CHIM', 'hk-chim-dialogue'],
      ['household', 'Household', 'hm-home'], ['family', 'Family tree', 'cat-companions'], ['history', 'History', 'hm-journal'],
      ['equipment', 'Equipment', 'hm-wardrobe'], ['gallery', 'Gallery', 'hk-portrait'], ['actions', 'Actions', 'cat-utilities']].forEach(function (t) {
      const tab = button(t[1], function () { if (socialMounted) { socialMounted.destroy(); socialMounted = null; socialPage = ''; } page = t[0]; query = ''; search.value = ''; paint(); scroll.scrollTop = 0; }, 'fd-ds-tab');
      tab.insertBefore(goldIcon(t[2]), tab.firstChild);
      tab.dataset.page = t[0]; tabs.push(tab); nav.append(tab);
    });
    const scroll = h('div', { class: 'fd-ds-layout fd-ds-scroll', tabindex: '0', 'aria-label': 'Character workspace' });
    const contentWrap = h('div', { class: 'fd-ds-body' });
    const content = h('div', { class: 'fd-ds-content' });
    const socialHost = h('div', {class:'fd-ds-social-host'}), galleryHost = h('div', {class:'fd-ds-gallery-host'}), outfitHost = h('div', {class:'fd-ds-outfit-host'});
    const controlsHost = h('div', { id: 'fd-dossier-controls', class: 'fd-ds-controls-host' });
    let controlsMounted = false;
    // The day owns its heading here; the original menu's label is redundant.
    const dayNodes = groups.routine.filter(function (el) { return !el.classList.contains('fd-ctx-field'); });
    if (!dayNodes.length) dayNodes.push(h('p', { class: 'fd-ds-empty' },
      state.nff.mhiyh ? 'No routine is available for this character. Locate them in the world to assign a home.'
        : 'Daily routines need My Home is Your Home. No routine data is available.'));
    const assigned = new Set((m.acts || []).filter(a => a.place && canSetKind(a.k)).map(a => a.k));
    if (m.mhHome) assigned.add(KIND_HOME);
    const daySummary = h('div', { class: 'fd-ds-day-summary' },
      h('span', null, state.nff.mhiyh ? assigned.size + ' / 7 places set · MHiYH' : 'MHiYH unavailable'),
      button('Saved rhythms…', function () {
        if (!window.ResidentsPane || !ResidentsPane.openRhythms) { toast('Residents controls are still loading. Try again shortly.'); return; }
        closeCtx(); ResidentsPane.openRhythms({formId:fidHexOf(m.liveFormId || m.formId),name:m.name,dead:m.dead});
      }, 'fd-ds-rhythms', 'Save or replace this NPC’s complete daily rhythm'));
    const dayStatus = h('p', { class: 'fd-ds-day-status', role: 'status', 'aria-live': 'polite' });
    function paintDayStatus() {
      const status = state.dayStatus[dayStatusKey(m.liveFormId || m.formId)];
      dayStatus.textContent = status ? status.msg : state.nff.mhiyh
        ? 'Set here marks where YOU are standing.'
        : 'Daily routines require My Home is Your Home.';
      dayStatus.classList.toggle('pending', !!(status && status.pending));
      dayStatus.classList.toggle('error', !!(status && !status.ok));
    }
    paintDayStatus();
    content.append(section('routine', 'Daily rhythm', '', [daySummary].concat(dayNodes, [dayStatus], homeCover ? [homeCover] : []), ['overview']));
    content.append(section('travel', 'Go together', 'Travel, recall and map tracking', groups.travel, ['overview', 'actions']));
    content.append(section('service', 'In your company', 'Follower service and belongings', groups.service, ['overview', 'actions', 'equipment']));
    content.append(section('profile', 'Their story', 'Edits save when you leave a field. Clear a field to reset it.', groups.profile, ['profile']));
    content.append(section('outfit-presets', 'Wardrobe presets', '', [outfitHost], ['equipment']));
    content.append(section('social', '', '', [socialHost], ['household','family','history']));
    content.append(section('gallery', '', '', [galleryHost], ['gallery']));
    content.append(section('equipment', 'Currently equipped', 'Read from the game, including outfit-owned pieces.', groups.equipment, ['equipment']));
    content.append(section('appearance', 'Portrait & appearance', 'Capture, frame and change their look', groups.appearance, ['profile']));
    content.append(section('controls', 'All character controls', 'The same live controls as F7, addressed to this character.', [controlsHost], ['actions']));

    const fid = Number(m.liveFormId || m.formId) || 0;
    const sceneStart = button('Start OStim scene', function () {
      closeCtx(); OstimTools.startFor({formId:fid,name:m.name});
    }, 'fd-ctx-item', 'Choose participants, furniture, clothing and scene control');
    sceneStart.insertBefore(goldIcon('seg-ostim'), sceneStart.firstChild);
    sceneStart.disabled = !fid || !!m.dead || !window.OstimTools || !OstimTools.startFor;
    content.querySelector('.fd-ds-service').append(sceneStart);
    const marriage = (equippedFor(m) || {}).about;
    const marital = marriage && marriage.maras;
    let marriageArmed = false;
    const marry = button(m.spouse ? 'Already married' : 'Force marriage', function () {
      if (!marriageArmed) {
        marriageArmed = true; marry.textContent = 'Confirm marriage to ' + m.name;
        marry.title = 'Registers a marriage through M.A.R.A.S. This changes your save.'; return;
      }
      marry.disabled = true; closeCtx();
      toGame('fdMarriage', JSON.stringify({formId:fid,confirm:true}));
    }, 'fd-ctx-item', 'Register marriage through M.A.R.A.S, using its own status transition');
    marry.insertBefore(goldIcon('hd-heart'), marry.firstChild);
    marry.disabled = !!m.spouse || !!m.dead || !fid || !(marital && marital.on);
    const marriageHint = m.spouse ? 'Married to you · M.A.R.A.S' : marital && marital.on
      ? 'Uses M.A.R.A.S to change marriage status. Confirm on a second click.' : 'Waiting for M.A.R.A.S status, or the mod is unavailable.';
    content.append(section('marriage', 'Marriage', marriageHint, [marry], ['profile']));
    const chimHost = h('div', {class:'fd-ds-chim-host'});
    let chimMounted = false;
    content.append(section('chim', 'CHIM', 'Voice, background and a life that evolves with them', [chimHost], ['chim']));
    if (!window.ChimBtn || !ChimBtn.mount) chimHost.append(h('p', {class:'fd-ds-empty'}, 'CHIM controls are not available in this view.'));

    function connect(label, detail, available, iconName, fn) {
      if (!available) return;
      const action = button(label, function (e) {
        const rect = e.currentTarget.getBoundingClientRect();
        closeCtx(); fn({ currentTarget: { getBoundingClientRect: function () { return rect; } } });
      }, 'fd-ctx-item', detail);
      action.insertBefore(goldIcon(iconName), action.firstChild);
      if (label === 'Tune stats & temperament') content.append(section('tuning', 'Stats & temperament', 'Open the dedicated live NPC editor', [action], ['profile']));
      else groups.connections.push(action);
    }
    connect('Quests & stages', 'Inspect this character’s quests and quest aliases', window.HDQuests && fid, 'hm-quests', function (e) {
      HDQuests.open(e.currentTarget, { who: m.name, formId: fid, hex: hexOf(fid), dead: !!m.dead,
        portrait: shot ? portraitSrc(shot) : '' });
    });
    connect('Tune stats & temperament', 'Open the existing NPC editor for ' + m.name, window.HDNpcTune && fid, 'cat-utilities', function () {
      HDNpcTune.open({ formId: fid, name: m.name, portrait: shot ? portraitSrc(shot) : '' });
    });
    content.append(section('connections', 'A deeper connection', 'Character tools', groups.connections.length ? groups.connections :
      [h('p', { class: 'fd-ds-empty' }, 'Additional character tools are unavailable in this session.')], ['overview', 'actions']));
    content.append(section('organize', 'Your roster', 'Categorise this person. Removing an entry leaves the NPC untouched.', groups.organize, ['profile']));
    const empty = h('p', { class: 'fd-ds-empty fd-ds-noresults', role: 'status' }, 'No matches. Try “home”, “inventory”, “portrait” or “category”.');
    content.append(empty); contentWrap.append(content);
    const count = h('span', { class: 'fd-ds-result', role: 'status', 'aria-live': 'polite' });
    const work = h('main', { class: 'fd-ds-work' }, nav, contentWrap,
      h('footer', { class: 'fd-ds-footer' }, count, h('span', null, 'Ctrl+K  Search / Esc  Back')));
    scroll.append(identity, work); root.append(scroll);

    // Semantic labels and stable IDs support keyboard navigation and restore.
    Array.prototype.forEach.call(root.querySelectorAll('input, select'), function (el, i) {
      if (!el.id) el.id = 'fd-ds-field-' + i;
      const parent = el.closest('.fd-ctx-field');
      const label = parent && parent.querySelector('label');
      if (label) { label.setAttribute('for', el.id); el.setAttribute('aria-label', label.textContent); }
    });
    function allDossierRows() {
      const list = [], seen = new Set();
      state.cats.forEach(function(c) { c.members.forEach(function(person,idx) {
        const key = canonFormId(fidHexOf(person.liveFormId || person.formId));
        if (!key || seen.has(key)) return; seen.add(key);
        list.push({cat:c.index,idx:idx,catName:catLabel(c),m:person});
      }); }); return list;
    }
    function personAdapter(person) {
      const image = portraitFor(person), formId = fidHexOf(person.liveFormId || person.formId);
      const actor={formId:formId,name:person.original || person.name};
      const record=window.HDDossierClient&&HDDossierClient.session(actor).person();
      return Object.assign({name:person.name,formId:formId,actor:actor,image:image ? portraitSrc(image) : '',location:person.where || ''},record||{});
    }
    function openConnectedPerson(person) {
      const generation = ++personNavigation;
      let id = person.formId || (person.actor && !person.actor.plugin ? person.actor.formId : '');
      const hit = allDossierRows().find(function(r) {
        if (id) return canonFormId(fidHexOf(r.m.liveFormId || r.m.formId)) === canonFormId(id);
        // A durable graph identity must resolve through native lookup, never a name guess.
        return false;
      });
      if (hit) { const nextState=root._dossier.snapshot();nextState.page='family';nextState.query='';nextState.focus='';nextState.portraitFrame=null;nextState.draft=null;openMemberMenu(hit,0,0,nextState);askEquipped(hit.m);return true; }
      if (person.actor && person.actor.plugin && window.HDDossierClient) {
        HDDossierClient.request({op:'resolveActor',actor:person.actor}).then(function(reply) {
          if (dossierClosed || generation !== personNavigation || !reply.ok || !reply.formId) return;
          const resolved = allDossierRows().find(function(r){return canonFormId(fidHexOf(r.m.liveFormId || r.m.formId))===canonFormId(reply.formId);});
          if (resolved) {const nextState=root._dossier.snapshot();nextState.page='family';nextState.query='';nextState.focus='';nextState.portraitFrame=null;nextState.draft=null;openMemberMenu(resolved,0,0,nextState);askEquipped(resolved.m);}
        }).catch(function(){});
      }
      return false;
    }
    function familyPortrait(person) {
      if(person.portrait&&person.portrait.file)return person.portrait.file;
      let member=null;
      if(person.id&&person.id===dsPerson().id)member=m;
      else {
        const runtime=person.formId||familyActorIds[person.id];
        if(runtime){const row=allDossierRows().find(function(r){return canonFormId(fidHexOf(r.m.liveFormId||r.m.formId))===canonFormId(runtime);});if(row)member=row.m;}
      }
      const shot=member&&portraitFor(member);return shot?portraitSrc(shot):person.image||'';
    }
    function loadFamilyFaces(){
      if(!window.HDDossierClient||!dsPerson().id)return;
      const data=HDDossierClient.snapshot(), connected=new Set([dsPerson().id]), queue=[dsPerson().id];
      while(queue.length&&connected.size<100){const id=queue.shift();(data.relations||[]).forEach(function(r){if(r.from!==id&&r.to!==id)return;const other=r.from===id?r.to:r.from;if(!connected.has(other)&&connected.size<100){connected.add(other);queue.push(other);}});}
      const tasks=(data.people||[]).filter(function(p){return connected.has(p.id)&&p.actor&&!familyActorAsked[p.id]&&!familyPortrait(p);}).map(function(p){
        familyActorAsked[p.id]=true;
        return HDDossierClient.request({op:'resolveActor',actor:p.actor}).then(function(r){if(r.ok&&r.formId)familyActorIds[p.id]=r.formId;}).catch(function(){});
      });
      if(tasks.length)Promise.all(tasks).then(function(){if(!dossierClosed&&socialMounted&&!moduleModal())socialMounted.refreshPortraits();});
    }
    function socialOptions() {
      const roster = allDossierRows(), p = dsPerson();
      const subject = Object.assign(personAdapter(m),p,{name:m.name,personId:p.id || ''});
      const residents = linkedHome ? roster.filter(function(r) {
        const home = window.DomainsPane && DomainsPane.homeFor && DomainsPane.homeFor({home:r.m.fields&&r.m.fields.home,nffHome:r.m.nffHome,mhHome:r.m.mhHome});
        return home && home.mark && home.mark.id === linkedHome.mark.id;
      }).map(function(r){return personAdapter(r.m);}) : [];
      return {page:page,subject:subject,roster:roster.map(function(r){return personAdapter(r.m);}),store:HDDossierClient.snapshot(),request:dsRequest,
        homeDomain:linkedHome && linkedHome.mark,homeLabel:m.homeName || (m.fields&&m.fields.home) || '',residents:residents,
        observedLocation:m.where || '',observedMarriage:m.spouse?'Married to the player':'',
        schedule:{currentLabel:m.nowAct ? (m.nowAct.spec && (m.nowAct.spec.name || m.nowAct.spec.label) || actSpec(m.nowAct.k).label || '') + (m.nowAct.place?' — '+m.nowAct.place:'') : ''},
        openPerson:openConnectedPerson,onFocusPerson:function(){personNavigation++;},portraitFor:familyPortrait,
        loadPortraits:function(){return HDDossierClient.request({op:'gallery',all:true}).then(function(r){if(!r.ok)throw new Error(r.msg||'Portrait library unavailable.');return r.photos||[];});},
        openDomain:function(home){closeCtx();DomainsPane.openWithFilter(home.name);},
        openRhythms:function(){if(window.ResidentsPane&&ResidentsPane.openRhythms){closeCtx();ResidentsPane.openRhythms({formId:fidHexOf(m.liveFormId||m.formId),name:m.name,dead:m.dead});}}
      };
    }
    async function dsRequest(req) {
      if (!dsClient) throw new Error('Dossier storage is still loading. Reopen this page.');
      const reply = await dsClient.request(req);
      if (!dossierClosed && reply.ok) { if(pinsMounted)pinsMounted.refresh();if(outfitMounted)outfitMounted.refresh(); }
      return reply;
    }
    function pinActions() {
      const labels={summon:'Summon to me',goto:'Go to them',placeHere:'Place them at me',sendTo:'Send back / send to…',track:'Track on map',capture:'Capture portrait',inventory:'Open inventory',storage:'Open spare inventory',service:m.following?'Dismiss from service':'Recruit as follower'};
      const nodes = [];
      root.querySelectorAll('[data-dossier-action]').forEach(function(node){const id=node.getAttribute('data-dossier-action');if(labels[id]&&!nodes.some(a=>a.id===id))nodes.push({id:id,label:labels[id],disabled:!!node.disabled,reason:node.title||'',icon:node.querySelector('.fd-ds-icon')?node.querySelector('.fd-ds-icon').getAttribute('src'):''});});
      return nodes;
    }
    const toolOptions = {
      getActorId:function(){return fidHexOf(m.liveFormId||m.formId);},getPerson:dsPerson,getActions:pinActions,
      savePins:function(pins){return dsRequest({op:'setPins',pins:pins});},
      runAction:function(id){
        const node=root.querySelector('[data-dossier-action="'+id+'"]');
        const current=visibleRows().find(function(r){return r.cat===row.cat&&r.idx===row.idx&&r.m.formId===m.formId;});
        if(!current||!node||node.disabled)return {ok:false,msg:'This action is no longer available. Reopen the character page.'};
        node.click();return {ok:true,msg:'Action requested.'};
      },
      getOutfits:function(){return window.WardrobePane&&WardrobePane.quickOutfits?WardrobePane.quickOutfits():[];},
      saveEquipment:function(slots){return dsRequest({op:'setEquipment',slots:slots});},
      getApplyWarning:function(){const about=window.WardrobePane&&WardrobePane.quickAbout&&WardrobePane.quickAbout(fidHexOf(m.liveFormId||m.formId));return about&&about.mode==='nff'?'Wardrobe will take outfit control back from NFF, assign this outfit, then request dressing.':about&&!about.tracked&&about.mode==='off'?'Wardrobe will add the outfit pieces to their inventory and request equip, without assigning outfit management.':'Wardrobe will assign this outfit and request dressing now. This changes outfit management for this NPC.';},
      applyOutfit:function(id){
        if(!window.WardrobePane||!WardrobePane.quickWear)return {ok:false,msg:'Wardrobe is not available yet. Open Wardrobe first.'};
        const about=WardrobePane.quickAbout(fidHexOf(m.liveFormId||m.formId));
        if(!about)return {ok:false,msg:'Wardrobe has not loaded this NPC. Open their Wardrobe People page first.'};
        if(m.dead)return {ok:false,msg:'This NPC is deceased.'};
        const unmanaged=!about.tracked&&about.mode==='off';
        const result=unmanaged&&WardrobePane.quickGiveWear?WardrobePane.quickGiveWear(about.key,id):WardrobePane.quickWear(about.key,id);
        if(result&&result.ok){dsRequest({op:'recordAction',action:'outfit-requested',detail:id}).catch(function(){});closeCtx();}
        return result;
      },
      getPortraits:function(){return galleryPhotos;},
      selectPortrait:async function(file){const reply=await dsRequest({op:'setPortrait',file:file});if(reply.ok&&!dossierClosed)paintPortrait(file);return reply;},
      capturePortrait:function(){const node=root.querySelector('[data-dossier-action="capture"]');if(!node||node.disabled)return {ok:false,msg:'This NPC must be visible in the world to capture a portrait.'};node.click();return {ok:true,msg:'Portrait capture requested.'};},
      framePortrait:function(){const adjust=portraitWrap.querySelector('.fd-ds-frame-toggle');if(adjust){adjust.click();scroll.scrollTop=0;return {ok:true,msg:'Drag the portrait or use the arrow controls, then save framing.'};}return {ok:false,msg:'Choose an available portrait first.'};}
    };
    function mountModules() {
      if (!libraryLoaded) {
        if (['family','history','household'].indexOf(page)!==-1) {socialHost.textContent=libraryError||'Loading shared person records…';}
        if (page==='gallery') galleryHost.textContent=libraryError||'Loading portrait library…';
        if (page==='equipment') outfitHost.textContent=libraryError||'Loading Wardrobe shortcuts…';
        return;
      }
      if(window.HDDossierTools){
        if(!pinsMounted)pinsMounted=HDDossierTools.mountPins(pinsHost,toolOptions);
        if(page==='equipment'&&!outfitMounted){outfitHost.textContent='';askClothes();outfitMounted=HDDossierTools.mountEquipment(outfitHost,toolOptions);}
        if(page==='gallery'&&!galleryMounted){galleryHost.textContent='';galleryMounted=HDDossierTools.mountGallery(galleryHost,toolOptions);loadGallery();}
      }
      if(['family','history','household'].indexOf(page)!==-1&&window.HDDossierSocial&&socialPage!==page){
        if(socialMounted)socialMounted.destroy();socialHost.textContent='';socialPage=page;socialMounted=HDDossierSocial.mount(socialHost,socialOptions());loadFamilyFaces();
      }
    }
    function loadGallery(){
      HDDossierClient.request({op:'gallery',name:m.original||m.name}).then(function(reply){
        if(dossierClosed)return;if(!reply.ok){galleryHost.append(h('p',{class:'fd-ds-empty',role:'alert'},reply.msg||'Portraits could not be loaded.'));return;}
        galleryPhotos=reply.photos||[];
        const currentFile=dsPerson().portrait&&dsPerson().portrait.file;
        if(currentFile&&!galleryPhotos.some(p=>p.file===currentFile))galleryPhotos.unshift({file:currentFile,src:currentFile,label:'Selected page portrait'});
        if(galleryMounted)galleryMounted.refresh();
      }).catch(function(e){if(!dossierClosed)galleryHost.append(h('p',{class:'fd-ds-empty',role:'alert'},e.message));});
    }
    function loadLibrary(){
      if(!dsClient){libraryError='Dossier storage is unavailable. Reopen SkyManager after its modules load.';return;}
      if(libraryLoading)return;libraryLoading=true;
      dsClient.read().then(function(reply){
        if(dossierClosed)return;libraryLoading=false;
        if(!reply.ok){libraryError=reply.msg||'Shared records could not be loaded. Reopen the page to retry.';paint();return;}
        libraryLoaded=true;const selected=dsPerson().portrait&&dsPerson().portrait.file;if(selected)paintPortrait(selected);paint();
      }).catch(function(e){if(!dossierClosed){libraryLoading=false;libraryError=e.message;paint();}});
    }
    const candidates = [];
    function indexCandidates() {
      candidates.length = 0;
      sections.forEach(function (s) {
      Array.prototype.forEach.call(s.body.querySelectorAll('.fd-ctx-item, .fd-ctx-field, .fd-day-row, .fd-eq-row, .fq button, .chim-fly-item, .dso-person, .dso-event, .dso-button, .hddt-slot, .hddt-photo, .hddt-button'), function (node) {
        if (node.closest('.fq-find')) return;
        const input = node.querySelector('input, select');
        candidates.push({ node: node, section: s, text: (node.textContent + ' ' + (node.title || '') + ' ' +
          (input ? input.value : '')).toLowerCase() });
      });
      });
    }
    function paint() {
      // Graph layout must measure a visible host, not the previous tab's hidden section.
      sections.forEach(function(s){if(s.pages.indexOf(page)!==-1)s.body.hidden=false;});
      mountModules();
      const q = query.trim().toLowerCase();
      if ((page === 'chim' || q) && !chimMounted && root.isConnected && window.ChimBtn && ChimBtn.mount) {
        chimMounted = true;
        ChimBtn.mount(chimHost, {original:m.original || m.name, who:m.name, formId:fid, dead:!!m.dead, onNavigate:closeCtx});
      }
      if ((page === 'actions' || q) && !controlsMounted && root.isConnected) {
        controlsMounted = true;
        mountQuick(controlsHost);
      }
      indexCandidates();
      let matches = 0;
      /* Every word, in any order: "change follower" must find the Category
         control whose words are "Change category … Follower Organizer group"
         (Rober, 2026-09-23). A phrase-only match was the reason it did not. */
      const toks = q.split(/\s+/).filter(Boolean);
      candidates.forEach(function (c) {
        const hit = !toks.length || toks.every(function (t) { return c.text.indexOf(t) !== -1; });
        c.node.hidden = !hit;
        if (q && hit) matches++;
      });
      sections.forEach(function (s) {
        s.body.hidden = q ? !candidates.some(c => c.section === s && !c.node.hidden) : s.pages.indexOf(page) === -1;
      });
      tabs.forEach(function (tab) { tab.setAttribute('aria-current', !q && tab.dataset.page === page ? 'page' : 'false'); });
      content.classList.toggle('searching', !!q);
      content.classList.toggle('overview', !q && page === 'overview');
      empty.hidden = !q || matches > 0;
      count.textContent = q ? matches + (matches === 1 ? ' match' : ' matches') : 'Character workspace';
    }
    function key(e) {
      if (e._fdDossierHandled) return true;
      if (moduleModal()) { if(socialMounted&&socialMounted.hasModal())socialMounted.onKey(e);else HDDossierTools.onKey(e);return true; }
      if (frameEdit && frameEdit.key(e)) return true;
      if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k') {
        e.preventDefault(); search.focus(); e._fdDossierHandled = true; return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e._fdDossierHandled = true;
        if (query) { query = ''; search.value = ''; paint(); search.focus(); }
        else closeCtx();
        return true;
      }
      if (e.key === 'Enter' && e.target === search) {
        e.preventDefault(); e._fdDossierHandled = true;
        const hit = candidates.find(c => !c.node.hidden && !c.section.body.hidden && !c.node.disabled);
        if (hit) {
          if (hit.node.tagName === 'BUTTON') hit.node.click();
          else { const control = hit.node.querySelector('input, select, button'); if (control) control.focus(); }
        }
        return true;
      }
      if (e.key === 'Tab') {
        const focusable = Array.prototype.filter.call(root.querySelectorAll('button, input, select, [tabindex]'), function (el) {
          return !el.disabled && !el.closest('[hidden]') && el.tabIndex !== -1;
        });
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
          e.preventDefault(); if (last) last.focus();
        } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); if (first) first.focus(); }
        e._fdDossierHandled = true; return true;
      }
      return false;
    }
    root.addEventListener('keydown', key);
    root._dossier = {
      key: key,
      applySize: applySize,
      subject: function () { return m; },
      controlsHost: controlsHost,
      controlsActive: function () { return controlsMounted; },
      refreshSearch: paint,
      paintDayStatus: paintDayStatus,
      keepEditing:function(){const active=document.activeElement;return moduleModal() || ['family','history','household','gallery'].indexOf(page)!==-1 || !!(active&&root.contains(active)&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));},
      mount: function () {
        fitPanel();loadLibrary();
        const panel = $('panel');
        if (window.addEventListener) window.addEventListener('resize', fitPanel);
        if (panel) {
          panel.addEventListener('transitionend', fitPanel);
          if (window.ResizeObserver) { panelObserver = new window.ResizeObserver(fitPanel); panelObserver.observe(panel); }
          if (window.MutationObserver) {
            styleObserver = new window.MutationObserver(fitPanel);
            [panel, document.documentElement].forEach(el => styleObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] }));
          }
        }
      },
      snapshot: function () {
        const active = document.activeElement;
        return { page: page, query: query, scroll: scroll.scrollTop, returnTo: returnTo, editing: editing, portraitFrame: frameEdit ? Object.assign({file:shot.file},frameEdit.snapshot()) : null,
          focus: root.contains(active) ? active.id : '',
          draft: root.contains(active) && active.tagName === 'INPUT' && active !== search && typeof active.selectionStart === 'number'
            ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null };
      },
      restore: function () {
        paint(); scroll.scrollTop = saved ? saved.scroll || 0 : 0;
        const focus = saved && saved.focus ? document.getElementById(saved.focus) : null;
        if (focus) {
          if (saved.draft) { focus.value = saved.draft.value; }
          focus.focus();
          if (saved.draft && focus.setSelectionRange) focus.setSelectionRange(saved.draft.start, saved.draft.end);
        } else if (!saved) back.focus();
      },
      close: function () {
        dossierClosed=true;
        if(socialMounted)socialMounted.destroy();[pinsMounted,galleryMounted,outfitMounted].forEach(function(module){if(module)module.destroy();});
        if (frameEdit) frameEdit.destroy();
        if (window.ChimBtn && ChimBtn.unmount) ChimBtn.unmount(chimHost);
        if (quickHost === controlsHost) { fqFindClose(); quickHost = null; }
        if (panelObserver) panelObserver.disconnect(); if (styleObserver) styleObserver.disconnect();
        if (window.removeEventListener) window.removeEventListener('resize', fitPanel);
        const panel = $('panel'); if (panel) panel.removeEventListener('transitionend', fitPanel);
        if (returnTo && returnTo.isConnected && returnTo.focus) returnTo.focus();
      }
    };
    return root;
  }

  function openMemberMenu(row, x, y, restore) {
    closeCtx();
    const m = row.m;
    ui.menuFor = { cat: row.cat, idx: row.idx, formId: m.formId, original: m.original || m.name };

    const item = (icon, label, on, opts) => h('button', {
      'data-dossier-action': ({'⤵':'summon','➜':'goto','✥':'placeHere','⮌':'sendTo','✓':'track','⚑':'track','◉':'capture','☰':'inventory','⛃':'storage','⚔':'service','⊘':'service'})[icon] || '',
      class: 'fd-ctx-item' + ((opts && opts.danger) ? ' danger' : '') + ((opts && opts.active) ? ' active' : ''),
      disabled: (opts && opts.disabled) ? true : null,
      title: (opts && opts.title) || null,
      onClick: (e) => { e.stopPropagation(); on(e); },
    }, h('span', { class: 'fd-ctx-check' }, icon), h('span', { class: 'fd-ctx-lbl' }, label));

    const groups = {};
    const items = [];
    items.push(h('div', { class: 'fd-ctx-head', title: m.name }, m.name,
      m.original && m.original !== m.name ? h('span', { class: 'fd-ctx-orig' }, ' · née ' + m.original) : null));
    items.push(h('div', { class: 'fd-ctx-field' },
      h('label', null, 'Name'),
      h('input', {
        class: 'fd-ctx-input', type: 'text', value: m.override || '', spellcheck: 'false',
        maxlength: String(FIELD_VALUE_MAX),
        placeholder: m.original || m.name,
        title: 'Rename them (applies in-game too). Blank restores the original name.',
        onClick: (e) => e.stopPropagation(),
        onChange: (e) => sendApply('renameMember', { cat: row.cat, idx: row.idx, name: clampText(e.target.value) }),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));
    items.push(h('div', { class: 'fd-ctx-field' },
      h('label', null, 'Note'),
      h('input', {
        class: 'fd-ctx-input note', type: 'text', value: m.desc || '', spellcheck: 'false',
        maxlength: String(FIELD_VALUE_MAX),
        placeholder: 'A few words to remember them by…',
        title: 'Shown under their name (saved into Follower Organizer)',
        onClick: (e) => e.stopPropagation(),
        onChange: (e) => sendApply('setDesc', { cat: row.cat, idx: row.idx, desc: clampText(e.target.value) }),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));

    /* ---- NPC fields: Relationship first, then the rest of the spec, then
       anything already stored under a key the spec doesn't know. Each writes
       on change; blank erases. Saved into FO's own JSON beside Name/Note. ---- */
    items.push(h('div', { class: 'fd-ctx-sep' }));
    /* The short fields go SIDE BY SIDE, not stacked. This is the actual "way
       more horizontal space usage" — widening the menu alone just made one tall
       column of wide boxes, still needing a scroll to reach Summon. Relationship
       / Home / Occupation / Faction are all short values, so two per line halves
       the height for free. Wrapped in a grid container rather than styled in
       place because Name and Note are also .fd-ctx-field and must stay full
       width; only these carry .fd-ctx-fieldrow. The grid is auto-fit, so a
       narrow menu collapses back to one column with no JS involved. */
    const fgrid = h('div', { class: 'fd-ctx-fieldgrid' });
    fieldRows(m).forEach((f) => {
      const isChip = !!(CHIP_FIELD && f.key === CHIP_FIELD.key);
      const inp = h('input', {
        class: 'fd-ctx-input',
        type: 'text', value: f.value, spellcheck: 'false',
        maxlength: String(FIELD_VALUE_MAX),
        placeholder: f.hint || '—',
        title: f.spec
          ? (f.hint ? f.label + ' — ' + f.hint : f.label) + '\nBlank clears it.'
          : 'Stored under the key “' + f.key + '” — kept because you (or the portal) set it.\nBlank clears it.',
        onClick: (e) => e.stopPropagation(),
        onChange: (e) => saveField(row, f.key, e.target.value),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      });
      if (isChip) inp.style.color = '#d9c48a';   // it's the one shown on the row
      fgrid.append(h('div', { class: 'fd-ctx-field fd-ctx-fieldrow', data: { fkey: f.key } },
        h('label', { title: f.label }, f.label), inp));
    });
    items.push(fgrid);

    groups.profile = items.splice(0);

    /* ---- Sharmat (CHIM intimacy profile) ----
       Its own popout, not more rows here: it is a long form with a different
       save contract (whole-profile commit, straight into CHIM's database,
       live) and it must not sit one slip away from the FO field rows above,
       which are queued and harmless by comparison.

       The name we hand it is the ORIGINAL, not the display name: CHIM keys
       its rows by the NPC's real name, so a follower renamed in the deck must
       still resolve to the right profile — and must never silently create a
       second one under her nickname. */
    if (typeof SmPane !== 'undefined') {
      items.push(h('div', { class: 'fd-ctx-sep' }));
      items.push(item('⚭', 'Sharmat profile…', () => {
        closeCtx();
        // Hand over the portrait WE already resolved rather than making the
        // popout re-derive the slug — that rule has three implementations
        // already (here, the portal, portraits/README.txt).
        const face = portraitFor(m);
        SmPane.open(m.original || m.name, m.name, {
          file: face ? face.file : '', mtime: face ? face.mtime : 0, hue: hueOf(row.cat),
        });
      }, { title: 'Kinks, speak style, status — CHIM’s per-NPC intimacy profile.\nEdits here are LIVE.' }));
    }

    groups.connections = items.splice(0);

    /* ---- Her day (My Home is Your Home NG) — strictly read-only. Sits after
       the things you can TYPE and before the things you can DO, because it is
       neither: it is what the game already believes. ---- */
    const day = dayBlock(m);
    if (day) day.forEach((el) => items.push(el));
    groups.routine = items.splice(0);

    items.push(h('div', { class: 'fd-ctx-sep' }));

    const worldBlocked = !m.inWorld;
    const wTitle = worldBlocked ? (m.resolved ? 'Only their base record resolved — not placed in the world' : 'Their plugin is not loaded this session') : null;
    items.push(item('⤵', 'Summon to me', () => { closeCtx(); sendWorld('summon', row.cat, row.idx, '⤵ ' + m.name + ' is on their way'); }, { disabled: worldBlocked, title: wTitle }));
    items.push(item('➜', 'Go to them', () => { closeCtx(); sendWorld('goto', row.cat, row.idx, '➜ ' + m.name); }, { disabled: worldBlocked, title: wTitle }));
    /* The rescue. Summon and Go-to are both gated on her being in the world —
       which is exactly the state this is for: "sometimes npc has despawned or
       something that ive added maybe an option to place them at you?"
       So it is deliberately NOT disabled by worldBlocked; that would hide it
       precisely when it is wanted. C++ re-enables her first if she has been
       disabled, refuses if she is dead, and EvaluatePackages her afterwards. */
    items.push(item('✥', 'Place them at me', () => { closeCtx(); sendNpc('placeHere', m); },
      { disabled: !!m.dead,
        title: m.dead ? m.name + ' is dead — this brings back the missing, not the fallen'
          : 'For when they have vanished: re-enables them if needed and puts them in '
            + 'front of you, even from another hold.' }));
    /* ---- Send back: now a DESTINATION, not just an undo -----------------
       Rober (2026-08-02): "send back on an npc should populate with like send
       back to MHIHM home or NFF home, or a typeable dropdown for any of my
       domains and teleports them there on press."

       The original meaning stays first and unchanged — Follower Organizer's
       snapshot-undo is the only option that knows where she was BEFORE you
       summoned her, and nothing else can reconstruct that. The homes and the
       domains are additions under it. */
    items.push(item('⮌', 'Send back / send to…', (e) => { openSendTo(e.currentTarget, row); },
      { disabled: worldBlocked, title: wTitle
          || 'Where she was, her MHiYH or NFF home, or any domain you have marked' }));
    items.push(item(m.tracked ? '✓' : '⚑', m.tracked ? 'Stop tracking on map' : 'Track on map', () => {
      closeCtx();
      sendApply('setTracked', { cat: row.cat, idx: row.idx, on: !m.tracked });
    }, { active: m.tracked }));

    groups.travel = items.splice(0);

    /* Photograph her from here, instead of closing the deck, finding the CHIM
       tab and hoping the crosshair is still on the right person. Names its
       subject explicitly (fdPortrait carries the formId), so it captures the
       follower you clicked — she still has to be loaded and on screen, and the
       plugin says so plainly if she is not.

       Labelled "Replace" once she has one, because that is the case that used
       to fail: a portrait the deck has already drawn is memory-mapped by the
       game and cannot be overwritten, so the capture lands as a new versioned
       file and the newest wins. */
    items.push(item('◉', portraitFor(m) ? 'Replace portrait' : 'Capture portrait', () => {
      closeCtx();
      /* formId, NOT form. `form` is the form STRING ("JenassaREF",
         "REF~Sera.esp"); `formId` is the hex the engine can look up, and it is
         what every other actor-keyed feature here sends (nff, mhiyh, fertility,
         equipped). Getting this wrong is silent: C++ parses hex, gets 0, logs
         "no usable formId" and returns, so the menu item just does nothing. */
      openPortraitCapture({formId:m.formId || '',name:m.name});
    }, {
      disabled: worldBlocked || !m.formId,
      title: worldBlocked
        ? wTitle
        : (!m.formId ? 'No form id on this entry' : 'Hides the HUD, frames her face and saves it as her portrait — she must be on screen'),
    }));

    /* 🎭 Preset — the same pick-into-the-quick-card move the crew strip makes
       (ui.fqPick), plus opening the Preset reveal, so "give HER a face" is one
       click from the roster instead of walk-up-and-look. The block itself
       stays single-sourced on the quick card. */
    items.push(item('🎭', 'Preset her face…', () => {
      closeCtx();
      // Deep-link into the Faces tab, aimed at her (the tab owns the browser).
      if (window.FacesPane && window.FacesPane.aimAt) window.FacesPane.aimAt(m.formId || 0, m.name);
      else if (window.__omniSetTab) window.__omniSetTab('faces');
    }, { title: 'Open the Faces tab and apply a RaceMenu preset to ' + m.name }));

    /* Re-frame the photo she ALREADY has. Distinct from "Replace portrait"
       above (which needs her loaded, on screen and alive) and from the LOOKING
       AT card's ⛶ Adjust (which frames the NEXT capture, blind): this one needs
       nothing but the file, so it is the only framing control that works on a
       follower who is three holds away. Offered only when there is a photo —
       an entry that can only say "no portrait yet" is worse than no entry. */
    const shot = portraitFor(m);
    if (shot) {
      items.push(item('⛶', cropFor(shot.file) ? 'Re-frame photo…' : 'Adjust photo framing…', () => {
        closeCtx();
        openLightbox({ slug: shot.slug, file: shot.file, ext: shot.ext,
                       mtime: shot.mtime, name: m.name, formId: m.formId || 0 }, true);
      }, {
        title: 'Open the photo large and drag / zoom it. Changes how the deck '
             + 'DRAWS this face everywhere; the file on disk is never rewritten.',
      }));
    }

    groups.appearance = items.splice(0);

    /* ---- Recruit / dismiss / inventory (Nether's Follower Framework) ----
       Placed with the other things you DO to a person, after the map toggle.
       `following` comes off the roster envelope, so the button says the one
       thing that is actually available rather than offering both. */
    items.push(h('div', { class: 'fd-ctx-sep' }));

    /* These go through sendNpc -> whoOf, which sends `liveFormId` when FO's
       stored id is a base record — so "the game can reach her" is the right
       question here, not FO's inWorld. (The two rows above, Summon and Go to,
       are FO's OWN ops on the stored form and stay gated on inWorld.) */
    const npcReachable = m.inWorld || !!m.liveFormId;
    const npcBlocked = !npcReachable || m.dead;
    const npcTitle = m.dead ? 'They are dead'
      : (!npcReachable ? (wTitle || 'Not in the world this session') : null);

    if (m.following) {
      /* Stays open on a quest-held refusal for the same reason the recruit
         row does: the arm needs this row on screen for its second click. */
      const dsArmed = !!forceDismiss;
      items.push(item('⊘', dsArmed ? 'Force dismiss?' : 'Dismiss from service', (e) => {
        if (dsArmed) { closeCtx(); dismissClick(m); return; }
        arm(e.currentTarget.querySelector('.fd-ctx-lbl') || e.currentTarget,
          'Dismiss ' + m.name + '?', 'Click again to send them home',
          () => { dismissClick(m); });
      }, { disabled: npcBlocked && !dsArmed,
           title: dsArmed ? forceDismiss.msg
                : (npcTitle || 'Send them home through NFF (its own dismissal, not a teleport)') }));
    } else {
      /* The menu deliberately STAYS OPEN on recruit. Two reasons: a guarded
         refusal needs this row still on screen to arm it for the second click,
         and a successful one re-pushes fdState, so refreshOpenMenu repaints
         this very row as "Dismiss from service" — the result in place, which
         is better feedback than a menu that vanished. */
      const ctxArmed = forceRecruit && forceRecruit.op === 'recruit';
      items.push(item('⚔', ctxArmed ? 'Recruit anyway?' : 'Recruit as follower', () => {
        recruitClick(m);
      }, { disabled: npcBlocked && !ctxArmed,
           title: ctxArmed ? forceRecruit.msg
                : (npcTitle || 'Ask them to follow you — through Nether\'s Follower Framework') }));
    }
    items.push(item('☰', 'Open their inventory', () => {
      closeCtx();
      sendNpc('inventory', m);
    }, { disabled: npcBlocked, title: npcTitle || 'Force-open their full container (the deck closes — you are standing in it)' }));
    /* The NFF SPARE inventory, for a SPECIFIC person off the roster — the
       quick card's version only ever acts on whoever is under the crosshair,
       and this is the menu you open when you have someone in mind. Third
       container, distinct from the one above and from her outfit chests. */
    items.push(item('⛃', 'Open their spare inventory', () => {
      closeCtx();
      sendNpc('storage', m);
    }, { disabled: npcBlocked,
         title: npcTitle || 'NFF\'s extra storage chest for them — not their own pack, '
           + 'and not their outfits (the deck closes)' }));

    groups.service = items.splice(0);

    /* The worn set, always shown. Asked for once per menu open; a cached
       answer paints immediately and is refreshed in the background. */
    items.push(equippedBlock(m, true));
    if (!restore) askEquipped(m);
    groups.equipment = items.splice(0);

    items.push(h('div', { class: 'fd-ctx-sep' }));

    const sel = h('select', { class: 'fd-ctx-select', title: 'Move to another category', onClick: (e) => e.stopPropagation(), onChange: (e) => {
      const to = parseInt(e.target.value, 10);
      if (!isNaN(to) && to !== row.cat) {
        closeCtx();
        sendApply('moveMember', { cat: row.cat, idx: row.idx, to });
      }
    } });
    state.cats.forEach((c) => {
      const o = h('option', { value: String(c.index) }, catLabel(c) + (c.members.length ? ' (' + c.members.length + ')' : ''));
      if (c.index === row.cat) o.selected = true;
      sel.append(o);
    });
    const categoryFilter = h('input', { class: 'fd-ctx-input', type: 'search',
      placeholder: 'Find a category…', 'aria-label': 'Find a category', autocomplete: 'off',
      onInput: function (e) {
        const q = e.target.value.trim().toLowerCase();
        Array.prototype.forEach.call(sel.options, function (o) {
          o.hidden = o.textContent.toLowerCase().indexOf(q) === -1;
        });
      },
      onKeydown: function (e) {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        e.preventDefault();
        const first = Array.prototype.find.call(sel.options, function (o) { return !o.hidden; });
        if (first && Number(first.value) !== row.cat) {
          closeCtx(); sendApply('moveMember', { cat: row.cat, idx: row.idx, to: Number(first.value) });
        }
      }
    });
    /* Rober, 2026-09-23: "no option to change that category in follower
       organizer they are in while searching?" — the control was here, but the
       search indexes a field by its text, and "change follower" is not in
       "Category". The title is indexed too, so it carries the words a player
       types for this. */
    items.push(h('div', { class: 'fd-ctx-field fd-ds-category', title: 'Change category — move them to another Follower Organizer group (file, move, folder, roster)' },
      h('label', null, 'Category'), categoryFilter, sel));

    /* Armed two-click, because PrismaUI has no confirm(). The arming has to
       EXPIRE, though: it used to persist for as long as the menu stayed open,
       so you could arm it, get distracted editing fields, come back, click
       once meaning "arm" — and delete. It now disarms after a few seconds and
       the moment you touch anything else in the menu, which are the two ways
       "I moved on" actually looks. */
    const RM_ARM_MS = 3500;
    let armed = false, armTimer = 0;
    const rmLbl = h('span', { class: 'fd-ctx-lbl' }, 'Remove from this category');
    const disarm = () => {
      if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
      if (!armed) return;
      armed = false;
      rmBtn.classList.remove('confirm');
      rmLbl.textContent = 'Remove from this category';
    };
    const rmBtn = h('button', {
      class: 'fd-ctx-item danger',
      title: 'Only removes the deck entry — the NPC is untouched',
      onClick: (e) => {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          rmBtn.classList.add('confirm');
          rmLbl.textContent = 'Remove — click again';
          if (armTimer) clearTimeout(armTimer);
          // isConnected: the menu may have been torn down before this fires
          armTimer = setTimeout(() => { if (rmBtn.isConnected) disarm(); else armTimer = 0; }, RM_ARM_MS);
          return;
        }
        disarm();
        closeCtx();
        sendApply('deleteMember', { cat: row.cat, idx: row.idx });
        toast('Removed ' + m.name + ' from ' + row.catName);
      },
    }, h('span', { class: 'fd-ctx-check' }, '🗑'), rmLbl);
    /* Anything else in the menu getting the pointer or the caret means the
       user moved on. Capture phase so it lands before the other handler, and
       skip events that came from the button itself. */
    const disarmOnOther = (e) => { if (!rmBtn.contains(e.target)) disarm(); };
    items.push(rmBtn);

    groups.organize = items.splice(0);
    ctxEl = buildMemberDossier(row, groups, restore);
    ctxEl.addEventListener('pointerdown', disarmOnOther, true);
    ctxEl.addEventListener('focusin', disarmOnOther, true);
    $('overlay').append(ctxEl);
    ctxEl._dossier.mount();
    ctxEl._dossier.restore();

  }

  /* File somebody into a Follower Organizer category.
   *
   *  `whoTo` is optional: omit it and this files the CROSSHAIR target, which
   *  is what the tab's own ＋ Add button has always done. The F7 card passes
   *  its SUBJECT instead, so the card can file the person it is actually
   *  about — including a follower picked off the party strip, who is not
   *  under the crosshair at all.
   *
   *  Categories she is ALREADY in are shown ticked and disabled rather than
   *  hidden: "she is already in Demons" is the answer to the question you
   *  opened this menu with, and silently omitting it looks like the category
   *  went missing. */
  /* "Add to follower framework" — and it ASKS WHICH GROUP.
   *
   *  Rober, 2026-09-20: "add to follower framework (MAKE SURE IT ASKS WHICH
   *  GROUP)". There are TWO things called "the framework" on this card and
   *  they are not the same thing, which is exactly why a bare button was
   *  wrong:
   *    · Follower Organizer — the ROSTER, which has categories (groups). This
   *      is what "which group" means, and it is what the deck itself reads.
   *    · Nether's Follower Framework — an IMPORT, which has no categories at
   *      all: it lends her NFF's gear/tweaks/storage while her own follow
   *      package keeps running.
   *  So the menu offers both, with the categories spelled out and the ones she
   *  is already in ticked and disabled. Same chrome as the roster's own + Add
   *  (fd-ctx-menu), because it is the same question asked from another place.
   */
  function openFrameworkMenu(whoTo) {
    const tgt = whoTo || state.target;
    if (!tgt || !tgt.name) return;
    closeCtx();

    /* Which categories she is already filed under — resolved through the
       roster's own identity match, not by name equality, so an NPC the roster
       knows by her base name still ticks correctly. */
    const already = Object.create(null);
    const hit = rosterEntryFor(tgt.original || tgt.name);
    state.cats.forEach((c) => {
      if (c.index === ALL) return;
      (c.members || []).forEach((m) => {
        const a1 = String(m.original || m.name || '').toLowerCase();
        const a2 = String((hit && hit.m.original) || tgt.original || tgt.name || '').toLowerCase();
        if (a1 && a1 === a2) already[c.index] = true;
      });
    });
    const imported = !!(hit && hit.m && hit.m.imported);

    const items = [h('div', { class: 'fd-ctx-head' }, 'Add “' + tgt.name + '” to…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });

    listBox.append(h('div', { class: 'fd-ctx-sub' }, 'Follower Organizer — pick a group'));
    state.cats.forEach((c) => {
      if (c.index === ALL) return;     // "All" is a view, not a group you can file into
      const inIt = !!already[c.index];
      listBox.append(h('button', {
        class: 'fd-ctx-item' + (inIt ? ' active' : ''),
        disabled: inIt ? true : null,
        title: inIt ? tgt.name + ' is already filed under ' + catLabel(c)
                    : 'File ' + tgt.name + ' under ' + catLabel(c),
        onClick: (e) => {
          e.stopPropagation(); closeCtx();
          if (inIt) return;
          sendApply('addMember', { cat: c.index, formId: Number(tgt.formId) >>> 0 });
        },
      },
        h('span', { class: 'fd-ctx-check' }, inIt ? '✓' : ''),
        h('span', { class: 'fd-ctx-lbl' }, catLabel(c)),
        h('span', { class: 'fd-ctx-count' }, String((c.members || []).length))));
    });

    /* NFF's import. Deliberately BELOW the groups and labelled as the
       different thing it is — it is not filing, and it has no group to pick. */
    listBox.append(h('div', { class: 'fd-ctx-sub' }, 'Nether\u2019s Follower Framework — no groups'));
    listBox.append(h('button', {
      class: 'fd-ctx-item' + (imported ? ' active' : ''),
      title: imported
        ? tgt.name + ' is already in NFF \u2014 this takes her back out again'
        : 'Lend ' + tgt.name + ' NFF\u2019s features (gear, tweaks, storage, sandbox). '
          + 'Not recruitment: her own follow package keeps running.',
      onClick: (e) => {
        e.stopPropagation(); closeCtx();
        const m = (hit && hit.m) ? hit.m : { formId: Number(tgt.formId) >>> 0, name: tgt.name,
                                             original: tgt.original || tgt.name };
        frameworkClick(m, imported);
      },
    },
      h('span', { class: 'fd-ctx-check' }, imported ? '\u2713' : ''),
      h('span', { class: 'fd-ctx-lbl' }, imported ? 'Remove from NFF' : 'Import into NFF'),
      h('span', { class: 'fd-ctx-count' }, '')));

    items.push(listBox);
    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const addW = ctxWidthPx(curAv(), false);
    ctxEl.style.width = addW + 'px';
    ctxEl.style.maxWidth = addW + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(260) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    centerCtx();
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
  }

  function openAddMenu(whoTo) {
    const tgt = whoTo || state.target;
    if (!tgt || !tgt.name) return;
    closeCtx();
    const already = Object.create(null);
    const hit = rosterEntryFor(tgt.original || tgt.name);
    state.cats.forEach((c) => {
      if (c.index === ALL) return;
      (c.members || []).forEach((m) => {
        const a1 = String(m.original || m.name || '').toLowerCase();
        const a2 = String((hit && hit.m.original) || tgt.original || tgt.name || '').toLowerCase();
        if (a1 && a1 === a2) already[c.index] = true;
      });
    });
    const items = [h('div', { class: 'fd-ctx-head' }, 'Add “' + tgt.name + '” to…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    state.cats.forEach((c) => {
      const inIt = !!already[c.index];
      listBox.append(h('button', {
        class: 'fd-ctx-item' + (inIt ? ' active' : ''),
        disabled: inIt ? true : null,
        title: inIt ? tgt.name + ' is already filed under ' + catLabel(c) : null,
        onClick: (e) => {
          e.stopPropagation(); closeCtx();
          if (inIt) return;
          sendApply('addMember', { cat: c.index, formId: Number(tgt.formId) >>> 0 });
        },
      },
        h('span', { class: 'fd-ctx-check' }, inIt ? '✓' : ''),
        h('span', { class: 'fd-ctx-lbl' }, catLabel(c)),
        h('span', { class: 'fd-ctx-count' }, String(c.members.length))));
    });
    items.push(listBox);
    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    // same box as the member menu, minus the day allowance — a category list
    // that is narrower than the menu it sits under reads as a different widget
    const addW = ctxWidthPx(curAv(), false);
    ctxEl.style.width = addW + 'px';
    ctxEl.style.maxWidth = addW + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    /* Sit the list ABOVE the button it came from. Measured rather than
       estimated from a per-row constant: the rows grow with the avatar
       slider now, so any constant here would be wrong at eleven of the
       twelve sizes and would silently start covering the button. */
    /* Anchored under the tab's own + Add button when it is there; centred when
       it is not, because the F7 card can open this from the Hotkeys tab where
       that button does not exist — and reading getBoundingClientRect off null
       would take the whole menu down. */
    const anchor = $('fd-add-btn');
    if (!anchor) { centerCtx(); reclampCtx(); makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
                   setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
                   return; }
    const r = anchor.getBoundingClientRect();
    // flip above the button by the PAINTED height (offset × --ui-scale)
    clampCtx(r.left, r.top - 10 - ctxEl.offsetHeight * deckScale());
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
  }

  /* ============================================== send her somewhere ==== *
   *  Three kinds of destination, deliberately in one list rather than three
   *  buttons, because they answer the same question and only differ in who
   *  knows the coordinates:
   *
   *    Where she was   Follower Organizer's snapshot-undo. The ONLY option
   *                    that knows where she stood before you summoned her —
   *                    nothing else can reconstruct that, which is why it
   *                    stays first and keeps the original wording.
   *    Her homes       MHiYH's linked marker, or NFF's base for the slot she
   *                    is filed under. Offered only when the roster already
   *                    shows a home for her, so a dead row is impossible; the
   *                    C++ side re-resolves the REF at press time, so if the
   *                    mod later moves her home this follows automatically.
   *    Domains         anything marked on the Domains tab, borrowed via
   *                    DomainsPane.listMarks() and sent through the existing
   *                    pdNpcTo route rather than a second mover.
   *
   *  Typeable because Rober asked for it and because the domain list is the
   *  one part that grows without limit — the filter covers name, category,
   *  note and place, matching how the Domains tab's own search behaves.
   * ====================================================================== */
  function domainMarks() {
    try {
      const dp = window.DomainsPane;
      if (!dp || typeof dp.listMarks !== 'function') return [];
      const list = dp.listMarks();
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }   // a borrower must never take the menu down
  }

  function sendToDomain(m, mark) {
    /* pdNpcTo wants the actor by KEY, in the same spelling the Domains tab's
       own summon list uses: a hex formId string. */
    toGame('pdNpcTo', JSON.stringify({
      npcKey: canonHexKey(m.formId),
      mark: {
        cellId: mark.cellId >>> 0, cellEdid: mark.cellEdid || '', name: mark.name || '',
        x: mark.x, y: mark.y, z: mark.z, angleZ: mark.angleZ,
        worldspaceId: mark.worldspaceId >>> 0, interior: !!mark.interior,
      },
    }));
    toast('⮌ ' + m.name + ' → ' + (mark.name || 'there'));
  }

  function canonHexKey(v) {
    const n = Number(v);
    if (isFinite(n) && n > 0) return '0x' + (n >>> 0).toString(16).toUpperCase();
    return String(v == null ? '' : v);
  }

  /* Put the crosshair NPC on Follower Organizer's roster. addMember wants the
     form id as a NUMBER (unlike nfBuild, which wants hex text) — passing the
     hex string files nobody and reports success, so the >>>0 is load-bearing.
     The chosen category is remembered for the one-click repeat button. */
  function fileInto(cat, target, who) {
    const t = target || (state.target || null);
    if (!t || !t.formId) return;
    const label = who || t.name || 'them';
    ui.fqLastCat = cat.index;
    fqStatus = { msg: 'Filing ' + label + ' into ' + catLabel(cat) + '…', ok: true, pending: true };
    sendApply('addMember', { cat: cat.index, formId: (t.formId >>> 0) });
    render();
  }

  /* ---- Move to… (2026-09-23) ---------------------------------------------
     Rober, F7 card, search "follower organizer": "not in f7 menu either".
     The card could ADD her to a second category (openAddMenu) but not CHANGE
     the one she is in — that was a dossier-only control. Same menu, filter
     and keyboard contract as openFileInto: the row she is in now is marked
     and inert, every other row moves her through FO's own moveMember, and
     the old "also add" door stays as the last row. */
  function openMoveTo(anchorEl, known, who, addTarget) {
    if (!known || !known.cat || !known.m) return;
    closeCtx();
    const label = who || known.m.name || 'them';
    const from = known.cat;
    const cats = state.cats.filter((c) => c.index !== ALL);

    const items = [h('div', { class: 'fd-ctx-head', title: label }, 'Move ' + label + ' to…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    const filter = h('input', {
      class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Type a category — Enter moves her to the top match',
      'aria-label': 'Find a category',
      onInput: (e) => paint(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const first = Array.prototype.find.call(listBox.querySelectorAll('.fd-ctx-item'),
            (b) => !(b.disabled || b.hasAttribute('disabled')));
          if (first) first.click();
        }
      },
    });
    items.push(h('div', { class: 'fd-ctx-field' }, filter));
    items.push(listBox);

    function moveTo(c) {
      closeCtx();
      fqStatus = { msg: 'Moving ' + label + ' from ' + catLabel(from) + ' to ' + catLabel(c) + '…', ok: true, pending: true };
      sendApply('moveMember', { cat: from.index, idx: known.idx, to: c.index });
      render();
    }

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      let n = 0;
      cats.forEach((c) => {
        const name = catLabel(c);
        if (f && (name + ' ' + (c.original || '')).toLowerCase().indexOf(f) === -1) return;
        const here = c.index === from.index;
        listBox.append(h('button', {
          class: 'fd-ctx-item' + (here ? ' active' : ''),
          disabled: here ? true : null,
          title: here ? label + ' is filed here now' : 'Move ' + label + ' to ' + name,
          onClick: (e) => { e.stopPropagation(); if (!here) moveTo(c); },
        },
          h('span', { class: 'fd-ctx-check' }, here ? '\u2713' : '\u203a'),
          h('span', { class: 'fd-ctx-lbl' }, name + (here ? ' \u2014 now' : '')),
          h('span', { class: 'fd-ctx-count' }, String(c.members.length))));
        n++;
      });
      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          cats.length ? 'No category matches \u201c' + q + '\u201d.'
                      : 'Follower Organizer has no categories yet.'));
      }
    }
    paint('');

    /* the old door, kept: file her under a SECOND category without leaving this one */
    if (addTarget) {
      items.push(h('div', { class: 'fd-ctx-sep' }));
      items.push(h('button', {
        class: 'fd-ctx-item fd-ctx-also',
        title: 'Keep ' + label + ' in ' + catLabel(from) + ' and add her to another category as well',
        onClick: (e) => { e.stopPropagation(); closeCtx(); openAddMenu(addTarget); },
      }, h('span', { class: 'fd-ctx-check' }, '\uff0b'),
         h('span', { class: 'fd-ctx-lbl' }, 'Also add to another category\u2026')));
    }

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    try { filter.focus(); } catch (err) { /* no focus in a harness */ }
  }

  /* The category picker the dead <select> should have been. Same menu, filter
     and keyboard contract as openSendTo — FO allows 25 categories, which is
     well past the point where an unfiltered list stops being usable. */
  function openFileInto(anchorEl, t, who) {
    closeCtx();
    const cats = state.cats.filter((c) => c.index !== ALL);

    const items = [h('div', { class: 'fd-ctx-head', title: who }, 'File ' + who + ' into…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });

    items.push(h('div', { class: 'fd-ctx-field' },
      h('input', {
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter categories…',
        onInput: (e) => paint(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      })));
    items.push(listBox);

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      listBox.textContent = '';
      let n = 0;
      cats.forEach((c) => {
        const label = catLabel(c);
        if (f && (label + ' ' + (c.original || '')).toLowerCase().indexOf(f) === -1) return;
        listBox.append(h('button', {
          class: 'fd-ctx-item',
          onClick: (e) => { e.stopPropagation(); closeCtx(); fileInto(c, t, who); },
        },
          h('span', { class: 'fd-ctx-check' }, c.index === ui.fqLastCat ? '\u2713' : '\uff0b'),
          h('span', { class: 'fd-ctx-lbl' }, label),
          h('span', { class: 'fd-ctx-count' }, String(c.members.length))));
        n++;
      });
      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          cats.length ? 'No category matches \u201c' + q + '\u201d.'
                      : 'Follower Organizer has no categories yet.'));
      }
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = ctxMaxHpx(220) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    clampCtx(r.left, r.top);
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  /* ---- "Send her to…" — a popout of places, with their pictures ----------
     2026-09-23, Rober (screenshot of the old list): "this menu should also be
     reworked to show domain artwork". It was a narrow text list in the ctx-menu
     shell; it is now a body-anchored popout (the deck's popout rule: anything
     that reveals more content gets its own spacious modal), and every domain is
     a card carrying the photo the Domains tab shows for it, painted through
     DomainsPane.artOf so a re-framed photo is framed the same here.

     Shape: a quick row of the special destinations (equal tiles, one row), then
     the domains GROUPED by category in the Domains tab's own order, each group
     an even grid of equal 16:9 cards. A place with no photo shows the same
     hue-tinted initials banner the Domains card does. Typeable (Enter takes the
     top hit), Escape / Close / a backdrop click close it.

     It is still `ctxEl`, so every existing guard — the pane swallowing keys
     while a menu is up, closeCtx() from anywhere — keeps working unchanged.
     Like .gaw-back it fills the viewport: bare vh/vw, no --ui-scale. */
  function sdpArt(mk) {
    let a = { src: '', transform: '', hue: 45, initials: '' };
    try {
      if (window.DomainsPane && typeof DomainsPane.artOf === 'function') a = DomainsPane.artOf(mk);
      else a.src = String(mk.image || '');
    } catch (_) { a.src = String(mk.image || ''); }
    const box = h('span', { class: 'sdp-art ' + (mk.interior ? 'interior' : 'exterior'), 'aria-hidden': 'true' });
    box.style.setProperty('--sdp-hue', String(a.hue == null ? 45 : a.hue));
    /* The banner is ALWAYS there, under the photo: a photo that fails to load
       paints nothing and the banner shows through — no probe, no 404 dance. */
    box.append(h('span', { class: 'sdp-banner' }, a.initials || '⌂'));
    if (a.src) {
      const img = h('span', { class: 'sdp-photo' });
      img.style.backgroundImage = 'url("' + String(a.src).replace(/"/g, '%22') + '")';
      if (a.transform) { img.style.transformOrigin = '50% 50%'; img.style.transform = a.transform; }
      box.append(img);
    }
    return box;
  }

  /* Columns for a group of n cards, chosen so its rows come out EVEN (Rober's
     symmetry rule: flush rows, no dangling card). C = how many ~300px cards
     fit across the popout. Prefer a count that divides n (C+1 down to C-1, so
     5 goes five-across and 8 goes 4 + 4); a small group sits in ONE row; only
     when nothing divides does the last row's cards stretch to fill it. Pure —
     the harness feeds it widths. */
  function sdpCols(n, vw) {
    const w = vw || (typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1600);
    const min = w <= 720 ? 220 : 300;
    const cardW = Math.min(1500, w - 48) - 60;
    const C = Math.max(1, Math.floor((cardW + 16) / (min + 16)));
    if (C === 1 || n <= 1) return 1;
    if (n <= C + 1) return Math.min(n, C + 1);
    for (let k = C + 1; k >= Math.max(2, C - 1); k--) if (n % k === 0) return k;
    return C;
  }

  function openSendTo(anchorEl, row) {
    const m = row.m;
    closeCtx();

    const mhHome = m.mhHome ? String(m.mhHome) : '';
    const nffHome = m.nffHome ? String(m.nffHome) : '';
    const marks = domainMarks();

    const pick = (on) => (e) => { if (e) e.stopPropagation(); closeCtx(); on(); };
    const body = h('div', { class: 'sdp-body' });
    const count = h('span', { class: 'sdp-count' }, '');

    const search = h('input', {
      /* fd-ctx-filter: the focus-on-open code below looks for it */
      class: 'sdp-search fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search places — name, category, note…',
      onInput: (e) => paint(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCtx(); return; }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const first = body.querySelector('.sdp-pick');
          if (first) first.click();
        }
      },
    });

    const card = h('div', { class: 'sdp-card', role: 'dialog', 'aria-label': 'Send ' + m.name + ' to' },
      h('div', { class: 'sdp-head' },
        h('span', { class: 'sdp-title' }, 'Send ' + m.name + ' to…'),
        count,
        h('button', { class: 'sdp-close', type: 'button', title: 'Close (Esc)',
          onClick: (e) => { e.stopPropagation(); closeCtx(); } }, 'Close')),
      h('div', { class: 'sdp-field' }, search),
      body);

    function quickTile(icon, label, sub, on) {
      return h('button', { class: 'sdp-quick-tile sdp-pick', type: 'button', onClick: pick(on) },
        h('span', { class: 'sdp-quick-ic' }, icon),
        h('span', { class: 'sdp-quick-text' },
          h('span', { class: 'sdp-quick-lbl' }, label),
          h('span', { class: 'sdp-quick-sub' }, sub)));
    }

    function placeCard(mk) {
      const where = [mk.interior ? 'Interior' : 'Exterior', mk.cellName && mk.cellName !== mk.name ? mk.cellName : '']
        .filter(Boolean).join(' · ');
      return h('button', { class: 'sdp-place sdp-pick', type: 'button', title: 'Send ' + m.name + ' to ' + mk.name,
        onClick: pick(() => sendToDomain(m, mk)) },
        sdpArt(mk),
        h('span', { class: 'sdp-place-meta' },
          h('span', { class: 'sdp-place-name' }, mk.name),
          h('span', { class: 'sdp-place-sub' }, where)));
    }

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      const hit = (s) => !f || String(s || '').toLowerCase().indexOf(f) !== -1;
      body.textContent = '';
      let n = 0;

      const quick = [];
      if (hit('where they were she was back undo summon return'))
        quick.push(quickTile('⮌', 'Where they were', 'Undo the summon',
          () => sendWorld('sendback', row.cat, row.idx, '⮌ ' + m.name + ' returns')));
      if (mhHome && hit('her home mhiyh my home is your home ' + mhHome))
        quick.push(quickTile('⌂', 'Her home', mhHome, () => sendNpc('sendHome', m, { dest: 'mhiyh' })));
      if (nffHome && hit('her nff base nether follower framework home ' + nffHome))
        quick.push(quickTile('⌂', 'Her NFF base', nffHome, () => sendNpc('sendHome', m, { dest: 'nff' })));
      if (quick.length) {
        const qrow = h('div', { class: 'sdp-quick' }, quick);
        /* one row, equal tiles, whatever the count — never a dangling tile */
        qrow.style.gridTemplateColumns = 'repeat(' + quick.length + ', minmax(0, 1fr))';
        body.append(qrow);
        n += quick.length;
      }

      /* Group by category in the Domains tab's order (first appearance);
         the uncategorised go last under their own header. */
      const order = [], groups = Object.create(null);
      marks.forEach((mk) => {
        if (!mk || !mk.name) return;
        if (!hit([mk.name, mk.category, mk.note, mk.cellName].join(' '))) return;
        const k = String(mk.category || '').trim();
        if (!groups[k]) { groups[k] = []; order.push(k); }
        groups[k].push(mk);
      });
      order.sort((x, y) => (x ? 0 : 1) - (y ? 0 : 1));
      order.forEach((k) => {
        const list = groups[k];
        body.append(h('div', { class: 'sdp-group-h' },
          h('span', { class: 'sdp-group-t' }, k || 'Other domains'),
          h('span', { class: 'sdp-group-n' }, String(list.length))));
        const cols = sdpCols(list.length);
        const grid = h('div', { class: 'sdp-grid sdp-k' + Math.min(cols, 4) }, list.map(placeCard));
        grid.style.setProperty('--sdp-cols', String(cols));
        body.append(grid);
        n += list.length;
      });

      count.textContent = f ? n + (n === 1 ? ' match' : ' matches') : marks.length + (marks.length === 1 ? ' domain' : ' domains');
      if (!n) {
        body.append(h('div', { class: 'sdp-empty' },
          marks.length || mhHome || nffHome ? 'Nothing matches “' + q + '”.'
            : 'No homes set, and no domains marked yet — mark one on the Domains tab.'));
      }
    }
    paint('');

    ctxEl = h('div', { class: 'sdp-back' }, card);
    /* A press on the dim backdrop closes; a press anywhere on the card does not. */
    ctxEl.addEventListener('mousedown', (e) => { if (e.target === ctxEl) closeCtx(); });
    document.body.append(ctxEl);
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
    }, 0);
  }

  function dropAfter(e, el) { const r = el.getBoundingClientRect(); return (e.clientY - r.top) > r.height / 2; }

  /* ====================================================== pane contract == */

  function isActive() {
    return typeof ui !== 'undefined' && window.__hdActiveTab === 'followers';
  }

  /* ---- who else is painting these faces (2026-09-13) --------------------
     The Followers tab is no longer the only consumer of the facegen-head
     rail: the Household tab draws the SAME renders (household-pane.js reads
     them through householdRoster -> portraitFor). Both the repaint AND the
     completion POLL have to honour it.

     The poll is the load-bearing half. A head that is not on disk yet comes
     back as `queued`, and the ONLY thing that ever collects it is the 5 s
     re-ask below — gated, until now, on the Followers tab being up. So
     opening Household asked for every missing face, C++ rendered them, and
     the view never went back for them: the page sat on initials forever and
     only filled in if you happened to visit Followers afterwards. */
  // portrait-consumers-v2: publish only after the shared store has changed.
  function portraitsChanged() {
    if (ctxEl && ctxEl._dossier) refreshOpenMenu();
    dropRowCache();
    if (isActive()) renderList();
    renderQuickCard();
    if (window.GetAway) GetAway.portraitsChanged();
    if (window.OstimTools) OstimTools.portraitsChanged();
    try { if (window.HouseholdPane) HouseholdPane.dataChanged(); } catch (e) {}
    window.dispatchEvent(new CustomEvent('hd-portraits-changed'));
  }

  function faceConsumerActive() {
    return isActive() || ['household', 'domains', 'wardrobe'].indexOf(window.__hdActiveTab) !== -1 || !!(window.DomainsPane && DomainsPane.isShown()) || !!(window.HDNpcTune && HDNpcTune.isOpen()) || !!(window.GetAway && GetAway.isOpen()) || !!(window.OstimTools && OstimTools.isOpen()) || !!(ctxEl && ctxEl._dossier);
  }

  /* Anything -> { key: "non-empty string" }. Non-object input, array input,
     numeric/boolean/null values, blank values and unusable keys are all
     dropped rather than propagated: every consumer downstream (chip, search,
     editor rows) can then assume plain strings. */
  function normalizeFields(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (k) {
      if (!FIELD_KEY_RE.test(k)) return;
      const v = raw[k];
      if (typeof v !== 'string') return;
      const t = v.trim();
      if (t) out[k] = t.length > FIELD_VALUE_MAX ? t.slice(0, FIELD_VALUE_MAX) : t;
    });
    return out;
  }

  function normMember(m) {
    /* Free-form field map. Tolerant on purpose — an older FO DLL sends no
       "fields" at all, and a hand-edited JSON can put anything in there; either
       way this ends up a plain object of string -> non-empty string, and every
       reader downstream can stop checking. fieldsText is the search haystack,
       lowercased once here instead of per keystroke. */
    const fields = normalizeFields(m.fields);
    const vals = [];
    Object.keys(fields).forEach(function (k) { vals.push(fields[k]); });
    /* mergeHome() folds on the NFF / MHiYH read-only facts, mergeFert() the
       Fertility Mode ones. Both run here AND from their own receivers, so
       fdState / fdNff / fdFertility may land in any order. They only ever write
       m.home* / m.nff* / m.fert — never m.fields, which is yours. */
    return mergeFert(mergeHome({
      name: String(m.name || '?'),
      override: String(m.override || ''),
      original: String(m.original || ''),
      desc: String(m.desc || ''),
      fields: fields,
      fieldsText: vals.join('\n').toLowerCase(),
      tracked: !!m.tracked,
      resolved: !!m.resolved,
      inWorld: !!m.inWorld,
      following: !!m.following,
      dead: !!m.dead,
      form: String(m.form || ''),
      formId: String(m.formId || ''),
    }));
  }

  function normalizeState(s) {
    s = s || {};
    state.cats = (Array.isArray(s.categories) ? s.categories : []).map((c) => ({
      index: (c.index >>> 0) || 0,
      name: String(c.name || ''),
      override: String(c.override || ''),
      original: String(c.original || ''),
      hotkey: typeof c.hotkey === 'number' ? c.hotkey : -1,
      inMagicMenu: !!c.inMagicMenu,
      members: (Array.isArray(c.members) ? c.members : []).map(normMember),
    })).filter((c) => c.index >= 1);
    state.total = typeof s.total === 'number' ? s.total
      : state.cats.reduce((n, c) => n + c.members.length, 0);
  }

  /* Party-sheet search words, per scope. The ROWS are derived from PT_SCOPES
     so a new scope becomes searchable the day it is added — but the words a
     player would actually type for one ("who is hurt", "over-encumbered") are
     not in the scope's own label or title, and a synonym list is exactly what
     keywords are for. An unlisted key simply searches by its label. */
  const PT_OMNI_KW = {
    all: 'retinue whole party side by side compare',
    here: 'with you at your back nearby present in the cell',
    away: 'waiting parked left behind elsewhere told to wait',
    issues: 'needs attention hurt wounded injured dying naked unarmed '
          + 'no weapon no armour no armor out of arrows problems what is wrong',
  };

  /* Land on the party sheet, on a named scope. Shared by the omni rows below
     and by anything else that wants to send you there with a question already
     chosen, so the tab switch and the scope always happen in the same order. */
  function ptOmniOpen(scopeKey) {
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
    ui.ptScope = scopeKey;
    ui.ptSel = -1;
    /* setPartyOpen early-returns when the sheet is ALREADY up, so the scope
       change would be stored and never painted — repaint it ourselves in that
       case. Two calls, one of which is always a no-op, is cheaper than a
       second implementation of the sheet's own opening sequence. */
    if (ui.ptOpen) renderParty(); else setPartyOpen(true);
  }

  /* ---- Omni search provider (universal search, v0.14.0) ---------------- *
   * Indexes the LIVE roster at query time — categories, names, notes, the
   * v0.10.0 NPC fields (relationship/home/…) and the NFF/MHiYH home text all
   * ride the same haystacks visibleRows() already searches, so anything new
   * that lands in a member is searchable with no omni change.
   *
   * Beyond the roster it also carries the two NAMED SURFACES this tab owns and
   * nothing else could reach — the party sheet (with its scopes) and the
   * Followers HUD settings — plus the companions who are following you but
   * have no Follower Organizer row at all. All three were invisible to search:
   * the sheet and the HUD hang off small buttons in the search row, and a
   * framework-driven companion is in state.liveParty, which the roster walk
   * below never touches. */
  function omniOpenMember(original, category, asDossier) {
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
    // Resolve after the tab transition. Search results may predate a rename,
    // reorder or move; never dispatch with a captured category/member index.
    let found = null;
    state.cats.forEach(c => (c.members || []).forEach((m, idx) => {
      if ((m.original || m.name) !== original) return;
      if (!found || c.index === category) found = { cat: c.index, idx: idx, m: m, catName: catLabel(c) };
    }));
    if (!found) { toast('“' + original + '” is no longer in the roster'); return; }
    ui.editing = false; ui.ptOpen = false; ui.nhOpen = false; ui.rrOpen = false; syncRecallChrome();
    ui.rosterOpen = true; exitFocus();
    ui.cat = found.cat; ui.filter = found.m.name || original; ui.fqPick = ''; ui.fqPickPinned = false;
    ui.sel = visibleRows().findIndex(r => r.cat === found.cat && r.idx === found.idx);
    const search = $('fd-search'); if (search) search.value = ui.filter;
    render();
    if (asDossier === 'quick') {
      ui.fqPickPinned = true; ui.fqPick = original;
      enterFocus(); pickCrew(found.m);
    } else if (asDossier) openMemberMenu(found, 0, 0);
    else {
      const list = $('fd-list');
      const selected = list && list.querySelector('.fd-member.sel');
      if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
    }
  }

  function omniFollowersIndex() {
    const items = [];
    (state.cats || []).forEach((c) => {
      const cl = c.override || c.name || c.original || '';
      (c.members || []).forEach((m) => {
        const rel = m.fields && m.fields.relationship;
        const original = m.original || m.name || '';
        /* ---- the wife / expecting markers (2026-09-13) -------------------
           Rober: "Searchable npcs in command k search with a marker for
           pregnant or wife." Both facts are already merged onto the member —
           `spouse` from M.A.R.A.S (via fdNff's rel slice) and `fert` from
           Fertility Mode — so the row can carry them without a single new
           read. They ride in THREE places on purpose:
             kind     the chip the result row draws, so the marker is visible
                      at a glance without reading the detail line;
             detail   "♥ wife · ◍ expecting 46%", because how far along is the
                      thing actually worth knowing about a pregnancy;
             keywords so typing "wife" or "pregnant" FINDS her — including the
                      MARAS spouse whose Relationship field you never filled
                      in, which is the case that made this necessary.
           The hues are the roster's own (violet married, rose pregnant); omni
           rows are text, so the glyphs ♥ / ◍ carry the same distinction the
           chips do — matching spouseChip() and fertChip() exactly. */
        const f = (m.fert && typeof m.fert === 'object') ? m.fert : null;
        const preg = !!(f && f.pregnant);
        const pregPct = (preg && f.termDays && typeof f.percent === 'number')
          ? (' ' + f.percent + '%') : '';
        /* A wife by EITHER answer: the game's (MARAS married her) or yours
           (you typed it in her Relationship field). They disagree often
           enough in a harem playthrough that picking one would be wrong half
           the time — same rule household-pane.js documents. */
        const wifeField = /(^|[^a-z])(wife|wives|spouse|husband|consort|bride)([^a-z]|$)/
          .test(String(rel || '').toLowerCase());
        const isWife = !!m.spouse || wifeField;
        const marks = [
          isWife ? '\u2665 wife' : '',
          preg ? ('\u25CD expecting' + pregPct) : '',
        ].filter(Boolean);
        /* The same two facts as ICONS on the name itself (Rober, 2026-09-14:
           "show if pregnant or a wife next to their name by an icon") — the
           detail line above says it in words, this says it where the eye
           lands first. Same glyphs, same hues (hd-omni.css .omni-mark-*). */
        const nameMarks = [];
        if (isWife) nameMarks.push({ g: '\u2665', cls: 'wife',
          title: m.spouse ? 'Married to you \u2014 M.A.R.A.S' : 'Your wife \u2014 her Relationship field' });
        if (preg) nameMarks.push({ g: '\u25CD', cls: 'expecting',
          title: 'Expecting' + pregPct + (f.father ? ' \u2014 father: ' + f.father : '') });
        /* 💬 — she is a live CHIM agent (Rober, 2026-09-14: "when searching
           can show a hoverable chim icon showing activated"). chim-flyout.js
           owns the agent set (one chAgents call as the omni opens); this
           just asks it. Empty until the set is known, never a stale badge. */
        if (window.ChimBtn && typeof ChimBtn.markFor === 'function') {
          try { ChimBtn.markFor(m).forEach((mk) => nameMarks.push(mk)); } catch (e) {}
        }
        items.push({
          label: m.name || m.original || '(unnamed)',
          marks: nameMarks,
          /* Explicit identity survives fdTarget's asynchronous crosshair
             refresh. Click opens her dossier; ↗/Shift+Enter selects her row. */
          run: function () { omniOpenMember(original, c.index, true); },
          jump: function () { omniOpenMember(original, c.index, false); },
          detail: marks.concat([rel, cl, m.desc].filter(Boolean)).join(' \u00b7 '),
          /* The marker WINS the chip when there is one — "expecting" says more
             about her than "follower" or whatever you typed, and a pregnancy
             is the rarer, more time-critical fact. */
          kind: preg ? 'expecting' : (isWife ? 'wife' : (rel || 'follower')),
          keywords: [m.original, m.fieldsText, m.homeText,
                     isWife ? 'wife wives spouse married maras household' : '',
                     preg ? 'pregnant expecting with child carrying baby heir '
                          + (f.termDays ? ('day ' + f.day + ' of ' + f.termDays) : '')
                          + (f.father ? (' father ' + f.father) : '') : '',
                     (f && f.births > 0) ? 'mother children born' : '',
                    ].filter(Boolean).join(' '),
          /* `original` — the same durable identity the recents strip keys
             on: a rename must not split her, a re-file must not lose her */
          pin: 'fol:' + original,
          snap: { original: original, label: m.name || m.original || '' },
          /* her portrait, plain path (no ?v= — Ultralight's loader can eat
             the query as filename, see medalEl); shelf falls back to the
             glyph if it fails to load */
          icon: (function () {
            const p = portraitFor(m);
            return p ? portraitSrc(p) : '';
          })(),
        });
      });
    });

    /* The people actually walking behind you who are NOT on the roster —
       companions run by their own follower mod, CHIM soft-follow. partyList()
       is the one place that merges state.liveParty in, and it already marks a
       synthesised entry `live:true`, so this is that merge reused rather than
       a second de-dup rule that could disagree with the crew strip.

       No `pin`: her identity here lasts exactly as long as she follows you,
       and a shelf star that greys out every time she is dismissed — then comes
       back under a DIFFERENT key the day she is filed into a category — is a
       worse promise than no star at all.

       run() lands her on the party sheet with her name in its filter, because
       that is the one surface in this pane that can say anything about her: the
       roster is state.cats and she is not in it, and the quick card resolves
       its subject through rosterEntryFor, which would not find her either. */
    (partyList() || []).forEach(function (m) {
      if (!m.live) return;
      const nm = m.name || m.original || '';
      if (!nm) return;
      items.push({
        label: nm,
        detail: 'following you — not on the Follower Organizer roster',
        kind: 'following now',
        keywords: 'live party companion teammate follower mod not filed unlisted '
                + 'behind you current party',
        icon: (function () {
          const p = portraitFor(m);
          return p ? portraitSrc(p) : '';
        })(),
        run: function () {
          ui.ptFilter = nm;
          ptOmniOpen('all');
        },
      });
    });

    /* The party sheet, one row per scope. The scopes ARE the questions people
       ask ("who needs attention"), so each gets its own row instead of one row
       that lands on whatever scope was last used. */
    PT_SCOPES.forEach(function (s) {
      items.push({
        label: s.key === 'all' ? 'Party sheet' : 'Party sheet: ' + s.label.toLowerCase(),
        detail: s.title,
        kind: 'page',
        keywords: 'party sheet everyone gear health armour armor weapon damage '
                + 'encumbered carry weight arrows level cards table '
                + (PT_OMNI_KW[s.key] || ''),
        run: function () { ptOmniOpen(s.key); },
      });
    });

    items.push({
      label: 'Followers HUD',
      detail: 'The on-screen portrait strip of your current followers — enable it, '
            + 'lay it out, pick what each face shows, bind its key.',
      kind: 'settings',
      keywords: 'hud portrait strip on screen overlay faces party bar health bars '
              + 'names compact browse key vertical horizontal reposition widgets',
      /* Tab FIRST, then the modal. The modal is a document.body child and would
         open over any tab — but its own button lives in this pane's search row,
         and landing somewhere the setting cannot be found again afterwards is
         how a settings shortcut becomes a magic trick. */
      run: function () {
        if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
        openHudModal();
      },
    });

    return items;
  }

  if (window.HDOmni) HDOmni.register({
    id: 'followers', label: 'Followers', tab: 'followers',
    /* People FIRST. Every other group sorts by score; this one sits above
       them whenever it has a hit at all, so "elana" shows Elana before the
       24 quests named after her (Rober, 2026-09-14). */
    rank: 0,
    /* Shelf activation: a pinned PERSON opens her ACTION MENU — summon / go
       to / send back, the roster row's own menu. Tab switch FIRST, then the
       exact resolve-by-identity path the recents strip uses, so the menu
       lands on her row in the pane that owns it — never floating over
       another tab (the wardrobe-guard lesson). */
    pinRun: function (snap) {
      if (!snap || !snap.original) return;
      if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
      openFromRecents({ id: snap.original, name: snap.label || snap.original }, null);
    },
    setFilter: function (q) {
      ui.cat = ALL; ui.rosterOpen = true;
      ui.ptOpen = false; ui.nhOpen = false; ui.rrOpen = false; syncRecallChrome(); exitFocus();
      ui.filter = String(q || '');
      ui.sel = -1;
      const s = $('fd-search');
      if (s) s.value = ui.filter;
      try { render(); } catch (e) {}
    },
    index: omniFollowersIndex,
  });

  /* ---- Omni provider: the quick card's own actions (2026-08-19) --------- *
   *  ⌕ Find an action already indexes every button this card can draw — the
   *  ~20 named verbs (Tune, Portrait, Inventory, Trade, Effects, Copy outfit,
   *  Full stats, Quests, Animate, Preset, Distributions, Room ban, Spare, Add
   *  as mount, CHIM, Adjust, Grab, Freeze, Formation…) plus the ones sitting
   *  behind a closed reveal. But that index lived entirely inside the card, so
   *  Ctrl+F from anywhere else in the deck returned nothing for any of them.
   *  This is the SAME index, published to omni.
   *
   *  ---- why it is snapshotted, not walked per keystroke ------------------
   *  index() runs on every keystroke and the walk costs a card build (the
   *  reveal probe builds several). The game is PAUSED for the whole life of
   *  the omni overlay, so the card cannot change underneath it — one snapshot
   *  at warm() is not a shortcut, it is the honest reading. The subject key is
   *  re-checked on every index() anyway, so a build whose host never calls
   *  warm() still gets a correct (merely later) index.
   *
   *  ---- why run() re-resolves instead of clicking the row's element ------
   *  A snapshot taken while the card was NOT mounted holds buttons from a
   *  detached node, and clicking one of those is a no-op that looks like a
   *  working press. So firing goes through the card's OWN fqFindResolve: land
   *  on the Followers tab, make sure the card is actually mounted, open the
   *  reveal if the action lives behind one, then click the live control. No
   *  verb is re-implemented here — every hit ends in a .click() on the card.
   * ---------------------------------------------------------------------- */

  /* The snapshot. `key` is who it is about; an empty key means "no subject, so
     there is no card and nothing to index". */
  const FQ_OMNI = { key: '', items: [] };

  function fqOmniSubject() {
    const subj = quickSubject();
    if (subj) return subj.name || subj.original || '';
    return (state.target && state.target.name) ? String(state.target.name) : '';
  }

  /* Every action the card can offer right now, whether or not it is on screen.
     With the card mounted this is exactly what its own ⌕ search sees. Without
     one — omni opened from another tab — the base card is built DETACHED and
     merged in front of the reveal probe's rows, which fqFindIndex cannot do for
     itself because it reads the live card. `fqProbing` is set for the same
     reason the probe sets it: a card nobody sees must not put asks on the
     wire. */
  function fqOmniRows() {
    const rows = fqFindIndex();
    if (fqFindCard()) return rows;
    let node = null;
    fqProbing = true;
    try { node = buildQuickCard(); } catch (e) { node = null; }
    fqProbing = false;
    if (!node) return rows;
    const seen = Object.create(null);
    const out = [];
    fqScan(node, '').forEach(function (r) {
      if (seen[r.key]) return;
      seen[r.key] = 1;
      out.push(r);
    });
    rows.forEach(function (r) {
      if (seen[r.key]) return;
      seen[r.key] = 1;
      out.push(r);
    });
    return out;
  }

  /* Put the card on screen so a hit has something to click. Uses the pane's own
     entry points: a picked party member is already the subject and only needs
     the host mounting, while a crosshair NPC gets the F7 dossier the card was
     designed for. Returns whether a card actually made it onto the page. */
  function fqOmniGo() {
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
    if (fqFindCard()) return true;
    if (ui.fqPick || ui.npcFocus) syncQuickHere();
    else if (state.target && state.target.name) enterFocus();
    return !!fqFindCard();
  }

  function fqOmniItems() {
    const who = fqOmniSubject();
    /* No subject, no rows. With nobody picked the card draws the EVERYONE
       orders instead, and those are not this provider's to publish: fqOmniGo
       cannot mount a subject-less card, so every one of them would be a press
       that quietly does nothing. */
    if (!who) return [];
    return fqOmniRows().map(function (r) {
      const why = r.disabled ? fqFirstClause(r.why) : '';
      return {
        label: r.label,
        detail: [r.sect, who, why ? '⚠ ' + why : fqFirstClause(r.sub)]
          .filter(Boolean).join(' · '),
        kind: r.disabled ? 'unavailable' : 'action',
        keywords: [r.sect, r.sub, r.alias, who, 'card button action'].filter(Boolean).join(' '),
        /* Even an unavailable action jumps to the card, so the greyed control
           and the reason written on it are what you land on — the card's own
           law that a refusal is the useful sentence, carried into search. */
        jump: function () { fqOmniGo(); },
        run: r.disabled ? undefined : function () {
          if (!fqOmniGo()) {
            toast('Look at ' + (who || 'someone') + ' again — her card is not open');
            return;
          }
          if (typeof r.run === 'function') { fqFindFire(r); return; }
          const el = fqFindResolve(r);
          if (el && el.isConnected) { el.click(); return; }
          toast('“' + r.label + '” is not on the card any more');
        },
      };
    });
  }

  /* Re-read unconditionally: the overlay has just opened, so this is the one
     moment the snapshot is guaranteed to be about the person on screen. */
  function fqOmniWarm() {
    FQ_OMNI.key = fqOmniSubject();
    FQ_OMNI.items = fqOmniItems();
  }

  function fqOmniIndex() {
    const who = fqOmniSubject();
    if (who !== FQ_OMNI.key) {
      FQ_OMNI.key = who;
      FQ_OMNI.items = fqOmniItems();
    }
    return FQ_OMNI.items;
  }

  if (window.HDOmni) HDOmni.register({
    id: 'follower-card', label: 'Follower card', tab: 'followers',
    warm: fqOmniWarm,
    index: fqOmniIndex,
  });

  /* ====================================================================== *
   *  Omni: three verbs that existed but had no way into the search bar.
   *
   *  Rober, 2026-09-17: "no option to add to follower organizer? Then ask me
   *  what category???" and "NFF has a players chest should be able to control
   *  f command k menu that and drop it."
   *
   *  All three already worked. Filing someone was the ＋ Add button inside this
   *  tab; the player chest was two buttons inside the Wardrobe's NFF block.
   *  Neither was registered with the omni, so from Ctrl+F they did not exist —
   *  and a verb you cannot find is a verb you do not have. The add menu already
   *  does exactly what he asked for: it lists every category, ticks the ones she
   *  is already filed under and disables those so she cannot be double-filed.
   * ====================================================================== */
  function rosterOmniItems() {
    const out = [];
    const tgt = state.target;
    const who = (tgt && tgt.name) ? tgt.name : '';
    /* Filing needs a subject. With nobody in the crosshair the row is published
       as UNAVAILABLE carrying the reason rather than hidden — the card
       provider's own law, that a refusal is the useful sentence. */
    out.push({
      label: 'Add to Follower Organizer…',
      detail: who
        ? 'File ' + who + ' under a category — the menu ticks the ones she is already in'
        : '⚠ Look at someone first: this files whoever is in your crosshair',
      kind: who ? 'action' : 'unavailable',
      keywords: 'add roster follower organizer file category member new list fo organiser',
      jump: function () { if (window.setTab) setTab('followers'); },
      run: who ? function () {
        if (window.setTab) setTab('followers');
        openAddMenu();
      } : undefined,
    });
    /* NFF's THIRD storage tier, and the one that is easy to forget exists:
       every cleared outfit set and every dismissed follower's leftovers drain
       into it. C++ closes the palette for chestOpen itself, because a
       ContainerMenu cannot be raised under the deck; chestPlace only moves the
       chest, so the palette stays up and you can open it next. */
    out.push({
      label: 'Player chest — open it',
      detail: "NFF's shared chest: cleared outfits and dismissed followers' leftovers drain here",
      kind: 'action',
      keywords: 'nff player chest storage open container shared stash leftovers outfit drain',
      run: function () { toGame('nfChest', '{"op":"chestOpen"}'); },
    });
    out.push({
      label: 'Player chest — drop it here',
      detail: 'Move the chest to a spot beside you. NFF polices this itself: it refuses in a dungeon '
            + 'and charges a cooldown away from a town or one of its home markers',
      kind: 'action',
      keywords: 'nff player chest drop place here move bring summon stash relocate',
      run: function () { toGame('nfChest', '{"op":"chestPlace"}'); },
    });
    return out;
  }

  if (window.HDOmni) HDOmni.register({
    id: 'roster-storage', label: 'Followers', tab: 'followers',
    index: rosterOmniItems,
  });

  /* Called by the Wardrobe host when NFF/SOES state changes underneath us, so
     the quick card's clothes block repaints in place instead of waiting for
     the next open. Guarded on our tab being the visible one. */
  /* The CHIM agent set landed or a toggle moved someone (chim-flyout.js
     agentsChanged): the card's 💬 reads its lit state at build time, so
     repaint. renderQuickCard is a no-op without a mounted host. */
  window.addEventListener('hd-chim-agents', function () {
    try { renderQuickCard(); } catch (e) {}
  });

  function clothesChanged() {
    if (isActive()) renderQuickCard();
    /* The outfit dock reads the same two modules and is drawn OVER the card, so
       a handover / wear / clear answered while it is up must repaint it too —
       it is not inside the card and never sees renderQuickCard(). */
    if (window.HDOutfit && HDOutfit.isOpen()) HDOutfit.refresh();
  }

  /* ====================================================================== *
   *                            PARTY  SHEET
   *  The whole retinue's gear, vitals and status on ONE page — the feature
   *  Skyrim Party Sheet (Nexus SSE 167538) is named after and the one this
   *  deck never had.
   *
   *  WHY IT IS NOT THE ROSTER. The roster answers "who exists and where is she
   *  filed". It cannot answer the questions that actually cost you a fight,
   *  because those are COMPARISONS:
   *
   *      who is hurt · who has no weapon · who is wearing nothing ·
   *      who is over-encumbered · who is holding a bow with no arrows ·
   *      who is parked in an inn three holds away
   *
   *  Twelve card opens cannot answer them either — each one reads a different
   *  moment. So: one snapshot (src/party_sheet.cpp, ptyScan → ptyData), every
   *  member side by side, two shapes to read it in.
   *
   *  THE SPLIT. C++ ships FACTS and never a verdict. Every threshold below —
   *  what counts as hurt, whether an empty potion pouch is worth a chip — is a
   *  judgement, and a judgement baked into the DLL costs a rebuild plus a game
   *  exit to retune. Here it is PT_RULES, a text edit.
   *
   *  ONE SNAPSHOT IS ENOUGH, and that is not laziness: Followers is a
   *  deck-class tab, so the game is PAUSED the whole time this is on screen.
   *  Nothing can change under it. A poll would burn a bridge round trip per
   *  tick to redraw identical numbers. ⟳ Refresh exists for the case where you
   *  gave an order from the card and came back.
   *
   *  ENGINE LAWS THIS OBEYS (measured in PrismaUI's own Ultralight 1.4.1):
   *    · conic-gradient computes to `none` — so every meter here is a LINEAR
   *      bar. There are no rings on this page, by construction rather than by
   *      fallback, because a fallback is a second thing to keep right.
   *    · no looping animations, no animated background-position.
   *    · colour emoji render monochrome at a ~1.4em advance, so the glyphs are
   *      drawn from the set the deck already ships (⚔ ⛨ ➶ ☠ ⚠ ◆) and every
   *      glyph box has a min-width.
   *    · 12px floor on every rule in followers-pane.css.
   *
   *  KEYSTROKE COST. Same discipline as the roster and for the same measured
   *  reason: cards are cached by formId, kept while their SIGNATURE holds, and
   *  MOVED into place by the roster's own fdReconcile. A keystroke rewrites the
   *  search highlight and nothing else. Every push that changes what a card
   *  draws without changing the member object (portraits, face renders) drops
   *  the cache at the source — see ptDropCache's callers.
   * ====================================================================== */

  /* Where the line is. Every number here is a JUDGEMENT, deliberately kept out
     of the DLL so retuning it is a text edit — see the header above. */
  const PT_RULES = {
    hurt: 0.60,        // below this fraction of max health: hurt
    critical: 0.25,    // …and below this: critical
    lowMagicka: 0.25,  // a caster with an empty pool
    far: 4096.0,       // game units — roughly a cell away
    minArmour: 1,      // an armour rating under this reads as "none"
  };

  /* The four sort orders, plus the columns the table shares with them so a
     header click and a chip click can never disagree about what "Armour" is. */
  const PT_SORTS = [
    { key: 'issues', label: 'Needs attention', title: 'Worst first — dead, then hurt, then missing gear.' },
    { key: 'name',   label: 'Name',            title: 'A to Z.' },
    { key: 'level',  label: 'Level',           title: 'Highest level first.' },
    { key: 'health', label: 'Health',          title: 'Lowest health, as a share of her own maximum, first.' },
    { key: 'armour', label: 'Armour',          title: 'Weakest armour first — who is going to get hurt.' },
    { key: 'damage', label: 'Damage',          title: 'Highest weapon damage first.' },
    { key: 'load',   label: 'Load',            title: 'Fullest pack first.' },
  ];

  const PT_SCOPES = [
    { key: 'all',    label: 'Everyone',        title: 'Every follower the game can see right now.' },
    { key: 'here',   label: 'With you',        title: 'Only the ones actually at your back.' },
    { key: 'away',   label: 'Waiting',         title: 'Only the ones you told to wait somewhere.' },
    { key: 'issues', label: 'Needs attention', title: 'Only the ones with something wrong.' },
  ];

  /* --------------------------------------------------------- the facts --- */

  function ptMembers() {
    const list = (state.party && Array.isArray(state.party.members)) ? state.party.members : [];
    /* A conjured familiar IS a teammate, and grading one for owning no boots is
       nonsense — C++ flags it rather than dropping it so this stays a setting
       and not a rebuild. */
    return ui.ptSummons ? list : list.filter(function (r) { return !r.summon; });
  }

  function ptNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  /* The bar's denominator. `hpMax` is base + PERMANENT modifiers, so a
     TEMPORARY fortify pushes hp above it; drawing that literally gives a bar
     overflowing its own track. Over-full is drawn as full — see party_sheet.h
     for why C++ does not invent the total instead. */
  function ptMax(cur, max) { return Math.max(ptNum(max), ptNum(cur), 1); }
  function ptFrac(cur, max) { return Math.min(1, ptNum(cur) / ptMax(cur, max)); }

  function ptHand(r, which) { return (r && r[which] && typeof r[which] === 'object') ? r[which] : {}; }
  function ptArmed(t) { const k = t.kind; return k === 'weapon' || k === 'staff' || k === 'spell'; }

  /* Her weapon, in one phrase. The right hand is the one that swings; a spell
     in the left of an empty right hand is still what she fights with. */
  function ptWeaponOf(r) {
    const rh = ptHand(r, 'right'), lh = ptHand(r, 'left');
    const main = ptArmed(rh) ? rh : (ptArmed(lh) ? lh : null);
    if (!main) return { name: '', kind: '', damage: 0, est: false };
    return { name: main.name || '(unnamed)', kind: main.kind,
             damage: ptNum(main.damage), est: !!main.est, ranged: !!main.ranged };
  }

  /* -------------------------------------------------------- the verdict --- */

  /* Everything wrong with one member, worst first. `tone` drives the colour:
     bad = she is going to die or cannot fight · warn = she is worse off than
     she should be · note = you probably want to know.
     `why` is the hover sentence, and it always says what to DO where there is
     something to do — a chip that only names a problem is half a report. */
  function ptIssues(r) {
    const out = [];
    const push = function (key, tone, glyph, label, why) {
      out.push({ key: key, tone: tone, glyph: glyph, label: label, why: why });
    };
    if (!r) return out;

    if (r.dead) {
      push('dead', 'bad', '☠', 'Dead',
        'She is down for good. Resurrecting her is not something this deck does.');
      return out;   // nothing else about a corpse is worth a chip
    }

    const hpF = ptFrac(r.hp, r.hpMax);
    if (hpF <= PT_RULES.critical)
      push('critical', 'bad', '◆', 'Critically hurt',
        Math.round(hpF * 100) + '% of her health left. One more hit and she is on the floor.');
    else if (hpF <= PT_RULES.hurt)
      push('hurt', 'warn', '◆', 'Hurt',
        Math.round(hpF * 100) + '% of her health left — she has not healed since the last fight.');

    if (r.unarmed)
      push('unarmed', 'bad', '⚔', 'No weapon',
        'Both hands empty. She will punch things for ' + Math.round(ptNum(r.unarmedDamage))
        + ' damage. Open her pack and give her something.');

    const slots = (r.slots && typeof r.slots === 'object') ? r.slots : {};
    if (!slots.body)
      push('naked', 'bad', '⛨', 'Wearing nothing',
        'Nothing in her body slot at all. If an outfit system is dressing her, it has not run.');
    else if (r.bodyClothing)
      push('clothes', 'warn', '⛨', 'In clothes',
        '“' + (r.body || 'Her outfit') + '” is clothing, not armour — it carries no rating.');
    else if (ptNum(r.armor) < PT_RULES.minArmour)
      push('noarmour', 'warn', '⛨', 'No armour rating',
        'She is wearing something, but the engine rates it at zero.');

    const rh = ptHand(r, 'right');
    const ammo = (r.ammo && typeof r.ammo === 'object') ? r.ammo : {};
    if (rh.ranged && ptNum(ammo.count) <= 0)
      push('noammo', 'bad', '➶', 'No arrows',
        'She is holding ' + (rh.name || 'a bow') + ' and has nothing to fire from it.');

    const load = ptNum(r.load), carry = ptNum(r.carry);
    if (carry > 0 && load > carry)
      push('over', 'warn', '■', 'Over-encumbered',
        Math.round(load) + ' / ' + Math.round(carry) + ' — she cannot run, so she falls behind and '
        + 'arrives after the fight.');

    const pots = (r.potions && typeof r.potions === 'object') ? r.potions : {};
    if (ptNum(pots.health) <= 0)
      push('nopotion', 'note', '⚗', 'No healing potion',
        'Nothing in her pack that restores health. She will not heal herself.');

    if (ptNum(r.magMax) > 0 && ptFrac(r.mag, r.magMax) <= PT_RULES.lowMagicka &&
        (rh.kind === 'spell' || ptHand(r, 'left').kind === 'spell' || rh.kind === 'staff'))
      push('nomagicka', 'warn', '✦', 'Out of magicka',
        'She casts, and her pool is nearly empty.');

    if (r.waiting)
      push('waiting', 'note', '✋', 'Waiting',
        'Told to wait' + (r.where ? ' at ' + r.where : '') + ' — she is not with you.');
    else if (!r.sameCell || ptNum(r.dist) > PT_RULES.far)
      push('far', 'note', '⤷', 'Far away',
        (r.where ? 'She is at ' + r.where + '. ' : '')
        + 'Not in the room with you, and not told to wait either.');

    /* The half-recruit nff_control.h documents: her factions say "current
       follower" while the engine says she is not a teammate, so half her
       dialogue is gone and her orders do not stick. Naming it here is the whole
       point — it is invisible everywhere else in the game. */
    if (r.source === 'faction')
      push('wedged', 'warn', '⚠', 'Orders may not stick',
        'The game has her in the follower faction but not as a teammate. That is the '
        + 'half-recruited state — dismiss and recruit her again to clear it.');

    if (r.invOk === false)
      push('unread', 'note', '⁉', 'Bag unreadable',
        'Her inventory could not be read this pass, so potions, arrows and gold are blank '
        + 'rather than zero.');

    return out;
  }

  const PT_TONE_WEIGHT = { bad: 100, warn: 10, note: 1 };
  function ptSeverity(issues) {
    let n = 0;
    for (let i = 0; i < issues.length; i++) n += (PT_TONE_WEIGHT[issues[i].tone] || 0);
    return n;
  }

  /* ------------------------------------------------------ search + sort --- */

  /* The haystack. It deliberately includes the ISSUE LABELS, so typing "arrows"
     or "encumbered" finds the people the sheet is complaining about — which is
     the question you actually came here with. */
  function ptHaystack(r, issues) {
    const w = ptWeaponOf(r);
    let hay = (r.name || '') + '\n' + (r.base || '') + '\n' + (r.race || '') + '\n'
            + (w.name || '') + '\n' + (r.body || '') + '\n' + (r.where || '') + '\n'
            + ((r.ammo && r.ammo.name) || '');
    for (let i = 0; i < issues.length; i++) hay += '\n' + issues[i].label;
    return hay.toLowerCase();
  }

  function ptScopeOk(r, issues) {
    switch (ui.ptScope) {
      case 'here':   return !r.waiting && !r.dead;
      case 'away':   return !!r.waiting;
      case 'issues': return issues.some(function (i) { return i.tone !== 'note'; });
      default:       return true;
    }
  }

  /* One pass: annotate, filter, sort. Returns the rows the page will draw, in
     order, each carrying its own issues so nothing is computed twice. */
  function ptVisible() {
    const q = String(ui.ptFilter || '').trim().toLowerCase();
    const rows = [];
    ptMembers().forEach(function (r) {
      const issues = ptIssues(r);
      if (!ptScopeOk(r, issues)) return;
      if (q && ptHaystack(r, issues).indexOf(q) < 0) return;
      rows.push({ r: r, issues: issues, sev: ptSeverity(issues) });
    });

    const byName = function (a, b) {
      return String(a.r.name || '').localeCompare(String(b.r.name || ''));
    };
    const desc = function (get) {
      return function (a, b) { const d = get(b.r) - get(a.r); return d || byName(a, b); };
    };
    const asc = function (get) {
      return function (a, b) { const d = get(a.r) - get(b.r); return d || byName(a, b); };
    };
    switch (ui.ptSort) {
      case 'name':   rows.sort(byName); break;
      case 'level':  rows.sort(desc(function (r) { return ptNum(r.level); })); break;
      case 'health': rows.sort(asc(function (r) { return ptFrac(r.hp, r.hpMax); })); break;
      case 'armour': rows.sort(asc(function (r) { return ptNum(r.phys); })); break;
      case 'damage': rows.sort(desc(function (r) { return ptWeaponOf(r).damage; })); break;
      case 'load':   rows.sort(desc(function (r) {
                       return ptNum(r.carry) > 0 ? ptNum(r.load) / ptNum(r.carry) : 0; })); break;
      default:       rows.sort(function (a, b) { return (b.sev - a.sev) || byName(a, b); });
    }
    return rows;
  }

  /* ----------------------------------------------------------- bridge ----- */

  let ptLastAsk = 0;
  const PT_MIN_GAP = 1200;   // folds the open + tab-show burst into one ask

  function ptAsk(force) {
    const now = Date.now();
    if (!force && now - ptLastAsk < PT_MIN_GAP) return;
    ptLastAsk = now;
    state.party.asking = true;
    /* The roster's own idea of who is following rides along, so a companion the
       two faction tests miss is still MEASURED rather than silently absent —
       and anyone we name who is not loaded comes back as an honest count. */
    const ids = [];
    const seen = {};
    partyList().forEach(function (m) {
      const n = Number(m.formId) >>> 0;
      if (n && !seen[n]) { seen[n] = 1; ids.push(n); }
    });
    toGame('ptyScan', JSON.stringify({ ids: ids, skills: !!ui.ptSkills }));
  }

  window.ptyData = function (env) {
    const v = coerce(env);
    ptDropCache();
    state.party.asking = false;
    if (!v || typeof v !== 'object') {
      state.party.ok = false;
      state.party.msg = 'The party scan came back unreadable.';
      state.party.members = [];
    } else {
      state.party.ok = v.ok !== false;
      state.party.msg = String(v.msg || '');
      state.party.members = Array.isArray(v.members) ? v.members : [];
      state.party.unloaded = ptNum(v.unloaded);
      state.party.skillNames = Array.isArray(v.skillNames) ? v.skillNames : [];
    }
    state.party.at = Date.now();
    /* A face we have never rendered may have just walked into the party. */
    requestFaceIcons(false);
    if (isActive()) renderParty();
  };

  /* ------------------------------------------------------------ chrome ---- */

  /* Party mode is a BODY CLASS, not a pile of .hidden toggles: renderList() and
     syncQuickHere() own those, and fighting them for the same elements is how a
     mode ends up half-applied. followers-pane.css hides the roster surfaces off
     that one class and shows #pt-pane. */
  function syncPartyChrome() {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('hd-partysheet', !!ui.ptOpen);
    const t = $('pt-toggle');
    if (t) {
      t.setAttribute('aria-pressed', ui.ptOpen ? 'true' : 'false');
      t.classList.toggle('on', !!ui.ptOpen);
    }
  }

  function setPartyOpen(on, opts) {
    const want = !!on;
    if (ui.ptOpen === want) return;
    ui.ptOpen = want;
    ui.ptSel = -1;
    syncPartyChrome();
    if (want) {
      /* Leaving NPC focus: the party sheet IS the wide view, and the dedicated
         single-NPC chrome hides the tab bar it needs. */
      if (ui.npcFocus) exitFocus();
      if (ui.nhOpen) setHereOpen(false, { noFocus: true });   // one wide view at a time
      if (ui.rrOpen) setRecallOpen(false, { noFocus: true });
      ptAsk(true);
      renderParty();
      if (!(opts && opts.noFocus))
        setTimeout(function () { const s = $('pt-search'); if (s) s.focus(); }, 30);
    } else {
      renderParty();
      setTimeout(function () { const s = $('fd-search'); if (s) s.focus(); }, 30);
    }
  }

  /* --------------------------------------------------------- the cache ---- */

  /* Cards are kept while their signature holds; a keystroke only rewrites the
     highlight. Everything a card draws that is NOT on the member object —
     portraits, face renders — arrives through a push, and each of those drops
     this cache at the source (see ptyData, and the roster's fdPortraits /
     fdCrops / fdFaceIconsData, which call ptDropCache alongside their own). */
  const ptCache = new Map();
  function ptDropCache() { ptCache.clear(); }

  const PT_HL_SEL = '.pt-name, .pt-sub, .pt-weap-name, .pt-where, .pt-chip-lbl';

  function ptCollectHl(el) {
    const out = [];
    const els = el.querySelectorAll(PT_HL_SEL);
    for (let i = 0; i < els.length; i++) out.push([els[i], els[i].textContent]);
    el.__ptHl = out;
  }

  function ptReHighlight(el, q) {
    if (el.__ptQ === q) return;
    const hl = el.__ptHl;
    if (hl) {
      for (let i = 0; i < hl.length; i++) {
        const node = hl[i][0];
        node.textContent = '';
        nameNodes(hl[i][1], q).forEach(function (n) { node.append(n); });
      }
    }
    el.__ptQ = q;
  }

  function ptSig(row) {
    let body;
    try { body = JSON.stringify(row.r); } catch (e) { body = String(row.r && row.r.name); }
    return ui.ptMode + ' ' + row.sev + ' ' + body;
  }

  /* ------------------------------------------------------------ pieces ---- */

  /* A linear meter. NOT a ring: conic-gradient computes to `none` in the engine
     that actually draws this, so a ring here would be an empty circle in game
     and a perfect one in chromium — which is precisely how forty of them
     shipped blank once already. The fill is an inline width, and inline width
     is the one thing every engine agrees on. */
  function ptMeter(cls, cur, max, label, title) {
    const f = ptFrac(cur, max);
    const bar = h('div', { class: 'pt-meter ' + cls, title: title || '' },
      h('div', { class: 'pt-meter-track' },
        h('div', { class: 'pt-meter-fill' })),
      h('div', { class: 'pt-meter-txt' }, label));
    const fill = bar.querySelector('.pt-meter-fill');
    fill.style.width = Math.round(f * 100) + '%';
    return bar;
  }

  function ptPoolMeter(r, kind) {
    const spec = kind === 'hp'
      ? { cls: 'hp', cur: r.hp, max: r.hpMax, name: 'Health' }
      : kind === 'mag'
      ? { cls: 'mag', cur: r.mag, max: r.magMax, name: 'Magicka' }
      : { cls: 'sta', cur: r.sta, max: r.staMax, name: 'Stamina' };
    const cur = Math.round(ptNum(spec.cur));
    const max = Math.round(ptMax(spec.cur, spec.max));
    return ptMeter(spec.cls, spec.cur, spec.max, cur + ' / ' + max,
      spec.name + ' — ' + cur + ' of ' + max
        + (ptNum(spec.cur) > ptNum(spec.max)
             ? '\n(A temporary fortify has her above her permanent maximum, so the bar reads full.)'
             : ''));
  }

  /* Her face, through the roster's own pipeline — a captured portrait if there
     is one, else the facegen head render, else initials. Never a second
     portrait resolver: medalEl / portraitFor already know every rule (the
     store beating a frozen row, the ?v= retry, the layout-crop fit). */
  function ptFace(r) {
    const hit = ptRosterFor(r);
    const m = {
      name: r.name || '',
      original: hit ? (hit.m.original || hit.m.name) : (r.base || r.name || ''),
      formId: r.formId,
      following: !r.waiting && !r.dead,
      dead: !!r.dead,
    };
    return medalEl(m, hit ? hit.cat : 0);
  }

  /* The roster row for a scanned member, by formId first (the reliable key) and
     by name as the fallback — the same order partyList() de-duplicates in. */
  function ptRosterFor(r) {
    const want = Number(r && r.formId) >>> 0;
    let byName = null;
    const names = [String((r && r.name) || '').toLowerCase(), String((r && r.base) || '').toLowerCase()];
    for (let ci = 0; ci < state.cats.length; ci++) {
      const c = state.cats[ci];
      if (c.index === ALL) continue;
      const mem = c.members || [];
      for (let i = 0; i < mem.length; i++) {
        const m = mem[i];
        if (want && (Number(m.formId) >>> 0) === want) return { cat: c.index, idx: i, m: m };
        if (!byName) {
          const k = String(m.original || m.name || '').toLowerCase();
          if (k && (k === names[0] || k === names[1])) byName = { cat: c.index, idx: i, m: m };
        }
      }
    }
    return byName;
  }

  function ptChip(issue) {
    return h('span', { class: 'pt-chip ' + issue.tone, title: issue.label + ' — ' + issue.why },
      h('span', { class: 'pt-chip-ic', 'aria-hidden': 'true' }, issue.glyph),
      h('span', { class: 'pt-chip-lbl' }, issue.label));
  }

  /* Drill in: her card, exactly as F7-on-her would give it. The party sheet
     implements no per-person verb of its own — every one already exists on the
     quick card, and a second copy is the failure mode.

     Someone the live scan found who has no Follower Organizer row cannot be
     addressed that way (quickPick resolves against the roster), so she says so
     and offers the roster's own Add flow instead of failing silently. */
  function ptOpenMember(r) {
    const hit = ptRosterFor(r);
    if (!hit) {
      if (typeof toast === 'function')
        toast('“' + (r.name || 'She') + '” is not on the Follower Organizer roster yet — '
            + 'add her from the roster and her card opens like everyone else’s');
      return false;
    }
    setPartyOpen(false, { noFocus: true });
    ui.cat = ALL;
    enterFocus();
    pickCrew(hit.m);
    return true;
  }

  /* --------------------------------------------------------------- card --- */

  function ptCard(row) {
    const r = row.r;
    const w = ptWeaponOf(r);
    const ammo = (r.ammo && typeof r.ammo === 'object') ? r.ammo : {};
    const card = h('div', {
      class: 'pt-card' + (r.dead ? ' dead' : '') + (r.waiting ? ' waiting' : '')
                       + (row.sev >= PT_TONE_WEIGHT.bad ? ' bad' : (row.sev >= PT_TONE_WEIGHT.warn ? ' warn' : '')),
      'data-fid': String(r.formId || ''),
      tabindex: '0',
      role: 'button',
      title: 'Open ' + (r.name || 'her') + '’s card — the same one F7 on her gives you',
      onClick: function (e) { e.stopPropagation(); ptOpenMember(r); },
      onKeydown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ptOpenMember(r); }
      },
    });

    const head = h('div', { class: 'pt-card-head' });
    head.append(h('span', { class: 'pt-face' }, ptFace(r)));
    const who = h('div', { class: 'pt-who' },
      h('div', { class: 'pt-name' }, r.name || 'Follower'),
      h('div', { class: 'pt-sub' },
        [r.race, r.level ? 'Level ' + r.level : '', r.summon ? 'summoned' : '']
          .filter(Boolean).join(' · ')));
    head.append(who);
    head.append(h('span', {
      class: 'pt-lv',
      title: (r.name || 'She') + ' is level ' + (r.level || '?') + '.',
    }, String(r.level || '?')));
    card.append(head);

    const bars = h('div', { class: 'pt-bars' });
    bars.append(ptPoolMeter(r, 'hp'));
    bars.append(ptPoolMeter(r, 'mag'));
    bars.append(ptPoolMeter(r, 'sta'));
    card.append(bars);

    const gear = h('div', { class: 'pt-gear' });
    gear.append(ptGearCell('⚔', 'Weapon',
      w.name || 'Bare hands',
      w.name ? (w.est ? '≈ ' : '') + Math.round(w.damage) : '—',
      w.name
        ? (w.name + ' — about ' + Math.round(w.damage) + ' damage a swing.\n'
           + 'An estimate: the engine only computes the exact figure for the player, so this is '
           + 'her weapon’s base damage scaled by her skill and fortify effects, and it '
           + 'cannot see the temper on that particular blade.')
        : 'Nothing in either hand — she fights with her fists for '
           + Math.round(ptNum(r.unarmedDamage)) + '.',
      'pt-weap-name'));
    gear.append(ptGearCell('⛨', 'Armour',
      r.body || (r.slots && r.slots.body ? 'Worn' : 'Nothing'),
      Math.round(ptNum(r.armor)),
      'Armour rating ' + Math.round(ptNum(r.armor)) + ', which is '
        + Math.round(ptNum(r.phys)) + '% less physical damage taken (the cap is '
        + ptNum(r.capPhys || 80) + '%).\n'
        + (r.pieces || 0) + ' of the 4 armour pieces that carry the per-piece bonus.'));
    gear.append(ptGearCell('➶', 'Ammo',
      ammo.name || (w.ranged ? 'None' : '—'),
      ammo.name ? String(ptNum(ammo.count)) : '—',
      ammo.name
        ? (ptNum(ammo.count) + ' × ' + ammo.name + ', ' + Math.round(ptNum(ammo.damage)) + ' damage each.')
        : (w.ranged ? 'She is holding a ranged weapon and carrying nothing to fire.'
                    : 'She is not using a ranged weapon.')));
    gear.append(ptGearCell('■', 'Load',
      Math.round(ptNum(r.load)) + ' / ' + Math.round(ptNum(r.carry)),
      ptNum(r.carry) > 0 ? Math.round(100 * ptNum(r.load) / ptNum(r.carry)) + '%' : '—',
      'Carrying ' + Math.round(ptNum(r.load)) + ' of ' + Math.round(ptNum(r.carry))
        + '.\nOver her limit she cannot run, so she arrives after the fight.'));
    card.append(gear);

    const pots = (r.potions && typeof r.potions === 'object') ? r.potions : {};
    const potTotal = ptNum(pots.health) + ptNum(pots.magicka) + ptNum(pots.stamina) + ptNum(pots.other);
    const foot = h('div', { class: 'pt-card-foot' });
    foot.append(h('span', {
      class: 'pt-pot' + (ptNum(pots.health) > 0 ? '' : ' none'),
      title: 'Potions in her pack: ' + ptNum(pots.health) + ' health, ' + ptNum(pots.magicka)
           + ' magicka, ' + ptNum(pots.stamina) + ' stamina, ' + ptNum(pots.other) + ' other.'
           + (r.invOk === false ? '\nHer bag could not be read this pass, so these are blank rather than zero.' : ''),
    }, '⚗ ' + ptNum(pots.health) + (potTotal > ptNum(pots.health) ? ' (' + potTotal + ')' : '')));
    if (r.where)
      foot.append(h('span', { class: 'pt-where', title: 'She is at ' + r.where + '.' }, r.where));
    card.append(foot);

    if (row.issues.length) {
      const chips = h('div', { class: 'pt-chips' });
      row.issues.forEach(function (i) { chips.append(ptChip(i)); });
      card.append(chips);
    } else {
      card.append(h('div', { class: 'pt-chips' },
        h('span', { class: 'pt-chip ok', title: 'Nothing on this sheet is wrong with her.' },
          h('span', { class: 'pt-chip-ic', 'aria-hidden': 'true' }, '✓'),
          h('span', { class: 'pt-chip-lbl' }, 'Ready'))));
    }
    return card;
  }

  function ptGearCell(glyph, label, text, value, title, extraCls) {
    return h('div', { class: 'pt-gear-cell', title: title || '' },
      h('span', { class: 'pt-gear-ic', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'pt-gear-body' },
        h('span', { class: 'pt-gear-lbl' }, label),
        h('span', { class: 'pt-gear-txt' + (extraCls ? ' ' + extraCls : '') }, text)),
      h('span', { class: 'pt-gear-val' }, String(value)));
  }

  /* -------------------------------------------------------------- table --- */

  /* The dense shape — the actual side-by-side. A CSS grid rather than a
     <table> so one row can be a single grid child (which is what makes the
     cached-node reconcile possible at all) and so a long name WRAPS in its own
     column instead of stretching the page. */
  const PT_COLS = [
    { key: 'who',    label: 'Follower', sort: 'name',   title: 'Sort A to Z.' },
    { key: 'level',  label: 'Lv',       sort: 'level',  title: 'Sort by level, highest first.' },
    { key: 'hp',     label: 'Health',   sort: 'health', title: 'Sort by health, lowest first.' },
    { key: 'mag',    label: 'Magicka',  sort: '',       title: 'Her magicka pool.' },
    { key: 'sta',    label: 'Stamina',  sort: '',       title: 'Her stamina pool.' },
    { key: 'armour', label: 'Armour',   sort: 'armour', title: 'Sort by armour, weakest first.' },
    { key: 'weapon', label: 'Weapon',   sort: 'damage', title: 'Sort by damage, highest first.' },
    { key: 'load',   label: 'Load',     sort: 'load',   title: 'Sort by pack fullness, fullest first.' },
    { key: 'issues', label: 'Status',   sort: 'issues', title: 'Sort worst-first.' },
  ];

  function ptTableHead() {
    const head = h('div', { class: 'pt-thead', role: 'row' });
    PT_COLS.forEach(function (c) {
      const active = c.sort && ui.ptSort === c.sort;
      head.append(c.sort
        ? h('button', {
            class: 'pt-th sortable' + (active ? ' active' : ''), type: 'button',
            'data-col': c.key, title: c.title,
            onClick: function (e) { e.stopPropagation(); ui.ptSort = c.sort; renderParty(); },
          }, c.label, active ? h('span', { class: 'pt-th-arrow', 'aria-hidden': 'true' }, '▾') : null)
        : h('span', { class: 'pt-th', 'data-col': c.key, title: c.title }, c.label));
    });
    return head;
  }

  function ptTableRow(row) {
    const r = row.r;
    const w = ptWeaponOf(r);
    const ammo = (r.ammo && typeof r.ammo === 'object') ? r.ammo : {};
    const tr = h('div', {
      class: 'pt-tr' + (r.dead ? ' dead' : '') + (r.waiting ? ' waiting' : '')
                     + (row.sev >= PT_TONE_WEIGHT.bad ? ' bad' : (row.sev >= PT_TONE_WEIGHT.warn ? ' warn' : '')),
      'data-fid': String(r.formId || ''),
      role: 'row', tabindex: '0',
      title: 'Open ' + (r.name || 'her') + '’s card',
      onClick: function (e) { e.stopPropagation(); ptOpenMember(r); },
      onKeydown: function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ptOpenMember(r); }
      },
    });

    tr.append(h('span', { class: 'pt-td who' },
      h('span', { class: 'pt-face sm' }, ptFace(r)),
      h('span', { class: 'pt-who' },
        h('span', { class: 'pt-name' }, r.name || 'Follower'),
        h('span', { class: 'pt-sub' }, r.race || ''))));
    tr.append(h('span', { class: 'pt-td num', title: 'Level' }, String(r.level || '?')));
    tr.append(h('span', { class: 'pt-td' }, ptPoolMeter(r, 'hp')));
    tr.append(h('span', { class: 'pt-td' }, ptPoolMeter(r, 'mag')));
    tr.append(h('span', { class: 'pt-td' }, ptPoolMeter(r, 'sta')));
    tr.append(h('span', {
      class: 'pt-td num',
      title: 'Armour rating ' + Math.round(ptNum(r.armor)) + ' — '
           + Math.round(ptNum(r.phys)) + '% less physical damage, from '
           + (r.pieces || 0) + ' of 4 bonus-carrying pieces.',
    }, String(Math.round(ptNum(r.armor)))));
    tr.append(h('span', { class: 'pt-td weap' },
      h('span', { class: 'pt-weap-name', title: w.name || 'Bare hands' }, w.name || 'Bare hands'),
      h('span', {
        class: 'pt-weap-dmg',
        title: w.name
          ? 'About ' + Math.round(w.damage) + ' damage — an estimate, since the engine only '
            + 'computes the exact figure for the player.'
          : 'Unarmed.',
      }, w.name ? (w.est ? '≈' : '') + Math.round(w.damage) : '—'),
      ammo.name ? h('span', {
        class: 'pt-weap-ammo' + (ptNum(ammo.count) <= 0 ? ' none' : ''),
        title: ptNum(ammo.count) + ' × ' + ammo.name,
      }, '➶' + ptNum(ammo.count)) : null));
    tr.append(h('span', {
      class: 'pt-td num' + (ptNum(r.carry) > 0 && ptNum(r.load) > ptNum(r.carry) ? ' over' : ''),
      title: 'Carrying ' + Math.round(ptNum(r.load)) + ' of ' + Math.round(ptNum(r.carry)) + '.',
    }, ptNum(r.carry) > 0 ? Math.round(100 * ptNum(r.load) / ptNum(r.carry)) + '%' : '—'));

    const st = h('span', { class: 'pt-td chips' });
    if (row.issues.length) row.issues.forEach(function (i) { st.append(ptChip(i)); });
    else st.append(h('span', { class: 'pt-chip ok', title: 'Nothing wrong with her.' },
      h('span', { class: 'pt-chip-ic', 'aria-hidden': 'true' }, '✓'),
      h('span', { class: 'pt-chip-lbl' }, 'Ready')));
    tr.append(st);
    return tr;
  }

  /* ---------------------------------------------------------- the page ---- */

  function ptMountPane() {
    let pane = $('pt-pane');
    if (pane) return pane;
    const main = $('fd-main');
    if (!main) return null;
    pane = h('section', { id: 'pt-pane', 'aria-label': 'Party sheet' },
      h('div', { class: 'pt-head' }),
      h('div', { class: 'pt-filters' }),
      h('div', { class: 'pt-body' }),
      h('div', { class: 'pt-empty hidden' }));
    /* Before the roster list, so the party sheet occupies the same slot the
       roster does and inherits its scroll box rather than sitting under it. */
    const before = $('fd-list');
    if (before && before.parentNode === main) main.insertBefore(pane, before);
    else main.append(pane);
    return pane;
  }

  function ptCountLine() {
    const all = ptMembers();
    const here = all.filter(function (r) { return !r.waiting && !r.dead; }).length;
    const away = all.filter(function (r) { return r.waiting; }).length;
    const down = all.filter(function (r) { return r.dead; }).length;
    const bits = [here + ' with you'];
    if (away) bits.push(away + ' waiting');
    if (down) bits.push(down + ' down');
    if (state.party.unloaded) bits.push(state.party.unloaded + ' too far to read');
    return bits.join(' · ');
  }

  function ptRenderHead(pane) {
    const head = pane.querySelector('.pt-head');
    head.textContent = '';

    head.append(h('button', {
      class: 'pt-back', type: 'button',
      title: 'Back to the follower roster',
      onClick: function (e) { e.stopPropagation(); setPartyOpen(false); },
    }, h('span', { class: 'pt-back-chev', 'aria-hidden': 'true' }, '◂'), 'Roster'));

    head.append(h('div', { class: 'pt-title-wrap' },
      h('div', { class: 'pt-title' }, 'Party sheet'),
      h('div', { class: 'pt-count', title: 'Read the instant this page opened. The game is paused while the deck is up, so nothing can change underneath it.' },
        ptCountLine())));

    const wrap = h('div', { class: 'pt-search-wrap' },
      h('span', { class: 'pt-search-ic', 'aria-hidden': 'true' }, '⌕'));
    const input = h('input', {
      id: 'pt-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search names, weapons, places — or “arrows”, “hurt”, “encumbered”…',
      title: 'Filters as you type. Enter opens the top match.',
    });
    input.value = ui.ptFilter || '';
    input.addEventListener('input', function (e) {
      ui.ptFilter = e.target.value; ui.ptSel = -1; ptRenderBody(pane);
    });
    /* Filter-as-you-type with the deck's own idiom: arrows move, Enter takes
       the highlighted row (the TOP hit when you have not moved), Escape clears
       the box before it leaves the mode. Handled on the input rather than in
       FolPane.onKey because the pane's key router deliberately hands every
       keystroke inside an <input> straight to that input — see its `inText`
       branch, which exists so typing a name never steers the roster. */
    input.addEventListener('keydown', function (e) {
      const rows = ptVisible();
      if (e.key === 'Enter') {
        const pick = rows[ui.ptSel >= 0 ? ui.ptSel : 0];
        if (pick) { e.preventDefault(); e.stopPropagation(); ptOpenMember(pick.r); }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        ui.ptSel = Math.min(rows.length - 1, ui.ptSel + 1); ptRenderBody(pane);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        ui.ptSel = Math.max(0, ui.ptSel < 0 ? 0 : ui.ptSel - 1); ptRenderBody(pane);
      } else if (e.key === 'Escape' && ui.ptFilter) {
        e.preventDefault(); e.stopPropagation();
        ui.ptFilter = ''; ui.ptSel = -1; input.value = ''; ptRenderBody(pane);
      }
    });
    wrap.append(input);
    if (ui.ptFilter) wrap.append(h('button', {
      class: 'pt-search-x', type: 'button', title: 'Clear the search',
      onClick: function (e) { e.stopPropagation(); ui.ptFilter = ''; ptRenderHead(pane); ptRenderBody(pane);
        const s = $('pt-search'); if (s) s.focus(); },
    }, '✕'));
    head.append(wrap);

    const modes = h('div', { class: 'pt-modes', role: 'group', 'aria-label': 'Layout' });
    [{ k: 'cards', ic: '▣', lbl: 'Cards', t: 'One card each — the readable shape.' },
     { k: 'table', ic: '≡', lbl: 'Table', t: 'One dense row each, columns aligned — the comparing shape.' }]
      .forEach(function (m) {
        modes.append(h('button', {
          class: 'pt-mode' + (ui.ptMode === m.k ? ' on' : ''), type: 'button',
          'aria-pressed': ui.ptMode === m.k ? 'true' : 'false', title: m.t,
          onClick: function (e) { e.stopPropagation(); if (ui.ptMode === m.k) return;
            ui.ptMode = m.k; ptDropCache(); renderParty(); },
        }, h('span', { class: 'pt-mode-ic', 'aria-hidden': 'true' }, m.ic),
           h('span', { class: 'pt-mode-lbl' }, m.lbl)));
      });
    head.append(modes);

    head.append(h('button', {
      class: 'pt-refresh' + (state.party.asking ? ' busy' : ''), type: 'button',
      title: 'Read the party again.\nThe game is paused while the deck is open, so this only '
           + 'matters after you have given an order and come back.',
      onClick: function (e) { e.stopPropagation(); ptAsk(true); renderParty(); },
    }, '↻'));
  }

  function ptRenderFilters(pane) {
    const bar = pane.querySelector('.pt-filters');
    bar.textContent = '';

    const scopes = h('div', { class: 'pt-scopes', role: 'group', 'aria-label': 'Who to show' });
    PT_SCOPES.forEach(function (s) {
      scopes.append(h('button', {
        class: 'pt-fchip' + (ui.ptScope === s.key ? ' on' : ''), type: 'button',
        'aria-pressed': ui.ptScope === s.key ? 'true' : 'false', title: s.title,
        onClick: function (e) { e.stopPropagation(); ui.ptScope = s.key; ui.ptSel = -1; ptRenderFilters(pane); ptRenderBody(pane); },
      }, s.label));
    });
    bar.append(scopes);

    bar.append(h('span', { class: 'pt-filters-spring' }));

    /* The table sorts from its own headers, so a second control saying the same
       thing would be two places to look. */
    if (ui.ptMode === 'cards') {
      const sorts = h('div', { class: 'pt-sorts', role: 'group', 'aria-label': 'Sort by' });
      sorts.append(h('span', { class: 'pt-sorts-lbl' }, 'Sort'));
      PT_SORTS.forEach(function (s) {
        sorts.append(h('button', {
          class: 'pt-fchip' + (ui.ptSort === s.key ? ' on' : ''), type: 'button',
          'aria-pressed': ui.ptSort === s.key ? 'true' : 'false', title: s.title,
          onClick: function (e) { e.stopPropagation(); ui.ptSort = s.key; ptRenderFilters(pane); ptRenderBody(pane); },
        }, s.label));
      });
      bar.append(sorts);
    }

    const hasSummon = (state.party.members || []).some(function (r) { return r.summon; });
    if (hasSummon)
      bar.append(h('button', {
        class: 'pt-fchip' + (ui.ptSummons ? ' on' : ''), type: 'button',
        'aria-pressed': ui.ptSummons ? 'true' : 'false',
        title: 'A conjured familiar is a teammate too. Grading one for owning no boots is '
             + 'nonsense, so they are hidden — turn them on if you want to see them.',
        onClick: function (e) { e.stopPropagation(); ui.ptSummons = !ui.ptSummons; ptDropCache();
          ptRenderFilters(pane); ptRenderBody(pane); ptRenderHead(pane); },
      }, '✦ Summons'));
  }

  function ptRenderBody(pane) {
    const body = pane.querySelector('.pt-body');
    const empty = pane.querySelector('.pt-empty');
    const rows = ptVisible();
    const q = String(ui.ptFilter || '').trim();

    if (!rows.length) {
      body.textContent = '';
      body.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.textContent = '';
      empty.append(h('div', { class: 'pt-em-ic', 'aria-hidden': 'true' }, q ? '⌕' : '⚔'));
      if (state.party.asking && !state.party.at) {
        empty.append(h('div', { class: 'pt-em-title' }, 'Reading the party…'));
        empty.append(h('div', { class: 'pt-em-sub' }, 'Measuring everyone the game can see.'));
      } else if (!state.party.ok) {
        empty.append(h('div', { class: 'pt-em-title' }, 'The party could not be read'));
        empty.append(h('div', { class: 'pt-em-sub' }, state.party.msg || 'No answer from the game.'));
      } else if (q) {
        empty.append(h('div', { class: 'pt-em-title' }, 'Nobody matches “' + q + '”'));
        empty.append(h('div', { class: 'pt-em-sub' },
          'The search covers names, weapons, places and the warnings themselves.'));
      } else if (ui.ptScope !== 'all') {
        empty.append(h('div', { class: 'pt-em-title' },
          ui.ptScope === 'issues' ? 'Everyone is in good shape' : 'Nobody in this group'));
        empty.append(h('div', { class: 'pt-em-sub' },
          ui.ptScope === 'issues'
            ? 'No missing weapons, no empty quivers, nobody badly hurt.'
            : 'Try “Everyone”.'));
      } else {
        empty.append(h('div', { class: 'pt-em-title' }, 'Nobody is with you'));
        empty.append(h('div', { class: 'pt-em-sub' },
          state.party.unloaded
            ? state.party.unloaded + ' of your followers are too far away for the game to read.'
            : 'Recruit someone, or summon your retinue from the roster’s party row.'));
      }
      return;
    }

    empty.classList.add('hidden');
    body.classList.remove('hidden');
    body.classList.toggle('pt-as-table', ui.ptMode === 'table');
    body.classList.toggle('pt-as-cards', ui.ptMode !== 'table');

    const nodes = [];
    if (ui.ptMode === 'table') {
      let head = ptCache.get(' head');
      const headSig = 'head ' + ui.ptSort;
      if (!head || head.__ptSig !== headSig) {
        head = ptTableHead();
        head.__ptSig = headSig;
        ptCache.set(' head', head);
      }
      nodes.push(head);
    }
    if (ui.ptSel >= rows.length) ui.ptSel = rows.length - 1;
    rows.forEach(function (row, i) {
      const key = String(row.r.formId || row.r.name);
      const sig = ptSig(row);
      let node = ptCache.get(key);
      if (!node || node.__ptSig !== sig) {
        node = ui.ptMode === 'table' ? ptTableRow(row) : ptCard(row);
        node.__ptSig = sig;
        node.__ptQ = q;
        ptCollectHl(node);
        ptCache.set(key, node);
      } else {
        ptReHighlight(node, q);
      }
      /* A class, not a rebuild — moving the highlight must not cost a node. */
      node.classList.toggle('sel', i === ui.ptSel);
      nodes.push(node);
    });
    fdReconcile(body, nodes);
    if (ui.ptSel >= 0) {
      const sel = body.querySelector('.sel');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderParty() {
    if (!ui.ptOpen) return;
    const pane = ptMountPane();
    if (!pane) return;
    ptRenderHead(pane);
    ptRenderFilters(pane);
    ptRenderBody(pane);
  }

  /* The switch into the sheet, living in the roster's search row where the eye
     already is. Built here rather than in index.html so the party sheet needs
     no skeleton edit — and so a build whose CSS never loaded still shows a
     labelled button rather than a mystery box. */
  function ptMountToggle() {
    if ($('pt-toggle')) return;
    const wrap = $('fd-search-wrap');
    if (!wrap) return;
    wrap.append(h('button', {
      id: 'pt-toggle', type: 'button', 'aria-pressed': 'false',
      title: 'Party sheet — everyone’s gear, health and status side by side, '
           + 'so you can see who is hurt, who has no weapon and who is carrying too much.',
      onClick: function (e) { e.stopPropagation(); setPartyOpen(!ui.ptOpen); },
    }, h('span', { class: 'pt-toggle-ic', 'aria-hidden': 'true' }, '⚔'),
       h('span', { class: 'pt-toggle-lbl' }, 'Party sheet')));
  }

  /* ================================================================ WHO'S HERE ==
   * Rober, 2026-09-17: "a button that scans the cell looking for any npcs that
   * are in my follower organizer and are in this cell? Im going around right
   * now trying to see why npcs in my system arnt showing profile pics in
   * certain areas". One press asks the DLL (fdCellScan -> fdCellScanData) for
   * every loaded actor near you who is on the FO roster, with the FACTS a
   * missing picture turns on. The medallion on each card is drawn by medalEl —
   * the roster's own painter — so what it shows here IS what the roster shows,
   * and the chips beside it say why. A sibling of the party sheet: same slot
   * before #fd-list, same chrome, one wide view open at a time. nh- = here. */
  function nhMountToggle() {
    if ($('nh-toggle')) return;
    const wrap = $('fd-search-wrap');
    if (!wrap) return;
    wrap.append(h('button', {
      id: 'nh-toggle', type: 'button', 'aria-pressed': 'false',
      title: 'Who’s here — two lists of this cell (outdoors: the loaded area around you): '
           + 'your Follower Organizer people, with why each does or does not have a picture '
           + '(portrait file, face render, roster id, following status) — or EVERY NPC here, '
           + 'strangers included, ready to be filed onto the roster.',
      onClick: function (e) { e.stopPropagation(); setHereOpen(!ui.nhOpen); },
    }, h('span', { class: 'nh-toggle-ic', 'aria-hidden': 'true' }, '◎'),
       h('span', { class: 'nh-toggle-lbl' }, 'Who’s here')));
  }

  function syncHereChrome() {
    document.body.classList.toggle('hd-cellscan', !!ui.nhOpen);
    const t = $('nh-toggle');
    if (t) { t.classList.toggle('on', !!ui.nhOpen); t.setAttribute('aria-pressed', ui.nhOpen ? 'true' : 'false'); }
  }

  function setHereOpen(on, opts) {
    const want = !!on;
    if (ui.nhOpen === want) return;
    ui.nhOpen = want;
    ui.nhSel = -1;
    syncHereChrome();
    if (want) {
      if (ui.npcFocus) exitFocus();
      if (ui.ptOpen) setPartyOpen(false, { noFocus: true });
      if (ui.rrOpen) setRecallOpen(false, { noFocus: true });
      nhAsk();
      renderHere();
      if (!(opts && opts.noFocus))
        setTimeout(function () { const s = $('nh-search'); if (s) s.focus(); }, 30);
    } else {
      renderHere();
      if (!(opts && opts.noFocus))
        setTimeout(function () { const s = $('fd-search'); if (s) s.focus(); }, 30);
    }
  }

  function nhAsk() {
    state.here.asking = true;
    /* render:true — a scan that finds a missing face also starts baking it.
       all:true asks the other question (every actor here, roster or not); the
       reply says which it answered, so a rescan mid-switch cannot mislabel. */
    toGame('fdCellScan', JSON.stringify({ render: true, all: ui.nhMode === 'all' }));
  }

  /* Switching the mode is a new question, so it is a new scan — the rows on
     screen answered the OTHER one and must not linger under the new heading. */
  function nhSetMode(mode) {
    const want = mode === 'all' ? 'all' : 'roster';
    if (ui.nhMode === want) return;
    ui.nhMode = want;
    ui.nhSel = -1;
    state.here.rows = [];
    nhAsk();
    renderHere();
  }

  window.fdCellScanData = function (env) {
    const v = coerce(env);
    state.here.asking = false;
    state.here.at = Date.now();
    if (!v || typeof v !== 'object') {
      state.here.ok = false; state.here.msg = 'The cell scan came back unreadable.'; state.here.rows = [];
    } else {
      state.here.ok = v.ok !== false;
      state.here.msg = v.msg || '';
      state.here.rows = Array.isArray(v.rows) ? v.rows : [];
      state.here.cell = v.cell || null;
      state.here.rosterTotal = v.rosterTotal | 0;
      state.here.seen = v.seen | 0;
      state.here.shown = (v.shown | 0) || state.here.rows.length;
      state.here.queued = v.queued | 0;
      state.here.mrf = v.mrf !== false;
      state.here.nearMeters = v.nearMeters | 0;
      state.here.all = v.all === true;
      /* A stranger's head render is never asked for by requestFaceIcons' roster
         sweep, so the path C++ just resolved for her is folded into the same
         cache medalEl reads. Without this, everyone-mode draws initials for
         faces that are already on disk. */
      state.here.rows.forEach(function (r) {
        const k = String(r.formId || '').toLowerCase();
        if (k && r.face && state.faceIcons[k] !== r.face) state.faceIcons[k] = r.face;
      });
    }
    if (isActive()) renderHere();
    /* Anything the DLL just queued lands through the roster's own face poll:
       re-arm it so the cards here (and the roster) swap initials for heads
       without waiting for the next tab open. */
    if (state.here.queued > 0 && typeof requestFaceIcons === 'function') requestFaceIcons(true);
  };

  function nhMountPane() {
    let pane = $('nh-pane');
    if (pane) return pane;
    const main = $('fd-main');
    if (!main) return null;
    pane = h('section', { id: 'nh-pane', 'aria-label': 'Who’s here' },
      h('div', { class: 'nh-head' }),
      h('div', { class: 'nh-body' }));
    const before = $('fd-list');
    if (before && before.parentNode === main) main.insertBefore(pane, before);
    else main.append(pane);
    return pane;
  }

  /* The facts, as chips. Tone is a JUDGEMENT and lives here on purpose (the
     DLL ships facts only — same split as the party sheet). */
  function nhChips(r) {
    const out = [];
    /* A stranger with no picture is NORMAL — she was never meant to have one.
       Saying "no portrait file" in bad tone for half a marketplace would train
       the eye to ignore the chips that do matter. Declared first: several
       chips below soften (or vanish) for someone you have never filed. */
    const stranger = r.roster === false;
    if (r.roster === false) {
      out.push({ tone: 'note', glyph: '＋', label: 'Not on the roster',
        why: 'Nobody in Follower Organizer matches her by id or by name. Click the card to file '
           + 'her into a category — everything else on this row (portrait, face render) already '
           + 'works the moment she is on it.' });
    } else if (r.match === 'name')
      out.push({ tone: 'warn', glyph: '≈', label: 'Matched by name only',
        why: 'The roster row’s id (' + (r.rosterFormId || '?') + ') does not resolve to her — a stale id. '
           + 'Everything keyed on the id (portrait lookups by id, orders) misses her until the roster is repaired.' });
    else
      out.push({ tone: 'ok', glyph: '#', label: 'Roster id matches', why: 'Follower Organizer’s runtime id resolves to this actor.' });

    if (r.teammate) out.push({ tone: 'ok', glyph: '⚑', label: 'Teammate', why: 'The engine’s follower flag is set — the HUD strip shows her.' + (stranger ? ' She is FOLLOWING YOU and is on no roster — file her.' : '') });
    else if (r.faction) out.push({ tone: 'ok', glyph: '⚑', label: 'Follower faction', why: 'In CurrentFollowerFaction without the teammate flag — the HUD strip still shows her.' + (stranger ? ' She is following you and is on no roster — file her.' : '') });
    /* "Not following" on a roster person is news; on a stranger in a market of
       forty it is forty chips of noise. Only the FOLLOWING case is worth a chip
       for someone you have never filed — and that case is worth a lot. */
    else if (!stranger) out.push({ tone: 'note', glyph: '·', label: 'Not following', why: 'Neither the teammate flag nor the follower faction: the HUD strip only draws people who are following you. The roster and this list still show her.' });

    if (r.portrait && r.portrait.file)
      out.push({ tone: 'ok', glyph: '▣', label: 'Portrait: ' + r.portrait.file,
        why: 'Found under the name “' + (r.portrait.via || '') + '”.' });
    else if (stranger)
      out.push({ tone: 'note', glyph: '▢', label: 'No portrait',
        why: 'No captured photo under: ' + ((r.tried || []).join(', ') || 'no usable name')
           + '. Expected for someone you have never filed — look at her and fire Capture Portrait '
           + 'if you want one.' });
    else
      out.push({ tone: 'warn', glyph: '▢', label: 'No portrait file',
        why: 'Looked for a captured portrait under: ' + ((r.tried || []).join(', ') || 'no usable name')
           + '. Look at her and fire Capture Portrait to make one.' });

    const fs = String(r.faceState || '');
    if (fs === 'ready') out.push({ tone: 'ok', glyph: '☺', label: 'Face render on disk', why: 'The facegen head PNG exists; the roster draws it when there is no portrait.' });
    else if (fs === 'unrendered') out.push({ tone: 'note', glyph: '⟳', label: 'Face render queued', why: 'Her facegen head exists but has not been rendered yet — this scan queued it. Give it a few seconds and rescan.' });
    else if (fs === 'body-unrendered') out.push({ tone: 'note', glyph: '⟳', label: 'Body render queued', why: 'No facegen head (a creature) — a body silhouette was queued instead.' });
    else if (fs === 'mrf-missing') out.push({ tone: 'bad', glyph: '✕', label: 'No renderer', why: 'Mesh Rendering Framework is not loaded, so no face can be rendered this session.' });
    else out.push({ tone: stranger ? 'note' : 'bad', glyph: '✕', label: 'No facegen head shipped', why: 'No facegeom NIF for her in the load order (templated NPC, or the mod never exported heads). Only a captured portrait can give her a picture.' });

    if (r.dead) out.push({ tone: 'bad', glyph: '†', label: 'Dead', why: 'The actor is dead.' });
    if (r.disabled) out.push({ tone: 'bad', glyph: '⊘', label: 'Disabled', why: 'The reference is disabled — present in the cell, not in the world.' });
    if (r.waiting) out.push({ tone: 'note', glyph: '⌛', label: 'Waiting', why: 'Told to wait here.' });
    return out;
  }

  function nhRows() {
    const q = String(ui.nhFilter || '').trim().toLowerCase();
    const rows = state.here.rows || [];
    if (!q) return rows;
    return rows.filter(function (r) {
      const hay = [r.name, r.base, r.original, r.cat, r.match, r.faceState,
        r.portrait && r.portrait.file, r.durable].concat(nhChips(r).map(function (c) { return c.label; }))
        .join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function nhCountLine() {
    const hr = state.here;
    if (hr.asking && !hr.rows.length) return 'Scanning…';
    if (!hr.ok) return hr.msg || 'Nothing read yet.';
    const withPic = hr.rows.filter(function (r) { return (r.portrait && r.portrait.file) || r.faceState === 'ready'; }).length;
    const where = hr.cell && hr.cell.name ? hr.cell.name : 'this cell';
    const bits = [];
    if (hr.all) {
      const onRoster = hr.rows.filter(function (r) { return r.roster !== false; }).length;
      /* seen > rows means the cap trimmed the far end — say so, because a list
         that silently stops at 96 in a market reads as a bug. */
      bits.push(hr.rows.length < hr.seen
        ? ('the ' + hr.rows.length + ' nearest of ' + hr.seen + ' NPCs here in ' + where)
        : (hr.rows.length + ' NPC' + (hr.rows.length === 1 ? '' : 's') + ' here in ' + where));
      bits.push(onRoster + ' on the roster');
    } else {
      bits.push(hr.rows.length + ' of ' + hr.rosterTotal + ' roster people here in ' + where);
      bits.push(hr.seen + ' actor' + (hr.seen === 1 ? '' : 's') + ' scanned');
    }
    bits.push(withPic + ' with a picture');
    if (hr.queued) bits.push(hr.queued + ' render' + (hr.queued === 1 ? '' : 's') + ' queued');
    return bits.join(' · ');
  }

  function nhOpenRow(r) {
    /* Same drill-in as the party sheet: her card, exactly as F7-on-her gives it.
       A STRANGER has no card to open — ptOpenMember would only toast "not on
       the roster yet", which is a dead end on a list whose whole point is that
       she is not on it. So she gets the ADD menu instead: the same category
       picker the ＋ button opens, addressed at her. */
    if (r.roster === false) {
      openAddMenu({ formId: Number(r.formId) >>> 0,
                    name: r.name || r.base || '?',
                    original: r.base || r.name || '' });
      return true;
    }
    return ptOpenMember({ formId: Number(r.formId) >>> 0, name: r.name, base: r.base || r.original });
  }

  function renderHere() {
    if (!ui.nhOpen) return;
    const pane = nhMountPane();
    if (!pane) return;
    const head = pane.querySelector('.nh-head');
    head.textContent = '';
    head.append(h('button', {
      class: 'nh-back', type: 'button', title: 'Back to the follower roster',
      onClick: function (e) { e.stopPropagation(); setHereOpen(false); },
    }, h('span', { class: 'nh-back-chev', 'aria-hidden': 'true' }, '◂'), 'Roster'));
    head.append(h('div', { class: 'nh-title-wrap' },
      h('div', { class: 'nh-title' }, 'Who’s here'),
      h('div', { class: 'nh-count', title: (state.here.all
            ? 'Every actor loaded in this cell, roster or not'
            : 'Everyone on the Follower Organizer roster who is loaded in this cell')
          + (state.here.nearMeters ? ' (outdoors: within about ' + state.here.nearMeters + ' m of you)' : '')
          + '. Read the instant you pressed the button.' },
        nhCountLine())));

    /* The two questions, as one switch (Rober, 2026-09-20). Same segmented
       idiom as the party sheet's Cards/Table — it reads as "the same list,
       asked differently", which is exactly what it is. */
    const modes = h('div', { class: 'nh-modes', role: 'group', 'aria-label': 'Who to list' });
    [{ k: 'roster', ic: '◎', lbl: 'My people',
       t: 'Only Follower Organizer people who are here — and why each one does or does not have a picture.' },
     /* ≡ not ⁂: only glyphs PROVEN in-game (the party sheet's Table button
        already draws this one). An asterism is exactly the shape Ultralight
        renders as a speck. */
     { k: 'all', ic: '≡', lbl: 'Everyone here',
       t: 'Every NPC loaded around you, strangers included. A stranger’s card files her onto the roster.' }]
      .forEach(function (m) {
        modes.append(h('button', {
          class: 'nh-mode' + (ui.nhMode === m.k ? ' on' : ''), type: 'button',
          'aria-pressed': ui.nhMode === m.k ? 'true' : 'false', title: m.t,
          onClick: function (e) { e.stopPropagation(); nhSetMode(m.k); },
        }, h('span', { class: 'nh-mode-ic', 'aria-hidden': 'true' }, m.ic),
           h('span', { class: 'nh-mode-lbl' }, m.lbl)));
      });
    head.append(modes);

    const wrap = h('div', { class: 'nh-search-wrap' }, h('span', { class: 'nh-search-ic', 'aria-hidden': 'true' }, '⌕'));
    const input = h('input', {
      id: 'nh-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: state.here.all
        ? 'Search everyone here — a name, “not on the roster”, “following”, “dead”…'
        : 'Search names, categories — or “no portrait”, “name only”, “queued”…',
      title: 'Filters as you type. Enter opens the top match’s card.',
    });
    input.value = ui.nhFilter || '';
    input.addEventListener('input', function (e) { ui.nhFilter = e.target.value; ui.nhSel = -1; nhRenderBody(pane); });
    input.addEventListener('keydown', function (e) {
      const rows = nhRows();
      if (e.key === 'Enter') {
        const pick = rows[ui.nhSel >= 0 ? ui.nhSel : 0];
        if (pick) { e.preventDefault(); e.stopPropagation(); nhOpenRow(pick); }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation(); ui.nhSel = Math.min(rows.length - 1, ui.nhSel + 1); nhRenderBody(pane);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation(); ui.nhSel = Math.max(0, ui.nhSel < 0 ? 0 : ui.nhSel - 1); nhRenderBody(pane);
      } else if (e.key === 'Escape' && ui.nhFilter) {
        e.preventDefault(); e.stopPropagation(); ui.nhFilter = ''; ui.nhSel = -1; input.value = ''; nhRenderBody(pane);
      }
    });
    wrap.append(input);
    head.append(wrap);
    head.append(h('button', {
      class: 'nh-refresh' + (state.here.asking ? ' busy' : ''), type: 'button',
      title: 'Scan this cell again (also queues any face render still missing).',
      onClick: function (e) { e.stopPropagation(); nhAsk(); renderHere(); },
    }, h('span', { 'aria-hidden': 'true' }, '↻'), ' Rescan'));

    nhRenderBody(pane);
  }

  function nhRenderBody(pane) {
    const body = pane.querySelector('.nh-body');
    body.textContent = '';
    const hr = state.here;
    const rows = nhRows();
    if (!rows.length) {
      const title = hr.asking ? 'Scanning the cell…'
        : (!hr.ok ? (hr.msg || 'Nothing read yet.')
        : (hr.rows.length ? 'Nobody matches that search.'
        : (hr.all ? 'Nobody is loaded around you.' : 'Nobody from the roster is in this cell.')));
      const reach = (hr.cell && !hr.cell.interior && hr.nearMeters)
        ? ' Outdoors this covers about ' + hr.nearMeters + ' m around you.' : '';
      const sub = hr.asking ? '' : (hr.rows.length ? 'Clear the search to see all ' + hr.rows.length + '.'
        : (hr.all
           ? ('Not one actor is loaded here — an empty room, or the cell has not finished loading.' + reach)
           : (hr.seen + ' actor' + (hr.seen === 1 ? '' : 's') + ' scanned against ' + hr.rosterTotal
              + ' roster people. Switch to “Everyone here” to see who IS around you.' + reach)));
      body.append(h('div', { class: 'nh-empty' }, h('div', { class: 'nh-empty-title' }, title), h('div', { class: 'nh-empty-sub' }, sub)));
      return;
    }
    rows.forEach(function (r, i) {
      const hit = ptRosterFor({ formId: Number(r.formId) >>> 0, name: r.name, base: r.base || r.original });
      /* ⚠ formId stays the HEX STRING C++ sent ("0x1a2b3c"), NOT Number(...) —
         medalEl → portraitFor looks a face render up as `String(m.formId)`,
         and a number stringifies to DECIMAL, which matches no key in
         state.faceIcons. Ever. That is why a roster person with a rendered
         head but no captured photo drew initials in this list while the same
         head showed fine on the roster (found by whos-here.checks.js,
         2026-09-20). ptRosterFor above still wants the number. */
      const m = { name: r.name || '', original: r.original || r.base || r.name || '',
                  formId: String(r.formId || '').toLowerCase(),
                  following: !!(r.teammate || r.faction) && !r.dead, dead: !!r.dead };
      const card = h('div', {
        class: 'nh-card' + (i === ui.nhSel ? ' sel' : '') + (r.dead || r.disabled ? ' dim' : ''),
        role: 'button', tabindex: '0',
        title: r.roster === false ? 'File her onto the Follower Organizer roster' : 'Open her card',
        onClick: function (e) { e.stopPropagation(); nhOpenRow(r); },
        onKeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nhOpenRow(r); } },
      });
      card.append(h('div', { class: 'nh-face' }, medalEl(m, hit ? hit.cat : Math.max(0, r.catIndex | 0))));
      const where = (r.sameCell ? 'Same cell' : 'Nearby') + ' · ' + (r.dist | 0) + ' m';
      const ident = r.durable ? ' · ' + r.durable : '';
      const filed = r.roster === false ? 'Not on the roster' : (r.cat || 'Uncategorised');
      const text = h('div', { class: 'nh-text' },
        h('div', { class: 'nh-name' }, r.name || r.original || '?'),
        h('div', { class: 'nh-sub' }, filed + ' · ' + where + ident
          + (r.base && r.base !== r.name ? ' · née ' + r.base : '')));
      const chips = h('div', { class: 'nh-chips' });
      nhChips(r).forEach(function (c) {
        chips.append(h('span', { class: 'nh-chip ' + c.tone, title: c.label + ' — ' + c.why },
          h('span', { class: 'nh-chip-ic', 'aria-hidden': 'true' }, c.glyph),
          h('span', { class: 'nh-chip-lbl' }, c.label)));
      });
      text.append(chips);
      card.append(text);
      body.append(card);
    });
  }

  /* ============================================================ RECALL ROSTER ==
   * Rober, 2026-09-26, after F17 summoned Vilja, Windy and Katana (never met):
   * "with a UI ability to see a page of current follows and register or
   * deregister". One press asks the DLL (prRoster -> prRosterData) for the
   * SAME survey the transferred summon key runs — every actor it would bring,
   * every flagged-but-unrecruited one it leaves alone, and the register — so
   * what this page shows IS what the key does. Register = "always answer",
   * for the custom follower whose following the engine cannot read; Never =
   * a veto. Both are stored as (local id + plugin) in party-recall.json by the
   * DLL, never by the view. A sibling of the party sheet and Who's here:
   * same slot before #fd-list, same chrome, one wide view open at a time.
   * rr- = recall roster (rc- is taken by the deck's scale rules). */
  function rrMountToggle() {
    if ($('rr-toggle')) return;
    const wrap = $('fd-search-wrap');
    if (!wrap) return;
    wrap.append(h('button', {
      id: 'rr-toggle', type: 'button', 'aria-pressed': 'false',
      title: 'Recall roster — who the follower recall (F17, when SkyManager holds NFF’s summon key) '
           + 'would bring to you right now, with the evidence for each; who it leaves alone and why; '
           + 'and a register to force anyone in (Register) or out (Never).',
      onClick: function (e) { e.stopPropagation(); setRecallOpen(!ui.rrOpen); },
    }, h('span', { class: 'rr-toggle-ic', 'aria-hidden': 'true' },
         h('img', { src: 'icons/custom/hk-party-summon.png', alt: '', width: '22', height: '22', draggable: 'false',
                    onError: function (e) { e.target.style.visibility = 'hidden'; } })),
       h('span', { class: 'rr-toggle-lbl' }, 'Recall roster')));
  }

  function syncRecallChrome() {
    document.body.classList.toggle('hd-recall', !!ui.rrOpen);
    const t = $('rr-toggle');
    if (t) { t.classList.toggle('on', !!ui.rrOpen); t.setAttribute('aria-pressed', ui.rrOpen ? 'true' : 'false'); }
  }

  function setRecallOpen(on, opts) {
    const want = !!on;
    if (ui.rrOpen === want) return;
    ui.rrOpen = want;
    ui.rrSel = -1;
    syncRecallChrome();
    if (want) {
      if (ui.npcFocus) exitFocus();
      if (ui.ptOpen) setPartyOpen(false, { noFocus: true });
      if (ui.nhOpen) setHereOpen(false, { noFocus: true });
      rrAsk();
      renderRecall();
      if (!(opts && opts.noFocus))
        setTimeout(function () { const s = $('rr-search'); if (s) s.focus(); }, 30);
    } else {
      renderRecall();
      if (!(opts && opts.noFocus))
        setTimeout(function () { const s = $('fd-search'); if (s) s.focus(); }, 30);
    }
  }

  function rrAsk() {
    state.recall.asking = true;
    toGame('prRoster', '{}');
  }

  /* Register / Never / Clear. The DLL resolves the durable pair and answers
     with the whole page again (prRosterData), so the row moves to its new
     group on the reply, never on hope. */
  function rrSet(r, mode) {
    if (!r) return;
    state.recall.asking = true;
    toGame('prSet', JSON.stringify({ formId: String(r.localId || r.formId || ''), plugin: r.plugin || '',
                                     name: r.name || '', mode: mode }));
    renderRecall();
  }

  window.prRosterData = function (env) {
    const v = coerce(env);
    const rr = state.recall;
    rr.asking = false;
    rr.at = Date.now();
    if (!v || typeof v !== 'object') {
      rr.ok = false; rr.msg = 'The recall roster came back unreadable.'; rr.rows = [];
    } else {
      rr.ok = v.ok !== false;
      rr.msg = v.msg || '';
      rr.rows = Array.isArray(v.rows) ? v.rows : [];
      rr.answer = v.answer | 0; rr.flagged = v.flagged | 0; rr.registered = v.registered | 0;
      rr.key = v.key && typeof v.key === 'object' ? v.key : null;
    }
    if (ui.rrOpen) renderRecall();
    if (typeof requestFaceIcons === 'function') requestFaceIcons(true);
  };

  function rrMountPane() {
    let pane = $('rr-pane');
    if (pane) return pane;
    const main = $('fd-main');
    if (!main) return null;
    pane = h('section', { id: 'rr-pane', 'aria-label': 'Recall roster' },
      h('div', { class: 'rr-head' }),
      h('div', { class: 'rr-body' }));
    const before = $('fd-list');
    if (before && before.parentNode === main) main.insertBefore(pane, before);
    else main.append(pane);
    return pane;
  }

  /* Which group a row lands in. "answer" = the key would act on her (recall,
     or leave her waiting/busy — still hers); "flagged" = one loose flag, left
     alone; "register" = a veto, or a registered person the world cannot find. */
  function rrGroupOf(r) {
    if (r.missing) return 'register';
    if (r.basis) return 'answer';
    if (r.flaggedOnly) return 'flagged';
    return 'register';
  }

  /* The evidence, as chips. Tone is a JUDGEMENT and lives here (the DLL ships
     facts only — same split as Who's here). */
  function rrChips(r) {
    const out = [];
    if (r.missing) {
      out.push({ tone: 'bad', glyph: '?', label: 'Not in the world right now',
        why: 'Registered as ' + (r.registered || '?') + ' but no actor with that identity is loaded or known this session. '
           + 'Her plugin may be off, or she has not been spawned yet. Clear to forget her.' });
      return out;
    }
    const basis = {
      registered: ['ok', '★', 'Registered: always', 'You registered her. She answers the recall whatever the engine says about her.'],
      framework:  ['ok', '⚑', 'Her mod says following', 'A verified follower-framework adapter reports her as recruited.'],
      engine:     ['ok', '⚑', 'Teammate + follower faction', 'Both halves of the vanilla recruit contract are set — vanilla and NFF set and clear them together.'],
      alias:      ['ok', '≡', 'On NFF’s follower list', 'She fills a follower alias on the DialogueFollower quest, which NFF clears on dismiss.'],
      package:    ['ok', '➜', 'Running her follow package', 'She is a teammate and the package her AI is running right now is follow / escort / accompany — a custom follower system doing its job.'],
    }[r.basis];
    if (basis) out.push({ tone: basis[0], glyph: basis[1], label: basis[2], why: basis[3] });
    if (r.registered === 'never')
      out.push({ tone: 'bad', glyph: '⊘', label: 'Never recalled', why: 'You registered her as Never. The recall skips her whatever the engine says.' });
    if (r.flaggedOnly && r.teammate)
      out.push({ tone: 'warn', glyph: '⚑', label: 'Teammate flag only',
        why: 'Her plugin set the engine’s teammate flag but nothing else says she is following (no follower faction rank, no NFF alias, no follow package running). '
           + 'Vilja’s plugin does this at startup; pet mods do it to a parked pet. Left alone — Register her if she really is yours.' });
    else if (r.flaggedOnly)
      out.push({ tone: 'warn', glyph: '⚑', label: 'Follower faction only',
        why: 'She holds a Current Follower faction rank without the teammate flag — Katana’s ESP lists it statically. Left alone — Register her if she really is yours.' });
    if (r.decision === 'waiting') out.push({ tone: 'note', glyph: '⌛', label: 'Waiting — stays put', why: 'Told to wait here (WaitingForPlayer, or Serana’s own waiting state). The recall leaves her where she is.' });
    if (r.decision === 'busy') out.push({ tone: 'note', glyph: '⌛', label: 'Busy — stays put', why: 'Mounted, in a scene, or holding a pose. The recall leaves her where she is.' });
    if (r.dead) out.push({ tone: 'bad', glyph: '†', label: 'Dead', why: 'The actor is dead.' });
    if (r.disabled) out.push({ tone: 'bad', glyph: '⊘', label: 'Disabled', why: 'The reference is disabled — present in the cell, not in the world.' });
    return out;
  }

  function rrRows() {
    const q = String(ui.rrFilter || '').trim().toLowerCase();
    const rows = state.recall.rows || [];
    const order = { answer: 0, flagged: 1, register: 2 };
    const sorted = rows.slice().sort(function (a, b) {
      const d = order[rrGroupOf(a)] - order[rrGroupOf(b)];
      return d || String(a.name || '').localeCompare(String(b.name || ''));
    });
    if (!q) return sorted;
    return sorted.filter(function (r) {
      const hay = [r.name, r.base, r.cell, r.durable, r.basis, r.decision, r.registered, rrGroupOf(r)]
        .concat(rrChips(r).map(function (c) { return c.label; })).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function rrCountLine() {
    const rr = state.recall;
    if (rr.asking && !rr.rows.length) return 'Reading…';
    if (!rr.ok) return rr.msg || 'Nothing read yet.';
    return rr.answer + ' answer' + (rr.answer === 1 ? 's' : '') + ' the recall · '
         + rr.flagged + ' flagged, left alone · ' + rr.registered + ' registered';
  }

  function rrKeyLine() {
    const k = state.recall.key;
    if (!k) return '';
    if (k.owned) return 'F17 is SkyManager’s: this list is who it brings.';
    if (k.enabled) return 'SkyManager’s transferred key is off right now (NFF holds a different binding). Recall now still works from here.';
    return 'NFF still owns its summon key — “Party: Take Over NFF Summon Key” makes F17 use this list. Recall now works from here either way.';
  }

  /* Card click: her F7 card when she is on the roster, the add menu when she
     is a stranger — the same drill-in Who's here uses. */
  function rrOpenRow(r) {
    if (!r || r.missing) return false;
    const hit = ptRosterFor({ formId: Number(r.formId) >>> 0, name: r.name, base: r.base });
    if (!hit) { openAddMenu({ formId: Number(r.formId) >>> 0, name: r.name || r.base || '?', original: r.base || r.name || '' }); return true; }
    return ptOpenMember({ formId: Number(r.formId) >>> 0, name: r.name, base: r.base });
  }

  function renderRecall() {
    if (!ui.rrOpen) return;
    const pane = rrMountPane();
    if (!pane) return;
    const head = pane.querySelector('.rr-head');
    head.textContent = '';
    head.append(h('button', {
      class: 'rr-back', type: 'button', title: 'Back to the follower roster',
      onClick: function (e) { e.stopPropagation(); setRecallOpen(false); },
    }, h('span', { class: 'rr-back-chev', 'aria-hidden': 'true' }, '◂'), 'Roster'));
    head.append(h('div', { class: 'rr-title-wrap' },
      h('div', { class: 'rr-title' }, 'Recall roster'),
      h('div', { class: 'rr-count', title: 'Read the instant you opened this page — the same survey the summon key runs.' }, rrCountLine()),
      h('div', { class: 'rr-key' }, rrKeyLine())));

    const wrap = h('div', { class: 'rr-search-wrap' }, h('span', { class: 'rr-search-ic', 'aria-hidden': 'true' }, '⌕'));
    const input = h('input', {
      id: 'rr-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search names, places — or “teammate”, “alias”, “never”, “waiting”…',
      title: 'Filters as you type. Enter registers the top match (or clears her registration); ↑↓ pick a row.',
    });
    input.value = ui.rrFilter || '';
    input.addEventListener('input', function (e) { ui.rrFilter = e.target.value; ui.rrSel = -1; rrRenderBody(pane); });
    input.addEventListener('keydown', function (e) {
      const rows = rrRows();
      if (e.key === 'Enter') {
        const pick = rows[ui.rrSel >= 0 ? ui.rrSel : 0];
        if (pick) { e.preventDefault(); e.stopPropagation(); rrSet(pick, pick.registered === 'always' ? 'clear' : 'always'); }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation(); ui.rrSel = Math.min(rows.length - 1, ui.rrSel + 1); rrRenderBody(pane);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation(); ui.rrSel = Math.max(0, ui.rrSel < 0 ? 0 : ui.rrSel - 1); rrRenderBody(pane);
      } else if (e.key === 'Escape' && ui.rrFilter) {
        e.preventDefault(); e.stopPropagation(); ui.rrFilter = ''; ui.rrSel = -1; input.value = ''; rrRenderBody(pane);
      }
    });
    wrap.append(input);
    head.append(wrap);
    head.append(h('button', {
      class: 'rr-refresh' + (state.recall.asking ? ' busy' : ''), type: 'button',
      title: 'Read the survey again.',
      onClick: function (e) { e.stopPropagation(); rrAsk(); renderRecall(); },
    }, h('span', { 'aria-hidden': 'true' }, '↻'), ' Refresh'));
    head.append(h('button', {
      class: 'rr-recall', type: 'button',
      title: 'Bring everyone in the “answers the recall” group to you now — the same recall the summon key fires. Closes the deck.',
      onClick: function (e) { e.stopPropagation(); toGame('prRecall', '{}'); },
    }, 'Recall now'));   // text only: a gold glyph on the gold button is invisible (preview shot, 2026-09-26)

    rrRenderBody(pane);
  }

  function rrActs(r) {
    const acts = h('div', { class: 'rr-acts' });
    const btn = function (lbl, mode, cls, title) {
      return h('button', { class: 'rr-act ' + cls, type: 'button', title: title,
        onClick: function (e) { e.stopPropagation(); rrSet(r, mode); },
        onKeydown: function (e) { e.stopPropagation(); } }, lbl);
    };
    const reg = r.registered || '';
    if (r.missing) { acts.append(btn('Clear', 'clear', 'clear', 'Forget this registration.')); return acts; }
    if (reg !== 'always') acts.append(btn('Register', 'always', 'always', 'Always answer the recall, whatever the engine reads about her.'));
    if (reg !== 'never') acts.append(btn('Never', 'never', 'never', 'Never answer the recall, whatever the engine reads about her.'));
    if (reg) acts.append(btn('Clear', 'clear', 'clear', 'Back to what the engine reads.'));
    return acts;
  }

  function rrRenderBody(pane) {
    const body = pane.querySelector('.rr-body');
    body.textContent = '';
    const rr = state.recall;
    const rows = rrRows();
    if (!rows.length) {
      const title = rr.asking ? 'Reading the survey…'
        : (!rr.ok ? (rr.msg || 'Nothing read yet.')
        : (rr.rows.length ? 'Nobody matches that search.' : 'Nobody would answer the recall right now.'));
      const sub = rr.asking ? '' : (rr.rows.length ? 'Clear the search to see all ' + rr.rows.length + '.'
        : 'No teammate, follower-faction, NFF alias or follow-package evidence on anyone, and nobody registered. '
          + 'Recruit someone, or open Who’s here and Register her from there.');
      body.append(h('div', { class: 'rr-empty' }, h('div', { class: 'rr-empty-title' }, title), h('div', { class: 'rr-empty-sub' }, sub)));
      return;
    }
    const heads = {
      answer:   ['Answers the recall', 'Everyone the summon key would act on — brought to you, or left waiting / busy where she is.'],
      flagged:  ['Flagged, left alone', 'One loose engine flag and nothing else. Never summoned unless you Register her.'],
      register: ['Register', 'Vetoes, and registered people the world cannot find right now.'],
    };
    let lastGroup = '';
    rows.forEach(function (r, i) {
      const g = rrGroupOf(r);
      if (g !== lastGroup) {
        lastGroup = g;
        body.append(h('div', { class: 'rr-group rr-group-' + g },
          h('div', { class: 'rr-group-title' }, heads[g][0]),
          h('div', { class: 'rr-group-sub' }, heads[g][1])));
      }
      const hit = r.missing ? null : ptRosterFor({ formId: Number(r.formId) >>> 0, name: r.name, base: r.base });
      /* formId stays the HEX STRING C++ sent — medalEl looks the face up by it
         (the Who's here lesson, 2026-09-20). */
      const m = { name: r.name || '', original: r.base || r.name || '',
                  formId: String(r.formId || '').toLowerCase(),
                  following: r.decision === 'recall', dead: !!r.dead };
      const card = h('div', {
        class: 'rr-card' + (i === ui.rrSel ? ' sel' : '') + (r.dead || r.disabled || r.missing ? ' dim' : ''),
        role: 'button', tabindex: '0',
        title: r.missing ? 'Not in the world right now' : (hit ? 'Open her card' : 'File her onto the Follower Organizer roster'),
        onClick: function (e) { e.stopPropagation(); rrOpenRow(r); },
        onKeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rrOpenRow(r); } },
      });
      card.append(h('div', { class: 'rr-face' }, r.missing ? initialsMedal(m, '40') : medalEl(m, hit ? hit.cat : 0)));
      const where = r.missing ? 'Nowhere loaded'
        : ((r.cell || 'Somewhere unloaded') + (typeof r.dist === 'number' ? ' · ' + r.dist + ' m' : ''));
      const ident = r.durable ? ' · ' + r.durable : '';
      const text = h('div', { class: 'rr-text' },
        h('div', { class: 'rr-name' }, r.name || r.base || '?'),
        h('div', { class: 'rr-sub' }, where + ident + (r.base && r.base !== r.name ? ' · née ' + r.base : '')));
      const chips = h('div', { class: 'rr-chips' });
      rrChips(r).forEach(function (c) {
        chips.append(h('span', { class: 'rr-chip ' + c.tone, title: c.label + ' — ' + c.why },
          h('span', { class: 'rr-chip-ic', 'aria-hidden': 'true' }, c.glyph),
          h('span', { class: 'rr-chip-lbl' }, c.label)));
      });
      text.append(chips);
      card.append(text);
      card.append(rrActs(r));
      body.append(card);
    });
  }

  window.FolPane = {
    clothesChanged: clothesChanged,
    /* The roster's crop popout, reusable by any tab (the Character sheet's
       portrait editor). Behaviour for the follower flow is untouched — this is
       purely an additional entry point into the same lightbox machinery. */
    openCropEditor: openCropEditor,
    init() {
      $('fd-search').addEventListener('input', (e) => {
        ui.filter = e.target.value; ui.sel = -1;
        /* Typing to find someone leaves the dedicated (roster-hidden) view and
           shows the results — otherwise the search would filter a hidden list. */
        if (ui.filter.trim()) ui.rosterOpen = true;
        applyFocusChrome();
        renderList();
      });
      /* Wrapped, NOT passed by reference: openAddMenu now takes an optional
         subject, and addEventListener would hand it the click EVENT as that
         argument — the menu would read event.name, find nothing and return,
         breaking this button silently. */
      $('fd-add-btn').addEventListener('click', () => openAddMenu());
      const shotBtn = $('fd-shot-btn');
      if (shotBtn) shotBtn.addEventListener('click', () => {
        /* formId 0 would also work (C++ falls back to the crosshair snapshot),
           but naming the subject explicitly means the capture cannot drift to
           whoever the crosshair happens to be on a second later. */
        openPortraitCapture({formId:state.target ? state.target.formId : 0,name:state.target && state.target.name});
      });
      $('fd-openkey-btn').addEventListener('click', () => { if (window.startFolCapture) window.startFolCapture(); });
      /* « / » collapse the category rail to an icon strip (Rober, 2026-08-05).
         Persisted via saveCfg, applied through the hd-railcol body class. */
      const railTgl = $('fd-rail-toggle');
      if (railTgl) railTgl.addEventListener('click', () => {
        state.railCollapsed = !state.railCollapsed;
        railTgl.textContent = state.railCollapsed ? '»' : '«';
        railTgl.title = state.railCollapsed ? 'Show categories' : 'Collapse categories';
        saveCfg();
        applyFocusChrome();
      });
      const avDec = $('fd-av-dec'), avInc = $('fd-av-inc'), avRst = $('fd-av-reset');
      if (avDec) avDec.addEventListener('click', () => nudgeAvatar(-AV_STEP));
      if (avInc) avInc.addEventListener('click', () => nudgeAvatar(+AV_STEP));
      if (avRst) avRst.addEventListener('click', () => nudgeAvatar(0));
      const uiDec = $('fd-ui-dec'), uiInc = $('fd-ui-inc'), uiRst = $('fd-ui-reset');
      if (uiDec) uiDec.addEventListener('click', () => nudgeUi(-UI_STEP));
      if (uiInc) uiInc.addEventListener('click', () => nudgeUi(+UI_STEP));
      if (uiRst) uiRst.addEventListener('click', () => nudgeUi(0));
      const icDec = $('fd-ic-dec'), icInc = $('fd-ic-inc'), icRst = $('fd-ic-reset');
      if (icDec) icDec.addEventListener('click', () => nudgeIcon(-IC_STEP));
      if (icInc) icInc.addEventListener('click', () => nudgeIcon(+IC_STEP));
      if (icRst) icRst.addEventListener('click', () => nudgeIcon(0));
      applyAvatarSize();   // paint the saved sizes before the first render
      applyUiScale();
      /* The party-sheet switch lives in the search row where the eye already
         is. Mounted from JS rather than index.html so the feature needs no
         skeleton edit — and so a build whose stylesheet never loaded still
         shows a labelled button instead of a mystery box. */
      ptMountToggle();
      syncPartyChrome();
      nhMountToggle();
      syncHereChrome();
      rrMountToggle();
      syncRecallChrome();
      $('fd-list').addEventListener('scroll', closeCtx, true);
      chainIcons();
      /* Edit-mode icon slots, DELEGATED: the rail is re-rendered on every
         category change, filter and roster push, so per-element listeners
         would be re-bound dozens of times a session for no gain. The slot only
         carries data-caticon in edit mode, so a view-mode click falls through
         to the row and still selects the category. */
      const rail = $('fd-rail-list');
      if (rail) rail.addEventListener('click', (e) => {
        const slot = e.target && e.target.closest ? e.target.closest('[data-caticon]') : null;
        if (!slot) return;
        e.preventDefault(); e.stopPropagation();
        const c = catForIcon(slot.dataset.caticon);
        if (c) openCatIconPicker(slot, c);
      });
      /* The rail scrolls independently of the list; a menu anchored to a row
         that has scrolled away is a menu pointing at nothing. */
      if (rail && rail.parentNode) rail.parentNode.addEventListener('scroll', closeCtx, true);
    },

    /* F7 NPC-focus mode, driven from app.js: maybeAutoFocus(fresh) on the
       Followers show (fresh = tail of a new open), exitFocus() to leave. */
    maybeAutoFocus: maybeAutoFocus,
    enterFocus: enterFocus,
    exitFocus: exitFocus,
    /* Address the quick card at a NAMED person rather than the crosshair —
       literally the F7-on-her behaviour, reached without looking at her.
       Shared with the Wheel Menu (hd-wheel.js), whose party wedges are exactly
       "what would happen if you hit F7 on a party member" (Rober, 2026-08-11).
       Same call the crew strip's faces make, so there is one implementation;
       `original` is the durable roster identity, never the display name. */
    quickPick: function (original, label) {
      if (!original) return false;
      const hit = rosterEntryFor(original);
      const m = hit ? hit.m : liveMemberFor(original);   // live companions too
      if (!m) return false;
      pickCrew(m);
      return true;
    },
    /* Called from hdClosed: the deck closing must not carry NPC-focus into the
       next open. hdClosed strips the body class; this clears the FLAG behind it
       so a re-open with no crosshair target can't re-paint an empty focus. */
    _resetFocus() {
      rankEdit = { key:null, has:false, rank:0, pending:false };
      if (rankVerify) { clearTimeout(rankVerify); rankVerify=0; }
      if (window.NpcScene) NpcScene.reset();
      ui.npcFocus = false; ui.focusRosterOpen = false; ui.focusDismissed = false;
      ui.fqPickPinned = false;
      /* The palette is closing: the card's ⌕ popout is an #overlay child and
         would otherwise still be sitting there on the next open. */
      fqFindClose();
    },

    onShow() {
      ui.sel = -1;
      /* Fresh entry to the Followers tab starts DEDICATED to the crosshair NPC
         (roster hidden) — you open a category yourself to browse. */
      ui.rosterOpen = false;
      // Re-query every show: the roster can change through FO's native flows,
      // and the crosshair add-target is per-open (snapshotted by C++).
      toGame('fdRefresh');
      /* Which Loadouts group each follower belongs to. Asked once per show and
         joined by ORIGINAL name: a runtime FormID is not what either side files
         people under, and `original` is exactly FO's own key. Read-only — this
         page can show a group, never change one. */
      toGame('loGroups');
      /* The party sheet survives a tab switch, so coming back must re-read it:
         the numbers are a SNAPSHOT, and a snapshot taken before you went and
         gave an order is exactly the stale reading this page exists to avoid.
         (Its own 1.2 s gate folds this into one ask when the show and the open
         coincide.) */
      ptMountToggle();
      syncPartyChrome();
      nhMountToggle();
      syncHereChrome();
      rrMountToggle();
      syncRecallChrome();
      if (ui.ptOpen) ptAsk(false);
      if (ui.rrOpen) rrAsk();   // a recall list is a live reading; re-ask on every show
      render();
      setTimeout(() => {
        if (ctxEl && ctxEl._dossier) return; // Don't steal focus behind a search-opened character page.
        const s = $(ui.ptOpen ? 'pt-search' : 'fd-search');
        if (s) s.focus();
      }, 30);
    },

    onHide() {
      closePortraitCapture();
      closeLightbox();   // an overlay that survives its tab is an unclickable deck
      closeHudModal();   // the HUD settings modal must not outlive its tab
      closeWornLightbox();
      closeCtx();
      /* Same law: the card's action search is an #overlay child, so leaving
         the tab without closing it would leave a popout floating over whatever
         comes next, eating clicks. */
      fqFindClose();
      ui.editing = false;
      ui.filter = '';
      const s = $('fd-search'); if (s) s.value = '';
      /* Focus mode hides the GLOBAL tab bar via a body class — leaving the tab
         (any route: the Hotkeys chevron, a manual switch) must take that class
         with it, or the next pane opens with no tabs. Not "dismissed": that is
         a within-focus statement; leaving the tab is a clean reset. */
      ui.npcFocus = false;
      ui.focusRosterOpen = false;
      /* The party sheet's own transient state. ptOpen is KEPT — which shape of
         the tab you were last reading is a within-session preference, and
         re-entering the tab to find the roster you did not ask for is the
         annoyance this avoids. The filter is not: a search is about a moment. */
      ui.ptFilter = '';
      ui.ptSel = -1;
      const ps = $('pt-search'); if (ps) ps.value = '';
      if (typeof document !== 'undefined' && document.body)
        document.body.classList.remove('hd-npcfocus', 'hd-focusroster');
    },

    /* App-level route, including Tab: never cycle the deck behind the dossier. */
    dossierKey(e) {
      if (FQF.open) { fqFindKey(e); return true; }
      if (!ctxEl || !ctxEl._dossier) return false;
      ctxEl._dossier.key(e);
      return true;
    },

    /* keydown while our tab is active; true = consumed */
    onKey(e) {
      // The lightbox is the topmost thing on screen, so it eats Escape first —
      // ahead of the context menu, the search box and the deck's own close.
      if (lightbox) {
        /* Editing the crop: the same keys mean something else. Arrows pan and
           +/- zoom (so the whole editor is reachable without a pointer at all),
           Enter commits and Escape backs out to the plain lightbox rather than
           closing it — one Escape undoes the edit, a second closes the photo,
           which is the order you actually want when you've mis-dragged. */
        if (lbEdit) {
          const c = lbEdit.ctx;
          const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (pan) {
            e.preventDefault();
            nudgeCrop(c.img, c.foot, 0, pan[0] * CROP_PAN_STEP, pan[1] * CROP_PAN_STEP);
            return true;
          }
          if (e.key === '+' || e.key === '=') {
            e.preventDefault(); nudgeCrop(c.img, c.foot, CROP_ZSTEP, 0, 0); return true;
          }
          if (e.key === '-' || e.key === '_') {
            e.preventDefault(); nudgeCrop(c.img, c.foot, 1 / CROP_ZSTEP, 0, 0); return true;
          }
          if (e.key === 'Enter') {
            e.preventDefault(); commitCrop(c.d, c.file, c.img, c.frame, c.foot); return true;
          }
          if (e.key === 'Escape') {
            e.preventDefault(); cancelCrop(c.d, c.file, c.img, c.frame, c.foot); return true;
          }
          return true;
        }
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          closeLightbox();
          return true;
        }
        return true;   // swallow the rest rather than acting behind an overlay
      }
      /* The card's ⌕ action search, when it is up. ABOVE the inText branch on
         purpose: that branch blurs a focused input on Escape, which here would
         leave the popout on screen with nothing driving it. app.js's key
         router is capture-phase, so this runs BEFORE the input's own listener
         and is the handling that actually happens in game. */
      if (FQF.open && fqFindKey(e)) return true;

      const t = e.target;
      const inText = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT');
      if (ctxEl) {
        if (ctxEl._dossier && ctxEl._dossier.key(e)) return true;
        if (e.key === 'Escape') { e.preventDefault(); closeCtx(); return true; }
        return true;  // typing lives inside the menu's inputs
      }
      /* The party sheet is a MODE, and Escape leaves a mode before it leaves
         the deck — the same order the crop editor and the context menu already
         keep. Its own search box handles Escape-with-text itself (clearing
         beats leaving); this is the empty-box and the nothing-focused case, and
         it sits ABOVE the `inText` branch below so it wins over that branch's
         blur. */
      if (ui.ptOpen && e.key === 'Escape' && !ui.ptFilter) {
        e.preventDefault(); setPartyOpen(false); return true;
      }
      if (ui.rrOpen && e.key === 'Escape' && !ui.rrFilter) {
        e.preventDefault(); setRecallOpen(false); return true;
      }
      if (inText && t.id !== 'fd-search') {
        if (e.key === 'Escape') { e.preventDefault(); t.blur(); return true; }
        return true;
      }
      if (e.key === 'Escape') {
        if (ui.filter) { e.preventDefault(); ui.filter = ''; $('fd-search').value = ''; ui.sel = -1; renderList(); return true; }
        return false;  // let the deck shell close the palette
      }
      const vis = visibleRows();
      if (e.key === 'ArrowDown') { e.preventDefault(); ui.sel = Math.min(vis.length - 1, ui.sel + 1); renderList(); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); ui.sel = Math.max(0, (ui.sel < 0 ? 0 : ui.sel - 1)); renderList(); return true; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const pick = ui.sel >= 0 ? vis[ui.sel] : vis[0];
        if (pick) {
          const rowEl = $('fd-list').querySelector('.fd-member[data-k="' + cssEsc(pick.cat + ':' + pick.idx) + '"]');
          const r = rowEl ? rowEl.getBoundingClientRect() : { left: 200, top: 160 };
          openMemberMenu(pick);
        }
        return true;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        closeCtx();
        ui.editing = !ui.editing;
        render();
        return true;
      }
      // funnel plain typing into our search box
      if (!inText && e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        /* …or into the CARD's action search, when the card is the surface you
           are looking at (F7 focus hides the roster and its search box, so the
           letter has nowhere else to go). fqFindClaimsTyping measures that
           rather than guessing it — see the note on the function. */
        if (fqFindClaimsTyping()) {
          e.preventDefault();
          fqFindOpen(e.key);
          return true;
        }
        const s = $('fd-search');
        if (s && document.activeElement !== s) { s.focus(); }
      }
      return false;
    },

    syncChrome,
    openKeyLabel() { return state.openKey.label || 'F14'; },
    /* the deck's collision question (app.js bindingSnapshot) reads this */
    openKeyBinding() { return { device: state.openKey.device, code: state.openKey.code, label: state.openKey.label }; },
    setOpenKey(device, code, label) {
      state.openKey = { device, code: code >>> 0, label };
      saveOpenKey();
      syncChrome();
      toast('Followers key set to ' + label);
    },
    /* "clear the pane's popouts" — app.js calls this before it raises anything
       of its own (the icon picker, the backdrop). The action search is one of
       them, so it goes with the member menu rather than surviving underneath. */
    closeMenus() { closeCtx(); fqFindClose(); },
    /* Read-only roster projection for the Domains tab's face clusters. Additive
       and side-effect free: it walks the SAME normalized members the tab already
       holds and hands back only what a face needs — the display name, the typed
       Home field (FIELDS' `home`), the two homes the MODS assert (NFF's base and
       MHiYH's house, folded on by mergeHome — sent so a domain can claim her
       AUTOMATICALLY, with nothing typed), the winning portrait URL (via
       portraitFor, so a rig with no portraits folder just gets null and the
       caller draws initials), and the formId for de-duping someone filed in two
       categories. A member may appear once per category it is in; the caller
       de-dupes. */
    /* ---- link someone to a place, from the Domains tab (Rober, 2026-09-17:
       "maybe a way on right click to a domain to link an npc") --------------

       The escape hatch for when NFF will not force-add her and My Home Is Your
       Home therefore never opens its gate. It writes the TYPED
       Home field, which outranks both mods in homesOf(), so the domain claims
       her face immediately and no framework has to agree.

       Domains deliberately does not know Follower Organizer's cat/idx: it hands
       over who and where, this finds the row. `who` is {formId?, name}; formId
       wins when both are present, because two people can share a name.

       Returns {ok, msg} so the caller can say what happened rather than assume. */
    linkHomeTo(who, homeName) {
      const wantId = String((who && who.formId) || '').trim().toLowerCase();
      const wantNm = String((who && who.name) || '').trim();
      const home = String(homeName == null ? '' : homeName).trim();
      if (!wantNm && !wantId) return { ok: false, msg: 'No one to link' };

      let found = null;
      state.cats.forEach(function (c) {
        if (found || c.index === ALL) return;
        (c.members || []).forEach(function (m, i) {
          if (found) return;
          const mid = String(m.formId || '').trim().toLowerCase();
          if (wantId && mid && mid === wantId) { found = { cat: c.index, idx: i, m: m }; return; }
          if (!wantId) {
            const n = String(m.name || '').trim().toLowerCase();
            const o = String(m.original || '').trim().toLowerCase();
            const w = wantNm.toLowerCase();
            if (n === w || o === w) found = { cat: c.index, idx: i, m: m };
          }
        });
      });
      if (!found) {
        return { ok: false, msg: (wantNm || 'That person') + ' is not on the roster - '
          + 'file them in Follower Organizer first' };
      }
      /* saveField wants a row whose `cat` is the category INDEX (not the
         object rosterEntryFor hands back) - see the setField sender. */
      if (!saveField(found, 'home', home)) return { ok: false, msg: 'Could not write the Home field' };
      found.m.fields = found.m.fields || {};
      found.m.fields.home = home;   // optimistic, so the Domains face appears now
      if (isActive()) renderList();   // this is called FROM Domains; only repaint if we are up
      return { ok: true, msg: (found.m.name || wantNm) + (home ? ' now lives at ' + home : '\u2019s home was cleared') };
    },

    rosterForDomains() {
      const out = [];
      state.cats.forEach(function (c) {
        (c.members || []).forEach(function (m) {
          const home = (m.fields && typeof m.fields.home === 'string') ? m.fields.home : '';
          const p = portraitFor(m);
          const portraitUrl = p
            ? portraitSrc(p) + (p.abs ? '' : '?v=' + (p.mtime || 0))
            : null;
          out.push({
            name: String(m.name || ''),
            home: home,
            nffHome: String(m.nffHome || ''),
            mhHome: String(m.mhHome || ''),
            portraitUrl: portraitUrl,
            formId: String(m.formId || ''),
          });
        });
      });
      return out;
    },
    /* ---- the Household tab's roster (household-pane.js, 2026-09-13) ------
       Rober: "SkyManager dedicated auto populating wife and pregnant women
       page, that shows how far along, hooks to profile pictures."

       AUTO-POPULATING MEANS THIS EXPORT, and nothing else. Every fact the
       Household page shows already lands here on the rails this pane owns:
         · the roster itself        — fdState   (Follower Organizer)
         · married / engine rank    — fdNff's per-actor `rel` slice
                                      (src/maras.cpp + src/relationship.cpp)
         · pregnancy and cycle      — fdFertility (src/fertility_bridge.cpp)
         · the face                 — portraitFor(), which already prefers a
                                      captured photo and falls back to the
                                      facegen head render
       So the page needs NO new bridge and no DLL change: it reads what the
       Followers tab is already told, through the pane that owns it. A second
       copy of any of these rules is a second thing to drift — the reason the
       Wardrobe's People card calls this file's verbs instead of re-deriving
       them, and the same reason here.

       Read-only, side-effect free, and safe before fdState has ever landed
       (an empty array, which the page renders as "reading the roster…"
       rather than as "you have no wives"). */
    householdRoster() {
      const out = [];
      (state.cats || []).forEach(function (c) {
        const cl = c.override || c.name || c.original || '';
        (c.members || []).forEach(function (m) {
          const p = portraitFor(m);
          const f = (m.fert && typeof m.fert === 'object') ? m.fert : null;
          out.push({
            /* Identity: `original` is the durable roster key (a rename must
               not split her), formId is what the face rail is keyed on. */
            original: String(m.original || m.name || ''),
            name: String(m.name || m.original || ''),
            formId: String(m.formId || ''),
            category: String(cl || ''),
            note: String(m.desc || ''),
            /* What YOU typed about her (her Relationship field) — your note
               to yourself, and NOT the same fact as the marriage below. */
            relationship: String((m.fields && m.fields.relationship) || ''),
            fieldsText: String(m.fieldsText || ''),
            /* What the GAME believes. `spouse` is M.A.R.A.S's marriage;
               relHas/relRank are the engine's RELA rank. Kept apart on
               purpose — you can be married at Foe (see spouseChip). */
            spouse: !!m.spouse,
            relHas: !!m.relHas,
            relRank: (typeof m.relRank === 'number') ? m.relRank : 0,
            rankLabel: m.relHas ? rankLabel(m.relRank) : '',
            /* Fertility Mode, verbatim — never re-computed here. A null
               means FM is not reporting on her, which the page says out
               loud instead of drawing an empty bar. */
            fert: f ? {
              pregnant: !!f.pregnant,
              day: (typeof f.day === 'number') ? f.day : 0,
              termDays: (typeof f.termDays === 'number') ? f.termDays : 0,
              percent: (typeof f.percent === 'number') ? f.percent : 0,
              trimester: (typeof f.trimester === 'number') ? f.trimester : 0,
              daysLeft: (typeof f.daysLeft === 'number') ? f.daysLeft : null,
              father: String(f.father || ''),
              births: (typeof f.births === 'number') ? f.births : 0,
              cycleDay: (typeof f.cycleDay === 'number') ? f.cycleDay : 0,
              ovulating: !!f.ovulating,
              tracked: (f.tracked === undefined) ? true : !!f.tracked,
            } : null,
            /* The tooltip the roster row already writes for this pregnancy —
               shared so the two surfaces cannot word it differently. */
            fertTitle: f ? fertTitle(f) : '',
            following: !!m.following,
            waiting: !!m.waiting,
            dead: !!m.dead,
            where: String(m.where || ''),
            homeText: String(m.homeText || ''),
            /* The winning face, already resolved: a captured photo outranks
               the facegen head render, exactly as everywhere else. */
            portraitUrl: p ? (portraitSrc(p) + (p.abs ? '' : '?v=' + (p.mtime || 0))) : null,
            /* Her head render was ASKED for and has not landed — the page
               shows a baking ring instead of initials that look final. */
            facePending: facePendingFor(m),
          });
        });
      });
      /* One card per PERSON: FO files the same woman under two categories as
         two member objects, and this used to emit a row for each. */
      return mergeHouseholdRows(out);
    },
    /* Whether Fertility Mode answered at all, so the Household page can tell
       "nobody is pregnant" apart from "the mod is not installed / has not
       initialised" — two very different pages, and only one of them is good
       news. Mirrors the fdFertility envelope's own flags. */
    fertilityStatus() {
      const s = state.fert || null;
      return {
        answered: !!(s && typeof s === 'object'),
        available: !!(s && s.available),
        tracked: (s && typeof s.tracked === 'number') ? s.tracked : null,
        loaded: !!state.loaded,
      };
    },
    /* Portrait lookup for a pane that holds someone's DISPLAY name and formId
       but not FO's un-renamed `original` — which is what a portrait is actually
       keyed on (slugOf(original || name)). The Wardrobe tab is exactly that
       case: src/wardrobe.cpp copies FO's `name` onto its NPC rows and drops
       `original`, so a renamed follower would silently lose her face on that
       surface while keeping it here. Resolving through the roster we already
       hold fixes it with no DLL change and no second copy of the slug rule.

       Read-only and side-effect free. `who` is { formId?, original?, name? };
       the formId path wins when it hits, and the name path is the fallback so
       an NPC the Followers tab has never heard of still resolves the ordinary
       way. Returns the same { slug, file, ext, mtime } shape as portraitFor(),
       or null. */
    portraitInfoFor(who) {
      if (!who) return null;
      const want = canonFormId(fidHexOf(who.formId));
      const name = String(who.original || who.name || "").toLowerCase();
      if (want || name) {
        for (let ci = 0; ci < state.cats.length; ci++) {
          const ms = state.cats[ci].members || [];
          for (let mi = 0; mi < ms.length; mi++) {
            if (want ? canonFormId(fidHexOf(ms[mi].formId)) !== want
              : [ms[mi].original, ms[mi].name].every(function (n) { return String(n || '').toLowerCase() !== name; })) continue;
            const hit = portraitFor(ms[mi]);
            if (hit) return hit;
          }
        }
      }
      /* formId rides along so someone the roster has never held (a MHiYH
         resident the Residents mode paints) still resolves her facegen head
         through portraitFor's own last-resort path. */
      return portraitFor({ original: who.original, name: who.name, formId: who.formId });
    },
    /* Shared face consumers can enqueue newly visible actors without opening
       Followers. Their ids also ride the completion poll below. */
    requestPortraitFaces() { faceIconsPolls = 0; requestFaceIcons(false); },
    /* test hooks */
    _renderHudCard: renderHudCard, _hudCfg: hudCfg, _hudSettingsRow: hudSettingsRow,
    _setHudState: function (s) { hudState = s; renderHudCard(); },
    _state: state, _ui: ui, _visibleRows: visibleRows, _render: render,
    _renderList: renderList, _syncCount: syncCount, _partyList: partyList,
    _crewFace: crewFace,
    _FIELDS: FIELDS, _fieldRows: fieldRows, _fieldValue: fieldValue,
    _normalizeFields: normalizeFields, _normMember: normMember,
    _refreshOpenMenu: refreshOpenMenu,
    _saveField: saveField, _openMemberMenu: openMemberMenu, _prettyKey: prettyKey, _fidHexOf: fidHexOf, _faceWhyFor: faceWhyFor,
    _mergeHouseholdRows: mergeHouseholdRows,
    _sdpCols: sdpCols,
    _openSendTo: openSendTo, _openFileInto: openFileInto, _openMoveTo: openMoveTo, _fqFindIndex: fqFindIndex, _fqRank: fqRank, _fqCategoryRows: fqCategoryRows, _openWardrobeInto: openWardrobeInto, _openNffBase: openNffBase, _fmtOff: fmtOff, _clearNffOutfit: clearNffOutfit, _fileInto: fileInto, _domainMarks: domainMarks, _whereChip: whereChip,
    _mergeHome: mergeHome, _homeChip: homeChip, _homeTitle: homeTitle, _nffEntry: nffEntry,
    _ACTS: ACTS, _actSpec: actSpec, _nowChip: nowChip, _nowTitle: nowTitle, _dayBlock: dayBlock,
    _SETTABLE_KINDS: SETTABLE_KINDS, _canSetKind: canSetKind, _dayActions: dayActions,
    _openSpotPicker: openSpotPicker, _spotPhrase: spotPhrase,
    _rankLabel: rankLabel, _clampRank: clampRank, _rankNum: rankNum,
    _spouseChip: spouseChip, _rankView: rankView,
    /* Trade (2026-08-17): exported so the harness can assert the barter-vs-pack
       prediction WITHOUT a running game — it is the half that must not drift
       from src/trade_actions.cpp. */
    _tradePlan: tradePlan, _tradeTitle: tradeTitle,
    /* Restraints (2026-08-17): the icon ask sits behind a 400 ms settle gate,
       and the harness runs synchronously — so it flushes the pending ask
       rather than sleeping. The rest is read-only state for the page-size and
       sort checks. */
    _fxZazFlushAsk: fxZazFlushAsk, _fxZazCmp: fxZazCmp,
    _FX_ZAZ_SIZES: FX_ZAZ_SIZES,
    _fxZazState: function () {
      return { page: fxZazPage, size: fxZazSize, cat: fxZazCat,
               worn: fxZazWorn, sort: fxZazSort, watching: !!fxZazPollT };
    },
    /* ---- Party sheet, for followers-pane.test.html ---- */
    _PT_RULES: PT_RULES, _PT_SORTS: PT_SORTS, _PT_SCOPES: PT_SCOPES, _PT_COLS: PT_COLS,
    _ptIssues: ptIssues, _ptSeverity: ptSeverity, _ptVisible: ptVisible,
    _ptWeaponOf: ptWeaponOf, _ptFrac: ptFrac, _ptMax: ptMax, _ptMembers: ptMembers,
    _ptHaystack: ptHaystack, _ptRosterFor: ptRosterFor, _ptOpenMember: ptOpenMember,
    _renderParty: renderParty, _setPartyOpen: setPartyOpen, _ptAsk: ptAsk,
    _ptMountPane: ptMountPane, _ptMountToggle: ptMountToggle, _ptCountLine: ptCountLine,
    _ptDropCache: ptDropCache, _ptCacheSize: function () { return ptCache.size; },
    /* ---- Omni providers. window.HDOmni is absent in the harness, so the
       registrations never run there — the index builders are exported so the
       checks drive the SHIPPED functions rather than a copy of them. ---- */
    _omniIndex: omniFollowersIndex,
    _fqOmni: {
      state: FQ_OMNI, subject: fqOmniSubject, rows: fqOmniRows,
      items: fqOmniItems, go: fqOmniGo,
      index: fqOmniIndex, warm: fqOmniWarm,
      /* An empty key is not a valid subject name, so the next index() is
         guaranteed to re-read rather than trust a stale snapshot. */
      forget: function () { FQ_OMNI.key = ''; FQ_OMNI.items = []; },
    },
    _refreshOpenMenu: refreshOpenMenu, _disarm: disarm,
    _ramp: ramp, _oddPx: oddPx, _applyAvatarSize: applyAvatarSize, _AV_DEF: AV_DEF,
    _deckScale: deckScale, _ctxWidthPx: ctxWidthPx, _ctxMaxHpx: ctxMaxHpx,
    _applyUiScale: applyUiScale, _syncEditRowWrap: syncEditRowWrap,
    _clampText: clampText, _FIELD_VALUE_MAX: FIELD_VALUE_MAX,
    _slugOf: slugOf, _portraitFor: portraitFor, _medalEl: medalEl, _openLightbox: openLightbox,
    _badgeEls: badgeEls, _groupsFor: groupsFor,
    _closeLightbox: closeLightbox,
    _closeHudModal: closeHudModal,
    _closeWornLightbox: closeWornLightbox,
    _clampCrop: clampCrop, _cropFor: cropFor, _applyCropTo: applyCropTo,
    _portraitSrc: portraitSrc, _faceFit: faceFit,
    _f7CropFor:f7CropFor, _saveF7Crop:saveF7Crop,
    _cropPhrase: cropPhrase, _CROP_ZSTEP: CROP_ZSTEP, _CROP_PAN_STEP: CROP_PAN_STEP,
    _CROP_ZMAX: CROP_ZMAX, _CROP_MAX_ENTRIES: CROP_MAX_ENTRIES,
    /* WYSIWYG crop plumbing, for the editor-vs-consumer equality harness. */
    _lbFrameDims: lbFrameDims, _paintCrop: paintCrop, _cropCssLocal: cropCssLocal,
    _MEDAL_IDENTITY_BASELINE: MEDAL_IDENTITY_BASELINE,
    _previewCrop: previewCrop,
    _lbEdit: function () { return lbEdit; },
    _lbEditing: function () { return !!lbEdit; },
    _canonFormId: canonFormId,
    _iconSrc: iconSrc, _catIconOf: catIconOf, _anyCatIcon: anyCatIcon,
    _catIconDefaultFor: catIconDefaultFor, _CAT_ICON_DEFAULTS: CAT_ICON_DEFAULTS,
    _railIconEl: railIconEl, _setCatIcon: setCatIcon,
    _openCatIconPicker: openCatIconPicker, _catForIcon: catForIcon,
    _chainIcons: chainIcons, _CATIC_PAGE: CATIC_PAGE, _CAT_MAX: CAT_MAX,
    /* app.js mounts the quick-follower card above the hotkey list while the
       Followers CATEGORY is up; unmount when it leaves. */
    mountQuickCard(host) { mountQuick(host); },
    openEffectsFor(subject, tab, query) {
      closeFxModal();
      fxTab = tab || 'fx'; fxSearch = query || '';
      fxEffMod = 'all'; fxZazCat = 'all'; fxZazWorn = false;
      openFxModal(subject, subject.name || 'NPC');
    },
    /* app.js may only unmount the card it mounted. It calls this on every deck
       render, including renders that happen while OUR tab is up — without the
       ownership check it would tear out the card the Followers tab just put on
       screen, on the very next repaint. */
    unmountQuickCard() {
      if (quickHost !== $('fd-quick')) quickHost = null;
      /* The palette is closing. Her sets can change while it is shut (NFF's own
         dialogue, the Wardrobe tab, the portal), so the next open asks again.
         Same for the worn set, and for the same reason. */
      clothesAsked = false;
      forgetEquippedAsks();
      forgetTuneAsks();
    },
    quickHostIs(host) { return quickHost === host; },
    _whoOf: whoOf, _sendNpc: sendNpc, _askEquipped: askEquipped,
    _buildQuickCard: buildQuickCard, _renderQuickCard: renderQuickCard,
    _NFF_SETS: NFF_SETS, _fillNffOutfit: fillNffOutfit,
    _rosterEntryFor: rosterEntryFor, _capturePortrait: capturePortrait,
    /* Fertility Mode for ANYONE (fmAllResult) — the NPC Finder's rows and the
       crosshair card read these; fertTitle/fertChip so the wording matches. */
    fertFor: fertFor, ensureFertAll: ensureFertAll,
    fertTitle: fertTitle, fertChip: fertChip,
    _fertAll: fertAll,
    _fqStatus: function () { return fqStatus; },
    _syncQuickHere: syncQuickHere,
    /* Fire the mount's give-up timer now instead of waiting 1.2s, so the
       fallback is actually asserted rather than assumed. */
    _fireTargetWait: function () {
      if (targetWait) { clearTimeout(targetWait); targetWait = 0; }
      if (state.targetKnown) return false;
      state.targetKnown = true; renderQuickCard(); return true;
    },
    _recruitClick: recruitClick, _frameworkClick: frameworkClick,
    _clearForceRecruit: clearForceRecruit,
    _dismissClick: dismissClick, _clearForceDismiss: clearForceDismiss,
    _equippedBlock: equippedBlock, _equippedFor: equippedFor, _renderAdd: renderAdd,
    _resetEquippedGate: function () {
      equippedAsked = { key: null, at: 0 }; equippedPending = null; forgetEquippedAsks();
    },
    _quickSubject: quickSubject, _forgetEquippedAsks: forgetEquippedAsks,
    _tuneRow: tuneRow, _tuneFor: tuneFor, _forgetTuneAsks: forgetTuneAsks,
    _openSpellShare: openSpellShare, _openTunePanel: openTunePanel,
    _openPerkGrant: openPerkGrant, _POOLS: POOLS,
    _syncQuickEquipped: syncQuickEquipped,
    /* ⌕ the card's action search (fq-find-actions). The whole surface, so the
       harness drives the real thing rather than a copy of its logic. */
    _fqFind: {
      state: FQF,
      open: fqFindOpen, close: fqFindClose, paint: fqFindPaint,
      key: fqFindKey, fire: fqFindFire, resolve: fqFindResolve,
      index: fqFindIndex, scan: fqScan, rank: fqRank, score: fqScoreRow,
      termScore: fqTermScore, aliasFor: fqAliasFor, labelKey: fqLabelKey,
      near: fqNear, stems: fqStems, sendToRows: fqSendToRows,
      face: fqFaceOf, sect: fqSectOf, clause: fqFirstClause, hl: fqHl,
      reveals: fqRevealFlags, claimsTyping: fqFindClaimsTyping,
      probing: function () { return fqProbing; },
      forgetProbe: function () { FQF.probeKey = ''; FQF.probeAt = 0; FQF.probe = []; },
      bar: function () { const c = fqFindCard(); return c ? c.querySelector('.fq-find') : null; },
      input: fqFindInput,
      pop: function () { return FQF.popEl; },
      outside: fqFindOutside,
      place: fqFindPlace,
    },
    _SANDBOX_STYLES: SANDBOX_STYLES, _openSandboxStyle: openSandboxStyle,
    /* The clothes block asks the Wardrobe modules once per palette open; the
       harness mounts the card dozens of times, so it needs the gate back. */
    _resetClothesGate: function () { clothesAsked = false; },
    _clothesAbout: clothesAbout,
  };

  /* ---- C++ → JS receivers (window globals, deck view) ---- */

  function coerce(x) {
    if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
    return x;
  }

  /* Followers HUD control state (C++ -> deck). Refreshes just the card. */
  window.hudCfgState = function (env) {
    env = coerce(env);
    if (!env) return;
    hudState = env;
    if (isActive()) renderHudCard();
  };

  window.fdState = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    env = coerce(env);
    if (!env) return;
    if (env.msg) toast(env.msg);
    const s = env.state && typeof env.state === 'object' ? env.state : env;
    normalizeState(s);
    state.loaded = true;
    state.foMissing = (env.ok === false && !state.cats.length)
      ? (env.msg || 'Follower Organizer is not available') : '';
    if (isActive()) render();
    requestFaceIcons(true);
    /* Same reason as fdFertility's: the Household tab is drawn from this
       roster and cannot see the push itself. */
    try { if (window.HouseholdPane) HouseholdPane.dataChanged(); } catch (e) {}
  };

  /* ---- facegen head renders as default portraits ------------------------
     Ask C++ to resolve every roster formId to its face render (existing PNGs
     answer immediately; missing ones are queued through the NPC finder's
     render route, render-once-keep-forever). Renders complete asynchronously
     in-game, so while any were queued the view re-asks on a slow clock —
     bounded, and only while the tab is up, because a templated NPC has no
     facegen file and would otherwise be polled forever. */
  let faceIconsTimer = 0, faceIconsPolls = 0, faceIconsLastAsk = 0;
  /* Heads ASKED FOR but not yet delivered (formid-hex key → asked-at ms).
     This is what lets a medallion show a LOADING ring instead of sitting on
     bare initials while the render bakes (Rober, 2026-08-19: "show some sort
     of loading animation between the blank profile pic and grabbing the
     face"). Session-only. Cleared per-key when fdFaceIconsData delivers that
     face, and wholesale when a reply says queued:0 — at that point nothing
     more will ever land, so a surviving entry would spin forever over an NPC
     who simply has no facegen file. The TTL in facePendingFor is the backstop
     for a reply that never comes at all. */
  const facePending = {};
  function facePendingFor(m) {
    const k = fidHexOf(m && m.formId);
    const at = k ? facePending[k] : 0;
    if (!at) return false;
    if (Date.now() - at > 150000) { delete facePending[k]; return false; }  // 24 polls × 5 s + slack
    return true;
  }
  function requestFaceIcons(reset) {
    if (reset) faceIconsPolls = 0;
    const now = Date.now();
    if (reset && now - faceIconsLastAsk < 3000) return;   // fdState bursts (refresh + apply) fold to one ask
    const ids = {};
    (state.cats || []).forEach(function (c) {
      (c.members || []).forEach(function (m) {
        const k = fidHexOf(m.formId);
        if (k && !state.faceIcons[k]) ids[k] = 1;
      });
    });
    (state.liveParty || []).forEach(function (m) {
      const k = fidHexOf(m.formId);
      if (k && !state.faceIcons[k]) ids[k] = 1;
    });
    /* …and everyone the party sheet measured. Almost always the same people as
       the live scan above, but not necessarily: a member the caller NAMED (a
       roster row the two faction tests missed) is on the sheet without ever
       having been in liveParty, and without this her card is the only face on
       the page still drawing initials. */
    ((state.party && state.party.members) || []).forEach(function (m) {
      const k = fidHexOf(m.formId);
      if (k && !state.faceIcons[k]) ids[k] = 1;
    });
    /* The F7 LOOKING-AT card's subject rides along too (folded into the same
       ask when a roster refresh happens to coincide). Its dedicated trigger is
       requestTargetFace() below — this covers the case where it is already the
       target when the roster re-asks. */
    const tk = fidHexOf(state.target && state.target.formId);
    if (tk && !state.faceIcons[tk]) ids[tk] = 1;
    /* …and everyone the open Who's here list is drawing. In "Everyone here"
       mode most of them are on no roster and in no party, so without this the
       5 s completion poll would never re-ask for the heads the scan queued and
       they would sit on initials until the next scan (the faceConsumerActive
       law — any surface that paints icons/npcs renders must be named here). */
    if (ui.nhOpen) (state.here.rows || []).forEach(function (r) {
      const k = fidHexOf(r.formId);
      if (k && !state.faceIcons[k]) ids[k] = 1;
    });
    if (ui.rrOpen) (state.recall.rows || []).forEach(function (r) {
      const k = fidHexOf(r.formId);
      if (k && !state.faceIcons[k]) ids[k] = 1;
    });
    if (window.GetAway && GetAway.isOpen()) GetAway.portraitIds().forEach(function (k) {
      if (k && !state.faceIcons[k]) ids[k] = 1;
    });
    if (window.OstimTools && OstimTools.isOpen()) OstimTools.portraitIds().forEach(function(k){if(k&&!state.faceIcons[k])ids[k]=1;});
    [window.DomainsPane, window.HDNpcTune].forEach(function (pane) {
      if (!pane || !pane.portraitIds) return;
      pane.portraitIds().forEach(function (id) {
        const k = fidHexOf(id);
        if (k && !state.faceIcons[k]) ids[k] = 1;
      });
    });
    const list = Object.keys(ids);
    if (!list.length) return;
    faceIconsLastAsk = now;
    list.forEach(function (k) { if (!facePending[k]) facePending[k] = now; });
    toGame('fdFaceIcons', JSON.stringify({ ids: list }));
  }

  /* Fetch (or queue) JUST the crosshair NPC's facegen head. Split out from
     requestFaceIcons on purpose: that one's 3s reset-debounce exists to fold
     fdState refresh bursts, but a fresh person under the crosshair is a
     distinct, intentional event that must NOT be swallowed by a roster refresh
     that fired moments earlier. It is rarely on the FO roster or in the live
     party (you look at strangers far more than at followers), so without this
     its head is never asked for and the quick-card medallion stays blank while
     the Finder renders the same face fine (2026-08-14 bug). Deduped against the
     cache so an already-rendered head costs nothing, and reset:true is left to
     requestFaceIcons callers; here we re-arm the poll so a freshly-queued
     render is picked up when it lands. The bridge answers with the head PNG (or
     queued>0 for a not-yet-rendered NPC), routed through fdFaceIconsData. */
  function requestTargetFace() {
    const tk = fidHexOf(state.target && state.target.formId);
    if (!tk || state.faceIcons[tk]) return;
    faceIconsPolls = 0;                     // re-arm the completion poll for this head
    faceIconsLastAsk = Date.now();
    if (!facePending[tk]) facePending[tk] = Date.now();
    toGame('fdFaceIcons', JSON.stringify({ ids: [tk] }));
  }

  /* group -> members, keyed by ORIGINAL name (loadouts.cpp
     GroupsByOriginalJson). Empty until the first reply, and empty forever on a
     save with no groups — both render as "no group", which is the truth. */
  window.loGroupsData = function (env) {
    const v = coerce(env);
    const by = (v && v.byOriginal && typeof v.byOriginal === 'object') ? v.byOriginal : {};
    const next = {};
    Object.keys(by).forEach(function (k) {
      if (Array.isArray(by[k])) next[String(k).toLowerCase()] = by[k];
    });
    state.groupsByOriginal = next;
    dropRowCache();
    if (isActive()) render();
    renderQuickCard();
  };

  /* Every group this follower is in, with the class she plays there. */
  function groupsFor(m) {
    if (!m) return [];
    const key = String(m.original || m.name || '').toLowerCase();
    if (!key) return [];
    return (state.groupsByOriginal && state.groupsByOriginal[key]) || [];
  }

  window.fdFaceIconsData = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    const v = coerce(env);
    if (!v || typeof v !== 'object') return;
    let changed = false;
    const icons = (v.icons && typeof v.icons === 'object') ? v.icons : {};
    Object.keys(icons).forEach(function (k) {
      const path = String(icons[k] || '');
      const key = fidHexOf(k);
      if (path && state.faceIcons[key] !== path) { state.faceIcons[key] = path; changed = true; }
      if (path && state.faceWhy[key]) { delete state.faceWhy[key]; changed = true; }
      if (facePending[key]) { delete facePending[key]; changed = true; }
    });
    /* The DLL's reasons for the ids it could NOT resolve to a head (not loaded,
       no head file shipped for her record, …) - the dossier shows them in
       place of "No portrait yet", which promised a picture that can't come. */
    const why = (v.why && typeof v.why === 'object') ? v.why : {};
    Object.keys(why).forEach(function (k) {
      const key = fidHexOf(k);
      const text = String(why[k] || '');
      if (!key || !text || state.faceIcons[key]) return;
      if (state.faceWhy[key] !== text) { state.faceWhy[key] = text; changed = true; }
    });
    clearTimeout(faceIconsTimer);
    const queued = Number(v.queued) || 0;
    /* queued:0 = the bridge has nothing baking, so no face beyond the ones
       just delivered will EVER land from this ask — anything still pending is
       a dead end (templated NPC, no facegen file) and its loading ring must
       stop now rather than spin out the TTL over honest initials. */
    if (queued === 0) {
      Object.keys(facePending).forEach(function (k) { delete facePending[k]; changed = true; });
    }
    if (changed) portraitsChanged();
    if (queued > 0 && faceIconsPolls < 24) {
      faceIconsPolls++;
      faceIconsTimer = setTimeout(
        function () { if (faceConsumerActive()) requestFaceIcons(false); }, 5000);
    }
  };

  /* Live party — the HUD's own teammate/faction scan (an ARRAY of
     {name,formId,following,dead,file,ext,mtime,crop}). Merged into partyList()
     so framework-driven followers the FO roster never lists (custom follower
     mods, CHIM soft-follow) still show in "Current party". De-dup vs the roster is by
     formId there, so an FO member is never doubled. */
  window.fdLiveParty = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    const v = coerce(env);
    state.liveParty = Array.isArray(v) ? v : (v && Array.isArray(v.list) ? v.list : []);
    if (isActive()) render();
    requestFaceIcons(true);
  };

  window.fdTarget = function (t) {
    /* A fresh crosshair target drops any party PICK: looking at somebody is a
       clearer statement of intent than a face you clicked earlier, and leaving
       the pick in place would mean the card silently keeps addressing the
       wrong person while you stare at someone else. */
    if (!ui.fqPickPinned) ui.fqPick = '';
    t = coerce(t);
    /* BEFORE the reassignment below — read it after and you are comparing the
       new target with itself, so a status line about the previous NPC would
       never be cleared. */
    const wasId = state.target ? state.target.formId : -1;
    state.target = (t && t.name) ? {
      formId: t.formId >>> 0,
      name: String(t.name),
      /* Optional — an older DLL sends neither. Absent reads as false, which
         leaves the quick strip saying "Recruit"; that is the safe default,
         since NFF refuses a double-recruit in words of its own. */
      following: !!t.following,
      /* The half-recruit: factions say current follower, engine says not a
         teammate. Also optional — a pre-2026-08-10 DLL never sends it, and
         absent reads as false, which is the old behaviour exactly. */
      wedged: !!t.wedged,
      /* In NFF's framework via its own Import. Optional for the same reason:
         a pre-2026-08-11 DLL never sends it, and absent reads as false — the
         button then offers "Add to framework", and importing someone who
         already is gets refused in words by C++ rather than done twice. */
      imported: !!t.imported,
      /* NFF's OWN follower faction. Separate from `following` above (which is
         IsPlayerTeammate) because NFF keeps followers through states the
         engine does not count as a teammate — and it is the answer that
         decides whether a Dismiss would do anything. Optional and absent =
         false, so a pre-2026-09-10 DLL simply behaves as it always did. */
      nffFollower: !!t.nffFollower,
      /* PotentialFollowerFaction — whether the game will let you ask her to
         follow at all.
         THREE-VALUED ON PURPOSE, unlike the flags above: null means the DLL
         did not say. A pre-2026-08-11 DLL never sends it, and collapsing that
         to `false` would make every NPC read as "cannot be asked" and remove
         ⚔ Recruit from the card entirely — a matched-set mismatch that
         silently deletes the most-used button. Unknown therefore falls back to
         the old behaviour (offer Recruit); only an explicit false switches the
         slot to ✚ Make recruitable. */
      canFollow: (typeof t.canFollow === 'boolean') ? t.canFollow : null,
      /* Did WE put her in the pool? Gates the undo, so it can never be
         offered on a natural follower. Same three-valued caution is
         unnecessary here: absent means "no", and the worst case is the undo
         simply not being offered. */
      forcedFollow: !!t.forcedFollow,
      dead: !!t.dead,
    } : null;
    state.targetKnown = true;
    if (targetWait) { clearTimeout(targetWait); targetWait = 0; }
    /* A verdict about the last person is noise once you look at someone else. */
    const nowId = state.target ? state.target.formId : -1;
    if (nowId !== wasId) {
      fqStatus = { msg: '', ok: true, pending: false };
      /* An in-flight rank edit belongs to the PREVIOUS person. rankView already
         keys on the form id so it could never be drawn on the new one, but a
         verify read fired at the old target would arrive as a worn-set answer
         about somebody else — so cancel it here rather than let it land. */
      rankEdit = { key: null, has: false, rank: 0, pending: false };
      if (rankVerify) { clearTimeout(rankVerify); rankVerify = 0; }
      /* Somebody else is under the crosshair, so the clothes block is about the
         wrong person until the two Wardrobe modules have answered for the new
         one. Same invalidation as the worn set below, for the same reason. */
      clothesAsked = false;
    }
    /* Rober, 2026-08-06: F7 on an NPC, close, F7 again on NOTHING left the
       stale npcFocus flag painting the dedicated chrome over an empty card —
       maybeAutoFocus runs at tab-show, BEFORE this snapshot lands, so its
       no-target guard judged the PREVIOUS open's target and let focus stand.
       This arrival is the authoritative "there is no NPC": drop focus and land
       on the main follower view (rail + All Followers), never the empty shell. */
    /* …unless the focus is a PINNED PICK (a row's F7 Controls, a party face):
       that view is about her, not about the crosshair, and a target push must
       not throw you out of it. */
    if (ui.npcFocus && !(state.target && state.target.name) && !(ui.fqPickPinned && ui.fqPick)) {
      ui.cat = ALL;
      ui.rosterOpen = true;
      exitFocus();
    }
    /* A new person under the crosshair invalidates the cached worn set for
       "the crosshair target" (it caches under the empty key), so drop it and
       let the card re-ask rather than showing the previous NPC's gear. */
    state.equipped[''] = undefined;
    delete state.equipped[''];
    equippedAsked = { key: null, at: 0 };
    /* A new person under the crosshair needs their facegen head fetched (or
       queued) so the LOOKING-AT medallion fills — the roster/live-party walk in
       requestFaceIcons never covers a stranger. Only on a genuine target change
       (nowId !== wasId) so a jittering crosshair on the same NPC doesn't spam
       the bridge. requestTargetFace dedupes against the cache, so an FO
       follower you look at costs nothing, and it bypasses the roster-refresh
       debounce so a stranger's head is never swallowed by a coincident fdState.
       BEFORE renderQuickCard on purpose: the ask is what marks facePending,
       and the card's very first paint must already wear the loading ring. */
    if (nowId !== wasId) requestTargetFace();
    renderQuickCard();
    if (quickHost && quickHost.isConnected) askEquipped(null);
    if (isActive()) renderAdd();
    /* F7 NPC-focus, the "last-closed tab was Followers" path: there, hdOpen's
       setTab('followers') runs BEFORE this fdTarget lands, so maybeAutoFocus saw
       no target and app.js's later hdShowTab('followers') no-ops (same tab). So
       the target's own arrival is the trigger — but ONLY on the Followers tab,
       within the fresh-open window, and not after a manual exit. A later
       crosshair change (past the window) just updates the card, never re-focuses. */
    if (state.target && state.target.name && !ui.npcFocus && !ui.focusDismissed
        && (typeof window !== 'undefined')
        && window.__hdActiveTab === 'followers'
        && (Date.now() - (window.__hdOpenedAt || 0)) < 2500) {
      enterFocus();
    }
  };

  /* fdPortraits: the live portraits/ listing. Listener-free — C++ pushes it
     at palette open and again with every fdRefresh (which onShow() triggers),
     so we never have to ask. Payload is [{ slug, file, ext, mtime }] — one entry
     per FOLLOWER, not per file: C++ has already picked the newest file for each
     slug. An object carrying a .portraits array is accepted too, so C++ can grow
     the envelope later without breaking this. */
  window.fdPortraits = function (list) {
    dropRowCache();   // a push the row signature cannot see for itself
    list = coerce(list);
    const arr = Array.isArray(list) ? list
      : (list && Array.isArray(list.portraits) ? list.portraits : []);
    const map = {};
    arr.forEach(function (p) {
      if (!p || !p.slug) return;
      const mt = typeof p.mtime === 'number' ? p.mtime : parseInt(p.mtime, 10);
      const slug = String(p.slug).toLowerCase();
      const ext = String(p.ext || 'png').toLowerCase().replace(/^\./, '');
      /* The winning file's real NAME. C++ picks it (newest file wins for a
         slug, and a re-capture of an already-drawn face lands as
         `<slug>~<n>.png`), so the view must not try to rebuild it. Anything
         with a path separator is refused rather than sanitised: `file` names a
         sibling in portraits/, and a value that walks out of it is a bug or an
         attack, never a portrait. Falling back to the classic form keeps a new
         view working against an older DLL that sends no `file`. */
      const raw = typeof p.file === 'string' ? p.file.trim() : '';
      const file = (raw && !/[\\/]/.test(raw) && raw !== '.' && raw !== '..')
        ? raw
        : (slug + '.' + ext);
      map[slug] = {
        file: file,
        ext: ext,
        // Plain number, NOT `>>> 0`: the stamp can exceed 32 bits and a
        // wrapped value would collide across different files.
        mtime: (isFinite(mt) && mt > 0) ? mt : 0,
      };
    });
    state.portraits = map;
    portraitsChanged();
  };

  /* fdCrops: the display-crop map, { "<file>": { z, x, y } }. Its own name in
     its own direction — `fdCropSave` goes the other way and the two must never
     share a spelling (a bridge name used for both directions silently unplugs
     the control; that has bitten five times).

     Pushed rather than asked for, exactly like fdPortraits, and it is
     AUTHORITATIVE: C++ prunes entries whose file has left portraits/ — which
     this side cannot compute, since it only ever learns the winning file per
     follower and never the whole directory — so replacing the map wholesale is
     how a prune reaches the screen. Re-validated here anyway: hotkeys.json is
     hand-editable and this is the one input the editor's own clamp never saw. */
  window.fdCrops = function (obj) {
    dropRowCache();   // a push the row signature cannot see for itself
    obj = coerce(obj);
    const src = (obj && typeof obj === 'object' && !Array.isArray(obj))
      ? (obj.crops && typeof obj.crops === 'object' ? obj.crops : obj) : {};
    const map = {};
    let n = 0;
    Object.keys(src).forEach(function (k) {
      if (n >= CROP_MAX_ENTRIES) return;
      const file = String(k || '').trim();
      // Same refusal as fdPortraits' `file`: this names a sibling inside
      // portraits/, and a value that walks out of it is a bug or an attack.
      if (!file || /[\\/]/.test(file) || file === '.' || file === '..') return;
      const c = clampCrop(src[k]);
      if (!c) return;   // identity or unparseable: nothing to draw, nothing to keep
      map[file] = c;
      n++;
    });
    state.crops = map;
    /* Hand the whole map to the SHARED portrait lane. followers-pane still owns
       this data (it loads, edits and persists it) — but every other surface that
       draws a face needs to be able to ask for the framing, and before this the
       store was private to this file, which is why fourteen panes centre-cropped
       instead (2026-08-19 sweep). One push here, and they all agree. */
    if (window.HDFaceFit && HDFaceFit.setPortraitCrops) HDFaceFit.setPortraitCrops(map);
    window.dispatchEvent(new CustomEvent('hd-portrait-crops-changed'));
    portraitsChanged();
  };

  /* fdNff: the read-only NFF + My Home is Your Home NG snapshot. Listener-free
     like fdPortraits — C++ pushes it at palette open and with every fdRefresh,
     so we never ask. Payload is the src/nff_bridge.cpp envelope
     { ok, nff, mhiyh, members: { "0x0001A6A1": { nff:{…}, mhiyh:{…} } } }; a
     bare members map is accepted too, so an older/newer C++ side degrades to
     "no chips" instead of throwing. */
  /* fdFramingInfo: the portrait crop as capture.ini now holds it, including
     the shipped defaults so Reset means one thing on both sides. Its own name,
     never fdFraming — a bridge name used for both directions unplugs the
     control (this has bitten four times). */
  window.fdFramingInfo = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    const e = coerce(env);
    if (!e || typeof e !== 'object') return;
    const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
    framing = {
      zoom: num(e.zoom, 0.6), offsetX: num(e.offsetX, 0), offsetY: num(e.offsetY, -0.06),
      defZoom: num(e.defZoom, 0.6), defOffsetX: num(e.defOffsetX, 0),
      defOffsetY: num(e.defOffsetY, -0.06),
    };
    if (captureSetup && captureSetup.load) captureSetup.load(Object.assign({},framing,{lighting:e.lighting && ['natural','soft','bright'].indexOf(e.lighting.mode)>=0 && typeof e.lighting.strength==='number' && isFinite(e.lighting.strength) && e.lighting.strength>=.25 && e.lighting.strength<=3 ? e.lighting : null}));
    if (isActive() && ui.fqFraming) renderQuickCard();
  };

  /* nfResult — NFF's answer to nfBuild / nfClear / nfCopy, which the card fires
     from its Fill / Wear / Reset rows.
     CHAINED, not assigned: wardrobe-nff.js owns this name and a second plain
     assignment would silently unplug whichever file loaded first. Same idiom as
     rooms-pane's chain(); we look, update the card, and always pass it on.

     Without this the card set a pending "Giving her X for Adventure…" that
     nothing ever cleared — so a copy that SUCCEEDED looked identical to one that
     hung, which is exactly what was reported (2026-08-02). A comment in this
     file claimed the reply "already lands in fqStatus"; it never did. */
  (function chainNfResult() {
    const prev = window.nfResult;
    window.nfResult = function (info) {
      try {
        const r = coerce(info) || {};
        // Only speak for a request WE made — the Wardrobe tab fires these too,
        // and stamping its replies onto the card would report someone else's op.
        if (fqStatus && fqStatus.pending) {
          const ok = (r.ok !== false);
          fqStatus = {
            msg: r.msg || (ok ? 'Done' : 'NFF refused that'),
            ok: ok, pending: false,
          };
          if (isActive()) renderQuickCard();
        }
      } catch (e) { /* never let our bookkeeping break the Wardrobe's reply */ }
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
    window.nfResult.__fdChained = true;
  })();

  window.fdNff = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    env = coerce(env);
    const isMap = env && typeof env === 'object' && !env.members &&
                  typeof env.nff !== 'boolean' && !Array.isArray(env);
    const members = (env && typeof env.members === 'object' && env.members) ? env.members
      : (isMap ? env : {});
    const map = {};
    Object.keys(members || {}).forEach(function (k) {
      const v = members[k];
      if (v && typeof v === 'object') map[String(k).toLowerCase()] = v;
    });
    state.nff = {
      nff: !!(env && env.nff),
      mhiyh: !!(env && env.mhiyh),
      /* NFF's allow-sandboxing switch: -1 = no answer (mod absent / no save),
         so the toggle hides rather than claiming "off". */
      sandbox: (env && typeof env.sandbox === 'number') ? env.sandbox : -1,
      members: map,
      // The player's registered NFF home bases, so the card can OFFER one
      // rather than only report which she has. Index is the faction rank NFF
      // itself stores, so it is what setBase takes back.
      bases: (env && Array.isArray(env.bases)) ? env.bases.filter(
        (b) => b && typeof b === 'object' && typeof b.index === 'number' && b.name) : [],
    };
    // fdState may have landed first (it usually does) — refold onto the roster
    // already in memory rather than waiting for the next state push.
    remergeHomes();
    if (isActive()) renderList();
    // An fdMhiyh round-trip lands here: the open member menu is showing the
    // day from BEFORE the change, so redraw it where it stands.
    refreshOpenMenu();
    /* …and so is the QUICK CARD, which was the one surface this handler never
       repainted. Set a home from the card and C++ did everything right — the
       home landed, fdNff carried it back, the roster row updated — but the
       card you were looking at kept showing the state from before the click,
       so the edit read as a no-op (Rober, 2026-08-02). It draws its home chip
       off the same roster member remergeHomes() just rewrote, so it only ever
       needed telling. */
    renderQuickCard();
    syncQuickHere();
  };

  /* fdMhiyhResult: the reply to a "tell My Home is Your Home to change her
     day" message (src/mhiyh_control.cpp).

     The name MUST NOT be `fdMhiyh` — that is the REQUEST bridge, which
     PrismaUI installs as a global of the same name. Assigning a receiver over
     it meant toGame('fdMhiyh') at sendMhiyh() called this handler instead of
     the plugin, so the whole day-editor was dead in game: every click toasted
     nothing and no Papyrus ever ran. Identical defect to fdNpc/fdEquipped in
     v0.10; caught by audit and fixed 2026-08-02.

     TWO replies per action, because the Papyrus call is asynchronous:

       { ok:false, phase:"refused", msg }              nothing was dispatched
       { ok:true,  phase:"sent",    op, kind, msg }    queued in the VM
       { ok,       phase:"done",    op, kind, msg }    MHiYH's own answer

     Only "sent" is silent-ish (a low-key toast so a click always feels like
     it did something); "refused" and "done" both say a full sentence,
     because a refusal is usually the mod's own rule ("she has to be
     following you") and is the most useful thing on screen. The day itself
     repaints off the fdNff C++ pushes alongside the "done" reply — this
     handler only remembers per-actor feedback; it never invents routine data
     before the mod confirms it. */
  window.fdMhiyhResult = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    updateDayStatus(env);
    const msg = typeof env.msg === 'string' ? env.msg : '';
    if (!msg) return;
    if (env.phase === 'sent') { toast(msg); return; }
    toast((env.ok ? '' : '⚠ ') + msg);
  };

  /* fdNpcResult: the reply to a quick recruit / dismiss / open-inventory
     (request goes out as `fdNpc`; the two names MUST differ, because PrismaUI
     installs every C++ listener as a JS global of its own name — reuse one and
     toGame('fdNpc') calls THIS function instead of the plugin)
     (src/nff_control.cpp). Two phases like fdMhiyh, because the Papyrus call
     is asynchronous:

       { ok:false, phase:"refused", msg, guarded, following }  nothing dispatched
       { ok:true,  phase:"sent",    op, via, msg }             queued in the VM
       { ok,       phase:"done",    op, via, msg }             what happened

     `via` is "nff" or "vanilla" and is surfaced on the SENT toast, so it is
     always visible which framework took the recruit rather than something you
     have to go and read in the log.

     A `guarded` refusal is the one case that changes the UI: the NPC has her
     own follower mod and NFF would give her a second controller. We re-arm the
     recruit affordance so a second click sends force:true — the deck's usual
     two-click idiom, rather than a lock on Rober's own game. */
  window.fdNpcResult = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    const msg = typeof env.msg === 'string' ? env.msg : '';

    /* Mirror every reply onto the card. "sent" is pending (the Papyrus call is
       queued, not done), "done"/"refused" are final. */
    if (msg) {
      fqStatus = { msg: msg, ok: env.ok !== false, pending: env.phase === 'sent' };
      renderQuickCard();
    }

    if (env.phase === 'sent') {
      const via = env.op === 'recruit' && env.via === 'vanilla' ? ' (vanilla — NFF not installed)' : '';
      if (msg) toast(msg + via);
      return;
    }

    if (env.guarded) {
      /* Arm the PERSON, not the button: whichever recruit control is clicked
         next means "yes, her, anyway". See armForceRecruit for why this cannot
         go through arm(). */
      armForceRecruit(lastRecruitTarget, msg, lastRecruitOp);
      if (msg) toast('⚠ ' + msg);
      return;
    }

    /* A quest holds her and NFF does not: the message names the quest, and
       the next Dismiss click forces it (armForceDismiss). */
    if (env.held) {
      armForceDismiss(lastDismissTarget, msg);
      if (msg) toast('⚠ ' + msg);
      return;
    }

    if (msg) toast((env.ok ? '' : '⚠ ') + msg);

    /* Her sandbox checkbox is WRITE-ONLY without this, and the log proved it:
       three clicks on 2026-08-03 logged "per-actor sandbox blocked" three
       times. The button sends `!m.sandboxOn`, and the only thing that ever
       wrote m.sandboxOn was a fresh fdNff envelope — which nothing asks for
       after the write. So the local value stayed `true`, every click sent
       "exclude her" again, and there was no way back from the deck.

       C++ already returns the value it actually wrote; take it. Applied to
       EVERY roster entry with that formId, because someone filed in two
       categories is two objects and half a truth is worse than none. */
    if (env.phase === 'done' && env.ok !== false && env.op === 'sandboxActor' &&
        typeof env.on === 'boolean') {
      const want = canonFormId(env.formId);
      if (want) {
        state.cats.forEach(function (c) {
          (c.members || []).forEach(function (m) {
            if (canonFormId(m.formId) === want) { m.sandboxOn = env.on; m.sandboxKnown = true; }
          });
        });
      }
    }

    /* The framework toggle is WRITE-ONLY without this — the same defect the
       sandbox chip had. `imported` on the card comes from fdTarget, which is
       only rebuilt when the palette next opens on her, so after an import the
       button would still read "Add to framework" and a second click would
       send import again. C++ returns the value it actually wrote; take it. */
    if (env.phase === 'done' && env.ok !== false &&
        (env.op === 'import' || env.op === 'export') &&
        typeof env.imported === 'boolean' && state.target) {
      state.target.imported = env.imported;
    }

    /* Same reason for "Make recruitable": once granted, the offer must stop
       being offered, or the next click just earns NFF's own refusal. */
    if (env.phase === 'done' && env.ok !== false && state.target &&
        (env.op === 'forceFollower' || env.op === 'unforceFollower')) {
      if (typeof env.canFollow === 'boolean') state.target.canFollow = env.canFollow;
      if (typeof env.forced === 'boolean') state.target.forcedFollow = env.forced;
    }

    /* A recruit now reports what it VERIFIED rather than that the call ran
       (src/nff_control.cpp FinishRecruit), so the card can stop showing a
       follower who never followed. Taking these three straight off the reply
       means a refused recruit immediately offers the thing that would fix it —
       Repair when she came back half-recruited, "Make recruitable" when she was
       never in the follower pool — instead of asking the user to guess which
       condition applies. */
    if (env.phase === 'done' && env.op === 'recruit' && state.target) {
      if (typeof env.following === 'boolean') state.target.following = env.following;
      if (typeof env.wedged === 'boolean') state.target.wedged = env.wedged;
      if (typeof env.canFollow === 'boolean') state.target.canFollow = env.canFollow;
    }

    /* A finished recruit/dismiss changed what they are wearing often enough
       (NFF hands a new follower her outfit) that a cached worn set is now a
       lie. Drop it; the next menu open re-asks. Import/export too: NFF applies
       and reverts its own gear tweaks on both. */
    if (env.phase === 'done' &&
        (env.op === 'recruit' || env.op === 'import' || env.op === 'export' ||
         env.op === 'dismiss' || env.op === 'removeItem')) {
      state.equipped = {};
      equippedAsked = { key: null, at: 0 };
      forgetEquippedAsks();   // else the wiped cache is never refilled
    }
    renderQuickCard();
  };

  /* fdWorn: the worn set for ONE actor, read off the engine. Request goes out
     as `fdEquipped` — disjoint names, see fdNpcResult above
     (src/nff_control.cpp EquippedJson). Cached by lowercased formId — the
     crosshair target under ''. Repaints the open menu in place so the skeleton
     is replaced without the menu moving. */
  /* fdTuneInfo: the answer to every fdTune op — the read, each write, and the
     spellbook. Request name is `fdTune`; a shared name would unplug the whole
     block (the deck law). */
  window.fdTuneInfo = function (env) {
    dropRowCache();   // a push the row signature cannot see for itself
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    if (env.op === 'perks') {
      tunePerks = Array.isArray(env.perks) ? env.perks : [];
      if (ctxEl) {
        const f = ctxEl.querySelector('.fd-ctx-filter');
        if (f) f.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (env.op === 'spells') {
      tuneSpells = Array.isArray(env.spells) ? env.spells : [];
      /* Repaint an OPEN picker in place: it was opened before the book had
         arrived and is showing "reading your spellbook…". */
      if (ctxEl) {
        const f = ctxEl.querySelector('.fd-ctx-filter');
        if (f) f.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (typeof env.msg === 'string' && env.msg) {
      fqStatus = { msg: env.msg, ok: env.ok !== false, pending: false };
      toast((env.ok === false ? '⚠ ' : '') + env.msg);
    }
    /* Keyed on the id we ASKED with, which C++ echoes back: its own `formId`
       is the durable local one and would never match the card's runtime id. */
    const k = String(env.reqId || env.formId || '').toLowerCase();
    if (k && env.tune) tuneCache[k] = env.tune;
    /* An OPEN panel repaints in place: every op answers here, and a panel that
       kept its pre-click state would be lying about what it just did. */
    repaintTunePanel();
    refreshOpenMenu();
    renderQuickCard();
  };

  /* ============================= ⛑ Gear Toggle (fdGear bridge) ==========
     gearState mirrors the last fdGearResult for the CURRENT subject:
     { formId, hidden:{head,cloak,shield,body} }. A per-actor thing, so it is
     dropped whenever the card's subject changes. */
  let gearState = null;
  let gearBusy = false;

  const GEAR_GROUPS = [
    ['head', '⛑', 'Head', 'Helmet / hat / circlet (hidden, stays equipped)'],
    ['cloak', '🧥', 'Cloak', 'Cloaks of Skyrim / capes (slots 46/47)'],
    ['shield', '🛡', 'Shield', 'The worn shield'],
    ['body', '👕', 'Body', 'Cuirass / body armour'],
    // Hood is special: it UNEQUIPS the hair-slot headwear (frees the slot so her
    // real hair shows) rather than hiding the mesh — hiding a hood that owns the
    // hair slot leaves it equipped, so the hair stays gone. Reversible.
    ['hood', '🧣', 'Hood', 'Take a hood OFF the hair slot so her hair shows (reversible)',
      { onLabel: '↩ Put hood on', offLabel: '🧣 Take hood off',
        onTitle: 'Put %WHO%’s hood back on',
        offTitle: 'Take %WHO%’s hood off the hair slot so her real hair shows — reversible' }],
  ];

  function gearSubjectId() {
    const subj = quickSubject();
    if (subj && subj.formId) return Number(subj.formId) || 0;
    return state.target ? (Number(state.target.formId) || 0) : 0;
  }

  function buildGearBlock(who) {
    const box = h('div', { class: 'fq-sets is-gear' },
      h('span', { class: 'fq-sets-lbl', title:
        'Hide worn gear — it stays equipped and keeps its stats, only the 3D '
        + 'is hidden, and it is remembered.' }, 'Hide gear'));

    // Mod-missing is a GLOBAL condition (no formId), so check it first.
    if (gearState && gearState.unavailable) {
      box.append(h('span', { class: 'fq-rank-note' },
        'Gear Toggle mod isn’t loaded — tick it in MO2 and restart.'));
      return box;
    }
    const fid = gearSubjectId();
    // Otherwise gearState is only trustworthy if it is about THIS subject.
    const st = (gearState && gearState.formId && parseInt(gearState.formId, 16) === fid)
      ? gearState : null;
    if (!st && !gearBusy) {
      // no state yet — ask (covers the case the button was pressed before a push)
      if (fid) toGame('fdGear', JSON.stringify({ op: 'state', formId: fid }));
    }

    GEAR_GROUPS.forEach(function (g) {
      const on = !!(st && st.hidden && st.hidden[g[0]]);
      const ov = g[4];   // optional { onLabel, offLabel, onTitle, offTitle } for hood
      const label = ov ? (on ? ov.onLabel : ov.offLabel) : ((on ? '🚫 ' : g[1] + ' ') + g[2]);
      const title = ov
        ? (on ? ov.onTitle : ov.offTitle).replace(/%WHO%/g, who)
        : ((on ? 'Show ' : 'Hide ') + who + '’s ' + g[2].toLowerCase() + ' — ' + g[3]);
      const busyMsg = ov
        ? (on ? 'Putting ' + who + '’s hood back on…' : 'Taking ' + who + '’s hood off…')
        : ((on ? 'Showing ' : 'Hiding ') + who + '’s ' + g[2].toLowerCase() + '…');
      box.append(h('button', {
        class: 'fq-set' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': String(on),
        disabled: gearBusy ? true : null,
        title: title,
        onClick: function (e) {
          e.stopPropagation();
          if (gearBusy || !fid) return;
          gearBusy = true;
          fqStatus = { msg: busyMsg, ok: true, pending: true };
          toGame('fdGear', JSON.stringify({ op: 'toggle', formId: fid, group: g[0] }));
          renderQuickCard();
        },
      }, label));
    });
    return box;
  }

  /* Better FaceLight state (C++ -> deck, reply to bflGet and rider on every
     bflSet). The FIRST arrival also answers "is the mod even installed" —
     until then the 💡 draws nowhere. */
  /* SPID Gear state (C++ → deck, reply to sgGet and rider on every inbox
     harvest). The FIRST arrival also answers "is the DLL new enough" — until
     then the 📦 draws nowhere. */
  window.sgState = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    sgPresent = env.present !== false;
    if (sgPresent && (env.formId || env.formId === 0))
      sgCache[sgKeyOf(env.formId)] = { at: Date.now(), env: env };
    renderQuickCard();
  };

  window.sgResult = function (env) {
    env = coerce(env);
    if (!env) return;
    if (env.msg) toast((env.ok === false ? '⚠ ' : '📦 ') + env.msg);
    /* A harvest/removal changed the roster — the manager modal (if open)
       re-reads so its list lands on the DLL's truth. */
    if (window.HDSpidGear && HDSpidGear.isOpen()) HDSpidGear.refresh();
  };

  window.fxState = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    /* anyPresent=false means NO registered effect's mod is on this load
       order — the ✨ stays hidden (bfl's present:false discipline). An
       ok:false (actor unloaded) leaves fxPresent untouched. */
    if (env.ok !== false) fxPresent = env.anyPresent !== false;
    if (env.formId || env.formId === 0)
      fxCache[fxKey(env.formId)] = { at: Date.now(), env: env };
    if (fxModalCtx && fxModalCtx.formId === ((Number(env.formId) || 0) >>> 0))
      fillFxModal();
    renderQuickCard();
  };

  window.fxResult = function (env) {
    env = coerce(env);
    if (!env) return;
    if (env.msg) toast((env.ok === false ? '⚠ ' : '✨ ') + env.msg);
    /* A successful skin apply/clear CLOSES the palette (the party-orders
       law): SkinShift's swap routes textures through a donor object whose 3D
       must load, and a paused game makes no progress — the queued apply can
       even time out. C++'s HUD notification survives the close; reopening
       the modal re-reads the live truth. */
    if (env.ok !== false && typeof env.id === 'string' &&
        env.id.indexOf('skinshift:') === 0 &&
        typeof requestClose === 'function')
      requestClose();
    /* Otherwise the fresh fxState C++ sends right behind this reply repaints
       the modal's rows; nothing else to do here. */
  };

  window.bflState = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    bflPresent = env.present !== false;
    if (bflPresent && (env.formId || env.formId === 0))
      bflCache[bflKey(env.formId)] = { at: Date.now(), env: env };
    renderQuickCard();
  };

  window.bflResult = function (env) {
    env = coerce(env);
    if (!env) return;
    if (env.msg) toast((env.ok === false ? '⚠ ' : '💡 ') + env.msg);
    /* Re-light finishes ~1.2 s AFTER this reply (the delayed re-add) — one
       forced re-read after that beat, so the icon flips to the truth. */
    if (env.op === 'relight') {
      setTimeout(function () {
        const s = quickSubject();
        const t = s || state.target;
        if (t && t.formId) askFacelight(t.formId, true);
      }, 1800);
    }
  };

  window.fdGearResult = function (env) {
    gearBusy = false;
    env = env && typeof env === 'object' ? env : {};
    if (env.error && /isn.t loaded/i.test(env.error)) {
      gearState = { unavailable: true };
      fqStatus = { msg: env.error, ok: false, pending: false };
    } else if (env.ok) {
      gearState = { formId: env.formId, hidden: env.hidden || {} };
      fqStatus = { msg: 'Gear updated for ' + (env.name || 'her'), ok: true, pending: false };
    } else {
      fqStatus = { msg: env.error || 'Gear toggle refused', ok: false, pending: false };
    }
    renderQuickCard();
  };

  window.fdWorn = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    const key = String(env.formId || '').toLowerCase();
    /* Store under BOTH the reported formId and the key we asked with: a
       crosshair request carries no formId outbound but comes back with one,
       and the menu that is open looks itself up by member formId. */
    const rec = {
      ok: env.ok !== false,
      msg: typeof env.msg === 'string' ? env.msg : '',
      who: env.who || '',
      following: !!env.following,
      dead: !!env.dead,
      outfit: env.outfit || null,
      /* The engine dossier travels with the worn set — copy it through, or the
         card's Lv / race / essential / health chips silently never appear. */
      about: (env.about && typeof env.about === 'object') ? env.about : null,
      items: Array.isArray(env.items) ? env.items : [],
    };
    /* An EMPTY formId is not "no answer" — it is the answer about the crosshair
       target, which is exactly the slot the quick card reads (equippedFor(null)
       looks up ''). Storing it unconditionally means a reply that arrives with
       no ask pending (a push, a seeded preview) is kept rather than dropped. */
    state.equipped[key] = rec;
    if (equippedPending !== null && equippedPending !== key) state.equipped[equippedPending] = rec;
    equippedPending = null;
    /* A fresh engine read outranks an optimistic rank — but only once the write
       it was covering for has been answered. Dropping it while still `pending`
       would let a read that raced the Papyrus stack snap the slider back to the
       old value for a beat and then forward again. */
    if (rankEdit.key !== null && !rankEdit.pending && Number(rankEdit.key) === Number(env.formId)) {
      rankEdit = { key: null, has: false, rank: 0, pending: false };
    }
    refreshOpenMenu();
    renderQuickCard();
    /* The ⧉ Copy floater is drawn FROM this reply and is usually opened before
       it lands ("Reading what she is wearing…"). It is not part of the card, so
       renderQuickCard() above does not reach it. */
    if (window.HDOutfit && HDOutfit.isOpen()) HDOutfit.refresh();
  };

  /* fdRankInfo: the reply to `fdRank` — the engine's relationship rank, and the
     acknowledgement of a change. Disjoint from the request name on purpose; a
     receiver named `fdRank` would swallow every outbound message and the whole
     control would go quiet (see [[prismaui-one-name-per-direction]]).

     `wrote:true` means the Papyrus stack was QUEUED, not that it ran, so this
     only clears the pending flag — the verify read scheduled by sendRank is
     what actually settles the number. */
  window.fdMarriageResult = function (env) {
    env = coerce(env);
    if (!env || !Number(env.formId)) return;
    if (env.msg) toast(env.msg);
    askEquipped({formId:env.formId}, true);
    toGame('fdRefresh', ''); // Read the framework's new status; never invent it.
  };

  window.fdRankInfo = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    if (!env.formId) return;
    const key = hexOf(Number(env.formId)).toLowerCase();
    if (rankEdit.key !== key) return;
    if (env.ok === false) {
      /* A refusal must not leave the optimistic value on screen pretending to
         be the truth — drop it and let `about` answer again. */
      if (rankEdit.key === key) rankEdit = { key: null, has: false, rank: 0, pending: false };
      fqStatus = { msg: env.msg || 'Could not change that', ok: false, pending: false };
      renderQuickCard();
      return;
    }
    if (typeof env.rank === 'number') {
      rankEdit = {
        key: key,
        has: env.has !== false,
        rank: clampRank(env.rank),
        pending: false,
      };
    } else if (rankEdit.key === key) {
      rankEdit.pending = false;
    }
    if (env.wrote && env.msg) fqStatus = { msg: env.msg, ok: true, pending: false };
    renderQuickCard(); refreshOpenMenu();
  };

  /* fdFertility: Fertility Mode pregnancy / cycle, pushed by C++ on the same
     rail as fdNff (src/fertility_bridge.cpp). Envelope is
     { ok, available, tracked, pregnant, actors: { "0x000A2C8C": {…} } }.
     FM absent => available:false and an empty map, and the roster renders
     exactly as it does without the mod. */
  window.fdFertility = function (env) {
    env = coerce(env);
    const actors = (env && typeof env.actors === 'object' && env.actors) ? env.actors : {};
    const map = {};
    Object.keys(actors).forEach(function (k) {
      const v = actors[k];
      if (v && typeof v === 'object') map[String(k).toLowerCase()] = v;
    });
    /* `tracked` / `pregnant` are FM's OWN tallies over the whole payload
       (src/fertility_bridge.cpp) and were being dropped here. The Household
       tab needs them to tell "nobody is pregnant" apart from "FM is tracking
       nobody yet" — the roster row never asked, so nothing missed them. */
    state.fert = {
      available: !!(env && env.available),
      tracked: (env && typeof env.tracked === 'number') ? env.tracked : null,
      pregnant: (env && typeof env.pregnant === 'number') ? env.pregnant : null,
      actors: map,
    };
    remergeFert();
    refreshOpenMenu();
    if (isActive()) renderList();
    /* The Household tab reads this pane's roster (householdRoster), so a
       pregnancy push must repaint it too — it is a different tab and
       isActive() above is only ever true for ours. */
    try { if (window.HouseholdPane) HouseholdPane.dataChanged(); } catch (e) {}
  };

  window.fdSaved = function (ok) {
    if (ok === false || ok === 'false') toast('⚠ Save failed — check HotkeyDeck.log');
  };

  /* fol open-key config arrives inside hdOpen's payload (followers.openKey);
     app.js forwards it here. */
  window.fdConfig = function (cfg) {
    cfg = coerce(cfg) || {};
    const ok = cfg.openKey || {};
    state.openKey = {
      device: ok.device || 'keyboard',
      code: (ok.code >>> 0) || 101,
      label: ok.label || 'F14',
    };
    state.avatarPx = clampAv(cfg.avatarPx);
    if (cfg.dossierFrames && typeof cfg.dossierFrames === 'object' && !Array.isArray(cfg.dossierFrames)) {
      state.dossierFrames = {};
      Object.keys(cfg.dossierFrames).slice(0,400).forEach(function(k){
        if (k !== '__proto__' && k.length <= 256) state.dossierFrames[k] = dossierFrameValue(cfg.dossierFrames[k]);
      });
    }
    if (cfg.dossierSizePct !== undefined) state.dossierSizePct = clampDossierSize(cfg.dossierSizePct);
    const dossier = document.getElementById('fd-ctx-menu');
    if (dossier && dossier._dossier) dossier._dossier.applySize();
    applyAvatarSize();
    state.uiScale = clampUi(cfg.uiScale);
    applyUiScale();
    /* Independent category-icon size. Absent (older DLL/portal) -> IC_DEF via
       clampIc, so an old config keeps the pre-slider look rather than 0-ing. */
    state.railIconPct = clampIc(cfg.railIconPct);
    applyAvatarSize();   // re-derive --fd-railic-px now the scale is known
    /* Quick-card action-labels preference (icons vs. always-labelled pills). */
    state.fqLabels = !!cfg.fqLabels;
    /* Collapsed category rail preference. */
    state.railCollapsed = !!cfg.railCollapsed;
    /* Category icons. Re-validated here as well as in C++: fdConfig is the one
       input the pane cannot see the provenance of, and the same three rules
       apply on both sides — a real slot index (0..CAT_MAX), a loadable
       view-relative path, nothing else kept. Rebuilt into a FRESH object so a
       key that has since been cleared cannot survive a reconfigure. */
    const src = cfg.catIcons;
    const next = {};
    if (src && typeof src === 'object') {
      for (const k in src) {
        if (!/^\d{1,3}$/.test(k)) continue;
        const idx = Number(k);
        if (!(idx >= 0 && idx <= CAT_MAX)) continue;
        const p = iconSrc(src[k]);
        if (p) next[String(idx)] = p;
      }
    }
    state.catIcons = next;
    if (isActive()) renderRail();
  };
})();
