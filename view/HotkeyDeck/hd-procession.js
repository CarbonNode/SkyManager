'use strict';

/* ====================================================================== *
 *  Procession modal — Royal Procession (palanquins + lockstep bearers) and
 *  Royal Retinue (escort squads) in the deck.
 *
 *  Rober's asks (2026-10-11): a throne on poles carried by four bearers he
 *  can dress ("equipable"), escort troops from saved presets marching in
 *  blocks around the palanquin ("left right front right front left etc"),
 *  and "group one attack!" through Sic 'em. The two mods are separate SKSE
 *  plugins; each section here works alone and says plainly which mod is
 *  missing.
 *
 *  Shape: body-anchored modal (Formation's sibling), four tabs — Palanquin,
 *  Bearers, Wagons, Escort squads — and two drill-in pages with Back (never
 *  an inline expander): the preset editor inside Squads, the seat picker
 *  inside Wagons.
 *
 *  Wagons (Royal Procession api 3, 2026-10-12): the lead wagon and a convoy
 *  of up to three, each drawn as a top-down cart (driver's bench + four
 *  passenger seats). A seat opens the picker: everyone following you
 *  (PartyRecall's roster, sent by the bridge) plus whoever is under the
 *  crosshair, searchable, Enter seats the top hit. An api-2 DLL keeps its
 *  palanquin and this tab says it needs updating.
 *
 *  Bridge (one name per direction): rpxGet → rpxOpen · rpxAct → rpxResult.
 *  Both mods POST their writes; C++ re-pushes rpxOpen at 700 ms and 2.6 s
 *  after every verb, so the controls end on the ENGINE's truth.
 *
 *  Every list has a typeable filter; Enter takes the top hit's main action.
 *  Destructive verbs (dismiss, delete) arm on the first click and act on the
 *  second within 4 s. Ultralight: no prompt/confirm, no native range drag
 *  (steppers instead), title= is drawn by app.js's #hd-tip layer.
 *
 *  The Deck Portal hosts this same file (portal/procession.html) with its own
 *  toGame shim; window.RPX_LIVE_POLL makes it re-read every 3 s there.
 * ====================================================================== */

(function () {
  const SLOTS = ['front-left', 'front', 'front-right', 'left', 'right', 'rear-left', 'rear', 'rear-right'];
  const SLOT_LABEL = {
    'front-left': 'Front left', front: 'Front', 'front-right': 'Front right',
    left: 'Left flank', right: 'Right flank',
    'rear-left': 'Rear left', rear: 'Rear', 'rear-right': 'Rear right',
  };
  /* The 3x3 map: the centre is the palanquin (or you, without one). */
  const GRID = [['front-left', 'front', 'front-right'], ['left', null, 'right'], ['rear-left', 'rear', 'rear-right']];
  const POLES = ['Front left pole', 'Front right pole', 'Rear left pole', 'Rear right pole'];
  const ARM_MS = 4000;
  const UNITS_PER_M = 70;

  const S = {
    open: false,
    tab: 'palanquin',
    data: null,
    loading: false,
    q: { designs: '', presets: '', squads: '', people: '' },
    edit: null,        // preset draft {id,name,blocks:{slot:{rows,cols,spacing}},isNew}
    editSlot: 'front',
    seatPick: null,    // the seat picker's target {wagon, seat}; null = the convoy
    armed: {},         // key -> timestamp of the first click
    msg: null,         // {ok,text}
    busy: '',          // the verb in flight (button shows its working state)
    pollTimer: 0,
  };

  let el = null;
  let opener = null;

  /* --------------------------------------------------------- helpers -- */

  function toGameSafe(fn, arg) { if (typeof window.toGame === 'function') window.toGame(fn, arg); }
  function say(msg) { if (typeof window.toast === 'function') window.toast(msg); }
  const now = () => Date.now();

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return n;
  }

  /* Ultralight can deliver a native keydown as key "Unidentified" with only the
     legacy keyCode (measured 2026-10-11, ultralight-probe README) — so every
     key test goes through this, never ev.key alone. */
  const KEYCODES = { 9: 'Tab', 13: 'Enter', 27: 'Escape', 37: 'ArrowLeft', 39: 'ArrowRight' };
  function keyOf(e) {
    const k = e && e.key;
    if (k && k !== 'Unidentified') return k;
    return KEYCODES[e && (e.keyCode || e.which)] || k || '';
  }

  function norm(s) { return String(s || '').toLowerCase(); }
  /* Filter-as-you-type: every word must appear somewhere in the haystack. */
  function matches(q, ...fields) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = norm(fields.join(' '));
    return words.every((w) => hay.indexOf(w) !== -1);
  }

  function slug(name) {
    const s = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s || 'squad';
  }

  const rp = () => (S.data && S.data.rp) || { installed: false };
  const rr = () => (S.data && S.data.rr) || { installed: false };
  const rpState = () => (rp().state && typeof rp().state === 'object') ? rp().state : null;

  /* Royal Procession's wagon half: {supported, state} (api 3), else unsupported. */
  const wagonApi = () => (rp().wagon && typeof rp().wagon === 'object') ? rp().wagon : { supported: false };
  const wagonState = () => { const w = wagonApi(); return (w.supported && w.state && typeof w.state === 'object') ? w.state : null; };
  const wagons = () => { const st = wagonState(); return st && Array.isArray(st.wagons) ? st.wagons : []; };

  function presetSoldiers(p) {
    if (p && typeof p.count === 'number') return p.count;
    return (p && Array.isArray(p.blocks) ? p.blocks : []).reduce((n, b) => n + (b.rows || 0) * (b.cols || 0), 0);
  }

  function armed(key) { return S.armed[key] && now() - S.armed[key] < ARM_MS; }
  /* Two clicks for anything that removes people or presets. Returns true when
     this click should act. */
  function arm(key) {
    if (armed(key)) { delete S.armed[key]; return true; }
    S.armed[key] = now();
    setTimeout(() => { if (S.armed[key] && now() - S.armed[key] >= ARM_MS) { delete S.armed[key]; if (S.open) render(); } }, ARM_MS + 50);
    render();
    return false;
  }

  /* ----------------------------------------------------------- bridge -- */

  function request() {
    S.loading = !S.data;
    toGameSafe('rpxGet', '{}');
  }

  /* Which button shows "Working…": the verb plus its subject (squad, pole,
     design, preset id). Buttons compare against the same key. */
  function busyKey(op, extra) {
    const x = extra || {};
    const subj = x.squad != null ? x.squad : x.slot != null ? x.slot : x.type != null ? x.type
      : typeof x.preset === 'string' ? x.preset : x.id != null ? x.id
      : x.index != null ? x.index : x.formId != null ? x.formId : '';
    return subj === '' ? op : op + ':' + subj;
  }

  function act(op, extra, label) {
    if (S.busy) return;
    S.busy = busyKey(op, extra);
    S.msg = { ok: true, text: label || 'Working…', pending: true };
    render();
    toGameSafe('rpxAct', JSON.stringify(Object.assign({ op: op }, extra || {})));
  }

  window.rpxOpen = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    if (!d || typeof d !== 'object') return;
    S.data = d;
    S.loading = false;
    S.offline = '';
    if (!S.open) return;                       // never draw into a closed modal
    if (window.HDBurst && HDBurst.defer('rpx', render)) return;
    render();
  };

  /* The Portal's transport could not reach the game: say so, offer a retry. */
  window.rpxOffline = function (msg) {
    S.offline = String(msg || 'The game did not answer.');
    S.loading = false;
    if (S.open) render();
  };

  window.rpxResult = function (payload) {
    let r = payload;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = null; } }
    S.busy = '';
    if (!r || typeof r !== 'object') r = { ok: false, msg: 'No answer from the game' };
    S.msg = { ok: !!r.ok, text: r.msg || (r.ok ? 'Done' : 'That did not work') };
    if (r.ok && S.edit && S.edit.saving) S.edit = null;   // saved: back to the list
    if (S.edit) delete S.edit.saving;
    if (r.ok && S.seatPick && S.seatPick.saving) S.seatPick = null;   // seated: back to the convoy
    if (S.seatPick) delete S.seatPick.saving;
    say(S.msg.text);
    if (S.open) render();
  };

  /* --------------------------------------------------------------- dom -- */

  function ensureDom() {
    if (el) return el;
    el = h('div', { id: 'rpx-modal', class: 'hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Procession' });
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
    document.body.appendChild(el);
    return el;
  }

  /* Rebuilding the body would drop the caret out of a search box mid-word;
     remember which input had focus (by data-key) and its selection. */
  function captureFocus() {
    const a = document.activeElement;
    if (!a || !el || !el.contains(a) || !a.getAttribute) return null;
    const key = a.getAttribute('data-key');
    if (!key) return null;
    let s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch (x) {}
    return { key, s, e };
  }
  function restoreFocus(f) {
    if (!f || !el) return;
    const n = el.querySelector('[data-key="' + f.key + '"]');
    if (!n) return;
    n.focus();
    try { if (f.s != null) n.setSelectionRange(f.s, f.e); } catch (x) {}
  }

  function btn(label, opts) {
    const o = opts || {};
    const cls = 'rpx-btn' + (o.kind ? ' rpx-' + o.kind : '') + (o.armed ? ' rpx-armed' : '') + (o.busy ? ' rpx-busy' : '');
    return h('button', {
      type: 'button', class: cls, disabled: o.disabled || null, title: o.title || null,
      'data-key': o.key || null, onclick: o.onclick || null, 'aria-busy': o.busy ? 'true' : null,
    }, o.busy ? 'Working…' : label);
  }

  function search(key, placeholder, onEnter) {
    const input = h('input', {
      type: 'search', class: 'rpx-search', placeholder: placeholder, value: S.q[key] || '', name: 'rpx-' + key,
      'data-key': 'q-' + key, 'aria-label': placeholder, autocomplete: 'off', spellcheck: 'false',
    });
    input.addEventListener('input', () => { S.q[key] = input.value; render(); });
    input.addEventListener('keydown', (e) => {
      const k = keyOf(e);
      if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); onEnter(); }
      else if (k === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); S.q[key] = ''; render(); }
    });
    return input;
  }

  function empty(title, text, action) {
    return h('div', { class: 'rpx-empty' }, h('div', { class: 'rpx-empty-t' }, title), text ? h('p', null, text) : null, action || null);
  }

  /* A missing mod gets the whole tab: what it would give you, and the two
     steps to get it — never a small note over an empty slab. */
  function missing(which) {
    const isRp = which === 'rp';
    const name = isRp ? 'Royal Procession' : 'Royal Retinue';
    const what = isRp ? 'palanquins, the four bearers who carry you, and wagons' : 'escort squads that march in formation around you';
    const loadedOld = isRp ? rp().loaded : rr().loaded;
    const art = isRp
      ? h('div', { class: 'rpx-missing-art' },
          h('img', { src: artUrl('rpx-nordic.png'), alt: '', width: '720', height: '440', draggable: 'false' }),
          h('img', { src: artUrl('rpx-necro.png'), alt: '', width: '720', height: '440', draggable: 'false' }))
      : h('div', { class: 'rpx-missing-art rpx-missing-map', 'aria-hidden': 'true' }, miniMap([
          { slot: 'front-left', rows: 1, cols: 2 }, { slot: 'front', rows: 2, cols: 2 }, { slot: 'front-right', rows: 1, cols: 2 },
          { slot: 'left', rows: 2, cols: 1 }, { slot: 'right', rows: 2, cols: 1 }, { slot: 'rear', rows: 1, cols: 3 }]));
    return h('div', { class: 'rpx-missing' }, art,
      h('div', { class: 'rpx-empty-t' }, name + (loadedOld ? ' needs updating' : ' is not running')),
      h('p', null, loadedOld
        ? name + ' is loaded but older than this deck expects. Install the matching build, then restart the game.'
        : 'This tab drives ' + what + '. It needs the ' + name + ' mod.'),
      loadedOld ? null : h('ol', { class: 'rpx-steps' },
        h('li', null, 'Tick “' + name + '” in Mod Organizer’s left pane.'),
        h('li', null, 'Restart the game, then open this tab again.')));
  }

  /* ------------------------------------------------------- palanquin -- */

  function stateLine(st) {
    if (!st || !st.mount) return null;
    const types = rp().types || [];
    const t = types.find((x) => x.id === st.type);
    return (t ? t.name : (st.mount.name || 'Palanquin'));
  }

  function bearerCount(st) {
    const b = (st && Array.isArray(st.bearers)) ? st.bearers.filter(Boolean) : [];
    const atPole = b.filter((x) => typeof x.dist === 'number' && x.dist >= 0 && x.dist < 40).length;
    return { present: b.length, atPole: atPole };
  }

  function renderPalanquin(body) {
    if (!rp().installed) { body.appendChild(missing('rp')); return; }
    const st = rpState();
    const types = rp().types || [];

    /* -- where it stands now -- */
    const card = h('section', { class: 'rpx-status' });
    if (st && st.mount) {
      const bc = bearerCount(st);
      const marching = !!st.active;
      card.appendChild(h('div', { class: 'rpx-status-main' },
        h('div', { class: 'rpx-kicker' }, marching ? 'Procession under way' : 'Palanquin parked'),
        h('h2', { class: 'rpx-status-t', title: stateLine(st) }, stateLine(st)),
        h('div', { class: 'rpx-chips' },
          h('span', { class: 'rpx-chip' + (bc.present === 4 ? ' rpx-good' : ' rpx-warn') }, bc.present + ' of 4 bearers'),
          h('span', { class: 'rpx-chip' + (bc.atPole === bc.present && bc.present ? ' rpx-good' : '') }, bc.atPole + ' at their poles'),
          h('span', { class: 'rpx-chip' + (st.seated ? ' rpx-good' : '') }, st.seated ? 'You are on the throne' : 'You are not seated'),
          marching ? h('span', { class: 'rpx-chip' }, Math.round(st.speed || 0) + ' units/s') : null)));
      card.appendChild(h('div', { class: 'rpx-status-acts' },
        btn(marching ? 'Stop the procession' : 'Start the procession', {
          kind: marching ? null : 'primary', key: 'march', busy: S.busy === 'march',
          title: marching ? 'Release the bearers; they stand by the poles' : 'Bearers take their poles and walk in step with you',
          onclick: () => act('march', { on: !marching }, marching ? 'Releasing the bearers…' : 'Bearers, to your poles…'),
        }),
        btn(armed('dismiss') ? 'Click again to dismiss' : 'Dismiss palanquin', {
          kind: 'danger', armed: armed('dismiss'), key: 'dismiss', busy: S.busy === 'dismiss',
          title: 'Removes the palanquin and its four bearers',
          onclick: () => { if (arm('dismiss')) act('dismiss', null, 'Dismissing…'); },
        })));
    } else {
      card.appendChild(h('div', { class: 'rpx-status-main' },
        h('div', { class: 'rpx-kicker' }, 'No palanquin'),
        h('h2', { class: 'rpx-status-t' }, 'Summon one below'),
        h('p', { class: 'rpx-help' }, 'It appears beside you with four bearers. Mount it like a horse, then start the procession.')));
    }
    body.appendChild(card);

    /* -- the designs -- */
    const list = types.filter((t) => matches(S.q.designs, t.name, t.detail));
    const sec = h('section', { class: 'rpx-sec' });
    sec.appendChild(h('div', { class: 'rpx-sec-head' },
      h('h3', { class: 'rpx-sec-t' }, 'Summon a palanquin'),
      search('designs', 'Search designs…', () => { if (list[0]) summon(list[0]); })));
    if (!list.length) {
      sec.appendChild(empty('No design matches “' + S.q.designs + '”', 'Clear the search to see every palanquin.'));
    } else {
      const grid = h('div', { class: 'rpx-cards rpx-cards-2' });
      list.forEach((t, i) => {
        const current = st && st.mount && st.type === t.id;
        grid.appendChild(h('div', { class: 'rpx-card rpx-design' + (i === 0 && S.q.designs ? ' rpx-top' : '') + (current ? ' rpx-current' : '') },
          t.image ? h('div', { class: 'rpx-art' }, h('img', { src: artUrl(t.image), alt: t.name, width: '720', height: '440', draggable: 'false' })) : null,
          h('div', { class: 'rpx-card-t', title: t.name }, t.name),
          h('p', { class: 'rpx-card-d' }, t.detail || ''),
          h('div', { class: 'rpx-card-acts' },
            btn(current ? 'Bring it here' : (st && st.mount ? 'Swap to this one' : 'Summon'), {
              kind: 'primary', key: 'summon-' + t.id, busy: S.busy === 'summon:' + t.id,
              onclick: () => summon(t),
            }))));
      });
      sec.appendChild(grid);
    }
    body.appendChild(sec);
  }

  /* The Portal serves the view's files from its own asset route. */
  function artUrl(name) { return (window.RPX_ASSET_BASE || '') + name; }

  function summon(t) { act('summon', { type: t.id }, 'Summoning the ' + t.name + '…'); }

  /* --------------------------------------------------------- bearers -- */

  function renderBearers(body) {
    if (!rp().installed) { body.appendChild(missing('rp')); return; }
    const st = rpState();
    if (!st || !st.mount) {
      body.appendChild(empty('No palanquin yet', 'Summon one on the Palanquin tab; its four bearers come with it.',
        btn('Go to Palanquin', { kind: 'primary', onclick: () => setTab('palanquin') })));
      return;
    }
    body.appendChild(h('p', { class: 'rpx-help rpx-lead' },
      'Your bearers are ordinary people: dress them like anyone else. “Open gear” closes the deck and opens their inventory.'));
    const bearers = Array.isArray(st.bearers) ? st.bearers : [];
    const map = h('div', { class: 'rpx-poles' });
    const cell = (i) => {
      const b = bearers[i];
      const card = h('div', { class: 'rpx-pole rpx-pole-' + i + (b ? '' : ' rpx-vacant') });
      card.appendChild(h('div', { class: 'rpx-kicker' }, POLES[i]));
      if (!b) {
        card.appendChild(h('div', { class: 'rpx-pole-name rpx-muted' }, 'Nobody'));
        card.appendChild(h('p', { class: 'rpx-help' }, 'Dismiss and summon the palanquin again to bring a new bearer.'));
        return card;
      }
      const d = typeof b.dist === 'number' ? b.dist : -1;
      const where = d < 0 ? ['Elsewhere', 'rpx-warn'] : d < 40 ? ['At the pole', 'rpx-good'] : d < 300 ? ['Walking to the pole', ''] : ['Far away', 'rpx-warn'];
      card.appendChild(h('div', { class: 'rpx-pole-name', title: b.name }, b.name || 'Bearer'));
      card.appendChild(h('div', { class: 'rpx-chips' }, h('span', { class: 'rpx-chip ' + where[1] }, where[0])));
      card.appendChild(h('p', { class: 'rpx-help' }, b.puppet && d >= 0 && d < 40 ? 'Carrying, in step with the other three'
        : st.active ? 'Catching up to the pole' : 'Waiting by the palanquin'));
      card.appendChild(h('div', { class: 'rpx-card-acts' },
        btn('Open gear', { key: 'gear-' + i, busy: S.busy === 'gear:' + i, onclick: () => act('gear', { slot: i }, 'Opening their gear…') }),
        btn('Dress all like this one', {
          key: 'dress-' + i, busy: S.busy === 'dressAll:' + i, title: 'The other three get copies of what this bearer wears',
          onclick: () => act('dressAll', { slot: i }, 'Dressing all four alike…'),
        })));
      return card;
    };
    map.appendChild(cell(0));
    map.appendChild(h('div', { class: 'rpx-throne', 'aria-hidden': 'true' },
      h('div', { class: 'rpx-throne-pole rpx-throne-pole-l' }), h('div', { class: 'rpx-throne-pole rpx-throne-pole-r' }),
      h('div', { class: 'rpx-throne-seat' }, 'Throne'), h('div', { class: 'rpx-throne-front' }, 'Front')));
    map.appendChild(cell(1));
    map.appendChild(cell(2));
    map.appendChild(cell(3));
    body.appendChild(map);
  }

  /* ---------------------------------------------------------- wagons -- */

  /* The five seats in RoyalProcession_SeatInWagon's order. `area` places the
     seat on the top-down cart (hd-procession.css: .rpx-cart grid areas). */
  const SEATS = [
    { label: 'Driver’s bench', short: 'Driver', area: 'bench' },
    { label: 'Left front', short: 'Left front', area: 'lf' },
    { label: 'Right front', short: 'Right front', area: 'rf' },
    { label: 'Left rear', short: 'Left rear', area: 'lr' },
    { label: 'Right rear', short: 'Right rear', area: 'rr' },
  ];

  /* A form id as the bridge spells it: a number (people), or hex text
     ("FE001810" in the wagon state). */
  function fid(v) {
    if (typeof v === 'number') return v >>> 0;
    const n = parseInt(String(v || '').replace(/^0x/i, ''), 16);
    return isNaN(n) ? 0 : n >>> 0;
  }
  const wagonLabel = (i) => (i === 0 ? 'Lead wagon' : 'Wagon ' + (i + 1));
  const seatsOf = (w) => (w && Array.isArray(w.seats) ? w.seats : []);
  const seatedCount = (w) => seatsOf(w).filter(Boolean).length;

  function whereSeated(id) {
    const ws = wagons();
    for (let wi = 0; wi < ws.length; wi++) {
      const seats = seatsOf(ws[wi]);
      for (let si = 0; si < seats.length; si++) if (seats[si] && fid(seats[si].id) === id) return { wagon: wi, seat: si };
    }
    return null;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* A person's face, the way Get Away and the Household tab draw it: the
     Followers pane decides photo vs facegen head (FolPane.portraitInfoFor);
     the Portal has no FolPane and keeps the initials. */
  function face(id, name, big) {
    const frame = h('span', { class: 'rpx-face' + (big ? ' rpx-face-big' : ''), 'aria-hidden': 'true' });
    const p = id && window.FolPane && typeof FolPane.portraitInfoFor === 'function'
      ? FolPane.portraitInfoFor({ formId: '0x' + id.toString(16), name: name }) : null;
    if (!p) { frame.textContent = initials(name); return frame; }
    const plain = p.abs ? p.file : 'portraits/' + p.file;
    const img = h('img', { alt: '', draggable: 'false', width: '56', height: '56' });
    img.src = plain + (p.abs ? '' : '?v=' + (p.mtime || 0));
    img.setAttribute('data-portrait', plain);
    let retried = false;
    img.addEventListener('error', () => {
      if (!retried) { retried = true; img.src = plain; return; }
      if (img.parentNode === frame) frame.removeChild(img);
      frame.textContent = initials(name);
    });
    frame.appendChild(img);
    return frame;
  }
  function fitFaces(root) {
    if (!window.HDFaceFit || !root) return;
    root.querySelectorAll('.rpx-face img').forEach((img) => {
      const src = img.getAttribute('data-portrait') || '';
      if (src.indexOf('icons/npcs/') !== -1) HDFaceFit.ensure(img, src);
      else if (typeof HDFaceFit.paintPortrait === 'function') HDFaceFit.paintPortrait(img, src);
    });
  }

  /* Everyone the picker offers: the crosshair person first, then the
     following roster, then anyone already seated (a spawned coachman can
     change seats too). */
  function candidates() {
    const out = [];
    const seen = {};
    const add = (id, name, extra) => {
      const n = fid(id);
      if (!n || seen[n]) return;
      seen[n] = 1;
      out.push(Object.assign({ id: n, name: name || '?', loaded: true }, extra));
    };
    const c = S.data && S.data.crosshair;
    if (c && !c.horse) add(c.id, c.name, { cross: true });
    (Array.isArray(rp().people) ? rp().people : []).forEach((p) => add(p.id, p.name, {
      basis: p.basis, waiting: !!p.waiting, loaded: p.loaded !== false, dist: typeof p.dist === 'number' ? p.dist : null,
    }));
    wagons().forEach((w) => seatsOf(w).forEach((x) => { if (x) add(x.id, x.name, { spawned: !!x.spawned }); }));
    out.forEach((p) => { p.at = whereSeated(p.id); });
    const rank = (p) => (p.cross ? 0 : !p.loaded ? 3 : p.at ? 2 : 1);
    return out.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0])
      || ((a[0].dist == null ? 1e9 : a[0].dist) - (b[0].dist == null ? 1e9 : b[0].dist)) || a[1] - b[1]).map((x) => x[0]);
  }

  /* What the row says about a person, for the seat being filled. */
  function personDetail(p, pick) {
    if (p.at && p.at.wagon === pick.wagon && p.at.seat === pick.seat) return 'Sitting here now';
    if (!p.loaded) return 'Not nearby — recall them first';
    /* short on purpose: two lines on a phone must still say where they sit now */
    const where = p.at ? 'Seated · ' + wagonLabel(p.at.wagon) + ' · ' + SEATS[p.at.seat].short : '';
    if (p.cross) return where || 'Under your crosshair';
    if (where) return where;
    const base = p.basis ? (p.waiting ? 'Waiting for you' : 'Following you') : p.spawned ? 'Hired coachman' : 'Nearby';
    return base + (p.dist != null ? ' · ' + p.dist + ' m away' : '');
  }
  const seatable = (p, pick) => p.loaded && !(p.at && p.at.wagon === pick.wagon && p.at.seat === pick.seat);

  /* Who the portrait poll should fetch while this tab is drawing faces. */
  function portraitIds() {
    if (!S.open || S.tab !== 'wagons' || !wagonApi().supported) return [];
    return candidates().map((p) => '0x' + p.id.toString(16));
  }
  let faceAsked = '';
  function askFaces() {
    const ids = portraitIds().sort().join(',');
    if (!ids || ids === faceAsked) return;
    faceAsked = ids;
    if (window.FolPane && typeof FolPane.requestPortraitFaces === 'function') FolPane.requestPortraitFaces();
  }

  function seatAct(p, pick) {
    if (!seatable(p, pick)) return;
    S.seatPick = { wagon: pick.wagon, seat: pick.seat, saving: true };
    act('wagonSeat', { formId: p.id, wagon: pick.wagon, seat: pick.seat }, 'Seating ' + p.name + '…');
  }
  function unseatAct(x) {
    act('wagonUnseat', { formId: fid(x.id) }, (x.name || 'They') + ' climbs down…');
  }
  function openPicker(wi, si) {
    S.seatPick = { wagon: wi, seat: si };
    S.q.people = '';
    render();
    const n = el && el.querySelector('[data-key="q-people"]');
    if (n) n.focus();
  }

  /* One seat on the cart. mode 'card': an empty seat opens the picker, a
     taken one offers Change + Unseat. mode 'pick': every seat retargets the
     open picker. mode 'ghost': drawing only. */
  function seatTile(w, wi, si, mode) {
    const x = seatsOf(w)[si];
    const def = SEATS[si];
    const cls = 'rpx-seat rpx-seat-' + def.area + (x ? '' : ' rpx-seat-empty');
    const label = h('span', { class: 'rpx-seat-l' }, def.label);
    if (mode === 'ghost') return h('div', { class: cls, 'aria-hidden': 'true' }, label, h('span', { class: 'rpx-seat-n rpx-muted' }, si === 0 ? 'Driver' : 'Passenger'));
    if (mode === 'pick') {
      const on = S.seatPick && S.seatPick.wagon === wi && S.seatPick.seat === si;
      return h('button', {
        type: 'button', class: cls + ' rpx-seat-btn' + (on ? ' rpx-seat-on' : ''), 'data-key': 'pickseat-' + wi + '-' + si,
        'aria-pressed': on ? 'true' : 'false', title: x ? def.label + ': ' + x.name : def.label + ': empty',
        onclick: () => { S.seatPick = { wagon: wi, seat: si }; render(); },
      }, label, x ? h('span', { class: 'rpx-seat-n', title: x.name }, x.name) : h('span', { class: 'rpx-seat-n rpx-muted' }, 'Empty'));
    }
    if (!x) {
      return h('button', {
        type: 'button', class: cls + ' rpx-seat-btn', 'data-key': 'seat-' + wi + '-' + si,
        'aria-label': 'Seat someone: ' + wagonLabel(wi) + ', ' + def.label, onclick: () => openPicker(wi, si),
      }, label, h('span', { class: 'rpx-seat-add' }, h('span', { class: 'rpx-seat-plus', 'aria-hidden': 'true' }, '+'), 'Seat someone'));
    }
    const id = fid(x.id);
    const role = si === 0 ? 'Driving' : 'Riding';
    return h('div', { class: cls },
      label,
      h('div', { class: 'rpx-seat-who' }, face(id, x.name),
        h('div', { class: 'rpx-seat-txt' },
          h('div', { class: 'rpx-seat-n', title: x.name }, x.name || '?'),
          h('div', { class: 'rpx-seat-r' }, role))),
      h('div', { class: 'rpx-seat-acts' },
        btn('Change', { key: 'seat-' + wi + '-' + si, title: 'Seat someone else here', onclick: () => openPicker(wi, si) }),
        btn('Unseat', { key: 'unseat-' + wi + '-' + si, busy: S.busy === 'wagonUnseat:' + id, title: x.name + ' climbs down',
          onclick: () => unseatAct(x) })));
  }

  /* The cart from above. Front faces right on a wide screen, up on a phone;
     the horse is in front, the driver's bench behind it. */
  function cart(w, wi, mode) {
    const horse = w && w.name ? w.name : (mode === 'ghost' ? 'Draught horse' : 'No horse');
    const grid = h('div', { class: 'rpx-cart' + (mode === 'ghost' ? ' rpx-cart-ghost' : ''), role: mode === 'ghost' ? null : 'group',
      'aria-label': mode === 'ghost' ? null : wagonLabel(wi) + ' seats' });
    grid.appendChild(h('div', { class: 'rpx-cart-bed', 'aria-hidden': 'true' },
      h('span', { class: 'rpx-wheel rpx-wheel-1' }), h('span', { class: 'rpx-wheel rpx-wheel-2' }),
      h('span', { class: 'rpx-wheel rpx-wheel-3' }), h('span', { class: 'rpx-wheel rpx-wheel-4' })));
    grid.appendChild(h('div', { class: 'rpx-cart-horse', title: horse },
      h('span', { class: 'rpx-seat-l' }, 'Horse'), h('span', { class: 'rpx-cart-horse-n' }, horse),
      h('span', { class: 'rpx-cart-front' }, 'Front')));
    for (let si = 0; si < SEATS.length; si++) grid.appendChild(seatTile(w, wi, si, mode));
    return grid;
  }

  function wagonChips(w, wi) {
    const chips = [];
    if (!w.loaded) chips.push(['Far away', 'rpx-warn']);
    else chips.push(w.hitched ? ['Hitched', 'rpx-good'] : ['Cart not attached', 'rpx-warn']);
    if (wi === 0 && w.driven) chips.push(['You are driving', 'rpx-good']);
    const swing = Math.round(Math.abs(w.swingDeg || 0));
    if (w.loaded && w.hitched && swing >= 2) chips.push(['Turning ' + swing + '°', '']);
    chips.push([seatedCount(w) + ' of ' + SEATS.length + ' seats', seatedCount(w) ? '' : 'rpx-muted']);
    return h('div', { class: 'rpx-chips' }, chips.map((c) => h('span', { class: 'rpx-chip ' + c[1] }, c[0])));
  }

  function wagonCard(w, wi) {
    const driver = seatsOf(w)[0];
    const remove = 'cvrm-' + wi;
    return h('section', { class: 'rpx-wagon' + (wi === 0 ? ' rpx-wagon-lead' : ''), 'data-wagon': String(wi) },
      h('div', { class: 'rpx-wagon-head' },
        h('div', { class: 'rpx-wagon-id' },
          h('div', { class: 'rpx-kicker' }, wagonLabel(wi) + (wi ? ' · follows the lead' : '')),
          h('div', { class: 'rpx-wagon-t', title: driver ? 'Driven by ' + driver.name : 'No driver' },
            driver ? 'Driven by ' + driver.name : 'No driver yet')),
        wagonChips(w, wi),
        wi > 0 ? h('div', { class: 'rpx-wagon-acts' }, btn(armed(remove) ? 'Click again to unhitch' : 'Unhitch & remove', {
          kind: 'danger', armed: armed(remove), key: remove, busy: S.busy === 'convoyRemove:' + wi,
          title: 'Everyone climbs down; a spawned horse and coachman leave',
          onclick: () => { if (arm(remove)) act('convoyRemove', { index: wi }, 'Wagon ' + (wi + 1) + ' leaves the convoy…'); },
        })) : null),
      cart(w, wi, 'card'));
  }

  /* The next wagon's outline: a peer of the real cards, holding the Add. */
  function ghostCard(n) {
    return h('section', { class: 'rpx-wagon rpx-wagon-ghost' },
      h('div', { class: 'rpx-wagon-head' },
        h('div', { class: 'rpx-wagon-id' },
          h('div', { class: 'rpx-kicker' }, 'Wagon ' + (n + 1) + ' · room for one more'),
          h('div', { class: 'rpx-wagon-t' }, 'Add a wagon to the convoy')),
        h('p', { class: 'rpx-help rpx-wagon-note' }, 'A draught horse and a coachman follow in the lead wagon’s tracks.'),
        h('div', { class: 'rpx-wagon-acts' }, btn('Add wagon ' + (n + 1), {
          kind: 'primary', key: 'convoyAdd', busy: S.busy === 'convoyAdd', onclick: () => act('convoyAdd', null, 'Calling wagon ' + (n + 1) + '…'),
        }))),
      cart(null, n, 'ghost'));
  }

  /* An api-2 Royal Procession: the palanquin works, wagons need the update. */
  function wagonsOutdated() {
    return h('div', { class: 'rpx-missing' },
      h('div', { class: 'rpx-missing-art rpx-missing-cart' }, cart(null, 0, 'ghost')),
      h('div', { class: 'rpx-empty-t' }, 'Royal Procession needs updating for wagons'),
      h('p', null, 'The Royal Procession you have' + (rp().api ? ' (API ' + rp().api + ')' : '') +
        ' carries palanquins but not wagons. Your palanquin and bearers keep working meanwhile.'),
      h('ol', { class: 'rpx-steps' },
        h('li', null, 'Install the Royal Procession build with wagons (API 3).'),
        h('li', null, 'Restart the game, then open this tab again.')));
  }

  function renderWagons(body) {
    if (!rp().installed) { body.appendChild(missing('rp')); return; }
    if (!wagonApi().supported) { body.appendChild(wagonsOutdated()); return; }
    const ws = wagons();
    if (S.seatPick && !ws[S.seatPick.wagon]) S.seatPick = null;   // that wagon has gone
    if (S.seatPick) { renderSeatPicker(body); return; }
    const st = wagonState() || {};
    const max = st.maxWagons || 3;
    const cross = S.data && S.data.crosshair;
    const horseX = cross && cross.horse ? cross : null;
    const seated = ws.reduce((n, w) => n + seatedCount(w), 0);
    const lead = ws[0];

    /* -- the train at a glance -- */
    const card = h('section', { class: 'rpx-status' });
    card.appendChild(h('div', { class: 'rpx-status-main' },
      h('div', { class: 'rpx-kicker' }, lead ? (lead.driven ? 'You hold the reins' : ws.length > 1 ? 'Convoy ready' : 'Wagon ready') : 'No wagon'),
      h('h2', { class: 'rpx-status-t' }, lead
        ? ws.length + (ws.length === 1 ? ' wagon' : ' wagons') + ' · ' + seated + ' seated'
        : 'Summon a wagon to travel together'),
      lead ? h('div', { class: 'rpx-chips' },
        h('span', { class: 'rpx-chip', title: lead.name || '' }, (lead.name || 'No horse') + ' pulls the lead'),
        h('span', { class: 'rpx-chip' + (lead.hitched ? ' rpx-good' : ' rpx-warn') }, lead.hitched ? 'Hitched' : 'Cart not attached'),
        h('span', { class: 'rpx-chip' + (lead.driven ? ' rpx-good' : '') }, lead.driven ? 'You are driving' : 'You are not driving'))
        : h('p', { class: 'rpx-help' }, 'Riding a horse? The wagon hitches to it. On foot, a draught horse and the Royal Coachman bring it to you.')));
    card.appendChild(h('div', { class: 'rpx-status-acts' },
      btn(lead ? 'Bring the wagon' : 'Summon the wagon', {
        kind: 'primary', key: 'wagonSummon', busy: S.busy === 'wagonSummon',
        title: 'Hitches to the horse you ride; otherwise a draught horse brings it',
        onclick: () => act('wagonSummon', null, lead ? 'Bringing the wagon…' : 'Summoning the wagon…'),
      }),
      horseX ? btn('Hitch to ' + horseX.name, {
        key: 'wagonHitch', busy: S.busy === 'wagonHitch:' + fid(horseX.id), title: horseX.name + ' pulls the lead wagon',
        onclick: () => act('wagonHitch', { formId: fid(horseX.id) }, 'Hitching to ' + horseX.name + '…'),
      }) : null,
      lead ? btn(armed('wagonDismiss') ? 'Click again to dismiss' : 'Dismiss all wagons', {
        kind: 'danger', armed: armed('wagonDismiss'), key: 'wagonDismiss', busy: S.busy === 'wagonDismiss',
        title: 'Unhitches every horse; everyone climbs down; spawned horses and coachmen leave',
        onclick: () => { if (arm('wagonDismiss')) act('wagonDismiss', null, 'Dismissing the wagons…'); },
      }) : null));
    body.appendChild(card);

    /* -- the convoy, lead first; or what a wagon holds -- */
    const sec = h('section', { class: 'rpx-sec' });
    if (lead) {
      sec.appendChild(h('div', { class: 'rpx-sec-head' },
        h('h3', { class: 'rpx-sec-t' }, 'Convoy', h('span', { class: 'rpx-count' }, ws.length + '/' + max)),
        ws.length >= max ? h('span', { class: 'rpx-help rpx-full-note' }, 'The convoy is full — Royal Procession runs ' + max + ' wagons at most.') : null));
      const list = h('div', { class: 'rpx-wagons' });
      ws.forEach((w, wi) => list.appendChild(wagonCard(w, wi)));
      if (ws.length < max) list.appendChild(ghostCard(ws.length));
      sec.appendChild(list);
    } else {
      sec.appendChild(h('div', { class: 'rpx-sec-head' }, h('h3', { class: 'rpx-sec-t' }, 'What a wagon holds')));
      sec.appendChild(h('div', { class: 'rpx-wagons' }, h('section', { class: 'rpx-wagon rpx-wagon-ghost rpx-wagon-intro' },
        h('p', { class: 'rpx-help' }, 'A driver on the bench and four passengers. Pick each seat’s person from everyone following you. Add up to two more wagons and they follow in line.'),
        cart(null, 0, 'ghost'))));
    }
    body.appendChild(sec);
    askFaces();
  }

  function renderSeatPicker(body) {
    const pick = S.seatPick;
    const ws = wagons();
    const w = ws[pick.wagon];
    const occ = seatsOf(w)[pick.seat];
    const people = candidates();
    const list = people.filter((p) => matches(S.q.people, p.name, personDetail(p, pick)));
    const top = list.find((p) => seatable(p, pick));

    body.appendChild(h('div', { class: 'rpx-ed-head rpx-pick-head' },
      btn('‹ Back to the convoy', { key: 'pick-back', onclick: () => { S.seatPick = null; render(); } }),
      h('div', { class: 'rpx-pick-title' },
        h('h3', { class: 'rpx-sec-t' }, occ ? 'Change who sits here' : 'Seat someone'),
        h('div', { class: 'rpx-help rpx-pick-sub' }, wagonLabel(pick.wagon) + ' · ' + SEATS[pick.seat].label +
          (occ ? ' · now ' + occ.name : '')))));

    /* A narrow screen has no room for the side cart: the five seats as a
       segmented bar instead (hidden on a wide one, where the cart shows). */
    body.appendChild(h('div', { class: 'rpx-seatbar', role: 'group', 'aria-label': 'Which seat' },
      SEATS.map((def, si) => {
        const on = si === pick.seat;
        const x = seatsOf(w)[si];
        return h('button', {
          type: 'button', class: 'rpx-seatbar-b' + (on ? ' on' : '') + (x ? ' taken' : ''), 'data-key': 'seatbar-' + si,
          'aria-pressed': on ? 'true' : 'false', title: def.label + (x ? ': ' + x.name : ': empty'),
          onclick: () => { S.seatPick = { wagon: pick.wagon, seat: si }; render(); },
        }, def.short);
      })));

    const layout = h('div', { class: 'rpx-pick' });
    /* -- the people -- */
    const left = h('div', { class: 'rpx-pick-list' });
    left.appendChild(h('div', { class: 'rpx-sec-head' },
      search('people', 'Search people… (Enter: seat)', () => { if (top) seatAct(top, pick); }),
      h('span', { class: 'rpx-count', title: 'People you can seat' }, String(people.filter((p) => seatable(p, pick)).length))));
    if (!people.length) {
      left.appendChild(empty('Nobody to seat yet', 'Everyone following you shows up here. To seat anyone else, look at them and open the deck.'));
    } else if (!list.length) {
      left.appendChild(empty('Nobody matches “' + S.q.people + '”', 'Clear the search to see everyone you can seat.'));
    } else {
      const rows = h('div', { class: 'rpx-rows rpx-people' });
      list.forEach((p) => {
        const can = seatable(p, pick);
        const here = p.at && p.at.wagon === pick.wagon && p.at.seat === pick.seat;
        rows.appendChild(h('div', { class: 'rpx-row rpx-person' + (p === top && S.q.people ? ' rpx-top' : '') + (can ? '' : ' rpx-unavail'), 'data-person': String(p.id) },
          face(p.id, p.name, true),
          h('div', { class: 'rpx-row-main' },
            h('div', { class: 'rpx-row-t', title: p.name }, p.name),
            h('div', { class: 'rpx-row-d', title: personDetail(p, pick) }, personDetail(p, pick))),
          h('div', { class: 'rpx-row-acts' }, btn(here ? 'Seated' : p.at ? 'Move here' : 'Seat', {
            kind: can && p === top ? 'primary' : null, disabled: !can, key: 'pp-' + p.id, busy: S.busy === 'wagonSeat:' + p.id,
            title: can ? 'Seat ' + p.name + ' at ' + SEATS[pick.seat].label.toLowerCase() : null,
            onclick: () => seatAct(p, pick),
          }))));
      });
      left.appendChild(rows);
    }
    layout.appendChild(left);

    /* -- which seat (tap another to retarget) -- */
    const side = h('aside', { class: 'rpx-pick-side' },
      h('div', { class: 'rpx-kicker' }, wagonLabel(pick.wagon)),
      cart(w, pick.wagon, 'pick'),
      h('p', { class: 'rpx-help' }, 'Pick another seat to fill that one instead.'),
      occ ? btn('Unseat ' + occ.name, { key: 'pick-unseat', busy: S.busy === 'wagonUnseat:' + fid(occ.id), onclick: () => unseatAct(occ) }) : null);
    layout.appendChild(side);
    body.appendChild(layout);
    askFaces();
  }

  /* ---------------------------------------------------------- squads -- */

  function squadCounts(s) {
    const m = Array.isArray(s.members) ? s.members : [];
    const by = {};
    m.forEach((x) => { by[x.state] = (by[x.state] || 0) + 1; });
    const alive = m.filter((x) => x.state !== 'dead').length;
    return { total: m.length, alive: alive, by: by };
  }

  function renderSquads(body) {
    if (!rr().installed) { body.appendChild(missing('rr')); return; }
    if (S.edit) { renderEditor(body); return; }
    const squads = Array.isArray(rr().squads) ? rr().squads : [];
    const presets = Array.isArray(rr().presets) ? rr().presets : [];
    /* Squads: Hold Here / Fall In (Retinue api 2) - every squad at once. */
    const holding = !!rr().holding && squads.length > 0;

    /* -- live squads -- */
    const live = squads.filter((s) => matches(S.q.squads, 'group ' + s.group, s.name, s.preset));
    const sec = h('section', { class: 'rpx-sec' });
    sec.appendChild(h('div', { class: 'rpx-sec-head' },
      h('h3', { class: 'rpx-sec-t' }, 'Squads out now', h('span', { class: 'rpx-count' }, String(squads.length))),
      squads.length ? search('squads', 'Search squads… (Enter: attack)', () => { if (live[0]) attack(live[0]); }) : null,
      squads.length && rr().canHold ? btn(holding ? 'Fall in' : 'Hold here', {
        kind: holding ? 'primary' : '', key: 'hold', busy: S.busy === 'squadHold',
        title: holding ? 'Your squads leave the post and fall in around you again'
          : 'Your squads stay and guard this spot while you go on',
        onclick: () => act('squadHold', { hold: !holding }, holding ? 'Squads, fall in…' : 'Squads, hold here…'),
      }) : null,
      squads.length > 1 ? btn(armed('dismissAll') ? 'Click again to dismiss all' : 'Dismiss all', {
        kind: 'danger', armed: armed('dismissAll'), key: 'dismissAll', busy: S.busy === 'squadDismissAll',
        onclick: () => { if (arm('dismissAll')) act('squadDismissAll', null, 'Dismissing every squad…'); },
      }) : null));
    if (holding) {
      sec.appendChild(h('div', { class: 'rpx-hold', role: 'status' },
        h('div', { class: 'rpx-hold-head' },
          h('span', { class: 'rpx-kicker' }, 'On guard'),
          h('p', { class: 'rpx-hold-t' }, 'Your squads hold the post where they stood.')),
        h('p', { class: 'rpx-hold-d' }, 'They guard it while you go on, and fight anything that comes. Fall in brings them back to you.')));
    }
    if (!squads.length) {
      sec.appendChild(empty('No squads out', presets.length ? 'Summon one from your presets below.' : 'Make a preset below, then summon it.'));
    } else if (!live.length) {
      sec.appendChild(empty('No squad matches “' + S.q.squads + '”', 'Search by group number or name.'));
    } else {
      const list = h('div', { class: 'rpx-rows' });
      live.forEach((s, i) => {
        const c = squadCounts(s);
        const fighting = c.by.fighting || 0, released = c.by.released || 0, forming = c.by['forming-up'] || 0;
        const status = fighting ? fighting + ' fighting' : released ? released + ' on orders' : forming ? forming + ' forming up'
          : holding ? 'Holding the post' : (s.marching ? 'Marching in formation' : 'Standing in formation');
        list.appendChild(h('div', { class: 'rpx-row' + (i === 0 && S.q.squads ? ' rpx-top' : '') },
          h('span', { class: 'rpx-group' }, 'Group ' + s.group),
          h('div', { class: 'rpx-row-main' },
            h('div', { class: 'rpx-row-t', title: s.name }, s.name || s.preset || 'Squad'),
            /* each phrase is one unit: a narrow row breaks at the dot, never inside "Holding the post" */
            h('div', { class: 'rpx-row-d' }, h('span', { class: 'rpx-nb' }, c.alive + ' of ' + c.total + ' standing'), ' · ',
              h('span', { class: 'rpx-nb' }, status))),
          h('div', { class: 'rpx-row-acts' },
            btn('Attack!', { kind: 'primary', key: 'attack-' + s.id, busy: S.busy === 'attack:' + s.id,
              title: 'Sic \'em: they charge whatever you are aiming at', onclick: () => attack(s) }),
            btn('Stand down', { key: 'stand-' + s.id, busy: S.busy === 'standDown:' + s.id,
              title: 'Cancel their orders; they walk back into formation',
              onclick: () => act('standDown', { squad: s.id }, 'Group ' + s.group + ': back in line…') }),
            btn(armed('sd-' + s.id) ? 'Confirm' : 'Dismiss', { kind: 'danger', armed: armed('sd-' + s.id), key: 'sdis-' + s.id,
              busy: S.busy === 'squadDismiss:' + s.id,
              onclick: () => { if (arm('sd-' + s.id)) act('squadDismiss', { squad: s.id }, 'Dismissing Group ' + s.group + '…'); } }))));
      });
      sec.appendChild(list);
    }
    body.appendChild(sec);

    /* -- presets -- */
    const shown = presets.filter((p) => matches(S.q.presets, p.name, p.id));
    const ps = h('section', { class: 'rpx-sec' });
    ps.appendChild(h('div', { class: 'rpx-sec-head' },
      h('h3', { class: 'rpx-sec-t' }, 'Presets', h('span', { class: 'rpx-count' }, String(presets.length))),
      presets.length ? search('presets', 'Search presets… (Enter: summon)', () => { if (shown[0]) summonSquad(shown[0]); }) : null,
      btn('New preset', { kind: 'primary', key: 'newPreset', onclick: () => startEdit(null) })));
    if (!presets.length) {
      const e = empty('No presets yet', 'A preset is a squad\'s gear and where its soldiers march around you. Make one, then summon it.',
        btn('Make your first preset', { kind: 'primary', key: 'firstPreset', onclick: () => startEdit(null) }));
      e.classList.add('rpx-empty-art');
      e.insertBefore(h('div', { class: 'rpx-missing-map', 'aria-hidden': 'true' }, miniMap([
        { slot: 'front', rows: 1, cols: 2 }, { slot: 'left', rows: 2, cols: 1 }, { slot: 'right', rows: 2, cols: 1 }, { slot: 'rear', rows: 1, cols: 2 }])), e.firstChild);
      ps.classList.add('rpx-sec-fill');
      ps.appendChild(e);
    } else if (!shown.length) {
      ps.appendChild(empty('No preset matches “' + S.q.presets + '”', 'Clear the search to see all ' + presets.length + '.'));
    } else {
      const grid = h('div', { class: 'rpx-cards rpx-cards-3' });
      shown.forEach((p, i) => {
        const n = presetSoldiers(p);
        grid.appendChild(h('div', { class: 'rpx-card' + (i === 0 && S.q.presets ? ' rpx-top' : '') },
          h('div', { class: 'rpx-card-top' },
            h('div', { class: 'rpx-card-main' },
              h('div', { class: 'rpx-card-t', title: p.name }, p.name || p.id),
              h('p', { class: 'rpx-card-d' }, n + (n === 1 ? ' soldier' : ' soldiers') + ' · ' + (p.gear || 0) + ' gear pieces')),
            miniMap(p.blocks)),
          h('div', { class: 'rpx-card-acts' },
            btn('Summon', { kind: 'primary', key: 'ps-' + p.id, busy: S.busy === 'squadSummon:' + p.id, disabled: !n || null,
              title: n ? null : 'This preset has no soldiers', onclick: () => summonSquad(p) }),
            btn('Edit', { key: 'pe-' + p.id, onclick: () => startEdit(p) }),
            btn(armed('pd-' + p.id) ? 'Confirm' : 'Delete', { kind: 'danger', armed: armed('pd-' + p.id), key: 'pdel-' + p.id,
              busy: S.busy === 'presetDelete:' + p.id,
              onclick: () => { if (arm('pd-' + p.id)) act('presetDelete', { id: p.id }, 'Deleting ' + (p.name || p.id) + '…'); } }))));
      });
      ps.appendChild(grid);
    }
    body.appendChild(ps);
  }

  function attack(s) { act('attack', { squad: s.id }, 'Group ' + s.group + ' - attack!'); }
  function summonSquad(p) { if (presetSoldiers(p)) act('squadSummon', { preset: p.id }, 'Summoning ' + (p.name || p.id) + '…'); }

  /* A preset's blocks as a tiny 3x3 map — at a glance, where its people walk. */
  function miniMap(blocks) {
    const by = {};
    (Array.isArray(blocks) ? blocks : []).forEach((b) => { if (b && b.slot) by[b.slot] = (by[b.slot] || 0) + (b.rows || 0) * (b.cols || 0); });
    const m = h('div', { class: 'rpx-mini', 'aria-hidden': 'true' });
    GRID.forEach((row) => row.forEach((slot) => {
      m.appendChild(slot ? h('span', { class: 'rpx-mini-c' + (by[slot] ? ' on' : '') }, by[slot] ? String(by[slot]) : '')
        : h('span', { class: 'rpx-mini-c rpx-mini-mid' }));
    }));
    return m;
  }

  /* ---------------------------------------------------------- editor -- */

  function startEdit(p) {
    const blocks = {};
    SLOTS.forEach((s) => { blocks[s] = { rows: 0, cols: 0, spacing: 80 }; });
    let isNew = !p;
    if (p && Array.isArray(p.blocks)) p.blocks.forEach((b) => { if (blocks[b.slot]) blocks[b.slot] = { rows: b.rows || 0, cols: b.cols || 0, spacing: b.spacing || 80 }; });
    if (!p) { blocks.front = { rows: 1, cols: 2, spacing: 75 }; blocks.rear = { rows: 1, cols: 2, spacing: 75 }; }
    S.edit = { id: p ? p.id : '', name: p ? (p.name || '') : '', blocks: blocks, isNew: isNew, gear: p ? (p.gear || 0) : 0 };
    S.editSlot = 'front';
    render();
    const n = el && el.querySelector('[data-key="ed-name"]');
    if (n) n.focus();
  }

  function editTotal() {
    return SLOTS.reduce((n, s) => n + S.edit.blocks[s].rows * S.edit.blocks[s].cols, 0);
  }

  function draftPreset() {
    const e = S.edit;
    const id = e.isNew ? uniqueId(slug(e.name)) : e.id;
    return {
      id: id, name: e.name.trim(),
      blocks: SLOTS.filter((s) => e.blocks[s].rows > 0 && e.blocks[s].cols > 0)
        .map((s) => ({ slot: s, rows: e.blocks[s].rows, cols: e.blocks[s].cols, spacing: e.blocks[s].spacing })),
    };
  }

  function uniqueId(base) {
    const taken = new Set((rr().presets || []).map((p) => p.id));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 999; i++) if (!taken.has(base + '-' + i)) return base + '-' + i;
    return base + '-' + Math.random().toString(36).slice(2, 6);
  }

  function stepper(label, value, min, max, step, fmt, onChange, key) {
    const set = (v) => { onChange(Math.max(min, Math.min(max, v))); render(); };
    return h('div', { class: 'rpx-step' },
      h('span', { class: 'rpx-step-l' }, label),
      h('div', { class: 'rpx-step-c' },
        h('button', { type: 'button', class: 'rpx-step-b', 'aria-label': 'Less ' + label, 'data-key': key + '-less',
          disabled: value <= min || null, onclick: () => set(value - step) }, '−'),
        h('span', { class: 'rpx-step-v' }, fmt(value)),
        h('button', { type: 'button', class: 'rpx-step-b', 'aria-label': 'More ' + label, 'data-key': key + '-more',
          disabled: value >= max || null, onclick: () => set(value + step) }, '+')));
  }

  function renderEditor(body) {
    const e = S.edit;
    const total = editTotal();
    const head = h('div', { class: 'rpx-ed-head' },
      btn('‹ Back to squads', { key: 'ed-back', onclick: () => { S.edit = null; render(); } }),
      h('h3', { class: 'rpx-sec-t' }, e.isNew ? 'New preset' : 'Edit preset'));
    body.appendChild(head);

    const nameRow = h('label', { class: 'rpx-field' },
      h('span', { class: 'rpx-field-l' }, 'Name'),
      (() => {
        const i = h('input', { type: 'text', class: 'rpx-input', name: 'rpx-preset-name', value: e.name, maxlength: '64', 'data-key': 'ed-name',
          placeholder: 'e.g. Royal Guard…', autocomplete: 'off', spellcheck: 'false' });
        i.addEventListener('input', () => { e.name = i.value; renderFoot(); });
        i.addEventListener('keydown', (ev) => { if (keyOf(ev) === 'Enter') { ev.preventDefault(); save(); } });
        return i;
      })());
    body.appendChild(nameRow);

    const layout = h('div', { class: 'rpx-ed' });
    /* -- the map -- */
    const map = h('div', { class: 'rpx-map', role: 'group', 'aria-label': 'Where the soldiers march' });
    GRID.forEach((row) => row.forEach((slot) => {
      if (!slot) {
        map.appendChild(h('div', { class: 'rpx-map-mid' }, h('span', null, rp().installed && rpState() && rpState().mount ? 'Palanquin' : 'You'),
          h('small', null, 'Facing front')));
        return;
      }
      const b = e.blocks[slot];
      const n = b.rows * b.cols;
      map.appendChild(h('button', {
        type: 'button', class: 'rpx-map-c' + (n ? ' on' : '') + (S.editSlot === slot ? ' sel' : ''),
        'data-key': 'slot-' + slot, 'aria-pressed': S.editSlot === slot ? 'true' : 'false',
        onclick: () => { S.editSlot = slot; render(); },
      }, h('span', { class: 'rpx-map-l' }, SLOT_LABEL[slot]), h('span', { class: 'rpx-map-n' }, n ? (b.rows + ' × ' + b.cols) : 'empty')));
    }));
    layout.appendChild(map);

    /* -- the selected block -- */
    const b = e.blocks[S.editSlot];
    const panel = h('div', { class: 'rpx-slot' },
      h('div', { class: 'rpx-kicker' }, 'Selected block'),
      h('h4', { class: 'rpx-slot-t' }, SLOT_LABEL[S.editSlot]),
      stepper('Rows', b.rows, 0, 10, 1, String, (v) => { b.rows = v; if (v && !b.cols) b.cols = 1; }, 'rows'),
      stepper('Columns', b.cols, 0, 10, 1, String, (v) => { b.cols = v; if (v && !b.rows) b.rows = 1; }, 'cols'),
      stepper('Spacing', b.spacing, 40, 400, 10, (v) => (v / UNITS_PER_M).toFixed(1) + ' m', (v) => { b.spacing = v; }, 'spacing'),
      h('p', { class: 'rpx-help' }, (b.rows * b.cols) + ' here · ' + total + ' in the whole squad'),
      btn('Clear this block', { key: 'clear-slot', disabled: !(b.rows * b.cols) || null, onclick: () => { b.rows = 0; b.cols = 0; render(); } }));
    layout.appendChild(panel);
    body.appendChild(layout);

    /* -- gear -- */
    const crossName = S.data && S.data.crosshair && typeof S.data.crosshair === 'object' ? S.data.crosshair.name : '';
    body.appendChild(h('section', { class: 'rpx-sec rpx-gear' },
      h('div', { class: 'rpx-gear-main' },
        h('div', { class: 'rpx-kicker' }, 'Gear'),
        h('p', { class: 'rpx-help' }, e.gear ? 'Every soldier wears the ' + e.gear + ' pieces this preset holds.' :
          (e.isNew ? 'New presets start with steel armour. Copy what someone is wearing to change it.' : 'This preset holds no gear yet.'))),
      btn(crossName ? 'Copy what ' + crossName + ' wears' : 'Look at someone to copy their gear', {
        key: 'copy-gear', disabled: !crossName || !e.name.trim() || null,
        title: !e.name.trim() ? 'Name the preset first' : (crossName ? 'Copy what ' + crossName + ' wears' : null),
        busy: S.busy.indexOf('presetFromActor') === 0,
        onclick: () => {
          const p = draftPreset();
          S.edit.id = p.id; S.edit.isNew = false;
          act('presetFromActor', { id: p.id, name: p.name }, 'Copying ' + crossName + '\'s gear…');
        },
      })));

    const foot = h('div', { class: 'rpx-ed-foot', 'data-role': 'foot' });
    body.appendChild(foot);
    renderFoot(foot);
  }

  function renderFoot(target) {
    const foot = target || (el && el.querySelector('[data-role="foot"]'));
    if (!foot || !S.edit) return;
    foot.textContent = '';
    const total = editTotal();
    const reason = !S.edit.name.trim() ? 'Name the preset' : !total ? 'Put at least one soldier on the map' : '';
    foot.appendChild(h('span', { class: 'rpx-ed-sum' }, reason || (total + (total === 1 ? ' soldier' : ' soldiers') + ' in ' +
      SLOTS.filter((s) => S.edit.blocks[s].rows * S.edit.blocks[s].cols).length + ' blocks')));
    foot.appendChild(btn('Cancel', { key: 'ed-cancel', onclick: () => { S.edit = null; render(); } }));
    foot.appendChild(btn('Save preset', { kind: 'primary', key: 'ed-save', disabled: !!reason || null, busy: S.busy.indexOf('presetSave') === 0, onclick: save }));
  }

  function save() {
    if (!S.edit || !S.edit.name.trim() || !editTotal()) return;
    const p = draftPreset();
    S.edit.id = p.id;
    S.edit.saving = true;
    act('presetSave', { preset: p }, 'Saving ' + p.name + '…');
  }

  /* ---------------------------------------------------------- render -- */

  const TABS = [['palanquin', 'Palanquin', 'Palanquin'], ['bearers', 'Bearers', 'Bearers'], ['wagons', 'Wagons', 'Wagons'], ['squads', 'Escort squads', 'Squads']];

  function setTab(id) {
    S.tab = id;
    if (id !== 'squads') S.edit = null;
    if (id !== 'wagons') S.seatPick = null;
    if (typeof window.RPX_ON_TAB === 'function') window.RPX_ON_TAB(id);   // the Portal keeps it in the URL
    render();
  }

  /* Which page the body shows; its scroll survives a re-render (the
     700 ms / 2.6 s re-pushes after every verb) but not a change of page. */
  function pageKey() { return S.tab + (S.edit ? ':edit' : '') + (S.seatPick ? ':pick' : '') + (S.data ? '' : ':wait'); }

  function render() {
    if (!el || !S.open) return;
    const f = captureFocus();
    const oldBody = el.querySelector('.rpx-body');
    const keep = oldBody && oldBody.getAttribute('data-page') === pageKey() ? oldBody.scrollTop : 0;
    el.textContent = '';
    const box = h('div', { class: 'rpx-box' });
    box.appendChild(h('div', { class: 'rpx-head' },
      h('div', { class: 'rpx-title' }, 'Procession'),
      h('div', { class: 'rpx-sub' }, 'Palanquin, bearers, wagons and escort squads'),
      h('button', { type: 'button', class: 'rpx-close', 'aria-label': 'Close', title: 'Close (Esc)', 'data-key': 'close', onclick: close }, '✕')));
    const nav = h('div', { class: 'rpx-tabs', role: 'tablist' });
    TABS.forEach(([id, label, short]) => {
      let badge = null;
      if (id === 'squads' && rr().installed && (rr().squads || []).length) badge = h('span', { class: 'rpx-count' }, String(rr().squads.length));
      if (id === 'bearers' && rpState() && rpState().mount) badge = h('span', { class: 'rpx-count' }, bearerCount(rpState()).present + '/4');
      if (id === 'wagons' && rp().installed && wagons().length) badge = h('span', { class: 'rpx-count' }, String(wagons().length));
      nav.appendChild(h('button', {
        type: 'button', role: 'tab', class: 'rpx-tab' + (S.tab === id ? ' on' : ''), 'aria-selected': S.tab === id ? 'true' : 'false',
        'data-key': 'tab-' + id, tabindex: S.tab === id ? '0' : '-1', onclick: () => setTab(id),
      }, h('span', { class: 'rpx-tab-long' }, label), h('span', { class: 'rpx-tab-short' }, short), badge));
    });
    box.appendChild(nav);

    const body = h('div', { class: 'rpx-body', 'data-page': pageKey() });
    if (!S.data && S.offline) {
      body.appendChild(h('div', { class: 'rpx-missing' },
        h('div', { class: 'rpx-empty-t' }, 'Skyrim is not connected'),
        h('p', null, S.offline),
        btn('Try again', { kind: 'primary', key: 'retry', onclick: () => { S.offline = ''; S.loading = true; render(); request(); } })));
    } else if (S.loading && !S.data) {
      body.appendChild(h('div', { class: 'rpx-loading' }, h('span', { class: 'rpx-spin', 'aria-hidden': 'true' }), 'Asking the game…'));
    } else if (S.tab === 'palanquin') renderPalanquin(body);
    else if (S.tab === 'bearers') renderBearers(body);
    else if (S.tab === 'wagons') renderWagons(body);
    else renderSquads(body);
    box.appendChild(body);

    box.appendChild(h('div', { class: 'rpx-status-bar' + (S.msg ? (S.msg.ok ? '' : ' rpx-bad') : ''), role: 'status', 'aria-live': 'polite' },
      S.msg ? S.msg.text : (!S.data ? (S.offline ? 'Waiting for the game.' : '')
        : rp().installed || rr().installed ? 'Changes reach the game straight away.'
        : 'Nothing to change here until the mods are installed.')));
    el.appendChild(box);
    if (keep) body.scrollTop = keep;
    fitFaces(body);
    restoreFocus(f);
  }

  /* ---------------------------------------------------------- public -- */

  function poll() {
    clearTimeout(S.pollTimer);
    if (!S.open || !window.RPX_LIVE_POLL) return;
    S.pollTimer = setTimeout(() => { if (S.open) { toGameSafe('rpxGet', '{}'); poll(); } }, 3000);
  }

  function open(tab) {
    opener = document.activeElement;
    if (tab && TABS.some((t) => t[0] === tab)) S.tab = tab;
    S.open = true;
    S.msg = null;
    S.busy = '';
    S.armed = {};
    ensureDom().classList.remove('hidden');
    toGameSafe('hdCapture', '1');
    request();
    render();
    const first = el.querySelector('.rpx-tab.on') || el.querySelector('.rpx-close');
    if (first) first.focus();
    poll();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.edit = null;
    S.seatPick = null;
    faceAsked = '';
    clearTimeout(S.pollTimer);
    if (el) el.classList.add('hidden');
    toGameSafe('hdCapture', '0');
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (typeof window.RPX_ON_CLOSE === 'function') window.RPX_ON_CLOSE();   // the Portal goes home
  }

  function onKey(e) {
    if (!S.open) return false;
    const k = keyOf(e);
    if (k === 'Escape' || e.code === 'Escape') {
      /* The deck and the Portal route keys here in the CAPTURE phase, before
         the search box hears them: Escape in a search with text clears it. */
      const f = document.activeElement;
      if (f && f.classList && f.classList.contains('rpx-search') && f.value) {
        S.q[f.name.replace(/^rpx-/, '')] = ''; render(); return true;
      }
      if (S.edit) { S.edit = null; render(); return true; }
      if (S.seatPick) { S.seatPick = null; render(); return true; }
      close(); return true;
    }
    /* Arrow keys move between the tabs (the tablist pattern). */
    const a = document.activeElement;
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && a && a.getAttribute && a.getAttribute('role') === 'tab') {
      const i = TABS.findIndex((t) => t[0] === S.tab);
      const next = TABS[(i + (k === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
      setTab(next);
      const n = el.querySelector('[data-key="tab-' + next + '"]');
      if (n) n.focus();
      return true;
    }
    if (k === 'Tab' && el) {
      const nodes = Array.from(el.querySelectorAll('button:not([disabled]), input:not([disabled])'));
      const index = nodes.indexOf(document.activeElement);
      if (nodes.length && (index < 0 || (!e.shiftKey && index === nodes.length - 1) || (e.shiftKey && index === 0))) {
        nodes[e.shiftKey ? nodes.length - 1 : 0].focus(); return true;
      }
    }
    return false;
  }

  window.HDProcession = {
    open: open,
    close: close,
    isOpen: () => S.open,
    onKey: onKey,
    portraitIds: portraitIds,   // followers-pane.js face poll (the faceConsumerActive law)
    _state: S,       // harness introspection only
    _render: render, // harness
  };

  /* Faces that land while the wagon tab is up replace the initials. */
  window.addEventListener('hd-portraits-changed', () => { if (S.open && S.tab === 'wagons') render(); });

  /* ------------------------------------------------------------- omni --- *
   * The modal is the destination; rows land on the right tab. */
  if (window.HDOmni && typeof HDOmni.register === 'function') {
    const openVia = (tab) => function () { const via = (window.HDProcession && window.HDProcession.open) || open; via(tab); };
    HDOmni.register({
      id: 'procession',
      label: 'Procession',
      rank: 48,
      tab: '',
      index: function () {
        return [
          { label: 'Procession — palanquin, bearers, wagons and escort squads', detail: 'Royal Procession + Royal Retinue', kind: 'procession',
            keywords: 'procession palanquin litter throne king royal bearers carry wagon cart carriage convoy escort squad squads retinue guard army troops march',
            run: openVia('palanquin') },
          { label: 'Summon the palanquin', detail: 'Pick a throne design', kind: 'procession',
            keywords: 'summon palanquin litter throne sedan chair carry king ride', run: openVia('palanquin') },
          { label: 'Palanquin bearers — dress them', detail: 'Open a bearer\'s gear, dress all four alike', kind: 'procession',
            keywords: 'bearers porters carriers gear outfit dress equip uniform', run: openVia('bearers') },
          { label: 'Wagon — summon, hitch, convoy', detail: 'Bring the wagon, hitch it to a horse, add wagons to the convoy', kind: 'procession',
            keywords: 'wagon cart carriage coach convoy caravan hitch horse draught summon dismiss travel ride', run: openVia('wagons') },
          { label: 'Wagon seats — who rides where', detail: 'Driver’s bench and four passenger seats', kind: 'procession',
            keywords: 'wagon cart seat seats sit ride passenger passengers driver coachman unseat followers', run: openVia('wagons') },
          { label: 'Escort squads — summon, attack, presets', detail: 'Group N attack! · formation blocks around the palanquin', kind: 'procession',
            keywords: 'escort squad squads retinue guard guards army troops soldiers group attack sic em formation preset march',
            run: openVia('squads') },
        ];
      },
    });
  }
})();
