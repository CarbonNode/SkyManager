<!-- ===================================================================== *
     Domains tab — Mark & Recall pane for the Hotkey Deck view.

     PASTE VERBATIM into view/HotkeyDeck/index.html as a sibling of
     #deck-pane / #notes-pane / #quests-pane / #numpad-pane — i.e. inside
     <div id="panel">, after <nav id="tabs"></nav> and before
     <footer id="hints">. Every id/class is dm- prefixed, so nothing here
     can collide with the deck, notes, quests or numpad panes.

     Also add, after app.js:
       <script src="domains-pane.js"></script>
     (after, so the pane can chain window.hdExtKey / hdNativeMouse / hdClosed.)
 * ===================================================================== -->
<section id="dm-pane" class="hidden" aria-label="Domains">
  <div id="dm-body">

    <!-- LEFT: category rail (freeform, user-editable in F2 edit mode) -->
    <nav id="dm-rail" aria-label="Domain categories">
      <div id="dm-rail-list"></div>
      <button id="dm-add-cat" class="dm-railadd hidden" title="Add a category">＋ Category</button>
    </nav>

    <!-- RIGHT: search + the domain list + the mark button -->
    <section id="dm-main">
      <div id="dm-toolbar">
        <div id="dm-search-wrap">
          <span class="dm-search-ic" aria-hidden="true">⌕</span>
          <input id="dm-search" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Search domains, notes, places…">
        </div>
        <span id="dm-count" title="Domains in view">0</span>
      </div>

      <!-- open-key rebind card (edit mode only) -->
      <div id="dm-openkey" class="hidden">
        <span class="dm-ok-label">Domains key</span>
        <button id="dm-openkey-btn" class="keychip" title="Press to rebind">F15</button>
        <span class="dm-ok-hint">Opens the deck straight onto this tab · default <b>F15</b>
          (through the F13–F24 bridge) · menu size lives in the deck's Edit settings</span>
      </div>

      <div id="dm-list" role="listbox" aria-label="Domains"></div>
      <div id="dm-empty" class="hidden"></div>

      <div id="dm-foot">
        <button id="dm-mark-btn" title="Save where you are standing right now">★ Mark this spot</button>
        <div id="dm-here" class="hidden"></div>
      </div>
    </section>

  </div>

  <!-- press-to-rebind capture — the pane's own, so app.js's #capture-modal
       flow (deck entries / ext keys) is left completely alone -->
  <div id="dm-capture" class="hidden">
    <div class="dm-capture-box">
      <div class="dm-capture-title">Press the new Domains key…</div>
      <div class="dm-capture-sub">Keyboard key, F13–F24, or mouse (middle / Mouse&nbsp;4 / Mouse&nbsp;5) · Esc cancels</div>
      <button id="dm-capture-cancel" class="ghost-btn">Cancel</button>
    </div>
  </div>
</section>
