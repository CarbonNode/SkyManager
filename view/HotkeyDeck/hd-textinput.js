/* hd-textinput.js — engine text-entry guard (deck view side)
 *
 * WHY: PrismaUI webviews never raise Skyrim's global text-entry refcount
 * (RE::ControlMap textEntryCount). Well-behaved hotkey mods — OBody, and
 * everything on MCM Helper / SkyUI idioms — skip their letter hotkeys while
 * IsTextEntryEnabled is true, which is why typing in SkyUI's inventory search
 * never fires them. Our search boxes did not raise it, so typing "O" in the
 * deck's search box opened OBody's menu over the deck (Nexus, IAMTOKKO).
 *
 * WHAT: one delegated focusin/focusout listener on document. When focus enters
 * a text field we tell C++ to raise the refcount (hdTextInput "1"); when it
 * leaves text entry entirely we tell it to release ("0"). C++ holds an OWN
 * balance counter and force-releases everything on palette close / save load /
 * view crash, so a stuck flag (which would eat every hotkey game-wide) cannot
 * survive — the C++ failsafe is what makes this shippable; this side is the
 * cooperative signal.
 *
 * The flip is coalesced (100 ms): tabbing from one input to another would
 * otherwise fire focusout("0") then focusin("1") every hop, briefly dropping
 * the guard and thrashing the engine. We only send a change when the desired
 * state actually differs from what we last sent after the window settles.
 *
 * Self-contained: it calls the PrismaUI-installed global window.hdTextInput
 * directly (each JS listener C++ registers becomes a global of that name), so
 * it does not depend on app.js internals. Loaded after app.js in index.html.
 */
(function () {
  'use strict';

  // Guard against a double-load (both views share the file name is fine; a
  // second <script> in one document would double-bind document listeners).
  if (window.__hdTextInputGuardInstalled) return;
  window.__hdTextInputGuardInstalled = true;

  var COALESCE_MS = 100;

  // What C++ currently believes (the last value we actually sent). null = never
  // sent, treated as "0" (down) so the first raise always transmits.
  var sent = false;
  // Where focus is right now, updated synchronously on every focus event.
  var wantOn = false;
  var timer = null;

  function isTextTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      // Only real text-entry input types raise the guard. A checkbox/radio/
      // button/range does not accept typed characters, so guarding on it would
      // needlessly suppress hotkeys while it is focused.
      var t = (el.type || 'text').toLowerCase();
      switch (t) {
        case 'text': case 'search': case 'password': case 'email':
        case 'url': case 'tel': case 'number':
          return true;
        default:
          return false;
      }
    }
    // contenteditable (isContentEditable also true for descendants of a CE root)
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
        // Fallback to the app.js bridge helper if the raw global isn't present
        // yet; harmless in the browser preview (logs instead of calling C++).
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

  // focusin/focusout bubble (unlike focus/blur), so one pair of delegated
  // listeners on document catches every field, including ones added later.
  document.addEventListener('focusin', function (e) {
    if (isTextTarget(e.target)) {
      wantOn = true;
      schedule();
    }
  }, true);

  document.addEventListener('focusout', function (e) {
    // relatedTarget is where focus is GOING. If it is another text field, the
    // coalesce window will keep wantOn true and no change is sent — the whole
    // point. If focus leaves to a non-input (or nowhere), release.
    var to = e.relatedTarget;
    if (!isTextTarget(to)) {
      wantOn = false;
      schedule();
    }
  }, true);

  // Belt-and-braces view-close hook: app.js clears document.body's 'open' class
  // on every route out of the palette. If a field was focused when the palette
  // closes, focusout may not fire — observe the class going away and release.
  // (The C++ failsafe also covers this; this just makes the signal honest from
  // the view side too, and is cheap.)
  try {
    if (window.MutationObserver && document.body) {
      var mo = new MutationObserver(function () {
        if (wantOn && !document.body.classList.contains('open')) {
          wantOn = false;
          send(false); // immediate on close — no reason to coalesce a teardown
          if (timer !== null) { clearTimeout(timer); timer = null; }
        }
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) { /* body not ready / no MutationObserver — C++ failsafe covers it */ }

  // Expose for the harness to drive without a real bridge.
  window.__hdTextInput = {
    isTextTarget: isTextTarget,
    coalesceMs: COALESCE_MS,
    _state: function () { return { sent: sent, wantOn: wantOn, pending: timer !== null }; }
  };
})();
