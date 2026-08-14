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
 * ====================================================================== */

window.HDLightbox = (function () {

  let el = null;          // the overlay root, while open
  let ring = [];          // loaded frame urls, ring[0] = src
  let ringAt = 0;
  let keyFn = null;
  let dragX = null;       // mousedown x while spinning, null = not dragging
  let dragBase = 0;       // ringAt at drag start
  let probeGen = 0;       // stale Image() probes from a closed box must not mutate

  const DRAG_PX_PER_STEP = 55;   // a full 4-frame turn in ~220px of drag

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
    dragX = null;
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
    const img = el.querySelector('.hdlb-img');
    if (img) {
      img.addEventListener('mousedown', function (e) {
        dragX = e.clientX;
        dragBase = ringAt;
        e.preventDefault();
      });
    }
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
  }

  function onDragMove(e) {
    if (dragX === null || !el) return;
    const steps = Math.round((e.clientX - dragX) / DRAG_PX_PER_STEP);
    showFrame(dragBase + steps);
  }

  function onDragUp() { dragX = null; }

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

  function open(opts) {
    opts = opts || {};
    const host = opts.host;
    if (!host || !opts.src) return;
    close();

    ring = [opts.src];
    ringAt = 0;

    el = document.createElement('div');
    el.className = 'hdlb';
    el.innerHTML =
      '<div class="hdlb-card">' +
      '<button class="hdlb-close" title="Close (Esc)">✕</button>' +
      '<div class="hdlb-stage">' +
      '<img class="hdlb-img" src="' + esc(opts.src) + '" alt="" draggable="false">' +
      '<div class="hdlb-fallback hidden">' + esc(opts.glyph || '❖') + '</div>' +
      '</div>' +
      '<div class="hdlb-caption">' +
      '<div class="hdlb-title">' + esc(opts.title || '') + '</div>' +
      (opts.sub ? '<div class="hdlb-sub">' + esc(opts.sub) + '</div>' : '') +
      '</div>' +
      '</div>';
    host.appendChild(el);

    /* a dead url shows the glyph, never a broken-image box */
    const img = el.querySelector('.hdlb-img');
    img.onerror = function () {
      const fb = el && el.querySelector('.hdlb-fallback');
      if (fb) fb.classList.remove('hidden');
      if (img.parentNode) img.parentNode.removeChild(img);
    };

    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    el.querySelector('.hdlb-close').addEventListener('click', close);

    keyFn = function (e) {
      if (!el) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft' && ring.length > 1) { e.stopPropagation(); showFrame(ringAt - 1); }
      else if (e.key === 'ArrowRight' && ring.length > 1) { e.stopPropagation(); showFrame(ringAt + 1); }
    };
    document.addEventListener('keydown', keyFn, true);

    /* entrance — one frame later so the transition actually runs */
    setTimeout(function () { if (el) el.classList.add('hdlb-in'); }, 10);

    probeFrames(opts.frames);
  }

  return { open: open, close: close, isOpen: isOpen, _ring: function () { return ring.slice(); } };
})();
