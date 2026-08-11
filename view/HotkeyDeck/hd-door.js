'use strict';

/* ====================================================================== *
 *  Door lock modal — F7 on a door → "lock or unlock?" with a level picker.
 *
 *  Rober's ask (2026-08-09): "hit F7 on a door and have a popup asking if
 *  you want to lock the door or unlock — (be able to set the lock level)".
 *  Polish pass same day: lock-state HERO (big animated padlock plate +
 *  difficulty meter), tier-coloured chips, smooth level slider synced with
 *  the exact-level field, state-flip snap animation.
 *
 *  Shape: a sibling of the Formation modal (#fm-modal) — an absolute
 *  inset-0 backdrop INSIDE #panel (inherits --ui-scale, clips to the deck
 *  window), flex-centered box, z-index 74, own sheet hd-door.css linked
 *  from index.html (NEVER merged into app.css — the sync_view_frags
 *  truncation trap).
 *
 *  Bridge (one name per direction): drSet→drResult · drRefresh→drTarget.
 *  C++ pushes drTarget on every palette open: non-null AND fresh-open →
 *  the modal raises itself over whatever tab loaded; null closes a stale
 *  modal from the previous open. drResult carries {ok,msg,state} where
 *  state is the engine's re-read truth after `lock`/`unlock` ran.
 *
 *  Lock tiers (CK canon): Novice 1 · Apprentice 25 · Adept 50 · Expert 75
 *  · Master 100 · Requires Key 255 (>100 = unpickable). The slider covers
 *  the pickable 1–100; Requires Key is its own chip (and the number field
 *  accepts any 0–255).
 *
 *  Ultralight rules honoured: no prompt/confirm, title= tooltips drawn by
 *  app.js's #hd-tip layer, window.hdSmoothRange wraps the slider, and
 *  hdCapture is claimed while open so digits typed into the level field
 *  never quick-fire a hotkey.
 * ====================================================================== */

(function () {
  /* Tier colour runs cool→hot with difficulty; Requires Key goes arcane
     purple. `seg` = how many meter segments the tier fills (of 5). */
  const TIERS = [
    { lvl: 1,   name: 'Novice',       color: '#86c97e', seg: 1, hint: 'Trivial pick — anyone gets in' },
    { lvl: 25,  name: 'Apprentice',   color: '#b4c76a', seg: 2, hint: 'Easy pick' },
    { lvl: 50,  name: 'Adept',        color: '#d9b65a', seg: 3, hint: 'Average pick' },
    { lvl: 75,  name: 'Expert',       color: '#d98a5a', seg: 4, hint: 'Hard pick' },
    { lvl: 100, name: 'Master',       color: '#d96a5a', seg: 5, hint: 'Hardest pickable lock' },
    { lvl: 255, name: 'Requires Key', color: '#b07ad9', seg: 5, hint: 'Unpickable — key holders only' },
  ];

  const S = {
    open: false,
    target: null,   // last drTarget state {refId,name,hasLock,locked,level,tier,keyName}
    pick: 50,       // the level the Lock button will use
    busy: false,    // a drSet is in flight
    wasLocked: null, // previous locked state — a flip triggers the snap animation
  };

  let el = null;    // the backdrop node

  function toGameSafe(fn, arg) {
    if (typeof window.toGame === 'function') window.toGame(fn, arg);
  }
  function say(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
  }

  function tierOf(lvl) {
    if (lvl > 100) return 'Requires Key';
    if (lvl >= 100) return 'Master';
    if (lvl >= 75) return 'Expert';
    if (lvl >= 50) return 'Adept';
    if (lvl >= 25) return 'Apprentice';
    return 'Novice';
  }
  function tierInfo(lvl) {
    const name = tierOf(lvl);
    return TIERS.find((t) => t.name === name) || TIERS[2];
  }

  /* --------------------------------------------------------------- dom -- */

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'style') n.style.cssText = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    }
    for (const kid of kids) {
      if (kid == null) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function ensureDom() {
    if (el && el.isConnected) return el;
    const panel = document.getElementById('panel') || document.body;
    el = h('div', { id: 'dr-modal', class: 'hidden' });
    /* Backdrop click closes; clicks inside the box stay inside. */
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.target === el) close();
    });
    panel.appendChild(el);
    return el;
  }

  /* ------------------------------------------------------------ bridge -- */

  window.drTarget = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    S.target = (d && d.name) ? d : null;
    S.busy = false;
    if (!S.target) {
      /* Reopened with no door under the crosshair: a modal left over from the
         previous open would be lying about what F7 was pointed at. */
      S.wasLocked = null;
      if (S.open) close();
      return;
    }
    /* Seed the picker from the door's current level, so "re-lock as it was"
       is the zero-click default. */
    const cur = S.target.level | 0;
    S.pick = (S.target.hasLock && cur > 0) ? cur : 50;
    S.wasLocked = !!S.target.locked;   // fresh door: no snap animation on first paint
    const fresh = (Date.now() - (window.__hdOpenedAt || 0)) < 1500;
    if (fresh && !S.open) open();
    else if (S.open) render();
  };

  window.drResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d) return;
    S.busy = false;
    if (d.msg) say(d.msg);
    if (d.state && d.state.name) S.target = d.state;
    else if (!d.ok) S.target = null;   // door gone — show the honest empty state
    if (S.open) render();
  };

  /* ------------------------------------------------------------ render -- */

  /* Five-segment pick-difficulty meter, filled + coloured by tier. An
     unlocked/no-lock door shows the frame empty (the lock isn't holding
     anything); Requires Key fills all five in arcane purple. */
  function meter(t) {
    const info = tierInfo(t.level | 0);
    const hasKeyBar = t.tier === 'Requires Key';
    const fill = t.locked ? (hasKeyBar ? 5 : info.seg) : 0;
    const wrap = h('div', {
      class: 'dr-meter',
      title: t.locked ? ('Pick difficulty: ' + t.tier) : 'Not locked — no pick needed',
    });
    for (let i = 0; i < 5; i++) {
      wrap.append(h('span', {
        class: 'dr-meter-seg' + (i < fill ? ' on' : ''),
        style: i < fill ? ('background:' + info.color + '; box-shadow: 0 0 8px ' + info.color + '55') : null,
      }));
    }
    return wrap;
  }

  /* The lock-state hero: big padlock plate (animates on state flips) +
     state word, tier line, meter, key row. */
  function hero(t) {
    const flipped = S.wasLocked !== null && S.wasLocked !== !!t.locked;
    S.wasLocked = !!t.locked;
    const info = tierInfo(t.level | 0);

    const glyph = h('div', {
      class: 'dr-hero-glyph ' + (t.locked ? 'is-locked' : 'is-open') + (flipped ? ' dr-snap' : ''),
      title: t.locked ? 'The lock is engaged' : 'The way is open',
    }, h('span', { class: 'dr-hero-ico' }, t.locked ? '🔒' : '🔓'));

    const infoCol = h('div', { class: 'dr-hero-info' },
      h('div', { class: 'dr-hero-state ' + (t.locked ? 'is-locked' : 'is-open') },
        t.hasLock ? (t.locked ? 'Locked' : 'Unlocked') : 'No lock'),
      t.hasLock
        ? h('div', { class: 'dr-hero-tier', style: 'color:' + info.color },
            t.tier + ' · level ' + t.level)
        : h('div', { class: 'dr-hero-tier dim' }, 'This door has never had a lock — locking adds one'),
      meter(t),
      t.keyName
        ? h('div', { class: 'dr-hero-key', title: 'The key that opens this lock' }, '🗝 ' + t.keyName)
        : null);

    return h('div', { class: 'dr-hero' }, glyph, infoCol);
  }

  function syncPickUi(chips, slide, num, lockBtn) {
    const want = tierOf(S.pick);
    chips.querySelectorAll('.dr-tier').forEach((c, i) => {
      const on = TIERS[i].name === want;
      c.classList.toggle('active', on);
      c.style.borderColor = on ? TIERS[i].color : '';
      c.style.boxShadow = on ? ('0 0 14px ' + TIERS[i].color + '33 inset, 0 0 10px ' + TIERS[i].color + '22') : '';
    });
    if (slide) {
      slide.value = String(Math.min(100, Math.max(1, S.pick)));
      slide.classList.toggle('dr-keyed', S.pick > 100);
      const pct = (Math.min(100, Math.max(1, S.pick)) - 1) / 99 * 100;
      slide.style.background = 'linear-gradient(90deg, ' + tierInfo(S.pick).color + ' ' + pct + '%, #ffffff14 ' + pct + '%)';
    }
    if (num && document.activeElement !== num) num.value = String(S.pick);
    if (lockBtn) {
      lockBtn.textContent = '🔒 Lock — ' + tierOf(S.pick);
      lockBtn.setAttribute('title', 'Lock this door at ' + tierOf(S.pick) + ' (level ' + S.pick + ')' +
        (S.pick > 100 ? ' — unpickable without the key' : ''));
    }
  }

  function render() {
    const root = ensureDom();
    root.textContent = '';
    const box = h('div', { class: 'dr-box', role: 'dialog', 'aria-label': 'Door lock' });
    root.appendChild(box);

    const t = S.target;

    box.append(h('div', { class: 'dr-head' },
      h('span', { class: 'dr-door-plate', 'aria-hidden': 'true' }, '🚪'),
      h('span', { class: 'dr-title', title: t ? t.name : null }, t ? t.name : 'Door'),
      h('button', {
        class: 'dr-close', type: 'button', title: 'Close (Esc)',
        onClick: () => close(),
      }, '✕')));

    const body = h('div', { class: 'dr-body' });
    box.append(body);

    if (!t) {
      body.append(h('div', { class: 'dr-empty' },
        h('div', { class: 'dr-empty-ic' }, '🚪'),
        h('div', { class: 'dr-empty-t' },
          'No door under the crosshair. Look straight at a door and press the deck key again.')));
      return;
    }

    body.append(hero(t));

    /* Level picker: six tier chips, a smooth 1–100 slider, exact number. */
    body.append(h('div', { class: 'dr-sect' }, 'Lock level'));
    const chips = h('div', { class: 'dr-tiers' });
    let slide = null, num = null, lockBtn = null;
    for (const tier of TIERS) {
      chips.append(h('button', {
        class: 'dr-tier', type: 'button',
        title: tier.hint + ' (level ' + tier.lvl + ')',
        onClick: () => { S.pick = tier.lvl; syncPickUi(chips, slide, num, lockBtn); },
      },
        h('span', { class: 'dr-tier-dot', style: 'background:' + tier.color + '; box-shadow: 0 0 6px ' + tier.color + '66' }),
        h('span', { class: 'dr-tier-name' }, tier.name),
        h('span', { class: 'dr-tier-lvl' }, String(tier.lvl))));
    }
    body.append(chips);

    slide = h('input', {
      class: 'dr-slide', type: 'range', min: '1', max: '100', step: '1',
      value: String(Math.min(100, Math.max(1, S.pick))),
      title: 'Drag through the pickable range (1–100)',
    });
    slide.addEventListener('input', () => {
      S.pick = parseInt(slide.value, 10) || 1;
      syncPickUi(chips, slide, num, lockBtn);
    });
    if (typeof window.hdSmoothRange === 'function') window.hdSmoothRange(slide);

    num = h('input', {
      class: 'dr-lvl', type: 'number', min: '0', max: '255', value: String(S.pick),
      title: 'Exact level: 1–100 pickable, over 100 requires a key',
    });
    num.addEventListener('input', () => {
      const v = parseInt(num.value, 10);
      if (!isNaN(v)) S.pick = Math.max(0, Math.min(255, v));
      syncPickUi(chips, slide, num, lockBtn);
    });

    body.append(h('div', { class: 'dr-fine' },
      slide,
      h('label', { class: 'dr-fine-lbl', title: 'The exact number the lock is set to' }, 'Level', num)));

    /* The question itself: two big verbs — a FOOTER outside the scroll area,
       so a short deck window scrolls the picker, never the answer buttons. */
    const disabled = S.busy ? ' dr-busy' : '';
    lockBtn = h('button', {
      class: 'dr-btn dr-btn-lock' + disabled, type: 'button',
      onClick: () => fire(true),
    }, '🔒 Lock — ' + tierOf(S.pick));
    box.append(h('div', { class: 'dr-foot' },
      h('div', { class: 'dr-actions' },
        lockBtn,
        h('button', {
          class: 'dr-btn dr-btn-unlock' + disabled, type: 'button',
          title: t.locked ? 'Unlock this door' : 'Already unlocked — harmless to send again',
          onClick: () => fire(false),
        }, '🔓 Unlock')),
      h('div', { class: 'dr-hint' }, 'Enter locks at the picked level · Esc closes')));

    syncPickUi(chips, slide, num, lockBtn);
  }

  function fire(lock) {
    if (S.busy) return;
    S.busy = true;
    toGameSafe('drSet', JSON.stringify({ action: lock ? 'lock' : 'unlock', level: S.pick }));
    render();
  }

  /* ------------------------------------------------------------ public -- */

  function open() {
    S.open = true;
    S.busy = false;
    ensureDom().classList.remove('hidden');
    toGameSafe('hdCapture', '1');   // digits typed into the level field must not quick-fire
    render();
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    if (el) el.classList.add('hidden');
    toGameSafe('hdCapture', '0');
  }

  function onKey(e) {
    if (!S.open) return false;
    if (e.key === 'Escape' || e.code === 'Escape') { close(); return true; }
    if (e.key === 'Enter' || e.code === 'Enter') { fire(true); return true; }
    return false;   // the slider / number field keep their native keys
  }

  window.HDDoor = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    onKey: onKey,
    _state: S,        // harness introspection only
    _render: render,  // harness
    _tierOf: tierOf,  // harness
  };
})();
