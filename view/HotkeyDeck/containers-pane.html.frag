<!-- ===================================================================== *
     Containers tab — Mark & Recall pane for the Hotkey Deck view.

     PASTE VERBATIM into view/HotkeyDeck/index.html as a sibling of
     the other deck panes — i.e. inside
     <div id="panel">, after <nav id="tabs"></nav> and before
     <footer id="hints">. Every id/class is ct- prefixed, so nothing here
     can collide with the deck, notes, quests or numpad panes.

     Also add, after app.js:
       <script src="containers-pane.js"></script>
     (after, so the pane can chain window.hdExtKey / hdNativeMouse / hdClosed.)
 * ===================================================================== -->
<section id="ct-pane" class="hidden" aria-label="Containers">
  <div id="ct-body">

    <!-- LEFT: category rail (freeform, user-editable in F2 edit mode) -->
    <nav id="ct-rail" aria-label="Container categories">
      <div id="ct-rail-list"></div>
      <button id="ct-add-cat" class="ct-railadd hidden" title="Add a category">＋ Category</button>
    </nav>

    <!-- RIGHT: search + the container list + the mark button -->
    <section id="ct-main">
      <div id="ct-toolbar">
        <div id="ct-search-wrap">
          <span class="ct-search-ic" aria-hidden="true">⌕</span>
          <input id="ct-search" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Search containers, notes, categories…">
        </div>
        <span id="ct-count" title="Containers in view">0</span>
      </div>

      <!-- open-key rebind card (edit mode only) -->
      <div id="ct-openkey" class="hidden">
        <span class="ct-ok-label">Containers key</span>
        <button id="ct-openkey-btn" class="keychip" title="Press to rebind">F16</button>
        <span class="ct-ok-hint">Opens the deck straight onto this tab · default <b>F16</b>
          (through the F13–F24 bridge) · menu size lives in the deck's Edit settings</span>
      </div>

      <div id="ct-list" role="listbox" aria-label="Containers"></div>
      <div id="ct-empty" class="hidden"></div>

      <div id="ct-foot">
        <button id="ct-mark-btn" title="Mark the container under your crosshair">★ Mark this container</button>
        <div id="ct-here" class="hidden"></div>
      </div>
    </section>

  </div>

  <!-- press-to-rebind capture — the pane's own, so app.js's #capture-modal
       flow (deck entries / ext keys) is left completely alone -->
  <div id="ct-capture" class="hidden">
    <div class="ct-capture-box">
      <div class="ct-capture-title">Press the new Containers key…</div>
      <div class="ct-capture-sub">Keyboard key, F13–F24, or mouse (middle / Mouse&nbsp;4 / Mouse&nbsp;5) · Esc cancels</div>
      <button id="ct-capture-cancel" class="ghost-btn">Cancel</button>
    </div>
  </div>
</section>
