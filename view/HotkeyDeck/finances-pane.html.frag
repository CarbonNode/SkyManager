<!-- ===================================================================== *
     Finances tab — Financial Manager pane for the Hotkey Deck view.

     PASTE VERBATIM into view/HotkeyDeck/index.html as a sibling of
     #deck-pane / #notes-pane / #quests-pane / #dm-pane / #numpad-pane — i.e.
     inside <div id="panel">, after <nav id="tabs"></nav> and before
     <footer id="hints">. Every id/class is fin- prefixed, so nothing here
     collides with the deck, notes, quests, domains or numpad panes.

     Also add, after app.js:
       <script src="finances-pane.js"></script>
     (after, so the pane can chain window.hdClosed.)
 * ===================================================================== -->
<section id="fin-pane" class="hidden" aria-label="Finances">

  <!-- summary bar: live gold, monthly net, rolling debt, the Settle button -->
  <!-- Whole-tab scale wrapper (hd-scale.css): the pane keeps its real box,
       this is sized 1/scale of it and transform-scaled back. Same contract
       as #fd-scale / #wd-scale. -->
  <div id="fin-scale">
  <div id="fin-summary">
    <div class="fin-stat">
      <span class="fin-stat-k">Gold</span>
      <span id="fin-gold" class="fin-stat-v gold">0 g</span>
    </div>
    <div class="fin-stat">
      <span class="fin-stat-k">Monthly net</span>
      <span id="fin-net" class="fin-stat-v">0 g</span>
    </div>
    <div class="fin-stat">
      <span class="fin-stat-k">Debt</span>
      <span id="fin-debt" class="fin-stat-v">0 g</span>
    </div>
    <button id="fin-settle" title="Collect income, pay expenses + debt; unpaid remainder rolls into debt">
      <span class="fin-settle-main">&#9878; Settle month</span>
      <span class="fin-settle-sub">+0 / &#8722;0</span>
    </button>
  </div>

  <!-- sub-tabs: Recurring · Market · Ledger -->
  <nav id="fin-nav" aria-label="Finance sections"></nav>

  <!-- toolbar: search + count + edit + add -->
  <div id="fin-toolbar">
    <div id="fin-search-wrap">
      <span class="fin-search-ic" aria-hidden="true">&#9109;</span>
      <input id="fin-search" type="text" autocomplete="off" spellcheck="false"
             placeholder="Search names, categories, notes…">
    </div>
    <span id="fin-count" title="Rows in view">0</span>
    <button id="fin-edit" class="ghost-btn" title="Edit mode — reveal delete controls (F2)">Edit</button>
    <button id="fin-add" class="ghost-btn" title="Add a row to this section">&#65291; Line</button>
  </div>

  <!-- edit-mode size strip (F2). Filled by hd-scale.js; finances-pane.js
       only toggles .hidden with the rest of its edit chrome. -->
  <div id="fin-editrow" class="hidden"></div>

  <div id="fin-list" role="list" aria-label="Finance rows"></div>
  <div id="fin-empty" class="hidden"></div>
  </div><!-- /#fin-scale -->


</section>
