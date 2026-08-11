'use strict';

/* ====================================================================== *
 *  HDScale — "UI size" and "image size", per TAB, for the tabs that had
 *  neither.
 *
 *  The deck already had three unrelated answers to "make this bigger":
 *  the deck-wide Menu scale (--ui-scale, app.js), the Followers tab's
 *  --fd-ui-scale + avatar px, the Wardrobe's --wd-ui-scale and the
 *  Domains tab's --dm-ui-scale. Each is hand-rolled, each persists into a
 *  different config slice, and every new tab arrived with none. This is
 *  the fourth-and-last implementation: ONE registry every remaining tab
 *  reads from, so a tab added tomorrow gets its controls by adding a line
 *  to SPEC rather than by re-deriving clamp/persist/apply from scratch.
 *
 *  The three tabs that already shipped their own are deliberately NOT
 *  migrated — their controls work, they are play-tested, and rewriting
 *  working persistence to satisfy a symmetry is how a config slice loses
 *  a field.
 *
 *  ---- the contract ------------------------------------------------------
 *  STATE     settings.tabScales = { "<tab>": { ui: <number>, img: <number> } }
 *            ONE map, in the deck's own `settings` slice. Not per-pane
 *            slices: every slice here is round-tripped WHOLE by C++, so a
 *            save that forgets a field silently resets it, and five new
 *            fields across five serializers is five chances to do that.
 *            One free-form map is one round-trip and one clamp — and a
 *            tab added later needs no C++ change at all.
 *
 *  ZERO      0 (or absent) means UNSET, not "zero pixels". Unset REMOVES
 *            the custom property, so the value falls back to the one the
 *            stylesheet already declares. The default therefore lives in
 *            exactly one place — the CSS — and this file never has to
 *            agree with it.
 *
 *  APPLY     --hdts-<tab>  whole-tab scale, unitless (transform: scale)
 *            --hdti-<tab>  image size, px
 *            Set on :root. The stylesheet does all the layout maths; no
 *            geometry is ever computed here.
 *
 *  CLAMP     Both here AND in C++ (main.cpp, TabScalesFromJson). hotkeys.json
 *            is hand-editable and a pasted 40 would otherwise paint a tab
 *            forty times the panel and leave no way back to the controls.
 *
 *  ---- why the controls are re-render-proof -------------------------------
 *  Panes rebuild their DOM constantly (Finances re-renders on every
 *  keystroke). So there is NO per-element wiring: one delegated click
 *  listener on document handles every [data-hds-act] that will ever exist,
 *  and syncing finds its targets by query. A pane can therefore drop the
 *  markup in with innerHTML, at any time, and it is live — including a copy
 *  that did not exist when this file loaded.
 *
 *  ⛔ No <input type=range>: Ultralight renders one but it is miserable to
 *  hit with a controller-ish mouse, and the deck settled on −/readout/＋
 *  everywhere else. No window.prompt/confirm — PrismaUI has neither.
 * ====================================================================== */

window.HDScale = (function () {

  /* Same range and step as the deck's Menu scale and the three hand-rolled
     tabs — 60%..160% in tens. A fourth range would just be a way for two
     tabs to disagree about what 100% means. */
  const UI = { min: 0.6, max: 1.6, step: 0.1, def: 1 };

  /* One line per tab. `img` is present ONLY where the tab actually draws
     images — a Notes tab with an "image size" control that moves nothing is
     worse than no control. Its `def` is documentation of the stylesheet's
     value, used for the readout when unset; the CSS keeps the real default. */
  const SPEC = {
    /* app.js-owned tabs (the shared edit card) */
    quests:   { ui: true, label: 'Quests' },
    notes:    { ui: true, label: 'Notes' },
    numpad:   { ui: true, label: 'Numpad' },
    recent:   { ui: true, label: 'Recent' },
    time:     { ui: true, label: 'Time' },
    loot:     { ui: true, label: 'Loot' },
    /* panes that own their own edit chrome */
    rooms:    { ui: true, label: 'Rooms' },
    finances: { ui: true, label: 'Finances',
                img: { min: 20, max: 72, step: 3, def: 35, label: 'Icon size',
                       hint: 'The round medal on every row' } },
    wardrobe: { img: { min: 110, max: 320, step: 10, def: 178, label: 'Tile size',
                       hint: 'How wide an outfit card is — the art grows with it' },
                label: 'Wardrobe' },
    /* the hotkey list itself: its scale is the deck-wide Menu scale, but its
       per-row icons never had a size of their own */
    deck:     { img: { min: 20, max: 72, step: 2, def: 30, label: 'Icon size',
                       hint: 'The little picture on each hotkey row' },
                label: 'Hotkeys' },
    /* Sharmat is a popout, not a tab — but it is the one deck surface the
       Followers tab's scale deliberately does not reach (it lives outside
       #fd-scale), so it needs its own or it is stuck at 100% forever. */
    sharmat:  { ui: true, label: 'Sharmat profile' },
  };

  /* The host supplies the settings object and the save. Unbound (a pane
     harness that loads no app.js) we keep our own, so every control and
     every clamp is testable without the deck. */
  let host = null;
  const orphan = { tabScales: {} };

  function settings() {
    if (host && typeof host.store === 'function') {
      const s = host.store();
      if (s && typeof s === 'object') return s;
    }
    return orphan;
  }

  function slice() {
    const s = settings();
    if (!s.tabScales || typeof s.tabScales !== 'object' || Array.isArray(s.tabScales)) s.tabScales = {};
    return s.tabScales;
  }

  function rec(tab, make) {
    const m = slice();
    if (!m[tab] || typeof m[tab] !== 'object') {
      if (!make) return {};
      /* BOTH fields, always, even the one this tab has no control for. C++
         replaces this slice wholesale on every save, so a record that omits
         `img` is a record that RESETS the image size the next time the deck
         opens — the exact shape of bug that has already cost this project a
         setting twice. Writing 0 costs nothing: 0 IS "unset". */
      m[tab] = { ui: 0, img: 0 };
    }
    const r = m[tab];
    if (typeof r.ui !== 'number') r.ui = 0;
    if (typeof r.img !== 'number') r.img = 0;
    return r;
  }

  function save() {
    if (host && typeof host.save === 'function') { try { host.save(); } catch (e) {} }
  }

  /* ------------------------------------------------------------ clamp -- */

  /* 0 out means UNSET. Anything unparseable is unset too — a corrupted
     hand-edit should hand the tab back at its default, never wedge it. */
  function clampUi(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return 0;
    v = Math.round(v * 10) / 10;          // snap, so ± cannot drift to 0.7999999
    return Math.max(UI.min, Math.min(UI.max, v));
  }

  function clampImg(tab, v) {
    const s = SPEC[tab] && SPEC[tab].img;
    if (!s) return 0;
    v = Math.round(Number(v));
    if (!isFinite(v) || v <= 0) return 0;
    return Math.max(s.min, Math.min(s.max, v));
  }

  function has(tab) { return !!SPEC[tab]; }
  function hasUi(tab) { return !!(SPEC[tab] && SPEC[tab].ui); }
  function hasImg(tab) { return !!(SPEC[tab] && SPEC[tab].img); }

  /* stored value, clamped (0 = unset) */
  function rawUi(tab)  { return clampUi(rec(tab).ui); }
  function rawImg(tab) { return clampImg(tab, rec(tab).img); }

  /* what is actually painted — the stored value, or the default */
  function effUi(tab)  { return rawUi(tab) || UI.def; }
  function effImg(tab) { return rawImg(tab) || (SPEC[tab] && SPEC[tab].img ? SPEC[tab].img.def : 0); }

  /* ------------------------------------------------------------ apply -- */

  function apply(tab) {
    const sp = SPEC[tab];
    if (!sp) return;
    const root = document.documentElement.style;
    if (sp.ui) {
      const v = rawUi(tab);
      /* removeProperty, not "set it to 1": unset must fall through to the
         stylesheet so the default has exactly one home. */
      if (v) root.setProperty('--hdts-' + tab, String(v));
      else root.removeProperty('--hdts-' + tab);
    }
    if (sp.img) {
      const v = rawImg(tab);
      if (v) root.setProperty('--hdti-' + tab, v + 'px');
      else root.removeProperty('--hdti-' + tab);
    }
    sync(tab);
  }

  function applyAll() { Object.keys(SPEC).forEach(apply); }

  /* ------------------------------------------------------------- set --- */

  /* delta 0 = reset to unset (back to the stylesheet's default). Stepping
     starts from the EFFECTIVE value, so the first press off the default
     moves by one step instead of jumping from 0. */
  function nudge(tab, kind, delta) {
    if (!SPEC[tab]) return;
    const r = rec(tab, true);
    if (kind === 'ui') {
      if (!SPEC[tab].ui) return;
      r.ui = delta === 0 ? 0 : clampUi(effUi(tab) + delta);
    } else {
      const s = SPEC[tab].img;
      if (!s) return;
      r.img = delta === 0 ? 0 : clampImg(tab, effImg(tab) + delta);
    }
    apply(tab);
    save();
    if (host && typeof host.changed === 'function') { try { host.changed(tab, kind); } catch (e) {} }
  }

  function set(tab, kind, value) {
    if (!SPEC[tab]) return;
    const r = rec(tab, true);
    if (kind === 'ui') r.ui = clampUi(value);
    else r.img = clampImg(tab, value);
    apply(tab);
    save();
  }

  /* --------------------------------------------------------- controls -- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function row(tab, kind, label, hint) {
    return '<div class="hds-row" data-hds="' + esc(tab) + '" data-hds-kind="' + kind + '">' +
      '<span class="hds-label" title="' + esc(hint || '') + '">' + esc(label) + '</span>' +
      '<span class="hds-ctl">' +
        '<button type="button" class="hds-btn" data-hds-act="' + kind + '-dec" ' +
          'title="Smaller — fits more on screen" aria-label="Smaller">&minus;</button>' +
        '<span class="hds-val" data-hds-out="' + kind + '">&hellip;</span>' +
        '<button type="button" class="hds-btn" data-hds-act="' + kind + '-inc" ' +
          'title="Bigger" aria-label="Bigger">&#65291;</button>' +
        '<button type="button" class="hds-btn hds-rst" data-hds-act="' + kind + '-rst" ' +
          'title="Back to the default">reset</button>' +
      '</span></div>';
  }

  /* HTML for a tab's controls. `only` narrows it to one kind, for the two
     places that want the image row somewhere other than beside the UI row
     (the deck's settings card, the Wardrobe's edit strip). */
  function controlsHtml(tab, only) {
    const sp = SPEC[tab];
    if (!sp) return '';
    let h = '';
    if (sp.ui && only !== 'img') h += row(tab, 'ui', 'UI size', 'Scales this whole tab, 60%–160%');
    if (sp.img && only !== 'ui') h += row(tab, 'img', sp.img.label || 'Image size', sp.img.hint);
    return h;
  }

  /* Drop the controls into a host element. No wiring — the document-level
     listener below already covers anything with data-hds-act, including
     markup that is replaced out from under it a moment later. */
  function mount(el, tab, only) {
    if (!el) return;
    el.innerHTML = controlsHtml(tab, only);
    /* Sync against `el`, not the document: Sharmat builds its header detached
       and attaches it afterwards, and a document query would find nothing and
       leave the readout showing the placeholder for the panel's whole life. */
    sync(tab, el);
  }

  /* ------------------------------------------------------------- sync -- */

  function sync(tab, root) {
    const sp = SPEC[tab];
    if (!sp || typeof document === 'undefined') return;
    const scope = root || document;
    const rows = scope.querySelectorAll('.hds-row[data-hds="' + tab + '"]');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const kind = r.getAttribute('data-hds-kind');
      const out = r.querySelector('[data-hds-out]');
      const stored = kind === 'ui' ? rawUi(tab) : rawImg(tab);
      const eff    = kind === 'ui' ? effUi(tab) : effImg(tab);
      if (out) {
        /* Unset says so, in the readout — otherwise "100%" and "default" are
           indistinguishable and reset looks broken. */
        out.textContent = kind === 'ui'
          ? (Math.round(eff * 100) + '%' + (stored ? '' : ' (auto)'))
          : (eff + (stored ? '' : ' (auto)'));
      }
      const lim = kind === 'ui' ? UI : sp.img;
      const off = (act, on) => {
        const b = r.querySelector('[data-hds-act="' + act + '"]');
        if (!b) return;
        b.disabled = !!on;
        b.classList.toggle('is-off', !!on);
      };
      /* At the end of the range a button is spent — say so, rather than
         leaving it looking live and doing nothing. */
      off(kind + '-dec', eff <= lim.min + 1e-9);
      off(kind + '-inc', eff >= lim.max - 1e-9);
      off(kind + '-rst', !stored);
    }
  }

  function syncAll() { Object.keys(SPEC).forEach(sync); }

  /* ---------------------------------------------------------- listener -- */

  let wired = false;
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('click', function (ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-hds-act]') : null;
      if (!btn || btn.disabled) return;
      const holder = btn.closest('[data-hds]');
      if (!holder) return;
      const tab = holder.getAttribute('data-hds');
      const act = btn.getAttribute('data-hds-act') || '';
      const kind = act.slice(0, act.indexOf('-'));
      const op = act.slice(act.indexOf('-') + 1);
      if (!SPEC[tab] || (kind !== 'ui' && kind !== 'img')) return;
      /* stopPropagation: several panes hang "click anywhere closes the menu"
         handlers off their own container, and pressing ＋ five times must not
         be five dismissals. */
      ev.preventDefault();
      ev.stopPropagation();
      const step = kind === 'ui' ? UI.step : SPEC[tab].img.step;
      if (op === 'rst') nudge(tab, kind, 0);
      else nudge(tab, kind, op === 'dec' ? -step : +step);
    }, true);
  }

  wire();

  function bind(h) {
    host = h || null;
    applyAll();
  }

  /* Adopt whatever C++ sent. Unknown tabs are kept in the map untouched
     (a newer deck's tab must survive a round-trip through an older view),
     known ones are clamped on the way in. */
  function load(tabScales) {
    const m = slice();
    if (tabScales && typeof tabScales === 'object' && !Array.isArray(tabScales)) {
      Object.keys(tabScales).forEach((k) => {
        const v = tabScales[k];
        if (!v || typeof v !== 'object') return;
        m[k] = { ui: Number(v.ui) || 0, img: Number(v.img) || 0 };
      });
    }
    applyAll();
  }

  return {
    bind, load, apply, applyAll, sync, syncAll,
    nudge, set, controlsHtml, mount,
    has, hasUi, hasImg, rawUi, rawImg, effUi, effImg,
    clampUi, clampImg,
    UI, SPEC,
    /* the persisted shape, for a harness that wants to assert the payload */
    dump: function () { return JSON.parse(JSON.stringify(slice())); },
    reset: function () { const s = settings(); s.tabScales = {}; applyAll(); },
  };
})();
