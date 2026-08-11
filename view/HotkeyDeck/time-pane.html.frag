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

    <!-- Until: land on a time of day, whatever the clock says now. -->
    <div class="tm-group" aria-label="Wait until">
      <div class="tm-group-label">Until</div>
      <div class="tm-chips" id="tm-until-chips">
        <button class="tm-chip" data-until="7"  title="Sleep the night away — jump to 7:00 AM">🌅 Morning<span class="tm-chip-sub" data-sub="7">…</span></button>
        <button class="tm-chip" data-until="12" title="Jump to 12:00 noon">☀️ Noon<span class="tm-chip-sub" data-sub="12">…</span></button>
        <button class="tm-chip" data-until="18" title="Jump to 6:00 PM">🌆 Evening<span class="tm-chip-sub" data-sub="18">…</span></button>
        <button class="tm-chip" data-until="22" title="Jump to 10:00 PM">🌙 Night<span class="tm-chip-sub" data-sub="22">…</span></button>
      </div>
    </div>

    <!-- For: plain hour jumps. -->
    <div class="tm-group" aria-label="Wait for">
      <div class="tm-group-label">For</div>
      <div class="tm-chips" id="tm-for-chips">
        <button class="tm-chip" data-hours="1">+1 h</button>
        <button class="tm-chip" data-hours="3">+3 h</button>
        <button class="tm-chip" data-hours="6">+6 h</button>
        <button class="tm-chip" data-hours="12">+12 h</button>
        <button class="tm-chip" data-hours="24">+24 h</button>
      </div>
    </div>

    <!-- The long haul: slider up to a week, with a landing forecast. -->
    <div class="tm-group" id="tm-custom" aria-label="Custom wait">
      <div class="tm-group-label">Longer</div>
      <div id="tm-slider-row">
        <input id="tm-slider" type="range" min="1" max="168" step="1" value="24"
               aria-label="Hours to wait">
        <div id="tm-slider-read">24 h</div>
      </div>
      <div id="tm-forecast">lands —</div>
      <button id="tm-go" class="tm-primary">⏩ Wait</button>
    </div>

    <div id="tm-note" class="tm-hiddenish" role="status"></div>

    <div id="tm-foot">
      Time jumps in one step — no ticking, no wait menu. The world catches up
      in a single beat. Blocked in combat, same as resting anywhere.
    </div>
  </div>
</section>
