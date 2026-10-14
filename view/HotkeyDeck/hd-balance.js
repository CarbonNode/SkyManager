'use strict';
/* ============================ HDBalance — chip rows that wrap into a tidy block ============================
 *
 *  WHY (Rober, 2026-10-10, a screenshot of the Weather filter chips: "things that line break
 *  a ton — but could be cleaner and more organized").  A row of filter chips that wraps the
 *  browser's way fills line one and drops a ragged one or two chips onto line two. The house
 *  rule (ui-guidelines §0.3) is one shape per set and no grid ending on empty cells.
 *
 *  WHAT.  A row with class `hd-balance` (display:flex; flex-wrap:wrap) is laid out as an even
 *  grid: measure the widest chip's natural width, take as many columns as fit, then spread
 *  the chips over the FEWEST rows with counts that differ by at most one (9 chips that fit
 *  4 across become 3 + 3 + 3, 7 that fit 3 become 3 + 2 + 2). Chips in a row share it
 *  evenly, so every row ends flush at both edges and no row is a lone straggler. When
 *  everything fits on one line, the chips share that line evenly.
 *
 *    hdBalance(el)        lay it out now (call after you rewrite its children)
 *    hdBalance.watch(el)  lay it out now and again whenever its width changes
 *
 *  It sets one custom property on each chip (--hd-bal-basis); the two rules this file injects
 *  (its own <style>, so a pane harness without app.css gets them too) do the rest. Never throws (an uncaught error during load takes down PrismaUI's shared
 *  renderer). Width 0 (the pane is hidden) is a no-op; watch() catches the first real width.
 * ============================================================================================== */
(function () {
  if (window.hdBalance) return;
  var watched = [];
  var ro = null;

  function visibleKids(el) {
    var out = [];
    for (var i = 0; i < el.children.length; i++) {
      var k = el.children[i];
      if (k.getBoundingClientRect().width > 0) out.push(k);
    }
    return out;
  }

  function balance(el) {
    try {
      if (!el || !el.isConnected) return;
      var cs = getComputedStyle(el);
      var w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (!(w > 0)) return;
      el.classList.add('hd-bal-measure');
      var kids = visibleKids(el);
      var widest = 0;
      for (var i = 0; i < kids.length; i++) widest = Math.max(widest, kids[i].getBoundingClientRect().width);
      el.classList.remove('hd-bal-measure');
      for (var c = 0; c < el.children.length; c++) el.children[c].style.removeProperty('--hd-bal-basis');
      if (kids.length < 2 || !(widest > 0)) return;
      /* getBoundingClientRect is post-transform; clientWidth is layout px. Bring the
         widest chip back to layout px through the row's own on-screen/layout ratio. */
      var rect = el.getBoundingClientRect().width;
      var k = rect > 0 && el.offsetWidth > 0 ? rect / el.offsetWidth : 1;
      widest = widest / k;
      var gap = parseFloat(cs.columnGap);
      if (!isFinite(gap)) gap = parseFloat(cs.gap) || 0;
      var fit = Math.max(1, Math.floor((w + gap) / (widest + gap)));
      /* Fewest rows, then spread the chips so no two rows differ by more than one
         (7 that fit 3 across: 3 + 2 + 2, never 3 + 3 + 1). Each chip's basis is its
         own row's share, so every row ends flush at both edges. */
      var rows = Math.ceil(kids.length / fit);
      var base = Math.floor(kids.length / rows), extra = kids.length % rows, at = 0;
      for (var r = 0; r < rows; r++) {
        var per = base + (r < extra ? 1 : 0);
        var basis = 'calc((100% - ' + ((per - 1) * gap) + 'px) / ' + per + ' - 0.5px)';
        for (var j = 0; j < per && at < kids.length; j++, at++) kids[at].style.setProperty('--hd-bal-basis', basis);
      }
    } catch (e) {}
  }

  function watch(el) {
    try {
      if (watched.indexOf(el) === -1) {
        watched.push(el);
        if (ro) ro.observe(el);
      }
      balance(el);
    } catch (e) {}
  }

  function all() {
    watched = watched.filter(function (el) { return el.isConnected; });
    watched.forEach(balance);
  }

  try {
    var css = document.createElement('style');
    css.id = 'hd-balance-css';
    css.textContent =
      '.hd-balance > * { flex: 1 1 var(--hd-bal-basis, auto); min-width: 0; justify-content: center; text-align: center; }\n' +
      '.hd-balance.hd-bal-measure > * { flex: 0 0 auto !important; }\n';
    (document.head || document.documentElement).appendChild(css);
  } catch (e) {}

  try {
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(function (entries) {
        try { entries.forEach(function (e) { balance(e.target); }); } catch (err) {}
      });
    }
    window.addEventListener('resize', all);
    /* No ResizeObserver (not every engine build has one): a row rendered while its
       pane was hidden is laid out on the next input instead. Only watched rows, so
       this is a handful of measurements. */
    if (!ro) ['click', 'keyup'].forEach(function (t) {
      window.addEventListener(t, function () { (window.requestAnimationFrame || setTimeout)(all); }, { capture: true, passive: true });
    });
  } catch (e) {}

  balance.watch = watch;
  balance.all = all;
  window.hdBalance = balance;
})();
