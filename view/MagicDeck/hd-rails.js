'use strict';
/* ================================= hdRails — the deck's own scroll rails =================================
 *
 *  WHY (Rober, 2026-10-12, two screenshots: a grey bar down the middle of the Bestiary's page, then
 *  "this scrollbar bleeds into not just bestiary but other areas too"). Ultralight paints a NATIVE
 *  scrollbar where it thinks the box is, and in game that is not always where the box is drawn:
 *  under the panel's `transform: scale(var(--ui-scale))`, and after a transformed entrance or page
 *  turn, the bar landed beside or over the content it belongs to. Offline at scale 1 it lands right,
 *  so it cannot be trusted. The Bestiary already drew its own rails (hd-bestiary.js syncRail); this
 *  does the same for every other scroller in the view.
 *
 *  WHAT. Every native scrollbar in the view is hidden (width/height 0). A rail is a plain fixed
 *  element placed from the scroller's getBoundingClientRect() — the same transformed coordinates the
 *  content is painted in — so it sits on the scroller's own edge at any --ui-scale. A rail shows on
 *  the scroller under the pointer and while one scrolls, fades out ~1.2 s after both stop, and its
 *  thumb drags. Vertical and horizontal.
 *
 *  RULES IT KEEPS.
 *   - Never throws: an uncaught error during load takes down PrismaUI's SHARED renderer
 *     (ultralight-probe README, trap 5). Every entry point is wrapped.
 *   - Nothing is attached to the scroller itself: rails live in one fixed layer on <body>, so no pane
 *     layout, positioning or overflow changes. A rail whose scroller left the DOM or is hidden (the
 *     deck closed) disappears on the next tick.
 *   - The Bestiary (.bx-back) keeps its own always-on rails.
 *   - No polling while nothing is shown: one 250 ms tick runs only while a rail is visible.
 *
 *  Shared, byte-identical, by HotkeyDeck and MagicDeck (the roots cannot see each other).
 * ======================================================================================================== */
(function () {
  if (window.hdRails) return;
  var SKIP = '.bx-back';
  var HIDE_MS = 1200;
  var W = 6;           // rail thickness, screen px
  var PAD = 4;         // inset from the scroller's ends
  var rails = [];      // { sc, axis, el, thumb, until }
  var tickT = 0, lastMove = 0, drag = null;

  function guard(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { return undefined; } }; }

  function style() {
    if (document.getElementById('hdr-style')) return;
    var s = document.createElement('style');
    s.id = 'hdr-style';
    s.textContent =
      '*::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; background: transparent !important; }' +
      '.hdr-rail { position: fixed; z-index: 2147483000; pointer-events: none; border-radius: 4px; background: rgba(212,174,98,.08);' +
      ' opacity: 0; transition: opacity .22s ease; }' +
      '.hdr-rail.hdr-on { opacity: 1; }' +
      '.hdr-thumb { position: absolute; left: 0; top: 0; border-radius: 4px; background: rgba(212,174,98,.46);' +
      ' box-shadow: inset 0 0 0 1px rgba(242,208,138,.18); pointer-events: auto; }' +
      '.hdr-rail.hdr-on .hdr-thumb:hover, .hdr-thumb.hdr-drag { background: rgba(232,196,120,.72); }';
    (document.head || document.documentElement).appendChild(s);
  }

  function scrolls(el, axis) {
    var cs = getComputedStyle(el), ov = axis === 'y' ? cs.overflowY : cs.overflowX;
    if (ov !== 'auto' && ov !== 'scroll') return false;
    return axis === 'y' ? el.scrollHeight > el.clientHeight + 2 : el.scrollWidth > el.clientWidth + 2;
  }
  /* the scrollers between a node and the page, nearest first, one per axis */
  function scrollersOf(node) {
    var out = [], gotY = false, gotX = false;
    for (var el = node; el && el.nodeType === 1 && el !== document.documentElement; el = el.parentNode) {
      if (el.closest && el.closest(SKIP)) return out;
      if (el.classList && (el.classList.contains('hdr-rail') || el.classList.contains('hdr-thumb'))) return out;
      if (!gotY && scrolls(el, 'y')) { out.push({ sc: el, axis: 'y' }); gotY = true; }
      if (!gotX && scrolls(el, 'x')) { out.push({ sc: el, axis: 'x' }); gotX = true; }
      if (gotY && gotX) break;
    }
    return out;
  }
  function railFor(sc, axis) {
    for (var i = 0; i < rails.length; i++) if (rails[i].sc === sc && rails[i].axis === axis) return rails[i];
    var el = document.createElement('div'), th = document.createElement('div');
    el.className = 'hdr-rail hdr-' + axis;
    th.className = 'hdr-thumb';
    el.appendChild(th);
    document.body.appendChild(el);
    var r = { sc: sc, axis: axis, el: el, thumb: th, until: 0 };
    th.addEventListener('mousedown', guard(function (ev) { startDrag(r, ev); }));
    rails.push(r);
    return r;
  }
  function visible(sc) {
    if (!sc.isConnected && !document.body.contains(sc)) return false;
    if (!sc.getClientRects().length) return false;
    for (var el = sc; el && el.nodeType === 1; el = el.parentNode) {
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    }
    return true;
  }
  function place(r) {
    var sc = r.sc, b = sc.getBoundingClientRect();
    if (r.axis === 'y') {
      var track = Math.max(0, b.height - 2 * PAD), sh = sc.scrollHeight, ch = sc.clientHeight;
      var th = Math.max(28, Math.round(track * ch / Math.max(1, sh)));
      var span = Math.max(1, sh - ch), top = Math.round((track - th) * Math.min(1, Math.max(0, sc.scrollTop / span)));
      r.el.style.left = Math.round(b.right - W - 2) + 'px'; r.el.style.top = Math.round(b.top + PAD) + 'px';
      r.el.style.width = W + 'px'; r.el.style.height = track + 'px';
      r.thumb.style.width = W + 'px'; r.thumb.style.height = th + 'px';
      r.thumb.style.transform = 'translateY(' + top + 'px)';
      r.trackLen = track; r.thumbLen = th;
    } else {
      var trackX = Math.max(0, b.width - 2 * PAD), sw = sc.scrollWidth, cw = sc.clientWidth;
      var tw = Math.max(28, Math.round(trackX * cw / Math.max(1, sw)));
      var spanX = Math.max(1, sw - cw), left = Math.round((trackX - tw) * Math.min(1, Math.max(0, sc.scrollLeft / spanX)));
      r.el.style.left = Math.round(b.left + PAD) + 'px'; r.el.style.top = Math.round(b.bottom - W - 2) + 'px';
      r.el.style.width = trackX + 'px'; r.el.style.height = W + 'px';
      r.thumb.style.height = W + 'px'; r.thumb.style.width = tw + 'px';
      r.thumb.style.transform = 'translateX(' + left + 'px)';
      r.trackLen = trackX; r.thumbLen = tw;
    }
  }
  function show(sc, axis) {
    var r = railFor(sc, axis);
    place(r);
    r.el.classList.add('hdr-on');
    r.until = Date.now() + HIDE_MS;
    if (!tickT) tickT = setInterval(guard(tick), 250);
  }
  function tick() {
    var now = Date.now(), any = false;
    for (var i = rails.length - 1; i >= 0; i--) {
      var r = rails[i];
      if (!visible(r.sc) || (r.axis === 'y' ? r.sc.scrollHeight <= r.sc.clientHeight + 2 : r.sc.scrollWidth <= r.sc.clientWidth + 2)) {
        if (r.el.parentNode) r.el.parentNode.removeChild(r.el);
        rails.splice(i, 1);
        continue;
      }
      if (drag && drag.r === r) { any = true; continue; }
      if (r.until > now) { place(r); any = true; } else r.el.classList.remove('hdr-on');
    }
    if (!any && tickT) { clearInterval(tickT); tickT = 0; }
  }
  function startDrag(r, ev) {
    if (ev.button !== 0) return;
    drag = { r: r, x0: ev.clientX, y0: ev.clientY, s0: r.axis === 'y' ? r.sc.scrollTop : r.sc.scrollLeft };
    r.thumb.classList.add('hdr-drag');
    ev.preventDefault(); ev.stopPropagation();
  }
  /* Ultralight can report buttons===0 mid-drag: the drag is ours from mousedown to mouseup/blur */
  var onMove = guard(function (ev) {
    if (drag) {
      var r = drag.r, sc = r.sc, room = Math.max(1, r.trackLen - r.thumbLen);
      if (r.axis === 'y') sc.scrollTop = drag.s0 + (ev.clientY - drag.y0) * (sc.scrollHeight - sc.clientHeight) / room;
      else sc.scrollLeft = drag.s0 + (ev.clientX - drag.x0) * (sc.scrollWidth - sc.clientWidth) / room;
      show(sc, r.axis);
      return;
    }
    var now = Date.now();
    if (now - lastMove < 60) return;      // a hover scan at most ~16 times a second
    lastMove = now;
    var list = scrollersOf(ev.target);
    for (var i = 0; i < list.length; i++) show(list[i].sc, list[i].axis);
  });
  var endDrag = guard(function () {
    if (!drag) return;
    drag.r.thumb.classList.remove('hdr-drag');
    drag.r.until = Date.now() + HIDE_MS;
    drag = null;
  });
  var onScroll = guard(function (ev) {
    var t = ev.target;
    if (!t || t.nodeType !== 1 || (t.closest && t.closest(SKIP))) return;
    if (scrolls(t, 'y')) show(t, 'y');
    if (scrolls(t, 'x')) show(t, 'x');
  });

  var init = guard(function () {
    style();
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', endDrag, true);
    window.addEventListener('blur', endDrag);
    document.addEventListener('scroll', onScroll, true);   // scroll does not bubble: capture it
    window.addEventListener('resize', guard(function () { for (var i = 0; i < rails.length; i++) place(rails[i]); }));
  });
  window.hdRails = {
    /* tests and panes: how many rails exist / are showing */
    count: function () { return rails.length; },
    shown: function () { return rails.filter(function (r) { return r.el.classList.contains('hdr-on'); }).length; },
    railOf: function (sc, axis) { for (var i = 0; i < rails.length; i++) if (rails[i].sc === sc && rails[i].axis === (axis || 'y')) return rails[i].el; return null; },
    refresh: guard(function () { for (var i = 0; i < rails.length; i++) place(rails[i]); })
  };
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
