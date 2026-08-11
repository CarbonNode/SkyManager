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
    /* Row avatar diameter. 0 = "use the stylesheet's default" — kept as 0
       rather than 40 so the default is defined in exactly one place. */
    avatarPx: 0,
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
      file: p ? p.file : '', mtime: p ? p.mtime : 0,
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
        return portraitFor({ original: id, name: id });
      });
    }
    Recents.render(host, openFromRecents);
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
    document.body.appendChild(modal);
    fillHudModal();
  }

  /* Click a face → her action menu, next to the chip.
     Resolved by IDENTITY first: cat/idx are a hint that goes stale the moment
     anyone is re-filed or removed, and opening the menu on whoever happens to
     occupy that slot now would be worse than not opening one. */
  function openFromRecents(entry, chipEl) {
    let found = null;
    state.cats.forEach((c) => {
      (c.members || []).forEach((m, i) => {
        if (found) return;
        if ((m.original || m.name) === entry.id) found = { cat: c.index, idx: i, m: m, catName: catLabel(c) };
      });
    });
    if (!found) {
      toast('“' + entry.name + '” is no longer in the roster');
      return;
    }
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
       being a menu and starts being a page on an ultrawide. */
    return Math.max(260, Math.min(Math.max(ramped, share), vp.w - 24, 1180));
  }

  /* Put it in the MIDDLE, not under the cursor.
     A menu this size anchored at the click lands hard against one edge and
     covers the row you were reading. Centred horizontally, and high in the
     upper third vertically rather than dead-centre, so a tall one still has
     room to grow downward before the clamp starts fighting it. Still
     draggable — this is only where it starts. */
  function centerCtx() {
    const vp = ctxViewport();
    const w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
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

  function cropFor(file) {
    const f = String(file || '');
    return f && state.crops[f] ? state.crops[f] : null;
  }

  /* Paint a crop onto the <img> that carries the face. transform-origin is the
     centre because clampCrop's slack maths assumes a centred scale; translate
     comes FIRST in the list so its percentages are of the untransformed box and
     therefore mean exactly "x frame-widths", independent of z. */
  function applyCropTo(face, file) {
    if (!face) return face;
    const c = cropFor(file);
    if (!c) {
      face.style.transform = '';
      face.style.objectPosition = '';
      return face;
    }
    face.style.transformOrigin = '50% 50%';
    face.style.transform = 'translate(' + (c.x * 100).toFixed(3) + '%,' +
      (c.y * 100).toFixed(3) + '%) scale(' + c.z.toFixed(4) + ')';
    /* The uncropped medallion biases the cover-crop upward (object-position
       50% 22%) because faces sit high in a screen grab. A deliberate crop is
       the user saying where the face is, so the guess must get out of its way —
       otherwise the editor and the row would disagree by 28% of the frame. */
    face.style.objectPosition = '50% 50%';
    return face;
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

  function openLightbox(d, startEditing) {
    closeLightbox();
    if (!d || !d.slug) return;
    /* `file` is the real filename — a re-capture of someone the deck has already
       drawn lands as `<slug>~<n>.png`, so slug + ext no longer rebuilds it. The
       old form stays as the fallback for a dataset written before that change. */
    const file = d.file || (d.slug + '.' + (d.ext || 'png'));
    const base = 'portraits/' + file;
    const img = h('img', {
      class: 'fd-lb-img',
      src: base + '?v=' + (d.mtime || 0),
      alt: d.name || '',
      draggable: 'false',
    });
    // Same query-hostile-loader retry the row medallion needs.
    let retried = false;
    img.addEventListener('error', function () {
      if (retried) { closeLightbox(); return; }
      retried = true;
      img.src = base;
    });

    const side = lbFrameSize();
    const frame = h('div', { class: 'fd-lb-frame' }, img);
    frame.style.width = side + 'px';
    frame.style.height = side + 'px';
    applyCropTo(img, file);

    const foot = h('div', { class: 'fd-lb-foot' });

    lightbox = h('div', {
      class: 'fd-lb',
      /* Backdrop click closes — but ONLY while not editing. A pan that ends
         with the pointer outside the frame releases on the backdrop, and
         throwing the edit away for that would be indistinguishable from a bug. */
      onClick: function () { if (!lbEdit) closeLightbox(); },
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
    if (startEditing) beginCrop(d, file, img, frame, foot);
  }

  /* Not editing: one button, and the current framing spelled out so you can see
     at a glance whether this face carries a crop at all. */
  function renderLbFoot(d, file, img, frame, foot) {
    foot.textContent = '';
    const c = cropFor(file);
    foot.append(h('button', {
      class: 'fd-lb-btn', type: 'button',
      title: 'Pan and zoom this photo. Nothing is re-saved to disk — the deck '
           + 'remembers the framing and draws it everywhere this face appears.',
      onClick: function (e) { e.stopPropagation(); beginCrop(d, file, img, frame, foot); },
    }, '✎ Adjust this photo'));
    foot.append(h('span', { class: 'fd-lb-val' }, c ? cropPhrase(c) : 'original framing'));
  }

  /* ---- the crop editor -------------------------------------------------
     Everything is a BUTTON or a drag; there is no <input type=range> and no
     <select>, because in Ultralight the first is a poor target and the second
     renders but never opens (see rankRow for the same reasoning). The wheel is
     wired as a convenience only — every gesture it offers has a button beside
     it, so a click-only (gamepad-ish) flow reaches every value. */
  function beginCrop(d, file, img, frame, foot) {
    const start = cropFor(file);
    lbEdit = { file: file, z: start ? start.z : 1, x: start ? start.x : 0, y: start ? start.y : 0 };
    /* Everything the keyboard path needs to finish the edit. onKey sees only
       `lbEdit`, and re-deriving these five from the DOM would be a second,
       drift-prone way of naming the same nodes. */
    lbEdit.ctx = { d: d, file: file, img: img, frame: frame, foot: foot };
    frame.classList.add('editing');
    renderCropFoot(d, file, img, frame, foot);
    wireCropGestures(d, file, img, frame, foot);
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
    if (c) {
      img.style.transformOrigin = '50% 50%';
      img.style.transform = 'translate(' + (c.x * 100).toFixed(3) + '%,' +
        (c.y * 100).toFixed(3) + '%) scale(' + c.z.toFixed(4) + ')';
      img.style.objectPosition = '50% 50%';
    } else {
      img.style.transform = '';
      img.style.objectPosition = '';
    }
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
      btn('✓ Save', 'Use this framing everywhere this face is drawn',
        () => commitCrop(d, file, img, frame, foot), 'ok'),
      btn('✕ Cancel', 'Leave the framing as it was',
        () => cancelCrop(d, file, img, frame, foot)),
      h('span', { class: 'fd-lb-val' }, cropPhrase(clampCrop(lbEdit))),
      h('div', { class: 'fd-lb-hint' },
        'Drag the photo to move it · wheel or ＋/－ to zoom · this changes how the '
        + 'deck DRAWS it, the file on disk is untouched'));
  }

  function wireCropGestures(d, file, img, frame, foot) {
    let dragging = false, lastX = 0, lastY = 0;
    /* Gain: one pixel of pointer travel moves the photo one pixel, which is the
       only mapping that feels like dragging a photo. The frame's px size is the
       divisor because x/y are stored as fractions of it. */
    const side = frame.offsetWidth || lbFrameSize();

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
      const dx = (e.clientX - lastX) / side;
      const dy = (e.clientY - lastY) / side;
      lastX = e.clientX; lastY = e.clientY;
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
    if (lbEdit && lbEdit.unwire) lbEdit.unwire();
    lbEdit = null;
    if (frame) frame.classList.remove('editing', 'dragging');
  }

  function cancelCrop(d, file, img, frame, foot) {
    endCropMode(frame);
    applyCropTo(img, file);        // back to whatever is stored
    renderLbFoot(d, file, img, frame, foot);
  }

  function commitCrop(d, file, img, frame, foot) {
    const c = clampCrop(lbEdit);
    endCropMode(frame);
    /* Optimistic: the map is updated here and every drawn face repaints now.
       C++ owns the file, so it will push the authoritative map back as fdCrops
       — including a prune we cannot compute here — and that push wins. */
    if (c) state.crops[file] = c;
    else delete state.crops[file];
    /* `clear` rather than a z=1 crop, so C++ never has to decide whether an
       identity crop means "remove me" — the two are the same thing and saying
       so explicitly keeps the map free of no-op rows. */
    toGame('fdCropSave', JSON.stringify(c
      ? { file: file, z: c.z, x: c.x, y: c.y }
      : { file: file, clear: true }));
    applyCropTo(img, file);
    renderLbFoot(d, file, img, frame, foot);
    if (isActive()) renderList();
    renderQuickCard();
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
  function whereChip(m, q) {
    if (!m.where) return null;
    if (m.homeName && m.where === m.homeName) return null;
    const chip = h('span', {
      class: 'fd-chip fd-chip-where' + (m.whereLoaded ? '' : ' stale'),
      title: m.whereLoaded ? ('Here now: ' + m.where)
                           : ('Last known: ' + m.where + '\nNot loaded right now, so this is where '
                              + 'the game still has them — not a live sighting.'),
    });
    chip.append(h('span', { class: 'fd-where-ic', 'aria-hidden': 'true' },
      m.whereLoaded ? '◈ ' : '◇ '));
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
    chip.append(h('span', { class: 'fd-home-ic', 'aria-hidden': 'true' }, '⌂ '));
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

  function canSetKind(k) { return SETTABLE_KINDS.indexOf(k) >= 0; }

  function sendMhiyh(op, m, kind) {
    const msg = { op: op, formId: m.formId || '', name: m.name || '' };
    if (typeof kind === 'number') msg.kind = kind;
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
    return { formId: String(m.formId || ''), name: String(m.name || '') };
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
    box.append(h('button', {
      class: 'fq-set', type: 'button',
      title: 'Every NPC with SPID grants — items, dates, chances, removal',
      onClick: (e) => { e.stopPropagation();
        if (window.HDSpidGear) HDSpidGear.open(); },
    }, '⚙ All grants…'));
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
      portrait: shot ? ('portraits/' + shot.file) : '',
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
    toGame('fdPortrait', JSON.stringify({ formId: hex }));
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
    ctxEl.style.maxHeight = Math.max(240, ctxViewport().h - 24) + 'px';
    ctxEl.style.overflowY = 'auto';
    /* CENTERED on screen, not anchored to the ⚙ Stats button (Rober,
       2026-08-05: "stats needs to open centered on screen"). Measure the built
       panel, then clamp it to the middle of the viewport. */
    const vp = ctxViewport();
    const h0 = ctxEl.offsetHeight || 320;
    clampCtx(Math.max(8, (vp.w - w) / 2), Math.max(8, (vp.h - h0) / 2));
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
  function wornIconFor(it) {
    if (!it || !it.formId || !it.plugin) return '';
    const wp = (typeof window !== 'undefined') ? window.WardrobePane : null;
    const idx = wp && wp._state && wp._state.itemIcons;
    if (!idx) return '';
    const key = String(it.formId).toUpperCase() + '|' + String(it.plugin).toLowerCase();
    return idx[key] || '';
  }

  /* Rendered gear pictures land ASYNCHRONOUSLY: the fdEquipped reply queues
     Mesh Rendering Framework renders and each finished batch re-pushes the
     wdItemIcons index. The Wardrobe receiver fires this event only when the
     index actually changed, and renderQuickCard self-guards when no card is
     mounted — so tiles upgrade glyph → picture as renders arrive, and a
     no-change push repaints nothing. */
  document.addEventListener('hd-item-icons', function () {
    try { renderQuickCard(); } catch (e) { /* card not mounted yet */ }
  });

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

  function wspinSrcAt(base, i) {
    if (!base || !i) return base || '';
    const suffix = '-a' + ('00' + (i * WSPIN_STEP)).slice(-3);
    const q = base.indexOf('?');           // Ultralight caches by URL; keep any ?v= intact
    const path = q >= 0 ? base.slice(0, q) : base, tail = q >= 0 ? base.slice(q) : '';
    const dot = path.lastIndexOf('.'), slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (dot <= slash) return path + suffix + tail;       // no extension → append
    return path.slice(0, dot) + suffix + path.slice(dot) + tail;
  }
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
    wspinProbe();
    wspinPaint();
  }
  function wspinLand(key, i, url) {
    if (wornSpinCache[key]) wornSpinCache[key].frames[i] = url;
    if (!wornSpin || wornSpin.key !== key || wornSpin.frames[i]) return;
    wornSpin.frames[i] = url; wspinPaint();
  }
  function wspinProbe() {
    if (!wornSpin) return;
    const sp = wornSpin;
    if (sp.poll) { clearTimeout(sp.poll); sp.poll = null; }
    let missing = 0;
    for (let i = 1; i < WSPIN_N; i++) {
      if (sp.frames[i]) continue;
      missing++;
      const url = wspinSrcAt(sp.base, i) + (sp.tries ? (sp.base.indexOf('?') >= 0 ? '&' : '?') + 'sp=' + sp.tries : '');
      const key = sp.key;
      const probe = new Image();
      probe.onload = () => wspinLand(key, i, url);
      probe.onerror = () => {};        // not baked yet — the next pass re-asks
      probe.src = url;
    }
    if (!missing || sp.tries >= WSPIN_POLL_TRIES) return;
    sp.tries++;
    sp.poll = setTimeout(wspinProbe, WSPIN_POLL_MS);
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
    if (key && wornSpin.frames.some((f, i) => i > 0 && f)) { wornSpin.asked = true; wspinProbe(); }
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
  function equippedContainer(m, who) {
    const data = equippedFor(m);
    /* NOT .fq-sets — that class is the Outfit set-picker's identifier; this is a
       cgroup like Order/Move/Home. */
    const box = h('div', { class: 'fq-cgroup fq-equip' });
    const count = data && data.ok ? String((data.items || []).length) : '…';
    /* Just the label + count — Hide/Delete live on each tile's hover flyout now
       (Rober, 2026-08-05: "no need for a button"). */
    box.append(h('span', { class: 'fq-sets-lbl fq-equip-head' },
      h('span', { class: 'fq-cg-ic' }, groupIcon('equip')), 'Equipped',
      h('span', { class: 'fq-equip-ct' }, count)));
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
    const grid = h('div', { class: 'fq-equip-grid' });
    items.forEach(function (it) {
      const url = wornIconFor(it);
      const tile = h('div', {
        class: 'fq-equip-tile' + (url ? ' haslb' : '') + (it.outfit ? ' outfit' : ''),
        title: it.name + (it.plugin ? '\n' + it.plugin : '')
             + (url ? '\nClick to see it large — then drag to turn it' : ''),
        onClick: () => { if (url) openWornLightbox(url, it.name, it); },
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
      /* A hover FLYOUT on the tile itself (Rober, 2026-08-05): Hide (cull the
         3D, keeps it equipped) + Delete. No separate button. */
      const fly = h('div', { class: 'fq-equip-fly' });
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
      grid.append(tile);
    });
    box.append(grid);
    return box;
  }

  function equippedBlock(m) {
    const box = h('div', { class: 'fd-eq' + (ui.eqOpen ? ' open' : '') });
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
    const head = h('button', {
      class: 'fd-eq-head', type: 'button',
      'aria-expanded': String(!!ui.eqOpen),
      title: 'Everything they have on, read off the engine — including pieces the '
           + 'container menu may hide because they belong to an outfit.',
      onClick: (e) => {
        e.stopPropagation();
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
      h('span', { class: 'fd-eq-caret' }, ui.eqOpen ? '▾' : '▸'),
      h('span', { class: 'fd-eq-title' }, 'Equipped'),
      h('span', { class: 'fd-eq-count' }, count));
    box.append(head);

    if (!ui.eqOpen) return box;

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
    if (!acts.length && !hasHome && !m.inWorld) return null;

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
        h('span', { class: 'fd-day-dot', 'aria-hidden': 'true' }, a.spec.ic),
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
  function medalEl(m, catIndex) {
    const hue = String(hueOf(catIndex));
    const p = portraitFor(m);
    if (!p) return initialsMedal(m, hue);
    /* ?v=<mtime> is the cache-bust that makes "replace a portrait mid-session"
       show (Ultralight caches view-relative images by URL). But Ultralight's
       view loader can also treat the query as part of the FILENAME — proven
       in-game 2026-07-28: the C++ scan found a follower's .jpg and pushed it,
       yet the img errored to initials. So: try the query form first, retry the
       plain path once on error, and only then fall back to the medallion. */
    const plain = 'portraits/' + p.file;
    const face = h('img', {
      class: 'medal-face',
      src: plain + '?v=' + p.mtime,
      alt: '',
      draggable: 'false',
    });
    applyCropTo(face, p.file);

    const wrap = h('span', {
      class: 'medal img' + (m.following ? ' following' : '') + (m.dead ? ' dead' : ''),
    }, face);
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

  /* Enter focus — only meaningful with a real crosshair NPC to focus ON. */
  function enterFocus() {
    if (!state.target || !state.target.name) return false;
    ui.npcFocus = true;
    ui.focusRosterOpen = false;
    ui.fqFold = false;   // the dedicated view wants the WHOLE dossier, not name-only
    applyFocusChrome();
    renderQuickCard();
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
    const canFocus = !!(state.target && state.target.name && state.targetKnown);
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

  function render() { renderHudCard(); renderRail(); renderList(); renderAdd(); syncQuickHere(); syncChrome(); applyFocusChrome(); renderEveryoneBar(); }

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

  /* The icon set for one category slot, '' when it has none. Reads through
     iconSrc so a poisoned config draws nothing rather than a broken box. */
  function catIconOf(index) {
    return iconSrc(state.catIcons[String(index)] || '');
  }

  /* Does ANY category carry an icon? Drives whether the un-iconed rows reserve
     an empty slot. Reserving unconditionally would indent every rail on every
     rig — including one that never touches this feature — and the brief is
     explicit that a category with no icon keeps today's look. Reserving only
     when the rail is MIXED is what keeps the names on one vertical line. */
  function anyCatIcon() {
    for (const k in state.catIcons) if (catIconOf(k)) return true;
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
      title: forEdit ? 'Change the icon for “' + label + '”' : label,
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
      grid.textContent = '';

      /* "Auto / None" first and always visible — clearing must never be behind
         a scroll, and it is the only way back to the plain rail row. */
      const none = h('button', {
        class: 'fd-catic-tile none' + (cur ? '' : ' on'), type: 'button',
        title: 'No icon — “' + label + '” goes back to the plain rail row',
        onClick: (e) => { e.stopPropagation(); closeCtx(); setCatIcon(c.index, ''); },
      }, h('span', { class: 'fd-catic-x' }, '⦸'), h('span', { class: 'fd-catic-lbl' }, 'Auto'));
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
    const medal = medalEl(pseudo, known ? known.cat.index : 0);
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
    return out;
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
        openMemberMenu(row, e.clientX, e.clientY);
      },
      onContextmenu: (e) => { e.preventDefault(); openMemberMenu(row, e.clientX, e.clientY); },
      // pointer-drag: onto another category's rail row (move) or between rows
      // of the same category (reorder; not in All / while searching). The
      // engine swallows the drop's click so it never opens the member menu.
      onMousedown: (e) => PDrag.arm(e, {
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
      }),
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
      h('div', { class: 'fd-right' }, badgeEls(m)),
    );
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

    list.textContent = '';
    const empty = $('fd-empty');
    if (!vis.length) {
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
      let lastCat = null, sec = null;
      vis.forEach((r, i) => {
        if (!grouped) { list.append(memberRow(r, i)); return; }
        if (r.catName !== lastCat) {
          sec = h('div', { class: 'fd-sec' }, groupHeader(r.catName, runs.get(r.catName)));
          list.append(sec);
          lastCat = r.catName;
        }
        sec.append(memberRow(r, i));
      });

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
    const key = String((t && t.formId) || '');
    const about = (equippedFor(null) || {}).about || null;
    if (rankEdit.key !== null && rankEdit.key === key) {
      return { known: true, has: rankEdit.has, rank: clampRank(rankEdit.rank),
               pending: rankEdit.pending };
    }
    /* No `rank` on the dossier means the DLL is older than this feature. That
       is not "Acquaintance" — it is no answer, and drawing a slider parked at 0
       would invite you to "confirm" a rank the game never reported. */
    if (!about || typeof about.rank !== 'number') return { known: false };
    return { known: true, has: !!about.relHas, rank: clampRank(about.rank), pending: false };
  }

  /* Commit a rank. Optimistic on purpose — the slider must not snap back to the
     old value for the second the VM takes — but the optimism is BOUNDED: a
     verify read is scheduled, and whatever the engine says then wins. */
  function sendRank(v) {
    const t = state.target;
    if (!t || !t.formId) return;
    const r = clampRank(v);
    rankEdit = { key: String(t.formId), has: true, rank: r, pending: true };
    fqStatus = { msg: 'Making ' + (t.name || 'them') + ' ' + rankLabel(r) + '…',
                 ok: true, pending: true };
    toGame('fdRank', JSON.stringify({ formId: hexOf(t.formId), rank: r }));
    renderQuickCard();

    /* Re-read the ENGINE once the VM has plausibly run. Without this a stack
       the VM silently dropped would leave the card showing a rank that was
       never applied — the exact class of lie the NPC-actions work was about.
       Forced past askEquipped's same-key gate because this is a TIMER, not an
       fdWorn reply, so it cannot re-enter the request loop that gate exists to
       break. */
    if (rankVerify) clearTimeout(rankVerify);
    rankVerify = setTimeout(function () {
      rankVerify = 0;
      askEquipped(null, true);
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
  function rankRow(t, who) {
    const rv = rankView(t);
    if (!rv.known) return null;

    const row = h('div', { class: 'fq-rank' + (rv.has ? '' : ' unset') },
      h('span', { class: 'fq-sets-lbl', title:
        'What SKYRIM thinks of you — the relationship rank the game itself branches on '
        + '(dialogue, followers, marriage). Not the Relationship you typed in her fields.' },
        'Rank'));

    const val = h('span', {
      class: 'fq-rank-val' + (rv.rank > 0 ? ' good' : (rv.rank < 0 ? ' bad' : '')),
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
      val.className = 'fq-rank-val' + (c > 0 ? ' good' : (c < 0 ? ' bad' : ''));
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
        if (n !== rv.rank) { rankFocus = true; sendRank(n); }
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
          sendRank(dragTo);
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
      onClick: (e) => { e.stopPropagation(); rankFocus = true; sendRank(rv.rank + delta); },
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
      title: 'Warp every follower to you — including the ones in another hold.' },
    /* 'Follow all' removed at Rober's request (2026-08-05). */
    { op: 'allWait',    ic: '\u270b', label: 'Wait',
      title: 'Everyone nearby waits where they stand.' },
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
      const plain = 'portraits/' + p.file;
      const face = h('img', {
        class: 'fq-crew-img',
        src: plain + (p.mtime ? '?v=' + p.mtime : ''),
        alt: '',
        draggable: 'false',
      });
      applyCropTo(face, p.file);
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
    const acts = h('div', { class: 'fq-acts' });
    PARTY_ACTS.forEach(function (p) {
      acts.append(quickBtn(p.ic, p.label, p.title, function () { sendParty(p.op); }));
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
    const hit = ui.fqPick ? rosterEntryFor(ui.fqPick) : null;
    if (ui.fqPick && !hit) ui.fqPick = '';    // she left the roster; fall back
    return hit ? hit.m : null;
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

  function buildQuickCard() {
    const subj = quickSubject();
    const t = subj
      ? { name: subj.name, formId: subj.formId, following: !!subj.following,
          dead: !!subj.dead, picked: true }
      : state.target;
    const card = h('div', { class: 'fq' + (subj ? ' picked' : '') });

    if (!state.targetKnown) {
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
       roster draws, so a face means the same thing on both surfaces. */
    const known = rosterEntryFor(who);
    const pseudo = known ? known.m : { name: who, original: who, following: following, dead: dead };
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
      sub.append(h('span', { class: 'fq-chip', title: 'Filed in Follower Organizer' },
        catLabel(known.cat)));
    } else {
      sub.append(h('span', { class: 'fq-chip new', title:
        'Not in Follower Organizer yet — file them below' }, 'unfiled'));
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
               : (following ? h('span', { class: 'fq-tag following' }, 'Following') : null)),
        ui.fqFold ? null : sub),
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
          title: 'Back to the party — stop acting on ' + who,
          onClick: (e) => { e.stopPropagation(); ui.fqPick = ''; renderQuickCard(); syncQuickHere(); },
        }, '\u2190') : null,
        /* Photograph them. Same bridge the roster's menu uses, and it names its
           subject explicitly, so it captures whoever you are looking at rather
           than whatever the crosshair drifts onto. "Replace" once one exists —
           a portrait the deck has drawn is memory-mapped and cannot be
           overwritten, so the capture lands versioned and the newest wins. */
        h('button', {
          class: 'fq-iconbtn', type: 'button',
          disabled: dead ? true : null,
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
          title: 'Sharmat profile — CHIM’s kinks / speak style / status for ' + who + '.\nEdits are LIVE.',
          onClick: (e) => { e.stopPropagation();
            SmPane.open((known && known.m.original) || who, who); },
        }, '⚭') : null,
        /* Annotate someone you just met without going to the Followers tab.
           Filed followers only — the fields live on an FO entry. */
        known ? h('button', {
          class: 'fq-iconbtn' + (ui.fqEdit ? ' on' : ''), type: 'button',
          'aria-pressed': String(!!ui.fqEdit),
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

    if (ui.fqFold) return card;

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
          () => { toGame('fdPortrait', JSON.stringify({
            formId: subj ? (Number(subj.formId) || 0) : (state.target ? state.target.formId : 0) })); }),
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
                             mtime: shot.mtime, name: who }, true);
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
      /* Animate (Rober, 2026-08-08: "if I hit F7 I can also click the animations
         tab and apply to them easily"). Jumps to the Animations tab aimed at the
         person you F7'd — the Poses target is the crosshair-open snapshot, which
         in F7-focus IS this NPC — and forces the Poses segment (not OStim, which
         is player-scene control). setTab handles leaving focus, like Preset. */
      quickBtn('🕺', 'Animate', dead ? who + ' is dead'
          : 'Open the Animations tab aimed at ' + who + ' — OStim scene controls if '
            + 'you’re in a scene, otherwise poses',
        () => {
          // Smart: OStim segment while a scene runs, Poses otherwise.
          if (window.OStimPane && OStimPane.smartLand) OStimPane.smartLand();
          else if (window.__omniSetTab) window.__omniSetTab('anim');
        },
        { disabled: dead })),
      /* (File / Add-to-category moved to the bottom bar under STATS — Rober,
         2026-08-05: the top ⊞ File icon duplicated the prominent "+ Add … to a
         category" footer, so the icon is dropped and the footer is the one way.) */
      
      /* Better FaceLight (Rober, 2026-08-06): gold when her facelight is ON,
         the hover title is the state sentence, click reveals the controls.
         Null until the DLL confirms the mod — nothing renders on a rig
         without it. */
      bflQuickBtn(t, who, dead),
      /* (📦 SPID Gear moved into the GEAR group above — it is a container,
         and it sits with the other containers. 2026-08-11.) */
      /* CHIM (Rober, 2026-08-06): one emoji button opening a flyout — CHIM
         Background (the dossier, via Omni Ask), Sharmat Background (the live
         editor), and Activate/Disable NPC (manual AI activation). Owned by
         chim-flyout.js; the button is ours so it matches the row. */
      (window.ChimBtn) ? quickBtn('💬', 'CHIM', dead ? who + ' is dead'
          : 'CHIM tools for ' + who + ' — background, Sharmat profile, and '
            + 'activate / disable manual AI',
        (e) => ChimBtn.open(e.currentTarget, {
          original: (known && known.m && known.m.original) || who,
          who: who, dead: dead,
          formId: subj ? (Number(subj.formId) || 0)
                       : (state.target ? (Number(state.target.formId) || 0) : 0),
        }),
        { disabled: dead }) : null,
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
              return shot ? ('portraits/' + shot.file) : '';
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
       one ask per 1.5 s per person — same loop-breaking gate as askEquipped). */
    if (bflPresent !== false && t && t.formId && !dead) askFacelight(t.formId);

    /* Same discipline for her SPID grants — the 📦 draws itself the moment
       the DLL answers, and stays current while the card is hers. */
    if (sgPresent !== false && t && t.formId && !dead) askSpid(t.formId);

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
        order.append(h('button', {
          class: 'fq-set danger', type: 'button',
          title: 'Send ' + who + ' home through NFF — click twice',
          onClick: (e) => { e.stopPropagation();
            arm(e.currentTarget, 'Dismiss ' + who + '?', 'Click again to send them home',
              () => sendNpc('dismiss', subj)); },
        }, '⊘ Dismiss'));
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
       Only for someone FO already has (the ops address her by form id + name
       out of the roster) and only while she is in the world. */
    if (known && known.m.inWorld) {
      const homeRow = h('div', { class: 'fq-sets fq-cgroup' },
        h('span', { class: 'fq-sets-lbl' }, h('span', { class: 'fq-cg-ic' }, groupIcon('home')), 'Home'));
      homeRow.append(h('button', {
        class: 'fq-set', type: 'button',
        title: 'Make where you are standing ' + who + '’s MHIYH home'
             + (known.m.mhHome ? '\nReplaces: ' + known.m.mhHome : ''),
        onClick: (e) => {
          e.stopPropagation();
          fqStatus = { msg: 'Setting ' + who + '’s home here…', ok: true, pending: true };
          sendMhiyh('setHome', known.m, KIND_HOME);
          renderQuickCard();
        },
      }, '⌂ Home is here'));
      if (known.m.mhHome) {
        homeRow.append(h('button', {
          class: 'fq-set' + (ui.fqArmHome ? ' on' : ''), type: 'button',
          title: ui.fqArmHome ? 'Click again to forget it'
                              : 'Forget ' + who + '’s home (' + known.m.mhHome + ')',
          onClick: (e) => {
            e.stopPropagation();
            if (!ui.fqArmHome) { ui.fqArmHome = true; renderQuickCard(); return; }
            ui.fqArmHome = false;
            fqStatus = { msg: 'Forgetting ' + who + '’s home…', ok: true, pending: true };
            sendMhiyh('forgetHome', known.m, KIND_HOME);
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
      const canSpot = !!known.m.mhHome;
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
          openSpotPicker(e.currentTarget, known, who);
        },
      }, '⚑ Set a spot…'));
      /* Her NFF BASE — the other home, and until now read-only here. Only
         offered when NFF is actually answering AND the player has bases set
         up; an empty picker would be a button that can only disappoint. */
      if (state.nff.nff && state.nff.bases.length) {
        homeRow.append(h('button', {
          class: 'fq-set', type: 'button',
          title: 'Set ' + who + '’s NFF home base'
               + (known.m.nffHome ? '\nCurrently: ' + known.m.nffHome : ''),
          onClick: (e) => { e.stopPropagation(); openNffBase(e.currentTarget, known, who); },
        }, '⌂ NFF base…'));
      }
      /* A little inline card showing WHERE she actually lives — her assigned
         MHIYH home and/or NFF base, with her portrait if the deck has one
         (Rober, 2026-08-05). On the same line as the Home buttons, so the
         answer to "where is she stationed" sits right beside the controls that
         set it. Silent when no home is assigned. */
      if (known.m.homeName) {
        /* A CLICKABLE card showing WHERE she lives — her MHIYH home / NFF base,
           her portrait, and a jump to the Domains tab (Rober, 2026-08-05:
           "show the domain icon etc and clicking it takes you to that domain
           tab"). Pre-fills the Domains filter with the home name so the marked
           place, if you have one, is the top hit. */
        const info = h('button', { class: 'fq-homeinfo', type: 'button', title:
          known.m.homeSrc + ' home: ' + known.m.homeName
          + (known.m.homeAlt ? '\nAlso ' + (known.m.homeSrc === HOME_SRC.nff ? 'MHIYH' : 'NFF')
                                       + ': ' + known.m.homeAlt : '')
          + '\nClick → Domains tab',
          onClick: (e) => {
            e.stopPropagation();
            if (window.DomainsPane && window.DomainsPane.openWithFilter)
              window.DomainsPane.openWithFilter(known.m.homeName);
            else if (window.__omniSetTab) window.__omniSetTab('domains');
          } });
        const p = portraitFor(known.m);
        if (p) {
          const face = h('span', { class: 'fq-homeinfo-face' });
          face.style.backgroundImage = 'url("portraits/' + p.file + (p.mtime ? '?v=' + p.mtime : '') + '")';
          info.append(face);
        } else {
          info.append(h('span', { class: 'fq-homeinfo-ic' }, '⌂'));
        }
        info.append(h('span', { class: 'fq-homeinfo-txt' },
          h('span', { class: 'fq-homeinfo-src' }, known.m.homeSrc),
          h('span', { class: 'fq-homeinfo-name' }, known.m.homeName)));
        info.append(h('span', { class: 'fq-homeinfo-go' }, '↗'));
        homeRow.append(info);
      } else {
        /* No MHIYH/NFF home assigned yet — a muted placeholder so the domain
           slot is VISIBLE (Rober, 2026-08-05: "i see nothing in home that shows
           a domain"). It becomes the live domain pill once a home is set. */
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
    if (!quickHost || quickHost.id !== 'fd-quick') card.append(partyBlock());
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
  }

  /* ================================================== member action menu == */

  let ctxEl = null;
  function ctxOutside(e) { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }
  function closeCtx() {
    if (!ctxEl) return;
    disarm();           // an armed Forget must never survive its own menu
    ctxEl.remove(); ctxEl = null;
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
    const want = ui.menuFor;
    const row = visibleRows().filter(function (r) {
      return r.cat === want.cat && r.idx === want.idx;
    })[0];
    if (!row) return;   // filtered out or gone — leave what is on screen
    openMemberMenu(row, isFinite(at.x) ? at.x : 120, isFinite(at.y) ? at.y : 120);
  }
  function clampCtx(x, y) {
    /* offsetWidth/Height, NOT getBoundingClientRect(). The menu opens under
       `animation: fdCtxIn` which includes `scale(.98)`, and getBoundingClientRect
       reports the TRANSFORMED box — so measuring here, one frame into the
       animation, returned 586px for a menu that settles at 598px and the clamp
       placed it 12px too low, hanging 6px off the bottom of the screen at the
       sizes where the menu is tallest. The layout box is transform-independent
       and already final on the frame the element is inserted. */
    const w = ctxEl.offsetWidth, hgt = ctxEl.offsetHeight;
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
        const w = ctxEl.offsetWidth, hgt = ctxEl.offsetHeight;
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

  function openMemberMenu(row, x, y) {
    closeCtx();
    ui.menuFor = { cat: row.cat, idx: row.idx };
    const m = row.m;

    const item = (icon, label, on, opts) => h('button', {
      class: 'fd-ctx-item' + ((opts && opts.danger) ? ' danger' : '') + ((opts && opts.active) ? ' active' : ''),
      disabled: (opts && opts.disabled) ? true : null,
      title: (opts && opts.title) || null,
      onClick: (e) => { e.stopPropagation(); on(e); },
    }, h('span', { class: 'fd-ctx-check' }, icon), h('span', { class: 'fd-ctx-lbl' }, label));

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

    /* ---- Her day (My Home is Your Home NG) — strictly read-only. Sits after
       the things you can TYPE and before the things you can DO, because it is
       neither: it is what the game already believes. ---- */
    const day = dayBlock(m);
    if (day) day.forEach((el) => items.push(el));

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
      toGame('fdPortrait', JSON.stringify({ formId: m.formId || '' }));
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
                       mtime: shot.mtime, name: m.name }, true);
      }, {
        title: 'Open the photo large and drag / zoom it. Changes how the deck '
             + 'DRAWS this face everywhere; the file on disk is never rewritten.',
      }));
    }

    /* ---- Recruit / dismiss / inventory (Nether's Follower Framework) ----
       Placed with the other things you DO to a person, after the map toggle.
       `following` comes off the roster envelope, so the button says the one
       thing that is actually available rather than offering both. */
    items.push(h('div', { class: 'fd-ctx-sep' }));

    const npcBlocked = !m.inWorld || m.dead;
    const npcTitle = m.dead ? 'They are dead'
      : (!m.inWorld ? (wTitle || 'Not in the world this session') : null);

    if (m.following) {
      items.push(item('⊘', 'Dismiss from service', (e) => {
        arm(e.currentTarget.querySelector('.fd-ctx-lbl') || e.currentTarget,
          'Dismiss ' + m.name + '?', 'Click again to send them home',
          () => { closeCtx(); sendNpc('dismiss', m); });
      }, { disabled: npcBlocked, title: npcTitle || 'Send them home through NFF (its own dismissal, not a teleport)' }));
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

    /* The worn set, always shown. Asked for once per menu open; a cached
       answer paints immediately and is refreshed in the background. */
    items.push(equippedBlock(m));
    askEquipped(m);

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
    items.push(h('div', { class: 'fd-ctx-field' }, h('label', null, 'Category'), sel));

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

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    ctxEl.addEventListener('pointerdown', disarmOnOther, true);
    ctxEl.addEventListener('focusin', disarmOnOther, true);
    $('overlay').append(ctxEl);

    /* Every label in THIS menu gets the same width, so the controls form one
       column instead of a ragged edge — and a label longer than the column
       ellipsizes rather than wrapping its row to two lines. Written inline
       (not left to the CSS var) because the value has to be identical across
       the menu even if a var lands mid-open. */
    const labW = ctxLabelPx(curAv()) + 'px';
    const labels = ctxEl.querySelectorAll('.fd-ctx-field label');
    for (let li = 0; li < labels.length; li++) labels[li].style.width = labW;

    /* Width is explicit rather than content-sized. Left to shrink-to-fit the
       menu settled wherever the longest button happened to land — 292px at
       Rober's 72px faces — which put "Steward of the Eastern Reac…" in an
       input with a 250px box around it. Setting it means every input is as
       wide as the menu allows, and maxWidth follows so nothing (a very long
       category name in the <select>, say) can push past it.

       The day allowance is keyed on the STEPPER actually being there, not on
       dayBlock() having returned something: its other shape is a one-line
       "no daily routine set" message, which needs no more room than a name. */
    const wantW = ctxWidthPx(curAv(), !!ctxEl.querySelector('.fd-day'));
    ctxEl.style.width = wantW + 'px';
    ctxEl.style.maxWidth = wantW + 'px';

    /* The field rows made this menu materially taller (4 spec rows + any
       unknown keys), and the day adds up to eight more. Cap it to the viewport
       and scroll inside, so it can never run off the bottom of a small window
       or a high menu-scale panel — and do it BEFORE clampCtx, which positions
       from the measured height. */
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';

    /* Centred rather than dropped at the click. A menu this wide anchored at
       the cursor lands hard against an edge and covers the row you were just
       reading. Still draggable — this is only where it starts. */
    centerCtx();
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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
    clampCtx(r.left, r.top - 10 - ctxEl.offsetHeight);
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
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
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

  function openSendTo(anchorEl, row) {
    const m = row.m;
    closeCtx();

    const mhHome = m.mhHome ? String(m.mhHome) : '';
    const nffHome = m.nffHome ? String(m.nffHome) : '';
    const marks = domainMarks();

    const items = [h('div', { class: 'fd-ctx-head', title: m.name }, 'Send ' + m.name + ' to…')];

    const filterWrap = h('div', { class: 'fd-ctx-field' },
      h('input', {
        /* the menu's own input treatment — focus ring, placeholder, radii
           all come from .fd-ctx-input; the modifier only drops the label gap */
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter destinations…',
        onInput: (e) => paint(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      }));
    items.push(filterWrap);

    const listBox = h('div', { class: 'fd-ctx-scroll' });
    items.push(listBox);

    function rowBtn(icon, label, sub, on) {
      return h('button', { class: 'fd-ctx-item', onClick: (e) => { e.stopPropagation(); closeCtx(); on(); } },
        h('span', { class: 'fd-ctx-check' }, icon),
        h('span', { class: 'fd-ctx-lbl' }, label),
        sub ? h('span', { class: 'fd-ctx-count' }, sub) : null);
    }

    function paint(q) {
      const f = String(q || '').trim().toLowerCase();
      const hit = (s) => !f || String(s || '').toLowerCase().indexOf(f) !== -1;
      listBox.textContent = '';
      let n = 0;

      if (hit('where she was back undo summon return')) {
        listBox.append(rowBtn('⮌', 'Where they were', 'undo a summon',
          () => sendWorld('sendback', row.cat, row.idx, '⮌ ' + m.name + ' returns')));
        n++;
      }
      if (mhHome && hit('home mhiyh my home is your home ' + mhHome)) {
        listBox.append(rowBtn('⌂', 'Her home', mhHome,
          () => sendNpc('sendHome', m, { dest: 'mhiyh' })));
        n++;
      }
      if (nffHome && hit('base nff nether follower framework home ' + nffHome)) {
        listBox.append(rowBtn('⌂', 'Her NFF base', nffHome,
          () => sendNpc('sendHome', m, { dest: 'nff' })));
        n++;
      }
      marks.forEach((mk) => {
        if (!hit([mk.name, mk.category, mk.note, mk.cellName].join(' '))) return;
        /* The callback goes THROUGH rowBtn (it closes the menu itself). The old
           shape appended a callback-less row and bolted sendToDomain on with
           .onclick — so rowBtn's own listener called undefined and threw
           "on is not a function" on every domain click (the send still worked,
           through the second handler, which is why nobody saw it in play). */
        listBox.append(rowBtn(mk.interior ? '⌂' : '▲', mk.name, mk.category || '',
          () => sendToDomain(m, mk)));
        n++;
      });

      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          marks.length || mhHome || nffHome ? 'Nothing matches “' + q + '”.'
            : 'No homes set, and no domains marked yet — mark one on the Domains tab.'));
      }
    }
    paint('');

    ctxEl = h('div', { id: 'fd-ctx-menu', role: 'menu' }, items);
    $('overlay').append(ctxEl);
    const w = ctxWidthPx(curAv(), false);
    ctxEl.style.width = w + 'px';
    ctxEl.style.maxWidth = w + 'px';
    ctxEl.style.maxHeight = Math.max(220, ctxViewport().h - 24) + 'px';
    ctxEl.style.overflowY = 'auto';
    ctxEl.style.overflowX = 'hidden';
    const r = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect()
                                                           : { left: 40, top: 120 };
    /* The destination list is long and filterable — centre it like the member
       menu rather than pinning it to the row that opened it. */
    centerCtx();
    reclampCtx();
    makeCtxDraggable(ctxEl.querySelector('.fd-ctx-head'));
    setTimeout(() => {
      const inp = ctxEl && ctxEl.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxOutside, true);
    }, 0);
  }

  function dropAfter(e, el) { const r = el.getBoundingClientRect(); return (e.clientY - r.top) > r.height / 2; }

  /* ====================================================== pane contract == */

  function isActive() {
    return typeof ui !== 'undefined' && window.__hdActiveTab === 'followers';
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

  /* ---- Omni search provider (universal search, v0.14.0) ---------------- *
   * Indexes the LIVE roster at query time — categories, names, notes, the
   * v0.10.0 NPC fields (relationship/home/…) and the NFF/MHiYH home text all
   * ride the same haystacks visibleRows() already searches, so anything new
   * that lands in a member is searchable with no omni change. */
  if (window.HDOmni) HDOmni.register({
    id: 'followers', label: 'Followers', tab: 'followers',
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
      ui.filter = String(q || '');
      ui.sel = -1;
      const s = $('fd-search');
      if (s) s.value = ui.filter;
      try { renderList(); } catch (e) {}
    },
    index: function () {
      const items = [];
      (state.cats || []).forEach((c) => {
        const cl = c.override || c.name || c.original || '';
        (c.members || []).forEach((m) => {
          const rel = m.fields && m.fields.relationship;
          const original = m.original || m.name || '';
          items.push({
            label: m.name || m.original || '(unnamed)',
            detail: [rel, cl, m.desc].filter(Boolean).join(' · '),
            kind: rel || 'follower',
            keywords: [m.original, m.fieldsText, m.homeText].filter(Boolean).join(' '),
            /* `original` — the same durable identity the recents strip keys
               on: a rename must not split her, a re-file must not lose her */
            pin: 'fol:' + original,
            snap: { original: original, label: m.name || m.original || '' },
            /* her portrait, plain path (no ?v= — Ultralight's loader can eat
               the query as filename, see medalEl); shelf falls back to the
               glyph if it fails to load */
            icon: (function () {
              const p = portraitFor(m);
              return p ? 'portraits/' + p.file : '';
            })(),
          });
        });
      });
      return items;
    },
  });

  /* Called by the Wardrobe host when NFF/SOES state changes underneath us, so
     the quick card's clothes block repaints in place instead of waiting for
     the next open. Guarded on our tab being the visible one. */
  function clothesChanged() {
    if (isActive()) renderQuickCard();
    /* The outfit dock reads the same two modules and is drawn OVER the card, so
       a handover / wear / clear answered while it is up must repaint it too —
       it is not inside the card and never sees renderQuickCard(). */
    if (window.HDOutfit && HDOutfit.isOpen()) HDOutfit.refresh();
  }

  window.FolPane = {
    clothesChanged: clothesChanged,
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
        toGame('fdPortrait', JSON.stringify({ formId: state.target ? state.target.formId : 0 }));
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
      if (!hit) return false;
      enterFocus();
      pickCrew(hit.m);
      return true;
    },
    /* Called from hdClosed: the deck closing must not carry NPC-focus into the
       next open. hdClosed strips the body class; this clears the FLAG behind it
       so a re-open with no crosshair target can't re-paint an empty focus. */
    _resetFocus() { ui.npcFocus = false; ui.focusRosterOpen = false; ui.focusDismissed = false; },

    onShow() {
      ui.sel = -1;
      /* Fresh entry to the Followers tab starts DEDICATED to the crosshair NPC
         (roster hidden) — you open a category yourself to browse. */
      ui.rosterOpen = false;
      // Re-query every show: the roster can change through FO's native flows,
      // and the crosshair add-target is per-open (snapshotted by C++).
      toGame('fdRefresh');
      render();
      setTimeout(() => { const s = $('fd-search'); if (s) s.focus(); }, 30);
    },

    onHide() {
      closeLightbox();   // an overlay that survives its tab is an unclickable deck
      closeHudModal();   // the HUD settings modal must not outlive its tab
      closeWornLightbox();
      closeCtx();
      ui.editing = false;
      ui.filter = '';
      const s = $('fd-search'); if (s) s.value = '';
      /* Focus mode hides the GLOBAL tab bar via a body class — leaving the tab
         (any route: the Hotkeys chevron, a manual switch) must take that class
         with it, or the next pane opens with no tabs. Not "dismissed": that is
         a within-focus statement; leaving the tab is a clean reset. */
      ui.npcFocus = false;
      ui.focusRosterOpen = false;
      if (typeof document !== 'undefined' && document.body)
        document.body.classList.remove('hd-npcfocus', 'hd-focusroster');
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
      const t = e.target;
      const inText = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT');
      if (ctxEl) {
        if (e.key === 'Escape') { e.preventDefault(); closeCtx(); return true; }
        return true;  // typing lives inside the menu's inputs
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
          openMemberMenu(pick, r.left + 60, r.top + 20);
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
      if (!inText && e.key && e.key.length === 1) {
        const s = $('fd-search');
        if (s && document.activeElement !== s) { s.focus(); }
      }
      return false;
    },

    syncChrome,
    openKeyLabel() { return state.openKey.label || 'F14'; },
    setOpenKey(device, code, label) {
      state.openKey = { device, code: code >>> 0, label };
      saveOpenKey();
      syncChrome();
      toast('Followers key set to ' + label);
    },
    closeMenus: closeCtx,
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
    rosterForDomains() {
      const out = [];
      state.cats.forEach(function (c) {
        (c.members || []).forEach(function (m) {
          const home = (m.fields && typeof m.fields.home === 'string') ? m.fields.home : '';
          const p = portraitFor(m);
          const portraitUrl = p
            ? 'portraits/' + (p.file || (p.slug + '.' + (p.ext || 'png'))) + '?v=' + (p.mtime || 0)
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
      const want = canonFormId(who.formId);
      if (want) {
        for (let ci = 0; ci < state.cats.length; ci++) {
          const ms = state.cats[ci].members || [];
          for (let mi = 0; mi < ms.length; mi++) {
            if (canonFormId(ms[mi].formId) !== want) continue;
            const hit = portraitFor(ms[mi]);
            if (hit) return hit;
          }
        }
      }
      return portraitFor({ original: who.original, name: who.name });
    },
    /* test hooks */
    _renderHudCard: renderHudCard, _hudCfg: hudCfg,
    _setHudState: function (s) { hudState = s; renderHudCard(); },
    _state: state, _ui: ui, _visibleRows: visibleRows, _render: render,
    _renderList: renderList, _syncCount: syncCount, _partyList: partyList,
    _crewFace: crewFace,
    _FIELDS: FIELDS, _fieldRows: fieldRows, _fieldValue: fieldValue,
    _normalizeFields: normalizeFields, _normMember: normMember,
    _saveField: saveField, _openMemberMenu: openMemberMenu, _prettyKey: prettyKey,
    _openSendTo: openSendTo, _openFileInto: openFileInto, _openWardrobeInto: openWardrobeInto, _openNffBase: openNffBase, _fmtOff: fmtOff, _clearNffOutfit: clearNffOutfit, _fileInto: fileInto, _domainMarks: domainMarks, _whereChip: whereChip,
    _mergeHome: mergeHome, _homeChip: homeChip, _homeTitle: homeTitle, _nffEntry: nffEntry,
    _ACTS: ACTS, _actSpec: actSpec, _nowChip: nowChip, _nowTitle: nowTitle, _dayBlock: dayBlock,
    _SETTABLE_KINDS: SETTABLE_KINDS, _canSetKind: canSetKind, _dayActions: dayActions,
    _openSpotPicker: openSpotPicker, _spotPhrase: spotPhrase,
    _rankLabel: rankLabel, _clampRank: clampRank, _rankNum: rankNum,
    _spouseChip: spouseChip, _rankView: rankView,
    _refreshOpenMenu: refreshOpenMenu, _disarm: disarm,
    _ramp: ramp, _oddPx: oddPx, _applyAvatarSize: applyAvatarSize, _AV_DEF: AV_DEF,
    _applyUiScale: applyUiScale, _syncEditRowWrap: syncEditRowWrap,
    _clampText: clampText, _FIELD_VALUE_MAX: FIELD_VALUE_MAX,
    _slugOf: slugOf, _portraitFor: portraitFor, _medalEl: medalEl, _openLightbox: openLightbox,
    _closeLightbox: closeLightbox,
    _closeHudModal: closeHudModal,
    _closeWornLightbox: closeWornLightbox,
    _clampCrop: clampCrop, _cropFor: cropFor, _applyCropTo: applyCropTo,
    _cropPhrase: cropPhrase, _CROP_ZSTEP: CROP_ZSTEP, _CROP_PAN_STEP: CROP_PAN_STEP,
    _CROP_ZMAX: CROP_ZMAX, _CROP_MAX_ENTRIES: CROP_MAX_ENTRIES,
    _lbEditing: function () { return !!lbEdit; },
    _canonFormId: canonFormId,
    _iconSrc: iconSrc, _catIconOf: catIconOf, _anyCatIcon: anyCatIcon,
    _railIconEl: railIconEl, _setCatIcon: setCatIcon,
    _openCatIconPicker: openCatIconPicker, _catForIcon: catForIcon,
    _chainIcons: chainIcons, _CATIC_PAGE: CATIC_PAGE, _CAT_MAX: CAT_MAX,
    /* app.js mounts the quick-follower card above the hotkey list while the
       Followers CATEGORY is up; unmount when it leaves. */
    mountQuickCard(host) { mountQuick(host); },
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
    _equippedBlock: equippedBlock, _equippedFor: equippedFor, _renderAdd: renderAdd,
    _resetEquippedGate: function () {
      equippedAsked = { key: null, at: 0 }; equippedPending = null; forgetEquippedAsks();
    },
    _quickSubject: quickSubject, _forgetEquippedAsks: forgetEquippedAsks,
    _tuneRow: tuneRow, _tuneFor: tuneFor, _forgetTuneAsks: forgetTuneAsks,
    _openSpellShare: openSpellShare, _openTunePanel: openTunePanel,
    _openPerkGrant: openPerkGrant, _POOLS: POOLS,
    _syncQuickEquipped: syncQuickEquipped,
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
    env = coerce(env);
    if (!env) return;
    if (env.msg) toast(env.msg);
    const s = env.state && typeof env.state === 'object' ? env.state : env;
    normalizeState(s);
    state.loaded = true;
    state.foMissing = (env.ok === false && !state.cats.length)
      ? (env.msg || 'Follower Organizer is not available') : '';
    if (isActive()) render();
  };

  /* Live party — the HUD's own teammate/faction scan (an ARRAY of
     {name,formId,following,dead,file,ext,mtime,crop}). Merged into partyList()
     so framework-driven followers the FO roster never lists (custom follower
     mods, CHIM soft-follow) still show in "Current party". De-dup vs the roster is by
     formId there, so an FO member is never doubled. */
  window.fdLiveParty = function (env) {
    const v = coerce(env);
    state.liveParty = Array.isArray(v) ? v : (v && Array.isArray(v.list) ? v.list : []);
    if (isActive()) render();
  };

  window.fdTarget = function (t) {
    /* A fresh crosshair target drops any party PICK: looking at somebody is a
       clearer statement of intent than a face you clicked earlier, and leaving
       the pick in place would mean the card silently keeps addressing the
       wrong person while you stare at someone else. */
    ui.fqPick = '';
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
    if (ui.npcFocus && !(state.target && state.target.name)) {
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
    if (isActive()) renderList();
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
    if (isActive()) renderList();
    renderQuickCard();
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
    const e = coerce(env);
    if (!e || typeof e !== 'object') return;
    const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
    framing = {
      zoom: num(e.zoom, 0.6), offsetX: num(e.offsetX, 0), offsetY: num(e.offsetY, -0.06),
      defZoom: num(e.defZoom, 0.6), defOffsetX: num(e.defOffsetX, 0),
      defOffsetY: num(e.defOffsetY, -0.06),
    };
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
     handler deliberately changes no state, so a payload from a newer DLL
     than this view cannot corrupt anything. */
  window.fdMhiyhResult = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
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
    if (rankEdit.key !== null && !rankEdit.pending) {
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
  window.fdRankInfo = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    const t = state.target;
    const key = String((t && t.formId) || '');
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
    renderQuickCard();
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
    state.fert = { available: !!(env && env.available), actors: map };
    remergeFert();
    if (isActive()) renderList();
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
