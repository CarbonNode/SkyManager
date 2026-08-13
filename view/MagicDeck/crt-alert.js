/* CRT Guard alert overlay logic.

   Bridge (C++ registers the listener; we call it through toGame):
     toGame('caDismiss')              — OK pressed → C++ Unfocuses + Hides the view

   Called BY C++ (window.* injected via Invoke):
     window.caShow(jsonStr)           — {culprit, message} → render + reveal the card
     window.caHide()                  — hide without a C++ round-trip (belt & braces)

   The view is otherwise invisible: #ca-backdrop starts with class 'ca-hidden'.
   The plugin Shows + Focuses the view (modal, game paused) right before caShow,
   so a keyboard/controller press cannot dismiss it by accident — only the button. */
(function () {
  'use strict';
  var DEV = /[?&]dev=1/.test(location.search);

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { if (DEV) console.log('bridge error', fn, e); }
    } else if (DEV) {
      console.log('[ca->game]', fn, arg);
    }
  }

  function coerce(x) {
    if (x && typeof x === 'object') return x;
    try { return JSON.parse(String(x || '{}')); } catch (e) { return {}; }
  }

  var backdrop = document.getElementById('ca-backdrop');
  var elCulprit = document.getElementById('ca-culprit');
  var elLead = document.getElementById('ca-lead');
  var elAdvice = document.getElementById('ca-advice');
  var btnOk = document.getElementById('ca-ok');

  function show(payload) {
    var p = coerce(payload);
    elCulprit.textContent = (p.culprit && String(p.culprit).trim()) || '(unknown mod)';
    // The C++ message is the authoritative wording; if present, split its lines
    // into the lead + advice paragraphs, else keep the static HTML copy.
    if (p.message) {
      var lines = String(p.message).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      // message = "A crash was suppressed…", "Culprit: X", "Your save may now be…"
      var lead = lines.find(function (l) { return /suppress|running/i.test(l); });
      var advice = lines.find(function (l) { return /save|restart|recommend/i.test(l); });
      if (lead) elLead.textContent = lead;
      if (advice) elAdvice.innerHTML = advice.replace(/(save to a new slot and restart[^.]*)/i, '<strong>$1</strong>');
    }
    backdrop.classList.remove('ca-hidden');
    backdrop.setAttribute('aria-hidden', 'false');
    try { btnOk.focus(); } catch (e) {}
  }

  function hide() {
    backdrop.classList.add('ca-hidden');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  btnOk.addEventListener('click', function () {
    hide();
    toGame('caDismiss');
  });

  // C++ entry points.
  window.caShow = show;
  window.caHide = hide;

  // Dev harness: ?dev=1 renders a sample so the card can be eyeballed in a browser.
  if (DEV) {
    show({ culprit: 'SomeMod.dll+0x1234',
           message: 'A crash was suppressed to keep your game running.\nCulprit: SomeMod.dll+0x1234\nYour save may now be unstable. Save to a NEW slot and restart the game. Continuing is not recommended.' });
  }
})();
