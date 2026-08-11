'use strict';

/* ====================================================================== *
 *  Quick Light card — a live On/Off control for Quick Light SE, shown above
 *  the hotkey list while the Hotkeys "Utilities" category is selected.
 *
 *  The ask (Rober, 2026-08-05): a state-aware Quick Light toggle in the deck —
 *  but NOT its own top-level tab; it belongs under Hotkeys → Utilities beside
 *  the "Quick Light" action row. So this is a CARD, mounted into a host by
 *  app.js's syncQuickLightCard() exactly like the quick-follower card. C++
 *  (quick_light.cpp) reads Quick Light's own state and calls the mod's own
 *  CastLight/RemoveLight through the Papyrus VM, so brightness / light-source
 *  stay whatever the MCM says. Nothing to persist.
 *
 *  Bridge — C++ registers these JS->C++ listeners on the deck view:
 *    qlGet() · qlOn() · qlOff() · qlToggle()
 *  C++ pushes back (names disjoint per the deck law):
 *    qlState({ok,installed,running,on}) · qlResult({ok,on,msg})
 *
 *  Host contract (mirrors FolPane.mountQuickCard): LightPane.mountCard(host) ·
 *  unmountCard(host). mountCard is called on EVERY deck render while shown, so
 *  it is idempotent — it builds DOM + starts the poll once per mount.
 * ====================================================================== */

window.LightPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const STATE_POLL = 1500;   // catch an external L-key press while the card is up

  const state = { installed: false, running: false, on: false, gotState: false };
  const ui = { host: null, built: false, chained: false, pollT: null };
  const els = {};

  const TEMPLATE =
    '<div class="ql-inner">' +
      '<button id="li-master" class="off" title="Toggle Quick Light on or off (the Quick Light row below, and any key you bind it to, do the same)">' +
        '<span id="li-glyph" aria-hidden="true">💡</span><span id="li-master-label">Quick Light</span>' +
      '</button>' +
      '<div id="li-state-wrap"><div id="li-master-state">OFF</div>' +
        '<div id="li-status" class="li-hint">Checking Quick Light…</div></div>' +
      '<div id="li-actions">' +
        '<button id="li-on" class="li-btn" disabled>Turn&nbsp;On</button>' +
        '<button id="li-off" class="li-btn" disabled>Turn&nbsp;Off</button>' +
      '</div>' +
    '</div>';

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
      return;
    }
    /* DEV fallback: no PrismaUI host, fake the game side so the harness works */
    console.log('[dev->game]', fn, arg);
    if (!DEV) return;
    if (fn === 'qlGet') {
      setTimeout(() => window.qlState(JSON.stringify(
        { ok: true, installed: true, running: true, on: state.on })), 20);
    } else if (fn === 'qlOn' || fn === 'qlOff' || fn === 'qlToggle') {
      state.on = fn === 'qlOn' ? true : fn === 'qlOff' ? false : !state.on;
      window.qlResult(JSON.stringify({ ok: true, on: state.on, msg: 'dev ' + fn }));
      window.qlState(JSON.stringify({ ok: true, installed: true, running: true, on: state.on }));
    }
  }

  /* ============================================================ render == */

  function statusText() {
    if (!state.installed) return ['Quick Light SE isn’t installed on this load order.', 'bad'];
    if (!state.running)   return ['Quick Light is turned off in its MCM — enable it there to use this.', 'warn'];
    return [state.on ? 'The light is on.' : 'The light is off.', ''];
  }

  function render() {
    if (!els.master) return;
    const usable = state.installed && state.running;

    els.master.classList.toggle('on', state.on);
    els.master.classList.toggle('off', !state.on);
    els.master.disabled = !usable;
    els.masterState.textContent = state.on ? 'ON' : 'OFF';
    els.masterState.classList.toggle('on', state.on);

    const [txt, cls] = statusText();
    els.status.textContent = txt;
    els.status.classList.toggle('warn', cls === 'warn');
    els.status.classList.toggle('bad', cls === 'bad');

    els.on.disabled = !usable || state.on;
    els.off.disabled = !usable || !state.on;
  }

  function flash(msg, bad) {
    if (!msg || !els.status) return;
    els.status.textContent = msg;
    els.status.classList.toggle('bad', !!bad);
    els.status.classList.toggle('warn', !bad);
  }

  /* ============================================================ receive == */

  function receive(key, info) {
    let j = null;
    try { j = JSON.parse(String(info || '{}')); } catch (e) { j = null; }

    if (key === 'state') {
      if (!j || !j.ok) return true;
      state.installed = !!j.installed;
      state.running = !!j.running;
      state.on = !!j.on;
      state.gotState = true;
      render();
      return true;
    }
    if (key === 'result') {
      if (j && j.ok === false && j.msg) flash(j.msg, !state.installed);
      /* a qlState always follows a result, so the real status repaints itself */
      return true;
    }
    return false;
  }

  function chainOnce() {
    if (ui.chained) return;
    ui.chained = true;
    ['qlState', 'qlResult'].forEach((name) => {
      const key = name === 'qlState' ? 'state' : 'result';
      const prev = window[name];
      window[name] = function (info) {
        if (receive(key, info)) return;
        if (typeof prev === 'function') return prev.apply(this, arguments);
      };
      window[name].__liReceiver = true;
    });
  }

  /* ============================================================ mount == */

  function bind() {
    els.master = document.getElementById('li-master');
    els.masterState = document.getElementById('li-master-state');
    els.status = document.getElementById('li-status');
    els.on = document.getElementById('li-on');
    els.off = document.getElementById('li-off');

    els.master.addEventListener('click', () => { if (!els.master.disabled) toGame('qlToggle'); });
    els.on.addEventListener('click', () => { if (!els.on.disabled) toGame('qlOn'); });
    els.off.addEventListener('click', () => { if (!els.off.disabled) toGame('qlOff'); });
  }

  function startPoll() {
    if (ui.pollT) return;
    ui.pollT = setInterval(() => { if (ui.built) toGame('qlGet'); }, STATE_POLL);
  }
  function stopPoll() { if (ui.pollT) { clearInterval(ui.pollT); ui.pollT = null; } }

  /* Idempotent: app.js calls this on every deck render while the Utilities
     category is up. Builds DOM + wires bridge + starts the poll once. */
  function mountCard(host) {
    if (!host) return;
    if (ui.host === host && ui.built) { startPoll(); return; }
    ui.host = host;
    ui.built = true;
    host.innerHTML = TEMPLATE;
    bind();
    chainOnce();
    render();
    toGame('qlGet');
    startPoll();
  }

  function unmountCard(host) {
    stopPoll();
    ui.built = false;
    ui.host = null;
    if (host) host.innerHTML = '';
    els.master = els.masterState = els.status = els.on = els.off = null;
  }

  return {
    mountCard, unmountCard,
    _state: state, _ui: ui   // test hooks only
  };
})();
