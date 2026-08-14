<!-- ===================================================================== *
     Animations tab — a ZaZ Animation Pack player (v0.16.0).
     Paste inside <div id="panel">, beside the other pane <section>s.
     Static shell only: the category rail and the animation rows are built by
     anim-pane.js from the catalogue C++ sends in anOpen (baked from ZAP's FNIS
     lists), so a bigger catalogue lands here with no markup edit.
     * ===================================================================== -->
<section id="an-pane" class="hidden">
  <!-- Poses | OStim segmented toggle (v0.17.0). Wired by ostim-pane.js; the
       OStim body (#os-body) is pasted from ostim-pane.html.frag after #an-row. -->
  <div id="an-seg" role="tablist" aria-label="Animation source">
    <button id="an-seg-poses" class="an-seg-btn active" role="tab">Animations</button>
    <button id="an-seg-ostim" class="an-seg-btn" role="tab" title="Search & change OStim scenes">OStim</button>
  </div>
  <!-- #an-row wraps the Poses layout so the OStim body can be a sibling of it -->
  <div id="an-row">
  <!-- LEFT: target + categories -->
  <aside id="an-side">
    <div class="an-card" id="an-target-card">
      <div class="an-card-title">Target</div>
      <div id="an-target" class="an-tgt">Applying to <span class="an-tgt-name">you</span></div>
      <div class="an-tgt-hint">Whoever you were looking at when the deck opened — or you, if nothing.</div>
      <div class="an-tgt-actions">
        <button id="an-reset" class="an-btn" title="Return the target to their normal idle">↺ Reset pose</button>
        <button id="an-crawl" class="an-btn an-crawl" title="Make the target crawl on all fours">🐾 Crawl</button>
      </div>
    </div>

    <div id="an-cats" class="an-cats" role="list" aria-label="Animation categories"></div>

    <!-- Load-order packs: in-game FNIS scan (anScan). anim-pane.js builds the
         body — scan pitch before the first scan, pack toggles + filter after. -->
    <div class="an-card" id="an-packs-card">
      <div class="an-card-title">Load-order packs
        <button id="an-rescan" class="an-pk-rescan hidden"
                title="Re-scan the load order for FNIS animation packs">⟳ Rescan</button>
      </div>
      <div id="an-pk-body"></div>
    </div>

    <div id="an-source" class="an-source">Loading ZaZ Animation Pack…</div>
  </aside>

  <!-- RIGHT: search + list -->
  <section id="an-main">
    <div id="an-searchbar">
      <input id="an-search" type="text" placeholder="Search animations… (Enter applies the top hit)"
             autocomplete="off" spellcheck="false" aria-label="Search animations">
      <span id="an-count" class="an-count">—</span>
    </div>
    <div id="an-list" role="list" aria-label="Animations"></div>
  </section>
  </div><!-- /#an-row -->

  <!-- OStim body pasted here from ostim-pane.html.frag (#os-body) -->

  <div id="an-toast" class="an-toast" role="status" aria-live="polite"></div>
</section>
