/* ===================================================================== *
 *  Scene tab — the dedicated OStim page, and where F7 lands mid-scene.
 *
 *  Rober, 2026-09-21: "if im in an ostim scene it should open a dedicated
 *  ostim scene page on f7 of skymanager", then "we should have a lot of
 *  ostim options".
 *
 *  ---- why this file is tiny ------------------------------------------
 *  Because the page already existed and was in the wrong place. The
 *  twelve-segment workspace, its live poll, its portraits, its searches
 *  and every verb behind them live in ostim-tools.js, which until today
 *  could only appear as a floating modal you had to go and find. So this
 *  is a MOVE, not a second copy: the pane owns the tab's lifecycle and
 *  hands the host element to OstimTools.mount(). One build, two hosts.
 *
 *  Two copies of a control is the failure mode this deck has already paid
 *  for (the portal and the deck drifting apart, twice). Anything that
 *  belongs on this page therefore goes into ostim-tools.js as a segment —
 *  NOT in here, where the modal would not get it.
 *
 *  ---- the landing itself is C++ ---------------------------------------
 *  main.cpp's OpenPalette sets g_pendingTab = "scene" when OStim reports a
 *  live player thread, BEFORE the crosshair heuristic — because mid-scene
 *  the crosshair is always full of a participant, so Followers would win
 *  every time and this page would never once open by the key that is
 *  supposed to open it. Setting: `sceneOpensScene` (Settings tab).
 * ===================================================================== */

window.ScenePane = (function () {
  'use strict';

  var HOST = 'sn-pane';
  var pending = '';          // segment a deep-open asked for before we mounted

  function host() { return document.getElementById(HOST); }

  function tools() {
    return (window.OstimTools && typeof OstimTools.mount === 'function') ? window.OstimTools : null;
  }

  /* The honest empty state. ostim-tools.js is DR1 in the boot manifest and
     so is almost always in by the time this tab can be reached — but "almost
     always" is not a guarantee, and a blank page would read as a broken tab
     rather than a slow one. */
  function waiting(reason) {
    var h = host();
    if (!h) return;
    h.textContent = '';
    var box = document.createElement('section');
    box.className = 'ost-card sc-waiting';
    var title = document.createElement('h2');
    title.textContent = 'OStim scene';
    var note = document.createElement('p');
    note.className = 'ost-help';
    note.textContent = reason;
    box.append(title, note);
    h.append(box);
  }

  return {
    init: function () { /* the host is static markup; nothing to build */ },

    onShow: function () {
      var h = host();
      if (!h) return;
      var t = tools();
      if (!t) { waiting('Loading the scene controls…'); return; }
      /* Mount fresh on every show. The page is a live view of a running
         scene: between two looks at it the scene can have changed, ended
         or restarted under a new thread, and a stale card is exactly what
         this tab exists to prevent. */
      /* '' = land on the launcher (hero + the twelve chips) and open nothing;
         a deep-open passes the segment it wants. */
      t.mount(h, pending || '');
      pending = '';
    },

    onHide: function () {
      var t = tools();
      /* Only tear down what WE mounted. The floating modal shares this
         module, and closing it from here would shut a workspace the user
         opened over another tab. */
      if (t && t.isHosted && t.isHosted()) t.close();
    },

    onKey: function (e) {
      var t = tools();
      return !!(t && t.onKey && t.onKey(e));
    },

    /* Omni / deep-open entry: land on the page with a segment chosen.
       The segment is ALWAYS parked on `pending`, even when the card is
       already mounted, because the caller's very next move is usually
       hdShowTab('scene') — and if that remounts us (arriving from another
       tab) the only record of what was asked for is this field. Clearing
       it in onShow is what keeps it to one use. */
    show: function (segment) {
      pending = segment || '';
      var t = tools();
      if (t && t.isHosted && t.isHosted() && segment) t.showSegment(segment);
    }
  };
})();
