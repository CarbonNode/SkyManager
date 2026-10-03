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
 *  Shape: body-anchored modal, independent of the deck's scale transform.
 *  Modern Walk With Me changes are drafted, validated and applied together;
 *  the legacy FWF / WWM 0.15 controls remain for installs that use them.
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
    /* Set when the modal was opened FOR the rescue button (from search).
       Cleared by the render that finally draws that button — the first paint
       after open() is the loading state, which has no footer to scroll to. */
    focusRescue: false,
    /* A setting to bring into view once the modal has painted it (opened
       from a search row). Consumed by the render that finds its node. */
    focusKey: '',
    provider: '',      // '' = let C++ pick (last used / only installed)
    wSlot: 0,          // Walk With Me: which party slot the grid edits
    section: 'travel',
    draft: {},
    picks: {},
    filter: '',
    error: '',
    busy: false,
  };

  let el = null;          // the backdrop node
  let applyTimer = 0;     // debounce for slider commits
  let opener = null;
  let renderedSection = '';
  /* Set by openRescue() and consumed by the open() it triggers — see there. */
  let rescuePending = false;
  /* Set by openSetting() and consumed by the open() it triggers — the same
     deferral reason as rescuePending: openVia may call open() a beat later. */
  let settingPending = null;
  /* One quiet fmGet per session so labels outside the modal (quick card
     button, search group) can name the installed mod before anyone opens it. */
  let warmed = false;

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

  /* The person under the crosshair, in the quick card's own whoOf() shape.
     The palette snapshots her at open into the Followers pane's state, and
     that is the same snapshot the quick card's Formation button reads — so
     opening this modal from search lands on exactly the person the button
     would have. No target is not an error: C++ falls back to its own
     crosshair snapshot when `formId` is absent (ResolveSubject), so `{}` is
     a legitimate "whoever I am looking at".

     The id is rendered in BASE 16 on the way out: the snapshot carries a
     NUMBER and C++ reads every formId with strtoul(…, 16), so shipping its
     decimal digits would resolve a different form entirely. */
  function crosshair() {
    try {
      const t = window.FolPane && FolPane._state && FolPane._state.target;
      const id = t ? (Number(t.formId) || 0) >>> 0 : 0;
      if (id) return { formId: '0x' + id.toString(16), name: String(t.name || '') };
    } catch (e) {}
    return {};
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
    el = h('div', { id: 'fm-modal', class: 'hidden' });
    /* Backdrop click closes; clicks inside the box stay inside. */
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.target === el) close();
    });
    document.body.appendChild(el);
    return el;
  }

  /* ------------------------------------------------------------ bridge -- */

  function subjPayload() {
    const p = {};
    if (S.subj && S.subj.formId) p.formId = String(S.subj.formId);
    /* Which formation mod this request is for. Absent on the first open of a
       session: the router then picks the last-used / only-installed one and
       tells us which in the reply, so the view never has to guess. */
    if (S.provider) p.provider = S.provider;
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
    if (d.provider) S.provider = d.provider;
    S.loading = false;
    relabelDoors();
    if (S.open) render();
  };

  window.fmResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    if (d.msg) say(d.msg);
    S.busy = false;
    if (S.data && S.data.modern) {
      S.error = d.ok === false ? String(d.msg || 'The change could not be applied.') : '';
      if (d.ok) { S.draft = {}; S.picks = {}; }
      if (d.closeGameMenu && d.ok) close();
      else if (S.open) render();
    }
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

  /* Tag a control with the setting it edits, so a search row can land on it. */
  function mark(node, key) { if (node && key) node.setAttribute('data-fm-key', key); return node; }

  /* How the formation stands right now, in one line, for the search rows.
     Reads the last fmOpen payload — which the omni provider's warm() asks
     for — and returns '' when the game has never answered, so the caller can
     fall back to describing the feature instead of asserting a state it does
     not know. The three absences are kept apart here exactly as the modal
     keeps them apart: they need different words. */
  function summary() {
    const d = S.data;
    if (!d) return '';
    if (Array.isArray(d.providers) && !d.providers.some((p) => p && p.installed))
      return 'No formation mod is installed';
    if (provOf(d) === 'wwm') {
      if (!d.installed) return 'Walk With Me isn’t in the load order';
      if (!d.present) return 'Walk With Me is installed, but its plugin isn’t enabled';
      const st = d.settings || {};
      const n = (d.count == null || d.count < 0) ? null : d.count;
      const party = n == null ? '' : String(n) + ' of ' + String(d.max || 10) + ' companions';
      if (st.enabled === false) return 'Walk With Me is switched OFF' + (party ? ' · ' + party : '');
      const mode = (Array.isArray(d.modes) ? d.modes : []).find((m) => Number(m.id) === Number(st.mode));
      return [party, mode ? mode.label : ''].filter(Boolean).join(' · ');
    }
    if (!d.installed) return 'Formation with Followers isn’t in the load order';
    if (!d.present) return 'Installed, but its plugin isn’t enabled';
    if (d.bound === false) return 'Loaded but never initialized — open its MCM once';
    const g = d.global || {};
    const formed = String(d.count || 0) + ' of ' + String(d.max || 64) + ' formed up';
    if (d.running === false) return 'The mod is switched OFF · ' + formed;
    if (g.enabled === false) return 'Formation is turned OFF · ' + formed;
    return formed + ' · spacing ' + Math.round(num(g.defaultX)) + ' ⇄ ' +
      Math.round(num(g.defaultY)) + ' ⇅';
  }

  /* Which formation mods the game says are installed: ['wwm'], ['fwf'],
     both, [] — or null when the game has not answered yet this session. */
  function installedProviders() {
    const d = S.data;
    if (!d) return null;
    /* A payload from before the provider router carries only its own mod. */
    if (!Array.isArray(d.providers)) return d.installed ? [provOf(d)] : [];
    return d.providers.filter((p) => p && p.installed).map((p) => p.id);
  }

  /* The name every surface outside the modal should use for "the formation
     mod": the one that is installed, Walk With Me when it is. */
  function displayName() {
    const ids = installedProviders();
    if (ids && ids.indexOf('wwm') !== -1) return 'Walk With Me';
    if (ids && ids.indexOf('fwf') !== -1) return 'Formation';
    return 'Formation';
  }

  /* Relabel the doors that are already on screen (the quick card's button)
     once the game has said which mod is installed. */
  function relabelDoors() {
    const name = displayName();
    document.querySelectorAll('[data-fm-open]').forEach((b) => {
      b.textContent = '⛬ ' + name + '…';
    });
  }

  function warm() {
    if (warmed || S.data) return;
    warmed = true;
    toGameSafe('fmGet', JSON.stringify(crosshair()));
  }

  /* ------------------------------------------------------------ render -- */

  function provOf(d) { return (d && d.provider) || S.provider || 'fwf'; }

  /* ------------------------------------------------------- providers -- */

  /* Providers are supplied by native detection. An explicitly configured
     Walk With Me replacement hides the retired FWF provider after cleanup. */
  function providerTabs(d) {
    const list = (d && Array.isArray(d.providers) ? d.providers : [])
      .filter((p) => p && p.installed);
    if (list.length < 2) return null;
    const row = h('div', { class: 'fm-prov' });
    list.forEach((p) => {
      const on = p.id === (d.provider || 'fwf');
      row.append(h('button', {
        class: 'fm-prov-tab' + (on ? ' on' : '') + (p.live ? ' live' : ''),
        type: 'button',
        title: p.live
          ? p.label + ' is driving your followers right now'
          : (p.wired === false
            ? p.label + ' is installed — the deck can’t drive it yet'
            : p.label + ' — installed, idle'),
        onClick: () => {
          if (on) return;
          S.provider = p.id;
          S.data = null;          /* never paint one mod's state under the
                                     other's tab, not even for a frame */
          S.loading = true;
          render();
          request();
        },
      }, p.live ? '● ' : '', p.label));
    });
    return row;
  }

  /* Two formation mods LIVE at once is the one way "both installed" hurts:
     they rewrite the same followers' travel packages every tick and fight.
     Installed-but-idle is fine and says nothing. */
  function conflictBanner(d) {
    if (!d || !d.conflict) return null;
    const others = (Array.isArray(d.providers) ? d.providers : [])
      .filter((p) => p && p.live && p.id !== d.provider);
    const other = others[0] || null;
    const warn = h('div', { class: 'fm-warn fm-conflict' },
      h('div', { class: 'fm-off-text' },
        '⚠ Two formation mods are running at once'
        + (other ? ' — this one and ' + other.label : '')
        + '. They will fight over where your followers walk. Turn one off.'));
    /* The stand-down button only exists for a provider the deck can actually
       stand down; for one it can't, the sentence is the whole answer. */
    if (other && other.wired !== false) {
      warn.append(h('button', {
        class: 'fm-btn fm-off-btn', type: 'button',
        title: 'Stand ' + other.label + ' down and leave this one running',
        onClick: () => {
          toGameSafe('fmRescue', JSON.stringify({ provider: other.id }));
          setTimeout(request, 700);
        },
      }, '⛔ Turn ' + other.label + ' off'));
    }
    return warn;
  }


  /* ==================================================================== *
   *  Walk With Me (Nexus 191283) — the second provider's body.
   *
   *  A different mod, so a different surface: it has no per-follower offset
   *  properties at all. It has FIVE ORDERS, and each order owns a table of
   *  ten party-slot positions in its own ini. The author said on release day
   *  that per-slot positioning is exactly what his in-game menu cannot do
   *  yet — which is why the positions grid below is the centre of this pane
   *  rather than an afterthought.
   *
   *  Everything here writes `Data/SKSE/Plugins/Wayfarer.ini` and then calls
   *  the mod's own ReloadSettings(), so the deck and its own configuration
   *  menu can never disagree about what is running.
   * ==================================================================== */

  /* The ten slots drawn as a little top-down map, player at the centre. Click
     to place the selected slot: a click, never a drag — Ultralight forwards
     drags to the game, and every other pad in this deck is click-placed for
     the same reason. */
  function slotMap(d, slots, commit) {
    const SIDE = 420, FWD = 700;                 // half-extents the map shows
    const wrap = h('div', { class: 'fm-map', title: 'Top-down: you are the '
      + 'gold dot. Click to move the selected companion’s place.' });
    wrap.append(h('div', { class: 'fm-map-you', title: 'You' }, '◆'));
    wrap.append(h('div', { class: 'fm-map-ax fm-map-ax-v' }));
    wrap.append(h('div', { class: 'fm-map-ax fm-map-ax-h' }));
    const max = Math.max(1, num(d.max) || slots.length);
    slots.forEach((sl, i) => {
      const x = 50 + (Math.max(-SIDE, Math.min(SIDE, num(sl.side))) / SIDE) * 46;
      const y = 50 - (Math.max(-FWD, Math.min(FWD, num(sl.forward))) / FWD) * 46;
      const on = i === S.wSlot;
      wrap.append(h('button', {
        class: 'fm-map-dot' + (on ? ' on' : '') + (i >= max ? ' over' : ''),
        type: 'button',
        style: 'left:' + x.toFixed(2) + '%;top:' + y.toFixed(2) + '%',
        title: 'Place ' + (i + 1) + (i >= max
          ? ' — beyond your companion limit, so nobody stands here'
          : ' · side ' + Math.round(num(sl.side)) + ', ahead ' + Math.round(num(sl.forward))),
        onClick: () => { S.wSlot = i; render(); },
      }, String(i + 1)));
    });
    wrap.addEventListener('click', (e) => {
      if (e.target !== wrap) return;              // a dot handled it
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const side = ((e.clientX - r.left) / r.width - 0.5) * 2 * SIDE;
      const fwd = (0.5 - (e.clientY - r.top) / r.height) * 2 * FWD;
      commit(Math.round(side), Math.round(fwd));
    });
    return wrap;
  }

  function renderWwm(body, d) {
    if (d.modern) { renderWwmModern(body, d); return; }
    const g = d.global || {};
    const safety = d.safety || {};
    const modes = Array.isArray(d.modes) ? d.modes : [];
    const mode = num(g.mode);

    /* ---- the order: what the party is actually doing ---- */
    if (modes.length) {
      const row = h('div', { class: 'fm-orders' });
      modes.forEach((m) => {
        const on = num(m.id) === mode;
        row.append(h('button', {
          class: 'fm-order' + (on ? ' on' : ''), type: 'button',
          title: on ? 'Current order — the game shows “' + (m.hud || '') + '”'
                    : 'Give the order “' + m.label + '”',
          onClick: () => {
            if (on) return;
            apply({ global: { mode: num(m.id) } });
            g.mode = num(m.id); S.wSlot = 0; render();
          },
        }, h('span', { class: 'fm-order-l' }, m.label),
           h('span', { class: 'fm-order-h' }, m.hud || '')));
      });
      body.append(row);
    }

    /* ---- switched off entirely: the loudest thing in the pane ---- */
    if (g.enabled === false) {
      body.append(h('div', { class: 'fm-warn fm-off' },
        h('div', { class: 'fm-off-text' },
          '⚠ Walk With Me is switched OFF — your followers are on their own AI '
          + 'and nothing below takes effect until you turn it on.'),
        h('button', {
          class: 'fm-btn primary fm-off-btn', type: 'button',
          title: 'Hand the party back to Walk With Me',
          onClick: () => { apply({ global: { enabled: true } }); g.enabled = true; render(); },
        }, '✦ Turn it on')));
    }

    /* ---- her place in the party ---- */
    const sub = d.subject;
    if (sub) {
      const her = h('div', { class: 'fm-sec' });
      body.append(her);
      /* Three states, and they need three different sentences: in the party,
         out of it, and "the game hasn't answered yet" — which is NOT the
         same as "no". */
      const known = typeof sub.registered === 'boolean';
      const inParty = sub.registered === true;
      const excluded = Array.isArray(d.excludedPlugins) && sub.plugin &&
        d.excludedPlugins.some((p) => String(p).toLowerCase() === String(sub.plugin).toLowerCase());
      her.append(h('div', { class: 'fm-sec-t' },
        h('span', {}, sub.name || S.who || 'Her place'),
        h('span', { class: 'fm-chip' + (inParty ? ' on' : '') },
          !known ? 'asking the game…' : (inParty ? 'walking with you' : 'not in the party'))));

      if (excluded) {
        her.append(h('div', { class: 'fm-note' },
          'Walk With Me is set to leave ' + (sub.plugin || 'her mod')
          + ' alone (its excluded-plugins list), so she keeps her own follower AI.'));
      }

      const btns = h('div', { class: 'fm-btnrow' });
      her.append(btns);
      if (inParty) {
        btns.append(h('button', {
          class: 'fm-btn danger', type: 'button',
          title: 'Take ' + (sub.name || 'her') + ' out of the walking party for now',
          onClick: () => toGameSafe('fmReg', JSON.stringify(
            Object.assign(subjPayload(), { op: 'unregister' }))),
        }, '⊘ Leave the party'));
      } else {
        /* Legacy 0.15 only — renderWwm hands 0.2.2 to renderWwmModern above,
           whose roster row is the enrolment surface and carries no gate (the
           public API it calls has none). This mirrors the legacy mod's own
           bRequirePlayerTeammate so a refusal is a sentence, not a dead button. */
        const can = sub.teammate !== false || g.requireTeammate === false;
        btns.append(h('button', {
          class: 'fm-btn primary', type: 'button', disabled: can ? null : '',
          title: can ? 'Give ' + (sub.name || 'her') + ' a place in the party'
                     : (sub.name || 'She') + ' isn’t following you, and “require '
                       + 'teammate” is on — turn that off below, or recruit her first',
          onClick: () => { if (can) toGameSafe('fmReg', JSON.stringify(
            Object.assign(subjPayload(), { op: 'register' }))); },
        }, '★ Walk with me'));
      }
      /* Exclude/include is the DURABLE pair — the mod remembers it across
         saves, which is what a companion with her own follower mod wants. */
      btns.append(h('button', {
        class: 'fm-btn', type: 'button',
        title: 'Permanently leave ' + (sub.name || 'her') + ' to her own follower '
          + 'AI. Remembered across saves — use it for a companion who has her own '
          + 'follower mod.',
        onClick: () => toGameSafe('fmReg', JSON.stringify(
          Object.assign(subjPayload(), { op: 'exclude' }))),
      }, '🚫 Never manage her'));
      btns.append(h('button', {
        class: 'fm-btn', type: 'button',
        title: 'Undo that — let Walk With Me manage ' + (sub.name || 'her') + ' again',
        onClick: () => toGameSafe('fmReg', JSON.stringify(
          Object.assign(subjPayload(), { op: 'include' }))),
      }, '↩ Allow her back'));
    }

    /* ---- where everyone walks: the ten places of THIS order ---- */
    const pos = h('div', { class: 'fm-sec' });
    body.append(pos);
    const orderName = (modes[mode] && modes[mode].label) || 'this order';
    const slots = Array.isArray(d.slots) ? d.slots : null;
    pos.append(h('div', { class: 'fm-sec-t' },
      h('span', {}, 'Where they walk'),
      h('span', { class: 'fm-chip' }, orderName),
      h('span', { class: 'fm-chip' },
        String(d.count == null || d.count < 0 ? '…' : d.count) + ' / ' + String(d.max || 10))));

    if (!slots) {
      pos.append(h('div', { class: 'fm-note' },
        'This order has no formation to edit — everyone anchors wherever you '
        + 'stopped and finds their own seat. Pick another order above to lay '
        + 'out places.'));
    } else {
      const chips = h('div', { class: 'fm-slots' });
      slots.forEach((sl, i) => {
        chips.append(h('button', {
          class: 'fm-slot' + (i === S.wSlot ? ' on' : '')
            + (i >= (num(d.max) || 10) ? ' over' : ''),
          type: 'button',
          title: 'Edit place ' + (i + 1),
          onClick: () => { S.wSlot = i; render(); },
        }, String(i + 1)));
      });
      pos.append(chips);

      const cur = slots[S.wSlot] || { side: 0, forward: 0 };
      const commit = (side, forward) => {
        apply({ slot: { mode: mode, slot: S.wSlot, side: side, forward: forward } });
        cur.side = side; cur.forward = forward; render();
      };
      pos.append(h('div', { class: 'fm-map-wrap' },
        slotMap(d, slots, commit),
        h('div', { class: 'fm-fine' },
          h('div', { class: 'fm-fine-t' }, 'Place ' + (S.wSlot + 1)),
          /* ±1000 rather than the C++ clamp's ±1024, and a step that divides
             it: with min -1024 and step 5 the grid is -1024, -1019 … and
             DEAD CENTRE IS UNREACHABLE, which is the one value you most want
             for a slot directly ahead of you. */
          slider('Side', '− left of you · + right of you', -1000, 1000, 5,
            num(cur.side), '',
            (v) => { apply({ slot: { mode: mode, slot: S.wSlot, side: v } }); cur.side = v; }),
          slider('Ahead', '− behind you · + ahead of you', -1000, 1000, 5,
            num(cur.forward), '',
            (v) => { apply({ slot: { mode: mode, slot: S.wSlot, forward: v } }); cur.forward = v; }))));
      if (S.wSlot >= (num(d.max) || 10)) {
        pos.append(h('div', { class: 'fm-note' },
          'Place ' + (S.wSlot + 1) + ' is past your companion limit of '
          + (num(d.max) || 10) + ', so nobody stands here yet.'));
      }
    }

    /* ---- how they travel ---- */
    const trav = h('div', { class: 'fm-sec' });
    body.append(trav);
    trav.append(h('div', { class: 'fm-sec-t' },
      h('span', {}, 'How they travel'),
      toggle('Walk With Me', 'Master switch — off hands the whole party back to '
        + 'their own follower AI', g.enabled !== false,
        (v) => { apply({ global: { enabled: v } }); g.enabled = v; render(); })));
    trav.append(
      slider('Spacing', 'How far apart they spread as you travel', 0.25, 3, 0.05,
        num(g.spacing), '×', (v) => { apply({ global: { spacing: v } }); g.spacing = v; }),
      slider('Catch-up speed', 'Extra speed a straggler gets to rejoin you', 0, 600, 10,
        num(g.catchUpBonus), '', (v) => { apply({ global: { catchUpBonus: v } }); g.catchUpBonus = v; }),
      slider('Arrival radius', 'How close to their place counts as arrived', 16, 512, 4,
        num(g.arrivalRadius), '', (v) => { apply({ global: { arrivalRadius: v } }); g.arrivalRadius = v; }),
      slider('Individuality', 'How much each companion’s reaction time and turn '
        + 'response varies from the others', 0, 2, 0.05,
        num(g.individuality), '×', (v) => { apply({ global: { individuality: v } }); g.individuality = v; }),
      slider('Companion limit', 'How many walk in formation at once', 1, 10, 1,
        num(g.maxFollowers) || 10, '',
        (v) => { apply({ global: { maxFollowers: v } }); g.maxFollowers = v; render(); }));
    trav.append(h('div', { class: 'fm-toggles' },
      toggle('Order emblem', 'Show the current order on the right of the screen',
        g.showHud !== false, (v) => { apply({ global: { showHud: v } }); g.showHud = v; }),
      toggle('Find them for me', 'Pick up new followers automatically as they join you',
        g.autoDiscover !== false, (v) => { apply({ global: { autoDiscover: v } }); g.autoDiscover = v; }),
      toggle('Teammates only', 'Only manage people who are actually following you',
        g.requireTeammate !== false,
        (v) => { apply({ global: { requireTeammate: v } }); g.requireTeammate = v; render(); })));

    /* ---- when it lets go ---- */
    const saf = h('div', { class: 'fm-sec' });
    body.append(saf);
    saf.append(h('div', { class: 'fm-sec-t' }, h('span', {}, 'When it lets go')));
    saf.append(h('div', { class: 'fm-toggles' },
      toggle('In combat', 'Hand them back the moment a fight starts',
        safety.combat !== false, (v) => { apply({ safety: { combat: v } }); safety.combat = v; }),
      toggle('While sneaking', 'Hand them back while you are sneaking',
        safety.sneaking !== false, (v) => { apply({ safety: { sneaking: v } }); safety.sneaking = v; }),
      toggle('Weapon drawn', 'Hand them back with a weapon or spell out',
        safety.weaponDrawn !== false,
        (v) => { apply({ safety: { weaponDrawn: v } }); safety.weaponDrawn = v; }),
      toggle('Cutscenes', 'Hand them back whenever the game takes your controls',
        safety.controlsDisabled !== false,
        (v) => { apply({ safety: { controlsDisabled: v } }); safety.controlsDisabled = v; }),
      toggle('Indoors', 'Never form up inside — on = interiors are left alone',
        safety.indoors === true, (v) => { apply({ safety: { indoors: v } }); safety.indoors = v; }),
      /* The one that matters on this rig: the deck drives NFF for the party
         orders, so two systems can end up steering the same follower. */
      toggle('Override NFF', 'Let Walk With Me take travel control away from '
        + 'Nether’s Follower Framework. The deck’s own party orders go through '
        + 'NFF — turn this OFF if they start fighting each other.',
        safety.enforceNff !== false,
        (v) => { apply({ safety: { enforceNff: v } }); safety.enforceNff = v; })));
    saf.append(slider('Let go beyond', 'Distance at which a companion is released '
      + 'to catch up on her own', 200, 10000, 50, num(safety.releaseDistance), '',
      (v) => { apply({ safety: { releaseDistance: v } }); safety.releaseDistance = v; }));

    if (d.warming) {
      body.append(h('div', { class: 'fm-note' },
        'Party numbers are still coming back from the game — they fill in a moment '
        + 'after the mod answers.'));
    }

    rescueFoot(body, 'Return the whole party to their own follower AI and switch '
      + 'Walk With Me off. Its own “Return to follower AI” order, from here.');
  }

  /* formation-wwm-modern: controls come from the verified native 0.2.2
     contract. Draft changes are committed together; ReloadSettings needs
     the unpaused VM, so Apply returns to the game once, after saving. */
  function pending() { return Object.keys(S.draft).length + Object.keys(S.picks).length; }
  function modernChange(key, value, repaint) {
    S.draft[key] = value;
    S.error = '';
    if (repaint !== false) render();
    else {
      const applyButton = el && el.querySelector('.fm-apply');
      if (applyButton) { applyButton.disabled = false; applyButton.textContent = 'Apply & return to game'; }
      const status = el && el.querySelector('.fm-draft-status');
      if (status) status.textContent = 'Changes ready to apply';
      const discard = el && el.querySelector('.fm-discard');
      if (discard) discard.disabled = false;
    }
  }

  function renderWwmModern(body, d) {
    const settings = Object.assign({}, d.settings || {}, S.draft);
    const sections = [['travel','Travel'], ['hands','Hand-holding'], ['rest','Rest'],
      ['scout','Scouting'], ['safety','Compatibility'], ['display','Display']];
    const nav = h('nav', { class: 'fm-section-nav', 'aria-label': 'Formation controls' });
    sections.forEach(([id,label]) => nav.append(h('button', {
      type:'button', class:'fm-section-tab' + (S.section === id ? ' on' : ''),
      'aria-pressed':String(S.section === id), onClick:() => { S.section=id; S.filter=''; render(); }
    },label)));
    body.append(nav);
    const intro = {
      travel:['Walk together', 'Choose an order and the companions who travel with you.'],
      hands:['A companion at your side', 'Experimental. Use third person with weapons sheathed. Pause to let your companion approach, then walk together.'],
      rest:['Make yourselves at home', 'Choose what companions do while the party rests.'],
      scout:['Let a companion find the way', 'Choose who scouts for nearby containers, bodies and valuable items.'],
      safety:['Work with your follower setup', 'Decide when Walk With Me gives control back to other follower behavior.'],
      display:['Your travel HUD', 'Set the size, position and visibility of Walk With Me’s own indicators.']
    }[S.section];
    body.append(h('div',{class:'fm-modern-intro'},
      h('div',{},h('h2',{},intro[0]),h('p',{},intro[1])),
      h('span',{class:'fm-chip'},String(d.count < 0 ? '…' : d.count || 0) + ' / ' + String(d.max || 10) + ' companions')));
    if (S.error) body.append(h('div',{class:'fm-warn',role:'alert'},S.error));
    if (!d.apiReady) body.append(h('div',{class:'fm-warn'},'The Walk With Me interface is unavailable. Check the installed DLL before applying changes.'));
    if (d.handoffPending) body.append(h('div',{class:'fm-note'},'Finishing the switch from Formation with Followers. Close the deck and let the game run for a moment.'));
    else if (d.handoffMessage && /paused|unavailable/.test(d.handoffMessage)) body.append(h('div',{class:'fm-warn',role:'alert'},d.handoffMessage));

    if (S.section === 'travel' || S.section === 'hands') {
      const modes = h('div',{class:'fm-orders'});
      (d.modes || []).forEach(m => modes.append(h('button',{
        type:'button',class:'fm-order' + (Number(settings.mode) === Number(m.id) ? ' on' : ''),
        'aria-pressed':String(Number(settings.mode) === Number(m.id)),
        onClick:()=>modernChange('mode',Number(m.id))
      },h('span',{class:'fm-order-l'},m.label),h('span',{class:'fm-order-h'},m.hud))));
      mark(modes,'mode');
      if (S.section === 'travel') body.append(modes);
      else if (Number(settings.mode) !== 2 || settings.enabled === false) {
        body.append(h('div',{class:'fm-note fm-action-note'},
          h('span',{},'Hand-holding uses Companion mode with Walk With Me enabled.'),
          h('button',{type:'button',class:'fm-btn',onClick:()=>{
            S.draft.mode=2; modernChange('enabled',true);
          }},'Use Companion mode')));
      }
      const side = mark(h('div',{class:'fm-choice-row'},h('span',{class:'fm-lbl'},'Companion side')),'preferredSide');
      [[-1,'Left'],[1,'Right']].forEach(([value,label])=>side.append(h('button',{
        type:'button',class:'fm-btn'+(Number(settings.preferredSide)===value?' primary':''),
        'aria-pressed':String(Number(settings.preferredSide)===value),onClick:()=>modernChange('preferredSide',value)
      },label)));
      body.append(side);
    }
    if (S.section === 'hands') {
      const row = mark(h('div',{class:'fm-choice-row'},h('span',{class:'fm-lbl'},'Method')),'method');
      [['classic','Classic'],['tether','TETHER']].forEach(([value,label])=>row.append(h('button',{
        type:'button',class:'fm-btn'+(settings.method===value?' primary':''),
        disabled:value==='tether'&&!d.tetherAssets?'':null,
        'aria-pressed':String(settings.method===value),onClick:()=>modernChange('method',value)
      },label)));
      body.append(row);
      if (!d.tetherAssets) body.append(h('p',{class:'fm-help'},'Classic is available without extra animations. TETHER needs Open Animation Replacer and generated clasp animations.'));
      body.append(h('p',{class:'fm-help'},'The selected partner is a preference. This interface cannot confirm that the hands have connected. Combat, sprinting and first person release the grip.'));
    }
    if (S.section === 'travel' || S.section === 'hands' || S.section === 'scout') renderModernRoster(body,d,settings);

    const fields = h('div',{class:'fm-control-grid'});
    (d.controls || []).filter(c=>c.group===S.section).forEach(c=>{
      if (S.section==='hands' && /^palm|^gripGap$/.test(c.key) && settings.method!=='tether') return;
      if (c.type==='toggle') {
        fields.append(mark(toggle(c.label,c.label,settings[c.key]===true,v=>modernChange(c.key,v)),c.key));
      } else {
        const input=h('input',{type:'number',class:'fm-number',name:c.key,
          min:c.min,max:c.max,step:c.step,value:settings[c.key],inputmode:'decimal',
          'aria-label':c.label,autocomplete:'off',onChange:e=>{
            const value=Number(e.target.value);
            if (e.target.value!=='' && Number.isFinite(value)) modernChange(c.key,value,false);
          }});
        fields.append(mark(h('label',{class:'fm-number-row'},h('span',{},c.label),input),c.key));
      }
    });
    body.append(fields);
    if (S.section==='rest') body.append(h('button',{class:'fm-btn',type:'button',onClick:()=>{
      S.draft.enabled=true; modernChange('mode',4);
    }},'Set order: Relax here'));
    const footer=h('div',{class:'fm-modern-foot'},
      h('span',{class:'fm-draft-status','aria-live':'polite'},pending()?'Changes ready to apply':'Settings apply when you return to the game'),
      h('button',{class:'fm-btn fm-discard',type:'button',disabled:pending()&&!S.busy?null:'',onClick:()=>{
        S.draft={};S.picks={};S.error='';render();
      }},'Discard'),
      h('button',{class:'fm-btn primary fm-apply',type:'button',disabled:pending()&&d.apiReady&&!S.busy&&!d.handoffPending?null:'',onClick:()=>{
        if (!pending() || !d.apiReady || S.busy || d.handoffPending) return;
        S.busy=true;render();
        toGameSafe('fmApply',JSON.stringify(Object.assign(subjPayload(),S.picks,{settings:S.draft})));
      }},S.busy?'Applying…':'Apply & return to game'));
    body.append(footer);
  }

  function renderModernRoster(body,d,settings) {
    const selecting = S.section !== 'travel';
    const hands = S.section === 'hands';
    const choice = hands ? 'partnerId' : 'finderId';
    const selected = hands ? d.partner || {} : d.finder || {};
    const roster = Array.isArray(d.roster) ? d.roster : [];
    const selectedRow = Object.prototype.hasOwnProperty.call(S.picks,choice)
      ? roster.find(r=>r.formId===S.picks[choice]) : roster.find(r=>r.key && r.key===selected.key);
    const pickedName = Object.prototype.hasOwnProperty.call(S.picks,choice)
      ? selectedRow && selectedRow.name : selected.name;
    const card=mark(h('section',{class:'fm-party'}),'party');
    card.append(h('div',{class:'fm-sec-t'},
      selecting ? (hands?'Hand-holding companion':'Loot scout') : 'Your nearby companions',
      selecting ? h('span',{class:'fm-chip'},pickedName || (hands?'Choose a partner':'Nearest companion')) : null));
    body.append(card);
    if (selecting) card.append(h('button',{type:'button',class:'fm-btn fm-clear-partner',onClick:()=>{
      S.picks[choice]=''; if(hands)S.draft.handsEnabled=false; render();
    }},hands?'Clear partner':'Use the nearest companion'));
    const input=h('input',{class:'fm-party-search',type:'search',name:'formation-companion-search',
      placeholder:'Find a companion…','aria-label':'Find a companion',autocomplete:'off',value:S.filter});
    card.append(input);
    const list=h('div',{class:'fm-party-list'});card.append(list);
    function paint() {
      list.textContent='';
      const matches=roster.filter(r=>String(r.name||'').toLowerCase().includes(S.filter.toLowerCase()));
      if (!matches.length) list.append(h('p',{class:'fm-help'},roster.length?'No companions match this search.':'No companions nearby. Open Formation from a follower’s quick card to target them.'));
      matches.forEach(r=>{
        const picked = selecting && (Object.prototype.hasOwnProperty.call(S.picks,choice)
          ? S.picks[choice]===r.formId : !!r.key&&r.key===selected.key);
        const row=h('article',{class:'fm-party-card'+(picked?' selected':'')},
          h('div',{class:'fm-party-name'},r.name || 'Companion'),
          h('span',{class:'fm-help'},!r.key?'Temporary reference':r.managed?'In the walking party':'Not in the walking party'));
        if(selecting) {
          const can=r.managed && !!r.key;
          row.append(h('button',{type:'button',class:'fm-btn'+(picked?' primary':''),disabled:can?null:'',
            title:can?'Choose this companion':'Add this companion to the walking party on the Travel tab first',onClick:()=>{
              if (!can) return;
              S.picks[choice]=r.formId;
              if(hands) { S.draft.handsEnabled=true; S.draft.mode=2; S.draft.enabled=true; }
              render();
            }},picked?'Selected':hands?'Hold hands':'Choose scout'));
        } else {
          row.append(h('button',{type:'button',class:'fm-btn'+(!r.managed?' primary':''),onClick:()=>{
            if(S.busy || d.handoffPending) return;
            if(pending()) { S.error='Apply or discard your settings before changing the walking party.';render();return; }
            S.busy=true;render();
            toGameSafe('fmReg',JSON.stringify({provider:'wwm',formId:r.formId,op:r.managed?'unregister':'register'}));
          }},r.managed?'Leave party':'Walk with me'));
        }
        list.append(row);
      });
    }
    input.addEventListener('input',()=>{S.filter=input.value;paint();});
    input.addEventListener('keydown',e=>{if(e.key==='Enter'){
      const top=list.querySelector('button:not([disabled])');if(top){e.preventDefault();top.click();}
    }});
    paint();
  }

  function render() {
    const before=el && el.querySelector('.fm-body');
    const scroll=before && renderedSection===S.section ? before.scrollTop : 0;
    const active=el && el.contains(document.activeElement) ? document.activeElement : null;
    const identity=active && {tag:active.tagName,name:active.getAttribute('name'),cls:active.className,text:active.textContent};
    renderContent();
    renderedSection=S.section;
    if(identity) {
      const next=Array.from(el.querySelectorAll('button,input,select')).find(n=>n.tagName===identity.tag &&
        (identity.name?n.getAttribute('name')===identity.name:n.className===identity.cls&&n.textContent===identity.text));
      if(next) next.focus();
    }
    const body=el.querySelector('.fm-body');if(body)body.scrollTop=scroll;
    focusSetting();
  }

  /* Opened from a search row for one setting: once the modal has painted the
     node that edits it, scroll it into view and light it briefly. Scroll and
     highlight only — no focus(), so Enter never fires a toggle by surprise. */
  function focusSetting() {
    if (!S.focusKey || !el || S.loading || !S.data) return;
    const node = el.querySelector('[data-fm-key="' + S.focusKey + '"]');
    if (!node) return;   // not painted in this provider/section; try next render
    S.focusKey = '';
    try { node.scrollIntoView({ block: 'center' }); } catch (e) {}
    node.classList.add('fm-hit');
    setTimeout(() => { if (node.isConnected) node.classList.remove('fm-hit'); }, 2400);
  }

  function renderContent() {
    const root = ensureDom();
    root.textContent = '';
    const box = h('div', { class: 'fm-box' + (S.data && S.data.modern ? ' fm-modern' : ''), role: 'dialog', 'aria-modal':'true', 'aria-label': 'Formation settings' });
    root.appendChild(box);

    const d = S.data;
    box.append(h('div', { class: 'fm-head' },
      h('span', { class: 'fm-title' }, d && d.modern ? 'Walk With Me' : 'Formation'),
      S.who ? h('span', { class: 'fm-who' }, S.who) : null,
      h('button', {
        class: 'fm-close', type: 'button', title: 'Close (Esc)', 'aria-label':'Close formation controls',
        onClick: () => close(),
      }, '✕')));

    const tabs = providerTabs(d);
    if (tabs) box.append(tabs);

    const body = h('div', { class: 'fm-body' });
    box.append(body);

    if (S.loading && !d) {
      body.append(h('div', { class: 'fm-empty' },
        h('div', { class: 'fm-empty-ic' }, '⛬'),
        h('div', { class: 'fm-empty-t' }, 'Asking the game…')));
      return;
    }

    if (d && provOf(d) !== 'fwf' && (d.wired === false || !d.present)) {
      /* A provider the deck knows about but cannot drive yet. Say that in its
         own words — the FWF copy below is about a different mod entirely. */
      body.append(h('div', { class: 'fm-empty' },
        h('div', { class: 'fm-empty-ic' }, '⛬'),
        h('div', { class: 'fm-empty-t' },
          (d.label || 'This formation mod')
          + (d.wired === false ? ' isn’t wired up yet' : ' isn’t ready')),
        h('div', { class: 'fm-empty-d' },
          d.note || 'The deck can see it, but can’t drive it yet.')));
      return;
    }

    if (!d || !d.present || d.bound === false) {
      /* Honest absence, with the way forward. Three flavours. */
      const why = !d || !d.installed
        ? 'No formation mod is in the load order. Walk With Me (Nexus 191283) '
          + 'is the one the deck drives — install it, tick its plugin '
          + '(Wayfarer.esp) and relaunch.'
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
    const conflict = conflictBanner(d);
    if (conflict) body.append(conflict);

    /* A different mod needs a different body — see renderWwm's header. */
    if (provOf(d) === 'wwm') { renderWwm(body, d); return; }

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
    const her = mark(h('div', { class: 'fm-sec' }), 'place');
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
      mark(toggle('Formation', 'Master switch — off releases everyone to walk normally',
        g.enabled !== false,
        (v) => { apply({ global: { enabled: v } }); g.enabled = v; render(); }), 'formation')));

    all.append(
      mark(slider('Spacing ⇄', 'How far apart the direction slots sit, side-to-side '
        + '(the pad above uses this)', 0, 1024, 8, num(g.defaultX), '',
        (v) => { apply({ global: { defaultX: v } }); g.defaultX = v; }), 'defaultX'),
      mark(slider('Spacing ⇅', 'How far apart the direction slots sit, front-to-back',
        0, 1024, 8, num(g.defaultY), '',
        (v) => { apply({ global: { defaultY: v } }); g.defaultY = v; }), 'defaultY'),
      mark(slider('Walk-to reach', 'She walks to her slot when she is this far from it',
        0, 256, 1, num(g.walkingArea), '',
        (v) => { apply({ global: { walkingArea: v } }); g.walkingArea = v; }), 'walkingArea'),
      mark(slider('Settle zone', 'Close enough — she stands still inside this radius',
        0, 256, 1, num(g.stopArea), '',
        (v) => { apply({ global: { stopArea: v } }); g.stopArea = v; }), 'stopArea'),
      mark(slider('Re-form every', 'How often positions re-assert. Lower = tighter '
        + 'formation but more script load — the original mod’s save-killer was '
        + 'exactly this loop running hot', 1, 60, 0.5, num(g.interval) || 5, 's',
        (v) => { apply({ global: { interval: v } }); g.interval = v; }), 'interval'));

    all.append(h('div', { class: 'fm-toggles' },
      mark(toggle('In towns', 'Keep formation inside villages and city grounds',
        g.habitation !== false,
        (v) => { apply({ global: { habitation: v } }); g.habitation = v; render(); }), 'habitation'),
      mark(toggle('Indoors', 'Keep formation in interiors and dungeons (off is the '
        + 'mod’s default — corridors fight formations)',
        g.dungeon === true,
        (v) => { apply({ global: { dungeon: v } }); g.dungeon = v; render(); }), 'dungeon'),
      mark(toggle('Cast opens menu', 'When you cast the Formation power AT a follower, '
        + 'open her direction quick-menu. Off = the cast just toggles her in/out '
        + 'of formation with no menu.',
        g.useQuickMenu !== false,
        (v) => { apply({ global: { useQuickMenu: v } }); g.useQuickMenu = v; render(); }), 'useQuickMenu')));

    /* Cast key — the mod's own hotkey that casts the Formation power. Press-to-
       rebind reusing the deck's DIK map (app.js). While capturing, the modal's
       onKey eats every key so nothing quick-fires behind it. */
    all.append(mark(h('div', { class: 'fm-row fm-key-row', title:
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
            keyLabel(g.hotkey == null ? -1 : g.hotkey))), 'hotkey'));

    rescueFoot(body);
  }

  /* The way out, shared by every provider: stand the mod down so the next save
     is clean. Two clicks, because it releases the whole party. */
  function rescueFoot(body, title) {
    const rescueArmed = S.rescueArmed && (Date.now() - S.rescueArmed < 4000);
    body.append(h('div', { class: 'fm-foot' },
      h('button', {
        class: 'fm-btn danger' + (rescueArmed ? ' armed' : ''), type: 'button',
        title: title || ('Unregister every follower, kill every update the mod has '
          + 'running, and stop its quest — the clean stand-down before a save '
          + 'or before unticking the mod. Works on the original scripts too.'),
        onClick: () => {
          if (rescueArmed) {
            S.rescueArmed = 0;
            toGameSafe('fmRescue', JSON.stringify({ provider: provOf(S.data) }));
          } else {
            S.rescueArmed = Date.now();
            render();
            setTimeout(() => { if (S.open) render(); }, 4200);
          }
        },
      }, rescueArmed ? 'Stand down — click again' : '🛟 Rescue: stand it all down')));

    /* Opened FROM the rescue search row: bring the button into view rather
       than firing it. Scrolling only — deliberately not focus(), because a
       focused button turns the next Enter into a click on the one control in
       here that stands the whole system down, and the two-click arming is the
       only thing between a mistyped key and that. */
    if (S.focusRescue) {
      S.focusRescue = false;
      /* `body`, not `box`: the foot lives in the body, and this block now
         runs inside the shared rescueFoot() rather than render(). */
      const btn = body.querySelector('.fm-foot .fm-btn');
      if (btn && btn.scrollIntoView) {
        try { btn.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    }
  }

  /* ------------------------------------------------------------ public -- */

  function open(subj, who) {
    opener=document.activeElement;
    S.subj = subj || null;
    S.who = who || (subj && subj.name) || '';
    S.open = true;
    S.rescueArmed = 0;
    S.focusRescue = rescuePending;
    rescuePending = false;
    S.focusKey = '';
    if (settingPending) {
      if (settingPending.provider) S.provider = settingPending.provider;
      if (settingPending.section) S.section = settingPending.section;
      S.focusKey = settingPending.key || '';
      settingPending = null;
    }
    S.data = null;
    S.draft = {}; S.picks = {}; S.error = ''; S.filter = ''; S.busy=false;
    ensureDom().classList.remove('hidden');
    toGameSafe('hdCapture', '1');   // digits must not quick-fire under us
    request();
    render();
    const first=el.querySelector('.fm-close');if(first)first.focus();
  }

  /* Open through the EXPORT rather than the closure-local open(): hd-css.js
     wraps the exported method so this modal's lazy stylesheet has applied
     before the box mounts, and an internal call is invisible to that wrapper
     (its MutationObserver backstop would still fetch the sheet, but only
     after the box had painted unstyled). Every door that is not the quick
     card's own button comes through here. */
  function openVia(subj, who) {
    const via = (window.HDFormation && window.HDFormation.open) || open;
    via(subj, who);
  }

  /* The rescue button, reached without knowing where it lives. It is the
     escape hatch for a documented save-poisoner, and it sat two levels down
     (quick card → modal → footer); someone whose saves are wedging needs to
     find it by typing "rescue". Opens the modal and lets the footer come to
     the top of the fold — the destructive op still takes its two clicks.

     The intent rides `rescuePending` rather than being set on S afterwards,
     because openVia can DEFER the call: setting the flag after a deferred
     open would have that open clear it a few ms later. */
  function openRescue(subj, who) {
    rescuePending = true;
    openVia(subj, who);
  }

  /* One setting, reached by typing its name. `provider` picks the mod's tab,
     `section` the Walk With Me section it lives in, `key` the control. */
  function openSetting(provider, section, key, subj, who) {
    settingPending = { provider: provider || '', section: section || '', key: key || '' };
    openVia(subj, who);
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.focusRescue = false;
    clearTimeout(applyTimer);
    if (el) el.classList.add('hidden');
    toGameSafe('hdCapture', '0');
    if(opener && opener.isConnected && typeof opener.focus==='function') opener.focus();
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
    if (e.key === 'Tab' && el) {
      const nodes = Array.from(el.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])'));
      const index = nodes.indexOf(document.activeElement);
      if (nodes.length && (index < 0 || (!e.shiftKey && index === nodes.length-1) || (e.shiftKey && index === 0))) {
        nodes[e.shiftKey ? nodes.length-1 : 0].focus(); return true;
      }
    }
    return false;   // sliders/buttons keep their native keys
  }

  window.HDFormation = {
    open: open,
    openRescue: openRescue,
    close: close,
    isOpen: function () { return S.open; },
    openSetting: openSetting,
    label: displayName,
    warm: warm,
    onKey: onKey,
    _state: S,        // harness introspection only
    _render: render,  // harness
  };

  /* ------------------------------------------------------------- omni --- *
   * An entire mod's settings surface used to hang off one button on one
   * card: "formation", "spacing" and "marching order" all found nothing.
   * Two rows, because the rescue is the one control someone hunts for under
   * pressure and it is the furthest from the surface.
   *
   * `tab` is empty on purpose. The modal is the destination, and the obvious
   * alternative — 'followers' — is gated on Follower Organizer being
   * installed, which would take the whole Formation feature out of search on
   * a rig that never had FO. */
  /* Rober, 2026-09-27: "what about the searching for them and their
     settings" — with Walk With Me in, typing "walk" found 18 quests and not
     the mod, and none of its 62 settings were findable at all. So the rows
     follow what is INSTALLED: each formation mod by its own name, each of its
     sections, and every setting, each landing on that control (scrolled into
     view and lit, never clicked). Formation with Followers' rows exist only
     while it is installed; before the game has answered, one neutral row.

     WWM_CATALOG mirrors src/formation_wwm_settings.h (the 0.2.2 contract).
     It is only the fallback — once fmOpen has answered, the live `controls`
     list from C++ is what gets indexed, so a new field shows up without a
     view change. */
  const WWM_SECTIONS = [['travel', 'Travel'], ['hands', 'Hand-holding'], ['rest', 'Rest'],
    ['scout', 'Scouting'], ['safety', 'Compatibility'], ['display', 'Display']];
  const WWM_CATALOG = [
    ['travel', 'enabled', 'Walk With Me (master switch)'], ['travel', 'autoDiscover', 'Automatically enroll followers'],
    ['travel', 'requireTeammate', 'Require a recruited follower'], ['travel', 'maxFollowers', 'Companion limit'],
    ['travel', 'spacing', 'Formation spacing'], ['travel', 'catchUpBonus', 'Catch-up speed bonus'],
    ['travel', 'arrivalRadius', 'Arrival distance'], ['travel', 'individuality', 'Individual movement'],
    ['travel', 'teleportCatchup', 'Recall distant companions'], ['travel', 'teleportDistance', 'Recall beyond this distance'],
    ['travel', 'forwardCollision', 'Avoid nearby obstacles'],
    ['hands', 'handsEnabled', 'Hand-holding'], ['hands', 'leadIn', 'Approach delay (seconds)'],
    ['hands', 'connectDistance', 'Connect within'], ['hands', 'handReleaseDistance', 'Release beyond'],
    ['hands', 'palmX', 'TETHER palm offset X'], ['hands', 'palmY', 'TETHER palm offset Y'],
    ['hands', 'palmZ', 'TETHER palm offset Z'], ['hands', 'gripGap', 'TETHER wrist gap'],
    ['rest', 'automaticRest', 'Rest when you stop'], ['rest', 'restRadius', 'Starting rest radius'],
    ['rest', 'maxRestRadius', 'Maximum rest radius'], ['rest', 'resumeDistance', 'Resume travel after'],
    ['rest', 'fullRestAfter', 'Settle after (seconds)'], ['rest', 'groundSitting', 'Sit on the ground'],
    ['rest', 'meals', 'Eat together'], ['rest', 'reading', 'Read while resting'],
    ['rest', 'stretching', 'Stretch while resting'], ['rest', 'areaActivities', 'Activities suited to the location'],
    ['rest', 'socialIdles', 'Companion conversations'], ['rest', 'walkingBanter', 'Conversations while walking'],
    ['rest', 'conversationAwareness', 'Give conversations room'], ['rest', 'personalities', 'Individual personalities'],
    ['rest', 'lookouts', 'Keep watch while resting'], ['rest', 'extraRestPoses', 'Extra rest poses'],
    ['scout', 'lootEnabled', 'Scout for loot'], ['scout', 'containers', 'Search containers'],
    ['scout', 'bodies', 'Search bodies'], ['scout', 'looseItems', 'Find valuable loose items'],
    ['scout', 'lootIcons', 'Show discovery icons'], ['scout', 'inhabitedInteriors', 'Scout in homes and settlements'],
    ['scout', 'searchRadius', 'Search radius'], ['scout', 'valuableGold', 'Valuable item threshold (gold)'],
    ['scout', 'searchSeconds', 'Search time (seconds)'], ['scout', 'areaDistance', 'Distance before another search'],
    ['safety', 'combat', 'Release in combat'], ['safety', 'sneaking', 'Release while sneaking'],
    ['safety', 'weaponDrawn', 'Release with weapons drawn'], ['safety', 'controlsDisabled', 'Release during scenes'],
    ['safety', 'requireTravelPackage', 'Respect non-travel AI packages'], ['safety', 'indoors', 'Disable formations indoors'],
    ['safety', 'releaseDistance', 'Release beyond this distance'], ['safety', 'enforceNff', 'Allow travel control with NFF'],
    ['safety', 'enforceCustom', 'Allow travel control with custom followers'],
    ['display', 'showHud', 'Show current order'], ['display', 'hudPanel', 'Order panel background'],
    ['display', 'hudScale', 'Order emblem size'], ['display', 'hudVertical', 'Order emblem vertical position'],
    ['display', 'restDialogueIcons', 'Show conversation icons'], ['display', 'animateChatIcons', 'Animate conversation icons'],
  ];
  /* Controls the modern body draws itself rather than from `controls`. */
  const WWM_EXTRA = [
    ['travel', 'mode', 'Travel order', 'order march companion relax follow normally'],
    ['travel', 'preferredSide', 'Companion side', 'left right side'],
    ['travel', 'party', 'Walking party', 'add remove enroll leave companions who walks'],
    ['hands', 'method', 'Hand-holding method', 'classic tether'],
    ['hands', 'party', 'Hand-holding partner', 'partner choose hold hands'],
    ['scout', 'party', 'Loot scout', 'finder choose scout who loots'],
  ];
  const FWF_ROWS = [
    ['place', 'Her place in the formation', 'direction pad walking sneaking combat offset side ahead behind flank position'],
    ['formation', 'Formation (master switch)', 'on off enable release everyone'],
    ['defaultX', 'Spacing ⇄ side-to-side', 'spacing width'],
    ['defaultY', 'Spacing ⇅ front-to-back', 'spacing depth'],
    ['walkingArea', 'Walk-to reach', 'distance slot'],
    ['stopArea', 'Settle zone', 'radius stand still'],
    ['interval', 'Re-form every', 'interval update seconds'],
    ['habitation', 'In towns', 'villages cities habitation'],
    ['dungeon', 'Indoors', 'interiors dungeons'],
    ['useQuickMenu', 'Cast opens menu', 'power quick menu'],
    ['hotkey', 'Cast key', 'hotkey key bind'],
  ];

  function wwmControls() {
    const d = S.data;
    const live = d && provOf(d) === 'wwm' && Array.isArray(d.controls) && d.controls.length
      ? d.controls.map((c) => [c.group, c.key, c.key === 'enabled' ? 'Walk With Me (master switch)' : c.label])
      : WWM_CATALOG;
    return live;
  }

  function wwmValue(key) {
    const d = S.data;
    if (!d || provOf(d) !== 'wwm' || !d.settings || !(key in d.settings)) return '';
    const v = d.settings[key];
    return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
  }

  if (window.HDOmni && typeof HDOmni.register === 'function') {
    const secName = {};
    WWM_SECTIONS.forEach(([id, label]) => { secName[id] = label; });
    HDOmni.register({
      id: 'formation',
      /* The group header names the installed mod. */
      get label() { return displayName(); },
      /* Ahead of the default 50 so "walk" shows the mod above the quests
         that merely have the word in their names. */
      get rank() { const ids = installedProviders(); return ids && ids.length ? 45 : 50; },
      tab: '',
      /* One read when the overlay opens, so the rows can say how the
         formation actually stands instead of describing it in the abstract.
         Deliberately NOT request(): that one commits S.subj and the loading
         flag, which belong to a modal that is not open. */
      warm: function () { toGameSafe('fmGet', JSON.stringify(crosshair())); },
      index: function () {
        const ids = installedProviders();
        const live = summary();
        const go = (prov, section, key) => function () {
          const c = crosshair(); openSetting(prov, section, key, c, c.name || '');
        };
        const rows = [];
        if (!ids || !ids.length) {
          /* Unknown (the game has not answered) or nothing installed: one
             neutral door, whose modal says honestly which is the case. */
          rows.push({
            label: 'Formation — where your followers walk',
            detail: live || (ids ? 'No formation mod is installed'
              : 'Walking companions, travel orders, hand-holding, rest and scouting'),
            kind: 'formation',
            keywords: 'formation walk with me wayfarer followers companions travel spacing ' +
              'hand holding rest scout loot marching order party',
            run: function () { const c = crosshair(); openVia(c, c.name || ''); },
          });
          if (!ids) rows.push({
            label: 'Formation: Rescue — stand it all down',
            detail: 'Unregister everyone, kill the updates the mod has running ' +
              'and stop its quest — the clean stand-down before a save',
            kind: 'formation',
            keywords: 'rescue stand down stand-down emergency panic stop off ' +
              'disable unregister release save corruption corrupt poisoned ' +
              'infinite loading screen wedged broken formation',
            run: function () { const c = crosshair(); openRescue(c, c.name || ''); },
          });
          return rows;
        }
        if (ids.indexOf('wwm') !== -1) {
          rows.push({
            label: 'Walk With Me — travel, hand-holding, rest and scouting',
            detail: (provOf(S.data) === 'wwm' && live) || 'How your companions walk, rest and scout with you',
            kind: 'formation',
            keywords: 'walk with me wayfarer formation followers companions travel order spacing ' +
              'hand holding rest scout loot party settings mcm',
            run: go('wwm', 'travel', ''),
          });
          WWM_SECTIONS.forEach(([id, label]) => rows.push({
            label: 'Walk With Me: ' + label,
            detail: 'Every ' + label.toLowerCase() + ' setting',
            kind: 'formation',
            keywords: 'walk with me wayfarer section settings ' + id,
            run: go('wwm', id, ''),
          }));
          const seen = {};
          WWM_EXTRA.concat(wwmControls().map((c) => [c[0], c[1], c[2], ''])).forEach(([sec, key, label, kw]) => {
            if (seen[sec + '/' + key]) return;
            seen[sec + '/' + key] = true;
            const val = wwmValue(key);
            rows.push({
              label: label,
              detail: 'Walk With Me · ' + (secName[sec] || sec) + (val ? ' · now ' + val : ''),
              kind: 'formation',
              keywords: 'walk with me wayfarer setting ' + (secName[sec] || sec) + ' ' + key + ' ' + (kw || '') +
                (key === 'enabled' ? ' on off disable stand down rescue master switch' : ''),
              run: go('wwm', sec, key),
            });
          });
        }
        if (ids.indexOf('fwf') !== -1) {
          rows.push({
            label: 'Formation with Followers — where your followers walk',
            detail: (provOf(S.data) === 'fwf' && live) || 'Direction pad, spacing and the formation’s own settings',
            kind: 'formation',
            keywords: 'formation with followers fwf spacing marching order walk position ' +
              'sneaking combat offsets towns indoors cast key quick menu',
            run: go('fwf', '', ''),
          });
          FWF_ROWS.forEach(([key, label, kw]) => rows.push({
            label: label,
            detail: 'Formation with Followers',
            kind: 'formation',
            keywords: 'formation with followers fwf setting ' + key + ' ' + kw,
            run: go('fwf', '', key),
          }));
          rows.push({
            label: 'Formation with Followers: Rescue — stand it all down',
            detail: 'Unregister everyone, kill the updates the mod has running ' +
              'and stop its quest — the clean stand-down before a save',
            kind: 'formation',
            keywords: 'rescue stand down stand-down emergency panic stop off ' +
              'disable unregister release save corruption corrupt poisoned ' +
              'infinite loading screen wedged broken formation',
            run: function () { const c = crosshair(); settingPending = { provider: 'fwf', section: '', key: '' }; openRescue(c, c.name || ''); },
          });
        }
        return rows;
      },
    });
  }
})();
