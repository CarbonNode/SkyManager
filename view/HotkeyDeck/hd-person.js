/* hd-person.js — the person page's look (2026-10-03).
 *
 * Rober saw SeverActions' companion page (built on MagelightUI) — the dressed
 * full-body mannequin, the portrait ring, the big serif name, the vitals, the
 * "How X sees you" drop-cap passage — and asked for it in SkyManager: "ok lets
 * get it all in" … "dont lose any features in our current UI's".
 *
 * So this module ADDS to the existing Followers dossier (followers-pane.js
 * buildMemberDossier) and owns none of its controls. Three pieces, each mounted
 * by the dossier into a host it already laid out:
 *
 *   HDPerson.hero(ctx)              -> Element  race · level, live H/S/M bars, NOW line
 *   HDPerson.mountSees(host, ctx)   -> ctl      "How <name> sees you" (CHIM, llm ask)
 *   HDPerson.mountMirror(host, ctx) -> ctl      the full-body figure, drag to turn
 *   HDPerson.unmount(root)                      stop every controller inside root
 *
 * THE MIRROR is MRF's composed render of exactly what the actor wears now
 * (ItemIcons::MirrorJson in C++): 24 frames, 15° apart. The bridge is
 * pnMirror {id, queue} -> pnMirrorData {id, ok, why?, frames:{angle:path},
 * total, queued, pieces, failed?}. `frames` lists ONLY files already on disk, and
 * an <img> src is only ever set to a listed path (Ultralight's cache may pin a
 * probed-missing URL; its query-string cache-bust does not work).
 *
 * The dossier is REBUILT whenever live data lands (refreshOpenMenu -> closeCtx ->
 * openMemberMenu), so state lives here, keyed by actor / name, and a rebuilt page
 * remounts instantly on the same angle without asking anything twice.
 *
 * Ultralight rules honoured: the image is cropped and zoomed by LAYOUT size, never
 * a scale transform (it rasterises an <img> at its layout size); a drag is tracked
 * from mousedown to mouseup/blur, never from MouseEvent.buttons (Ultralight can
 * report 0 mid-drag); no color-mix / conic-gradient in the CSS.
 */
(function () {
  'use strict';

  var STEP_PX = 22;           // drag distance per 15° frame
  var POLL_MS = 1500;         // while frames are still baking
  var POLL_MAX = 160;         // ~4 minutes, then the page stops asking on its own
  var ZOOM_MIN = 1, ZOOM_MAX = 2.4;

  var mirrors = Object.create(null);  // id -> { reply, angle, zoom, polls }
  var sees = Object.create(null);     // name -> { state, text, msg, at }
  var live = [];                      // mounted controllers

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach(function (c) {
        if (c == null || c === false) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }
  function coerce(v) {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
    return v;
  }
  function send(name, payload) {
    if (typeof window.toGame === 'function') window.toGame(name, JSON.stringify(payload));
  }
  function later(fn, ms) { return typeof window.setTimeout === 'function' ? window.setTimeout(fn, ms) : 0; }
  function cancel(t) { if (t && typeof window.clearTimeout === 'function') window.clearTimeout(t); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function norm(a) { a = Math.round(a) % 360; return a < 0 ? a + 360 : a; }

  /* ------------------------------------------------------------------ hero */

  function bar(kind, label, cur, max) {
    var has = cur !== null && max !== null && max > 0;
    var pct = has ? Math.max(0, Math.min(100, Math.round(cur / max * 100))) : 0;
    return el('div', { class: 'pn-vit pn-vit-' + kind, role: 'group', 'aria-label': label },
      el('span', { class: 'pn-vit-label' }, label),
      el('span', { class: 'pn-vit-bar' }, el('i', { style: 'width:' + pct + '%' })),
      el('span', { class: 'pn-vit-num' }, has ? String(cur) : '—',
        el('span', { class: 'pn-vit-max' }, has ? ' / ' + max : '')));
  }

  function hero(ctx) {
    ctx = ctx || {};
    var a = ctx.about || null;
    var race = a && a.race ? String(a.race) : '';
    var level = a && num(a.level) ? 'Level ' + a.level : '';
    var bits = [race, level].filter(Boolean).join(' · ');
    var vitals = el('div', { class: 'pn-vitals' });
    if (a && num(a.healthMax) !== null) {
      vitals.appendChild(bar('hp', 'Health', num(a.health), num(a.healthMax)));
      // An older DLL sends health only: draw what is true, not three bars of guesses.
      if (num(a.staminaMax) !== null) vitals.appendChild(bar('sp', 'Stamina', num(a.stamina), num(a.staminaMax)));
      if (num(a.magickaMax) !== null) vitals.appendChild(bar('mp', 'Magicka', num(a.magicka), num(a.magickaMax)));
    } else {
      vitals.appendChild(el('p', { class: 'pn-vitals-wait' },
        ctx.dead ? 'No vitals — deceased.' : 'Reading live health, stamina and magicka…'));
    }
    var now = el('p', { class: 'pn-now' }, el('b', null, 'NOW'),
      el('span', { class: 'pn-now-what' }, ctx.now || ctx.status || 'Not located'),
      ctx.where ? el('em', null, ' · ' + ctx.where) : null);
    return el('div', { class: 'pn-hero' },
      bits ? el('p', { class: 'pn-race' }, bits) : null, vitals, now);
  }

  /* ------------------------------------------------------- how she sees you */

  function seesQuestion(name) {
    // "the player", never a name: CHIM's own context already knows who the player is,
    // and a shipped file may not carry anyone's playthrough (release scan + public tripwire).
    return 'How does ' + name + ' see the player right now: what ' + name + ' feels about them, what ' +
      name + ' respects or resents in them, and what ' + name + ' wants from them? ' +
      'Answer as a short portrait of that view of them.';
  }

  function askSees(name, original) {
    var s = sees[name] || (sees[name] = { state: 'idle', text: '', msg: '', at: 0 });
    if (!window.HDOmni || typeof HDOmni.chimCall !== 'function') {
      s.state = 'error'; s.msg = 'CHIM is not available in this view.'; repaintSees(name); return;
    }
    s.state = 'asking'; s.msg = ''; repaintSees(name);
    var qs = 'q=' + encodeURIComponent(seesQuestion(name)) + '&npc=' + encodeURIComponent(original || name) + '&mode=llm';
    HDOmni.chimCall(qs, function (env) {
      env = coerce(env) || {};
      var j = coerce(env.json) || {};
      if (env.ok === false || (!j.answer && !j.ok && j.error)) {
        s.state = 'error';
        s.msg = j.error || env.error || 'CHIM did not answer. Is CHIM running?';
      } else if (j.answer) {
        s.state = 'ok'; s.text = String(j.answer).trim(); s.at = Date.now();
      } else if (j.llm_error) {
        s.state = 'error'; s.msg = 'CHIM could not write it: ' + j.llm_error;
      } else {
        s.state = 'error';
        s.msg = 'CHIM has no profile for ' + name + ' yet. Talk to ' + name + ' in game once, then ask again.';
      }
      repaintSees(name);
    }, true);
  }

  function repaintSees(name) {
    live.forEach(function (c) { if (c.kind === 'sees' && c.name === name) c.paint(); });
  }

  function ago(at) {
    if (!at) return '';
    var m = Math.round((Date.now() - at) / 60000);
    return m < 1 ? 'just now' : m === 1 ? 'a minute ago' : m < 60 ? m + ' minutes ago' : 'earlier this session';
  }

  function mountSees(host, ctx) {
    ctx = ctx || {};
    var name = ctx.name || 'They';
    host.textContent = '';
    var text = el('p', { class: 'pn-sees-text', 'aria-live': 'polite' });
    var src = el('p', { class: 'pn-sees-src' });
    var again = el('button', { type: 'button', class: 'pn-sees-again', title: 'Ask CHIM again',
      'aria-label': 'Ask CHIM again how ' + name + ' sees you',
      onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); askSees(name, ctx.original); } }, '↻');
    var box = el('section', { class: 'pn-sees', 'aria-label': 'How ' + name + ' sees you' },
      el('div', { class: 'pn-sees-head' }, el('span', { class: 'pn-eyebrow' }, 'How ' + name + ' sees you'), again),
      text, src);
    host.appendChild(box);
    var ctl = {
      kind: 'sees', name: name, host: host,
      paint: function () {
        var s = sees[name] || { state: 'idle' };
        box.classList.toggle('pn-sees-asking', s.state === 'asking');
        box.classList.toggle('pn-sees-error', s.state === 'error');
        again.disabled = s.state === 'asking' || ctx.dead;
        if (s.state === 'ok') {
          text.textContent = s.text;
          src.textContent = 'Written by CHIM from ' + name + '’s profile, diary and memories · ' + ago(s.at);
        } else if (s.state === 'asking') {
          text.textContent = s.text || 'Asking CHIM how ' + name + ' sees you…';
          src.textContent = s.text ? 'Asking again…' : 'This takes a few seconds.';
        } else if (s.state === 'error') {
          text.textContent = s.text || s.msg;
          src.textContent = s.text ? s.msg : 'Press ↻ to try again.';
        } else {
          text.textContent = ctx.dead ? name + ' is gone. CHIM keeps no new thoughts for the dead.'
            : 'Press ↻ to ask CHIM how ' + name + ' sees you.';
          src.textContent = '';
        }
      },
      destroy: function () { host.textContent = ''; }
    };
    live.push(ctl);
    ctl.paint();
    // Once per person per session; ↻ asks again. A dead NPC is never asked.
    if (!sees[name] && !ctx.dead) askSees(name, ctx.original);
    return ctl;
  }

  /* ------------------------------------------------------------ the mirror */

  function mirrorState(id) {
    return mirrors[id] || (mirrors[id] = { reply: null, angle: 0, zoom: 1, polls: 0, asked: false });
  }

  function askMirror(id, queue) {
    var st = mirrorState(id);
    st.asked = true;
    send('pnMirror', { id: id, queue: queue !== false });
  }

  window.pnMirrorData = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object' || !env.id) return;
    var st = mirrorState(String(env.id));
    st.reply = env;
    live.forEach(function (c) { if (c.kind === 'mirror' && c.id === String(env.id)) c.onReply(); });
  };

  function framesOf(reply) {
    var out = [];
    if (reply && reply.frames && typeof reply.frames === 'object')
      Object.keys(reply.frames).forEach(function (k) {
        var a = Number(k);
        if (isFinite(a) && typeof reply.frames[k] === 'string' && reply.frames[k]) out.push(norm(a));
      });
    return out.sort(function (x, y) { return x - y; });
  }

  // The baked frame nearest to the angle the player turned to (frames land in
  // 0/180/90/270 order, so a drag that starts mid-bake still turns).
  function nearest(angles, want) {
    var best = null, bestD = 999;
    angles.forEach(function (a) {
      var d = Math.abs(a - want); d = Math.min(d, 360 - d);
      if (d < bestD) { bestD = d; best = a; }
    });
    return best;
  }

  function mountMirror(host, ctx) {
    ctx = ctx || {};
    var id = String(ctx.formId || '');
    var name = ctx.name || 'them';
    var st = mirrorState(id);
    var step = 15, total = 24, pollTimer = 0, drag = null, alive = true;
    host.textContent = '';

    var img = el('img', { class: 'pn-mir-img', alt: 'Full-body figure of ' + name + ' in their current gear',
      draggable: 'false', hidden: true });
    var empty = el('div', { class: 'pn-mir-empty', role: 'status', 'aria-live': 'polite' });
    var progress = el('span', { class: 'pn-mir-progress' }, el('i'));
    var hint = el('div', { class: 'pn-mir-hint' }, 'Drag to turn · wheel to zoom');
    var stage = el('div', { class: 'pn-mir-stage', tabindex: '0', role: 'img',
      'aria-label': name + ', full-body figure. Left and right arrows turn; plus and minus zoom.' },
      el('div', { class: 'pn-mir-floor' }), img, empty, hint);
    var dial = el('div', { class: 'pn-mir-dial', role: 'group', 'aria-label': 'Angles' });
    var count = el('span', { class: 'pn-mir-count' });
    function btn(label, title, fn) {
      return el('button', { type: 'button', class: 'pn-mir-btn', title: title, 'aria-label': title,
        onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); fn(); } }, label);
    }
    var status = el('p', { class: 'pn-mir-status' });
    var box = el('div', { class: 'pn-mir' },
      el('div', { class: 'pn-mir-head' }, el('span', { class: 'pn-eyebrow' }, 'The Mirror'), count),
      el('button', { type: 'button', class: 'pn-mir-live', disabled: ctx.dead || !id ? true : null,
        title: 'See ' + name + ' live in the world: the game camera frames the whole figure and you turn around them',
        onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation();
          enterLive({ formId: id, name: name, hero: ctx.hero || null }); } },
        el('span', { class: 'pn-mir-live-title' }, 'Live view'),
        el('span', { class: 'pn-mir-live-sub' }, ctx.dead ? 'Not for the dead' : 'The real look, lit, in the world · drag to turn')),
      stage, progress, dial,
      el('div', { class: 'pn-mir-ctl' },
        btn('‹ Turn', 'Turn left', function () { turn(-1); }),
        btn('Front', 'Face front', function () { st.angle = 0; st.zoom = 1; paint(); }),
        btn('Turn ›', 'Turn right', function () { turn(1); }),
        btn('Refresh', 'Read what ' + name + ' is wearing again', function () { st.polls = 0; askMirror(id, true); paintStatus('Reading gear…'); })),
      status);
    host.appendChild(box);

    function turn(dir) { st.angle = norm(st.angle + dir * step); paint(); }

    function layoutImage() {
      var r = stage.getBoundingClientRect ? stage.getBoundingClientRect() : null;
      var w = r && r.width ? r.width : 0, h = r && r.height ? r.height : 0;
      if (!w || !h) return;
      // A square canvas holding a standing figure: fill the HEIGHT, centre the
      // width, and zoom by layout size anchored at the upper body.
      var size = Math.round(h * st.zoom);
      img.style.width = size + 'px';
      img.style.height = size + 'px';
      img.style.left = Math.round((w - size) / 2) + 'px';
      img.style.top = Math.round(-(size - h) * 0.18) + 'px';
    }

    function paintDial(angles) {
      dial.textContent = '';
      for (var a = 0; a < 360; a += step) {
        (function (ang) {
          var baked = angles.indexOf(ang) !== -1;
          var tick = el('button', { type: 'button', class: 'pn-mir-tick' + (baked ? ' baked' : '') +
            (ang === st.angle ? ' on' : ''), title: ang + '°' + (baked ? '' : ' (still rendering)'),
            'aria-label': 'Turn to ' + ang + ' degrees', disabled: baked ? null : true,
            onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); st.angle = ang; paint(); } });
          dial.appendChild(tick);
        })(a);
      }
    }

    function paintStatus(text) { status.textContent = text; }

    function paint() {
      if (!alive) return;
      var r = st.reply;
      if (r && r.step) step = Number(r.step) || 15;
      if (r && r.total) total = Number(r.total) || 24;
      var angles = framesOf(r);
      var shown = nearest(angles, st.angle);
      box.classList.toggle('pn-mir-ready', shown !== null);
      if (shown !== null) {
        var path = r.frames[String(shown)];
        if (img.getAttribute('src') !== path) img.setAttribute('src', path);
        img.hidden = false;
        empty.hidden = true;
        layoutImage();
      } else {
        img.hidden = true;
        empty.hidden = false;
        empty.textContent = !r ? 'Reading what ' + name + ' is wearing…'
          : r.ok === false ? (r.why || 'No figure for ' + name + '.')
          : r.failed ? 'The renderer refused this figure: ' + r.failed
          : 'Rendering ' + name + '’s figure…';
      }
      var have = angles.length;
      progress.hidden = !(r && r.ok && have < total && !r.failed);
      progress.firstChild.style.width = Math.round(have / Math.max(1, total) * 100) + '%';
      count.textContent = r && r.ok ? (r.pieces ? 'wearing ' + r.pieces + (r.pieces === 1 ? ' piece' : ' pieces') : 'no gear worn') : '';
      paintDial(angles);
      hint.hidden = have < 2;
      if (r && r.ok === false) paintStatus('Nothing to show yet.');
      else if (r && r.failed) paintStatus('The renderer refused this figure. Refresh after changing gear to try again.');
      else if (r && have < total) paintStatus(have + ' of ' + total + ' angles ready · rendering the rest in the background');
      else if (r) paintStatus('All ' + total + ' angles ready · re-renders by itself when the gear changes (Refresh).');
      else paintStatus('');
    }

    function schedulePoll() {
      cancel(pollTimer); pollTimer = 0;
      var r = st.reply;
      if (!alive || !r || r.ok === false || r.failed) return;
      if (framesOf(r).length >= (Number(r.total) || 24)) return;
      if (st.polls >= POLL_MAX) { paintStatus('Still rendering. Press Refresh to check again.'); return; }
      pollTimer = later(function () {
        pollTimer = 0;
        if (!alive || !host.isConnected) return;
        st.polls++;
        askMirror(id, false);
      }, POLL_MS);
    }

    function down(e) {
      if (e.button !== undefined && e.button !== 0) return;
      drag = { x: e.clientX, angle: st.angle };
      stage.classList.add('pn-mir-dragging');
      if (e.preventDefault) e.preventDefault();
      if (stage.focus) try { stage.focus(); } catch (err) { /* harness */ }
    }
    function move(e) {
      if (!drag) return;
      var steps = Math.round((e.clientX - drag.x) / STEP_PX);
      var next = norm(drag.angle - steps * step);
      if (next !== st.angle) { st.angle = next; paint(); }
    }
    function up() { if (drag) { drag = null; stage.classList.remove('pn-mir-dragging'); } }
    function wheel(e) {
      var d = e.deltaY || 0;
      if (!d) return;
      st.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, st.zoom * (d < 0 ? 1.12 : 1 / 1.12)));
      layoutImage();
      if (e.preventDefault) e.preventDefault();
    }
    function key(e) {
      var k = e.key;
      if (k === 'ArrowLeft') turn(-1);
      else if (k === 'ArrowRight') turn(1);
      else if (k === '+' || k === '=') { st.zoom = Math.min(ZOOM_MAX, st.zoom * 1.12); layoutImage(); }
      else if (k === '-' || k === '_') { st.zoom = Math.max(ZOOM_MIN, st.zoom / 1.12); layoutImage(); }
      else if (k === 'Home') { st.angle = 0; st.zoom = 1; paint(); }
      else return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }
    stage.addEventListener('mousedown', down);
    stage.addEventListener('wheel', wheel);
    stage.addEventListener('keydown', key);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    if (window.addEventListener) window.addEventListener('blur', up);
    img.addEventListener('load', layoutImage);

    var ctl = {
      kind: 'mirror', id: id, host: host,
      onReply: function () { paint(); schedulePoll(); },
      say: function (text) { paintStatus(text); },
      destroy: function () {
        alive = false; cancel(pollTimer); pollTimer = 0; drag = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (window.removeEventListener) window.removeEventListener('blur', up);
        host.textContent = '';
      }
    };
    live.push(ctl);
    paint();
    if (!id) { empty.textContent = name + ' has no live reference to render.'; return ctl; }
    // Always ask once per mount with queue on: frames already on disk come back
    // instantly, and a change of clothes since the last mount is a new set.
    st.polls = 0;
    askMirror(id, true);
    return ctl;
  }

  /* ------------------------------------------------- memories / bonds / life */
  /* Three CHIM systems on two person-page tabs (2026-10-03, Rober: "we use chim
     right? … could hook to this as well + chim … cool idea, if it can also hook
     to chim"). Nothing is simulated here: chim/person.php (beside deck_ask's
     ask.php) runs CHIM's OWN code —
       Memories   CHIM memory + diarylog, Tamrielic dates; her letters to you.
       Bonds      CHIM's relationship system: affinity -100..100, CHIM's tiers and
                  types, the very data CHIM puts in her prompt. Set it, or have
                  CHIM's relationship model re-judge her.
       Life Away  CHIM's Background Life: her off-screen turns, rumours and
                  letters (a letter reaches the game as a book by courier).
     One read per person per session (cached by name), refreshed by every write. */
  var people = Object.create(null);   // name -> { state, data, msg, busy }

  function personState(name) {
    return people[name] || (people[name] = { state: 'idle', data: null, msg: '', busy: '' });
  }
  function personRepaint(name) {
    live.forEach(function (c) { if (c.kind === 'inner' && c.name === name) c.paint(); });
  }
  function personCall(name, original, mode, extra, llm, busy) {
    var st = personState(name);
    if (!window.HDOmni || typeof HDOmni.chimCall !== 'function') {
      st.state = st.data ? 'ok' : 'error'; st.msg = 'CHIM is not available in this view.'; personRepaint(name); return;
    }
    if (mode === 'person' && !st.data) st.state = 'loading';
    st.busy = busy || ''; personRepaint(name);
    var qs = 'mode=' + mode + '&npc=' + encodeURIComponent(original || name) + (extra || '');
    HDOmni.chimCall(qs, function (env) {
      env = coerce(env) || {};
      var j = coerce(env.json) || {};
      st.busy = '';
      if (env.ok === false && !j.ok) {
        st.state = st.data ? 'ok' : 'error';
        st.msg = 'CHIM did not answer — it only runs while the game and the CHIM launcher are up.';
      } else if (j.ok === false) {
        st.state = st.data ? 'ok' : 'error';
        st.msg = j.why || j.error || 'CHIM refused that.';
      } else {
        st.state = 'ok'; st.data = j; st.msg = j.message || '';
      }
      personRepaint(name);
    }, !!llm);
  }

  function chip(text, cls) { return el('span', { class: 'pn-chip' + (cls ? ' ' + cls : '') }, text); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  // Full text of a letter / diary entry / memory in its own popout (the deck's
  // "reveals more content -> popout, never an inline expander" law). Owns Escape.
  function openReader(title, date, text, opts) {
    opts = opts || {};
    var letter = opts.kind === 'letter';
    var back = el('div', { class: 'pn-pop-back' + (letter ? ' pn-letter-back' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    function close() {
      if (window.removeEventListener) window.removeEventListener('keydown', key, true);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    function key(e) {
      if (e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); e._fdDossierHandled = true; close(); }
    }
    var paras = String(text || '').split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
    var card;
    if (letter) {
      // A letter reads as one: aged paper, her hand, her seal. The salutation
      // ("My Lord,") and her sign-off are CHIM's words, so they are kept as
      // written; the page only adds the signature line when she left none.
      var from = opts.from || '';
      var last = paras.length ? paras[paras.length - 1] : '';
      var signed = from && last.length < 80 && last.toLowerCase().indexOf(String(from).split(' ')[0].toLowerCase()) !== -1;
      // The close button lives on the frame, outside the paper's scroll box, so
      // it stays put while a long letter scrolls under it.
      card = el('div', { class: 'pn-letter-frame' },
        el('button', { type: 'button', class: 'pn-letter-x', 'aria-label': 'Fold the letter away', title: 'Fold it away (Esc)', onClick: close }, '×'),
        el('article', { class: 'pn-letter', tabindex: '0' },
          el('header', { class: 'pn-letter-head' },
            el('p', { class: 'pn-letter-kicker' }, from ? 'A letter from ' + from : title),
            date ? el('p', { class: 'pn-letter-date' }, date) : null),
          el('div', { class: 'pn-letter-text' }, paras.map(function (para, i) {
            return el('p', { class: i === 0 && /,\s*$/.test(para) && para.length < 60 ? 'pn-letter-salute' : null }, para);
          })),
          el('footer', { class: 'pn-letter-foot' },
            from && !signed ? el('p', { class: 'pn-letter-sign' }, '— ' + from) : el('span', null),
            el('img', { class: 'pn-letter-seal', src: 'person/seal.png', alt: from ? from + '’s seal' : 'Wax seal', width: '128', height: '128' }))));
    } else {
      card = el('article', { class: 'pn-pop' },
        el('header', { class: 'pn-pop-head' },
          el('div', null, el('h2', null, title), date ? el('p', { class: 'pn-pop-date' }, date) : null),
          el('button', { type: 'button', class: 'pn-pop-x', 'aria-label': 'Close', onClick: close }, '×')),
        el('div', { class: 'pn-pop-text' }, paras.map(function (para) { return el('p', null, para); })));
    }
    back.appendChild(card);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    if (window.addEventListener) window.addEventListener('keydown', key, true);
    // Arrow keys / Page Down read on without reaching for the mouse.
    var paper = letter && card.querySelector ? card.querySelector('.pn-letter') : null;
    if (paper && paper.focus) { try { paper.focus(); } catch (e) {} }
    return { close: close };
  }

  function entryRow(kind, title, date, text, where, from) {
    var short = String(text || '').replace(/\s+/g, ' ');
    if (short.length > 260) short = short.slice(0, 257).replace(/\s+\S*$/, '') + '…';
    return el('button', { type: 'button', class: 'pn-entry pn-entry-' + kind,
      title: kind === 'letter' ? 'Break the seal and read it' : 'Read the whole ' + kind,
      onClick: function () { openReader(title || cap(kind), [date, where].filter(Boolean).join(' · '), text, { kind: kind, from: from }); } },
      el('span', { class: 'pn-entry-head' },
        kind === 'letter' ? el('img', { class: 'pn-entry-seal', src: 'person/seal.png', alt: '', width: '44', height: '44' }) : null,
        el('span', { class: 'pn-entry-title' }, title || cap(kind)),
        el('span', { class: 'pn-entry-date' }, date || '')),
      el('span', { class: 'pn-entry-text' }, short),
      where ? el('span', { class: 'pn-entry-where' }, where) : null);
  }

  function mountInner(host, ctx, which) {
    ctx = ctx || {};
    var name = ctx.name || '', original = ctx.original || name;
    var query = '';
    host.textContent = '';
    var box = el('div', { class: 'pn-inner pn-inner-' + which });
    host.appendChild(box);
    var search = el('input', { type: 'search', class: 'pn-inner-search', autocomplete: 'off',
      placeholder: which === 'memories' ? 'Search ' + name + '’s letters, diary and memories…' : 'Search who ' + name + ' has feelings about…',
      'aria-label': which === 'memories' ? 'Search letters, diary and memories' : 'Search relationships',
      onInput: function (e) { query = String(e.target.value || '').toLowerCase(); ctl.paint(); },
      onKeydown: function (e) { if (e.key === 'Enter') { var first = box.querySelector('.pn-entry:not([hidden]), .pn-rel:not([hidden])'); if (first && first.click) first.click(); if (e.preventDefault) e.preventDefault(); } } });
    function hit(text) { return !query || String(text || '').toLowerCase().indexOf(query) !== -1; }
    function act(label, title, mode, extra, llm, busyKey, cls) {
      var st = personState(name);
      return el('button', { type: 'button', class: 'pn-act' + (cls ? ' ' + cls : ''), title: title, 'aria-label': title,
        disabled: st.busy || ctx.dead ? true : null,
        onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); personCall(name, original, mode, extra, llm, busyKey); } },
        st.busy === busyKey ? 'Working…' : label);
    }

    function paintMemories(d, body) {
      var letters = (d.letters || []).filter(function (x) { return hit(x.text) || hit(x.topic); });
      var diary = (d.diary || []).filter(function (x) { return hit(x.text) || hit(x.topic) || hit(x.where); });
      var mems = (d.memories || []).filter(function (x) { return hit(x.text); });
      function group(title, sub, rows, empty) {
        return el('section', { class: 'pn-group' },
          el('header', { class: 'pn-group-head' }, el('span', { class: 'pn-eyebrow' }, title), el('span', { class: 'pn-group-count' }, sub)),
          rows.length ? el('div', { class: 'pn-entries' }, rows) : el('p', { class: 'pn-empty' }, empty));
      }
      body.appendChild(group('Letters to you', letters.length + ' of ' + (d.letters || []).length,
        letters.map(function (x) { return entryRow('letter', 'A letter from ' + name, x.date, x.text, '', name); }),
        query ? 'No letter matches.' : name + ' has not written to you. Switch on letters under Bonds & Life, and CHIM’s background life will have ' + name + ' write.'));
      body.appendChild(group('Diary', diary.length + ' of ' + (d.diary || []).length,
        diary.map(function (x) { return entryRow('diary', x.topic || 'Diary', x.date, x.text, x.where); }),
        query ? 'No diary entry matches.' : 'No diary entries yet. CHIM writes them as ' + name + ' lives through things with you.'));
      body.appendChild(group('Memories', mems.length + ' of ' + (d.memories || []).length,
        mems.map(function (x) { return entryRow('memory', 'Memory', x.date, x.text, ''); }),
        query ? 'No memory matches.' : 'CHIM has stored no memories for ' + name + ' yet.'));
    }

    function bondBar(aff) {
      var a = Math.max(-100, Math.min(100, Number(aff) || 0));
      var left = a < 0 ? 50 + a / 2 : 50, width = Math.abs(a) / 2;
      return el('span', { class: 'pn-bond-bar' + (a < 0 ? ' neg' : '') },
        el('i', { style: 'left:' + left + '%;width:' + width + '%' }), el('b', { style: 'left:50%' }));
    }

    function paintBonds(d, body) {
      var b = d.bonds || {}, me = b.player, life = d.life || {};
      var you = el('section', { class: 'pn-group pn-bond-you' },
        el('header', { class: 'pn-group-head' }, el('span', { class: 'pn-eyebrow' }, 'How ' + name + ' feels about you'),
          b.enabled === false ? chip('CHIM relationships are switched off', 'warn') : null));
      if (me) {
        var val = me.aff;
        var out = el('span', { class: 'pn-bond-num' }, String(val));
        var slider = el('input', { type: 'range', min: '-100', max: '100', step: '1', value: String(val), class: 'pn-bond-slider',
          'aria-label': 'Affinity toward you, -100 to 100', disabled: ctx.dead ? true : null,
          onInput: function (e) { out.textContent = e.target.value; },
          onChange: function (e) { personCall(name, original, 'person_bond', '&aff=' + encodeURIComponent(e.target.value), false, 'bond'); } });
        you.appendChild(el('div', { class: 'pn-bond-main' },
          el('span', { class: 'pn-bond-tier' }, me.tier), chip(cap(me.type)), out));
        you.appendChild(slider);
        you.appendChild(el('p', { class: 'pn-hint' }, 'This is the feeling CHIM puts in ' + name + '’s mind every time ' + name +
          ' speaks. Drag to set it; CHIM keeps adjusting it after each conversation.'));
      } else {
        you.appendChild(el('p', { class: 'pn-empty' }, 'CHIM has not judged how ' + name + ' feels about you yet.'));
      }
      you.appendChild(el('div', { class: 'pn-acts' },
        act('Ask CHIM to judge ' + name, 'CHIM’s relationship model reads your history with ' + name + ' and sets the feeling', 'person_analyze', '', true, 'analyze', 'primary')));
      body.appendChild(you);

      var others = (b.others || []).filter(function (r) { return hit(r.name) || hit(r.tier) || hit(r.type); });
      body.appendChild(el('section', { class: 'pn-group' },
        el('header', { class: 'pn-group-head' }, el('span', { class: 'pn-eyebrow' }, name + ' and the others'),
          el('span', { class: 'pn-group-count' }, others.length + ' of ' + (b.others || []).length)),
        others.length ? el('div', { class: 'pn-rels' }, others.map(function (r) {
          return el('div', { class: 'pn-rel' }, el('span', { class: 'pn-rel-name' }, r.name),
            el('span', { class: 'pn-rel-tier' }, r.tier), chip(cap(r.type)), bondBar(r.aff),
            el('span', { class: 'pn-rel-num' }, String(r.aff)));
        })) : el('p', { class: 'pn-empty' }, query ? 'Nobody matches.' : 'No feelings about anyone else recorded yet.')));

      function toggle(label, on, extra, desc, disabled) {
        return el('button', { type: 'button', class: 'pn-toggle' + (on ? ' on' : ''), role: 'switch',
          'aria-checked': on ? 'true' : 'false', disabled: disabled || ctx.dead ? true : null, title: desc,
          onClick: function () { personCall(name, original, 'person_life', extra, false, 'life'); } },
          el('span', { class: 'pn-toggle-knob' }), el('span', { class: 'pn-toggle-text' },
            el('b', null, label), el('span', null, desc)));
      }
      var lifeBox = el('section', { class: 'pn-group pn-life' },
        el('header', { class: 'pn-group-head' }, el('span', { class: 'pn-eyebrow' }, 'Life away'),
          el('span', { class: 'pn-group-count' }, life.enabled ? 'every ' + (life.every_hours || 24) + ' game hours' : 'off')),
        el('div', { class: 'pn-toggles' },
          toggle('Background life', !!life.enabled, '&enabled=' + (life.enabled ? '0' : '1'),
            'While you are apart, CHIM gives ' + name + ' an off-screen turn: what ' + name + ' does, and the rumours that follow.'),
          toggle('Letters', !!life.letters, '&letters=' + (life.letters ? '0' : '1'),
            name + ' writes to you. A letter arrives in game as a book, by courier.', !life.enabled)),
        el('p', { class: 'pn-hint' }, life.last ? 'Last turn: ' + life.last : 'No turn taken yet.'),
        el('div', { class: 'pn-acts' },
          act('Write me a letter now', 'Have ' + name + ' write to you now (CHIM writes it; it arrives by courier)', 'person_life_now', '&kind=letter', true, 'letter', 'primary'),
          act('Take a turn now', 'Run one of ' + name + '’s off-screen turns now', 'person_life_now', '&kind=action', true, 'action')));
      var hist = (life.history || []).filter(function (h) { return hit(h.text) || hit(h.category); });
      lifeBox.appendChild(hist.length ? el('div', { class: 'pn-entries' }, hist.map(function (h) {
        return el('div', { class: 'pn-life-row' }, chip(cap(h.category || 'life')), el('span', { class: 'pn-life-text' }, h.text),
          el('span', { class: 'pn-entry-date' }, h.date || ''));
      })) : el('p', { class: 'pn-empty' }, life.enabled ? 'Nothing has happened off-screen yet — the first turn comes within ' + (life.every_hours || 24) + ' game hours.' :
        'Switch on background life and ' + name + ' starts living while you are away.'));
      body.appendChild(lifeBox);
    }

    var ctl = {
      kind: 'inner', name: name, host: host,
      paint: function () {
        var st = personState(name);
        var active = document.activeElement === search;
        box.textContent = '';
        box.appendChild(el('div', { class: 'pn-inner-top' }, search,
          el('button', { type: 'button', class: 'pn-act', title: 'Read again from CHIM', disabled: st.state === 'loading' ? true : null,
            onClick: function () { personCall(name, original, 'person', '', false, ''); } }, 'Refresh')));
        if (st.msg) box.appendChild(el('p', { class: 'pn-inner-msg' + (st.state === 'error' ? ' err' : ''), role: 'status' }, st.msg));
        var body = el('div', { class: 'pn-inner-body' });
        box.appendChild(body);
        if (!st.data) {
          body.appendChild(el('p', { class: 'pn-empty' }, st.state === 'loading' ? 'Reading ' + name + ' from CHIM…' : (st.msg ? '' : 'Nothing read yet.')));
        } else if (which === 'memories') paintMemories(st.data, body);
        else paintBonds(st.data, body);
        if (active && search.focus) try { search.focus(); } catch (e) { /* harness */ }
      },
      destroy: function () { host.textContent = ''; }
    };
    live.push(ctl);
    ctl.paint();
    var st0 = personState(name);
    if (!st0.data && st0.state !== 'loading' && !ctx.dead) personCall(name, original, 'person', '', false, '');
    else if (ctx.dead && !st0.data) personCall(name, original, 'person', '', false, '');
    return ctl;
  }

  /* -------------------------------------------------------- the dashboard */
  /* The Household tab's "Today" view (2026-10-03, Rober: "1. sure, dynamic?
     2. dashboard be nice for suere!"). One CHIM call does two jobs:
       · DYNAMIC SYNC — person.php `household` keeps CHIM awake for whoever is in
         the household right now: never-judged people go into CHIM's own
         relationship queue (its worker judges them during play), and the FIRST
         time someone is seen her Background Life + letters are switched on
         (once — a later manual "off" stands). New wives join on their own.
       · THE DIGEST — her letters, off-screen happenings, recent diary and how
         each one feels about you, drawn here with what the deck already knows
         (pregnancy terms from Fertility Mode).
     Re-asked only when the household changes, on Refresh, or after 5 minutes. */
  var house = { sig: '', state: 'idle', data: null, msg: '', at: 0 };

  function houseAsk(names, sig) {
    if (!window.HDOmni || typeof HDOmni.chimCall !== 'function') {
      house.state = 'error'; house.msg = 'CHIM is not available in this view.'; houseRepaint(); return;
    }
    house.sig = sig; house.state = house.data ? 'refreshing' : 'loading'; house.at = Date.now(); houseRepaint();
    HDOmni.chimCall('mode=person_household&npc=-&auto=1&names=' + encodeURIComponent(JSON.stringify(names)), function (env) {
      env = coerce(env) || {};
      var j = coerce(env.json) || {};
      if (env.ok === false && !j.ok) { house.state = house.data ? 'ok' : 'error'; house.msg = 'CHIM did not answer — it only runs while the game and the CHIM launcher are up.'; }
      else if (j.ok === false) { house.state = house.data ? 'ok' : 'error'; house.msg = j.why || j.error || 'CHIM refused the household.'; }
      else { house.state = 'ok'; house.data = j; house.msg = ''; }
      houseRepaint();
    }, false);
  }
  function houseRepaint() { live.forEach(function (c) { if (c.kind === 'dash') c.paint(); }); }

  function mountDashboard(host, opts) {
    opts = opts || {};
    var rows = (opts.rows || []).filter(function (r) { return r && (r.original || r.name); });
    var names = rows.map(function (r) { return String(r.original || r.name); }).sort();
    var sig = names.join('|');
    var query = String(opts.query || '').toLowerCase();
    live = live.filter(function (c) { if (c.kind === 'dash') { c.destroy(); return false; } return true; });
    host.textContent = '';
    var box = el('div', { class: 'pn-dash' });
    host.appendChild(box);
    function hit() {
      if (!query) return true;
      for (var i = 0; i < arguments.length; i++) if (String(arguments[i] || '').toLowerCase().indexOf(query) !== -1) return true;
      return false;
    }
    function rowFor(name) {
      var n = String(name || '').toLowerCase();
      return rows.filter(function (r) { return String(r.original || '').toLowerCase() === n || String(r.name || '').toLowerCase() === n; })[0] || null;
    }
    function person(name) {
      var r = rowFor(name);
      return el('button', { type: 'button', class: 'pn-dash-name', title: r ? 'Open ' + (r.name || name) : name,
        disabled: r && opts.openPerson ? null : true,
        onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (r && opts.openPerson) opts.openPerson(r); } }, (r && r.name) || name);
    }
    function section(cls, title, sub, kids) {
      return el('section', { class: 'pn-dash-sec ' + cls },
        el('header', { class: 'pn-group-head' }, el('span', { class: 'pn-eyebrow' }, title), sub ? el('span', { class: 'pn-group-count' }, sub) : null),
        kids);
    }

    var ctl = {
      kind: 'dash', host: host,
      paint: function () {
        box.textContent = '';
        var d = house.data;
        var head = el('div', { class: 'pn-dash-head' },
          el('div', null, el('h2', { class: 'pn-dash-title' }, 'The house today'),
            el('p', { class: 'pn-dash-date' }, d && d.today ? d.today : 'Tamriel time comes from CHIM')),
          el('button', { type: 'button', class: 'pn-act', title: 'Ask CHIM again and re-sync the household',
            disabled: house.state === 'loading' || house.state === 'refreshing' ? true : null,
            onClick: function () { houseAsk(names, sig); } }, house.state === 'refreshing' || house.state === 'loading' ? 'Asking CHIM…' : 'Refresh'));
        box.appendChild(head);
        if (house.msg) box.appendChild(el('p', { class: 'pn-inner-msg' + (house.state === 'error' ? ' err' : ''), role: 'status' }, house.msg));
        if (d) {
          var bits = [];
          if (d.queued) bits.push(d.queued + (d.queued === 1 ? ' person' : ' people') + ' sent to CHIM to be judged for the first time');
          if (d.woke && d.woke.length) bits.push('Background Life and letters switched on for ' + d.woke.join(', '));
          if (bits.length) box.appendChild(el('p', { class: 'pn-dash-sync' }, bits.join(' · ') + '.'));
        }

        // ---- needs you: one card each, one shape
        var needs = [];
        rows.forEach(function (r) {
          var f = r.fert;
          if (f && f.pregnant && typeof f.percent === 'number' && f.percent >= 80 && hit(r.name, 'pregnant', 'term'))
            needs.push({ cls: 'preg', title: (r.name || r.original) + ' is near her term', text: f.percent + '% along' +
              (f.termDays ? ' · day ' + f.day + ' of ' + f.termDays : '') + (f.father ? ' · father ' + f.father : ''), who: r.original || r.name });
        });
        ((d && d.people) || []).forEach(function (p) {
          if (p.judged && p.aff !== null && p.aff < 31 && hit(p.name, p.tier, 'feel'))
            needs.push({ cls: p.aff < -5 ? 'cold' : 'cool', title: p.name + ' feels ' + p.tier + ' toward you',
              text: (p.aff > 0 ? '+' : '') + p.aff + ' · ' + cap(p.type || 'neutral') + ' — talk to her; CHIM re-judges after every conversation', who: p.name });
        });
        if (d && d.missing && d.missing.length && hit(d.missing.join(' '), 'chim', 'profile'))
          needs.push({ cls: 'info', title: 'No CHIM profile yet', text: d.missing.join(', ') + ' — talk to ' + (d.missing.length === 1 ? 'her' : 'each') + ' once in game and CHIM starts remembering.', who: '' });
        ((d && d.problems) || []).forEach(function (t) {
          needs.push({ cls: 'info', title: 'CHIM setting needs fixing', text: t, who: '' });
        });
        var needBox = el('div', { class: 'pn-needs' });
        if (!needs.length) needBox.appendChild(el('div', { class: 'pn-need calm' }, el('b', null, d ? 'Nothing needs you right now' : 'Reading the household…'),
          el('span', null, d ? 'No one is near her term, and no one feels cold toward you.' : 'Asking CHIM about ' + names.length + (names.length === 1 ? ' person' : ' people') + '…')));
        needs.forEach(function (n) {
          var r = n.who ? rowFor(n.who) : null;
          needBox.appendChild(el('button', { type: 'button', class: 'pn-need ' + n.cls, disabled: r && opts.openPerson ? null : true,
            onClick: function () { if (r && opts.openPerson) opts.openPerson(r); } }, el('b', null, n.title), el('span', null, n.text)));
        });
        box.appendChild(section('pn-dash-needs', 'Needs you', needs.length ? String(needs.length) : '', needBox));

        // ---- letters | happenings
        var letters = ((d && d.letters) || []).filter(function (x) { return hit(x.name, x.text); });
        var happen = ((d && d.happenings) || []).filter(function (x) { return hit(x.name, x.text, x.category); });
        var cols = el('div', { class: 'pn-dash-cols' },
          section('pn-dash-letters', 'Letters', letters.length ? String(letters.length) : '',
            letters.length ? el('div', { class: 'pn-entries' }, letters.map(function (x) { return entryRow('letter', 'From ' + x.name, x.date, x.text, '', x.name); }))
              : el('p', { class: 'pn-empty' }, d ? (query ? 'No letter matches.' : 'No letters yet. With letters on, each of them writes when CHIM’s Background Life gives her a turn (every ' + (d.every_hours || 24) + ' game hours).') : '')),
          section('pn-dash-happen', 'While you were away', happen.length ? String(happen.length) : '',
            happen.length ? el('div', { class: 'pn-entries' }, happen.map(function (x) {
              return el('div', { class: 'pn-life-row' }, chip(cap(x.category || 'life')),
                el('span', { class: 'pn-life-text' }, person(x.name), ' ', x.text), el('span', { class: 'pn-entry-date' }, x.date || ''));
            })) : el('p', { class: 'pn-empty' }, d ? (query ? 'Nothing matches.' : 'Nothing has happened off-screen yet. Background Life gives each of them a turn every ' + (d.every_hours || 24) + ' game hours while you are apart.') : '')));
        box.appendChild(cols);

        // ---- how they feel
        var people = ((d && d.people) || []).filter(function (p) { return hit(p.name, p.tier, p.type); });
        box.appendChild(section('pn-dash-feel', 'How they feel about you', people.length ? String(people.length) : '',
          people.length ? el('div', { class: 'pn-rels' }, people.map(function (p) {
            return el('div', { class: 'pn-rel' }, person(p.name),
              el('span', { class: 'pn-rel-tier' }, p.judged ? p.tier : (p.queued ? 'Being judged…' : 'Not judged yet')),
              p.judged ? chip(cap(p.type || 'neutral')) : chip(p.life ? (p.letters ? 'Life + letters' : 'Life on') : 'Life off', p.life ? '' : 'warn'),
              p.judged ? bondBarFor(p.aff) : el('span', { class: 'pn-bond-bar' }),
              el('span', { class: 'pn-rel-num' }, p.judged ? String(p.aff) : '—'));
          })) : el('p', { class: 'pn-empty' }, d ? 'Nobody to show.' : '')));

        // ---- recent diary
        var diary = ((d && d.diary) || []).filter(function (x) { return hit(x.name, x.text, x.topic); });
        if (diary.length || !d) box.appendChild(section('pn-dash-diary', 'From their diaries', diary.length ? String(diary.length) : '',
          el('div', { class: 'pn-entries' }, diary.map(function (x) { return entryRow('diary', x.name + ' · ' + (x.topic || 'Diary'), x.date, x.text, x.where); }))));
      },
      destroy: function () { host.textContent = ''; }
    };
    live.push(ctl);
    ctl.paint();
    var stale = !house.data || house.sig !== sig || (Date.now() - house.at) > 5 * 60 * 1000;
    if (names.length && stale && house.state !== 'loading' && house.state !== 'refreshing') houseAsk(names, sig);
    return ctl;
  }
  function bondBarFor(aff) {
    var a = Math.max(-100, Math.min(100, Number(aff) || 0));
    var left = a < 0 ? 50 + a / 2 : 50, width = Math.abs(a) / 2;
    return el('span', { class: 'pn-bond-bar' + (a < 0 ? ' neg' : '') },
      el('i', { style: 'left:' + left + '%;width:' + width + '%' }), el('b', { style: 'left:50%' }));
  }

  /* ------------------------------------------------------------ live view */
  /* The game itself draws her (PersonLive in C++): the deck hides, the free
     camera frames her full height right of centre, the portrait fill rides the
     camera, and dragging anywhere turns the camera round her. pnLive {op} ->
     pnLiveData {ok, why?, op, yaw, zoom}. The whole layer is body-anchored and
     fills the viewport (bare vh/vw are correct; it never wears the deck scale),
     and it OWNS the keyboard while up (capture listener) so Escape leaves the
     live view, not the dossier. */
  var liveEl = null, liveCtx = null, liveDrag = null, livePending = 0, liveTimer = 0, liveStatus = null;

  function liveSend(payload) { send('pnLive', payload); }
  function liveOrbit(dyaw, dzoom, reset) { liveSend({ op: 'orbit', dyaw: dyaw || 0, dzoom: dzoom || 1, reset: !!reset }); }
  function liveFlush() {
    liveTimer = 0;
    if (!livePending) return;
    var d = livePending; livePending = 0;
    liveOrbit(d, 1, false);
  }
  function liveSay(text) { if (liveStatus) liveStatus.textContent = text; }

  function liveKey(e) {
    if (!liveEl) return;
    var k = e.key, handled = true;
    if (k === 'Escape' || k === 'Backspace') exitLive('key');
    else if (k === 'ArrowLeft') liveOrbit(-15, 1, false);
    else if (k === 'ArrowRight') liveOrbit(15, 1, false);
    else if (k === '+' || k === '=' || k === 'ArrowUp') liveOrbit(0, 1 / 1.12, false);
    else if (k === '-' || k === '_' || k === 'ArrowDown') liveOrbit(0, 1.12, false);
    else if (k === 'Home') liveOrbit(0, 1, true);
    else handled = false;
    if (handled) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); e._fdDossierHandled = true; }
  }
  function liveDown(e) {
    if (!liveEl || (e.button !== undefined && e.button !== 0)) return;
    var side = liveEl.querySelector('.pnl-side');
    if (side && side.contains(e.target)) return;
    liveDrag = { x: e.clientX };
    liveEl.classList.add('pnl-dragging');
    if (e.preventDefault) e.preventDefault();
  }
  function liveMove(e) {
    if (!liveDrag) return;
    var dx = e.clientX - liveDrag.x;
    if (!dx) return;
    liveDrag.x = e.clientX;
    livePending += dx * 0.35;   // degrees per pixel: a full turn is about a screen width
    if (!liveTimer) liveTimer = later(liveFlush, 33) || (liveFlush(), 0);
  }
  function liveUp() { if (liveDrag) { liveDrag = null; if (liveEl) liveEl.classList.remove('pnl-dragging'); liveFlush(); } }
  function liveWheel(e) {
    if (!liveEl) return;
    var d = e.deltaY || 0;
    if (!d) return;
    liveOrbit(0, d < 0 ? 1 / 1.12 : 1.12, false);
    if (e.preventDefault) e.preventDefault();
  }

  function enterLive(ctx) {
    if (liveEl) exitLive('restart');
    ctx = ctx || {};
    liveCtx = ctx;
    var name = ctx.name || 'them';
    function b(label, title, fn, cls) {
      return el('button', { type: 'button', class: 'pnl-btn' + (cls ? ' ' + cls : ''), title: title, 'aria-label': title,
        onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); fn(); } }, label);
    }
    var s = sees[name];
    liveStatus = el('p', { class: 'pnl-status', role: 'status', 'aria-live': 'polite' }, 'Moving the camera to ' + name + '…');
    var side = el('aside', { class: 'pnl-side', 'aria-label': name + ', live view' },
      el('span', { class: 'pn-eyebrow' }, 'The Mirror · live'),
      el('h1', { class: 'pnl-name' }, name),
      ctx.hero ? hero(ctx.hero) : null,
      s && s.text ? el('p', { class: 'pnl-sees' }, s.text) : null,
      el('div', { class: 'pnl-ctl' },
        b('‹ Turn', 'Turn left', function () { liveOrbit(-30, 1, false); }),
        b('Face me', 'Face the camera, full height', function () { liveOrbit(0, 1, true); }),
        b('Turn ›', 'Turn right', function () { liveOrbit(30, 1, false); }),
        b('Closer', 'Move the camera closer', function () { liveOrbit(0, 1 / 1.2, false); }),
        b('Further', 'Move the camera back', function () { liveOrbit(0, 1.2, false); }),
        b('Back', 'Back to the page (Esc)', function () { exitLive('button'); }, 'pnl-back')),
      el('p', { class: 'pnl-hint' }, 'Drag anywhere to turn · wheel to zoom · Esc to go back'),
      liveStatus);
    liveEl = el('div', { id: 'pn-live', class: 'pnl', role: 'dialog', 'aria-modal': 'true', 'aria-label': name + ', live view' },
      side, el('div', { class: 'pnl-tag' }, 'LIVE · in the world'));
    document.body.appendChild(liveEl);
    if (document.body.classList) document.body.classList.add('pn-live-on');
    liveEl.addEventListener('mousedown', liveDown);
    liveEl.addEventListener('wheel', liveWheel);
    document.addEventListener('mousemove', liveMove);
    document.addEventListener('mouseup', liveUp);
    if (window.addEventListener) { window.addEventListener('keydown', liveKey, true); window.addEventListener('blur', liveUp); }
    liveSend({ op: 'start', id: String(ctx.formId || '') });
  }

  function exitLive(why, message) {
    if (!liveEl) return;
    cancel(liveTimer); liveTimer = 0; livePending = 0; liveDrag = null;
    if (why !== 'refused' && why !== 'lost') liveSend({ op: 'stop' });
    document.removeEventListener('mousemove', liveMove);
    document.removeEventListener('mouseup', liveUp);
    if (window.removeEventListener) { window.removeEventListener('keydown', liveKey, true); window.removeEventListener('blur', liveUp); }
    if (liveEl.parentNode) liveEl.parentNode.removeChild(liveEl);
    liveEl = null; liveStatus = null;
    if (document.body.classList) document.body.classList.remove('pn-live-on');
    var ctx = liveCtx; liveCtx = null;
    if (message && ctx) {
      live.forEach(function (c) { if (c.kind === 'mirror' && c.id === String(ctx.formId)) c.say(message); });
      if (typeof window.toast === 'function') window.toast(message);
    }
  }

  window.pnLiveData = function (env) {
    env = coerce(env);
    if (!env || typeof env !== 'object' || !liveEl) return;
    if (env.op === 'stop') return;
    if (env.ok === false) {
      exitLive(env.op === 'start' ? 'refused' : 'lost', 'Live view: ' + (env.why || 'it could not start.'));
      return;
    }
    var yaw = Math.round(Number(env.yaw) || 0), zoom = Number(env.zoom) || 1;
    liveSay((yaw === 0 ? 'Facing you' : (yaw > 0 ? 'Turned ' + yaw + '° right' : 'Turned ' + (-yaw) + '° left')) +
      ' · ' + (zoom < 0.8 ? 'close' : zoom > 1.1 ? 'far' : 'full height'));
  };

  // The live layer OUTLIVES dossier rebuilds (every live push rebuilds the page
  // under it); it ends on Back / Esc, a refusal, or the deck closing. C++ has
  // already handed the camera back on a palette close, so no stop is sent then.
  var prevClosed = window.hdClosed;
  window.hdClosed = function () {
    if (liveEl) exitLive('lost');
    if (typeof prevClosed === 'function') return prevClosed.apply(this, arguments);
  };

  function unmount(root) {
    live = live.filter(function (c) {
      var inside = !root || !c.host || root === c.host || (root.contains && root.contains(c.host)) || !c.host.isConnected;
      if (inside) c.destroy();
      return !inside;
    });
  }

  window.HDPerson = {
    hero: hero,
    mountSees: mountSees,
    mountMirror: mountMirror,
    unmount: unmount,
    mountInner: mountInner,
    mountDashboard: mountDashboard,
    openReader: openReader,
    enterLive: enterLive,
    exitLive: exitLive,
    liveOpen: function () { return !!liveEl; },
    // harness hooks — read-only views of the module caches
    _state: function () { return { mirrors: mirrors, sees: sees, live: live.length, kinds: live.map(function (c) { return c.kind; }) }; },
    _reset: function () { if (liveEl) exitLive('lost'); unmount(null); mirrors = Object.create(null); sees = Object.create(null); people = Object.create(null); house = { sig: '', state: 'idle', data: null, msg: '', at: 0 }; }
  };
})();
