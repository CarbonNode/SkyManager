<!-- ===================================================================== *
     Loot tab — the Loot Highlighter's controls (glow scanner, v0.15.0).
     Paste inside <div id="panel">, beside the other pane <section>s.
     Static shell only: category rows and palette swatches are built by
     loot-pane.js from what C++ sends in ltOpen, so a new category or colour
     added in C++ lands here with no markup edit.
     * ===================================================================== -->
<section id="lt-pane" class="hidden">
  <!-- LEFT: master switch + live status -->
  <aside id="lt-side">
    <div class="lt-card" id="lt-master-card">
      <button id="lt-master" class="off" title="Toggle every loot glow (also the Loot Vision entry in Misc, bindable to a key)">
        ✨ Loot Vision</button>
      <div id="lt-master-state">OFF</div>
      <div id="lt-active" class="lt-hint">Nothing is glowing.</div>

      <button id="lt-safe" class="off" title="Glow only safe (non-respawning) storage — barrels, chests and cupboards you can stash loot in. Works even with Loot Vision off."
        style="width:100%;margin-top:12px;padding:12px 14px;font:inherit;font-size:16px;font-weight:600;border-radius:12px;cursor:pointer;border:1px solid rgba(120,210,140,.45);background:rgba(120,210,140,.12);color:#cfe6d5;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .05s ease">🗄 Safe containers</button>
      <div id="lt-safe-state" class="lt-hint" style="margin-top:6px">Off — safe storage not glowing on its own.</div>
    </div>

    <div class="lt-card" id="lt-lotd-card">
      <div class="lt-card-title">Museum tracking</div>
      <div id="lt-lotd-status" class="lt-hint">Checking for The Curator's Companion…</div>
    </div>

    <div class="lt-card" id="lt-safe-card">
      <div class="lt-card-title">Safe containers</div>
      <div class="lt-hint">The <b>Safe containers</b> category glows storage that
        never resets — barrels, chests and cupboards you can stash loot in
        without a cell reset eating it. Recolour or turn it off in the list.
        If you still run the <i>Highlight Safe Containers</i> mod, untick it so
        safe chests don’t glow twice.</div>
    </div>

    <div class="lt-card">
      <div class="lt-card-title">How it works</div>
      <div class="lt-hint">Glows update every second or two as you move.
        Opening a corpse or chest counts as looting it — its glow dies.
        After a reload, things glow again until re-opened.</div>
    </div>
  </aside>

  <!-- RIGHT: categories + tuning -->
  <section id="lt-main">
    <div id="lt-cats" role="list" aria-label="Highlight categories"></div>

    <div id="lt-settings">
      <div class="lt-set-title">Tuning</div>

      <label class="lt-field">
        <span class="lt-field-label">Reach <span id="lt-radius-val" class="lt-val">31 m</span></span>
        <input id="lt-radius" type="range" min="500" max="8000" step="100" value="2200"
               aria-label="Scan radius">
        <span class="lt-hint">How far from you things light up.</span>
      </label>

      <label class="lt-field">
        <span class="lt-field-label">Max glows <span id="lt-max-val" class="lt-val">40</span></span>
        <input id="lt-max" type="range" min="5" max="150" step="5" value="40"
               aria-label="Maximum simultaneous glows">
        <span class="lt-hint">Nearest first. Keeps a packed cellar from hurting the frame rate.</span>
      </label>

      <label class="lt-field">
        <span class="lt-field-label">Valuables worth at least <span id="lt-valmin-val" class="lt-val">100</span></span>
        <input id="lt-valmin" type="range" min="0" max="2000" step="25" value="100"
               aria-label="Minimum value for the Valuables category">
        <span class="lt-hint">The Valuables &amp; gems bar: a garnet (100) glows, a dwemer cog stays dark.</span>
      </label>

      <div class="lt-set-title">Valuable gear bar</div>
      <label class="lt-field">
        <span class="lt-field-label">Worth per unit of weight <span id="lt-ratio-val" class="lt-val">10</span></span>
        <input id="lt-ratio" type="range" min="0" max="100" step="1" value="10"
               aria-label="Value to weight ratio">
        <span class="lt-hint">A 50-weight battleaxe needs 500 gold of value at 10.</span>
      </label>
      <label class="lt-field">
        <span class="lt-field-label">Minimum value <span id="lt-minval-val" class="lt-val">250</span></span>
        <input id="lt-minval" type="range" min="0" max="3000" step="50" value="250"
               aria-label="Minimum gold value">
        <span class="lt-hint">Nothing under this glows, whatever it weighs.</span>
      </label>

      <label class="lt-check"><input id="lt-hideopened" type="checkbox" checked>
        <span>Chests go dark once opened</span></label>
      <label class="lt-check"><input id="lt-labelsafe" type="checkbox">
        <span>Tag safe containers “(Safe)” in their name <span class="lt-hint" style="display:inline">— works even with the glow off; lets you drop the Highlight Safe Containers mod</span></span></label>
      <label class="lt-check"><input id="lt-notify" type="checkbox" checked>
        <span>Corner message when Loot Vision toggles</span></label>
    </div>
  </section>
</section>
