'use strict';

/* ====================================================================== *
 *  Formation modal — Formation with Followers (Nexus 66759) in the deck.
 *
 *  Rober's ask (2026-08-06): the mod's whole MCM, captured as a deck
 *  surface — a button in the F7 NPC quick card's order/move controls that
 *  opens a CENTERED popup modal with the formation settings. The mod
 *  itself is a confirmed save-poisoner in its original form (repeating
 *  update + Busy-wedge ratchet → infinite-load saves — the author pulled
 *  it from Nexus over exactly this), so the modal also carries the honest
 *  version banner (fixed fork vs. original scripts) and a RESCUE button
 *  that stands the whole system down so the next save is clean.
 *
 *  Shape: a sibling of the icon picker (#hk-icon-modal) — an absolute
 *  inset-0 backdrop INSIDE #panel (so it inherits --ui-scale and clips to
 *  the window), flex-centered box, z-index 74 (above the icon picker at
 *  72, below toast at 80). Own sheet hd-formation.css, linked from
 *  index.html — NEVER merged into app.css (the sync_view_frags truncation
 *  trap is why every new surface ships its own <link>).
 *
 *  Bridge (one name per direction): fmGet→fmOpen · fmApply→fmResult ·
 *  fmReg→fmResult · fmRescue→fmResult; every mutation is followed by a
 *  fresh fmOpen push from C++ ~700ms later, so the controls always end on
 *  the ENGINE's truth — a failed Papyrus hop shows up as the control
 *  springing back, never as a silent lie.
 *
 *  Ultralight rules honoured: no prompt/confirm (armed two-click rescue),
 *  no native range drag (window.hdSmoothRange wraps every slider), no
 *  native tooltips (title= is drawn by app.js's #hd-tip layer).
 * ====================================================================== */

(function () {
  const S = {
    open: false,
    subj: null,        // {formId,name} — whoOf() shape from the quick card
    who: '',           // display name for headings
    data: null,        // last fmOpen payload
    mode: 'follow',    // follow | sneak | combat — which offset set the pad edits
    loading: false,
    rescueArmed: 0,    // timestamp of the first click, two-click confirm
    capturing: false,  // cast-key rebind: waiting for the next keypress
  };

  let el = null;          // the backdrop node
  let applyTimer = 0;     // debounce for slider commits

  /* Cast-key rebind maps. app.js owns the canonical DIK tables and exposes
     window.hdKeyScan / hdKeyLabel; we PREFER those. This compact fallback only
     covers the common keys so the rebind still works when this file is
     deployed ahead of an app.js that predates those globals (the matched-set
     staging ships just this module + the DLL, not the shared app.js). */
  const DIK_FALLBACK = {
    KeyA: 0x1E, KeyB: 0x30, KeyC: 0x2E, KeyD: 0x20, KeyE: 0x12, KeyF: 0x21,
    KeyG: 0x22, KeyH: 0x23, KeyI: 0x17, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
    KeyM: 0x32, KeyN: 0x31, KeyO: 0x18, KeyP: 0x19, KeyQ: 0x10, KeyR: 0x13,
    KeyS: 0x1F, KeyT: 0x14, KeyU: 0x16, KeyV: 0x2F, KeyW: 0x11, KeyX: 0x2D,
    KeyY: 0x15, KeyZ: 0x2C,
    Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
    Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
    F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41,
    F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,
    Space: 0x39, Enter: 0x1C, Backquote: 0x29, Minus: 0x0C, Equal: 0x0D,
    BracketLeft: 0x1A, BracketRight: 0x1B, Semicolon: 0x27, Quote: 0x28,
    Comma: 0x33, Period: 0x34, Slash: 0x35, Backslash: 0x2B,
  };
  const LABEL_FALLBACK = (() => {
    const m = {};
    for (const c in DIK_FALLBACK) {
      m[DIK_FALLBACK[c]] = c.replace(/^Key|^Digit/, '');
    }
    m[-1] = 'None';
    return m;
  })();
  const keyScan = (evCode) =>
    (window.hdKeyScan ? window.hdKeyScan(evCode) : (DIK_FALLBACK[evCode] != null ? DIK_FALLBACK[evCode] : null));
  const keyLabel = (code) =>
    (window.hdKeyLabel ? window.hdKeyLabel(code)
                       : (LABEL_FALLBACK[code] || (code === -1 ? 'None' : 'code ' + code)));

  function toGameSafe(fn, arg) {
    if (typeof window.toGame === 'function') window.toGame(fn, arg);
  }
  function say(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
  }

  /* --------------------------------------------------------------- dom -- */

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    }
    for (const kid of kids) {
      if (kid == null) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function ensureDom() {
    if (el && el.isConnected) return el;
    const panel = document.getElementById('panel') || document.body;
    el = h('div', { id: 'fm-modal', class: 'hidden' });
    /* Backdrop click closes; clicks inside the box stay inside. */
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.target === el) close();
    });
    panel.appendChild(el);
    return el;
  }

  /* ------------------------------------------------------------ bridge -- */

  function subjPayload() {
    const p = {};
    if (S.subj && S.subj.formId) p.formId = String(S.subj.formId);
    return p;
  }

  function request() {
    S.loading = true;
    toGameSafe('fmGet', JSON.stringify(subjPayload()));
  }

  /* One debounced fmApply carrying only what changed. Slider drags update
     the readout live and commit once the hand settles. */
  function apply(diff) {
    const req = Object.assign(subjPayload(), diff);
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      toGameSafe('fmApply', JSON.stringify(req));
    }, 250);
  }

  window.fmOpen = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    S.data = d;
    S.loading = false;
    if (S.open) render();
  };

  window.fmResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    if (d.msg) say(d.msg);
  };

  /* ---------------------------------------------------------- controls -- */

  function slider(label, title, min, max, step, value, unit, commit) {
    const val = h('span', { class: 'fm-val' }, fmtVal(value, unit));
    const input = h('input', {
      type: 'range', class: 'fm-range', min: String(min), max: String(max),
      step: String(step), value: String(value), title: title,
    });
    input.addEventListener('input', () => {
      val.textContent = fmtVal(parseFloat(input.value), unit);
      commit(parseFloat(input.value));   // debounced upstream
    });
    if (typeof window.hdSmoothRange === 'function') window.hdSmoothRange(input);
    return h('label', { class: 'fm-row', title: title },
      h('span', { class: 'fm-lbl' }, label), input, val);
  }

  function fmtVal(v, unit) {
    const n = Math.round(v * 10) / 10;
    return String(n) + (unit || '');
  }

  function toggle(label, title, on, commit) {
    return h('button', {
      class: 'fm-toggle' + (on ? ' on' : ''), type: 'button', title: title,
      'aria-pressed': String(!!on),
      onClick: () => commit(!on),
    }, h('span', { class: 'fm-knob' }), h('span', { class: 'fm-toggle-lbl' }, label));
  }

  /* The 3×3 direction pad: 8 directions + center = walk beside/clear.
     A cell writes the CURRENT mode's offsets as ±(spacing X, spacing Y),
     exactly what the mod's own quick menu writes; the active cell is the
     one whose signs match what is set now. */
  const PAD = [
    { dx: -1, dy: 1, g: '↖', name: 'Front left' },
    { dx: 0, dy: 1, g: '↑', name: 'In front' },
    { dx: 1, dy: 1, g: '↗', name: 'Front right' },
    { dx: -1, dy: 0, g: '←', name: 'Left flank' },
    { dx: 0, dy: 0, g: '·', name: 'No offset (clear)' },
    { dx: 1, dy: 0, g: '→', name: 'Right flank' },
    { dx: -1, dy: -1, g: '↙', name: 'Back left' },
    { dx: 0, dy: -1, g: '↓', name: 'Behind' },
    { dx: 1, dy: -1, g: '↘', name: 'Back right' },
  ];

  function sgn(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

  function pad(sub, g) {
    const x = num(sub[S.mode + 'X']), y = num(sub[S.mode + 'Y']);
    const grid = h('div', { class: 'fm-pad', role: 'group' });
    for (const c of PAD) {
      const active = sgn(x) === c.dx && sgn(y) === c.dy;
      grid.append(h('button', {
        class: 'fm-pad-cell' + (active ? ' active' : ''), type: 'button',
        title: c.name + (c.dx || c.dy
          ? ' — offsets ±spacing (' + (c.dx * num(g.defaultX)) + ', ' + (c.dy * num(g.defaultY)) + ')'
          : ' — she walks free, no formation slot'),
        onClick: () => {
          const o = {};
          o[S.mode + 'X'] = c.dx * num(g.defaultX);
          o[S.mode + 'Y'] = c.dy * num(g.defaultY);
          apply({ offsets: o });
          /* optimistic: show the pick immediately, the fmOpen re-push
             confirms (or springs it back) */
          S.data.subject[S.mode + 'X'] = o[S.mode + 'X'];
          S.data.subject[S.mode + 'Y'] = o[S.mode + 'Y'];
          render();
        },
      }, c.g));
    }
    return grid;
  }

  function num(v) { return typeof v === 'number' ? v : parseFloat(v) || 0; }

  /* ------------------------------------------------------------ render -- */

  function render() {
    const root = ensureDom();
    root.textContent = '';
    const box = h('div', { class: 'fm-box', role: 'dialog', 'aria-label': 'Formation settings' });
    root.appendChild(box);

    const d = S.data;
    box.append(h('div', { class: 'fm-head' },
      h('span', { class: 'fm-title' }, '⛬ Formation'),
      S.who ? h('span', { class: 'fm-who' }, S.who) : null,
      h('button', {
        class: 'fm-close', type: 'button', title: 'Close (Esc)',
        onClick: () => close(),
      }, '✕')));

    const body = h('div', { class: 'fm-body' });
    box.append(body);

    if (S.loading && !d) {
      body.append(h('div', { class: 'fm-empty' },
        h('div', { class: 'fm-empty-ic' }, '⛬'),
        h('div', { class: 'fm-empty-t' }, 'Asking the game…')));
      return;
    }

    if (!d || !d.present || d.bound === false) {
      /* Honest absence, with the way forward. Three flavours. */
      const why = !d || !d.installed
        ? 'Formation with Followers isn’t in the load order. The FIXED fork is '
          + 'staged in MO2 as “Formation with Followers - Fixed” — tick it '
          + '(and its plugin) and relaunch.'
        : (!d.present
          ? 'The plugin is installed but not enabled — tick '
            + 'FormationWithFollowers.esp in MO2’s right pane and relaunch.'
          : 'The mod is loaded but has never initialized — it starts itself '
            + 'on a new game. Open its MCM once (Mod enabled) and come back.');
      body.append(h('div', { class: 'fm-empty' },
        h('div', { class: 'fm-empty-ic' }, '⛬'),
        h('div', { class: 'fm-empty-t' }, 'Formation isn’t available'),
        h('div', { class: 'fm-empty-d' }, why)));
      return;
    }

    /* -- formation is OFF: the loudest thing in the modal, because with it
       off nothing below does anything (Rober had it disabled and the dead
       sliders gave no hint why). Two depths: the whole MOD switched off
       (quest stopped) vs. formation released (the master switch). One click
       turns it on — C++ restarts the mod if that is what "off" means. -- */
    const gg = d.global || {};
    const modOff = d.running === false;
    const released = gg.enabled === false;
    if (modOff || released) {
      body.append(h('div', { class: 'fm-warn fm-off' },
        h('div', { class: 'fm-off-text' },
          modOff
            ? '⚠ The Formation mod is switched OFF entirely — none of these '
              + 'settings run until you turn it back on.'
            : '⚠ Formation is turned OFF — your followers walk normally and '
              + 'nothing below takes effect until you turn it on.'),
        h('button', {
          class: 'fm-btn primary fm-off-btn', type: 'button',
          title: modOff ? 'Start the Formation mod and form everyone up'
                        : 'Re-form your followers',
          onClick: () => {
            apply({ global: { enabled: true } });
            gg.enabled = true; d.running = true; render();
          },
        }, modOff ? '✦ Turn the mod on' : '✦ Turn formation on')));
    }

    /* -- the save-safety banner: which scripts are actually running -- */
    if (d.fixed === false) {
      body.append(h('div', { class: 'fm-warn', title:
        'The original v1.2 scripts run a repeating update per follower and '
        + 'wedge permanently on errors — hours of play poisons every save '
        + 'since the mod was activated (infinite loading screens; the author '
        + 'pulled the mod over it). The fixed fork is staged in MO2.' },
        '⚠ ORIGINAL scripts detected — this version corrupts saves over time. '
        + 'Switch to “Formation with Followers - Fixed” in MO2. Rescue below '
        + 'stands it down safely.'));
    }

    const g = d.global || {};

    /* ---- her place (the F7 subject) ---- */
    const sub = d.subject;
    const her = h('div', { class: 'fm-sec' });
    body.append(her);
    if (sub && sub.registered) {
      her.append(h('div', { class: 'fm-sec-t' },
        h('span', {}, sub.name || S.who || 'Her place'),
        h('span', { class: 'fm-chip on' }, 'in formation'),
        toggle('Forms up', (sub.name || 'She')
          + ' keeps her slot — off = registered but walking free',
          sub.enabled !== false,
          (v) => { apply({ offsets: { enabled: v } });
            sub.enabled = v; render(); })));

      /* mode chips: which of her three offset sets the pad below edits */
      const modes = [['follow', 'Walking'], ['sneak', 'Sneaking'], ['combat', 'Combat']];
      her.append(h('div', { class: 'fm-modes' }, ...modes.map(([m, label]) =>
        h('button', {
          class: 'fm-mode' + (S.mode === m ? ' active' : ''), type: 'button',
          title: 'Edit her ' + label.toLowerCase() + ' position',
          onClick: () => { S.mode = m; render(); },
        }, label))));

      her.append(h('div', { class: 'fm-pad-wrap' },
        pad(sub, g),
        h('div', { class: 'fm-fine' },
          slider('Side', 'Fine-tune: − left · + right of you', -1024, 1024, 8,
            num(sub[S.mode + 'X']), '',
            (v) => { const o = {}; o[S.mode + 'X'] = v; apply({ offsets: o }); sub[S.mode + 'X'] = v; }),
          slider('Ahead', 'Fine-tune: − behind · + ahead of you', -1024, 1024, 8,
            num(sub[S.mode + 'Y']), '',
            (v) => { const o = {}; o[S.mode + 'Y'] = v; apply({ offsets: o }); sub[S.mode + 'Y'] = v; }))));

      her.append(h('button', {
        class: 'fm-btn danger', type: 'button',
        title: 'Take ' + (sub.name || 'her') + ' out of the formation',
        onClick: () => toGameSafe('fmReg', JSON.stringify(
          Object.assign(subjPayload(), { op: 'unregister' }))),
      }, '⊘ Leave the formation'));
    } else if (sub) {
      her.append(h('div', { class: 'fm-sec-t' },
        h('span', {}, sub.name || S.who || 'Her place'),
        h('span', { class: 'fm-chip' }, 'not registered')));
      const can = sub.teammate !== false;
      her.append(h('button', {
        class: 'fm-btn primary', type: 'button', disabled: can ? null : '',
        title: can ? 'Give ' + (sub.name || 'her') + ' a formation slot'
                   : (sub.name || 'She') + ' isn’t following you — the mod only forms up teammates',
        onClick: () => { if (can) toGameSafe('fmReg', JSON.stringify(
          Object.assign(subjPayload(), { op: 'register' }))); },
      }, '★ Add to the formation'));
    }

    /* ---- everyone (the mod's global settings) ---- */
    const all = h('div', { class: 'fm-sec' });
    body.append(all);
    all.append(h('div', { class: 'fm-sec-t' },
      h('span', {}, 'The whole formation'),
      h('span', { class: 'fm-chip' }, String(d.count || 0) + ' / ' + String(d.max || 64)),
      toggle('Formation', 'Master switch — off releases everyone to walk normally',
        g.enabled !== false,
        (v) => { apply({ global: { enabled: v } }); g.enabled = v; render(); })));

    all.append(
      slider('Spacing ⇄', 'How far apart the direction slots sit, side-to-side '
        + '(the pad above uses this)', 0, 1024, 8, num(g.defaultX), '',
        (v) => { apply({ global: { defaultX: v } }); g.defaultX = v; }),
      slider('Spacing ⇅', 'How far apart the direction slots sit, front-to-back',
        0, 1024, 8, num(g.defaultY), '',
        (v) => { apply({ global: { defaultY: v } }); g.defaultY = v; }),
      slider('Walk-to reach', 'She walks to her slot when she is this far from it',
        0, 256, 1, num(g.walkingArea), '',
        (v) => { apply({ global: { walkingArea: v } }); g.walkingArea = v; }),
      slider('Settle zone', 'Close enough — she stands still inside this radius',
        0, 256, 1, num(g.stopArea), '',
        (v) => { apply({ global: { stopArea: v } }); g.stopArea = v; }),
      slider('Re-form every', 'How often positions re-assert. Lower = tighter '
        + 'formation but more script load — the original mod’s save-killer was '
        + 'exactly this loop running hot', 1, 60, 0.5, num(g.interval) || 5, 's',
        (v) => { apply({ global: { interval: v } }); g.interval = v; }));

    all.append(h('div', { class: 'fm-toggles' },
      toggle('In towns', 'Keep formation inside villages and city grounds',
        g.habitation !== false,
        (v) => { apply({ global: { habitation: v } }); g.habitation = v; render(); }),
      toggle('Indoors', 'Keep formation in interiors and dungeons (off is the '
        + 'mod’s default — corridors fight formations)',
        g.dungeon === true,
        (v) => { apply({ global: { dungeon: v } }); g.dungeon = v; render(); }),
      toggle('Cast opens menu', 'When you cast the Formation power AT a follower, '
        + 'open her direction quick-menu. Off = the cast just toggles her in/out '
        + 'of formation with no menu.',
        g.useQuickMenu !== false,
        (v) => { apply({ global: { useQuickMenu: v } }); g.useQuickMenu = v; render(); })));

    /* Cast key — the mod's own hotkey that casts the Formation power. Press-to-
       rebind reusing the deck's DIK map (app.js). While capturing, the modal's
       onKey eats every key so nothing quick-fires behind it. */
    all.append(h('div', { class: 'fm-row fm-key-row', title:
      'The keyboard key that casts the Formation power in-game. You mostly '
      + 'drive formation from this deck now, but this is the mod’s own cast key.' },
      h('span', { class: 'fm-lbl' }, 'Cast key'),
      h('span', { class: 'fm-key-spacer' }),
      S.capturing
        ? h('button', { class: 'fm-btn fm-key-btn armed', type: 'button',
            title: 'Press any key… (Esc cancels)',
            onClick: () => { S.capturing = false; render(); } }, 'Press a key…')
        : h('button', { class: 'fm-btn fm-key-btn', type: 'button',
            title: 'Click, then press the new key',
            onClick: () => { S.capturing = true; render(); } },
            keyLabel(g.hotkey == null ? -1 : g.hotkey))));

    /* ---- the way out: stand everything down so the next save is clean ---- */
    const rescueArmed = S.rescueArmed && (Date.now() - S.rescueArmed < 4000);
    body.append(h('div', { class: 'fm-foot' },
      h('button', {
        class: 'fm-btn danger' + (rescueArmed ? ' armed' : ''), type: 'button',
        title: 'Unregister every follower, kill every update the mod has '
          + 'running, and stop its quest — the clean stand-down before a save '
          + 'or before unticking the mod. Works on the original scripts too.',
        onClick: () => {
          if (rescueArmed) {
            S.rescueArmed = 0;
            toGameSafe('fmRescue', '{}');
          } else {
            S.rescueArmed = Date.now();
            render();
            setTimeout(() => { if (S.open) render(); }, 4200);
          }
        },
      }, rescueArmed ? 'Stand down — click again' : '🛟 Rescue: stand it all down')));
  }

  /* ------------------------------------------------------------ public -- */

  function open(subj, who) {
    S.subj = subj || null;
    S.who = who || (subj && subj.name) || '';
    S.open = true;
    S.rescueArmed = 0;
    S.data = null;
    ensureDom().classList.remove('hidden');
    toGameSafe('hdCapture', '1');   // digits must not quick-fire under us
    request();
    render();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    if (el) el.classList.add('hidden');
    toGameSafe('hdCapture', '0');
  }

  function onKey(e) {
    if (!S.open) return false;
    /* Rebinding the cast key: swallow EVERY key so none quick-fires behind the
       modal. Esc cancels; a mappable key commits via RegisterHotkey (C++). */
    if (S.capturing) {
      const code = e.code || '';
      if (code === 'Escape') { S.capturing = false; render(); return true; }
      const scan = keyScan(code);
      if (scan != null) {
        S.capturing = false;
        apply({ global: { hotkey: scan } });
        if (S.data && S.data.global) S.data.global.hotkey = scan;
        render();
      }
      return true;   // consumed regardless — never fall through while capturing
    }
    if (e.key === 'Escape' || e.code === 'Escape') { close(); return true; }
    return false;   // sliders/buttons keep their native keys
  }

  window.HDFormation = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    onKey: onKey,
    _state: S,        // harness introspection only
    _render: render,  // harness
  };
})();
