/* ===================================================================== *
 *  The live OStim alignment overlay.
 *
 *  Rober, 2026-09-21: "a dedicated alignment menu ... current one is bad,
 *  it needs to layer over, and not pause the game though if you call it,
 *  maybe use arrow keys plus e or enter to change stuff."
 *
 *  It rides the always-on HUD document and C++ gives that view real focus
 *  with pauseGame=false (main.cpp AgOpenAlign), so the scene keeps running
 *  while you adjust it.
 *
 *  ⚠ WHAT THE 2026-09-22 PLAY-TEST PROVED, and why this is mouse-first.
 *  The first cut was keyboard-ONLY and assumed a focused view takes the
 *  arrows away from the game. It does not. The log shows `align-overlay:
 *  open` with NO "Focus refused" — focus succeeded — and the screenshot
 *  shows the overlay's own axis cursor sitting on SOS bend (so the view got
 *  the ArrowUp) while OStim's furniture picker was open behind it (so the
 *  game got the SAME ArrowUp). Keys are delivered to BOTH. That is the
 *  deck's own standing law restated: the input sink cannot CONSUME events.
 *
 *  Two consequences, both baked in below:
 *
 *   · EVERY control is clickable. A keyboard-only overlay with no Close
 *     button is a softlock the moment anything upstream grabs a key —
 *     which is exactly what happened: Rober had to kill the game.
 *   · The keys are W/S/A/D/Q/E/R, never the arrows. Arrow keys are OStim's
 *     own scene navigation, so every nudge was also driving the scene. The
 *     WASD set is inert during a scene because OStim disables player
 *     movement, so the fall-through lands on nothing.
 *
 *  Bridge — JS -> C++:  agGet() · agAdjust(json) · agClose()
 *           C++ -> JS:  agState(json) · agShow("1"/"0")
 *
 *  agAdjust's reply IS the new state, so one round trip both applies the
 *  nudge and refreshes the readout; the 700ms poll exists only to notice
 *  the SCENE ending underneath us, which auto-closes rather than stranding
 *  an overlay over a finished scene.
 * ===================================================================== */

window.HudAlign = (function () {
  'use strict';

  /* Axis order is the order they appear, top to bottom. Step is what one
     Left/Right press moves; C++ owns the clamps (the same ones the Scene
     page's Alignment segment uses). */
  var AXES = [
    { key: 'x',        label: 'Left / right',   step: 1,  unit: '',  fine: 0.5 },
    { key: 'y',        label: 'Forward / back', step: 1,  unit: '',  fine: 0.5 },
    { key: 'z',        label: 'Height',         step: 1,  unit: '',  fine: 0.5 },
    { key: 'rotation', label: 'Rotation',       step: 5,  unit: '°', fine: 1 },
    { key: 'scale',    label: 'Scale',          step: 1,  unit: '×', fine: 1 },
    { key: 'bend',     label: 'SOS bend',       step: 1,  unit: '',  fine: 1 }
  ];

  var root = null, host = null, timer = 0;
  var state = { ok: false, actors: [] };
  var who = 0;         // index into state.actors
  var axis = 0;        // index into AXES
  var fineMode = false;  // a toggle, not a held Shift: Shift falls through too

  function send(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function actor() { return state.actors[who] || null; }

  /* ------------------------------------------------------------ paint -- */

  function build() {
    host = document.getElementById('hud-align');
    if (!host) return null;
    host.textContent = '';
    var card = el('section', 'ag-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Scene alignment');

    var head = el('header', 'ag-head');
    var titles = el('div', 'ag-titles');
    titles.append(el('h2', 'ag-title', 'Alignment'), el('div', 'ag-who'));
    /* The one control that must never depend on the keyboard. */
    var x = btn('ag-x', 'Close', function () { close(true); });
    head.append(titles, x);

    var tabs = el('div', 'ag-tabs');          /* one per actor; filled in paint */

    var rows = el('div', 'ag-rows');
    AXES.forEach(function (a, i) {
      var row = el('div', 'ag-row');
      row.dataset.axis = a.key;
      row.addEventListener('click', function () { axis = i; paint(); });
      var minus = btn('ag-step', '\u2212', function () { axis = i; paint(); nudge(-1); });
      var plus  = btn('ag-step', '+',       function () { axis = i; paint(); nudge(1); });
      row.append(el('span', 'ag-name', a.label), minus,
                 el('span', 'ag-value', '\u2014'), plus);
      rows.append(row);
    });

    var foot = el('div', 'ag-foot');
    foot.append(btn('ag-btn ag-fine', 'Fine steps', function () { fineMode = !fineMode; paint(); }),
                btn('ag-btn', 'Reset person', function () { reset(); }));

    var help = el('p', 'ag-help',
      'Click anything \u00b7 W / S pick \u00b7 A / D nudge \u00b7 Q / E person \u00b7 R reset \u00b7 Esc close');
    card.append(head, tabs, rows, foot, help);
    host.append(card);
    return card;
  }

  /* A button that stops its click reaching the row underneath it. */
  function btn(cls, label, onClick) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      onClick();
    });
    return b;
  }

  /* One step on the current axis, honouring the Fine toggle. */
  function nudge(dir) {
    var def = AXES[axis];
    if (!def) return;
    adjust(dir * (fineMode ? def.fine : def.step));
  }

  function paint() {
    if (!host) return;
    var a = actor();
    var whoEl = host.querySelector('.ag-who');
    if (whoEl) {
      whoEl.textContent = !state.ok ? 'No scene'
        : a ? a.name + (state.actors.length > 1 ? '  (' + (who + 1) + ' of ' + state.actors.length + ')' : '')
        : 'No participants';
    }
    var title = host.querySelector('.ag-title');
    if (title) title.textContent = state.sceneName || state.scene || 'Alignment';
    /* Actor tabs: clicking a name is the mouse equivalent of Q/E, and with
       one participant there is nothing to switch between, so no tabs. */
    var tabs = host.querySelector('.ag-tabs');
    if (tabs) {
      tabs.textContent = '';
      if (state.actors.length > 1) {
        state.actors.forEach(function (p, i) {
          var t = btn('ag-tab', p.name || ('Person ' + (i + 1)), function () { who = i; paint(); });
          t.dataset.on = String(i === who);
          tabs.append(t);
        });
      }
    }
    var fine = host.querySelector('.ag-fine');
    if (fine) fine.dataset.on = String(fineMode);
    host.querySelectorAll('.ag-row').forEach(function (row, i) {
      var def = AXES[i];
      var v = a ? a[def.key] : null;
      row.dataset.on = String(i === axis);
      var value = row.querySelector('.ag-value');
      /* Scale is the one that is not an offset: it reads 1.00× at rest, and
         printing it as "1" would look like the others' neutral zero. */
      value.textContent = (typeof v === 'number' && isFinite(v))
        ? (def.key === 'scale' ? v.toFixed(2) + def.unit
           : (Math.round(v * 10) / 10).toFixed(1) + def.unit)
        : '—';
    });
  }

  /* ------------------------------------------------------------ bridge -- */

  function adjust(delta) {
    var a = actor();
    if (!a || !state.ok) return;
    send('agAdjust', JSON.stringify({ formId: a.formId, axis: AXES[axis].key, delta: delta }));
  }
  function reset() {
    var a = actor();
    if (!a || !state.ok) return;
    send('agAdjust', JSON.stringify({ formId: a.formId, axis: 'reset', delta: 0 }));
  }
  function poll() {
    clearTimeout(timer); timer = 0;
    if (!root) return;
    send('agGet');
    timer = setTimeout(poll, 700);
  }

  /* -------------------------------------------------------------- keys -- */
  /* The overlay only sees these because C++ gave this view real focus; the
     same focus is what keeps them away from OStim and from the player's
     movement. Returns true when handled. */
  function onKey(e) {
    if (!root) return false;
    var k = e.key;
    var lower = (typeof k === 'string' && k.length === 1) ? k.toLowerCase() : k;
    if (k === 'Escape')                    { close(true); return true; }
    /* ⚠ NOT the arrow keys. They reach the view AND the game, and in the
       game they are OStim's scene navigation — the 2026-09-22 softlock. */
    if (lower === 'w')                     { axis = (axis + AXES.length - 1) % AXES.length; paint(); return true; }
    if (lower === 's')                     { axis = (axis + 1) % AXES.length; paint(); return true; }
    if (lower === 'a')                     { nudge(-1); return true; }
    if (lower === 'd')                     { nudge(1); return true; }
    if (lower === 'q' || lower === 'e') {
      if (state.actors.length > 1) {
        who = lower === 'e' ? (who + 1) % state.actors.length
                            : (who + state.actors.length - 1) % state.actors.length;
        paint();
      }
      return true;
    }
    if (lower === 'f')                     { fineMode = !fineMode; paint(); return true; }
    if (lower === 'r')                     { reset(); return true; }
    return false;
  }

  /* ------------------------------------------------------- open / close -- */

  function open() {
    if (root) return;
    root = build();
    if (!root) return;
    document.body.classList.add('ag-open');
    who = 0; axis = 0;
    paint();
    poll();
  }
  function close(tellCpp) {
    clearTimeout(timer); timer = 0;
    if (host) host.textContent = '';
    root = null; host = null;
    document.body.classList.remove('ag-open');
    /* agClose is how C++ learns to release the Focus it took. Without it the
       view keeps the keyboard and the player cannot move — the browse-mode
       lesson, which is why closing from the view ALWAYS reports back. */
    if (tellCpp) send('agClose');
  }

  /* --------------------------------------------------------- C++ -> JS -- */

  window.agShow = function (v) { if (String(v) === '1') open(); else close(false); };
  window.agState = function (raw) {
    var j;
    try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!j || typeof j !== 'object') return;
    state = j;
    state.actors = Array.isArray(j.actors) ? j.actors : [];
    if (who >= state.actors.length) who = 0;
    /* The scene ended under us: there is nothing left to align, so close
       rather than sit there holding the keyboard over a finished scene. */
    if (root && (!j.ok || !j.inScene || !state.actors.length)) { close(true); return; }
    paint();
  };

  document.addEventListener('keydown', function (e) {
    if (!root) return;
    if (onKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  return { isOpen: function () { return !!root; }, onKey: onKey, _state: function () { return { state: state, who: who, axis: axis }; } };
})();
