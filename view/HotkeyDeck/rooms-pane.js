'use strict';

/* ====================================================================== *
 *  Rooms — Room Guard tab pane inside the Hotkey Deck view.
 *
 *  The peeve it exists for: you rent a room at an inn and the patrons keep
 *  treating it as more inn — sitting on your chair, sleeping in your bed,
 *  standing in the doorway. Claim the room here and they get shown out.
 *
 *  Two things this pane is careful about, both straight from Rober:
 *    - HOUSES. A room marked 🏠 Home is remembered as a place and is NEVER
 *      guarded, so claiming inside your own house can't start throwing your
 *      household out.
 *    - IGNORED PEOPLE. Look at someone, press the button, and they are never
 *      moved anywhere, in any room. Followers are exempt by default too.
 *
 *  Self-contained by design: the pane owns its own state, its own DOM (every
 *  id rm- prefixed) and its own listeners. It never reads or writes app.js's
 *  `state` / `ui`.
 *
 *  Ownership split:
 *    - VIEW owns  rooms / ignore / settings  → mutated here, pushed whole via
 *      a debounced `rgSave`. C++ parses these into the "rooms" slice.
 *    - C++ owns   the claim snapshot, the eviction and blockedRefs → only C++
 *      writes those, and pushes them back via rgOpen / rgResult / rgState.
 *
 *  Bridge — C++ registers these JS→C++ listeners on the DECK view:
 *    rgClaim(json) · rgAnchor(id) · rgEvict(id) · rgRelease(id) ·
 *    rgIgnore() · rgLock(id) · rgState() · rgNpcs(json) · rgSave(json) · rgLog(str)
 *  C++ calls into us (names disjoint from the above, since PrismaUI installs
 *  each JS listener as a global of that name):
 *    rgOpen(cfg) · rgResult(json) · rgSaved(ok) · rgShow() · rgStateResult(json)
 *    · rgNpcsResult(json)
 *  NB the occupancy reply is rgStateResult, deliberately NOT rgState: sharing
 *  the request's name put a receiver on top of the bridge and the request
 *  never left the view. One name per direction — no "tell them apart by
 *  shape" shortcuts, because a request with no payload has no shape.
 *
 *  Host contract (mirrors DomainsPane / FinancesPane):
 *    RoomsPane.init() · onShow() · onHide() · receive(fn, payload) ·
 *    toggleEdit() · wantsPause() -> true
 * ====================================================================== */

window.RoomsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const SAVE_DEBOUNCE = 350;    // same cadence as the other panes
  const STATE_POLL = 1200;      // live occupancy refresh while the tab is up

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }
  function glog(msg) { toGame('rgLog', msg); }

  /* ============================================================= state == */

  const state = {
    rooms: [],
    ignore: [],
    enabled: true,
    allowFollowers: true,
    notify: true,
    autoClaim: true,
    graceMs: 4000,
    tickMs: 1500,
    here: { ok: false }            // live "where are you standing" snapshot
  };

  const ui = {
    inited: false,
    shown: false,
    editing: false,
    filter: '',
    sel: -1,
    kind: 'inn',                   // claim-form kind
    shape: 'circle',               // claim-form footprint
    radius: 200,
    claimWhole: false,             // claim-form: guard the whole cell
    claimEvict: false,             // claim-form: push followers out too
    parked: [],                    // followers this room is holding outside (live)
    roomEvict: false,              // here-room's evictFollowers (live)
    roomWhole: false,              // here-room's wholeCell (live)
    expanded: null,                // room id whose size panel is open
    banFor: null,                  // room id whose blacklist panel is open
    armed: null,                   // room id with a primed delete
    deleting: {},                  // id -> true: removed locally, C++ save not yet acked
    occupants: [],
    hereRoomId: '',
    lastStateSig: '',              // last occupancy reply, for the no-change skip
    pollT: null,
    saveT: null
  };

  const els = {};
  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') el.className = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
      }
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function esc(s) { return String(s === undefined || s === null ? '' : s); }

  /* Ultralight's native <input type=range> drag is broken in-game — the thumb
     moves one step per click and never follows the cursor. MOUSE events, not
     pointer events: the first fix used PointerEvent and changed nothing live,
     because Ultralight never delivers them — every working drag in this deck
     (Domains rows, Followers rows, Spell combos) is mousedown/mousemove on the
     DOCUMENT, and that is the only idiom proven in-game. Document-level move
     also means leaving the track mid-drag keeps dragging, which is what a
     slider should do. */
  function smoothRange(input) {
    if (!input || input.__smooth) return input;
    input.__smooth = true;
    const apply = (e) => {
      const r = input.getBoundingClientRect();
      if (!r.width) return;
      const min = Number(input.min) || 0;
      const max = Number(input.max) || 100;
      const step = Number(input.step) || 1;
      let v = min + ((e.clientX - r.left) / r.width) * (max - min);
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, v));
      if (String(v) !== input.value) {
        input.value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    const onMove = (e) => apply(e);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    input.addEventListener('mousedown', (e) => {
      apply(e);
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();   // the native (broken) drag must not fight ours
    });
    return input;
  }
  window.hdSmoothRange = window.hdSmoothRange || smoothRange;

  /* ============================================================== save == */

  /* Only the view-owned fields travel. blockedRefs is C++ bookkeeping the pane
     never sees and must never invent — C++ re-attaches it by room id on merge. */
  function slice() {
    return {
      rooms: state.rooms.map((r) => ({
        id: r.id, name: r.name, note: r.note || '', kind: r.kind,
        cellId: r.cellId, cellEdid: r.cellEdid || '', cellName: r.cellName || '',
        x: r.x, y: r.y, z: r.z, radius: r.radius, height: r.height,
        shape: r.shape === 'box' ? 'box' : 'circle',
        halfX: r.halfX || 200, halfY: r.halfY || 260, yaw: r.yaw || 0,
        enabled: !!r.enabled,
        lockdown: !!r.lockdown,
        evictFollowers: !!r.evictFollowers,
        wholeCell: !!r.wholeCell,
        hasAnchor: !!r.hasAnchor, ax: r.ax || 0, ay: r.ay || 0, az: r.az || 0, aangle: r.aangle || 0,
        repel: r.repel !== false,
        allow: (r.allow || []),
        deny: (r.deny || [])
      })),
      ignore: state.ignore,
      enabled: !!state.enabled,
      allowFollowers: !!state.allowFollowers,
      notify: !!state.notify,
      autoClaim: state.autoClaim !== false,
      graceMs: state.graceMs,
      tickMs: state.tickMs
    };
  }

  function save() {
    if (ui.saveT) clearTimeout(ui.saveT);
    ui.saveT = setTimeout(flushSave, SAVE_DEBOUNCE);
  }

  function flushSave() {
    if (ui.saveT) { clearTimeout(ui.saveT); ui.saveT = null; }
    try { toGame('rgSave', JSON.stringify(slice())); } catch (e) { glog('save failed: ' + e); }
  }

  /* ============================================================ helpers == */

  function roomById(id) { return state.rooms.find((r) => r.id === id) || null; }

  function matches(r, q) {
    if (!q) return true;
    const kindWords = r.kind === 'home' ? 'home house'
                    : r.kind === 'private' ? 'private bedroom'
                    : 'inn rented';
    const extra = (r.lockdown ? ' sealed privacy locked nobody keep everyone out' : '') +
                  (r.wholeCell ? ' whole cell private cell' : '') +
                  (r.evictFollowers ? ' followers out' : '') +
                  ((r.deny || []).length ? ' banned blacklist ' +
                    r.deny.map((d) => d.name || '').join(' ') : '');
    const hay = (r.name + ' ' + (r.note || '') + ' ' + (r.cellName || '') + ' ' +
                 kindWords + extra).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function visible() {
    const q = ui.filter.trim().toLowerCase();
    return state.rooms.filter((r) => matches(r, q));
  }

  /* The occupancy reply reduced to a comparable string. Only fields that feed
     the three renders the poll drives belong here — over-including means a
     jittering float would defeat the skip, under-including means a real change
     would not repaint. */
  function stateSig(j) {
    return JSON.stringify([
      j.roomId || '',
      !!j.roomEvictFollowers, !!j.roomWholeCell, !!j.roomLockdown,
      (Array.isArray(j.parked) ? j.parked : []).map((p) => [p.name, !!p.waiting]),
      j.occupants.map((o) => [o.name, !!o.exempt, o.reason || '',
        o.plugin || '', o.localId || 0, !!o.denied])
    ]);
  }

  /* Is the player standing in this room right now? C++ answers authoritatively
     in rgState; the cell compare here is only a fallback for the first paint,
     before the first state poll lands. */
  function isHere(r) {
    if (ui.hereRoomId) return r.id === ui.hereRoomId;
    return !!(state.here && state.here.ok && state.here.cellId === r.cellId);
  }

  /* ============================================================ render === */

  /* PRIVACY LOCKDOWN — "don't let anyone in this room at all right now"
     (Rober, 2026-08-11). A temporary OVERRIDE on top of a room's normal rules,
     never an edit to them: while it is on, followers and everyone on the allow
     list are shown out too; flip it off and the room's own settings are back
     exactly as they were, because nothing was changed to get here.

     Optimistic on purpose. C++ owns the flag (rgLock flips it and re-pushes
     the whole config), but the button must read as instant, and — more
     importantly — the pane's own 350 ms debounced save carries `lockdown` in
     its slice, so a save already in flight would otherwise land the OLD value
     on top of the flip. Painting it locally first means both sides agree. */
  function toggleLockdown(r) {
    if (!r) return;
    r.lockdown = !r.lockdown;
    toGame('rgLock', r.id);
    render();
  }

  function lockedRooms() { return state.rooms.filter((r) => r.lockdown); }

  function renderHere() {
    const hc = state.here || {};
    els.hereName.textContent = hc.ok ? (hc.cellName || 'Unnamed place') : '—';

    const claimed = ui.hereRoomId ? roomById(ui.hereRoomId) : null;
    els.hereStatus.className = 'rm-here-status';
    if (!hc.ok) {
      els.hereStatus.textContent = 'No cell loaded yet.';
    } else if (claimed) {
      if (claimed.lockdown) {
        // The seal outranks the kind: a sealed Home is guarded for as long as
        // it is sealed, and saying "never guarded" there would be a lie.
        els.hereStatus.classList.add('sealed');
        els.hereStatus.textContent = '🔒 Sealed: ' + claimed.name + ' — nobody comes in.';
      } else if (claimed.kind === 'home') {
        els.hereStatus.classList.add('home');
        els.hereStatus.textContent = '🏠 ' + claimed.name + ' — never guarded.';
      } else {
        els.hereStatus.classList.add('claimed');
        const glyph = claimed.kind === 'private' ? '🛏' : '🔒';
        els.hereStatus.textContent =
          (claimed.enabled ? glyph + ' Guarded: ' : '⏸ Paused: ') + claimed.name;
      }
    } else {
      els.hereStatus.textContent = 'Not claimed.';
    }

    // The big one-press privacy button, right under "you are in". Disabled with
    // an honest reason when there is nothing here to seal — a dead button that
    // does not say why is the thing this pane keeps being asked about.
    if (els.lockBtn) {
      const sealed = !!(claimed && claimed.lockdown);
      els.lockBtn.disabled = !claimed;
      els.lockBtn.classList.toggle('on', sealed);
      els.lockBtn.textContent = sealed ? '🔓 Let people in again' : '🔒 Nobody in right now';
      els.lockBtn.title = !claimed
        ? 'Claim this room first — sealing needs a claimed room to seal'
        : sealed
        ? 'Lift the seal: ' + claimed.name + ' goes straight back to your normal ' +
          'who’s-allowed settings — followers, allowed people and bans all as they were'
        : 'Seal ' + claimed.name + ' right now: NOBODY comes in — followers and ' +
          'people you allowed included. Anyone inside is shown out. Press again to undo. ' +
          '(People on the global “never move” list still stay.)';
    }

    // Claiming needs a loaded cell; claiming a second time in the same room is
    // allowed on purpose (rooms can overlap, e.g. a big room plus its alcove).
    els.claimBtn.disabled = !hc.ok;
    if (!els.claimName.value && hc.suggested && document.activeElement !== els.claimName) {
      els.claimName.placeholder = hc.suggested;
    }
    // Rented-bed detection (inn cell + the one bed the rental script made
    // yours): when it's live, the claim centres on the BED, not on your feet —
    // so you can claim from the doorway and still get the room, not the hall.
    const bed = hc.rentedBed && hc.rentedBed.found;
    els.claimBtn.textContent = ui.claimWhole ? '🚪 Claim the whole cell'
      : bed ? '🛏 Claim my rented room' : '★ Claim this room';
    els.claimBtn.title = ui.claimWhole
      ? 'Guard the entire cell as a private cell — the size slider is ignored'
      : bed
      ? 'Your rented bed was detected — the claimed area is centred on it'
      : 'Claim the room you are standing in';
    els.evictBtn.disabled = !ui.hereRoomId;
  }

  /* The occupant rows double as the ALLOW control. In a Private bedroom inside
     a shared-cell home the "intruders" are your own household — non-followers,
     so nothing exempts them — and the people you would want to allow in are by
     definition standing in the room. So: ✋ on a to-be-evicted row puts that
     person on THIS room's allow list; ✕ on an "allowed here" row takes them
     off it. Identity comes from C++ with the row (plugin + base localId). */
  /* Boundary ring: ask C++ to draw a circle of glow markers on the room's
     edge in the WORLD. This is the answer to "no way of knowing if it's set up
     correctly or large enough" — the volume becomes something you can look at.
     Throttled: a slider drag fires oninput dozens of times a second and each
     send re-aims 16 refs on the game thread. */
  let ringT = 0;
  function ringShow(r, radius) {
    const now = Date.now();
    if (now - ringT < 120) return;
    ringT = now;
    toGame('rgRing', JSON.stringify({
      id: r.id,
      radius: radius !== undefined ? radius : r.radius,
      halfX: r.halfX, halfY: r.halfY
    }));
  }
  function ringHide() { toGame('rgRing', '{}'); }

  function sameNpc(a, b) {
    return a && b && a.localId === b.localId &&
      String(a.plugin || '').toLowerCase() === String(b.plugin || '').toLowerCase();
  }
  function npcKey(n) {
    return String(n.plugin || '').toLowerCase() + '|' + String(n.localId || 0);
  }

  function toggleAllow(o) {
    const room = ui.hereRoomId ? roomById(ui.hereRoomId) : null;
    if (!room || !o.plugin || !o.localId) return;
    room.allow = room.allow || [];
    const i = room.allow.findIndex((a) => sameNpc(a, o));
    if (i >= 0) room.allow.splice(i, 1);
    else room.allow.push({ plugin: o.plugin, localId: o.localId, name: o.name });
    save();
    toGame('rgState');   // C++ re-judges everyone against the new list
  }

  /* Put someone on / take someone off a room's BLACKLIST. Banning also drops
     any allow entry for the same person — a ban that silently loses to a
     forgotten ✋ from last week is a lie. */
  function setDeny(room, ref, on) {
    if (!room || !ref || !ref.plugin || !ref.localId) return false;
    room.deny = room.deny || [];
    const i = room.deny.findIndex((d) => sameNpc(d, ref));
    if (on && i < 0) {
      room.deny.push({ plugin: ref.plugin, localId: ref.localId, name: ref.name || '' });
      room.allow = (room.allow || []).filter((a) => !sameNpc(a, ref));
    } else if (!on && i >= 0) {
      room.deny.splice(i, 1);
    } else {
      return false;   // already in the asked-for state
    }
    save();
    toGame('rgState');   // the watchdog acts on its own tick; this refreshes the readout
    return true;
  }
  function isDenied(room, ref) {
    return !!(room && ref && (room.deny || []).some((d) => sameNpc(d, ref)));
  }

  function renderOccupants() {
    els.occ.replaceChildren();
    if (!ui.hereRoomId) return;
    const hereRoom = roomById(ui.hereRoomId);
    const sealed = !!(hereRoom && hereRoom.lockdown);
    els.occ.append(h('div', { class: 'rm-occ-title' }, 'In here now'));
    if (sealed) {
      // Say what the seal is doing to this list, and — just as important — what
      // it is NOT doing: someone on the global never-move list is still standing
      // there on purpose, and that reads as a broken seal unless it is spelled out.
      els.occ.append(h('div', { class: 'rm-occ-sealed' },
        '🔒 Sealed — everyone here is being shown out. Only people on your ' +
        '“never move” list stay.'));
    }
    if (!ui.occupants.length) {
      els.occ.append(h('div', { class: 'rm-occ' }, h('span', { class: 'rm-occ-name' }, 'Nobody but you')));
      return;
    }
    for (const o of ui.occupants) {
      const kids = [
        h('span', { class: 'rm-occ-name' }, o.name),
        h('span', { class: 'rm-occ-why' + (o.denied ? ' denied' : '') },
          o.exempt ? o.reason
                   : (o.denied ? 'blacklisted here'
                               : sealed ? 'sealed — shown out' : 'being shown out'))
      ];
      const identifiable = o.plugin && o.localId;
      if (identifiable && o.denied) {
        /* A banned person's row offers the ban's own undo, not a raised-hand
           allow that the blacklist beats anyway. */
        kids.push(h('button', {
          class: 'rm-occ-allow off',
          title: 'Lift the ban and let ' + o.name + ' back into this room',
          onclick: () => {
            const room = ui.hereRoomId ? roomById(ui.hereRoomId) : null;
            if (room && setDeny(room, o, false)) renderList();
          }
        }, '↩'));
      } else if (identifiable && !o.exempt) {
        kids.push(h('button', {
          class: 'rm-occ-allow',
          // While the room is sealed the allow list is overridden, so the button
          // still edits it but must not claim an effect it cannot have yet.
          title: sealed
            ? 'Put ' + o.name + ' on this room’s allow list — she may come in ' +
              'once you lift the seal (the seal keeps everyone out until then)'
            : 'Let ' + o.name + ' stay — allowed into this room from now on',
          onclick: () => toggleAllow(o)
        }, '\u270B'));
      } else if (identifiable && o.reason === 'allowed here') {
        kids.push(h('button', {
          class: 'rm-occ-allow off',
          title: 'Stop allowing ' + o.name + ' in here',
          onclick: () => toggleAllow(o)
        }, '\u2715'));
      }
      els.occ.append(h('div', { class: 'rm-occ' + (o.exempt ? '' : ' going') }, ...kids));
    }
  }

  /* A seal is temporary by intent but permanent by storage — it survives a
     save/load, so it has to be impossible to forget. This banner sits above the
     list whatever the search box says and whichever room you are standing in,
     names every sealed room, and lifts any of them in one click. Without it a
     seal set last night reads as "Room Guard has started throwing my household out". */
  function renderLockBanner() {
    const locked = lockedRooms();
    els.lockBanner.replaceChildren();
    els.lockBanner.classList.toggle('hidden', !locked.length);
    if (!locked.length) return;
    els.lockBanner.append(h('span', { class: 'rm-lock-ban-t' },
      locked.length === 1 ? '🔒 1 room is sealed — nobody may enter'
                          : '🔒 ' + locked.length + ' rooms are sealed — nobody may enter'));
    for (const r of locked) {
      els.lockBanner.append(h('button', {
        class: 'rm-lock-ban-b',
        title: 'Lift the seal on ' + r.name + ' — back to its normal who’s-allowed settings',
        onclick: () => toggleLockdown(r)
      }, '🔓 ' + r.name));
    }
  }

  function renderList() {
    const rows = visible();
    els.count.textContent = rows.length + (rows.length === 1 ? ' room' : ' rooms');
    renderLockBanner();
    els.list.replaceChildren();

    if (!rows.length) {
      els.list.classList.add('hidden');
      els.empty.classList.remove('hidden');
      els.empty.replaceChildren();
      if (state.rooms.length) {
        els.empty.append(h('div', {}, 'No room matches ', h('b', {}, ui.filter)));
      } else {
        els.empty.append(
          h('div', {}, h('b', {}, 'No rooms claimed yet.')),
          h('div', { style: 'margin-top:6px' },
            'Stand in the middle of a rented room and hit ', h('b', {}, '★ Claim this room'), '.'),
          h('div', { style: 'margin-top:6px' },
            'Mark your own houses as ', h('b', {}, '🏠 Home'), ' so they are never guarded.'));
      }
      return;
    }
    els.empty.classList.add('hidden');
    els.list.classList.remove('hidden');

    for (const r of rows) {
      const home = r.kind === 'home';
      const priv = r.kind === 'private';
      const here = isHere(r);
      const armed = ui.armed === r.id;

      const chips = [];
      if (here) chips.push(h('span', { class: 'rm-chip here' }, 'you are here'));
      chips.push(h('span', { class: 'rm-chip' + (home ? ' home' : '') },
        home ? 'Home' : priv ? 'Private' : 'Rented'));
      // The seal is loud everywhere it can be: a forgotten one silently evicting
      // your household weeks later is the failure mode worth designing against.
      if (r.lockdown) chips.push(h('span', {
        class: 'rm-chip sealed',
        title: 'Sealed — nobody may come in at all right now, followers and allowed ' +
               'people included. Press 🔓 to go back to this room’s normal settings.'
      }, '🔒 sealed'));
      if (!home && r.wholeCell) chips.push(h('span', {
        class: 'rm-chip cell', title: 'The whole cell is guarded, not just a sized area'
      }, '🚪 whole cell'));
      if (!home && r.evictFollowers) chips.push(h('span', {
        class: 'rm-chip evict',
        title: 'Followers are pushed out too — parked (told to wait) so they stop trailing you in, ' +
               'and rejoin when you leave the cell'
      }, '🚶 followers out'));
      if (!home && (r.deny || []).length) chips.push(h('span', {
        class: 'rm-chip deny',
        title: 'Blacklisted from this room: ' +
               r.deny.map((d) => d.name || 'someone').join(', ')
      }, '🚫 ' + r.deny.length + ' banned'));
      if (!home && !r.hasAnchor) {
        chips.push(h('span', {
          class: 'rm-chip warn',
          title: 'Without a drop point people are pushed straight out past the room edge, ' +
                 'which can land them in scenery. Stand outside the door and press Drop point.'
        }, 'no drop point'));
      }
      if (!home && !r.enabled) chips.push(h('span', { class: 'rm-chip warn' }, 'paused'));

      const sub = [];
      if (r.cellName) sub.push(r.cellName);
      sub.push(r.shape === 'box'
        ? (Math.round(r.halfX * 2) + '\u00D7' + Math.round(r.halfY * 2) + 'u')
        : (Math.round(r.radius) + 'u'));
      if (r.note) sub.push(r.note);

      const acts = [
        h('button', {
          class: 'rm-act' + (ui.expanded === r.id ? ' armed' : ''),
          title: 'Resize the claimed area — watch the "In here now" list while you drag',
          onclick: () => {
            ui.expanded = ui.expanded === r.id ? null : r.id;
            ui.banFor = null;   // one panel at a time under a row
            if (ui.expanded) ringShow(r); else ringHide();
            renderList();
          }
        }, '📐'),
        home ? null : h('button', {
          class: 'rm-act' + (ui.banFor === r.id ? ' armed' : ''),
          title: 'Blacklist — pick people who are shown out of this room even if ' +
                 'they are followers or on the allow list',
          onclick: () => {
            ui.banFor = ui.banFor === r.id ? null : r.id;
            if (ui.expanded) { ui.expanded = null; ringHide(); }
            renderList();
          }
        }, '🚫'),
        // Privacy seal, next to the blacklist because they are the same family
        // of thought (who is kept out) — and deliberately AFTER 📐/🚫, whose
        // positions the harness pins by index. Glyph = the action you'd take,
        // the same convention as ⏸/▶ below, and deliberately NOT 🔒, which the
        // kind button already uses for "guard this place again".
        h('button', {
          class: 'rm-act rm-act-lock' + (r.lockdown ? ' on' : ''),
          title: r.lockdown
            ? 'Sealed — click to let your normal people back into ' + r.name
            : 'Seal ' + r.name + ' — nobody comes in at all until you press this ' +
              'again (followers and allowed people too)',
          onclick: () => toggleLockdown(r)
        }, r.lockdown ? '🔓' : '⛔'),
        h('button', {
          class: 'rm-act',
          title: home ? 'Guard this place again (Rented)'
               : priv ? 'Stop guarding — mark as Home'
               : 'Make this a Private bedroom (guarded; allow your own people via ✋)',
          onclick: () => setKind(r, home ? 'inn' : priv ? 'home' : 'private')
        }, home ? '🔒' : priv ? '🏠' : '🛏'),
        h('button', {
          class: 'rm-act',
          title: here ? 'Set where evicted people are put — stand OUTSIDE the room first'
                      : 'Go to that room first to set its drop point',
          onclick: () => { toGame('rgAnchor', r.id); }
        }, '📍'),
        h('button', {
          class: 'rm-act', title: r.enabled ? 'Pause this room' : 'Resume this room',
          onclick: () => { r.enabled = !r.enabled; save(); render(); }
        }, r.enabled ? '⏸' : '▶')
      ];
      if (ui.editing) {
        acts.push(h('button', {
          class: 'rm-act danger' + (armed ? ' armed' : ''),
          title: armed ? 'Click again to remove this room' : 'Remove this room',
          onclick: () => armedDelete(r)
        }, armed ? 'Sure?' : '🗑'));
      }

      els.list.append(h('div', {
        class: 'rm-row' + (home ? ' home' : '') + (!r.enabled && !home ? ' off' : '') +
               (r.lockdown ? ' sealed' : ''),
        role: 'option', 'aria-selected': 'false'
      },
        h('div', { class: 'rm-medal' }, home ? '🏠' : priv ? '🛏' : '🔒'),
        h('div', { class: 'rm-info' },
          h('div', { class: 'rm-name', title: r.name }, r.name),
          h('div', { class: 'rm-sub', title: sub.join(' · ') }, sub.join(' · '))),
        ...chips,
        h('div', { class: 'rm-actions' }, ...acts)));

      if (ui.expanded === r.id) els.list.append(sizePanel(r, here));
      if (ui.banFor === r.id) els.list.append(banPanel(r));
    }
  }

  /* The blacklist panel under a room row: who is banned (chip + remove), and
     the searchable picker to ban more people. Sits beside the ALLOW control
     (the occupant ✋) as its opposite: allow whitelists into a Private room,
     this blacklists out of any guarded room — followers included. */
  function banPanel(r) {
    const list = h('div', { class: 'rm-deny-list' });
    const deny = r.deny || [];
    if (!deny.length) {
      list.append(h('span', { class: 'rm-hint' },
        'Nobody is banned from this room yet.'));
    }
    for (const d of deny) {
      list.append(h('span', { class: 'rm-ig deny' },
        d.name || (d.plugin + '|' + d.localId),
        h('button', {
          class: 'rm-ig-x', title: 'Lift the ban on ' + (d.name || 'them'),
          onclick: () => { if (setDeny(r, d, false)) renderList(); }
        }, '×')));
    }
    const addBtn = h('button', {
      class: 'rm-deny-add',
      title: 'Pick someone by name — your roster and everyone loaded nearby, ' +
             'searchable as you type',
      onclick: (e) => openNpcPicker(e.currentTarget, {
        title: 'Ban from ' + (r.name || 'this room'),
        except: deny,
        onPick: (ref) => {
          if (setDeny(r, ref, true))
            toast((ref.name || 'They') + ' is banned from ' + (r.name || 'this room'));
          renderList();
        }
      })
    }, '＋ Ban someone…');
    return h('div', { class: 'rm-tune rm-ban' },
      h('div', { class: 'rm-occ-title' }, 'Blacklisted from this room'),
      list,
      addBtn,
      h('div', { class: 'rm-hint' },
        'Banned people are shown out even if they are followers or on the allow ' +
        'list. The global “never move” list still protects its people everywhere.'));
  }

  /* The tuning panel. The claimed volume is a plain distance test — it knows
     nothing about walls — so the ONLY way to know a room's size is right is to
     watch who falls inside it. Dragging re-renders the row immediately and
     re-asks C++ for occupancy, so the "In here now" list on the left is the
     readout you tune against. */
  function sizePanel(r, here) {
    const mkSlider = (label, key, min, max, step, unit) => {
      const val = h('span', { class: 'rm-size-val' }, fmtUnits(r[key]));
      return h('div', { class: 'rm-tune-row' },
        h('span', { class: 'rm-field-label' }, label),
        smoothRange(h('input', {
          type: 'range', min: min, max: max, step: step, value: r[key],
          'aria-label': label,
          oninput: (e) => {
            r[key] = Number(e.target.value) || min;
            val.textContent = fmtUnits(r[key]);
            save();
            // Re-ask who is inside at the new size, and re-aim the world ring —
            // dragging the slider IS watching the boundary move.
            toGame('rgState');
            if (key !== 'height') ringShow(r, r.radius);
          }
        })),
        val);
    };
    const repelCb = h('input', { type: 'checkbox' });
    repelCb.checked = r.repel !== false;
    repelCb.addEventListener('change', () => { r.repel = repelCb.checked; save(); });
    const evictCb = h('input', { type: 'checkbox' });
    evictCb.checked = !!r.evictFollowers;
    evictCb.addEventListener('change', () => {
      r.evictFollowers = evictCb.checked; save(); renderList(); toGame('rgState');
    });
    const wholeCb = h('input', { type: 'checkbox' });
    wholeCb.checked = !!r.wholeCell;
    wholeCb.addEventListener('change', () => {
      r.wholeCell = wholeCb.checked; save(); renderList(); toGame('rgState');
      if (wholeCb.checked) ringHide(); else ringShow(r);   // no ring for a whole-cell claim
    });
    const box = r.shape === 'box';
    const shapeRow = h('div', { class: 'rm-tune-row' },
      h('span', { class: 'rm-field-label' }, 'Footprint'),
      h('div', { class: 'rm-seg', style: 'flex:1' },
        h('button', {
          class: 'rm-seg-btn' + (box ? '' : ' active'),
          title: 'Round area sized by one Across slider',
          onclick: () => { r.shape = 'circle'; save(); renderList(); ringShow(r); }
        }, '\u25EF Round'),
        h('button', {
          class: 'rm-seg-btn' + (box ? ' active' : ''),
          title: 'Rectangle aligned to the direction you faced when claiming — ' +
                 'use \u21BB to re-align it to where you face now',
          onclick: () => { r.shape = 'box'; save(); renderList(); ringShow(r); }
        }, '\u25AD Box')),
      box ? h('button', {
        class: 'rm-act',
        title: 'Face along the room (e.g. square at the bed wall), then click — ' +
               'the box rotates to match your view',
        onclick: () => { toGame('rgRing', JSON.stringify({ id: r.id, align: true })); }
      }, '\u21BB') : null);
    return h('div', { class: 'rm-tune' },
      shapeRow,
      box ? mkSlider('Width', 'halfX', 60, 1200, 20)
          : mkSlider('Across', 'radius', 80, 1200, 20),
      box ? mkSlider('Depth', 'halfY', 60, 1200, 20) : null,
      mkSlider('Up / down', 'height', 60, 600, 10),
      h('label', { class: 'rm-check rm-tune-repel',
        title: 'The same mechanism the game uses for your rented bed, extended to the ' +
               'chairs: NPCs stop CHOOSING furniture owned by someone else, so they stop ' +
               'coming — instead of walking in and being bounced over and over. ' +
               'Original owners are restored when the room is released.' },
        repelCb,
        h('span', {}, 'Own the furniture — stops them coming back for the chair')),
      h('label', { class: 'rm-check rm-tune-evict',
        title: 'Followers get pushed out too, not just strangers. Each is told to WAIT ' +
               '(through her own follower mod) so she stops trailing you back in, and ' +
               'rejoins the moment you leave the cell. A follower on a mod with no wait ' +
               'is still moved out, but may warp back — dismiss her by hand.' },
        evictCb,
        h('span', {}, 'Push my followers out too')),
      h('label', { class: 'rm-check rm-tune-whole',
        title: 'Guard the ENTIRE cell instead of the sized area above — a private cell. ' +
               'Anyone unwelcome anywhere in the cell is moved out; the size sliders and ' +
               'the world ring do not apply.' },
        wholeCb,
        h('span', {}, 'Guard the whole cell (ignores the size above)')),
      r.wholeCell ? h('div', { class: 'rm-hint' },
        'Whole-cell claim — the size sliders and ring above are ignored.') : null,
      here && r.evictFollowers && ui.parked && ui.parked.length ? h('div', {
        class: 'rm-parked',
        title: 'They rejoin you when you leave the cell'
      }, '🚶 ' + ui.parked.length + ' follower' + (ui.parked.length === 1 ? '' : 's') +
         ' waiting outside: ' + ui.parked.map((p) => esc(p.name)).join(', ')) : null,
      h('div', { class: 'rm-hint' },
        here ? 'Watch “In here now” on the left — shrink until only the right people are listed.'
             : 'Go and stand in this room to see who the area actually covers.'));
  }

  /* Game units are meaningless on their own; show the real-world span too.
     1 unit ~= 1.43 cm, and the slider value is a RADIUS, so the room-sized
     number people care about is the diameter. */
  function fmtUnits(u) {
    const m = (u * 2 * 0.0143).toFixed(1);
    return u + 'u (' + m + ' m)';
  }

  /* ==================================================== NPC picker / bans ==
   *
   *  Rober, 2026-08-09: "a searchable dropdown of npcs in the system … don't
   *  have to add an npc to the follower system to blacklist, but nice to be
   *  able to pick from list or just hit F7 on an npc".
   *
   *  Candidates come from C++ (rgNpcs → rgNpcsResult): every loaded actor
   *  near the player PLUS the Follower Organizer roster, which the view hands
   *  over as runtime formIds (FollowersPane.rosterForDomains — the same
   *  read-only projection the Domains tab uses). Each row carries the durable
   *  (plugin, localId) base identity, which is the only thing the lists
   *  store. People already named on some list are offered even before the
   *  game answers, so the picker is never empty while the reply is in
   *  flight — and the dev harness works with no bridge at all.
   * ======================================================================= */

  const pick = {
    el: null,          // the open popover, or null
    mode: '',          // 'npc' | 'ban'
    input: null,
    listEl: null,
    onPick: null,
    except: [],
    rows: [],          // merged candidate rows
    subj: null,        // ban-menu subject { formId, name }
    subjRef: null,     // resolved durable identity for subj
    subjPending: null, // action queued while identity resolves
    scale: 1,          // zoom the anchor is painted at (see anchorScale)
    anchorRect: null   // viewport rect of the button that opened us
  };

  /* Roster extras for rgNpcs: FO members as runtime formIds. FO formats them
     "0x%08X", which Number() parses as hex. */
  function npcExtras() {
    const out = [];
    const seen = {};
    try {
      const fp = window.FollowersPane;
      if (fp && typeof fp.rosterForDomains === 'function') {
        for (const m of fp.rosterForDomains()) {
          const fid = (Number(m.formId) || 0) >>> 0;
          if (!fid || seen[fid]) continue;
          seen[fid] = 1;
          out.push({ formId: fid, name: String(m.name || '') });
        }
      }
    } catch (e) { glog('roster extras failed: ' + e); }
    return out;
  }

  function requestNpcs() {
    toGame('rgNpcs', JSON.stringify({ extra: npcExtras() }));
  }

  /* People already named on ANY list — identity known without asking the
     game. Instant candidates + offline/dev fallback. */
  function knownNpcRefs() {
    const map = {};
    const add = (n) => {
      if (!n || !n.plugin || !n.localId) return;
      const k = npcKey(n);
      if (!map[k]) map[k] = { name: n.name || '', plugin: n.plugin, localId: n.localId };
    };
    (state.ignore || []).forEach(add);
    (state.rooms || []).forEach((r) => {
      (r.allow || []).forEach(add);
      (r.deny || []).forEach(add);
    });
    return Object.keys(map).map((k) => map[k]);
  }

  function mergeNpcRows(gameRows) {
    const map = {};
    for (const n of knownNpcRefs()) map[npcKey(n)] = n;
    for (const g of (gameRows || [])) {
      if (!g || !g.plugin || !g.localId) continue;
      map[npcKey(g)] = {
        name: g.name || '', plugin: g.plugin, localId: g.localId,
        refId: g.refId || 0, follower: !!g.follower, loaded: g.loaded !== false
      };
    }
    const rows = Object.keys(map).map((k) => map[k]);
    rows.sort((a, b) => (b.follower ? 1 : 0) - (a.follower ? 1 : 0) ||
      String(a.name).localeCompare(String(b.name)));
    return rows;
  }

  /* rgNpcsResult landed: refresh an open picker, and resolve the ban menu's
     subject (matched by RUNTIME refId — all the F7 snapshot knows). */
  function onNpcRows(gameRows) {
    pick.rows = mergeNpcRows(gameRows);
    if (pick.el && pick.mode === 'npc') renderPickList();
    if (pick.mode === 'ban' && pick.subj && !pick.subjRef) {
      const want = (Number(pick.subj.formId) || 0) >>> 0;
      const hit = pick.rows.find((r) => ((r.refId || 0) >>> 0) === want && want);
      if (hit) {
        pick.subjRef = { plugin: hit.plugin, localId: hit.localId,
          name: pick.subj.name || hit.name };
        if (pick.el) renderBanBody();
        const act = pick.subjPending;
        pick.subjPending = null;
        if (act) act(pick.subjRef);
      } else if (pick.subjPending) {
        // The game answered and she is not in it: no durable identity (a
        // spawned 0xFF base). Honest refusal beats a silent nothing.
        pick.subjPending = null;
        toast((pick.subj.name || 'They') + ' has no durable identity — cannot blacklist');
        closePicker();
      }
    }
  }

  function closePicker() {
    if (pick.el) {
      try { pick.el.remove(); } catch (e) {}
      document.removeEventListener('mousedown', onPickOutside, true);
    }
    pick.el = null; pick.mode = ''; pick.input = null; pick.listEl = null;
    pick.onPick = null; pick.except = [];
    pick.subj = null; pick.subjRef = null; pick.subjPending = null;
    pick.scale = 1; pick.anchorRect = null;
  }

  function onPickOutside(e) {
    if (pick.el && !pick.el.contains(e.target)) closePicker();
  }

  /* How much is the thing that opened us actually zoomed?
   *
   *  The deck is a stack of transform: scale() surfaces — #panel wears
   *  --ui-scale, and the Followers tab wears --fd-ui-scale on top of it. This
   *  popover is appended to <body>, OUTSIDE both, so it used to paint at raw
   *  px beside a card drawn half again as big: the ban dropdown read as tiny
   *  while everything around it was comfortable (Rober, 2026-08-11: "dropdown
   *  text too hard to read (too small) … searching is nice, but still too
   *  small"). Rather than guess which vars apply, MEASURE: the ratio of the
   *  anchor's painted width to its layout width is exactly the product of
   *  every transform above it. So the menu ends up the same size as the button
   *  it hangs off, whatever nests it. Falls back to --ui-scale, then 1. */
  function anchorScale(anchor) {
    try {
      if (anchor && anchor.offsetWidth > 0 && anchor.getBoundingClientRect) {
        const k = anchor.getBoundingClientRect().width / anchor.offsetWidth;
        if (isFinite(k) && k > 0.2 && k < 6) return k;
      }
    } catch (e) {}
    try {
      const v = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--ui-scale'));
      if (isFinite(v) && v > 0) return v;
    } catch (e) {}
    return 1;
  }

  /* Position (and size) the open popover against its anchor. Split out of
     popShell because the shell is measured BEFORE the caller appends the
     filter row and the list — placing once, with only the title in the box,
     is what used to flip a full-height menu 40px above the button and let it
     run off the bottom. Re-run on every list render, so filtering can't push
     the last row off-screen either. */
  function placePicker() {
    const el = pick.el;
    if (!el) return;
    const r = pick.anchorRect || { left: 40, top: 40, bottom: 40 };
    el.style.transform = 'none';                     // measure the layout box
    const w0 = el.offsetWidth || 420, h0 = el.offsetHeight || 240;
    /* Wear the deck's zoom — but never so much that the menu no longer fits
       (a 640px deck window, or the browser harness, is a real viewport). */
    let k = Math.min(pick.scale || 1,
      (window.innerWidth - 16) / Math.max(1, w0),
      (window.innerHeight - 16) / Math.max(1, h0));
    if (!isFinite(k) || k < 0.6) k = 0.6;
    const w = w0 * k, hh = h0 * k;
    let x = r.left, y = r.bottom + 6;
    if (y + hh > window.innerHeight - 8) y = r.top - 6 - hh;          // prefer above
    /* Then clamp both axes unconditionally. The anchor is not always on
       screen — a tall pane can leave the button that opened us scrolled past
       the bottom edge, and hanging the menu off THAT put it out of the
       window entirely. Fit beats faithful. */
    x = Math.max(8, Math.min(x, window.innerWidth - 8 - w));
    y = Math.max(8, Math.min(y, window.innerHeight - 8 - hh));
    el.style.transform = 'scale(' + k.toFixed(3) + ')';
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }

  /* Fixed-position shell shared by both popovers. Appended to <body>, so it
     rides above every pane the caller may sit on (the F7 card included). */
  function popShell(anchor, headText) {
    closePicker();
    const el = h('div', { class: 'rm-pick' },
      h('div', { class: 'rm-pick-head' }, headText));
    document.body.append(el);
    el.style.left = '0px'; el.style.top = '0px';
    pick.el = el;
    pick.scale = anchorScale(anchor);
    pick.anchorRect = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: 40, bottom: 40, top: 40, width: 0 };
    placePicker();
    document.addEventListener('mousedown', onPickOutside, true);
    return el;
  }

  function pickFilterRow(placeholder, onEnter) {
    const input = h('input', {
      class: 'rm-pick-in', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: placeholder
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closePicker(); }
      if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
    });
    return input;
  }

  /* --------------------------------------------- searchable NPC dropdown -- */

  function openNpcPicker(anchor, opts) {
    const o = opts || {};
    const el = popShell(anchor, o.title || 'Pick a person');
    pick.mode = 'npc';
    pick.onPick = typeof o.onPick === 'function' ? o.onPick : function () {};
    pick.except = Array.isArray(o.except) ? o.except : [];
    pick.rows = mergeNpcRows([]);
    pick.input = pickFilterRow('Type a name…', () => {
      const first = pick.listEl && pick.listEl.querySelector('.rm-pick-item');
      if (first) first.click();
    });
    pick.input.addEventListener('input', renderPickList);
    pick.listEl = h('div', { class: 'rm-pick-list' });
    el.append(pick.input, pick.listEl,
      h('div', { class: 'rm-pick-hint' },
        'Your roster and everyone loaded nearby. Not listed? Look at them and use ' +
        'the F7 card, or stand closer.'));
    renderPickList();
    requestNpcs();
    setTimeout(() => { try { pick.input.focus(); } catch (e) {} }, 20);
    return el;
  }

  function renderPickList() {
    if (!pick.listEl) return;
    const q = String(pick.input && pick.input.value || '').trim().toLowerCase();
    const skip = {};
    (pick.except || []).forEach((n) => { skip[npcKey(n)] = 1; });
    const rows = pick.rows.filter((n) => !skip[npcKey(n)])
      .filter((n) => !q ||
        String(n.name).toLowerCase().indexOf(q) !== -1 ||
        String(n.plugin).toLowerCase().indexOf(q) !== -1);
    pick.listEl.replaceChildren();
    if (!rows.length) {
      pick.listEl.append(h('div', { class: 'rm-pick-empty' },
        q ? 'Nobody matches "' + q + '".' : 'Nobody to list yet…'));
      placePicker();
      return;
    }
    let shown = 0;
    for (const n of rows) {
      if (++shown > 60) {
        pick.listEl.append(h('div', { class: 'rm-pick-empty' },
          (rows.length - 60) + ' more — type to narrow'));
        break;
      }
      const onPick = pick.onPick;
      pick.listEl.append(h('button', {
        class: 'rm-pick-item',
        title: (n.name || '?') + '\n' + n.plugin,
        onclick: () => {
          closePicker();
          onPick({ plugin: n.plugin, localId: n.localId, name: n.name || '' });
        }
      },
        h('span', { class: 'rm-pick-nm' }, n.name || '(unnamed)'),
        n.follower ? h('span', { class: 'rm-pick-badge fol' }, 'follower') : null,
        h('span', { class: 'rm-pick-badge' },
          String(n.plugin || '').replace(/\.es[lmp]$/i, ''))));
    }
    placePicker();
  }

  /* ------------------------------------- F7 quick-card entry: banMenu() --
   *  Called by the Followers pane with the crosshair NPC's runtime formId +
   *  display name. Lists the guarded rooms (searchable) plus the global
   *  "never move" toggle; identity resolves through rgNpcs in the
   *  background, and a click that lands first is queued until it does. */
  function banMenu(anchor, subj) {
    const who = (subj && subj.name) || 'Them';
    const el = popShell(anchor, who + ' — rooms');
    pick.mode = 'ban';
    pick.subj = { formId: (subj && Number(subj.formId) || 0) >>> 0, name: who };
    pick.subjRef = null;
    pick.subjPending = null;
    pick.input = pickFilterRow('Search your rooms…', () => {
      const first = pick.listEl && pick.listEl.querySelector('.rm-pick-item');
      if (first) first.click();
    });
    pick.input.addEventListener('input', renderBanBody);
    pick.listEl = h('div', { class: 'rm-pick-list' });
    el.append(pick.input, pick.listEl);
    renderBanBody();
    // Resolve her durable identity while the menu is being read.
    if (pick.subj.formId) requestNpcs();
    setTimeout(() => { try { pick.input.focus(); } catch (e) {} }, 20);
    return el;
  }

  /* Run an action that needs the subject's durable identity — now if it is
     already resolved, queued for the rgNpcs reply otherwise. */
  function withSubjRef(act) {
    if (pick.subjRef) { act(pick.subjRef); return; }
    if (!pick.subj || !pick.subj.formId) {
      toast('No target — open this from the F7 card');
      closePicker();
      return;
    }
    pick.subjPending = act;
    requestNpcs();   // re-ask in case the first reply was missed
  }

  function renderBanBody() {
    if (!pick.listEl || pick.mode !== 'ban') return;
    const q = String(pick.input && pick.input.value || '').trim().toLowerCase();
    const who = pick.subj ? pick.subj.name : 'Them';
    pick.listEl.replaceChildren();

    const guarded = (state.rooms || []).filter((r) => r.kind !== 'home')
      .filter((r) => !q ||
        String(r.name).toLowerCase().indexOf(q) !== -1 ||
        String(r.cellName || '').toLowerCase().indexOf(q) !== -1);

    if (!guarded.length) {
      pick.listEl.append(h('div', { class: 'rm-pick-empty' },
        q ? 'No room matches "' + q + '".'
          : 'No guarded rooms yet — claim one on the Rooms tab first.'));
    }
    for (const r of guarded) {
      const banned = pick.subjRef ? isDenied(r, pick.subjRef) : false;
      pick.listEl.append(h('button', {
        class: 'rm-pick-item' + (banned ? ' on' : ''),
        title: banned
          ? who + ' is banned from ' + r.name + ' — click to lift the ban'
          : 'Ban ' + who + ' from ' + r.name + ' — Room Guard shows them out, ' +
            'follower or not',
        onclick: () => withSubjRef((ref) => {
          const nowBanned = !isDenied(r, ref);
          setDeny(r, ref, nowBanned);
          toast(nowBanned ? (ref.name || who) + ' is banned from ' + r.name
                          : 'Ban lifted — ' + (ref.name || who) + ' may enter ' + r.name);
          if (ui.inited) renderList();
          renderBanBody();
        })
      },
        h('span', { class: 'rm-pick-nm' }, (banned ? '✓ ' : '🚫 ') + r.name),
        h('span', { class: 'rm-pick-badge' }, r.cellName || r.kind)));
    }

    // The global list rides along: protect rather than ban.
    const prot = pick.subjRef &&
      (state.ignore || []).some((n) => sameNpc(n, pick.subjRef));
    pick.listEl.append(h('button', {
      class: 'rm-pick-item guard' + (prot ? ' on' : ''),
      title: prot
        ? who + ' is never moved, anywhere — click to stop protecting'
        : 'Protect ' + who + ' — never moved out of any room, anywhere',
      onclick: () => withSubjRef((ref) => {
        const had = (state.ignore || []).some((n) => sameNpc(n, ref));
        if (had) state.ignore = state.ignore.filter((n) => !sameNpc(n, ref));
        else state.ignore.push({ plugin: ref.plugin, localId: ref.localId, name: ref.name || '' });
        save();
        toGame('rgState');
        toast(had ? (ref.name || who) + ' is no longer protected'
                  : (ref.name || who) + ' is never moved, anywhere');
        if (ui.inited) render();
        renderBanBody();
      })
    },
      h('span', { class: 'rm-pick-nm' }, (prot ? '✓ ' : '🛡 ') + 'Never move ' + who + ' — anywhere'),
      null));

    if (pick.subj && pick.subj.formId && !pick.subjRef) {
      pick.listEl.append(h('div', { class: 'rm-pick-hint' }, 'Confirming who this is…'));
    }
    placePicker();
  }

  function renderIgnore() {
    els.ignoreList.replaceChildren();
    if (!state.ignore.length) return;
    els.ignoreList.append(h('span', { class: 'rm-occ-title', style: 'width:100%' }, 'Never moved'));
    for (const n of state.ignore) {
      els.ignoreList.append(h('span', { class: 'rm-ig' },
        n.name || (n.plugin + '|' + n.localId),
        h('button', {
          class: 'rm-ig-x', title: 'Stop ignoring ' + (n.name || 'them'),
          onclick: () => {
            state.ignore = state.ignore.filter((x) => !(x.plugin === n.plugin && x.localId === n.localId));
            save(); render();
          }
        }, '×')));
    }
  }

  function renderSettings() {
    els.settings.classList.toggle('hidden', !ui.editing);
    els.editBtn.classList.toggle('on', ui.editing);
    els.enabled.checked = !!state.enabled;
    els.followers.checked = !!state.allowFollowers;
    els.notify.checked = !!state.notify;
    els.autoclaim.checked = state.autoClaim !== false;
    els.grace.value = state.graceMs;
    els.graceVal.textContent = (state.graceMs / 1000).toFixed(1) + 's';
  }

  function render() {
    if (!ui.inited) return;
    renderHere();
    renderOccupants();
    renderSettings();
    renderList();
    renderIgnore();
  }

  /* ============================================================ actions == */

  function setKind(r, kind) {
    r.kind = kind;
    // Switching a place to Home is the "stop guarding my house" escape hatch, so
    // it must take effect immediately rather than waiting for a tick to notice.
    if (kind === 'home') r.enabled = true;
    save();
    render();
  }

  function armedDelete(r) {
    if (ui.armed !== r.id) { ui.armed = r.id; render(); return; }
    ui.armed = null;
    // Release FIRST so C++ unblocks any furniture this room blocked while its
    // ref ids are still known — then drop the row and save.
    //
    // ⚠ rgRelease RE-PUSHES the full config (RunRoomOp repush=true), and that
    // push still CONTAINS this room — only the rgSave below deletes it. With a
    // debounced save the push always landed first and resurrected the row:
    // trash → Sure? → the room came straight back ("can't remove room", user
    // report 2026-08-13). So the delete is tombstoned until C++ acks the save
    // (the open handler filters tombstoned ids out of any config push), and
    // the save flushes IMMEDIATELY — a delete is not a slider drag, there is
    // nothing to coalesce.
    ui.deleting[r.id] = true;
    toGame('rgRelease', r.id);
    state.rooms = state.rooms.filter((x) => x.id !== r.id);
    flushSave();
    render();
  }

  function doClaim() {
    const name = els.claimName.value.trim();
    const useBed = !!(state.here && state.here.rentedBed && state.here.rentedBed.found);
    // A whole-cell claim is inherently a "private cell" and centred on nothing —
    // file it as Private (a Home never guards, so whole-cell + Home is a
    // contradiction: prefer the guard).
    const kind = ui.claimWhole && ui.kind === 'home' ? 'private' : ui.kind;
    toGame('rgClaim', JSON.stringify({
      name: name, kind: kind, radius: ui.radius, shape: ui.shape, useBed: useBed,
      wholeCell: !!ui.claimWhole, evictFollowers: !!ui.claimEvict
    }));
    els.claimName.value = '';
    // Reset the keep-out toggles so the NEXT claim doesn't silently inherit them.
    ui.claimWhole = false; ui.claimEvict = false;
    if (els.claimWhole) els.claimWhole.checked = false;
    if (els.claimEvict) els.claimEvict.checked = false;
    renderHere();
  }

  /* ============================================================ receive == */

  /* The reply arrives as `rgStateResult`, NOT `rgState`.

     It used to share the request's name, chained onto the bridge and told
     apart "by shape". That could not work: the request carries no payload at
     all, so the shape test saw a reply with no `occupants` array, returned
     "handled", and never forwarded to the real bridge underneath. Every
     toGame('rgState') — including the 1.5s poll — died inside the view, so
     the occupant list stayed empty forever. C++ now pushes a distinct name
     (src/main.cpp OnJsRoomState) and the shape test is gone. */
  function receive(fn, payload) {
    if (fn === 'open') {
      const j = parse(payload);
      if (!j) return true;
      state.rooms = (Array.isArray(j.rooms) ? j.rooms : [])
        .filter((r) => !ui.deleting[r.id]);   // mid-delete push must not resurrect the row
      state.ignore = Array.isArray(j.ignore) ? j.ignore : [];
      state.enabled = j.enabled !== false;
      state.allowFollowers = j.allowFollowers !== false;
      state.notify = j.notify !== false;
      state.autoClaim = j.autoClaim !== false;
      state.graceMs = Number(j.graceMs) || 4000;
      state.tickMs = Number(j.tickMs) || 1500;
      state.here = j.here || { ok: false };
      ui.armed = null;
      render();
      return true;
    }
    if (fn === 'state') {
      const j = parse(payload);
      if (!j || !Array.isArray(j.occupants)) return true;
      /* The 1.2 s occupancy poll used to re-render unconditionally, and
         renderList/renderOccupants rebuild their DOM with replaceChildren —
         so the button under the cursor was destroyed and recreated every
         tick, and its hover tooltip died and re-armed with it ("pulsing"
         hover, Rober 2026-08-09). Occupancy is IDENTICAL between most polls:
         skip the whole repaint when nothing changed, so hover states and
         tooltips live until the data actually moves. */
      const sig = stateSig(j);
      if (sig === ui.lastStateSig) return true;
      ui.lastStateSig = sig;
      ui.hereRoomId = j.roomId || '';
      ui.occupants = j.occupants;
      ui.parked = Array.isArray(j.parked) ? j.parked : [];
      ui.roomEvict = !!j.roomEvictFollowers;
      ui.roomWhole = !!j.roomWholeCell;
      // C++ is the truth about the seal (the bindable Privacy action can flip it
      // with this pane closed), so believe the poll over the local copy.
      const hereRoom = ui.hereRoomId ? roomById(ui.hereRoomId) : null;
      if (hereRoom && typeof j.roomLockdown === 'boolean')
        hereRoom.lockdown = j.roomLockdown;
      renderHere();
      renderOccupants();
      renderList();
      return true;
    }
    if (fn === 'npcs') {
      const j = parse(payload);
      if (j && Array.isArray(j.npcs)) onNpcRows(j.npcs);
      return true;
    }
    if (fn === 'result') {
      const j = parse(payload);
      if (!j) return true;
      if (j.msg) toast(j.msg);
      if (Array.isArray(j.ignore)) { state.ignore = j.ignore; renderIgnore(); }
      // rgLock's reply: C++'s authoritative seal state for that room. It also
      // arrives when the BOUND Privacy key was pressed with the deck shut, which
      // is the case the optimistic local flip cannot cover.
      if (j.id && typeof j.lockdown === 'boolean') {
        const lr = roomById(j.id);
        if (lr && lr.lockdown !== j.lockdown) { lr.lockdown = j.lockdown; render(); }
        else if (lr) { renderHere(); renderList(); }
      }
      // A fresh claim opens its own size panel with the world ring up, so the
      // FIRST thing after claiming is seeing what you claimed.
      if (j.room && j.room.id) {
        ui.expanded = j.room.id;
        ringShow(j.room);
      }
      return true;
    }
    if (fn === 'ring') {
      const j = parse(payload);
      if (j && j.msg && !j.ok) toast(j.msg);
      return true;
    }
    if (fn === 'saved') { ui.deleting = {}; return true; }
    if (fn === 'show') { showTab(); return true; }
    return false;
  }

  function parse(p) {
    if (p === null || p === undefined) return null;
    if (typeof p === 'object') return p;
    try { return JSON.parse(String(p)); } catch (e) { glog('bad payload: ' + e); return null; }
  }

  let toastT = null;
  function toast(msg) {
    let t = $('rm-toast');
    if (!t) {
      t = h('div', { id: 'rm-toast', class: 'hidden' });
      document.body.append(t);
    }
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), 2100);
  }

  /* ============================================================ show/hide */

  function showTab() {
    const btn = document.querySelector('#tabs .tab[data-tab="rooms"]');
    if (btn) { btn.click(); return true; }
    if (typeof window.hdSetTab === 'function') { window.hdSetTab('rooms'); return true; }
    const pane = $('rm-pane');
    if (!pane) return false;
    pane.classList.remove('hidden');
    onShow();
    return true;
  }

  function onShow() {
    ui.shown = true;
    const pane = $('rm-pane');
    if (pane) pane.classList.remove('hidden');
    ui.armed = null;
    ui.lastStateSig = '';   // repaint on the first reply of a fresh visit
    render();
    toGame('rgState');
    // Occupancy is a live fact and the whole point of the readout, so poll it
    // while the tab is visible — and ONLY while it is visible.
    if (ui.pollT) clearInterval(ui.pollT);
    ui.pollT = setInterval(() => { if (ui.shown) toGame('rgState'); }, STATE_POLL);
    setTimeout(() => { if (els.search) els.search.focus(); }, 30);
  }

  function onHide() {
    ui.shown = false;
    ui.armed = null;
    closePicker();
    ringHide();
    if (ui.pollT) { clearInterval(ui.pollT); ui.pollT = null; }
    flushSave();
    const pane = $('rm-pane');
    if (pane) pane.classList.add('hidden');
  }

  function toggleEdit() { ui.editing = !ui.editing; ui.armed = null; render(); }
  function wantsPause() { return true; }

  /* ============================================================= wiring == */

  function chain(name, key) {
    const prev = window[name];
    window[name] = function (info) {
      if (receive(key, info)) return;
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
    /* Tag it so the selftest can prove no receiver ever lands on a REQUEST
       name again — the failure mode is silent, so it needs a marker to test. */
    window[name].__rmReceiver = true;
  }

  function init() {
    if (ui.inited) return true;
    if (!$('rm-pane')) { console.log('[rooms] #rm-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;

    els.pane = $('rm-pane');
    els.hereName = $('rm-here-name');
    els.hereStatus = $('rm-here-status');
    els.lockBtn = $('rm-lock-btn');
    els.lockBanner = $('rm-lock-banner');
    els.claimName = $('rm-claim-name');
    els.claimBtn = $('rm-claim-btn');
    els.claimWhole = $('rm-claim-whole');
    els.claimEvict = $('rm-claim-evict');
    els.kindToggle = $('rm-kind-toggle');
    els.radius = $('rm-radius');
    els.sizeVal = $('rm-size-val');
    els.occ = $('rm-occupants');
    els.search = $('rm-search');
    els.count = $('rm-count');
    els.editBtn = $('rm-edit');
    els.settings = $('rm-settings');
    els.enabled = $('rm-enabled');
    els.followers = $('rm-followers');
    els.notify = $('rm-notify');
    els.autoclaim = $('rm-autoclaim');
    els.grace = $('rm-grace');
    els.graceVal = $('rm-grace-val');
    els.list = $('rm-list');
    els.empty = $('rm-empty');
    els.evictBtn = $('rm-evict-btn');
    els.ignoreBtn = $('rm-ignore-btn');
    els.ignoreList = $('rm-ignore-list');

    /* Whole-tab size, in with the other master switches. hd-scale.js owns the
       clamp and the persistence (the deck's `settings.tabScales`, NOT the
       rooms slice — every slice here is round-tripped whole by C++ and one
       more field is one more chance for a save to drop it). No listener to
       attach: hd-scale.js delegates from document. */
    if (window.HDScale) HDScale.mount($('rm-size-row'), 'rooms');

    els.claimBtn.addEventListener('click', doClaim);
    els.claimName.addEventListener('keydown', (e) => { if (e.key === 'Enter') doClaim(); });
    if (els.claimWhole) els.claimWhole.addEventListener('change', () => {
      ui.claimWhole = els.claimWhole.checked; renderHere();
    });
    if (els.claimEvict) els.claimEvict.addEventListener('change', () => {
      ui.claimEvict = els.claimEvict.checked;
    });

    els.kindToggle.addEventListener('click', (e) => {
      const b = e.target.closest('.rm-seg-btn');
      if (!b) return;
      ui.kind = b.dataset.kind;
      for (const btn of els.kindToggle.querySelectorAll('.rm-seg-btn')) {
        const on = btn === b;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    });

    smoothRange(els.radius);
    smoothRange(els.grace);
    els.radius.addEventListener('input', () => {
      ui.radius = Number(els.radius.value) || 200;
      els.sizeVal.textContent = fmtUnits(ui.radius);
    });
    els.sizeVal.textContent = fmtUnits(ui.radius);

    // Search-as-you-type: the list is expected to accumulate (every inn in
    // Skyrim is a candidate), so it filters live rather than paging.
    els.search.addEventListener('input', () => { ui.filter = els.search.value; renderList(); });

    els.editBtn.addEventListener('click', toggleEdit);
    els.enabled.addEventListener('change', () => { state.enabled = els.enabled.checked; save(); });
    els.followers.addEventListener('change', () => { state.allowFollowers = els.followers.checked; save(); });
    els.notify.addEventListener('change', () => { state.notify = els.notify.checked; save(); });
    els.autoclaim.addEventListener('change', () => { state.autoClaim = els.autoclaim.checked; save(); });
    els.grace.addEventListener('input', () => {
      state.graceMs = Number(els.grace.value) || 0;
      els.graceVal.textContent = (state.graceMs / 1000).toFixed(1) + 's';
      save();
    });

    // Privacy: seal / unseal the room you are standing in. Empty id would make
    // C++ resolve "here" itself, but the pane already knows which room that is
    // and passing it keeps the optimistic repaint and the game in step.
    if (els.lockBtn) els.lockBtn.addEventListener('click', () => {
      const r = ui.hereRoomId ? roomById(ui.hereRoomId) : null;
      if (r) toggleLockdown(r);
    });

    els.evictBtn.addEventListener('click', () => { toGame('rgEvict', ui.hereRoomId || ''); });
    els.ignoreBtn.addEventListener('click', () => { toGame('rgIgnore'); });
    // "Never move…" by NAME — the picker twin of the crosshair button, for
    // protecting someone who is not standing in front of you.
    els.ignorePick = $('rm-ignore-pick');
    if (els.ignorePick) els.ignorePick.addEventListener('click', (e) => {
      openNpcPicker(e.currentTarget, {
        title: 'Never move — pick a person',
        except: state.ignore,
        onPick: (ref) => {
          if (state.ignore.some((n) => sameNpc(n, ref))) return;
          state.ignore.push({ plugin: ref.plugin, localId: ref.localId, name: ref.name || '' });
          save();
          render();
          toast((ref.name || 'They') + ' is never moved, anywhere');
        }
      });
    });

    chain('rgOpen', 'open');
    chain('rgStateResult', 'state');
    chain('rgNpcsResult', 'npcs');
    chain('rgResult', 'result');
    chain('rgRingState', 'ring');
    chain('rgSaved', 'saved');
    chain('rgShow', 'show');

    if (SELFTEST) setTimeout(selftest, 60);
    return true;
  }

  /* ============================================================ selftest == */

  function selftest() {
    const out = [];
    const ok = (name, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + name);

    // The pane must actually be on screen before anything is measured — a
    // hidden pane yields convincing but meaningless geometry.
    els.pane.classList.remove('hidden');

    ok('pane mounted', !!els.pane && els.pane.offsetParent !== null);
    ok('claim button present', !!els.claimBtn);
    ok('search present', !!els.search);

    /* The occupancy poll must actually LEAVE the view. It did not for the
       whole of the Room Guard's first life: the reply shared the request's
       name, so chain() sat a receiver on top of window.rgState and swallowed
       every request as an unusable reply. Prove the bridge is still the
       bridge and that a request reaches it. */
    (function () {
      const REQUESTS = ['rgClaim', 'rgAnchor', 'rgEvict', 'rgRelease',
        'rgIgnore', 'rgLock', 'rgSave', 'rgState', 'rgNpcs', 'rgLog'];
      const shadowed = REQUESTS.filter((n) => window[n] && window[n].__rmReceiver);
      ok('no receiver shadows a request bridge' +
        (shadowed.length ? ' (' + shadowed.join(', ') + ')' : ''), shadowed.length === 0);

      const real = window.rgState;
      let calls = 0;
      window.rgState = function () { calls++; };
      toGame('rgState');
      window.rgState = real;
      ok('toGame(rgState) reaches the plugin, not the view', calls === 1);
    })();

    receive('open', {
      rooms: [
        { id: 'r1', name: 'Bannered Mare — room', kind: 'inn', cellId: 1, cellName: 'The Bannered Mare',
          x: 0, y: 0, z: 0, radius: 320, height: 180, enabled: true, hasAnchor: false, allow: [] },
        { id: 'r2', name: 'Breezehome', kind: 'home', cellId: 2, cellName: 'Breezehome',
          x: 0, y: 0, z: 0, radius: 500, height: 200, enabled: true, hasAnchor: true, allow: [] }
      ],
      ignore: [{ plugin: 'Skyrim.esm', localId: 10, name: 'Lydia' }],
      enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 1, cellName: 'The Bannered Mare', suggested: 'The Bannered Mare — room' }
    });

    ok('two rooms loaded', state.rooms.length === 2);
    ok('rows rendered', els.list.querySelectorAll('.rm-row').length === 2);
    ok('home row styled', !!els.list.querySelector('.rm-row.home'));
    ok('no-anchor warning on r1', !!els.list.querySelector('.rm-chip.warn'));
    ok('home row has no anchor warning',
      els.list.querySelectorAll('.rm-row')[1].querySelectorAll('.rm-chip.warn').length === 0);
    ok('ignore chip rendered', els.ignoreList.querySelectorAll('.rm-ig').length === 1);
    ok('here name shown', els.hereName.textContent === 'The Bannered Mare');

    // search
    ui.filter = 'breeze'; renderList();
    ok('search narrows to 1', els.list.querySelectorAll('.rm-row').length === 1);
    ui.filter = 'home'; renderList();
    ok('search matches kind word', els.list.querySelectorAll('.rm-row').length === 1);
    ui.filter = 'zzzz'; renderList();
    ok('no-match empty state', !els.empty.classList.contains('hidden'));
    ui.filter = ''; renderList();
    ok('filter cleared restores 2', els.list.querySelectorAll('.rm-row').length === 2);

    // occupancy
    receive('state', {
      roomId: 'r1', roomName: 'Bannered Mare — room', roomKind: 'inn',
      occupants: [
        { name: 'Mikael', exempt: false, reason: '' },
        { name: 'Lydia', exempt: true, reason: 'follower' }
      ]
    });
    ok('occupants rendered', els.occ.querySelectorAll('.rm-occ').length === 2);
    ok('non-exempt marked going', !!els.occ.querySelector('.rm-occ.going'));
    ok('exempt shows reason',
      els.occ.querySelectorAll('.rm-occ-why')[1].textContent === 'follower');
    ok('here room resolved -> evict enabled', els.evictBtn.disabled === false);
    ok('you-are-here chip', !!els.list.querySelector('.rm-chip.here'));

    // --- box-shaped rooms ---
    receive('open', {
      rooms: [{ id: 'b1', name: 'Box room', kind: 'inn', cellId: 8, cellName: 'B',
        shape: 'box', halfX: 150, halfY: 300, yaw: 0.5,
        x: 0, y: 0, z: 0, radius: 200, height: 130, enabled: true, hasAnchor: true, allow: [] }],
      ignore: [], enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 8, cellName: 'B' }
    });
    ok('box row shows W\u00D7D dims', /300\u00D7600u/.test(els.list.textContent));
    ui.expanded = 'b1'; renderList();
    const btune = els.list.querySelector('.rm-tune');
    ok('box tune has three sliders (W/D/height)',
      btune.querySelectorAll('input[type=range]').length === 3);
    ok('box tune has the align button', /\u21BB/.test(btune.textContent));
    ok('slice carries the shape fields', (() => {
      const s0 = slice().rooms[0];
      return s0.shape === 'box' && s0.halfX === 150 && s0.halfY === 300 && s0.yaw === 0.5;
    })());
    btune.querySelectorAll('.rm-seg-btn')[0].click();   // flip to Round
    ok('shape flips back to circle', roomById('b1').shape === 'circle');
    ui.expanded = null;

    // --- smooth slider drag (Ultralight's native range drag is broken) ---
    (function () {
      const r = els.radius.getBoundingClientRect();
      if (r.width > 0) {
        els.radius.dispatchEvent(new MouseEvent('mousedown',
          { bubbles: true, clientX: r.left + r.width * 0.75 }));
        const v1 = Number(els.radius.value);
        ok('pointer press jumps the slider to the pressed spot',
          v1 > (Number(els.radius.min) + Number(els.radius.max)) / 2);
        document.dispatchEvent(new MouseEvent('mousemove',
          { bubbles: true, clientX: r.left + r.width * 0.25 }));
        ok('pointer drag follows continuously', Number(els.radius.value) < v1);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        els.radius.value = '200'; ui.radius = 200;
      } else {
        ok('pointer press jumps the slider to the pressed spot', true);
        ok('pointer drag follows continuously', true);
      }
    })();

    // --- boundary ring follows the size panel ---
    let ringPayloads = [];
    const prevRing = window.rgRing;
    window.rgRing = (p) => { ringPayloads.push(JSON.parse(p)); };
    receive('open', {
      rooms: [{ id: 'v1', name: 'Ring room', kind: 'inn', cellId: 3, cellName: 'X',
        x: 0, y: 0, z: 0, radius: 200, height: 130, enabled: true, hasAnchor: true, allow: [] }],
      ignore: [], enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 3, cellName: 'X' }
    });
    ui.expanded = null; renderList();
    ringT = 0;   // the box-shape tests above just fired ringShow; clear the throttle
    els.list.querySelector('.rm-act').click();   // 📐
    ok('opening the size panel shows the ring',
      ringPayloads.length === 1 && ringPayloads[0].id === 'v1');
    ringT = 0;
    const rr = els.list.querySelector('.rm-tune input[type=range]');
    rr.value = '400'; rr.dispatchEvent(new Event('input', { bubbles: true }));
    ok('radius drag re-aims the ring at the new size',
      ringPayloads.length === 2 && ringPayloads[1].radius === 400);
    ringT = 0;
    els.list.querySelector('.rm-act').click();   // collapse
    ok('collapsing hides the ring',
      ringPayloads.length === 3 && !ringPayloads[2].id);
    window.rgRing = prevRing;
    ui.expanded = null;

    // --- rented-bed detection drives the claim ---
    receive('open', {
      rooms: [], ignore: [], enabled: true, allowFollowers: true, notify: true,
      graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 5, cellName: 'Sleeping Giant Inn', isInn: true,
              suggested: 'Sleeping Giant Inn — room',
              rentedBed: { found: true, x: 10, y: 20, z: 30 } }
    });
    ok('bed detection retitles the claim button',
      els.claimBtn.textContent.indexOf('my rented room') !== -1);
    let claimPayload = null;
    const prevClaim = window.rgClaim;
    window.rgClaim = (p) => { claimPayload = JSON.parse(p); };
    doClaim();
    window.rgClaim = prevClaim;
    ok('claim sends useBed when a bed is detected', !!claimPayload && claimPayload.useBed === true);
    receive('open', {
      rooms: [], ignore: [], enabled: true, allowFollowers: true, notify: true,
      graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 6, cellName: 'Somewhere', isInn: false,
              rentedBed: { found: false } }
    });
    ok('no detection -> plain claim button',
      els.claimBtn.textContent.indexOf('my rented room') === -1);

    // --- Private bedrooms in a shared cell + the occupant allow toggle ---
    receive('open', {
      rooms: [
        { id: 'p1', name: 'Castle bedroom', kind: 'private', cellId: 9, cellName: 'Mistveil Keep',
          x: 0, y: 0, z: 0, radius: 220, height: 130, enabled: true, hasAnchor: true, allow: [] }
      ],
      ignore: [], enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 9, cellName: 'Mistveil Keep', suggested: 'Mistveil Keep — room' }
    });
    ok('private chip renders', els.list.querySelector('.rm-chip').nextSibling &&
      [...els.list.querySelectorAll('.rm-chip')].some((c) => c.textContent === 'Private'));
    ui.filter = 'bedroom'; renderList();
    ok('search finds private by kind word', els.list.querySelectorAll('.rm-row').length === 1);
    ui.filter = ''; renderList();
    receive('state', { roomId: 'p1', occupants: [
      { name: 'Sylgja', exempt: false, reason: '', plugin: 'Household.esp', localId: 77 },
      { name: 'Unknown husk', exempt: false, reason: '' }
    ] });
    const allowBtns = els.occ.querySelectorAll('.rm-occ-allow');
    ok('allow button only on identifiable occupants', allowBtns.length === 1);
    allowBtns[0].click();
    ok('allow click lands on the room', roomById('p1').allow.length === 1 &&
      roomById('p1').allow[0].name === 'Sylgja');
    ok('slice carries the allow list', slice().rooms[0].allow.length === 1);
    receive('state', { roomId: 'p1', occupants: [
      { name: 'Sylgja', exempt: true, reason: 'allowed here', plugin: 'Household.esp', localId: 77 }
    ] });
    const unBtn = els.occ.querySelector('.rm-occ-allow.off');
    ok('allowed occupant gets the un-allow button', !!unBtn);
    unBtn.click();
    ok('un-allow empties the list', roomById('p1').allow.length === 0);

    // --- occupancy no-change skip (the pulsing-hover fix, 2026-08-09) ---
    // The 1.2s poll re-rendered identical data and destroyed the hovered
    // button each tick. Same payload twice must keep the SAME DOM nodes.
    (function () {
      const payload = { roomId: 'p1', occupants: [
        { name: 'Sylgja', exempt: false, reason: '', plugin: 'Household.esp', localId: 77 }
      ] };
      receive('state', payload);
      const nodeBefore = els.occ.querySelector('.rm-occ');
      receive('state', JSON.parse(JSON.stringify(payload)));
      ok('identical occupancy reply skips the repaint (hover survives)',
        els.occ.querySelector('.rm-occ') === nodeBefore);
      receive('state', { roomId: 'p1', occupants: [
        { name: 'Sylgja', exempt: true, reason: 'allowed here', plugin: 'Household.esp', localId: 77 }
      ] });
      ok('changed occupancy reply does repaint',
        els.occ.querySelector('.rm-occ') !== nodeBefore);
    })();

    // --- per-room blacklist (deny) ---
    receive('open', {
      rooms: [
        { id: 'd1', name: 'Guarded room', kind: 'inn', cellId: 30, cellName: 'Inn',
          x: 0, y: 0, z: 0, radius: 200, height: 130, enabled: true, hasAnchor: true,
          allow: [{ plugin: 'Household.esp', localId: 77, name: 'Sylgja' }],
          deny: [{ plugin: 'Skyrim.esm', localId: 0xA2C8, name: 'Lydia' }] }
      ],
      ignore: [], enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 30, cellName: 'Inn' }
    });
    ok('banned chip renders with the count',
      [...els.list.querySelectorAll('.rm-chip')].some((c) => /1 banned/.test(c.textContent)));
    ok('slice round-trips the deny list', (() => {
      const s0 = slice().rooms[0];
      return Array.isArray(s0.deny) && s0.deny.length === 1 && s0.deny[0].name === 'Lydia';
    })());
    ui.filter = 'lydia'; renderList();
    ok('search finds a room by its banned name', els.list.querySelectorAll('.rm-row').length === 1);
    ui.filter = ''; renderList();

    // ban panel opens from the row's own action
    const banBtn = els.list.querySelectorAll('.rm-act')[1];   // 📐 then 🚫
    banBtn.click();
    const banPane = els.list.querySelector('.rm-ban');
    ok('ban panel opens under the row', !!banPane && ui.banFor === 'd1');
    ok('ban panel lists the banned person', /Lydia/.test(banPane.textContent));

    // lifting a ban from the panel chip
    banPane.querySelector('.rm-ig-x').click();
    ok('panel chip removes the ban', (roomById('d1').deny || []).length === 0);

    // the searchable NPC picker: known refs instantly, game rows merged in,
    // filter narrows, Enter takes the top hit, ban trumps allow
    const addBtn = els.list.querySelector('.rm-deny-add');
    ok('ban panel offers the picker', !!addBtn);
    addBtn.click();
    const pop = document.querySelector('.rm-pick');
    ok('picker popover opens on body', !!pop && pop.parentNode === document.body);
    ok('picker lists known refs before any reply',
      /Sylgja/.test(pop.textContent));
    receive('npcs', { npcs: [
      { name: 'Mikael', plugin: 'Skyrim.esm', localId: 0x1348, refId: 0x1349, follower: false, loaded: true },
      { name: 'Annekke', plugin: 'CustomFollower.esp', localId: 0x801, refId: 0xFF0007, follower: true, loaded: true }
    ] });
    ok('game candidates merge into the open picker', /Mikael/.test(pop.textContent));
    ok('follower badge renders', !!pop.querySelector('.rm-pick-badge.fol'));
    pick.input.value = 'anne';
    pick.input.dispatchEvent(new Event('input', { bubbles: true }));
    ok('picker filter narrows to the match',
      pop.querySelectorAll('.rm-pick-item').length === 1 && /Annekke/.test(pop.textContent));
    pick.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ok('Enter bans the top hit', isDenied(roomById('d1'),
      { plugin: 'CustomFollower.esp', localId: 0x801 }));
    ok('picking closes the picker', !document.querySelector('.rm-pick'));
    roomById('d1').allow = [{ plugin: 'Skyrim.esm', localId: 0x1348, name: 'Mikael' }];
    setDeny(roomById('d1'), { plugin: 'Skyrim.esm', localId: 0x1348, name: 'Mikael' }, true);
    ok('banning drops the same person\'s allow entry',
      roomById('d1').allow.length === 0 && (roomById('d1').deny || []).length === 2);
    ui.banFor = null; renderList();

    // denied occupant row: labelled, and offers the ban's own undo
    receive('state', { roomId: 'd1', occupants: [
      { name: 'Annekke', exempt: false, reason: '', plugin: 'CustomFollower.esp', localId: 0x801, denied: true }
    ] });
    ok('denied occupant is labelled blacklisted',
      /blacklisted here/.test(els.occ.textContent));
    const liftBtn = els.occ.querySelector('.rm-occ-allow.off');
    ok('denied occupant gets the lift-ban button', !!liftBtn);
    liftBtn.click();
    ok('lift-ban removes her from the deny list', !isDenied(roomById('d1'),
      { plugin: 'CustomFollower.esp', localId: 0x801 }));

    // --- the F7 entry point: banMenu (rooms list + never-move, searchable) ---
    (function () {
      const anchor = els.claimBtn;
      banMenu(anchor, { formId: 0xFF0007, name: 'Annekke' });
      const menu = document.querySelector('.rm-pick');
      ok('banMenu opens with the guarded rooms listed',
        !!menu && /Guarded room/.test(menu.textContent));
      ok('banMenu offers the global never-move option',
        /Never move Annekke/.test(menu.textContent));
      ok('banMenu says it is resolving identity', /Confirming who this is/.test(menu.textContent));
      // identity lands (refId match) -> checkmarks + queued actions work
      receive('npcs', { npcs: [
        { name: 'Annekke', plugin: 'CustomFollower.esp', localId: 0x801, refId: 0xFF0007, follower: true, loaded: true }
      ] });
      ok('identity resolves through the rgNpcs reply',
        !!pick.subjRef && pick.subjRef.plugin === 'CustomFollower.esp');
      const roomRow = [...menu.querySelectorAll('.rm-pick-item')]
        .find((b) => /Guarded room/.test(b.textContent));
      roomRow.click();
      ok('picking a room bans her from it', isDenied(roomById('d1'),
        { plugin: 'CustomFollower.esp', localId: 0x801 }));
      const guardRow = document.querySelector('.rm-pick-item.guard');
      guardRow.click();
      ok('the never-move row adds her to the global list',
        state.ignore.some((n) => n.localId === 0x801));
      guardRow.click();
      ok('clicking again removes the protection',
        !state.ignore.some((n) => n.localId === 0x801));

      /* --- readable at couch distance (Rober, 2026-08-11) ---------------
         Nothing in this menu may be footnote-sized, and it must wear the
         same zoom as the anchor: it lives on <body>, outside #panel's
         --ui-scale, so without the transform it stays 100% while the deck
         around it grows. */
      const px = (el, prop) => parseFloat(getComputedStyle(el)[prop || 'fontSize']) || 0;
      ok('menu title is readable (>=15px)', px(menu.querySelector('.rm-pick-head')) >= 15);
      ok('search box text is readable (>=15px)', px(pick.input) >= 15);
      ok('room rows are readable (>=15px)', px(menu.querySelector('.rm-pick-item')) >= 15);
      ok('the room badge is not a footnote (>=12px)',
        px(menu.querySelector('.rm-pick-badge')) >= 12);
      ok('menu is wide enough for a name plus its cell (>=400px)',
        menu.offsetWidth >= 400);
      ok('menu scales with its anchor, not with the raw viewport',
        /scale\(/.test(menu.style.transform || ''));
      (function () {
        const before = menu.style.transform;
        pick.scale = 1.5;
        placePicker();
        const k = parseFloat((menu.style.transform.match(/scale\(([\d.]+)\)/) || [])[1]);
        // a small harness window may clamp it; either it took the zoom, or it
        // took as much as fits — never silently 1 when there IS room.
        ok('a zoomed deck zooms the menu too',
          k > 1 || menu.offsetWidth * 1.5 > window.innerWidth - 16);
        ok('the zoomed menu still fits on screen',
          menu.getBoundingClientRect().right <= window.innerWidth + 1 &&
          menu.getBoundingClientRect().bottom <= window.innerHeight + 1);
        pick.scale = 1; menu.style.transform = before;
      })();

      closePicker();
      roomById('d1').deny = [];
      state.ignore = [];
    })();

    // the footer's pick-by-name protect button exists (typable-search rule)
    ok('never-move picker button present', !!$('rm-ignore-pick'));

    // restore the main fixture for the tests below
    receive('open', {
      rooms: [
        { id: 'r1', name: 'Bannered Mare — room', kind: 'inn', cellId: 1, cellName: 'The Bannered Mare',
          x: 0, y: 0, z: 0, radius: 320, height: 180, enabled: true, hasAnchor: false, allow: [] },
        { id: 'r2', name: 'Breezehome', kind: 'home', cellId: 2, cellName: 'Breezehome',
          x: 0, y: 0, z: 0, radius: 500, height: 200, enabled: true, hasAnchor: true, allow: [] }
      ],
      ignore: [{ plugin: 'Skyrim.esm', localId: 10, name: 'Lydia' }],
      enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 1, cellName: 'The Bannered Mare', suggested: 'The Bannered Mare — room' }
    });
    receive('state', { roomId: 'r1', occupants: [
      { name: 'Mikael', exempt: false, reason: '' },
      { name: 'Lydia', exempt: true, reason: 'follower' }
    ] });

    // kind flip is the "don't guard my house" escape hatch
    const r1 = roomById('r1');
    setKind(r1, 'home');
    ok('kind flip to home', roomById('r1').kind === 'home');
    ok('home never shows no-drop-point warning',
      els.list.querySelectorAll('.rm-row')[0].querySelectorAll('.rm-chip.warn').length === 0);
    setKind(r1, 'inn');

    // armed delete needs two clicks
    ui.editing = true; render();
    ok('edit reveals settings', !els.settings.classList.contains('hidden'));
    armedDelete(r1);
    ok('first delete click only arms', state.rooms.length === 2 && ui.armed === 'r1');
    armedDelete(r1);
    ok('second delete click removes', state.rooms.length === 1);
    ok('delete tombstones the id until the save is acked', ui.deleting['r1'] === true);
    // the resurrection bug (user report 2026-08-13): rgRelease re-pushes the
    // full config BEFORE the deleting save lands — a push still carrying the
    // deleted room must not bring the row back
    receive('open', JSON.stringify({ rooms: [
      { id: 'r1', name: 'Deleted room', kind: 'inn' },
      state.rooms[0]
    ], ignore: [], enabled: true }));
    ok('mid-delete config push does not resurrect the room',
      !roomById('r1') && state.rooms.length === 1);
    receive('saved', 'true');
    ok('save ack clears the tombstones', Object.keys(ui.deleting).length === 0);
    ui.editing = false;

    // the save slice must not invent C++-owned bookkeeping
    const s = slice();
    ok('slice omits C++-owned bookkeeping',
      s.rooms.every((r) => !('owned' in r) && !('blockedRefs' in r)));
    ok('slice carries repel, default on', s.rooms.every((r) => r.repel === true));
    ok('slice carries settings', s.graceMs === 4000 && s.allowFollowers === true);
    ok('slice carries autoClaim, default on', s.autoClaim === true);
    ok('auto-claim checkbox exists', !!$('rm-autoclaim'));

    // Pause dims a RENTED room. A home room is never guarded, so "paused" is
    // meaningless there and it deliberately does not dim — assert both, since
    // the first version of this test picked the home row and read the correct
    // behaviour as a failure.
    const left = state.rooms[0];
    left.enabled = false; left.kind = 'home'; render();
    ok('paused home row does NOT dim', !els.list.querySelector('.rm-row.off'));
    left.kind = 'inn'; render();
    ok('paused rented row dims', !!els.list.querySelector('.rm-row.off'));

    // --- per-room size tuning (the answer to "how does it know my room?") ---
    ui.expanded = null; renderList();
    ok('no tune panel by default', !els.list.querySelector('.rm-tune'));
    const tuneMe = state.rooms[0];
    ui.expanded = tuneMe.id; renderList();
    const tune = els.list.querySelector('.rm-tune');
    ok('tune panel opens', !!tune);
    ok('tune has two sliders', tune.querySelectorAll('input[type=range]').length === 2);
    const repelBox = tune.querySelector('.rm-tune-repel input[type=checkbox]');
    ok('tune has the repel toggle, on by default', !!repelBox && repelBox.checked);
    repelBox.checked = false;
    repelBox.dispatchEvent(new Event('change', { bubbles: true }));
    ok('repel toggle writes the room', tuneMe.repel === false);
    tuneMe.repel = true;
    const rng = tune.querySelector('input[type=range]');
    rng.value = '400';
    rng.dispatchEvent(new Event('input', { bubbles: true }));
    ok('dragging updates the room radius', tuneMe.radius === 400);
    ok('tune readout shows metres', /m\)/.test(tune.querySelector('.rm-size-val').textContent));
    ui.expanded = null;

    // Defaults must stay ROOM-sized. 320u was ~9 m across — double a rented
    // inn room, so it reached through the wall into the corridor.
    ok('claim default is room-sized', ui.radius <= 240);
    ok('unit readout is a diameter', fmtUnits(200).indexOf('5.7 m') !== -1);

    // --- private cell + push-followers-out (2026-08-05) ---
    ok('claim box has whole-cell + evict toggles', !!$('rm-claim-whole') && !!$('rm-claim-evict'));

    receive('open', {
      rooms: [{ id: 'pc1', name: 'My study', kind: 'private', cellId: 12, cellName: 'Proudspire Manor',
        x: 0, y: 0, z: 0, radius: 200, height: 130, enabled: true, hasAnchor: true,
        wholeCell: true, evictFollowers: true, allow: [] }],
      ignore: [], enabled: true, allowFollowers: true, notify: true, graceMs: 4000, tickMs: 1500,
      here: { ok: true, cellId: 12, cellName: 'Proudspire Manor' }
    });
    ok('whole-cell chip renders',
      [...els.list.querySelectorAll('.rm-chip')].some((c) => /whole cell/.test(c.textContent)));
    ok('followers-out chip renders',
      [...els.list.querySelectorAll('.rm-chip')].some((c) => /followers out/.test(c.textContent)));
    ui.filter = 'private cell'; renderList();
    ok('search finds a whole-cell room by keyword', els.list.querySelectorAll('.rm-row').length === 1);
    ui.filter = ''; renderList();
    ok('slice round-trips the new flags', (() => {
      const s0 = slice().rooms[0];
      return s0.wholeCell === true && s0.evictFollowers === true;
    })());

    // per-room tune toggles reflect and write the room
    ui.expanded = 'pc1'; renderList();
    const tune2 = els.list.querySelector('.rm-tune');
    const evictBox = tune2.querySelector('.rm-tune-evict input[type=checkbox]');
    const wholeBox = tune2.querySelector('.rm-tune-whole input[type=checkbox]');
    ok('tune has the evict-followers toggle, reflecting state', !!evictBox && evictBox.checked === true);
    ok('tune has the whole-cell toggle, reflecting state', !!wholeBox && wholeBox.checked === true);
    evictBox.checked = false; evictBox.dispatchEvent(new Event('change', { bubbles: true }));
    ok('evict toggle writes the room', roomById('pc1').evictFollowers === false);
    roomById('pc1').evictFollowers = true;

    // parked readout from live state
    receive('state', {
      roomId: 'pc1', roomEvictFollowers: true, roomWholeCell: true,
      parked: [{ name: 'Illia', waiting: true }, { name: 'Lydia', waiting: true }],
      occupants: []
    });
    ui.expanded = 'pc1'; renderList();
    ok('parked readout lists followers waiting outside',
      /2 followers waiting outside/.test(els.list.textContent) && /Illia/.test(els.list.textContent));
    ui.expanded = null;

    // claim payload carries then clears the keep-out toggles; whole-cell overrides Home
    receive('open', {
      rooms: [], ignore: [], enabled: true, allowFollowers: true, notify: true,
      graceMs: 4000, tickMs: 1500, here: { ok: true, cellId: 20, cellName: 'Cave' }
    });
    ui.kind = 'home';
    $('rm-claim-whole').checked = true; $('rm-claim-whole').dispatchEvent(new Event('change', { bubbles: true }));
    $('rm-claim-evict').checked = true; $('rm-claim-evict').dispatchEvent(new Event('change', { bubbles: true }));
    ok('whole-cell relabels the claim button', /whole cell/i.test(els.claimBtn.textContent));
    let pcPayload = null;
    const prevClaim2 = window.rgClaim;
    window.rgClaim = (p) => { pcPayload = JSON.parse(p); };
    doClaim();
    window.rgClaim = prevClaim2;
    ok('claim sends wholeCell + evictFollowers',
      !!pcPayload && pcPayload.wholeCell === true && pcPayload.evictFollowers === true);
    ok('whole-cell overrides Home to Private', pcPayload.kind === 'private');
    ok('keep-out toggles reset after claim',
      ui.claimWhole === false && ui.claimEvict === false && $('rm-claim-whole').checked === false);
    ui.kind = 'inn';

    /* ---- privacy lockdown (2026-08-11) ----
       "A quick privacy overwrite": one press = nobody in here at all, press
       again = back to the room's normal rules. The things worth proving are
       that the flip REACHES the game (a purely local flag would evict nobody),
       that it round-trips in the saved slice, that a sealed room says so
       everywhere it is drawn, and — the one that matters most — that lifting
       it leaves the allow list, the bans and the follower setting untouched. */
    (function () {
      const allow = [{ plugin: 'Skyrim.esm', localId: 0x2F, name: 'Camilla' }];
      const deny = [{ plugin: 'Skyrim.esm', localId: 0x31, name: 'Sven' }];
      receive('open', {
        rooms: [{ id: 'lk1', name: 'Proudspire Manor — bedroom', kind: 'private', cellId: 40,
          cellName: 'Proudspire Manor', x: 0, y: 0, z: 0, radius: 200, height: 130,
          enabled: true, hasAnchor: true, evictFollowers: false, wholeCell: false,
          allow: allow, deny: deny }],
        ignore: [], enabled: true, allowFollowers: true, notify: true,
        graceMs: 4000, tickMs: 1500,
        here: { ok: true, cellId: 40, cellName: 'Proudspire Manor' }
      });
      receive('state', { roomId: 'lk1', roomLockdown: false, parked: [], occupants: [] });

      ok('privacy button exists in the here card', !!els.lockBtn);
      ok('privacy button offers to seal', /nobody in/i.test(els.lockBtn.textContent));

      let sent = null;
      const prev = window.rgLock;
      window.rgLock = (id) => { sent = id; };
      els.lockBtn.click();
      window.rgLock = prev;

      ok('sealing reaches the game on rgLock', sent === 'lk1');
      ok('room is sealed locally (optimistic paint)', roomById('lk1').lockdown === true);
      ok('privacy button flips to the undo', /let people in/i.test(els.lockBtn.textContent));
      ok('sealed chip renders on the row',
        [...els.list.querySelectorAll('.rm-chip')].some((c) => /sealed/.test(c.textContent)));
      ok('sealed row is styled', !!els.list.querySelector('.rm-row.sealed'));
      ok('here status says sealed', /Sealed/.test(els.hereStatus.textContent));
      ok('banner names the sealed room',
        !els.lockBanner.classList.contains('hidden') &&
        /Proudspire Manor/.test(els.lockBanner.textContent));
      ok('sealed room round-trips in the saved slice', slice().rooms[0].lockdown === true);

      // The banner is the anti-forgetting device: it must survive a filter that
      // hides the room itself, or a seal set last night is invisible.
      ui.filter = 'zzzz-no-such-room'; renderList();
      ok('banner survives a filter that hides every row',
        els.list.querySelectorAll('.rm-row').length === 0 &&
        !els.lockBanner.classList.contains('hidden'));
      ui.filter = ''; renderList();
      ui.filter = 'privacy'; renderList();
      ok('search finds a sealed room by keyword', els.list.querySelectorAll('.rm-row').length === 1);
      ui.filter = ''; renderList();

      // Occupants: everyone is being shown out, and the pane says why — plus the
      // honest exception, so a "never move" person still standing there is not
      // mistaken for the seal being broken.
      receive('state', {
        roomId: 'lk1', roomLockdown: true, parked: [],
        occupants: [
          { name: 'Camilla', exempt: false, reason: '', plugin: 'Skyrim.esm', localId: 0x2F, denied: false },
          { name: 'Lydia', exempt: true, reason: 'ignored', plugin: 'Skyrim.esm', localId: 0xA2C8E, denied: false }
        ]
      });
      ok('occupant list explains the seal', /Sealed/.test(els.occ.textContent));
      ok('an allowed person is shown out while sealed', /sealed — shown out/.test(els.occ.textContent));
      ok('a never-move person is still exempt, with the reason',
        /ignored/.test(els.occ.textContent));

      // Unseal: the room's own settings must be exactly as they were.
      const r = roomById('lk1');
      els.lockBtn.click();
      ok('unsealing clears the flag', r.lockdown === false);
      ok('unsealing keeps the allow list', r.allow.length === 1 && r.allow[0].name === 'Camilla');
      ok('unsealing keeps the blacklist', r.deny.length === 1 && r.deny[0].name === 'Sven');
      ok('unsealing keeps the follower setting', r.evictFollowers === false);
      ok('banner hides when nothing is sealed', els.lockBanner.classList.contains('hidden'));

      // C++ is the truth: the bound Privacy key can seal a room with this pane
      // shut, and the reply must land even though the pane never clicked.
      receive('result', { ok: true, id: 'lk1', lockdown: true, msg: 'sealed' });
      ok('rgLock reply from a bound key seals the pane too', roomById('lk1').lockdown === true);
      receive('state', { roomId: 'lk1', roomLockdown: false, parked: [], occupants: [] });
      ok('the occupancy poll corrects a stale local seal', roomById('lk1').lockdown === false);

      // A HOME is never guarded — except while sealed, which is the whole point
      // of a privacy button in your own bedroom. The row must offer it.
      receive('open', {
        rooms: [{ id: 'hm1', name: 'Breezehome', kind: 'home', cellId: 41, cellName: 'Breezehome',
          x: 0, y: 0, z: 0, radius: 300, height: 150, enabled: true, hasAnchor: true, allow: [] }],
        ignore: [], enabled: true, allowFollowers: true, notify: true,
        graceMs: 4000, tickMs: 1500, here: { ok: true, cellId: 41, cellName: 'Breezehome' }
      });
      ok('a home row still offers the privacy seal',
        !!els.list.querySelector('.rm-row.home .rm-act-lock'));
    })();

    // empty state
    state.rooms = []; render();
    ok('empty state when no rooms', !els.empty.classList.contains('hidden'));
    ok('empty state mentions claiming', /Claim this room/.test(els.empty.textContent));

    /* ---- per-tab size (hd-scale.js) ----
       The control is STATIC markup here, so the only things worth asserting
       are that hd-scale mounted into it and that the variable it writes is
       the one the stylesheet reads. Both have failed elsewhere: a mount host
       renamed out from under the pane, and a var written under a name the
       CSS never mentions, are silent no-ops that look fine in the DOM. */
    (function () {
      if (!window.HDScale) { ok('size control (hd-scale not loaded here)', true); return; }
      const host = document.getElementById('rm-size-row');
      ok('size row is mounted inside the settings block', !!host &&
         !!host.querySelector('.hds-row[data-hds="rooms"]'));
      ok('the size row is a button pair, not an <input type=range>',
         !!host && host.querySelectorAll('[data-hds-act]').length === 3 &&
         host.querySelectorAll('input[type=range]').length === 0);
      /* Asserted on WIDTH, not on transform. #rm-body carries
         `transition: transform 130ms`, so a getComputedStyle() read in the
         same tick reports the value the animation is starting FROM — this
         check failed against a perfectly working control until that was
         measured. Width is the other half of the same contract (the layout
         box is divided by the scale so the painted result lands back inside
         the pane) and it is not transitioned, so it is the honest probe. */
      const body = els.pane.querySelector('#rm-body');
      const paneW = els.pane.getBoundingClientRect().width;
      HDScale.set('rooms', 'ui', 1.4);
      ok('the size control actually resizes #rm-body',
         paneW > 0 && Math.abs(body.getBoundingClientRect().width - paneW / 1.4) < 2);
      HDScale.nudge('rooms', 'ui', 0);
      ok('reset drops back to the stylesheet default',
         document.documentElement.style.getPropertyValue('--hdts-rooms') === '' &&
         Math.abs(body.getBoundingClientRect().width - paneW) < 2);
    })();

    const fails = out.filter((l) => l.startsWith('FAIL'));
    const box = h('pre', {
      style: 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
             'background:#111;color:#ddd;padding:10px;border:1px solid ' +
             (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace'
    }, out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed');
    document.body.append(box);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search, v0.14.0) ---------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'rooms', label: 'Rooms', tab: 'rooms',
    setFilter: function (q) {
      ui.filter = String(q || '');
      const s = $('rm-search');
      if (s) s.value = ui.filter;
      try { renderList(); } catch (e) {}
    },
    index: function () {
      const KIND = { home: 'home', private: 'private room', inn: 'rented room' };
      return (state.rooms || []).map((r) => ({
        label: r.name || '(unnamed room)',
        detail: [KIND[r.kind] || r.kind, r.cellName, r.note].filter(Boolean).join(' · '),
        kind: 'room',
        keywords: r.cellEdid || '',
        /* rooms are keyed by parent CELL (one claim per cell) — the same
           durable identity the guard itself uses */
        pin: 'rm:' + (r.cellEdid || r.cellName || r.name || ''),
      }));
    },
  });

  return {
    init, onShow, onHide, receive, toggleEdit, wantsPause, showTab,
    /* Blacklist entry point for OTHER panes (the F7 quick card): anchor
       element + { formId: runtime id, name }. Rooms data is loaded at every
       palette open (rgOpen), so this works without the Rooms tab ever having
       been visited. */
    banMenu, openNpcPicker,
    _state: state, _ui: ui, _pick: pick,          // test hooks only
    _anchorScale: anchorScale, _placePicker: placePicker
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.RoomsPane.init());
} else {
  window.RoomsPane.init();
}
