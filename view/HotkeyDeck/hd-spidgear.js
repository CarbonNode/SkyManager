'use strict';

/* ====================================================================== *
 *  SPID Gear manager — every permanent grant, one modal.
 *
 *  Rober's ask (2026-08-09): F7 on an NPC → a button that opens a chest;
 *  whatever goes in becomes a SPID mod line that re-applies at every
 *  launch — "and a manager UI too in game of history / showing the npc,
 *  can see the items, etc."  The per-NPC half lives on the F7 quick card
 *  (followers-pane.js, sg* bridge). THIS file is the roster: every NPC
 *  that has grants, her items, counts, the date each grant was recorded,
 *  a chance slider per item, and removal — searchable, because past ~10
 *  rows an unsearchable list is a defect (standing UI rule #4).
 *
 *  Shape: a sibling of the Formation modal (hd-formation.js) — an
 *  absolute inset-0 backdrop INSIDE #panel (inherits --ui-scale, clips to
 *  the window), flex-centered box, z-index 74. Own sheet hd-spidgear.css,
 *  linked from index.html — never merged into app.css (sync_view_frags
 *  truncation trap).
 *
 *  Bridge (one name per direction): sgAll → sgAllState. Mutations reuse
 *  the card's sgRemove/sgChance (keyed by DURABLE npc identity, so a row
 *  about someone not currently loaded still works); after each mutation
 *  the modal re-asks ~350 ms later and lands on the DLL's truth.
 * ====================================================================== */

(function () {
  var S = {
    open: false,
    data: null,        // last sgAllState payload
    loading: false,
    filter: '',
    armedKey: '',      // two-click remove: "npcKey|itemKey" of the armed row
    armedAt: 0,
  };

  var el = null;
  var chanceTimers = {};   // itemKey -> debounce timer for the slider

  function toGameSafe(fn, arg) {
    if (typeof window.toGame === 'function') window.toGame(fn, arg);
  }
  function say(msg) {
    if (typeof window.toast === 'function') window.toast(msg);
  }

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
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  function ensureDom() {
    if (el && el.isConnected) return el;
    var panel = document.getElementById('panel') || document.body;
    el = h('div', { id: 'sg-modal', class: 'hidden' });
    el.addEventListener('mousedown', function (e) {
      if (e.button === 0 && e.target === el) close();
    });
    panel.appendChild(el);
    return el;
  }

  function request() {
    S.loading = true;
    toGameSafe('sgAll', '{}');
  }

  window.sgAllState = function (payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
    if (!d || typeof d !== 'object') return;
    S.data = d;
    S.loading = false;
    if (S.open) render();
  };

  function keyOf(o) { return String(o.plugin || '').toLowerCase() + '|' + String(o.localId || ''); }

  function match(n, q) {
    if (!q) return true;
    if (String(n.name || '').toLowerCase().indexOf(q) !== -1) return true;
    for (var i = 0; i < (n.items || []).length; i++)
      if (String(n.items[i].name || '').toLowerCase().indexOf(q) !== -1) return true;
    return false;
  }

  /* ------------------------------------------------------------ render -- */

  function itemRow(npc, it) {
    var ikey = keyOf(npc) + '|' + keyOf(it);
    var armed = S.armedKey === ikey && (Date.now() - S.armedAt < 4000);

    var pct = h('span', { class: 'sg-pct' }, String(it.chance) + '%');
    var range = h('input', {
      type: 'range', class: 'sg-range', min: '5', max: '100', step: '5',
      value: String(it.chance),
      title: 'Chance she actually receives this each time SPID hands gear out '
        + '(per launch). 100% = always.',
    });
    range.addEventListener('input', function () {
      var v = parseInt(range.value, 10) || 100;
      pct.textContent = String(v) + '%';
      it.chance = v;
      clearTimeout(chanceTimers[ikey]);
      chanceTimers[ikey] = setTimeout(function () {
        toGameSafe('sgChance', JSON.stringify({
          npcPlugin: npc.plugin, npcLocalId: npc.localId,
          plugin: it.plugin, localId: it.localId, chance: v,
        }));
      }, 300);
    });
    if (typeof window.hdSmoothRange === 'function') window.hdSmoothRange(range);

    return h('div', { class: 'sg-item' },
      h('span', { class: 'sg-item-name', title: (it.name || '(unnamed item)')
        + '\n' + it.plugin + ' | ' + it.localId }, it.name || '(unnamed item)'),
      it.count > 1 ? h('span', { class: 'sg-count' }, '×' + it.count) : null,
      it.when ? h('span', { class: 'sg-when', title: 'Recorded ' + it.when }, it.when) : null,
      range, pct,
      h('button', {
        class: 'sg-x' + (armed ? ' armed' : ''), type: 'button',
        title: armed ? 'Click again — removes the grant from the ini'
          : 'Stop granting this (the copy she already has stays with her)',
        onClick: function () {
          if (armed) {
            S.armedKey = ''; S.armedAt = 0;
            toGameSafe('sgRemove', JSON.stringify({
              npcPlugin: npc.plugin, npcLocalId: npc.localId,
              plugin: it.plugin, localId: it.localId,
            }));
            setTimeout(request, 350);
          } else {
            S.armedKey = ikey; S.armedAt = Date.now();
            render();
            setTimeout(function () { if (S.open) render(); }, 4200);
          }
        },
      }, armed ? 'Remove?' : '✕'));
  }

  function render() {
    var root = ensureDom();
    root.textContent = '';
    var box = h('div', { class: 'sg-box', role: 'dialog', 'aria-label': 'SPID Gear manager' });
    root.appendChild(box);

    var d = S.data;
    var npcs = (d && d.npcs) || [];

    box.append(h('div', { class: 'sg-head' },
      h('span', { class: 'sg-title' }, '📦 SPID Gear'),
      h('span', { class: 'sg-chip' }, String(npcs.length) + ' NPC' + (npcs.length === 1 ? '' : 's')),
      h('button', {
        class: 'sg-close', type: 'button', title: 'Close (Esc)',
        onClick: function () { close(); },
      }, '✕')));

    box.append(h('div', { class: 'sg-note' },
      'Permanent gear, granted through a real SPID ini ('
      + ((d && d.ini) || 'HotkeyDeckGear_DISTR.ini')
      + ') — changes apply at the NEXT game launch.'));

    /* Search — always present once there is anything to search. */
    if (npcs.length) {
      var input = h('input', {
        class: 'sg-search', type: 'text', spellcheck: 'false', autocomplete: 'off',
        placeholder: 'Type to filter — NPC or item name…',
        value: S.filter,
      });
      input.addEventListener('input', function () {
        S.filter = input.value;
        paintList();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
      });
      box.append(h('div', { class: 'sg-search-row' }, input));
      setTimeout(function () { try { input.focus(); } catch (_) {} }, 0);
    }

    var body = h('div', { class: 'sg-body' });
    box.append(body);

    function paintList() {
      body.textContent = '';
      if (S.loading && !d) {
        body.append(h('div', { class: 'sg-empty' },
          h('div', { class: 'sg-empty-ic' }, '📦'),
          h('div', { class: 'sg-empty-t' }, 'Asking the game…')));
        return;
      }
      if (!npcs.length) {
        body.append(h('div', { class: 'sg-empty' },
          h('div', { class: 'sg-empty-ic' }, '📦'),
          h('div', { class: 'sg-empty-t' }, 'No grants yet'),
          h('div', { class: 'sg-empty-d' },
            'Look at someone, press F7, hit the 📦 button on her card, '
            + 'then “Add items” — whatever you put in the chest '
            + 'becomes hers at every launch.')));
        return;
      }
      var q = S.filter.trim().toLowerCase();
      var shown = 0;
      for (var i = 0; i < npcs.length; i++) {
        var n = npcs[i];
        if (!match(n, q)) continue;
        shown++;
        var sec = h('div', { class: 'sg-npc' });
        sec.append(h('div', { class: 'sg-npc-head' },
          h('span', { class: 'sg-npc-name', title: n.plugin + ' | ' + n.localId },
            n.name || '(unnamed)'),
          h('span', { class: 'sg-npc-count' },
            String((n.items || []).length) + ' item' + ((n.items || []).length === 1 ? '' : 's'))));
        for (var k = 0; k < (n.items || []).length; k++)
          sec.append(itemRow(n, n.items[k]));
        body.append(sec);
      }
      if (!shown)
        body.append(h('div', { class: 'sg-empty' },
          h('div', { class: 'sg-empty-t' }, 'Nothing matches “' + S.filter + '”')));
    }
    paintList();
  }

  /* ------------------------------------------------------------ public -- */

  function open() {
    S.open = true;
    S.filter = '';
    S.armedKey = '';
    ensureDom().classList.remove('hidden');
    toGameSafe('hdCapture', '1');   // digits must not quick-fire under the modal
    request();
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
    if (e.key === 'Escape' || e.code === 'Escape') {
      /* The search input handles its own Esc (stopPropagation) — reaching
         here means the modal itself should close. */
      close();
      return true;
    }
    return false;   // the search box and sliders keep their native keys
  }

  window.HDSpidGear = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    onKey: onKey,
    refresh: request,
    _state: S,        // harness introspection only
    _render: render,  // harness
  };
})();
