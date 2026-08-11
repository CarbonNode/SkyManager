<!-- ===================================================================== *
     OStim segment of the Animations tab (v0.17.0).

     INTEGRATION — the Animations tab becomes a two-segment column:
       1. Inside <section id="an-pane">, add #an-seg (the Poses|OStim toggle)
          as the FIRST child.
       2. Wrap the existing #an-side + #an-main in <div id="an-row"> … </div>.
       3. Paste the #os-body block below as a sibling AFTER #an-row (before the
          #an-toast). ostim-pane.css.frag styles all of it; ostim-pane.js drives it.
       4. Add <script src="ostim-pane.js"></script> after anim-pane.js in index.html.

     Static shell only: the actor chips and the scene rows are built by
     ostim-pane.js from what C++ (ostim_deck.cpp) sends via the OStim Thread API.
     * ===================================================================== -->

<!-- (1) segmented toggle — first child of #an-pane -->
<div id="an-seg" role="tablist" aria-label="Animation source">
  <button id="an-seg-poses" class="an-seg-btn active" role="tab">Poses</button>
  <button id="an-seg-ostim" class="an-seg-btn" role="tab" title="Search & change OStim scenes">OStim</button>
</div>

<!-- (3) OStim body — sibling after #an-row -->
<section id="os-body" class="os-outscene">
  <div id="os-status">
    <div id="os-status-top">
      <span id="os-scene">Not in a scene</span>
      <span id="os-scene-hint">Start an OStim scene, then pick from the list to change it.</span>
    </div>
    <div id="os-actors"></div>
    <div id="os-controls">
      <span class="os-speed">
        <button id="os-speed-down" class="os-ctl" title="Slower" disabled>◂ Speed</button>
        <span id="os-speed-val">—</span>
        <button id="os-speed-up" class="os-ctl" title="Faster" disabled>Speed ▸</button>
      </span>
      <button id="os-auto" class="os-ctl" title="OStim auto-mode (read-only here)" disabled>⟳ Auto: OFF</button>
      <span class="os-ctl-sep" aria-hidden="true"></span>
      <span class="os-ctl-label">Furniture</span>
      <button id="os-furn-near" class="os-ctl" title="Move the scene onto the nearest furniture" disabled>🛏 Nearby</button>
      <button id="os-furn-floor" class="os-ctl" title="Move the scene off furniture, onto the floor" disabled>⌞ Floor</button>
      <span class="os-ctl-sep" aria-hidden="true"></span>
      <button id="os-swap" class="os-ctl" title="Swap DOM / SUB roles" disabled>⇄ Swap roles</button>
    </div>
  </div>

  <div id="os-searchbar">
    <input id="os-search" type="text" placeholder="Search OStim scenes… (Enter changes to the top hit)"
           autocomplete="off" spellcheck="false" aria-label="Search OStim scenes">
    <span id="os-count" class="os-count">—</span>
  </div>
  <div id="os-list" role="list" aria-label="OStim scenes"></div>

  <div id="os-toast" class="os-toast" role="status" aria-live="polite"></div>
</section>
