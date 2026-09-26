'use strict';

/* ====================================================================== *
 *  Fixes popout — the 🔧 on the F7 quick card.
 *
 *  2026-09-23: a centred, body-anchored POPOUT, no longer a flyout anchored
 *  under the button. Rober: "this dropdown should be a popout modal, its
 *  cutting off screen" — a ten-row anchored list opened from a button low on
 *  the card ran off the bottom of the screen, and the deck's standing rule is
 *  that anything revealing more content opens as its own spacious popout
 *  (CLAUDE.md, "Anything that reveals more content…"). Same verbs, same probe,
 *  same refusals; only the container changed. Like .gaw-back it fills the
 *  viewport, so its bare vh/vw is correct and it wears NO --ui-scale.
 *
 *  Rober's ask (2026-09-20): "sometimes npcs get stuck following me, but are
 *  not followers, how can we fix this and add a function to an npc to fix
 *  them … maybe a new button (like chim with dropdown) with fixes - this
 *  could be one of the fixes."
 *
 *  So: the CHIM button's flyout shape (chim-flyout.js), holding the repair
 *  verbs that used to exist ONLY as palette hotkeys (fix_actions.cpp), plus
 *  the new one — Stop her following.
 *
 *  ---- what talks to what ------------------------------------------------
 *    JS  → C++ : hdFixProbe { formId }              (pure read)
 *    C++ → JS  : hdFixProbeResult { ok, why[], blocked, fixable, … }
 *    JS  → C++ : hdFixApply { formId, fix, force }
 *    C++ → JS  : hdFixResult { ok, msg, changed[] }  + a fresh probe behind it
 *
 *  ---- ⛔ WHY THIS SHOWS A DIAGNOSIS BEFORE IT OFFERS A FIX ⛔ -------------
 *  "She keeps following me" is FOUR different faults (see fix_actions.h), and
 *  three of them look identical from here:
 *    · a leaked teammate flag / follower faction  → we can clear it
 *    · a quest ALIAS running a follow package     → actor-level clearing does
 *      NOTHING, and would report success anyway — the exact silent no-op the
 *      deck already got burned by on freeze/sit/bed
 *    · a follower FRAMEWORK that still thinks it has her → clearing underneath
 *      it leaves it holding her and may break its own dismiss
 *    · a stale package nothing has re-evaluated   → Reset AI is the fix
 *  So the flyout PROBES on open, prints what it found in the words the player
 *  needs, and only then offers the button — which the C++ can still refuse,
 *  because she may have been recruited in the seconds the flyout was open.
 *  Never turn this into a one-click "fix everything": that is how you get a
 *  button that lies.
 * ====================================================================== */

var FixBtn = (function () {

  /* Last probe, keyed by the formId it was about. Kept so reopening the
     flyout on the same person paints instantly instead of flashing "reading". */
  var probes = Object.create(null);

  var fly = null;
  var onEsc = null;
  var currentCtx = null;
  var busy = '';          // the fix currently in flight, or ''
  var result = null;      // { ok, msg } from the last apply
  var armed = '';         // a fix that needs a second click (the forceful one)

  /* ---- tiny self-contained DOM helper (mirrors chim-flyout.js) ---------- */
  function mk(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function toG(name, arg) {
    if (typeof toGame === 'function') toGame(name, arg === undefined ? '' : arg);
  }
  /* `fly` is the BACKDROP (.fx-back); the card is its only child. */
  function teardown() {
    if (fly) { try { fly.remove(); } catch (e) {} fly = null; }
    if (onEsc) { document.removeEventListener('keydown', onEsc, true); onEsc = null; }
  }
  function close() { teardown(); currentCtx = null; armed = ''; }
  function isOpen() { return !!fly; }

  function hexOf(fid) {
    var n = Number(fid) || 0;
    if (!n) return '';
    var s = (n >>> 0).toString(16).toUpperCase();
    while (s.length < 8) s = '0' + s;
    return s;
  }

  /* ---- the verbs -------------------------------------------------------- *
   *  `needsBody` = pointless on a corpse. `player` = no NPC involved at all.
   *  The order is the order you would try them in.                          */
  var FIXES = [
    { id: 'recoverDismiss', ic: '🚫', label: 'Dismiss and repair',
      sub: 'Use her follower mod, refresh AI, verify she left',
      tip: 'Tries the owning follower controller first. Clears leftover flags only after no quest or framework owns her. Stops if the controller does not answer.',
      needsBody: true, lead: true },
    { id: 'recoverRecruit', ic: '✚', label: 'Restore following',
      sub: 'Repair a half-recruit, then verify she joined',
      tip: 'Uses her supported follower controller and checks the result. Does not bypass a custom companion story or make an unwilling NPC recruitable.',
      needsBody: true },
    { id: 'unfollow', ic: '🚫', label: 'Stop her following',
      sub: 'She trails you but is not your follower',
      tip: 'Clears the leftover teammate flag and the follower factions, then re-evaluates her AI. '
         + 'If a quest or a follower mod is what is holding her, this says so instead of pretending.',
      needsBody: true, lead: true },
    { id: 'resetai', ic: '♻', label: 'Reset AI',
      sub: 'Re-evaluate her packages',
      tip: 'Makes the engine pick her package again. The fix for "she is still doing the thing she was '
         + 'doing ten minutes ago".',
      needsBody: true },
    { id: 'recycle', ic: '🔄', label: 'Rebuild her',
      sub: 'T-posing, invisible, wedged in place',
      tip: 'recycleactor — throws away her 3D and her AI and builds both again. Heavier than Reset AI '
         + 'and the answer when she is visually broken rather than behaviourally.',
      needsBody: true },
    { id: 'calm', ic: '🕊', label: 'Stop fighting',
      sub: 'Ends combat and drops aggression',
      tip: 'stopcombat plus aggression 0 — for the guard who will not stop swinging at someone.',
      needsBody: true },
    { id: 'resurrect', ic: '✚', label: 'Bring her back',
      sub: 'Resurrect, keeping her inventory',
      tip: 'resurrect 1 — she stands up with everything she was carrying. Only offered on a corpse.',
      deadOnly: true },
    { id: 'noclip', ic: '👣', label: 'Noclip (you)',
      sub: 'Walk out of the scenery',
      tip: 'tcl — toggles YOUR collision, not hers. Fire it again to put it back. Here because this is '
         + 'where you look when something is stuck, and sometimes the something is you.',
      player: true },
  ];

  /* ---- probe ------------------------------------------------------------ */
  function probeKey(ctx) { return String(ctx && ctx.formId ? ctx.formId : 0); }
  function probeFor(ctx) { return probes[probeKey(ctx)] || null; }

  function askProbe(ctx) {
    if (!ctx || !ctx.formId) return;
    var p = probes[probeKey(ctx)];
    if (!p) probes[probeKey(ctx)] = { pending: true };
    else p.pending = true;
    /* Re-render, so a REOPEN says it is re-checking rather than presenting a
       minute-old verdict as current. The cached verdict stays on screen while
       it does — flashing "reading…" over an answer we already have would be
       worse — but it is labelled. */
    if (fly && currentCtx) render(currentCtx);
    toG('hdFixProbe', JSON.stringify({ formId: hexOf(ctx.formId) }));
  }

  /* C++ answers here. Tolerant of a string OR an object, like every other
     view callback — PrismaUI has handed both shapes to listeners. */
  function onProbe(env) {
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || typeof env !== 'object') return;
    /* The reply carries no formId, so it belongs to whoever we last asked
       about — which is the open flyout's subject, because nothing else asks. */
    var key = currentCtx ? probeKey(currentCtx) : '';
    if (!key) return;
    env.pending = false;
    probes[key] = env;
    if (fly && currentCtx) render(currentCtx);
  }

  function onResult(env) {
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || typeof env !== 'object') return;
    busy = '';
    result = { ok: env.ok !== false, msg: String(env.msg || (env.ok !== false ? 'Done' : 'Could not do that')) };
    /* Hand it to the card's own status line as well, so the answer survives
       the flyout being dismissed — the same courtesy Add-as-mount gets. */
    if (typeof window.fqFixStatus === 'function') window.fqFixStatus(result);
    if (fly && currentCtx) render(currentCtx);
  }

  function fire(ctx, fix, force) {
    if (runRecovery(ctx, fix)) return;
    busy = fix; result = null; armed = '';
    render(ctx);
    toG('hdFixApply', JSON.stringify({
      formId: hexOf(ctx.formId), fix: fix, force: !!force,
    }));
  }

  function runRecovery(ctx, fix) {
    if (fix !== 'recoverDismiss' && fix !== 'recoverRecruit') return false;
    if (!ctx || !ctx.formId || ctx.dead) return true;
    close();
    // The existing fdNpc door releases the palette for Papyrus and delivers
    // its verified result to the NPC card, including when opened from search.
    toG('fdNpc', JSON.stringify({
      op: fix === 'recoverRecruit' ? 'recruit' : 'dismiss',
      formId: hexOf(ctx.formId), recover: true,
    }));
    return true;
  }

  /* Fire a verb with NO flyout open. The quick card's action search indexes
     these verbs (fqFixRows in followers-pane.js) and runs them straight from
     the box, which is the whole point of a search bar - but `fire` renders
     the flyout, so it cannot be the door. `onResult` hands every answer to
     window.fqFixStatus BEFORE it touches `fly`, so the card's own status line
     still reports what happened.

     "unfollow" is REFUSED here on purpose. Its value is the probe's refusal -
     blocked by a quest alias, owned by a framework, armed before a force -
     and a caller that fired it blind would throw away exactly the safety it
     exists to provide. Search routes that one to open() instead. */
  function runDetached(ctx, fix, force) {
    if (!ctx || !ctx.formId) return false;
    if (runRecovery(ctx, fix)) return true;
    if (fix === 'unfollow') return false;
    busy = ''; result = null; armed = '';
    toG('hdFixApply', JSON.stringify({
      formId: hexOf(ctx.formId), fix: String(fix), force: !!force,
    }));
    return true;
  }

  /* ---- the flyout ------------------------------------------------------- */
  function itemBtn(icon, label, sub, opts, on) {
    var b = mk('button', 'fx-item' + (opts && opts.disabled ? ' is-disabled' : '')
                                   + (opts && opts.danger ? ' fx-danger' : '')
                                   + (opts && opts.lead ? ' fx-lead' : '')
                                   + (opts && opts.wide ? ' fx-wide' : ''));
    b.type = 'button';
    if (opts && opts.title) b.title = opts.title;
    b.appendChild(mk('span', 'fx-item-ic', icon));
    var col = mk('span', 'fx-item-text');
    col.appendChild(mk('span', 'fx-item-lbl', label));
    if (sub) col.appendChild(mk('span', 'fx-item-sub', sub));
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

    fly = mk('div', 'fx-back');
    fly.addEventListener('mousedown', function (e) { if (e.target === fly) close(); });
    var card = mk('div', 'fx-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Fixes for ' + ctx.who);
    fly.appendChild(card);

    var head = mk('div', 'fx-head');
    head.appendChild(mk('span', 'fx-head-ic', '🔧'));
    head.appendChild(mk('span', 'fx-head-t', 'Fixes — ' + ctx.who));
    var x = mk('button', 'fx-close', 'Close');
    x.type = 'button';
    x.title = 'Close (Esc)';
    x.addEventListener('click', function (e) { e.stopPropagation(); close(); });
    head.appendChild(x);
    card.appendChild(head);

    /* Everything below goes into the card; `fly` stays the backdrop. */
    var body = mk('div', 'fx-diag');
    card.appendChild(body);

    var p = probeFor(ctx);
    var stale = false;

    /* ---- the diagnosis, before any button ---- */
    if (!ctx.dead) {
      stale = !!(p && p.pending && p.ok !== undefined);   // a re-check over an answer we have
      if (!p || (p.pending && p.ok === undefined)) {
        body.appendChild(mk('div', 'fx-note', 'Reading what the engine thinks she is…'));
      } else if (p.ok === false) {
        body.appendChild(mk('div', 'fx-note bad', String(p.msg || 'Could not read her state.')));
      } else if (p.following) {
        var why = mk('div', 'fx-note warn');
        /* A framework slot with NO leaked flag is not "the game thinks she
           follows" - the engine flags are clean; it is the framework that
           still has her (Ambrelie, 2026-09-23: NFF slot, dismiss interrupted). */
        var flagged = p.teammate || p.inCurrentFollowerFaction || p.inPlayerFollowerFaction;
        why.appendChild(mk('div', 'fx-note-t', (p.owner && !flagged)
          ? p.owner + ' still counts her as one of your followers.'
          : 'The game thinks she is following you.'));
        (p.why || []).forEach(function (line) { why.appendChild(mk('div', 'fx-why', '• ' + line)); });
        (p.holders || []).forEach(function (q) {
          why.appendChild(mk('div', 'fx-why', '• Held by quest ' +
            (q.questName || q.quest || '(unnamed)') +
            (q.plugin ? ' (' + q.plugin + ')' : '')));
        });
        if (p.blocked) why.appendChild(mk('div', 'fx-why blocked', p.blocked));
        body.appendChild(why);
      } else if (p.suggestResetAi) {
        body.appendChild(mk('div', 'fx-note warn',
          'Nothing is flagged on her, but the package she is running is a follow package — '
          + 'the engine has not re-evaluated her. Reset AI is the one to try.'));
      } else {
        body.appendChild(mk('div', 'fx-note',
          'Nothing is holding her: not a teammate, not in a follower faction, no quest running a '
          + 'follow package on her.'));
      }
    }

    if (!ctx.dead && stale) {
      body.appendChild(mk('div', 'fx-note', 'Re-checking with the engine…'));
    }

    /* ---- the last thing we did ---- */
    if (result) {
      body.appendChild(mk('div', 'fx-note ' + (result.ok ? 'good' : 'bad'), result.msg));
    }

    /* ---- the verbs ----
       An even two-column grid of equal tiles. The player-only verb (Noclip)
       is a different kind of thing, so it takes its own full-width row -
       which also means an odd count never leaves one tile dangling. */
    var grid = mk('div', 'fx-grid');
    card.appendChild(grid);
    var owner = (p && !p.pending && p.ok !== false && p.owner) ? String(p.owner) : '';
    FIXES.forEach(function (f) {
      if (f.deadOnly && !ctx.dead) return;
      if (f.needsBody && ctx.dead) return;

      var running = busy === f.id;
      var sub = f.sub;
      var danger = false;
      var force = false;

      if (f.id === 'unfollow' && p && p.ok !== false && !p.pending) {
        if (!p.following) {
          sub = 'Nothing to stop — she is not following';
        } else if (p.blocked) {
          /* The refusal is the POINT. The button stays live, but it is armed
             and coloured, and it says what it is about to override. */
          sub = armed === f.id ? 'Force it anyway — sure?' : 'Blocked — read the note above';
          danger = true;
          force = armed === f.id;
        } else if (p.fixable) {
          sub = 'Clear the flags and re-evaluate her';
        }
      }
      if (f.id === 'recoverDismiss' && owner) sub = 'Goes through ' + owner + ', then verifies she left';
      if (running) sub = 'Working…';

      grid.appendChild(itemBtn(f.ic, armed === f.id ? 'Force: ' + f.label : f.label, sub,
        { title: f.tip, disabled: !!busy, danger: danger && armed === f.id,
          lead: f.id === 'recoverDismiss' && !!owner, wide: !!f.player },
        function () {
          if (f.id === 'unfollow' && p && p.blocked && armed !== f.id) {
            armed = f.id;
            render(ctx);
            setTimeout(function () { if (armed === f.id) { armed = ''; if (fly) render(ctx); } }, 4000);
            return;
          }
          fire(ctx, f.id, force);
        }));
    });

    /* The raw dossier is one click away — this flyout is the summary, 🔍 Debug
       is the evidence, and a player chasing a weird one wants both. */
    card.appendChild(mk('div', 'fx-foot',
      'Still wrong? The 🔍 Debug button on this card shows the raw engine truth — every faction with '
      + 'its rank, every quest alias, and the package in force.'));

    mount();
  }

  /* Body-anchored, like .gaw-back: the backdrop fills the viewport and the
     card centres itself, so there is no anchor maths left to get wrong. */
  function mount() {
    document.body.appendChild(fly);
  }

  /* ---- public ----------------------------------------------------------- *
   *  ctx = { who, formId, dead }.                                            */
  function open(anchorEl, ctx) {
    if (fly) { close(); return; }        // toggle, like the card's other reveals
    if (!ctx) return;
    busy = ''; result = null; armed = '';
    render(ctx);
    if (!ctx.dead) askProbe(ctx);
    /* The popout OWNS Escape while it is up: captured above the deck's own
       handler, so Esc closes this and not the deck behind it. */
    onEsc = function (e) {
      if (e.code === 'Escape' || e.key === 'Escape') {
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (e.preventDefault) e.preventDefault();
        close();
      }
    };
    var h = onEsc;
    setTimeout(function () {
      if (fly && onEsc === h) document.addEventListener('keydown', h, true);
    }, 0);
  }

  window.hdFixProbeResult = onProbe;
  window.hdFixResult = onResult;

  return {
    open: open, close: close, isOpen: isOpen, run: runDetached,
    /* exposed for the standalone harness */
    _probe: onProbe, _result: onResult, _fixes: FIXES, _probes: probes,
  };
})();
