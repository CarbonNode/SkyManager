'use strict';

/* ============================================================================
   SkyManager HUD — the Minimap (Detailed MiniMap, SkyManager build).

   Rober, 2026-10-09, linking Neutral9/DetailedMiniMap: "can we hook this and
   its settings into skymanager? and maybe ability to easily drag it around
   screen and maybe add some cool generated frames for it? Focus square /
   rectangle".

   Detailed MiniMap draws itself through SKSE Menu Framework's ImGui, not
   through this view. What this file owns is the CONFIGURATION of it:
     • a "Minimap" section in the HUD editor's shelf (hud.js buildSettings
       appends HudMinimap.section()), searchable by the shelf's own filter;
     • a GHOST box over the minimap while the editor is up: drag it to move the
       map, drag a corner to resize it (live — DMM moves under the cursor), the
       wheel over it steps the size. The real map is outlined by DMM itself in
       preview, so the true edge shows even if ImGui paints over this view.

   ---------------------------------------------------------------- bridge ----
   toGame('mmCfg', json)
     {op:'get'}                                   → mmCfgState
     {op:'set', values:{'Section.Key':v}, save}   → mmCfgState
     {op:'place', l,t,w,h, save, quiet}           — fractions of the viewport
     {op:'reset', what:'look'|'map'}
   window.mmCfgState(obj) — {present, api, ok, msg, settings, ranges, kinds,
     frames:[{id,name,thumb}], iconStyles, rect:{l,t,w,h}|null, preview, keys}

   Integration with hud.js is through two names only: window.HudShelfApi (what
   hud.js exposes: rebuild / reveal / isOpen) and window.HudMinimap (this).
   Either can load first; neither is required by the other to work.

   ⚠ ULTRALIGHT. A held mouse can report e.buttons === 0, so a drag lives from
   mousedown to mouseup/blur and never reads `buttons`. Preset buttons, not
   sliders. No looping animation. Every number off the wire is clamped here.
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else if (DEV) {
      console.log('[hud->game]', fn, arg);
    }
  }
  function send(obj) { toGame('mmCfg', JSON.stringify(obj)); }
  function log(msg) { toGame('hudLog', 'minimap: ' + msg); }
  function shelf() { return window.HudShelfApi || null; }

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null || attrs[k] === false) continue;
      if (k === 'class') node.className = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    for (const kid of kids) if (kid != null && kid !== false)
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return node;
  }
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---- state --------------------------------------------------------------
     `st` is the last mmCfgState (null = never heard). `editing` mirrors the
     HUD editor. `drag` is the in-flight ghost drag. */
  let st = null;
  let editing = false;
  let drag = null;
  let frameQ = '';
  let askedThisEdit = false;

  function S(key, d) {
    const v = st && st.settings ? st.settings[key] : undefined;
    return v === undefined ? d : v;
  }
  function range(key, lo, hi) {
    const r = st && st.ranges ? st.ranges[key] : null;
    return (Array.isArray(r) && r.length === 2) ? [num(r[0], lo), num(r[1], hi)] : [lo, hi];
  }
  function usable() { return !!(st && st.present && num(st.api, 0) >= 1); }
  function isRound() { return S('Map.MinimapRound', false) === true; }

  /* ---- the presets (one table each — label beside value, so a row can never
     disagree with what it sends) ------------------------------------------ */
  const SHAPES = [
    { id: 'square', label: 'Square', aspect: 1 },
    { id: 'rect', label: '4:3', aspect: 4 / 3 },
    { id: 'wide', label: 'Wide 16:9', aspect: 16 / 9 },
    { id: 'tall', label: 'Tall 3:4', aspect: 3 / 4 },
    { id: 'round', label: 'Round', round: true },
  ];
  const SIZES = [['S', 200], ['M', 260], ['L', 340], ['XL', 460]];
  const CORNERS = [['Sharp', 0], ['Soft', 16], ['Rounded', 40]];
  const FRAME_W = [['Thin', 0.7], ['Normal', 1], ['Bold', 1.4]];
  const OPACITY = [['100%', 1], ['85%', 0.85], ['70%', 0.7], ['50%', 0.5]];
  const RANGE_OUT = [['Close', 2500], ['Normal', 3700], ['Far', 6000]];
  const RANGE_IN = [['Close', 800], ['Normal', 1200], ['Far', 2000]];
  const TILT = [['Flat', 90], ['Tilted', 55], ['Low', 35]];
  const ICONS = [
    ['enemy', 'Enemies'], ['guard', 'Guards'], ['npc', 'People'], ['follower', 'Followers'],
    ['creature', 'Animals'], ['door', 'Doors'], ['food', 'Food'], ['potion', 'Potions'],
    ['container', 'Chests'], ['weapon', 'Weapons'], ['armor', 'Armour'], ['loot', 'Loot'],
    ['quest', 'Quest targets'], ['body', 'Bodies'], ['flora', 'Plants'], ['ore', 'Ore veins'],
  ];
  const CORNER_NAMES = ['Top left', 'Top right', 'Bottom left', 'Bottom right'];

  function shapeId() {
    if (isRound()) return 'round';
    const a = num(S('Map.MinimapAspect', 1), 1);
    let best = '', bd = 1e9;
    for (const s of SHAPES) if (!s.round) {
      const d = Math.abs(s.aspect - a);
      if (d < bd) { bd = d; best = s.id; }
    }
    return bd < 0.03 ? best : '';
  }

  /* ---- writing ------------------------------------------------------------
     Optimistic: the local copy changes at once so the shelf marks the pick,
     and the game's reply (mmCfgState) corrects it if DMM clamped it. */
  function setValues(values) {
    if (!usable()) return;
    for (const k in values) st.settings[k] = values[k];
    send({ op: 'set', values: values, save: true });
    rebuild();
  }
  function rebuild() {
    const api = shelf();
    if (api && typeof api.rebuild === 'function') { try { api.rebuild(); } catch (e) { log('rebuild threw ' + e.message); } }
  }

  /* ---- the reply ------------------------------------------------------------ */
  window.mmCfgState = function (s) {
    let j = s;
    if (typeof s === 'string') { try { j = JSON.parse(s); } catch (e) { log('parse ' + e); return; } }
    if (!j || typeof j !== 'object') return;
    if (!j.settings || typeof j.settings !== 'object') j.settings = {};
    st = j;
    /* a reply that lands mid-drag must not yank the ghost back to where the
       game last saved it — the drag owns the box until it lets go */
    if (!drag) placeGhost();
    rebuild();
  };

  /* ================================================== the shelf section === */
  function chip(label, act, val, on, title, disabled) {
    return h('button', {
      class: 'hud-el-chip' + (on ? ' on' : ''), type: 'button',
      'data-mm': act, 'data-mmv': val === undefined ? '' : String(val),
      title: title || label, disabled: !!disabled, 'aria-pressed': on ? 'true' : 'false',
    }, label);
  }
  function label(text) { return h('div', { class: 'hud-mm-lab' }, text); }
  function row(id, name, words, icon) {
    const r = h('div', { class: 'hud-el hud-mm-row', 'data-el': id,
      'data-elname': (name + ' minimap mini map detailed ' + (words || '')).toLowerCase() });
    const head = h('div', { class: 'hud-el-head' });
    const ic = h('span', { class: 'hud-el-ic' }, icon || '◈');
    head.appendChild(ic);
    head.appendChild(h('span', { class: 'hud-el-name', title: name }, name));
    r.appendChild(head);
    return { row: r, head: head, body: r.appendChild(h('div', { class: 'hud-el-body' })) };
  }
  function seg(items) {
    const s = h('div', { class: 'hud-el-chips hud-el-seg hud-mm-seg' });
    for (const c of items) s.appendChild(c);
    return s;
  }
  function chips(items, cls) {
    const s = h('div', { class: 'hud-el-chips' + (cls ? ' ' + cls : '') });
    for (const c of items) s.appendChild(c);
    return s;
  }
  const near = (a, b, eps) => Math.abs(num(a, -1e9) - b) <= (eps || 0.5);

  function emptyCard(title, text) {
    const r = row('minimap', 'Minimap', 'install missing detailed minimap skse menu framework');
    r.body.appendChild(h('div', { class: 'hud-mm-empty' },
      h('b', null, title), h('span', null, text)));
    return r.row;
  }

  function section() {
    const sec = h('div', { class: 'hud-el-sec hud-mm-sec', 'data-sec': 'minimap' },
      h('div', { class: 'hud-el-secname' }, 'Minimap'));
    sec.appendChild(h('div', { class: 'hud-el-subhead' },
      'Detailed MiniMap — a live 3D map of the cells around you. Drag the gold box on screen to move it; drag a corner to resize.'));
    if (!st) {
      if (!askedThisEdit) { askedThisEdit = true; send({ op: 'get' }); }
      sec.appendChild(emptyCard('Asking the minimap…', 'Waiting for Detailed MiniMap to answer. If this stays, the game has not loaded it.'));
      return wire(sec);
    }
    if (!st.present) {
      sec.appendChild(emptyCard('Detailed MiniMap is not loaded',
        st.msg || 'Install the SkyManager build of Detailed MiniMap (it needs SKSE Menu Framework), tick it in MO2, and relaunch.'));
      return wire(sec);
    }
    if (num(st.api, 0) < 1) {
      sec.appendChild(emptyCard('This is the stock Detailed MiniMap',
        'Its settings cannot be reached live from here. Install the SkyManager build of Detailed MiniMap to configure, drag and frame it from this shelf. Its own page still works: Omni → type “Detailed MiniMap”.'));
      return wire(sec);
    }
    const round = isRound();
    const keys = st.keys || {};

    /* ---- 1. on/off + placement ---- */
    {
      const r = row('minimap', 'Minimap', 'radar compass local map show hide toggle place move corner snap position reset', '◈');
      const vis = S('Map.Visible', true) === true;
      const sw = h('button', { class: 'hud-opt hud-el-sw' + (vis ? ' on' : ''), type: 'button',
        'data-mm': 'visible', title: vis ? 'Hide the minimap' : 'Show the minimap', 'aria-pressed': vis ? 'true' : 'false' },
        vis ? 'On' : 'Off');
      r.head.appendChild(sw);
      if (S('Map.Enabled', true) === false)
        r.body.appendChild(h('div', { class: 'hud-el-note hud-mm-warn' },
          'The map is switched off in Detailed MiniMap itself.'));
      if (S('Map.Enabled', true) === false)
        r.body.appendChild(chips([chip('Turn the map on', 'enable', 1, false, 'Detailed MiniMap’s master switch')]));
      r.body.appendChild(h('div', { class: 'hud-el-note' },
        'Show / hide during play: ' + (keys.toggle || 'no key') + '. Zoom: ' + (keys.zoomIn || '—') + ' / ' + (keys.zoomOut || '—') + '.'));
      r.body.appendChild(label('Snap to a corner'));
      const a = num(S('Map.Anchor', 1), 1);
      const atEdge = near(S('Map.OffsetX', 18), 18, 1) && near(S('Map.OffsetY', 18), 18, 1);
      r.body.appendChild(chips(CORNER_NAMES.map(function (n, i) {
        return chip(n, 'corner', i, atEdge && a === i, 'Put the minimap in the ' + n.toLowerCase() + ' corner');
      }), 'hud-mm-grid4'));
      sec.appendChild(r.row);
    }

    /* ---- 2. shape + size ---- */
    {
      const r = row('minimap-shape', 'Shape & size', 'square rectangle wide tall round circle aspect size bigger smaller corner rounding', '▭');
      const sid = shapeId();
      r.body.appendChild(seg(SHAPES.map(function (s) {
        return chip(s.label, 'shape', s.id, sid === s.id,
          s.round ? 'A round minimap (it takes Detailed MiniMap’s own round frames)' : 'A ' + s.label.toLowerCase() + ' minimap');
      })));
      const size = num(S('Map.MinimapSize', 600), 600);
      const [smin, smax] = range('Map.MinimapSize', 100, 900);
      r.body.appendChild(label('Size — ' + Math.round(size) + ' px tall at 1080p'));
      const sc = SIZES.map(function (p) { return chip(p[0], 'size', p[1], near(size, p[1], 1), p[1] + ' px tall at 1080p'); });
      sc.push(chip('−', 'sizeby', -20, false, 'Smaller by 20', size <= smin));
      sc.push(chip('＋', 'sizeby', 20, false, 'Bigger by 20', size >= smax));
      r.body.appendChild(chips(sc, 'hud-mm-size'));
      r.body.appendChild(label('Corners'));
      const cr = num(S('Map.MinimapCorner', 40), 40);
      r.body.appendChild(seg(CORNERS.map(function (c) {
        return chip(c[0], 'corner-r', c[1], !round && near(cr, c[1], 1),
          round ? 'A round map has no corners' : c[0] + ' corners', round);
      })));
      if (round) r.body.appendChild(h('div', { class: 'hud-el-note' }, 'Round maps have no corners to round.'));
      sec.appendChild(r.row);
    }

    /* ---- 3. frame ---- */
    {
      const r = row('minimap-frame', 'Frame', 'frame border edge ornate picture nordic gold silver iron thin bold skymanager plate line hud rope frost embers compass', '▣');
      /* SkyManager's own frames (drawn from this view's tokens, so they sit with the widgets
         and the action bar) lead the grid; our generated nine-slice set follows, then
         Detailed MiniMap's own picture frames (kind "picture"), each group in DMM's order */
      const OWN = ['skymanager-plate', 'skymanager-line'];   /* the default first */
      const rank = function (f) {
        const k = OWN.indexOf(String(f && f.id || ''));
        return k !== -1 ? k : (f && f.kind === 'picture' ? OWN.length + 1 : OWN.length);
      };
      const frames = (Array.isArray(st.frames) ? st.frames.slice() : [])
        .map(function (f, i) { return { f: f, i: i }; })
        .sort(function (a, b) { return rank(a.f) - rank(b.f) || a.i - b.i; })
        .map(function (x) { return x.f; });
      const on = S('Map.MinimapFrame', true) === true;
      const style = String(S('MapLook.FrameStyle', '') || '');
      /* which map shapes a frame goes round: the build says ("fits"); a build from before it
         had nine-slice frames only, which fit square and rectangle maps */
      const shape = round ? 'round' : 'square';   /* every non-round shape takes the same frames */
      const fits = function (f) { return Array.isArray(f.fits) ? f.fits.indexOf(shape) !== -1 || (shape === 'square' && f.fits.indexOf('rect') !== -1) : !round; };
      const cur = frames.filter(function (f) { return f && f.id === style; })[0];
      const curFits = !!cur && fits(cur);
      if (round && frames.some(function (f) { return f && !fits(f); })) r.body.appendChild(h('div', { class: 'hud-el-note hud-mm-warn' },
        frames.some(function (f) { return f && fits(f); })
          ? 'A round map takes Detailed MiniMap’s own frames. The others fit square and rectangle maps — pick one of those shapes above to use them.'
          : 'Picture frames fit square and rectangle maps. A round map wears its drawn ring — pick a square or rectangle shape above to use one.'));
      if (frames.length > 8) {
        const inp = h('input', { class: 'hud-mm-ffilter', id: 'hud-mm-ffilter', type: 'text',
          placeholder: 'Search frames…', autocomplete: 'off', spellcheck: 'false' });
        inp.value = frameQ;
        r.body.appendChild(inp);
      }
      const grid = h('div', { class: 'hud-mm-frames' });
      const tile = function (act, val, name, sel, thumb, title, disabled, words) {
        const t = h('button', { class: 'hud-mm-frame' + (sel ? ' on' : ''), type: 'button',
          'data-mm': act, 'data-mmv': val, title: title, 'data-mmname': (name + ' ' + val + ' ' + (act === 'frame-none' ? 'none no frame' : act === 'frame-drawn' ? 'drawn line ring style' : (words || ''))).toLowerCase(), disabled: !!disabled, 'aria-pressed': sel ? 'true' : 'false' });
        const art = h('span', { class: 'hud-mm-fart' + (thumb ? '' : ' is-plain') });
        if (thumb) {
          const im = h('img', { src: thumb, alt: '', draggable: 'false' });
          im.onerror = function () { try { im.remove(); } catch (e) {} art.classList.add('is-plain'); };
          art.appendChild(im);
        } else art.appendChild(h('span', { class: 'hud-mm-fmark' + (act === 'frame-none' ? ' is-none' : '') }));
        t.appendChild(art);
        t.appendChild(h('span', { class: 'hud-mm-fname' }, name));
        return t;
      };
      grid.appendChild(tile('frame-none', '', 'None', !on, null, 'No frame — just the map’s own edge'));
      grid.appendChild(tile('frame-drawn', '', 'Drawn line', on && (!style || !curFits), null,
        'The map style’s own thin frame'));
      for (const f of frames) {
        if (!f || typeof f.id !== 'string') continue;
        const nm = String(f.name || f.id);
        const ok = fits(f);
        const dmm = f.kind === 'picture';
        grid.appendChild(tile('frame', f.id, nm, on && ok && style === f.id, f.thumb || null,
          !ok ? nm + ' — square and rectangle maps only' : dmm ? nm + ' — Detailed MiniMap’s own frame' : nm, !ok,
          dmm ? 'detailed minimap dmm own round' : ''));
      }
      r.body.appendChild(grid);
      r.body.appendChild(h('div', { class: 'hud-mm-nomatch is-hid' }));
      if (!frames.length) r.body.appendChild(h('div', { class: 'hud-el-note' },
        'No picture frames are installed yet — they live in Data/Textures/DetailedMiniMap/frames.'));
      if (on && curFits && cur.kind !== 'picture') {   /* the width is a nine-slice frame's; a picture keeps its own */
        const fs = num(S('MapLook.FrameScale', 1), 1);
        r.body.appendChild(label('Frame width'));
        r.body.appendChild(seg(FRAME_W.map(function (w) { return chip(w[0], 'framew', w[1], near(fs, w[1], 0.04)); })));
      }
      sec.appendChild(r.row);
    }

    /* ---- 4. look ---- */
    {
      const r = row('minimap-look', 'Look', 'style colour color vanilla sepia icons icon style opacity transparent fade', '◐');
      const sty = num(S('MapLook.Style', 1), 1);
      r.body.appendChild(seg([
        chip('Colour', 'style', 0, sty === 0, 'Coloured ground, buildings, roads and water'),
        chip('Vanilla', 'style', 1, sty === 1, 'The game’s own local-map look: sepia, with its frame'),
      ]));
      const styles = Array.isArray(st.iconStyles) ? st.iconStyles : [];
      if (styles.length) {
        const cur = String(S('MapLook.IconStyle', ''));
        r.body.appendChild(label('Icon style'));
        r.body.appendChild(chips(styles.slice(0, 24).map(function (n) {
          return chip(String(n), 'iconstyle', String(n), cur === String(n), 'Icons from the “' + n + '” set');
        })));
      }
      const op = num(S('Map.MinimapOpacity', 1), 1);
      r.body.appendChild(label('Opacity'));
      r.body.appendChild(seg(OPACITY.map(function (o) { return chip(o[0], 'opacity', o[1], near(op, o[1], 0.02)); })));
      r.body.appendChild(chips([chip('Reset the look', 'reset', 'look', false, 'Colours, lines and roads back to Detailed MiniMap’s defaults (the style stays)')]));
      sec.appendChild(r.row);
    }

    /* ---- 5. view ---- */
    {
      const r = row('minimap-view', 'View', 'zoom range distance tilt angle flat north up rotate turn camera inside outside', '◎');
      const ro = num(S('Map.MinimapRange', 3700), 3700), ri = num(S('Map.MinimapRangeInside', 1200), 1200);
      r.body.appendChild(label('Outside — how far it shows'));
      r.body.appendChild(seg(RANGE_OUT.map(function (p) { return chip(p[0], 'range', p[1], near(ro, p[1], 1)); })));
      r.body.appendChild(label('Inside — caves and houses'));
      r.body.appendChild(seg(RANGE_IN.map(function (p) { return chip(p[0], 'rangein', p[1], near(ri, p[1], 1)); })));
      const tl = num(S('Map.MinimapTilt', 55), 55);
      r.body.appendChild(label('Seen from'));
      r.body.appendChild(seg(TILT.map(function (p) {
        return chip(p[0], 'tilt', p[1], near(tl, p[1], 1), p[1] === 90 ? 'Straight down, like a paper map' : p[1] + '° above the ground');
      })));
      const nu = S('Map.NorthUp', false) === true;
      r.body.appendChild(seg([
        chip('Turns with the camera', 'northup', 0, !nu),
        chip('North stays up', 'northup', 1, nu),
      ]));
      sec.appendChild(r.row);
    }

    /* ---- 6. icons ---- */
    {
      const r = row('minimap-icons', 'Icons', 'icons markers enemies guards people followers animals doors food potions chests weapons armour armor loot quest targets bodies plants ore beam group empty containers', '✦');
      r.body.appendChild(chips(ICONS.map(function (p) {
        const on = S('Icons.Show_' + p[0], true) === true;
        return chip(p[1], 'icon', p[0], on, (on ? 'Hide ' : 'Show ') + p[1].toLowerCase() + ' on the map');
      }), 'hud-mm-icons'));
      r.body.appendChild(label('Extras'));
      r.body.appendChild(chips([
        chip('Quest beam', 'flag', 'Map.QuestBeam', S('Map.QuestBeam', true) === true, 'A glowing line to the nearest quest target (' + (keys.beam || 'no key') + ' shows / hides it)'),
        chip('Group close icons', 'flag', 'Map.GroupIcons', S('Map.GroupIcons', true) === true, 'Icons of one kind that overlap merge into one'),
        chip('Hide empty chests', 'flag', 'Map.HideEmpty', S('Map.HideEmpty', true) === true, 'Containers with nothing left to take are left off'),
      ], 'hud-mm-grid3'));
      sec.appendChild(r.row);
    }

    sec.appendChild(h('div', { class: 'hud-el-note hud-mm-keys' },
      'Keys are rebound on Detailed MiniMap’s own page: Omni → type “Detailed MiniMap”. Local map: ' + (keys.localMap || 'no key') + '.'));
    return wire(sec);
  }

  /* one listener per built section; the double-fire guard is the shelf's own
     (pointer AND mouse events on a browser that sends both) */
  function wire(sec) {
    let sawPointer = 0;
    const onDown = function (e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-mm]') : null;
      if (!t || t.disabled) return;
      e.preventDefault(); e.stopPropagation();
      act(t.getAttribute('data-mm'), t.getAttribute('data-mmv'));
    };
    sec.addEventListener('pointerdown', function (e) { sawPointer = Date.now(); onDown(e); });
    sec.addEventListener('mousedown', function (e) { if (Date.now() - sawPointer < 500) return; onDown(e); });
    const inp = sec.querySelector('#hud-mm-ffilter');
    if (inp) {
      /* narrowed IN PLACE — a rebuild would replace the input under the
         player's fingers (the shelf filter's own lesson, hud.js) */
      inp.addEventListener('input', function () { frameQ = inp.value; filterFrames(sec); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' || e.code === 'Escape') {
          if (inp.value) { frameQ = ''; inp.value = ''; filterFrames(sec); e.preventDefault(); e.stopPropagation(); }
          return;
        }
        if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
          /* Enter takes the top hit — the deck's law */
          const first = sec.querySelector('.hud-mm-frame[data-mm="frame"]:not([disabled]):not(.is-hid)');
          if (first) act('frame', first.getAttribute('data-mmv'));
          e.preventDefault(); e.stopPropagation();
        }
      });
    }
    filterFrames(sec);
    return sec;
  }
  function filterFrames(sec) {
    const q = frameQ.trim().toLowerCase();
    let shown = 0;
    const vis = [];
    for (const t of sec.querySelectorAll('.hud-mm-frame')) {
      const hit = !q || (t.getAttribute('data-mmname') || '').indexOf(q) !== -1;
      t.classList.toggle('is-hid', !hit);
      t.classList.remove('is-wide2', 'is-wide3');
      if (hit) { shown++; vis.push(t); }
    }
    /* three across, and a short last row stretches to fill it (Rober's rule: no grid ends
       on an empty cell) - whatever the frame count or the search leaves */
    const rem = vis.length % 3;
    if (rem === 2) { vis[vis.length - 2].classList.add('is-wide2'); vis[vis.length - 1].classList.add('is-wide2'); }
    else if (rem === 1 && vis.length > 1) vis[vis.length - 1].classList.add('is-wide3');
    const none = sec.querySelector('.hud-mm-nomatch');
    if (none) {
      none.textContent = shown ? '' : 'No frame matches “' + frameQ.trim() + '”.';
      none.classList.toggle('is-hid', !!shown);
    }
  }

  function act(a, v) {
    if (!usable() && a !== 'get') return;
    const n = parseFloat(v);
    switch (a) {
      case 'visible': setValues({ 'Map.Visible': !(S('Map.Visible', true) === true) }); break;
      case 'enable': setValues({ 'Map.Enabled': true }); break;
      case 'corner': setValues({ 'Map.Anchor': clamp(Math.round(n), 0, 3), 'Map.OffsetX': 18, 'Map.OffsetY': 18 }); break;
      case 'shape': {
        const s = SHAPES.filter(x => x.id === v)[0];
        if (!s) return;
        setValues(s.round ? { 'Map.MinimapRound': true } : { 'Map.MinimapRound': false, 'Map.MinimapAspect': Number(s.aspect.toFixed(4)) });
        break;
      }
      case 'size': setValues({ 'Map.MinimapSize': n }); break;
      case 'sizeby': {
        const [lo, hi] = range('Map.MinimapSize', 100, 900);
        setValues({ 'Map.MinimapSize': clamp(Math.round(num(S('Map.MinimapSize', 600), 600) + n), lo, hi) });
        break;
      }
      case 'corner-r': setValues({ 'Map.MinimapCorner': n }); break;
      case 'frame-none': setValues({ 'Map.MinimapFrame': false }); break;
      case 'frame-drawn': setValues({ 'Map.MinimapFrame': true, 'MapLook.FrameStyle': '' }); break;
      case 'frame': setValues({ 'Map.MinimapFrame': true, 'MapLook.FrameStyle': String(v || '') }); break;
      case 'framew': setValues({ 'MapLook.FrameScale': n }); break;
      case 'style': setValues({ 'MapLook.Style': Math.round(n) }); break;
      case 'iconstyle': setValues({ 'MapLook.IconStyle': String(v || '') }); break;
      case 'opacity': setValues({ 'Map.MinimapOpacity': n }); break;
      case 'range': setValues({ 'Map.MinimapRange': n }); break;
      case 'rangein': setValues({ 'Map.MinimapRangeInside': n }); break;
      case 'tilt': setValues({ 'Map.MinimapTilt': n }); break;
      case 'northup': setValues({ 'Map.NorthUp': n === 1 }); break;
      case 'icon': { const k = 'Icons.Show_' + v; setValues({ [k]: !(S(k, true) === true) }); break; }
      case 'flag': { const k = String(v); setValues({ [k]: !(S(k, true) === true) }); break; }
      case 'reset': send({ op: 'reset', what: v === 'map' ? 'map' : 'look' }); break;
      default: break;
    }
  }

  /* ================================================== the ghost ============ */
  let ghost = null;
  function ensureGhost() {
    if (ghost) return ghost;
    ghost = h('div', { id: 'hud-mm-ghost', 'aria-label': 'Minimap — drag to move, corner to resize' });
    ghost.appendChild(h('div', { class: 'hud-mm-glab' },
      h('b', null, 'Minimap'), h('span', null, 'drag to move · corner to resize')));
    for (const c of ['nw', 'ne', 'sw', 'se'])
      ghost.appendChild(h('span', { class: 'hud-mm-handle is-' + c, 'data-mmh': c }));
    let sawPointer = 0;
    ghost.addEventListener('pointerdown', function (e) { sawPointer = Date.now(); onGhostDown(e); });
    ghost.addEventListener('mousedown', function (e) { if (Date.now() - sawPointer < 500) return; onGhostDown(e); });
    ghost.addEventListener('wheel', onGhostWheel, { passive: false });
    (document.body || document.documentElement).appendChild(ghost);
    return ghost;
  }
  function vw() { return Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1); }
  function vh() { return Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1); }

  /* the rect in px — from the drag while one is live, else from the game */
  function rectPx() {
    if (drag) return drag.cur;
    const r = st && st.rect;
    if (!r || typeof r !== 'object') return null;
    const l = num(r.l, NaN), t = num(r.t, NaN), w = num(r.w, NaN), hh = num(r.h, NaN);
    if (!(w > 0) || !(hh > 0) || !isFinite(l) || !isFinite(t)) return null;
    return { x: l * vw(), y: t * vh(), w: w * vw(), h: hh * vh() };
  }
  function placeGhost() {
    const show = editing && usable() && !!rectPx();
    if (!show) { if (ghost) ghost.classList.remove('show'); return; }
    const g = ensureGhost();
    const r = rectPx();
    g.style.left = Math.round(r.x) + 'px';
    g.style.top = Math.round(r.y) + 'px';
    g.style.width = Math.round(r.w) + 'px';
    g.style.height = Math.round(r.h) + 'px';
    g.classList.toggle('is-round', isRound());
    g.classList.toggle('is-small', r.h < 170);
    g.classList.toggle('is-drag', !!drag);
    g.classList.add('show');
  }

  const SNAP = 14;                       // px — edge / centre pull
  const ASPECT_SNAPS = [1, 4 / 3, 16 / 9, 3 / 4];
  function edgeMargin() { return 18 * vh() / 1080; }
  function minH() { return range('Map.MinimapSize', 100, 900)[0] * vh() / 1080; }
  function maxH() { return Math.min(range('Map.MinimapSize', 100, 900)[1] * vh() / 1080, vh()); }

  function onGhostDown(e) {
    if (!editing || !usable() || (e.button !== undefined && e.button !== 0)) return;
    const r = rectPx();
    if (!r) return;
    const hnd = e.target && e.target.getAttribute ? e.target.getAttribute('data-mmh') : null;
    drag = { mode: hnd || 'move', sx: e.clientX, sy: e.clientY, start: Object.assign({}, r),
             cur: Object.assign({}, r), lastSend: 0, moved: false };
    const api = shelf();
    if (api && api.reveal) { try { api.reveal('minimap'); } catch (x) {} }
    window.addEventListener('mousemove', onGhostMove, true);
    window.addEventListener('mouseup', onGhostUp, true);
    window.addEventListener('pointermove', onGhostMove, true);
    window.addEventListener('pointerup', onGhostUp, true);
    window.addEventListener('blur', onGhostUp, true);
    placeGhost();
    e.preventDefault(); e.stopPropagation();
  }
  function snapGuide(on) {
    const g = document.getElementById('hud-fw-guide');
    if (g) g.classList.toggle('show', !!on);
  }
  function onGhostMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const s = drag.start, W = vw(), H = vh();
    let r;
    let centred = false;
    if (drag.mode === 'move') {
      r = { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h };
      const m = edgeMargin();
      /* pull to the usual 18px corner margin and to the screen's middle */
      if (Math.abs(r.x - m) < SNAP) r.x = m;
      if (Math.abs(r.x + r.w - (W - m)) < SNAP) r.x = W - m - r.w;
      if (Math.abs(r.y - m) < SNAP) r.y = m;
      if (Math.abs(r.y + r.h - (H - m)) < SNAP) r.y = H - m - r.h;
      if (Math.abs(r.x + r.w / 2 - W / 2) < SNAP) { r.x = W / 2 - r.w / 2; centred = true; }
    } else {
      /* resize from a corner: the opposite corner stays put */
      const left = drag.mode.indexOf('w') !== -1, top = drag.mode.indexOf('n') !== -1;
      const ax = left ? s.x + s.w : s.x, ay = top ? s.y + s.h : s.y;   // the anchor corner
      let w = left ? s.w - dx : s.w + dx, hh = top ? s.h - dy : s.h + dy;
      hh = clamp(hh, minH(), maxH());
      if (isRound()) w = hh;
      else {
        let a = clamp(w / hh, 0.5, 2.5);
        for (const sa of ASPECT_SNAPS) if (Math.abs(a - sa) / sa < 0.04) { a = sa; break; }
        w = hh * a;
      }
      r = { x: left ? ax - w : ax, y: top ? ay - hh : ay, w: w, h: hh };
    }
    r.x = clamp(r.x, 0, Math.max(0, W - r.w));
    r.y = clamp(r.y, 0, Math.max(0, H - r.h));
    drag.cur = r;
    snapGuide(centred);
    placeGhost();
    const now = Date.now();
    if (now - drag.lastSend >= 33) { drag.lastSend = now; sendPlace(r, false); }
    e.preventDefault();
  }
  function sendPlace(r, save) {
    const W = vw(), H = vh();
    const msg = { op: 'place', l: +(r.x / W).toFixed(5), t: +(r.y / H).toFixed(5),
      w: +(r.w / W).toFixed(5), h: +(r.h / H).toFixed(5), save: !!save };
    if (!save) msg.quiet = true;
    send(msg);
    if (save && st) st.rect = { l: msg.l, t: msg.t, w: msg.w, h: msg.h };
  }
  function endDrag(commitRect) {
    window.removeEventListener('mousemove', onGhostMove, true);
    window.removeEventListener('mouseup', onGhostUp, true);
    window.removeEventListener('pointermove', onGhostMove, true);
    window.removeEventListener('pointerup', onGhostUp, true);
    window.removeEventListener('blur', onGhostUp, true);
    const d = drag;
    drag = null;
    snapGuide(false);
    if (d && commitRect) sendPlace(commitRect, true);
    placeGhost();
  }
  function onGhostUp() {
    if (!drag) return;
    /* a click that never moved saves nothing — it only selected the map */
    endDrag(drag.moved ? drag.cur : null);
  }
  function cancelDrag() {
    if (!drag) return false;
    endDrag(drag.moved ? drag.start : null);
    return true;
  }
  /* the wheel over the box steps its size — the editor's own idiom for every
     other widget ("the mouse wheel over one resizes it") */
  let wheelT = 0;
  function onGhostWheel(e) {
    if (!editing || !usable() || drag) return;
    const raw = num(e.deltaY, 0) || (num(e.wheelDelta, 0) ? -e.wheelDelta : 0);
    if (!raw) return;
    e.preventDefault(); e.stopPropagation();
    const now = Date.now();
    if (now - wheelT < 60) return;
    wheelT = now;
    act('sizeby', raw > 0 ? -20 : 20);
  }
  /* Esc mid-drag puts the box back and STAYS in the editor (capture phase, so
     it lands before hud.js's own Esc, which leaves edit mode) */
  window.addEventListener('keydown', function (e) {
    if (!drag) return;
    if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
      cancelDrag(); e.preventDefault(); e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('resize', function () { if (!drag) placeGhost(); });

  /* ================================================== hud.js hooks ========= */
  window.HudMinimap = {
    section: section,
    onEdit: function (on) {
      on = !!on;
      if (on === editing) return;
      editing = on;
      if (on) { askedThisEdit = true; send({ op: 'get' }); }
      else {
        askedThisEdit = false;
        /* leaving the editor mid-drag keeps where the box was let go — same
           law as hud.js saveFree: a reposition must not silently revert */
        if (drag) endDrag(drag.moved ? drag.cur : null);
        frameQ = '';
      }
      placeGhost();
    },
    /* for the harness */
    _state: function () { return st; },
    _act: act,
  };
})();
