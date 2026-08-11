<!-- ===================================================================== *
     Rooms tab — Room Guard pane for the Hotkey Deck.

     PASTE VERBATIM into view/HotkeyDeck/index.html as a sibling of
     #deck-pane / #dm-pane / #fin-pane / #numpad-pane — i.e. inside
     <div id="panel">, after <nav id="tabs"></nav> and before
     <footer id="hints">. Every id/class is rm- prefixed, so nothing here
     collides with the deck, notes, quests, domains, finances, wardrobe or
     numpad panes.

     Also add, after app.js:
       <script src="rooms-pane.js"></script>
 * ===================================================================== -->
<section id="rm-pane" class="hidden" aria-label="Rooms">
  <div id="rm-body">

    <!-- LEFT: what you're standing in right now + the claim controls -->
    <aside id="rm-side" aria-label="Where you are">
      <div id="rm-here-card">
        <div class="rm-here-label">You are in</div>
        <div id="rm-here-name" class="rm-here-name">—</div>
        <div id="rm-here-status" class="rm-here-status"></div>
        <!-- Privacy lockdown: one press = nobody in this room at all, right now.
             Press again and the room is back to its normal who's-allowed rules
             (nothing about them was edited). Label/title/disabled are set live
             in rooms-pane.js renderHere(). -->
        <button id="rm-lock-btn" class="rm-lock-btn"
                title="Seal the room you are standing in — nobody comes in at all">
          🔒 Nobody in right now</button>
      </div>

      <div id="rm-claim-box">
        <label class="rm-field">
          <span class="rm-field-label">Name</span>
          <input id="rm-claim-name" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Rented room">
        </label>

        <div class="rm-field">
          <span class="rm-field-label">This place is</span>
          <div id="rm-kind-toggle" class="rm-seg" role="radiogroup" aria-label="Room kind">
            <button class="rm-seg-btn active" data-kind="inn" role="radio" aria-checked="true"
                    title="Guarded — strangers get moved out">🔒 Rented</button>
            <button class="rm-seg-btn" data-kind="private" role="radio" aria-checked="false"
                    title="Guarded bedroom inside a shared cell — use ✋ on the occupant list to allow your own people in">🛏 Private</button>
            <button class="rm-seg-btn" data-kind="home" role="radio" aria-checked="false"
                    title="Never guarded — your household is left alone">🏠 Home</button>
          </div>
        </div>

        <div class="rm-field">
          <span class="rm-field-label">Footprint</span>
          <div id="rm-shape-toggle" class="rm-seg" role="radiogroup" aria-label="Claim footprint">
            <button class="rm-seg-btn active" data-shape="circle" role="radio" aria-checked="true"
                    title="Round area — one size slider">&#9711; Round</button>
            <button class="rm-seg-btn" data-shape="box" role="radio" aria-checked="false"
                    title="Rectangle aligned to where you face when claiming — fine-tune width and depth afterwards in the room's size panel">&#9645; Box</button>
          </div>
        </div>

        <div class="rm-field">
          <span class="rm-field-label">Size <span id="rm-size-val" class="rm-size-val">200</span></span>
          <input id="rm-radius" type="range" min="80" max="1200" step="20" value="200"
                 aria-label="Claim radius">
          <span class="rm-hint">About one room. Too big reaches through the wall into
            the corridor — you can retune it after claiming.</span>
        </div>

        <div class="rm-field rm-keepout">
          <span class="rm-field-label">Keep out</span>
          <label class="rm-check"
                 title="Guard the ENTIRE cell, not just the area you sized above — 'mark this cell private'. Anyone unwelcome anywhere in the cell is moved out and the size slider is ignored.">
            <input id="rm-claim-whole" type="checkbox"> <span>🚪 The whole cell (private cell)</span></label>
          <label class="rm-check"
                 title="Push your FOLLOWERS out of this room too, not just strangers. They are told to wait (their own follower mod's wait) so they stop trailing you in, and rejoin when you leave the cell.">
            <input id="rm-claim-evict" type="checkbox"> <span>🚶 My followers too</span></label>
        </div>

        <button id="rm-claim-btn" title="Claim the room you are standing in">★ Claim this room</button>
        <div class="rm-hint">Stand in the middle of the room, then claim.</div>
      </div>

      <div id="rm-occupants" aria-label="Who is in here"></div>
    </aside>

    <!-- RIGHT: the claimed-room list -->
    <section id="rm-main">
      <div id="rm-toolbar">
        <div id="rm-search-wrap">
          <span class="rm-search-ic" aria-hidden="true">⌕</span>
          <input id="rm-search" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Search rooms, notes, places…">
        </div>
        <span id="rm-count" title="Rooms in view">0</span>
        <button id="rm-edit" class="ghost-btn" title="Edit mode — reveal delete controls (F2)">Edit</button>
      </div>

      <!-- master switches, edit mode only -->
      <div id="rm-settings" class="hidden">
        <label class="rm-check"><input id="rm-enabled" type="checkbox"> <span>Room Guard on</span></label>
        <label class="rm-check"><input id="rm-followers" type="checkbox">
          <span>Followers may always come in</span></label>
        <label class="rm-check"><input id="rm-notify" type="checkbox">
          <span>Corner message on each eviction</span></label>
        <label class="rm-check"><input id="rm-autoclaim" type="checkbox">
          <span>Auto-claim rented inn rooms</span></label>
        <label class="rm-field rm-field-inline">
          <span class="rm-field-label">Grace when you're watching</span>
          <input id="rm-grace" type="range" min="0" max="15000" step="500" value="4000">
          <span id="rm-grace-val" class="rm-size-val">4.0s</span>
        </label>
        <!-- Whole-tab size. Static markup on purpose: rooms-pane.js rebuilds
             the room LIST constantly but never this block, and hd-scale.js
             needs no per-element wiring, so there is nothing to re-attach. -->
        <div id="rm-size-row"></div>
      </div>

      <!-- Sealed-room banner: a lockdown survives a save/load, so every sealed
           room is named here whatever the search box says, with a one-click
           lift. Filled by rooms-pane.js renderLockBanner(). -->
      <div id="rm-lock-banner" class="hidden" aria-label="Sealed rooms"></div>

      <div id="rm-list" role="listbox" aria-label="Claimed rooms"></div>
      <div id="rm-empty" class="hidden"></div>

      <div id="rm-foot">
        <button id="rm-evict-btn" title="Move everyone evictable out of this room right now">
          ⇥ Clear this room</button>
        <button id="rm-ignore-btn" class="ghost-btn"
                title="Look at someone and press this — they are never moved, anywhere">
          🚫 Never move who I'm looking at</button>
        <button id="rm-ignore-pick" class="ghost-btn"
                title="Pick someone by name — your roster and everyone nearby, searchable — they are never moved, anywhere">
          🛡 Never move…</button>
      </div>

      <div id="rm-ignore-list" aria-label="Never moved"></div>
    </section>

  </div>
</section>
