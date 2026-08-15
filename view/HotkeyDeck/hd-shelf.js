'use strict';

/* ====================================================================== *
 *  Favorites Shelf (v0.15.0) — pin ANYTHING, one click from any tab.
 *
 *  A collapsible rail docked to the screen edge BESIDE the panel (the deck
 *  slides over to make room — the dead margin at 2560×1440 is the space it
 *  spends). Rober's ask, 2026-08-04: "a favorites bar… where you could add
 *  any function to it (literally any) — re-order priority, etc."
 *
 *  ---- "literally any" is the Omni provider registry -------------------
 *  The shelf does not know what a spell, a follower or a domain is. It pins
 *  OMNI ITEMS: every provider's index() items carry a durable `pin` key
 *  (provider-scoped string) and optionally a JSON-safe `snap` payload, and
 *  the ☆ on every omni result row files that identity here. Anything a pane
 *  indexes for omni is shelf-able the same day, with no shelf edit — the
 *  same scale-by-construction contract omni itself uses.
 *
 *  ---- activation: live truth first, snapshot second, honesty third -----
 *  A click re-resolves the pin against the provider's LIVE index():
 *    1. live item found:  run() it (fire / cast / travel), else the
 *       provider's pinRun(snap, item) (followers: open her menu), else jump
 *       to its tab with the pane's own filter pre-filled.
 *    2. not found, but the pin carries a snap and the provider a pinRun:
 *       fire from the snapshot (quests before their lazy search, spells
 *       before the warm data lands, tabs, deck actions).
 *    3. otherwise: the row greys with the reason and the click degrades to
 *       the tab jump — never a silent dead button.
 *  `label` is refreshed from the live item on every resolve (a renamed
 *  hotkey renames its pin); `alias` is the user's own shelf rename and is
 *  never touched by that refresh.
 *
 *  ---- storage ----------------------------------------------------------
 *  state.shelf = { side:'right'|'left', open:bool, pins:[{prov,key,label,
 *  detail,kind,snap,alias,abbr}] } — one more root slice of the config app.js
 *  already round-trips whole through hdSave/hdOpen. C++ (main.cpp) carries
 *  it as a RAW json blob on Config: the schema lives here, and a key an
 *  older DLL has never heard of survives the trip (size-capped only).
 *  ⚠ Matched set: a pre-v0.15 DLL DROPS the slice on its next save — the
 *  deploy script ships DLL + view together, which is what makes that safe.
 *
 *  ---- layout contract with app.css -------------------------------------
 *  The shelf is a WING OF THE DECK WINDOW: an absolute column appended
 *  INSIDE #panel, flush to its right (or left) edge — Rober, 2026-08-04:
 *  "I want it attached to the main UI." So it scales with the panel's
 *  --ui-scale transform, clips to the window's rounded corners, and moves
 *  with the window. It sets body classes:
 *    shf-left            the wing docks left instead of right
 *    shf-open            the full panel is out (rail-only otherwise)
 *  hd-shelf.css uses those to GROW #panel by the wing width and pad the
 *  same side, so the deck's content keeps its size and the assembly
 *  spends the free screen margin — never compressing the deck below its
 *  own min sizes (the panel's max-width still caps the total). The
 *  resize grip is offset off the wing, and app.js's gripMove subtracts
 *  HDShelf.wingWidth() so a drag stores the DECK's size, not deck+wing.
 *
 *  Ultralight rules honoured (see [[ultralight-input-and-form-id-traps]]):
 *  mouse events on document for the drag (no PointerEvents), title= hover
 *  text (app.js's #hd-tip layer draws it), no prompt/confirm — inline
 *  rename input + armed two-click remove.
 * ====================================================================== */

var HDShelf = (function () {
  const DEV = location.search.indexOf('dev=1') !== -1;
  const MAX_PINS = 96;
  const RAIL_W = 64, PANEL_W = 348;   // must match hd-shelf.css paddings

  let env = null;          // { state, saveSoon, setTab, openOmni } from app.js
  const ui = {
    filter: '',
    renaming: -1,          // pin index with the inline rename input up
    renameMode: 'name',    // 'name' edits the alias; 'abbr' edits the rail shorthand
    menu: null,            // { i, x, y, armed } — right-click menu state
    drag: null,            // { i, y0, moved, to } — row drag-reorder
    warmed: false,         // warm() sent once per palette open
  };

  function toast(msg) { if (typeof window.toast === 'function') window.toast(msg); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------- slice */
  /* Normalises IN PLACE so hdSave always writes a sane shape, whatever a
     hand-edit or an older portal wrote. Never replaces state.shelf itself:
     app.js may have handed us the object reference before hdOpen refreshed
     the fields inside it. */
  function slice() {
    const st = env && env.state;
    if (!st) return null;
    if (!st.shelf || typeof st.shelf !== 'object' || Array.isArray(st.shelf))
      st.shelf = {};
    const sh = st.shelf;
    if (sh.side !== 'left' && sh.side !== 'right') sh.side = 'right';
    if (typeof sh.open !== 'boolean') sh.open = false;
    if (!Array.isArray(sh.pins)) sh.pins = [];
    sh.pins = sh.pins.filter((p) => p && typeof p === 'object' &&
      typeof p.prov === 'string' && p.prov &&
      typeof p.key === 'string' && p.key).slice(0, MAX_PINS);
    sh.pins.forEach((p) => {
      p.label = String(p.label || '');
      p.detail = String(p.detail || '');
      p.kind = String(p.kind || '');
      p.alias = String(p.alias || '');
      p.abbr = String(p.abbr || '').slice(0, 6);   // collapsed-rail shorthand override
      p.icon = safeIcon(p.icon);
      if (p.snap !== null && typeof p.snap !== 'object') p.snap = null;
    });
    return sh;
  }

  /* View-relative image paths only — same rule as C++'s ValidViewIconPath: a
     hand-edited absolute/escaping path renders nothing rather than reaching
     outside the view folder. */
  function safeIcon(p) {
    p = String(p || '');
    if (!p) return '';
    if (p.indexOf('..') !== -1 || p[0] === '/' || p.indexOf(':') !== -1) return '';
    return p;
  }

  function nameOf(p) { return p.alias || p.label || '(unnamed)'; }

  /* the collapsed rail shows 4 letters — skip a leading article so
     "The Bee and Barb" rails as BEE, not THE. `p.abbr` (right-click ▸
     Shorthand…) overrides the derivation without touching the real name. */
  function railAuto(name) {
    const t = String(name).replace(/^(the|a|an)\s+/i, '');
    return (t || String(name)).slice(0, 4);
  }
  function railLabel(p) { return p.abbr || railAuto(nameOf(p)); }

  /* ------------------------------------------------------- pin identity */

  function findPin(prov, key) {
    const sh = slice();
    if (!sh) return -1;
    return sh.pins.findIndex((p) => p.prov === prov && p.key === key);
  }

  function isPinned(prov, key) { return findPin(prov, key) >= 0; }

  /* The ☆ on an omni row lands here. Returns true when the click changed
     anything (omni re-renders its rows off that). */
  function togglePin(provider, item) {
    const sh = slice();
    if (!sh || !provider || !item || !item.pin) return false;
    const i = findPin(provider.id, String(item.pin));
    if (i >= 0) {
      sh.pins.splice(i, 1);
      toast('Unpinned “' + nameOf({ label: item.label }) + '”');
    } else {
      if (sh.pins.length >= MAX_PINS) { toast('The shelf is full (' + MAX_PINS + ' pins)'); return false; }
      sh.pins.push({
        prov: provider.id, key: String(item.pin),
        label: String(item.label || ''), detail: String(item.detail || ''),
        kind: String(item.kind || ''),
        icon: safeIcon(item.icon),
        /* stringify-parse: the snap must be JSON-safe NOW, not at save time —
           a closure or DOM node smuggled in here would poison hdSave for the
           whole config, and this is the moment the mistake is cheap to see. */
        snap: item.snap ? JSON.parse(JSON.stringify(item.snap)) : null,
        alias: '',
      });
      toast('★ Pinned “' + (item.label || '') + '” to the shelf');
    }
    env.saveSoon();
    render();
    return true;
  }

  /* -------------------------------------------------------- activation */

  function resolve(p) {
    if (window.HDOmni && typeof HDOmni.resolvePin === 'function')
      return HDOmni.resolvePin(p.prov, p.key);
    return { provider: null, item: null, indexed: false };
  }

  /* 'ok' | 'snap' (fireable from snapshot) | 'unknown' (provider data not
     loaded yet — never greyed) | 'gone' (provider says it no longer exists) */
  function statusOf(p, r) {
    if (r.item) return 'ok';
    const canSnap = p.snap && r.provider && typeof r.provider.pinRun === 'function';
    if (canSnap) return 'snap';
    if (!r.indexed) return 'unknown';
    return 'gone';
  }

  function jumpPin(p, provider) {
    provider = provider || (window.HDOmni && HDOmni.providerById(p.prov)) || null;
    if (!provider || !provider.tab) { toast('“' + nameOf(p) + '” isn’t reachable right now'); return; }
    /* setTab BEFORE setFilter — same onShow-wipes-the-filter trap omni's
       jumpTo documents (Finances resets its filter in onShow). */
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab(provider.tab);
    if (typeof provider.setFilter === 'function') {
      try { provider.setFilter(p.label || p.alias || ''); } catch (e) {}
    }
  }

  function firePin(i) {
    const sh = slice();
    const p = sh && sh.pins[i];
    if (!p) return;
    const r = resolve(p);
    if (r.item) {
      /* live truth refreshes the stored label and icon (a renamed hotkey
         renames its pin; a new portrait shows up) — but never the alias,
         that one is the user's own. */
      if (r.item.label && r.item.label !== p.label) { p.label = r.item.label; env.saveSoon(); }
      const li = safeIcon(r.item.icon);
      if (li !== p.icon) { p.icon = li; env.saveSoon(); }
      if (typeof r.item.run === 'function') {
        try { r.item.run(); } catch (e) {}
        flashRow(i);
        return;
      }
      if (r.provider && typeof r.provider.pinRun === 'function') {
        try { r.provider.pinRun(p.snap || {}, r.item); } catch (e) {}
        return;
      }
      jumpPin(p, r.provider);
      return;
    }
    if (p.snap && r.provider && typeof r.provider.pinRun === 'function') {
      try { r.provider.pinRun(p.snap, null); } catch (e) {}
      return;
    }
    jumpPin(p, r.provider);
  }

  function flashRow(i) {
    const row = root && root.querySelector('.shf-row[data-i="' + i + '"]');
    if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 350); }
    const chip = root && root.querySelector('.shf-rail-btn[data-i="' + i + '"]');
    if (chip) { chip.classList.add('flash'); setTimeout(() => chip.classList.remove('flash'), 350); }
  }

  /* ------------------------------------------------------------ glyphs */
  /* Provider-keyed, kind-refined. A provider the shelf has never heard of
     gets the star — a NEW pane's pins render fine the day it registers. */

  const PROV_GLYPH = {
    hotkeys: '⌨', 'deck-actions': '⚙', tabs: '▦', notes: '✎', quests: '❖',
    spells: '✦', time: '◔', domains: '◈', rooms: '⌂', finances: 'ᚠ',
    wardrobe: '⛃', followers: '☺',
  };
  /* kind first (it is descriptive prose — 'combo', 'room', 'wife'), provider
     second, star last — so a provider the shelf has never heard of still gets
     a meaningful glyph when its kind says what it is */
  const KIND_GLYPH = {
    combo: '⚡', action: '⚙', hotkey: '⌨', tab: '▦', note: '✎', quest: '❖',
    spell: '✦', wait: '◔', room: '⌂', outfit: '⛃', wardrobe: '⛃', market: 'ᚠ',
  };
  function glyphOf(p) {
    const k = String(p.kind || '').split(' ')[0];   // 'spell · equip' → 'spell'
    return KIND_GLYPH[k] || PROV_GLYPH[p.prov] || '★';
  }

  /* The pin's plate: the REAL art when the pin carries an icon (an entry's
     icons/… file, a follower's portrait, a domain's photo), the glyph
     otherwise. The <img> sits OVER the glyph and removes itself on load
     error, so a stale path costs a blink and never a broken-image box.
     Plain src, no ?v= cache-bust — Ultralight's view loader can treat the
     query as part of the filename (proven in-game 2026-07-28, see
     followers-pane medalEl). */
  function plateHtml(p, cls) {
    const open = '<span class="' + cls + (p.icon ? ' has-ico' : '') +
      '" style="--shf-hue:' + hueOf(p.prov) + '">';
    if (!p.icon) return open + glyphOf(p) + '</span>';
    return open + '<span class="shf-plate-glyph">' + glyphOf(p) + '</span>' +
      '<img class="shf-ico" src="' + esc(p.icon) + '" alt="" draggable="false"></span>';
  }

  /* innerHTML can't carry listeners — arm the error-fallback after a paint */
  function armIconFallbacks(host) {
    host.querySelectorAll('img.shf-ico').forEach((im) => {
      im.addEventListener('error', () => {
        const plate = im.parentNode;
        im.remove();
        if (plate && plate.classList) plate.classList.remove('has-ico');
      });
    });
  }
  /* stable per-provider hue for the glyph plate — same trick as the deck's
     category medallions, so a pin's colour says WHERE it lives */
  function hueOf(prov) {
    let h = 0;
    for (let i = 0; i < prov.length; i++) h = (h * 31 + prov.charCodeAt(i)) % 360;
    return h;
  }

  /* ------------------------------------------------------------ render */

  let root = null;

  function ensureDom() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'hd-shelf';
    root.innerHTML =
      '<div class="shf-rail">' +
        '<button class="shf-rail-open" title="Open the Favorites shelf">★</button>' +
        '<div class="shf-rail-list"></div>' +
        '<button class="shf-rail-add" title="Pin something — opens Search (Ctrl+F), hit the ☆ on any result">＋</button>' +
      '</div>' +
      '<div class="shf-panel">' +
        '<div class="shf-head">' +
          '<span class="shf-title">★ Favorites</span>' +
          '<span class="shf-count"></span>' +
          '<span class="shf-head-sp"></span>' +
          '<button class="shf-side-btn" title="Dock the shelf on the other side">⇄</button>' +
          '<button class="shf-collapse" title="Collapse to the rail">▸</button>' +
        '</div>' +
        '<div class="shf-search-wrap"><input class="shf-search" type="text" ' +
          'placeholder="Filter favorites…" autocomplete="off" spellcheck="false"></div>' +
        '<div class="shf-list"></div>' +
        '<div class="shf-foot"><button class="shf-add">＋ Pin anything…</button>' +
          '<button class="shf-newcc" title="Type any console command — it becomes a deck entry and lands here as a pin">＞ New command…</button></div>' +
      '</div>';
    /* inside the deck window — the wing contract (see header). Falls back to
       body only if #panel is somehow absent (a harness without one). */
    (document.getElementById('panel') || document.body).appendChild(root);

    root.querySelector('.shf-rail-open').addEventListener('click', () => setOpen(true));
    root.querySelector('.shf-collapse').addEventListener('click', () => setOpen(false));
    root.querySelector('.shf-side-btn').addEventListener('click', toggleSide);
    root.querySelector('.shf-rail-add').addEventListener('click', () => { if (env) env.openOmni(); });
    root.querySelector('.shf-add').addEventListener('click', () => { if (env) env.openOmni(); });
    /* "＞ New command…" — the deck's console editor makes a real entry, and
       the shelf pins it the moment it lands. togglePin owns the cap, the
       save and the toast, exactly as if the ☆ had been hit in Omni. */
    root.querySelector('.shf-newcc').addEventListener('click', () => {
      if (typeof window.openConsoleEditor !== 'function') { toast('Console editor unavailable'); return; }
      /* fileUnder: shelf-made commands collect on the Commands tab too */
      window.openConsoleEditor(null, null, { fileUnder: 'Commands', onDone: (en) => {
        togglePin({ id: 'hotkeys' }, { pin: 'hk:' + en.id, label: en.name,
          detail: en.desc || '', kind: 'hotkey', icon: '', snap: null });
      } });
    });

    const search = root.querySelector('.shf-search');
    search.addEventListener('input', (e) => { ui.filter = e.target.value; renderList(); });
    /* Enter = fire the TOP visible pin — the fd-ctx idiom every deck list uses */
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = root.querySelector('.shf-row');
        if (first) firePin(Number(first.dataset.i));
      }
    });

    const list = root.querySelector('.shf-list');
    list.addEventListener('mousedown', onListMouseDown);
    list.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.shf-row');
      if (!row) return;
      e.preventDefault();
      openMenu(Number(row.dataset.i), e.clientX, e.clientY);
    });
    const rail = root.querySelector('.shf-rail-list');
    rail.addEventListener('click', (e) => {
      const b = e.target.closest('.shf-rail-btn');
      if (b) firePin(Number(b.dataset.i));
    });
    rail.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('.shf-rail-btn');
      if (!b) return;
      e.preventDefault();
      setOpen(true);                       // reorder/rename live in the panel
      openMenu(Number(b.dataset.i), e.clientX, e.clientY);
    });
    return root;
  }

  function setOpen(open) {
    const sh = slice();
    if (!sh) return;
    sh.open = !!open;
    env.saveSoon();
    closeMenu();
    render();
    if (open) {
      const s = root.querySelector('.shf-search');
      if (s) setTimeout(() => s.focus(), 30);
    }
  }

  function toggleSide() {
    const sh = slice();
    if (!sh) return;
    sh.side = sh.side === 'right' ? 'left' : 'right';
    env.saveSoon();
    render();
  }

  function visiblePins(sh) {
    const q = ui.filter.trim().toLowerCase();
    const out = [];
    sh.pins.forEach((p, i) => {
      if (q) {
        const hay = (nameOf(p) + ' ' + p.label + ' ' + p.detail + ' ' + p.kind + ' ' + p.prov).toLowerCase();
        if (hay.indexOf(q) === -1) return;
      }
      out.push({ p, i });
    });
    return out;
  }

  function render() {
    if (!env) return;
    const sh = slice();
    if (!sh) return;
    ensureDom();

    root.classList.toggle('side-left', sh.side === 'left');
    root.classList.toggle('expanded', sh.open);
    document.body.classList.toggle('shf-left', sh.side === 'left');
    document.body.classList.toggle('shf-open', sh.open);

    /* rail — every pin as a glyph chip, same order as the panel */
    const rail = root.querySelector('.shf-rail-list');
    let rh = '';
    sh.pins.forEach((p, i) => {
      rh += '<button class="shf-rail-btn" data-i="' + i + '" style="--shf-hue:' + hueOf(p.prov) + '" ' +
        'title="' + esc(nameOf(p)) + (p.detail ? ' — ' + esc(p.detail) : '') + '">' +
        plateHtml(p, 'shf-rail-glyph') +
        '<span class="shf-rail-lbl">' + esc(railLabel(p)) + '</span></button>';
    });
    rail.innerHTML = rh;
    armIconFallbacks(rail);
    /* an empty rail is two lone buttons — the gold hint on ＋ says where to start */
    root.querySelector('.shf-rail-add').classList.toggle('hint', !sh.pins.length);

    root.querySelector('.shf-count').textContent = sh.pins.length ? String(sh.pins.length) : '';
    const swrap = root.querySelector('.shf-search-wrap');
    /* UI rule 4: a typeable filter wherever one can exist — but an input over
       three pins is chrome, so it appears once the list can actually lose
       something (and stays while a filter is typed, or clearing it strands you) */
    swrap.classList.toggle('hidden', sh.pins.length < 8 && !ui.filter);
    renderList();
  }

  function renderList() {
    const sh = slice();
    if (!sh || !root) return;
    const list = root.querySelector('.shf-list');

    if (!sh.pins.length) {
      list.innerHTML =
        '<div class="shf-empty">' +
          '<div class="shf-empty-star">★</div>' +
          '<div class="shf-empty-t">Pin anything here</div>' +
          '<div class="shf-empty-s">Open <b>⌕ Search</b> (Ctrl F) and hit the ☆ on any result — ' +
          'hotkeys, spells, people, places, quests, waits, tabs.<br>Drag to reorder. ' +
          'Right-click a pin to rename or remove it.</div>' +
          '<button class="shf-empty-add">⌕ Find something to pin</button>' +
        '</div>';
      const b = list.querySelector('.shf-empty-add');
      if (b) b.addEventListener('click', () => { if (env) env.openOmni(); });
      return;
    }

    const rows = visiblePins(sh);
    if (!rows.length) {
      list.innerHTML = '<div class="shf-empty"><div class="shf-empty-t">Nothing matches “' +
        esc(ui.filter.trim()) + '”</div></div>';
      return;
    }

    let html = '';
    const filtering = !!ui.filter.trim();
    let first = true;
    rows.forEach(({ p, i }) => {
      const r = resolve(p);
      const st = statusOf(p, r);
      const gone = st === 'gone';
      /* while filtering, mark the row Enter fires — the fd-ctx idiom */
      const topHit = filtering && first && ui.renaming !== i;
      first = false;
      if (ui.renaming === i) {
        const abbrMode = ui.renameMode === 'abbr';
        html += '<div class="shf-row renaming" data-i="' + i + '">' +
          plateHtml(p, 'shf-glyph') +
          (abbrMode
            ? '<div class="shf-abbr-wrap"><input class="shf-rename abbr" type="text" value="' +
              esc(p.abbr || railAuto(nameOf(p))) + '" maxlength="6" ' +
              'title="The short label under this pin on the collapsed rail — the name itself is untouched">' +
              '<span class="shf-abbr-hint">rail letters · Esc cancels</span></div>'
            : '<input class="shf-rename" type="text" value="' + esc(nameOf(p)) + '" maxlength="60">') +
          '</div>';
        return;
      }
      const sub = [p.kind, p.detail].filter(Boolean).join(' · ');
      html += '<div class="shf-row' + (gone ? ' gone' : '') + (topHit ? ' top-hit' : '') +
        '" data-i="' + i + '" title="' +
        (gone ? esc(nameOf(p)) + ' — no longer exists; click opens its tab'
              : esc(nameOf(p)) + (sub ? ' — ' + esc(sub) : '')) + '">' +
        plateHtml(p, 'shf-glyph') +
        '<div class="shf-body">' +
          '<div class="shf-name">' + esc(nameOf(p)) + '</div>' +
          (sub ? '<div class="shf-sub">' + esc(sub) + '</div>' : '') +
        '</div>' +
        (gone ? '<span class="shf-warn" title="The thing this pin points at is gone — right-click to remove the pin">⚠</span>' : '') +
        '</div>';
    });
    list.innerHTML = html;
    armIconFallbacks(list);

    const input = list.querySelector('.shf-rename');
    if (input) {
      input.focus();
      input.select();
      const commit = () => {
        const sh2 = slice();
        const p = sh2 && sh2.pins[ui.renaming];
        if (p) {
          const v = input.value.trim();
          if (ui.renameMode === 'abbr') {
            /* typing the derived letters back = clearing the override, so the
               shorthand keeps following renames — same law as the alias */
            p.abbr = (v && v !== railAuto(nameOf(p))) ? v.slice(0, 6) : '';
          } else {
            /* typing the live name back = clearing the alias, so the pin keeps
               following renames instead of freezing on today's spelling */
            p.alias = (v && v !== p.label) ? v : '';
          }
          env.saveSoon();
        }
        ui.renaming = -1;
        ui.renameMode = 'name';
        render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { ui.renaming = -1; ui.renameMode = 'name'; render(); }
      });
      input.addEventListener('blur', commit);
    }
  }

  /* --------------------------------------------------- drag / click ---- */
  /* One mousedown handler owns both: <5px of travel is a click (fire), more
     is a drag (reorder). Document-level move/up — Ultralight forwards plain
     mouse events there reliably; PointerEvents do not exist. */

  function onListMouseDown(e) {
    if (e.button !== 0) return;
    const row = e.target.closest('.shf-row');
    if (!row || row.classList.contains('renaming')) return;
    const i = Number(row.dataset.i);
    ui.drag = { i, y0: e.clientY, moved: false, to: i };
    const onMove = (ev) => {
      if (!ui.drag) return;
      if (!ui.drag.moved && Math.abs(ev.clientY - ui.drag.y0) < 5) return;
      ui.drag.moved = true;
      row.classList.add('dragging');
      const rows = Array.prototype.slice.call(root.querySelectorAll('.shf-row'));
      let to = ui.drag.i;
      for (const r2 of rows) {
        const rect = r2.getBoundingClientRect();
        if (ev.clientY > rect.top + rect.height / 2) to = Number(r2.dataset.i);
      }
      /* above the first row's midpoint = slot 0 */
      const first = rows[0];
      if (first) {
        const fr = first.getBoundingClientRect();
        if (ev.clientY < fr.top + fr.height / 2) to = Number(first.dataset.i);
      }
      if (to !== ui.drag.to) {
        ui.drag.to = to;
        rows.forEach((r2) => r2.classList.toggle('drop-target',
          Number(r2.dataset.i) === to && to !== ui.drag.i));
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const d = ui.drag;
      ui.drag = null;
      if (!d) return;
      if (!d.moved) { closeMenu(); firePin(d.i); return; }
      if (d.to !== d.i) {
        const sh = slice();
        if (sh && sh.pins[d.i]) {
          const [moved] = sh.pins.splice(d.i, 1);
          sh.pins.splice(d.to, 0, moved);
          env.saveSoon();
        }
      }
      render();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ------------------------------------------------------ context menu */

  function openMenu(i, x, y) {
    closeMenu();
    const sh = slice();
    if (!sh || !sh.pins[i]) return;
    ui.menu = { i, armed: false };
    const m = document.createElement('div');
    m.id = 'shf-menu';
    m.innerHTML =
      '<button data-act="jump">↗ Open in its tab</button>' +
      '<button data-act="rename">✎ Rename</button>' +
      '<button data-act="abbr">🏷 Shorthand… <span class="shf-menu-sub">rail letters</span></button>' +
      '<button data-act="top">⤒ Move to top</button>' +
      '<button data-act="unpin" class="shf-menu-danger">✕ Remove from shelf</button>';
    document.body.appendChild(m);
    /* clamp inside the viewport — the shelf hugs an edge, the menu must not.
       #shf-menu lives on <body>, OUTSIDE #panel's transform: scale(--ui-scale),
       so it wears the scale itself (see #shf-menu in hd-shelf.css). offsetWidth/
       Height are pre-transform layout px; the PAINTED box is × the scale, so
       clamp that or a Fill'd deck throws the menu off-screen. */
    let sc = 1;
    try { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')); if (isFinite(v) && v > 0) sc = v; } catch (e) {}
    const w = m.offsetWidth * sc, h = m.offsetHeight * sc;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - 8 - w;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - 8 - h;
    m.style.left = Math.round(Math.max(8, x)) + 'px';
    m.style.top = Math.round(Math.max(8, y)) + 'px';
    m.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      const sh2 = slice();
      if (!sh2 || !sh2.pins[ui.menu.i]) { closeMenu(); return; }
      if (act === 'jump') { const p = sh2.pins[ui.menu.i]; closeMenu(); jumpPin(p, null); return; }
      if (act === 'rename') { ui.renaming = ui.menu.i; ui.renameMode = 'name'; closeMenu(); render(); return; }
      if (act === 'abbr') { ui.renaming = ui.menu.i; ui.renameMode = 'abbr'; closeMenu(); render(); return; }
      if (act === 'top') {
        const [p] = sh2.pins.splice(ui.menu.i, 1);
        sh2.pins.unshift(p);
        env.saveSoon();
        closeMenu();
        render();
        return;
      }
      if (act === 'unpin') {
        /* armed two-click — PrismaUI has no confirm(), and a misclick here
           deletes real curation */
        if (!ui.menu.armed) { ui.menu.armed = true; b.textContent = '✕ Remove — sure?'; b.classList.add('armed'); return; }
        const [p] = sh2.pins.splice(ui.menu.i, 1);
        toast('Unpinned “' + nameOf(p) + '”');
        env.saveSoon();
        closeMenu();
        render();
      }
    });
    setTimeout(() => document.addEventListener('mousedown', onMenuAway), 0);
  }

  function onMenuAway(e) {
    const m = document.getElementById('shf-menu');
    if (m && !m.contains(e.target)) closeMenu();
  }

  function closeMenu() {
    document.removeEventListener('mousedown', onMenuAway);
    const m = document.getElementById('shf-menu');
    if (m) m.remove();
    ui.menu = null;
  }

  /* -------------------------------------------------------- app hooks */

  function hookInto(e) {
    env = e;
    ensureDom();
    render();
  }

  /* Called from hdOpen — freshOpen is false for the live-refresh re-push.
     Warms every provider that actually has pins (the spells slice arrives
     via hdSpellsData only on request), then repaints against fresh state. */
  function onOpen(freshOpen) {
    const sh = slice();
    if (!sh) return;
    if (freshOpen) ui.warmed = false;
    if (!ui.warmed && window.HDOmni && typeof HDOmni.providerById === 'function') {
      ui.warmed = true;
      const provs = {};
      sh.pins.forEach((p) => { provs[p.prov] = true; });
      Object.keys(provs).forEach((id) => {
        const pr = HDOmni.providerById(id);
        if (pr && typeof pr.warm === 'function') { try { pr.warm(); } catch (err) {} }
      });
    }
    ui.filter = '';
    const s = root && root.querySelector('.shf-search');
    if (s) s.value = '';
    render();
  }

  /* hdClosed teardown — the menu hangs off document.body, so body.open going
     away does not take it along (the domains closeOverlays lesson). */
  function closeOverlays() { closeMenu(); ui.renaming = -1; ui.drag = null; }

  /* The wing's current layout width, for app.js's resize-grip math: a drag
     must store the DECK's size, not deck+wing, or every drag with the shelf
     out would inflate the saved panel width by the wing. */
  function wingWidth() {
    const sh = slice();
    if (!sh || !document.body.classList.contains('open')) return 0;
    return sh.open ? PANEL_W : RAIL_W;
  }

  return {
    hookInto, onOpen, render, closeOverlays, wingWidth,
    togglePin, isPinned, firePin,
    /* harness seams */
    _ui: ui, _slice: slice, _statusOf: statusOf, _resolve: resolve,
    _visible: visiblePins, _glyphOf: glyphOf,
  };
})();
