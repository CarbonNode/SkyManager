/* md-textinput.js — engine text-entry guard (Spell Deck / MagicDeck view side)
 *
 * Twin of the deck view's hd-textinput.js. PrismaUI webviews never raise
 * Skyrim's global text-entry refcount, so the Spell Deck's search box leaks
 * typed letters as other mods' global hotkeys exactly as the deck's did
 * (Nexus, IAMTOKKO). This tells C++ (the shared hdTextInput bridge, registered
 * on this view too) to raise the refcount while a text field is focused and
 * release when it is not. C++ owns a balance counter and force-releases on
 * palette close / save load / view crash, so the guard can never leak — that
 * failsafe is what makes this shippable.
 *
 * Coalesced 100 ms so tabbing input->input doesn't thrash the engine. Sends the
 * SAME global (window.hdTextInput) as the deck view — it is one global engine
 * refcount, so which view raised it is irrelevant. Loaded after app.js.
 */
(function () {
  'use strict';

  if (window.__mdTextInputGuardInstalled) return;
  window.__mdTextInputGuardInstalled = true;

  var COALESCE_MS = 100;

  var sent = false;
  var wantOn = false;
  var timer = null;

  function isTextTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      switch (t) {
        case 'text': case 'search': case 'password': case 'email':
        case 'url': case 'tel': case 'number':
          return true;
        default:
          return false;
      }
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function send(on) {
    if (on === sent) return;
    sent = on;
    try {
      if (typeof window.hdTextInput === 'function') {
        window.hdTextInput(on ? '1' : '0');
      } else if (typeof window.toGame === 'function') {
        window.toGame('hdTextInput', on ? '1' : '0');
      }
    } catch (e) {
      /* bridge missing (dev preview) — nothing to do */
    }
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(function () {
      timer = null;
      send(wantOn);
    }, COALESCE_MS);
  }

  document.addEventListener('focusin', function (e) {
    if (isTextTarget(e.target)) {
      wantOn = true;
      schedule();
    }
  }, true);

  document.addEventListener('focusout', function (e) {
    if (!isTextTarget(e.relatedTarget)) {
      wantOn = false;
      schedule();
    }
  }, true);

  // The Spell Deck's app.js toggles a body class on close; observe it going
  // away and release immediately, so a field focused at close still reports out
  // from the view side. The C++ failsafe (CloseMagicPalette drains all raises)
  // is the real guarantee; this keeps the signal honest and is cheap.
  try {
    if (window.MutationObserver && document.body) {
      var mo = new MutationObserver(function () {
        if (wantOn && !document.body.classList.contains('open')) {
          wantOn = false;
          send(false);
          if (timer !== null) { clearTimeout(timer); timer = null; }
        }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) { /* C++ failsafe covers it */ }

  window.__mdTextInput = {
    isTextTarget: isTextTarget,
    coalesceMs: COALESCE_MS,
    _state: function () { return { sent: sent, wantOn: wantOn, pending: timer !== null }; }
  };
})();
