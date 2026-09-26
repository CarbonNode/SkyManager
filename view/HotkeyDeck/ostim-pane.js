'use strict';

/* ====================================================================== *
 *  OStim — a scene search / change / control panel living as the second
 *  segment ("OStim") of the deck's Animations tab, beside "Poses".
 *
 *  The ask (Rober, 2026-08-07): the search-popout half of OStim Prism
 *  (Nexus 174750) WITHOUT replacing OStim's native menu — "an animation
 *  searcher popout I can use while in a scene to change the scene or start
 *  a scene" — plus OStim Furniture Switch (Nexus 184782) built in without
 *  enabling it: real-time furniture switch + DOM/SUB role swap.
 *
 *  C++ (ostim_deck.cpp) owns the OStim SA Thread API; this pane owns the UI.
 *  Bridge — JS->C++ requests:
 *    osGet() · osPoll() · osSearch(q) · osNav(sceneId) · osSpeed("+"/"-")
 *    osAuto() · osFurn("nearby"/"floor") · osSwap() · osLog(str)
 *  C++->JS replies (names disjoint from the requests, per the deck law):
 *    osOpen(state+scenes) · osState(state) · osList(results) · osResult({ok,msg,…})
 *
 *  It hangs off AnimPane's lifecycle: AnimPane.onShow()/onHide() call
 *  OStimPane.onAnimShow()/onAnimHide(), and the #an-seg buttons flip the
 *  Animations tab between the Poses body (#an-row) and this one (#os-body).
 * ====================================================================== */

window.OStimPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const RENDER_CAP = 200;   // rows painted at once — keep typing to narrow
  const SEARCH_DEBOUNCE = 130;
  const POLL_MS = 1500;      // live-state refresh cadence while OStim mode is up

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV) devBridge(fn, arg);
    }
  }
  function glog(msg) { toGame('osLog', msg); }

  /* --------------------------------------------------- dev / browser mock */

  const DEV_SCENES = [
    { sceneId: 'ostim-standing-hugkiss', name: 'Standing Hug Kiss', actorCount: 2 },
    { sceneId: 'ostim-missionary', name: 'Missionary', actorCount: 2 },
    { sceneId: 'ostim-cowgirl', name: 'Cowgirl', actorCount: 2 },
    { sceneId: 'ostim-blowjob-kneel', name: 'Kneeling Blowjob', actorCount: 2 },
    { sceneId: 'ostim-threesome-dp', name: 'Threesome DP', actorCount: 3 },
    { sceneId: 'ostim-solo-touch', name: 'Solo Touch', actorCount: 1 },
    { sceneId: 'ostim-foursome-line', name: 'Foursome Line', actorCount: 4 },
    { sceneId: 'ostim-standing-behind', name: 'Standing From Behind', actorCount: 2 },
  ];
  function devState(inScene) {
    return inScene ? {
      ok: true, ostim: true, inScene: true, threadID: 12,
      scene: 'ostim-missionary', sceneName: 'Missionary', actorCount: 2,
      actors: [{ name: 'Dragonborn', female: false, formId: 20 }, { name: 'Lydia', female: true, formId: 42 }],
      speed: 1, maxSpeed: 3, auto: false, furnitureType: '', canSwap: true,
    } : {
      ok: true, ostim: true, inScene: false, threadID: 0, scene: '', sceneName: '',
      actorCount: 0, actors: [], speed: 0, maxSpeed: 0, auto: false, furnitureType: '', canSwap: false,
    };
  }
  function devBridge(fn, arg) {
    if (fn === 'osGet') {
      const s = devState(true); s.scenes = DEV_SCENES.map(x => ({ ...x, compatible: x.actorCount === 2 }));
      setTimeout(() => window.osOpen(JSON.stringify(s)), 20); return;
    }
    if (fn === 'osPoll') { setTimeout(() => window.osState(JSON.stringify(devState(true))), 20); return; }
    if (fn === 'osSearch') {
      const q = String(arg || '').toLowerCase();
      const r = DEV_SCENES.filter(x => x.name.toLowerCase().indexOf(q) !== -1)
        .map(x => ({ ...x, compatible: x.actorCount === 2 }));
      setTimeout(() => window.osList(JSON.stringify({ query: arg, results: r })), 20); return;
    }
    if (fn === 'osNav') { window.osResult(JSON.stringify({ ok: true, msg: '▸ ' + arg })); return; }
    if (fn === 'osSpeed') { window.osResult(JSON.stringify({ ok: true, msg: 'speed', speed: 2, maxSpeed: 3 })); return; }
    if (fn === 'osAuto') { window.osResult(JSON.stringify({ ok: true, msg: 'Auto OFF', auto: false })); return; }
    if (fn === 'osFurn') { window.osResult(JSON.stringify({ ok: true, msg: '→ ' + (arg === 'floor' ? 'floor' : 'Double Bed') })); return; }
    if (fn === 'osSwap') { window.osResult(JSON.stringify({ ok: true, msg: 'Swapping roles…' })); return; }
  }

  /* ============================================================= state == */

  const state = {
    ostim: false, inScene: false, threadID: 0,
    scene: '', sceneName: '', actorCount: 0, actors: [],
    speed: 0, maxSpeed: 0, auto: false, furnitureType: '',
    canSwap: false, scenes: [],
  };
  const ui = { inited: false, mode: 'poses', query: '', gotOpen: false, searchT: 0, pollT: 0, results: null };

  const els = {};
  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s === undefined || s === null ? '' : s); }

  /* ============================================================ render == */

  // The rows we show: an active search's results if present, else the seed list.
  const expandedGroups = new Set();
  function favorites() { return window.AnimPane ? AnimPane.sceneFavorites() : {}; }
  function rows() {
    let list = ui.favoriteMode ? Object.values(favorites()) : ((ui.results !== null) ? ui.results : state.scenes);
    if (ui.favoriteMode && ui.query) list = list.filter((s) => (s.name || s.sceneId).toLowerCase().indexOf(ui.query.toLowerCase()) !== -1);
    const seen = new Set();
    return list.filter((s) => { if (!s.sceneId || seen.has(s.sceneId)) return false; seen.add(s.sceneId); return true; });
  }
  function knownCompatible(s) {
    return state.inScene && (!ui.favoriteMode || state.scenes.concat(ui.results || []).some((x) => x.sceneId === s.sceneId));
  }
  function favoriteMode(on) {
    ui.favoriteMode = !!on;
    if (!on && ui.query) { ui.results = []; sendSearch(ui.query); }
    if (window.AnimPane) AnimPane.ensureSceneFavorites();
    renderList();
  }
  function sceneTools() {
    if (!els.list || document.getElementById('os-scene-tools')) return;
    const bar = document.createElement('div'); bar.id = 'os-scene-tools'; bar.className = 'os-scene-tools';
    [['All scenes', false], ['Favorite scenes', true]].forEach((x) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = x[0]; b.dataset.favorites = String(x[1]);
      b.addEventListener('click', () => favoriteMode(x[1])); bar.append(b);
    });
    const library=document.createElement('button');library.type='button';library.textContent='Collections & recent';library.addEventListener('click',()=>{if(window.OstimTools)OstimTools.open('library');});bar.append(library);
    els.list.parentNode.insertBefore(bar, els.list);
  }

  function renderStatus() {
    if (!els.scene) return;
    const inS = state.inScene;
    els.body.classList.toggle('os-outscene', !inS);

    // Search only works while a scene runs (OStim's SearchScenes needs a live
    // thread). Out of a scene, disable the box and say why — a live-looking but
    // silently-empty search reads as broken.
    if (els.search) {
      const canSearch = inS && state.ostim;
      els.search.disabled = !canSearch;
      els.search.placeholder = canSearch
        ? 'Search scene names… (Enter changes to the top hit)'
        : (state.ostim ? 'Start an OStim scene to search & change it' : 'OStim not detected');
    }

    if (!state.ostim) {
      els.scene.textContent = 'OStim not detected';
      els.sceneHint.textContent = 'Is OStim Standalone installed and enabled?';
      els.actors.textContent = '';
      return;
    }
    els.scene.textContent = inS ? (state.sceneName || state.scene || 'Scene') : 'Not in a scene';
    els.sceneHint.textContent = inS
      ? (state.actorCount + (state.actorCount === 1 ? ' actor' : ' actors'))
      : 'Start an OStim scene, then pick from the list to change it.';

    // actor chips
    els.actors.textContent = '';
    for (const a of state.actors) {
      const chip = document.createElement('span');
      chip.className = 'os-actor' + (a.female ? ' f' : ' m');
      chip.textContent = esc(a.name);
      els.actors.append(chip);
    }

    // controls: speed readout + enable/disable by scene state
    els.speedVal.textContent = inS ? (state.speed + ' / ' + state.maxSpeed) : '—';
    els.auto.classList.toggle('on', !!state.auto);
    els.auto.textContent = state.auto ? '⟳ Auto: ON' : '⟳ Auto: OFF';

    for (const b of els.ctlButtons) b.disabled = !inS;
    els.swap.disabled = !inS || !state.canSwap;
    els.swap.title = !inS ? 'Start a scene first'
      : (state.canSwap ? 'Swap DOM / SUB roles (reverses actor order)' : 'Needs at least two actors');
  }

  function renderList() {
    if (!els.list) return;
    sceneTools();
    document.querySelectorAll('#os-scene-tools button[data-favorites]').forEach((b) => {
      const active = (b.dataset.favorites === 'true') === !!ui.favoriteMode;
      b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active));
    });
    const savedScroll=els.list.scrollTop;
    const list = rows();
    const inS = state.inScene;
    els.count.textContent = list.length + (list.length === 1 ? ' scene' : ' scenes');
    els.list.textContent = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'os-empty';
      // ostim-absent is tested FIRST: absent implies not-in-scene, so testing
      // !inS first told a user with no OStim installed to start a scene.
      empty.textContent = ui.favoriteMode ? (ui.query ? 'No favorites match your search.' : 'Star scenes to collect them here. Each variant has its own star.') : (ui.gotOpen && !state.ostim)
        ? 'OStim Standalone isn’t installed or isn’t reporting — nothing to search here.'
        : (!inS
            ? 'Start an OStim scene first — then search here to change it.'
            : (ui.query
                ? 'No scene name matches “' + ui.query + '” for the current furniture & actors. '
                  + 'OStim searches scene NAMES — try a word like “behind”, “cowgirl” or “kiss”.'
                : 'No scenes for this furniture & actor count.'));
      els.list.append(empty);
      return;
    }

    // Note when we auto-swapped a colloquial term for its OStim scene-name.
    if (inS && ui.synShown && ui.synFor) {
      const note = document.createElement('div');
      note.className = 'os-more';
      note.textContent = 'No scene named “' + ui.synFor + '” — showing “' + ui.synShown + '” instead.';
      els.list.append(note);
    }

    // Group by display name, but preserve the actual scene IDs for actions and stars.
    const groups = new Map();
    list.forEach((scene) => {
      const key = (scene.name || scene.sceneId).trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(scene);
    });
    groups.forEach((g) => g.sort((a, b) => a.sceneId.localeCompare(b.sceneId)));
    const grouped = [];
    groups.forEach((g) => g.forEach((scene) => grouped.push(scene)));
    const containers = new Map();
    const shown = Math.min(grouped.length, RENDER_CAP);
    for (let i = 0; i < shown; i++) {
      const s = grouped[i];
      const groupKey = (s.name || s.sceneId).trim().toLowerCase();
      const siblings = groups.get(groupKey);
      let destination = els.list;
      if (siblings.length > 1) {
        if (!containers.has(groupKey)) {
          const group = document.createElement('div'); group.className = 'os-group';
          const toggle = document.createElement('button'); toggle.className = 'os-group-toggle'; toggle.type = 'button';
          const body = document.createElement('div'); body.className = 'os-group-body';
          const update = () => {
            const open = expandedGroups.has(groupKey);
            toggle.textContent = (open ? '▾ ' : '▸ ') + (s.name || s.sceneId) + ' (' + siblings.length + ')';
            toggle.setAttribute('aria-expanded', String(open)); body.hidden = !open;
          };
          toggle.addEventListener('click', () => {
            if (expandedGroups.has(groupKey)) expandedGroups.delete(groupKey); else expandedGroups.add(groupKey);
            update();
          });
          update(); group.append(toggle, body); els.list.append(group); containers.set(groupKey, body);
        }
        destination = containers.get(groupKey);
      }
      // OStim's SearchScenes already returns ONLY scenes that fit the running
      // thread (matching actor count + furniture), so every listed scene is a
      // valid target. Its SceneSearchResult.actorCount is unreliable (often 0),
      // so don't gate on it — being in a scene is the whole test.
      const compatible = knownCompatible(s);
      const acN = s.actorCount || state.actorCount || 0;   // result count is often 0; fall back to the live count
      const row = document.createElement('div');
      row.className = 'os-row' + (compatible ? '' : ' incompat') + (i === 0 && compatible ? ' top' : '');

      const main = document.createElement('div');
      main.className = 'os-row-main';
      const name = document.createElement('div');
      name.className = 'os-row-name';
      const variant = Number(s.variant) > 0 ? Number(s.variant) : (siblings.length > 1 ? siblings.indexOf(s) + 1 : 0);
      name.textContent = (s.name || s.sceneId) + (variant ? " " + variant : "");
      name.title = s.sceneId;
      const meta = document.createElement('div');
      meta.className = 'os-row-meta';
      meta.textContent = [(acN ? acN + ' participants' : 'Scene'),s.pack||'Pack not supplied',s.furniture==='none'?'Floor':s.furniture||'Furniture not supplied'].join(' · ');
      main.append(name, meta);
      /* The position pictogram (2026-09-21). This is the list you actually
         PICK a scene from, so it is the one that most wanted the art.
         Deliberately borrowed from OstimTools rather than re-deriving: one
         keyword table, not two to drift apart. Feature-detected, because a
         missing icon here must never be able to break the browser. */
      const posArt = window.OstimTools && OstimTools.positionArt
        ? OstimTools.positionArt(s.name, s.sceneId, 'os-pos') : null;
      /* Matched or not, the slot is reserved — a list where only some scenes
         match must still line up in a column. */
      if (window.OstimTools && OstimTools.positionReference) {
        const pickArt = document.createElement('button'); pickArt.type = 'button'; pickArt.className = 'os-pos-picker';
        pickArt.setAttribute('aria-label', 'Choose icon for ' + (s.name || s.sceneId));
        pickArt.title = 'Choose an icon for this scene';
        pickArt.append(posArt || Object.assign(document.createElement('span'), { className: 'os-pos os-pos-none', textContent: '+' }));
        pickArt.addEventListener('click', (e) => { e.stopPropagation(); OstimTools.positionReference(s); });
        row.append(pickArt);
      } else row.append(posArt || Object.assign(document.createElement('span'), { className: 'os-pos os-pos-none' }));
      row.append(main);
      const star = document.createElement('button'); star.type = 'button';
      const saved = !!favorites()[s.sceneId];
      star.className = 'os-fav' + (saved ? ' on' : ''); star.textContent = saved ? '★' : '☆';
      star.setAttribute('aria-pressed', String(saved));
      star.setAttribute('aria-label', (saved ? 'Unfavorite ' : 'Favorite ') + name.textContent);
      star.title = (saved ? 'Remove from favorites' : 'Save this exact scene variant');
      star.disabled = !window.AnimPane || !AnimPane.sceneFavoritesReady();
      star.addEventListener('click', (e) => { e.stopPropagation(); if (window.AnimPane) AnimPane.toggleSceneFavorite(Object.assign({}, s, { variant: variant })); });
      row.append(star);

      const btn = document.createElement('button');
      btn.className = 'os-go';
      if (!inS) {
        btn.disabled = true;
        btn.textContent = 'Start';
        btn.title = 'Starting a fresh scene is coming soon — for now, change scenes while one is running';
      } else if (!compatible) {
        btn.disabled = true;
        btn.textContent = 'Unavailable';
        btn.title = 'Not in OStim’s current compatible results. Search for it in All scenes with the right actors and furniture.';
      } else {
        btn.textContent = 'Change';
        btn.title = 'Change the current scene to “' + (s.name || s.sceneId) + '”';
        btn.addEventListener('click', () => change(s));
      }
      row.append(btn);

      if (inS && compatible) row.addEventListener('click', (ev) => { if (ev.target !== btn) change(s); });
      destination.append(row);
    }

    els.list.scrollTop=savedScroll;
    if (list.length > shown) {
      const more = document.createElement('div');
      more.className = 'os-more';
      more.textContent = (list.length - shown) + ' more — keep typing to narrow it down.';
      els.list.append(more);
    }
  }

  function toast(msg, ok) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = 'os-toast show' + (ok === false ? ' bad' : '');
    clearTimeout(ui.toastT);
    ui.toastT = setTimeout(() => { els.toast.className = 'os-toast'; }, 2200);
  }

  /* The three segment toasts sit at identical coordinates (an-/os-/zz-toast are
     siblings of the bodies, all left:50% bottom:14px), so a toast that outlives
     its segment floats over the next one's list. Every entry path clears the
     segments it is leaving. */
  function hideToast() {
    if (!els.toast) return;
    clearTimeout(ui.toastT);
    els.toast.className = 'os-toast';
  }

  /* =========================================================== actions == */

  function change(s) {
    if (!s || !knownCompatible(s)) return;
    // No compatibility gate: OStim already filtered the list to scenes that fit
    // the running thread. (Its per-result actorCount is unreliable — often 0.)
    toGame('osNav', s.sceneId);
    toast('▸ ' + (s.name || s.sceneId), true);   // optimistic; osResult confirms
    glog('change ' + s.sceneId);
    schedulePoll(700);
  }

  /* The four live scene controls, named once so the buttons in init() and the
     Omni rows at the foot of this file fire the same code. They are the reason
     to reach for this segment mid-scene, which is exactly when hunting for a
     button costs the most. */
  function swapRoles() { toGame('osSwap'); toast('swapping…', true); schedulePoll(1000); }
  function setFurniture(kind) {
    if(kind==='nearby'&&window.OstimTools){OstimTools.open('move');return;} toGame('osFurn', kind === 'floor' ? 'floor' : 'nearby'); }
  function nudgeSpeed(dir) { toGame('osSpeed', dir === '-' ? '-' : '+'); }
  function toggleAuto() { toGame('osAuto'); }

  /* Colloquial → OStim scene-NAME synonyms. OStim's search matches the scene
     NAME only (doggy-style scenes are named "…From Behind…", not "doggy"), so a
     literal "doggy" finds nothing. When a term returns zero, we auto-retry its
     synonym and label the results. */
  const SYN = {
    'doggy': 'behind', 'doggystyle': 'behind', 'doggy style': 'behind',
    'from behind': 'behind', 'bj': 'blow', 'blowjob': 'oral', 'blow job': 'oral',
    'reverse cowgirl': 'reverse', '69': 'sixty', 'sixtynine': 'sixty',
    'titjob': 'titfuck', 'boobjob': 'titfuck', 'handjob': 'hand',
  };

  function sendSearch(term) { ui.lastSent = term; toGame('osSearch', term); }

  function doSearch() {
    const q = ui.query.trim();
    if (ui.favoriteMode) { renderList(); return; }
    ui.synShown = ''; ui.synFor = '';
    if (!q) { ui.results = null; ui.lastSent = ''; renderList(); return; }
    sendSearch(q);
  }

  function schedulePoll(delay) {
    clearTimeout(ui.pollOne);
    ui.pollOne = setTimeout(() => toGame('osPoll'), delay || POLL_MS);
  }
  function startPoll() { stopPoll(); ui.pollT = setInterval(() => toGame('osPoll'), POLL_MS); }
  function stopPoll() { if (ui.pollT) { clearInterval(ui.pollT); ui.pollT = 0; } clearTimeout(ui.pollOne); }

  /* =========================================================== receive == */

  function applyState(j) {
    state.ostim = !!j.ostim;
    state.inScene = !!j.inScene;
    state.threadID = Number(j.threadID) || 0;
    state.scene = esc(j.scene);
    state.sceneName = esc(j.sceneName);
    state.actorCount = Number(j.actorCount) || 0;
    state.actors = Array.isArray(j.actors) ? j.actors : [];
    state.speed = Number(j.speed) || 0;
    state.maxSpeed = Number(j.maxSpeed) || 0;
    state.auto = !!j.auto;
    state.furnitureType = esc(j.furnitureType);
    state.canSwap = !!j.canSwap;
    if (Array.isArray(j.scenes)) state.scenes = j.scenes;
    if(state.inScene&&window.AnimPane)AnimPane.recordScene({sceneId:state.scene,name:state.sceneName,actorCount:state.actorCount});
  }

  function receive(key, info) {
    let j = null;
    if (typeof info === 'string') { try { j = JSON.parse(info); } catch (e) { j = null; } }
    else if (info && typeof info === 'object') { j = info; }

    if (key === 'open') {
      if (!j || typeof j !== 'object') return true;
      ui.gotOpen = true;
      ui.results = null;                      // fresh open drops any stale search
      applyState(j);
      renderStatus(); renderList();
      // Smart landing: pick the segment now that we know if a scene is running.
      if (ui.pendingSmart) { ui.pendingSmart = false; setMode(state.inScene ? 'ostim' : 'poses'); }
      return true;
    }
    if (key === 'state') {
      if (j && typeof j === 'object') { applyState(j); renderStatus(); renderList(); }
      return true;
    }
    if (key === 'list') {
      if (j && Array.isArray(j.results)) {
        // Match against the term we actually SENT (may be a synonym), not the
        // raw box text — otherwise the synonym reply looks stale and is dropped.
        const replied = (j.query === undefined) ? (ui.lastSent || '') : String(j.query).trim();
        if (replied !== (ui.lastSent || '').trim()) return true;   // stale
        // A literal term that found nothing → auto-retry its OStim-name synonym.
        const raw = (ui.query || '').trim().toLowerCase();
        const syn = SYN[raw];
        if (!j.results.length && syn && (ui.lastSent || '').toLowerCase() !== syn && !ui.synShown) {
          ui.synShown = syn; ui.synFor = ui.query.trim();
          sendSearch(syn);
          return true;
        }
        ui.results = j.results; renderList();
        /* An external search (the Scene page's quick bar) gets the same
           results the list just got, once. It plays through play() below,
           so the compatibility gate in change() sees them as known. */
        if(ui.externalCb){const cb=ui.externalCb;ui.externalCb=null;try{cb(j.results.slice());}catch(e){}}
        if(ui.pendingScene){const found=j.results.find(s=>s.sceneId===ui.pendingScene.sceneId);ui.pendingScene=null;if(found)change(found);else toast('That scene does not fit the current actors and furniture.',false);}
      }
      return true;
    }
    if (key === 'result') {
      if (j) window.dispatchEvent(new CustomEvent('hd-ostim-result', { detail: j }));
      if (ui.navCb) { const cb = ui.navCb; ui.navCb = null; try { cb(j || {}); } catch (e) {} }
      if (j && typeof j === 'object') {
        if (typeof j.speed === 'number') { state.speed = j.speed; if (typeof j.maxSpeed === 'number') state.maxSpeed = j.maxSpeed; renderStatus(); }
        if (typeof j.auto === 'boolean') { state.auto = j.auto; renderStatus(); }
        if (j.msg) toast(esc(j.msg), j.ok !== false);
      }
      schedulePoll(700);
      return true;
    }
    return false;
  }

  function chain(name, key) {
    const prev = window[name];
    window[name] = function (info) {
      if (receive(key, info)) return;
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
    window[name].__osReceiver = true;
  }

  /* ========================================================= mode / show == */

  function setMode(mode) {
    // Three-way seg row: entering EITHER of our modes vacates the ZaZ body
    // first (zaz-pane.js's setMode('zaz') calls us with 'poses' before taking
    // the pane, so this can never recurse).
    if (window.ZazPane && typeof ZazPane.leave === 'function') ZazPane.leave();
    ui.mode = (mode === 'ostim') ? 'ostim' : 'poses';
    const pane = $('an-pane');
    if (pane) pane.classList.toggle('mode-ostim', ui.mode === 'ostim');
    if (els.segPoses) els.segPoses.classList.toggle('active', ui.mode === 'poses');
    if (els.segOstim) els.segOstim.classList.toggle('active', ui.mode === 'ostim');
    // take the outgoing segment's toast with us (see hideToast)
    if (ui.mode === 'ostim') { if (window.AnimPane && AnimPane.hideToast) AnimPane.hideToast(); }
    else hideToast();
    if (ui.mode === 'ostim') { if (window.AnimPane) AnimPane.ensureSceneFavorites(); toGame('osGet'); startPoll(); if (els.search) els.search.focus(); }
    else { stopPoll(); }
  }

  /* Smart landing (Rober, 2026-08-08: "if I'm in a scene and hit F7 on an NPC,
     jump to the OStim tab"). Switch to the Animations tab, ask C++ for live scene
     state, and pick the segment: OStim while a scene runs, Poses otherwise. */
  function smartLand() {
    init();
    if (window.__omniSetTab) window.__omniSetTab('anim');
    else if (window.setTab) window.setTab('anim');
    if (ostimGatedOut()) { setMode('poses'); return; }   // OStim off → don't land on a hidden segment
    ui.pendingSmart = true;
    toGame('osGet');   // its osOpen reply resolves the segment (receive 'open')
  }

  /* Give the OStim seg button a small brand icon left of its "OStim" label
     (Rober, 2026-08-14). The button markup lives in index.html (static), so the
     icon + its styling are injected from here at init. The seg-row base styles
     live in the shared app.css; this only adds the OStim-icon-specific rules,
     scoped to #an-seg-ostim, via a one-time injected <style> so no shared sheet
     is touched. The logo is a full-colour gradient on transparent — a subtle
     dark rounded plate helps it read on the dark seg row without recolouring. */
  function decorateOstimSeg() {
    const btn = els.segOstim;
    if (!btn || btn.querySelector('.an-seg-ostim-ico')) return;

    if (!document.getElementById('an-seg-ostim-style')) {
      const st = document.createElement('style');
      st.id = 'an-seg-ostim-style';
      st.textContent =
        '#an-seg-ostim{display:inline-flex;align-items:center;gap:7px;}' +
        '#an-seg-ostim .an-seg-ostim-ico{' +
          'width:18px;height:18px;flex:0 0 18px;border-radius:5px;' +
          'object-fit:contain;display:block;padding:1px;' +
          'background:rgba(20,18,14,.55);' +
          'box-shadow:0 0 0 1px rgba(201,162,75,.22) inset;' +
        '}' +
        /* on the active (gold) segment the dark plate would fight the fill — */
        /* drop it so the logo sits clean on gold. */
        '#an-seg-ostim.active .an-seg-ostim-ico{' +
          'background:rgba(255,255,255,.65);' +
          'box-shadow:0 0 0 1px rgba(20,18,14,.18) inset;' +
        '}';
      document.head.appendChild(st);
    }

    const img = document.createElement('img');
    img.className = 'an-seg-ostim-ico';
    img.src = 'icons/custom/seg-ostim.png';   // plain path — Ultralight eats ?v=
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    // a broken/missing icon must not leave a dead box beside the label
    img.addEventListener('error', () => { img.remove(); });
    btn.insertBefore(img, btn.firstChild);
  }

  function init() {
    if (ui.inited) return true;
    if (!$('os-body')) { console.log('[ostim] #os-body missing — fragment not pasted?'); return false; }
    ui.inited = true;

    els.body = $('os-body');
    els.scene = $('os-scene');
    els.sceneHint = $('os-scene-hint');
    els.actors = $('os-actors');
    els.speedVal = $('os-speed-val');
    els.auto = $('os-auto');
    els.swap = $('os-swap');
    els.search = $('os-search');
    els.count = $('os-count');
    els.list = $('os-list');
    els.toast = $('os-toast');
    els.segPoses = $('an-seg-poses');
    els.segOstim = $('an-seg-ostim');
    decorateOstimSeg();

    // live controls
    const b = (id) => $(id);
    els.ctlButtons = [b('os-speed-down'), b('os-speed-up'), els.auto, b('os-furn-near'), b('os-furn-floor'), els.swap].filter(Boolean);
    b('os-speed-down') && b('os-speed-down').addEventListener('click', () => nudgeSpeed('-'));
    b('os-speed-up') && b('os-speed-up').addEventListener('click', () => nudgeSpeed('+'));
    els.auto && els.auto.addEventListener('click', toggleAuto);
    els.swap && els.swap.addEventListener('click', swapRoles);
    b('os-furn-near') && b('os-furn-near').addEventListener('click', () => setFurniture('nearby'));
    b('os-furn-floor') && b('os-furn-floor').addEventListener('click', () => setFurniture('floor'));

    els.search.addEventListener('input', () => {
      ui.pendingScene=null;ui.query = els.search.value || '';
      clearTimeout(ui.searchT);
      ui.searchT = setTimeout(doSearch, SEARCH_DEBOUNCE);
    });
    els.search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const first = els.list.firstElementChild;
        if (first && first.classList.contains('os-group') && first.querySelector('.os-group-body').hidden) {
          first.querySelector('.os-group-toggle').click(); return;
        }
        const top = Array.from(els.list.querySelectorAll('.os-go')).find((b) => {
          const group = b.closest('.os-group-body'); return !b.disabled && (!group || !group.hidden);
        });
        if (top) top.click();
      }
    });

    // segmented toggle
    els.segPoses && els.segPoses.addEventListener('click', () => setMode('poses'));
    els.segOstim && els.segOstim.addEventListener('click', () => setMode('ostim'));

    chain('osOpen', 'open');
    chain('osState', 'state');
    chain('osList', 'list');
    chain('osResult', 'result');

    if (SELFTEST) setTimeout(selftest, 60);
    return true;
  }

  /* OStim detected-absent (explicit false only) off app.js's shared-scope
     `state.detected.ostim` — the 2026-08-12 sweep flag. When OStim is off the
     whole "OStim" segment of the Animations tab is hidden ("if someone doesn't
     have a supported mod it shouldn't show up"), not shown as a dead
     "OStim not detected" panel. Unknown/older host → segment stays. This is a
     stronger, install-time gate than state.ostim (the LIVE Thread-API probe),
     which still drives the in-scene messaging when the segment IS shown. */
  function ostimGatedOut() {
    /* ⚠ This IIFE has its OWN local `state` (the live scene), so read app.js's
       detection through the window accessor, never a bare `state`. */
    try {
      return (typeof window.__hdFlagAbsent === 'function') && window.__hdFlagAbsent('ostim');
    } catch (e) { return false; }
  }
  function applyOstimGate() {
    const gone = ostimGatedOut();
    /* Pre-v2 this hid the whole Poses|OStim toggle when OStim is off — a lone
       "Poses" segment button read as a broken control. The row now also hosts
       ★ Favorites + the user's custom tabs (anim-pane v2, segAlwaysOn), so it
       stays; only the OStim button + body go. The old hide survives for a
       mismatched older anim-pane.js. */
    const rowStays = !!(window.AnimPane && typeof AnimPane.segAlwaysOn === 'function' && AnimPane.segAlwaysOn());
    const seg = $('an-seg');
    if (seg) seg.classList.toggle('hidden', gone && !rowStays);
    if (els.segOstim) els.segOstim.classList.toggle('hidden', gone);
    if (els.body && gone) els.body.classList.add('hidden');
    if (gone && ui.mode === 'ostim') setMode('poses');   // never land on a hidden segment
  }

  // Called by AnimPane when the Animations tab opens / closes.
  function onAnimShow() {
    if (!init()) return;
    applyOstimGate();
    if (els.search) els.search.value = ui.query;
    if (!ostimGatedOut() && ui.mode === 'ostim') { toGame('osGet'); startPoll(); }
  }
  function onAnimHide() { ui.pendingScene=null;stopPoll(); }

  /* ============================================================ selftest == */

  function selftest() {
    const out = [];
    const ok = (name, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + name);

    // force the pane visible for measurement
    const pane = $('an-pane'); if (pane) pane.classList.remove('hidden');
    setMode('ostim');

    ok('os-body exists', !!$('os-body'));
    ok('seg switched to ostim', $('an-pane').classList.contains('mode-ostim'));
    ok('got open config', ui.gotOpen);
    ok('in-scene status shown', /Missionary/.test(els.scene.textContent));
    ok('actor chips rendered (2)', els.actors.querySelectorAll('.os-actor').length === 2);
    ok('scene rows rendered', els.list.querySelectorAll('.os-row').length >= 6);
    ok('a 3p scene is incompatible', !!els.list.querySelector('.os-row.incompat'));
    ok('incompatible go-button disabled', els.list.querySelector('.os-row.incompat .os-go').disabled === true);
    ok('top compatible row marked', !!els.list.querySelector('.os-row.top'));
    ok('speed readout shows 1 / 3', /1 \/ 3/.test(els.speedVal.textContent));
    ok('swap enabled (2 actors)', els.swap.disabled === false);

    // search narrows via C++ (dev bridge)
    els.search.value = 'cow'; els.search.dispatchEvent(new Event('input'));
    // wait for debounce+dev reply
    setTimeout(() => {
      ok('search narrows to Cowgirl', /Cowgirl/.test(els.list.textContent) && els.list.querySelectorAll('.os-row').length === 1);

      // change the scene (top hit)
      els.search.value = 'behind'; els.search.dispatchEvent(new Event('input'));
      setTimeout(() => {
        const first = rows()[0];
        change(first);
        ok('change toasts', els.toast.classList.contains('show'));

        // furniture + swap fire without throwing
        $('os-furn-near').click(); ok('furniture button fires', true);
        els.swap.click(); ok('swap button fires', true);

        // out-of-scene state greys the go buttons
        applyState(devState(false)); ui.results = null; renderStatus(); renderList();
        ok('out-of-scene shows Not in a scene', /Not in a scene/.test(els.scene.textContent));
        ok('out-of-scene go buttons say Start', /Start/.test(els.list.textContent));

        ok('receivers tagged', window.osOpen.__osReceiver === true && window.osResult.__osReceiver === true);
        ok('no receiver on a REQUEST name', typeof window.osGet !== 'function' || window.osGet.__osReceiver !== true);

        // restore
        applyState(devState(true)); ui.results = null; renderStatus(); renderList();

        const fails = out.filter((l) => l.indexOf('FAIL') === 0);
        const box = document.createElement('pre');
        box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
          'background:#111;color:#ddd;padding:10px;border:1px solid ' +
          (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
        box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
        document.body.append(box);
        console.log(out.join('\n'));
      }, 60);
    }, 60);
  }

  /* Land ON the OStim segment. smartLand() decides which segment fits the live
     state; this is the explicit "show me OStim" a player just typed, so it goes
     there whether or not a scene is running. */
  function openSegment() {
    if (!init()) return;
    if (ostimGatedOut()) return;   // never land on a hidden segment
    if (window.__omniSetTab) window.__omniSetTab('anim');
    else if (window.setTab) window.setTab('anim');
    setMode('ostim');
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'ostim', label: 'OStim scenes', tab: 'anim',
    setFilter: function (q) {
      setMode('ostim');
      ui.query = q || ''; if (els.search) els.search.value = ui.query; doSearch();
    },
    index: function () {
      // OStim absent (install-time gate) → no rows at all (2026-08-12 sweep).
      if (ostimGatedOut()) return [];
      const items = [];
      /* Typing "ostim" has to find OStim. This pane's nav label is
         "Animations", so before this row a player naming one of the deck's
         advertised integrations matched nothing anywhere in the deck whenever a
         scene wasn't running — which is most of the time. */
      items.push({
        label: 'OStim scenes',
        detail: state.inScene
          ? 'In a scene · ' + (state.sceneName || state.scene || 'running') + ' — search and change it'
          : 'Animations tab · start a scene, then change it from here',
        kind: 'ostim',
        keywords: 'ostim osa scene sex animation search change segment tab',
        run: openSegment,
      });

      /* Everything below drives a RUNNING scene — OStim's thread API has
         nothing to act on otherwise, and the pane's own buttons are disabled
         for the same reason. */
      if (!state.inScene) return items;

      if (state.canSwap) items.push({
        label: '⇄ Swap roles',
        detail: 'OStim · reverse DOM / SUB in the current scene',
        kind: 'ostim',
        keywords: 'ostim swap roles dom sub reverse switch positions actors',
        run: swapRoles,
      });
      items.push({
        label: 'Move scene / furniture',
        detail: 'OStim · move the scene onto the nearest bed or furniture',
        kind: 'ostim',
        keywords: 'ostim furniture bed nearby move scene onto switch',
        jump: function () { setFurniture('nearby'); },
      });
      items.push({
        label: '⌞ Furniture: floor',
        detail: 'OStim · put the scene back on the floor',
        kind: 'ostim',
        keywords: 'ostim furniture floor ground off bed move scene',
        run: function () { setFurniture('floor'); },
      });
      items.push({
        label: 'Speed up',
        detail: 'OStim · speed ' + state.speed + ' / ' + state.maxSpeed,
        kind: 'ostim',
        keywords: 'ostim speed faster quicker harder pace increase',
        run: function () { nudgeSpeed('+'); },
      });
      items.push({
        label: 'Speed down',
        detail: 'OStim · speed ' + state.speed + ' / ' + state.maxSpeed,
        kind: 'ostim',
        keywords: 'ostim speed slower gentler pace decrease',
        run: function () { nudgeSpeed('-'); },
      });
      /* ⟳ Auto is deliberately NOT here: osAuto only READS OStim's auto-mode
         (the Thread API has no write — see ostim_deck.cpp ToggleAuto), so a
         search row named "turn auto on" would promise a toggle nothing
         performs. It comes back when the Scene API lands. */

      for (const s of rows()) {
        if (s.compatible === false) continue;
        items.push({
          label: s.name || s.sceneId,
          detail: 'OStim scene · ' + (s.actorCount || '?') + 'p',
          kind: 'ostim',
          keywords: 'ostim scene animation ' + s.sceneId,
          run: function () { change(s); },
        });
      }
      return items;
    },
  });

  window.addEventListener('hd-animation-user-changed', () => { if (ui.inited) renderList(); });
  window.addEventListener('hd-position-art-changed', () => { if (ui.inited) renderList(); });

  return {
    init, onAnimShow, onAnimHide, setMode, smartLand, hideToast,
    openFavorites() {
      init(); ui.favoriteMode = true; ui.query = ''; ui.results = null; if (els.search) els.search.value = '';
      if (window.__omniSetTab) window.__omniSetTab('anim');
      setMode('ostim'); renderList();
    },
    /* Hand a raw query to this browser and land on it. The Scene page's
       quick scene bar uses it so that page never grows a scene index of its
       own (Rober, 2026-09-22: "add a quick scene bar as well that you type
       into and popups up your search for animations"). */
    /* Search WITHOUT touching this pane's UI or the deck's tabs: the Scene
       page's quick bar paints the results itself. cb(results) fires once. */
    search(query, cb) {
      const q=String(query||'').trim();if(!q){if(cb)cb([]);return;}
      init();ui.pendingScene=null;ui.favoriteMode=false;ui.query=q;ui.externalCb=cb||null;ui.synShown='';ui.synFor='';
      sendSearch(q);
    },
    /* Play from OUTSIDE this pane (the Scene page's quick bar). change() is
       gated on this pane's own state.inScene, which is stale whenever the
       Animations tab has not been opened during the running scene - so a
       click from the Scene page did nothing at all (Rober, 2026-09-22: "on
       click of dropdown its also not changing animation at all"). The DLL
       validates the thread and the fit; cb(result) gets its answer once. */
    play(s, cb) {
      if (!s || !s.sceneId) { if (cb) cb({ ok: false, msg: 'No scene' }); return; }
      ui.navCb = cb || null;
      toGame('osNav', s.sceneId);
      glog('play ' + s.sceneId);
    },
    searchFor(query) {
      ui.externalCb = null; ui.navCb = null;   // the quick bar handed over; nothing of its stays pending
      const q=String(query||'').trim();if(!q)return;
      init();ui.favoriteMode=false;ui.query=q;ui.pendingScene=null;ui.results=[];
      if(els.search)els.search.value=q;
      if(window.__omniSetTab)window.__omniSetTab('anim');
      setMode('ostim');sendSearch(q);renderList();
    },
    findScene(s) {
      if(!s||!s.sceneId)return;init();ui.favoriteMode=false;ui.query=s.name||s.sceneId;ui.pendingScene=s;ui.results=[];
      if(els.search)els.search.value=ui.query;if(window.__omniSetTab)window.__omniSetTab('anim');setMode('ostim');sendSearch(ui.query);renderList();
    },
    previousScene(currentId) {
      const recent=window.AnimPane?AnimPane.sceneLibrary().recent:[];const previous=recent.find(s=>s.sceneId!==(currentId||state.scene));
      if(previous)this.findScene(previous);else toast('No previous scene recorded yet.',false);
    },
    _state: state, _ui: ui   // test hooks only
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.OStimPane.init());
} else {
  window.OStimPane.init();
}
