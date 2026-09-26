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

  /* ---- the WHOLE agent set (2026-09-14) ---------------------------------
     Rober: "when searching can show a hoverable chim icon showing activated
     (if activated)" — and the 💬 on the F7 card should be lit for her, not
     wait for a flyout to ask. One C++ call (chAgents → findAllAgentsFormId)
     answers for everyone at once; per-NPC chState stays the flyout's own
     truth read. Keyed THREE ways because the roster and CHIM disagree on
     what a person is called: runtime formId (durable inside one session),
     her display name, and her base name (the roster's `original`). */
  var agents = { ids: Object.create(null), names: Object.create(null),
                 list: [], known: false, at: 0 };
  var AGENTS_TTL = 8000;   // ms — a re-ask sooner than this is the same answer

  function fidOf(v) {
    if (v == null || v === '') return 0;
    var n = (typeof v === 'number') ? v : Number(String(v).trim());
    return isFinite(n) ? (n >>> 0) : 0;
  }
  function lc(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  /* Ask C++ for the agent set — throttled, because the card, the omni and the
     flyout all want it at about the same moment. `force` = the omni just
     opened / a toggle just fired: the answer may have changed, ask anyway. */
  function ensureAgents(force) {
    var now = Date.now();
    if (!force && agents.at && (now - agents.at) < AGENTS_TTL) return;
    agents.at = now;
    toG('chAgents', '');
  }

  /* Is this person a CHIM agent? true / false / undefined (not known yet —
     nothing has answered, so callers draw the neutral state, never "off"). */
  function isAgent(who) {
    if (!agents.known || !who) return agents.known ? false : undefined;
    var fid = fidOf(who.formId);
    if (fid && agents.ids[fid]) return true;
    var keys = [who.original, who.name, who.base];
    for (var i = 0; i < keys.length; i++) {
      var k = lc(keys[i]);
      if (k && agents.names[k]) return true;
    }
    return false;
  }

  /* The omni `marks` entry for a row — the hoverable CHIM icon. Same contract
     as the ♥ wife / ◍ expecting marks followers-pane emits (hd-omni.js
     marksHtml): { g, cls, title }. Empty when she is not (or not yet known
     to be) an agent, so a row never carries a stale badge. */
  function markFor(who) {
    if (isAgent(who) !== true) return [];
    var nm = (who && (who.name || who.original)) ? String(who.name || who.original) : 'She';
    return [{ g: '\uD83D\uDCAC', cls: 'chim',
              title: 'CHIM AI is ON \u2014 ' + nm + ' is a live CHIM agent. '
                   + 'The \uD83D\uDCAC on her F7 card turns it off.' }];
  }

  /* Everyone who cares about the set: the F7 card repaints its 💬, the omni
     re-collects so labels and marks follow. */
  function agentsChanged() {
    try { window.dispatchEvent(new CustomEvent('hd-chim-agents')); } catch (e) {}
    try {
      if (window.HDOmni && typeof HDOmni.isOpen === 'function' && HDOmni.isOpen()
          && typeof HDOmni.rerender === 'function') HDOmni.rerender();
    } catch (e) {}
  }

  /* A toggle (ours, optimistic) or a per-NPC truth read moves ONE person in
     the set, so the badge and the lit button follow the click at once rather
     than on the next chAgents round-trip. */
  function syncAgent(name, formId, on) {
    var fid = fidOf(formId), k = lc(name);
    if (on) {
      if (fid) agents.ids[fid] = true;
      if (k) agents.names[k] = true;
      var have = false;
      for (var i = 0; i < agents.list.length; i++) {
        var a = agents.list[i];
        if ((fid && a.formId === fid) || (k && (lc(a.name) === k || lc(a.base) === k))) { have = true; break; }
      }
      if (!have) agents.list.push({ formId: fid, name: String(name || ''), base: '' });
    } else {
      if (fid) delete agents.ids[fid];
      if (k) delete agents.names[k];
      agents.list = agents.list.filter(function (a) {
        if (fid && a.formId === fid) { delete agents.names[lc(a.name)]; delete agents.names[lc(a.base)]; return false; }
        if (k && (lc(a.name) === k || lc(a.base) === k)) { if (a.formId) delete agents.ids[a.formId]; delete agents.names[lc(a.name)]; delete agents.names[lc(a.base)]; return false; }
        return true;
      });
    }
    /* a per-person fact is a fact even before the first whole-set answer */
    agents.known = true;
    agentsChanged();
  }

  /* ---- C++ -> view: chAgentsResult { ok, agents: [{ formId, name, base }] } */
  function onAgentsResult(payload) {
    var env = payload;
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || !env.ok || !Array.isArray(env.agents)) return;
    var ids = Object.create(null), names = Object.create(null), list = [];
    for (var i = 0; i < env.agents.length; i++) {
      var a = env.agents[i] || {};
      var fid = fidOf(a.formId);
      var it = { formId: fid, name: String(a.name || ''), base: String(a.base || '') };
      if (fid) ids[fid] = true;
      if (lc(it.name)) names[lc(it.name)] = true;
      if (lc(it.base)) names[lc(it.base)] = true;
      list.push(it);
    }
    agents.ids = ids; agents.names = names; agents.list = list;
    agents.known = true; agents.at = Date.now();
    /* Keep the flyout's per-name memory honest too: a name we have an
       opinion on flips to what the set says. */
    for (var nm in known) {
      if (!Object.prototype.hasOwnProperty.call(known, nm)) continue;
      active[nm] = !!names[lc(nm)];
    }
    for (var j = 0; j < list.length; j++) {
      var key = list[j].base || list[j].name;
      if (key) { active[key] = true; known[key] = true; }
    }
    if (fly && currentCtx) render(currentCtx);
    agentsChanged();
  }

  /* Whoever was under the crosshair when the palette opened — the same
     snapshot hd-npctune.js and the F7 card read (fdTarget → FolPane state).
     `original` comes from her roster row when she has one: that is the name
     CHIM's removeAgentByName knows her by. */
  function crosshairNpc() {
    try {
      var t = window.FolPane && FolPane._state && FolPane._state.target;
      var id = t ? fidOf(t.formId) : 0;
      if (!id || !t.name) return null;
      var original = String(t.name);
      try {
        var r = (typeof FolPane._rosterEntryFor === 'function') ? FolPane._rosterEntryFor(t.name) : null;
        if (r && r.m && r.m.original) original = String(r.m.original);
      } catch (e) {}
      return { formId: id, name: String(t.name), original: original, dead: !!t.dead };
    } catch (e) {}
    return null;
  }

  function say(msg) {
    if (typeof window.toast === 'function') { try { window.toast(msg); return; } catch (e) {} }
    if (typeof window.hdToast === 'function') { try { window.hdToast(msg); } catch (e) {} }
  }

  /* The omni row's verb: activate if she is off (or unknown), deactivate if
     on. Same wire as the flyout's toggle, same optimistic sync. */
  function omniToggle() {
    var npc = crosshairNpc();
    if (!npc) { say('Look at someone first \u2014 CHIM activation is for the person in your crosshair'); return; }
    if (npc.dead) { say(npc.name + ' is dead'); return; }
    var want = isAgent(npc) !== true;
    active[npc.original] = want;
    known[npc.original] = true;
    syncAgent(npc.original, npc.formId, want);
    if (npc.name !== npc.original) syncAgent(npc.name, npc.formId, want);
    toG('chSet', JSON.stringify({ formId: npc.formId, name: npc.original, on: want }));
    say(want ? '\u26A1 CHIM AI activating on ' + npc.name
             : '\u26D4 CHIM AI switched off for ' + npc.name);
  }

  var fly = null;          // the mounted popover element
  var onEsc = null;        // bound Esc handler
  var currentCtx = null;

  /* ---- CHIM-side state (2026-09-21) --------------------------------------
     Rober: "chim dropdown should have like write diary option as well, or
     refresh dynamic profile or enable dynamic profile settings … also show the
     current LLM model its using". All of it lives in CHIM's database, not in
     the game, so it rides the deck's existing HTTP pipe to deck_ask.php
     (HDOmni.chimCall → haAsk → C++ ask.cpp): mode=chim_state on open (a DB
     read — the model, the dynamic flag, the last diary line), then
     dynprof_set / dynprof_refresh / diary on the rows. Keyed by her original
     name, like `active` above. busy[name] = which row is mid-flight. */
  var chim = Object.create(null);   // name -> chim_state reply (json)
  var busy = Object.create(null);   // name -> 'diary' | 'dynprof' | 'refresh'
  var note = Object.create(null);   // name -> last outcome line for the sub
  var since = Object.create(null);  // name -> Date.now() when the busy call left
  var result = Object.create(null); // name -> { at, kind, ok, text } — the last outcome, shown as a banner
  var ticker = null;
  /* "make the UI responsive" (Rober, 2026-09-21): a press must show something at
     once and keep showing it — a busy row with a live seconds counter (repainted
     every second while the flyout is open), the result inside the flyout when
     it lands, and the last outcome as a banner when the flyout is reopened. */
  function tick() {
    if (!fly || !currentCtx) { clearInterval(ticker); ticker = null; return; }
    if (busy[currentCtx.original]) render(currentCtx);
    else { clearInterval(ticker); ticker = null; }
  }
  function startTicker() { if (!ticker) ticker = setInterval(tick, 1000); }
  function elapsed(name) { return since[name] ? Math.max(0, Math.round((Date.now() - since[name]) / 1000)) : 0; }
  function spin(name) { return ['◐', '◓', '◑', '◒'][elapsed(name) % 4]; }
  function chimOf(ctx) { return ctx ? chim[ctx.original] : null; }
  function canChim() { return !!(window.HDOmni && typeof HDOmni.chimCall === 'function'); }
  function decode(env) {
    if (!env || !env.ok) return null;
    var b = env.json;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
    return b;
  }
  function askState(ctx) {
    if (!canChim() || !ctx || !ctx.original) return;
    HDOmni.chimCall('mode=chim_state&npc=' + encodeURIComponent(ctx.original), function (env) {
      var b = decode(env);
      if (b && b.ok) chim[ctx.original] = b;
      else if (env && env.chimDown) note[ctx.original] = 'CHIM isn’t reachable';
      else if (b && b.error) note[ctx.original] = b.error;
      if (fly && currentCtx && currentCtx.original === ctx.original) render(currentCtx);
    }, false);
  }
  function ago(ts) {
    var d = Date.now() / 1000 - (Number(ts) || 0);
    if (!(d >= 0)) return '';
    if (d < 90) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + ' min ago';
    if (d < 86400) return Math.floor(d / 3600) + ' h ago';
    return Math.floor(d / 86400) + ' d ago';
  }
  function modelLine(st) {
    if (!st || !st.profile) return '';
    var p = st.profile;
    var m = p.model || p.connector || '';
    if (!m) return '';
    return m + (p.badge ? ' · ' + p.badge : (p.provider ? ' · ' + p.provider : ''))
             + (p.profile_name && !p.is_default ? ' · ' + p.profile_name : '');
  }
  function toastSafe(msg) {
    if (typeof toast === 'function') { try { toast(msg); } catch (e) {} }
  }
  /* one round trip per row press; the row shows "…" while it is out, the
     outcome line replaces its sub afterwards, and the state is re-read so
     the model / diary / flag lines are truthful again */
  var ACT_TIMEOUT_MS = 90000;   // past the C++ ask budget (75 s) — never leave a row stuck
  /* the game's own top-left line (hdHudNotify, C++), because a diary reply lands
     10-20 s after the press and the deck is usually closed by then — the row and
     the deck toast both die with it (Rober, 2026-09-21: "i dont get any top left
     notifications or anything"). An older DLL without the listener ignores it. */
  function hud(msg) { toG('hdHudNotify', String(msg || '').replace(/\s+/g, ' ').slice(0, 150)); }
  function chimAct(ctx, kind, qs, llm, onBody) {
    if (!canChim() || busy[ctx.original]) return;
    busy[ctx.original] = kind;
    since[ctx.original] = Date.now();
    delete result[ctx.original];
    var started = kind === 'diary' ? 'Writing ' + ctx.who + '’s diary… (10–20 s)'
                : kind === 'refresh' ? 'Rewriting ' + ctx.who + '’s profile… (10–20 s)'
                : 'Saving…';
    toastSafe(started);
    if (llm) hud('CHIM: ' + started);
    render(ctx);
    startTicker();
    var settled = false;
    var guard = setTimeout(function () {
      if (settled) return;
      settled = true;
      delete busy[ctx.original];
      note[ctx.original] = 'No answer from CHIM in ' + Math.round(ACT_TIMEOUT_MS / 1000) + ' s — it may still be working; reopen to re-read';
      result[ctx.original] = { at: Date.now(), kind: kind, ok: false, text: note[ctx.original], full: '' };
      toastSafe(note[ctx.original]);
      hud(note[ctx.original]);
      if (fly && currentCtx && currentCtx.original === ctx.original) render(currentCtx);
    }, ACT_TIMEOUT_MS);
    HDOmni.chimCall(qs, function (env) {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      delete busy[ctx.original];
      var b = decode(env);
      var okNow = !!(b && b.ok);
      if (okNow) { note[ctx.original] = onBody(b) || b.message || 'done'; if (b.kind) chim[ctx.original] = b; }
      else note[ctx.original] = (env && env.chimDown) ? 'CHIM isn’t reachable — is the server up?' : ((b && b.error) || (env && env.error) || 'CHIM did not answer');
      result[ctx.original] = { at: Date.now(), kind: kind, ok: okNow, text: note[ctx.original],
                               full: (okNow && b.entry && b.entry.excerpt) ? String(b.entry.excerpt) : '' };
      toastSafe(note[ctx.original]);
      hud(note[ctx.original]);
      if (fly && currentCtx && currentCtx.original === ctx.original) render(currentCtx);
    }, !!llm);
  }
  function doDiary(ctx) {
    chimAct(ctx, 'diary', 'mode=diary&npc=' + encodeURIComponent(ctx.original), true, function (b) {
      return b.entry && b.entry.excerpt ? ('📓 ' + ctx.who + ' wrote: ' + String(b.entry.excerpt).replace(/\s+/g, ' ').slice(0, 140) + '…') : b.message;
    });
  }
  function doDynToggle(ctx) {
    var st = chimOf(ctx);
    var want = !(st && st.dynamic);
    chimAct(ctx, 'dynprof', 'mode=dynprof_set&npc=' + encodeURIComponent(ctx.original) + '&on=' + (want ? '1' : '0'), false, function (b) { return b.message; });
  }
  function doDynRefresh(ctx) {
    chimAct(ctx, 'refresh', 'mode=dynprof_refresh&npc=' + encodeURIComponent(ctx.original), true, function (b) {
      return (b.changed && b.changed.length) ? ('✎ rewritten: ' + b.changed.join(', ')) : b.message;
    });
  }

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

  var inlineHost = null;
  function teardown() {
    inlineHost = null;
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (fly) { try { fly.remove(); } catch (e) {} fly = null; }
    document.removeEventListener('mousedown', outside, true);
    if (onEsc) { document.removeEventListener('keydown', onEsc, true); onEsc = null; }
  }
  function close() { teardown(); }
  function outside(e) { if (fly && !fly.contains(e.target)) close(); }

  /* ---- the three actions ------------------------------------------------ */
  function doBackground(ctx) {
    if (ctx.onNavigate) ctx.onNavigate();
    close();
    if (window.HDOmni && typeof HDOmni.askAbout === 'function') {
      HDOmni.askAbout(ctx.original, 'Tell me about ' + ctx.who
        + ' — background, personality, relationships and goals.');
    }
  }
  function doSharmat(ctx) {
    if (ctx.onNavigate) ctx.onNavigate();
    close();
    if (window.SmPane && typeof SmPane.open === 'function') {
      SmPane.open(ctx.original, ctx.who);
    }
  }
  /* chim-stay-talk: start a real, reversible native movement hold before
     opening the editable Direct draft. Neither search nor opening this menu
     acts on anybody. Quest/follower packages do not decide whether we hold. */
  var conversationSeq = 0, conversationPending = Object.create(null);
  function conversationRequest(ctx, op) {
    var name = String(ctx.original || ctx.who || '').trim();
    var requestId = 'conversation-' + (++conversationSeq);
    var timer = setTimeout(function () {
      if (!conversationPending[requestId]) return;
      delete conversationPending[requestId];
      say('Stay and talk was not confirmed. Reopen SkyManager after installing the current DLL; use Let them continue if needed.');
    }, 5000);
    conversationPending[requestId] = { ctx: ctx, op: op, timer: timer };
    say(op === 'start' ? 'Holding ' + name + ' here…' : 'Releasing ' + name + '…');
    toG('chConversation', JSON.stringify({ requestId: requestId, op: op, formId: fidOf(ctx.formId), name: name }));
  }
  window.chConversationResult = function (value) {
    var r = value;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { return; } }
    if (!r) return;
    var pending = conversationPending[r.requestId];
    if (!pending) return;
    delete conversationPending[r.requestId]; clearTimeout(pending.timer);
    say(r.msg || (r.ok ? 'Conversation hold updated' : 'Could not apply conversation hold'));
    if (!r.ok || pending.op !== 'start' || r.requestId !== 'conversation-' + conversationSeq) return;
    var ctx = pending.ctx, name = String(ctx.original || ctx.who || '').trim();
    if (ctx.onNavigate) ctx.onNavigate();
    close();
    HDOmni.open('direct', name + ' stops walking away, stays nearby, faces the player, and talks with the player.');
  };
  function conversationAction(ctx) {
    ctx = Object.assign({}, ctx || {});
    var name = String(ctx.original || ctx.who || '').trim();
    var why = !name ? 'Choose an NPC first.'
      : ctx.dead ? (ctx.who || name) + ' is dead.'
      : !fidOf(ctx.formId) ? 'Choose a nearby NPC with a live reference.'
      : !(window.HDOmni && typeof HDOmni.open === 'function') ? 'Direct is not available.' : '';
    return {
      key: 'chim-stay-talk', label: 'Stay and talk to me…',
      sub: 'Hold ' + (ctx.who || name) + ' here for up to five minutes, then review and Send the CHIM request. Let them continue releases the hold; leaving or combat ends it automatically.',
      alias: 'stay talk speak chat conversation stop walking away come closer direct instruction',
      iconPath: 'icons/custom/hk-chim-dialogue.png',
      disabled: !!why, why: why,
      run: function () {
        if (why) return;
        conversationRequest(ctx, 'start');
      },
    };
  }
  function conversationReleaseAction(ctx) {
    ctx = Object.assign({}, ctx || {});
    var why = !fidOf(ctx.formId) ? 'Choose the held NPC first.' : '';
    return { key: 'chim-talk-release', label: 'Let them continue',
      sub: 'Release this NPC from Stay and talk so their current quest or routine can continue.',
      alias: 'release resume continue stop end conversation hold stay talk unfreeze',
      iconPath: 'icons/custom/hk-chim-dialogue.png', disabled: !!why, why: why,
      run: function () { if (!why) conversationRequest(ctx, 'release'); } };
  }
  /* Toggle CHIM AI. Optimistic: flip our local view of her state and re-render
     at once so the button feels instant; the C++ reply (chStateResult)
     reconciles it against CHIM's own agent set a moment later. */
  function toggleActive(ctx) {
    var want = !active[ctx.original];
    active[ctx.original] = want;
    known[ctx.original] = true;
    syncAgent(ctx.original, ctx.formId, want);
    if (ctx.who && ctx.who !== ctx.original) syncAgent(ctx.who, ctx.formId, want);
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
    syncAgent(nm, env.formId, !!env.active);
    if (fly && currentCtx && currentCtx.original === nm) render(currentCtx);
  }

  /* ---- the flyout -------------------------------------------------------- */
  function itemBtn(icon, label, sub, opts, on) {
    var b = mk('button', 'chim-fly-item' + (opts && opts.on ? ' on' : '')
                                          + (opts && opts.disabled ? ' is-disabled' : ''));
    b.type = 'button';
    if (opts && opts.title) b.title = opts.title;
    var ic = mk('span', 'chim-fly-ic', opts && opts.iconPath ? '' : icon);
    ic.setAttribute('aria-hidden', 'true');
    if (opts && opts.iconPath) {
      var img = document.createElement('img');
      img.src = opts.iconPath; img.alt = ''; img.width = 30; img.height = 30;
      ic.appendChild(img);
    }
    if (opts && opts.disabled) b.setAttribute('aria-disabled', 'true');
    b.appendChild(ic);
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
    /* the model she is answered by — Rober: "show the current LLM model its using" */
    var st = chimOf(ctx);
    var ml = modelLine(st);
    var model = mk('div', 'chim-fly-model' + (ml ? '' : ' is-wait'),
      ml ? ml : (canChim() ? (note[ctx.original] || 'Reading CHIM…') : 'CHIM state needs the Omni'));
    model.title = ml ? 'The LLM answering ' + ctx.who + ' right now — her CHIM profile’s primary connector' : '';
    fly.appendChild(model);
    /* the last outcome, right where the eye lands — survives closing and reopening
       the flyout, so a diary that finished while the deck was shut is still shown */
    var res = result[ctx.original];
    if (res) {
      var ban = mk('div', 'chim-fly-result' + (res.ok ? ' is-ok' : ' is-bad'));
      ban.appendChild(mk('span', 'chim-fly-result-t', (res.ok ? '✓ ' : '✕ ') + res.text));
      if (res.full) ban.appendChild(mk('div', 'chim-fly-result-full', res.full));
      ban.appendChild(mk('span', 'chim-fly-result-when', ago(res.at / 1000)));
      ban.title = 'Click to dismiss';
      ban.addEventListener('click', function (e) { e.stopPropagation(); delete result[ctx.original]; render(ctx); });
      fly.appendChild(ban);
    }

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

    var talk = conversationAction(ctx);
    var talkButton = itemBtn('', talk.label,
      talk.why || 'Hold here, then review and Send. Five minutes; ends when you leave or combat starts. CHIM activation is still needed for speech.',
      { iconPath: talk.iconPath, disabled: talk.disabled, title: talk.why || talk.sub }, talk.run);
    talkButton.classList.add('chim-fly-talk');
    fly.appendChild(talkButton);
    var releaseTalk = conversationReleaseAction(ctx);
    var releaseTalkButton = itemBtn('', releaseTalk.label, releaseTalk.sub,
      { iconPath: releaseTalk.iconPath, disabled: releaseTalk.disabled, title: releaseTalk.why || releaseTalk.sub }, releaseTalk.run);
    releaseTalkButton.classList.add('chim-fly-talk');
    fly.appendChild(releaseTalkButton);

    /* 4–6) the CHIM-database rows (2026-09-21). Disabled until the state
       read lands (no pipe = never), busy while their call is out. */
    var can = canChim();
    var b = busy[ctx.original] || '';
    var last = note[ctx.original] || '';
    var dsub = b === 'diary' ? spin(ctx.original) + ' Writing… ' + elapsed(ctx.original) + ' s (CHIM is thinking, usually 10–20 s)'
             : (last && /wrote|Diary|cooldown/i.test(last)) ? last
             : st && st.diary_cooldown_left > 0 ? 'Diary on cooldown — ' + st.diary_cooldown_left + ' s'
             : st && st.diary ? 'Last entry ' + ago(st.diary.at) + ' — write another now'
             : st ? 'No diary yet — write her first entry now'
             : 'Reading CHIM…';
    fly.appendChild(itemBtn('📓', 'Write diary', dsub,
      { disabled: !can || !st || !!b || (st && st.diary_cooldown_left > 0),
        title: 'Ask CHIM to write ' + ctx.who + '’s diary entry right now — the same request the game sends when her diary is due. Takes a few seconds.' },
      function () { doDiary(ctx); }));

    var dyn = !!(st && st.dynamic), locked = !!(st && st.locked);
    var tsub = b === 'dynprof' ? spin(ctx.original) + ' Saving…'
             : !st ? 'Reading CHIM…'
             : locked ? (dyn ? 'On, but her profile is LOCKED in CHIM — nothing will change' : 'Off — and her profile is locked in CHIM')
             : dyn ? 'On — CHIM rewrites her personality, speech style and goals from what she lives through · click to switch off'
                   : 'Off — her profile stays as written · click to switch on';
    fly.appendChild(itemBtn(dyn ? '🧬' : '🧬', dyn ? 'Dynamic profile: on' : 'Dynamic profile: off', tsub,
      { on: dyn, disabled: !can || !st || !!b,
        title: 'core_npc_master.dynamic_profile — the switch CHIM’s own NPC editor flips. On: her profile evolves; off: fixed.' },
      function () { doDynToggle(ctx); }));

    var pend = st && st.dynamic_state ? st.dynamic_state.pending_events : null;
    var rsub = b === 'refresh' ? spin(ctx.original) + ' Rewriting… ' + elapsed(ctx.original) + ' s (CHIM is thinking)'
             : (last && /rewritten|did not take|scheduler|cooldown —|events for her/i.test(last)) ? last
             : !st ? 'Reading CHIM…'
             : !dyn ? 'Switch the dynamic profile on first'
             : locked ? 'Her profile is locked in CHIM'
             : (pend != null ? pend + ' new event' + (pend === 1 ? '' : 's') + ' since her last rewrite — ' : '') + 'rewrite now';
    fly.appendChild(itemBtn('♻', 'Refresh dynamic profile', rsub,
      { disabled: !can || !st || !!b || !dyn || locked,
        title: 'Run CHIM’s dynamic-profile pass for ' + ctx.who + ' now, skipping the day-interval and event-count gates (its own attempt cooldown still applies).' },
      function () { doDynRefresh(ctx); }));

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
    if (inlineHost) {
      fly.classList.add('chim-inline'); fly.setAttribute('role', 'group');
      inlineHost.appendChild(fly); return;
    }
    var host = document.getElementById('overlay') || document.body;
    host.appendChild(fly);
    fly.style.position = 'fixed';
    fly.style.visibility = 'hidden';
    fly.style.left = '0px'; fly.style.top = '0px';
    var vp = viewport(), vw = vp.w, vh = vp.h;
    /* .chim-fly wears transform: scale(--ui-scale) (top-left origin) because it
       lives outside #panel's transform; offsetWidth/Height are PRE-transform
       layout px, so the PAINTED box is × the scale — clamp that or a Fill'd
       deck's flyout runs off the edge. */
    var sc = 1;
    try { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')); if (isFinite(v) && v > 0) sc = v; } catch (e) {}
    var fw = (fly.offsetWidth || 260) * sc, fh = (fly.offsetHeight || 180) * sc;
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
    /* …and CHIM's database for the model / diary / dynamic-profile rows. A
       fresh read every open: the flag or the model may have changed in CHIM. */
    askState(ctx);
    if (busy[ctx.original]) startTicker();   // reopened mid-call: keep the counter moving
    onEsc = function (e) { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  }

  /* C++ pushes state through these globals (registered like the deck's other
     *Result receivers). */
  window.chStateResult = onStateResult;
  window.chAgentsResult = onAgentsResult;

  /* ---- Omni provider (2026-09-14) ---------------------------------------
     Rober: "hook to chim's manual activate an npc, and add this ability or
     function to f7 on an npc" — typed "activate chim" in the omni and got
     only Tune. This is the row: it names whoever is in your crosshair, reads
     as Activate or Deactivate from the real agent set, and Enter toggles her
     through the same natives the flyout uses. A second row is the roll-call —
     "CHIM agents · 3 active" with the names — so "who is on right now" is one
     search away. warm() refreshes the set as the omni opens, which is also
     what puts the 💬 mark on every activated follower's row. */
  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'chim', label: 'CHIM', tab: '',
      warm: function () { ensureAgents(true); },
      pinRun: function () { omniToggle(); },
      index: function () {
        var items = [];
        var npc = crosshairNpc();
        var st = npc ? isAgent(npc) : undefined;
        var verb = (st === true) ? 'Deactivate' : 'Activate';
        items.push({
          label: npc ? (verb + ' CHIM on ' + npc.name) : 'Activate CHIM on whoever you are looking at',
          detail: !npc
            ? 'Look at someone first \u2014 manual CHIM AI activation for the person in your '
              + 'crosshair, the same thing CHIM\u2019s own activate key does'
            : npc.dead ? npc.name + ' is dead'
            : (st === true)  ? 'CHIM AI is ON for ' + npc.name + ' \u2014 Enter switches her off'
            : (st === false) ? 'CHIM AI is off for ' + npc.name + ' \u2014 Enter activates her'
            : 'Reading CHIM state\u2026 Enter activates ' + npc.name,
          kind: 'npc',
          marks: (npc && st === true) ? markFor(npc) : [],
          keywords: 'chim activate deactivate enable disable turn on off ai agent manual '
                  + 'driven talk voice npc herika register',
          pin: 'chim:crosshair', snap: {},
          run: omniToggle,
        });
        if (agents.known) {
          var names = [];
          for (var i = 0; i < agents.list.length; i++) {
            var a = agents.list[i];
            var n = a.name || a.base;
            if (n) names.push(n);
          }
          items.push({
            label: 'CHIM agents \u00B7 ' + agents.list.length + ' active',
            detail: names.length ? names.join(' \u00B7 ')
                                 : 'No NPC is CHIM-activated right now',
            kind: 'chim',
            keywords: 'chim agents active activated list who is on roster ai npcs',
          });
        }
        return items;
      },
    });
  }

  return {
    mount: function (host, ctx) {
      teardown(); inlineHost = host; render(ctx);
      if (!ctx.dead) toG('chState', JSON.stringify({formId:Number(ctx.formId)||0,name:ctx.original}));
      askState(ctx); if (busy[ctx.original]) startTicker();
    },
    unmount: function (host) { if (inlineHost === host) teardown(); },
    open: open,
    close: close,
    onStateResult: onStateResult,
    onAgentsResult: onAgentsResult,
    /* the agent set — F7 card (lit 💬) and omni rows (the mark) read these */
    ensureAgents: ensureAgents,
    isAgent: isAgent,
    markFor: markFor,
    crosshairNpc: crosshairNpc,
    conversationAction: conversationAction,
    conversationReleaseAction: conversationReleaseAction,
    agents: function () { return { known: agents.known, list: agents.list.slice() }; },
    /* exposed for the harness */
    _state: function () { return { active: active, known: known, fly: fly, agents: agents, chim: chim, busy: busy, note: note }; },
    _modelLine: modelLine,
  };
})();
window.ChimBtn = ChimBtn;
