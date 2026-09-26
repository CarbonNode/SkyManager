'use strict';

/* ====================================================================== *
 *  Residents — My Home is Your Home NG's MASTER LIST, the third mode of the
 *  Domains tab (🗺 Places ‖ 🏰 Bases ‖ ⌂ Residents).
 *
 *  Rober's ask (2026-09-17): "what if i want to set like where there bedroom
 *  is, work area is, do i need to go talk or hit f7 on them again or can i do
 *  it manually or remotely? can i manage MHIYH locations and edit them? in a
 *  master list somewhere like domains, tab - bases, a new tab for MHYHM".
 *
 *  What was true before: the Followers tab's "Her Day" and the F7 card could
 *  set every stop — but only for people Follower Organizer knows, and only at
 *  the PLAYER'S FEET, because that is the one place MHiYH's own dialogue can
 *  mean. This mode reads MHiYH's OWN registry (everyone it holds, FO or not)
 *  and can put any stop of anyone's day on a Domains mark, from anywhere.
 *
 *  A MODE, not a tab — the same call bases-pane.js made: it answers "where in
 *  Skyrim", and F15 already lands here. bases-pane.js owns the segmented
 *  switch and tells us when we are the showing mode (setActive); we own the
 *  body below it. SELF-MOUNTING like Bases (index.html gains a <link> only),
 *  own stylesheet (residents-pane.css), rs-* classes only.
 *
 *  Bridge, one name per direction (the deck law):
 *      JS -> C++   rsState() · rsDay({formId}) · rsAct({op,…})
 *      C++ -> JS   rsStateResult(state) · rsDayResult({ok,formId,day}) ·
 *                  rsActResult({ok,phase,op,formId,kind,msg})
 *  Every verb is answered by rsActResult twice (sent, then done) and then by
 *  a fresh rsStateResult, so a control that failed springs back to the mod's
 *  truth instead of lying. Nothing here re-implements MHiYH: every write is
 *  one of its own transactions (HD_MhiyhRemote.psc), and the reads are its
 *  linked refs and alias instances (src/nff_bridge.cpp).
 *
 *  Domains marks are BORROWED read-only (DomainsPane.listMarks) — for the
 *  picker, and to name where a stop IS by position: a stop in the same
 *  interior cell as a mark, or within RS_NEAR units of one outdoors, wears
 *  that mark's name (sub-areas win over their parent when close enough).
 *  Faces come from the Followers pane's own store (portraitInfoFor), with a
 *  facegen ask (fdFaceIcons) for anyone it has never drawn.
 *
 *  Ultralight rules honoured: no prompt/confirm (armed two-click), no native
 *  tooltips (title= is drawn by app.js's #hd-tip), no <select> (steppers), no
 *  colour emoji in our own glyphs (the segment labels are Bases' precedent).
 * ====================================================================== */

window.ResidentsPane = (function () {

  /* Kind numbers are MMTYHNative's own — the wire key. Do not renumber.
     Glyphs are the Followers tab's proven-in-game set (its ACTS spec). */
  const KINDS = [
    { k: 0, key: 'home',      glyph: '⌂', label: 'Home',      verb: 'At home',
      hint: 'Where she lives. Every other stop hangs off it, and it is where she goes when nothing else is scheduled.' },
    { k: 1, key: 'sleep',     glyph: '☾', label: 'Sleeps',    verb: 'Sleeping',
      hint: 'Where she goes to bed.' },
    { k: 2, key: 'work',      glyph: '⚒', label: 'Works',     verb: 'Working',
      hint: 'Where she spends her working hours.' },
    { k: 3, key: 'guard',     glyph: '⚔', label: 'Guards',    verb: 'On guard',
      hint: 'Her post. Watch (passive) and Guard (active) share it — the mode is set below.' },
    { k: 4, key: 'breakfast', glyph: '☀', label: 'Breakfast', verb: 'At breakfast',
      hint: 'Where she eats in the morning.' },
    { k: 5, key: 'lunch',     glyph: '◑', label: 'Lunch',     verb: 'At lunch',
      hint: 'Where she eats at midday.' },
    { k: 6, key: 'dinner',    glyph: '✦', label: 'Dinner',    verb: 'At dinner',
      hint: 'Where she eats in the evening.' },
  ];
  const KIND_BY_K = {};
  KINDS.forEach((s) => { KIND_BY_K[s.k] = s; });
  const K_HOME = 0, K_GUARD = 3, K_WATCH = 7;
  const RS_NEAR = 2400;        // exterior: a stop this close to a mark wears its name (~34 m)
  const RS_CHILD_NEAR = 900;   // …but a SUB-AREA only claims it when it is really at it
  const ARM_MS = 2600;
  const HOURS_DEBOUNCE = 550;
  const FACE_ASK_MS = 5000;
  const FACE_POLLS = 12;
  const RADIUS_STEP = 64;
  const RADIUS_MIN = 64, RADIUS_MAX = 4096;

  function kindSpec(k) {
    return KIND_BY_K[k] || (k === K_WATCH
      ? { k: 7, key: 'watch', glyph: '⚐', label: 'Watch', verb: 'Keeping watch', hint: '' }
      : { k: k, key: 'k' + k, glyph: '•', label: 'Activity ' + k, verb: 'Busy', hint: '' });
  }

  const S = {
    mounted: false,
    active: false,          // we are the showing mode of the Domains tab
    loaded: false,
    present: null,          // null = not answered; false = MHiYH absent
    script: true,           // false = HD_MhiyhRemote.pex not installed
    msg: '',
    list: [],               // residents, as C++ sent them (normalised)
    sel: '',                // selected resident formId (lowercase)
    q: '',                  // rail filter
    view: 'people',         // people | places
    place: '',              // selected place key in places view
    day: {},                // formId -> [{k,start,end,enabled,radius}]
    dayEdits: {},           // formId -> { kind -> pending row } (debounced)
    dayPending: '',         // formId whose day is being fetched
    pending: '',            // the sentence for an op in flight
    armed: { key: '', at: 0 },
    picker: null,           // { formId, kind, q } while the domain picker is open
  };

  let body = null, rail = null, railList = null, railFoot = null, main = null, search = null;
  let toastTimer = 0;
  const hoursTimers = {};
  let faceTimer = 0, facePolls = 0, faceLastAsk = 0;

  /* ============================================================ helpers == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }

  function say(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
    else console.log('[toast]', msg);
  }

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, String(attrs[k]));
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function fid(v) { return String(v || '').toLowerCase(); }

  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }

  /* An earthen wheel, the Bases precedent — a full-spectrum hue fights the
     gold chrome. Stable per name. */
  const HUES = [38, 22, 96, 212, 292, 12, 176, 46];
  function hueOf(name) {
    let x = 0;
    for (const c of String(name || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    return HUES[x % HUES.length];
  }

  function hourLabel(v) {
    const n = ((Number(v) || 0) % 24 + 24) % 24;
    if (n === 0) return '12 am';
    if (n === 12) return '12 pm';
    return (n > 12 ? n - 12 : n) + (n > 12 ? ' pm' : ' am');
  }
  function endLabel(v) { return Number(v) === 24 ? '12 am' : hourLabel(v); }

  function matches(hay, q) {
    if (!q) return true;
    const s = String(hay || '').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => s.indexOf(t) !== -1);
  }

  function isArmed(key) { return S.armed.key === key && (Date.now() - S.armed.at) < ARM_MS; }
  function arm(key) {
    S.armed = { key: key, at: Date.now() };
    renderMain();
    setTimeout(() => { if (S.armed.key === key && !isArmed(key)) { S.armed = { key: '', at: 0 }; renderMain(); } }, ARM_MS + 60);
  }
  function disarm() { S.armed = { key: '', at: 0 }; }

  function toast(msg, ok) {
    const t = document.getElementById('rs-toast');
    if (!t) { say(msg); return; }
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('rs-toast-ok', !!ok);
    t.classList.toggle('rs-toast-bad', !ok);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
  }

  /* ----------------------------------------------------------- marks --- */

  /* Domains marks, borrowed read-only. Empty when the pane is absent. */
  function marks() {
    const dp = window.DomainsPane;
    if (!dp || typeof dp.listMarks !== 'function') return [];
    try { const r = dp.listMarks(); return Array.isArray(r) ? r : []; } catch (_) { return []; }
  }
  function markById(all, id) { return all.find((m) => m.id === id) || null; }
  function markLabel(all, m) {
    if (!m) return '';
    const p = m.parentId ? markById(all, m.parentId) : null;
    return p ? (p.name + ' › ' + m.name) : m.name;
  }

  /* Which mark a stop IS AT, by position. Same interior cell = a match;
     outdoors, the nearest mark within RS_NEAR in the same worldspace. A
     sub-area (parentId set) wins over its parent only within RS_CHILD_NEAR,
     so "Breezehome › upstairs" is claimed by the bed and not by the door. */
  function matchMark(geo, all) {
    if (!geo || !geo.cellId && !geo.worldspaceId) return null;
    let best = null, bestScore = Infinity;
    all.forEach((m) => {
      let d;
      if (geo.interior) {
        if ((m.cellId >>> 0) !== (geo.cellId >>> 0)) return;
        d = Math.hypot((m.x || 0) - geo.x, (m.y || 0) - geo.y, (m.z || 0) - geo.z);
      } else {
        if (m.interior) return;
        if ((m.worldspaceId >>> 0) !== (geo.worldspaceId >>> 0)) return;
        d = Math.hypot((m.x || 0) - geo.x, (m.y || 0) - geo.y);
        if (d > RS_NEAR) return;
      }
      /* a child that is not really at the stop must not beat its parent */
      if (m.parentId && d > RS_CHILD_NEAR) return;
      const score = m.parentId ? d * 0.5 : d;   // prefer the finer mark on a tie
      if (score < bestScore) { bestScore = score; best = m; }
    });
    return best ? { mark: best, dist: bestScore } : null;
  }

  /* The place a stop reads as: the matched mark's label, else MHiYH's own
     place name (the cell), else "Somewhere". */
  function placeOf(geo, all) {
    if (!geo) return { text: '', mark: null };
    const hit = matchMark(geo, all);
    if (hit) return { text: markLabel(all, hit.mark), mark: hit.mark };
    return { text: geo.place || geo.name || 'Somewhere', mark: null };
  }

  /* ----------------------------------------------------------- faces --- */

  function faceUrl(r) {
    const fp = window.FolPane || window.FollowersPane;
    if (!fp || typeof fp.portraitInfoFor !== 'function') return '';
    let p = null;
    try { p = fp.portraitInfoFor({ formId: r.formId, name: r.name }); } catch (_) { p = null; }
    if (!p || !p.file) return '';
    if (p.url) return p.url;
    if (p.abs) return p.file;
    return 'portraits/' + p.file + '?v=' + (p.mtime || 0);
  }

  function faceEl(r, cls) {
    const wrap = h('span', { class: 'rs-face' + (cls ? ' ' + cls : '') },
      h('span', { class: 'rs-face-ini' }, initialsOf(r.name)));
    wrap.style.setProperty('--rs-hue', String(hueOf(r.name)));
    const url = faceUrl(r);
    if (!url) return wrap;
    const plain = url.split('?')[0];
    const img = h('img', { class: 'rs-face-img', alt: '', draggable: 'false', src: url });
    if (window.HDFaceFit) { try { HDFaceFit.paintPortrait(img, plain); } catch (_) {} }
    let retried = false;
    img.addEventListener('error', function () {
      if (!retried && url !== plain) { retried = true; img.src = plain; return; }
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    wrap.appendChild(img);
    return wrap;
  }

  /* Ask C++ for facegen heads of everyone without a face. The reply lands in
     the Followers pane's store (fdFaceIconsData, chained below) and repaints
     us; queued renders are re-asked every FACE_ASK_MS while we are showing
     (the faceConsumerActive law: whoever paints icons/npcs must collect). */
  function askFaces(reset) {
    if (!S.active) return;
    if (reset) facePolls = 0;
    const now = Date.now();
    if (reset && now - faceLastAsk < 3000) return;
    const ids = S.list.filter((r) => r.formId && !faceUrl(r)).map((r) => fid(r.formId));
    if (!ids.length) return;
    faceLastAsk = now;
    toGame('fdFaceIcons', JSON.stringify({ ids: ids }));
  }
  function chainFaces() {
    if (window.__rsFacesChained) return;
    const orig = window.fdFaceIconsData;
    window.fdFaceIconsData = function (env) {
      const r = typeof orig === 'function' ? orig.apply(this, arguments) : undefined;
      let v = env;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (S.active) {
        render();
        const queued = v && Number(v.queued) || 0;
        clearTimeout(faceTimer);
        if (queued > 0 && facePolls < FACE_POLLS) {
          facePolls++;
          faceTimer = setTimeout(() => askFaces(false), FACE_ASK_MS);
        }
      }
      return r;
    };
    window.__rsFacesChained = true;
  }

  /* ----------------------------------------------------------- data ---- */

  function normResident(r) {
    r = r || {};
    const acts = Array.isArray(r.acts) ? r.acts : [];
    const byK = {};
    acts.forEach((a) => { if (a && typeof a.k === 'number') byK[a.k] = a; });
    return {
      formId: String(r.formId || ''),
      slot: Number(r.slot) || 0,
      name: String(r.name || 'Someone'),
      following: !!r.following, dead: !!r.dead, inWorld: !!r.inWorld,
      waiting: !!r.waiting, where: String(r.where || ''), whereId: (r.whereId >>> 0) || 0,
      flagged: !!r.flagged,
      home: (r.home && typeof r.home === 'object') ? r.home : null,
      acts: acts, actByK: byK,
      now: Array.isArray(r.now) ? r.now : [],
    };
  }

  function selected() { return S.list.find((r) => fid(r.formId) === S.sel) || null; }

  function nowVerb(r) {
    const ks = (r.now || []).filter((k) => k !== K_HOME);
    const k = ks.length ? ks[0] : ((r.now || []).length ? K_HOME : -1);
    return k < 0 ? '' : kindSpec(k).verb;
  }

  /* Everything searchable about one resident, in one string. */
  function haystack(r, all) {
    const parts = [r.name, r.where, r.home ? r.home.name : ''];
    r.acts.forEach((a) => { parts.push(a.place || ''); const p = placeOf(a, all); parts.push(p.text); });
    if (r.home) parts.push(placeOf(r.home, all).text);
    parts.push(nowVerb(r));
    return parts.filter(Boolean).join(' ');
  }

  /* Places view: residents grouped by the TOP-LEVEL mark any of their stops
     sits at; "Unmatched" gathers stops at no mark. Each entry says which of
     her stops are there. */
  function placeGroups(all) {
    const groups = {}, order = [];
    function add(key, label, r, role, place) {
      if (!groups[key]) { groups[key] = { key: key, label: label, people: {}, n: 0 }; order.push(key); }
      const g = groups[key];
      if (!g.people[fid(r.formId)]) { g.people[fid(r.formId)] = { r: r, roles: [] }; g.n++; }
      g.people[fid(r.formId)].roles.push({ role: role, place: place });
    }
    S.list.forEach((r) => {
      const stops = [];
      if (r.home) stops.push({ k: K_HOME, geo: r.home });
      r.acts.forEach((a) => { if (a.cellId || a.worldspaceId) stops.push({ k: a.k, geo: a }); });
      stops.forEach((st) => {
        const hit = matchMark(st.geo, all);
        if (hit) {
          const top = hit.mark.parentId ? (markById(all, hit.mark.parentId) || hit.mark) : hit.mark;
          add('m:' + top.id, top.name, r, kindSpec(st.k).label, markLabel(all, hit.mark));
        } else {
          add('u', 'Not on any domain', r, kindSpec(st.k).label, st.geo.place || st.geo.name || 'Somewhere');
        }
      });
    });
    const out = order.map((k) => groups[k]);
    out.sort((a, b) => (a.key === 'u') - (b.key === 'u') || a.label.localeCompare(b.label));
    return out;
  }

  /* ----------------------------------------------------------- bridge -- */

  function refresh() {
    S.loaded = S.loaded && S.present !== null;
    toGame('rsState', '{}');
    renderFoot();
  }

  function act(payload, pendingMsg) {
    disarm();
    S.pending = pendingMsg || 'Working…';
    toGame('rsAct', JSON.stringify(payload));
    renderMain();
  }

  function fetchDay(formId) {
    if (!formId) return;
    S.dayPending = fid(formId);
    toGame('rsDay', JSON.stringify({ formId: formId }));
  }

  window.rsStateResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || typeof d !== 'object') return;
    S.loaded = true;
    S.present = d.present !== false;
    S.script = d.script !== false;
    S.msg = String(d.msg || '');
    S.list = (Array.isArray(d.residents) ? d.residents : []).map(normResident);
    S.list.sort((a, b) => a.name.localeCompare(b.name));
    if (S.sel && !selected()) S.sel = '';
    if (!S.sel && S.list.length && S.view === 'people') S.sel = fid(S.list[0].formId);
    S.pending = '';
    if (S.active) { render(); askFaces(true); }
  };

  window.rsDayResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || typeof d !== 'object') return;
    const key = fid(d.formId);
    if (key === S.dayPending) S.dayPending = '';
    if (d.ok && Array.isArray(d.day)) {
      S.day[key] = d.day.map((row) => ({
        k: Number(row.k) || 0, start: Number(row.start) || 0, end: Number(row.end) || 0,
        enabled: !!row.enabled, radius: Number(row.radius) || 0,
      }));
    } else if (d.msg) {
      toast(d.msg, false);
    }
    if (S.active && key === S.sel) renderMain();
  };

  window.rsActResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || typeof d !== 'object') return;
    if (d.phase === 'sent') { S.pending = String(d.msg || 'Working…'); if (S.active) renderMain(); return; }
    S.pending = '';
    if (d.msg) toast(d.msg, !!d.ok);
    /* hours came back — re-read her day so the steppers show the mod's truth */
    if (d.phase === 'done' && (d.op === 'hours' || d.op === 'guard') && d.formId) fetchDay(d.formId);
    if (S.active) renderMain();
  };

  /* ------------------------------------------------------------ mount --- */

  function ensureDom() {
    if (S.mounted && body && body.isConnected) return true;
    const pane = document.getElementById('dm-pane');
    const dmBody = document.getElementById('dm-body');
    if (!pane || !dmBody) return false;

    search = h('input', {
      id: 'rs-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Search residents, homes, places…',
      oninput: (e) => { S.q = e.target.value || ''; renderRail(); },
      onkeydown: onSearchKey,
    });
    rail = h('nav', { id: 'rs-rail', 'aria-label': 'Residents' },
      h('div', { id: 'rs-rail-head' },
        h('div', { class: 'rs-view-wrap', role: 'tablist' },
          h('button', { class: 'rs-view', id: 'rs-view-people', type: 'button',
            title: 'Every resident My Home is Your Home holds, whoever they are',
            onclick: () => setView('people') }, 'People'),
          h('button', { class: 'rs-view', id: 'rs-view-places', type: 'button',
            title: 'The same people, grouped by the domain their stops sit on',
            onclick: () => setView('places') }, 'By place')),
        h('div', { class: 'rs-search-wrap' },
          h('span', { class: 'rs-search-ic', 'aria-hidden': 'true' }, '⌕'),
          search)),
      railList = h('div', { id: 'rs-rail-list', role: 'listbox' }),
      railFoot = h('div', { id: 'rs-rail-foot' }));
    main = h('section', { id: 'rs-main' });
    body = h('section', { id: 'rs-body', class: 'hidden', 'aria-label': 'Residents' },
      rail, main, h('div', { id: 'rs-toast', class: 'hidden' }));

    const nb = document.getElementById('nb-body');
    if (nb && nb.parentNode === pane) pane.insertBefore(body, nb.nextSibling);
    else pane.insertBefore(body, dmBody.nextSibling);
    S.mounted = true;
    chainFaces();
    return true;
  }

  function onSearchKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); if (S.q) { S.q = ''; search.value = ''; renderRail(); } return; }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const first = railList.querySelector('.rs-row');
      if (first) first.click();
    }
  }

  function setView(v) {
    if (S.view === v) return;
    S.view = v;
    disarm(); S.picker = null;
    render();
  }

  function select(formId) {
    S.sel = fid(formId);
    disarm(); S.picker = null;
    if (S.sel && !S.day[S.sel]) fetchDay(formId);
    render();
    const row = railList && railList.querySelector('.rs-row.on');
    if (row && typeof row.scrollIntoView === 'function') { try { row.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
  }

  function selectPlace(key) {
    S.place = key;
    disarm(); S.picker = null;
    render();
  }

  /* ------------------------------------------------------------ render -- */

  window.addEventListener('hd-portraits-changed', function () { if (S.active) render(); });

  function render() {
    if (!ensureDom()) return;
    const p = document.getElementById('rs-view-people'), q = document.getElementById('rs-view-places');
    if (p) p.classList.toggle('on', S.view === 'people');
    if (q) q.classList.toggle('on', S.view === 'places');
    renderRail();
    renderMain();
    renderFoot();
  }

  function renderRail() {
    if (!railList) return;
    railList.textContent = '';
    const all = marks();
    if (S.view === 'places') {
      const groups = placeGroups(all).filter((g) => matches(g.label + ' ' + Object.keys(g.people).map((k) => g.people[k].r.name).join(' '), S.q));
      if (!S.place && groups.length) S.place = groups[0].key;
      groups.forEach((g) => {
        railList.appendChild(h('button', {
          class: 'rs-row rs-row-place' + (g.key === S.place ? ' on' : '') + (g.key === 'u' ? ' dim' : ''),
          type: 'button', role: 'option', title: g.n + ' resident' + (g.n === 1 ? '' : 's') + ' at ' + g.label,
          onclick: () => selectPlace(g.key),
        },
          domainArt(g.key.indexOf('m:')===0?markById(all,g.key.slice(2)):null,true,g.key==='u'),
          h('span', { class: 'rs-row-text' },
            h('span', { class: 'rs-row-name' }, g.label),
            h('span', { class: 'rs-row-sub' }, g.n + ' resident' + (g.n === 1 ? '' : 's'))),
          h('span', { class: 'rs-row-pop' }, String(g.n))));
      });
      if (!groups.length) railList.appendChild(emptyRow(S.q ? 'No place matches' : 'Nobody has a home yet'));
      return;
    }
    const rows = S.list.filter((r) => matches(haystack(r, all), S.q));
    rows.forEach((r) => {
      const home = r.home ? placeOf(r.home, all).text : '';
      const verb = nowVerb(r);
      railList.appendChild(h('button', {
        class: 'rs-row' + (fid(r.formId) === S.sel ? ' on' : '') + (r.dead ? ' dead' : ''),
        type: 'button', role: 'option',
        title: r.name + (home ? '\nHome: ' + home : '\nNo home') + (verb ? '\n' + verb : '') + (r.where ? '\nLast seen: ' + r.where : ''),
        onclick: () => select(r.formId),
      },
        faceEl(r, 'rs-face-row'),
        h('span', { class: 'rs-row-text' },
          h('span', { class: 'rs-row-name' }, r.name),
          h('span', { class: 'rs-row-sub' }, home || 'No home set')),
        verb ? h('span', { class: 'rs-row-now', title: 'What MHiYH has her doing right now' }, verb) : null,
        r.following ? h('span', { class: 'rs-row-tag', title: 'Following you' }, '➤') : null));
    });
    if (!rows.length) railList.appendChild(emptyRow(S.q ? 'No resident matches' : (S.loaded ? 'Nobody yet' : 'Reading MHiYH…')));
  }

  function emptyRow(text) {
    return h('div', { class: 'rs-rail-empty' }, text);
  }

  function renderFoot() {
    if (!railFoot) return;
    railFoot.textContent = '';
    const n = S.list.length;
    railFoot.append(
      h('span', { class: 'rs-count' }, S.loaded ? (n + ' resident' + (n === 1 ? '' : 's')) : 'reading…'),
      h('button', { class: 'rs-btn rs-btn-sm', type: 'button', title: 'Re-read MHiYH\'s registry', onclick: () => refresh() }, '⟳ Refresh'));
  }

  function renderMain() {
    if (!main) return;
    main.textContent = '';
    if (!S.loaded) { main.appendChild(h('div', { class: 'rs-skeleton' }, h('div'), h('div'), h('div'))); return; }
    if (S.present === false) {
      main.appendChild(h('div', { class: 'rs-empty' },
        h('div', { class: 'rs-empty-title' }, 'My Home is Your Home NG is not in this load order'),
        h('div', { class: 'rs-empty-sub' }, 'This mode reads and writes that mod\'s own registry. Install MHiYH SKSE NG and the residents will appear here.')));
      return;
    }
    if (!S.script) {
      main.appendChild(h('div', { class: 'rs-empty' },
        h('div', { class: 'rs-empty-title' }, 'The deck\'s door into MHiYH is missing'),
        h('div', { class: 'rs-empty-sub' }, S.msg || 'HD_MhiyhRemote.pex is not installed, or no save is loaded.'),
        h('div', { class: 'rs-empty-sub' }, 'It ships in the SkyManager Source mod under Scripts\\ — compile it with tools/compile-mhiyh-remote.ps1.')));
      return;
    }
    if (S.view === 'places') { renderPlace(); return; }
    const r = selected();
    if (!r) {
      main.appendChild(h('div', { class: 'rs-empty' },
        h('div', { class: 'rs-empty-title' }, S.list.length ? 'Pick a resident' : 'Nobody lives anywhere yet'),
        h('div', { class: 'rs-empty-sub' }, S.list.length
          ? 'Choose someone on the left to see and change her whole day.'
          : 'Give someone a home — from her F7 card, her row on the Followers tab, or by talking to her — and she appears here.')));
      return;
    }
    renderPerson(r);
  }

  function chip(text, cls, title) {
    return h('span', { class: 'rs-chip' + (cls ? ' ' + cls : ''), title: title || null }, text);
  }

  function renderPerson(r) {
    const all = marks();
    const home = r.home ? placeOf(r.home, all) : null;
    const verb = nowVerb(r);

    const head = h('div', { class: 'rs-head' },
      faceEl(r, 'rs-face-big'),
      h('div', { class: 'rs-head-text' },
        h('div', { class: 'rs-name' }, r.name),
        h('div', { class: 'rs-chips' },
          r.dead ? chip('Dead', 'rs-chip-bad') : null,
          r.following ? chip('➤ Following you', 'rs-chip-gold') : (r.waiting ? chip('Told to wait', 'rs-chip-dim') : null),
          verb ? chip(verb, 'rs-chip-gold', 'What MHiYH has her doing right now') : chip('Idle', 'rs-chip-dim', 'MHiYH has no activity in force for her this moment'),
          r.where ? chip((r.inWorld ? 'Here: ' : 'Last seen: ') + r.where, 'rs-chip-dim', r.inWorld ? 'She is loaded in the world right now' : 'Her last known cell — she is not loaded') : null,
          chip('slot ' + r.slot, 'rs-chip-dim', 'Her row in MHiYH\'s registry'))),
      h('div', { class: 'rs-head-actions' },
        home ? h('button', { class: 'rs-btn', type: 'button', title: 'Travel to her home (' + home.text + ')', onclick: () => travel(r.home, r.name + '\'s home') }, '➤ Go to her home') : null,
        home ? h('button', { class: 'rs-btn', type: 'button', disabled: r.following ? true : null,
          title: r.following ? 'She is following you — dismiss her first, or she just walks back' : 'Put her at her home marker right now',
          onclick: () => act({ op: 'sendHome', formId: r.formId }, 'Sending ' + r.name + ' home…') }, '⤓ Send home') : null,
        h('button', { class: 'rs-btn', type: 'button', title: 'Re-link every marker and alias MHiYH holds for her (its own RepairActor)',
          onclick: () => act({ op: 'repair', formId: r.formId }, 'Re-linking ' + r.name + '\'s day…') }, '⟲ Repair'),
        home ? h('button', { class: 'rs-btn rs-btn-danger' + (isArmed('forget') ? ' armed' : ''), type: 'button',
          title: isArmed('forget') ? 'Click again to forget her home AND every stop' : 'Forget her home — every other stop goes with it, and she leaves MHiYH\'s registry',
          onclick: () => { if (isArmed('forget')) act({ op: 'forget', formId: r.formId }, 'Forgetting ' + r.name + '\'s home…'); else arm('forget'); } },
          isArmed('forget') ? '✕ Sure? Forget everything' : '✕ Forget home') : null));
    main.appendChild(head);
    main.appendChild(h('button',{class:'rs-btn',type:'button',disabled:r.dead?true:null,onclick:()=>openRhythms(r)},'Saved rhythms…'));

    if (S.pending) main.appendChild(h('div', { class: 'rs-pending' }, S.pending));

    const day = S.day[fid(r.formId)] || null;
    const grid = h('div', { class: 'rs-day', role: 'table', 'aria-label': r.name + '\'s day' });
    grid.appendChild(h('div', { class: 'rs-day-head' },
      h('span', {}, 'Stop'), h('span', {}, 'Where'), h('span', {}, 'When'), h('span', {}, '')));
    KINDS.forEach((spec) => grid.appendChild(dayRow(r, spec, day, all)));
    main.appendChild(grid);

    if (!day) {
      main.appendChild(h('div', { class: 'rs-note' },
        S.dayPending === fid(r.formId) ? 'Reading her hours from MHiYH…'
          : h('button', { class: 'rs-btn rs-btn-sm', type: 'button', onclick: () => fetchDay(r.formId) }, 'Read her hours')));
    }

    if (S.picker && fid(S.picker.formId) === fid(r.formId)) main.appendChild(pickerEl(r, all));
  }

  function geoOf(r, k) {
    if (k === K_HOME) return r.home;
    const a = r.actByK[k];
    return (a && (a.cellId || a.worldspaceId || a.place)) ? a : null;
  }

  function dayRow(r, spec, day, all) {
    const k = spec.k;
    const geo = geoOf(r, k);
    const place = geo ? placeOf(geo, all) : null;
    const isNow = (r.now || []).indexOf(k) !== -1 || (k === K_GUARD && (r.now || []).indexOf(K_WATCH) !== -1);
    const hasHome = !!r.home;
    const canSet = k === K_HOME || hasHome;
    const row = h('div', { class: 'rs-day-row' + (isNow ? ' now' : '') + (geo ? '' : ' unset'), role: 'row' });

    row.appendChild(h('span', { class: 'rs-day-stop', title: spec.hint },
      h('span', { class: 'rs-day-glyph' }, spec.glyph),
      h('span', { class: 'rs-day-label' }, spec.label),
      isNow ? h('span', { class: 'rs-day-now', title: 'In force right now' }, 'now') : null));

    const where = h('span', { class: 'rs-day-where' });
    if (place) {
      where.append(h('span', { class: 'rs-day-place' + (place.mark ? ' matched' : '') ,
        title: place.mark ? 'On your domain "' + place.text + '"' : 'Not on any domain you have marked — MHiYH\'s own name for the cell' }, place.text));
      if (!place.mark && geo.place && geo.cellName && geo.place !== geo.cellName) where.append(h('span', { class: 'rs-day-cell' }, geo.cellName));
    } else {
      where.append(h('span', { class: 'rs-day-place none' }, k === K_HOME ? 'No home yet' : 'Not set'));
    }
    row.appendChild(where);

    const when = h('span', { class: 'rs-day-when' });
    const hrs = day ? (k === K_GUARD ? (day.find((d) => d.k === K_GUARD) || null) : (day.find((d) => d.k === k) || null)) : null;
    if (k === K_HOME) {
      when.append(h('span', { class: 'rs-day-hours dim' }, 'Whenever nothing else is due'));
    } else if (hrs) {
      const guardMode = k === K_GUARD ? guardModeOf(day) : -1;
      const on = k === K_GUARD ? guardMode > 0 : hrs.enabled;
      when.append(
        stepper('Starts', hourLabel(hrs.start), () => sendHours(r, k, hrs, { start: (hrs.start + 23) % 24 }), () => sendHours(r, k, hrs, { start: (hrs.start + 1) % 24 })),
        stepper('Ends', endLabel(hrs.end), () => sendHours(r, k, hrs, { end: (hrs.end + 23) % 24 }), () => sendHours(r, k, hrs, { end: hrs.end >= 24 ? 0 : hrs.end + 1 })),
        stepper('Wander', hrs.radius + ' u', () => sendHours(r, k, hrs, { radius: Math.max(RADIUS_MIN, hrs.radius - RADIUS_STEP) }), () => sendHours(r, k, hrs, { radius: Math.min(RADIUS_MAX, hrs.radius + RADIUS_STEP) }),
          'How far from the marker she may wander during this stop'));
      if (k === K_GUARD) {
        when.append(h('span', { class: 'rs-guard-modes', role: 'radiogroup', 'aria-label': 'Guard mode' },
          guardChip(r, 'Off', 0, guardMode, geo), guardChip(r, 'Watch', 1, guardMode, geo), guardChip(r, 'Guard', 2, guardMode, geo)));
      } else {
        when.append(h('button', { class: 'rs-toggle' + (on ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
          disabled: geo ? null : true,
          title: geo ? (on ? 'Scheduled — click to switch this stop off without forgetting the place' : 'Off — click to schedule it') : 'Set a place first',
          onclick: () => sendHours(r, k, hrs, { enabled: !on }) }, on ? 'On' : 'Off'));
      }
    } else {
      when.append(h('span', { class: 'rs-day-hours dim' }, day ? '—' : '…'));
    }
    row.appendChild(when);

    const acts = h('span', { class: 'rs-day-acts' });
    acts.append(
      h('button', { class: 'rs-btn rs-btn-sm', type: 'button', disabled: canSet ? null : true,
        title: canSet ? 'Make where you are standing her ' + spec.label.toLowerCase() + (k === K_HOME ? '' : ' spot') : 'Give her a home first — every other stop hangs off it',
        onclick: () => act({ op: 'setAt', formId: r.formId, kind: k, here: true }, 'Marking here as ' + r.name + '\'s ' + spec.label.toLowerCase() + '…') }, '⌖ Here'),
      h('button', { class: 'rs-btn rs-btn-sm rs-btn-gold', type: 'button', disabled: canSet ? null : true,
        title: canSet ? 'Put this stop on one of your Domains — from anywhere' : 'Give her a home first — every other stop hangs off it',
        onclick: () => openPicker(r, k) }, '⌂ Domain…'),
      geo && (geo.cellId || geo.worldspaceId) ? h('button', { class: 'rs-btn rs-btn-sm', type: 'button', title: 'Travel there',
        onclick: () => travel(geo, r.name + '\'s ' + spec.label.toLowerCase()) }, '➤ Go') : null,
      (geo && k !== K_HOME) ? h('button', { class: 'rs-btn rs-btn-sm rs-btn-danger' + (isArmed('clear' + k) ? ' armed' : ''), type: 'button',
        title: isArmed('clear' + k) ? 'Click again to forget this stop' : 'Forget this stop (she keeps her home and every other stop)',
        onclick: () => { if (isArmed('clear' + k)) act({ op: 'clear', formId: r.formId, kind: k }, 'Clearing ' + r.name + '\'s ' + spec.label.toLowerCase() + '…'); else arm('clear' + k); } },
        isArmed('clear' + k) ? 'Sure?' : '✕') : null);
    row.appendChild(acts);
    return row;
  }

  function guardModeOf(day) {
    if (!day) return -1;
    const a = day.find((d) => d.k === K_GUARD), p = day.find((d) => d.k === K_WATCH);
    if (a && a.enabled) return 2;
    if (p && p.enabled) return 1;
    return 0;
  }

  function guardChip(r, label, mode, cur, geo) {
    return h('button', { class: 'rs-mode' + (cur === mode ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': cur === mode ? 'true' : 'false',
      disabled: geo ? null : true,
      title: mode === 0 ? 'No guard duty (the post is kept)' : mode === 1 ? 'Keep watch — stands at the post, passive' : 'Stand guard — actively guards the post',
      onclick: () => { if (cur !== mode) act({ op: 'guard', formId: r.formId, mode: mode }, 'Setting ' + r.name + '\'s guard mode…'); } }, label);
  }

  function stepper(label, value, dec, inc, title) {
    return h('span', { class: 'rs-step', title: title || null },
      h('span', { class: 'rs-step-lbl' }, label),
      h('button', { class: 'rs-step-btn', type: 'button', title: 'Earlier / less', onclick: dec }, '‹'),
      h('span', { class: 'rs-step-val' }, value),
      h('button', { class: 'rs-step-btn', type: 'button', title: 'Later / more', onclick: inc }, '›'));
  }

  /* Hours edits are local first (the stepper moves at once) and sent after a
     short quiet gap, one Papyrus call per (resident, stop) rather than one per
     click. */
  function sendHours(r, k, hrs, patch) {
    const key = fid(r.formId);
    const day = S.day[key];
    if (!day) return;
    const kinds = k === K_GUARD ? [K_GUARD, K_WATCH] : [k];
    kinds.forEach((kk) => {
      const row = day.find((d) => d.k === kk);
      /* the twin guard row (7) shares hours but keeps its OWN enabled flag — that flag is the guard mode */
      if (row) Object.keys(patch).forEach((p) => { if (kk === k || p !== 'enabled') row[p] = patch[p]; });
    });
    renderMain();
    const row = day.find((d) => d.k === k);
    scheduleHours(key + ':' + k, () => {
      act({ op: 'hours', formId: r.formId, kind: k, start: row.start, end: row.end, enabled: !!row.enabled, radius: row.radius },
        'Setting ' + r.name + '\'s ' + kindSpec(k).label.toLowerCase() + ' hours…');
    });
  }

  function scheduleHours(tk, fn) {
    if (hoursTimers[tk]) clearTimeout(hoursTimers[tk].id);
    hoursTimers[tk] = { fn: fn, id: setTimeout(() => { delete hoursTimers[tk]; fn(); }, HOURS_DEBOUNCE) };
  }
  /* Fire every pending hours op now — the harness's seam, so the debounce can
     be asserted without waiting on a real clock. */
  function flushHours() {
    Object.keys(hoursTimers).forEach((tk) => {
      const t = hoursTimers[tk];
      clearTimeout(t.id);
      delete hoursTimers[tk];
      t.fn();
    });
  }

  function travel(geo, label) {
    if (!geo || !(geo.cellId || geo.worldspaceId)) return;
    toGame('pdRecall', JSON.stringify({
      id: '', name: label, category: '',
      cellId: geo.cellId >>> 0, cellEdid: '', worldspaceId: geo.worldspaceId >>> 0,
      interior: !!geo.interior, x: Number(geo.x) || 0, y: Number(geo.y) || 0, z: Number(geo.z) || 0,
      angleZ: 0, label: '➤ ' + label,
    }));
  }

  /* ------------------------------------------------------------ picker -- */

  function openPicker(r, k) {
    S.picker = { formId: r.formId, kind: k, q: '' };
    disarm();
    renderMain();
    const inp = document.getElementById('rs-pick-q');
    if (inp) setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
  }
  function closePicker() { S.picker = null; renderMain(); }

  function pickerRows(all, q) {
    const rows = all.map((m) => ({ m: m, label: markLabel(all, m),
      hay: [m.name, m.category, m.cellName, m.worldspaceName, m.note].concat(m.tags || []).filter(Boolean).join(' ') }));
    rows.sort((a, b) => a.label.localeCompare(b.label));
    return rows.filter((x) => matches(x.label + ' ' + x.hay, q));
  }

  function pickerEl(r, all) {
    const spec = kindSpec(S.picker.kind);
    const list = h('div', { class: 'rs-pick-list', role: 'listbox' });
    const paint = () => {
      list.textContent = '';
      const rows = pickerRows(all, S.picker.q);
      if (!S.picker.q) {
        list.appendChild(h('button', { class: 'rs-pick-row rs-pick-here', type: 'button',
          title: 'Where you are standing right now', onclick: () => choose(null) },
          h('span', { class: 'rs-pick-glyph' }, '⌖'), h('span', { class: 'rs-pick-name' }, 'Right here'),
          h('span', { class: 'rs-pick-sub' }, 'the spot you stand on')));
      }
      rows.forEach((x) => list.appendChild(h('button', { class: 'rs-pick-row', type: 'button',
        title: x.m.note || x.label, onclick: () => choose(x.m) },
        h('span', { class: 'rs-pick-glyph' }, x.m.interior ? '⌂' : '▲'),
        h('span', { class: 'rs-pick-name' }, x.label),
        h('span', { class: 'rs-pick-sub' }, [x.m.category, x.m.cellName || x.m.worldspaceName].filter(Boolean).join(' · ')))));
      if (!rows.length) list.appendChild(h('div', { class: 'rs-rail-empty' }, all.length ? 'No domain matches' : 'You have not marked any domains yet — mark one under 🗺 Places'));
    };
    const choose = (m) => {
      const k = S.picker.kind;
      S.picker = null;
      if (m) act({ op: 'setAt', formId: r.formId, kind: k, mark: { id: m.id, name: markLabel(all, m), cellId: m.cellId >>> 0, cellEdid: m.cellEdid || '', x: m.x, y: m.y, z: m.z, angleZ: m.angleZ || 0 } },
        'Marking ' + markLabel(all, m) + ' as ' + r.name + '\'s ' + spec.label.toLowerCase() + '…');
      else act({ op: 'setAt', formId: r.formId, kind: k, here: true }, 'Marking here as ' + r.name + '\'s ' + spec.label.toLowerCase() + '…');
    };
    const inp = h('input', { id: 'rs-pick-q', class: 'rs-pick-q', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Type to filter your domains… (Enter = top hit)', value: S.picker.q,
      oninput: (e) => { S.picker.q = e.target.value || ''; paint(); },
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closePicker(); return; }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const f = list.querySelector('.rs-pick-row'); if (f) f.click(); }
      } });
    paint();
    return h('div', { class: 'rs-pick', role: 'dialog', 'aria-label': 'Choose a domain' },
      h('div', { class: 'rs-pick-head' },
        h('span', { class: 'rs-pick-title' }, spec.glyph + ' ' + r.name + ' — ' + spec.label.toLowerCase() + (spec.k === K_HOME ? '' : ' spot') + ' at…'),
        h('button', { class: 'rs-btn rs-btn-sm', type: 'button', title: 'Close', onclick: closePicker }, '✕')),
      inp, list);
  }

  /* Saved full schedules are owned by the native sidecar; the UI sends IDs, never a fabricated schedule. */
  let rhythmModal = null, rhythmState = null;
  let rhythmLibrary = [], rhythmBusy = false, rhythmMessage = '';
  function closeRhythms() {
    if (rhythmModal && rhythmModal.parentNode) rhythmModal.parentNode.removeChild(rhythmModal);
    rhythmModal = null; rhythmState = null;
  }
  window.rsPresetsResult = function(payload) {
    let d=payload; if(typeof d==='string'){try{d=JSON.parse(d);}catch(_){return;}}
    if(!d || typeof d!=='object') return;
    if(Array.isArray(d.presets)) rhythmLibrary=d.presets;
    rhythmBusy=!!d.busy; rhythmMessage=d.msg||'';
    if(rhythmState){rhythmState.loading=false;paintRhythms();}
    if(d.op!=='list' && d.msg) say(d.msg);
  };
  function openRhythms(subjects) {
    if(window.HDCss && !HDCss.ready('domains')) { HDCss.need('domains',()=>openRhythms(subjects));return; }
    closeRhythms();
    const people=(Array.isArray(subjects)?subjects:[subjects]).filter(r=>r&&r.formId&&!r.dead);
    if(!people.length){say('Select a living NPC first.');return;}
    rhythmState={people:people,target:people.length===1?fid(people[0].formId):'',q:'',personQ:'',id:'',name:'',review:false,deleteId:'',loading:true};
    rhythmMessage='';rhythmLibrary=[];
    rhythmModal=h('div',{class:'rs-rhythm-shade',onkeydown:e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeRhythms();}
      if(e.key==='Tab'){
        const nodes=Array.from(rhythmModal.querySelectorAll('button,input')).filter(n=>!n.disabled);
        const first=nodes[0],last=nodes[nodes.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    }});
    const appPanel=document.getElementById('panel');
    if(appPanel&&appPanel.getBoundingClientRect){const r=appPanel.getBoundingClientRect();if(r.width>0&&r.height>0){rhythmModal.style.inset='auto';rhythmModal.style.left=r.left+'px';rhythmModal.style.top=r.top+'px';rhythmModal.style.width=r.width+'px';rhythmModal.style.height=r.height+'px';}}
    (document.getElementById('overlay')||document.body).appendChild(rhythmModal);
    paintRhythms();toGame('rsPresets',JSON.stringify({op:'list'}));
    const input=rhythmModal.querySelector('input');if(input)input.focus();
  }
  function paintRhythms() {
    if(!rhythmModal||!rhythmState)return;
    const s=rhythmState;rhythmModal.textContent='';
    const target=s.people.find(r=>fid(r.formId)===s.target);
    const btn=(label,fn,disabled)=>h('button',{class:'rs-btn',type:'button',disabled:disabled?true:null,onclick:fn},label);
    const box=h('section',{class:'rs-rhythm',role:'dialog','aria-modal':'true','aria-labelledby':'rs-rhythm-title'});
    box.append(h('header',{class:'rs-rhythm-head'},h('h2',{id:'rs-rhythm-title'},'Saved rhythms'),btn('Close ×',closeRhythms)));
    box.append(h('p',{class:'rs-rhythm-intro'},'Save a complete day, then reuse its destinations, hours and guard mode. Replacing a rhythm also clears stops missing from the preset.'));
    if(s.people.length>1){
      const choices=h('div',{class:'rs-rhythm-people'});
      const paintPeople=()=>{choices.textContent='';s.people.filter(r=>matches(r.name,s.personQ)).forEach(r=>choices.append(btn((fid(r.formId)===s.target?'✓ ':'')+r.name,()=>{s.target=fid(r.formId);s.review=false;paintRhythms();})));};
      box.append(h('label',{class:'rs-rhythm-label'},'Apply to one resident',h('input',{class:'rs-rhythm-input',type:'search',placeholder:'Find a resident…',value:s.personQ,oninput:e=>{s.personQ=e.target.value;paintPeople();},onkeydown:e=>{if(e.key==='Enter'){const b=choices.querySelector('button');if(b)b.click();}}})),choices);paintPeople();
    } else box.append(h('p',{class:'rs-rhythm-target'},target.name));
    const saveName=h('input',{class:'rs-rhythm-input',type:'text',maxlength:'100',placeholder:'Name this rhythm…',value:s.name,oninput:e=>{s.name=e.target.value;saveButton.disabled=!s.name.trim()||!target||rhythmBusy||s.loading;}});
    const saveButton=btn('Save current rhythm',()=>{
      const name=s.name.trim();if(!name||!target)return;
      closeRhythms();toGame('rsPresets',JSON.stringify({op:'save',formId:target.formId,name:name}));
    },!s.name.trim()||!target||rhythmBusy||s.loading);
    box.append(h('div',{class:'rs-rhythm-save'},h('label',{class:'rs-rhythm-label'},'Capture this NPC’s current day',saveName),saveButton));
    const list=h('div',{class:'rs-rhythm-list'});
    const paintList=()=>{
      list.textContent='';
      const presets=rhythmLibrary.filter(p=>matches(p.name+' '+p.source,s.q));
      presets.forEach(p=>list.append(h('button',{class:'rs-rhythm-option'+(s.id===p.id?' selected':''),type:'button',onclick:()=>{s.id=p.id;s.review=false;s.deleteId='';paintRhythms();}},
        h('strong',{},p.name),h('span',{},'From '+p.source+' · '+(p.slots||[]).filter(Boolean).length+' destinations'))));
      if(!presets.length)list.append(h('p',{},s.loading?'Loading saved rhythms…':s.q?'No rhythms match.':'No saved rhythms yet. Set up one NPC’s day, then save it above.'));
    };
    box.append(h('input',{class:'rs-rhythm-input',type:'search','aria-label':'Search saved rhythms',placeholder:'Find a saved rhythm…',value:s.q,oninput:e=>{s.q=e.target.value;paintList();},onkeydown:e=>{if(e.key==='Enter'){const b=list.querySelector('button');if(b)b.click();}}}),list);paintList();
    const p=rhythmLibrary.find(p=>p.id===s.id);
    if(p){
      const detail=h('div',{class:'rs-rhythm-detail'},h('h3',{},p.name));
      KINDS.forEach(spec=>{
        const slot=(p.slots||[])[spec.k], hrs=(p.day||[]).find(d=>d.k===spec.k);
        const guard=spec.k===3?guardModeOf(p.day||[]):0;
        detail.append(h('div',{class:'rs-rhythm-stop'},h('strong',{},spec.label),h('span',{},slot?slot.name:'Clear this stop'),h('span',{},slot&&hrs?(spec.k===0?'Home':spec.k===3?(guard===2?'Guard':guard===1?'Watch':'Off')+' · '+hourLabel(hrs.start)+'–'+endLabel(hrs.end):(hrs.enabled?'':'Off · ')+hourLabel(hrs.start)+'–'+endLabel(hrs.end)):'—')));
      });
      detail.append(h('p',{},'These are the saved physical spots; moving a Domain later does not move this preset.'));
      if(s.review)detail.append(h('p',{class:'rs-rhythm-confirm'},'Replace '+target.name+'’s entire day with “'+p.name+'”? Their home moves too. This changes your save and closes SkyManager while MHiYH applies it.'));
      detail.append(h('div',{class:'rs-rhythm-actions'},btn(s.review?'Confirm replacement':'Replace rhythm…',()=>{
        if(!target)return;
        if(!s.review){s.review=true;paintRhythms();return;}
        closeRhythms();toGame('rsPresets',JSON.stringify({op:'apply',formId:target.formId,id:p.id,confirm:true}));
      },!target||rhythmBusy||s.loading),btn(s.deleteId===p.id?'Confirm delete':'Delete preset',()=>{
        if(s.deleteId!==p.id){s.deleteId=p.id;paintRhythms();return;}
        s.id='';s.deleteId='';toGame('rsPresets',JSON.stringify({op:'delete',id:p.id}));
      },rhythmBusy||s.loading)));
      box.append(detail);
    }
    if(rhythmMessage)box.append(h('p',{class:'rs-rhythm-feedback',role:'status'},rhythmMessage));
    if(rhythmBusy)box.append(h('p',{role:'status'},'A rhythm operation is still running in the game.'));
    rhythmModal.append(box);
  }

  function domainArt(mark, small, unmatched) {
    const wrap=h('span',{class:small?'rs-domain-thumb':'rs-place-crest'});
    if(!mark||!mark.image){wrap.textContent=unmatched?'?':'⌂';return wrap;}
    wrap.classList.add('rs-domain-photo');
    wrap.append(h('img',{src:mark.image,alt:mark.name||'Domain',onerror:()=>{wrap.textContent=unmatched?'?':'⌂';wrap.classList.remove('rs-domain-photo');}}));
    return wrap;
  }

  /* -------------------------------------------------------- places view -- */

  function renderPlace() {
    const all = marks();
    const groups = placeGroups(all);
    const g = groups.find((x) => x.key === S.place) || groups[0] || null;
    if (!g) {
      main.appendChild(h('div', { class: 'rs-empty' },
        h('div', { class: 'rs-empty-title' }, 'Nobody is stationed anywhere yet'),
        h('div', { class: 'rs-empty-sub' }, 'Give someone a home and her stops appear under the domain they sit on.')));
      return;
    }
    S.place = g.key;
    const mark = g.key.indexOf('m:') === 0 ? markById(all, g.key.slice(2)) : null;
    main.appendChild(h('div', { class: 'rs-head' },
      domainArt(mark,false,g.key==='u'),
      h('div', { class: 'rs-head-text' },
        h('div', { class: 'rs-name' }, g.label),
        h('div', { class: 'rs-chips' },
          chip(g.n + ' resident' + (g.n === 1 ? '' : 's'), 'rs-chip-gold'),
          mark ? chip(mark.category || 'domain', 'rs-chip-dim') : chip('stops at no domain you have marked', 'rs-chip-dim'))),
      h('div', { class: 'rs-head-actions' },
        mark ? h('button', { class: 'rs-btn', type: 'button', title: 'Travel to this domain', onclick: () => travel(mark, mark.name) }, '➤ Go') : null)));
    main.appendChild(h('button',{class:'rs-btn',type:'button',onclick:()=>openRhythms(Object.keys(g.people).map(k=>g.people[k].r))},'Saved rhythms for residents…'));
    const cards = h('div', { class: 'rs-cards' });
    Object.keys(g.people).map((k) => g.people[k]).sort((a, b) => a.r.name.localeCompare(b.r.name)).forEach((p) => {
      cards.appendChild(h('button', { class: 'rs-card', type: 'button', title: 'Open ' + p.r.name + '\'s day',
        onclick: () => { S.view = 'people'; select(p.r.formId); } },
        faceEl(p.r, 'rs-face-card'),
        h('span', { class: 'rs-card-text' },
          h('span', { class: 'rs-card-name' }, p.r.name),
          h('span', { class: 'rs-card-roles' }, p.roles.map((x) => x.role + (x.place !== g.label ? ' · ' + x.place : '')).join(' — ')))));
    });
    main.appendChild(cards);
  }

  /* -------------------------------------------------------------- host -- */

  function setActive(on) {
    on = !!on;
    if (!ensureDom()) return;
    S.active = on;
    body.classList.toggle('hidden', !on);
    if (!on) { disarm(); S.picker = null; clearTimeout(faceTimer); }
  }

  /* Called by bases-pane.js when its switch lands on us (and again on every
     Domains show while we are the mode): always re-ask — homes change while
     the deck is closed. */
  function onEnter() {
    if (!ensureDom()) return;
    setActive(true);
    refresh();
    render();
    if (search) setTimeout(() => { try { search.focus(); } catch (_) {} }, 0);
  }

  function onHide() { disarm(); S.picker = null; clearTimeout(faceTimer); }

  function boot() {
    if (!document.getElementById('dm-pane')) { setTimeout(boot, 60); return; }
    ensureDom();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Omni: every resident is findable from the universal search. Indexed
     live at query time (the provider contract in hd-omni.js). */
  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'residents',
      label: 'Residents',
      index: function () {
        const all = marks();
        return S.list.map((r) => ({
          key: 'res:' + fid(r.formId),
          label: r.name,
          detail: 'MHiYH resident · ' + (r.home ? placeOf(r.home, all).text : 'no home') + (nowVerb(r) ? ' · ' + nowVerb(r) : ''),
          kind: 'resident',
          keywords: haystack(r, all),
          run: function () {
            if (typeof window.hdSetTab === 'function') window.hdSetTab('domains');
            if (window.BasesPane) BasesPane.setMode('residents');
            S.view = 'people';
            select(r.formId);
            return true;
          },
          snap: { formId: r.formId, name: r.name },
        }));
      },
      pinRun: function (snap) {
        if (typeof window.hdSetTab === 'function') window.hdSetTab('domains');
        if (window.BasesPane) BasesPane.setMode('residents');
        S.view = 'people';
        if (snap && snap.formId) select(snap.formId);
        return true;
      },
    });
  }

  return {
    openRhythms: openRhythms,
    closeOverlays: closeRhythms,
    setActive: setActive,
    onEnter: onEnter,
    onHide: onHide,
    refresh: refresh,
    select: select,
    setView: setView,
    render: render,
    state: function () { return S; },
    /* test seams — the two halves that must agree with C++ and with Domains */
    _matchMark: matchMark, _placeOf: placeOf, _placeGroups: placeGroups, _kindSpec: kindSpec,
    _guardModeOf: guardModeOf, _hourLabel: hourLabel, _endLabel: endLabel, _haystack: haystack,
    _mount: ensureDom, _ingest: function (d) { window.rsStateResult(d); },
    _flushHours: flushHours,
    _KINDS: KINDS, _RS_NEAR: RS_NEAR, _RS_CHILD_NEAR: RS_CHILD_NEAR,
  };
})();
