/* ============================================================================
   FPS meter (2026-10-14) — the card behind hud-fps.css.
   Rober: "i always have to toggle on Community shaders fps, lets add this to
   hud elements that hooks to it so we can control the fps meter. if we could
   also maybe hook to puredarks so we can show fps engine and fps (frame gen)
   in ui elements without performance cost and toggable that would be amazing."

   Where the numbers come from (src/fps_meter.h has the whole story):
     ENGINE     frames the game itself drew, counted in the deck's present hook.
     FRAME GEN  frames shown on screen, read from PureDark's own counters
                (PDPerfPlugin GetFgFrameCounters) — the number his Upscaler menu
                calls "Framegen FPS". Measured, never engine x a ratio.
   C++ sends one `fpsPush` per refresh (0.5 / 1 / 2 s) and nothing else; this
   file only writes text and a transform per push. No timers, no loops.

   API (window.HDFps):
     note(d)            remember a push for the history bars (every push, shown or not)
     sig(o, d)          rebuild signature: the options and which columns exist
     build(root, o, d)  draw the card into `root` (o = gen, ms, graph, label, slim)
                        slim = one line, "32 fps | 128 FG": no labels, sub-lines
                        or history (Rober: "make sure to build a slim version")
     apply(root, d, o)  write the numbers in place
     editCard(o, cs, rateMs)  the edit-mode options card (buttons carry data-fpsact)
     fmtX(x)            "×4", "×3.7"
   ============================================================================ */
(function () {
  'use strict';

  var HIST = 30;               // history bars — 30 s at the default refresh
  var hist = [];               // engine fps, oldest first

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setText(e, t) { if (e && e.textContent !== t) e.textContent = t; }
  function setCls(e, c, on) { if (e && e.classList.contains(c) !== !!on) e.classList.toggle(c, !!on); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  function fmtX(x) {
    x = num(x);
    if (x == null || x <= 0) return '';
    var r = Math.round(x * 10) / 10;
    return '×' + (r % 1 ? r.toFixed(1) : String(r));
  }

  /* Which bands the engine number falls in. Frame generation makes a low
     engine rate FEEL like input lag rather than stutter (fps-vram-2026-10-13:
     "frame generation hid the low engine fps"), so the colour is the engine
     number's, not the frame-gen one's. */
  function band(fps) {
    if (fps == null) return '';
    return fps < 25 ? 'is-low' : fps < 45 ? 'is-mid' : 'is-high';
  }

  /* The frame-gen column exists when there is something honest to put in it:
     PureDark's counters answering (ok) or an Upscaler that is present but not
     generating right now (idle / nocounter). With no Upscaler at all it is
     simply left out, so the card is the engine number alone. */
  function genShown(o, d) {
    if (!o.gen || !d || !d.fg) return false;
    return d.fg.ok === true || d.fg.why === 'idle' || d.fg.why === 'nocounter';
  }

  function note(d) {
    var e = d && num(d.e);
    if (e == null) return;
    hist.push(e);
    if (hist.length > HIST) hist.splice(0, hist.length - HIST);
  }

  function sig(o, d) {
    return ['fps', o.slim ? 's' : '', o.label ? 'l' : '', o.ms ? 'm' : '', o.graph ? 'g' : '', genShown(o, d) ? 'f' : ''].join('|');
  }

  function column(kind, label, slim) {
    var c = el('div', 'hud-fps-col hud-fps-' + kind);
    if (!slim) c.appendChild(el('div', 'hud-fps-lab', label));
    var v = el('div', 'hud-fps-val');
    v.appendChild(el('b', 'hud-fps-n', '—'));
    /* slim keeps one word per number so the pair still reads without labels */
    v.appendChild(el('span', 'hud-fps-u', slim && kind === 'gen' ? 'FG' : 'fps'));
    c.appendChild(v);
    if (!slim) c.appendChild(el('div', 'hud-fps-sub', ''));
    return c;
  }

  function build(root, o, d) {
    var card = el('div', 'hud-fw-card hud-fps-card fw-in' + (o.slim ? ' is-slim' : ''));
    var row = el('div', 'hud-fps-row');
    var gen = genShown(o, d);
    row.appendChild(column('eng', gen ? 'Engine' : 'FPS', o.slim));
    if (gen) {
      row.appendChild(el('div', 'hud-fps-sep'));
      row.appendChild(column('gen', 'Frame gen', o.slim));
    }
    card.appendChild(row);
    if (o.graph && !o.slim) {
      var g = el('div', 'hud-fps-graph');
      for (var i = 0; i < HIST; i++) g.appendChild(el('i', ''));
      card.appendChild(g);
    }
    setCls(card, 'no-label', !o.label);
    root.appendChild(card);
    if (d) apply(root, d, o);
    return card;
  }

  function apply(root, d, o) {
    var card = root && root.querySelector('.hud-fps-card');
    if (!card || !d) return;
    var e = num(d.e);
    var eng = card.querySelector('.hud-fps-eng');
    if (eng) {
      setText(eng.querySelector('.hud-fps-n'), e == null ? '—' : String(e));
      var es = '';
      if (o.ms && num(d.ms)) es = d.ms.toFixed(1) + ' ms';
      setText(eng.querySelector('.hud-fps-sub'), es);
      setCls(eng, 'is-low', band(e) === 'is-low');
      setCls(eng, 'is-mid', band(e) === 'is-mid');
      setCls(eng, 'is-high', band(e) === 'is-high');
    }
    var gen = card.querySelector('.hud-fps-gen');
    if (gen) {
      var fg = d.fg || {};
      var ok = fg.ok === true && num(fg.o) != null;
      setText(gen.querySelector('.hud-fps-n'), ok ? String(fg.o) : '—');
      setText(gen.querySelector('.hud-fps-sub'),
        ok ? (fg.fw ? 'FrameWarp ' : '') + fmtX(fg.x)
          : fg.why === 'nocounter' ? 'not reported' : 'idle');
      setCls(gen, 'is-idle', !ok);
    }
    var g = card.querySelector('.hud-fps-graph');
    if (g) {
      /* Scale = the window's best, rounded up to a 30-fps step, never under 60:
         a flat 32 reads as "two thirds", a hitch to 12 drops visibly. scaleY,
         not height — a transform repaints without a layout pass. */
      var top = 60;
      for (var i = 0; i < hist.length; i++) if (hist[i] > top) top = hist[i];
      top = Math.ceil(top / 30) * 30;
      var bars = g.children, off = HIST - hist.length;
      for (var b = 0; b < bars.length; b++) {
        var v = b >= off ? hist[b - off] : null;
        var s = v == null ? 0 : Math.max(0.05, Math.min(1, v / top));
        var t = 'scaleY(' + String(+s.toFixed(3)) + ')';
        if (bars[b].style.transform !== t) bars[b].style.transform = t;
        var c = v == null ? 'is-empty' : band(v);
        if (bars[b].className !== c) bars[b].className = c;
      }
    }
    var tip = 'Engine ' + (e == null ? '—' : e + ' fps') +
      (num(d.ms) ? ' (' + d.ms.toFixed(1) + ' ms)' : '') +
      (num(d.worst) ? ', slowest frame ' + d.worst + ' ms' : '');
    if (d.fg && d.fg.ok) tip += '\nFrame gen ' + d.fg.o + ' fps ' + fmtX(d.fg.x) + ' — PureDark’s own count';
    if (card.title !== tip) card.title = tip;
  }

  /* ---- edit-mode options card --------------------------------------------- */
  function btn(act, label, title, on) {
    var b = el('button', 'hud-fpsx-btn' + (on ? ' is-on' : ''), label);
    b.setAttribute('data-fpsact', act);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  }
  function secs(ms) { var v = ms / 1000; return (v % 1 ? v.toFixed(1) : String(v)) + ' s'; }

  function editCard(o, cs, rateMs) {
    var ed = el('div', 'hud-fpsx-edit');
    ed.appendChild(el('div', 'hud-fpsx-title', 'FPS meter'));

    var r1 = el('div', 'hud-fpsx-row');
    var st = el('div', 'hud-fpsx-step');
    st.appendChild(el('span', 'hud-fpsx-lab', 'Refresh'));
    st.appendChild(btn('rate-', '−', 'Update more often'));
    st.appendChild(el('b', 'hud-fpsx-n', secs(rateMs)));
    st.appendChild(btn('rate+', '＋', 'Update less often'));
    r1.appendChild(st);
    ed.appendChild(r1);

    var r0 = el('div', 'hud-fpsx-row');
    r0.appendChild(el('span', 'hud-fpsx-lab', 'Style'));
    r0.appendChild(btn('plate', (!o.slim ? '✓ ' : '') + 'Plate',
      'Labels, frame time, the ratio and the history bars', !o.slim));
    r0.appendChild(btn('slim', (o.slim ? '✓ ' : '') + 'Slim',
      'One line: engine fps | frame-gen fps, nothing else', o.slim));
    ed.appendChild(r0);

    var r2 = el('div', 'hud-fpsx-row');
    r2.appendChild(btn('gen', (o.gen ? '✓ ' : '') + 'Frame gen',
      'Show frames on screen from PureDark’s Upscaler beside the engine number', o.gen));
    if (!o.slim) {
      r2.appendChild(btn('ms', (o.ms ? '✓ ' : '') + 'Frame time',
        'Milliseconds per engine frame under the engine number', o.ms));
      r2.appendChild(btn('graph', (o.graph ? '✓ ' : '') + 'History',
        'The last ' + HIST + ' readings as bars — a hitch shows as a dip', o.graph));
    }
    ed.appendChild(r2);

    ed.appendChild(el('div', 'hud-fpsx-title is-sub', 'Community Shaders overlay'));
    if (cs && cs.present) {
      var r3 = el('div', 'hud-fpsx-row');
      r3.appendChild(btn('cs', cs.on ? 'Overlay on — hide it' : 'Show the overlay',
        'Presses Community Shaders’ own overlay key (' + (cs.key || 'F10') + ')', cs.on));
      r3.appendChild(btn('csauto', (cs.auto ? '✓ ' : '') + 'Turn on when the game loads',
        'Once per launch, a few seconds into play', cs.auto));
      ed.appendChild(r3);
      ed.appendChild(el('div', 'hud-fpsx-note', cs.bound === false
        ? 'Its overlay key is unbound in Community Shaders, so there is nothing to press. Bind one in its menu (End).'
        : 'Uses its own key, ' + (cs.key || 'F10') + '. Pressing ' + (cs.key || 'F10') + ' yourself keeps this in step.'));
    } else {
      ed.appendChild(el('div', 'hud-fpsx-note', 'Community Shaders is not loaded.'));
    }
    return ed;
  }

  window.HDFps = { note: note, sig: sig, build: build, apply: apply, editCard: editCard, fmtX: fmtX, genShown: genShown,
    _hist: function () { return hist.slice(); } };
})();
