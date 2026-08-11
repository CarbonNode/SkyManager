'use strict';

/* ====================================================================== *
 *  Deck Portal button — opens the portal's web UI in this PC's browser.
 *
 *  Rober's design (2026-08-11): the portal is a LOCAL server that boots with
 *  the DLL, and SkyManager gets a button that opens it. No phone pairing, no
 *  QR, no password — 127.0.0.1 means the only thing that can reach it is the
 *  machine you are already sitting at.
 *
 *  Bridge, one name per direction (the deck law):
 *      JS -> C++   ptGet() · ptOpen()
 *      C++ -> JS   ptState({ ok, running, ours, url, node, reason })
 *
 *  THE BUTTON IS HIDDEN UNTIL IT CAN WORK. Node is a documented requirement
 *  rather than a bundled runtime, so plenty of installs will not have it —
 *  and a visible button that silently does nothing is worse than no button.
 *  When Node is present but the server is down, the button stays visible and
 *  says why, because that one is fixable from here (pressing it starts it).
 *
 *  Own tiny sheet-free footprint: it reuses .ghost-btn, so there is no CSS
 *  file to keep in sync.
 * ====================================================================== */

(function () {

  const S = { data: null, asked: false };

  function btn() { return document.getElementById('portal-btn'); }

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

  function apply() {
    const b = btn();
    if (!b) return;
    const d = S.data;

    // No answer yet, or Node genuinely absent: show nothing at all.
    if (!d || !d.node) { b.classList.add('hidden'); return; }

    b.classList.remove('hidden');
    b.classList.toggle('on', !!d.running);
    b.setAttribute('title', d.running
      ? 'Open the Deck Portal in your browser  ·  ' + (d.url || '')
        + '\nUpload portraits and icons, edit hotkeys and followers with a real keyboard.'
      : 'Start the Deck Portal and open it in your browser'
        + (d.reason ? '\n' + d.reason : ''));
  }

  window.ptState = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    const wasRunning = S.data && S.data.running;
    S.data = d;
    apply();
    // Only speak up when the press could not do what it promised. A working
    // press is self-evident: a browser window appears.
    if (!d.running && d.reason && wasRunning !== undefined && S.asked) say(d.reason);
  };

  function press() {
    S.asked = true;
    const d = S.data;
    if (d && !d.node) { say(d.reason || 'Node.js isn’t installed — the portal needs it.'); return; }
    say('Opening the Deck Portal…');
    toGame('ptOpen', '');
  }

  function boot() {
    const b = btn();
    if (!b) { setTimeout(boot, 120); return; }
    b.addEventListener('click', press);
    apply();
    // Ask once at load and again whenever the deck opens: the server can die
    // (or be started by hand) between openings, and a stale "running" would
    // make the button lie.
    toGame('ptGet', '');
    const prev = window.hdOpen;
    window.hdOpen = function () {
      const r = typeof prev === 'function' ? prev.apply(this, arguments) : undefined;
      toGame('ptGet', '');
      return r;
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.HDPortal = { state: function () { return S; }, _apply: apply, _press: press };
})();
