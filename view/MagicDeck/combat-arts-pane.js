'use strict';

/* ====================================================================== *
 *  Combat Arts — the "Ashes of War" collection/equip screen (2026-08-15).
 *  74 collectible weapon arts, at most ONE equipped; equipping is instant
 *  and works under the paused deck, so every verb stays inside the pane.
 *
 *  C++ owns the art roster, the equip and the icon persistence; this pane
 *  owns the search, the collection view and the icon picking.
 *
 *  Bridge — requests: caState({}) · caAct({op:'equip'|'unequip',id}) ·
 *  caSave({icons:{artId: 'icons/custom/x.png'|null}})
 *  Replies (disjoint, per the deck law):
 *    caStateResult({present,reason?,equipped,collected,arts:[{id,num,name,
 *      full,owned,count,icon,equipped}]})   — all 74 always present, sorted
 *      by num; MAY arrive UNSOLICITED (live intercept while the tab is up),
 *      so every landing repaints from the latest push.
 *    caActResult({ok,msg,id,equipped})      — !ok lands as an INLINE error
 *      (persistent until dismissed), never a toast that vanishes.
 *    caSaved({ok,icons})                    — the confirmed icon map.
 *
 *  Host contract (mirrors ItemsPane): CombatArtsPane.init() · onShow() ·
 *  onHide() · toggleEdit() (flips the icon-assign chrome) · wantsPause()
 *  -> true · setFilter(q) for omni jumps.
 * ====================================================================== */

window.CombatArtsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const TOTAL_HINT = 74;   // display fallback before the first state lands

  /* ============================================================== state == */

  const state = {
    asked: false,      // any caStateResult landed yet? (false = skeletons)
    present: false,
    reason: '',
    equipped: null,    // artId | null
    collected: 0,
    arts: [],          // ALL arts, sorted by num (owned + undiscovered)
    actErr: '',        // last !ok caActResult message — inline + persistent
    actErrArt: '',     // the art NAME it failed on (for the inline banner)
  };

  const ui = {
    q: '',
    sel: 0,            // index into ownedRows() — the equip-able selection
    visible: false,
    edit: false,       // deck edit mode: the ✎ icon-assign chrome always on
    undiscOpen: false, // the collapsible Undiscovered section
    picker: null,      // artId while the icon picker sheet is up
    pickFilter: '',
    toastT: null,
    inited: false,
  };

  /* The custom icon pool (icons/custom), captured off the SAME hdIcons push
     app.js's own picker eats — chained below, never a second bridge. */
  let iconPool = [];   // [{file,label}]

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function' && !f.__caDev) {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'caState') setTimeout(devState, 30);
      if (DEV && fn === 'caAct') setTimeout(function () { devAct(arg); }, 30);
      if (DEV && fn === 'caSave') setTimeout(function () { devSave(arg); }, 30);
    }
  }

  function parseD(d) {
    if (typeof d === 'string') { try { return JSON.parse(d); } catch (e) { return null; } }
    return d;
  }

  window.caStateResult = function (d) {
    d = parseD(d);
    if (!d || typeof d !== 'object') return;
    state.asked = true;
    state.present = !!d.present;
    state.reason = typeof d.reason === 'string' ? d.reason : '';
    state.equipped = (typeof d.equipped === 'string' && d.equipped) ? d.equipped : null;
    state.collected = d.collected | 0;
    state.arts = Array.isArray(d.arts) ? d.arts : [];
    /* C++ may push this UNSOLICITED (an art picked up / equipped from outside
       while the tab sits open) — always render from the latest push. */
    if (ui.visible) renderPreservingScroll();
  };

  window.caActResult = function (d) {
    d = parseD(d);
    if (!d || typeof d !== 'object') return;
    if (d.ok) {
      state.actErr = '';
      state.actErrArt = '';
      state.equipped = (typeof d.equipped === 'string' && d.equipped) ? d.equipped : null;
      state.arts.forEach(function (a) { a.equipped = (a.id === state.equipped); });
      if (d.msg) toast(d.msg);
    } else {
      /* a refusal is the useful sentence — keep it on screen (inline banner),
         never a toast that vanishes */
      state.actErr = d.msg || 'Could not do that';
      const art = artById(d.id);
      state.actErrArt = art ? art.name : '';
    }
    if (ui.visible) renderPreservingScroll();
  };

  window.caSaved = function (d) {
    d = parseD(d);
    if (!d || typeof d !== 'object' || !d.ok) return;
    if (d.icons && typeof d.icons === 'object') {
      Object.keys(d.icons).forEach(function (id) {
        const art = artById(id);
        if (art) art.icon = d.icons[id] || null;
      });
    }
    if (ui.visible) renderPreservingScroll();
  };

  /* The custom icon pool comes from HDArt, which already taps the host view's
     custom-icon push (`hdIcons` in the main deck, `mdIcons` in the Spell Deck —
     this pane moved into the Spell Deck on 2026-08-15, and both views get the
     same mirrored icons/custom tree from C++). Two things the module now owns
     that this pane used to guess at:
       · WHICH re-scan verb this view answers to. The old test —
         `typeof window.mdIcons === 'function'` — cannot work any more, because
         HDArt taps that name in EVERY view, so it is a function everywhere.
         HDArt answers from the name C++ actually pushed on, which is ground truth.
       · repainting an OPEN picker when a fresh listing lands (onPool).
     A view without HDArt keeps the old chain so nothing regresses. */
  const ICON_REQ = window.HDArt ? null : ((typeof window.mdOpen === 'function')
    ? 'mdIconList' : 'hdIconList');
  function refreshIconPool() {
    if (window.HDArt) { HDArt.refreshPool(); return; }
    toGame(ICON_REQ, '');
  }
  (function chainIcons() {
    if (window.HDArt) {
      iconPool = HDArt.pool();
      HDArt.onPool(function (p) { iconPool = p; if (ui.picker) renderPicker(); });
      return;
    }
    function takePool(r) {
      const p = parseD(r);
      if (p && Array.isArray(p.custom)) {
        iconPool = p.custom
          .map(function (c) { return { file: normPath(c.file), label: c.label || '' }; })
          .filter(function (c) { return c.file; });
        if (ui.picker) renderPicker();
      }
    }
    ['hdIcons', 'mdIcons'].forEach(function (name) {
      const prev = window[name];
      window[name] = function (r) {
        if (typeof prev === 'function') { try { prev(r); } catch (e) {} }
        takePool(r);
      };
    });
  })();

  /* ============================================================ helpers == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function normPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }

  /* Defence in depth, the hkIconSrc law: never let a hand-edited config hand
     the webview a filesystem path or an escape out of the view root. HDArt.path
     is that law's one implementation — and it also STRIPS any ?v= query, which
     Ultralight would otherwise fold into the filename and fail to load. */
  function iconSrc(p) {
    if (window.HDArt) return HDArt.path(p);
    p = normPath(p);
    if (!p) return '';
    if (p.indexOf('..') !== -1) return '';
    if (p.charAt(0) === '/') return '';
    if (/^[A-Za-z]:/.test(p)) return '';
    if (/^(?:file|https?):/i.test(p)) return '';
    return p;
  }

  function pad2(n) { n = n | 0; return (n < 10 ? '0' : '') + n; }

  function artById(id) {
    for (let i = 0; i < state.arts.length; i++) if (state.arts[i].id === id) return state.arts[i];
    return null;
  }

  /* Per-art hue for the ⚔ glyph fallback — a stable hash of the id, so the
     same art always wears the same tint. Comma-syntax hsla on purpose
     (Ultralight-safe; no CSS var math). */
  function hueFor(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function glyphStyle(id) {
    const h = hueFor(id);
    return 'color:hsl(' + h + ',52%,72%);background:hsla(' + h + ',52%,60%,0.10);' +
      'border-color:hsla(' + h + ',52%,60%,0.32)';
  }

  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }

  /* The <img> over the glyph plate; a broken path removes itself so a stale
     icon never leaves a broken-image box (HK_ICO_ERR idiom). Plain src, no
     ?v= query — Ultralight drops queries. */
  const ICO_ERR = window.HDArt ? HDArt.errFor('ca-has-art')
    : ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;ca-has-art&quot;);' +
      'b.removeChild(this);}"';
  /* A combat art has exactly one art source — the picture you chose — so this is
     HDArt's precedence rung 1 and nothing else. Asking the module anyway (rather
     than reading art.icon straight) is what keeps the path law, the ?v= strip and
     the glyph fallback in ONE place. */
  function artOf(art) {
    if (!window.HDArt) return { src: iconSrc(art && art.icon), glyph: '⚔' };
    return HDArt.for({ kind: 'plain', icon: (art && art.icon) || '', glyph: '⚔' });
  }
  function glyphInner(art) {
    const url = artOf(art).src;
    if (!url) return '⚔';
    return '⚔<img class="ca-art" src="' + esc(url) + '" alt="" draggable="false"' + ICO_ERR + '>';
  }

  /* ============================================================= search == */

  /* Every token must appear in "NN num name full". "03" finds art 3 by its
     padded number; names and the full "Ashes 01: High Kick" both match. */
  function matches(a, q) {
    q = String(q == null ? '' : q).trim().toLowerCase();
    if (!q) return true;
    const hay = (pad2(a.num) + ' ' + (a.num | 0) + ' ' + (a.name || '') + ' ' + (a.full || '')).toLowerCase();
    const toks = q.split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) === -1) return false;
    return true;
  }

  function ownedRows() {
    return state.arts.filter(function (a) { return a.owned && matches(a, ui.q); });
  }
  function undiscRows() {
    return state.arts.filter(function (a) { return !a.owned && matches(a, ui.q); });
  }
  /* The Undiscovered fold: a typed query that matches hidden arts auto-opens
     it (search results must never hide), the header toggle rules otherwise. */
  function undiscEffectiveOpen() {
    if (ui.q.trim() && undiscRows().length) return true;
    return ui.undiscOpen;
  }

  /* ============================================================ actions == */

  function equip(id) {
    toGame('caAct', JSON.stringify({ op: 'equip', id: String(id || '') }));
  }
  function unequip() {
    toGame('caAct', JSON.stringify({ op: 'unequip', id: String(state.equipped || '') }));
  }
  /* Click a collected row = equip toggle. */
  function activate(art) {
    if (!art || !art.owned) return;
    if (art.equipped) unequip();
    else equip(art.id);
  }

  function saveIcon(artId, file) {
    const icons = {};
    icons[artId] = file || null;
    toGame('caSave', JSON.stringify({ icons: icons }));
    /* optimistic — caSaved confirms (and corrects, if C++ refused) */
    const art = artById(artId);
    if (art) art.icon = file || null;
  }

  /* ============================================================= render == */

  function renderHeader() {
    const chip = $('ca-count-chip');
    if (chip) {
      chip.textContent = !state.asked ? ''
        : !state.present ? ''
          : (state.collected + ' / ' + (state.arts.length || TOTAL_HINT) + ' collected');
    }
  }

  function renderEquip() {
    const box = $('ca-equip');
    if (!box) return;
    if (!state.asked || !state.present) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    const art = state.equipped ? artById(state.equipped) : null;
    if (!art) {
      box.classList.add('ca-equip-none');
      box.innerHTML = '<div class="ca-equip-glyph" style="' + glyphStyle('none') + ';opacity:.45">⚔</div>' +
        '<div class="ca-equip-txt"><div class="ca-equip-empty">No combat art equipped</div>' +
        '<div class="ca-equip-sub">Click a collected art below to put it on your weapon</div></div>';
      return;
    }
    box.classList.remove('ca-equip-none');
    box.innerHTML =
      '<div class="ca-equip-glyph" style="' + glyphStyle(art.id) + '">' + glyphInner(art) + '</div>' +
      '<div class="ca-equip-txt">' +
      '<div class="ca-equip-name" title="' + esc(art.full || art.name) + '">' + esc(art.name) + '</div>' +
      '<div class="ca-equip-sub">' + esc(art.full || ('Ashes ' + pad2(art.num))) + ' · equipped now</div>' +
      '</div>' +
      '<button class="ca-unequip" id="ca-unequip-btn" title="Take the art off your weapon">Unequip</button>';
    const b = $('ca-unequip-btn');
    if (b) b.addEventListener('click', function (e) { e.stopPropagation(); unequip(); });
  }

  function renderErr() {
    const box = $('ca-err');
    if (!box) return;
    if (!state.actErr || !state.present) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '⚠ ' + (state.actErrArt ? '<b>' + esc(state.actErrArt) + '</b> — ' : '') +
      esc(state.actErr) +
      '<button class="ca-err-x" title="Dismiss">✕</button>';
    box.querySelector('.ca-err-x').addEventListener('click', function () {
      state.actErr = ''; state.actErrArt = '';
      renderErr();
    });
  }

  function rowHtml(art, selIdx, idx) {
    const q = ui.q.trim();
    return '<div class="ca-row' + (art.equipped ? ' ca-eq' : '') + (selIdx === idx ? ' ca-sel' : '') +
      '" data-id="' + esc(art.id) + '" title="' + esc(art.full || art.name) +
      (art.equipped ? ' — click to unequip' : ' — click to equip') + '">' +
      '<div class="ca-glyph' + (iconSrc(art.icon) ? ' ca-has-art' : '') + '" style="' + glyphStyle(art.id) + '">' +
      glyphInner(art) + '</div>' +
      '<div class="ca-mid">' +
      '<div class="ca-name">' + pad2(art.num) + ' · ' + highlight(art.name, q) + '</div>' +
      '<div class="ca-sub" title="' + esc(art.full) + '">' + esc(art.full) + '</div>' +
      '</div>' +
      ((art.count | 0) > 1 ? '<span class="ca-count" title="You carry ' + (art.count | 0) + ' of these">×' + (art.count | 0) + '</span>' : '') +
      '<div class="ca-act">' +
      '<button class="ca-pen" data-pen="' + esc(art.id) + '" title="Choose an icon for this art">✎</button>' +
      (art.equipped
        ? '<span class="ca-eq-chip">★ Equipped</span><button class="ca-equip-btn" data-un="1" title="Take it off">Unequip</button>'
        : '<button class="ca-equip-btn" title="Put this art on your weapon">Equip</button>') +
      '</div></div>';
  }

  function undRowHtml(art) {
    const q = ui.q.trim();
    return '<div class="ca-row ca-und" data-und="' + esc(art.id) + '" title="' + esc(art.full || art.name) + ' — not found yet">' +
      '<div class="ca-glyph" style="' + glyphStyle(art.id) + '">⚔</div>' +
      '<div class="ca-mid">' +
      '<div class="ca-name">' + pad2(art.num) + ' · ' + highlight(art.name, q) + '</div>' +
      '<div class="ca-sub">found in loot across Skyrim</div>' +
      '</div>' +
      '<button class="ca-pen" data-pen="' + esc(art.id) + '" title="Choose an icon for this art">✎</button>' +
      '</div>';
  }

  function renderBody() {
    const body = $('ca-body');
    const empty = $('ca-empty');
    if (!body || !empty) return;

    /* first state not landed: skeleton rows sized like the real thing */
    if (!state.asked) {
      body.innerHTML = new Array(7).fill(
        '<div class="ca-row ca-skel"><div class="ca-glyph ca-skel-box"></div>' +
        '<div class="ca-mid"><span class="ca-skel-box ca-skel-w1"></span>' +
        '<span class="ca-skel-box ca-skel-w2"></span></div>' +
        '<span class="ca-skel-box ca-skel-btn"></span></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    /* the mod isn't here — the whole pane is the honest reason, nothing else */
    if (!state.present) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = '<div class="ca-absent-glyph">⚔</div>' +
        '<div class="ca-empty-title">Combat Arts is standing down</div>' +
        '<div class="ca-empty-sub">' + esc(state.reason || 'The Ashes of War mod was not found in the load order.') + '</div>';
      return;
    }

    const owned = ownedRows();
    const undisc = undiscRows();
    const undOpen = undiscEffectiveOpen();

    /* nothing matches the query at all — honest empty */
    if (!owned.length && !undisc.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = '<div class="ca-empty-title">Nothing matches</div>' +
        '<div class="ca-empty-sub">No combat art called “' + esc(ui.q.trim()) + '”. ' +
        'Try fewer letters, or the art’s number (“03”).</div>';
      return;
    }
    empty.classList.add('hidden');

    let html = '';

    if (owned.length) {
      html += '<div class="ca-sect">Collected <b>' + owned.length + '</b></div>';
      if (ui.sel >= owned.length) ui.sel = owned.length - 1;
      if (ui.sel < 0) ui.sel = 0;
      owned.forEach(function (a, i) { html += rowHtml(a, ui.sel, i); });
    } else if (!ui.q.trim()) {
      html += '<div class="ca-sect">Collected <b>0</b></div>' +
        '<div class="ca-empty-sub" style="padding:8px 4px 14px">No combat arts found yet — ' +
        'they turn up as loot across Skyrim. What you find collects here.</div>';
    }

    /* the Undiscovered fold — a collection screen shows what's LEFT */
    html += '<button class="ca-und-head" id="ca-und-head" ' +
      'title="' + (undOpen ? 'Fold the undiscovered list away' : 'See every art still out there') + '">' +
      '<span class="ca-und-caret">' + (undOpen ? '▾' : '▸') + '</span>' +
      'Undiscovered (' + undisc.length + ')' +
      '<span class="ca-und-hint">found in loot across Skyrim</span></button>';
    if (undOpen) undisc.forEach(function (a) { html += undRowHtml(a); });

    body.innerHTML = html;

    /* wire */
    const undHead = $('ca-und-head');
    if (undHead) undHead.addEventListener('click', function () {
      ui.undiscOpen = !ui.undiscOpen;
      renderPreservingScroll();
    });
    body.querySelectorAll('.ca-row:not(.ca-skel):not(.ca-und)').forEach(function (row) {
      const id = row.getAttribute('data-id');
      row.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.ca-pen, .ca-equip-btn')) return;
        activate(artById(id));
      });
      const btn = row.querySelector('.ca-equip-btn');
      if (btn) btn.addEventListener('click', function (e) {
        e.stopPropagation();
        activate(artById(id));
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openPicker(id);
      });
    });
    body.querySelectorAll('.ca-pen').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        openPicker(b.getAttribute('data-pen'));
      });
    });
    body.querySelectorAll('.ca-row.ca-und').forEach(function (row) {
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openPicker(row.getAttribute('data-und'));
      });
    });
  }

  function render() {
    const pane = $('ca-pane');
    if (pane) pane.classList.toggle('ca-editing', !!ui.edit);
    /* present:false hides the working chrome — the reason owns the screen */
    const bar = document.querySelector('#ca-pane .ca-bar');
    const showChrome = !state.asked || state.present;
    if (bar) bar.classList.toggle('hidden', !showChrome);
    renderHeader();
    renderEquip();
    renderErr();
    renderBody();
  }

  /* Repaint but keep the list's scroll — a live push landing mid-scroll must
     not jump the list back to the top (the keys-pane idiom). */
  function renderPreservingScroll() {
    const body = $('ca-body');
    const top = body ? body.scrollTop : 0;
    render();
    const b2 = $('ca-body');
    if (b2) b2.scrollTop = top;
  }

  /* =============================================================== toast == */

  function toast(msg) {
    const t = $('ca-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('ca-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('ca-toast-show'); }, 2400);
  }

  /* ========================================================= icon picker == *
   * A small in-pane sheet over the pane (the ix-sheet idiom): None + the
   * icons/custom pool, filter-as-you-type. The pool arrives off the SAME
   * hdIcons push the deck's own picker uses (chained above); opening asks
   * C++ to re-scan via the existing hdIconList request. */

  function openPicker(artId) {
    const art = artById(artId);
    if (!art) return;
    ui.picker = artId;
    ui.pickFilter = '';
    refreshIconPool();   // re-scan the custom pool (HDArt picks this view's own verb)
    renderPicker();
    setTimeout(function () { const f = $('ca-pick-filter'); if (f) f.focus(); }, 30);
  }

  function closePicker() {
    ui.picker = null;
    ui.pickFilter = '';
    const sh = $('ca-picker');
    if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; }
    const s = $('ca-search');
    if (s) s.focus();
  }

  function pickIcon(file) {
    const id = ui.picker;
    closePicker();
    if (!id) return;
    saveIcon(id, file || null);
    renderPreservingScroll();
    const art = artById(id);
    toast(file ? ('Icon set for ' + (art ? art.name : 'art')) : ('Icon cleared' + (art ? ' for ' + art.name : '')));
  }

  function renderPicker() {
    const sh = $('ca-picker');
    if (!sh) return;
    if (!ui.picker) { sh.classList.add('hidden'); sh.innerHTML = ''; return; }
    const art = artById(ui.picker);
    if (!art) { closePicker(); return; }
    const q = ui.pickFilter.trim().toLowerCase();
    const pool = iconPool.filter(function (c) {
      return !q || (c.label || '').toLowerCase().indexOf(q) !== -1 ||
        (c.file || '').toLowerCase().indexOf(q) !== -1;
    });
    const cur = normPath(art.icon || '');

    let tiles = '<button class="ca-tile' + (!cur ? ' ca-tile-sel' : '') + '" data-file="">' +
      '<span class="ca-tile-none-glyph">∅</span><span class="ca-tile-lbl">None</span></button>';
    pool.forEach(function (c) {
      tiles += '<button class="ca-tile' + (cur === c.file ? ' ca-tile-sel' : '') +
        '" data-file="' + esc(c.file) + '" title="' + esc(c.label || c.file) + '">' +
        '<img src="' + esc(iconSrc(c.file)) + '" alt="" draggable="false"' + ICO_ERR + '>' +
        '<span class="ca-tile-lbl">' + esc(c.label || c.file) + '</span></button>';
    });

    sh.classList.remove('hidden');
    sh.innerHTML =
      '<div class="ca-pick-card">' +
      '<div class="ca-pick-head">Icon for <b>' + esc(art.name) + '</b>' +
      '<button class="ca-pick-x" title="Done (Esc)">✕</button></div>' +
      '<div class="ca-pick-search"><span class="ca-bar-glyph">⌕</span>' +
      '<input id="ca-pick-filter" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="Filter your icons…" value="' + esc(ui.pickFilter) + '"></div>' +
      '<div id="ca-pick-grid">' + tiles + '</div>' +
      (iconPool.length ? '' :
        '<div class="ca-pick-hint">No custom icons yet — drop images into the view’s ' +
        '<b>icons\\custom\\</b> folder, then reopen this picker.</div>') +
      '</div>';

    sh.querySelector('.ca-pick-x').addEventListener('click', closePicker);
    sh.addEventListener('mousedown', function (e) { if (e.target === sh) closePicker(); });
    sh.querySelectorAll('.ca-tile').forEach(function (b) {
      b.addEventListener('click', function () { pickIcon(b.getAttribute('data-file')); });
    });
    const filter = $('ca-pick-filter');
    if (filter) {
      filter.addEventListener('input', function () {
        ui.pickFilter = filter.value;
        const keep = filter.value;
        renderPicker();
        const f2 = $('ca-pick-filter');
        if (f2) { f2.value = keep; f2.focus(); f2.setSelectionRange(keep.length, keep.length); }
      });
      filter.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const first = sh.querySelector('.ca-tile[data-file]:not([data-file=""])');
          if (first) pickIcon(first.getAttribute('data-file'));
        }
      });
    }
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('caState', '{}');
    const s = $('ca-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    render();
  }

  function onHide() {
    ui.visible = false;
    closePicker();
    if (ui.toastT) { clearTimeout(ui.toastT); ui.toastT = null; }
  }

  function toggleEdit() {
    ui.edit = !ui.edit;
    render();
  }
  function wantsPause() { return true; }

  /* omni jump: land on the tab with the bar pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.sel = 0;
    const s = $('ca-search');
    if (s) s.value = ui.q;
    if (ui.visible) render();
  }

  function init() {
    if (ui.inited) return;
    ui.inited = true;
    const s = $('ca-search');
    if (s) {
      s.addEventListener('input', function () {
        ui.q = s.value;
        ui.sel = 0;
        renderBodyOnly();
      });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          /* Enter = equip the highlighted (top) COLLECTED hit and stay open.
             preventDefault + stopPropagation so it never leaks to the deck's
             quick-fire (the items-pane law). No hit = no-op, never a close. */
          e.preventDefault();
          e.stopPropagation();
          const rows = ownedRows();
          const hit = rows[Math.min(ui.sel, rows.length - 1)] || rows[0];
          if (hit) activate(hit);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = ownedRows();
          if (rows.length) {
            ui.sel = e.key === 'ArrowDown'
              ? Math.min(rows.length - 1, ui.sel + 1)
              : Math.max(0, ui.sel - 1);
            renderBodyOnly();
            const el = document.querySelector('#ca-body .ca-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Escape') {
          if (ui.picker) { closePicker(); e.stopPropagation(); }
          else if (s.value) { s.value = ''; ui.q = ''; ui.sel = 0; renderBodyOnly(); e.stopPropagation(); }
          /* bare Esc falls through to the palette's close, on purpose */
        }
      });
    }
    if (SELFTEST && DEV) setTimeout(devState, 60);
  }

  function renderBodyOnly() {
    renderHeader();
    renderBody();
  }

  /* =============================================================== dev == */

  function devArts() {
    const names = ['High Kick', 'Storm Stomp', 'Gravitas', 'Sacred Blade', 'Bloody Slash', 'Quickstep'];
    const arts = [];
    for (let i = 1; i <= 74; i++) {
      const owned = i <= 6;
      arts.push({
        id: 'ash' + pad2(i), num: i,
        name: owned ? names[i - 1] : ('Lost Art ' + pad2(i)),
        full: 'Ashes ' + pad2(i) + ': ' + (owned ? names[i - 1] : ('Lost Art ' + pad2(i))),
        owned: owned, count: i === 2 ? 3 : 1, icon: null, equipped: i === 1,
      });
    }
    return arts;
  }
  function devState() {
    window.caStateResult({ present: true, equipped: 'ash01', collected: 6, arts: devArts() });
  }
  function devAct(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    window.caActResult({
      ok: true, msg: req.op === 'equip' ? 'Equipped' : 'Unequipped',
      id: req.id || '', equipped: req.op === 'equip' ? req.id : null,
    });
  }
  function devSave(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    window.caSaved({ ok: true, icons: (req && req.icons) || {} });
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'combatarts', label: 'Combat Arts', tab: 'combatarts',
    setFilter: setFilter,
    index: function () {
      const out = [{
        label: 'Combat Arts',
        detail: 'Ashes of War — collect weapon arts, equip one on your blade',
        kind: 'combatarts',
        keywords: 'combat arts ashes of war weapon art skill collect equip',
      }];
      state.arts.forEach(function (a) {
        if (!a.owned) return;
        out.push({
          label: 'Equip ' + a.name + ' (Combat Art)',
          detail: (a.full || '') + (a.equipped ? ' · equipped now' : ''),
          kind: 'combatarts',
          keywords: 'combat art ashes equip ' + a.name,
          run: function () { equip(a.id); },
        });
      });
      return out;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    /* the Spell Deck's header paints its Edit button from this */
    isEditing: function () { return !!ui.edit; },
    _state: state, _ui: ui,
    _matches: matches, _ownedRows: ownedRows, _undiscRows: undiscRows,
    _equip: equip, _unequip: unequip, _activate: activate,
    _openPicker: openPicker, _closePicker: closePicker, _pickIcon: pickIcon,
    _hueFor: hueFor, _artById: artById, _iconPool: function () { return iconPool.slice(); },
    _render: render,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.CombatArtsPane.init(); });
} else {
  window.CombatArtsPane.init();
}
