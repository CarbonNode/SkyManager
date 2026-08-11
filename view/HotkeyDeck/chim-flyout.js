'use strict';

/* ====================================================================== *
 *  CHIM flyout — the unified CHIM control for the F7 quick card.
 *
 *  Rober's ask (2026-08-06): "a single emoji button, you click and [the]
 *  flyouts pop up — Chim Background, Sharmat Background, Activate or Disable
 *  NPC (depending on current state)." Then (v2): "the active thing… asks me to
 *  press a key? Just have it hook to chim and activate or deactivate and track
 *  state — activate if deactivated and vice versa."
 *
 *  So Activate/Disable is a REAL toggle now, not a key press. It hooks CHIM's
 *  own game-side natives through the deck's C++ (chim_control.cpp):
 *    • chState { formId, name }        → C++ getAgentByName → chStateResult
 *    • chSet   { formId, name, on }    → C++ setDrivenByAIA / removeAgentByName
 *                                        → chStateResult (optimistic, then
 *                                          reconciled from CHIM's agent set)
 *  The row's label follows the TRUE state: "Disable NPC" when she is a CHIM
 *  agent, "Activate NPC" when she is not.
 *
 *  The BUTTON itself is built by followers-pane's own quickBtn(); this module
 *  owns only the flyout and the three actions:
 *    • CHIM Background   → HDOmni.askAbout(original)   (the dossier)
 *    • Sharmat Background → SmPane.open(original, who) (the live editor)
 *    • Activate / Disable → the CHIM-native toggle above.
 * ====================================================================== */

var ChimBtn = (function () {
  /* True CHIM-agent state, keyed by original name, learned from chStateResult.
     undefined ⇒ not yet known ⇒ the row shows a neutral "Activate NPC" until
     the state read lands (usually <100 ms after the flyout opens). */
  var active = Object.create(null);
  var known = Object.create(null);

  var fly = null;          // the mounted popover element
  var onEsc = null;        // bound Esc handler
  var currentCtx = null;

  /* ---- tiny self-contained DOM helper ----------------------------------- */
  function mk(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function toG(name, arg) {
    if (typeof toGame === 'function') toGame(name, arg === undefined ? '' : arg);
  }

  function teardown() {
    if (fly) { try { fly.remove(); } catch (e) {} fly = null; }
    document.removeEventListener('mousedown', outside, true);
    if (onEsc) { document.removeEventListener('keydown', onEsc, true); onEsc = null; }
  }
  function close() { teardown(); }
  function outside(e) { if (fly && !fly.contains(e.target)) close(); }

  /* ---- the three actions ------------------------------------------------ */
  function doBackground(ctx) {
    close();
    if (window.HDOmni && typeof HDOmni.askAbout === 'function') {
      HDOmni.askAbout(ctx.original, 'Tell me about ' + ctx.who
        + ' — background, personality, relationships and goals.');
    }
  }
  function doSharmat(ctx) {
    close();
    if (window.SmPane && typeof SmPane.open === 'function') {
      SmPane.open(ctx.original, ctx.who);
    }
  }
  /* Toggle CHIM AI. Optimistic: flip our local view of her state and re-render
     at once so the button feels instant; the C++ reply (chStateResult)
     reconciles it against CHIM's own agent set a moment later. */
  function toggleActive(ctx) {
    var want = !active[ctx.original];
    active[ctx.original] = want;
    known[ctx.original] = true;
    toG('chSet', JSON.stringify({
      formId: Number(ctx.formId) || 0, name: ctx.original, on: want,
    }));
    render(ctx);
  }

  /* ---- state read: C++ -> view ------------------------------------------ *
   *  chStateResult { formId, name, active, ok }. Update our map and, if the
   *  flyout is open for that person, repaint the row.                        */
  function onStateResult(payload) {
    var env = payload;
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || !env.ok) return;
    var nm = String(env.name || '');
    if (!nm) return;
    active[nm] = !!env.active;
    known[nm] = true;
    if (fly && currentCtx && currentCtx.original === nm) render(currentCtx);
  }

  /* ---- the flyout -------------------------------------------------------- */
  function itemBtn(icon, label, sub, opts, on) {
    var b = mk('button', 'chim-fly-item' + (opts && opts.on ? ' on' : '')
                                          + (opts && opts.disabled ? ' is-disabled' : ''));
    b.type = 'button';
    if (opts && opts.title) b.title = opts.title;
    b.appendChild(mk('span', 'chim-fly-ic', icon));
    var col = mk('span', 'chim-fly-text');
    col.appendChild(mk('span', 'chim-fly-lbl', label));
    if (sub) col.appendChild(mk('span', 'chim-fly-sub', sub));
    b.appendChild(col);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts && opts.disabled) return;
      on(e);
    });
    return b;
  }

  function render(ctx) {
    currentCtx = ctx;
    if (fly) { try { fly.remove(); } catch (e) {} fly = null; }

    fly = mk('div', 'chim-fly');
    fly.setAttribute('role', 'menu');

    var head = mk('div', 'chim-fly-head');
    head.appendChild(mk('span', 'chim-fly-head-ic', '💬'));
    head.appendChild(mk('span', 'chim-fly-head-t', 'CHIM — ' + ctx.who));
    fly.appendChild(head);

    /* 1) CHIM Background */
    fly.appendChild(itemBtn('📖', 'CHIM Background',
      'Bio, personality, relationships & goals',
      { title: 'Ask CHIM everything it holds on ' + ctx.who
             + ' — background, personality, relationships, goals, recent diary.' },
      function () { doBackground(ctx); }));

    /* 2) Sharmat Background */
    var hasSm = !!(window.SmPane && typeof SmPane.open === 'function');
    fly.appendChild(itemBtn('⚭', 'Sharmat Background',
      hasSm ? 'Kinks, speak style, status — live edit' : 'Sharmat isn’t loaded',
      { title: 'Open ' + ctx.who + '’s Sharmat profile — CHIM’s per-NPC '
             + 'kinks / speak style / status. Edits are live.', disabled: !hasSm },
      function () { doSharmat(ctx); }));

    /* 3) Activate / Disable — the CHIM-native toggle. */
    var isOn = !!active[ctx.original];
    var stateKnown = !!known[ctx.original];
    var canFire = !ctx.dead;
    var sub = ctx.dead ? ctx.who + ' is dead'
            : !stateKnown ? 'Reading CHIM state…'
            : isOn ? 'CHIM AI is on — click to deactivate'
                   : 'CHIM AI is off — click to activate';
    fly.appendChild(itemBtn(isOn ? '⛔' : '⚡',
      isOn ? 'Disable NPC' : 'Activate NPC', sub,
      { on: isOn, disabled: !canFire,
        title: 'Manual CHIM AI activation for ' + ctx.who
             + '. Hooks CHIM directly (no key) and tracks her real agent state.' },
      function () { toggleActive(ctx); }));

    mountAt(ctx.anchorRect);
  }

  /* The deck's viewport size. Ultralight does not populate window.innerWidth
     reliably — read #overlay's rect first, fall back to window. */
  function viewport() {
    var host = document.getElementById('overlay');
    if (host) {
      var r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
    }
    return { w: window.innerWidth || 1280, h: window.innerHeight || 720 };
  }

  function mountAt(r) {
    var host = document.getElementById('overlay') || document.body;
    host.appendChild(fly);
    fly.style.position = 'fixed';
    fly.style.visibility = 'hidden';
    fly.style.left = '0px'; fly.style.top = '0px';
    var vp = viewport(), vw = vp.w, vh = vp.h;
    var fw = fly.offsetWidth || 260, fh = fly.offsetHeight || 180;
    var ax = r ? r.left : 40, ay = r ? r.bottom : 120, atop = r ? r.top : 100;
    var left = Math.max(8, Math.min(ax, vw - fw - 8));
    var top = ay + 6;
    if (top + fh > vh - 8) top = Math.max(8, atop - fh - 6);   // flip above if no room
    fly.style.left = Math.round(left) + 'px';
    fly.style.top = Math.round(top) + 'px';
    fly.style.visibility = 'visible';
  }

  /* ---- public: open the flyout anchored at the CHIM button -------------- *
   *  ctx = { original, who, dead, formId }.                                  */
  function open(anchorEl, ctx) {
    teardown();
    if (!ctx) return;
    var rect = (anchorEl && anchorEl.getBoundingClientRect)
      ? anchorEl.getBoundingClientRect() : null;
    ctx.anchorRect = rect;
    render(ctx);
    /* Ask C++ for her true CHIM-agent state so the toggle label is truthful. */
    if (!ctx.dead) {
      toG('chState', JSON.stringify({ formId: Number(ctx.formId) || 0, name: ctx.original }));
    }
    onEsc = function (e) { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  /* C++ pushes state through this global (registered like the deck's other
     *Result receivers). */
  window.chStateResult = onStateResult;

  return {
    open: open,
    close: close,
    onStateResult: onStateResult,
    /* exposed for the harness */
    _state: function () { return { active: active, known: known, fly: fly }; },
  };
})();
window.ChimBtn = ChimBtn;
