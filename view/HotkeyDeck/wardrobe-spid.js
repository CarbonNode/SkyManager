'use strict';

/* ====================================================================== *
 *  Wardrobe → SPID — every permanent grant, by person, on the wardrobe.
 *
 *  Rober (2026-08-11): "how do i manage spid outfits? … i think a tab is
 *  needed on the dedicated wardrobe page to show like what outfits have
 *  been created and from what npc (hook to their profile picture and show
 *  it there) with ability to delete or otherwise … the point of this is to
 *  enforce items (like wigs, etc) that it should be easily trackable ….
 *  enable or disable etc."
 *
 *  So: a real sub-tab of the Wardrobe pane (WardrobePane.registerSub), not
 *  a modal you have to know about. One CARD per NPC — her portrait, her
 *  grants, and the two verbs that matter:
 *
 *    • ENABLE / DISABLE, per grant and per person. Reversible: the row
 *      stays, the ini line goes. This is the "enforce a wig, then stop
 *      enforcing it" switch, and it is why the C++ grew Item.enabled /
 *      Npc.enabled rather than the view faking it with chance 0.
 *    • FORGET — the destructive one, armed with a two-click.
 *
 *  Everything is keyed by DURABLE identity (npc plugin + base local id),
 *  so a card works whether or not she is loaded in the world — this page
 *  is a file editor, not a live-actor screen.
 *
 *  Bridge (one name per direction): sgAll → sgAllState (shared with the
 *  hd-spidgear modal, so this file CHAINS the receiver rather than
 *  replacing it), sgEnable / sgNpcOp / sgRemove / sgChance out. Every
 *  mutation is answered by a fresh sgAllState from the DLL, so the card
 *  always repaints from truth; the optimistic local edit only exists so
 *  the toggle does not visibly lag.
 * ====================================================================== */

window.WardrobeSpid = (function () {
  /* ------------------------------------------------------------ state -- */

  var state = {
    npcs: [],          // last sgAllState roster
    ini: 'HotkeyDeckGear_DISTR.ini',
    lines: 0,          // grants that actually reach the ini
    loaded: false,     // has the DLL ever answered?
  };

  var ui = {
    filter: '',
    armedNpc: '',      // npc key armed for "forget all"
    armedItem: '',     // "npcKey|itemKey" armed for removal
    armedAt: 0,
  };

  var ARM_MS = 4000;
  var chanceTimers = {};
  var ctx = null;      // last render context from the host

  /* ----------------------------------------------------------- helpers -- */

  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      if (Array.isArray(kid)) { kid.forEach(function (x) { if (x != null) n.append(x.nodeType ? x : document.createTextNode(String(x))); }); continue; }
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function toGame(fn, arg) {
    if (typeof window.toGame === 'function') window.toGame(fn, arg);
  }

  function say(msg) {
    if (ctx && typeof ctx.toast === 'function') ctx.toast(msg);
    else if (typeof window.toast === 'function') window.toast(msg);
  }

  function keyOf(o) {
    return String((o && o.plugin) || '').toLowerCase() + '|' + String((o && o.localId) || '');
  }

  function armed(which, key) {
    return ui[which] === key && (Date.now() - ui.armedAt) < ARM_MS;
  }

  function arm(which, key) {
    ui.armedNpc = ''; ui.armedItem = '';
    ui[which] = key; ui.armedAt = Date.now();
  }

  function disarm() { ui.armedNpc = ''; ui.armedItem = ''; ui.armedAt = 0; }

  /* Text-node highlighter — never innerHTML (same rule as every other pane). */
  function nameNodes(text, q) {
    var s = String(text == null ? '' : text);
    if (!q) return [document.createTextNode(s)];
    var i = s.toLowerCase().indexOf(q);
    if (i === -1) return [document.createTextNode(s)];
    return [document.createTextNode(s.slice(0, i)),
            h('mark', null, s.slice(i, i + q.length)),
            document.createTextNode(s.slice(i + q.length))];
  }

  /* --------------------------------------------------------- portraits -- *
   *  "hook to their profile picture and show it there". A SPID grant knows
   *  the NPC's BASE identity and the display name recorded at grant time —
   *  no runtime form id — so resolution goes through FolPane's own helper
   *  with the name in both slots, which is exactly the slug path the photo
   *  files are stored under. Missing photo => the generic glyph, never a
   *  broken image box. */
  function portraitFor(npc) {
    var F = window.FolPane;
    var probe = { formId: 0, original: npc.name || '', name: npc.name || '' };
    try {
      if (F && typeof F.portraitInfoFor === 'function') return F.portraitInfoFor(probe);
      if (F && typeof F._portraitFor === 'function') return F._portraitFor(probe);
    } catch (_) { /* a portrait must never break the list */ }
    return null;
  }

  function faceGlyph() {
    var wrap = h('span', { class: 'wdsp-face ph', 'aria-hidden': 'true' });
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M12 12a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0 1.8c-3.4 0-7 1.7-7 3.9V21h14v-3.3c0-2.2-3.6-3.9-7-3.9Z');
    p.setAttribute('fill', 'currentColor');
    svg.append(p);
    wrap.append(svg);
    return wrap;
  }

  /* ---- head renders (2026-08-20) --------------------------------------
     A captured photo is the best picture and stays first, but almost nobody
     on this page has one: these are people you granted a wig to, not people
     you travel with. The deck already bakes a facegen head for every NPC the
     Finder shows, and that pool is keyed by the FACE OWNER — for a templated
     NPC a donor record in another plugin — which is why this needs its own
     door (sgFaces) rather than the followers' runtime-id one. Renders that
     exist come back at once; missing ones bake and we re-ask on a slow,
     BOUNDED clock, because an NPC with no facegen file never lands and an
     unbounded poll would ask forever (the 2026-08-14 lesson). */
  var faces = {};          // "plugin|0xlocal" -> icons/npcs/… path
  var faceAsked = {};      // keys already sent this session
  var facePolls = 0;
  var facePollT = null;
  var MAX_FACE_POLLS = 12;

  function faceKey(npc) {
    return (npc && npc.plugin && npc.localId) ? (npc.plugin + '|' + npc.localId) : '';
  }

  function requestFaces() {
    var ask = [];
    state.npcs.forEach(function (npc) {
      var k = faceKey(npc);
      if (!k || faceAsked[k] || faces[k]) return;
      var shot = portraitFor(npc);
      if (shot && shot.file) return;          // a real photo already wins
      faceAsked[k] = true;
      ask.push({ plugin: npc.plugin, localId: npc.localId });
    });
    if (!ask.length) return;
    facePolls = 0;
    toGame('sgFaces', JSON.stringify({ npcs: ask }));
  }

  function receiveFaces(payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || typeof d !== 'object') return;
    var got = 0;
    if (d.icons && typeof d.icons === 'object') {
      for (var k in d.icons) {
        if (!Object.prototype.hasOwnProperty.call(d.icons, k)) continue;
        if (faces[k] !== d.icons[k]) { faces[k] = d.icons[k]; got++; }
      }
    }
    if (got) redraw();
    /* Still baking: ask again, but only so many times. The empty re-ask
       queues nothing — it just reads the on-disk index. */
    if (facePollT) { clearTimeout(facePollT); facePollT = null; }
    if ((d.queued | 0) > 0 && facePolls < MAX_FACE_POLLS) {
      facePolls++;
      facePollT = setTimeout(function () {
        facePollT = null;
        var again = [];
        state.npcs.forEach(function (npc) {
          var k = faceKey(npc);
          if (k && !faces[k]) again.push({ plugin: npc.plugin, localId: npc.localId });
        });
        if (again.length) toGame('sgFaces', JSON.stringify({ npcs: again }));
      }, 3000);
    }
  }

  function faceEl(npc) {
    var shot = portraitFor(npc);
    if (!shot || !shot.file) {
      var render = faces[faceKey(npc)];
      if (render) {
        var rwrap = h('span', { class: 'wdsp-face' });
        var rimg = h('img', { src: render, alt: '' });
        /* Head renders are framed by the shared face-fit lane, exactly as the
           roster and the Finder frame the SAME png — three surfaces, one
           framing, or the same face looks cropped differently in each. */
        if (window.HDFaceFit && typeof HDFaceFit.paint === 'function')
          HDFaceFit.paint(rimg, render);
        rimg.addEventListener('error', function () {
          var g = faceGlyph();
          if (rwrap.parentNode) rwrap.parentNode.replaceChild(g, rwrap);
        });
        rwrap.append(rimg);
        return rwrap;
      }
      return faceGlyph();
    }
    var wrap = h('span', { class: 'wdsp-face' });
    /* Plain path, no ?v= cache-buster: Ultralight treats the query as part
       of the filename and 404s (the Favorites Shelf learned this). */
    var plain = shot.abs ? shot.file : 'portraits/' + shot.file;
    var img = h('img', { src: plain, alt: '' });
    /* the user's saved framing — one shared lane, or this centre-crops (2026-08-19) */
    if (window.HDFaceFit) { if (shot.abs) HDFaceFit.ensure(img, plain); else HDFaceFit.paintPortrait(img, plain); }
    img.addEventListener('error', function () {
      var g = faceGlyph();
      if (wrap.parentNode) wrap.parentNode.replaceChild(g, wrap);
    });
    wrap.append(img);
    return wrap;
  }

  /* ------------------------------------------------------------- data -- */

  function request() { toGame('sgAll', '{}'); }

  function receive(payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || typeof d !== 'object') return;
    state.npcs = Array.isArray(d.npcs) ? d.npcs : [];
    if (d.ini) state.ini = d.ini;
    /* Derived here rather than trusting the payload's `lines`: the same
       function then owns the number after an optimistic toggle, so the
       headline can never disagree with the switches underneath it. */
    state.lines = countLive();
    state.loaded = true;
    /* A roster reply is the only moment we learn about a person we have never
       drawn — a grant just added, or the first load of the session — so this
       is where the faces for her get asked for. Anyone already answered or
       already asked is skipped inside. */
    requestFaces();
    if (ctx && typeof ctx.render === 'function' && isShowing()) ctx.render();
  }

  function isShowing() {
    var host = window.WardrobePane;
    return !!(host && host._ui && host._ui.sub === 'spid');
  }

  function countLive() {
    var n = 0;
    state.npcs.forEach(function (npc) {
      if (npc.enabled === false) return;
      (npc.items || []).forEach(function (it) { if (it.enabled !== false) n++; });
    });
    return n;
  }

  /* The host asks for a tab count. NPCs, not items: the card is the unit. */
  function count() { return state.npcs.length; }

  function matches(npc, q) {
    if (!q) return true;
    if (String(npc.name || '').toLowerCase().indexOf(q) !== -1) return true;
    if (String(npc.plugin || '').toLowerCase().indexOf(q) !== -1) return true;
    var items = npc.items || [];
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].name || '').toLowerCase().indexOf(q) !== -1) return true;
      if (String(items[i].plugin || '').toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  /* --------------------------------------------------------- mutations -- */

  function sendEnableItem(npc, it, on) {
    it.enabled = on;                                   // optimistic; DLL confirms
    state.lines = countLive();
    toGame('sgEnable', JSON.stringify({
      npcPlugin: npc.plugin, npcLocalId: npc.localId,
      plugin: it.plugin, localId: it.localId, enabled: !!on,
    }));
    say((it.name || 'Grant') + (on ? ' — on at next launch' : ' — off, kept in the list'));
  }

  /* ---- add a grant from an item's identity (2026-08-20) ----------------
     No optimistic row here, unlike every other mutation on this page. The
     DLL is the only thing that can say whether the item resolves in THIS
     load order and whether it is something an NPC can carry, and drawing a
     grant that the answer then refuses would be a lie the page had to take
     back. sgAdd always answers with a fresh sgAllState, so the row appears
     the moment it is real. */
  function addGrant(npc, item, count) {
    if (!npc || !item || !item.plugin) return;
    toGame('sgAdd', JSON.stringify({
      npcPlugin: npc.plugin, npcLocal: npc.localId, npcName: npc.name || '',
      itemPlugin: item.plugin,
      itemLocal: HDItemPickLocal(item),
      itemName: item.name || '',
      count: Math.max(1, Math.min(999, count | 0 || 1)),
      chance: 100,
    }));
  }

  /* The picker hands back localId as a NUMBER; every sg* payload speaks the
     "0x…" string form (ActorIdentity::ParseHex on the other side). One place
     does the conversion so a future caller cannot get it subtly wrong. */
  function HDItemPickLocal(item) {
    if (typeof item.localId === 'string') return item.localId;
    return '0x' + Number(item.localId >>> 0).toString(16);
  }

  function openAddFor(npc) {
    /* The picker mounts inset:0 INSIDE a pane element, so it inherits the
       deck's scale and clips to its rounded corners (the ix-sheet idiom). The
       host hands us its own pane in the render context — that is the right
       one; the lookups after it are only for a host that predates the ctx or
       a harness that draws us bare. */
    var host = (ctx && ctx.pane) || null;
    if (!host && ctx && ctx.list && ctx.list.closest) host = ctx.list.closest('section');
    if (!host) host = document.getElementById('wd-pane');
    if (!window.HDItemPick || !host) {
      say('The item finder is not available here');
      return;
    }
    var already = (npc.items || []).map(function (it) {
      return { plugin: it.plugin, localId: parseInt(String(it.localId), 16) >>> 0 };
    });
    HDItemPick.open({
      host: host,
      title: 'Enforce on ' + (npc.name || 'her'),
      hint: 'She is handed this at every launch, forever, until you pause or forget it.',
      confirm: 'Enforce',
      multi: true,        // granting a whole outfit is one trip, not five
      chosen: function () { return already; },
      onPick: function (it) {
        addGrant(npc, it, 1);
        already.push({ plugin: it.plugin, localId: (it.localId >>> 0) });
        say('Enforcing ' + (it.name || 'that item') + ' on ' + (npc.name || 'her'));
      },
      onClose: function () { redraw(); },
    });
  }

  function sendEnableNpc(npc, on) {
    npc.enabled = on;
    state.lines = countLive();
    toGame('sgNpcOp', JSON.stringify({
      npcPlugin: npc.plugin, npcLocalId: npc.localId, op: on ? 'enable' : 'disable',
    }));
    say((npc.name || 'She') + (on ? '’s gear is on' : '’s gear is off — nothing forgotten'));
  }

  function sendForgetNpc(npc) {
    state.npcs = state.npcs.filter(function (n) { return keyOf(n) !== keyOf(npc); });
    state.lines = countLive();
    toGame('sgNpcOp', JSON.stringify({
      npcPlugin: npc.plugin, npcLocalId: npc.localId, op: 'delete',
    }));
    say('Forgot every grant for ' + (npc.name || 'that NPC'));
  }

  function sendRemoveItem(npc, it) {
    npc.items = (npc.items || []).filter(function (x) { return keyOf(x) !== keyOf(it); });
    if (!npc.items.length)
      state.npcs = state.npcs.filter(function (n) { return keyOf(n) !== keyOf(npc); });
    state.lines = countLive();
    toGame('sgRemove', JSON.stringify({
      npcPlugin: npc.plugin, npcLocalId: npc.localId,
      plugin: it.plugin, localId: it.localId,
    }));
    say('Removed ' + (it.name || 'that grant'));
  }

  function sendChance(npc, it, pct) {
    it.chance = pct;
    var k = keyOf(npc) + '|' + keyOf(it);
    clearTimeout(chanceTimers[k]);
    chanceTimers[k] = setTimeout(function () {
      toGame('sgChance', JSON.stringify({
        npcPlugin: npc.plugin, npcLocalId: npc.localId,
        plugin: it.plugin, localId: it.localId, chance: pct,
      }));
    }, 220);
  }

  /* ------------------------------------------------------------ render -- */

  function toggle(on, label, title, onClick, cls) {
    var b = h('button', {
      class: 'wdsp-toggle' + (on ? ' on' : '') + (cls ? ' ' + cls : ''),
      type: 'button', title: title,
      'aria-pressed': on ? 'true' : 'false',
      onClick: onClick,
    }, h('span', { class: 'wdsp-toggle-dot', 'aria-hidden': 'true' }),
       h('span', { class: 'wdsp-toggle-lbl' }, label));
    return b;
  }

  function itemRow(npc, it, q) {
    var on = it.enabled !== false;
    var npcOn = npc.enabled !== false;
    var ikey = keyOf(npc) + '|' + keyOf(it);
    var isArmed = armed('armedItem', ikey);
    var row = h('div', {
      class: 'wdsp-item' + (on ? '' : ' off') + (npcOn ? '' : ' muted'),
    });

    row.append(toggle(on, on ? 'On' : 'Off',
      on ? 'Stop distributing ' + (it.name || 'this') + ' — the grant is kept, just switched off'
         : 'Distribute ' + (it.name || 'this') + ' again at the next launch',
      function (e) { e.stopPropagation(); sendEnableItem(npc, it, !on); redraw(); },
      'sm'));

    var nm = h('span', { class: 'wdsp-item-name', title: (it.name || 'Unnamed item')
      + '\n' + (it.plugin || '?') + ' · ' + (it.localId || '?')
      + (it.when ? '\nGranted ' + it.when : '') });
    nameNodes(it.name || 'Unnamed item', q).forEach(function (n) { nm.append(n); });
    row.append(nm);

    if (it.count > 1) row.append(h('span', { class: 'wdsp-x', title: 'Quantity granted' }, '×' + it.count));

    var pct = h('span', { class: 'wdsp-pct' }, String(it.chance) + '%');
    var range = h('input', {
      type: 'range', class: 'wdsp-range', min: '5', max: '100', step: '5',
      value: String(it.chance), disabled: on ? null : true,
      title: 'Chance she receives this each launch — 100% = always',
    });
    range.addEventListener('input', function () {
      var v = parseInt(range.value, 10) || 100;
      pct.textContent = v + '%';
      sendChance(npc, it, v);
    });
    row.append(range, pct);

    row.append(h('button', {
      class: 'wdsp-x-btn' + (isArmed ? ' armed' : ''), type: 'button',
      title: isArmed ? 'Click again to forget this grant for good'
                     : 'Forget this grant (removes the line — use On/Off to pause it instead)',
      onClick: function (e) {
        e.stopPropagation();
        if (isArmed) { disarm(); sendRemoveItem(npc, it); }
        else arm('armedItem', ikey);
        redraw();
      },
    }, isArmed ? 'Sure?' : '✕'));

    return row;
  }

  function npcCard(npc, q) {
    var on = npc.enabled !== false;
    var items = npc.items || [];
    var live = items.filter(function (it) { return it.enabled !== false; }).length;
    var nkey = keyOf(npc);
    var isArmed = armed('armedNpc', nkey);

    var card = h('div', { class: 'wdsp-card' + (on ? '' : ' off') });

    var head = h('div', { class: 'wdsp-head' });
    head.append(faceEl(npc));

    var idBox = h('div', { class: 'wdsp-id' });
    var nm = h('div', { class: 'wdsp-name', title: (npc.name || 'Unnamed')
      + '\n' + (npc.plugin || '?') + ' · ' + (npc.localId || '?') });
    nameNodes(npc.name || 'Unnamed', q).forEach(function (n) { nm.append(n); });
    idBox.append(nm);
    idBox.append(h('div', { class: 'wdsp-sub' },
      h('span', { class: 'wdsp-chip', title: 'Which plugin defines her — her durable identity' },
        npc.plugin || '?'),
      h('span', { class: 'wdsp-chip dim' }, npc.localId || '?'),
      h('span', { class: 'wdsp-chip' + (on && live ? ' good' : ' dim'),
        title: on ? live + ' of ' + items.length + ' grant(s) will be handed to her at the next launch'
                  : 'Her gear is switched off — none of these are distributed' },
        on ? live + ' of ' + items.length + ' on' : items.length + ' held, all off')));
    head.append(idBox);

    var acts = h('div', { class: 'wdsp-acts' });
    /* ＋ Add gear (2026-08-20). Until now the ONLY way to grant anything was
       the inbox chest on her F7 card: you had to be standing in front of her
       AND already own the item. So "give her the wig I have not crafted yet",
       or granting from this page at all, was impossible. The picker is the
       Finder's own index (hd-itempick.js), so it searches every item in the
       load order, and the grant is made from identity — no physical object
       changes hands. */
    acts.append(h('button', {
      class: 'wdsp-add', type: 'button',
      title: 'Search every item in the load order and enforce one on ' +
        (npc.name || 'her') + ' — no need to be near her, or to own it',
      onClick: function (e) { e.stopPropagation(); openAddFor(npc); },
    }, '＋ Add gear'));
    acts.append(toggle(on, on ? 'Enforced' : 'Paused',
      on ? 'Pause every grant for ' + (npc.name || 'her') + ' — kept in the list, none distributed'
         : 'Enforce ' + (npc.name || 'her') + '’s grants again from the next launch',
      function (e) { e.stopPropagation(); sendEnableNpc(npc, !on); redraw(); }));
    acts.append(h('button', {
      class: 'wdsp-forget' + (isArmed ? ' armed' : ''), type: 'button',
      title: isArmed ? 'Click again to forget all ' + items.length + ' grant(s) for good'
                     : 'Forget every grant for ' + (npc.name || 'her') + ' — use Pause to keep them',
      onClick: function (e) {
        e.stopPropagation();
        if (isArmed) { disarm(); sendForgetNpc(npc); }
        else arm('armedNpc', nkey);
        redraw();
      },
    }, isArmed ? 'Forget all?' : '✕ Forget all'));
    head.append(acts);
    card.append(head);

    var rows = h('div', { class: 'wdsp-items' });
    items.forEach(function (it) { rows.append(itemRow(npc, it, q)); });
    card.append(rows);
    return card;
  }

  function redraw() {
    if (ctx && typeof ctx.render === 'function') ctx.render();
  }

  function render(hostCtx) {
    ctx = hostCtx || ctx;
    var list = ctx && ctx.list;
    if (!list) return 0;
    var q = ui.filter;

    var shown = state.npcs.filter(function (n) { return matches(n, q); });

    var head = h('div', { class: 'wdsp-bar' },
      h('span', { class: 'wdsp-bar-lbl' }, '📦 Permanent gear'),
      h('span', { class: 'wdsp-bar-note', title:
        'Grants are written as real SPID lines into ' + state.ini + ' and handed out by '
        + 'Spell Perk Item Distributor when the game STARTS — a change here takes effect '
        + 'at your next launch, not now.' },
        state.lines + ' line' + (state.lines === 1 ? '' : 's') + ' live · applies at next launch'),
      h('button', { class: 'wdsp-refresh', type: 'button',
        title: 'Re-read the grant list from the game',
        onClick: function (e) { e.stopPropagation(); request(); } }, '⟳ Refresh'));
    list.append(head);

    if (!state.npcs.length) {
      list.append(h('div', { class: 'wdsp-empty' },
        h('div', { class: 'wdsp-empty-ic' }, '📦'),
        h('div', { class: 'wdsp-empty-h' },
          state.loaded ? 'Nobody has permanent gear yet' : 'Asking the game…'),
        h('div', { class: 'wdsp-empty-p' },
          'Look at someone in game, press F7, and click 📦 next to Inventory and Spare. '
          + 'A chest opens: drop in the wig, the ring, the armour she should ALWAYS have, '
          + 'then close it. Your items come straight back, and she is handed a copy at '
          + 'every game launch from then on. They all show up here.')));
      return 0;
    }

    if (!shown.length) {
      list.append(h('div', { class: 'wdsp-empty' },
        h('div', { class: 'wdsp-empty-ic' }, '⌕'),
        h('div', { class: 'wdsp-empty-h' }, 'Nothing matches “' + q + '”'),
        h('div', { class: 'wdsp-empty-p' }, 'Search covers her name, the item names and the plugins.')));
      return 0;
    }

    shown.forEach(function (npc) { list.append(npcCard(npc, q)); });
    return shown.length;
  }

  /* --------------------------------------------------------- lifecycle -- */

  function init() {
    /* CHAIN the receiver — hd-spidgear.js (the modal) owns the same name, and
       a second assignment would silently unplug it (one name per direction). */
    var prev = window.sgAllState;
    window.sgAllState = function (payload) {
      try { receive(payload); } finally {
        if (typeof prev === 'function') prev(payload);
      }
    };
    /* sgFacesData is OURS alone (no other surface asks for grant faces), but
       it is chained on the same principle anyway: a future owner appearing
       above us must not be unplugged by this line. */
    var prevFaces = window.sgFacesData;
    window.sgFacesData = function (payload) {
      try { receiveFaces(payload); } finally {
        if (typeof prevFaces === 'function') prevFaces(payload);
      }
    };
    request();
  }

  function onEnter() { disarm(); request(); requestFaces(); }

  function setFilter(q) { ui.filter = String(q || '').trim().toLowerCase(); }

  /* --------------------------------------------------------- omni hook -- */

  /* Landing on THIS page from anywhere. It is a SUB-tab of the Wardrobe, never
     a button in the deck's top nav, so omni's tab fallback cannot reach it and
     a result that merely opened the Wardrobe would drop you on whichever
     section you happened to use last — a worse answer than no result.
     Two things the ordering has to survive. app.js's setTab() returns early
     when its tab is already open, so switching the sub cannot rely on it. And
     the host re-pushes ITS filter into every sub-tab on each render, so the
     query belongs in the Wardrobe's own search box: setting ours alone is wiped
     by the very repaint that would show it. */
  function showSub(q) {
    var host = window.WardrobePane;
    var text = String(q == null ? '' : q);
    if (host && host._ui) host._ui.sub = 'spid';
    onEnter();                    // disarm anything half-armed, re-ask the roster
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('wardrobe');
    /* The Wardrobe's own omni provider is the single implementation of "put
       this in the wardrobe search box and repaint" — filter, input value and
       render, in the order the host needs them. Without it (a harness, or a
       boot where the host has not registered yet) we still filter and redraw,
       so the landing is never a silent no-op. */
    var wardrobe = (window.HDOmni && typeof window.HDOmni.providerById === 'function')
      ? window.HDOmni.providerById('wardrobe') : null;
    if (wardrobe && typeof wardrobe.setFilter === 'function') wardrobe.setFilter(text);
    else { setFilter(text); redraw(); }
  }

  function omniIndex() {
    var out = [];
    var people = state.npcs.length;
    /* The page itself, first. Every other row here is named after an item or a
       person, so without this one nothing in the deck answers "spid",
       "permanent gear", "grant" or "enforce" — the words this whole feature is
       built around, and the ones someone hunting for it would actually type. */
    out.push({
      label: 'Permanent gear — SPID grants',
      detail: people
        ? people + (people === 1 ? ' person · ' : ' people · ') + state.lines +
          ' line' + (state.lines === 1 ? '' : 's') + ' live · applies at next launch'
        : 'Nobody has permanent gear yet — the page explains how to grant some',
      kind: 'wardrobe',
      keywords: 'spid permanent gear grant grants granted enforce enforced wig wigs ' +
        'distr ini distribution distributed always wears forever wardrobe',
      pin: 'spid:page',
      run: function () { showSub(''); },
    });
    state.npcs.forEach(function (npc) {
      var items = npc.items || [];
      var live = items.filter(function (it) { return it.enabled !== false; }).length;
      /* Her card, by her name. "What is Lydia permanently granted" used to
         depend on one of her item names happening to match, and the two verbs
         that live on the card — pause everything, forget everything — had no
         name at all in search. */
      out.push({
        label: npc.name || 'Unnamed',
        detail: 'Permanent gear · ' + (npc.enabled === false
          ? items.length + ' grant' + (items.length === 1 ? '' : 's') + ' held, all paused'
          : live + ' of ' + items.length + ' at next launch'),
        kind: 'person',
        keywords: 'spid permanent gear grant enforce enforced pause paused forget ' +
          (npc.plugin || ''),
        pin: 'spid:' + keyOf(npc),
        snap: { name: npc.name || '' },
        run: function () { showSub(npc.name || ''); },
      });
      items.forEach(function (it) {
        out.push({
          label: (it.name || 'Grant') + ' → ' + (npc.name || 'someone'),
          detail: 'SPID gear · ' + (it.enabled === false || npc.enabled === false ? 'off' : 'on'),
          keywords: 'spid gear permanent ' + (npc.plugin || '') + ' ' + (it.plugin || ''),
          pin: 'spid:' + keyOf(npc) + '|' + keyOf(it),
          snap: { name: it.name || '' },
          /* Filtered to the ITEM rather than to her: the search that found this
             row was about the thing, and her card sits one line above it in the
             filtered page either way. */
          run: function () { showSub(it.name || ''); },
        });
      });
    });
    return out;
  }

  /* ------------------------------------------------------------ export -- */

  var api = {
    id: 'spid',
    label: 'SPID',
    init: init,
    onEnter: onEnter,
    count: count,
    render: render,
    setFilter: setFilter,
    /* ---- the door other surfaces come in through (2026-08-20) ----------
       The Wigs tab and the F7 card both want "enforce THIS on HER, then show
       me where that lives". They must not learn the sgAdd payload shape:
       this page owns the grant contract, and a second copy of it elsewhere
       is how the item-id-vs-hex mistakes get made.
         enforce({npc:{plugin,localId,name} | formId, item:{plugin,localId,name}, count?})
       `formId` is the crosshair's RUNTIME id — the DLL resolves her durable
       identity from it, so a caller that only has a live actor is fine.
       `show` opens the page, optionally filtered to a name. */
    enforce: function (req) {
      if (!req || !req.item || !req.item.plugin) return false;
      var it = req.item;
      toGame('sgAdd', JSON.stringify({
        npcPlugin: (req.npc && req.npc.plugin) || '',
        npcLocal: (req.npc && req.npc.localId) || '',
        npcName: (req.npc && req.npc.name) || '',
        formId: req.formId || 0,
        itemPlugin: it.plugin,
        itemLocal: HDItemPickLocal(it),
        itemName: it.name || '',
        count: Math.max(1, Math.min(999, (req.count | 0) || 1)),
        chance: 100,
      }));
      return true;
    },
    show: showSub,
    /* exposed for the harness */
    _state: state, _ui: ui, _receive: receive, _keyOf: keyOf,
    _addGrant: addGrant, _openAddFor: openAddFor, _receiveFaces: receiveFaces,
    _faces: function () { return faces; }, _requestFaces: requestFaces,
    _matches: matches, _npcCard: npcCard, _itemRow: itemRow, _faceEl: faceEl,
    _countLive: countLive, _omniIndex: omniIndex, _showSub: showSub,
    _setCtx: function (c) { ctx = c; },
  };

  if (window.WardrobePane && typeof window.WardrobePane.registerSub === 'function')
    window.WardrobePane.registerSub(api);

  if (window.HDOmni && typeof window.HDOmni.register === 'function') {
    window.HDOmni.register({
      /* The label is the group heading omni prints above these rows. It was
         missing, and the heading is rendered verbatim — so every SPID result
         sat under a blank line with a bare count beside it, looking like rows
         nobody owned. */
      id: 'spidgear', label: 'SPID gear', tab: 'wardrobe',
      warm: function () { request(); },
      /* A jump (Shift+Enter, or the shelf's tab-jump) has to land on the SPID
         sub-tab as well — the Wardrobe tab on its own would show whichever
         section was open last. */
      setFilter: function (q) { showSub(q); },
      /* Shelf activation for a pin whose live row has not warmed in yet: her
         page, filtered to the name the pin remembered, beats a dead button. */
      pinRun: function (snap) { showSub((snap && snap.name) || ''); },
      index: omniIndex,
    });
  }

  return api;
})();
