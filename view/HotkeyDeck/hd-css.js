'use strict';
/* ============================ HDCss — staged / lazy stylesheets ============================ *
 *
 *  WHAT THIS IS.  hd-boot.js stages the deck's JAVASCRIPT (2.6 MB down to ~560 KB
 *  before DOM-ready). Its CSS was never staged: 33 <link> tags, ~1.15 MB, 8,300
 *  selectors, every one of them parsed synchronously before first paint and then
 *  matched against every DOM write for the rest of the session. Measured in Blink
 *  (whose CSS engine is far faster than Ultralight's): DOMContentLoaded 56 ms with
 *  all 33 sheets vs 18 ms with the core set, and 2,000 per-row class writes cost
 *  3.5 ms against the full rule set. This file is the CSS half of staged boot.
 *
 *  THE SHAPE.  index.html keeps ALL 33 <link> nodes in their original document
 *  order, but the lazy ones carry no rel/href — they are inert PLACEHOLDERS:
 *
 *      <link data-hdcss="npcs-pane.css" data-hdcss-key="npcs" data-hdcss-gate="#nx-pane">
 *
 *  and the real <link rel="stylesheet"> is inserted immediately BEFORE its
 *  placeholder when the key is first needed. Keeping the slot is not decoration:
 *  the cascade is document order, several sheets deliberately override app.css
 *  (zaz-pane.css says so in its own header), and hd-scale.css must stay LAST.
 *  Appending late sheets to the end of <head> would silently reorder the cascade.
 *
 *  NO UNSTYLED FLASH, BY CONSTRUCTION.  Every lazy sheet declares the SELECTOR of
 *  the DOM it owns (data-hdcss-gate). At parse time — before <body> is parsed, so
 *  before anything can paint — this file emits one gate rule per selector
 *
 *      html.hdcss-w-<key> <gate> { display: none !important; }
 *
 *  and stamps `hdcss-w-<key>` onto <html>. So the gate is ON from the first byte
 *  and is only ever LIFTED, when that key's sheet has actually applied (its
 *  <link> onload). Nothing the deck can do — a tab switch, a C++ deep-open, a
 *  popout that mounts itself, a trigger that misses — can paint that DOM before
 *  its stylesheet is live; the worst case is that it stays invisible a few ms
 *  longer. That is why the guarantee does not depend on the triggers below being
 *  complete or correctly ordered.
 *
 *  TRIGGERS (latency only, never correctness):
 *    1. TABS — hd-boot calls armTabs() once the deck is interactive; it wraps
 *       window.setTab (the single production choke point: every route into a pane,
 *       including C++'s hdShowTab deep-open and Omni's jump, goes through it) and
 *       window.render (a catch-all for the internal redirects setTab does to
 *       itself — 'finder' resolving to items/npcs, a gated-off tab bouncing to
 *       home — which the wrapper cannot see from its argument).
 *    2. POPOUTS — armModule() wraps the exported open()/toggle() of each popout
 *       module as its script lands, so the sheet starts loading on the call.
 *    3. BACKSTOP — a MutationObserver on body / #overlay / #panel (childList,
 *       NOT subtree) catches any root that mounts without going through a wrapped
 *       export (hd-door's drTarget push, a module's internal open()). Observer
 *       callbacks run as a microtask, i.e. before the frame paints, so this is a
 *       real guarantee and not a race. Every trigger funnels into need(), which
 *       is idempotent, so firing three times costs one load.
 *
 *  FAILURE = FALL BACK TO TODAY.  A sheet that errors, or takes longer than
 *  LOAD_LEASH ms, has its gate lifted anyway and logs loudly: unstyled-but-present
 *  beats invisible-forever. If this file throws at install time, window.HDCss is
 *  still defined with a need() that no-ops and every placeholder is loaded eagerly,
 *  i.e. the deck degrades to exactly the pre-staging behaviour. index.html carries
 *  a matching fallback for the case where this file is missing entirely.
 *
 *  ADDING A LAZY SHEET.  Put the placeholder in index.html with its key + gate
 *  selector(s). A TAB pane whose key equals its tab id needs nothing else —
 *  needForTab falls back to the key registry when the TAB_KEY map has no entry
 *  (added 2026-08-18 after the High King tab shipped gated-invisible: the map
 *  entry was forgotten, no other trigger could see a STATIC pane section, and
 *  the tab drew blank forever). Popouts and non-tab roots still need their
 *  MODULE_KEY / ROOT_ID / ROOT_CLASS trigger — the backstop observer only sees
 *  roots INSERTED into body/#overlay/#panel, never static DOM.
 *
 *  Marker: HDCss (view identity).
 * =========================================================================================== */
(function () {
  var LOAD_LEASH = 3000;   // ms before a stuck sheet's gate is lifted regardless

  function log(line) {
    if (window.HDPerf && typeof HDPerf.log === 'function') { HDPerf.log(line); return; }
    var f = window.hdLog;
    if (typeof f === 'function') { try { f(String(line)); } catch (e) {} }
    else if (window.console) console.log('[hdcss] ' + line);
  }

  /* ------------------------------------------------------------------ triggers ----
   * ui.tab value -> css key. Only tabs whose pane has a lazy sheet appear; a tab
   * styled entirely by app.css (home, hotkeys, quests, notes, numpad, followers'
   * roster, domains' own body, containers, rooms, loot, faces, finances, light,
   * time, wardrobe's body, anim's pose list) has no entry and costs nothing. */
  var TAB_KEY = {
    wardrobe: 'wardrobe', keys: 'keys', items: 'items', npcs: 'npcs',
    journal: 'journal', settle: 'settle', wigs: 'wigs', survival: 'survival',
    spellcraft: 'spellcraft', transmog: 'transmog', mounts: 'mounts',
    anim: 'anim', sheet: 'sheet', domains: 'domains', followers: 'followers',
    highking: 'highking'
  };

  /* [global module name, methods that can mount its DOM, css key]. Wrapping the
   * EXPORT only catches external calls — a module's internal open() is a closure
   * local and is invisible from here — which is exactly why the observer exists.
   *
   * ⚠ A popout's FIRST open is AWAITED, not gated (see armModule): these modules
   * size themselves from live layout at open time (the quiver measures its stage,
   * the anchored popouts measure their own box to place it), so opening one into
   * a stylesheet that has not applied yet bakes in the wrong numbers and nothing
   * ever re-measures. Proven, not theorised: a computed-style diff of the whole
   * deck against the pre-staging build showed exactly one regression, the quiver's
   * stage coming out 784px instead of 540px. Awaiting the sheet is what closes it.
   * That is why `onKey` is deliberately NOT wrapped anywhere here — deferring a
   * keystroke could drop it; open()/toggle() are the only calls that mount DOM. */
  var MODULE_KEY = [
    ['HDWheel',     ['open', 'toggle'],          'wheel'],
    ['HDPotions',   ['open'],                    'potions'],
    ['HDQuiver',    ['open'],                    'quiver'],
    ['HDSurvival',  ['open'],                    'survival'],   // shares the tab's key: see index.html
    ['HDSuper',     ['open', 'openConfig'],      'super'],      // Super Searcher: widget skin + config popup
    ['HDFormation', ['open'],                    'formation'],
    ['HDDoor',      ['open'],                    'door'],
    ['HDOutfit',    ['open', 'show'],            'outfit'],
    ['HDQuests',    ['open'],                    'npcquests'],
    ['HDSpidGear',  ['open'],                    'followers'],
    ['ChimBtn',     ['open'],                    'chim'],
    ['FixBtn',      ['open'],                    'chim'],       // the Fixes popout lives in chim-flyout.css
    ['SmPane',      ['open'],                    'followers'],
    ['HDLightbox',  ['open'],                    'lightbox'],
    ['HDItemPick',  ['open'],                    'itempick'],
    ['HDMcm',       ['open'],                    'mcm'],
    ['AppearanceGallery', ['open'],              'appearances'],
    ['WigsPane',    ['openFor'],                 'wigs']        // the NPC card's Wigs… popout hosts the gated #wv-pane (2026-09-23)
  ];

  /* Backstop map: the id / class of a gated root -> its key. Kept as plain lookups
   * (no querySelector) so the observer callback stays O(1) per inserted node. */
  var ROOT_ID = {
    'hd-wheel': 'wheel', 'hd-potions': 'potions', 'hd-quiver': 'quiver',
    'hd-survival': 'survival', 'hd-super': 'super', 'fm-modal': 'formation', 'dr-modal': 'door',
    'hdo-layer': 'outfit', 'hdq-layer': 'npcquests', 'sg-modal': 'followers',
    'mc-modal': 'mcm', 'appearance-gallery': 'appearances'
  };
  var ROOT_CLASS = [
    ['chim-fly', 'chim'], ['fx-back', 'chim'], ['sm-pop', 'followers'], ['sdp-back', 'followers'],
    ['hdlb', 'lightbox'], ['ip-wrap', 'itempick']
  ];

  /* ------------------------------------------------------------------ registry ---- */
  var reg = {};        // key -> { nodes:[placeholder…], gates:[sel…], state, cbs:[], pending, t0 }
  var keys = [];
  var armedTabs = false;
  var armedMods = {};
  var loadedCount = 0;

  function discover() {
    var ph = document.querySelectorAll('link[data-hdcss]');
    for (var i = 0; i < ph.length; i++) {
      var el = ph[i];
      var file = el.getAttribute('data-hdcss');
      var key = el.getAttribute('data-hdcss-key') || file;
      var gate = el.getAttribute('data-hdcss-gate') || '';
      if (!file) continue;
      var r = reg[key];
      if (!r) { r = reg[key] = { nodes: [], gates: [], state: 'idle', cbs: [], pending: 0, t0: 0 }; keys.push(key); }
      r.nodes.push(el);
      if (gate) {
        var parts = gate.split(',');
        for (var j = 0; j < parts.length; j++) {
          var s = parts[j].trim();
          if (s && r.gates.indexOf(s) === -1) r.gates.push(s);
        }
      }
    }
  }

  /* Emit the gate rules and stamp <html>. Both happen at PARSE time, from inside
   * <head>, so no gated DOM can ever have been laid out unstyled. */
  function installGates() {
    var css = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], r = reg[k];
      if (!r.gates.length) continue;
      var sel = [];
      for (var j = 0; j < r.gates.length; j++) sel.push('html.hdcss-w-' + k + ' ' + r.gates[j]);
      css.push(sel.join(',\n') + ' { display: none !important; }');
      document.documentElement.classList.add('hdcss-w-' + k);
    }
    if (!css.length) return;
    var st = document.createElement('style');
    st.id = 'hd-css-gates';
    st.appendChild(document.createTextNode(
      '/* HDCss gates — a lazy sheet\'s DOM stays display:none until that sheet has\n' +
      '   applied. Added at parse time, removed one key at a time by hd-css.js. */\n' +
      css.join('\n')));
    document.head.appendChild(st);
  }

  function lift(key) {
    try { document.documentElement.classList.remove('hdcss-w-' + key); } catch (e) {}
  }

  function settle(key, how) {
    var r = reg[key];
    if (!r || r.state === 'ready') return;
    r.state = 'ready';
    if (r.leash) { clearTimeout(r.leash); r.leash = 0; }
    if (r.poll) { clearInterval(r.poll); r.poll = 0; }
    lift(key);
    if (how !== 'ok') {
      log('HDCss: ERROR — "' + key + '" ' + how + '; showing it UNSTYLED rather than hiding it');
    }
    var cbs = r.cbs; r.cbs = [];
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](); } catch (e) { log('HDCss: callback for ' + key + ' threw: ' + e); }
    }
  }

  /* Load a key's sheet(s) if they are not already in flight/done.
   * Returns TRUE when the styles are live NOW (so cb ran synchronously — the
   * steady-state path, and the reason a second open of a popout is not delayed),
   * FALSE when the caller has to wait. cb is optional. */
  function need(key, cb) {
    var r = reg[key];
    if (!r) { if (cb) { try { cb(); } catch (e) {} } return true; }
    if (r.state === 'ready') { if (cb) { try { cb(); } catch (e) {} } return true; }
    if (cb) r.cbs.push(cb);
    if (r.state === 'loading') return false;
    r.state = 'loading';
    r.pending = r.nodes.length;
    r.links = [];
    r.t0 = (window.HDPerf && HDPerf.now) ? HDPerf.now() : Date.now();
    var done = function (link) {
      if (link) { if (link.__hdDone) return; link.__hdDone = true; }
      if (--r.pending > 0) return;
      loadedCount++;
      var ms = ((window.HDPerf && HDPerf.now) ? HDPerf.now() : Date.now()) - r.t0;
      log('HDCss: "' + key + '" +' + r.nodes.length + ' sheet' + (r.nodes.length === 1 ? '' : 's')
        + ' in ' + (window.HDPerf ? HDPerf.fmt(ms) : Math.round(ms)) + ' ms');
      settle(key, 'ok');
    };
    for (var i = 0; i < r.nodes.length; i++) {
      var ph = r.nodes[i];
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.onload = (function (l) { return function () { done(l); }; })(link);
      link.onerror = (function (l, file) {
        return function () { log('HDCss: FAILED to load ' + file); done(l); };
      })(link, ph.getAttribute('data-hdcss'));
      link.href = ph.getAttribute('data-hdcss');
      /* BEFORE the placeholder: that is the sheet's original cascade slot. */
      if (ph.parentNode) ph.parentNode.insertBefore(link, ph);
      else document.head.appendChild(link);
      r.links.push(link);
    }
    /* BELT AND BRACES — do not bet the gate on the load EVENT.
     * `link.sheet` becoming non-null is the DOM's own statement that the
     * stylesheet is parsed and applied; the load event is a separate promise
     * that this engine (Ultralight, not Blink) is not verified to keep. Poll for
     * the authoritative signal and settle on whichever arrives first, so a
     * missing load event costs a few ms rather than the whole LOAD_LEASH. */
    r.poll = setInterval(function () {
      for (var j = 0; j < r.links.length; j++) {
        var l = r.links[j];
        if (l.__hdDone) continue;
        var live = false;
        try { live = !!l.sheet; } catch (e) { live = false; }
        if (live) done(l);
      }
    }, 8);
    /* A local file that never answers must not leave its DOM invisible forever. */
    r.leash = setTimeout(function () { settle(key, 'did not load within ' + LOAD_LEASH + ' ms'); }, LOAD_LEASH);
    return false;
  }

  function needAll(why) {
    for (var i = 0; i < keys.length; i++) need(keys[i]);
    if (why) log('HDCss: loaded every lazy sheet eagerly (' + why + ')');
  }

  /* ------------------------------------------------------------------ tab arming ----
   * Wraps setTab (pre-need, so the load starts before render paints) and render
   * (post-need catch-all: setTab redirects to itself internally — 'finder' ->
   * items/npcs, a gated-off tab -> home — and those never reach our argument). */
  function armTabs() {
    armObserver();          // #overlay / #panel exist by now; see armObserver
    if (armedTabs) return;
    armedTabs = true;
    try {
      var realSetTab = window.setTab;
      if (typeof realSetTab === 'function') {
        window.setTab = function (t) {
          try { needForTab(t); } catch (e) {}
          var out = realSetTab.apply(this, arguments);
          try { needForTab(window.__hdActiveTab); } catch (e) {}
          return out;
        };
      }
      var realRender = window.render;
      if (typeof realRender === 'function') {
        window.render = function () {
          var out = realRender.apply(this, arguments);
          try { needForTab(window.__hdActiveTab); } catch (e) {}
          return out;
        };
      }
    } catch (e) { log('HDCss: armTabs threw (' + e + ') — loading every sheet eagerly'); needAll('armTabs failed'); }
  }

  function needForTab(tab) {
    var t = String(tab || '');
    /* Explicit map first, then the CONVENTION: a pane's css key equals its tab
     * id (keys/items/npcs/… all do). Without this fallback a new gated tab whose
     * author forgets the TAB_KEY entry is display:none FOREVER — the pane renders
     * perfectly under a gate nothing ever lifts. That is exactly the High King
     * blank-tab of 2026-08-18: gate installed at parse, no trigger, invisible.
     * reg[] only holds keys that declared a placeholder, so this can never load
     * anything a stray tab name invents. */
    var key = TAB_KEY[t] || (reg[t] ? t : '');
    if (!key) return;
    var r = reg[key];
    if (!r || r.state === 'ready') return;
    /* Already in flight: its rehydrate callback is registered. Re-registering on
     * every render() during the load window would re-fire the pane's onShow once
     * per repaint, which is a bridge-request storm, not a hydration. */
    if (r.state === 'loading') return;
    need(key, function () { rehydrate(tab); });
  }

  /* The pane rendered into a display:none subtree while its gate held, so anything
   * it measured (journal's pagination, wigs' grid, bases' narrow test) measured
   * zero. Re-firing onShow once the styles are live is the SAME hydration hd-boot
   * already performs when a pane's script lands on the active tab — same map, same
   * idempotency assumption — so this adds no new contract. */
  function rehydrate(tab) {
    try {
      if (window.__hdActiveTab !== tab) return;   // user moved on; nothing to fix
      var map = (window.HDBoot && HDBoot._paneForTab) || null;
      var name = map && map[tab];
      var pane = name && window[name];
      if (pane && typeof pane.onShow === 'function') {
        pane.onShow();
        log('HDCss: re-hydrated "' + tab + '" after its stylesheet landed');
      }
    } catch (e) { log('HDCss: rehydrate(' + tab + ') threw: ' + e); }
  }

  /* ------------------------------------------------------------------ module arming ---- */
  function armModule(name) {
    for (var i = 0; i < MODULE_KEY.length; i++) {
      var spec = MODULE_KEY[i];
      if (name && spec[0] !== name) continue;
      if (armedMods[spec[0]]) continue;
      var mod = window[spec[0]];
      if (!mod) continue;
      var wrapped = 0;
      for (var j = 0; j < spec[1].length; j++) {
        var m = spec[1][j];
        if (typeof mod[m] !== 'function' || mod[m].__hdCss) continue;
        mod[m] = (function (fn, key) {
          var w = function () {
            var r = reg[key];
            /* Steady state — and every state after the first open — is a plain
             * synchronous call: no timing change at all. */
            if (!r || r.state === 'ready') return fn.apply(this, arguments);
            /* First open: run it once the sheet has applied, so the module
             * measures a styled layout. Deferring is safe for these entry points
             * because none of them reads live event state — an anchor arrives as
             * an already-resolved ELEMENT argument (`e.currentTarget` is evaluated
             * at the call site, inside the handler), and the element is still in
             * the DOM a few ms later. Nothing consumes their return value; the
             * one caller shape that looks at state (hdShowTab's isOpen() toggle
             * guard) is already protected by its own 700 ms open-guard. */
            var self = this, args = arguments;
            need(key, function () { try { fn.apply(self, args); } catch (e) { log('HDCss: deferred ' + key + ' open threw: ' + e); } });
            return undefined;
          };
          w.__hdCss = true;
          return w;
        })(mod[m], spec[2]);
        wrapped++;
      }
      if (wrapped) armedMods[spec[0]] = true;
    }
  }

  /* Arm everything already present (core modules at hd-boot.start(), and a sweep
   * at the end of staged boot). Cheap: a handful of typeof checks. */
  function armAll() { armModule(null); }

  /* ------------------------------------------------------------------ backstop ---- */
  function keyForNode(n) {
    if (!n || n.nodeType !== 1) return null;
    if (n.id && ROOT_ID[n.id]) return ROOT_ID[n.id];
    var cl = n.classList;
    if (!cl) return null;
    for (var i = 0; i < ROOT_CLASS.length; i++) if (cl.contains(ROOT_CLASS[i][0])) return ROOT_CLASS[i][1];
    return null;
  }

  var obs = null;
  var observed = {};

  /* Idempotent, and called more than once ON PURPOSE: this file parses inside
   * <head>, where document.body / #overlay / #panel do not exist yet, so the
   * first call can only arm what is already there. It is re-called at
   * DOMContentLoaded and again from armTabs(), by which point all three hosts
   * exist. Nothing gated can mount before app.js init() runs, so there is no
   * window in which the backstop is missing. */
  function armObserver() {
    if (typeof MutationObserver !== 'function') return;
    if (!obs) {
      obs = new MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          var added = recs[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var k = keyForNode(added[j]);
            if (k && reg[k] && reg[k].state !== 'ready') need(k);
          }
        }
      });
    }
    var hosts = [['body', document.body], ['overlay', document.getElementById('overlay')],
                 ['panel', document.getElementById('panel')]];
    for (var i = 0; i < hosts.length; i++) {
      var name = hosts[i][0], el = hosts[i][1];
      if (!el || observed[name]) continue;
      /* childList only, subtree OFF: every gated root mounts as a DIRECT child of
       * one of these three (verified per module), and a subtree observer over the
       * whole deck would fire on every render. */
      try { obs.observe(el, { childList: true }); observed[name] = true; } catch (e) {}
    }
    /* The lightbox and the item picker mount into a caller-supplied pane <section>
     * rather than one of the three hosts, so they rely on their wrapped export —
     * which is reliable, being the only way a pane can reach them. */
  }

  /* ------------------------------------------------------------------ completeness ----
   * Called by hd-boot when the deferred script phase ends. A key whose trigger can
   * never fire (module renamed, export dropped) would leave its DOM permanently
   * invisible, which is worse than the flash we are avoiding — so name it loudly
   * and load it. Mirrors hd-boot's orphan-stub check. */
  function audit() {
    armAll();
    var orphan = [];
    for (var i = 0; i < MODULE_KEY.length; i++) {
      var spec = MODULE_KEY[i];
      var mod = window[spec[0]];
      var ok = false;
      if (mod) for (var j = 0; j < spec[1].length; j++) if (typeof mod[spec[1][j]] === 'function' && mod[spec[1][j]].__hdCss) ok = true;
      if (!ok && reg[spec[2]] && reg[spec[2]].state !== 'ready' && orphan.indexOf(spec[2]) === -1) orphan.push(spec[2]);
    }
    if (orphan.length) {
      log('HDCss: ERROR — no live trigger for ' + orphan.length + ' key(s): ' + orphan.join(', ')
        + ' — loading them now so nothing can stay invisible');
      for (var k = 0; k < orphan.length; k++) need(orphan[k]);
    }
    var lazy = 0;
    for (var m = 0; m < keys.length; m++) if (reg[keys[m]].state !== 'ready') lazy++;
    log('open-diag(startup): staged-css — ' + keys.length + ' lazy key(s), ' + (keys.length - lazy)
      + ' loaded so far, ' + lazy + ' still unpaid for');
  }

  try {
    discover();
    installGates();
    armObserver();
    /* …and again once <body> exists, in case hd-boot never runs (a broken install
     * still gets the backstop). */
    if (document.addEventListener) document.addEventListener('DOMContentLoaded', armObserver, false);
    window.HDCss = {
      need: need, needAll: needAll, armTabs: armTabs, armModule: armModule,
      armAll: armAll, audit: audit,
      ready: function (k) { return !reg[k] || reg[k].state === 'ready'; },
      keys: function () { return keys.slice(); },
      /* introspection for the harness */
      _reg: reg, _tabKey: TAB_KEY, _moduleKey: MODULE_KEY,
      _rootId: ROOT_ID, _rootClass: ROOT_CLASS,
      _loaded: function () { return loadedCount; }
    };
  } catch (e) {
    /* Never let a staging bug cost the deck its styles. */
    try {
      var ph = document.querySelectorAll('link[data-hdcss]');
      for (var i = 0; i < ph.length; i++) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = ph[i].getAttribute('data-hdcss');
        ph[i].parentNode.insertBefore(l, ph[i]);
      }
      var cls = document.documentElement.className.split(/\s+/);
      for (var c = 0; c < cls.length; c++) if (cls[c].indexOf('hdcss-w-') === 0) document.documentElement.classList.remove(cls[c]);
    } catch (e2) {}
    window.HDCss = {
      need: function (k, cb) { if (cb) try { cb(); } catch (x) {} return true; },
      needAll: function () {}, armTabs: function () {}, armModule: function () {},
      armAll: function () {}, audit: function () {}, ready: function () { return true; },
      keys: function () { return []; }, _reg: {}, _loaded: function () { return 0; }
    };
    log('HDCss: install threw (' + e + ') — every stylesheet loaded eagerly, gates cleared');
  }
})();
