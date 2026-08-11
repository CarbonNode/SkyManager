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
  function rows() { return (ui.results !== null) ? ui.results : state.scenes; }

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
    const list = rows();
    const inS = state.inScene;
    els.count.textContent = list.length + (list.length === 1 ? ' scene' : ' scenes');
    els.list.textContent = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'os-empty';
      empty.textContent = !inS
        ? 'Start an OStim scene first — then search here to change it.'
        : (ui.query
            ? 'No scene name matches “' + ui.query + '” for the current furniture & actors. '
              + 'OStim searches scene NAMES — try a word like “behind”, “cowgirl” or “kiss”.'
            : (state.ostim ? 'No scenes for this furniture & actor count.' : 'OStim isn’t reporting any scenes.'));
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

    const shown = Math.min(list.length, RENDER_CAP);
    for (let i = 0; i < shown; i++) {
      const s = list[i];
      // OStim's SearchScenes already returns ONLY scenes that fit the running
      // thread (matching actor count + furniture), so every listed scene is a
      // valid target. Its SceneSearchResult.actorCount is unreliable (often 0),
      // so don't gate on it — being in a scene is the whole test.
      const compatible = inS;
      const acN = s.actorCount || state.actorCount || 0;   // result count is often 0; fall back to the live count
      const row = document.createElement('div');
      row.className = 'os-row' + (compatible ? '' : ' incompat') + (i === 0 && compatible ? ' top' : '');

      const main = document.createElement('div');
      main.className = 'os-row-main';
      const name = document.createElement('div');
      name.className = 'os-row-name';
      name.textContent = s.name || s.sceneId;
      name.title = s.sceneId;
      const meta = document.createElement('div');
      meta.className = 'os-row-meta';
      meta.textContent = (acN ? acN + 'p' : s.sceneId);
      main.append(name, meta);
      row.append(main);

      const btn = document.createElement('button');
      btn.className = 'os-go';
      if (!inS) {
        btn.disabled = true;
        btn.textContent = 'Start';
        btn.title = 'Starting a fresh scene is coming soon — for now, change scenes while one is running';
      } else if (!compatible) {
        btn.disabled = true;
        btn.textContent = s.actorCount + 'p';
        btn.title = 'This scene needs ' + s.actorCount + ' actors; the current scene has ' + state.actorCount;
      } else {
        btn.textContent = 'Change';
        btn.title = 'Change the current scene to “' + (s.name || s.sceneId) + '”';
        btn.addEventListener('click', () => change(s));
      }
      row.append(btn);

      if (inS && compatible) row.addEventListener('click', (ev) => { if (ev.target !== btn) change(s); });
      els.list.append(row);
    }

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

  /* =========================================================== actions == */

  function change(s) {
    if (!s || !state.inScene) return;
    // No compatibility gate: OStim already filtered the list to scenes that fit
    // the running thread. (Its per-result actorCount is unreliable — often 0.)
    toGame('osNav', s.sceneId);
    toast('▸ ' + (s.name || s.sceneId), true);   // optimistic; osResult confirms
    glog('change ' + s.sceneId);
    schedulePoll(700);
  }

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
      }
      return true;
    }
    if (key === 'result') {
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
    ui.mode = (mode === 'ostim') ? 'ostim' : 'poses';
    const pane = $('an-pane');
    if (pane) pane.classList.toggle('mode-ostim', ui.mode === 'ostim');
    if (els.segPoses) els.segPoses.classList.toggle('active', ui.mode === 'poses');
    if (els.segOstim) els.segOstim.classList.toggle('active', ui.mode === 'ostim');
    if (ui.mode === 'ostim') { toGame('osGet'); startPoll(); if (els.search) els.search.focus(); }
    else { stopPoll(); }
  }

  /* Smart landing (Rober, 2026-08-08: "if I'm in a scene and hit F7 on an NPC,
     jump to the OStim tab"). Switch to the Animations tab, ask C++ for live scene
     state, and pick the segment: OStim while a scene runs, Poses otherwise. */
  function smartLand() {
    init();
    if (window.__omniSetTab) window.__omniSetTab('anim');
    else if (window.setTab) window.setTab('anim');
    ui.pendingSmart = true;
    toGame('osGet');   // its osOpen reply resolves the segment (receive 'open')
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

    // live controls
    const b = (id) => $(id);
    els.ctlButtons = [b('os-speed-down'), b('os-speed-up'), els.auto, b('os-furn-near'), b('os-furn-floor'), els.swap].filter(Boolean);
    b('os-speed-down') && b('os-speed-down').addEventListener('click', () => toGame('osSpeed', '-'));
    b('os-speed-up') && b('os-speed-up').addEventListener('click', () => toGame('osSpeed', '+'));
    els.auto && els.auto.addEventListener('click', () => toGame('osAuto'));
    els.swap && els.swap.addEventListener('click', () => { toGame('osSwap'); toast('swapping…', true); schedulePoll(1000); });
    b('os-furn-near') && b('os-furn-near').addEventListener('click', () => toGame('osFurn', 'nearby'));
    b('os-furn-floor') && b('os-furn-floor').addEventListener('click', () => toGame('osFurn', 'floor'));

    els.search.addEventListener('input', () => {
      ui.query = els.search.value || '';
      clearTimeout(ui.searchT);
      ui.searchT = setTimeout(doSearch, SEARCH_DEBOUNCE);
    });
    els.search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const list = state.inScene ? rows() : [];   // all listed scenes are OStim-filtered = valid
        if (list.length) change(list[0]);   // Enter = top compatible hit (deck idiom)
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

  // Called by AnimPane when the Animations tab opens / closes.
  function onAnimShow() {
    if (!init()) return;
    if (els.search) els.search.value = ui.query;
    if (ui.mode === 'ostim') { toGame('osGet'); startPoll(); }
  }
  function onAnimHide() { stopPoll(); }

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

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'ostim', label: 'OStim scenes', tab: 'anim',
    setFilter: function (q) {
      setMode('ostim');
      ui.query = q || ''; if (els.search) els.search.value = ui.query; doSearch();
    },
    index: function () {
      // Only meaningful while a scene is running (Omni changes the live scene).
      if (!state.inScene) return [];
      const items = [];
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

  return {
    init, onAnimShow, onAnimHide, setMode, smartLand,
    _state: state, _ui: ui   // test hooks only
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.OStimPane.init());
} else {
  window.OStimPane.init();
}
