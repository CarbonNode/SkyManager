/* hd-facefit.js — dynamic face framing for FaceGen head renders.
 *
 * MRF frames the WHOLE bust into the 512px canvas, so a long-haired follower
 * is mostly hair and the face reads tiny in a 64px tile. This module finds
 * the face dynamically and produces the transform that fills a SQUARE frame
 * with it, letting hair bleed off the edges (Rober, 2026-08-14: "more focused
 * on the face, allowing hair to cut off screen, so more distinct").
 *
 * HOW THE FACE IS FOUND — anatomy, not color. Skin-color detection breaks on
 * orcs (green), dunmer (grey) and argonians (scales); geometry does not: the
 * skull hangs from the TOP of the rendered bust and its size tracks the
 * content WIDTH (hair length only ever grows the box DOWNWARD). So, from the
 * opaque bounding box (alpha > 16):
 *
 *     face centre y = bboxTop + K * bboxWidth     (K = 0.54)
 *     window side   = S * bboxWidth               (S = 1.00)
 *
 * calibrated on real renders (facefit.preview.html re-tunes live). The window
 * is clamped inside the content vertically when the content is SHORTER than
 * the window (a bald head), which degrades exactly to the whole-head fit.
 *
 * Measured ONCE per url via canvas readback, cached for the session. Consumers:
 * followers-pane.js (roster medallions, crew strip, quick card) and
 * npcs-pane.js (Finder tiles). Lightboxes deliberately DON'T use it — the big
 * view's job is the whole render.
 */
(function () {
  'use strict';

  /* Tunables. tune() exists for facefit.preview.html — the deck itself ships
     the defaults and re-tuning there is how new defaults get chosen. */
  const K0 = 0.54, S0 = 1.00;   // shipped defaults (facefit.preview.html calibration)
  let K = K0;     // face centre sits this many bbox-WIDTHS below the bbox top
  let S = S0;     // face window side, in bbox-widths
  const ZMAX = 4; // matches the followers pane's CROP_ZMAX — one law for zoom

  const fits = {};       // url -> {cx, cy, side} as fractions of the source image
  const busy = {};       // url -> [img, ...] waiting for the measure to finish
  const overrides = {};  // url -> {z,x,y} — a HAND framing; always beats the measure

  function computeFit(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d');
    if (!c2) return null;
    c2.drawImage(img, 0, 0);
    let d;
    try { d = c2.getImageData(0, 0, w, h).data; }
    catch (_) { return null; }   // tainted canvas (file:// browser) — no fit
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    /* Per-row opaque pixel COUNT (coverage), not span — two separated ears must
       read as narrow, not as one wide row. The ear/horn fix below uses this to
       find where the solid head mass begins. Cheap (one int per source row). */
    const rowCov = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let cov = 0;
      for (let x = 0; x < w; x++) {
        if (d[(row + x) * 4 + 3] > 16) {
          cov++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      rowCov[y] = cov;
    }
    /* Empty or sliver content = a broken render; framing noise helps nobody. */
    if (x1 < 0 || (x1 - x0 + 1) < w * 0.05 || (y1 - y0 + 1) < h * 0.05) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

    /* --- ear/horn/tall-crown fix (Ankha, Rober 2026-08-14) ------------------
       The window is sized by content WIDTH and top-anchored, so it clips the
       top ~(K - S/2)*bw of content. For a human that sliver is scalp/hair and
       clipping it is intended; but a cat-eared / horned / tall-crowned head has
       real HEAD geometry up there and it gets cut off. We tell the two apart by
       anatomy, not species: the skull/face is the SOLID mass, ears/horns are
       NARROW protrusions ABOVE it. maxCov is the fullest row's opaque pixel
       count; yWide is the first row (top-down) whose coverage reaches a fraction
       of it — the top of the solid head mass. Everything between y0 and yWide is
       a protrusion we should keep. Coverage (not span) is what makes two
       separated ears read as narrow. (Hair only ever grows DOWNWARD, so this
       never mistakes long hair for ears — hair does not sit above the widest
       part of the head.) */
    let maxCov = 0;
    for (let y = y0; y <= y1; y++) if (rowCov[y] > maxCov) maxCov = rowCov[y];
    const wideAt = maxCov * 0.55;          // "solid" = >=55% of the fullest row's coverage
    let yWide = y0;
    for (let y = y0; y <= y1; y++) { if (rowCov[y] >= wideAt) { yWide = y; break; } }
    const earsPx = yWide - y0;             // height of the narrow crown above the face mass

    let side = S * bw;
    if (side > bh) side = bh;             // bald/short content: take it all
    let cy = y0 + K * bw;

    /* If there is a meaningful crown above the wide head (ears/horns), grow the
       window UP so its top edge reaches the true content top y0 instead of
       slicing through the ears. We raise the top edge only (the bottom stays,
       so hair keeps bleeding off), which both enlarges `side` and lifts `cy`.
       Capped so a very tall protrusion can't shrink the face to a speck: the
       window grows by at most ~0.6*bw (side ≤ ~1.6*bw). A negligible crown
       (< 6% of bw — ordinary human scalp/noise) is ignored, so human framing is
       byte-unchanged. */
    const crownThresh = bw * 0.06;
    if (earsPx > crownThresh) {
      const curTop = cy - side / 2;
      const wantTop = y0;                          // include all the way to the ear tips
      if (wantTop < curTop) {
        const grow = Math.min(curTop - wantTop, bw * 0.6);   // capped upward growth
        const newTop = curTop - grow;
        const bottom = cy + side / 2;              // keep the bottom edge fixed
        side = bottom - newTop;
        cy = (newTop + bottom) / 2;
      }
    }

    /* Density floor: a window under ~96 source px stretched into a tile is
       BLOCKS, not a face (the pixelated-finder report, 2026-08-14). Rather
       than zoom into pixels, grow the window — the face reads slightly
       smaller but stays an image. Renders are 1024px now, so this only bites
       on meshes MRF framed unusually small. */
    const minWin = 96;
    if (side < minWin) side = Math.min(minWin, Math.max(bh, side));
    if (side > bh) side = bh;              // never taller than the content itself
    /* Keep the window on the content vertically — a face window that slides
       past the chin of a short-haired head would frame empty air. */
    const half = side / 2;
    cy = Math.max(y0 + half, Math.min(cy, y1 + 1 - half));
    const cx = x0 + bw / 2;
    return { cx: cx / w, cy: cy / h, side: side / Math.min(w, h) };
  }

  /* ============================================================================
   *  cropCss — THE ONE crop -> CSS mapping. Editor preview AND every consumer
   *  (charsheet portrait, follower medallion, crew strip, quick card, shelf)
   *  call this, so a saved {z,x,y} produces byte-identical CSS on all of them
   *  and the editor is WYSIWYG by construction.
   *
   *  WYSIWYG INVARIANT: two <img>s carrying the SAME crop look identical iff
   *  they also share (frame aspect ratio, cover baseline, identity-case
   *  object-position). cropCss owns the last two; the caller owns the frame
   *  aspect — which is why openCropEditor takes the consumer's aspect, so the
   *  editor frame matches the surface it is framing FOR (a square medallion vs
   *  the 156x200 character portrait). Get any of the three wrong and the same
   *  numbers render a different picture — that was the "reframe doesn't match
   *  the thumbnail" bug (Rober, 2026-08-14): the editor was square + biased 22%
   *  up, the character portrait 156x200 + centred, so he had to mis-frame it.
   *
   *  `crop` is {z,x,y}, already clamped by the caller (clampCrop / normCrop);
   *  null/identity means "no transform, fall back to the baseline". `baseline`
   *  is the object-position a surface shows when there is NO crop (medallions
   *  bias '50% 22%' because faces sit high in a grab; the character portrait is
   *  '50% 50%'). WITH a crop, object-position is forced to the frame centre so
   *  the transform is the only thing steering — the guess must get out of the
   *  user's way. transform-origin is the centre because clampCrop's slack maths
   *  ((z-1)/2) assumes a centred scale; translate comes FIRST so its percentages
   *  are of the UNTRANSFORMED box and therefore mean exactly "x frame-widths",
   *  independent of z. The number formatting (3dp translate, 4dp scale) is part
   *  of the contract — the charsheet harness asserts the exact string.
   * ========================================================================== */
  function isIdentity(c) {
    return !c || !isFinite(c.z) || (c.z === 1 && !c.x && !c.y);
  }
  function cropCss(crop, baseline) {
    const base = String(baseline || '');
    if (isIdentity(crop)) {
      /* No crop: clear the transform and let the surface's own baseline show.
         objectPosition '' means "inherit the stylesheet"; a caller that wants a
         specific identity baseline passes it and we set it explicitly. */
      return {
        transform: '',
        transformOrigin: '50% 50%',
        objectPosition: base,
      };
    }
    const z = crop.z, x = crop.x || 0, y = crop.y || 0;
    return {
      transform: 'translate(' + (x * 100).toFixed(3) + '%,' +
        (y * 100).toFixed(3) + '%) scale(' + z.toFixed(4) + ')',
      transformOrigin: '50% 50%',
      objectPosition: '50% 50%',
    };
  }

  /* Apply cropCss to an <img> in one call — the consumers' shared painter. */
  function applyCrop(img, crop, baseline) {
    if (!img || !img.style) return img;
    const css = cropCss(crop, baseline);
    img.style.transformOrigin = css.transformOrigin;
    img.style.transform = css.transform;
    img.style.objectPosition = css.objectPosition;
    return img;
  }

  /* The {z,x,y} transform for a SQUARE cover-fit frame — the same shape the
     followers pane's hand-made crops use, so applyCropTo needs no second
     path. translate is in frame-widths of the UNTRANSFORMED box; see
     followers-pane.js applyCropTo for the matrix reasoning. */
  function cssFor(url) {
    url = String(url || '');
    /* A hand framing (per-NPC override, saved by the followers pane) always
       beats the measured fit — the human said where the face is. */
    if (overrides[url]) return overrides[url];
    const f = fits[url];
    if (!f) return null;
    let z = 1 / f.side;
    z = Math.max(1, Math.min(ZMAX, z));
    const lim = (z - 1) / 2;
    const x = Math.max(-lim, Math.min(lim, z * (0.5 - f.cx)));
    const y = Math.max(-lim, Math.min(lim, z * (0.5 - f.cy)));
    return {
      z: Math.round(z * 1e4) / 1e4,
      x: Math.round(x * 1e4) / 1e4,
      y: Math.round(y * 1e4) / 1e4,
    };
  }

  /* The safe, self-contained state: cover the frame, biased to the top where
     faces sit, clipped by the frame's overflow. This is what an <img> shows
     while its layout crop cannot yet be applied SAFELY (see paint()). It is a
     normal in-flow image — NEVER position:absolute — so it is physically
     incapable of escaping its frame regardless of what ancestor is positioned.
     Painting the layout crop only ever REPLACES this once containment is
     proven; if the crop can't be applied, the face stays here and reads fine. */
  function paintSafe(img) {
    if (!img || !img.style) return;
    img.style.transform = '';
    img.style.position = '';
    img.style.inset = '';
    img.style.left = '';
    img.style.top = '';
    img.style.margin = '';
    img.style.display = 'block';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.style.objectPosition = '50% 22%';
  }

  /* Force the frame to actually CONTAIN an absolutely-positioned child: it must
     be a positioned ancestor (else the absolute img escapes to the nearest
     positioned ancestor — the whole pane — and paints huge over the roster,
     the 2026-08-14 "giant face on the Followers tab" bug) AND it must clip
     (else the z-times-frame img overflows the medallion). Both are forced in
     CODE here because the frame's stylesheet may leave it static/visible
     (.medal.img and .fq-crew-face both ship overflow:hidden but NO position),
     so containment can never depend on CSS this module doesn't own. */
  function containFrame(par) {
    if (!par || !par.style) return;
    /* Only relative — never override an author's absolute/fixed frame. */
    const pos = par.style.position;
    if (pos !== 'relative' && pos !== 'absolute' && pos !== 'fixed') {
      par.style.position = 'relative';
    }
    par.style.overflow = 'hidden';
  }

  /* Does the frame have a real, non-zero layout box yet? In a live view a
     freshly-inserted row / a hidden tab measures 0×0, and laying the image out
     against a 0-box makes the percentage geometry meaningless. We can only
     trust a positive measurement; environments with no layout at all (jsdom)
     report 0 for everything, so a 0 there is treated as "unknown, proceed" —
     containFrame() has already made escape impossible either way. */
  function frameHasLayout(par) {
    if (!par || typeof par.getBoundingClientRect !== 'function') return true;
    let r;
    try { r = par.getBoundingClientRect(); } catch (_) { return true; }
    if (!r) return true;
    /* A browser with layout will give the frame a size; 0×0 means not laid
       out yet -> defer. jsdom gives 0×0 to EVERYTHING, so distinguish it by
       innerWidth: a real viewport is non-zero, jsdom's is 0. */
    const hasViewport = typeof window !== 'undefined' && window.innerWidth > 0;
    if (!hasViewport) return true;            // no real layout engine: don't loop forever
    return r.width > 0 && r.height > 0;
  }

  const RETRY_MAX = 30;   // ~0.5s of frames — a frame that never lays out keeps the safe fit

  /* LAYOUT-based crop, not a CSS transform. In these Ultralight views
     (compositor off) an <img> is rasterised at its LAYOUT size and a
     transform then scales that little raster — a 64px tile zoomed 4x samples
     16 effective pixels and reads as blocks, no matter how dense the source
     PNG is (the pixelated-finder report, 2026-08-14). Laying the image out
     at z-times the frame and shifting it with margins makes Ultralight
     decode at the big size; the frame's overflow:hidden does the cropping,
     and the picture stays an image. Frames are squares everywhere this is
     used (percentage margin-top resolves against parent WIDTH — fine for
     squares, wrong anywhere else; keep the frames square).

     Containment is STRUCTURAL, not timing-dependent: the absolute layout is
     applied ONLY when the img is inside a frame that has been forced to
     position:relative + overflow:hidden AND has a real non-zero rect. Until
     then the img sits in paintSafe() — a plain in-flow cover image that
     cannot escape — and paint retries on the next frame (bounded), so a face
     inserted before its row lays out can NEVER flash huge across the pane. */
  function paint(img, url, _tries) {
    const c = cssFor(url);
    if (!c || !img || !img.style) return;
    const z = (isFinite(c.z) ? Math.max(1, Math.min(ZMAX, c.z)) : 1);   // defensive cap
    const par = img.parentElement;

    /* No parent (called on a detached img — the followers medallion builds the
       image, fits it, THEN wraps it) or a frame with no layout box yet: keep
       the safe fit and try again next frame. Never set position:absolute here
       — an absolute img with no positioned/clipping parent is the whole bug. */
    if (!par || !frameHasLayout(par)) {
      paintSafe(img);
      const n = (_tries | 0) + 1;
      if (n <= RETRY_MAX && typeof window !== 'undefined' &&
          typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () {
          /* Re-check: the img may have been removed or the fit changed. */
          if (img.parentElement || n <= 2) paint(img, url, n);
        });
      }
      return;
    }

    /* Parent exists and is laid out: MAKE it contain us, then lay the crop out
       absolutely inside it. containFrame is what makes the absolute safe. */
    containFrame(par);
    const left = ((1 - z) / 2 + (c.x || 0)) * 100;
    const top = ((1 - z) / 2 + (c.y || 0)) * 100;
    img.style.transform = '';
    img.style.position = 'absolute';
    img.style.inset = 'auto';
    img.style.display = 'block';
    img.style.left = left.toFixed(3) + '%';
    img.style.top = top.toFixed(3) + '%';
    img.style.margin = '0';
    img.style.width = (z * 100).toFixed(2) + '%';
    img.style.height = (z * 100).toFixed(2) + '%';
    img.style.objectFit = 'contain';
    img.style.objectPosition = '50% 50%';
  }

  /* Measure url through img (once), then paint EVERY img that asked. onReady
     fires once per measure so a pane can repaint rows that share the file. */
  function ensure(img, url, onReady) {
    url = String(url || '');
    if (!img || !url) return;
    if (fits[url]) { paint(img, url); return; }
    if (busy[url]) { busy[url].push(img); return; }
    busy[url] = [img];
    const done = function () {
      const f = computeFit(img);
      const waiters = busy[url] || [];
      delete busy[url];
      if (!f) return;                    // unmeasurable: everyone keeps the full render
      fits[url] = f;
      waiters.forEach(function (w) { paint(w, url); });
      if (typeof onReady === 'function') onReady(url);
    };
    if (img.complete && img.naturalWidth) done();
    else img.addEventListener('load', done, { once: true });
  }

  window.HDFaceFit = {
    ensure: ensure,
    cssFor: cssFor,
    paint: paint,
    /* THE shared crop -> CSS mapping. The editor preview and every consumer
       call this, so the same {z,x,y} is byte-identical everywhere. */
    cropCss: cropCss,
    applyCrop: applyCrop,
    isIdentityCrop: isIdentity,
    has: function (url) { return !!fits[String(url || '')]; },
    /* Computed fit only — the editor seeds from this when clearing an
       override, so "reset" lands on the measured framing, not on nothing. */
    computedFor: function (url) {
      url = String(url || '');
      const o = overrides[url];
      delete overrides[url];
      const c = cssFor(url);
      if (o) overrides[url] = o;
      return c;
    },
    setOverride: function (url, c) {
      url = String(url || '');
      if (!url) return;
      if (c && isFinite(c.z)) overrides[url] = { z: c.z, x: c.x || 0, y: c.y || 0 };
      else delete overrides[url];
    },
    overrideFor: function (url) { return overrides[String(url || '')] || null; },
    /* preview-page + in-game default-framing hooks */
    tune: function (k, s) {
      if (isFinite(k)) K = k;
      if (isFinite(s)) S = s;
      Object.keys(fits).forEach(function (u) { delete fits[u]; });   // re-measure under new law
    },
    params: function () { return { k: K, s: S }; },
    defaults: function () { return { k: K0, s: S0 }; },
    _computeFit: computeFit,
  };
})();
