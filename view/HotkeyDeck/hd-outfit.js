'use strict';

/* ====================================================================== *
 *  Outfit dock — the F7 card's ⛨ button, split into three popouts.
 *
 *  Rober's ask (2026-08-11): "the outfit button is decent when you hit f7
 *  on an npc but i think it should be [three] things. A floater popout one
 *  (to copy outfit to a new wardrobe — move that button to this new dock
 *  and remove it otherwise). Then 2/3 is a quick apply basically a modal
 *  popout (spacious, a typing box that i can search outfits and quickly
 *  apply — it forces the equip then and there) and then 3 a full settings
 *  modal popout — polished. basically the dressed by stuff that the
 *  current one does but in a nicer popout menu."
 *
 *  So ⛨ no longer expands three cramped chip rows INSIDE the card. It
 *  opens a DOCK — a small anchored floater naming the three things you do
 *  with someone's clothes — and each of those is its own surface:
 *
 *    ⚡ Quick apply  → MODAL. Big search box, big rows, Enter wears the top
 *                     hit. Destination chips pick who does the dressing
 *                     (◇ Wardrobe/SOES, or one of her three NFF sets), so
 *                     the one box serves both backends.
 *    ⧉ Copy outfit  → FLOATER (not a modal, deliberately): you are reading
 *                     what she is wearing and ticking pieces, and the card
 *                     underneath is worth still seeing. This is the button
 *                     that used to sit loose on the action row.
 *    ⚙ Settings     → MODAL. Who dresses her, wear a set, fill a chest,
 *                     her satchel, SOES tracking, reset — the old reveal,
 *                     spacious and sectioned.
 *
 *  OWNERSHIP, unchanged from the reveal this replaces: this file owns the
 *  buttons; wardrobe-pane.js and wardrobe-nff.js own the verbs and the
 *  data. Every op here is one of THEIR exports (quickWear / quickOutfits /
 *  quickSetManaged / quickTrack / quickDress / quickFocus, wearSet /
 *  openChest / openSatchel / copyOutfit / setClaim), never a second copy.
 *  The few things only the Followers pane can do — read her worn set,
 *  open an NFF chest through its palette-closing bridge, print a verdict
 *  on the card — arrive as callbacks on the ctx handed to open().
 *
 *  Shape: a sibling of the Door / SPID modals — a root INSIDE #panel, so
 *  it inherits --ui-scale and clips to the deck window. Own sheet
 *  hd-outfit.css linked from index.html; NEVER merged into app.css (the
 *  sync_view_frags truncation trap).
 *
 *  Ultralight rules honoured: no prompt()/confirm() (inline inputs + armed
 *  two-click), title= tooltips drawn by app.js's #hd-tip layer, hdCapture
 *  claimed while open so typing a name never quick-fires a hotkey.
 * ====================================================================== */

(function () {

  /* NFF's own numbering — its dialogue fragments pass exactly these, so this
     is the mod's public API and not our invention. Type 3 (kBase, "her own
     clothes") is a WEAR target, never a set, so it is not in this list. */
  var SETS = [
    { t: 0, name: 'Adventure', hint: 'worn in the wild and in dungeons' },
    { t: 1, name: 'Town', hint: 'worn in towns, cities and inns' },
    { t: 2, name: 'Home', hint: 'worn inside a house you own' },
  ];
  var BASE_TYPE = 3;

  var S = {
    view: '',          // '' | 'dock' | 'apply' | 'copy' | 'settings'
    ctx: null,         // what the Followers card handed us (see open())
    at: { x: 0, y: 0 },// where the dock / floater sits, panel-relative
    filter: '',        // Quick apply search
    sel: 0,            // keyboard cursor into the filtered outfit list
    dest: null,        // 'wardrobe' | 0 | 1 | 2 — null means "decide from her mode"
    keep: null,        // Copy outfit tick map, by itemKey() — never by index
    keepFor: '',       // whose ticks those are
    copyName: '',
    msg: null,         // { ok, text } — the last verdict, shown in place
    armReset: false,   // the two-click "Stop using NFF"
    hersOnly: false,   // Quick apply: show only what is tagged for this person
    sig: '',           // last painted data signature — see maybeRender()
    animFor: '',       // which (view × subject) the entrance animation belongs to
  };

  var root = null;     // the layer inside #panel
  var pop = null;      // the floater element, when one is up

  /* ------------------------------------------------------------ plumbing -- */

  function toGameSafe(fn, arg) {
    if (typeof window.toGame === 'function') window.toGame(fn, arg);
  }

  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'style') n.style.cssText = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      if (Array.isArray(kid)) { kid.forEach(function (c) { if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); }); continue; }
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function ctx() { return S.ctx || {}; }
  function who() { return String(ctx().who || 'her'); }

  /* A worn piece's durable identity — what the Copy floater's tick map is keyed
     by. plugin+formId is what createOutfitFromItems resolves against anyway; the
     name is the fallback for a row that arrived without either. */
  function itemKey(it) {
    if (!it) return '';
    var p = String(it.plugin || ''), f = String(it.formId || '');
    return (p || f) ? (p + '|' + f).toLowerCase() : ('n|' + String(it.name || ''));
  }

  /* The two Wardrobe modules, or null. Absent module = the surfaces that need
     it are simply not drawn — never a row of dead controls. */
  function wardrobeApi() {
    var w = window.WardrobePane;
    return (w && typeof w.quickAbout === 'function') ? w : null;
  }
  function nffApi() {
    var n = window.WardrobeNff;
    return (n && typeof n.keyForActor === 'function') ? n : null;
  }

  /* One read of both modules, LIVE, per render — the same shape (and the same
     claim-beats-assignment rule) the card's clothesAbout() produced, so nothing
     downstream had to change when this moved out of followers-pane.js. */
  function about() {
    var hex = String(ctx().hex || '');
    if (!hex) return null;
    var wp = wardrobeApi(), nfp = nffApi();
    var w = wp ? wp.quickAbout(hex) : null;
    var key = nfp ? nfp.keyForActor(hex) : '';
    var nf = (key && nfp.infoFor) ? nfp.infoFor(key) : null;
    if (!w && !nf) return null;
    return {
      hex: hex, w: w, nf: nf, key: key || (w ? w.key : ''),
      mode: w ? w.mode : ((nf && nf.claimed) ? 'nff' : 'off'),
    };
  }

  /* A verdict lands HERE, where you are still looking, and is echoed onto the
     card so it survives the popout closing. Both modules answer {ok,msg}
     rather than toasting precisely so this is possible. */
  function say(r) {
    if (!r) return;
    S.msg = { ok: r.ok !== false, text: r.msg || (r.ok !== false ? 'Done' : 'Refused') };
    if (typeof ctx().say === 'function') ctx().say(r);
    render();
  }
  function sayText(ok, text) { say({ ok: ok, msg: text }); }

  /* --------------------------------------------------------------- dom --- */

  function ensureRoot() {
    if (root && root.isConnected) return root;
    var panel = document.getElementById('panel') || document.body;
    root = h('div', { id: 'hdo-layer', class: 'hidden' });
    /* Backdrop click closes — but only when the backdrop IS the layer (a modal
       view). In floater views the layer does not take pointer events at all. */
    root.addEventListener('mousedown', function (e) {
      if (e.button === 0 && e.target === root && isModalView()) close();
    });
    panel.appendChild(root);
    return root;
  }

  function isModalView() { return S.view === 'apply' || S.view === 'settings'; }

  /* Anchor a floater under the button that opened it. #panel is
     transform: scale(var(--ui-scale)), so the viewport delta between the
     anchor and the layer has to be divided by that scale to become a
     panel-relative offset — measuring the layer's own rect against its layout
     width is how the factor is recovered without reading the variable. */
  function anchorTo(anchorEl) {
    var r = ensureRoot();
    var rr = r.getBoundingClientRect();
    var sx = (r.offsetWidth > 0 && rr.width > 0) ? (rr.width / r.offsetWidth) : 1;
    if (!anchorEl || !anchorEl.getBoundingClientRect) {
      S.at = { x: 40, y: 90 };
      return;
    }
    var ar = anchorEl.getBoundingClientRect();
    S.at = {
      x: Math.round((ar.left - rr.left) / sx),
      y: Math.round((ar.bottom - rr.top) / sx) + 8,
    };
  }

  /* Keep a floater inside the deck window. offsetWidth/Height, not the
     transformed rect — the open animation includes a scale, and measuring the
     transformed box one frame in places it several pixels wrong. */
  function clampPop() {
    if (!pop || !root) return;
    var vw = root.offsetWidth, vh = root.offsetHeight;
    var w = pop.offsetWidth, ht = pop.offsetHeight;
    var x = S.at.x, y = S.at.y;
    if (x + w > vw - 10) x = vw - w - 10;
    if (y + ht > vh - 10) y = vh - ht - 10;
    pop.style.left = Math.max(10, x) + 'px';
    pop.style.top = Math.max(10, y) + 'px';
  }

  /* Drag a floater by its header. Same two rules as the card's ctx menus: a
     press that MOVED is a drag (its click is swallowed), and a drag starting
     on the header must never read as an outside click. */
  function makeDraggable(head) {
    if (!head) return;
    head.classList.add('hdo-drag');
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !pop) return;
      e.preventDefault();
      e.stopPropagation();
      var sx = e.clientX, sy = e.clientY;
      var ox = parseFloat(pop.style.left) || 0, oy = parseFloat(pop.style.top) || 0;
      var rr = root.getBoundingClientRect();
      var k = (root.offsetWidth > 0 && rr.width > 0) ? (rr.width / root.offsetWidth) : 1;
      var moved = false;
      function mv(ev) {
        var dx = (ev.clientX - sx) / k, dy = (ev.clientY - sy) / k;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        S.at = { x: Math.round(ox + dx), y: Math.round(oy + dy) };
        clampPop();
      }
      function up() {
        document.removeEventListener('mousemove', mv, true);
        document.removeEventListener('mouseup', up, true);
        if (moved) document.addEventListener('click', function once(ev) {
          ev.stopPropagation(); document.removeEventListener('click', once, true);
        }, true);
      }
      document.addEventListener('mousemove', mv, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  /* Click anywhere outside a FLOATER closes it. Modals have a backdrop and
     handle their own outside click, so this listener is only armed for the
     dock and the copy floater. */
  function outside(e) {
    if (!pop || !isFloaterView()) return;
    if (pop.contains(e.target)) return;
    close();
  }
  function isFloaterView() { return S.view === 'dock' || S.view === 'copy'; }

  /* -------------------------------------------------------------- bits --- */

  /* The header medallion. With a portrait it is HER FACE with the surface's
     glyph as a corner badge — the dock is about a person, and a card that shows
     one reads as hers rather than as a form id's. Without one it is the plain
     gold plate, unchanged. The image is removed on error rather than left as a
     broken box, so a portrait file that has been renamed degrades to the plate. */
  function facePlate(glyph) {
    var url = String(ctx().portrait || '');
    if (!url) return h('span', { class: 'hdo-plate', 'aria-hidden': 'true' }, glyph);
    var box = h('span', { class: 'hdo-plate is-face', 'aria-hidden': 'true' });
    var img = h('img', { class: 'hdo-face-img', src: url, alt: '' });
    img.addEventListener('error', function () {
      box.classList.remove('is-face');
      if (img.parentNode) img.parentNode.removeChild(img);
      box.append(document.createTextNode(glyph));
    });
    box.append(img, h('span', { class: 'hdo-face-badge' }, glyph));
    return box;
  }

  function modeChip(a) {
    if (!a) return null;
    var label = 'Nobody dresses her';
    var cls = 'off';
    if (a.mode === 'wardrobe') {
      cls = 'wd';
      label = '◇ Wardrobe' + (a.w && a.w.label ? ' · ' + a.w.label : '');
    } else if (a.mode === 'nff') {
      cls = 'nff';
      label = '⛨ NFF' + (a.nf && a.nf.wornLabel ? ' · ' + a.nf.wornLabel : '');
    }
    return h('span', {
      class: 'hdo-mode ' + cls,
      title: 'Exactly one system dresses her at a time. Change it in ⚙ Settings.',
    }, label);
  }

  /* `slim` = one ellipsized line with the full sentence as its tooltip. Quick
     apply asks for it: on a short deck window a three-line banner ate the
     result list, and the list is what that modal is FOR. Nothing is hidden —
     the full wording is a hover away, and Settings (where you act on it) always
     shows it in full. */
  function warnings(a, slim) {
    if (!a) return null;
    var cls = 'hdo-warn' + (slim ? ' is-slim' : '');
    var out = [];
    if (a.w && a.w.twoSystems) {
      var t1 = '⚠ Two systems claim ' + who() + ' — the Wardrobe and NFF. Pick one in '
        + '⚙ Settings, or they will keep undressing each other.';
      out.push(h('div', { class: cls, title: slim ? t1 : null }, t1));
    }
    if (a.w && a.w.conflict) {
      var t2 = '⚠ Tailor also dresses ' + who() + '. Whichever ran last wins, which is why '
        + 'her clothes keep changing back.';
      out.push(h('div', { class: cls, title: slim ? t2 : null }, t2));
    }
    return out.length ? out : null;
  }

  function statusLine() {
    if (!S.msg) return null;
    return h('div', { class: 'hdo-msg ' + (S.msg.ok ? 'ok' : 'bad') }, S.msg.text);
  }

  /* The header, as a WRAPPER rather than a single bar. The mode chip
     ("◇ Wardrobe · Court silks") gets its own full-width line underneath: in
     a 420 px floater, title + chip + Back + ✕ on one row squeezed the name to
     "Lydia’s …" and the chip is the sentence you most want to read. Its own
     line also lets it say more without ever colliding. */
  function head(title, glyph, opts) {
    var o = opts || {};
    var wrap = h('div', { class: 'hdo-headwrap' });
    var bar = h('div', { class: 'hdo-head' }, facePlate(glyph),
      h('span', { class: 'hdo-title', title: title }, title));
    if (o.back) bar.append(h('button', {
      class: 'hdo-back', type: 'button', title: 'Back to the outfit dock (Esc)',
      onClick: function (e) { e.stopPropagation(); toDock(); },
    }, '‹ Back'));
    bar.append(h('button', {
      class: 'hdo-close', type: 'button', title: 'Close (Esc)',
      onClick: function (e) { e.stopPropagation(); close(); },
    }, '✕'));
    wrap.append(bar);
    if (o.chip) wrap.append(h('div', { class: 'hdo-subhead' },
      h('span', { class: 'hdo-subhead-lbl' }, 'Dressed by'), o.chip));
    return wrap;
  }

  /* ================================================================ dock == */

  function tile(glyph, title, sub, go, opts) {
    var o = opts || {};
    return h('button', {
      class: 'hdo-tile' + (o.disabled ? ' is-off' : '') + (o.tone ? ' t-' + o.tone : ''),
      type: 'button',
      disabled: o.disabled ? true : null,
      title: o.title || (o.disabled ? (o.why || '') : (title + ' — ' + sub)),
      onClick: function (e) { e.stopPropagation(); if (!o.disabled) go(); },
    },
      h('span', { class: 'hdo-tile-ic', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'hdo-tile-txt' },
        h('span', { class: 'hdo-tile-t' }, title),
        h('span', { class: 'hdo-tile-s' }, o.disabled ? (o.why || sub) : sub)),
      h('span', { class: 'hdo-tile-go', 'aria-hidden': 'true' }, o.disabled ? '' : '›'));
  }

  function renderDock() {
    var a = about();
    pop = h('div', { class: 'hdo-pop hdo-dock', role: 'dialog', 'aria-label': who() + '’s clothes' });
    root.append(pop);

    pop.append(head(who() + '’s clothes', '⛨', { chip: modeChip(a) }));

    var body = h('div', { class: 'hdo-pop-body' });
    pop.append(body);

    var w = warnings(a);
    if (w) w.forEach(function (n) { body.append(n); });

    var haveWardrobe = !!(a && a.w);
    var haveNff = !!(a && a.nf);

    body.append(tile('⚡', 'Quick apply', 'Search your outfits — Enter wears the top hit',
      function () { toView('apply'); },
      (haveWardrobe || haveNff) ? { tone: 'gold' } : {
        tone: 'gold', disabled: true,
        why: 'Neither the Wardrobe nor NFF has heard of ' + who() + ' yet',
      }));

    body.append(tile('⧉', 'Copy outfit', 'Save what ' + who() + ' is wearing as a new Wardrobe outfit',
      function () { toView('copy'); },
      ctx().dead ? { tone: 'violet', disabled: true, why: who() + ' is dead' }
                 : { tone: 'violet' }));

    body.append(tile('⚙', 'Outfit settings', 'Who dresses her, her three sets, chests and SOES',
      function () { toView('settings'); },
      a ? { tone: 'steel' } : {
        tone: 'steel', disabled: true,
        why: 'No outfit system has heard of ' + who() + ' yet',
      }));

    var st = statusLine();
    if (st) body.append(st);

    /* An honest empty state rather than three dead tiles: on a rig with
       neither backend loaded there is genuinely nothing here to do. */
    if (!a)
      body.append(h('div', { class: 'hdo-note' },
        'Nothing has heard of ' + who() + ' yet. Recruit her (NFF) or open the '
        + 'Wardrobe tab once, then try again — Copy outfit works either way.'));

    stagger(pop, '.hdo-tile');
    makeDraggable(pop.querySelector('.hdo-head'));
    clampPop();
  }

  /* Entrance stagger. Every row lands the same way, ~26 ms apart, so the surface
     ASSEMBLES instead of appearing — and it is capped at eight because past that
     the last rows are still arriving when you have already started typing. */
  function stagger(host, sel) {
    if (!host || !S.fresh) return;
    var rows = host.querySelectorAll(sel);
    for (var i = 0; i < rows.length && i < 8; i++)
      rows[i].style.animationDelay = (i * 26) + 'ms';
  }

  /* ========================================================= quick apply == */

  /* Where an outfit lands. ◇ Wardrobe is SOES: assign + dress, one op. An NFF
     set pours the same outfit's pieces into that set and then wears it — which
     is what "apply" means on a follower NFF dresses, and it is the mod's own
     two-step, not a shortcut around it. */
  function destinations(a) {
    var out = [];
    if (a && a.w) out.push({ id: 'wardrobe', label: '◇ Wardrobe',
      hint: 'Assign it to her and dress her now, through SOES-NG'
        + ((a.mode === 'nff') ? '. She is on NFF — this takes her back first.' : '') });
    if (a && a.nf && a.nf.slot >= 0) SETS.forEach(function (s) {
      var lbl = (a.nf.labels && a.nf.labels[s.t]) || s.name;
      out.push({ id: s.t, label: '⛨ ' + lbl,
        hint: 'Pour it into her ' + s.name + ' set (' + s.hint + ') and put it on' });
    });
    /* NO SYSTEM AT ALL (Rober, 2026-08-11: "what about option to just drop it
       into inventory and force equip?"). Both destinations above enrol her in
       something that then owns her clothes; sometimes you just want her wearing
       the thing. Offered whenever the Wardrobe can name her — the pieces come
       from SOES's catalogue either way — and refused in words while SOES
       TRACKS her, because it would put its own outfit back within seconds. */
    if (a && a.w) out.push({ id: 'raw', label: '⇩ Straight on',
      hint: a.w.tracked
        ? 'Unavailable while SOES-NG manages her — it would put its own outfit '
          + 'back within seconds. Switch her to ○ Nobody in ⚙ Settings first.'
        : 'Drop the pieces into her inventory and force-equip them. Nothing '
          + 'manages her afterwards — no assignment, no NFF set.',
      off: !!a.w.tracked });
    return out;
  }

  function currentDest(a) {
    var list = destinations(a).filter(function (d) { return !d.off; });
    if (!list.length) return null;
    /* An explicit pick wins, as long as it is still offered. */
    for (var i = 0; i < list.length; i++) if (list[i].id === S.dest) return list[i];
    /* Otherwise: whoever dresses her now. On NFF, the set she is WEARING, so
       "quick apply" replaces what is on her rather than a set she is not in. */
    if (a && a.mode === 'nff') {
      var worn = (a.nf && a.nf.worn >= 0 && a.nf.worn < SETS.length) ? a.nf.worn : 1;
      for (var k = 0; k < list.length; k++) if (list[k].id === worn) return list[k];
    }
    return list[0];
  }

  function outfits() {
    var wp = window.WardrobePane;
    if (wp && typeof wp.quickOutfits === 'function') return wp.quickOutfits() || [];
    /* Older wardrobe-pane: names only, so the rows are plainer but present. */
    var st = wp && wp._state;
    var list = (st && st.soes && Array.isArray(st.soes.outfits)) ? st.soes.outfits : [];
    return list.map(function (o) {
      return { name: (o && typeof o === 'object') ? o.name : o, pieces: -1,
               note: '', image: '', fav: false, pending: false,
               categories: [], tags: [], forNpcs: [] };
    }).filter(function (o) { return o.name; });
  }

  /* Everything a row DISPLAYS is searchable, pills included — an outfit you can
     see is tagged "Lydia" but cannot find by typing "lydia" is a worse list than
     one with no tags at all. */
  function matches(o, q) {
    if (!q) return true;
    if (String(o.name).toLowerCase().indexOf(q) !== -1) return true;
    if (String(o.note || '').toLowerCase().indexOf(q) !== -1) return true;
    var hit = function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; };
    if ((o.categories || []).some(hit)) return true;
    if ((o.tags || []).some(hit)) return true;
    return (o.forNpcs || []).some(function (t) { return hit(t.name); });
  }

  /* Is this outfit tagged for the person the dock is about? */
  function isHers(o, a) {
    var key = String((a && a.key) || (a && a.w && a.w.key) || '').toLowerCase();
    if (!key) return false;
    return (o.forNpcs || []).some(function (t) { return String(t.key || '').toLowerCase() === key; });
  }
  /* The owner pill she is named in, so the row can say whether it is the
     outfit's own tag or one inherited from a wardrobe. */
  function hersTag(o, a) {
    var key = String((a && a.key) || (a && a.w && a.w.key) || '').toLowerCase();
    if (!key) return null;
    for (var i = 0; i < (o.forNpcs || []).length; i++)
      if (String(o.forNpcs[i].key || '').toLowerCase() === key) return o.forNpcs[i];
    return null;
  }

  /* One pill. `kind` only picks the hue — the shapes are identical on purpose,
     because they are all "a word attached to this outfit". */
  function pill(text, kind, title) {
    return h('span', { class: 'hdo-pill' + (kind ? ' k-' + kind : ''), title: title || null }, text);
  }

  function applyOutfit(a, dest, name) {
    if (!dest) { sayText(false, 'Nowhere to put it — ' + who() + ' is on no outfit system'); return; }
    if (dest.id === 'wardrobe') {
      var wp = wardrobeApi();
      if (!wp || typeof wp.quickWear !== 'function') {
        sayText(false, 'This deck’s Wardrobe module is too old to apply an outfit from here');
        return;
      }
      say(wp.quickWear(a.key || (a.w && a.w.key), name));
      return;
    }
    if (dest.id === 'raw') {
      var wr = wardrobeApi();
      if (!wr || typeof wr.quickGiveWear !== 'function') {
        sayText(false, 'This deck’s Wardrobe module is too old to do that from here');
        return;
      }
      /* The real verdict (how many pieces went on, how many no longer resolve)
         only C++ knows, and it arrives later on wdResult — which the Wardrobe
         pane routes back to HDOutfit.report(). This is the optimistic half. */
      say(wr.quickGiveWear(a.key || (a.w && a.w.key), name));
      return;
    }
    var nfp = nffApi();
    if (!nfp || typeof nfp.copyOutfit !== 'function') {
      sayText(false, 'The NFF module isn’t loaded');
      return;
    }
    var t = Number(dest.id);
    if (!nfp.copyOutfit(a.key, t, name)) {
      /* copyOutfit's own guard already said why (it toasts the one-backend
         refusal); repeat it here so the answer is on the surface you are
         looking at, which is the whole point of this popout. */
      sayText(false, 'NFF refused — the Wardrobe dresses her. Hand her over in ⚙ Settings first.');
      return;
    }
    sayText(true, 'Filling her ' + SETS[t].name + ' set with “' + name + '”, then putting it on…');
    /* The wear has to follow the copy: nfCopy moves items, it does not dress
       her, and the pieces have to be in the set before the wear op can find
       them. NFF answers both through Papyrus, hence the gap. */
    setTimeout(function () {
      var n2 = nffApi();
      if (!n2) return;
      var r = n2.wearSet(a.key, t);
      if (r && !r.ok) say(r);
    }, 1100);
  }

  function renderApply() {
    var a = about();
    var box = h('div', { class: 'hdo-box hdo-apply', role: 'dialog', 'aria-label': 'Quick apply' });
    root.append(box);

    /* No mode chip in this header: the "Apply to" row below is the same fact,
       said as the control it belongs to — and on a short deck window every
       fixed row above the results is a row of results you cannot see. */
    box.append(head('Dress ' + who(), '⚡', { back: true }));

    var dest = currentDest(a);
    var body = h('div', { class: 'hdo-body' });
    box.append(body);

    var w = warnings(a, true);
    if (w) w.forEach(function (n) { body.append(n); });

    /* WHERE IT LANDS. Always visible, never a hidden default — applying an
       outfit to the wrong NFF set puts her clothes on somewhere she is not. */
    var dests = destinations(a);
    if (dests.length > 1) {
      var row = h('div', { class: 'hdo-dest' },
        h('span', { class: 'hdo-dest-lbl', title:
          'Who does the dressing. The Wardrobe assigns and equips through SOES-NG; '
          + 'an NFF set is one of her three outfits, filled and then worn.' }, 'Apply to'));
      dests.forEach(function (d) {
        row.append(h('button', {
          class: 'hdo-chip' + (dest && d.id === dest.id ? ' on' : ''),
          type: 'button', 'aria-pressed': String(!!(dest && d.id === dest.id)),
          disabled: d.off ? true : null,
          title: d.hint,
          onClick: function (e) { e.stopPropagation(); S.dest = d.id; render(); },
        }, d.label));
      });
      body.append(row);
    } else if (dests.length === 1) {
      body.append(h('div', { class: 'hdo-dest' },
        h('span', { class: 'hdo-dest-lbl' }, 'Apply to'),
        h('span', { class: 'hdo-chip on', title: dests[0].hint }, dests[0].label)));
    }

    /* THE TYPING BOX. Autofocused, big, and it owns the arrow keys so the
       list can be driven without ever leaving it. */
    var list = h('div', { class: 'hdo-list' });
    var input = h('input', {
      class: 'hdo-search', type: 'text', spellcheck: 'false', autocomplete: 'off',
      placeholder: 'Type an outfit name…',
      value: S.filter,
      title: 'Filters by name, note and category. ↑ ↓ move · Enter applies · Esc goes back',
    });
    input.addEventListener('input', function () { S.filter = input.value; S.sel = 0; paint(); });
    input.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowDown') { e.preventDefault(); step(1); return; }
      if (k === 'ArrowUp') { e.preventDefault(); step(-1); return; }
      if (k === 'Enter') { e.preventDefault(); fireSel(); return; }
      if (k === 'Escape') { e.stopPropagation(); toDock(); }
    });
    /* ◈ HERS — the filter the tags exist for. Only drawn when she HAS any, so
       an empty toggle never sits there promising something; the count is on the
       chip because "is it worth pressing" is the question it answers. */
    var mineCount = outfits().filter(function (o) { return isHers(o, a); }).length;
    var searchRow = h('div', { class: 'hdo-search-row' }, input);
    if (mineCount) {
      searchRow.append(h('button', {
        class: 'hdo-chip hdo-hers' + (S.hersOnly ? ' on' : ''), type: 'button',
        'aria-pressed': String(!!S.hersOnly),
        title: S.hersOnly
          ? 'Showing only what is tagged for ' + who() + ' — click for everything'
          : 'Show only the ' + mineCount + ' outfit' + (mineCount === 1 ? '' : 's')
            + ' tagged for ' + who(),
        onClick: function (e) { e.stopPropagation(); S.hersOnly = !S.hersOnly; S.sel = 0; render(); },
      }, '❤ Hers ' + mineCount));
    }
    body.append(searchRow);
    body.append(list);

    var shown = [];
    function step(d) {
      if (!shown.length) return;
      S.sel = Math.max(0, Math.min(shown.length - 1, S.sel + d));
      paint();
      var el = list.querySelector('.hdo-row.sel');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    function fireSel() {
      if (!shown.length) return;
      applyOutfit(a, currentDest(about()), shown[Math.max(0, Math.min(shown.length - 1, S.sel))].name);
    }

    function paint() {
      list.textContent = '';
      var q = String(S.filter || '').trim().toLowerCase();
      var all = outfits();
      shown = all.filter(function (o) { return matches(o, q); });
      if (S.hersOnly) shown = shown.filter(function (o) { return isHers(o, a); });
      /* HERS FIRST, always. The whole point of tagging an outfit for someone is
         that it should be the thing you reach on HER card — a stable sort, so
         everything else keeps the catalogue's own order underneath. */
      shown = shown.slice().sort(function (x, y) {
        var hx = isHers(x, a) ? 0 : 1, hy = isHers(y, a) ? 0 : 1;
        return hx - hy;
      });
      if (S.sel >= shown.length) S.sel = Math.max(0, shown.length - 1);

      if (!all.length) {
        list.append(h('div', { class: 'hdo-empty' },
          h('div', { class: 'hdo-empty-ic' }, '⛨'),
          h('div', { class: 'hdo-empty-t' }, 'No wardrobe outfits yet'),
          h('div', { class: 'hdo-empty-d' },
            'Build one on the Wardrobe tab — or use ⧉ Copy outfit to mint one '
            + 'from what someone is already wearing.'),
          h('button', {
            class: 'hdo-btn', type: 'button', title: 'Open the Wardrobe tab',
            onClick: function (e) { e.stopPropagation(); jumpWardrobe(); },
          }, '◇ Open the Wardrobe')));
        return;
      }
      if (!shown.length) {
        var offBtn = S.hersOnly ? h('button', {
          class: 'hdo-btn', type: 'button', title: 'Show every outfit again',
          onClick: function (e) { e.stopPropagation(); S.hersOnly = false; render(); },
        }, '❤ Show everything') : null;
        list.append(h('div', { class: 'hdo-empty' },
          h('div', { class: 'hdo-empty-t' }, S.filter
            ? 'Nothing matches “' + S.filter + '”'
            : 'Nothing is tagged for ' + who() + ' yet'),
          h('div', { class: 'hdo-empty-d' }, S.hersOnly
            ? 'Turn ❤ Hers off, then press ♡ on an outfit to make it hers.'
            : all.length + ' outfits, none by that name.'),
          offBtn));
        return;
      }
      var wearing = (a && a.w && a.w.label) ? a.w.label : '';
      var canTag = !!(a && (a.key || (a.w && a.w.key)) && wardrobeApi()
        && typeof wardrobeApi().quickTagOwner === 'function');
      shown.forEach(function (o, i) {
        var art = h('span', { class: 'hdo-row-art', 'aria-hidden': 'true' }, o.image ? null : '⛨');
        if (o.image) art.style.backgroundImage = 'url("' + String(o.image).replace(/"/g, '%22') + '")';
        var isNow = wearing && wearing === o.name;
        var mine = hersTag(o, a);

        /* THE PILL ROW. Facts first (piece count), then who owns it, then its
           tags — a fixed order, so the eye lands in the same place on every
           row instead of hunting. */
        var pills = h('span', { class: 'hdo-pills' });
        if (o.pieces >= 0)
          pills.append(pill(o.pieces + ' piece' + (o.pieces === 1 ? '' : 's'), 'n'));
        (o.forNpcs || []).forEach(function (t) {
          pills.append(pill('❤ ' + (t.name || 'someone'), 'who',
            t.via ? ('Tagged on the wardrobe “' + t.via + '”, which holds this outfit')
                  : 'Tagged as ' + (t.name || 'hers')));
        });
        (o.categories || []).forEach(function (c) { pills.append(pill(c, 'cat', 'Category')); });
        (o.tags || []).forEach(function (t) { pills.append(pill('#' + t, 'tag', 'Tag')); });
        if (o.note) pills.append(pill(o.note, 'note', o.note));
        if (o.pending) pills.append(pill('new', 'new', 'Built here — SOES hasn’t listed it yet'));

        var row = h('button', {
          class: 'hdo-row' + (i === S.sel ? ' sel' : '') + (isNow ? ' is-now' : '')
            + (mine ? ' is-hers' : ''),
          type: 'button',
          title: 'Put “' + o.name + '” on ' + who() + ' now'
            + (isNow ? ' — this is already what she is assigned' : ''),
          onClick: function (e) {
            e.stopPropagation();
            S.sel = i;
            applyOutfit(a, currentDest(about()), o.name);
          },
        },
          art,
          h('span', { class: 'hdo-row-txt' },
            h('span', { class: 'hdo-row-t' },
              o.fav ? h('span', { class: 'hdo-fav', title: 'Favourite' }, '★') : null,
              o.name,
              isNow ? h('span', { class: 'hdo-now' }, 'assigned') : null),
            pills));

        /* Tag it for HER, without leaving the list. An INHERITED pill is not
           this outfit's to remove — it belongs to the wardrobe carrying it — so
           the control says so instead of pretending it can. */
        if (canTag) {
          var inherited = !!(mine && mine.via);
          row.append(h('span', {
            class: 'hdo-row-tag' + (mine ? ' on' : '') + (inherited ? ' is-inherited' : ''),
            role: 'button',
            title: inherited
              ? 'Hers through the wardrobe “' + mine.via + '” — remove it there, not here'
              : (mine ? 'Tagged for ' + who() + ' — click to untag'
                      : 'Tag “' + o.name + '” as ' + who() + '’s'),
            onClick: function (e) {
              e.stopPropagation();
              e.preventDefault();
              if (inherited) { sayText(false, 'That pill comes from the wardrobe “' + mine.via + '” — remove it there.'); return; }
              var wp = wardrobeApi();
              if (!wp) return;
              say(wp.quickTagOwner(o.name, a.key || (a.w && a.w.key), who(), !mine));
            },
          }, mine ? '❤' : '♡'));
        }
        row.append(h('span', { class: 'hdo-row-go', 'aria-hidden': 'true' }, '👗'));
        list.append(row);
      });
      stagger(list, '.hdo-row');
    }
    paint();

    var st = statusLine();
    var foot = h('div', { class: 'hdo-foot' },
      st || h('div', { class: 'hdo-hint' },
        'Enter wears the top hit · ↑ ↓ to choose · Esc goes back to the dock'));
    box.append(foot);

    setTimeout(function () { try { input.focus(); } catch (_) {} }, 0);
  }

  /* ========================================================= copy outfit == */

  function renderCopy() {
    pop = h('div', { class: 'hdo-pop hdo-copy', role: 'dialog', 'aria-label': 'Copy outfit' });
    root.append(pop);

    pop.append(head('Copy ' + who() + '’s outfit', '⧉', { back: true }));
    var body = h('div', { class: 'hdo-pop-body' });
    pop.append(body);

    body.append(h('div', { class: 'hdo-sub' }, 'into a new Wardrobe outfit'));

    var wp = (window.WardrobePane && typeof window.WardrobePane.createOutfitFromItems === 'function')
      ? window.WardrobePane : null;
    if (!wp) {
      body.append(h('div', { class: 'hdo-msg bad' },
        'The Wardrobe system isn’t loaded, so there is nowhere to copy the outfit to.'));
      makeDraggable(pop.querySelector('.hdo-head')); clampPop();
      return;
    }

    var eq = (typeof ctx().equipped === 'function') ? ctx().equipped() : null;
    if (!eq) {
      body.append(h('div', { class: 'hdo-note' }, 'Reading what ' + who() + ' is wearing…'));
      if (typeof ctx().askEquipped === 'function') ctx().askEquipped();
      makeDraggable(pop.querySelector('.hdo-head')); clampPop();
      return;
    }
    if (!eq.ok) {
      body.append(h('div', { class: 'hdo-msg bad' },
        eq.msg || 'Could not read what ' + who() + ' is wearing.'));
      makeDraggable(pop.querySelector('.hdo-head')); clampPop();
      return;
    }

    var items = eq.items || [];
    var key = String(ctx().hex || ctx().formId || '');
    /* Wipe the ticks and the name when the SUBJECT changes, so a fresh
       crosshair target starts clean rather than inheriting the last person's
       choices. */
    if (S.keepFor !== key || !S.keep) {
      S.keepFor = key;
      S.keep = Object.create(null);
      S.copyName = who() + '’s outfit';
    }
    /* Ticks are keyed by the PIECE, not by its position: she can draw a sword
       or drop a torch between two opens of this floater, and an index-keyed map
       would then silently apply your ticks to different items. Anything not yet
       decided seeds from its kind — armour on, a torch or a drawn sword off,
       because a Wardrobe outfit only carries armour and ticking a weapon is a
       no-op the row's own label warns about rather than a silent drop. */
    items.forEach(function (it) {
      var ik = itemKey(it);
      if (S.keep[ik] === undefined) S.keep[ik] = (String(it.kind || '') === 'armor');
    });

    if (!items.length) {
      body.append(h('div', { class: 'hdo-note' },
        eq.dead ? who() + ' has nothing on.' : who() + ' has nothing worn to copy.'));
      makeDraggable(pop.querySelector('.hdo-head')); clampPop();
      return;
    }

    body.append(h('label', { class: 'hdo-name' },
      h('span', { class: 'hdo-name-lbl' }, 'Name'),
      h('input', {
        class: 'hdo-name-in', type: 'text', spellcheck: 'false',
        value: S.copyName || '', maxlength: '80',
        placeholder: who() + '’s outfit',
        title: 'What the new Wardrobe outfit is called',
        onClick: function (e) { e.stopPropagation(); },
        onInput: function (e) { S.copyName = e.target.value; },
        onKeydown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); toDock(); }
        },
      })));

    function setAll(fn) {
      items.forEach(function (it, n) { S.keep[itemKey(it)] = !!fn(it, n); });
      render();
    }
    body.append(h('div', { class: 'hdo-presets' },
      h('span', { class: 'hdo-presets-lbl' }, 'Include'),
      h('button', { class: 'hdo-preset', type: 'button', title: 'Tick every worn piece',
        onClick: function (e) { e.stopPropagation(); setAll(function () { return true; }); } }, 'All'),
      h('button', { class: 'hdo-preset', type: 'button',
        title: 'Tick only the armour and clothing — what a Wardrobe outfit is made of',
        onClick: function (e) { e.stopPropagation(); setAll(function (it) { return String(it.kind || '') === 'armor'; }); } }, 'Armour only'),
      h('button', { class: 'hdo-preset', type: 'button', title: 'Untick everything',
        onClick: function (e) { e.stopPropagation(); setAll(function () { return false; }); } }, 'None')));

    var list = h('div', { class: 'hdo-copy-list' });
    var icon = (typeof ctx().eqIcon === 'function') ? ctx().eqIcon : function () { return { ic: '◆', lbl: 'Worn' }; };
    items.forEach(function (it, n) {
      var ik = itemKey(it);
      var on = !!S.keep[ik];
      var nonArmor = String(it.kind || '') !== 'armor';
      var ei = icon(it);
      var row = h('button', {
        class: 'hdo-copy-row' + (on ? ' on' : '') + (nonArmor ? ' nonarmor' : ''),
        type: 'button',
        title: (on ? 'Included — click to exclude' : 'Excluded — click to include')
          + (nonArmor ? '\nNot clothing: a Wardrobe outfit only carries armour, so this piece won’t apply.' : ''),
        onClick: function (e) { e.stopPropagation(); S.keep[ik] = !S.keep[ik]; render(); },
      },
        h('span', { class: 'hdo-copy-check', 'aria-hidden': 'true' }, on ? '☑' : '☐'),
        h('span', { class: 'hdo-copy-ic', title: ei.lbl }, ei.ic),
        h('span', { class: 'hdo-copy-nm' }, it.name));
      if (it.count > 1) row.append(h('span', { class: 'hdo-copy-ct' }, '×' + it.count));
      if (it.outfit) row.append(h('span', { class: 'hdo-copy-tag', title: 'Part of her default outfit' }, 'outfit'));
      list.append(row);
    });
    body.append(list);

    var nPick = items.filter(function (it) { return S.keep[itemKey(it)]; }).length;
    var st = statusLine();
    if (st) body.append(st);
    body.append(h('div', { class: 'hdo-copy-foot' },
      h('button', {
        class: 'hdo-btn hdo-btn-go', type: 'button',
        disabled: nPick ? null : true,
        title: nPick
          ? 'Create a Wardrobe outfit from the ' + nPick + ' ticked piece' + (nPick === 1 ? '' : 's')
          : 'Tick at least one piece first',
        onClick: function (e) {
          e.stopPropagation();
          var nm = String(S.copyName || '').trim() || (who() + '’s outfit');
          var pick = items.filter(function (it) { return S.keep[itemKey(it)]; });
          var res = wp.createOutfitFromItems(nm, pick);
          if (res && res.ok) {
            sayText(true, '✓ Saved “' + res.name + '” to the Wardrobe — ' + res.count
              + ' piece' + (res.count === 1 ? '' : 's') + '. It is in ⚡ Quick apply now.');
          } else {
            sayText(false, (res && res.msg) ? res.msg : 'Nothing to copy.');
          }
        },
      }, '⧉ Create outfit' + (nPick ? ' (' + nPick + ')' : ''))));

    makeDraggable(pop.querySelector('.hdo-head'));
    clampPop();
  }

  /* ============================================================ settings == */

  function section(title, hint) {
    return h('div', { class: 'hdo-sec' },
      h('div', { class: 'hdo-sec-h' },
        h('span', { class: 'hdo-sec-t' }, title),
        hint ? h('span', { class: 'hdo-sec-hint' }, hint) : null));
  }

  function jumpWardrobe(key) {
    var wp = wardrobeApi();
    /* setTab BEFORE focusing: the Wardrobe pane's onShow re-reads its state and
       re-renders, which would wipe a sheet opened first. */
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('wardrobe');
    if (wp && key && typeof wp.quickFocus === 'function') wp.quickFocus(key);
    close();
  }

  function renderSettings() {
    var a = about();
    var box = h('div', { class: 'hdo-box hdo-settings', role: 'dialog', 'aria-label': 'Outfit settings' });
    root.append(box);

    /* No mode chip in the header here — the "Dressed by" section immediately
       below IS the mode, spelled out and changeable, and two "DRESSED BY"
       labels a centimetre apart read as a bug. */
    box.append(head(who() + '’s clothes', '⚙', { back: true }));
    var body = h('div', { class: 'hdo-body' });
    box.append(body);

    if (!a) {
      body.append(h('div', { class: 'hdo-empty' },
        h('div', { class: 'hdo-empty-ic' }, '⛨'),
        h('div', { class: 'hdo-empty-t' }, 'No outfit system has heard of ' + who()),
        h('div', { class: 'hdo-empty-d' },
          'Recruit her through NFF, or open the Wardrobe tab once so SOES-NG lists her.')));
      return;
    }

    var w = warnings(a);
    if (w) w.forEach(function (n) { body.append(n); });

    /* WHO DRESSES HER — the lead control, and the reason this popout exists.
       Three exclusive states; clicking one runs the Wardrobe pane's OWN
       handover, which clears the losing side in C++ so the two backends can
       never both hold her. */
    if (a.w) {
      var sec = section('Dressed by',
        'Exactly one system. Switching hands her over — the losing side is cleared for you.');
      var opts = [
        ['wardrobe', '◇', 'Wardrobe', 'The deck assigns her outfits, through SOES-NG'],
        ['nff', '⛨', 'NFF', 'Nether’s Follower Framework dresses her — the three sets below'],
        ['off', '○', 'Nobody', 'Nobody manages her clothes — she wears what she wears'],
      ];
      var grid = h('div', { class: 'hdo-opts' });
      opts.forEach(function (o) {
        grid.append(h('button', {
          class: 'hdo-opt' + (a.mode === o[0] ? ' on' : ''), type: 'button',
          'aria-pressed': String(a.mode === o[0]), title: o[3],
          onClick: function (e) {
            e.stopPropagation();
            var wp = wardrobeApi();
            if (!wp) return;
            say(wp.quickSetManaged(a.key || a.w.key, o[0]));
          },
        },
          h('span', { class: 'hdo-opt-ic', 'aria-hidden': 'true' }, o[1]),
          h('span', { class: 'hdo-opt-t' }, o[2]),
          h('span', { class: 'hdo-opt-s' }, o[3])));
      });
      sec.append(grid);
      body.append(sec);
    }

    /* WEAR IT NOW. Piece counts and the ● come from NFF's own export, so a chip
       can never claim a set that is empty. "Her own" is kBase — her original
       clothes back with the sets untouched; it is NOT the destructive Reset. */
    if (a.nf) {
      var wsec = section('Wear now', 'Put one of her NFF sets on this second');
      var wrow = h('div', { class: 'hdo-chips' });
      SETS.forEach(function (s) {
        var have = !!(a.nf.have && a.nf.have[s.t]);
        var n = (a.nf.counts && a.nf.counts[s.t] >= 0) ? a.nf.counts[s.t] : -1;
        var worn = a.nf.worn === s.t;
        var label = (a.nf.labels && a.nf.labels[s.t]) || s.name;
        wrow.append(h('button', {
          class: 'hdo-chip' + (worn ? ' on' : ''), type: 'button',
          disabled: have ? null : true,
          'aria-current': worn ? 'true' : null,
          title: have
            ? (worn ? 'She is wearing this now — click to put it on again' : 'Put this on her now')
              + ' — ' + s.hint + (n >= 0 ? ' · ' + n + ' piece' + (n === 1 ? '' : 's') : '')
            : 'Her ' + s.name + ' set is empty — fill it first, with the row below',
          onClick: function (e) {
            e.stopPropagation();
            var nfp = nffApi();
            if (nfp) say(nfp.wearSet(a.key, s.t));
          },
        }, (worn ? '● ' : '') + label + (n > 0 ? ' ' + n : '')));
      });
      if (a.nf.slot >= 0) {
        wrow.append(h('button', {
          class: 'hdo-chip' + (a.nf.worn === BASE_TYPE ? ' on' : ''), type: 'button',
          title: 'Put her OWN original clothes back on. The three sets stay exactly '
            + 'where they are — this is not the Reset below.',
          onClick: function (e) {
            e.stopPropagation();
            var nfp = nffApi();
            if (nfp) say(nfp.wearSet(a.key, BASE_TYPE));
          },
        }, 'Her own'));
      }
      wsec.append(wrow);
      body.append(wsec);

      /* FILL — the four containers. Each closes the deck, because NFF answers
         with a container menu of its own. */
      var fsec = section('Fill a chest', 'The deck closes — NFF answers with a container');
      var frow = h('div', { class: 'hdo-chips' });
      SETS.forEach(function (s) {
        frow.append(h('button', {
          class: 'hdo-chip', type: 'button',
          title: 'Open ' + who() + '’s ' + s.name + ' chest — ' + s.hint
            + '.\nThe deck closes, because NFF answers with a container menu.',
          onClick: function (e) {
            e.stopPropagation();
            if (typeof ctx().fillChest === 'function') { ctx().fillChest(s.t); close(); return; }
            var nfp = nffApi();
            if (nfp) { say(nfp.openChest(a.key, s.t)); close(); }
          },
        }, s.name));
      });
      if (a.nf.slot >= 0) {
        frow.append(h('button', {
          class: 'hdo-chip', type: 'button',
          title: 'Open ' + who() + '’s NFF satchel — where NFF stows her own gear while '
            + 'one of its outfits is on. The deck closes.',
          onClick: function (e) {
            e.stopPropagation();
            var nfp = nffApi();
            if (nfp) say(nfp.openSatchel(a.key));
          },
        }, '🎒 Satchel'));
      }
      frow.append(h('button', {
        class: 'hdo-chip is-link', type: 'button',
        title: 'Fill a set from a wardrobe outfit you already built — that is exactly '
          + 'what ⚡ Quick apply does with an NFF destination.',
        onClick: function (e) { e.stopPropagation(); toView('apply'); },
      }, '⚡ From a wardrobe outfit…'));
      fsec.append(frow);
      body.append(fsec);
    }

    /* SOES — the Wardrobe side of the same person. */
    if (a.w) {
      var ssec = section('SOES-NG', a.w.label
        ? 'Assigned: ' + a.w.label + (a.w.cadence ? ' · changes every ' + a.w.cadence : '')
        : 'The deck’s own outfit backbone');
      var srow = h('div', { class: 'hdo-chips' });
      srow.append(h('button', {
        class: 'hdo-chip', type: 'button',
        disabled: a.w.canDress ? null : true,
        title: a.w.canDress
          ? 'Put ' + who() + '’s assigned outfit on her right now'
          : (a.w.soes ? 'Nothing is assigned to her — use ⚡ Quick apply, or her card'
                      : 'SOES-NG isn’t answering, so there is nothing to dress her with'),
        onClick: function (e) {
          e.stopPropagation();
          var wp = wardrobeApi();
          if (wp) say(wp.quickDress(a.w.key));
        },
      }, '✦ Dress now'));
      srow.append(h('button', {
        class: 'hdo-chip' + (a.w.tracked ? ' on' : ''), type: 'button',
        'aria-pressed': String(!!a.w.tracked),
        title: a.w.tracked
          ? 'SOES-NG manages ' + who() + '’s equipment. Click to leave her alone.'
          : 'Let SOES-NG manage ' + who() + '’s equipment. It refuses while nothing is '
            + 'assigned — a tracked actor it cannot dress gets STRIPPED.',
        onClick: function (e) {
          e.stopPropagation();
          var wp = wardrobeApi();
          if (wp) say(wp.quickTrack(a.w.key, !a.w.tracked));
        },
      }, a.w.tracked ? '✓ Tracked' : '◇ Track'));
      srow.append(h('button', {
        class: 'hdo-chip is-link', type: 'button',
        title: 'Open ' + who() + '’s full Wardrobe card — which outfit or pool, how often '
          + 'it changes, and what she wears in each kind of place',
        onClick: function (e) { e.stopPropagation(); jumpWardrobe(a.w.key); },
      }, '◇ Her full card…'));
      ssec.append(srow);
      body.append(ssec);
    }

    /* RESET — the one area here that DESTROYS something, so it is last, muted,
       and the wide one is armed. */
    if (a.nf) {
      var rsec = section('Reset', 'Forget an outfit. Nothing here is undoable.');
      rsec.classList.add('is-danger');
      var rrow = h('div', { class: 'hdo-chips' });
      SETS.forEach(function (s) {
        rrow.append(h('button', {
          class: 'hdo-chip is-danger', type: 'button',
          title: 'Forget ' + who() + '’s ' + s.name + ' outfit — that set only',
          onClick: function (e) {
            e.stopPropagation();
            if (typeof ctx().clearSet === 'function') { ctx().clearSet(s.t, s.name); sayText(true, 'Clearing her ' + s.name + ' outfit…'); }
          },
        }, '✕ ' + s.name));
      });
      rrow.append(h('button', {
        class: 'hdo-chip is-danger' + (S.armReset ? ' armed' : ''), type: 'button',
        title: S.armReset
          ? 'Click again to drop ' + who() + ' from NFF outfits entirely'
          : 'Stop NFF dressing ' + who() + ' at all — she goes back to her own clothes.'
            + '\nThis is the “reset outfit” that lives in NFF’s dialogue.',
        onClick: function (e) {
          e.stopPropagation();
          if (!S.armReset) { S.armReset = true; render(); setTimeout(function () {
            if (S.armReset) { S.armReset = false; if (S.view === 'settings') render(); }
          }, 4200); return; }
          S.armReset = false;
          if (typeof ctx().clearSet === 'function') { ctx().clearSet(BASE_TYPE, 'NFF outfits'); sayText(true, 'Dropping her from NFF outfits…'); }
        },
      }, S.armReset ? '⟲ Sure?' : '⟲ Stop using NFF'));
      rsec.append(rrow);
      body.append(rsec);
    }

    var st = statusLine();
    box.append(h('div', { class: 'hdo-foot' },
      st || h('div', { class: 'hdo-hint' }, 'Esc goes back to the dock')));
  }

  /* Everything the current surface is DRAWN FROM, as one short string.
     The dock opens before the Wardrobe has answered, so open() schedules two
     catch-up repaints — and a repaint is a full teardown of #hdo-layer, which
     re-runs the entrance animation from opacity 0. Three of those inside a
     second is the "dropdown flashes a few times" Rober saw (measured: rebuilds
     at 1 ms, 282 ms and 901 ms after one press). So a catch-up repaint now has
     to EARN it: same signature, no paint. */
  function sig() {
    var a = about();
    var parts = [S.view, String(ctx().hex || ''), S.filter, String(S.dest), String(S.sel),
      S.hersOnly ? 'H' : '',
      S.msg ? (S.msg.ok ? '1' : '0') + S.msg.text : '', S.armReset ? 'a' : ''];
    if (a) {
      parts.push(a.mode, a.key || '');
      if (a.w) parts.push(a.w.label || '', a.w.tracked ? 't' : '', a.w.canDress ? 'd' : '',
        a.w.twoSystems ? '2' : '', a.w.conflict ? 'c' : '');
      if (a.nf) parts.push(String(a.nf.worn), String(a.nf.slot),
        (a.nf.counts || []).join(','), (a.nf.labels || []).join(','));
    } else {
      parts.push('unknown');
    }
    if (S.view === 'apply') {
      var os = outfits();
      /* The pill row is part of what is DRAWN, so a tag toggled from a row has
         to change the signature — otherwise maybeRender() would decide nothing
         happened and the pill would not appear until the next full render. */
      parts.push(String(os.length), os.map(function (o) {
        return o.name + ':' + o.pieces + ':' + (o.tags || []).join(',') + ':'
          + (o.forNpcs || []).map(function (t) { return t.key; }).join(',');
      }).join('|'));
    }
    if (S.view === 'copy') {
      var eq = (typeof ctx().equipped === 'function') ? ctx().equipped() : null;
      parts.push(eq ? (eq.ok ? 'ok' : 'no') + ((eq.items || []).length) : 'none');
      parts.push(String(S.copyName), JSON.stringify(S.keep || {}));
    }
    return parts.join('\u0001');
  }

  /* Repaint only if something actually changed. Used by every LATE trigger —
     the catch-up timers, a wardrobe/NFF push, an fdEquipped reply — none of
     which know whether they carry news. */
  function maybeRender() {
    if (!S.view) return false;
    if (sig() === S.sig) return false;
    render();
    return true;
  }

  /* ============================================================== render == */

  function render() {
    var r = ensureRoot();
    if (pop) pop = null;
    r.textContent = '';
    r.classList.toggle('hidden', !S.view);
    r.classList.toggle('is-modal', isModalView());
    if (!S.view) { S.sig = ''; S.animFor = ''; return; }
    /* The entrance animation belongs to ARRIVING somewhere, not to every
       repaint. Without this gate a data-driven repaint fades the whole surface
       in again — which is the same flash, just rarer and harder to explain. */
    var key = S.view + '|' + String(ctx().hex || '');
    S.fresh = (S.animFor !== key);
    S.animFor = key;
    if (S.view === 'dock') renderDock();
    else if (S.view === 'apply') renderApply();
    else if (S.view === 'copy') renderCopy();
    else if (S.view === 'settings') renderSettings();
    if (S.fresh) {
      var box = r.querySelector('.hdo-pop, .hdo-box');
      if (box) box.classList.add('is-fresh');
    }
    S.sig = sig();
  }

  /* ============================================================== public == */

  function toView(v) {
    S.view = v;
    S.msg = null;
    S.armReset = false;
    if (v === 'apply') { S.filter = ''; S.sel = 0; }
    render();
  }
  function toDock() { toView('dock'); }

  /* open(anchorEl, ctx) — the ⛨ button's whole job.
     ctx: { who, formId, hex, dead, equipped(), askEquipped(), eqIcon(it),
            say({ok,msg}), fillChest(type), clearSet(type,label), onClose() } */
  function open(anchorEl, c) {
    S.ctx = c || {};
    var key = String(S.ctx.hex || S.ctx.formId || '');
    if (S.keepFor !== key) { S.keep = null; S.keepFor = ''; S.copyName = ''; }
    S.dest = null;
    S.msg = null;
    /* SHOW FIRST, measure second. `hidden` is display:none, and a display:none
       element reports a zero rect — so anchoring before this line silently
       treated the anchor's VIEWPORT coordinates as layer coordinates and put
       the floater one panel-offset away from the button that opened it. */
    ensureRoot().classList.remove('hidden');
    anchorTo(anchorEl);
    toGameSafe('hdCapture', '1');   // typing a name must never quick-fire a hotkey
    /* Both slices, once — this popout is reached without ever visiting the
       Wardrobe tab, so without the ask the whole thing would be empty on the
       surface it matters on. */
    var wp = wardrobeApi();
    if (wp && typeof wp.quickRefresh === 'function') wp.quickRefresh();
    setTimeout(maybeRender, 280);
    setTimeout(maybeRender, 900);
    toDock();
    setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
  }

  function close() {
    if (!S.view) return;
    S.view = '';
    S.armReset = false;
    pop = null;
    if (root) { root.textContent = ''; root.classList.add('hidden'); root.classList.remove('is-modal'); }
    document.removeEventListener('mousedown', outside, true);
    toGameSafe('hdCapture', '0');
    /* Tell the card. Its ⛨ draws itself gold while the dock is up (that is what
       `active` reads), and a button left lit over a closed popout is the kind of
       small lie that makes a UI feel broken. */
    var cb = ctx().onClose;
    if (typeof cb === 'function') { try { cb(); } catch (e) {} }
  }

  function onKey(e) {
    if (!S.view) return false;
    var k = e.key || e.code;
    if (k === 'Escape') {
      if (S.view === 'dock') close(); else toDock();
      return true;
    }
    return false;   // the search box and the name field keep their native keys
  }

  /* Data arrived after we drew (fdEquipped answering the Copy floater, or a
     wardrobe/NFF push). Repaint whatever is up — cheap, and every surface here
     is built from live module state on every render anyway. */
  function refresh() { return maybeRender(); }

  /* A verdict that arrived LATER, from C++ (wdResult). The Wardrobe pane routes
     it here because a toast can land behind this popout, and "5 pieces on, 1
     missing" is the sentence you actually wanted. */
  function report(r) {
    if (!r || !S.view) return;
    S.msg = { ok: r.ok !== false, text: r.msg || (r.ok !== false ? 'Done' : 'Refused') };
    render();
  }

  window.HDOutfit = {
    open: open,
    close: close,
    isOpen: function () { return !!S.view; },
    view: function () { return S.view; },
    onKey: onKey,
    refresh: refresh,
    report: report,
    show: toView,       // deep-link a surface (harness + future callers)
    _state: S,          // harness introspection only
    _render: render,
    _sets: SETS,
    _about: about,
    _outfits: outfits,
    _destinations: destinations,
    _currentDest: currentDest,
  };
})();
