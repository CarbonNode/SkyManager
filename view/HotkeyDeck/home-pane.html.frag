<!-- ===================================================================== *
     Home tab — the deck's landing page: a card per system + a universal
     search that opens Omni, with a collapsed Recent drawer below the cards.
     Paste inside <div id="panel">, beside the other pane <section>s.
     Cards + recent rows are built by home-pane.js; only the shell is static.
     * ===================================================================== -->
<section id="hm-pane" class="hidden">
  <div id="hm-scroll">
    <!-- universal search: a launcher that opens the real Omni overlay -->
    <div id="hm-search" role="button" tabindex="0"
         title="Search every system — hotkeys, spells, followers, quests, loot, places…">
      <span class="hm-search-ic" aria-hidden="true">⌕</span>
      <span id="hm-search-label">Search everything</span>
      <span class="hm-search-kbd"><kbd>Ctrl</kbd><kbd>F</kbd></span>
    </div>

    <!-- Open key — the ONE control a new user hunts for and can't find
         (Nexus feedback, IAMTOKKO: wanted to change F7, searched, gave up).
         Big current-bind label + a Change… button that runs the SAME
         press-to-rebind flow Edit ▸ settings has. Filled by home-pane.js. -->
    <div id="hm-openkey" role="group" aria-label="Open key">
      <div class="hm-ok-plate" aria-hidden="true">⌨</div>
      <div class="hm-ok-body">
        <div class="hm-ok-title">Open key</div>
        <div class="hm-ok-help">This key opens SkyManager anywhere in the game.</div>
      </div>
      <div class="hm-ok-key" id="hm-ok-key" title="The key that opens SkyManager">F7</div>
      <button id="hm-ok-change" type="button" class="hm-ok-btn"
              title="Press or pick the new key that opens SkyManager">Change…</button>
    </div>

    <div class="hm-sec-head">
      <h2>Systems</h2>
      <span class="hm-sec-hint">Pick a card — or search above</span>
    </div>
    <div id="hm-grid" role="list" aria-label="Deck systems"></div>

    <!-- Notes / Time / Recent: folded away by default, each opens on click.
         Time and Notes moved here off the tab strip (Rober, 2026-08-05) — the
         same treatment as Recent. -->
    <div id="hm-notes" class="hm-drawer">
      <button id="hm-notes-toggle" class="hm-drawer-head" aria-expanded="false">
        <span class="hm-chev" aria-hidden="true">▸</span>
        <span class="hm-drawer-title">Notes</span>
        <span class="hm-drawer-sub">your scratchpad</span>
      </button>
      <div id="hm-notes-body" class="hm-drawer-body hidden">
        <textarea id="hm-notes-ta" class="hm-notes-ta" spellcheck="false"
                  placeholder="Jot anything — saved with the deck."></textarea>
      </div>
    </div>

    <div id="hm-time" class="hm-drawer">
      <button id="hm-time-toggle" class="hm-drawer-head" aria-expanded="false">
        <span class="hm-chev" aria-hidden="true">▸</span>
        <span class="hm-drawer-title">Time</span>
        <span id="hm-time-now" class="hm-drawer-sub">skip the slow wait menu</span>
      </button>
      <div id="hm-time-body" class="hm-drawer-body hidden">
        <div class="hm-time-clock" id="hm-time-clock">—:—</div>
        <div class="hm-time-date" id="hm-time-date">reading the sky…</div>
        <div class="hm-time-group-label">Wait until</div>
        <div class="hm-time-chips" id="hm-time-until">
          <button class="hm-time-chip" data-until="7">🌅 Morning</button>
          <button class="hm-time-chip" data-until="12">☀️ Noon</button>
          <button class="hm-time-chip" data-until="18">🌆 Evening</button>
          <button class="hm-time-chip" data-until="22">🌙 Night</button>
        </div>
        <div class="hm-time-group-label">Wait for</div>
        <div class="hm-time-chips" id="hm-time-for">
          <button class="hm-time-chip" data-hours="1">+1 h</button>
          <button class="hm-time-chip" data-hours="3">+3 h</button>
          <button class="hm-time-chip" data-hours="6">+6 h</button>
          <button class="hm-time-chip" data-hours="12">+12 h</button>
          <button class="hm-time-chip" data-hours="24">+24 h</button>
        </div>
      </div>
    </div>

    <!-- UI Elements: the on-screen elements (HUD, Action Bar, Wheel, Loot
         Vision) — a live on/off chip, a toggle and a jump to where each is
         configured. Rows built by home-pane.js (home-ui-elements). -->
    <div id="hm-uie" class="hm-drawer">
      <button id="hm-uie-toggle" class="hm-drawer-head" aria-expanded="false">
        <span class="hm-chev" aria-hidden="true">▸</span>
        <span class="hm-drawer-title">UI Elements</span>
        <span class="hm-drawer-sub">what's on your screen, and where to change it</span>
      </button>
      <div id="hm-uie-body" class="hm-drawer-body hidden"></div>
    </div>

    <div id="hm-recent" class="hm-drawer">
      <button id="hm-recent-toggle" class="hm-drawer-head" aria-expanded="false">
        <span class="hm-chev" aria-hidden="true">▸</span>
        <span class="hm-drawer-title">Recent</span>
        <span id="hm-recent-count" class="hm-drawer-count"></span>
        <span class="hm-drawer-sub">what you've fired this session</span>
      </button>
      <div id="hm-recent-body" class="hm-drawer-body hidden"></div>
    </div>
  </div>
</section>
