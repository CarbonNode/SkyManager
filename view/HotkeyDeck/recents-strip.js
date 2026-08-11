'use strict';

/* ====================================================================== *
 *  Recents strip — the people you just did something to.
 *
 *  A thin horizontal band above the roster on the Followers tab. The
 *  roster is filed by CATEGORY, which is the right way to keep 69 people
 *  but the wrong way to get back to the one you summoned ten seconds ago:
 *  she is behind a rail click, a scroll and a scan. This is the shortcut —
 *  click a face, get her action menu, without leaving where you are.
 *
 *  ---- what counts as an interaction ------------------------------------
 *  Anything the deck DID to her: summon / go to / send back, a rename, a
 *  note, an NPC field, map tracking, a re-file, a portrait, a Sharmat
 *  edit. Recorded at the two choke points every one of those already goes
 *  through (sendApply / sendWorld), so a new action is recorded for free
 *  rather than needing to remember to call this.
 *
 *  ---- identity ----------------------------------------------------------
 *  Keyed by `original` (OriginalName || Name) — the same durable identity
 *  the rest of the deck uses. Renaming somebody must not split her into
 *  two entries, and re-filing her must not lose her. cat/idx are stored
 *  too but treated as a HINT: they shift the moment anything is re-filed,
 *  so a click re-resolves by identity and only falls back to the hint.
 *
 *  ---- lifetime ----------------------------------------------------------
 *  In memory, for the session. Deliberately NOT persisted: "who did I just
 *  touch" is a question about right now, the PrismaUI view outlives every
 *  palette open/close (so it survives the whole play session), and
 *  persisting would mean a new slice in hotkeys.json — a DLL change — for
 *  something whose value expires in minutes.
 * ====================================================================== */

var Recents = (function () {
  var MAX = 12;          // more than fits comfortably; the strip scrolls
  var list = [];         // most-recent-first

  /* op -> how to describe it, for the little verb under the name. Unknown
     ops fall through to a generic mark rather than being dropped: a new
     action should show up here the day it is added, not the day someone
     remembers to extend this table. */
  var VERBS = {
    summon: { ic: '⤵', t: 'summoned' },
    goto: { ic: '➜', t: 'went to' },
    sendback: { ic: '⮌', t: 'sent back' },
    renameMember: { ic: '✎', t: 'renamed' },
    setDesc: { ic: '✎', t: 'noted' },
    setField: { ic: '✎', t: 'edited' },
    setFieldByOriginal: { ic: '✎', t: 'edited' },
    setTracked: { ic: '⚑', t: 'tracked' },
    moveMember: { ic: '⇄', t: 'filed' },
    reorderMember: { ic: '⇅', t: 'reordered' },
    addTarget: { ic: '＋', t: 'added' },
    import: { ic: '⚑', t: 'added to NFF' },
    export: { ic: '⚑', t: 'removed from NFF' },
    forceFollower: { ic: '✚', t: 'made recruitable' },
    removeMember: { ic: '✕', t: 'removed' },
    sharmat: { ic: '⚭', t: 'profile' },
    portrait: { ic: '◉', t: 'photo' },
    outfit: { ic: '⛃', t: 'outfit' },
  };
  function verbOf(op) { return VERBS[op] || { ic: '•', t: 'used' }; }

  /* Ops that say nothing about a PERSON and would only add noise — they are
     about the category rail or the tab itself. */
  var IGNORE = {
    renameCategory: 1, setCatMagic: 1, reorderCategory: 1,
    addCategory: 1, deleteCategory: 1,
  };

  /* Record one interaction. `m` is the member object the pane already has;
     everything we keep is copied out of it, so holding this list can never
     pin a stale member object alive across a refresh. */
  function touch(m, op, hint) {
    if (!m || IGNORE[op]) return;
    var id = String((m.original || m.name || '')).trim();
    if (!id) return;

    var e = {
      id: id,
      name: m.name || id,
      op: op,
      cat: hint && hint.cat != null ? hint.cat : null,
      idx: hint && hint.idx != null ? hint.idx : null,
      hue: hint && hint.hue != null ? hint.hue : 0,
      file: hint && hint.file ? hint.file : '',
      mtime: hint && hint.mtime ? hint.mtime : 0,
    };

    // Move-to-front, deduped by identity: interacting with the same person
    // twice must not give her two slots.
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list.splice(i, 1); break; }
    }
    list.unshift(e);
    if (list.length > MAX) list.length = MAX;
  }

  /* Re-resolve every chip's FACE against whatever the caller currently knows.
     touch() snapshots file/mtime, which is right for name/hue (they describe
     the moment you interacted) and WRONG for the portrait: capture a new photo
     of someone already in the strip and the chip kept drawing the file that
     existed when she was added. Rober, 2026-08-02: "recent up top doesnt update
     fast enough (portraits)".
     A callback rather than a portrait map, so this module still knows nothing
     about how portraits are stored or which file wins for a slug. Returning
     null/undefined leaves the entry alone — a resolver that has not loaded yet
     must not blank a face that is already drawing. */
  function refreshFaces(resolve) {
    if (typeof resolve !== 'function') return;
    for (var i = 0; i < list.length; i++) {
      var f = resolve(list[i].id, list[i]);
      if (!f) continue;
      list[i].file = f.file || '';
      list[i].mtime = f.mtime || 0;
      if (f.hue != null) list[i].hue = f.hue;
    }
  }

  function clear() { list = []; }
  function all() { return list.slice(); }
  function count() { return list.length; }

  /* ---------------------------------------------------------------- DOM -- */

  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  function initialsOf(name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    var a = [].concat(Array.from(parts[0]))[0] || '?';
    var b = parts.length > 1 ? ([].concat(Array.from(parts[parts.length - 1]))[0] || '') : '';
    return (a + b).toUpperCase();
  }

  function faceFor(e) {
    if (e.file) {
      /* Same two-step src fallback as the roster row and the Sharmat header:
         Ultralight can treat the ?v= cache-bust as part of the FILENAME, so
         try the query form, retry plain once, then give up to initials. The
         listener STAYS attached across the retry — detaching it is how the
         Sharmat header ended up showing an empty circle for a missing file. */
      var img = h('img', { class: 'rc-face', src: 'portraits/' + e.file + '?v=' + (e.mtime || 0), alt: '', draggable: 'false' });
      img.addEventListener('error', function () {
        if (img.dataset.retried) { img.replaceWith(medal(e)); return; }
        img.dataset.retried = '1';
        img.src = 'portraits/' + e.file;
      });
      img.style.setProperty('--rc-hue', String(e.hue || 0));
      return img;
    }
    return medal(e);
  }
  function medal(e) {
    var s = h('span', { class: 'rc-face initials' }, initialsOf(e.name));
    s.style.setProperty('--rc-hue', String(e.hue || 0));
    return s;
  }

  /* Draw into `host`. `onPick(entry, chipEl)` fires on click — the caller
     owns what "open" means, because only the pane knows how to resolve an
     identity back to a live row and put a menu next to it.

     Returns true if anything was drawn. An EMPTY strip renders nothing at
     all (not an empty box with a label): before you have touched anyone it
     is pure chrome, and the roster is what the tab is for. */
  function render(host, onPick) {
    if (!host) return false;
    host.innerHTML = '';
    if (!list.length) { host.classList.add('hidden'); return false; }
    host.classList.remove('hidden');

    host.append(h('span', { class: 'rc-label' }, 'Recent'));
    var scroller = h('div', { class: 'rc-scroll' });

    list.forEach(function (e) {
      var v = verbOf(e.op);
      var chip = h('button', {
        class: 'rc-chip', type: 'button',
        title: e.name + ' — ' + v.t + (e.name !== e.id ? '\n(CHIM/FO name: ' + e.id + ')' : ''),
        onClick: function (ev) { ev.stopPropagation(); if (onPick) onPick(e, chip); },
      },
        faceFor(e),
        h('span', { class: 'rc-body' },
          h('span', { class: 'rc-name' }, e.name),
          h('span', { class: 'rc-verb' }, v.ic + ' ' + v.t)));
      scroller.append(chip);
    });

    host.append(scroller);
    host.append(h('button', {
      class: 'rc-clear', type: 'button', title: 'Clear the recent list',
      onClick: function (ev) { ev.stopPropagation(); clear(); render(host, onPick); },
    }, '✕'));
    return true;
  }

  return { touch: touch, render: render, refreshFaces: refreshFaces, clear: clear, all: all, count: count, _verbs: VERBS };
})();
