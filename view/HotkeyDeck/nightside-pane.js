/* =====================================================================
 *  Nightside tab — the three curses (nightside-pane.css owns the looks).
 *
 *  Rober, 2026-09-14: "new pages / tabs that appear only if you are a
 *  werewolf, lich, vampire. … You can be all 3 i think (with mods) so
 *  allow all 3. visually stunning and maybe the overaching page can be
 *  called something clever."
 *
 *  The page is a TRIPTYCH: one altar lane per curse the player actually
 *  holds, and nothing at all when they hold none (the tab itself is gated
 *  away by app.js's requiresState, the live twin of the SYS_TABS `requires`
 *  mod gate — see tabAvailable()).
 *
 *  Every lane is driven by one hue, set as custom properties on the lane
 *  element (the --dm-hue / --ct-hue idiom). Palette values are explicit
 *  rather than color-mix()'d: this renderer is Ultralight, color-mix is
 *  barely exercised anywhere in the deck, and a dropped colour function
 *  fails SILENTLY — a translucent rgba layered over the carved plate gets
 *  the same picture with none of the risk.
 *
 *  It implements NO actions. Every button casts a power the player already
 *  knows, through the bridge to SpellActions::Cast — which already owns the
 *  voice-slot road that Beast Form, Vampire Lord and the Lich Transformation
 *  all need. Same law as the party-order actions and the Mounts tab.
 *
 *  Host contract (mirrors MountsPane): NightsidePane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ===================================================================== */
window.NightsidePane = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------- palette -- */
  /* hue  = the accent itself          lit  = brighter, for lit glyphs
     edge = accent blended into the plate border (precomputed solid)
     soft/wash/wash2 = the same accent at 30% / 22% / 9%
     mute = the accent muted toward the deck's dim grey, for a DORMANT lane */
  var PALETTE = {
    vampire: {
      hue: '#b3202f', lit: '#e2515e', edge: '#6d2f38', mute: '#a0555c',
      soft: 'rgba(179,32,47,.30)', wash: 'rgba(179,32,47,.22)', wash2: 'rgba(179,32,47,.09)'
    },
    werewolf: {
      hue: '#9fb4d4', lit: '#dceaf9', edge: '#56606f', mute: '#8d99ac',
      soft: 'rgba(159,180,212,.28)', wash: 'rgba(159,180,212,.20)', wash2: 'rgba(159,180,212,.08)'
    },
    lich: {
      hue: '#8b6bd6', lit: '#c3affa', edge: '#5a4a7a', mute: '#8a80a6',
      soft: 'rgba(139,107,214,.30)', wash: 'rgba(139,107,214,.22)', wash2: 'rgba(139,107,214,.09)'
    }
  };
  function paletteFor(id) { return PALETTE[id] || PALETTE.vampire; }

  function applyHue(el, id) {
    var p = paletteFor(id);
    el.style.setProperty('--ns-hue', p.hue);
    el.style.setProperty('--ns-lit', p.lit);
    el.style.setProperty('--ns-edge', p.edge);
    el.style.setProperty('--ns-mute', p.mute);
    el.style.setProperty('--ns-soft', p.soft);
    el.style.setProperty('--ns-wash', p.wash);
    el.style.setProperty('--ns-wash2', p.wash2);
  }

  /* ----------------------------------------------------------- sigils -- */
  /* Heraldic, not illustrative — they are carved marks on an altar plate,
     and they have to stay legible at 20px in the header crest. currentColor
     throughout so one CSS rule lights them. */
  var SIGIL = {
    /* a drop of blood, with the two fangs that took it */
    vampire:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 2.8c0 0 6.9 7.9 6.9 12.1a6.9 6.9 0 0 1-13.8 0C5.1 10.7 12 2.8 12 2.8Z"/>' +
      '<path d="M9.3 14.6a2.9 2.9 0 0 0 2.4 3.4"/></svg>',
    /* the moon, and what went through it */
    werewolf:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M15.8 2.6a9.4 9.4 0 1 0 0 18.8 7.6 7.6 0 0 1 0-18.8Z"/>' +
      '<path d="M14.6 6.1 20.4 9"/><path d="M14.2 10.4 21 12.4"/><path d="M14.6 14.7 20.4 16"/>' +
      '</svg>',
    /* the crowned skull — you did not catch this one, you chose it */
    lich:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 4.1c-4.3 0-7.4 3.1-7.4 7.2 0 2.5 1.2 4.1 2.4 5.1.5.4.8.9.8 1.6v.8a1.4 1.4 0 0 0 1.4 1.4h5.6a1.4 1.4 0 0 0 1.4-1.4v-.8c0-.7.3-1.2.8-1.6 1.2-1 2.4-2.6 2.4-5.1 0-4.1-3.1-7.2-7.4-7.2Z"/>' +
      '<circle cx="9.1" cy="11.4" r="1.7"/><circle cx="14.9" cy="11.4" r="1.7"/>' +
      '<path d="M12 14.4v2"/><path d="M4.9 4.4 6.8 6.2"/><path d="M19.1 4.4 17.2 6.2"/>' +
      '</svg>'
  };
  /* The medallion art (Rober, 2026-09-14: "can we generate some interesting
     art of each 3 instead of just emojis … something that fits the circles
     nicely, not overly detailed, but visually interesting"). One heraldic
     enamel roundel per curse — flat two-tone figure, near-black field, thin
     gold rim — generated through the deck's own Forge pipeline and checked at
     86 / 48 / 34 px before shipping, which is why they are bold silhouettes
     and not illustrations. They already CARRY their own rim and field, so the
     medallion well just clips them to its circle.
     PLAIN paths, no ?v= query — Ultralight drops the query and fails the load
     (the same trap the follower portraits hit). The SIGIL line-art stays as
     the automatic fallback: remove-on-error, so a missing PNG degrades to the
     vector mark instead of an empty hole. */
  var ART = {
    vampire: 'icons/custom/ns-blood.png',
    werewolf: 'icons/custom/ns-moon.png',
    lich: 'icons/custom/ns-bone.png'
  };

  /* art <img> over the vector sigil; onerror drops the img and leaves the
     sigil showing underneath. */
  function markHtml(id, cls) {
    var art = ART[id];
    var h = SIGIL[id] || '';
    if (art) {
      h += '<img class="' + cls + '" src="' + art + '" alt="" draggable="false"' +
           ' onerror="this.parentNode &amp;&amp; this.parentNode.removeChild(this)">';
    }
    return h;
  }

  /* one generic mark for a kit tile — the power's own art lives in the
     Spell Deck's icon pool, which is a different view folder and therefore
     an explicitly unverified path from here (the shelf learned that). */
  var GLYPH_HAND =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3.2 14.3 9l6.1.5-4.6 4 1.4 5.9L12 16.3 6.8 19.4l1.4-5.9-4.6-4L9.7 9Z"/></svg>';
  var GLYPH_VOICE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 9.5v5h3.4L12 18.6V5.4L7.4 9.5Z"/>' +
    '<path d="M15.6 9a4.2 4.2 0 0 1 0 6"/><path d="M18.2 6.6a7.7 7.7 0 0 1 0 10.8"/></svg>';
  var GLYPH_LOCK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4.6" y="10.4" width="14.8" height="10.4" rx="2.2"/>' +
    '<path d="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/></svg>';
  var GLYPH_TREE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="4.4" r="2.2"/><circle cx="5.6" cy="14" r="2.2"/>' +
    '<circle cx="18.4" cy="14" r="2.2"/><circle cx="12" cy="20.4" r="2.2"/>' +
    '<path d="M10.6 6.2 7 12.2"/><path d="M13.4 6.2 17 12.2"/>' +
    '<path d="M6.9 15.9 10.7 19"/><path d="M17.1 15.9 13.3 19"/></svg>';
  var GLYPH_SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2' +
    'M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/></svg>';
  var GLYPH_MOON_SM =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 14.2A8.4 8.4 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2Z"/></svg>';

  /* ------------------------------------------------------------ state -- */

  var st = { any: false, sun: null, forms: [] };
  var ui = { visible: false, q: '', tick: null, toastT: null,
             /* per-section collapse + filter, session-scoped on purpose: a
                persisted slice would need the shelf blob and this is a
                browsing convenience, not a setting. */
             secOpen: {}, secQ: {}, focusSec: '',
             /* '' = the triptych overview; otherwise the one curse whose
                dedicated page is open (Rober, 2026-09-14: "dedicated pages for
                it? Like you click one and it expands to show just 1"). */
             focus: '' };

  /* A section longer than this collapses itself (Rober, 2026-09-14: "anything
     that expands to far - in a chevron and searchable") and grows its own
     filter box. The Blood kit is ~120 rows once Sacrosanct's spells fold in,
     which is exactly the case this exists for. */
  var SEC_COLLAPSE_OVER = 12;
  var SEC_SEARCH_OVER   = 10;

  function secIsOpen(id, count) {
    /* A global search must never hide its own results behind a collapsed
       chevron — while the top bar has a query, every section is open. */
    if (ui.q) return true;
    /* On a curse's own page there is room, so sections start open unless the
       reader has since closed one by hand. */
    if (ui.focus && !Object.prototype.hasOwnProperty.call(ui.secOpen, id)) return true;
    if (Object.prototype.hasOwnProperty.call(ui.secOpen, id)) return !!ui.secOpen[id];
    return count <= SEC_COLLAPSE_OVER;      // short sections stay open
  }
  function secQuery(id) { return ui.secQ[id] || ''; }

  var CHEV = '<svg class="ns-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 6l6 6-6 6"/></svg>';

  /* One collapsible section: chevron head with a live count, optional filter
     box, then the body. `count` is the FULL item count (so the head can say
     how much is hidden); `shownCount` is what survived the filters. */
  function sectionHtml(id, title, count, shownCount, bodyHtml, unit) {
    var open = secIsOpen(id, count);
    var q = secQuery(id);
    var h = '<div class="ns-sec' + (open ? ' open' : '') + '" data-sec="' + esc(id) + '">';
    h += '<button class="ns-sec-head" type="button" data-sectog="' + esc(id) + '"' +
         ' aria-expanded="' + open + '" title="' + (open ? 'Collapse' : 'Expand') + ' ' + esc(title) + '">' +
         CHEV + '<span class="ns-sec-title">' + esc(title) + '</span>' +
         '<span class="ns-sec-count">' +
         ((q || ui.q) && shownCount !== count ? shownCount + ' of ' + count : count) +
         ' ' + esc(unit || '') + '</span></button>';
    if (open) {
      h += '<div class="ns-sec-body">';
      if (count > SEC_SEARCH_OVER) {
        h += '<div class="ns-sec-search"><span aria-hidden="true">&#8981;</span>' +
             '<input type="text" data-secq="' + esc(id) + '" value="' + esc(q) + '"' +
             ' placeholder="Filter ' + esc(title.toLowerCase()) + '"' +
             ' autocomplete="off" spellcheck="false" aria-label="Filter ' + esc(title) + '"></div>';
      }
      h += bodyHtml + '</div>';
    }
    h += '</div>';
    return h;
  }

  /* Local ring clock. C++ sends remaining seconds at the moment it built
     the payload; between pushes we step it down ourselves so a ring cannot
     sit frozen on screen. Stepped at the tick, never animated — the hotbar's
     own rule. */
  var lastStamp = 0;

  function elapsedSince() {
    return lastStamp ? (Date.now() - lastStamp) / 1000 : 0;
  }

  /* ---------------------------------------------------------- receive -- */

  window.nsStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    st = {
      any: !!d.any,
      sun: d.sun || null,
      forms: Array.isArray(d.forms) ? d.forms : []
    };
    lastStamp = Date.now();
    render();
  };

  window.nsActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (d.ok && d.act === 'glob') {
      /* patch the row we just wrote instead of re-reading every lane */
      for (var i = 0; i < st.forms.length; i++) {
        var a = st.forms[i].adv;
        if (!a || a.plugin !== d.plugin) continue;
        var n = 0;
        for (var r = 0; r < a.rows.length; r++) {
          if (a.rows[r].id === d.id) {
            a.rows[r].value = d.value;
            a.rows[r].changed = Math.abs(d.value - a.rows[r].def) > 0.0001;
          }
          if (a.rows[r].changed) n++;
        }
        a.changed = n;
      }
      if (d.msg) toast(d.msg, false);
      render();
      return;
    }
    if (d.msg) toast(d.msg, !d.ok);
    /* a cast that landed changes what is running — re-ask, but only if we
       are still the tab on screen. */
    if (d.ok && ui.visible) setTimeout(function () { ask(); }, 350);
  };

  /* In the deck's own dev preview (index.html?dev=1) there is no game to
     answer nsState, so the pane answers itself with the demo triptych — the
     same mock road every other pane's dev mode takes. */
  function devMode() {
    try { return /[?&]dev=1/.test(location.search); } catch (e) { return false; }
  }

  function ask() {
    if (devMode()) { setTimeout(demo, 60); return; }
    toGame('nsState', '');
  }

  /* ------------------------------------------------------------ toast -- */

  function toast(msg, err) {
    var t = $('ns-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.borderColor = err ? '#6d2027' : '#3a3a44';
    t.classList.remove('hidden');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.add('hidden'); }, 3400);
  }

  /* ----------------------------------------------------------- render -- */

  function matches(text) {
    if (!ui.q) return true;
    return String(text || '').toLowerCase().indexOf(ui.q) !== -1;
  }

  /* A lane survives the filter if its own names match, or any kit row does.
     Typing "howl" should leave Moon standing with only its howls. */
  function laneMatches(f) {
    if (!ui.q) return true;
    if (matches(f.lane) || matches(f.name) || matches(f.source) || matches(f.shape)) return true;
    var kit = f.kit || [];
    for (var i = 0; i < kit.length; i++) if (kitMatches(kit[i])) return true;
    return false;
  }

  /* A tile matches on its NAME or its footnote — vanilla's "Animal Vigor"
     is a howl and says so only in the note, so a search for "howl" that
     dropped it would be lying about the kit. */
  function kitMatches(row) {
    return matches(row.name) || matches(row.note);
  }

  /* The sky chip states the HOUR and whether you are under a roof — always
     true, always safe to say. It turns red ONLY on `sun.burning`, which C++
     sets from a live sun-damage effect rather than from the clock (Rober,
     2026-09-14: "what if i get a vampire ability qwhere i can be in sun, we
     are assuming a lot"). Standing in daylight unharmed therefore reads as a
     plain fact, and the panel never claims immunity either — an overhaul with
     its own sun-damage spell would not be in the detected set. */
  function sunHtml() {
    var s = st.sun;
    if (!s) return '';
    var burning = !!s.burning;
    var hour = (typeof s.hour === 'number' && s.hour >= 0)
      ? (Math.floor(s.hour) + ':' + (('0' + Math.floor((s.hour % 1) * 60)).slice(-2)))
      : '—';
    var where = s.interior ? 'indoors' : 'outside';
    var glyph = s.day ? GLYPH_SUN : GLYPH_MOON_SM;
    var line = burning
      ? '<b>' + hour + '</b> · the sun is burning you'
      : '<b>' + hour + '</b> · ' + (s.day ? 'daylight' : 'night') + ', ' + where;
    var tip = burning
      ? (s.burnSrc ? s.burnSrc + ' is running on you right now'
                   : 'A sun-damage effect is running on you right now')
      : 'The hour, and whether you are under the sky' +
        (s.exposed ? ' — you are in daylight, but nothing is burning you that the deck can see' : '');
    return '<div class="ns-sky' + (burning ? ' burning' : '') + '" title="' + esc(tip) + '">' +
      glyph + '<span>' + line + '</span></div>';
  }

  function hasForm(id) {
    for (var i = 0; i < st.forms.length; i++) if (st.forms[i].id === id) return true;
    return false;
  }
  function isAwake(id) {
    for (var i = 0; i < st.forms.length; i++) {
      if (st.forms[i].id === id) return !!st.forms[i].awake;
    }
    return false;
  }

  function crestHtml() {
    var order = ['vampire', 'werewolf', 'lich'];
    var out = '';
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var held = hasForm(id), awake = isAwake(id);
      var p = paletteFor(id);
      var cls = 'ns-crest-mark' + (awake ? ' awake' : (held ? ' held' : '')) +
                (ui.focus === id ? ' on' : '');
      var title = held
        ? (awake ? laneName(id) + ' — awake right now' : laneName(id) + ' — held, mortal shape')
        : laneName(id) + ' — not yours';
      if (held) title += ' · click to open its page';
      /* A held curse's sigil is also the switch to its page; one you do not
         carry stays inert rather than opening an empty page. */
      out += (held
          ? '<button type="button" class="' + cls + '" data-focus="' + esc(id) + '"'
          : '<span class="' + cls + '"') +
        ' style="--ns-hue:' + p.hue + '" title="' + esc(title) + '">' +
        markHtml(id, 'ns-crest-art') +
        (held ? '</button>' : '</span>');
    }
    return out;
  }

  function laneName(id) {
    return id === 'vampire' ? 'Blood' : id === 'werewolf' ? 'Moon' : 'Bone';
  }

  function summaryLine() {
    if (ui.focus) {
      for (var k = 0; k < st.forms.length; k++) {
        if (st.forms[k].id !== ui.focus) continue;
        var ff = st.forms[k];
        return ff.awake
          ? '<b>Awake</b> — you are wearing this shape right now.'
          : 'Held — you are wearing your own face.';
      }
    }
    var n = st.forms.length;
    var awake = 0;
    for (var i = 0; i < st.forms.length; i++) if (st.forms[i].awake) awake++;
    if (!n) return 'Nothing has its teeth in you.';
    var word = n === 1 ? 'curse' : 'curses';
    var head = '<b>' + n + '</b> ' + word + ' held';
    if (awake === 0) return head + ' · none awake — you are wearing your own face.';
    if (awake === n && n > 1) return head + ' · <b>all of them awake</b>.';
    return head + ' · <b>' + awake + '</b> awake right now.';
  }

  function ringStyle(row) {
    if (typeof row.fxRem !== 'number' || typeof row.fxDur !== 'number' || row.fxDur <= 0) return null;
    var rem = row.fxRem - elapsedSince();
    if (rem <= 0) return null;
    var spent = 1 - (rem / row.fxDur);
    if (spent < 0) spent = 0;
    if (spent > 1) spent = 1;
    return { turn: spent.toFixed(4) + 'turn', rem: rem };
  }

  function tileHtml(row, formId) {
    var known = row.known !== false;
    var voice = row.slot === 'voice';
    var ring = known ? ringStyle(row) : null;
    var cls = 'ns-tile' + (known ? '' : ' locked');
    var title = known
      ? (voice ? 'Power — cast it (closes the palette)' : 'Spell — cast it (closes the palette)')
      : 'You have not learned this yet';
    if (row.note) title = row.note + ' — ' + title;

    var h = '<button class="' + cls + '" type="button" title="' + esc(title) + '"' +
      (known ? ' data-cast="1"' : ' disabled aria-disabled="true"') +
      ' data-plugin="' + esc(row.plugin || '') + '"' +
      ' data-local="' + esc(row.localId != null ? row.localId : '') + '"' +
      ' data-fid="' + esc(row.formId != null ? row.formId : '') + '"' +
      ' data-name="' + esc(row.name || '') + '">';
    h += '<span class="ns-tile-orb">';
    if (ring) h += '<span class="ns-ring" style="--ns-spent:' + ring.turn + '"></span>';
    h += (voice ? GLYPH_VOICE : GLYPH_HAND) + '</span>';
    if (ring) h += '<span class="ns-tile-cd">' + Math.ceil(ring.rem) + 's</span>';
    if (!known) h += '<span class="ns-tile-lock" title="Not learned yet">' + GLYPH_LOCK + '</span>';
    h += '<span class="ns-tile-name">' + esc(row.name || '—') + '</span>';
    h += '<span class="ns-tile-slot">' + (voice ? 'Power' : 'Spell') + '</span>';
    h += '</button>';
    return h;
  }

  function verbHtml(ref, kind) {
    if (!ref) return '';
    var known = ref.known !== false;
    var label = (kind === 'primary' ? '' : '') + esc(ref.name || (kind === 'primary' ? 'Transform' : 'Revert'));
    var cls = 'ns-verb' + (kind === 'primary' ? ' primary' : '');
    var glyph = kind === 'primary' ? GLYPH_VOICE : '';
    return '<button class="' + cls + '" type="button"' +
      (known ? ' data-cast="1"' : ' disabled aria-disabled="true"') +
      ' title="' + (known ? esc((ref.name || '') + ' — casts it and closes the palette')
        : 'You do not know this power') + '"' +
      ' data-plugin="' + esc(ref.plugin || '') + '"' +
      ' data-local="' + esc(ref.localId != null ? ref.localId : '') + '"' +
      ' data-fid="' + esc(ref.formId != null ? ref.formId : '') + '"' +
      ' data-name="' + esc(ref.name || '') + '">' + glyph + '<span>' + label + '</span></button>';
  }

  /* The curse's Custom Skills Framework tree: its real level and unspent
     points, and the button that opens it. A curse with no tree draws nothing
     at all — better than a dead button — and a tree whose mod is installed but
     not loaded says exactly that. */
  /* Sacrosanct's own readouts: the blood meter (Wassail), its blood-magic
     track, vampire age, and Blue Blood — the quest of powerful mortals worth
     draining. Drawn only when Sacrosanct is actually loaded. */
  /* Rules and perks render identically for any overhaul, so both lanes share
     these rather than growing a second copy. */
  function rulesSection(id, title, rules) {
    if (!rules || !rules.length) return '';
    var q = secQuery(id).toLowerCase();
    var shown = rules.filter(function (r) {
      return !q || String(r.k).toLowerCase().indexOf(q) !== -1;
    });
    var body = '<button type="button" class="ns-mcm-open" data-mcm=""' +
      ' title="Open every mod setting in the load order">&#9881; All mod settings</button>' +
      '<div class="ns-rule-note">These are the mod\'s own MCM switches — clicking one ' +
      'writes the setting directly. A plain flag takes immediately; one whose MCM does ' +
      'extra work on change (re-applying abilities, refreshing perks) is better flipped ' +
      'in &#9881; All mod settings, which drives the mod\'s own MCM handler.</div>';
    if (shown.length) {
      body += '<div class="ns-rules">';
      for (var i = 0; i < shown.length; i++) {
        var r = shown[i], addressable = typeof r.i === 'number';
        body += (addressable
            ? '<button type="button" class="ns-rule' + (r.on ? ' on' : '') +
              '" data-rule="' + r.i + '" data-on="' + (r.on ? '1' : '0') +
              '" title="Click to turn ' + (r.on ? 'off' : 'on') + '">'
            : '<span class="ns-rule' + (r.on ? ' on' : '') + '">') +
          esc(r.k) + '<b>' + (r.on ? 'on' : 'off') + '</b>' +
          (addressable ? '</button>' : '</span>');
      }
      body += '</div>';
    } else {
      body += '<div class="ns-sec-empty">No rule matches.</div>';
    }
    return sectionHtml(id, title, rules.length, shown.length, body, 'switches');
  }

  function perksSection(id, title, pk) {
    if (!pk || !pk.total) return '';
    var q = secQuery(id).toLowerCase();
    var names = (pk.names || []).filter(function (n) {
      return !q || String(n).toLowerCase().indexOf(q) !== -1;
    });
    var body = '<div class="ns-subnote">' + pk.total + ' perks in this tree</div>';
    if (names.length) {
      body += '<div class="ns-chips">';
      for (var i = 0; i < names.length; i++) body += '<span class="ns-chip on">' + esc(names[i]) + '</span>';
      body += '</div>';
    } else {
      body += '<div class="ns-sec-empty">' + (pk.owned ? 'No perk matches.' : 'None taken yet.') + '</div>';
    }
    return sectionHtml(id, title, pk.names ? pk.names.length : 0, names.length, body, 'taken');
  }

  /* The overhaul's passives — what the curse is doing to you permanently.
     Read-only by nature: these are abilities, not things you cast. */
  function passivesSection(id, title, names) {
    if (!names || !names.length) return '';
    var q = secQuery(id).toLowerCase();
    var shown = names.filter(function (n) {
      return !q || String(n).toLowerCase().indexOf(q) !== -1;
    });
    var body = '<div class="ns-subnote">Always on while you carry this curse.</div>';
    if (shown.length) {
      body += '<div class="ns-chips">';
      for (var i = 0; i < shown.length; i++) body += '<span class="ns-chip on">' + esc(shown[i]) + '</span>';
      body += '</div>';
    } else {
      body += '<div class="ns-sec-empty">No passive matches.</div>';
    }
    return sectionHtml(id, title, names.length, shown.length, body, 'active');
  }

  function questsSection(id, title, quests, running, total) {
    if (!quests || !quests.length) return '';
    var q = secQuery(id).toLowerCase();
    var shown = quests.filter(function (x) {
      return !q || String(x.name).toLowerCase().indexOf(q) !== -1;
    });
    var body = '<div class="ns-subnote">' + (running || 0) + ' of ' +
      (total || quests.length) + ' under way</div>';
    if (shown.length) {
      body += '<div class="ns-quests">';
      for (var i = 0; i < shown.length; i++) {
        var x = shown[i];
        body += '<span class="ns-quest' + (x.running ? ' on' : '') + '">' + esc(x.name) +
          '<b>' + (x.running ? 'stage ' + x.stage : 'not started') + '</b></span>';
      }
      body += '</div>';
    } else {
      body += '<div class="ns-sec-empty">No quest matches.</div>';
    }
    return sectionHtml(id, title, quests.length, shown.length, body, 'quests');
  }

  /* Growl's readouts for the Moon lane — the same shapes Sacrosanct uses. */
  function growlHtml(f) {
    var g = f.grw;
    if (!g || !g.present) return '';
    var h = '<div class="ns-overhaul">';

    /* the cooldown meter: this is the thing the lane used to have to shrug
       about, so it leads */
    var b = g.beast || {};
    if (typeof b.cdLeft === 'number' && b.cdTotal > 0) {
      var pct = Math.max(0, Math.min(100, Math.round((1 - b.cdLeft / b.cdTotal) * 100)));
      h += '<div class="ns-meter" title="Growl replaces vanilla\'s once-a-day rule with a cooldown">' +
        '<div class="ns-meter-top"><span>Beast form</span><b>' +
        Math.ceil(b.cdLeft) + 's to go</b></div>' +
        '<div class="ns-meter-bar"><span style="width:' + pct + '%"></span></div></div>';
    } else if (b.cooling) {
      h += '<div class="ns-vitals"><span class="ns-vital warn"><i>Beast form</i><b>cooling down</b></span></div>';
    }

    var chips = '';
    if (typeof b.duration === 'number')
      chips += '<span class="ns-vital"><i>Lasts</i><b>' + b.duration + 's' +
        (b.perFeed ? ' +' + b.perFeed + '/feed' : '') + '</b></span>';
    if (typeof b.cooldown === 'number' && !(typeof b.cdLeft === 'number'))
      chips += '<span class="ns-vital"><i>Cooldown</i><b>' + b.cooldown + 's</b></span>';
    if (g.call && typeof g.call.now === 'number')
      chips += '<span class="ns-vital"><i>Call of the Blood</i><b>' + g.call.now + '%</b></span>';
    if (g.night)
      chips += '<span class="ns-vital"><i>Night</i><b>' + g.night.start + ':00–' + g.night.end + ':00</b></span>';
    if (g.werebear === true)  chips += '<span class="ns-vital"><i>Totem</i><b>Werebear</b></span>';
    if (g.xp && typeof g.xp.weapon === 'number')
      chips += '<span class="ns-vital"><i>Weapon xp</i><b>' + g.xp.weapon +
        (g.xp.weaponMult && g.xp.weaponMult !== 1 ? ' ×' + g.xp.weaponMult : '') + '</b></span>';
    if (chips) h += '<div class="ns-vitals">' + chips + '</div>';

    h += passivesSection('growl-passives', 'Beastblood passives', g.passives);
    h += perksSection('growl-perks', 'Growl perks', g.perks);
    h += rulesSection('growl-rules', 'Growl rules', g.rules);
    h += '</div>';
    return h;
  }

  /* Undeath's readouts for the Bone lane. It publishes almost no settings, so
     this is mostly its questline — which is what the mod actually is. */
  /* An EDID is not a label. Strip the mod's prefix, drop the word Global,
     split the remaining CamelCase/underscores into words. */
  function prettyEdid(e) {
    var t = String(e || '');
    t = t.replace(/^(SCS|HRI|Necro)_?/, '')
         .replace(/^(Mechanics|Abilities|Events|Lycan|Mortal|PerkTree|VampireSpells|VampireLord|VampireLordDark|Help|Hemomancy|Racial|Vanilla|Power)_/gi, '')
         .replace(/_?Global_?/gi, '_')
         .replace(/_+/g, ' ')
         .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
         .trim();
    return t || e;
  }

  /* Every global the overhaul publishes — raw, collapsed, and resettable.
     The curated switches above are the safe surface; this is the rest of the
     MCM, and it says so. */
  function advancedHtml(f) {
    var a = f.adv;
    if (!a || !a.rows || !a.rows.length) return '';
    var id = f.id + '-adv';
    var q = secQuery(id).toLowerCase();
    var rows = a.rows.filter(function (r) {
      if (!q) return true;
      return prettyEdid(r.edid).toLowerCase().indexOf(q) !== -1 ||
             String(r.edid).toLowerCase().indexOf(q) !== -1;
    });

    var body = '<div class="ns-note">Every setting this mod publishes, straight from its ' +
      'plugin. The switches above are the safe ones; most of these are raw tuning that ' +
      'nothing validates — but each remembers the value the mod shipped, so ↺ always ' +
      'puts it back.' + (a.changed ? ' <b>' + a.changed + ' differ from default.</b>' : '') +
      '</div>';

    if (rows.length) {
      body += '<div class="ns-advs">';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        /* step by something sensible for the magnitude: fine for fractions,
           whole numbers for counts */
        var mag = Math.abs(r.value) < 2 && Math.abs(r.def) < 2 ? 0.05 : 1;
        var dn = Math.round((r.value - mag) * 1000) / 1000;
        var up = Math.round((r.value + mag) * 1000) / 1000;
        body += '<div class="ns-adv' + (r.changed ? ' changed' : '') + '">' +
          '<span class="ns-adv-name" title="' + esc(r.edid) + '">' + esc(prettyEdid(r.edid)) + '</span>' +
          '<span class="ns-step">' +
            '<button type="button" data-glob="' + esc(a.plugin) + '" data-gid="' + r.id +
              '" data-gv="' + dn + '" title="Down">&#8722;</button>' +
            '<b>' + r.value + '</b>' +
            '<button type="button" data-glob="' + esc(a.plugin) + '" data-gid="' + r.id +
              '" data-gv="' + up + '" title="Up">&#43;</button>' +
          '</span>';
        if (r.changed) {
          body += '<button type="button" class="ns-adv-reset" data-glob="' + esc(a.plugin) +
            '" data-gid="' + r.id + '" data-gv="' + r.def +
            '" title="Put back what the mod shipped (' + r.def + ')">&#8634;</button>';
        }
        body += '</div>';
      }
      body += '</div>';
    } else {
      body += '<div class="ns-sec-empty">No setting matches.</div>';
    }
    return sectionHtml(id, 'Advanced — all ' + (f.lane === 'Blood' ? 'Sacrosanct' :
      f.lane === 'Moon' ? 'Growl' : 'Undeath') + ' settings',
      a.rows.length, rows.length, body, 'globals');
  }

  function undeathHtml(f) {
    var u = f.und;
    if (!u || !u.present) return '';
    var h = '<div class="ns-overhaul">';

    var chips = '';
    if (typeof u.phylactery === 'number' && u.phylactery > 0)
      chips += '<span class="ns-vital"><i>Phylactery</i><b>' + u.phylactery + '</b></span>';
    if (u.blackBook === true)
      chips += '<span class="ns-vital"><i>Black Book</i><b>claimed</b></span>';
    if (chips) h += '<div class="ns-vitals">' + chips + '</div>';

    h += questsSection('und-quests', 'Undeath questline', u.quests,
      u.questsRunning, u.questsTotal);

    h += passivesSection('und-passives', 'Lich passives', u.passives);
    h += perksSection('und-perks', 'Undeath perks', u.perks);

    /* Undeath publishes no setting GLOBALS, so there is no inline rules
       section here and the lane says why rather than leaving a suspicious gap
       where the other two have one. It may still register a SkyUI MCM, which
       the settings popout now drives directly (skyui_mcm.cpp) — so point
       there instead of claiming its options are unreachable. */
    if (u.noSettings)
      h += '<div class="ns-note">Undeath publishes no setting globals to switch from here — ' +
           'its options live in its own SkyUI MCM, which is readable in ' +
           '<button type="button" class="ns-inline-mcm" data-mcm="undeath">' +
           '&#9881; All mod settings</button>.</div>';
    h += '</div>';
    return h;
  }

  function sacHtml(f) {
    var sc = f.sac;
    if (!sc || !sc.present) return '';
    var h = '<div class="ns-overhaul">';

    if (sc.wassail && sc.wassail.cap > 0) {
      var w = sc.wassail, pct = Math.max(0, Math.min(100, Math.round(w.cur / w.cap * 100)));
      h += '<div class="ns-meter" title="Wassail — Sacrosanct\'s blood meter">' +
           '<div class="ns-meter-top"><span>Blood</span><b>' + w.cur + ' / ' + w.cap + '</b></div>' +
           '<div class="ns-meter-bar"><span style="width:' + pct + '%"></span></div></div>';
    }

    var chips = '';
    if (sc.hemomancy) {
      chips += '<span class="ns-vital"><i>Hemomancy</i><b>' + (sc.hemomancy.n | 0) + '</b>' +
        (typeof sc.hemomancy.steps === 'number'
          ? '<span class="ns-stage-word">' + sc.hemomancy.steps + '/' + sc.hemomancy.toNext + '</span>' : '') +
        '</span>';
    }
    if (sc.age) chips += '<span class="ns-vital"><i>Age</i><b>' + sc.age.cur + ' / ' + sc.age.next + '</b></span>';
    if (sc.sunOff) chips += '<span class="ns-vital"><i>Sun</i><b>damage off</b></span>';
    if (chips) h += '<div class="ns-vitals">' + chips + '</div>';

    /* your bloodline — Sacrosanct's per-race power, detected by which record
       you actually carry rather than guessed from your race name */
    if (sc.bloodline && sc.bloodline.length) {
      h += '<div class="ns-blood-line">';
      for (var bi = 0; bi < sc.bloodline.length; bi++) {
        var bl = sc.bloodline[bi];
        var ready = bl.ready;
        h += '<div class="ns-bl' + (ready === false ? ' spent' : '') + '">';
        h += '<span class="ns-bl-race">' + esc(bl.race) + ' blood</span>';
        h += '<span class="ns-bl-name">' + esc(bl.name) + '</span>';
        if (ready === true)  h += '<span class="ns-bl-tag ready">ready</span>';
        if (ready === false) h += '<span class="ns-bl-tag">spent</span>';
        if (bl.known && bl.formId != null) {
          h += '<button class="ns-bl-cast" type="button" data-cast="1"' +
               ' data-plugin="' + esc(bl.plugin || '') + '"' +
               ' data-local="' + esc(bl.localId || 0) + '"' +
               ' data-fid="' + esc(bl.formId) + '"' +
               ' title="Cast ' + esc(bl.castName || bl.name) + '">Cast</button>';
        }
        h += '</div>';
      }
      h += '</div>';
    }

    /* the hunters hunting you */
    if (sc.hunter) {
      var hu = sc.hunter, hc = '';
      if (typeof hu.killed === 'number')
        hc += '<span class="ns-vital"><i>Hunters killed</i><b>' + hu.killed + '</b></span>';
      if (typeof hu.chance === 'number')
        hc += '<span class="ns-vital"><i>Hunted</i><b>' + hu.chance + '%</b></span>';
      if (hu.cooldown > 0)
        hc += '<span class="ns-vital"><i>Hunt cooldown</i><b>' + hu.cooldown + '</b></span>';
      if (hc) h += '<div class="ns-vitals">' + hc + '</div>';
    }

    /* Amaranth + what a feed is worth */
    var ac = '';
    if (sc.amaranth && typeof sc.amaranth.xp === 'number')
      ac += '<span class="ns-vital"><i>Amaranth</i><b>' + sc.amaranth.xp + ' xp</b></span>';
    if (sc.feed && typeof sc.feed.lethalBase === 'number')
      ac += '<span class="ns-vital"><i>Lethal feed</i><b>' + sc.feed.lethalBase +
            ' + ' + (sc.feed.lethalLevel || 0) + '/lvl</b></span>';
    if (sc.feed && typeof sc.feed.bloodKnight === 'number')
      ac += '<span class="ns-vital"><i>Blood Knight</i><b>' + sc.feed.bloodKnight + '</b></span>';
    if (ac) h += '<div class="ns-vitals">' + ac + '</div>';

    h += perksSection('sac-perks', 'Sacrosanct perks', sc.perks);

    h += questsSection('sac-quests', 'Sacrosanct quests', sc.quests,
      sc.questsRunning, sc.questsTotal);
    h += passivesSection('sac-passives', 'Vampiric passives', sc.passives);

    h += rulesSection('sac-rules', 'Sacrosanct rules', sc.rules);

    var bb = sc.blueBlood;
    if (bb && bb.marks && bb.marks.length) {
      var bbId = 'blueblood';
      var bq = secQuery(bbId).toLowerCase();
      var marks = bb.marks.filter(function (m) {
        return !bq || String(m.name || '').toLowerCase().indexOf(bq) !== -1;
      });
      var body = '<div class="ns-subnote" title="These are the quest\'s own alias slots. ' +
        'The deck reports whether each is currently tracked; it cannot tell from the record ' +
        'alone whether you have already drained them.">' +
        bb.filled + ' of ' + bb.total + ' tracked</div>';
      if (marks.length) {
        body += '<div class="ns-chips">';
        for (var i = 0; i < marks.length; i++) {
          body += '<span class="ns-chip' + (marks[i].filled ? ' on' : '') + '">' +
                  esc(marks[i].name) + '</span>';
        }
        body += '</div>';
      } else {
        body += '<div class="ns-sec-empty">No mark matches.</div>';
      }
      h += sectionHtml(bbId, bb.name || 'Blue Blood', bb.marks.length, marks.length, body, 'marks');
    }
    h += '</div>';
    return h;
  }

  function treeHtml(f) {
    var t = f.tree;
    if (!t) return '';
    var ok = t.ok !== false;
    var bits = '';
    if (typeof t.level === 'number')
      bits += '<span class="ns-tree-stat"><i>Level</i><b>' + t.level + '</b></span>';
    if (typeof t.points === 'number' && t.points > 0)
      bits += '<span class="ns-tree-stat unspent"><i>Unspent</i><b>' + t.points +
              (t.points === 1 ? ' point' : ' points') + '</b></span>';

    var h = '<div class="ns-tree' + (ok ? '' : ' off') + '">';
    h += '<div class="ns-tree-id">';
    h += '<span class="ns-tree-glyph">' + GLYPH_TREE + '</span>';
    h += '<span class="ns-tree-names"><b>' + esc(t.name || 'Skill tree') + '</b>';
    h += '<i>' + (ok ? 'Custom Skills tree' : esc(t.msg || 'not loaded')) + '</i></span>';
    h += '</div>';
    if (bits) h += '<div class="ns-tree-stats">' + bits + '</div>';
    if (ok) {
      h += '<button class="ns-tree-open" type="button" data-tree="' + esc(f.id) + '"' +
           ' title="Open the ' + esc(t.name || 'skill') + ' perk tree (closes the deck)">Open tree</button>';
    }
    h += '</div>';
    return h;
  }

  /* ratio/progress is deliberately NOT drawn as a bar here: CSF reports it as
     a 0..1 fraction toward the NEXT level, and a bar without a number reads as
     overall completion, which it is not. */

  /* Short chips first, the long sentence LAST. A warning chip is a whole
     sentence and a chip after it gets orphaned onto a row of its own with the
     rest of that row empty (Rober, 2026-09-14: "i really dont like empty
     space … after nord"). Ordering the wide one last means the wrap happens
     after everything short has paired up, and .ns-vital grows to fill the
     slack so no row ends ragged. */
  function vitalsHtml(f) {
    var out = '';
    out += '<span class="ns-vital"><i>Shape</i><b>' + esc(f.shape || '—') + '</b></span>';
    if (f.race) out += '<span class="ns-vital"><i>Race</i><b>' + esc(f.race) + '</b></span>';
    if (typeof f.kitHave === 'number' && f.kit)
      out += '<span class="ns-vital"><i>Kit</i><b>' + f.kitHave + ' of ' + f.kit.length + '</b></span>';
    if (f.cooling) out += '<span class="ns-vital warn"><i>Cooldown</i><b>still cooling</b></span>';
    if (f.warn) out += '<span class="ns-vital warn wide"><i>Sun</i><b>' + esc(f.warn) + '</b></span>';
    return out;
  }

  function stageHtml(f) {
    if (!f.stage) return '';
    /* Sacrosanct publishes its own stage and an xp fraction toward the next
       one, so there are no four notches to draw — the notches exist only for
       vanilla, where four stage abilities really is all the data there is. */
    if (f.stage.src === 'sacrosanct') {
      var sx = '<span class="ns-vital ns-stage" title="Sacrosanct\'s own progression stage">' +
        '<i>Stage</i><b>' + (f.stage.n | 0) + '</b>';
      if (typeof f.stage.xp === 'number' && f.stage.toNext > 0) {
        var pct = Math.max(0, Math.min(100, Math.round(f.stage.xp / f.stage.toNext * 100)));
        sx += '<span class="ns-xp" title="' + f.stage.xp + ' of ' + f.stage.toNext +
              ' toward the next stage"><span class="ns-xp-fill" style="width:' + pct + '%"></span></span>' +
              '<span class="ns-stage-word">' + f.stage.xp + '/' + f.stage.toNext + '</span>';
      }
      return sx + '</span>';
    }
    var n = f.stage.n | 0, of = f.stage.of | 0 || 4;
    var pips = '';
    for (var i = 1; i <= of; i++) pips += '<span class="ns-stage-pip' + (i <= n ? ' on' : '') + '"></span>';
    /* The certain fact is WHICH stage ability is live, so that leads; the word
       is vanilla's flavour for that stage and follows it. An overhaul can
       rename its stages, but it cannot change which of the four is running. */
    var lab = esc(f.stage.label || '');
    return '<span class="ns-vital ns-stage" title="Which of the four vampirism stage ' +
      'abilities is currently running on you"><i>Hunger</i>' +
      '<span class="ns-stage-pips">' + pips + '</span>' +
      '<b>Stage ' + n + '</b>' + (lab ? '<span class="ns-stage-word">' + lab + '</span>' : '') +
      '</span>';
  }

  function laneHtml(f) {
    var awake = !!f.awake;
    var cls = 'ns-lane held' + (awake ? ' awake' : '');
    var h = '<section class="' + cls + '" data-form="' + esc(f.id) + '" aria-label="' + esc(f.lane) + '">';

    h += '<div class="ns-lane-head">';
    /* the head is the way in to this curse's own page (a real button, so it is
       keyboard reachable); in focus mode it is already open, so it goes inert */
    var openable = !ui.focus;
    h += openable
      ? '<button type="button" class="ns-lane-open" data-focus="' + esc(f.id) +
        '" title="Open the ' + esc(f.lane) + ' page">'
      : '<div class="ns-lane-open static">';
    h += '<div class="ns-medal">' + markHtml(f.id, 'ns-medal-art') + '</div>';
    h += '<div class="ns-lane-id">';
    h += '<div class="ns-lane-lane">' + esc(f.lane || '') + '</div>';
    h += '<div class="ns-lane-name">' + esc(f.name || '') + '</div>';
    h += '<div class="ns-lane-src" title="' + esc(f.source || '') + '">' + esc(f.source || '') + '</div>';
    h += '</div>';
    if (openable) h += '<span class="ns-lane-go" aria-hidden="true">' + CHEV + '</span>';
    h += openable ? '</button>' : '</div>';
    h += '<span class="ns-state">' + (awake ? 'AWAKE' : 'DORMANT') + '</span>';
    h += '</div>';

    h += '<div class="ns-vitals">' + stageHtml(f) + vitalsHtml(f) + '</div>';

    var verbs = verbHtml(f.primary, 'primary') + verbHtml(f.revert, 'revert');
    if (verbs) h += '<div class="ns-verbs">' + verbs + '</div>';

    h += sacHtml(f);
    h += growlHtml(f);
    h += undeathHtml(f);
    h += advancedHtml(f);
    h += treeHtml(f);

    if (f.unknown) h += '<div class="ns-note">' + esc(f.unknown) + '</div>';

    var all = f.kit || [];
    var secId = f.id + '-kit';
    var sq = secQuery(secId).toLowerCase();
    var kit = all.filter(function (r) {
      if (ui.q && !kitMatches(r)) return false;
      if (sq) {
        var hay = String(r.name || '') + ' ' + String(r.note || '');
        if (hay.toLowerCase().indexOf(sq) === -1) return false;
      }
      return true;
    });
    if (all.length) {
      var body = '';
      if (kit.length) {
        body += '<div class="ns-kit">';
        for (var i = 0; i < kit.length; i++) body += tileHtml(kit[i], f.id);
        body += '</div>';
      } else {
        body += '<div class="ns-sec-empty">Nothing in this kit matches.</div>';
      }
      h += sectionHtml(secId, f.lane + ' kit', all.length, kit.length, body, 'powers');
    }

    h += '</section>';
    return h;
  }

  function render() {
    var pane = $('ns-pane');
    if (!pane) return;

    var sub = $('ns-sub');
    if (sub) sub.innerHTML = summaryLine();
    var crest = $('ns-crest');
    if (crest) crest.innerHTML = crestHtml();
    var sky = $('ns-sky-slot');
    if (sky) sky.innerHTML = sunHtml();

    var lanes = $('ns-lanes');
    var empty = $('ns-empty');
    if (!lanes || !empty) return;

    if (!st.forms.length) {
      lanes.innerHTML = '';
      empty.classList.remove('hidden');
      lanes.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    lanes.classList.remove('hidden');

    /* A focused curse gets the page to itself; the crest above stays as the
       switch between them. A focus on a curse that is no longer held (cured
       mid-session) falls back to the overview rather than showing nothing. */
    var focused = null;
    if (ui.focus) {
      for (var fi = 0; fi < st.forms.length; fi++)
        if (st.forms[fi].id === ui.focus) focused = st.forms[fi];
      if (!focused) ui.focus = '';
    }

    var shown = focused ? [focused] : st.forms.filter(laneMatches);
    lanes.classList.toggle('ns-one', shown.length === 1);
    lanes.classList.toggle('ns-focused', !!focused);

    var html = '';
    if (focused) {
      html += '<div class="ns-back-bar">' +
        '<button type="button" class="ns-back" data-focus="">' + CHEV +
        '<span>All curses</span></button>' +
        '<span class="ns-back-where">' + esc(focused.lane) + ' — ' + esc(focused.name) + '</span>' +
        '</div>';
    }
    for (var i = 0; i < shown.length; i++) html += laneHtml(shown[i]);
    if (!shown.length) {
      html = '<div id="ns-noresults">Nothing in your curses matches “' + esc(ui.q) + '”.</div>';
    }
    lanes.innerHTML = html;

    /* hues are set as properties, not classes — one lane, one accent */
    var els = lanes.querySelectorAll('.ns-lane');
    for (var j = 0; j < els.length; j++) applyHue(els[j], els[j].getAttribute('data-form'));

    restoreSecFocus();
  }

  /* Ring-only repaint. A full render() on every tick would drop the focus
     ring off a tile mid-press and reset the scroll — the tab-scale card
     lesson. */
  function tickRings() {
    var lanes = $('ns-lanes');
    if (!lanes) return;
    var forms = st.forms;
    for (var i = 0; i < forms.length; i++) {
      var kit = forms[i].kit || [];
      for (var k = 0; k < kit.length; k++) {
        var row = kit[k];
        if (typeof row.fxRem !== 'number') continue;
        var sel = '.ns-lane[data-form="' + forms[i].id + '"] .ns-tile[data-fid="' +
          (row.formId != null ? row.formId : '') + '"]';
        var tile = lanes.querySelector(sel);
        if (!tile) continue;
        var ring = tile.querySelector('.ns-ring');
        var cd = tile.querySelector('.ns-tile-cd');
        var r = ringStyle(row);
        if (!r) {
          if (ring) ring.parentNode.removeChild(ring);
          if (cd) cd.parentNode.removeChild(cd);
          continue;
        }
        if (ring) ring.style.setProperty('--ns-spent', r.turn);
        if (cd) cd.textContent = Math.ceil(r.rem) + 's';
      }
    }
  }

  function startTick() {
    stopTick();
    ui.tick = setInterval(function () {
      if (!ui.visible) return;
      tickRings();
    }, 1000);
  }
  function stopTick() { if (ui.tick) { clearInterval(ui.tick); ui.tick = null; } }

  /* --------------------------------------------------------- handlers -- */

  function onClick(e) {
    var foc = e.target && e.target.closest ? e.target.closest('[data-focus]') : null;
    if (foc) {
      ui.focus = foc.getAttribute('data-focus') || '';
      render();
      var pane = $('ns-pane');
      if (pane && pane.scrollTop) pane.scrollTop = 0;
      var l = $('ns-lanes');
      if (l) l.scrollTop = 0;
      return;
    }
    var mcm = e.target && e.target.closest ? e.target.closest('[data-mcm]') : null;
    if (mcm) {
      if (window.HDMcm) HDMcm.open(mcm.getAttribute('data-mcm') || '');
      return;
    }
    var glob = e.target && e.target.closest ? e.target.closest('[data-glob]') : null;
    if (glob) {
      toGame('nsAct', JSON.stringify({
        act: 'glob',
        plugin: glob.getAttribute('data-glob'),
        id: parseInt(glob.getAttribute('data-gid'), 10),
        value: parseFloat(glob.getAttribute('data-gv'))
      }));
      return;
    }
    var rule = e.target && e.target.closest ? e.target.closest('[data-rule]') : null;
    if (rule) {
      toGame('nsAct', JSON.stringify({
        act: 'rule',
        i: parseInt(rule.getAttribute('data-rule'), 10),
        on: rule.getAttribute('data-on') !== '1'      // click = flip
      }));
      return;
    }
    var tog = e.target && e.target.closest ? e.target.closest('[data-sectog]') : null;
    if (tog) {
      var sid = tog.getAttribute('data-sectog');
      /* first click on a never-touched section flips whatever its DEFAULT was,
         so a long collapsed kit opens and a short open one closes */
      var wasOpen = tog.getAttribute('aria-expanded') === 'true';
      ui.secOpen[sid] = !wasOpen;
      render();
      return;
    }
    var tree = e.target && e.target.closest ? e.target.closest('[data-tree]') : null;
    if (tree) {
      toGame('nsAct', JSON.stringify({ act: 'tree', curse: tree.getAttribute('data-tree') }));
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest('[data-cast]') : null;
    if (!btn) return;
    if (btn.hasAttribute('disabled')) return;
    var req = {
      act: 'cast',
      plugin: btn.getAttribute('data-plugin') || '',
      localId: parseInt(btn.getAttribute('data-local'), 10) || 0,
      formId: parseInt(btn.getAttribute('data-fid'), 10) || 0
    };
    toGame('nsAct', JSON.stringify(req));
  }

  function onSearch(e) {
    ui.q = String(e.target.value || '').trim().toLowerCase();
    render();
  }

  /* Section filter boxes live inside the re-rendered lane HTML, so typing in
     one would throw focus away on every keystroke. Remember which section was
     being typed into and restore focus + caret after the render — the same
     problem (and cure) as the tab-scale card. */
  function onSecInput(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var sid = t.getAttribute('data-secq');
    if (!sid) return;
    ui.secQ[sid] = String(t.value || '');
    ui.focusSec = sid;
    render();
  }

  function restoreSecFocus() {
    if (!ui.focusSec) return;
    var el = document.querySelector('[data-secq="' + ui.focusSec + '"]');
    if (!el) { ui.focusSec = ''; return; }
    if (document.activeElement !== el) {
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) {}
    }
  }

  function onKey(e) {
    if (e.key !== 'Enter') return;
    /* Enter = fire the top matching power, the deck's standing bar idiom */
    var lanes = $('ns-lanes');
    if (!lanes) return;
    var first = lanes.querySelector('.ns-tile[data-cast]');
    if (first) first.click();
  }

  /* -------------------------------------------------------- lifecycle -- */

  var inited = false;
  function init() {
    if (inited) return;
    inited = true;
    var s = $('ns-search');
    if (s) {
      s.addEventListener('input', onSearch);
      s.addEventListener('keydown', onKey);
    }
    var lanes = $('ns-lanes');
    if (lanes) {
      lanes.addEventListener('click', onClick);
      lanes.addEventListener('input', onSecInput);
    }
    var crest = $('ns-crest');
    if (crest) crest.addEventListener('click', onClick);
  }

  function onShow() {
    ui.visible = true;
    /* every open lands on the overview — the page you left is rarely the one
       you want next time, and the crest makes getting back one click */
    ui.focus = '';
    ask();
    startTick();
    var s = $('ns-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    render();
  }

  function onHide() {
    ui.visible = false;
    stopTick();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }
  function setFilter(q) {
    ui.q = String(q || '').trim().toLowerCase();
    var s = $('ns-search');
    if (s) s.value = q || '';
    render();
  }

  /* ------------------------------------------------------------ omni -- */
  /* Every power across every lane is findable from Ctrl+F, and Enter casts
     it — the same contract the Spell Deck's omni rows carry. */
  if (window.HDOmni) {
    HDOmni.register({
      id: 'nightside',
      tab: 'nightside',
      label: 'Nightside',
      index: function () {
        var out = [{
          key: 'ns:mcm',
          label: 'Mod settings',
          detail: 'Every MCM setting in the load order',
          kind: 'settings',
          run: function () { if (window.HDMcm) HDMcm.open(''); }
        }];
        for (var i = 0; i < st.forms.length; i++) {
          var f = st.forms[i];
          out.push({
            key: 'ns:' + f.id,
            label: f.lane + ' — ' + f.name,
            detail: f.shape + (f.awake ? ' · awake' : ''),
            kind: 'curse'
          });
          var kit = f.kit || [];
          for (var k = 0; k < kit.length; k++) {
            if (kit[k].known === false) continue;
            out.push({
              key: 'ns:' + f.id + ':' + kit[k].formId,
              label: kit[k].name,
              detail: f.lane + ' kit',
              kind: 'power',
              run: (function (row) {
                return function () {
                  toGame('nsAct', JSON.stringify({
                    act: 'cast', plugin: row.plugin || '',
                    localId: row.localId || 0, formId: row.formId || 0
                  }));
                };
              })(kit[k])
            });
          }
        }
        return out;
      }
    });
  }

  /* ---------------------------------------------------------- harness -- */
  /* ?dev=1&nsdemo=1 mounts the triptych with all three curses held and two
     of them awake, so the looks can be judged out of game. */
  function demo() {
    window.nsStateResult({
      any: true,
      sun: { hour: 13.5, interior: false, day: true, exposed: true,
             burning: true, burnSrc: 'Sun Damage' },
      forms: [
        {
          id: 'vampire', name: 'Vampirism', lane: 'Blood', held: true, awake: true,
          race: 'Nord Vampire', source: 'Sacrosanct — Vampires of Skyrim',
          shape: 'Vampire Lord', stage: { n: 7, xp: 640, toNext: 900, src: 'sacrosanct' },
          warn: 'The sun is burning you.',
          sac: {
            present: true,
            stage: { n: 7, xp: 640, toNext: 900 },
            wassail: { cur: 62, cap: 100 },
            hemomancy: { n: 3, steps: 2, toNext: 4 },
            age: { cur: 96, next: 120 },
            sunOff: false,
            bloodline: [ { race: 'Nord', name: 'From Ancient Soil', ready: true,
                           castName: 'Cold Embrace', plugin: 'Sacrosanct - Vampires of Skyrim.esp',
                           localId: 144237, formId: 9001, known: true } ],
            hunter: { killed: 3, chance: 12, perTest: 2, cooldown: 0, cooldownDur: 5 },
            amaranth: { xp: 450, mult: 2, tradeskills: false },
            feed: { lethalBase: 250, lethalLevel: 25, kissOfDeath: 1, bloodKnight: 100 },
            perks: { total: 64, owned: 3,
                     names: ['Foster Childe', 'Lion Among Sheep', 'Celerity'] },
            questsRunning: 2, questsTotal: 7,
            quests: [ { name: 'The Hunter Hunted', running: true, stage: 30 },
                      { name: 'Fortitude', running: false, stage: 0 },
                      { name: "Vampire's Command", running: true, stage: 20 },
                      { name: 'Wassail', running: false, stage: 0 },
                      { name: 'Sommelier', running: false, stage: 0 },
                      { name: 'Damning Night', running: false, stage: 0 },
                      { name: "Summon to Molag's Court", running: false, stage: 0 } ],
            passives: ['Cold Embrace', 'Predatorial Instincts', 'Vampiric Resilience',
                       'Nightstalker', 'Unnatural Reflexes'],
            rules: [
                     { i: 0, k: 'Feeding blocked', on: false },
                     { i: 1, k: 'Blood potions', on: true },
                     { i: 2, k: 'Drain essential NPCs', on: true },
                     { i: 3, k: 'Vanilla feed', on: false },
                     { i: 4, k: 'Sun damage', on: true },
                     { i: 5, k: 'Beast-form loss', on: true },
                     { i: 6, k: 'Hate (town reactions)', on: true },
                     { i: 7, k: 'Shadow regen', on: false },
                     { i: 8, k: 'Trespassing curse', on: true },
                     { i: 9, k: 'Can die of thirst', on: true },
                     { i: 10, k: 'Fortitude', on: true },
                     { i: 11, k: 'Elemental bias', on: true },
                     { i: 12, k: 'Reversed progression', on: false },
                     { i: 13, k: 'Amaranth allows tradeskills', on: false },
                     { i: 14, k: 'Sneak lethal feed (Wildflowers)', on: false },
                   ],
            blueBlood: { name: 'Blue Blood', running: true, filled: 4, total: 13,
              marks: [ { name: 'Jarl Balgruuf the Greater', filled: true },
                       { name: 'Ulfric Stormcloak', filled: true },
                       { name: 'General Tullius', filled: true },
                       { name: 'Arch-Mage Savos Aren', filled: true },
                       { name: 'Astrid', filled: false },
                       { name: 'Brynjolf', filled: false },
                       { name: 'Harkon', filled: false },
                       { name: 'Paarthurnax', filled: false } ] }
          },
          tree: { id: 'MolagsWillTree', name: 'Vampirism', ok: true, level: 14, ratio: 0.42, points: 2,
                  desc: 'As you drain your foes, your might as a vampire increases…' },
          primary: { name: 'Vampire Lord', plugin: 'Dawnguard.esm', localId: 10299, formId: 33566779, known: true },
          revert: { name: 'Revert Form', plugin: 'Dawnguard.esm', localId: 52572, formId: 33605980, known: true },
          kitHave: 5,
          kit: [
            { name: "Vampire's Bane", plugin: 'Dawnguard.esm', localId: 14518, formId: 1, slot: 'hand', known: true },
            { name: "Vampire's Grip", plugin: 'Dawnguard.esm', localId: 14519, formId: 2, slot: 'hand', known: true, fxRem: 12.4, fxDur: 30 },
            { name: 'Detect Life', plugin: 'Dawnguard.esm', localId: 14520, formId: 3, slot: 'voice', known: true },
            { name: 'Bats', plugin: 'Dawnguard.esm', localId: 14521, formId: 4, slot: 'voice', known: true, note: 'Blood-summoned swarm' },
            { name: 'Mist Form', plugin: 'Dawnguard.esm', localId: 14522, formId: 5, slot: 'voice', known: false, note: 'Untouchable while it lasts' },
            { name: 'Vampiric Drain', plugin: 'Skyrim.esm', localId: 579519, formId: 6, slot: 'hand', known: true },
            { name: 'Raise Thrall', plugin: 'Skyrim.esm', localId: 971940, formId: 7, slot: 'hand', known: false }
          ]
        },
        {
          id: 'werewolf', name: 'Lycanthropy', lane: 'Moon', held: true, awake: false,
          race: 'Nord Vampire', source: 'Growl — Werebeasts of Skyrim', shape: 'Mortal shape',
          stage: null,
          grw: {
            present: true,
            beast: { duration: 150, perFeed: 30, cooldown: 90, cdLeft: 34.5, cdTotal: 90 },
            call: { base: 20, now: 20, wentOff: false },
            night: { start: 19, end: 5 },
            werebear: false, totemCap: 50,
            xp: { weapon: 20, weaponMult: 1, armor: 20, armorMult: 1 },
            passives: ['Beastblood', 'Lycanthropic Speed', 'No fall damage'],
            perks: { total: 38, owned: 4,
                     names: ['Bestial Strength', 'Gorging', 'Totem of the Hunt', 'Savage Feeding'] },
            rules: [ { i: 100, k: 'Werewolf hunters', on: true },
                     { i: 101, k: 'Invulnerable while changing', on: false },
                     { i: 102, k: 'Skip the Beast Form check', on: false } ]
          },
          adv: { plugin: 'Growl - Werebeasts of Skyrim.esp', changed: 1, rows: [
            { edid: 'HRI_Lycan_Global_BeastForm_Duration', id: 2053, value: 210, def: 150, changed: true },
            { edid: 'HRI_Lycan_Global_BeastForm_Cooldown', id: 2145, value: 90, def: 90, changed: false },
            { edid: 'HRI_Mortal_Global_CallOfTheBlood_Chance', id: 2130, value: 20, def: 20, changed: false },
            { edid: 'HRI_Lycan_Global_ArmorXPLevelMult', id: 2116, value: 2, def: 2, changed: false }
          ] },
          primary: { name: 'Beast Form', plugin: 'Skyrim.esm', localId: 601160, formId: 8, known: true },
          kitHave: 3,
          kit: [
            { name: 'Howl of Terror', plugin: 'Skyrim.esm', localId: 850833, formId: 9, slot: 'voice', known: true, note: 'Howl' },
            { name: 'Howl of the Pack', plugin: 'Skyrim.esm', localId: 850845, formId: 10, slot: 'voice', known: true, note: 'Howl' },
            { name: 'Animal Vigor', plugin: 'Skyrim.esm', localId: 843799, formId: 11, slot: 'voice', known: true, note: 'Howl' },
            { name: 'Ring of Hircine', plugin: 'Skyrim.esm', localId: 1016582, formId: 12, slot: 'voice', known: false, note: 'Ring of Hircine — an extra change' }
          ]
        },
        {
          id: 'lich', name: 'Lichdom', lane: 'Bone', held: true, awake: true,
          race: 'Lich', source: 'Undeath — Classical Lichdom', shape: 'Lich',
          stage: null, cooling: true,
          und: {
            present: true, noSettings: true, phylactery: 0, blackBook: false,
            questsRunning: 2, questsTotal: 7,
            quests: [ { name: 'The Path of Transcendance', running: true, stage: 40 },
                      { name: 'In their Footsteps', running: true, stage: 10 },
                      { name: 'Exhuming Power', running: false, stage: 0 },
                      { name: 'Arkay the Enemy', running: false, stage: 0 },
                      { name: 'Infernal Alchemy', running: false, stage: 0 },
                      { name: 'Scourg Barrow', running: false, stage: 0 },
                      { name: 'Black Book: Whispers of the Veil', running: false, stage: 0 } ],
            passives: ['Undeath', 'Unholy Will', 'Dark Resurgence'],
            perks: { total: 8, owned: 2, names: ['Unholy Will', 'Dark Resurgance'] }
          },
          tree: { id: 'PreludeToPurgatory', name: 'Lichdom', ok: false,
                  msg: 'PreludeToPurgatory.esp is not loaded — enable the mod to use this tree.' },
          primary: { name: 'Lich Transformation', plugin: 'Undeath.esp', localId: 42052, formId: 13, known: true },
          revert: { name: 'Revert', plugin: 'Undeath.esp', localId: 81750, formId: 14, known: true },
          kitHave: 4,
          kit: [
            { name: 'Revenant', plugin: 'Undeath.esp', localId: 991885, formId: 15, slot: 'hand', known: true },
            { name: 'Lich Lightning Storm', plugin: 'Undeath.esp', localId: 83132, formId: 16, slot: 'hand', known: true, fxRem: 4.2, fxDur: 12 },
            { name: 'Lich Blizzard', plugin: 'Undeath.esp', localId: 83133, formId: 17, slot: 'hand', known: true },
            { name: 'Lich Fire Storm', plugin: 'Undeath.esp', localId: 83135, formId: 18, slot: 'hand', known: false },
            { name: 'Mass Reanimate', plugin: 'Undeath.esp', localId: 15785, formId: 19, slot: 'hand', known: true },
            { name: 'Etherealize', plugin: 'Undeath.esp', localId: 3394302, formId: 20, slot: 'voice', known: false, note: 'Phylactery' }
          ]
        }
      ]
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.NightsidePane.init(); });
  } else {
    setTimeout(function () { if (window.NightsidePane) window.NightsidePane.init(); }, 0);
  }

  return {
    init: init, onShow: onShow, onHide: onHide, toggleEdit: toggleEdit,
    wantsPause: wantsPause, setFilter: setFilter, demo: demo,
    _state: function () { return st; }
  };
})();
