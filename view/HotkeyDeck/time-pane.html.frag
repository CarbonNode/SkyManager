<!-- ===================================================================== *
     Time tab — instant waiting for the Hotkey Deck.

     PASTE VERBATIM into view/HotkeyDeck/index.html as a sibling of
     #deck-pane / #rm-pane / #numpad-pane — i.e. inside <div id="panel">,
     after <nav id="tabs"></nav> and before <footer id="hints">.
     Every id/class is tm- prefixed; nothing collides with other panes.

     Also add, after rooms-pane.js:
       <script src="time-pane.js"></script>
 * ===================================================================== -->
<section id="tm-pane" class="hidden" aria-label="Time">
  <div id="tm-body">

    <!-- The clock: big current game time + date, with a day-arc ribbon.  -->
    <div id="tm-clock-card">
      <div id="tm-dial" aria-hidden="true"><div id="tm-dial-dot"></div></div>
      <div id="tm-clock-main">
        <div id="tm-clock-time">—:—</div>
        <div id="tm-clock-date">reading the sky…</div>
      </div>
      <div id="tm-jump-flash" class="tm-hiddenish" aria-live="polite"></div>
    </div>

    <div id="tm-wait-controls"></div>

    <!-- Sky: force any weather the load order ships, or hand it back.
         (2026-08-17, the PROTEUS weather menu rebuilt over the whole order) -->
    <div class="tm-group" id="tm-sky" aria-label="Sky">
      <div class="tm-group-label">Sky</div>
      <div id="tm-sky-now">reading the sky…</div>
      <div id="tm-sky-bar">
        <span class="tm-sky-glyph">⌕</span>
        <input id="tm-sky-q" type="text" autocomplete="off" spellcheck="false"
               placeholder="Search every weather — clear, storm, snow, ash… (Enter = top hit)">
        <button id="tm-sky-release" title="Release the forced weather and let natural weather resume">Let the sky decide</button>
      </div>
      <div id="tm-sky-list" class="tm-hiddenish"></div>
    </div>

    <div id="tm-note" class="tm-hiddenish" role="status"></div>

    <div id="tm-foot">
      Choose a duration, review the arrival date, then confirm. Waiting is unavailable in combat.
    </div>
  </div>
</section>
