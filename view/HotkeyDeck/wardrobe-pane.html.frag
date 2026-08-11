<!-- ===================================================================== *
     Wardrobe tab — outfit / wardrobe / NPC manager pane for the Hotkey Deck.

     PASTE VERBATIM into view/HotkeyDeck/index.html as a sibling of
     #deck-pane / #notes-pane / #quests-pane / #fin-pane / #numpad-pane — i.e.
     inside <div id="panel">, after <nav id="tabs"></nav> and before
     <footer id="hints">. Every id/class is wd- prefixed, so nothing here
     collides with the deck, notes, quests, domains, finances or numpad panes.

     Also add, after app.js:
       <script src="wardrobe-pane.js"></script>
     (after, so the pane can chain window.hdClosed.)

     Backbone is SOES-NG — see modding/guides/wardrobe_system_design.md.
 * ===================================================================== -->
<section id="wd-pane" class="hidden" aria-label="Wardrobe">
 <!-- #wd-scale is the whole-tab zoom box: it is sized 1/scale of the pane and
      scaled back with transform, so every px in this tab's stylesheet rides
      the scaler without knowing it exists. It wraps EVERYTHING, dialogs and
      menu included, because "scale the tab" means the sheet too. -->
 <div id="wd-scale">

  <!-- sub-tabs: Outfits · Wardrobes · NPCs -->
  <nav id="wd-nav" aria-label="Wardrobe sections"></nav>

  <!-- toolbar: search + count + edit + add -->
  <div id="wd-toolbar">
    <div id="wd-search-wrap">
      <span class="wd-search-ic" aria-hidden="true">&#9109;</span>
      <input id="wd-search" type="text" autocomplete="off" spellcheck="false"
             placeholder="Search outfits, wardrobes, people…">
      <button id="wd-search-clear" class="hidden" title="Clear search" aria-label="Clear search">&#10005;</button>
    </div>
    <span id="wd-count" title="Rows in view">0</span>
    <button id="wd-edit" class="ghost-btn" title="Edit mode — reveal delete controls (F2)">Edit</button>
    <button id="wd-add" class="ghost-btn" title="Add to this section">&#65291; New</button>
  </div>

  <!-- edit-mode chrome (F2). Same control shape, range and step as the
       Followers tab's "Tab" group, so the two tabs never disagree. -->
  <div id="wd-editrow" class="hidden">
    <span class="wd-ok-grp">
      <span class="wd-ok-label">Tab size</span>
      <button id="wd-ui-dec" class="keychip" title="Shrink the whole tab — fits more on screen">&minus;</button>
      <span id="wd-ui-val" class="wd-ui-v">100%</span>
      <button id="wd-ui-inc" class="keychip" title="Enlarge the whole tab — bigger text and controls">+</button>
      <button id="wd-ui-reset" class="keychip" title="Back to 100%">Reset</button>
    </span>
    <!-- Tile size — the ART, as opposed to Tab size above which is the text and
         controls. Separate because they are genuinely different wants: browsing
         outfits by their picture means big tiles at normal text, and neither
         control can express that alone. Filled by hd-scale.js (tab
         "wardrobe"). -->
    <span id="wd-img-row" class="wd-ok-grp"></span>
    <span class="wd-ok-hint">Scales this tab's text and controls, 60%&ndash;160%. Saved with the deck.</span>
  </div>

  <!-- SOES availability / conflict banner (hidden unless there is something to say) -->
  <div id="wd-banner" class="hidden" role="status"></div>

  <!-- category filter pills (Outfits sub-tab only); renamed/deleted in edit mode -->
  <div id="wd-cats" class="hidden" aria-label="Filter by category"></div>

  <!-- bulk-action bar; appears only when something is selected -->
  <div id="wd-selbar"></div>

  <!-- the scrolling body; one of these is visible at a time -->
  <div id="wd-body">
    <div id="wd-list" role="list" aria-label="Wardrobe rows"></div>
    <div id="wd-empty" class="hidden"></div>
  </div>

  <!-- wardrobe builder overlay: members (left) + catalogue (right) -->
  <div id="wd-builder" class="hidden" role="dialog" aria-modal="true" aria-label="Edit wardrobe">
    <div id="wd-builder-card">
      <header id="wd-builder-head">
        <button id="wd-builder-swatch" type="button" title="Change this wardrobe's colour"
                aria-label="Change colour"></button>
        <div id="wd-builder-id">
          <!-- the title is an inline <input>: PrismaUI has no window.prompt,
               so renaming happens in place, like the Domains rail -->
          <h2 id="wd-builder-title"></h2>
          <span id="wd-builder-sub"></span>
        </div>
        <div id="wd-builder-note"></div>
        <span id="wd-builder-mode"></span>
        <span id="wd-builder-del"></span>
        <button id="wd-builder-close" class="ghost-btn" title="Done (Esc)">Done</button>
      </header>
      <div id="wd-builder-cols">
        <section class="wd-col" aria-label="Members">
          <h3 class="wd-col-h">In this wardrobe <span id="wd-mem-count">0</span></h3>
          <div id="wd-members" role="list"></div>
          <div id="wd-members-empty" class="wd-col-empty">
            Nothing here yet — click outfits on the right to add them.
          </div>
        </section>
        <section class="wd-col" aria-label="Outfit catalogue">
          <h3 class="wd-col-h">All outfits</h3>
          <input id="wd-cat-search" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Filter outfits…">
          <div id="wd-catalogue" role="list"></div>
        </section>
      </div>
    </div>
  </div>

  <!-- NPC detail sheet: assignment, cadence, location overrides -->
  <div id="wd-sheet" class="hidden" role="dialog" aria-modal="true" aria-label="Assignment">
    <div id="wd-sheet-card">
      <header id="wd-sheet-head">
        <img id="wd-sheet-face" alt="" class="hidden">
        <div class="wd-sheet-id">
          <h2 id="wd-sheet-name">NPC</h2>
          <span id="wd-sheet-sub"></span>
        </div>
        <button id="wd-sheet-close" class="ghost-btn" title="Done (Esc)">Done</button>
      </header>
      <div id="wd-sheet-body"></div>
    </div>
  </div>

  <!-- an outfit's actual pieces: view, and remove one -->
  <div id="wd-pieces" class="hidden" role="dialog" aria-modal="true" aria-label="Outfit pieces">
    <div id="wd-pieces-card">
      <header id="wd-pieces-head">
        <h2 id="wd-pieces-title">Outfit</h2>
        <span id="wd-pieces-sub"></span>
        <button id="wd-pieces-close" class="ghost-btn" title="Done (Esc)">Done</button>
      </header>
      <div id="wd-pieces-body"></div>
    </div>
  </div>

  <!-- searchable picker: assign to a wardrobe / category, or create one inline -->
  <div id="wd-picker" class="hidden" role="dialog" aria-modal="true" aria-label="Choose">
    <div id="wd-picker-card">
      <header id="wd-picker-head">
        <h2 id="wd-picker-title">Choose</h2>
        <span id="wd-picker-sub"></span>
        <button id="wd-picker-close" class="ghost-btn" title="Done (Esc)">Done</button>
      </header>
      <input id="wd-picker-input" type="text" autocomplete="off" spellcheck="false">
      <div id="wd-picker-list" role="listbox"></div>
    </div>
  </div>

  <!-- shared right-click menu -->
  <div id="wd-menu" class="hidden" role="menu"></div>

 </div><!-- /#wd-scale -->
</section>
