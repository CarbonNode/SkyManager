'use strict';

/* ====================================================================== *
 *  Key strip — the keys your keyboard hasn't got, where you look for them.
 *
 *  Rober, 2026-09-20: "if i search for end or home or other stuff (hotkeys)
 *  not on a keyboard it should show a strip at the top showing little
 *  clickable key icons (like a keyboard) for common things like if i search
 *  home, ins, etc etc page up, del, etc".
 *
 *  He plays from a couch on a board with no nav cluster and no numpad, so
 *  "press End" (Community Shaders), "press Insert", "press Page Up" are
 *  instructions he cannot follow. The Numpad tab has been the answer since
 *  2026-08-30 — but only if you remember it exists and go there. The search
 *  box is where a player actually types the word "end", so the key itself is
 *  offered THERE, above the rows, as a cap you click.
 *
 *  ---- what it is allowed to fire ---------------------------------------
 *  Exactly the keys the Numpad tab already fires: app.js hands us its flat
 *  NUMPAD_LAYOUT as window.hdKeypadKeys. Nothing new is invented here, so a
 *  cap on this strip is a key that has been play-proven for weeks. The table
 *  below adds only ALIASES — the words a person types for a key whose label
 *  is an abbreviation ("page up" for PgUp, "ins" for Insert, "tilde" for `).
 *
 *  ---- and how ----------------------------------------------------------
 *  Through window.hdFireRawKey (app.js), which sends hdFireKey with
 *  close:true. That matters: the Numpad TAB runs the game live (OnJsTab), so
 *  a key fired there lands immediately — the Hotkeys tab is PAUSED, and a key
 *  fired into a paused game is a key that did nothing. close:true routes the
 *  C++ through FireAndClose, the same close → unpause → press path every
 *  hotkey row already uses. Pressing a cap here IS pressing the key.
 *
 *  ---- and the finder too (2026-10-14) ----------------------------------
 *  Rober: "when you search escape it used to show a clickable button that
 *  fires that button, searching f12 etc used to do that now it doesnt".
 *  Since the two-bar header (2026-10-11) the header search hands typing to
 *  the Omni, so the Hotkeys filter this strip listens to is no longer where
 *  a player types. hd-omni.js now asks match() and paints the same caps
 *  (capsHtml) above its results, and press() fires them. One matcher, one
 *  key table, two surfaces.
 *
 *  Esc and Tab are the two keys the Numpad tab can NOT offer (the deck owns
 *  them while it is open). A cap here always fires through close:true —
 *  the deck is shut and the game unpaused 200 ms before the key goes out —
 *  so they are safe on the strip and in the finder, and only there:
 *  match(q, { extra: true }). The Hotkey Pad picker keeps the plain table.
 * ====================================================================== */

window.KeyStrip = (function () {
  const MOD_ROW = [
    { dik: 42, label: 'Shift' },
    { dik: 29, label: 'Ctrl' },
    { dik: 56, label: 'Alt' },
  ];

  /* Keys the strip and the finder may press that the Numpad tab may not (see
     the header). `strict`: matched by their own words only, whole or from the
     start, so "escort" or "table" do not grow an Esc or a Tab cap. */
  const EXTRA_KEYS = [
    { l: 'Esc', c: 0x01, name: 'Escape', strict: true },
    { l: 'Tab', c: 0x0F, name: 'Tab', strict: true },
  ];

  /* Caps shown at once. Past this the strip would be a keyboard, and there is
     already a keyboard — the ⌗ button goes to it. 24 is the largest cluster,
     the F1-F24 function row (2026-10-14, F13-F24 added): "fkeys" hands you all
     of it, and "numpad" no longer loses its last three keys to a cap of 14. */
  const MAX_CAPS = 24;

  /* scancode -> the words somebody types looking for that key. The key's own
     name and cap label are added automatically, so this holds only what they
     do NOT already say. Normalised the same way the query is (lowercase,
     punctuation and spaces dropped), so "page up" here == "PageUp" typed. */
  const ALIAS = {
    0xD2: ['ins', 'insert'],
    0xD3: ['del', 'delete', 'remove'],
    0xC7: ['home'],
    0xCF: ['end'],
    0xC9: ['pageup', 'pgup', 'prior', 'page'],
    0xD1: ['pagedown', 'pgdn', 'pgdown', 'next', 'page'],
    0xC8: ['uparrow', 'arrowup'],
    0xD0: ['downarrow', 'arrowdown'],
    0xCB: ['leftarrow', 'arrowleft'],
    0xCD: ['rightarrow', 'arrowright'],
    0x0E: ['backspace', 'bksp', 'back'],
    0x1C: ['return'],
    0x39: ['spacebar'],
    0x3A: ['caps', 'capslock'],
    0x46: ['scrolllock', 'scrlk', 'scroll'],
    0xC5: ['pause', 'break'],
    0xB7: ['printscreen', 'prtsc', 'prtscr', 'sysrq', 'screenshot'],
    0x2B: ['backslash', 'pipe'],
    0x29: ['tilde', 'grave', 'backtick', 'console'],
    0x45: ['numlock'],
    0x01: ['esc', 'escape'],
  };

  /* A word for a whole cluster. Typing "numpad" should hand you a numpad, not
     nothing — the keys come back in NUMPAD_LAYOUT order, which is already the
     order they sit in on a real board. `test` runs against the key's own name,
     so a group needs no second list to maintain. */
  const GROUPS = [
    { terms: ['numpad', 'keypad', 'numeric', 'numberpad'], test: (n) => n.indexOf('Num') === 0 },
    { terms: ['arrows', 'arrowkeys', 'cursor', 'direction'], test: (n) => ['Up', 'Down', 'Left', 'Right'].indexOf(n) !== -1 },
    { terms: ['navigation', 'navcluster', 'editing'],
      test: (n) => ['Insert', 'Delete', 'Home', 'End', 'PgUp', 'PgDn'].indexOf(n) !== -1 },
    { terms: ['functionkeys', 'fkeys', 'functionrow'], test: (n) => /^F\d+$/.test(n) },
    /* F13-F24: the keys the Scimitar's G-buttons send and no keyboard has. */
    { terms: ['extended', 'extendedfkeys', 'extendedkeys', 'highfkeys', 'gkeys', 'scimitar'],
      test: (n) => /^F(1[3-9]|2[0-4])$/.test(n) },
  ];

  let host = null;
  let mods = [];        // active modifier DIKs — one-shot, cleared on fire
  let caps = [];        // what is on screen right now, in order
  let sig = '';         // last painted signature, so typing does not re-paint
  let openKey = 0;      // the deck's open key, as renderList last told us

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function keys(opts) {
    const k = window.hdKeypadKeys;
    const base = Array.isArray(k) ? k : [];
    return opts && opts.extra ? base.concat(EXTRA_KEYS) : base;
  }

  /* Every word this key answers to. */
  function terms(k) {
    const t = [norm(k.name), norm(k.l)];
    (ALIAS[k.c] || []).forEach((a) => t.push(norm(a)));
    return t.filter(Boolean);
  }

  /* Lower is better; Infinity means "not this key". A 2-character query only
     matches from the START of a word — otherwise "de" drags in every key with
     a d in it and the strip becomes noise instead of an answer. */
  function score(k, q) {
    let best = Infinity;
    terms(k).forEach((t) => {
      let s = Infinity;
      if (t === q) s = 0;
      else if (t.indexOf(q) === 0) s = 1;
      else if (k.strict) s = Infinity;
      else if (q.indexOf(t) === 0 && t.length >= 3) s = 1.5;   // "home key", "page up key"
      else if (q.length >= 3 && t.indexOf(q) !== -1) s = 2;
      if (s < best) best = s;
    });
    return best;
  }

  function groupHits(q, opts) {
    const hit = [];
    GROUPS.forEach((g) => {
      const on = g.terms.some((t) => t === q || (q.length >= 3 && t.indexOf(q) === 0));
      if (on) keys(opts).forEach((k) => { if (g.test(k.name || k.l) && hit.indexOf(k) === -1) hit.push(k); });
    });
    return hit;
  }

  /* The caps a query earns, best first. Exported for the harness, the Hotkey
     Pad picker and the Omni. `opts.extra` adds Esc and Tab (see the header). */
  function match(query, opts) {
    const q = norm(query);
    if (q.length < 2) return [];
    const scored = [];
    keys(opts).forEach((k, i) => {
      const s = score(k, q);
      if (s !== Infinity) scored.push({ k: k, s: s, i: i });
    });
    scored.sort((a, b) => (a.s - b.s) || (a.i - b.i));
    const out = scored.map((x) => x.k);
    /* Group hits come after the direct ones: "num" is first of all the Num
       keys' own name, and only then the word for the whole cluster. */
    groupHits(q, opts).forEach((k) => { if (out.indexOf(k) === -1) out.push(k); });
    return out.slice(0, MAX_CAPS);
  }

  function capHtml(k, openCode) {
    const deck = openCode && k.c === openCode;
    const label = k.name || k.l;
    const title = deck
      ? label + ' — this is the deck’s own open key, so firing it closes the deck'
      : 'Press ' + label + ' — the deck closes and the game gets the real key';
    return '<button class="ks-cap' + (deck ? ' ks-deckkey' : '') + '" data-c="' + k.c +
      '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
      '<span class="ks-cap-l">' + esc(label) + '</span>' +
      (deck ? '<span class="ks-cap-tag">deck</span>' : '') +
      '</button>';
  }

  function paint(openCode) {
    const modHtml = MOD_ROW.map((m) =>
      '<button class="ks-mod' + (mods.indexOf(m.dik) !== -1 ? ' on' : '') + '" data-mod="' + m.dik +
      '" title="Hold ' + m.label + ' with the next key">' + m.label + '</button>').join('');
    host.innerHTML =
      '<div class="ks-head">' +
        '<span class="ks-title">Keys</span>' +
        '<span class="ks-sub">Click one and the game gets a real key press — for the keys this keyboard hasn’t got.</span>' +
        '<span class="ks-mods">' + modHtml +
          '<button class="ks-full" data-full="1" title="The whole on-screen keyboard — Numpad tab">⌗ Full keyboard</button>' +
        '</span>' +
      '</div>' +
      '<div class="ks-caps">' + caps.map((k) => capHtml(k, openCode)).join('') + '</div>';
  }

  function fire(k, btn) {
    if (!k) return;
    if (btn) {
      btn.classList.add('ks-flash');
      setTimeout(() => btn.classList.remove('ks-flash'), 280);
    }
    if (typeof window.hdFireRawKey === 'function') {
      window.hdFireRawKey({ code: k.c, mods: mods.slice(), label: k.name || k.l, close: true });
    } else {
      console.log('[keystrip] no hdFireRawKey', k);
    }
    /* One-shot modifiers, like the Numpad tab's default: a chord you meant to
       send once must not ride along on the next cap you click. */
    if (mods.length) {
      mods = [];
      if (host) host.querySelectorAll('.ks-mod').forEach((m) => m.classList.remove('on'));
    }
  }

  function onClick(e) {
    const modBtn = e.target.closest('.ks-mod');
    if (modBtn) {
      const dik = Number(modBtn.getAttribute('data-mod'));
      const i = mods.indexOf(dik);
      if (i === -1) mods.push(dik); else mods.splice(i, 1);
      modBtn.classList.toggle('on', i === -1);
      return;
    }
    if (e.target.closest('.ks-full')) {
      if (typeof window.hdShowTab === 'function') window.hdShowTab('numpad');
      return;
    }
    const cap = e.target.closest('.ks-cap');
    if (!cap) return;
    const code = Number(cap.getAttribute('data-c'));
    fire(caps.filter((k) => k.c === code)[0], cap);
  }

  /* Called from renderList() on every keystroke. `openCode` is the deck's own
     open key (marked, never hidden — firing it really does close the deck). */
  function sync(query, openCode) {
    openKey = openCode || 0;
    host = host || document.getElementById('ks-strip');
    if (!host) return;
    if (!host.__ksWired) { host.__ksWired = true; host.addEventListener('click', onClick); }
    caps = match(query, { extra: true });
    host.classList.toggle('hidden', caps.length === 0);
    /* Empty means EMPTY: a hidden strip still holding the last query's caps is
       a strip that can be clicked by a stray Enter and fire a key nobody asked
       for. Tear it down. */
    if (!caps.length) { if (sig) host.innerHTML = ''; sig = ''; return; }
    const next = caps.map((k) => k.c).join(',') + '|' + (openCode || 0);
    if (next === sig) return;   // same caps, different query text — leave the DOM alone
    sig = next;
    paint(openCode || 0);
  }

  /* The finder's door (hd-omni.js): the same caps, and a press by scancode.
     No modifiers here — the finder is for "press End", and a chord has the
     strip and the Numpad tab. */
  function capsHtml(list) { return (list || []).map((k) => capHtml(k, openKey)).join(''); }
  function press(code) {
    const k = keys({ extra: true }).filter((x) => x && x.c === Number(code))[0];
    if (!k || typeof window.hdFireRawKey !== 'function') return false;
    window.hdFireRawKey({ code: k.c, mods: [], label: k.name || k.l, close: true });
    return true;
  }

  return {
    sync: sync,
    capsHtml: capsHtml,
    press: press,
    match: match,             // harness
    top: function () { return caps[0] || null; },
    fireTop: function () {
      if (!caps.length) return false;
      fire(caps[0], host ? host.querySelector('.ks-cap') : null);
      return true;
    },
    /* harness hooks */
    _mods: function () { return mods.slice(); },
    _reset: function () { host = null; mods = []; caps = []; sig = ''; },
  };
})();
