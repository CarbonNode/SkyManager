/* auto-photo.js — real in-game face photos, taken by themselves (2026-10-12).
 *
 * Rober: "can it just be smarter and more dynamic??" — the MRF head renders are
 * an imitation of the game's renderer and some faces come out wrong (Sol's white
 * eyes, untinted hair). A photo of the game's own frame is right by construction.
 *
 * The view's part is small on purpose; C++ (src/auto_portrait.cpp) decides WHO:
 *   1. after the deck's portraits land (fdPortraits, pushed every open after the
 *      first paint) and the roster is in, name everyone the deck draws a face for:
 *        fdAutoPhoto {op:"consider", people:[{id, slug, name}]}
 *      C++ keeps the loaded, nearby people with no photo of their own (a photo
 *      the player took is never replaced), at most two, nearest first.
 *   2. fdAutoPhotoStart {names} -> the deck steps out of the frame (body class
 *      ap-shooting: visibility, never display:none — the open-warm law), and two
 *      frames later says so: fdAutoPhoto {op:"go"}.
 *   3. C++ aims the free camera at each face, waits for a steady frame, saves it
 *      as a normal portrait, puts everything back, pushes fdPortraits (so every
 *      surface repaints with the photo) and fdAutoPhotoDone {taken, failed, why}.
 *   4. the deck comes back and a toast names who was photographed.
 * A 6 s guard un-hides the deck even if C++ never answers.
 */
(function () {
  'use strict';

  var CONSIDER_DELAY = 1200;   // let the roster slice land after fdPortraits
  var HIDE_GUARD     = 6000;   // never leave the deck invisible longer than this
  var consideredOpen = false;  // one consider per deck open
  var timer = null, guard = null;

  function send(op, extra) {
    var msg = { op: op };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    if (typeof window.toGame === 'function') window.toGame('fdAutoPhoto', JSON.stringify(msg));
  }

  function toast(msg) { if (typeof window.toast === 'function') window.toast(msg); }

  function deckOpen() {
    var b = document.body;
    return !!(b && b.classList && b.classList.contains('open'));
  }

  /* Anything already owning the camera or the frame: the live view, a photo
     session, an OStim scene page. Auto photos wait for a quieter open. */
  function frameBusy() {
    var b = document.body;
    if (!b || !b.classList) return true;
    return b.classList.contains('pn-live-on') || b.classList.contains('ap-shooting');
  }

  function people() {
    try {
      return (window.FolPane && typeof FolPane.autoPhotoPeople === 'function') ? FolPane.autoPhotoPeople() : [];
    } catch (e) { return []; }
  }

  function consider() {
    timer = null;
    if (consideredOpen || !deckOpen() || frameBusy()) return;
    var list = people();
    if (!list.length) return;
    consideredOpen = true;
    send('consider', { people: list });
  }

  function schedule() {
    if (consideredOpen || timer) return;
    timer = setTimeout(consider, CONSIDER_DELAY);
  }

  function show() {
    if (guard) { clearTimeout(guard); guard = null; }
    if (document.body && document.body.classList) document.body.classList.remove('ap-shooting');
  }

  window.fdAutoPhotoStart = function (env) {
    if (!deckOpen()) { show(); return; }
    document.body.classList.add('ap-shooting');
    if (guard) clearTimeout(guard);
    guard = setTimeout(show, HIDE_GUARD);
    /* Two frames: the class has been styled AND painted before C++ grabs. */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        /* Closed (or un-hidden by the guard) in between: never send a stale go —
           C++ would take the camera with the deck gone. Its own 4 s wait for go
           stands the round down. */
        if (deckOpen() && document.body.classList.contains('ap-shooting')) send('go');
      });
    });
  };

  window.fdAutoPhotoDone = function (env) {
    show();
    var taken = (env && env.taken) || [];
    if (taken.length) {
      var names = taken.map(function (t) { return t.name || t.slug; });
      toast('New photo' + (names.length > 1 ? 's' : '') + ': ' + names.join(', '));
    }
  };

  window.fdAutoPhotoState = function (env) {
    window.__hdAutoPhotoEnabled = !(env && env.enabled === false);
  };

  /* fdPortraits arrives on every open (a deferred slice) and after every photo.
     Chain it — followers-pane and wardrobe-nff own receivers too. */
  var prevPortraits = window.fdPortraits;
  window.fdPortraits = function (list) {
    if (typeof prevPortraits === 'function') prevPortraits.apply(this, arguments);
    schedule();
  };

  /* A new open is a new chance; a close cancels a pending ask and un-hides. */
  var prevOpen = window.hdOpen;
  window.hdOpen = function () {
    consideredOpen = false;
    return typeof prevOpen === 'function' ? prevOpen.apply(this, arguments) : undefined;
  };
  var prevClosed = window.hdClosed;
  window.hdClosed = function () {
    if (timer) { clearTimeout(timer); timer = null; }
    show();
    return typeof prevClosed === 'function' ? prevClosed.apply(this, arguments) : undefined;
  };

  /* The deck steps out of the picture; visibility only (the open-warm law:
     display:none on the deck throws its layout away). */
  (function style() {
    var css = 'body.ap-shooting > * { visibility: hidden !important; }';
    var el = document.createElement('style');
    el.setAttribute('id', 'ap-style');
    el.textContent = css;
    (document.head || document.body).appendChild(el);
  })();

  window.HDAutoPhoto = {
    consider: consider,
    _reset: function () { consideredOpen = false; if (timer) { clearTimeout(timer); timer = null; } show(); },
    _considered: function () { return consideredOpen; }
  };
})();
