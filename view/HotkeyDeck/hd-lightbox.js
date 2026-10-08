'use strict';

/* ====================================================================== *
 *  HDLightbox — the shared image popout (Rober, 2026-08-13: "click the
 *  image to do a popout lightbox bigger view of item" — Items + NPCs).
 *
 *  One overlay, owned by whichever pane opens it: open() mounts INTO the
 *  pane's own <section> (the ix-sheet idiom — absolute inset:0 inside the
 *  panel, so it inherits the deck scale, clips to the rounded corners and
 *  never leaks over another tab). The 512px renders the framework bakes are
 *  the asset; the row shows them at 44-64px, this shows them big.
 *
 *  Turntable: items MAY have angle siblings on disk (-a090/-a180/-a270,
 *  baked by the Wardrobe's spin lightbox). open() probes the candidate URLs
 *  with Image() — the ones that load join the ring, and the chrome (‹ ›,
 *  drag-to-spin, dots) appears only when there is something to spin. A face
 *  render has no siblings and gets a plain big view; probing is harmless.
 *  NEVER a ?v= query on any URL — Ultralight drops the query and fails.
 *
 *  API:  HDLightbox.open({ host, src, title, sub, glyph, frames })
 *          host   — the pane <section> to mount into (required)
 *          src    — view-relative image url (required)
 *          title  — big caption line (item / NPC name)
 *          sub    — smaller meta line under it ('' hides)
 *          glyph  — fallback glyph if the image fails to load
 *          frames — optional candidate sibling urls to probe for a spin
 *        HDLightbox.close()  ·  HDLightbox.isOpen()
 *
 *  Turn in 3D (2026-10-04, Rober on SeverActions' Catalog: "also
 *  interesting.... (toggable maybe)"): an ITEM subject whose hdSpinState says
 *  inspect:true gets a "Turn in 3D" button. It swaps the 4-frame turntable for
 *  the inspector — 24 frames, 15° apart, rendered at 1024px (hdInspect in,
 *  hdInspectData out, C++ ItemIcons::InspectJson) — with drag / wheel / arrow
 *  keys to turn and the Mirror's angle dial. The switch is Finder > Items'
 *  "3D inspector" (item-explorer.json inspect3d); off, nothing renders.
 * ====================================================================== */

window.HDLightbox = (function () {

  let el = null;          // the overlay root, while open
  let ring = [];          // loaded frame urls, ring[0] = src
  let ringAt = 0;
  let keyFn = null;
  let dragX = null;       // mousedown x while spinning, null = not dragging
  let dragBase = 0;       // ringAt at drag start
  let probeGen = 0;       // stale Image() probes from a closed box must not mutate

  /* Turntable identity (opts.spin): {kind:'item'|'face', formId, plugin}.
     The whole flow is LAZY so opening costs nothing (Rober, 2026-08-19:
     "already so slow to load, i dont want them slower"):
       open  → one hdSpin {bake:false} — a state-only disk read; frames a past
               session already baked join the ring, NOTHING renders;
       drag  → hdSpin {bake:true} once, then a 3 s re-ask poll while frames are
               missing. C++ answers hdSpinState with the frames ON DISK, and an
               <img> src is only ever set to a path that reply named — never a
               probed guess, because Ultralight cannot be trusted to reload a
               URL it has already seen missing and its ?query cache-bust does
               not load at all (the reason the old worn-spin never showed). */
  let spin = null;        // {kind, formId, plugin, count, asked} while open
  let spinPollT = null;
  let spinTries = 0;
  let lastSpinState = null;   // last hdSpinState payload, for other listeners
  const SPIN_POLL_MS = 3000, SPIN_POLL_MAX = 40, SPIN_SLOP_PX = 4;

  const DRAG_PX_PER_STEP = 55;   // a full 4-frame turn in ~220px of drag

  /* The 3D inspector, while it is up: {reply, angle, polls, timer, drag}.
     inspectOn is the C++ answer to "is the switch on" for THIS subject. */
  let insp = null;
  let inspectOn = false;
  const INSP_STEP_PX = 22, INSP_POLL_MS = 1500, INSP_POLL_MAX = 200;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isOpen() { return !!el; }

  function close() {
    probeGen++;
    if (keyFn) { document.removeEventListener('keydown', keyFn, true); keyFn = null; }
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    ring = [];
    ringAt = 0;
    baseW = 0;
    baseH = 0;
    dragX = null;
    spin = null;
    spinTries = 0;
    if (spinPollT) { clearTimeout(spinPollT); spinPollT = null; }
    if (insp && insp.timer) clearTimeout(insp.timer);
    insp = null;
    inspectOn = false;
  }

  function showFrame(i) {
    if (!el || !ring.length) return;
    ringAt = ((i % ring.length) + ring.length) % ring.length;
    const img = el.querySelector('.hdlb-img');
    if (img && img.getAttribute('src') !== ring[ringAt]) img.setAttribute('src', ring[ringAt]);
    el.querySelectorAll('.hdlb-dot').forEach(function (d, n) {
      d.classList.toggle('hdlb-dot-on', n === ringAt);
    });
  }

  function rebuildDots() {
    if (!el) return;
    const dots = el.querySelector('.hdlb-dots');
    if (!dots || dots.children.length === ring.length) return;
    dots.innerHTML = '';
    ring.forEach(function (_, n) {
      const d = document.createElement('span');
      d.className = 'hdlb-dot' + (n === ringAt ? ' hdlb-dot-on' : '');
      dots.appendChild(d);
    });
  }

  function renderSpinChrome() {
    if (!el || ring.length < 2) return;
    const stage = el.querySelector('.hdlb-stage');
    if (!stage || stage.querySelector('.hdlb-prev')) return;
    const prev = document.createElement('button');
    prev.className = 'hdlb-nav hdlb-prev';
    prev.title = 'Turn left (drag the picture too)';
    prev.innerHTML = '&#8249;';
    const next = document.createElement('button');
    next.className = 'hdlb-nav hdlb-next';
    next.title = 'Turn right (drag the picture too)';
    next.innerHTML = '&#8250;';
    prev.addEventListener('click', function (e) { e.stopPropagation(); showFrame(ringAt - 1); });
    next.addEventListener('click', function (e) { e.stopPropagation(); showFrame(ringAt + 1); });
    stage.appendChild(prev);
    stage.appendChild(next);
    const dots = document.createElement('div');
    dots.className = 'hdlb-dots';
    ring.forEach(function (_, n) {
      const d = document.createElement('span');
      d.className = 'hdlb-dot' + (n === ringAt ? ' hdlb-dot-on' : '');
      dots.appendChild(d);
    });
    stage.appendChild(dots);
    stage.classList.add('hdlb-spinnable');

    /* drag-to-spin — mouse events on purpose (Ultralight has no HTML5 DnD,
       and the deck's other drags are mouse-based too) */
    wireSpinMouse();
  }

  /* One mousedown wiring per open (the data flag), shared by the frames-landed
     path (renderSpinChrome) and the lazy-bake path (open, when opts.spin is
     set) — so a spinnable-but-not-yet-baked picture still takes the grab. */
  let docWired = false;   // document listeners once per VIEW, not per open
  function wireSpinMouse() {
    const img = el && el.querySelector('.hdlb-img');
    if (!img || img.getAttribute('data-spinwired')) return;
    img.setAttribute('data-spinwired', '1');
    img.addEventListener('mousedown', function (e) {
      /* zoomed in, a drag PANS (see wireZoom) — spinning the turntable at the
         same time would fight it for the same gesture */
      if (zoom > 1.001 || insp) return;
      dragX = e.clientX;
      dragBase = ringAt;
      e.preventDefault();
    });
    if (!docWired) {
      docWired = true;
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragUp);
    }
  }

  function onDragMove(e) {
    if (dragX === null || !el) return;
    /* the first REAL drag on a spin subject is what spends renders — never the
       open, never a click (the slop gate) */
    if (spin && !spin.asked && Math.abs(e.clientX - dragX) > SPIN_SLOP_PX)
      spinBeginBake();
    const steps = Math.round((e.clientX - dragX) / DRAG_PX_PER_STEP);
    showFrame(dragBase + steps);
  }

  function onDragUp() { dragX = null; }

  /* ---- turntable via the hdSpin bridge ----------------------------------- */

  function spinPayload(bake) {
    return JSON.stringify({ kind: spin.kind, formId: spin.formId, plugin: spin.plugin, bake: !!bake });
  }
  function spinStat(text) {
    if (!el) return;
    const s = el.querySelector('.hdlb-spinstat');
    if (s) s.textContent = text || '';
  }
  function spinBeginBake() {
    if (!spin || spin.asked) return;
    spin.asked = true;
    spinTries = 0;
    toGame('hdSpin', spinPayload(true));
    spinStat('turning…');
    spinPollSoon();
  }
  function spinPollSoon() {
    if (spinPollT) { clearTimeout(spinPollT); spinPollT = null; }
    if (!el || !spin || !spin.asked) return;
    if (ring.length >= spin.count || spinTries >= SPIN_POLL_MAX) { spinStat(''); return; }
    spinPollT = setTimeout(function () {
      spinPollT = null;
      /* re-check at FIRE time — a reply that completed the ring while this
         timer was pending must not spend one more ask */
      if (!el || !spin || ring.length >= spin.count || spinTries >= SPIN_POLL_MAX) { spinStat(''); return; }
      spinTries++;
      toGame('hdSpin', spinPayload(false));   // state-only re-ask; the bake is underway
      spinPollSoon();
    }, SPIN_POLL_MS);
  }
  function applySpinState(d) {
    if (!el || !spin || !d || typeof d !== 'object' || !d.frames) return;
    if (String(d.kind || 'item') !== spin.kind) return;
    if (String(d.formId || '').toUpperCase() !== spin.formId.toUpperCase()) return;
    if (String(d.plugin || '').toLowerCase() !== spin.plugin.toLowerCase()) return;
    if (spin.kind === 'item' && typeof d.inspect === 'boolean') setInspectOffered(d.inspect);
    if (d.count) spin.count = d.count | 0;
    /* rebuild the ring in ANGLE order so a turn is coherent: frame 0 is the
       reply's own frame 0 when it names one (the "-s2" base can differ from
       the src the pane opened with), else whatever we opened on */
    const angles = Object.keys(d.frames)
      .map(function (a) { return parseInt(a, 10); })
      .filter(function (a) { return !isNaN(a); })
      .sort(function (a, b) { return a - b; });
    const cur = ring[ringAt];
    const next = [];
    if (d.frames['0']) next.push(d.frames['0']);
    else if (ring.length) next.push(ring[0]);
    angles.forEach(function (a) { if (a > 0 && next.indexOf(d.frames[String(a)]) === -1) next.push(d.frames[String(a)]); });
    if (!next.length) return;
    const changed = next.length !== ring.length;
    ring = next;
    const keep = ring.indexOf(cur);
    ringAt = keep >= 0 ? keep : 0;
    if (changed) {
      renderSpinChrome();
      rebuildDots();
      if (spin.asked)
        spinStat(ring.length >= spin.count ? '' : 'turning… ' + ring.length + ' of ' + spin.count + ' angles');
    }
  }

  /* The one receiver for hdSpinState. Other surfaces (the F7 worn lightbox)
     listen for the plain 'hd-spin-state' document event and read the payload
     back via HDLightbox._spinState() — Ultralight predates CustomEvent detail
     being dependable, so the payload rides module state, not the event. */
  window.hdSpinState = function (j) {
    let d = j;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    if (!d || typeof d !== 'object') return;
    lastSpinState = d;
    applySpinState(d);
    try { document.dispatchEvent(new Event('hd-spin-state')); } catch (e) {}
  };

  /* ---- Turn in 3D: the item inspector ------------------------------------ */

  function setInspectOffered(on) {
    inspectOn = !!on;
    const b = el && el.querySelector('.hdlb-3d');
    if (b) b.classList.toggle('hidden', !inspectOn);
    if (!inspectOn && insp) exitInspect();
  }

  function inspNorm(a) { return ((a % 360) + 360) % 360; }
  function inspStep() { return (insp && insp.reply && Number(insp.reply.step)) || 15; }
  function inspTotal() { return (insp && insp.reply && Number(insp.reply.total)) || 24; }
  function inspAngles() {
    const f = insp && insp.reply && insp.reply.frames;
    if (!f) return [];
    return Object.keys(f).map(function (a) { return parseInt(a, 10); })
      .filter(function (a) { return !isNaN(a); }).sort(function (a, b) { return a - b; });
  }
  /* the baked frame nearest the angle the player turned to — front, back and
     the profiles bake first, so a drag mid-bake still turns */
  function inspNearest(angles, want) {
    let best = null, bestD = 999;
    angles.forEach(function (a) {
      let d = Math.abs(a - want); d = Math.min(d, 360 - d);
      if (d < bestD) { bestD = d; best = a; }
    });
    return best;
  }

  function inspAsk() {
    if (!spin || !insp) return;
    toGame('hdInspect', JSON.stringify({ formId: spin.formId, plugin: spin.plugin, queue: true }));
  }

  function enterInspect() {
    if (!el || !spin || spin.kind !== 'item' || insp) return;
    setZoom(1);
    dragX = null;
    insp = { reply: null, angle: 0, polls: 0, timer: 0, drag: null };
    el.classList.add('hdlb-inspect');
    const stage = el.querySelector('.hdlb-stage');
    if (stage) stage.style.height = '';   // the 3D stage owns its own size
    baseW = 0; baseH = 0;
    const hint = el.querySelector('.hdlb-hint');
    if (hint) hint.textContent = 'drag, scroll or ← → to turn · Home faces the front · Esc goes back to the picture';
    paintInspect();
    inspAsk();
  }

  function exitInspect() {
    if (!insp) return;
    if (insp.timer) clearTimeout(insp.timer);
    insp = null;
    if (!el) return;
    el.classList.remove('hdlb-inspect');
    const img = el.querySelector('.hdlb-img');
    if (img && ring.length && img.getAttribute('src') !== ring[ringAt]) img.setAttribute('src', ring[ringAt]);
    const hint = el.querySelector('.hdlb-hint');
    if (hint) hint.textContent = 'hold + drag to turn it · scroll to zoom · double-click to fill';
    setTimeout(lockStage, 0);
  }

  function inspTurn(dir) {
    if (!insp) return;
    insp.angle = inspNorm(insp.angle + dir * inspStep());
    paintInspect();
  }

  function inspStatus(text) {
    const s = el && el.querySelector('.hdlb-insp-status');
    if (s) s.textContent = text || '';
  }

  function paintInspect() {
    if (!el || !insp) return;
    const r = insp.reply;
    const step = inspStep(), total = inspTotal();
    const angles = inspAngles();
    const shown = inspNearest(angles, insp.angle);
    const img = el.querySelector('.hdlb-img');
    if (img && shown !== null) {
      const path = r.frames[String(shown)];
      if (img.getAttribute('src') !== path) img.setAttribute('src', path);
    }
    const deg = el.querySelector('.hdlb-insp-deg');
    if (deg) deg.textContent = (shown === null ? insp.angle : shown) + '°';
    const bar = el.querySelector('.hdlb-insp-progress');
    if (bar) {
      bar.classList.toggle('hidden', !(r && r.ok && angles.length < total && !(r.refused >= total)));
      const fill = bar.firstChild;
      if (fill) fill.style.width = Math.round(angles.length / Math.max(1, total) * 100) + '%';
    }
    const dial = el.querySelector('.hdlb-insp-dial');
    if (dial) {
      dial.textContent = '';
      for (let a = 0; a < 360; a += step) {
        const baked = angles.indexOf(a) !== -1;
        const t = document.createElement('button');
        t.type = 'button';
        t.className = 'hdlb-insp-tick' + (baked ? ' hdlb-insp-baked' : '') + (a === shown ? ' hdlb-insp-on' : '');
        t.title = a + '°' + (baked ? '' : ' (still rendering)');
        t.setAttribute('aria-label', 'Turn to ' + a + ' degrees');
        if (!baked) t.disabled = true;
        t.setAttribute('data-angle', String(a));
        t.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!insp) return;
          insp.angle = parseInt(this.getAttribute('data-angle'), 10) || 0;
          paintInspect();
        });
        dial.appendChild(t);
      }
    }
    if (!r) inspStatus('Reading the piece…');
    else if (r.ok === false) inspStatus(r.why || 'This piece cannot be turned in 3D.');
    else if (r.failed && !angles.length) inspStatus('The renderer refused this piece: ' + r.failed);
    else if (angles.length < total) inspStatus(angles.length + ' of ' + total + ' angles ready · the rest render while you look' +
      (r.refused ? ' (' + r.refused + ' refused)' : ''));
    else inspStatus('All ' + total + ' angles ready · rendered once, kept for next time');
  }

  function inspSchedulePoll() {
    if (!insp) return;
    if (insp.timer) { clearTimeout(insp.timer); insp.timer = 0; }
    const r = insp.reply;
    if (!r || r.ok === false) return;
    const have = inspAngles().length;
    if (have + (Number(r.refused) || 0) >= inspTotal()) return;
    if (insp.polls >= INSP_POLL_MAX) { inspStatus('Still rendering — close and reopen to check again.'); return; }
    insp.timer = setTimeout(function () {
      if (!insp || !el) return;
      insp.timer = 0;
      insp.polls++;
      inspAsk();
    }, INSP_POLL_MS);
  }

  function applyInspect(d) {
    if (!el || !spin || !insp || !d || typeof d !== 'object') return;
    if (String(d.formId || '').toUpperCase() !== spin.formId.toUpperCase()) return;
    if (String(d.plugin || '').toLowerCase() !== spin.plugin.toLowerCase()) return;
    if (d.off) { setInspectOffered(false); return; }
    insp.reply = d;
    paintInspect();
    inspSchedulePoll();
  }

  window.hdInspectData = function (j) {
    let d = j;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    applyInspect(d);
  };

  let inspDocWired = false;
  function onInspMove(e) {
    if (!insp || !insp.drag) return;
    const steps = Math.round((e.clientX - insp.drag.x) / INSP_STEP_PX);
    const next = inspNorm(insp.drag.angle - steps * inspStep());
    if (next !== insp.angle) { insp.angle = next; paintInspect(); }
  }
  /* mouse-down to mouse-up, never MouseEvent.buttons (Ultralight reports 0
     while a button is held) */
  function onInspUp() {
    if (!insp || !insp.drag) return;
    insp.drag = null;
    const stage = el && el.querySelector('.hdlb-stage');
    if (stage) stage.classList.remove('hdlb-dragging');
  }
  function wireInspect() {
    const stage = el.querySelector('.hdlb-stage');
    if (stage) stage.addEventListener('mousedown', function (e) {
      if (!insp || e.button !== 0) return;
      e.preventDefault();
      insp.drag = { x: e.clientX, angle: insp.angle };
      stage.classList.add('hdlb-dragging');
    });
    const go = el.querySelector('.hdlb-3d');
    if (go) go.addEventListener('click', function (e) { e.stopPropagation(); enterInspect(); });
    el.querySelectorAll('.hdlb-insp-btn').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const act = b.getAttribute('data-act');
        if (act === 'left') inspTurn(-1);
        else if (act === 'right') inspTurn(1);
        else if (act === 'front') { if (insp) { insp.angle = 0; paintInspect(); } }
        else if (act === 'back') exitInspect();
      });
    });
    if (!inspDocWired) {
      inspDocWired = true;
      document.addEventListener('mousemove', onInspMove);
      document.addEventListener('mouseup', onInspUp);
      window.addEventListener('blur', onInspUp);
    }
  }

  function probeFrames(candidates) {
    const gen = ++probeGen;
    (candidates || []).forEach(function (url) {
      if (!url) return;
      const probe = new Image();
      probe.onload = function () {
        if (gen !== probeGen || !el) return;
        if (ring.indexOf(url) !== -1) return;
        ring.push(url);
        renderSpinChrome();
        const dots = el.querySelector('.hdlb-dots');
        if (dots && dots.children.length !== ring.length) {
          /* a late frame joined an existing ring — rebuild the dots */
          dots.innerHTML = '';
          ring.forEach(function (_, n) {
            const d = document.createElement('span');
            d.className = 'hdlb-dot' + (n === ringAt ? ' hdlb-dot-on' : '');
            dots.appendChild(d);
          });
        }
      };
      probe.src = url;
    });
  }

  /* ---- zoom + pan -------------------------------------------------------- *
   * Rober, 2026-08-15, on a face preset: "the lightbox popup shows full body
   * (fine) but needs to be able to zoom in on face... obviously". A render is
   * framed for the whole subject, so the interesting part is a fraction of it.
   * Wheel zooms toward the cursor, drag pans, double-click toggles 1x/2.4x, and
   * the offset is clamped so the picture can never be dragged off its own
   * stage. Ultralight rasterises an <img> at its LAYOUT size and a CSS
   * transform scales THAT raster (compositor off) -- so zoom is applied by
   * re-laying the image out bigger, not by transform, or every zoom would be a
   * blur (the hd-facefit lesson, 2026-08-14). */
  const ZMIN = 1, ZMAX = 6, ZSTEP = 1.25, ZDBL = 2.4;
  let zoom = 1, panX = 0, panY = 0;
  let dragging = false, panFromX = 0, panFromY = 0;
  /* The un-zoomed image box, in LAYOUT px. See lockStage. */
  let baseW = 0, baseH = 0;

  /* ---- why the popup used to jump on the first wheel notch ----------------
   * Rober, 2026-08-19: "the lightbox popout resizes oddly on scroll wheel".
   * It did, and it is this file's bug, not the renderer's — the picture is a
   * 512x512 PNG at every angle, so nothing about the render changes size.
   *
   * The stage has no height of its own: it is a flex box that takes the height
   * of the image inside it. Zooming past 1x makes that image `position:
   * absolute` (so it can overflow and be panned), an absolutely-positioned
   * child contributes NOTHING to its parent's height, and the stage therefore
   * collapsed to its 220px min-height the instant the wheel moved — and sprang
   * back the moment zoom returned to 1. The whole card resized under the
   * cursor. Worse, the zoomed size was set as a PERCENTAGE of that collapsed
   * parent, so the first notch could make the picture SMALLER than it was at
   * 1x before growing again.
   *
   * Fix: measure the image's laid-out box once, pin the stage to that height,
   * and size the zoom in PIXELS off that base. Then the card never changes
   * size, and zoom is exactly linear from the first notch.
   *
   * offsetWidth/offsetHeight on purpose, NOT getBoundingClientRect: the deck
   * lives inside a `transform: scale(--ui-scale)` panel, so a rect is in
   * SCREEN px and writing it back as a layout height would be wrong by the
   * deck scale. offset* is layout px and immune to ancestor transforms. */
  function lockStage() {
    if (!el || zoom > 1.001 || insp) return;   // only meaningful while un-zoomed, and never in 3D
    const img = el.querySelector('.hdlb-img');
    const stage = el.querySelector('.hdlb-stage');
    if (!img || !stage) return;
    const w = img.offsetWidth, h = img.offsetHeight;
    if (!w || !h) return;              // not laid out yet — the load handler retries
    baseW = w;
    baseH = h;
    stage.style.height = h + 'px';
  }

  function clampPan() {
    /* How far the picture may travel before an edge would show through: half
       the overhang, expressed as a fraction of the stage (left/top are set as
       percentages of the stage). Computed from the REAL boxes — the image is
       only `zoom` times the STAGE when the two started the same size, which is
       not true horizontally (the image is capped at 460px inside a wider
       stage), and pretending otherwise let a drag pull an edge into view. */
    const stage = el && el.querySelector('.hdlb-stage');
    const sw = stage ? stage.offsetWidth : 0;
    const sh = stage ? stage.offsetHeight : 0;
    const iw = baseW * zoom, ih = baseH * zoom;
    const limX = (sw > 0 && iw > sw) ? (iw - sw) / 2 / sw : 0;
    const limY = (sh > 0 && ih > sh) ? (ih - sh) / 2 / sh : 0;
    panX = Math.max(-limX, Math.min(limX, panX));
    panY = Math.max(-limY, Math.min(limY, panY));
  }

  function paintZoom() {
    if (!el) return;
    const img = el.querySelector('.hdlb-img');
    const stage = el.querySelector('.hdlb-stage');
    if (!img || !stage) return;
    if (!baseW || !baseH) lockStage();
    clampPan();
    /* LAYOUT-size zoom: the decode happens at the drawn size, so a zoomed face
       is sharp instead of a magnified thumbnail. In PIXELS off the measured
       base, so the size is continuous through the 1x boundary where the image
       leaves the flow (percentages there are of a parent that just changed). */
    if (zoom <= ZMIN + 0.001) {
      /* Back at 1x the image is STATIC again (the .hdlb-zoomed rules stop
         applying), and left/top mean nothing to a static box while the
         centring transform very much still applies — it used to shove the
         picture half its own size up and left the moment you zoomed out. So
         every inline style is handed back to the stylesheet. */
      img.style.width = '';
      img.style.height = '';
      img.style.left = '';
      img.style.top = '';
      img.style.transform = '';
    } else {
      if (baseW && baseH) {
        img.style.width = (baseW * zoom) + 'px';
        img.style.height = (baseH * zoom) + 'px';
      } else {
        img.style.width = (zoom * 100) + '%';
        img.style.height = (zoom * 100) + '%';
      }
      img.style.left = (50 + panX * 100) + '%';
      img.style.top = (50 + panY * 100) + '%';
      img.style.transform = 'translate(-50%, -50%)';
    }
    stage.classList.toggle('hdlb-zoomed', zoom > 1.001);
    const hint = el.querySelector('.hdlb-zoomlvl');
    if (hint) hint.textContent = zoom > 1.001 ? (Math.round(zoom * 10) / 10) + 'x' : '';
  }

  function setZoom(z, ax, ay) {
    const prev = zoom;
    zoom = Math.max(ZMIN, Math.min(ZMAX, z));
    if (zoom <= ZMIN + 0.001) { panX = 0; panY = 0; }
    else if (typeof ax === 'number' && prev > 0) {
      /* keep the point under the cursor put: pan shifts by the zoom delta
         times how far that point sits from the middle */
      panX += (0.5 - ax) * (zoom - prev) / zoom;
      panY += (0.5 - ay) * (zoom - prev) / zoom;
    }
    paintZoom();
  }

  function wireZoom() {
    const stage = el.querySelector('.hdlb-stage');
    if (!stage) return;
    stage.addEventListener('wheel', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (insp) { if (e.deltaY) inspTurn(e.deltaY > 0 ? 1 : -1); return; }
      const r = stage.getBoundingClientRect();
      const ax = r.width ? (e.clientX - r.left) / r.width : 0.5;
      const ay = r.height ? (e.clientY - r.top) / r.height : 0.5;
      setZoom(e.deltaY < 0 ? zoom * ZSTEP : zoom / ZSTEP, ax, ay);
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (insp) return;
      const r = stage.getBoundingClientRect();
      const ax = r.width ? (e.clientX - r.left) / r.width : 0.5;
      const ay = r.height ? (e.clientY - r.top) / r.height : 0.5;
      setZoom(zoom > 1.001 ? 1 : ZDBL, ax, ay);
    });
    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || zoom <= 1.001) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; panFromX = e.clientX; panFromY = e.clientY;
      stage.classList.add('hdlb-dragging');
    });
    document.addEventListener('mousemove', onDrag, true);
    document.addEventListener('mouseup', endDrag, true);
  }

  function onDrag(e) {
    if (!dragging || !el) return;
    const stage = el.querySelector('.hdlb-stage');
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    /* pointer travel is divided by the stage size, so a drag moves the picture
       exactly as far as the hand moved, at any zoom */
    if (r.width) panX += (e.clientX - panFromX) / r.width;
    if (r.height) panY += (e.clientY - panFromY) / r.height;
    panFromX = e.clientX; panFromY = e.clientY;
    paintZoom();
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (el) {
      const stage = el.querySelector('.hdlb-stage');
      if (stage) stage.classList.remove('hdlb-dragging');
    }
  }

  function open(opts) {
    opts = opts || {};
    const host = opts.host;
    if (!host || !opts.src) return;
    close();

    ring = [opts.src];
    ringAt = 0;
    zoom = 1; panX = 0; panY = 0; dragging = false;
    baseW = 0; baseH = 0;
    spin = (opts.spin && opts.spin.formId && opts.spin.plugin && opts.spin.formId !== '0x0')
      ? { kind: String(opts.spin.kind || 'item'), formId: String(opts.spin.formId),
          plugin: String(opts.spin.plugin), count: 4, asked: false }
      : null;
    spinTries = 0;

    el = document.createElement('div');
    el.className = 'hdlb';
    el.innerHTML =
      '<div class="hdlb-card">' +
      '<button class="hdlb-close" title="Close (Esc)">✕</button>' +
      '<div class="hdlb-stage">' +
      '<img class="hdlb-img" src="' + esc(opts.src) + '" alt="" draggable="false">' +
      '<div class="hdlb-fallback hidden">' + esc(opts.glyph || '❖') + '</div>' +
      '<span class="hdlb-zoomlvl" aria-hidden="true"></span>' +
      '<span class="hdlb-spinstat" aria-hidden="true"></span>' +
      '</div>' +
      '<div class="hdlb-caption">' +
      '<div class="hdlb-title">' + esc(opts.title || '') + '</div>' +
      (opts.sub ? '<div class="hdlb-sub">' + esc(opts.sub) + '</div>' : '') +
      '<div class="hdlb-hint">' + (spin
        ? 'hold + drag to turn it · scroll to zoom · double-click to fill'
        : 'scroll to zoom · drag to move · double-click to fill') + '</div>' +
      (spin && spin.kind === 'item'
        ? '<button type="button" class="hdlb-3d hidden" title="Render this piece from every side, big, and turn it freely">' +
          '<span class="hdlb-3d-title">Turn in 3D</span>' +
          '<span class="hdlb-3d-sub">24 angles at full size · rendered once, kept</span></button>' +
          '<div class="hdlb-insp" role="group" aria-label="3D inspector">' +
          '<div class="hdlb-insp-progress hidden"><i></i></div>' +
          '<div class="hdlb-insp-row"><span class="hdlb-insp-deg">0°</span>' +
          '<div class="hdlb-insp-dial" role="group" aria-label="Angles"></div></div>' +
          '<div class="hdlb-insp-ctl">' +
          '<button type="button" class="hdlb-insp-btn" data-act="left" title="Turn left (←)">‹ Turn</button>' +
          '<button type="button" class="hdlb-insp-btn" data-act="front" title="Face the front (Home)">Front</button>' +
          '<button type="button" class="hdlb-insp-btn" data-act="right" title="Turn right (→)">Turn ›</button>' +
          '<button type="button" class="hdlb-insp-btn" data-act="back" title="Back to the picture (Esc)">Back to picture</button>' +
          '</div>' +
          '<p class="hdlb-insp-status" role="status" aria-live="polite"></p>' +
          '</div>'
        : '') +
      '</div>' +
      '</div>';
    host.appendChild(el);

    /* a dead url shows the glyph, never a broken-image box */
    const img = el.querySelector('.hdlb-img');
    /* Pin the stage to the picture's own height as soon as there IS one, so
       zooming (which takes the image out of the flow) cannot resize the card.
       Runs per src, so a turntable frame of a different size re-pins — but only
       while un-zoomed, so a frame landing mid-zoom never moves the box. */
    img.addEventListener('load', lockStage);
    if (img.complete) setTimeout(lockStage, 0);
    img.onerror = function () {
      const fb = el && el.querySelector('.hdlb-fallback');
      if (fb) fb.classList.remove('hidden');
      if (img.parentNode) img.parentNode.removeChild(img);
    };

    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    el.querySelector('.hdlb-close').addEventListener('click', close);
    wireZoom();

    keyFn = function (e) {
      if (!el) return;
      if (insp) {
        /* the 3D inspector owns the keys while it is up; Esc steps back to the
           picture first, a second Esc closes */
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); exitInspect(); }
        else if (e.key === 'ArrowLeft') { e.stopPropagation(); e.preventDefault(); inspTurn(-1); }
        else if (e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); inspTurn(1); }
        else if (e.key === 'Home') { e.stopPropagation(); e.preventDefault(); insp.angle = 0; paintInspect(); }
        return;
      }
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
      else if (e.key === '+' || e.key === '=') { e.stopPropagation(); setZoom(zoom * ZSTEP); }
      else if (e.key === '-' || e.key === '_') { e.stopPropagation(); setZoom(zoom / ZSTEP); }
      else if (e.key === '0') { e.stopPropagation(); setZoom(1); }
      else if (e.key === 'ArrowLeft' && ring.length > 1) { e.stopPropagation(); showFrame(ringAt - 1); }
      else if (e.key === 'ArrowRight' && ring.length > 1) { e.stopPropagation(); showFrame(ringAt + 1); }
    };
    document.addEventListener('keydown', keyFn, true);

    /* entrance — one frame later so the transition actually runs */
    setTimeout(function () { if (el) el.classList.add('hdlb-in'); }, 10);

    probeFrames(opts.frames);

    if (spin) {
      /* the affordance is live from the first paint — the grab is what starts
         a bake; opening only asks what is already on disk (bake:false) */
      const stage = el.querySelector('.hdlb-stage');
      if (stage) stage.classList.add('hdlb-spinnable');
      wireSpinMouse();
      if (spin.kind === 'item') wireInspect();
      toGame('hdSpin', spinPayload(false));
    }
  }

  return { open: open, close: close, isOpen: isOpen, _ring: function () { return ring.slice(); },
           _zoom: function () { return zoom; }, _setZoom: setZoom,
           _pan: function () { return { x: panX, y: panY }; },
           _base: function () { return { w: baseW, h: baseH }; },
           _spinState: function () { return lastSpinState; },
           _spin: function () { return spin; },
           _insp: function () { return insp ? { angle: insp.angle, frames: inspAngles().length, polls: insp.polls } : null; },
           _inspectOffered: function () { return inspectOn; },
           _enterInspect: enterInspect, _exitInspect: exitInspect };
})();
