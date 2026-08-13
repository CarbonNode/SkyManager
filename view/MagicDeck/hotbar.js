'use strict';

/* ============================================================================
   Hotbar — view logic for the always-on action bar.

   Bridge (C++ registers these; we call them through toGame). ⚠ ONE NAME PER
   DIRECTION — a name used for both silently unplugs the control, and this
   codebase has paid for that lesson more than once:

     toGame('hbReady')                 — on load: "push me config, live, icons"
     toGame('hbSave',    json)         — the whole editable Config, after any edit
     toGame('hbEditDone')              — leave edit mode (C++ then Unfocuses)
     toGame('hbFire',    json)         — {page, i} run this button NOW
     toGame('hbAssign',  json)         — {page, i, slot|null} put a thing on a button
     toGame('hbCatalog')               — "send me everything I can put on a button"
     toGame('hbLog',     msg)

   C++ calls INTO us:
     window.hbConfig(jsonStr)   — the whole Config (see src/hotbar.h)
     window.hbLive(jsonStr)     — {page, slots:[{i, ok, name, count, …}]}
     window.hbPage(jsonStr)     — {page} the modifier page that is live right now
     window.hbEdit("1"|"0")     — enter / leave edit mode
     window.hbFlash(jsonStr)    — {page,i} exact fired button: flash it
     window.hbCatalogData(json) — {spells:[], items:[], entries:[], combos:[]}
     window.hbIconIndex(json)   — the Spell Hotbar 2 atlas index (same shape the
                                  Spell Deck gets — this view is in its folder
                                  precisely so those paths resolve)
     window.hbIcons(json)       — {custom:[{file,label}]} live icons/custom listing
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else if (DEV) {
      console.log('[hb->game]', fn, arg);
    }
  }
  function log(m) { toGame('hbLog', m); if (DEV) console.log('[hb]', m); }

  /* C++ sometimes hands us a JSON string and sometimes (dev/harness) a real
     object. Coerce once, here, rather than guessing at every entry point. */
  function coerce(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const MAX_SLOTS = 24;            // must match kMaxSlots in hotbar.h
  const PAGE_NAMES = ['Main', 'Shift', 'Ctrl', 'Alt'];

  /* ── state ───────────────────────────────────────────────────────────── */

  const cfg = {
    enabled: false, visible: true,
    x: 0, y: 90, scale: 1,
    orient: 'horiz', anchorH: 'center', anchorV: 'bottom',
    cols: 8, rows: 1,
    showKeys: true, showLabels: false, showCounts: true, showEmpty: true,
    idleMs: 0, idleAlpha: 0.35, uiScale: 1, opacity: 1,
    showMode: 'always', lingerMs: 4000, hideInMenus: true,
    skin: 'plain', modHold: true,
    pages: [], slotKeys: [],
    key: { device: 'keyboard', code: 0, label: '' },
  };

  let livePage = 0;               // which page the modifiers currently select
  let live = { page: 0, slots: [] };
  let editing = false;
  let selected = 0;               // the button the edit panel is talking about
  let lastFireAt = 0;
  /* True while the user is ACTIVELY moving the bar — a grip drag or an arrow
     nudge. The panel-avoidance shift below is for a STATIC preview only; while
     you are hand-placing the bar it must follow the cursor 1:1 across the whole
     screen, so the avoidance is suppressed for the duration and the bar sits at
     its true cfg position. Without this, applyPlacement re-clamps the position
     into the narrow strip beside the panel on every mousemove, which pins the
     bar the moment it reaches the strip edge — the "won't drag horizontally
     anywhere" bug (Rober, 2026-08-13). */
  let interacting = false;
  /* True once the user has hand-placed the bar in THIS edit session (a grip
     drag or an arrow nudge). The panel-avoidance shift exists only so a bar
     you have NOT touched doesn't hide under the setup panel; the instant you
     grab it and put it somewhere, that convenience must stop moving it. Without
     this the bar jumps by the avoidance-shift the moment you release the drag —
     "it jumps from where I let go" (Rober, 2026-08-13). The invariant: the
     pixel under the cursor at mouseup is where the bar stays. Reset on each
     edit-mode entry. */
  let placed = false;

  const ICONS = { byForm: null, generic: null, catalog: [], custom: [] };
  /* `loaded` separates "the catalog is still in flight" from "you really own
     nothing" — without it the picker's first frame accuses you of not having
     opened the deck, which is an error message where a wait belongs. */
  const CATALOG = { spells: [], items: [], entries: [], combos: [], loaded: false };

  const el = {};
  ['hb-root', 'hb-grid', 'hb-pages', 'hb-grip', 'hb-edit', 'hb-done',
   'hb-cols', 'hb-rows', 'hb-orient', 'hb-scale', 'hb-scale-val', 'hb-shape-note',
   'hb-anchorH', 'hb-anchorV', 'hb-skins', 'hb-showKeys', 'hb-showLabels',
   'hb-showCounts', 'hb-showEmpty', 'hb-idle', 'hb-idle-val', 'hb-pagetoggles',
   'hb-modHold', 'hb-slotlist', 'hb-page-name', 'hb-slot-note',
   'hb-showMode', 'hb-linger', 'hb-linger-val', 'hb-linger-row', 'hb-hideInMenus',
   'hb-togglekey', 'hb-togglekey-clear', 'hb-show-note', 'hb-preview-note',
   'hb-uiscale', 'hb-uiscale-val', 'hb-opacity', 'hb-opacity-val', 'hb-reset-pos',
   'hb-pick', 'hb-pick-title', 'hb-pick-q', 'hb-pick-tabs', 'hb-pick-list', 'hb-pick-wrap',
   'hb-pick-close', 'hb-pick-clear',
   'hb-icons', 'hb-icons-q', 'hb-icons-grid', 'hb-icons-close', 'hb-icons-auto',
   'hb-cap', 'hb-cap-title', 'hb-cap-key', 'hb-cap-clear', 'hb-cap-cancel',
  ].forEach((id) => { el[id] = document.getElementById(id); });

  /* Add the injected controls, then bind the ids they created into `el`. Done
     up front so every later `el['hb-opacity']` / `el['hb-reset-pos']` resolves,
     exactly as if they had been in the static markup. */
  injectControls();
  ['hb-opacity', 'hb-opacity-val', 'hb-reset-pos'].forEach((id) => { el[id] = document.getElementById(id); });

  /* ── tiny DOM helper (same shape as the deck's `h`) ───────────────────── */
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  /* ── inject the opacity slider + reset-position button ────────────────────
     These two controls are added from JS rather than the static hotbar.html so
     the whole feature ships in the view's JS/CSS pair. Idempotent (guards on the
     ids), and it re-uses the panel's own field/row classes so it matches every
     other control exactly. The opacity slider lands in the Look section beside
     the editor-scale slider; the reset button lands under the Where anchors —
     an escape hatch that is always on screen because the panel is. */
  function injectControls() {
    // Opacity — after the editor-scale slider's row (its .hb-range's row).
    if (!document.getElementById('hb-opacity')) {
      const uiRange = document.getElementById('hb-uiscale');
      const uiRow = uiRange && uiRange.closest('.hb-row');
      if (uiRow && uiRow.parentNode) {
        const row = h('div', { class: 'hb-row' },
          h('label', { class: 'hb-field hb-grow',
              title: 'How solid the bar is during play. Lower it so the bar does not cover the scene.' },
            h('span', {}, 'Bar opacity ', h('em', { id: 'hb-opacity-val' }, '100%')),
            h('input', { id: 'hb-opacity', class: 'hb-range', type: 'range',
              min: '30', max: '100', step: '5',
              title: 'How solid the bar is during play (edit mode always shows it fully)' })));
        uiRow.parentNode.insertBefore(row, uiRow.nextSibling);
      }
    }
    // Reset position — after the Where section's anchor row.
    if (!document.getElementById('hb-reset-pos')) {
      const av = document.getElementById('hb-anchorV');
      const whereSect = av && av.closest('.hb-sect');
      if (whereSect) {
        const row = h('div', { class: 'hb-row' },
          h('button', { id: 'hb-reset-pos', class: 'hb-btn', type: 'button',
            title: 'Move the bar back to a safe spot (bottom centre) if it drifted off screen' },
            'Reset position'),
          h('p', { class: 'hb-note',
            text: 'Recentres the bar at the bottom of the screen — use it if the bar or its ✥ grip ends up off screen.' }));
        whereSect.appendChild(row);
      }
    }
  }

  /* ── icons: the Spell Deck's own resolve chain ────────────────────────── */
  /* Ported deliberately rather than shared: this is a separate document and
     app.js is not loaded here. Keep the two in step — the chain is
     override → exact FormID → school/element/tier generic → glyph. */

  function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  }
  function shKeyFor(m) {
    if (!m || !m.plugin || m.localId === undefined || m.localId === null) return null;
    const id = Number(m.localId);
    if (!isFinite(id)) return null;
    return String(m.plugin).toLowerCase() + '|' + (id >>> 0).toString(16);
  }
  function genericKeyFor(m) {
    if (!m) return null;
    const t = String(m.tier || 'NOVICE').toUpperCase();
    if (m.type === 'shout' || m.voice) return 'SHOUT_GENERIC';
    switch (String(m.school || '').toLowerCase()) {
      case 'destruction': {
        const e = String(m.element || '').toLowerCase();
        if (e === 'fire' || e === 'frost' || e === 'shock') return 'DESTRUCTION_' + e.toUpperCase() + '_' + t;
        return 'DESTRUCTION_GENERIC_' + t;
      }
      case 'alteration':   return 'ALTERATION_' + t;
      case 'restoration':  return 'RESTORATION_FRIENDLY_' + t;
      case 'illusion':     return 'ILLUSION_FRIENDLY_' + t;
      case 'conjuration':  return 'CONJURATION_SUMMON_' + t;
    }
    return null;
  }
  function resolveIconPath(m) {
    if (m && m.icon) return normPath(m.icon);
    if (ICONS.byForm && m) {
      const k = shKeyFor(m);
      if (k && ICONS.byForm[k]) return ICONS.byForm[k];
    }
    if (ICONS.generic && m) {
      const g = genericKeyFor(m);
      if (g && ICONS.generic[g]) return ICONS.generic[g];
    }
    return null;
  }
  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const a = [...parts[0]][0] || '';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }
  /* An <img> when the chain resolves, initials otherwise. A broken src (a
     deleted custom file, a stale override) swaps itself for the initials via
     onerror, so a button never shows a broken-image box. */
  function artFor(model, name) {
    const p = resolveIconPath(model);
    if (!p) return h('span', { class: 'hb-glyph', text: initialsOf(name) || '·' });
    const img = h('img', { class: 'hb-art', src: p, alt: '', draggable: 'false' });
    img.addEventListener('error', () => {
      const fb = h('span', { class: 'hb-glyph', text: initialsOf(name) || '·' });
      if (img.parentNode) img.parentNode.replaceChild(fb, img);
    });
    return img;
  }

  /* ── config plumbing ─────────────────────────────────────────────────── */

  function pageAt(i) {
    if (!Array.isArray(cfg.pages)) cfg.pages = [];
    while (cfg.pages.length < 4) cfg.pages.push({ enabled: cfg.pages.length === 0, name: '', slots: [] });
    const p = cfg.pages[clamp(i, 0, 3)];
    if (!Array.isArray(p.slots)) p.slots = [];
    while (p.slots.length < MAX_SLOTS) p.slots.push({});
    return p;
  }
  function slotAt(page, i) { return pageAt(page).slots[clamp(i, 0, MAX_SLOTS - 1)] || {}; }
  function keyAt(i) {
    if (!Array.isArray(cfg.slotKeys)) cfg.slotKeys = [];
    while (cfg.slotKeys.length < MAX_SLOTS) cfg.slotKeys.push({ device: 'keyboard', code: 0, label: '' });
    return cfg.slotKeys[clamp(i, 0, MAX_SLOTS - 1)];
  }
  function visibleSlots() {
    return clamp(Math.max(1, cfg.cols | 0) * Math.max(1, cfg.rows | 0), 1, MAX_SLOTS);
  }
  function isEmptySlot(s) {
    if (!s || !s.kind) return true;
    if (s.kind === 'entry' || s.kind === 'combo') return !s.refId;
    return !s.localId && !s.formId;
  }

  /* Everything the C++ side persists. Sent whole on every edit: the config is
     small, and a partial patch protocol is how the two sides drift apart. */
  function saveCfg() {
    toGame('hbSave', JSON.stringify({
      x: cfg.x, y: cfg.y, scale: cfg.scale,
      orient: cfg.orient, anchorH: cfg.anchorH, anchorV: cfg.anchorV,
      cols: cfg.cols, rows: cfg.rows,
      showKeys: cfg.showKeys, showLabels: cfg.showLabels,
      showCounts: cfg.showCounts, showEmpty: cfg.showEmpty,
      idleMs: cfg.idleMs, idleAlpha: cfg.idleAlpha, uiScale: cfg.uiScale,
      opacity: cfg.opacity,
      showMode: cfg.showMode, lingerMs: cfg.lingerMs, hideInMenus: cfg.hideInMenus,
      key: cfg.key,
      skin: cfg.skin, modHold: cfg.modHold,
      pages: cfg.pages.map((p) => ({ enabled: !!p.enabled, name: p.name || '', slots: p.slots })),
      slotKeys: cfg.slotKeys,
    }));
  }

  /* ── placement ───────────────────────────────────────────────────────── */
  /* The stored (x,y) is measured FROM the anchor edge, and transform-origin is
     set to the same corner. That pairing is what makes a bottom-centred bar
     stay bottom-centred when you scale it — origin at the wrong corner walks
     the bar off screen as it grows, which is the classic version of this bug. */

  /* While the edit panel is up it covers the right of the screen — and the bar
     is usually centred, so at anything narrower than a very wide monitor the
     thing you are editing hides UNDER the thing you are editing it with. Shift
     the bar out of the panel's way for the duration; the stored x/y never
     changes, so leaving edit mode puts it exactly back. Measured, never
     assumed: the panel is min(560px,46vw) and 46vw is the live one on a narrow
     window. */
  /* The editor's size. Clamped TWICE: the config is 0.8-2.0, and then again
     here so the scaled panel can never be wider than 94% of the window — a
     panel whose controls have walked off the right edge is unusable, and the
     user cannot fix it because the fix is IN the panel. Re-applied on resize
     because the clamp depends on the viewport. */
  function applyUiScale() {
    const want = clamp(Number(cfg.uiScale) || 1, 1, 2);
    const panel = el['hb-edit'];
    let capped = want;
    if (panel) {
      /* offsetWidth is the UNSCALED layout width — exactly what we need to
         work out how wide it WOULD be at a given scale. (getBoundingClientRect
         would already include the transform and make this circular.) */
      const layout = panel.offsetWidth || 1;
      const max = (window.innerWidth * 0.94) / layout;
      /* Never BELOW 1. Under ~900px the panel is already full-width by media
         query, so `max` comes out under 1 and an unfloored clamp would shrink
         the type on exactly the screen that can least afford it. At 1x a
         full-width panel is exactly the viewport, so there is nothing to
         overflow. Above 1 the cap is real and keeps the panel on screen. */
      capped = Math.max(1, Math.min(want, max));
    }
    document.documentElement.style.setProperty('--hb-ui', String(capped));
    return capped;
  }
  window.addEventListener('resize', () => { applyUiScale(); applyPlacement(); });

  const EDIT_GAP = 12;
  const EDIT_DRAG_ROOM = 48;

  /* Resolve the preview as geometry, not a guessed half-panel shove. At
     1024px the measured free strip is 552.97px while the default eight-button
     bar is 554px: no translation can keep both fully on screen. A temporary
     preview fit closes that exact 1.03px impossibility and leaves 48px of drag
     room on each side, while the saved cfg.scale remains untouched. If fitting
     would shrink the preview by more than 30%, hide it honestly instead of
     manufacturing tiny unreadable art. */
  function editPreviewLayout() {
    const baseScale = Number(cfg.scale) || 1;
    const out = { hidden: false, fit: false, shift: 0, scale: baseScale, reason: '' };
    if (!editing) return out;
    /* Hand-placing the bar (interacting), OR the user has already placed it this
       session (placed): no avoidance. The bar tracks the cursor / arrows at its
       true cfg position across the full screen — the clamp below is what
       otherwise pins a drag inside the free strip. And once the user has put the
       bar somewhere on purpose, re-introducing the shift on mouseup would move
       it away from where they let go (the "jumps from where I let go" bug). The
       shift is a convenience for a bar you have NOT touched, and stops the
       moment you do. */
    if (interacting || placed) return out;
    const p = el['hb-edit'];
    const r = el['hb-root'];
    if (!p || p.hidden || !r) return out;

    const pr = p.getBoundingClientRect();
    if (!pr.width) return out;
    if (pr.width > window.innerWidth * 0.7) {
      out.hidden = true;
      out.reason = 'The bar preview is hidden while setup fills this screen. Tap Done to see it in play.';
      return out;
    }

    const freeRight = Math.max(0, Math.min(window.innerWidth, pr.left) - EDIT_GAP);
    const layoutW = r.offsetWidth || 1; // deliberately unscaled; avoids measurement feedback loops
    /* A just-barely fitting bar is technically collision-free but cannot move:
       x changes and the clamp cancels them out. Preserve a real horizontal
       drag lane whenever the viewport has it. */
    const dragRoom = Math.min(EDIT_DRAG_ROOM, freeRight * 0.1);
    const fitScale = Math.max(0, freeRight - dragRoom * 2) / layoutW;
    if (fitScale < baseScale) {
      if (fitScale / baseScale < 0.7) {
        out.hidden = true;
        out.reason = 'The bar preview is hidden because this layout is too wide to show beside setup. Tap Done to see it at full size.';
        return out;
      }
      out.scale = Math.max(0.01, fitScale);
      out.fit = true;
      out.reason = 'Preview scaled to fit beside setup. Your saved bar Size is unchanged.';
    }

    const barW = layoutW * out.scale;
    const x = Number(cfg.x) || 0;
    let desiredLeft = x;
    if (cfg.anchorH === 'center') desiredLeft = freeRight / 2 + x - barW / 2;
    else if (cfg.anchorH === 'right') desiredLeft = freeRight - x - barW;
    const placedLeft = clamp(desiredLeft, 0, Math.max(0, freeRight - barW));
    /* Convert the measured preview position back into each anchor's stored
       coordinate system. The conversion is constant through the middle of
       the drag lane, so cfg.x changes remain visibly one-for-one. */
    if (cfg.anchorH === 'left') out.shift = x - placedLeft;
    else if (cfg.anchorH === 'right') out.shift = window.innerWidth - x - (placedLeft + barW);
    else out.shift = window.innerWidth / 2 + x - (placedLeft + barW / 2);
    return out;
  }

  function paintPreviewState(preview) {
    const r = el['hb-root'];
    const grip = el['hb-grip'];
    const note = el['hb-preview-note'];
    r.classList.toggle('is-edit-preview-hidden', preview.hidden);
    r.classList.toggle('is-edit-preview-fit', preview.fit);
    if (preview.hidden) r.setAttribute('aria-hidden', 'true');
    else r.removeAttribute('aria-hidden');
    if (grip) grip.hidden = !editing || preview.hidden;
    /* Grip side. The grip is a sibling in the bar's flex column, so by default
       it sits BELOW the grid and adds its own height to the bar's bounding box —
       a bottom-anchored bar then cannot touch the bottom screen edge, and near
       the edge the grip itself clips off-screen (Rober, 2026-08-13: grip hangs
       below the bar; a grip clipped off-screen). Flip it ABOVE the grid whenever
       the bar lives in the LOWER half of the screen, so the bar can sit flush
       against the bottom and the grip stays reachable. In the upper half it
       stays below for the same reason at the top edge. Purely a CSS `order`
       flip — no geometry stored. */
    const lower = cfg.anchorV === 'bottom';
    r.classList.toggle('grip-above', editing && lower);
    r.classList.toggle('grip-below', editing && !lower);
    if (note) {
      note.hidden = !editing || (!preview.hidden && !preview.fit);
      note.textContent = note.hidden ? '' : preview.reason;
    }
  }

  /* ── keep the bar reachable ───────────────────────────────────────────── */
  /* On edit-mode entry (and on a config load while editing) pull the bar — and
     its drag grip — fully back on screen if any part of it has drifted off.
     Without this a bar dragged too far, or one loaded from an odd saved
     position, becomes unmovable because the grip you would grab is past the
     edge (Rober, 2026-08-13: "got it stuck and now can't move it"). Measured
     against the real rendered box, converted back into the anchor's own
     coordinate space so the stored x/y stays honest. A 6px inset keeps the
     grip's rim clear of the very edge. */
  const EDGE_INSET = 6;
  function clampIntoView() {
    const r = el['hb-root'];
    if (!r || !editing) return false;
    const rect = r.getBoundingClientRect();
    /* jsdom / a pre-layout frame reports a zero box — nothing to clamp against,
       and clamping to a phantom 0×0 rect would yank a perfectly-placed bar to
       the corner. Bail unless we have a real measurement. */
    if (!rect.width || !rect.height) return false;
    const W = window.innerWidth, H = window.innerHeight;
    let dx = 0, dy = 0;
    if (rect.left < EDGE_INSET) dx = EDGE_INSET - rect.left;
    else if (rect.right > W - EDGE_INSET) dx = (W - EDGE_INSET) - rect.right;
    if (rect.top < EDGE_INSET) dy = EDGE_INSET - rect.top;
    else if (rect.bottom > H - EDGE_INSET) dy = (H - EDGE_INSET) - rect.bottom;
    if (!dx && !dy) return false;
    /* Screen-space deltas → stored deltas. A right/bottom anchor counts inward,
       so a rightward screen move (+dx) DECREASES the stored offset. */
    cfg.x = Math.round(cfg.x + dx * (cfg.anchorH === 'right' ? -1 : 1));
    cfg.y = Math.round(cfg.y + dy * (cfg.anchorV === 'bottom' ? -1 : 1));
    placed = true;   // a clamp is a placement — don't let avoidance move it again
    applyPlacement();
    return true;
  }

  /* Recentre the bar to a safe, always-visible spot: bottom-centre, a little way
     up from the edge. The escape hatch for a bar that got stuck — the button
     that triggers it lives in the setup panel, which can never itself be
     off-screen, so this can always be reached. */
  function resetPosition() {
    cfg.anchorH = 'center';
    cfg.anchorV = 'bottom';
    cfg.x = 0;
    cfg.y = 90;
    placed = true;
    if (el['hb-anchorH']) el['hb-anchorH'].value = 'center';
    if (el['hb-anchorV']) el['hb-anchorV'].value = 'bottom';
    applyPlacement();
    saveCfg();
  }

  function applyPlacement() {
    const r = el['hb-root'];
    if (!r) return;
    const s = r.style;
    s.left = s.right = s.top = s.bottom = s.transform = '';

    const preview = editPreviewLayout();
    paintPreviewState(preview);
    const shift = preview.shift;
    let ox = 'center', oy = 'center';
    if (cfg.anchorH === 'left')       { s.left = ((Number(cfg.x) || 0) - shift) + 'px';  ox = 'left'; }
    else if (cfg.anchorH === 'right') { s.right = (cfg.x + shift) + 'px'; ox = 'right'; }
    else {
      /* x is still meaningful for a centre anchor: it is an offset from the
         screen centre. The first version persisted cfg.x during a drag but
         hard-coded left:50%, so horizontal movement was mathematically
         discarded. Put the offset in the layout position; transform remains
         responsible only for centring/scaling. */
      s.left = 'calc(50% + ' + Math.round((Number(cfg.x) || 0) - shift) + 'px)';
      ox = 'center';
    }
    if (cfg.anchorV === 'top') { s.top = cfg.y + 'px'; oy = 'top'; }
    else                       { s.bottom = cfg.y + 'px'; oy = 'bottom'; }

    r.style.transformOrigin = ox + ' ' + oy;
    r.style.transform =
      (cfg.anchorH === 'center' ? 'translateX(-50%) ' : '') +
      'scale(' + preview.scale + ')';
    r.style.setProperty('--hb-scale', '1');   // scale lives in the transform above
    applyOpacity();
  }

  /* Play-time opacity. A separate multiplier from the idle fade: idleAlpha dims
     the bar after inactivity, opacity is a steady see-through-ness the player
     dials in so the bar doesn't cover the scene. Edit mode ALWAYS renders fully
     opaque — you cannot place a bar you can barely see. Applied as its own CSS
     var so it composes with --hb-alpha (idle) rather than fighting it. */
  function applyOpacity() {
    const r = el['hb-root'];
    if (!r) return;
    const o = editing ? 1 : clamp(Number(cfg.opacity) || 1, 0.3, 1);
    r.style.setProperty('--hb-opacity', String(o));
  }

  /* ── the bar ─────────────────────────────────────────────────────────── */

  function render() {
    const root = el['hb-root'];
    const grid = el['hb-grid'];
    if (!root || !grid) return;

    root.className = 'hb-root skin-' + (cfg.skin || 'plain') +
                     (cfg.showEmpty ? '' : ' hide-empty') +
                     ((cfg.enabled && cfg.visible) || editing ? '' : ' hb-hidden');

    const n = visibleSlots();
    const along = Math.max(1, cfg.cols | 0);      // buttons along the long axis
    const lines = Math.max(1, cfg.rows | 0);      // how many lines of them
    grid.style.gridTemplateColumns = cfg.orient === 'vert'
      ? 'repeat(' + lines + ', var(--hb-cell))'
      : 'repeat(' + along + ', var(--hb-cell))';
    /* In vertical mode the buttons must run DOWN the first column before
       wrapping to the second, which is grid-auto-flow: column. */
    grid.style.gridAutoFlow = cfg.orient === 'vert' ? 'column' : 'row';
    grid.style.gridTemplateRows = cfg.orient === 'vert'
      ? 'repeat(' + along + ', var(--hb-cell))'
      : 'repeat(' + lines + ', var(--hb-cell))';

    clear(grid);
    const rows = (live && Array.isArray(live.slots)) ? live.slots : [];
    for (let i = 0; i < n; i++) {
      grid.appendChild(slotEl(i, rows[i] || { i: i, kind: '' }));
    }
    renderPips();
    applyPlacement();
    applyIdle();
  }

  function slotEl(i, L) {
    const s = slotAt(livePage, i);
    const k = keyAt(i);
    const empty = isEmptySlot(s) || !L.kind;
    const dead = !empty && L.ok === false;
    const name = s.label || L.label || L.name || '';

    /* Every badge is gated on !empty. The stored slot and the live row are
       pushed on different beats — clearing a button updates cfg and re-renders
       at once, while the matching hbLive is a tick behind — so an ungated badge
       paints the PREVIOUS occupant's stack count on an empty socket. */
    const cls = ['hb-slot'];
    if (empty) cls.push('is-empty');
    if (dead) cls.push('is-dead');
    if (!empty && L.equipped) cls.push('is-equipped');
    if (!empty && L.voice) cls.push('is-voice');
    if (editing && i === selected) cls.push('is-selected');

    const btn = h('div', {
      class: cls.join(' '),
      'data-i': String(i),
      'data-page': String(livePage),
      title: empty ? ('Button ' + (i + 1) + ' — empty')
                   : (name + (dead && L.msg ? ' — ' + L.msg : '')),
    });

    if (empty) {
      btn.appendChild(h('span', { class: 'hb-glyph', text: '+' }));
    } else {
      /* The live row carries school/element/tier so the generic fallback can
         fire; the stored slot carries the override. Merge, override wins. */
      btn.appendChild(artFor(Object.assign({}, L, { icon: s.icon || L.icon }), name));
    }
    if (cfg.showKeys && k.code) btn.appendChild(h('span', { class: 'hb-key', text: k.label || '' }));
    if (!empty && cfg.showCounts && L.count > 1)
      btn.appendChild(h('span', { class: 'hb-count', text: 'x' + L.count }));

    if (editing) {
      btn.addEventListener('click', () => { selected = i; renderEdit(); render(); });
    }

    if (!cfg.showLabels) return btn;
    return h('div', { class: 'hb-cell-wrap' }, btn,
      h('div', { class: 'hb-label', title: name, text: name }));
  }

  function renderPips() {
    const box = el['hb-pages'];
    if (!box) return;
    const any = [1, 2, 3].some((i) => pageAt(i).enabled);
    box.hidden = !any;
    if (!any) return;
    clear(box);
    for (let i = 0; i < 4; i++) {
      const p = pageAt(i);
      if (i > 0 && !p.enabled) continue;
      box.appendChild(h('span', {
        class: 'hb-pip' + (i === livePage ? ' is-live' : ''),
        text: p.name || PAGE_NAMES[i],
      }));
    }
  }

  /* Idle fade. A bar that dims when untouched and snaps back on a press —
     0 means never fade, which is the default because a bar that vanishes is
     worse than one that is always there. */
  let idleTimer = 0;
  function applyIdle() {
    const root = el['hb-root'];
    if (!root) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    if (!cfg.idleMs || editing) { root.style.setProperty('--hb-alpha', '1'); return; }
    const since = Date.now() - lastFireAt;
    if (since >= cfg.idleMs) {
      root.style.setProperty('--hb-alpha', String(cfg.idleAlpha));
    } else {
      root.style.setProperty('--hb-alpha', '1');
      idleTimer = setTimeout(applyIdle, Math.max(120, cfg.idleMs - since));
    }
  }

  const flashTimers = {};
  function flash(page, i) {
    lastFireAt = Date.now();
    applyIdle();
    /* A modifier release can repaint Base between the native key match and
       this JS call. Never pulse the same index on the wrong page. */
    if (page !== livePage) return;
    const n = el['hb-grid'] && el['hb-grid'].querySelector(
      '.hb-slot[data-page="' + page + '"][data-i="' + i + '"]');
    if (!n) return;
    const k = page + ':' + i;
    if (flashTimers[k]) clearTimeout(flashTimers[k]);
    n.classList.remove('is-fired');
    void n.offsetWidth;  // repeat presses restart the physical down/up beat
    n.classList.add('is-fired');
    flashTimers[k] = setTimeout(() => {
      n.classList.remove('is-fired');
      delete flashTimers[k];
    }, 260);
  }

  /* ── drag to move ────────────────────────────────────────────────────── */
  /* Ultralight does NOT implement HTML5 drag & drop (the deck learned this the
     hard way), so this is pointer maths on mousedown/mousemove/mouseup. */

  (function wireGrip() {
    const grip = el['hb-grip'];
    if (!grip) return;
    let dragging = false, sx = 0, sy = 0, bx = 0, by = 0;

    grip.addEventListener('mousedown', (e) => {
      dragging = true; interacting = true;
      sx = e.clientX; sy = e.clientY; bx = cfg.x; by = cfg.y;
      /* Snap the preview to the true position for the drag: the avoidance shift
         is off while `interacting`, so the bar jumps to where cfg.x actually
         is before the first mousemove — otherwise the pointer would grab it at
         the shifted spot and the whole drag would carry a constant offset. */
      applyPlacement();
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      /* An anchor on the right/bottom edge counts INWARD, so the delta has to
         be inverted or the bar runs away from the cursor. The bar follows the
         cursor across the FULL screen width — no clamp, because the user is
         directly placing it and 1:1 feedback is the whole point. */
      const dx = (e.clientX - sx) * (cfg.anchorH === 'right' ? -1 : 1);
      const dy = (e.clientY - sy) * (cfg.anchorV === 'bottom' ? -1 : 1);
      cfg.x = Math.round(bx + dx);
      cfg.y = Math.round(by + dy);
      applyPlacement();
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; interacting = false;
      /* The user just hand-placed the bar. Mark it placed so avoidance stays
         off — re-introducing the panel-avoidance shift here would jump the bar
         away from exactly where the cursor let go. The pixel under the cursor
         at mouseup is the resting pixel; cfg.x/y already hold it. */
      placed = true;
      saveCfg();
      applyPlacement();   // repaint at the placed position (no shift now)
    });
  })();

  /* Arrow-key nudge while editing — pixel-accurate placement that a drag cannot
     give you. A nudge is a placement: it marks the bar `placed`, which keeps the
     panel-avoidance shift off so the nudge lands 1:1 and the bar rests exactly
     where you put it (no settle-back that would swallow a nudge near the strip
     edge, and no jump on the following repaint). */
  document.addEventListener('keydown', (e) => {
    if (!editing) return;
    if (el['hb-pick'] && !el['hb-pick'].hidden) return;
    if (el['hb-cap'] && !el['hb-cap'].hidden) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const step = e.shiftKey ? 10 : 1;
    let hit = true;
    if (e.key === 'ArrowLeft')       cfg.x -= cfg.anchorH === 'right' ? -step : step;
    else if (e.key === 'ArrowRight') cfg.x += cfg.anchorH === 'right' ? -step : step;
    else if (e.key === 'ArrowUp')    cfg.y -= cfg.anchorV === 'bottom' ? -step : step;
    else if (e.key === 'ArrowDown')  cfg.y += cfg.anchorV === 'bottom' ? -step : step;
    else hit = false;
    if (!hit) return;
    e.preventDefault();
    placed = true;
    applyPlacement();
    saveCfg();
  });

  /* ── edit panel ──────────────────────────────────────────────────────── */

  const SKINS = [
    { id: 'plain',  label: 'Plain' },
    { id: 'runed',  label: 'Runed' },
    { id: 'carved', label: 'Carved' },
    { id: 'gilded', label: 'Gilded' },
  ];

  /* Assign a form control's value WITHOUT stomping a live interaction. Writing
     `.value` on a <select> whose native dropdown is open closes the popup, and
     the poller re-runs renderEdit() on every hbConfig/hbLive push (~700ms) — so
     the very first click that opened a Rows/Direction dropdown got swallowed by
     the next poll before the user could pick, and it "took two clicks" (Rober,
     2026-08-13). Never rewrite the control the user is currently touching, and
     skip the write when it already matches so an unchanged poll is inert. */
  function setVal(id, v) {
    const n = el[id];
    if (!n) return;
    if (n === document.activeElement) return;   // don't collapse an open dropdown
    const s = String(v);
    if (n.value !== s) n.value = s;
  }

  function renderEdit() {
    if (!editing) return;
    setVal('hb-cols', cfg.cols);
    setVal('hb-rows', String(cfg.rows));
    setVal('hb-orient', cfg.orient);
    setVal('hb-anchorH', cfg.anchorH);
    setVal('hb-anchorV', cfg.anchorV);
    setVal('hb-scale', Math.round((cfg.scale || 1) * 100));
    el['hb-scale-val'].textContent = Math.round((cfg.scale || 1) * 100) + '%';
    el['hb-showKeys'].checked = !!cfg.showKeys;
    el['hb-showLabels'].checked = !!cfg.showLabels;
    el['hb-showCounts'].checked = !!cfg.showCounts;
    el['hb-showEmpty'].checked = !!cfg.showEmpty;
    el['hb-modHold'].checked = !!cfg.modHold;
    setVal('hb-idle', String(Math.round((cfg.idleMs || 0) / 1000)));
    el['hb-idle-val'].textContent = cfg.idleMs ? (Math.round(cfg.idleMs / 1000) + 's') : 'Never';

    /* opacity (play-time see-through-ness; 100% = solid) */
    const opPct = Math.round(clamp(Number(cfg.opacity) || 1, 0.3, 1) * 100);
    setVal('hb-opacity', String(opPct));
    if (el['hb-opacity-val']) el['hb-opacity-val'].textContent = opPct + '%';
    applyOpacity();

    /* ---- when to show ------------------------------------------------- */
    const uiPct = Math.round((clamp(Number(cfg.uiScale) || 1, 1, 2)) * 100);
    setVal('hb-uiscale', String(uiPct));
    const applied = Math.round(applyUiScale() * 100);
    el['hb-uiscale-val'].textContent = applied < uiPct
      ? (uiPct + '% (capped to ' + applied + '% by your window)')
      : (uiPct + '%');

    setVal('hb-showMode', cfg.showMode || 'always');
    el['hb-hideInMenus'].checked = !!cfg.hideInMenus;
    setVal('hb-linger', String(Math.round((cfg.lingerMs || 0) / 1000)));
    el['hb-linger-val'].textContent = cfg.lingerMs
      ? (Math.round(cfg.lingerMs / 1000) + 's') : 'No delay';
    /* The linger only means anything for the modes that watch combat — showing
       it under "Always" would be a control that does nothing. */
    const watchesCombat = cfg.showMode === 'combat' || cfg.showMode === 'either';
    el['hb-linger-row'].hidden = !watchesCombat;

    const tk = cfg.key || {};
    el['hb-togglekey'].textContent = tk.code ? (tk.label || ('#' + tk.code)) : 'No key';
    el['hb-togglekey'].className = 'hb-keybtn' + (tk.code ? '' : ' is-unbound');
    el['hb-togglekey-clear'].disabled = !tk.code;

    el['hb-show-note'].textContent = cfg.showMode === 'always'
      ? 'The bar is up whenever it is switched on. Its keys work while you can see it.'
      : 'While the bar is hidden by this rule its keys do nothing either — so your '
        + 'number keys go back to being Skyrim\'s own favourites out of combat.';

    el['hb-shape-note'].textContent =
      visibleSlots() + ' buttons on screen. Buttons past the end keep whatever you put on them — '
      + 'widen the bar again and they come back.';

    /* skins */
    clear(el['hb-skins']);
    SKINS.forEach((s) => {
      const sw = h('div', { class: 'sw hb-slot' });
      const tile = h('div', { class: 'hb-skin skin-' + s.id + (cfg.skin === s.id ? ' is-on' : ''), title: s.label },
        sw, h('span', { text: s.label }));
      tile.addEventListener('click', () => { cfg.skin = s.id; saveCfg(); render(); renderEdit(); });
      el['hb-skins'].appendChild(tile);
    });

    /* page toggles */
    clear(el['hb-pagetoggles']);
    [1, 2, 3].forEach((i) => {
      const p = pageAt(i);
      const box = h('input', { type: 'checkbox' });
      box.checked = !!p.enabled;
      box.addEventListener('change', () => {
        p.enabled = box.checked;
        if (!p.enabled && selectedPage === i) { selectedPage = 0; }
        saveCfg(); renderEdit(); render();
      });
      el['hb-pagetoggles'].appendChild(
        h('label', {
          class: 'hb-check',
          title: 'Hold ' + PAGE_NAMES[i] + ' to swap the whole bar to a second set of actions. '
               + 'Off means ' + PAGE_NAMES[i] + ' keeps whatever the game already does with it.',
        }, box, h('span', { text: PAGE_NAMES[i] + ' page' })));
    });

    renderSlotList();
  }

  /* Which page the EDIT panel is showing. Independent of livePage: you edit
     the shift page without holding shift, which you could not do otherwise —
     holding shift while clicking in the panel is not a workflow. */
  let selectedPage = 0;

  function renderSlotList() {
    const box = el['hb-slotlist'];
    clear(box);

    /* page tabs for the editor */
    const tabs = h('div', { class: 'hb-chips', style: 'margin-bottom:12px' });
    for (let i = 0; i < 4; i++) {
      if (i > 0 && !pageAt(i).enabled) continue;
      const c = h('button', {
        class: 'hb-chip' + (i === selectedPage ? ' is-on' : ''), type: 'button',
        title: i === 0 ? 'The buttons you see with no modifier held'
                       : ('The buttons you see while holding ' + PAGE_NAMES[i]),
        text: pageAt(i).name || PAGE_NAMES[i],
      });
      c.addEventListener('click', () => { selectedPage = i; renderSlotList(); });
      tabs.appendChild(c);
    }
    box.appendChild(tabs);
    el['hb-page-name'].textContent = selectedPage === 0 ? '' : '· ' + PAGE_NAMES[selectedPage] + ' page';

    const n = visibleSlots();

    /* A page of nothing needs telling what to do about it, once, at the top —
       eight identical "Click to choose an action" rows say it eight times and
       none of them says WHERE the things come from. */
    let anyFilled = false;
    for (let i = 0; i < n; i++) if (!isEmptySlot(slotAt(selectedPage, i))) { anyFilled = true; break; }
    if (!anyFilled) {
      box.appendChild(h('p', { class: 'hb-emptyhint',
        text: selectedPage === 0
          ? 'Nothing on the bar yet. Click a button below and pick a spell, a shout, '
            + 'something from your bag, or any deck action.'
          : 'This page is empty — hold ' + PAGE_NAMES[selectedPage]
            + ' in game and the bar shows these buttons instead. The keys stay the same.' }));
    }
    const rows = (live && live.page === selectedPage && Array.isArray(live.slots)) ? live.slots : [];
    for (let i = 0; i < n; i++) {
      const s = slotAt(selectedPage, i);
      const L = rows[i] || {};
      const k = keyAt(i);
      const empty = isEmptySlot(s);
      const name = s.label || L.name || (empty ? 'Empty' : (s.refId || 'Unknown'));

      const thumb = h('div', { class: 'thumb', title: 'Change this icon' },
        empty ? h('span', { class: 'g', text: '+' })
              : artFor(Object.assign({}, L, { icon: s.icon }), name));
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (empty) { openPicker(i); return; }
        openIconPicker(i);
      });

      const what = h('div', { class: 'what' },
        h('div', { class: 'nm' + (empty ? ' is-blank' : ''), title: name, text: name }),
        h('div', { class: 'sub', text: empty ? 'Click to choose an action'
          : (kindLabel(s.kind) + (L.ok === false && L.msg ? ' · ' + L.msg : '')) }));
      what.addEventListener('click', () => openPicker(i));

      const keyBtn = h('button', {
        class: 'hb-keybtn' + (k.code ? '' : ' is-unbound'), type: 'button',
        title: 'Press to rebind the key for button ' + (i + 1),
        text: k.code ? (k.label || ('#' + k.code)) : 'No key',
      });
      keyBtn.addEventListener('click', () => openCapture(i));

      const row = h('div', { class: 'hb-slotrow' },
        h('div', { class: 'idx', text: String(i + 1) }), thumb, what, keyBtn);
      box.appendChild(row);
    }

    /* The vanilla-favourites collision, said out loud exactly where it bites.
       This plugin's input sink cannot consume events, so a number key that is
       ALSO a vanilla favourite hotkey fires both. Warning beats a silent
       double-cast. */
    const numeric = [];
    for (let i = 0; i < n; i++) {
      const c = keyAt(i).code;
      if (keyAt(i).device === 'keyboard' && c >= 0x02 && c <= 0x0B) numeric.push(i + 1);
    }
    el['hb-slot-note'].className = 'hb-note' + (numeric.length ? ' is-warn' : '');
    el['hb-slot-note'].textContent = numeric.length
      ? 'Buttons ' + numeric.join(', ') + ' use number keys, which Skyrim also uses for its own '
        + 'favourites. If you have a favourite on the same number, BOTH fire. Rebind to the numpad '
        + 'or F-keys if that bites.'
      : 'Pick a button, then choose what it does and which key fires it.';
  }

  function kindLabel(k) {
    return k === 'spell' ? 'Spell' : k === 'item' ? 'Item'
         : k === 'entry' ? 'Deck action' : k === 'combo' ? 'Combo' : '';
  }

  /* ── edit-panel control wiring ───────────────────────────────────────── */

  function onShapeChange() {
    cfg.cols = clamp(parseInt(el['hb-cols'].value, 10) || 1, 1, MAX_SLOTS);
    cfg.rows = clamp(parseInt(el['hb-rows'].value, 10) || 1, 1, 2);
    if (cfg.cols * cfg.rows > MAX_SLOTS) cfg.cols = Math.floor(MAX_SLOTS / cfg.rows);
    el['hb-cols'].value = cfg.cols;
    cfg.orient = el['hb-orient'].value === 'vert' ? 'vert' : 'horiz';
    saveCfg(); render(); renderEdit();
  }
  if (el['hb-cols'])   el['hb-cols'].addEventListener('change', onShapeChange);
  if (el['hb-rows'])   el['hb-rows'].addEventListener('change', onShapeChange);
  if (el['hb-orient']) el['hb-orient'].addEventListener('change', onShapeChange);

  if (el['hb-scale']) el['hb-scale'].addEventListener('input', () => {
    cfg.scale = clamp((parseInt(el['hb-scale'].value, 10) || 100) / 100, 0.4, 3);
    el['hb-scale-val'].textContent = Math.round(cfg.scale * 100) + '%';
    applyPlacement();
  });
  if (el['hb-scale']) el['hb-scale'].addEventListener('change', saveCfg);

  if (el['hb-idle']) el['hb-idle'].addEventListener('input', () => {
    cfg.idleMs = (parseInt(el['hb-idle'].value, 10) || 0) * 1000;
    el['hb-idle-val'].textContent = cfg.idleMs ? (Math.round(cfg.idleMs / 1000) + 's') : 'Never';
    applyIdle();
  });
  if (el['hb-idle']) el['hb-idle'].addEventListener('change', saveCfg);

  ['hb-anchorH', 'hb-anchorV'].forEach((id) => {
    if (!el[id]) return;
    el[id].addEventListener('change', () => {
      cfg.anchorH = el['hb-anchorH'].value;
      cfg.anchorV = el['hb-anchorV'].value;
      applyPlacement(); saveCfg();
    });
  });

  [['hb-showKeys', 'showKeys'], ['hb-showLabels', 'showLabels'],
   ['hb-showCounts', 'showCounts'], ['hb-showEmpty', 'showEmpty'],
   ['hb-modHold', 'modHold'], ['hb-hideInMenus', 'hideInMenus']].forEach(([id, key]) => {
    if (!el[id]) return;
    el[id].addEventListener('change', () => { cfg[key] = el[id].checked; saveCfg(); render(); });
  });

  if (el['hb-showMode']) el['hb-showMode'].addEventListener('change', () => {
    cfg.showMode = el['hb-showMode'].value;
    saveCfg();
    renderEdit();   // the linger row appears/disappears with the mode
  });
  if (el['hb-linger']) el['hb-linger'].addEventListener('input', () => {
    cfg.lingerMs = (parseInt(el['hb-linger'].value, 10) || 0) * 1000;
    el['hb-linger-val'].textContent = cfg.lingerMs
      ? (Math.round(cfg.lingerMs / 1000) + 's') : 'No delay';
  });
  if (el['hb-linger']) el['hb-linger'].addEventListener('change', saveCfg);

  if (el['hb-uiscale']) el['hb-uiscale'].addEventListener('input', () => {
    cfg.uiScale = (parseInt(el['hb-uiscale'].value, 10) || 100) / 100;
    const want = Math.round(cfg.uiScale * 100);
    const applied = Math.round(applyUiScale() * 100);
    el['hb-uiscale-val'].textContent = applied < want
      ? (want + '% (capped to ' + applied + '% by your window)') : (want + '%');
    applyPlacement();   // the bar's edit-mode offset depends on the panel width
  });
  if (el['hb-uiscale']) el['hb-uiscale'].addEventListener('change', saveCfg);

  if (el['hb-opacity']) el['hb-opacity'].addEventListener('input', () => {
    cfg.opacity = clamp((parseInt(el['hb-opacity'].value, 10) || 100) / 100, 0.3, 1);
    if (el['hb-opacity-val']) el['hb-opacity-val'].textContent = Math.round(cfg.opacity * 100) + '%';
    /* Preview it live even though edit mode renders full-opacity: paint the
       chosen value onto the bar directly so the slider shows what play will
       look like. Leaving edit mode's applyOpacity() restores the rule. */
    if (el['hb-root']) el['hb-root'].style.setProperty('--hb-opacity', String(cfg.opacity));
  });
  if (el['hb-opacity']) el['hb-opacity'].addEventListener('change', saveCfg);

  if (el['hb-reset-pos']) el['hb-reset-pos'].addEventListener('click', resetPosition);

  if (el['hb-togglekey']) el['hb-togglekey'].addEventListener('click', () => openCapture(-1));
  if (el['hb-togglekey-clear']) el['hb-togglekey-clear'].addEventListener('click', () => {
    cfg.key = { device: 'keyboard', code: 0, label: '' };
    saveCfg(); renderEdit();
  });

  if (el['hb-done']) el['hb-done'].addEventListener('click', () => {
    setEditing(false);
    saveCfg();
    toGame('hbEditDone');
  });

  /* ── the assign picker ───────────────────────────────────────────────── */

  const pick = { open: false, slot: 0, tab: 'all', q: '', cursor: 0, rows: [] };

  function openPicker(i) {
    pick.open = true; pick.slot = i; pick.q = ''; pick.cursor = 0;
    el['hb-pick-title'].textContent = 'Put something on button ' + (i + 1) +
      (selectedPage ? ' (' + PAGE_NAMES[selectedPage] + ' page)' : '');
    el['hb-pick'].hidden = false;
    el['hb-pick-q'].value = '';
    if (!CATALOG.loaded) toGame('hbCatalog');
    renderPickTabs();
    renderPickList();
    setTimeout(() => el['hb-pick-q'] && el['hb-pick-q'].focus(), 30);
  }
  function closePicker() { pick.open = false; el['hb-pick'].hidden = true; }

  const PICK_TABS = [
    { id: 'all',     label: 'Everything' },
    { id: 'spells',  label: 'Spells & shouts' },
    { id: 'items',   label: 'Items' },
    { id: 'entries', label: 'Deck actions' },
    { id: 'combos',  label: 'Combos' },
  ];
  function renderPickTabs() {
    clear(el['hb-pick-tabs']);
    PICK_TABS.forEach((t) => {
      const n = t.id === 'all' ? candidates('all').length : (CATALOG[t.id] || []).length;
      const c = h('button', {
        class: 'hb-chip' + (pick.tab === t.id ? ' is-on' : ''), type: 'button',
        title: t.id === 'all' ? 'Everything you can put on a button'
                              : ('Only ' + t.label.toLowerCase()),
        text: t.label + (n ? ' (' + n + ')' : ''),
      });
      c.addEventListener('click', () => { pick.tab = t.id; pick.cursor = 0; renderPickTabs(); renderPickList(); });
      el['hb-pick-tabs'].appendChild(c);
    });
  }

  function candidates(tab) {
    const tag = (arr, kind) => (arr || []).map((r) => Object.assign({ _kind: kind }, r));
    if (tab === 'spells')  return tag(CATALOG.spells, 'spell');
    if (tab === 'items')   return tag(CATALOG.items, 'item');
    if (tab === 'entries') return tag(CATALOG.entries, 'entry');
    if (tab === 'combos')  return tag(CATALOG.combos, 'combo');
    return [].concat(tag(CATALOG.spells, 'spell'), tag(CATALOG.items, 'item'),
                     tag(CATALOG.combos, 'combo'), tag(CATALOG.entries, 'entry'));
  }

  /* Filter-as-you-type. Substring, case-insensitive, and it also matches the
     detail line — so "destruction" finds every fire spell without you having
     to remember a name. Scored so an exact prefix hit outranks a mid-word one,
     because Enter takes the top row and it must be the obvious one. */
  function filterRows() {
    const q = pick.q.trim().toLowerCase();
    const all = candidates(pick.tab);
    if (!q) return all.slice(0, 400);
    const out = [];
    for (const r of all) {
      const n = String(r.name || '').toLowerCase();
      const d = String(r.detail || '').toLowerCase();
      let score = -1;
      if (n.startsWith(q)) score = 0;
      else if (n.indexOf(q) >= 0) score = 1;
      else if (d.indexOf(q) >= 0) score = 2;
      if (score >= 0) out.push({ r: r, s: score, n: n });
    }
    out.sort((a, b) => (a.s - b.s) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    return out.slice(0, 400).map((o) => o.r);
  }

  function markUp(text, q) {
    const t = String(text || '');
    if (!q) return document.createTextNode(t);
    const i = t.toLowerCase().indexOf(q);
    if (i < 0) return document.createTextNode(t);
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(t.slice(0, i)));
    frag.appendChild(h('mark', { text: t.slice(i, i + q.length) }));
    frag.appendChild(document.createTextNode(t.slice(i + q.length)));
    return frag;
  }

  /* Skeleton rows sized like the real ones, so nothing jumps when the catalog
     lands. Shown ONLY while it is genuinely in flight — an empty result after
     it has arrived is a different message and gets one. */
  function skeletonRows(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      frag.appendChild(h('div', { class: 'hb-skel-row' },
        h('div', { class: 'hb-skel hb-skel-ico' }),
        h('div', { class: 'hb-skel-txt' },
          h('div', { class: 'hb-skel hb-skel-l1' }),
          h('div', { class: 'hb-skel hb-skel-l2' }))));
    }
    return frag;
  }

  /* The bottom fade only earns its place when there IS more below. */
  function syncPickOverflow() {
    const wrap = el['hb-pick-wrap'];
    const box = el['hb-pick-list'];
    if (!wrap || !box) return;
    const more = box.scrollHeight - box.clientHeight - box.scrollTop > 8;
    wrap.classList.toggle('has-more', more);
  }

  function renderPickList() {
    const box = el['hb-pick-list'];
    clear(box);
    pick.rows = filterRows();

    if (!CATALOG.loaded) {
      box.appendChild(skeletonRows(6));
      syncPickOverflow();
      return;
    }
    if (!pick.rows.length) {
      box.appendChild(h('div', { class: 'hb-pick-empty',
        text: pick.q ? ('Nothing matches “' + pick.q + '”.')
                     : 'Nothing in this group — try Everything, or another tab.' }));
      syncPickOverflow();
      return;
    }
    pick.cursor = clamp(pick.cursor, 0, pick.rows.length - 1);
    const q = pick.q.trim().toLowerCase();
    pick.rows.forEach((r, i) => {
      const row = h('div', {
        class: 'hb-pick-row' + (i === pick.cursor ? ' is-cursor' : ''),
        role: 'option', title: r.name || '',
      });
      row.appendChild(h('div', { class: 'ico' }, artFor(r, r.name)));
      const txt = h('div', { class: 'txt' });
      const nm = h('div', { class: 'n' });
      nm.appendChild(markUp(r.name, q));
      txt.appendChild(nm);
      txt.appendChild(h('div', { class: 'd', text: (kindLabel(r._kind) + (r.detail ? ' · ' + r.detail : '')) }));
      row.appendChild(txt);
      row.addEventListener('click', () => assign(r));
      row.addEventListener('mouseenter', () => {
        pick.cursor = i;
        const cur = box.querySelector('.is-cursor');
        if (cur) cur.classList.remove('is-cursor');
        row.classList.add('is-cursor');
      });
      box.appendChild(row);
    });
    syncPickOverflow();
    /* Arrow-keying past the visible window has to bring the row WITH it, or
       the cursor walks off the bottom and Enter fires something unseen. */
    const cur = box.querySelector('.is-cursor');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function assign(r) {
    const s = r ? {
      kind: r._kind,
      plugin: r.plugin || '',
      localId: r.localId || 0,
      formId: r.formId || 0,
      refId: r.refId || r.id || '',
      label: '',
      icon: '',
    } : null;
    pageAt(selectedPage).slots[pick.slot] = s || {};
    toGame('hbAssign', JSON.stringify({ page: selectedPage, i: pick.slot, slot: s }));
    saveCfg();
    closePicker();
    renderSlotList();
    render();
  }

  if (el['hb-pick-q']) el['hb-pick-q'].addEventListener('input', () => {
    pick.q = el['hb-pick-q'].value; pick.cursor = 0; renderPickList();
  });
  if (el['hb-pick-q']) el['hb-pick-q'].addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { pick.cursor++; renderPickList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { pick.cursor--; renderPickList(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (pick.rows.length) assign(pick.rows[clamp(pick.cursor, 0, pick.rows.length - 1)]); e.preventDefault(); }
    else if (e.key === 'Escape') { closePicker(); e.preventDefault(); }
  });
  if (el['hb-pick-list']) el['hb-pick-list'].addEventListener('scroll', syncPickOverflow);
  if (el['hb-pick-close']) el['hb-pick-close'].addEventListener('click', closePicker);
  if (el['hb-pick-clear']) el['hb-pick-clear'].addEventListener('click', () => assign(null));

  /* ── icon picker ─────────────────────────────────────────────────────── */

  const iconPick = { open: false, slot: 0, q: '', shown: 300 };

  function openIconPicker(i) {
    iconPick.open = true; iconPick.slot = i; iconPick.q = ''; iconPick.shown = 300;
    el['hb-icons'].hidden = false;
    el['hb-icons-q'].value = '';
    renderIconGrid();
    setTimeout(() => el['hb-icons-q'] && el['hb-icons-q'].focus(), 30);
  }
  function closeIconPicker() { iconPick.open = false; el['hb-icons'].hidden = true; }

  function iconPool() {
    const custom = (ICONS.custom || []).map((c) => ({ file: c.file, label: c.label || c.file }));
    const atlas = (ICONS.catalog || []).map((c) => ({ file: c.file, label: c.label || c.key || '' }));
    return custom.concat(atlas);
  }
  function renderIconGrid() {
    const box = el['hb-icons-grid'];
    clear(box);
    const q = iconPick.q.trim().toLowerCase();
    const pool = iconPool().filter((c) => !q || String(c.label).toLowerCase().indexOf(q) >= 0
                                              || String(c.file).toLowerCase().indexOf(q) >= 0);
    if (!pool.length) {
      box.appendChild(h('div', { class: 'hb-pick-empty', text: 'No icons match that.' }));
      return;
    }
    /* Chunked: the pool runs to ~1,900 tiles and Ultralight will not thank us
       for all of them at once. Scrolling to the end grows it. */
    pool.slice(0, iconPick.shown).forEach((c) => {
      const t = h('div', { class: 'hb-icon-tile', title: c.label, tabindex: '0' },
        h('img', { src: c.file, alt: '', draggable: 'false' }));
      t.addEventListener('click', () => {
        pageAt(selectedPage).slots[iconPick.slot].icon = c.file;
        saveCfg(); closeIconPicker(); renderSlotList(); render();
      });
      box.appendChild(t);
    });
    if (pool.length > iconPick.shown) {
      box.appendChild(h('div', { class: 'hb-pick-empty',
        text: (pool.length - iconPick.shown) + ' more — keep scrolling' }));
    }
  }
  if (el['hb-icons-grid']) el['hb-icons-grid'].addEventListener('scroll', () => {
    const g = el['hb-icons-grid'];
    if (g.scrollTop + g.clientHeight > g.scrollHeight - 80) {
      const before = iconPick.shown;
      iconPick.shown += 300;
      if (before !== iconPick.shown) renderIconGrid();
    }
  });
  if (el['hb-icons-q']) el['hb-icons-q'].addEventListener('input', () => {
    iconPick.q = el['hb-icons-q'].value; iconPick.shown = 300; renderIconGrid();
  });
  if (el['hb-icons-close']) el['hb-icons-close'].addEventListener('click', closeIconPicker);
  if (el['hb-icons-auto']) el['hb-icons-auto'].addEventListener('click', () => {
    pageAt(selectedPage).slots[iconPick.slot].icon = '';
    saveCfg(); closeIconPicker(); renderSlotList(); render();
  });

  /* ── key capture ─────────────────────────────────────────────────────── */
  /* Browser keydown gives a VK/name, not a DIK scancode, and the sink matches
     DIK. `e.code` ("Digit1", "Numpad4", "F5") maps cleanly and is layout
     independent — which a keyCode would not be. Anything unmapped is refused
     out loud rather than stored as a key that will never match. */

  const DIK = (function () {
    const m = {
      Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
      Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
      Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
      KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
      KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
      BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C, ControlLeft: 0x1D,
      KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
      KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
      ShiftLeft: 0x2A, Backslash: 0x2B,
      KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
      Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
      NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3A,
      F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40,
      F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
      Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A,
      Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
      Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
      F11: 0x57, F12: 0x58,
      NumpadEnter: 0x9C, ControlRight: 0x9D, NumpadDivide: 0xB5, AltRight: 0xB8,
      Home: 0xC7, ArrowUp: 0xC8, PageUp: 0xC9, ArrowLeft: 0xCB, ArrowRight: 0xCD,
      End: 0xCF, ArrowDown: 0xD0, PageDown: 0xD1, Insert: 0xD2, Delete: 0xD3,
    };
    return m;
  })();
  function prettyKey(code) {
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
  }

  /* slot === -1 means the bar's own show/hide key. One modal for both, because
     they are the same interaction and a second copy would drift. */
  const cap = { open: false, slot: 0 };
  function openCapture(i) {
    cap.open = true; cap.slot = i;
    el['hb-cap-title'].textContent = i < 0
      ? 'Press a key to show / hide the bar'
      : ('Press a key for button ' + (i + 1));
    el['hb-cap-key'].textContent = 'Waiting for a key…';
    el['hb-cap-key'].className = 'hb-cap-key is-listening';
    el['hb-cap'].hidden = false;
  }
  function closeCapture() { cap.open = false; el['hb-cap'].hidden = true; }

  document.addEventListener('keydown', (e) => {
    if (!cap.open) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { closeCapture(); return; }
    const dik = DIK[e.code];
    if (!dik) {
      el['hb-cap-key'].textContent = 'That key can’t be used — try another';
      el['hb-cap-key'].className = 'hb-cap-key is-bad';
      return;
    }
    const k = cap.slot < 0 ? (cfg.key = cfg.key || {}) : keyAt(cap.slot);
    k.device = 'keyboard';
    k.code = dik;
    k.label = prettyKey(e.code);
    el['hb-cap-key'].textContent = k.label;
    el['hb-cap-key'].className = 'hb-cap-key is-got';
    saveCfg();
    setTimeout(() => { closeCapture(); renderEdit(); render(); }, 260);
  }, true);

  if (el['hb-cap-clear']) el['hb-cap-clear'].addEventListener('click', () => {
    const k = cap.slot < 0 ? (cfg.key = cfg.key || {}) : keyAt(cap.slot);
    k.code = 0; k.label = '';
    saveCfg(); closeCapture(); renderEdit(); render();
  });
  if (el['hb-cap-cancel']) el['hb-cap-cancel'].addEventListener('click', closeCapture);

  /* ── edit mode ───────────────────────────────────────────────────────── */

  function setEditing(on) {
    editing = !!on;
    interacting = false;   // no half-finished drag survives an edit-mode change
    placed = false;        // a fresh edit session: avoidance is allowed again
    document.body.classList.toggle('hb-edit', editing);
    el['hb-edit'].hidden = !editing;
    el['hb-grip'].hidden = !editing;
    if (!editing) {
      closePicker(); closeIconPicker(); closeCapture();
      el['hb-root'].classList.remove('grip-above', 'grip-below');
    } else {
      selectedPage = clamp(selectedPage, 0, 3); applyUiScale(); renderEdit();
    }
    render();
    /* Rescue a bar that drifted off screen so its grip is reachable. Runs after
       render() so the box is laid out; a no-op in jsdom (zero rect) and when the
       bar is already fully visible. */
    if (editing) clampIntoView();
  }

  /* ── C++ -> view ─────────────────────────────────────────────────────── */

  window.hbConfig = function (j) {
    const c = coerce(j);
    if (!c || typeof c !== 'object') return;
    Object.keys(cfg).forEach((k) => { if (c[k] !== undefined) cfg[k] = c[k]; });
    if (!Array.isArray(cfg.pages)) cfg.pages = [];
    if (!Array.isArray(cfg.slotKeys)) cfg.slotKeys = [];
    pageAt(3); keyAt(MAX_SLOTS - 1);          // normalise lengths once
    applyUiScale();
    if (editing) renderEdit();
    render();
    /* A config load that arrives while editing may carry a position that puts
       the bar (or its grip) off screen — pull it back so it stays reachable. */
    if (editing) clampIntoView();
  };

  window.hbLive = function (j) {
    const d = coerce(j);
    if (!d || typeof d !== 'object') return;
    live = { page: d.page || 0, slots: Array.isArray(d.slots) ? d.slots : [] };
    if (live.page !== livePage) livePage = live.page;
    render();
    if (editing && live.page === selectedPage) renderSlotList();
  };

  window.hbPage = function (j) {
    const d = coerce(j);
    const p = d && typeof d === 'object' ? (d.page | 0) : (parseInt(j, 10) || 0);
    if (p === livePage) return;
    livePage = clamp(p, 0, 3);
    render();
    /* A held modifier changes every icon at once; without a beat of motion it
       reads as a flicker rather than a swap. 110ms — never laggy under the
       fingers. Re-triggered by removing and re-adding on the next frame. */
    const g = el['hb-grid'];
    if (g) {
      g.classList.remove('is-swapping');
      void g.offsetWidth;
      g.classList.add('is-swapping');
      setTimeout(() => g.classList.remove('is-swapping'), 140);
    }
  };

  window.hbEdit = function (v) { setEditing(String(v) === '1'); };

  window.hbFlash = function (j) {
    const d = coerce(j);
    const i = d && typeof d === 'object' ? (d.i | 0) : (parseInt(j, 10) || 0);
    const page = d && typeof d === 'object' && d.page !== undefined ? (d.page | 0) : livePage;
    flash(page, i);
  };

  window.hbCatalogData = function (j) {
    const d = coerce(j);
    if (!d || typeof d !== 'object') return;
    CATALOG.loaded  = true;
    CATALOG.spells  = Array.isArray(d.spells) ? d.spells : [];
    CATALOG.items   = Array.isArray(d.items) ? d.items : [];
    CATALOG.entries = Array.isArray(d.entries) ? d.entries : [];
    CATALOG.combos  = Array.isArray(d.combos) ? d.combos : [];
    if (pick.open) { renderPickTabs(); renderPickList(); }
  };

  window.hbIconIndex = function (j) {
    const idx = coerce(j);
    if (!idx || typeof idx !== 'object') { ICONS.byForm = null; ICONS.generic = null; ICONS.catalog = []; render(); return; }
    const byForm = {}, generic = {};
    const bf = idx.byForm || {};
    for (const k in bf) byForm[String(k).toLowerCase()] = normPath(bf[k]);
    const gn = idx.generic || {};
    for (const k in gn) generic[k] = normPath(gn[k]);
    ICONS.byForm = byForm;
    ICONS.generic = generic;
    ICONS.catalog = (Array.isArray(idx.catalog) ? idx.catalog : [])
      .map((c) => ({ file: normPath(c.file), label: c.label || '', key: c.key || '' }))
      .filter((c) => c.file);
    render();
    if (iconPick.open) renderIconGrid();
  };

  window.hbIcons = function (j) {
    const r = coerce(j);
    ICONS.custom = (((r && r.custom) || [])).map((c) => ({ file: normPath(c.file), label: c.label || '' }))
      .filter((c) => c.file);
    if (iconPick.open) renderIconGrid();
  };

  /* ── boot ────────────────────────────────────────────────────────────── */

  pageAt(3); keyAt(MAX_SLOTS - 1);
  render();
  toGame('hbReady');
  log('hotbar view ready');

  /* Exposed for the harness only — never called by the plugin. */
  window.__hb = {
    cfg, ICONS, CATALOG,
    get live() { return live; },
    get livePage() { return livePage; },
    get editing() { return editing; },
    get interacting() { return interacting; },
    set interacting(v) { interacting = v; },
    get placed() { return placed; },
    set placed(v) { placed = v; },
    get selectedPage() { return selectedPage; },
    set selectedPage(v) { selectedPage = v; },
    get pick() { return pick; },
    pageAt, keyAt, slotAt, visibleSlots, isEmptySlot,
    resolveIconPath, shKeyFor, genericKeyFor, filterRows, prettyKey, DIK,
    setEditing, render, renderEdit, renderSlotList, applyUiScale,
    openPicker, closePicker, assign, openIconPicker, openCapture,
    flash, applyPlacement, applyOpacity, clampIntoView, resetPosition,
  };
})();
