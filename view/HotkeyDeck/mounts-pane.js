'use strict';

/* ====================================================================== *
 *  Mounts — the stable (Rober, 2026-08-14: "A mounts tab. It needs to
 *  hook to the actual NPC itself - some are controlled by spells or
 *  earned via a spell so it would be cool if you could add spells as
 *  mounts in this menu and it can auto-detect the npc it conjures.
 *  Searchable list on left, Right uses the mesh rendering framework to
 *  show a nice sizable image of the npc").
 *
 *  The WoW mount-journal shape. C++ owns the stable (mounts.cpp,
 *  mounts.json beside hotkeys.json), the conjured-NPC auto-detect (the
 *  spell record's own kSummonCreature associatedForm) and the physical
 *  verbs; this pane owns the list, the picker and the BIG drag-to-turn
 *  preview. Bodies are Mesh Rendering Framework renders of the NPC's
 *  race-skin NIF (icons/mounts/), with 45°-step turntable frames baked
 *  lazily the first time a preview is dragged — "rotate" is real, it is
 *  just pre-rendered (a live 3D view does not exist in this UI stack).
 *
 *  Bridge — requests: mtState() · mtSpells() · mtAct(json) · mtIcons()
 *  Replies (disjoint, per the deck law): mtStateResult({mrf,count,riding,
 *  mounts}) · mtSpellsData({spells}) · mtActResult({ok,act,found,msg,
 *  mount?}) · mtIconsData({version,icons}). A successful summon/call/
 *  ride/goto gets NO reply — C++ closes the palette and acts.
 *
 *  Host contract (mirrors NpcsPane): MountsPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.MountsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const SPIN_STEP = 45;                 // item_icons.cpp kBodySpinStep — keep in lockstep
  const DRAG_PX_PER_STEP = 36;          // horizontal pixels per turntable frame
  const ICON_POLL_MS = 2800;            // on-disk nudge while renders land one by one
  const ICON_POLL_MAX = 24;
  const FRAME_POLL_MS = 3500;           // re-probe missing turntable frames (≈6s a frame)
  const FRAME_POLL_MAX = 30;

  /* Wheel-zoom on the preview stage. Cursor-anchored CSS transform on the
     render <img>. Ultralight is compositor-off, so scale() re-rasterises at
     layout size — fine for zooming IN (we are magnifying). Clamp 1×–4×; each
     wheel notch steps ZOOM_STEP; a short transition keeps it smooth. */
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.35;               // scale delta per wheel notch

  /* ============================================================== state == */

  const state = {
    ready: false,
    mrf: true,
    riding: null,        // {name,id} | null
    mounts: [],
    categories: [],      // [{id,name}] user categories, rail order
    spells: null,        // picker roster, re-fetched on every picker open
    prefs: {},           // free-form view prefs from mounts.json (pickerSort, …)
  };

  /* The picker sort orders, in rail order. Each is a comparator over the spell
     rows; 'rideable' is the default (the likeliest mounts float up, keeping the
     old behaviour). Every order still ends in an A-Z tiebreak so it is stable
     under the live search filter. The KEY strings are the durable persisted
     values (mounts.json prefs.pickerSort) — never renumber them. */
  const SORTS = [
    ['rideable', '🐴 Rideable first', 'Likeliest mounts up top — the default'],
    ['az',       'A–Z',              'Alphabetical by spell name'],
    ['school',   'School',           'Grouped by magic school, then A–Z'],
    ['learned',  'Learned first',    'Spells in your spellbook before the rest'],
  ];
  function sortKeys() { return SORTS.map(function (s) { return s[0]; }); }
  function validSort(k) { return sortKeys().indexOf(k) !== -1 ? k : 'rideable'; }

  const ui = {
    q: '',
    filter: 'all',       // all | fav | spell | actor
    sel: 0,
    selId: '',           // detail selection (sticky across repaints)
    visible: false,
    toastT: null,
    iconPollT: null,
    iconPollN: 0,
    editing: '',         // '' | 'rename' | 'note'
    removeArmed: false,
    picker: false,
    pickerQ: '',
    pickerSel: 0,
    pickerAll: false,    // false = likely mounts only · true = every candidate
    pickerLearned: false,  // true = show ONLY spells in your spellbook (known:true); loaded from prefs.pickerLearned
    pickerSort: 'rideable',   // one of SORTS[][0]; loaded from prefs.pickerSort
    pickerRefreshing: false,  // a manual ⟳ re-sweep is in flight (spinner)
    catMenu: null,       // {id, x, y} — the move-to-category context menu, or null
    catEditing: '',      // '' | 'new' | '<catId>' — inline category name editor
    dragCat: null,       // id of the mount being dragged onto a category
    catCollapsed: {},    // catId ('' = uncategorised) -> true when folded
    angle: 0,            // preview turntable angle for the selected mount
    dragX: null,
    dragBase: 0,
    zoom: 1,             // preview magnification (1 = fit); reset when the mount changes
    zoomOX: 50,          // cursor-anchored transform origin, % of the img box
    zoomOY: 50,
    spinAsked: {},       // mountId -> 1 (this session)
    frames: {},          // img-path -> {45:'ok'|'bad', …} probe results
    framePollT: null,
    framePollN: 0,
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'mtState') setTimeout(devState, 30);
      if (DEV && fn === 'mtSpells') setTimeout(devSpells, 30);
      if (DEV && fn === 'mtAct') setTimeout(function () { devAct(arg); }, 30);
    }
  }

  window.mtStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = true;
    state.mrf = d.mrf !== false;
    state.riding = (d.riding && typeof d.riding === 'object') ? d.riding : null;
    state.mounts = Array.isArray(d.mounts) ? d.mounts : [];
    state.categories = Array.isArray(d.categories) ? d.categories : [];
    /* Adopt persisted view prefs. Feature-detected: an older DLL that never
       heard of prefs just omits the key, and we keep the current default. The
       persisted sort is the source of truth (it also carries a change made from
       another surface), so mirror it into the live ui each time state lands. */
    state.prefs = (d.prefs && typeof d.prefs === 'object') ? d.prefs : {};
    if (typeof state.prefs.pickerSort === 'string')
      ui.pickerSort = validSort(state.prefs.pickerSort);
    if (typeof state.prefs.pickerLearned === 'boolean')
      ui.pickerLearned = state.prefs.pickerLearned;
    /* The riding flag is derived HERE from riding.id (C++ marks the row too,
       but one derivation in one place can never disagree with the chip). */
    if (state.riding && state.riding.id)
      for (let i = 0; i < state.mounts.length; i++)
        if (state.mounts[i].id === state.riding.id) state.mounts[i].riding = true;
    if (ui.selId && !byId(ui.selId)) { ui.selId = ''; ui.angle = 0; }
    /* A category filter whose category was just deleted would show an empty
       list forever — fall back to All rather than stranding the user. */
    if (ui.filter.indexOf('cat:') === 0 && !catById(ui.filter.slice(4))) ui.filter = 'all';
    if (ui.visible) { render(); startIconPoll(); }
  };

  window.mtSpellsData = function (d) {
    if (!d || typeof d !== 'object') return;
    state.spells = Array.isArray(d.spells) ? d.spells : [];
    ui.pickerRefreshing = false;   // the sweep answered — stop the spinner
    if (ui.visible && ui.picker) renderPicker();
  };

  window.mtActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    /* A caller outside this pane (the F7 quick card's "Add as mount") can hand
       us a one-shot callback for the NEXT addLook reply, so the {ok,msg} lands
       on ITS surface instead of a toast the hidden Mounts pane would swallow.
       Consumed once, per (open × person) — see addLookingAt. */
    if (d.act === 'addLook' && pendingAddCb) {
      const cb = pendingAddCb;
      pendingAddCb = null;
      try { cb({ ok: d.ok !== false, msg: d.msg || (d.ok ? 'Added to your mounts' : 'Could not add') }); }
      catch (e) { console.log('mounts addLook cb error', e); }
      if (d.ok) toGame('mtState');   // keep the stable current for when the tab opens
      return;                        // the card owns the message; no pane toast
    }
    /* setPref (the picker sort) is a silent write — no toast, and no state
       re-ask that would churn the list under the open picker overlay. */
    if (d.act === 'setPref') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (d.ok) {
      if (d.mount && d.mount.id) ui.selId = d.mount.id;
      toGame('mtState');   // the stable changed — repaint from truth
    }
  };

  /* Feature 4: the Followers-tab quick card calls this to add whoever is under
     the crosshair as a mount, WITHOUT reimplementing any mount logic — it fires
     the module's own addLook verb (which snapshots the crosshair ref at palette
     open, exactly as the Mounts tab does) and routes the honest {ok,msg} reply
     to `cb` so a refusal ("that one is dead", "nothing durable to store") shows
     on the card. Guarded to one in-flight add so a double-click can't strand a
     callback. */
  let pendingAddCb = null;
  function addLookingAt(cb) {
    pendingAddCb = (typeof cb === 'function') ? cb : null;
    act({ act: 'addLook' });
  }

  /* Body renders landed (C++ batch push, or our mtIcons nudge). Rows carry
     their img off mtStateResult; this merges later-landing art in place. */
  window.mtIconsData = function (d) {
    if (!d || typeof d !== 'object' || typeof d.icons !== 'object' || !d.icons) return;
    let changed = false;
    for (let i = 0; i < state.mounts.length; i++) {
      const m = state.mounts[i];
      const key = iconKey(m);
      if (key && d.icons[key] && m.img !== d.icons[key]) { m.img = d.icons[key]; changed = true; }
    }
    if (changed && ui.visible) render();
  };

  /* ============================================================ helpers == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }
  function byId(id) {
    for (let i = 0; i < state.mounts.length; i++)
      if (state.mounts[i].id === id) return state.mounts[i];
    return null;
  }

  /* The C++ KeyOf contract: UPPERCASE whole fid ("0x81A" -> "0X81A"),
     lowercase plugin. One function owns that here. */
  function iconKey(m) {
    if (!m || !m.npId || !m.npPlugin) return '';
    return String(m.npId).toUpperCase() + '|' + String(m.npPlugin).toLowerCase();
  }

  /* THE TURNTABLE FILENAME CONTRACT (item_icons.cpp AngleFile, verbatim):
     angle 0 = the file untouched; else "<stem>-aNNN.png", three digits. */
  function angleFile(file, angle) {
    angle = ((angle | 0) % 360 + 360) % 360;
    if (!file || angle === 0) return file || '';
    const stem = /\.png$/i.test(file) ? file.slice(0, -4) : file;
    return stem + '-a' + ('00' + angle).slice(-3) + '.png';
  }

  function glyphOf(m) { return m.kind === 'spell' ? '✨' : '🐴'; }

  /* ========================================================= categories == */

  function catById(id) {
    if (!id) return null;
    for (let i = 0; i < state.categories.length; i++)
      if (state.categories[i].id === id) return state.categories[i];
    return null;
  }
  function catName(id) { const c = catById(id); return c ? c.name : ''; }
  /* The category a mount is FILED under, tolerant of a stale id (a category
     deleted by another surface): an unknown id reads as uncategorised. */
  function catOf(m) { return (m && m.cat && catById(m.cat)) ? m.cat : ''; }

  /* ========================================================== filtering == */

  function filtered() {
    const toks = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    const catFilter = ui.filter.indexOf('cat:') === 0 ? ui.filter.slice(4) : null;
    const out = [];
    for (let i = 0; i < state.mounts.length; i++) {
      const m = state.mounts[i];
      if (ui.filter === 'fav' && !m.fav) continue;
      if (ui.filter === 'spell' && m.kind !== 'spell') continue;
      if (ui.filter === 'actor' && m.kind !== 'actor') continue;
      if (ui.filter === 'uncat' && catOf(m) !== '') continue;
      if (catFilter !== null && catOf(m) !== catFilter) continue;
      const hay = (String(m.name || '') + ' ' + String(m.race || '') + ' ' +
        String(m.spName || '') + ' ' + String(m.note || '') + ' ' +
        String(m.plug || '') + ' ' + String(catName(catOf(m)) || '')).toLowerCase();
      let ok = true;
      for (let t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) === -1) { ok = false; break; }
      if (ok) out.push(m);
    }
    out.sort(function (a, b) {
      if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return out;
  }

  /* The list, grouped for the section-header view: an ordered array of
     { id, name, mounts:[…] }. Uncategorised comes first only when it has rows;
     each user category appears in rail order even when empty (so it stays a
     visible drop target). Favourites still sort first WITHIN each group. */
  function grouped(rows) {
    const byCat = {};
    for (let i = 0; i < rows.length; i++) {
      const c = catOf(rows[i]);
      (byCat[c] || (byCat[c] = [])).push(rows[i]);
    }
    const groups = [];
    if (byCat[''] && byCat[''].length) groups.push({ id: '', name: 'Uncategorised', mounts: byCat[''] });
    for (let i = 0; i < state.categories.length; i++) {
      const c = state.categories[i];
      groups.push({ id: c.id, name: c.name, mounts: byCat[c.id] || [] });
    }
    return groups;
  }

  /* ============================================================= actions == */

  function act(payload) { toGame('mtAct', JSON.stringify(payload)); }

  /* Persist one free-form view preference into mounts.json (C++ round-trips the
     whole prefs object, so an older DLL keeps keys it doesn't know). The reply
     is swallowed in mtActResult — this is fire-and-forget. */
  function setPref(key, value) {
    state.prefs[key] = value;   // reflect locally so a repaint before the reply agrees
    act({ act: 'setPref', key: key, value: value });
  }

  /* File a mount into a category (or '' for uncategorised). A no-op when it is
     already there, so a drop onto its own section doesn't churn the config. */
  function fileMount(mountId, catId) {
    const m = byId(mountId);
    if (!m) return;
    if (catOf(m) === (catId || '')) { toast('Already in ' + (catId ? catName(catId) : 'Uncategorised')); return; }
    act({ act: 'setCat', id: mountId, cat: catId || '' });
  }

  /* The move-to-category context menu (right-click a category chip, a section
     header, or a row). Rename / Delete for a real category; the "move THIS
     mount to…" list when a mount id is supplied. Mounted into #overlay-anchored
     body so it is never clipped by the pane's overflow, self-scaled by the deck
     the same way the other overlay popups are (app.js reads --ui-scale). */
  function closeCatMenu() {
    ui.catMenu = null;
    const el = $('mt-catmenu');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    document.removeEventListener('mousedown', onCatMenuOutside, true);
  }
  function onCatMenuOutside(e) {
    const el = $('mt-catmenu');
    if (el && !el.contains(e.target)) closeCatMenu();
  }
  function openCatMenu(catId, x, y) {
    closeCatMenu();
    ui.catMenu = { id: catId, x: x, y: y };
    const menu = document.createElement('div');
    menu.id = 'mt-catmenu';
    menu.className = 'mt-catmenu';
    let html = '';
    if (catId) {
      html += '<div class="mt-cm-head">' + esc(catName(catId)) + '</div>';
      html += '<button class="mt-cm-item" data-act="rename">✎ Rename</button>';
      const idx = state.categories.findIndex(function (c) { return c.id === catId; });
      if (idx > 0) html += '<button class="mt-cm-item" data-act="up">▲ Move up</button>';
      if (idx >= 0 && idx < state.categories.length - 1) html += '<button class="mt-cm-item" data-act="down">▼ Move down</button>';
      html += '<button class="mt-cm-item mt-cm-danger" data-act="del">✕ Delete category</button>';
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    // clamp on-screen, then apply the deck's own scale so it isn't tiny at Fill
    const scale = (typeof window.deckPaintScale === 'function') ? window.deckPaintScale() : 1;
    const r = menu.getBoundingClientRect();
    let px = x, py = y;
    if (px + r.width > window.innerWidth - 8) px = window.innerWidth - r.width - 8;
    if (py + r.height > window.innerHeight - 8) py = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
    menu.style.transform = 'scale(' + scale + ')';
    menu.style.transformOrigin = 'top left';
    menu.querySelectorAll('.mt-cm-item').forEach(function (b) {
      b.addEventListener('click', function () {
        const a = b.getAttribute('data-act');
        closeCatMenu();
        if (a === 'rename') beginCatEdit(catId);
        else if (a === 'del') act({ act: 'catDel', cat: catId });
        else if (a === 'up' || a === 'down') moveCat(catId, a === 'up' ? -1 : 1);
      });
    });
    setTimeout(function () { document.addEventListener('mousedown', onCatMenuOutside, true); }, 0);
  }

  function moveCat(catId, dir) {
    const ids = state.categories.map(function (c) { return c.id; });
    const i = ids.indexOf(catId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    act({ act: 'catReorder', order: ids });
  }

  function rideable(m) {
    if (m.kind === 'spell') return m.known !== false;
    return m.found !== false && m.dead !== true;
  }

  function rideBlockReason(m) {
    if (m.kind === 'spell') {
      if (m.known === false) return "You don't know " + (m.spName || 'its spell') + ' yet';
      return '';
    }
    if (m.dead === true) return m.name + ' is dead';
    if (m.found === false) return m.name + ' is nowhere the game can reach right now';
    return '';
  }

  function doRide(m) {
    if (!m) return;
    const why = rideBlockReason(m);
    if (why) { toast(why, true); return; }
    act({ act: 'ride', id: m.id });
  }

  /* ============================================================= render == */

  function renderHeader() {
    const chip = $('mt-count-chip');
    if (chip) {
      const n = state.mounts.length;
      chip.textContent = state.ready ? (n + (n === 1 ? ' mount' : ' mounts')) : 'reading the stable…';
    }
    const riding = $('mt-riding-chip');
    if (riding) {
      const on = state.riding && state.riding.name;
      riding.classList.toggle('hidden', !on);
      riding.textContent = on ? ('🐴 Riding ' + state.riding.name) : '';
    }
    const note = $('mt-mrf-note');
    if (note) note.classList.toggle('hidden', state.mrf);
  }

  const FILTERS = [
    ['all',   'All',        'Everything in the stable'],
    ['fav',   '★ Favorites', 'Only the mounts you starred'],
    ['spell', '✨ Summons',  'Mounts a spell conjures'],
    ['actor', '🐴 Beasts',   'Flesh-and-blood mounts added from the crosshair'],
  ];

  function renderPills() {
    const box = $('mt-pills');
    if (!box) return;
    if (ui.catEditing) return;   // the inline name editor owns this row right now
    let html = FILTERS.map(function (f) {
      return '<button class="mt-pill' + (ui.filter === f[0] ? ' mt-pill-on' : '') +
        '" data-f="' + f[0] + '" title="' + esc(f[2]) + '">' + esc(f[1]) + '</button>';
    }).join('');
    // A divider, then one filter chip per user category (drop targets too), then
    // the New-category affordance. Every chip is a drop target for a dragged
    // mount, so filing is drag-onto-the-chip as well as via the row menu.
    if (state.categories.length) {
      html += '<span class="mt-pill-div" aria-hidden="true"></span>';
      for (let i = 0; i < state.categories.length; i++) {
        const c = state.categories[i];
        const n = state.mounts.reduce(function (a, m) { return a + (catOf(m) === c.id ? 1 : 0); }, 0);
        const on = ui.filter === 'cat:' + c.id;
        html += '<button class="mt-pill mt-pill-cat' + (on ? ' mt-pill-on' : '') +
          '" data-f="cat:' + esc(c.id) + '" data-cat="' + esc(c.id) + '" ' +
          'title="' + esc(c.name) + ' — ' + n + ' mount' + (n === 1 ? '' : 's') +
          ' · drag a mount here to file it, right-click to rename or delete">' +
          esc(c.name) + '<span class="mt-pill-n">' + n + '</span></button>';
      }
    }
    html += '<button class="mt-pill mt-pill-new" data-new="1" ' +
      'title="Create a category">＋ Category</button>';
    box.innerHTML = html;

    box.querySelectorAll('.mt-pill').forEach(function (b) {
      const cat = b.getAttribute('data-cat');
      if (b.getAttribute('data-new')) {
        b.addEventListener('click', function () { beginCatEdit('new'); });
        return;
      }
      b.addEventListener('click', function () {
        ui.filter = b.getAttribute('data-f');
        ui.sel = 0;
        render();
        const s = $('mt-search');
        if (s) s.focus();
      });
      if (cat != null) {
        b.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          openCatMenu(cat, e.clientX, e.clientY);
        });
        // drop target: dragging a mount row onto the chip files it here
        b.addEventListener('dragover', function (e) { if (ui.dragCat) { e.preventDefault(); b.classList.add('mt-pill-drop'); } });
        b.addEventListener('dragleave', function () { b.classList.remove('mt-pill-drop'); });
        b.addEventListener('drop', function (e) {
          e.preventDefault();
          b.classList.remove('mt-pill-drop');
          if (ui.dragCat) fileMount(ui.dragCat, cat);
        });
      }
    });
  }

  /* Inline category name editor — reuses the picker-modal-free idiom: a small
     prompt row that replaces the pills area. 'new' creates, a catId renames. */
  function beginCatEdit(which) {
    ui.catEditing = which;
    const box = $('mt-pills');
    if (!box) return;
    const cur = which === 'new' ? '' : catName(which);
    box.innerHTML = '<div class="mt-catedit">' +
      '<input id="mt-catedit-input" type="text" maxlength="40" value="' + esc(cur) + '" ' +
      'placeholder="' + (which === 'new' ? 'New category name — Enter creates, Esc cancels' : 'Rename — Enter saves, Esc cancels') + '">' +
      '<button class="mt-btn mt-btn-primary" id="mt-catedit-save">' + (which === 'new' ? 'Create' : 'Save') + '</button>' +
      '<button class="mt-btn" id="mt-catedit-cancel">Cancel</button></div>';
    const inp = $('mt-catedit-input');
    const done = function () { ui.catEditing = ''; renderPills(); };
    function commit() {
      const v = inp.value.trim();
      if (!v) { done(); return; }
      if (which === 'new') act({ act: 'catAdd', name: v });
      else act({ act: 'catRename', cat: which, name: v });
      done();
    }
    $('mt-catedit-save').addEventListener('click', commit);
    $('mt-catedit-cancel').addEventListener('click', done);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commit(); e.stopPropagation(); }
      else if (e.key === 'Escape') { done(); e.stopPropagation(); }
      else e.stopPropagation();
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }

  function rowHtml(m, idx) {
    const selected = m.id === ui.selId;
    let chips = '';
    if (m.riding) chips += '<span class="mt-chip mt-chip-riding" title="You are on this one right now">riding</span>';
    if (m.kind === 'spell') {
      if (m.known === false) chips += '<span class="mt-chip mt-chip-warn" title="' + esc((m.spName || 'Its spell') + ' is not in your spellbook yet') + '">unlearned</span>';
    } else if (m.found === false) {
      chips += '<span class="mt-chip mt-chip-warn" title="Nowhere the game can reach right now — it may be in an unloaded cell">away</span>';
    } else if (m.dead === true) {
      chips += '<span class="mt-chip mt-chip-warn">dead</span>';
    }
    const img = m.img
      ? '<img src="' + esc(m.img) + '" alt="" draggable="false" onerror="this.parentNode.removeChild(this)">'
      : '';
    // The KIND chip (summon/beast) is always present — categories are a second,
    // orthogonal axis, so seeing "beast" AND "Riverwood horses" together is the
    // point (Rober: keep the kind chip visible regardless of category).
    const cat = catOf(m);
    const catChip = cat
      ? '<span class="mt-chip mt-chip-cat" title="Category: ' + esc(catName(cat)) + '">' + esc(catName(cat)) + '</span>'
      : '';
    return '<div class="mt-row' + (selected ? ' mt-sel' : '') + '" draggable="true" data-id="' + esc(m.id) + '" data-idx="' + idx + '">' +
      '<div class="mt-plate">' + glyphOf(m) + img + '</div>' +
      '<div class="mt-mid">' +
      '<div class="mt-name">' + (m.fav ? '<span class="mt-fav-star">★</span>' : '') +
      '<span title="' + esc(m.name) + '">' + highlight(m.name, ui.q) + '</span>' + chips + '</div>' +
      '<div class="mt-meta">' +
      '<span class="mt-chip ' + (m.kind === 'spell' ? 'mt-chip-spell' : 'mt-chip-beast') + '">' +
      (m.kind === 'spell' ? '✨ summon' : '🐴 beast') + '</span>' +
      catChip +
      '<span title="' + esc(m.race || '') + '">' + esc(m.race || '') + '</span>' +
      '</div></div>' +
      '<button class="mt-row-cat" data-catbtn="1" title="Move ' + esc(m.name) + ' to a category">⋯</button>' +
      '</div>';
  }

  function wireRow(row) {
    const id = row.getAttribute('data-id');
    row.addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-catbtn')) return;
      select(id);
    });
    row.addEventListener('dblclick', function () { doRide(byId(id)); });
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      openMountCatMenu(id, e.clientX, e.clientY);
    });
    // drag a row onto a category chip / section header to file it
    row.addEventListener('dragstart', function (e) {
      ui.dragCat = id;
      row.classList.add('mt-dragging-row');
      if (e.dataTransfer) { try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} }
    });
    row.addEventListener('dragend', function () {
      ui.dragCat = null;
      row.classList.remove('mt-dragging-row');
    });
    const cb = row.querySelector('[data-catbtn]');
    if (cb) cb.addEventListener('click', function (e) {
      e.stopPropagation();
      openMountCatMenu(id, e.clientX, e.clientY);
    });
  }

  /* The per-mount "move to…" menu — the category list plus Uncategorised, each
     a one-click file, then the category-management verbs. Reuses the catmenu
     shell so there is one popup, one placement/scale path. */
  function openMountCatMenu(mountId, x, y) {
    closeCatMenu();
    const m = byId(mountId);
    if (!m) return;
    ui.catMenu = { id: '', x: x, y: y, mount: mountId };
    const cur = catOf(m);
    const menu = document.createElement('div');
    menu.id = 'mt-catmenu';
    menu.className = 'mt-catmenu';
    let html = '<div class="mt-cm-head">Move “' + esc(m.name) + '” to</div>';
    html += '<button class="mt-cm-item' + (cur === '' ? ' mt-cm-on' : '') + '" data-file="">' +
      (cur === '' ? '✓ ' : '') + 'Uncategorised</button>';
    for (let i = 0; i < state.categories.length; i++) {
      const c = state.categories[i];
      html += '<button class="mt-cm-item' + (cur === c.id ? ' mt-cm-on' : '') + '" data-file="' + esc(c.id) + '">' +
        (cur === c.id ? '✓ ' : '') + esc(c.name) + '</button>';
    }
    html += '<button class="mt-cm-item mt-cm-plus" data-newcat="1">＋ New category…</button>';
    menu.innerHTML = html;
    document.body.appendChild(menu);
    const scale = (typeof window.deckPaintScale === 'function') ? window.deckPaintScale() : 1;
    const r = menu.getBoundingClientRect();
    let px = x, py = y;
    if (px + r.width > window.innerWidth - 8) px = window.innerWidth - r.width - 8;
    if (py + r.height > window.innerHeight - 8) py = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
    menu.style.transform = 'scale(' + scale + ')';
    menu.style.transformOrigin = 'top left';
    menu.querySelectorAll('.mt-cm-item').forEach(function (b) {
      b.addEventListener('click', function () {
        closeCatMenu();
        if (b.getAttribute('data-newcat')) { beginCatEdit('new'); return; }
        fileMount(mountId, b.getAttribute('data-file'));
      });
    });
    setTimeout(function () { document.addEventListener('mousedown', onCatMenuOutside, true); }, 0);
  }

  function sectionHeaderHtml(g) {
    const collapsed = !!ui.catCollapsed[g.id];
    return '<div class="mt-sec" data-cat="' + esc(g.id) + '">' +
      '<button class="mt-sec-head' + (collapsed ? ' mt-sec-collapsed' : '') + '" data-cat="' + esc(g.id) + '">' +
      '<span class="mt-sec-chev">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="mt-sec-name">' + esc(g.name) + '</span>' +
      '<span class="mt-sec-n">' + g.mounts.length + '</span>' +
      (g.id ? '<span class="mt-sec-gear" data-catgear="' + esc(g.id) + '" title="Rename or delete this category">⚙</span>' : '') +
      '</button></div>';
  }

  function renderList() {
    const list = $('mt-list');
    const empty = $('mt-empty');
    if (!list || !empty) return;

    if (!state.ready) {
      list.innerHTML = new Array(5).fill(
        '<div class="mt-row mt-skel"><div class="mt-plate mt-skel-box"></div>' +
        '<div class="mt-mid"><span class="mt-skel-box mt-skel-w1"></span>' +
        '<span class="mt-skel-box mt-skel-w2"></span></div></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const rows = filtered();

    if (!state.mounts.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="mt-hero-glyph">🐴</div>' +
        '<div class="mt-empty-title">Your stable is empty</div>' +
        '<div class="mt-empty-sub">Two ways in: <b>look at a horse or beast</b> in the world and press ' +
        '“Add what I’m looking at”, or <b>add a summon spell</b> — the deck reads the spell’s own ' +
        'record to learn which creature it conjures, so Ride can cast it and hop on the moment it lands.' +
        (state.mrf ? '' : ' <b>Previews are off</b> — Mesh Rendering Framework is not installed, so rows keep their glyphs.') +
        '</div>';
      return;
    }

    if (!rows.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = '<div class="mt-empty-title">No mount matches</div>' +
        '<div class="mt-empty-sub">Nothing called “' + esc(ui.q) + '”' +
        (ui.filter !== 'all' ? ' under that pill' : '') + '. Try fewer letters or another pill.</div>';
      return;
    }
    empty.classList.add('hidden');

    // Section-header grouping is used ONLY when the view is showing everything
    // (no single-category / kind filter and no search) AND at least one user
    // category exists — otherwise a flat list reads cleaner. A single-category
    // filter is already one group, so it stays flat too.
    const grouping = state.categories.length && ui.filter === 'all' && !ui.q;

    let html = '';
    if (grouping) {
      const groups = grouped(rows);
      let idx = 0;
      for (let g = 0; g < groups.length; g++) {
        html += sectionHeaderHtml(groups[g]);
        if (!ui.catCollapsed[groups[g].id]) {
          html += '<div class="mt-sec-body" data-cat="' + esc(groups[g].id) + '">';
          for (let i = 0; i < groups[g].mounts.length; i++) html += rowHtml(groups[g].mounts[i], idx++);
          if (!groups[g].mounts.length)
            html += '<div class="mt-sec-empty">Drag a mount here to file it under ' + esc(groups[g].name) + '.</div>';
          html += '</div>';
        }
      }
    } else {
      for (let i = 0; i < rows.length; i++) html += rowHtml(rows[i], i);
    }
    list.innerHTML = html;

    list.querySelectorAll('.mt-row').forEach(wireRow);

    // Section headers: collapse toggle, gear menu, and drop target.
    list.querySelectorAll('.mt-sec-head').forEach(function (head) {
      const cid = head.getAttribute('data-cat');
      head.addEventListener('click', function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-catgear')) {
          e.stopPropagation();
          openCatMenu(cid, e.clientX, e.clientY);
          return;
        }
        ui.catCollapsed[cid] = !ui.catCollapsed[cid];
        renderList();
      });
      if (cid) head.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openCatMenu(cid, e.clientX, e.clientY);
      });
    });
    // Section bodies AND headers are drop targets (drop anywhere in the group).
    list.querySelectorAll('.mt-sec-body, .mt-sec-head').forEach(function (zone) {
      const cid = zone.getAttribute('data-cat');
      zone.addEventListener('dragover', function (e) { if (ui.dragCat) { e.preventDefault(); zone.classList.add('mt-drop-here'); } });
      zone.addEventListener('dragleave', function () { zone.classList.remove('mt-drop-here'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault();
        zone.classList.remove('mt-drop-here');
        if (ui.dragCat) fileMount(ui.dragCat, cid || '');
      });
    });
  }

  function statusLine(m) {
    if (m.kind === 'spell') {
      const bits = [];
      if (m.spName) bits.push('Conjured by <b>' + esc(m.spName) + '</b>');
      if (m.npKnown === false)
        bits.push('<span title="The spell record does not name what it summons (a script does the work), so Ride just casts it">its record hides what it conjures</span>');
      if (m.known === false) bits.push('<b>not in your spellbook yet</b>');
      return bits.join(' · ');
    }
    if (m.dead === true) return '<b>Dead.</b>';
    if (m.found === false) return 'Nowhere the game can reach right now — it may be stabled in an unloaded cell.';
    if (m.riding) return 'You are riding this one right now.';
    if (m.loaded === false) return 'Somewhere else in the world — Call brings it to you.';
    return m.near ? 'Standing near you.' : 'Loaded and reachable.';
  }

  function detailActionsHtml(m) {
    const why = rideBlockReason(m);
    let h = '<button class="mt-btn mt-btn-primary" data-a="ride"' + (why ? ' disabled title="' + esc(why) + '"' : ' title="One press: get on it — a summon is cast and mounted the moment it lands"') + '>⚡ Ride</button>';
    if (m.kind === 'spell')
      h += '<button class="mt-btn" data-a="summon"' + (m.known === false ? ' disabled title="' + esc(why) + '"' : ' title="Cast the summon without mounting"') + '>✨ Summon</button>';
    else {
      h += '<button class="mt-btn" data-a="call" title="Teleport it to you">⤝ Call</button>';
      h += '<button class="mt-btn" data-a="goto" title="Teleport yourself to it">⤞ Go to</button>';
    }
    h += '<button class="mt-btn" data-a="fav" title="' + (m.fav ? 'Unstar' : 'Star — favorites sort first') + '">' + (m.fav ? '★ Starred' : '☆ Star') + '</button>';
    h += '<button class="mt-btn" data-a="rename" title="Rename this mount (the game name is untouched)">✎ Rename</button>';
    h += '<button class="mt-btn" data-a="note" title="A note to self on this mount">🗒 Note</button>';
    h += '<button class="mt-btn' + (ui.removeArmed ? ' mt-btn-danger-armed' : '') + '" data-a="remove" title="Release it from the stable (the creature itself is untouched)">' +
      (ui.removeArmed ? '✕ Really release?' : '✕ Release') + '</button>';
    return h;
  }

  function renderDetail() {
    const box = $('mt-detail');
    if (!box) return;
    const m = byId(ui.selId);
    if (!m) {
      box.innerHTML =
        '<div class="mt-d-head"><div class="mt-d-name">Pick a mount</div></div>' +
        '<div class="mt-stage"><div class="mt-stage-glyph">🐴</div>' +
        '<div class="mt-stage-hint">Select one on the left — its body renders here, big. Drag to turn it.</div></div>';
      return;
    }

    const src = stageSrc(m);
    box.innerHTML =
      '<div class="mt-d-head">' +
      '<div class="mt-d-name">' + (m.fav ? '<span class="mt-fav-star">★</span> ' : '') + esc(m.name) + '</div>' +
      '<div class="mt-d-sub">' + esc(m.race || '') + (m.plug ? ' · ' + esc(m.plug) : '') +
      (m.kind === 'spell' ? ' · summon' : ' · beast') + '</div>' +
      '</div>' +
      '<div class="mt-stage" id="mt-stage" title="Drag to turn · scroll to zoom · double-click to reset">' +
      (src
        ? '<img id="mt-stage-img" src="' + esc(src) + '" alt="" draggable="false">'
        : '<div class="mt-stage-glyph">' + glyphOf(m) + '</div>') +
      '<div class="mt-stage-note' + (stageNote(m) ? '' : ' hidden') + '" id="mt-stage-note">' + esc(stageNote(m)) + '</div>' +
      '<div class="mt-stage-hint">' + (m.img ? '⟲ drag to turn · scroll to zoom' :
        (state.mrf ? 'render on its way — it appears here when the framework finishes' : 'previews off — Mesh Rendering Framework is not installed')) + '</div>' +
      '</div>' +
      '<div class="mt-status' + ((m.kind === 'spell' ? m.known === false : (m.found === false || m.dead)) ? ' mt-status-warn' : '') + '">' +
      statusLine(m) + '</div>' +
      (m.note && ui.editing !== 'note' ? '<div class="mt-status">🗒 ' + esc(m.note) + '</div>' : '') +
      (ui.editing ? editRowHtml(m) : '') +
      '<div class="mt-actions" id="mt-actions">' + detailActionsHtml(m) + '</div>';

    wireStage(m);
    wireDetailActions(m);
    if (ui.editing) wireEditRow(m);
  }

  function editRowHtml(m) {
    const val = ui.editing === 'rename' ? m.name : (m.note || '');
    const ph = ui.editing === 'rename' ? 'New name — Enter saves, Esc cancels' : 'A note to self — Enter saves, Esc cancels';
    return '<div class="mt-edit-row"><input id="mt-edit-input" type="text" maxlength="' +
      (ui.editing === 'rename' ? 64 : 300) + '" value="' + esc(val) + '" placeholder="' + esc(ph) + '">' +
      '<button class="mt-btn" id="mt-edit-save">Save</button></div>';
  }

  function wireEditRow(m) {
    const inp = $('mt-edit-input');
    const save = $('mt-edit-save');
    if (!inp || !save) return;
    function commit() {
      const v = inp.value.trim();
      if (ui.editing === 'rename') { if (v) act({ act: 'rename', id: m.id, name: v }); }
      else act({ act: 'note', id: m.id, note: v });
      ui.editing = '';
      renderDetail();
    }
    save.addEventListener('click', commit);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commit(); e.stopPropagation(); }
      else if (e.key === 'Escape') { ui.editing = ''; renderDetail(); e.stopPropagation(); }
      else e.stopPropagation();   // typing must never fall through to the palette
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }

  function wireDetailActions(m) {
    const box = $('mt-actions');
    if (!box) return;
    box.querySelectorAll('.mt-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        const a = b.getAttribute('data-a');
        if (a === 'ride') { doRide(m); return; }
        if (a === 'summon' || a === 'call' || a === 'goto') { act({ act: a, id: m.id }); return; }
        if (a === 'fav') { act({ act: 'fav', id: m.id, on: !m.fav }); return; }
        if (a === 'rename' || a === 'note') { ui.editing = a; ui.removeArmed = false; renderDetail(); return; }
        if (a === 'remove') {
          if (!ui.removeArmed) { ui.removeArmed = true; renderDetail(); return; }
          ui.removeArmed = false;
          act({ act: 'remove', id: m.id });
          ui.selId = '';
        }
      });
    });
  }

  /* ------------------------------------------------ the turntable stage -- */

  function frameStateFor(m) {
    if (!m.img) return null;
    let f = ui.frames[m.img];
    if (!f) f = ui.frames[m.img] = {};
    return f;
  }

  /* The best drawable frame at the desired angle: the exact frame when its
     file has probed good, else frame 0 (which always exists — it is the img
     the row already shows). */
  function stageSrc(m) {
    if (!m.img) return '';
    const a = ((ui.angle | 0) % 360 + 360) % 360;
    if (a === 0) return m.img;
    const f = frameStateFor(m);
    return (f && f[a] === 'ok') ? angleFile(m.img, a) : m.img;
  }

  function stageNote(m) {
    if (!m.img || !ui.spinAsked[m.id]) return '';
    const f = frameStateFor(m) || {};
    let okN = 0, total = 0;
    for (let a = SPIN_STEP; a < 360; a += SPIN_STEP) { total++; if (f[a] === 'ok') okN++; }
    if (okN >= total) return '';
    return '⟲ baking turntable — ' + (okN + 1) + '/' + (total + 1) + ' frames';
  }

  function probeFrames(m) {
    const f = frameStateFor(m);
    if (!f) return;
    for (let a = SPIN_STEP; a < 360; a += SPIN_STEP) {
      if (f[a] === 'ok' || f[a] === 'probing') continue;
      f[a] = 'probing';
      (function (angle) {
        const img = new Image();
        img.onload = function () {
          f[angle] = 'ok';
          const cur = byId(ui.selId);
          if (ui.visible && cur && cur.img === m.img) renderDetail();
        };
        img.onerror = function () { f[angle] = 'bad'; };
        img.src = angleFile(m.img, angle);
      })(a);
    }
  }

  function framesMissing(m) {
    const f = frameStateFor(m);
    if (!f) return false;
    for (let a = SPIN_STEP; a < 360; a += SPIN_STEP) if (f[a] !== 'ok') return true;
    return false;
  }

  function stopFramePoll() {
    if (ui.framePollT) { clearInterval(ui.framePollT); ui.framePollT = null; }
  }

  function startFramePoll(m) {
    stopFramePoll();
    ui.framePollN = 0;
    ui.framePollT = setInterval(function () {
      const cur = byId(ui.selId);
      if (!ui.visible || !cur || cur.img !== m.img || !framesMissing(cur) ||
          ++ui.framePollN > FRAME_POLL_MAX) {
        stopFramePoll();
        return;
      }
      const f = frameStateFor(cur);
      for (let a = SPIN_STEP; a < 360; a += SPIN_STEP) if (f[a] === 'bad') delete f[a];
      probeFrames(cur);
    }, FRAME_POLL_MS);
  }

  /* ------------------------------------------------- wheel-zoom the render -- */

  /* Push the current zoom onto the render img. transform-origin is the
     cursor-anchored point (percent of the img box) so a wheel-in magnifies
     toward the pointer; at zoom 1 we snap origin back to centre so the fitted
     image sits square. A short ease makes the step smooth; overflow:hidden on
     the stage clips anything that spills. */
  function applyZoom(smooth) {
    const img = $('mt-stage-img');
    if (!img) return;
    const z = ui.zoom;
    if (z <= 1.0001) { ui.zoomOX = 50; ui.zoomOY = 50; }
    img.style.transformOrigin = ui.zoomOX + '% ' + ui.zoomOY + '%';
    img.style.transition = smooth ? 'transform 120ms ease-out' : 'none';
    img.style.transform = z > 1.0001 ? ('scale(' + z.toFixed(3) + ')') : 'none';
  }

  function resetZoom() {
    ui.zoom = 1; ui.zoomOX = 50; ui.zoomOY = 50;
    applyZoom(true);
  }

  function onStageWheel(e) {
    const img = $('mt-stage-img');
    if (!img) return;
    // Anchor the zoom on the point under the cursor, expressed as a percent of
    // the img's own layout box (which may be letterboxed inside the stage).
    const r = img.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      ui.zoomOX = +(px * 100).toFixed(2);
      ui.zoomOY = +(py * 100).toFixed(2);
    }
    const dir = e.deltaY < 0 ? 1 : -1;   // wheel up = zoom in
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, ui.zoom + dir * ZOOM_STEP));
    // Always eat the wheel over the stage so the pane/list never scrolls while
    // the pointer is on the render — even at the clamp ends.
    e.preventDefault();
    e.stopPropagation();
    if (Math.abs(next - ui.zoom) < 0.001) return;
    ui.zoom = next;
    applyZoom(true);
  }

  function wireStage(m) {
    const stage = $('mt-stage');
    if (!stage || !m.img) return;
    // Restore any live zoom after a repaint, and honour cursor-zoom on wheel.
    applyZoom(false);
    stage.addEventListener('wheel', onStageWheel, { passive: false });
    // Double-click resets to fit — the cleanest "un-zoom" that doesn't steal a
    // corner of the stage for a control.
    stage.addEventListener('dblclick', function (e) { resetZoom(); e.preventDefault(); });
    // Leaving the render drops the zoom, so it never persists over a fitted
    // image the next time you glance at it.
    stage.addEventListener('mouseleave', function () { if (ui.zoom > 1.0001) resetZoom(); });
    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      ui.dragX = e.clientX;
      ui.dragBase = ui.angle;
      stage.classList.add('mt-dragging');
      // First drag on this mount = bake its frames (lazy — merely looking
      // costs nothing; each frame is a full offscreen render).
      if (!ui.spinAsked[m.id]) {
        ui.spinAsked[m.id] = 1;
        act({ act: 'spin', id: m.id });
        probeFrames(m);
        startFramePoll(m);
      }
      e.preventDefault();
    });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (ui.dragX == null) return;
    const steps = Math.round((e.clientX - ui.dragX) / DRAG_PX_PER_STEP);
    const next = ((ui.dragBase + steps * SPIN_STEP) % 360 + 360) % 360;
    if (next !== ui.angle) {
      ui.angle = next;
      const m = byId(ui.selId);
      const img = $('mt-stage-img');
      if (m && img) {
        const src = stageSrc(m);
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      }
    }
  }

  function onDragEnd() {
    if (ui.dragX == null) return;
    ui.dragX = null;
    const stage = $('mt-stage');
    if (stage) stage.classList.remove('mt-dragging');
  }

  /* ------------------------------------------------------------ select -- */

  function select(id) {
    if (ui.selId !== id) { ui.angle = 0; ui.zoom = 1; ui.editing = ''; ui.removeArmed = false; }
    ui.selId = id;
    const rows = filtered();
    for (let i = 0; i < rows.length; i++) if (rows[i].id === id) { ui.sel = i; break; }
    render();
  }

  /* ======================================================= spell picker == */

  /* The mode toggle bar (#mt-picker-mode) is not in the static markup — the
     pane's index.html is owned elsewhere — so it is inserted lazily, once, just
     above the results. A pure DOM mutation: no markup file changes. */
  function ensurePickerMode() {
    if ($('mt-picker-mode')) return;
    const list = $('mt-picker-list');
    if (!list || !list.parentNode) return;
    const bar = document.createElement('div');
    bar.id = 'mt-picker-mode';
    bar.className = 'mt-picker-mode';
    list.parentNode.insertBefore(bar, list);
  }

  /* A manual re-sweep: throw away the cached roster and ask C++ again. The
     button spins until mtSpellsData lands (or the ~6s safety timeout clears it,
     so a dropped reply can't leave the spinner stuck). Feature 1's guarantee:
     a spell learned mid-session, or a tome just read, shows up on demand. */
  function refreshSpells() {
    if (ui.pickerRefreshing) return;
    ui.pickerRefreshing = true;
    toGame('mtSpells');
    renderPicker();
    setTimeout(function () {
      if (ui.pickerRefreshing) { ui.pickerRefreshing = false; if (ui.visible && ui.picker) renderPicker(); }
    }, 6000);
  }

  function openPicker() {
    ui.picker = true;
    ui.pickerQ = '';
    ui.pickerSel = 0;
    // ALWAYS re-sweep on open — the roster must reflect spells learned since the
    // last open (and every known-flag is a live HasSpell in C++). Clearing the
    // cache first shows the "Reading your spellbook…" state until the reply.
    state.spells = null;
    ui.pickerRefreshing = false;
    toGame('mtSpells');
    ensurePickerMode();
    renderPicker();
    const p = $('mt-picker');
    if (p) p.classList.remove('hidden');
    setTimeout(function () { const s = $('mt-picker-search'); if (s) { s.value = ''; s.focus(); } }, 30);
  }

  function closePicker() {
    ui.picker = false;
    const p = $('mt-picker');
    if (p) p.classList.add('hidden');
    const s = $('mt-search');
    if (s) s.focus();
  }

  /* Is this candidate a LIKELY mount (vs. merely a candidate the catalogue
     swept in)? A conjured NPC (any), a summon/reanimate/bound archetype, a
     Conjuration spell, or a name that reads like a steed. The "Everything"
     toggle drops this gate so NOTHING the load order holds can stay hidden —
     the fix for "searching shows no such spell". */
  function likelyMount(s) {
    if (s.np) return true;
    if (s.archetype === 'summon' || s.archetype === 'reanimate' || s.archetype === 'bound') return true;
    if (s.school === 'conjuration') return true;
    return /summon|conjure|call|steed|mount|horse|raise|reanimat|familiar|atronach/i.test(String(s.name || ''));
  }

  /* Rank for the "likely mount" sort: rideable-looking conjured first, any
     conjured next, then summon-archetype, then the rest — the likeliest mounts
     float to the top of an unfiltered open. Known spells edge ahead of
     catalogue-only ones at the same rank (you can ride a known one right now). */
  function pickerRank(s) {
    let r = (s.np && s.np.rideable) ? 0 : s.np ? 2 : (s.archetype === 'summon' || s.archetype === 'reanimate') ? 4 : 6;
    if (s.known === false) r += 1;   // catalogue-only sinks just below its known twin
    return r;
  }

  function nameCmp(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''));
  }

  /* The chosen sort as a comparator. Every order ends in an A-Z tiebreak so the
     result is deterministic under the live filter (and keyboard nav stays sane).
     The sort composes with search + both pills because it is applied AFTER the
     rows are filtered — it only reorders what survived. */
  function pickerCompare(sortKey) {
    switch (validSort(sortKey)) {
      case 'az':
        return nameCmp;
      case 'school':
        return function (a, b) {
          // case-insensitive so 'Conjuration' and 'conjuration' group together
          // (C++ emits lowercase for catalogue rows, capitalised for known ones);
          // an empty school sinks to the bottom via the 'zzz' sentinel.
          const sa = String(a.school || 'zzz').toLowerCase();
          const sb = String(b.school || 'zzz').toLowerCase();
          const c = sa.localeCompare(sb);
          return c !== 0 ? c : nameCmp(a, b);
        };
      case 'learned':
        return function (a, b) {
          const ka = a.known === false ? 1 : 0, kb = b.known === false ? 1 : 0;
          return ka !== kb ? ka - kb : nameCmp(a, b);
        };
      default:   // 'rideable' — the original likely-mount rank
        return function (a, b) {
          const ra = pickerRank(a), rb = pickerRank(b);
          return ra !== rb ? ra - rb : nameCmp(a, b);
        };
    }
  }

  function pickerRows() {
    if (!state.spells) return null;   // still fetching
    const toks = ui.pickerQ.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < state.spells.length; i++) {
      const s = state.spells[i];
      // "Learned only" (Rober, 2026-08-14: "a toggle to show just stuff
      // learned") hides every catalogue-only row — the ones carrying the
      // "unlearned" chip. Applied FIRST and unconditionally (even under a
      // query), because it is an explicit intent: show me only what I can cast
      // right now. C++ marks a row known:true when player->HasSpell is true.
      if (ui.pickerLearned && s.known === false) continue;
      // "Likely" mode with NO query hides the noise; the moment you type, the
      // gate relaxes so a summon the classifier missed is still findable — if
      // you searched for it, you want it. "Everything" never gates.
      if (!ui.pickerAll && !toks.length && !likelyMount(s)) continue;
      const hay = (String(s.name || '') + ' ' + String(s.school || '') + ' ' +
        String(s.element || '') + ' ' + String(s.archetype || '') + ' ' +
        (s.known === false ? 'unlearned catalogue ' : 'known ') +
        (s.np ? String(s.np.name || '') + ' ' + String(s.np.race || '') : '')).toLowerCase();
      let ok = true;
      for (let t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) === -1) { ok = false; break; }
      if (ok) out.push(s);
    }
    out.sort(pickerCompare(ui.pickerSort));
    return out;
  }

  /* Real Spell-Hotbar art for a picker row, via the deck view's own resolver
     (window.hdSpellIconPath — same icon library, same view tree, so no
     cross-view path). Falls back to the glyph when the chain gives up or the
     resolver isn't present (older deck app.js). Sends the full metadata the
     resolver needs (school/element/tier/slot), which C++ now carries per row. */
  function spellIconHtml(s) {
    const p = (typeof window.hdSpellIconPath === 'function') ? window.hdSpellIconPath({
      plugin: s.plugin, localId: s.localId, school: s.school, element: s.element,
      archetype: s.archetype, tier: s.tier, slot: s.slot,
    }) : '';
    if (p)
      return '<span class="mt-sp-icon"><img src="' + esc(p) + '" alt="" draggable="false" ' +
        'onerror="this.parentNode.className=\'mt-sp-icon mt-sp-icon-glyph\';this.parentNode.textContent=\'' +
        (s.np ? '🐴' : '✨') + '\'"></span>';
    return '<span class="mt-sp-icon mt-sp-icon-glyph">' + (s.np ? '🐴' : '✨') + '</span>';
  }

  function renderPicker() {
    // Two control rows live above the list. Row 1: the scope toggle (Likely
    // mounts / Everything) with a ⟳ re-sweep on the right — "Everything" is the
    // promise that nothing is ever unfindable, ⟳ picks up a spell learned this
    // very session. Row 2: the Sort segments, persisted in mounts.json.
    const modeBox = $('mt-picker-mode');
    if (modeBox) {
      let html =
        '<div class="mt-pk-row mt-pk-scope">' +
        '<button class="mt-seg' + (!ui.pickerAll ? ' mt-seg-on' : '') + '" data-all="0" ' +
          'title="Only spells that look like a mount summon — a conjured creature, a summon/reanimate effect, or a steed-shaped name">🐴 Likely mounts</button>' +
        '<button class="mt-seg' + (ui.pickerAll ? ' mt-seg-on' : '') + '" data-all="1" ' +
          'title="Every castable spell in your load order — nothing hidden, even an unread tome you have not learned yet">✦ Everything</button>' +
        '<button class="mt-pk-toggle' + (ui.pickerLearned ? ' mt-pk-toggle-on' : '') + '"' +
          ' id="mt-picker-learned" role="switch" aria-checked="' + (ui.pickerLearned ? 'true' : 'false') + '"' +
          ' title="' + (ui.pickerLearned
            ? 'Showing only spells in your spellbook — click to also show ones you have not learned yet'
            : 'Show only spells already in your spellbook (hide the unlearned catalogue rows)') + '">' +
          '<span class="mt-pk-toggle-box" aria-hidden="true">' + (ui.pickerLearned ? '✓' : '') + '</span>' +
          'Learned only</button>' +
        '<button class="mt-pk-refresh' + (ui.pickerRefreshing ? ' mt-pk-refresh-busy' : '') + '"' +
          ' id="mt-picker-refresh"' + (ui.pickerRefreshing ? ' disabled' : '') +
          ' title="Re-scan your load order — pick up a spell you just learned or a tome you just read">' +
          '<span class="mt-pk-refresh-glyph">⟳</span>' +
          (ui.pickerRefreshing ? 'Refreshing…' : 'Refresh') + '</button>' +
        '</div>';
      // Row 2 — Sort. A label then segmented buttons (the deck's no-dropdown
      // idiom); past four options this stays a comfortable single row.
      html += '<div class="mt-pk-row mt-pk-sort">' +
        '<span class="mt-pk-sort-label">Sort</span>';
      for (let i = 0; i < SORTS.length; i++) {
        const on = validSort(ui.pickerSort) === SORTS[i][0];
        html += '<button class="mt-seg mt-seg-sort' + (on ? ' mt-seg-on' : '') +
          '" data-sort="' + esc(SORTS[i][0]) + '" title="' + esc(SORTS[i][2]) + '">' +
          esc(SORTS[i][1]) + '</button>';
      }
      html += '</div>';
      modeBox.innerHTML = html;

      modeBox.querySelectorAll('.mt-seg[data-all]').forEach(function (b) {
        b.addEventListener('click', function () {
          ui.pickerAll = b.getAttribute('data-all') === '1';
          ui.pickerSel = 0;
          renderPicker();
          const s = $('mt-picker-search');
          if (s) s.focus();
        });
      });
      const lb = $('mt-picker-learned');
      if (lb) lb.addEventListener('click', function () {
        ui.pickerLearned = !ui.pickerLearned;
        setPref('pickerLearned', ui.pickerLearned);   // persisted in mounts.json, same path as the sort
        ui.pickerSel = 0;   // the top hit changes when the list shrinks/grows
        renderPicker();
        const s = $('mt-picker-search');
        if (s) s.focus();
      });
      modeBox.querySelectorAll('.mt-seg-sort').forEach(function (b) {
        b.addEventListener('click', function () {
          const k = validSort(b.getAttribute('data-sort'));
          if (k !== ui.pickerSort) { ui.pickerSort = k; setPref('pickerSort', k); }
          ui.pickerSel = 0;   // top hit changes under the new order
          renderPicker();
          const s = $('mt-picker-search');
          if (s) s.focus();
        });
      });
      const rf = $('mt-picker-refresh');
      if (rf) rf.addEventListener('click', refreshSpells);
    }

    const list = $('mt-picker-list');
    if (!list) return;
    const rows = pickerRows();
    if (rows === null) {
      list.innerHTML = '<div class="mt-picker-empty">Reading your spellbook…</div>';
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<div class="mt-picker-empty">No spell matches “' + esc(ui.pickerQ) + '”.' +
        (ui.pickerLearned ? ' <b>“Learned only” is on</b> — turn it off to include spells you have not learned yet.' :
          (!ui.pickerAll ? ' <b>Try “✦ Everything”</b> — it searches every spell in the load order, even ones you have not learned.' : '')) +
        '</div>';
      return;
    }
    let html = '';
    const cap = Math.min(rows.length, 120);
    for (let i = 0; i < cap; i++) {
      const s = rows[i];
      const sub = [esc(s.school || '')];
      if (s.archetype === 'summon') sub.push('summon');
      else if (s.archetype === 'reanimate') sub.push('reanimate');
      html += '<div class="mt-sp-row' + (i === ui.pickerSel ? ' mt-sel' : '') + '" data-i="' + i + '">' +
        spellIconHtml(s) +
        '<div class="mt-sp-mid">' +
        '<div class="mt-sp-name"><span class="mt-sp-nm">' + highlight(s.name, ui.pickerQ) + '</span>' +
        (s.known === false ? '<span class="mt-sp-tag" title="Not in your spellbook yet — add it here and read the tome (or learn it) to cast it">unlearned</span>' : '') +
        '</div>' +
        '<div class="mt-sp-sub">' + sub.filter(Boolean).join(' · ') + '</div>' +
        '</div>' +
        (s.np ? '<span class="mt-sp-np" title="Auto-detected from the spell’s own record">conjures ' + esc(s.np.name) + '</span>'
              : '<span class="mt-sp-np mt-sp-np-dim" title="The spell’s record does not name what it summons (a script does), so Ride will just cast it">record-driven</span>') +
        '</div>';
    }
    if (rows.length > cap)
      html += '<div class="mt-picker-empty">' + (rows.length - cap) + ' more — type to narrow</div>';
    list.innerHTML = html;
    list.querySelectorAll('.mt-sp-row').forEach(function (row) {
      row.addEventListener('click', function () {
        addSpellRow(rows[row.getAttribute('data-i') | 0]);
      });
    });
  }

  function addSpellRow(s) {
    if (!s) return;
    act({ act: 'addSpell', plugin: s.plugin, localId: s.localId, formId: s.formId });
    closePicker();
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('mt-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('mt-toast-err', !!err);
    t.classList.add('mt-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('mt-toast-show'); }, 2600);
  }

  /* ========================================================= icon polls == */

  function artMissing() {
    for (let i = 0; i < state.mounts.length; i++) {
      const m = state.mounts[i];
      if (m.npId && !m.img) return true;
    }
    return false;
  }

  function stopIconPoll() {
    if (ui.iconPollT) { clearInterval(ui.iconPollT); ui.iconPollT = null; }
  }

  function startIconPoll() {
    stopIconPoll();
    ui.iconPollN = 0;
    if (!state.mrf || !artMissing()) return;
    ui.iconPollT = setInterval(function () {
      if (!ui.visible || !artMissing() || ++ui.iconPollN > ICON_POLL_MAX) { stopIconPoll(); return; }
      toGame('mtIcons');
    }, ICON_POLL_MS);
  }

  /* ============================================================= render == */

  function render() {
    renderHeader();
    renderPills();
    renderList();
    renderDetail();
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('mtState');   // loads mounts.json on first ask; cheap after
    const s = $('mt-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    render();
  }

  function onHide() {
    ui.visible = false;
    ui.editing = '';
    ui.removeArmed = false;
    ui.catEditing = '';
    ui.dragCat = null;
    closeCatMenu();
    closePicker();
    stopIconPoll();
    stopFramePoll();
    onDragEnd();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  function setFilter(text) {
    ui.q = String(text || '');
    ui.filter = 'all';
    const s = $('mt-search');
    if (s) s.value = ui.q;
    if (state.ready) render();
  }

  function init() {
    // Idempotent: the harness calls init() eagerly (its checks dispatch real
    // events), then DOMContentLoaded calls it again — double-wired listeners
    // would double-fire every click.
    if (ui._inited) return;
    ui._inited = true;
    const s = $('mt-search');
    if (s) {
      s.addEventListener('input', function () {
        ui.q = s.value.trim();
        ui.sel = 0;
        renderList();
      });
      s.addEventListener('keydown', function (e) {
        const rows = filtered();
        if (e.key === 'Enter') {
          const m = rows[Math.min(ui.sel, rows.length - 1)] || rows[0];
          if (m) { select(m.id); doRide(m); }
          e.stopPropagation();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (rows.length) {
            ui.sel = e.key === 'ArrowDown'
              ? Math.min(rows.length - 1, ui.sel + 1)
              : Math.max(0, ui.sel - 1);
            select(rows[ui.sel].id);
            const el = document.querySelector('#mt-list .mt-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Escape') {
          if (s.value) { s.value = ''; ui.q = ''; renderList(); e.stopPropagation(); }
          /* bare Esc falls through to the palette's close, on purpose */
        }
      });
    }
    const addLook = $('mt-add-look');
    if (addLook) addLook.addEventListener('click', function () { act({ act: 'addLook' }); });
    const addSpell = $('mt-add-spell');
    if (addSpell) addSpell.addEventListener('click', openPicker);

    const px = $('mt-picker-x');
    if (px) px.addEventListener('click', closePicker);
    const pk = $('mt-picker');
    if (pk) pk.addEventListener('click', function (e) { if (e.target === pk) closePicker(); });
    const ps = $('mt-picker-search');
    if (ps) {
      ps.addEventListener('input', function () {
        ui.pickerQ = ps.value.trim();
        ui.pickerSel = 0;
        renderPicker();
      });
      ps.addEventListener('keydown', function (e) {
        const rows = pickerRows() || [];
        if (e.key === 'Enter') {
          addSpellRow(rows[Math.min(ui.pickerSel, rows.length - 1)] || rows[0]);
          e.stopPropagation();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (rows.length) {
            ui.pickerSel = e.key === 'ArrowDown'
              ? Math.min(rows.length - 1, ui.pickerSel + 1)
              : Math.max(0, ui.pickerSel - 1);
            renderPicker();
            const el = document.querySelector('#mt-picker-list .mt-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Escape') {
          closePicker();
          e.stopPropagation();
        } else {
          e.stopPropagation();   // typing must never reach the palette
        }
      });
    }

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_MOUNTS = [
    { id: 'm1', kind: 'spell', name: 'Arvak', fav: true, note: '', race: 'Horse', rideable: true,
      plug: 'Dawnguard.esm', img: 'icons/mounts/dawnguard-esm-00a26e.png', spName: 'Summon Arvak',
      known: true, npKnown: true, npId: '0xA26E', npPlugin: 'Dawnguard.esm' },
    { id: 'm2', kind: 'actor', name: 'Frost', fav: false, note: 'stabled at Riverwood', race: 'Horse',
      rideable: true, plug: 'Skyrim.esm', img: '', found: true, loaded: false, dead: false,
      npId: '0x109A5', npPlugin: 'Skyrim.esm' },
    { id: 'm3', kind: 'spell', name: 'Storm Atronach Steed', fav: false, note: '', race: 'Atronach',
      rideable: false, plug: 'CoolMounts.esp', img: '', spName: 'Conjure Storm Steed',
      known: false, npKnown: true, npId: '0x801', npPlugin: 'CoolMounts.esp' },
  ];

  function devState() {
    window.mtStateResult({
      mrf: true, count: DEV_MOUNTS.length,
      riding: { name: 'Frost', id: 'm2' },
      mounts: JSON.parse(JSON.stringify(DEV_MOUNTS)),
    });
  }

  function devSpells() {
    window.mtSpellsData({ spells: [
      { plugin: 'Dawnguard.esm', localId: 0xA26D, formId: 0x0200A26D, name: 'Summon Arvak',
        school: 'Conjuration', archetype: 'summon', slot: 'hand',
        np: { name: 'Arvak', race: 'Horse', rideable: true, plugin: 'Dawnguard.esm', id: '0xA26E' } },
      { plugin: 'Skyrim.esm', localId: 0x7E8E0, formId: 0x0007E8E0, name: 'Conjure Familiar',
        school: 'Conjuration', archetype: 'summon', slot: 'hand',
        np: { name: 'Familiar', race: 'Wolf', rideable: true, plugin: 'Skyrim.esm', id: '0x7E8E1' } },
      { plugin: 'Skyrim.esm', localId: 0x12FCD, formId: 0x00012FCD, name: 'Flames',
        school: 'Destruction', archetype: 'fire', slot: 'hand', np: null },
    ] });
  }

  function devAct(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.act === 'addSpell') {
      window.mtActResult({ ok: true, act: 'addSpell', found: true, msg: '✨ added',
        mount: { id: 'm9', kind: 'spell', name: 'Added' } });
      return;
    }
    if (req.act === 'addLook') {
      window.mtActResult({ ok: false, act: 'addLook', found: false,
        msg: 'Look at a horse or beast, then open the deck and add it' });
      return;
    }
    if (req.act === 'spin') { window.mtActResult({ ok: true, act: 'spin', found: true, msg: '' }); return; }
    window.mtActResult({ ok: true, act: req.act, found: true, msg: req.act + ' ok' });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }

    ui.visible = true;

    /* skeletons before ready */
    state.ready = false;
    render();
    ok('skeletons: shown before ready', document.querySelectorAll('#mt-list .mt-skel').length === 5);

    devState();
    ok('state: ready + rows landed', state.ready && state.mounts.length === 3);
    ok('header: count chip', $('mt-count-chip').textContent.indexOf('3 mounts') !== -1);
    ok('header: riding chip', $('mt-riding-chip').textContent.indexOf('Frost') !== -1);

    /* favorites sort first */
    let rows = filtered();
    ok('sort: favourite first', rows[0].id === 'm1');

    /* search narrows */
    ui.q = 'frost';
    rows = filtered();
    ok('search: narrows to Frost', rows.length === 1 && rows[0].id === 'm2');
    ui.q = '';

    /* pills */
    ui.filter = 'spell';
    rows = filtered();
    ok('pill: summons only', rows.length === 2 && rows.every(function (m) { return m.kind === 'spell'; }));
    ui.filter = 'all';
    render();

    /* riding + unlearned chips */
    ok('chip: riding drawn', !!document.querySelector('#mt-list .mt-chip-riding'));
    ok('chip: unlearned drawn', !!document.querySelector('#mt-list .mt-chip-warn'));

    /* selection -> detail */
    select('m1');
    ok('detail: name shown', $('mt-detail').textContent.indexOf('Arvak') !== -1);
    ok('detail: conjured-by line', $('mt-detail').textContent.indexOf('Summon Arvak') !== -1);
    ok('detail: stage img uses row art', !!$('mt-stage-img') &&
      $('mt-stage-img').getAttribute('src') === 'icons/mounts/dawnguard-esm-00a26e.png');

    /* angle filename contract */
    ok('turntable: angle file derivation',
      angleFile('icons/mounts/x.png', 45) === 'icons/mounts/x-a045.png' &&
      angleFile('icons/mounts/x.png', 315) === 'icons/mounts/x-a315.png' &&
      angleFile('icons/mounts/x.png', 0) === 'icons/mounts/x.png');

    /* stageSrc falls back to frame 0 while a frame is unproven */
    ui.angle = 90;
    ok('turntable: unproven frame falls back to frame 0',
      stageSrc(byId('m1')) === 'icons/mounts/dawnguard-esm-00a26e.png');
    const f = frameStateFor(byId('m1'));
    f[90] = 'ok';
    ok('turntable: proven frame is used',
      stageSrc(byId('m1')) === 'icons/mounts/dawnguard-esm-00a26e-a090.png');
    ui.angle = 0;

    /* ride gating */
    select('m3');
    const rideBtn = document.querySelector('#mt-actions [data-a="ride"]');
    ok('ride: unlearned spell disables Ride', rideBtn && rideBtn.disabled);
    ok('ride: reason in the title', rideBtn && rideBtn.getAttribute('title').indexOf('Conjure Storm Steed') !== -1);

    /* icon key normalisation (the C++ KeyOf contract) */
    ok('icon key: uppercased fid, lowercased plugin',
      iconKey({ npId: '0xa26e', npPlugin: 'Dawnguard.ESM' }) === '0XA26E|dawnguard.esm');

    /* icons merge updates a row in place */
    window.mtIconsData({ version: 1, icons: { '0X109A5|skyrim.esm': 'icons/mounts/skyrim-esm-109a5.png' } });
    ok('icons: late render lands on the row', byId('m2').img === 'icons/mounts/skyrim-esm-109a5.png');

    /* armed remove is two-step */
    select('m1');
    ui.removeArmed = false;
    renderDetail();
    const rm = document.querySelector('#mt-actions [data-a="remove"]');
    rm.click();
    ok('remove: first press arms', ui.removeArmed === true &&
      document.querySelector('#mt-actions [data-a="remove"]').textContent.indexOf('Really') !== -1);
    ui.removeArmed = false;
    renderDetail();

    /* rename editor */
    ui.editing = 'rename';
    renderDetail();
    ok('rename: editor input present', !!$('mt-edit-input'));
    ui.editing = '';
    renderDetail();

    /* picker: fetch + summon-first sort + search */
    openPicker();
    devSpells();
    let prows = pickerRows();
    ok('picker: rideable summons sort first', prows[0].name === 'Summon Arvak' && !!prows[0].np);
    ok('picker: conjured name shown', $('mt-picker-list').textContent.indexOf('conjures Arvak') !== -1);
    ui.pickerQ = 'flames';
    prows = pickerRows();
    ok('picker: search narrows', prows.length === 1 && prows[0].name === 'Flames');
    ui.pickerQ = '';
    closePicker();

    /* refusal toast */
    devAct(JSON.stringify({ act: 'addLook' }));
    ok('act: refusal reaches the toast', $('mt-toast').classList.contains('mt-toast-show') &&
      $('mt-toast').classList.contains('mt-toast-err'));

    /* empty hero */
    state.mounts = [];
    ui.selId = '';
    render();
    ok('empty: hero explains both add flows', !$('mt-empty').classList.contains('hidden') &&
      $('mt-empty').textContent.indexOf('summon spell') !== -1);

    const fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
    window.__selftest = { out: out, fails: fails.length };
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'mounts', label: 'Mounts', tab: 'mounts',
    setFilter: setFilter,
    index: function () {
      const rows = [{
        label: 'Mounts',
        detail: 'Your stable — summon, call and ride anything you can sit on',
        kind: 'mounts',
        keywords: 'mount mounts stable horse ride summon steed arvak call',
      }];
      for (let i = 0; i < state.mounts.length; i++) {
        const m = state.mounts[i];
        rows.push({
          label: m.name,
          detail: (m.kind === 'spell' ? 'Summoned mount' : 'Mount') +
            (m.race ? ' · ' + m.race : '') + ' — open the Mounts tab to ride',
          kind: 'mounts',
          keywords: 'mount ride ' + String(m.name || '') + ' ' + String(m.race || ''),
        });
      }
      return rows;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter, addLookingAt,
    _state: state, _ui: ui, _filtered: filtered, _angleFile: angleFile,
    _iconKey: iconKey, _stageSrc: stageSrc, _pickerRows: pickerRows,
    _openPicker: openPicker, _closePicker: closePicker, _select: select,
    _grouped: grouped, _catOf: catOf, _catName: catName, _likelyMount: likelyMount,
    _fileMount: fileMount, _spellIconHtml: spellIconHtml, _beginCatEdit: beginCatEdit,
    _openCatMenu: openCatMenu, _openMountCatMenu: openMountCatMenu, _moveCat: moveCat,
    _refreshSpells: refreshSpells, _setPref: setPref, _sortKeys: sortKeys,
    _pickerCompare: pickerCompare, _renderPicker: renderPicker,
    _resetZoom: resetZoom, _applyZoom: applyZoom,
    _ZOOM_MIN: ZOOM_MIN, _ZOOM_MAX: ZOOM_MAX, _ZOOM_STEP: ZOOM_STEP,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.MountsPane.init(); });
} else {
  window.MountsPane.init();
}
