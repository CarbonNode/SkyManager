'use strict';
/* ============================ HDIconMip — small icons drawn from small sources ============================
 *
 *  WHY (Rober, 2026-10-10, a screenshot of the Weather chips: "these icons, they are
 *  pixelated").  Measured in PrismaUI's own Ultralight with tools/ultralight-probe
 *  (icons-probe, 2026-10-10): the engine draws an <img> by sampling its source at the
 *  final screen size with NO mipmaps. The custom icons are 256px line art; at 20px that
 *  is a 12.8x shrink, and a 6px stroke comes out as a row of dots. `image-rendering`
 *  changes nothing. A source within ~3x of the drawn size is clean at ANY --ui-scale:
 *  the engine samples at the TRANSFORMED size, so the tier is chosen from the on-screen
 *  rect, not the layout box.
 *
 *  WHAT.  tools/make_icon_mips.py ships every icons/custom/<n>.png as
 *  icons/custom/mip/{32,64,128}/<n>.png (the small tiers also thicken thin line art).
 *  This file watches the DOM and points each icons/custom <img> at the smallest tier
 *  that is still >= 1.45x its drawn size; past 88 screen px it keeps the original.
 *  Every call site keeps writing the plain 'icons/custom/<n>.png' — nothing else in the
 *  view needs to know mips exist, and a pane written tomorrow gets them for free.
 *
 *  Pictures with NO shipped mips (the plugin's 512-1024px item / NPC / mount / body
 *  renders, icons uploaded from the Portal) are shrunk at runtime instead: a canvas
 *  halving 2:1 per step to the drawn size, then a data: URL (see "runtime-shrunk").
 *
 *  An inline `background-image: url(...)` of the same art is handled exactly like an <img>.
 *
 *  RULES IT KEEPS.
 *   - Never throws: an uncaught error during load takes down PrismaUI's SHARED renderer
 *     (ultralight-probe README, trap 5). Every entry point is wrapped.
 *   - A mip that fails to load (an icon uploaded from the Portal after the mips were
 *     built) falls back to the original once, and that name is not tried again.
 *   - A hidden <img> (its pane is display:none) has no rect: it is sized from its CSS
 *     width/height x --ui-scale, or, when that is 'auto', re-checked on the next input.
 *   - No query strings: Ultralight drops '?v=' (hud.js says so where it learned it).
 *   - Opt out per image with data-no-mip. Code that needs the file path reads
 *     data-icmip-src (the src attribute may be a mip path or a data: URL).
 *
 *  Shared, byte-identical, by HotkeyDeck and MagicDeck (the roots cannot see each other);
 *  each root has its OWN generated hd-icon-mip-list.js, loaded just before this file.
 *  app.js's applyScale() calls hdIconMip.rescan() when the zoom changes.
 * ============================================================================================== */
(function () {
  if (window.hdIconMip) return;
  var RX = /^(.*?)icons\/custom\/([^\/?#]+\.png)$/i;
  var TIERS = [32, 64, 128];
  var HEADROOM = 1.45;
  var has = Object.create(null);       // names that ship mips (hd-icon-mip-list.js)
  try {
    String(window.HD_ICON_MIPS || '').split('|').forEach(function (n) { if (n) has[n + '.png'] = 1; });
  } catch (e) {}
  var pending = [];                     // hidden, unsized: re-check on input
  var PENDING_CAP = 3000;
  var queued = false;

  function uiScale() {
    try {
      var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'));
      return isFinite(v) && v > 0 ? v : 1;
    } catch (e) { return 1; }
  }

  /* On-screen size in px, or 0 when it cannot be known yet. */
  function screenSize(img) {
    var r = img.getBoundingClientRect();
    var s = Math.max(r.width, r.height);
    if (s > 0) return s;
    var cs = getComputedStyle(img);
    var w = /px$/.test(cs.width) ? parseFloat(cs.width) : 0;
    var h = /px$/.test(cs.height) ? parseFloat(cs.height) : 0;
    var m = Math.max(w || 0, h || 0);
    return m > 0 ? m * uiScale() : 0;
  }

  function tierFor(px) {
    var need = px * HEADROOM;
    for (var i = 0; i < TIERS.length; i++) if (need <= TIERS[i]) return TIERS[i];
    return 0;   // the original
  }

  /* Belt and braces: the list says a mip exists but the file is not on disk (icons are
     copied to the live tree by hand). Put the original back, unless a call site's own
     error ladder has already moved the image on, and stop trying that name. */
  function onError() {
    var img = this, orig = img.getAttribute('data-icmip-src');
    img.removeEventListener('error', onError);
    if (!orig || img.getAttribute('src') !== img.__icmip) return;
    var m = RX.exec(orig);
    if (m) delete has[m[2]];
    img.__icmip = orig;
    img.setAttribute('src', orig);
  }

  /* ---- runtime-shrunk pictures ---------------------------------------------------
     Pictures with no shipped mips (item / NPC / mount / body renders the plugin writes
     at 512-1024px, 128px Spell Hotbar icons, icons uploaded from the Portal) are shrunk HERE: a canvas
     halving 2:1 per step down to the drawn size, then a data: URL. Measured in
     Ultralight (render-probe, 2026-10-10): a one-step canvas shrink is as grainy as the
     raw <img>; halving is clean; toDataURL is allowed for the view's own files.
     Work is spread over frames, and results are cached per (file, size). */
  /* Only the art folders: generated renders and custom icons. Photos, portraits and
     journal pictures are left alone — their editors do crop / drag maths on the image
     and hand img.src to callbacks (domain-areas.js onLoad). */
  var LOCAL = /^(?!data:|https?:|blob:|file:)(?:[^?#]*\/)?icons\/(?:items|npcs|mounts|faces|bodies|pubes|custom|sh)\/[^?#]+\.(png|jpe?g|webp)$/i;
  var RATIO = 3;                  // shrink only when the source is > 3x the drawn size
  var shrunk = new Map();         // orig|w|h -> data URL
  var SHRUNK_CAP = 900;
  var loaders = new Map();        // orig -> { img, ready, waiters }
  var LOADER_CAP = 240;
  var jobs = [], jobsQueued = false;

  function loadOrig(orig, then) {
    var l = loaders.get(orig);
    if (!l) {
      if (loaders.size >= LOADER_CAP) loaders.delete(loaders.keys().next().value);
      l = { img: new Image(), ready: false, failed: false, waiters: [] };
      loaders.set(orig, l);
      l.img.onload = function () { l.ready = true; var w = l.waiters; l.waiters = []; w.forEach(function (f) { try { f(l.img); } catch (e) {} }); };
      l.img.onerror = function () { l.failed = true; l.waiters = []; };
      l.img.src = orig;
    }
    if (l.failed) return;
    if (l.ready) then(l.img); else l.waiters.push(then);
  }

  function shrinkTo(src, tw, th) {
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, cur = src;
    while (w / 2 >= tw && h / 2 >= th) {
      var t = document.createElement('canvas');
      t.width = Math.max(1, Math.round(w / 2)); t.height = Math.max(1, Math.round(h / 2));
      var tx = t.getContext('2d');
      tx.imageSmoothingEnabled = true;
      tx.drawImage(cur, 0, 0, t.width, t.height);
      cur = t; w = t.width; h = t.height;
    }
    var c = document.createElement('canvas');
    c.width = tw; c.height = th;
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.drawImage(cur, 0, 0, tw, th);
    return c.toDataURL('image/png');
  }

  /* The same art is also drawn as an inline background-image (equipped-item tiles on the
     follower cards). An element is handled through one accessor pair whatever it is: an
     <img>'s src attribute, or a single url(...) inline background. Gradients and layered
     backgrounds are left alone. */
  var BG_URL = /^url\(\s*["']?([^"')]+)["']?\s*\)$/;
  function getSrc(el) {
    if (el.tagName === 'IMG') return el.getAttribute('src');
    var b = el.style && el.style.backgroundImage;
    if (!b || b.indexOf('url(') === -1) return null;
    var m = BG_URL.exec(b.trim());
    return m ? m[1] : null;
  }
  function setSrc(el, v) {
    el.__icmip = v;
    if (el.tagName === 'IMG') el.setAttribute('src', v);
    else el.style.backgroundImage = 'url("' + v + '")';
  }

  /* Step 1 (any time): load the original once. Step 2 (frame budget): shrink it. */
  var ready = [];
  function applyShrunk(img, orig, px) {
    loadOrig(orig, function (src) { ready.push({ img: img, orig: orig, px: px, src: src }); queueJobs(); });
  }

  function finish(j) {
    var img = j.img, orig = j.orig, src = j.src;
    if (!img.isConnected || img.getAttribute('data-icmip-src') !== orig) return;   // moved on since
    var nw = src.naturalWidth, nh = src.naturalHeight;
    if (!(nw > 0 && nh > 0)) return;
    /* min side: right for object-fit:cover as well as contain */
    var k = j.px * HEADROOM / Math.min(nw, nh);
    if (k * RATIO >= 1) {                       // close enough: the original is fine
      if (getSrc(img) !== orig) setSrc(img, orig);
      return;
    }
    var tw = Math.max(1, Math.ceil(nw * k)), th = Math.max(1, Math.ceil(nh * k));
    var key = orig + '|' + tw + 'x' + th;
    var url = shrunk.get(key);
    if (!url) {
      url = shrinkTo(src, tw, th);
      if (shrunk.size >= SHRUNK_CAP) shrunk.delete(shrunk.keys().next().value);
      shrunk.set(key, url);
    }
    if (getSrc(img) !== url) setSrc(img, url);
  }

  function runJobs() {
    jobsQueued = false;
    var t0 = Date.now();
    while (ready.length && Date.now() - t0 < 8) {
      try { finish(ready.shift()); } catch (e) {}
    }
    while (jobs.length && Date.now() - t0 < 8) {
      var j = jobs.shift();
      try { if (j.img.isConnected) applyShrunk(j.img, j.orig, j.px); } catch (e) {}
    }
    if (jobs.length || ready.length) queueJobs();
  }
  function queueJobs() {
    if (jobsQueued) return;
    jobsQueued = true;
    (window.requestAnimationFrame || setTimeout)(runJobs);
  }

  /* Returns false when the image could not be sized yet (keep it pending). */
  function fit(img) {
    var src = getSrc(img);
    if (!src || img.hasAttribute('data-no-mip')) return true;
    var orig = img.getAttribute('data-icmip-src');
    if (src !== img.__icmip) {                 // a call site wrote a new src
      if (!LOCAL.test(src)) { if (orig) img.removeAttribute('data-icmip-src'); return true; }
      orig = src;
      img.setAttribute('data-icmip-src', orig);
    }
    if (!orig) return true;
    var px = screenSize(img);
    if (!(px > 0)) return false;
    var m = RX.exec(orig);
    if (m && has[m[2]]) {                      // a shipped icon: its mip tier
      var t = tierFor(px);
      var want = t ? m[1] + 'icons/custom/mip/' + t + '/' + m[2] : orig;
      if (want !== src) {
        if (t && img.tagName === 'IMG') img.addEventListener('error', onError);
        setSrc(img, want);
      }
      return true;
    }
    jobs.push({ img: img, orig: orig, px: px });   // anything else: shrink it here if it needs it
    queueJobs();
    return true;
  }

  function consider(el, out) {
    if (el.tagName === 'IMG') { if (el.getAttribute('src') !== el.__icmip) out.push(el); return; }
    var s = getSrc(el);
    if (s && s !== el.__icmip && (LOCAL.test(s) || el.hasAttribute('data-icmip-src'))) out.push(el);
  }
  var BG_SEL = '[style*="background-image"]';

  function run(list) {
    for (var i = 0; i < list.length; i++) {
      var img = list[i];
      try {
        if (!fit(img) && pending.length < PENDING_CAP) pending.push(img);
      } catch (e) {}
    }
  }

  function recheckPending() {
    queued = false;
    try {
      var keep = [], list = pending;
      pending = [];
      for (var i = 0; i < list.length; i++) {
        var img = list[i];
        if (!img.isConnected) continue;
        try { if (!fit(img)) keep.push(img); } catch (e) {}
      }
      pending = keep.concat(pending).slice(0, PENDING_CAP);
    } catch (e) {}
  }

  function soon() {
    if (queued || !pending.length) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(recheckPending);
  }

  function scanTree(root) {
    var out = [];
    try {
      if (root.nodeType !== 1) return;
      consider(root, out);
      if (root.getElementsByTagName) {
        var all = root.getElementsByTagName('img');
        for (var i = 0; i < all.length; i++) consider(all[i], out);
        var bgs = root.querySelectorAll(BG_SEL);
        for (var b = 0; b < bgs.length; b++) consider(bgs[b], out);
      }
    } catch (e) {}
    run(out);
  }

  /* open-mip-hidden-keep (2026-10-15): app.js's applyScale() runs on every deck open
     and at the end of every render(), so this ran two or three times per open over
     every <img> in the document (~800 by mid-session). For an image in a hidden pane
     the rect is 0 and screenSize() falls back to getComputedStyle, a full style
     resolution per element inside a display:none subtree: the bulk of the open's
     "render" time on tab=home. While --ui-scale is the one we last rescanned at, an
     image we already decided and that is hidden now keeps its decision: nothing can
     be seen of it, and the render() that shows its pane rescans it with a real rect.
     A changed --ui-scale still re-decides everything, exactly as before. */
  var lastRescanScale = 0;
  function hasBox(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function rescan() {
    try {
      var sc = uiScale(), same = sc === lastRescanScale;
      lastRescanScale = sc;
      var all = [].slice.call(document.getElementsByTagName('img')).concat([].slice.call(document.querySelectorAll(BG_SEL))), out = [];
      var kept = same ? new Set() : null;
      for (var i = 0; i < all.length; i++) {
        var img = all[i];
        var o = img.getAttribute('data-icmip-src');
        if (o) {
          if (kept && getSrc(img) === img.__icmip && !hasBox(img)) { kept.add(img); continue; }   // hidden, decided: keep
          img.__icmip = getSrc(img); out.push(img);                 // ours: re-decide from o
        }
        else if (LOCAL.test(getSrc(img) || '')) { img.__icmip = null; out.push(img); }
      }
      /* a kept image that was waiting for a size stays waiting (input re-checks it) */
      var was = pending;
      pending = [];
      if (kept && kept.size) for (var p = 0; p < was.length; p++) if (kept.has(was[p])) pending.push(was[p]);
      run(out);
    } catch (e) {}
  }

  /* Measuring forces layout. Collect what the mutations added and size it all in ONE
     pass on the next animation frame, where the layout the frame needs anyway is the
     one we read. The always-on HUD re-renders often; this keeps it to one layout. */
  var batch = [], batchQueued = false;
  function flush() {
    batchQueued = false;
    var list = batch;
    batch = [];
    run(list);
    if (pending.length) soon();
  }
  function onMutations(records) {
    try {
      var out = batch;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') { consider(r.target, out); continue; }
        var added = r.addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          consider(n, out);
          if (n.firstElementChild) {
            var imgs = n.getElementsByTagName('img');
            for (var k = 0; k < imgs.length; k++) consider(imgs[k], out);
            var bgs = n.querySelectorAll(BG_SEL);
            for (var q = 0; q < bgs.length; q++) consider(bgs[q], out);
          }
        }
      }
      if (out.length && !batchQueued) {
        batchQueued = true;
        (window.requestAnimationFrame || setTimeout)(flush);
      }
    } catch (e) {}
  }

  function start() {
    try {
      if (typeof MutationObserver === 'function') {
        new MutationObserver(onMutations).observe(document.documentElement,
          { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
      }
      scanTree(document.documentElement);
      ['click', 'keyup', 'wheel'].forEach(function (t) {
        window.addEventListener(t, soon, { capture: true, passive: true });
      });
    } catch (e) {}
  }

  var rescanQueued = false;
  function rescanSoon() {
    if (rescanQueued) return;
    rescanQueued = true;
    (window.requestAnimationFrame || setTimeout)(function () { rescanQueued = false; rescan(); });
  }

  window.hdIconMip = { rescan: rescan, rescanSoon: rescanSoon, flush: function () { try { flush(); recheckPending(); runJobs(); } catch (e) {} }, fit: function (img) { try { return fit(img); } catch (e) { return true; } }, tierFor: tierFor };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
