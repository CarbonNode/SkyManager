'use strict';

/* ====================================================================== *
 *  Music — what is playing, and a player for anything else, as a Hotkey
 *  Deck tab (mus- prefix). The whole tab IS a Dwemer radio.
 *
 *  Rober, 2026-10-14: "music controller, see what song is playing in
 *  skymanager, change to any other song searchable, favoritable, hook to
 *  youtube and stream music in game" → "Improve UI" → "Dwemer radio style"
 *  → "Redesign the whole UI so it feels like it's a Dwemer radio" + "Also
 *  add playlist support".
 *
 *  One cabinet, top to bottom, the way a cathedral radio reads:
 *    crown    the brass nameplate (MUSIC), the crest with its amber eye,
 *             and the ON AIR plate (lit while something plays)
 *    dial     the amber glass: a round porthole (the song's picture or the
 *             station's medallion), what you hear, and the tuning scale —
 *             a needle on a printed scale. Streaming, the scale is time and
 *             the needle seeks; on Skyrim's own music the scale is printed
 *             with the five station kinds and the needle points at the one
 *             playing (press a kind to tune it).
 *    speaker  the grille (music-art/grille.jpg). Up next sits on it; an
 *             empty queue lets the grille show through, lit.
 *    drum     the station browser: five band keys (YouTube · Skyrim ·
 *             Playlists · Starred · Recent), the search bar, the list.
 *    plinth   brass transport keys, the volume knob (drag, scroll, arrows),
 *             the repeat selector, the "quiet Skyrim" toggle, the maker's
 *             badge.
 *
 *  Playlists: named lists of songs kept by C++ in music.json. "+ List" on
 *  any song (and on the dial, and "Save as playlist" on the queue or a
 *  search) opens a picker — type to filter, Enter takes the top row, a
 *  name that matches none makes a new list. A playlist opens in its own
 *  popout: rename in place, play, shuffle, queue, reorder, remove, delete.
 *
 *  Bridge (src/music_player.cpp, main.cpp OnJsMu*):
 *    muState({full, plSeq}) -> muStateData({engine,stream,search,favTypes,
 *                       favVideos,recents,settings,tools,muted,plSeq,
 *                       playlists?,types?})   playlists ride along only when
 *                       plSeq differs from what the view holds (or full)
 *    muSet({act,...}) -> muResult({ok,msg,state})
 *  Both replies are response-style (this pane always asks first), so the
 *  pane needs no hd-boot STUB_FNS entry. While the tab is shown it asks for
 *  the light state once a second; hidden, it asks for nothing.
 *
 *  Host contract (mirrors WeatherPane): init() · onShow() · onHide() · onKey(e)
 *  Omni (the deck's Ctrl+F): play/pause, next, stop, release, play starred,
 *  play each playlist, and "Tune to <type>" for every music type.
 * ====================================================================== */

window.MusicPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const POLL_MS = 1000;
  /* Rows drawn per pass; Ultralight lays out every row it is given. */
  const ROW_CAP = 120;
  const ART = 'music-art/';

  /* the band keys: five equal keys, never a wrapping row */
  const MODES = [
    { id: 'yt', label: 'YouTube', title: 'Search YouTube' },
    { id: 'sk', label: 'Skyrim', title: 'Skyrim’s own stations' },
    { id: 'pl', label: 'Playlists', title: 'Your saved playlists' },
    { id: 'fav', label: 'Starred', title: 'Starred songs and stations' },
    { id: 'recent', label: 'Recent', title: 'What you streamed lately' },
  ];
  /* Six equal cells, never a wrapping chip row. "Other" types are in All. */
  const KINDS = [
    { id: 'all', label: 'All', art: 'resonator-64.png' },
    { id: 'explore', label: 'Explore', art: 'st-explore-64.png' },
    { id: 'town', label: 'Towns', art: 'st-town-64.png', title: 'Towns, taverns and halls' },
    { id: 'dungeon', label: 'Dungeons', art: 'st-dungeon-64.png' },
    { id: 'combat', label: 'Combat', art: 'st-combat-64.png' },
    { id: 'moment', label: 'Moments', art: 'st-moment-64.png', title: 'Discoveries, rewards, dragons, death' },
  ];
  /* the five kinds printed on the dial's scale, and where */
  const SCALE = [
    { id: 'explore', label: 'Explore', at: 10 },
    { id: 'town', label: 'Towns', at: 30 },
    { id: 'dungeon', label: 'Dungeons', at: 50 },
    { id: 'combat', label: 'Combat', at: 70 },
    { id: 'moment', label: 'Moments', at: 90 },
  ];
  const KIND_NAME = { explore: 'Explore', town: 'Town', dungeon: 'Dungeon', combat: 'Combat', moment: 'Moment', other: 'Other' };
  const REPEAT = [
    { id: 'off', label: 'Off', deg: -55, title: 'Stop at the end of the queue' },
    { id: 'one', label: 'One', deg: 0, title: 'Play this song again and again' },
    { id: 'all', label: 'All', deg: 55, title: 'Start the queue over at its end' },
  ];
  /* sizes: 'big' = 256 (porthole, popout), default 128 (rows), 'small' = 64
     (plates, Omni) — Ultralight samples with no mipmaps, so each source stays
     within ~3x of the size it is drawn at */
  function medal(kind, size) {
    return ART + 'st-' + (KIND_NAME[kind] ? kind : 'other') + (size === true ? '.png' : size === 'small' ? '-64.png' : '-128.png');
  }

  let st = null;            // the last light state
  let types = [];           // every music type, from the last full read
  let playlists = [];       // every saved playlist, from the last read that carried them
  let plSeq = -1;           // the generation `playlists` is
  let plThumb = -1;         // the thumbSeq `playlists` was read at
  let mode = 'yt';
  let kind = 'all';
  let q = '';
  let sel = 0;              // highlighted row in the browser
  let selAuto = false;      // the query just changed: the browser picks the row Enter takes
  let drawn = [];           // the rows the browser shows, in order
  let wired = false;
  let shown = false;
  let pollT = 0;
  let toastT = 0;
  let listSig = '';         // what the browser was last drawn from
  let revealKey = '';       // which list the browser last revealed
  let faceSig = '';
  let pop = null;           // the open popout's root
  let popKey = null;
  let popRedraw = null;     // redraws the open popout from fresh state
  let seeking = false;      // a drag on the tuning scale is in flight
  let volT = 0;
  let volDrag = false;      // a drag on the volume knob is in flight
  let warmAt = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function norm(s) { return String(s || '').toLowerCase(); }
  function words(s) { return norm(s).split(/\s+/).filter(Boolean); }
  /* every word of the query appears somewhere in the haystack */
  function matches(hay, qq) {
    if (!qq) return true;
    const h = norm(hay);
    const w = words(qq);
    for (let i = 0; i < w.length; i++) if (h.indexOf(w[i]) === -1) return false;
    return true;
  }
  function songs(n) { return n + (n === 1 ? ' song' : ' songs'); }

  /* ------------------------------------------------------------ bridge -- */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(typeof arg === 'string' ? arg : JSON.stringify(arg || {})); } catch (e) { console.log('bridge error', fn, e); }
      return;
    }
    if (DEV && window.MusicPaneDev) window.MusicPaneDev(fn, arg);
    else console.log('[dev->game]', fn, arg);
  }
  /* the playlists come back only when they changed — or when a thumbnail
     landed since they were read, so their pictures fill in */
  function ask(full) {
    const known = st && plThumb === st.thumbSeq ? plSeq : -1;
    toGame('muState', { full: !!full, plSeq: known });
  }
  function act(o) { toGame('muSet', o); }

  /* ------------------------------------------------------------- state -- */

  function stream() { return (st && st.stream) || {}; }
  function engine() { return (st && st.engine) || {}; }
  function tools() { return (st && st.tools) || {}; }
  function settings() { return (st && st.settings) || { vol: 60, mute: true, repeat: 'off' }; }
  function queue() { const s = stream(); return Array.isArray(s.queue) ? s.queue : []; }
  function current() {
    const s = stream();
    const qu = queue();
    return (s.index >= 0 && s.index < qu.length) ? qu[s.index] : null;
  }
  /* the stream owns the display while it is loading, playing or paused */
  function streamOnAir() { const s = stream(); return !!(current() && (s.playing || s.loading)); }
  function keyOf(v) { return v ? (v.id || v.url) : ''; }
  function isFavVideo(v) {
    const k = keyOf(v);
    const f = (st && st.favVideos) || [];
    for (let i = 0; i < f.length; i++) if (keyOf(f[i]) === k) return true;
    return false;
  }
  function isFavType(id) { return !!(st && Array.isArray(st.favTypes) && st.favTypes.indexOf(id) !== -1); }
  function toolsReady() { const t = tools(); return !!(t.mpv && t.ytdlp); }
  function thumbSrc(v) { return (v && v.id && v.thumb) ? 'music-thumbs/' + v.id + '.jpg' : ''; }
  function plById(id) { for (let i = 0; i < playlists.length; i++) if (playlists[i].id === id) return playlists[i]; return null; }
  function plItems(p) { return (p && Array.isArray(p.items)) ? p.items : []; }
  function plDur(p) { return plItems(p).reduce(function (a, v) { return a + (v.dur || 0); }, 0); }
  function plSub(p) {
    const n = plItems(p).length;
    const d = plDur(p);
    return n ? songs(n) + (d ? ' · ' + fmtTime(d) : '') : 'Empty — add songs with + List';
  }

  /* --------------------------------------------------------- the toast -- */

  function toast(msg, ok) {
    const el = $('mus-toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.classList.remove('hidden', 'ok', 'err');
    el.classList.add(ok ? 'ok' : 'err');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.add('hidden'); }, 4200);
  }

  /* ------------------------------------------------------ brass parts -- */

  /* Transport marks are drawn with borders and boxes, never media glyphs:
     Ultralight draws ⏯-style characters as mismatched symbol-font specks. */
  function icon(name) {
    return '<span class="mus-ic mus-ic-' + name + '" aria-hidden="true"><i></i><i></i></span>';
  }
  function rivets() { return '<i class="mus-rv mus-rv-tl"></i><i class="mus-rv mus-rv-tr"></i><i class="mus-rv mus-rv-bl"></i><i class="mus-rv mus-rv-br"></i>'; }

  /* A playlist's cover: four thumbnails as a 2 x 2 when it has them, the
     first one alone when it has fewer, the resonator when it has none.
     `big` draws it 256 x 144 (each tile at its source size either way). */
  function coverHtml(p, big) {
    const th = plItems(p).map(thumbSrc).filter(Boolean);
    const cls = 'mus-cover' + (big ? ' mus-cover-big' : '');
    if (th.length >= 4) {
      return '<div class="' + cls + ' mus-cover-4">' + th.slice(0, 4).map(function (t) { return '<img src="' + esc(t) + '" alt="">'; }).join('') + '</div>';
    }
    if (th.length) return '<div class="' + cls + ' mus-cover-1"><img src="' + esc(th[0]) + '" alt=""></div>';
    return '<div class="' + cls + ' mus-cover-0"><img src="' + ART + (big ? 'resonator-256.png' : 'resonator-128.png') + '" alt=""></div>';
  }

  /* ---------------------------------------------------------- the dial -- */

  /* Skyrim's engine plate is engraved on the glass, between what you hear
     and the readout; renderEngine fills this slot after every redraw. */
  const SKY_SLOT = '<div id="mus-sky" class="mus-sky hidden"></div>';

  /* The amber glass: the porthole, what you hear, and its readout. */
  function dialTopHtml() {
    const s = stream();
    if (streamOnAir()) {
      const cur = current();
      const th = thumbSrc(cur);
      const title = s.mediaTitle && s.playing ? s.mediaTitle : cur.title;
      const state = s.loading ? 'Tuning the aether…' : s.buffering ? 'Gathering signal…' : s.paused ? 'Paused' : 'On air';
      const on = s.dur > 0;
      return '<div class="mus-port">' +
          (th ? '<img class="mus-port-thumb" src="' + esc(th) + '" alt="">' : '<img class="mus-port-art" src="' + ART + 'resonator-256.png" alt="">') + '</div>' +
        '<div class="mus-glass">' +
          '<div class="mus-glass-state' + (s.playing && !s.paused && !s.loading ? ' live' : '') + '"><span class="mus-band-tag">YouTube</span>' + state + '</div>' +
          '<div class="mus-glass-title" title="' + esc(title) + '">' + esc(title) + '</div>' +
          (cur.channel ? '<div class="mus-glass-sub">' + esc(cur.channel) + '</div>' : '') +
          (s.error ? '<div class="mus-err">' + esc(s.error) + '</div>' : '') +
        '</div>' + SKY_SLOT +
        '<div class="mus-dial-side">' +
          '<div class="mus-readout"><span id="mus-pos">' + (on ? fmtTime(s.pos || 0) : (s.loading ? '…' : 'Live')) + '</span>' +
            (on ? '<span class="mus-readout-of">/</span><span id="mus-dur">' + fmtTime(s.dur) + '</span>' : '') + '</div>' +
          '<div class="mus-dial-btns">' +
            '<button type="button" class="mus-btn" data-act="listCur" title="Add this song to a playlist">+ List</button>' +
            '<button type="button" class="mus-star' + (isFavVideo(cur) ? ' on' : '') + '" data-act="favCur" title="Star this song">★</button>' +
          '</div></div>';
    }
    const e = engine();
    const c = e.ok ? e.current : null;
    if (!c) {
      return '<div class="mus-port"><img class="mus-port-art" src="' + ART + 'resonator-256.png" alt=""></div>' +
        '<div class="mus-glass">' +
          '<div class="mus-glass-state"><span class="mus-band-tag">Skyrim</span>' + (e.ok ? 'Silence' : 'Waiting for a save') + '</div>' +
          '<div class="mus-glass-title">' + (e.ok ? 'No music is playing' : 'The resonator is warming up') + '</div>' +
          '<div class="mus-glass-sub">Tune a station on the scale below, or search YouTube.</div>' +
          (s.error ? '<div class="mus-err">' + esc(s.error) + '</div>' : '') +
        '</div>' + SKY_SLOT;
    }
    const tr = c.track;
    return '<div class="mus-port mus-port-medal"><img class="mus-port-medal-img" src="' + medal(c.kind, true) + '" alt="' + esc(KIND_NAME[c.kind] || '') + '"></div>' +
      '<div class="mus-glass">' +
        '<div class="mus-glass-state live"><span class="mus-band-tag">Skyrim</span>' + esc(KIND_NAME[c.kind] || c.kind) + ' · ' + esc(c.status) + '</div>' +
        '<div class="mus-glass-title" title="' + esc(tr ? tr.label : c.label) + '">' + esc(tr ? tr.label : (c.label || c.edid)) + '</div>' +
        '<div class="mus-glass-sub">' + esc(c.label || c.edid) + (tr && tr.plugin ? ' · ' + esc(tr.plugin) : '') +
          (tr && tr.kind === 'palette' ? ' · a layered palette' : '') + '</div>' +
        (s.error ? '<div class="mus-err">' + esc(s.error) + '</div>' : '') +
      '</div>' + SKY_SLOT +
      '<div class="mus-dial-side"><div class="mus-dial-btns">' +
        '<button type="button" class="mus-star' + (isFavType(c.id) ? ' on' : '') + '" data-act="favPlaying" title="Star this station">★</button>' +
      '</div></div>';
  }

  /* The tuning scale. Streaming: time, and the needle seeks. Skyrim: the
     five station kinds, the needle on the one playing, each kind a key. */
  function scaleHtml() {
    const s = stream();
    const live = streamOnAir() && s.dur > 0;
    let ticks = '';
    for (let i = 0; i <= 40; i++) {
      ticks += '<i class="mus-tick' + (i % 4 === 0 ? ' major' : i % 2 === 0 ? ' mid' : '') + '" style="left:' + (i * 2.5) + '%"></i>';
    }
    let labels = '';
    let needle = -1;
    if (live) {
      labels = [0, 25, 50, 75, 100].map(function (p) {
        return '<span class="mus-scale-num" style="left:' + p + '%">' + fmtTime(s.dur * p / 100) + '</span>';
      }).join('');
    } else if (!streamOnAir()) {
      const c = engine().ok ? engine().current : null;
      labels = SCALE.map(function (k) {
        const on = c && c.kind === k.id;
        if (on) needle = k.at;
        return '<button type="button" class="mus-scale-kind' + (on ? ' on' : '') + '" style="left:' + k.at + '%" data-act="tuneKind" data-kind="' + k.id + '" title="Tune a ' + esc(KIND_NAME[k.id]) + ' station">' + k.label + '</button>';
      }).join('');
    }
    return '<div class="mus-scale' + (live ? ' live' : ' idle') + '" id="mus-prog" title="' + (live ? 'Click or drag to jump' : '') + '">' +
        '<div class="mus-scale-labels">' + labels + '</div>' +
        '<div class="mus-scale-ticks">' + ticks + '</div>' +
        '<div class="mus-band-fill" id="mus-prog-fill"></div>' +
        '<div class="mus-needle' + (live || needle >= 0 ? '' : ' hidden') + '" id="mus-needle"' + (needle >= 0 ? ' style="left:' + needle + '%"' : '') + '></div>' +
      '</div>';
  }

  /* --------------------------------------------------------- the plinth -- */

  function plinthHtml() {
    const s = stream();
    const set = settings();
    const playing = s.playing && !s.paused;
    let ring = '';
    for (let i = 0; i <= 10; i++) ring += '<i class="mus-ring-tick' + (i % 5 === 0 ? ' major' : '') + '" style="transform:rotate(' + (-135 + i * 27) + 'deg)"></i>';
    const rep = REPEAT.filter(function (r) { return r.id === set.repeat; })[0] || REPEAT[0];
    return '<div class="mus-plinth-keys" role="group" aria-label="Transport">' +
        '<button type="button" class="mus-key" data-act="prev" title="Previous (back to the start first)">' + icon('prev') + '</button>' +
        '<button type="button" class="mus-key mus-key-main' + (s.loading ? ' busy' : '') + '" data-act="toggle" title="' + (playing ? 'Pause' : 'Play') + '">' +
          icon(playing ? 'pause' : 'play') + '</button>' +
        '<button type="button" class="mus-key" data-act="next" title="Next">' + icon('next') + '</button>' +
        '<button type="button" class="mus-key" data-act="stop" title="Stop">' + icon('stop') + '</button>' +
      '</div>' +
      '<div class="mus-plinth-dials">' +
        '<div class="mus-ctl">' +
          '<div class="mus-ring">' + ring +
            '<div class="mus-knob" id="mus-vol" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + esc(set.vol) + '" title="Drag, scroll or use the arrow keys">' +
              '<div class="mus-knob-cap" id="mus-knob-cap"><i class="mus-knob-mark"></i></div></div>' +
          '</div>' +
          '<div class="mus-engrave">Volume <b id="mus-vol-num"></b></div>' +
        '</div>' +
        '<div class="mus-ctl">' +
          '<div class="mus-rot" role="group" aria-label="Repeat">' +
            REPEAT.map(function (r) {
              return '<button type="button" class="mus-rot-pos mus-rot-' + r.id + (r.id === rep.id ? ' on' : '') + '" data-act="repeat" data-mode="' + r.id + '" title="' + esc(r.title) + '">' + r.label + '</button>';
            }).join('') +
            '<button type="button" class="mus-rot-knob" data-act="repeatCycle" title="Turn to the next setting">' +
              '<span class="mus-rot-cap" style="transform:rotate(' + rep.deg + 'deg)"><i></i></span></button>' +
          '</div>' +
          '<div class="mus-engrave">Repeat</div>' +
        '</div>' +
        '<div class="mus-ctl">' +
          '<button type="button" class="mus-toggle' + (set.mute ? ' on' : '') + '" data-act="mute" aria-pressed="' + (set.mute ? 'true' : 'false') + '" ' +
            'title="While a stream plays, the game’s Music volume is held at 0 and put back afterwards">' +
            '<span class="mus-toggle-word">' + (set.mute ? 'On' : 'Off') + '</span><span class="mus-toggle-slot"><span class="mus-toggle-bat"></span></span></button>' +
          '<div class="mus-engrave">Quiet Skyrim</div>' +
        '</div>' +
      '</div>' +
      '<div class="mus-badge" aria-hidden="true">' +
        '<img src="' + ART + 'resonator-128.png" alt="">' +
        '<div class="mus-badge-text"><span class="mus-badge-name">Resonator</span><span class="mus-badge-mk">Kagrenzel Works · Mk VII</span></div>' +
      '</div>';
  }

  function renderFace() {
    const host = $('mus-face');
    const deck = $('mus-deck');
    if (!host) return;
    const s = stream();
    const e = engine();
    const cur = current();
    const set = settings();
    const c = e.current;
    const sig = JSON.stringify([streamOnAir(), s.loading, s.playing, s.paused, s.buffering, s.error, keyOf(cur), cur && cur.thumb,
      s.mediaTitle, Math.floor(s.dur || 0), set.repeat, set.mute, isFavVideo(cur), toolsReady(), e.ok,
      c && [c.id, c.kind, c.status, c.track && c.track.index], c && isFavType(c.id)]);
    if (sig !== faceSig) {
      faceSig = sig;
      host.innerHTML = '<div class="mus-dial-top">' + dialTopHtml() + '</div>' + scaleHtml();
      if (deck) deck.innerHTML = plinthHtml();
      /* the crown's ON AIR plate and the cabinet's glow */
      const live = (streamOnAir() && !s.paused) || (!streamOnAir() && !!(e.ok && c && c.status === 'playing'));
      const air = $('mus-onair');
      if (air) air.classList.toggle('live', live);
      const src = $('mus-src');
      if (src) src.textContent = streamOnAir() ? (s.paused ? 'YouTube · paused' : 'YouTube') : (e.ok && c ? 'Skyrim · ' + (KIND_NAME[c.kind] || c.kind) : e.ok ? 'Silence' : 'Waiting for a save');
      const cab = $('mus-cab');
      if (cab) cab.classList.toggle('onair', live);
    }
    if (!volDrag) paintVol(set.vol);
    tickProgress();
  }

  /* -------------------------------------------------------- the knob ---- */

  function paintVol(v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const cap = $('mus-knob-cap'), num = $('mus-vol-num'), knob = $('mus-vol');
    /* -135° at 0, +135° at 100: the sweep of a real radio's knob */
    if (cap) cap.style.transform = 'rotate(' + Math.round(-135 + v * 2.7) + 'deg)';
    if (num) num.textContent = String(v);
    if (knob) knob.setAttribute('aria-valuenow', String(v));
  }

  function setVol(v, now) {
    if (v == null) return;
    v = Math.max(0, Math.min(100, Math.round(v)));
    if (st && st.settings) st.settings.vol = v;
    paintVol(v);
    clearTimeout(volT);
    volT = setTimeout(function () { volT = 0; act({ act: 'yt-vol', v: v }); }, now ? 0 : 120);
  }

  function tickProgress() {
    const s = stream();
    const fill = $('mus-prog-fill');
    const needle = $('mus-needle');
    const pos = $('mus-pos');
    if (!fill || seeking || !streamOnAir()) return;
    const dur = s.dur || 0;
    const p = dur > 0 ? Math.max(0, Math.min(1, (s.pos || 0) / dur)) : 0;
    fill.style.width = (p * 100).toFixed(2) + '%';
    if (needle) needle.style.left = (p * 100).toFixed(2) + '%';
    if (pos && dur) pos.textContent = fmtTime(s.pos || 0);
  }

  /* ------------------------------------------------- Skyrim's engine --- */

  /* Engraved on the dial's glass: the held type, what Skyrim plays under a
     stream, and what waits underneath. */
  function renderEngine() {
    const host = $('mus-sky');
    if (!host) return;
    const e = engine();
    let h = '';
    if (e.ok) {
      const c = e.current;
      if (streamOnAir() && c) {
        h += '<div class="mus-plate-row"><img class="mus-plate-medal" src="' + medal(c.kind, 'small') + '" alt="">' +
          '<span class="mus-plate-text">Skyrim underneath: <b>' + esc(c.label || c.edid) + '</b>' +
          (c.track ? ' · ' + esc(c.track.label) : '') +
          (st && st.muted ? ' <span class="mus-note">· held quiet (the Audio menu’s Music slider reads 0 meanwhile)</span>' : '') + '</span></div>';
      }
      if (e.held) {
        h += '<div class="mus-held">' +
          '<img class="mus-plate-medal" src="' + medal(e.held.kind, 'small') + '" alt="">' +
          '<div class="mus-held-text">Holding <b>' + esc(e.held.label) + '</b> over the game’s own choice</div>' +
          '<button type="button" class="mus-btn" data-act="skAgain" title="A new track from the same station">Another track</button>' +
          '<button type="button" class="mus-btn mus-btn-hero" data-act="skRelease">Release</button>' +
          '</div>';
      }
      const qu = Array.isArray(e.queue) ? e.queue.filter(function (x) { return !c || x.id !== c.id; }) : [];
      if (qu.length) {
        h += '<div class="mus-plate-row mus-plate-q"><span class="mus-dim">Waiting underneath</span>' +
          qu.slice(0, 5).map(function (x) { return '<span class="mus-qchip">' + esc(x.label || x.edid) + '</span>'; }).join('') +
          (qu.length > 5 ? '<span class="mus-dim">+' + (qu.length - 5) + ' more</span>' : '') + '</div>';
      }
    }
    host.classList.toggle('hidden', !h);
    if (host.__h !== h) { host.__h = h; host.innerHTML = h; }
  }

  /* ---------------------------------------------------------- up next -- */

  function setupHtml() {
    const t = tools();
    const miss = [];
    if (!t.mpv) miss.push('<b>mpv.exe</b> (the player)');
    if (!t.ytdlp) miss.push('<b>yt-dlp.exe</b> (finds the stream)');
    return '<div class="mus-setup">' +
      '<div class="mus-setup-title">Wire the resonator to YouTube</div>' +
      '<div class="mus-setup-body">SkyManager streams through two free programs it does not ship. Missing: ' + miss.join(' and ') + '.</div>' +
      '<ol class="mus-setup-steps">' +
        '<li>Get <b>mpv</b> for Windows (mpv.io → Installation) and <b>yt-dlp.exe</b> (github.com/yt-dlp/yt-dlp → Releases).</li>' +
        '<li>Put both in<div class="mus-path">' + esc(t.dir || '%LOCALAPPDATA%\\SkyManager\\music-tools') + '</div>' +
          'or set <b>sToolsDir=</b> under <b>[Music]</b> in SkyManager.ini.</li>' +
        '<li>YouTube needs a JavaScript runtime for yt-dlp: <b>deno.exe</b> in the same folder, or Node.js.' +
          (t.js ? ' Found: <b>' + esc(t.js) + '</b>.' : '') + '</li>' +
      '</ol>' +
      '<button type="button" class="mus-btn mus-btn-hero" data-act="recheck">Check again</button>' +
      '<div class="mus-setup-foot">Skyrim’s own stations work without any of this.</div>' +
      '</div>';
  }

  function renderQueue() {
    const host = $('mus-queue');
    if (!host) return;
    const s = stream();
    const qu = queue();
    const spk = $('mus-speaker');
    if (spk) spk.classList.toggle('empty', toolsReady() && !qu.length);
    const sig = JSON.stringify([qu.map(keyOf), s.index, qu.map(function (v) { return v.thumb ? 1 : 0; }), toolsReady()]);
    if (host.__sig === sig) return;
    host.__sig = sig;
    if (!toolsReady()) { host.innerHTML = setupHtml(); return; }
    if (!qu.length) {
      /* the grille shows through, lit; one brass plaque says what goes here */
      host.innerHTML = '<div class="mus-plaque">' + rivets() +
        '<div class="mus-plaque-title">Nothing queued</div>' +
        '<div class="mus-plaque-sub">Play a song and the rest of its list lines up here. <b class="mus-nw">+ Queue</b> adds one to the end; a playlist plays as one queue.</div>' +
        '</div>';
      return;
    }
    host.innerHTML = '<div class="mus-section-title">Up next <span class="mus-dim">' + songs(qu.length) + '</span>' +
      '<span class="mus-section-acts">' +
        '<button type="button" class="mus-link" data-act="saveQueue" title="Keep this queue as a playlist">Save as playlist</button>' +
        '<button type="button" class="mus-link" data-act="clearQueue">Clear</button></span></div>' +
      '<div class="mus-qlist">' + qu.map(function (v, i) {
        const th = thumbSrc(v);
        return '<div class="mus-qrow' + (i === s.index ? ' cur' : '') + '" data-act="jump" data-i="' + i + '" title="Play it now">' +
          '<span class="mus-qnum">' + (i === s.index ? '▶' : (i + 1)) + '</span>' +
          '<span class="mus-qthumb">' + (th ? '<img src="' + esc(th) + '" alt="">' : '<img class="mus-qthumb-art" src="' + ART + 'resonator-64.png" alt="">') + '</span>' +
          '<span class="mus-qtitle">' + esc(v.title) + '</span>' +
          (v.dur ? '<span class="mus-qdur">' + fmtTime(v.dur) + '</span>' : '') +
          '<button type="button" class="mus-x" data-act="drop" data-i="' + i + '" title="Take it out of the queue">×</button>' +
          '</div>';
      }).join('') + '</div>';
  }

  /* ---------------------------------------------------------- browser -- */

  function renderModes() {
    const host = $('mus-modes');
    if (!host) return;
    host.innerHTML = MODES.map(function (m) {
      return '<button type="button" data-act="mode" data-mode="' + m.id + '" class="mus-bandkey' + (m.id === mode ? ' on' : '') + '" title="' + esc(m.title) + '">' +
        '<span class="mus-bandkey-lamp"></span>' + m.label + '</button>';
    }).join('');
    const inp = $('mus-search');
    if (inp) {
      inp.placeholder = mode === 'yt' ? 'Search YouTube — a song, an artist, or paste a link (Enter searches)' :
        mode === 'sk' ? 'Search Skyrim’s stations — explore, tavern, combat, a mod’s name (Enter = hold the top hit)' :
          mode === 'pl' ? 'Search your playlists — or type a new one’s name and press Enter' :
            mode === 'fav' ? 'Search your starred music (Enter = play the top hit)' : 'Search what you played lately (Enter = play the top hit)';
    }
    goLabel();
    const kinds = $('mus-kinds');
    if (kinds) {
      kinds.classList.toggle('hidden', mode !== 'sk');
      if (mode === 'sk') {
        kinds.innerHTML = KINDS.map(function (k) {
          return '<button type="button" class="' + (k.id === kind ? 'on' : '') + '" data-act="kind" data-kind="' + k.id + '"' +
            (k.title ? ' title="' + esc(k.title) + '"' : '') + '><img src="' + ART + k.art + '" alt="">' + k.label + '</button>';
        }).join('');
      }
    }
  }

  /* the search bar's button says what Enter will do */
  function goLabel() {
    const go = document.querySelector('#mus-pane .mus-go');
    if (!go) return;
    let t = mode === 'yt' ? 'Search' : mode === 'sk' ? 'Hold top hit' : 'Play top hit';
    if (mode === 'pl') t = drawn[sel] && drawn[sel].kind === 'plnew' && drawn[sel].name ? 'Make it' : 'Open';
    go.textContent = t;
  }

  function videoRows(list) {
    return list.filter(function (v) { return matches(v.title + ' ' + v.channel, q); });
  }

  function typeRows(k) {
    const playing = engine().current ? engine().current.id : '';
    const held = engine().held ? engine().held.id : '';
    return types.filter(function (t) {
      if (k === 'fav' && !isFavType(t.id)) return false;
      if (k !== 'all' && k !== 'fav' && t.kind !== k) return false;
      return matches(t.label + ' ' + t.edid + ' ' + t.plugin + ' ' + t.editedBy + ' ' + (KIND_NAME[t.kind] || '') +
        ' ' + (t.list || []).map(function (x) { return x.label; }).join(' '), q);
    }).sort(function (a, b) {
      const pa = (a.id === playing ? 0 : 1), pb = (b.id === playing ? 0 : 1);
      if (pa !== pb) return pa - pb;
      const fa = isFavType(a.id) ? 0 : 1, fb = isFavType(b.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    }).map(function (t) { return { t: t, playing: t.id === playing, held: t.id === held }; });
  }

  /* playlists matching the query (by name, or by a song inside), newest
     first; the "make one" row always heads the list */
  function plRows() {
    const exact = q && playlists.some(function (p) { return norm(p.name) === norm(q); });
    const rows = [{ kind: 'plnew', name: exact ? '' : q, exact: !!exact }];
    playlists.slice().reverse().forEach(function (p) {
      if (matches(p.name + ' ' + plItems(p).slice(0, 200).map(function (v) { return v.title + ' ' + v.channel; }).join(' '), q)) rows.push({ kind: 'pl', p: p });
    });
    return rows;
  }

  function rowsNow() {
    if (mode === 'sk') return typeRows(kind).map(function (r) { return { kind: 'type', r: r }; });
    if (mode === 'pl') return plRows();
    let list = [];
    if (mode === 'yt') list = (st && st.search && st.search.results) || [];
    else if (mode === 'fav') list = (st && st.favVideos) || [];
    else list = (st && st.recents) || [];
    const rows = videoRows(list).map(function (v) { return { kind: 'video', v: v }; });
    if (mode === 'fav') typeRows('fav').forEach(function (r) { rows.push({ kind: 'type', r: r }); });
    return rows;
  }

  /* An empty browser is not a blank slab: one line on what to do, and —
     where it helps — the six Skyrim station kinds as one-press dials. */
  function emptyHtml(title, sub, tune) {
    return '<div class="mus-empty"><div class="mus-empty-title">' + title + '</div>' + (sub ? '<div class="mus-empty-sub">' + sub + '</div>' : '') +
      (tune ? '<div class="mus-tune-label">Or tune a Skyrim station</div>' +
        '<div class="mus-tune">' + KINDS.map(function (k) {
          return '<button type="button" class="mus-tune-cell" data-act="tuneKind" data-kind="' + k.id + '"' + (k.title ? ' title="' + esc(k.title) + '"' : '') + '>' +
            '<img src="' + (k.id === 'all' ? ART + 'resonator-128.png' : medal(k.id)) + '" alt="">' + (k.id === 'all' ? 'All stations' : k.label) + '</button>';
        }).join('') + '</div>' : '') + '</div>';
  }

  function renderList(force) {
    const host = $('mus-list');
    const count = $('mus-count');
    if (!host) return;
    const s = (st && st.search) || {};
    const sig = JSON.stringify([mode, kind, q, sel, s.seq, s.busy, s.error, st && st.thumbSeq, st && st.favTypes, (st && st.favVideos || []).length,
      (st && st.recents || []).map(keyOf).slice(0, 5), types.length, engine().current && engine().current.id, engine().held && engine().held.id,
      keyOf(current()), stream().playing, toolsReady(), plSeq, mode === 'pl' ? plThumb : 0]);
    if (!force && sig === listSig) return;
    listSig = sig;
    const rows = rowsNow();
    drawn = rows.slice(0, ROW_CAP);
    /* typing in Playlists: Enter opens the first list that matches; the
       "make" row takes it only when nothing does (arrow up to it) */
    if (selAuto) { selAuto = false; if (mode === 'pl' && q && drawn.length > 1 && drawn[1].kind === 'pl') sel = 1; }
    if (sel >= drawn.length) sel = Math.max(0, drawn.length - 1);
    let head = '', body = '';
    if (mode === 'yt') {
      if (!toolsReady()) body = emptyHtml('YouTube is not wired yet', 'The speaker on the left says where mpv and yt-dlp go.');
      else if (s.busy) head = '<div class="mus-searching"><span class="mus-spin"></span>Searching YouTube for “' + esc(s.q) + '”…</div>';
      else if (s.error) head = '<div class="mus-err">' + esc(s.error) + '</div>';
      else if (!s.seq) body = emptyHtml('Tune the aether', 'Type a song or an artist and press <b>Enter</b>. A pasted YouTube link — a video or a whole playlist — lists what it holds.', true);
      if (toolsReady() && !s.busy && drawn.length) {
        head += '<div class="mus-listhead"><span class="mus-listhead-text">' + (s.title ? esc(s.title) : '<span class="mus-dim">' + drawn.length + ' results' +
          (q && s.q && norm(q) !== norm(s.q) ? ' · filtered by “' + esc(q) + '” — Enter searches YouTube for it' : '') + '</span>') + '</span>' +
          '<button type="button" class="mus-btn" data-act="saveResults" title="Keep these as a playlist">Save as playlist</button>' +
          '<button type="button" class="mus-btn mus-btn-hero" data-act="playAll">Play all</button></div>';
      }
    } else if (mode === 'sk') {
      head = types.length ? '<div class="mus-hint">Click a station to hold it over the game’s own choice — it starts as you close the deck. Skyrim picks the track inside it.</div>' : '';
      if (!types.length) body = emptyHtml('Reading the load order’s music…', '');
      else if (!rows.length) body = emptyHtml('No station matches', 'Clear the search or pick another kind.');
    } else if (mode === 'pl') {
      if (!playlists.length) {
        body = drawn.map(rowHtml).join('') + emptyHtml('No playlists yet',
          'Type a name above and press <b>Enter</b> to make one. Then <b>+ List</b> on any song adds it — or <b>Save as playlist</b> keeps the whole queue or a search.');
      } else if (drawn.length === 1 && q) {
        body = rowHtml(drawn[0], 0) + '<div class="mus-hint mus-hint-c">No playlist matches “' + esc(q) + '”.</div>';
      }
    } else if (mode === 'fav') {
      if (!rows.length) body = emptyHtml(q ? 'Nothing starred matches' : 'Nothing starred yet', 'Press ★ on a song or a Skyrim station.', !q);
      else if (drawn.some(function (r) { return r.kind === 'video'; }))
        head = '<div class="mus-listhead"><span class="mus-listhead-text mus-dim">Starred songs play as one queue</span>' +
          '<button type="button" class="mus-btn" data-act="saveResults" title="Keep these as a playlist">Save as playlist</button>' +
          '<button type="button" class="mus-btn mus-btn-hero" data-act="playAll">Play all</button></div>';
    } else if (!rows.length) {
      body = emptyHtml(q ? 'Nothing recent matches' : 'Nothing played yet', 'What you stream shows up here.', !q);
    }
    /* rows rise in, staggered, when the list is NEW (a band, a kind, a
       search, a query) — never when a poll or an arrow key redraws it */
    const content = JSON.stringify([mode, kind, q, s.seq, mode === 'pl' ? plSeq : 0]);
    host.classList.toggle('mus-reveal', content !== revealKey);
    revealKey = content;
    host.innerHTML = head + (body || drawn.map(rowHtml).join('') +
      (rows.length > drawn.length ? '<div class="mus-more">' + (rows.length - drawn.length) + ' more — narrow the search</div>' : ''));
    if (count) {
      const n = mode === 'sk' && types.length ? (rows.length + ' of ' + types.length + ' stations') :
        mode === 'pl' && playlists.length ? ((rows.length - 1) + ' of ' + playlists.length + ' playlists') : '';
      count.textContent = n;
      count.classList.toggle('hidden', !n);
    }
    goLabel();
  }

  function rowHtml(row, i) {
    return row.kind === 'video' ? videoRowHtml(row.v, i) : row.kind === 'type' ? typeRowHtml(row.r, i) :
      row.kind === 'pl' ? plRowHtml(row.p, i) : plNewRowHtml(row, i);
  }

  function videoRowHtml(v, i) {
    const th = thumbSrc(v);
    const cur = current();
    const isCur = cur && keyOf(cur) === keyOf(v) && stream().playing;
    return '<div class="mus-row mus-vrow' + (i === sel ? ' sel' : '') + (isCur ? ' cur' : '') + '" data-act="playRow" data-i="' + i + '" title="Play it">' +
      '<div class="mus-thumb">' + (th ? '<img src="' + esc(th) + '" alt="">' : '<img class="mus-thumb-art" src="' + ART + 'resonator-128.png" alt="">') + '</div>' +
      '<div class="mus-row-main">' +
        '<div class="mus-row-title">' + (isCur ? '<span class="mus-live">▶</span>' : '') + esc(v.title) + '</div>' +
        '<div class="mus-row-sub">' + esc(v.channel || 'YouTube') + (v.dur ? ' · ' + fmtTime(v.dur) : '') + '</div>' +
      '</div>' +
      '<div class="mus-row-acts">' +
        '<button type="button" class="mus-btn" data-act="queueRow" data-i="' + i + '" title="Add to the end of the queue">+ Queue</button>' +
        '<button type="button" class="mus-btn" data-act="listRow" data-i="' + i + '" title="Add to a playlist">+ List</button>' +
        '<button type="button" class="mus-star' + (isFavVideo(v) ? ' on' : '') + '" data-act="favRow" data-i="' + i + '" title="Star it">★</button>' +
      '</div></div>';
  }

  function typeRowHtml(r, i) {
    const t = r.t;
    return '<div class="mus-row mus-trow' + (i === sel ? ' sel' : '') + (r.playing ? ' cur' : '') + '" data-act="holdRow" data-i="' + i + '" title="Hold this station">' +
      '<div class="mus-thumb mus-thumb-medal"><img src="' + medal(t.kind) + '" alt="' + esc(KIND_NAME[t.kind] || '') + '"></div>' +
      '<div class="mus-row-main">' +
        '<div class="mus-row-title">' + (r.playing ? '<span class="mus-live">▶</span>' : '') + esc(t.label || t.edid) +
          (r.held ? '<span class="mus-pill mus-pill-held">held</span>' : '') + '</div>' +
        '<div class="mus-row-sub">' + esc(KIND_NAME[t.kind] || t.kind) + ' · ' + t.tracks + ' track' + (t.tracks === 1 ? '' : 's') + ' · ' + esc(t.plugin) +
          (t.editedBy && t.editedBy !== t.plugin ? ' · tracks from ' + esc(t.editedBy) : '') + '</div>' +
      '</div>' +
      '<div class="mus-row-acts">' +
        '<button type="button" class="mus-btn" data-act="tracks" data-i="' + i + '" title="See its tracks">Tracks</button>' +
        '<button type="button" class="mus-star' + (isFavType(t.id) ? ' on' : '') + '" data-act="favType" data-i="' + i + '" title="Star it">★</button>' +
      '</div></div>';
  }

  function plRowHtml(p, i) {
    const n = plItems(p).length;
    return '<div class="mus-row mus-plrow' + (i === sel ? ' sel' : '') + '" data-act="openPl" data-i="' + i + '" title="Open it">' +
      '<div class="mus-thumb mus-thumb-cover">' + coverHtml(p) + '</div>' +
      '<div class="mus-row-main">' +
        '<div class="mus-row-title">' + esc(p.name) + '</div>' +
        '<div class="mus-row-sub">' + esc(plSub(p)) + '</div>' +
      '</div>' +
      '<div class="mus-row-acts">' +
        (n > 1 ? '<button type="button" class="mus-btn" data-act="plShuffle" data-i="' + i + '" title="Play it in a random order">Shuffle</button>' : '') +
        (n ? '<button type="button" class="mus-btn mus-btn-hero" data-act="plPlay" data-i="' + i + '" title="Play it from the top">Play</button>' : '') +
        '<button type="button" class="mus-btn" data-act="openPl" data-i="' + i + '" title="See its songs">Open</button>' +
      '</div></div>';
  }

  function plNewRowHtml(row, i) {
    const named = !!row.name;
    return '<div class="mus-row mus-newrow' + (i === sel ? ' sel' : '') + (named ? ' named' : '') + '" data-act="plNew" data-i="' + i + '">' +
      '<div class="mus-thumb mus-thumb-new"><span class="mus-plus">+</span></div>' +
      '<div class="mus-row-main">' +
        '<div class="mus-row-title">' + (named ? 'Make a playlist called “' + esc(row.name) + '”' : 'New playlist') + '</div>' +
        '<div class="mus-row-sub">' + (named ? 'Enter on this row makes it — then + List on any song fills it' : row.exact ? 'That name is taken — it is listed below' : 'Type its name in the search bar above, then press Enter') + '</div>' +
      '</div></div>';
  }

  function renderAll() {
    faceSig = '';
    const sky = $('mus-sky'); if (sky) sky.__h = null;
    const qh = $('mus-queue'); if (qh) qh.__sig = null;
    renderModes();
    renderLive();
    renderList(true);
  }

  function renderLive() {
    renderFace();
    renderEngine();
    renderQueue();
    renderList(false);
  }

  /* ----------------------------------------------------- the popouts --- */

  /* Body-anchored and full-viewport (the popout law): a popout owns the
     keyboard while up and never wears the panel's scale. */
  function openPop(cls, label, html) {
    closePop();
    const back = document.createElement('div');
    back.className = 'mus-pop-back';
    back.innerHTML = '<div class="mus-pop ' + cls + '" role="dialog" aria-label="' + esc(label) + '">' + rivets() + html + '</div>';
    document.body.appendChild(back);
    pop = back;
    popKey = function (e) {
      if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
        e.preventDefault(); e.stopPropagation(); closePop();
      }
    };
    window.addEventListener('keydown', popKey, true);
    return back;
  }

  function closePop() {
    if (popKey) window.removeEventListener('keydown', popKey, true);
    popKey = null;
    popRedraw = null;
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
  }

  function focusIn(id) { const el = $(id); if (el) { try { el.focus(); } catch (err) {} } }

  /* A station's tracks. */
  function openTracks(t) {
    const curId = engine().current && engine().current.id === t.id && engine().current.track ? engine().current.track.index : -1;
    const back = openPop('mus-pop-tracks', 'Tracks',
      '<div class="mus-pop-head"><img class="mus-pop-medal" src="' + medal(t.kind) + '" alt="">' +
        '<div><div class="mus-pop-title">' + esc(t.label || t.edid) + '</div>' +
        '<div class="mus-pop-sub">' + esc(t.edid) + ' · ' + esc(t.plugin) + ' · priority ' + esc(t.priority) + ' (lower wins)</div></div>' +
        '<button type="button" class="mus-x mus-pop-x" data-pop="close" title="Close (Esc)">×</button></div>' +
      '<div class="mus-pop-bar"><span class="mus-bar-glyph" aria-hidden="true">&#8981;</span>' +
        '<input type="text" id="mus-pop-q" placeholder="Filter the tracks" autocomplete="off" spellcheck="false"></div>' +
      '<div class="mus-pop-list" id="mus-pop-list"></div>' +
      '<div class="mus-pop-foot">Skyrim chooses which of these plays while the station is held; the one playing now is marked.' +
        '<button type="button" class="mus-btn mus-btn-hero" data-pop="hold">Hold ' + esc(t.label || t.edid) + '</button></div>');
    const draw = function () {
      const fq = ($('mus-pop-q') || {}).value || '';
      const list = (t.list || []).filter(function (x) { return matches(x.label + ' ' + (x.edid || '') + ' ' + (x.plugin || ''), fq); });
      $('mus-pop-list').innerHTML = list.length ? list.map(function (x) {
        return '<div class="mus-prow' + (x.index === curId ? ' cur' : '') + '">' +
          '<span class="mus-qnum">' + (x.index === curId ? '▶' : (x.index + 1)) + '</span>' +
          '<span class="mus-prow-title">' + esc(x.label) + '</span>' +
          (x.kind !== 'track' ? '<span class="mus-pill">' + esc(x.kind) + '</span>' : '') +
          '<span class="mus-dim">' + esc(x.plugin || '') + '</span></div>';
      }).join('') : '<div class="mus-hint">No track matches.</div>';
    };
    draw();
    back.addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-pop]') : null;
      if (e.target === back || (b && b.getAttribute('data-pop') === 'close')) { closePop(); return; }
      if (b && b.getAttribute('data-pop') === 'hold') { act({ act: 'sk-play', id: t.id }); closePop(); }
    });
    const inp = $('mus-pop-q');
    if (inp) inp.addEventListener('input', draw);
    focusIn('mus-pop-q');
  }

  function shuffled(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function playPl(p, shuffle, from) {
    const items = plItems(p);
    if (!items.length) { toast('“' + p.name + '” is empty — add songs with + List', false); return; }
    if (!toolsReady()) { toast('mpv and yt-dlp are not set up yet — the speaker says where they go', false); return; }
    act({ act: 'yt-play', items: shuffle ? shuffled(items) : items, index: shuffle ? 0 : Math.max(0, Math.min(items.length - 1, from || 0)) });
  }

  /* One playlist: rename in place, play, shuffle, queue, reorder, remove,
     delete (a second press confirms). */
  function openPlaylist(id) {
    const p0 = plById(id);
    if (!p0) return;
    let armed = false;
    const back = openPop('mus-pop-pl', 'Playlist',
      '<div class="mus-pop-head"><div id="mus-pl-cover"></div>' +
        '<div><input type="text" class="mus-pl-name" id="mus-pl-name" maxlength="80" spellcheck="false" aria-label="Playlist name" title="Rename it: type, then Enter">' +
        '<div class="mus-pop-sub" id="mus-pl-sub"></div></div>' +
        '<button type="button" class="mus-x mus-pop-x" data-pop="close" title="Close (Esc)">×</button></div>' +
      '<div class="mus-pop-acts">' +
        '<button type="button" class="mus-btn mus-btn-hero" data-pop="play">Play</button>' +
        '<button type="button" class="mus-btn" data-pop="shuffle">Shuffle</button>' +
        '<button type="button" class="mus-btn" data-pop="queue" title="Add every song to the end of the queue">Add to queue</button>' +
        '<button type="button" class="mus-btn mus-btn-danger" data-pop="delete" id="mus-pl-del">Delete playlist</button>' +
      '</div>' +
      '<div class="mus-pop-bar"><span class="mus-bar-glyph" aria-hidden="true">&#8981;</span>' +
        '<input type="text" id="mus-pop-q" placeholder="Filter the songs" autocomplete="off" spellcheck="false"></div>' +
      '<div class="mus-pop-list" id="mus-pop-list"></div>' +
      '<div class="mus-pop-foot"><span>Click a song to play the list from there. <b class="mus-nw">+ List</b> on any song adds to it.</span></div>');
    const name = $('mus-pl-name');
    name.value = p0.name;
    const draw = function () {
      const p = plById(id);
      if (!p) { closePop(); return; }
      $('mus-pl-cover').innerHTML = coverHtml(p, true);
      $('mus-pl-sub').textContent = plSub(p);
      if (document.activeElement !== name) name.value = p.name;
      const fq = ($('mus-pop-q') || {}).value || '';
      const items = plItems(p);
      const cur = current();
      const rows = [];
      items.forEach(function (v, i) { if (matches(v.title + ' ' + v.channel, fq)) rows.push({ v: v, i: i }); });
      $('mus-pop-list').innerHTML = rows.length ? rows.map(function (r) {
        const th = thumbSrc(r.v);
        const isCur = cur && keyOf(cur) === keyOf(r.v) && stream().playing;
        return '<div class="mus-prow mus-plitem' + (isCur ? ' cur' : '') + '" data-pop="from" data-i="' + r.i + '" title="Play the list from here">' +
          '<span class="mus-qnum">' + (isCur ? '▶' : (r.i + 1)) + '</span>' +
          '<span class="mus-qthumb">' + (th ? '<img src="' + esc(th) + '" alt="">' : '<img class="mus-qthumb-art" src="' + ART + 'resonator-64.png" alt="">') + '</span>' +
          '<span class="mus-plitem-main"><span class="mus-prow-title">' + esc(r.v.title) + '</span><span class="mus-dim">' + esc(r.v.channel || 'YouTube') + '</span></span>' +
          (r.v.dur ? '<span class="mus-qdur">' + fmtTime(r.v.dur) + '</span>' : '') +
          '<button type="button" class="mus-x mus-mv" data-pop="up" data-i="' + r.i + '" title="Move up"' + (r.i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="mus-x mus-mv" data-pop="down" data-i="' + r.i + '" title="Move down"' + (r.i === items.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="mus-x" data-pop="drop" data-i="' + r.i + '" title="Take it out of the playlist">×</button></div>';
      }).join('') : '<div class="mus-hint mus-hint-c">' + (items.length ? 'No song matches.' : 'Nothing in it yet — press <b>+ List</b> on a song in YouTube, Starred or Recent.') + '</div>';
    };
    popRedraw = draw;
    draw();
    const rename = function () {
      const p = plById(id);
      const v = name.value.trim();
      if (!p) return;
      if (!v) { name.value = p.name; return; }
      if (v !== p.name) act({ act: 'pl-rename', id: id, name: v });
    };
    name.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); e.stopPropagation(); rename(); try { name.blur(); } catch (err) {} }
    });
    name.addEventListener('blur', rename);
    back.addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-pop]') : null;
      if (e.target === back || (b && b.getAttribute('data-pop') === 'close')) { closePop(); return; }
      if (!b) return;
      const p = plById(id);
      if (!p) { closePop(); return; }
      const what = b.getAttribute('data-pop');
      const i = Number(b.getAttribute('data-i'));
      if (what !== 'delete' && armed) {
        armed = false;
        const del = $('mus-pl-del'); if (del) { del.textContent = 'Delete playlist'; del.classList.remove('armed'); }
      }
      if (what === 'play') { playPl(p, false, 0); }
      else if (what === 'shuffle') { playPl(p, true); }
      else if (what === 'queue') { if (plItems(p).length) act({ act: 'yt-add', items: plItems(p) }); else toast('Nothing in it yet', false); }
      else if (what === 'from') { if (!(e.target.closest && e.target.closest('.mus-x'))) playPl(p, false, i); }
      else if (what === 'up') { e.stopPropagation(); if (i > 0) act({ act: 'pl-move', id: id, from: i, to: i - 1 }); }
      else if (what === 'down') { e.stopPropagation(); if (i < plItems(p).length - 1) act({ act: 'pl-move', id: id, from: i, to: i + 1 }); }
      else if (what === 'drop') { e.stopPropagation(); act({ act: 'pl-drop', id: id, index: i }); }
      else if (what === 'delete') {
        if (!armed) { armed = true; b.textContent = 'Press again to delete'; b.classList.add('armed'); return; }
        act({ act: 'pl-delete', id: id });
        closePop();
      }
    });
    const inp = $('mus-pop-q');
    if (inp) inp.addEventListener('input', draw);
  }

  /* "+ List": pick a playlist to add `items` to — type to filter, Enter
     takes the highlighted row; a name no list has makes a new one. */
  function openPicker(items, label, suggest) {
    items = (items || []).filter(Boolean);
    if (!items.length) { toast('Nothing to add', false); return; }
    let pickSel = -1;          // -1: let the next draw choose
    let rows = [];
    const back = openPop('mus-pop-pick', 'Add to a playlist',
      '<div class="mus-pop-head"><div><div class="mus-pop-title">Add to a playlist</div>' +
        '<div class="mus-pop-sub">' + esc(label) + '</div></div>' +
        '<button type="button" class="mus-x mus-pop-x" data-pop="close" title="Close (Esc)">×</button></div>' +
      '<div class="mus-pop-bar"><span class="mus-bar-glyph" aria-hidden="true">&#8981;</span>' +
        '<input type="text" id="mus-pick-q" placeholder="Find a playlist — or type a new name" autocomplete="off" spellcheck="false" maxlength="80"></div>' +
      '<div class="mus-pop-list" id="mus-pick-list"></div>' +
      '<div class="mus-pop-foot"><span>Enter takes the highlighted row. Songs already in a list are not added twice.</span></div>');
    const inp = $('mus-pick-q');
    if (suggest) inp.value = suggest;
    const keys = items.map(keyOf);
    const has = function (p) {
      const set = {};
      plItems(p).forEach(function (v) { set[keyOf(v)] = 1; });
      return keys.every(function (k) { return set[k]; });
    };
    const draw = function () {
      const fq = inp.value.trim();
      const exact = fq && playlists.some(function (p) { return norm(p.name) === norm(fq); });
      rows = [];
      playlists.slice().reverse().forEach(function (p) { if (matches(p.name, fq)) rows.push({ p: p }); });
      if (fq && !exact) rows.unshift({ name: fq });
      if (!fq && !playlists.length) rows.push({ hint: true });
      /* a fresh list aims Enter at the first one the songs are not in yet */
      if (pickSel < 0) {
        pickSel = 0;
        for (let i = 0; i < rows.length; i++) if (rows[i].name || (rows[i].p && !has(rows[i].p))) { pickSel = i; break; }
      }
      if (pickSel >= rows.length) pickSel = Math.max(0, rows.length - 1);
      $('mus-pick-list').innerHTML = rows.map(function (r, i) {
        if (r.hint) return '<div class="mus-hint mus-hint-c">No playlists yet — type a name and press <b>Enter</b> to make the first.</div>';
        if (r.name) {
          return '<div class="mus-prow mus-pick' + (i === pickSel ? ' sel' : '') + '" data-pop="pick" data-i="' + i + '">' +
            '<span class="mus-pick-new">+</span><span class="mus-prow-title">New playlist “' + esc(r.name) + '”</span>' +
            '<span class="mus-dim">with ' + songs(items.length) + '</span></div>';
        }
        const inIt = has(r.p);
        return '<div class="mus-prow mus-pick' + (i === pickSel ? ' sel' : '') + (inIt ? ' has' : '') + '" data-pop="pick" data-i="' + i + '">' +
          '<span class="mus-pick-cover">' + coverHtml(r.p) + '</span>' +
          '<span class="mus-prow-title">' + esc(r.p.name) + '</span>' +
          '<span class="mus-dim">' + (inIt ? 'Already in it' : songs(plItems(r.p).length)) + '</span></div>';
      }).join('');
    };
    const take = function (i) {
      const r = rows[i];
      if (!r || r.hint) return;
      if (r.name) act({ act: 'pl-new', name: r.name, items: items });
      else act({ act: 'pl-add', id: r.p.id, items: items });
      closePop();
    };
    popRedraw = draw;
    draw();
    inp.addEventListener('input', function () { pickSel = -1; draw(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.keyCode === 40) { e.preventDefault(); e.stopPropagation(); pickSel = Math.min(rows.length - 1, pickSel + 1); draw(); }
      else if (e.key === 'ArrowUp' || e.keyCode === 38) { e.preventDefault(); e.stopPropagation(); pickSel = Math.max(0, pickSel - 1); draw(); }
      else if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); e.stopPropagation(); take(pickSel); }
    });
    back.addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-pop]') : null;
      if (e.target === back || (b && b.getAttribute('data-pop') === 'close')) { closePop(); return; }
      if (b && b.getAttribute('data-pop') === 'pick') take(Number(b.getAttribute('data-i')));
    });
    focusIn('mus-pick-q');
    try { inp.select(); } catch (err) {}
  }

  /* ------------------------------------------------------ the actions -- */

  function videosOfDrawn() {
    return drawn.filter(function (r) { return r.kind === 'video'; }).map(function (r) { return r.v; });
  }

  function playVideoRow(i) {
    const row = drawn[i];
    if (!row || row.kind !== 'video') return;
    /* the list from this row on becomes the queue — a search or the starred
       list plays on like an album */
    const vids = videosOfDrawn();
    const at = vids.indexOf(row.v);
    act({ act: 'yt-play', items: vids, index: Math.max(0, at) });
  }

  function makePlaylist(name) {
    name = String(name || '').trim();
    if (!name) { focusSearch(); toast('Type the new playlist’s name in the search bar, then press Enter', true); return; }
    act({ act: 'pl-new', name: name });
  }

  function bringSelected() {
    const row = drawn[sel];
    if (!row) return false;
    if (row.kind === 'video') playVideoRow(sel);
    else if (row.kind === 'type') act({ act: 'sk-play', id: row.r.t.id });
    else if (row.kind === 'pl') openPlaylist(row.p.id);
    else if (row.kind === 'plnew') makePlaylist(row.name);
    return true;
  }

  function onClick(e) {
    const b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    const a = b.getAttribute('data-act');
    const i = Number(b.getAttribute('data-i'));
    const row = drawn[i];
    switch (a) {
      case 'mode': mode = b.getAttribute('data-mode'); sel = 0; renderModes(); renderList(true); focusSearch(); break;
      case 'kind': kind = b.getAttribute('data-kind'); sel = 0; renderModes(); renderList(true); break;
      case 'tuneKind': mode = 'sk'; kind = b.getAttribute('data-kind'); sel = 0; setQ(''); renderModes(); renderList(true); break;
      case 'toggle': act({ act: 'yt-toggle' }); break;
      case 'stop': act({ act: 'yt-stop' }); break;
      case 'next': act({ act: 'yt-next' }); break;
      case 'prev': act({ act: 'yt-prev' }); break;
      case 'repeat': act({ act: 'yt-repeat', mode: b.getAttribute('data-mode') }); break;
      case 'repeatCycle': {
        const ids = REPEAT.map(function (r) { return r.id; });
        act({ act: 'yt-repeat', mode: ids[(ids.indexOf(settings().repeat) + 1) % ids.length] });
        break;
      }
      case 'mute': act({ act: 'mute', on: !settings().mute }); break;
      case 'favCur': { const c = current(); if (c) act({ act: 'fav', kind: 'video', item: c, on: !isFavVideo(c) }); break; }
      case 'listCur': { const c = current(); if (c) openPicker([c], c.title); break; }
      case 'favPlaying': { const c = engine().current; if (c) act({ act: 'fav', kind: 'type', id: c.id, on: !isFavType(c.id) }); break; }
      case 'recheck': ask(false); toast('Looking for mpv and yt-dlp again…', true); break;
      case 'skRelease': act({ act: 'sk-release' }); break;
      case 'skAgain': act({ act: 'sk-again' }); break;
      case 'clearQueue': act({ act: 'yt-clear' }); break;
      case 'saveQueue': { const qu = queue(); openPicker(qu, songs(qu.length) + ' from the queue', ''); break; }
      case 'saveResults': {
        const v = videosOfDrawn();
        const s = (st && st.search) || {};
        openPicker(v, songs(v.length) + (mode === 'fav' ? ' you starred' : ' from this search'), mode === 'yt' ? (s.title || s.q || '') : 'Starred');
        break;
      }
      case 'jump': if (!(e.target.closest && e.target.closest('.mus-x'))) act({ act: 'yt-jump', index: i }); break;
      case 'drop': e.stopPropagation(); act({ act: 'yt-drop', index: i }); break;
      case 'playAll': { const v = videosOfDrawn(); if (v.length) act({ act: 'yt-play', items: v, index: 0 }); break; }
      case 'playRow':
        if (e.target.closest && e.target.closest('.mus-row-acts')) break;
        sel = i; playVideoRow(i); break;
      case 'queueRow': e.stopPropagation(); if (row && row.v) act({ act: 'yt-add', item: row.v }); break;
      case 'listRow': e.stopPropagation(); if (row && row.v) openPicker([row.v], row.v.title); break;
      case 'favRow': e.stopPropagation(); if (row && row.v) act({ act: 'fav', kind: 'video', item: row.v, on: !isFavVideo(row.v) }); break;
      case 'holdRow':
        if (e.target.closest && e.target.closest('.mus-row-acts')) break;
        sel = i; if (row && row.r) act({ act: 'sk-play', id: row.r.t.id }); break;
      case 'tracks': e.stopPropagation(); if (row && row.r) openTracks(row.r.t); break;
      case 'favType': e.stopPropagation(); if (row && row.r) act({ act: 'fav', kind: 'type', id: row.r.t.id, on: !isFavType(row.r.t.id) }); break;
      case 'openPl':
        /* the row and its Open button share the act; a press on another
           button in the row is that button's */
        if (b.classList.contains('mus-row') && e.target.closest && e.target.closest('.mus-row-acts')) break;
        e.stopPropagation(); sel = i; if (row && row.p) openPlaylist(row.p.id); break;
      case 'plPlay': e.stopPropagation(); if (row && row.p) playPl(row.p, false, 0); break;
      case 'plShuffle': e.stopPropagation(); if (row && row.p) playPl(row.p, true); break;
      case 'plNew': sel = i; makePlaylist(row && row.name); break;
      case 'clearQ': setQ(''); focusSearch(); break;
      case 'search': runSearch(); break;
    }
  }

  function runSearch() {
    const inp = $('mus-search');
    const v = inp ? inp.value.trim() : q;
    if (mode === 'yt') {
      if (!v) { toast('Type something to search for', false); return; }
      if (!toolsReady()) { toast('mpv and yt-dlp are not set up yet — the speaker says where they go', false); return; }
      act({ act: 'yt-search', q: v });
      return;
    }
    bringSelected();
  }

  /* tuning scale: press and drag to scrub, release to seek. Ultralight can
     report buttons === 0 on a held move, so the drag runs from mousedown to
     mouseup, never from that field (the deck's slider law). */
  function seekFrom(e, commit) {
    const bar = $('mus-prog');
    const s = stream();
    if (!bar || !(s.dur > 0) || !streamOnAir()) return;
    const r = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    const fill = $('mus-prog-fill');
    if (fill) fill.style.width = (p * 100).toFixed(2) + '%';
    const needle = $('mus-needle');
    if (needle) needle.style.left = (p * 100).toFixed(2) + '%';
    const pos = $('mus-pos');
    if (pos) pos.textContent = fmtTime(p * s.dur);
    if (commit) act({ act: 'yt-seek', sec: p * s.dur });
  }

  /* ---------------------------------------------------------- the keys -- */

  function moveSel(d) {
    if (!drawn.length) return;
    sel = Math.max(0, Math.min(drawn.length - 1, sel + d));
    renderList(true);
    const el = document.querySelector('#mus-list .mus-row.sel');
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (err) { el.scrollIntoView(false); } }
  }

  function focusSearch() {
    const inp = $('mus-search');
    if (inp) { try { inp.focus(); } catch (e) {} }
  }

  /* Called by app.js onKeyDown (capture phase) while this tab is up, BEFORE
     the search box's own listener. True = handled. */
  function onKey(e) {
    if (pop) {
      if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) { closePop(); return true; }
      return false;
    }
    const inp = $('mus-search');
    const inSearch = inp && document.activeElement === inp;
    const knob = $('mus-vol');
    if (knob && document.activeElement === knob) {
      const step = (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.keyCode === 38 || e.keyCode === 39) ? 5 :
        (e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.keyCode === 40 || e.keyCode === 37) ? -5 : 0;
      if (step) { setVol(settings().vol + step); return true; }
    }
    const typing = !inSearch && document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (inSearch) {
      if ((e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) && inp.value) { setQ(''); return true; }
      return false;   // the box's own keydown owns arrows / Enter
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'ArrowDown' || e.keyCode === 40) { moveSel(1); return true; }
    if (e.key === 'ArrowUp' || e.keyCode === 38) { moveSel(-1); return true; }
    if ((e.key === 'Enter' || e.keyCode === 13) && drawn.length) { bringSelected(); return true; }
    if (inp && (e.key === '/' || (e.key && e.key.length === 1 && /[a-z0-9]/i.test(e.key)))) {
      focusSearch();
      setQ(e.key === '/' ? inp.value : inp.value + e.key);
      return true;
    }
    return false;
  }

  function setQ(v) {
    const inp = $('mus-search');
    if (inp && inp.value !== v) inp.value = v;
    q = String(v || '').trim();
    sel = 0;
    selAuto = true;
    const c = $('mus-clear');
    if (c) c.classList.toggle('hidden', !q);
    renderList(true);
    const el = $('mus-list');
    if (el) el.scrollTop = 0;
  }

  /* ----------------------------------------------------- C++ -> view ---- */

  function apply(d) {
    st = d;
    if (Array.isArray(d.types)) types = d.types;
    if (Array.isArray(d.playlists)) { playlists = d.playlists; plSeq = d.plSeq; plThumb = d.thumbSeq; }
  }

  function redraw(fn) {
    if (!shown) return;
    if (window.HDBurst && HDBurst.defer('music', fn)) return;
    fn();
  }

  function redrawPop() { if (popRedraw) { try { popRedraw(); } catch (e) { console.log('[music] popout redraw', e); } } }

  window.muStateData = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object' || !d.stream) return;
    const hadPl = Array.isArray(d.playlists);
    apply(d);
    /* a deck search that warmed us is still open — re-run it with the list */
    if ((Array.isArray(d.types) || hadPl) && window.HDOmni && HDOmni.rerender) { try { HDOmni.rerender(); } catch (e) {} }
    redraw(function () { renderLive(); if (hadPl) redrawPop(); });
  };

  window.muResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    const hadPl = !!(d.state && Array.isArray(d.state.playlists));
    if (d.state) { const keep = types; apply(d.state); if (!Array.isArray(d.state.types)) types = keep; }
    /* a playlist made from the browser's own "make" row opens at once */
    const opened = d.ok && d.id && mode === 'pl' && !pop;
    if (!shown) { if (d.msg) console.log('[music]', d.msg); return; }
    redraw(function () {
      renderLive();
      if (hadPl) redrawPop();
      if (opened && plById(d.id)) { setQ(''); openPlaylist(d.id); }
      if (d.msg) toast(d.msg, !!d.ok);
    });
  };

  /* -------------------------------------------------------------- poll -- */

  function poll() {
    clearTimeout(pollT);
    if (!shown) return;
    ask(false);
    pollT = setTimeout(poll, POLL_MS);
  }

  /* -------------------------------------------------------------- wire -- */

  function init() {
    if (wired) return;
    const root = $('mus-pane');
    if (!root) return;
    wired = true;
    root.addEventListener('click', onClick);
    root.addEventListener('mousedown', function (e) {
      const el = e.target.closest ? e.target.closest('#mus-prog, #mus-vol') : null;
      if (!el || e.button !== 0) return;
      const isVol = el.id === 'mus-vol';
      /* the idle scale is a row of station keys, not a seek bar */
      if (!isVol && !(streamOnAir() && stream().dur > 0)) return;
      e.preventDefault();
      /* the knob turns with the drag: right or up raises it, two pixels a
         step, from where the press began */
      const x0 = e.clientX, y0 = e.clientY, v0 = settings().vol;
      const volAt = function (ev) { return v0 + ((ev.clientX - x0) - (ev.clientY - y0)) / 2; };
      if (isVol) { volDrag = true; try { el.focus(); } catch (err) {} } else { seeking = true; seekFrom(e, false); }
      const move = function (ev) { if (isVol) setVol(volAt(ev)); else seekFrom(ev, false); };
      const up = function (ev) {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        window.removeEventListener('blur', up, true);
        const real = ev && ev.type === 'mouseup' && ev.clientX != null;
        if (isVol) { volDrag = false; if (real) setVol(volAt(ev), true); }
        else { seeking = false; if (real) seekFrom(ev, true); }
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      window.addEventListener('blur', up, true);
    });
    root.addEventListener('wheel', function (e) {
      const knob = e.target.closest ? e.target.closest('#mus-vol') : null;
      if (!knob) return;
      e.preventDefault();
      setVol(settings().vol + (e.deltaY < 0 ? 5 : -5));
    });
    const inp = $('mus-search');
    if (inp) {
      if (!$('mus-clear')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = 'mus-clear';
        b.className = 'mus-clear hidden';
        b.setAttribute('data-act', 'clearQ');
        b.setAttribute('aria-label', 'Clear the search');
        b.title = 'Clear (Esc)';
        b.textContent = '×';
        inp.parentNode.insertBefore(b, inp.nextSibling);
      }
      inp.addEventListener('input', function () { setQ(inp.value); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.keyCode === 40) { e.preventDefault(); e.stopPropagation(); moveSel(1); }
        else if (e.key === 'ArrowUp' || e.keyCode === 38) { e.preventDefault(); e.stopPropagation(); moveSel(-1); }
        else if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); e.stopPropagation(); runSearch(); }
        /* the host's onKey clears first inside the deck; this covers a box with
           no host listening (the harnesses) and costs nothing when it already ran */
        else if ((e.key === 'Escape' || e.keyCode === 27) && inp.value) { e.preventDefault(); e.stopPropagation(); setQ(''); }
      });
    }
  }

  function onShow() {
    init();
    shown = true;
    renderAll();
    /* the station list is walked fresh on every show: a music mod enabled
       since the last open is reflected at once */
    ask(true);
    clearTimeout(pollT);
    pollT = setTimeout(poll, POLL_MS);
  }

  function onHide() {
    shown = false;
    clearTimeout(pollT);
    closePop();
    clearTimeout(toastT);
    const t = $('mus-toast');
    if (t) t.classList.add('hidden');
    if (volT) {   // a volume turn still on its debounce lands now
      clearTimeout(volT);
      volT = 0;
      if (st && st.settings) act({ act: 'yt-vol', v: st.settings.vol });
    }
  }

  /* ---------------------------------------------------- deck search -- */
  /* Omni (Ctrl+F): the transport, release, starred songs, every playlist
     and every station in the load order. The list is asked for when the
     search opens, so it is searchable before the Music tab has been shown. */
  if (window.HDOmni) HDOmni.register({
    id: 'music', label: 'Music', tab: 'music',
    warm: function () {
      if (!types.length || Date.now() - warmAt > 60000) { warmAt = Date.now(); ask(true); }
    },
    pinRun: function (snap) { if (snap && snap.act) act(snap); },
    setFilter: function (v) { setQ(String(v || '')); },
    index: function () {
      const s = stream();
      const rows = [
        { label: s.playing && !s.paused ? 'Pause the music' : 'Play the music', detail: 'Music · ' + (current() ? current().title : 'the YouTube queue'),
          kind: 'music', icon: ART + 'resonator-64.png', keywords: 'music play pause resume radio song youtube stream',
          pin: 'mu:toggle', snap: { act: 'yt-toggle' }, run: function () { act({ act: 'yt-toggle' }); } },
        { label: 'Next song', detail: 'Music · skip to the next in the queue', kind: 'music', icon: ART + 'resonator-64.png',
          keywords: 'music next skip song track forward', pin: 'mu:next', snap: { act: 'yt-next' }, run: function () { act({ act: 'yt-next' }); } },
        { label: 'Stop the music', detail: 'Music · stop the stream; Skyrim’s music comes back', kind: 'music', icon: ART + 'resonator-64.png',
          keywords: 'music stop silence quiet stream', pin: 'mu:stop', snap: { act: 'yt-stop' }, run: function () { act({ act: 'yt-stop' }); } },
      ];
      const favs = (st && st.favVideos) || [];
      if (favs.length) rows.push({ label: 'Play starred songs', detail: 'Music · ' + favs.length + ' starred, as one queue', kind: 'music',
        icon: ART + 'resonator-64.png', keywords: 'music starred favourite favorite songs playlist',
        pin: 'mu:favs', run: function () { act({ act: 'yt-play', items: favs, index: 0 }); } });
      playlists.forEach(function (p) {
        if (!plItems(p).length) return;
        rows.push({ label: 'Play playlist ' + p.name, detail: 'Music · playlist · ' + plSub(p), kind: 'playlist',
          icon: ART + 'resonator-64.png', keywords: 'music playlist play list songs ' + p.name,
          pin: 'mu:pl:' + p.id, run: function () { const cur = plById(p.id); if (cur) playPl(cur, false, 0); } });
      });
      if (engine().held) rows.push({ label: 'Release ' + engine().held.label, detail: 'Music · let Skyrim pick its own music again', kind: 'music',
        icon: medal(engine().held.kind, 'small'), keywords: 'music release skyrim station held stop holding',
        pin: 'mu:release', snap: { act: 'sk-release' }, run: function () { act({ act: 'sk-release' }); } });
      types.forEach(function (t) {
        rows.push({ label: 'Tune to ' + (t.label || t.edid), detail: 'Skyrim station · ' + (KIND_NAME[t.kind] || t.kind) + ' · ' + t.tracks + ' tracks · ' + t.plugin,
          kind: isFavType(t.id) ? '★ station' : 'station', icon: medal(t.kind, 'small'),
          keywords: 'music skyrim station hold play ' + t.edid + ' ' + t.kind + ' ' + (KIND_NAME[t.kind] || '') + ' ' + t.editedBy,
          pin: 'mu:sk:' + t.id, snap: { act: 'sk-play', id: t.id }, run: function () { act({ act: 'sk-play', id: t.id }); } });
      });
      return rows;
    },
  });

  return {
    init: init, onShow: onShow, onHide: onHide, onKey: onKey,
    _state: function () { return { st: st, types: types, playlists: playlists, plSeq: plSeq, mode: mode, kind: kind, q: q, sel: sel, drawn: drawn }; },
  };
})();
