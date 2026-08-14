'use strict';
/* ============================ HDBoot — staged / progressive boot ============================ *
 *
 *  WHAT THIS IS.  The deck's view is 39 script files / ~2.6 MB of JS. Ultralight
 *  parses every "script tag" src synchronously before it fires DOMContentLoaded,
 *  and DOM-ready is the moment C++ measures as "view load to DOM ready" and the
 *  earliest the palette can open. On weak hardware that whole parse is the
 *  once-per-session warm-up a first F7 press waits on.
 *
 *  Staged boot splits the parse in two WITHOUT changing the steady state:
 *    - CORE (the tags that stay in index.html: hd-scale, hd-omni, hd-shelf,
 *      hd-wheel, home-pane, app.js) parses synchronously, so DOM-ready — and the
 *      deck being openable — lands after ~560 KB instead of ~2.6 MB.
 *    - The DEFERRED set (every pane + the lazy F7-card helpers, ~2.4 MB) is
 *      injected by HDBoot.start() the instant the core deck is interactive
 *      (end of app.js init()). Within a beat everything is loaded and the running
 *      view is BYTE-IDENTICAL to the old single-stage boot — this is progressive
 *      loading, not permanent lazy-loading.
 *
 *  This is a PLAIN SCRIPT, not a PrismaUI view — no VIEW_HTML_ENTRYPOINTS impact.
 *
 *  THE DEFER TRAP, and how this file is safe against it.
 *    (1) C++ pushes into the view by `g_prisma->Invoke(g_view, "fnName(payload)")`.
 *        If fnName's defining script hasn't parsed yet, that is a ReferenceError
 *        and the push is LOST. Every reply-fn a deferred script defines and that
 *        C++ can push (verified by grepping src/) gets a BUFFERING STUB installed
 *        HERE, in core, before any push can arrive (the deck cannot open until
 *        C++ calls hdOpen, which is after DOM-ready, which is after this parses).
 *        The stub records {args, t}; when the real script overwrites window.fn,
 *        the loader REPLAYS the buffer in order. See STUB_FNS below.
 *    (2) Cross-file synchronous calls INTO a deferred module (setTab's per-pane
 *        onShow, FolPane/WardrobePane/HDLightbox/… exports) already feature-detect
 *        `if (window.Pane)` at every call site — audited case by case — so a call
 *        that lands during the sub-second window is a silent no-op, not a crash,
 *        and the pane hydrates the moment its script arrives (see maybeHydrate).
 *    (3) The chained globals (fdPortraits/fdTarget/hdIconIndex/hdIcons/hdClosed …)
 *        are reassembled IDENTICALLY to today because the deferred set loads
 *        STRICTLY SEQUENTIALLY in the same relative order as the old script tags,
 *        so every `const prev = window.fn` captures exactly what it captured
 *        before — only the wall-clock moment moved, not the order.
 *
 *  FAILURE = FALL BACK TO TODAY.  A local file that fails to load means a broken
 *  install; the loader logs loudly via hdLog and then loads the remaining scripts
 *  eagerly and synchronously (document.write is gone by then, so it appends
 *  blocking script nodes and lets the browser serialize them), so the result is
 *  never worse than the current single-stage boot.
 *
 *  Wrapped so a bug in staged boot can never wedge the deck: if HDBoot throws at
 *  install time, window.HDBoot is still defined with a start() that eager-loads
 *  everything, i.e. degrades to the old behaviour.
 *
 *  Marker: HDBoot (view identity).
 * =========================================================================================== */
(function () {
  var perf = (window.HDPerf && window.HDPerf.now) ? window.HDPerf.now
    : ((window.performance && performance.now) ? function () { return performance.now(); }
                                               : function () { return Date.now(); });

  function log(line) {
    // Same channel + prefix as HDPerf/open-diag so a pasted log reads as one timeline.
    if (window.HDPerf && typeof HDPerf.log === 'function') { HDPerf.log(line); return; }
    var f = window.hdLog;
    if (typeof f === 'function') { try { f(String(line)); } catch (e) {} }
    else if (window.console) console.log('[hdboot] ' + line);
  }

  /* ------------------------------------------------------------------ manifest ----
   * The deferred set, in the EXACT relative order of the old script-src tags
   * (index.html bottom block). Order is load-bearing for the chained globals, so
   * do not reshuffle without re-checking the `const prev = window.fn` chains
   * (fdPortraits/fdTarget: followers-pane before wardrobe-nff/wardrobe-pane;
   * hdClosed: app.js[core] before domains-pane before wardrobe-pane; hdOpen:
   * app.js[core] before hd-portal).
   *
   * DR1 orders by likelihood-of-first-use within that constraint: followers-pane
   * is first (F7-on-an-NPC deep-opens the Followers tab — a common first open),
   * then wardrobe (its itemIconFor is cross-pane load-bearing for items/npcs/
   * charsheet icon resolution). Everything else keeps its historical slot.
   *
   * The filenames are spelled as literals here (and several also still appear in
   * index.html for the marker verify): a new deferred pane is added to THIS array
   * plus the STUB_FNS list for any reply fn it defines. */
  var MANIFEST = [
    // ---- F7-quick-card helpers, tiny (~150 KB total) and needed by the followers
    //      card's buttons, so they keep their historical slot BEFORE followers-pane
    //      (its card only draws the 📜 / outfit / formation buttons when these
    //      exist — feature-detected, so a race is a missing button, not a crash,
    //      but loading them first makes even that impossible). ----
    'hd-formation.js',
    'hd-door.js',
    'hd-spidgear.js',
    'hd-outfit.js',
    'hd-quests.js',
    // ---- the heavy priority panes, first among the big files (DR1) ----
    'followers-pane.js',   // F7-with-target deep-opens here; FolPane.init() re-run on land
    'wardrobe-pane.js',    // itemIconFor is cross-pane load-bearing (items / npcs / charsheet)
    // ---- the historical order for the remainder (every prev-chain preserved) ----
    'domains-pane.js',
    'bases-pane.js',       // chains DomainsPane.onShow/onHide; must follow domains-pane
    'hd-portal.js',        // chains window.hdOpen (app.js core is already parsed)
    'containers-pane.js',
    'rooms-pane.js',
    'loot-pane.js',
    'keys-pane.js',
    'hd-lightbox.js',
    'hd-facefit.js',       // before the panes that use it (npcs tiles, followers medallions)
    'items-pane.js',
    'npcs-pane.js',
    'mounts-pane.js',
    'charsheet-pane.js',
    'anim-pane.js',
    'ostim-pane.js',
    'light-pane.js',
    'faces-pane.js',
    'time-pane.js',
    'finances-pane.js',
    'wardrobe-nff.js',     // chains fdPortraits/fdTarget/hdIconIndex/hdIcons off
                           // wardrobe-pane (pos 7) -> must load after it; keeps its
                           // historical adjacency to wardrobe-spid below
    'wardrobe-spid.js',
    'sharmat-pane.js',
    'recents-strip.js',
    'chim-flyout.js',
    'hd-textinput.js'
  ];

  /* Which manifest entries DEFINE the active tab's pane, so a switch to a not-yet-
   * loaded tab hydrates the instant its script lands (DR3). Maps script -> the
   * ui.tab value(s) it serves. Only panes that setTab drives need an entry; a
   * helper the tab doesn't gate on (hd-lightbox, hd-facefit, …) is absent. */
  var TAB_OWNER = {
    'followers-pane.js': ['followers'],
    'wardrobe-pane.js': ['wardrobe'],
    'domains-pane.js': ['domains'],
    'containers-pane.js': ['containers'],
    'rooms-pane.js': ['rooms'],
    'loot-pane.js': ['loot'],
    'keys-pane.js': ['keys'],
    'items-pane.js': ['items'],
    'npcs-pane.js': ['npcs'],
    'mounts-pane.js': ['mounts'],
    'charsheet-pane.js': ['sheet'],
    'anim-pane.js': ['anim'],
    'ostim-pane.js': ['anim'],       // OStim body lives inside the Animations tab
    'faces-pane.js': ['faces'],
    'time-pane.js': ['time'],
    'finances-pane.js': ['finances'],
    'bases-pane.js': ['domains']     // Bases is a mode of the Domains tab
  };

  /* Global pane object per tab id — used to re-fire onShow when the pane lands and
   * its tab is already the active one. Mirrors setTab's own dispatch. */
  var PANE_FOR_TAB = {
    followers: 'FolPane', wardrobe: 'WardrobePane', domains: 'DomainsPane',
    containers: 'ContainersPane', rooms: 'RoomsPane', loot: 'LootPane',
    keys: 'KeysPane', items: 'ItemsPane', npcs: 'NpcsPane', mounts: 'MountsPane',
    sheet: 'CharSheetPane', anim: 'AnimPane', faces: 'FacesPane', time: 'TimePane',
    finances: 'FinancesPane'
  };

  /* ------------------------------------------------------------------ stub set ----
   * Every reply-fn a DEFERRED script defines that C++ can push UNPROMPTED (verified:
   * each has a matching Invoke/reply literal in src/), and whose ROOT definition is
   * a deferred file — so it can be undefined when a push arrives during the window.
   *
   * SCOPE — the ONLY calls that can arrive before a deferred script parses are
   * C++ pushes that are UNPROMPTED (fired at open, not in reply to a view request).
   * A RESPONSE-style receiver (psResult after the view sent psGet, wdState after
   * wdOpen, fdNpcResult after fdRefresh, every *Result/*Data) cannot land before
   * its own pane loads, because the pane is what SENT the request — so it needs no
   * stub. That collapses the buffering set to exactly the reply-fns C++ Invoke()s
   * on the deck view (g_view) whose defining script is DEFERRED.
   *
   * DERIVED MECHANICALLY and pinned by the harness + the end-of-boot orphan check:
   *   { window.<fn>= OR chain('<fn>') in a deferred file }   (installed-by-deferred)
   *   ∩ { the literal "<fn>(" appears in src/ }               (C++ Invoke target)
   *   − { the same window.<fn>= exists in a CORE file }       (already present pre-DOM-ready)
   * EXCLUDED for cause: (a) module namespaces (FolPane, WardrobePane …) — never
   * Invoke()d; (b) core-defined-and-invoked (hdOpen / hdClosed / hdIconIndex /
   * hdIcons / hdExtKey / hdNativeMouse — app.js parses them before DOM-ready, so a
   * push can never precede them); (c) the HUD view's hudConfig/hudData/hudEdit —
   * those Invoke g_hudView, a DIFFERENT view whose hud.js the deck does not load;
   * (d) view→game REQUESTS (rgState/rgClaim/pdSave/finSettle/wdBuild … are
   * RegisterJSListener names the VIEW calls, never pushes C++ makes).
   *
   * These fall into two open-time groups: UNPROMPTED pushes fired from the open
   * block (main.cpp) that MUST resolve on the very first open, and the *Saved
   * write-acks (kept for defense-in-depth — a save is only ever requested from a
   * loaded pane, but stubbing the ack is free and cannot orphan since the pane
   * installs it). */
  var STUB_FNS = [
    // followers-pane.js — pushed unprompted at open (main.cpp ~4142-4198)
    'fdConfig', 'fdTarget', 'fdPortraits', 'fdCrops', 'fdState',
    'fdLiveParty', 'fdNff', 'fdFertility', 'hudCfgState', 'fdSaved',
    // domains-pane.js — pdOpen + pdHere unprompted at open (~4199-4201); pdSaved ack
    'pdOpen', 'pdHere', 'pdSaved',
    // containers-pane.js — ctOpen + ctTarget unprompted at open (~4203-4204); ctSaved ack
    'ctOpen', 'ctTarget', 'ctSaved',
    // rooms-pane.js — rgOpen unprompted at open (~4200); rgSaved ack (chained receivers)
    'rgOpen', 'rgSaved',
    // hd-door.js — drTarget unprompted at open (~4208; a null push closes a stale modal)
    'drTarget',
    // loot-pane.js — ltSaved ack (LootPane chains it; ltOpen arrives from LootPane.onShow,
    //   which cannot run before the pane is loaded, so ltOpen needs no stub)
    'ltSaved',
    // finances-pane.js — finSaved ack (finOpen/finState arrive from FinancesPane.onShow)
    'finSaved'
  ];

  /* Buffers of calls that arrived before the real fn landed. buf[fn] = [[args,t]…] */
  var buf = {};
  var stubOf = {};      // fn -> the exact stub function object we installed
  var replayed = {};    // fn -> true once its buffer has been flushed

  function installStub(fn) {
    if (typeof window[fn] === 'function') return;   // a real def already here (never for a deferred root)
    buf[fn] = buf[fn] || [];
    var s = function () {
      // Once drained, become a harmless no-op. This matters for the receive-panes
      // (rooms/loot/anim/finances/domains/ostim), whose install idiom is
      //   const prev = window[name]; window[name] = wrapper-that-also-calls-prev
      // so THIS stub survives as `prev` after the real handler chains over it.
      // Neutering on drain stops that leftover chain-call from re-buffering a call
      // the real handler already processed. Direct-overwrite panes (followers'
      // fdTarget etc.) drop the stub entirely and never reach this branch.
      if (s.__drained) return undefined;
      // record a shallow copy of arguments + a timestamp; replay reproduces the call
      try { buf[fn].push([Array.prototype.slice.call(arguments), perf()]); } catch (e) {}
      return undefined;   // C++ push sites ignore the return value
    };
    s.__hdStub = true;
    stubOf[fn] = s;
    window[fn] = s;
  }

  /* After a script lands, flush any stub whose real def has now landed — whether
   * the pane OVERWROTE window.fn outright or CHAINED a wrapper over the stub. In
   * both cases window.fn is no longer the bare stub, so replaying the buffer into
   * it reaches the real handler; then we neuter the stub so any residual
   * prev-chain call to it (the chain idiom) is a no-op rather than a re-buffer. */
  function flushReady() {
    for (var i = 0; i < STUB_FNS.length; i++) {
      var fn = STUB_FNS[i];
      if (replayed[fn]) continue;
      var cur = window[fn];
      if (typeof cur === 'function' && cur !== stubOf[fn]) {
        var q = buf[fn] || [];
        // neuter FIRST, so a wrapper that calls prev(stub) during replay no-ops
        // instead of re-buffering the very call we are replaying.
        if (stubOf[fn]) stubOf[fn].__drained = true;
        for (var j = 0; j < q.length; j++) {
          try { cur.apply(window, q[j][0]); }
          catch (e) { log('HDBoot: replay of ' + fn + ' threw: ' + e); }
        }
        if (q.length) log('HDBoot: replayed ' + q.length + ' buffered ' + fn + '() call' + (q.length === 1 ? '' : 's'));
        replayed[fn] = true;
        replayCount += q.length;
        buf[fn] = null;
      }
    }
  }

  var replayCount = 0;
  var started = false;
  var idx = 0;
  var t0 = 0;
  var loadedCount = 0;
  var failed = false;

  /* Re-run a just-landed pane's onShow if its tab is the one on screen (DR3), and
   * re-run FolPane.init() for followers (app.js init() skipped it because the
   * script wasn't loaded yet). Safe: both are feature-detected and idempotent. */
  function maybeHydrate(file) {
    try {
      if (file === 'followers-pane.js' && window.FolPane && typeof FolPane.init === 'function') {
        // app.js init() runs `if (window.FolPane) FolPane.init()`; with followers
        // deferred that was skipped, so do it now. FolPane.init wires pane-local
        // listeners + chainIcons() (which captures app.js's hdIconIndex as prev).
        FolPane.init();
      }
      var tabs = TAB_OWNER[file];
      if (!tabs) return;
      var active = window.__hdActiveTab;   // app.js publishes the live ui.tab here
      if (!active) return;
      if (tabs.indexOf(active) === -1) return;
      // the pane that owns the active tab just loaded — fire its onShow so the
      // skeleton the user is already staring at hydrates (never a blank pane).
      var paneName = PANE_FOR_TAB[active];
      var pane = paneName && window[paneName];
      if (pane && typeof pane.onShow === 'function') {
        pane.onShow();
        log('HDBoot: hydrated active tab "' + active + '" as ' + file + ' landed');
      }
    } catch (e) { log('HDBoot: hydrate(' + file + ') threw: ' + e); }
  }

  /* Sequential loader. Dynamically-created script nodes are async-by-default (do
   * NOT block DOMContentLoaded), and we chain them one at a time via onload so the
   * relative order — and therefore every prev-capture chain — is preserved exactly. */
  function loadNext() {
    if (idx >= MANIFEST.length) { finish(); return; }
    var file = MANIFEST[idx];
    var el = document.createElement('script');
    el.src = file;
    el.async = false;   // hint; sequencing is enforced by chaining on onload anyway
    el.onload = function () {
      loadedCount++;
      flushReady();       // a real reply-fn may have just replaced its stub
      maybeHydrate(file); // FolPane.init + active-tab onShow if this pane owns it
      idx++;
      loadNext();
    };
    el.onerror = function () {
      // Local file failed => broken install (these are on-disk files, not network).
      // Retrying THIS one via another mechanism cannot fix a genuinely-missing file,
      // so log loudly and eager-load the REMAINDER (idx+1..end) — the failed pane
      // simply won't work, exactly as it wouldn't under the old single-stage boot,
      // and every other pane still loads. Skipping idx+1 (not idx) is also what
      // keeps a script from being appended twice.
      failed = true;
      log('HDBoot: FAILED to load ' + file + ' — falling back to eager load of the remaining '
        + (MANIFEST.length - idx - 1) + ' scripts');
      eagerRemainder(idx + 1);
    };
    document.head.appendChild(el);
  }

  /* Fallback: append the remaining scripts as ordinary nodes and let the browser
   * serialize them; then run finish() once the last one loads (or errors). */
  function eagerRemainder(from) {
    var rest = MANIFEST.slice(from);
    var done = 0;
    if (!rest.length) { finish(); return; }
    rest.forEach(function (file) {
      var el = document.createElement('script');
      el.src = file;
      el.async = false;
      var after = function () {
        loadedCount++;
        flushReady();
        maybeHydrate(file);
        if (++done === rest.length) finish();
      };
      el.onload = after;
      el.onerror = function () { log('HDBoot: eager fallback also failed on ' + file); after(); };
      document.head.appendChild(el);
    });
  }

  var finished = false;
  function finish() {
    if (finished) return;   // both loadNext(end) and eagerRemainder can reach here — once only
    finished = true;
    flushReady();   // last pass
    var full = perf() - t0;
    // Completeness self-check (VERIFICATION BAR (a)): every stubbed fn must have
    // been overwritten by a real definition by now. A stub still live = a global
    // we buffered but nothing ever defined — either a wrong STUB_FNS entry or a
    // pane that stopped defining it. Name it loudly so it cannot rot silently.
    var orph = [];
    for (var i = 0; i < STUB_FNS.length; i++) {
      var fn = STUB_FNS[i];
      if (window[fn] === stubOf[fn]) orph.push(fn);
    }
    if (orph.length) {
      log('HDBoot: ERROR — ' + orph.length + ' stub(s) never replaced by a real definition: ' + orph.join(', '));
    }
    // Startup timing (VERIFICATION BAR / DR5): the deferred phase, logged on its own.
    // app.js already logged "boot→core-ready" (the synchronous core parse), and its
    // __hdBootDone hook below composes the two into one "full-boot" line.
    log('open-diag(startup): staged-boot — deferred ' + MANIFEST.length + ' scripts '
      + (window.HDPerf ? HDPerf.fmt(full) : Math.round(full)) + ' ms | buffered-replays ' + replayCount
      + (failed ? ' | FELL BACK to eager load' : '')
      + (orph.length ? ' | ORPHAN STUBS ' + orph.length : ''));
    // Let app.js fold this into its own startup line if it is still waiting.
    if (typeof window.__hdBootDone === 'function') { try { window.__hdBootDone({
      deferred: MANIFEST.length, ms: full, replays: replayCount, failed: failed, orphans: orph
    }); } catch (e) {} }
    window.HDBoot.done = true;
    window.HDBoot.stats = { deferred: MANIFEST.length, ms: full, replays: replayCount, failed: failed, orphans: orph };
  }

  /* Install the stubs NOW, at core parse time, before anything can push. */
  try {
    for (var i = 0; i < STUB_FNS.length; i++) installStub(STUB_FNS[i]);
  } catch (e) {
    log('HDBoot: stub install threw (' + e + ') — deferred set will still load, unbuffered');
  }

  window.HDBoot = {
    /* Called by app.js init() the instant the core deck is interactive. Idempotent. */
    start: function () {
      if (started) return;
      started = true;
      t0 = perf();
      try { loadNext(); }
      catch (e) {
        // If sequential injection itself throws, fall back to eager for ALL of it.
        log('HDBoot: loader threw (' + e + ') — eager-loading the whole deferred set');
        eagerRemainder(0);
      }
    },
    /* introspection for the harness */
    _manifest: MANIFEST,
    _stubFns: STUB_FNS,
    _buffer: buf,
    _flush: flushReady,
    _installStub: installStub,
    done: false
  };
})();
