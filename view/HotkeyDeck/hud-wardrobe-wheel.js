'use strict';

/* ============================================================================
   Wardrobe Wheel — looks on a slow-time radial, each with a flyout of things
   to wear over it (Rober, 2026-10-12: "dedicated wardrobe wheel like the
   stance wheel, where you can assign outfits to a wheel, and add flyouts to
   each outfit that show 3d rendering of gear. so you have outfit, then a
   configurable flyout menu of any piece or combination of gear to equip over
   that outfit").

   Lives in the HUD view (hud.html) as its own fixed layer #hud-wwheel, a
   sibling of #hud-stance. C++ opens it (seeded action `wardrobe-wheel`),
   slows the world and gives this view UNPAUSED focus — the Combat Wheel's
   exact discipline (hud-stance.js). The looks and their flyouts are wardrobe
   Flair metadata (flair.wheel), resolved here with the shared model
   (wardrobe-flair-model.js wheelRows), so the deck editor, the phone portal
   and this wheel read one document.

   Aim at a look's wedge: that look alone. Aim past its rim: its flyout fans
   out there — each petal a Flair set or one single piece, drawn with the
   pieces' MRF renders (icons/items). Click / E / Enter / the wheel's own key
   wears the aimed choice; the side panel shows every piece it would put on.

   ---------------------------------------------------------------- bridge ----
   view -> C++ (HUD view listeners):
     wwGet()          — push me the state again
     wwPick(json)     — {kind:"outfit"|"wardrobe", id, choice:""|"set:<id>"|
                         "item:<0xid>|<plugin>"}; the view has ALREADY closed
     wwClose()        — closed without a pick
     wwIcons(json)    — {items:[{formId,plugin,name}]}: renders still missing
   C++ -> view:
     window.wwShow("1"|"0")   window.wwState(json {doc,renders,key,slow})
     window.wwKey()           window.wwIconsData(index json)

   ⚠ Same Ultralight laws as hud-stance.js: wrapped so an error never takes
   the renderer down; one-shot class flips, no looping animation; SVG
   geometry as ATTRIBUTES; explicit rgba(); images sized by LAYOUT (calc ×
   --ww-k), never scale(); the open layer turns pointer-events back on
   (hud.css makes the HUD body pointer-events:none).
   ============================================================================ */

(function () {
  const M = window.WardrobeFlairModel;
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('ww bridge error', fn, e); }
      return true;
    }
    if (DEV) console.log('[ww->game]', fn, arg);
    return false;
  }
  function log(msg) { try { toGame('hudLog', 'wardrobe-wheel: ' + msg); } catch (e) {} }
  function parse(s) {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ---- geometry (wheel units; the wrap is SIZE units across) --------------
     The ring of looks, then the flyout band OUTSIDE it: petals sit on R_FLY
     and reach the wrap's edge, so the whole wheel + flyout fits the square. */
  const SIZE = 1000, C = SIZE / 2;
  const R_IN = 168, R_OUT = 352;     // the looks' band
  const R_HUB = 152;                 // the hub disc
  const DEAD = 96;                   // centre dead zone
  const R_FLY = 434, PETAL = 120;    // petal centre radius and size (name inside)
  /* Degrees between petals. Petals are axis-aligned squares, so two on a
     diagonal need their centres a full PETAL apart on BOTH axes: chord ×
     cos45° >= PETAL, i.e. 2·R_FLY·sin(step/2)·0.707 >= 120 -> 23°. */
  const FLY_STEP = 23;
  const GAP_DEG = 2.5;

  function pt(r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  }
  function sectorPath(a0, a1, rOut, rIn) {
    const large = (a1 - a0) > 180 ? 1 : 0;
    const p0 = pt(rOut, a0), p1 = pt(rOut, a1), p2 = pt(rIn, a1), p3 = pt(rIn, a0);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      ' A' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
      ' L' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2) +
      ' A' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + p3[0].toFixed(2) + ' ' + p3[1].toFixed(2) + ' Z';
  }
  function arcPath(r, a0, a1) {
    const large = (a1 - a0) > 180 ? 1 : 0;
    const p0 = pt(r, a0), p1 = pt(r, a1);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }
  function norm(deg) { return ((deg % 360) + 360) % 360; }
  function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }

  /* A single wedge spans the full circle; draw it as two halves so the SVG
     arc is never degenerate. */
  function wedgePaths(a0, a1, rOut, rIn) {
    if (a1 - a0 < 359) return [sectorPath(a0, a1, rOut, rIn)];
    return [sectorPath(0, 180, rOut, rIn), sectorPath(180, 360, rOut, rIn)];
  }

  /* ---- render index (icons/items) ------------------------------------------
     Keys are FORMID-8-hex-upper | plugin-lower (hud.js normKey) — the asymmetry
     that once silently lost every render. */
  function canonHex8(v) {
    const n = parseInt(String(v == null ? '' : v).replace(/^0x/i, ''), 16);
    if (!isFinite(n)) return '';
    return ('00000000' + (n >>> 0).toString(16).toUpperCase()).slice(-8);
  }
  function normKey(k) {
    const s = String(k || ''), i = s.indexOf('|');
    if (i < 0) return s.toUpperCase();
    return (canonHex8(s.slice(0, i)) || s.slice(0, i).toUpperCase()) + '|' + s.slice(i + 1).toLowerCase();
  }
  function pieceKey(p) { return p && p.formId && p.plugin ? canonHex8(p.formId) + '|' + String(p.plugin).toLowerCase() : ''; }
  function safePath(v) { return typeof v === 'string' && /^icons\/[a-zA-Z0-9 _~().@+\/-]+\.(png|jpg|jpeg|webp)$/i.test(v) && v.indexOf('..') < 0; }
  let renders = {};
  function takeIndex(j) {
    const icons = j && (j.icons || j.map || j);
    if (!icons || typeof icons !== 'object') return 0;
    let n = 0;
    for (const k in icons) if (safePath(icons[k])) { const nk = normKey(k); if (renders[nk] !== icons[k]) { renders[nk] = icons[k]; n++; } }
    return n;
  }
  function renderOf(p) { return renders[pieceKey(p)] || ''; }

  /* ---- state ----------------------------------------------------------------- */
  let open = false, busy = false, keySeen = false;
  let st = null;               // last wwState
  let rows = [];               // M.wheelRows(doc): [{kind,id,name,image,count,flyout:[…]}]
  let hiSlot = -1, hiChoice = -1;
  let root = null, frame = null, wrap = null, svgEl = null, flyLayer = null;
  let wedgeEls = [], faceEls = [], petalEls = [];
  let side = null, hubName = null, hubSub = null;
  let iconTimer = 0, iconTries = 0;

  function host() { return document.getElementById('hud-wwheel'); }
  function doc() { return (st && st.doc) || {}; }
  function span() { return 360 / Math.max(1, rows.length); }
  function slotMid(i) { return i * span(); }

  /* The flyout fans out centred on its look's wedge. */
  function petalAngle(slot, j) {
    const n = rows[slot] ? rows[slot].flyout.length : 0;
    return norm(slotMid(slot) + (j - (n - 1) / 2) * FLY_STEP);
  }
  function fanHalf(slot) {
    const n = rows[slot] ? rows[slot].flyout.length : 0;
    return n ? ((n - 1) / 2) * FLY_STEP + FLY_STEP / 2 + 4 : 0;
  }

  /* ---- art ------------------------------------------------------------------- */
  function portraitPath(r) {
    const raw = typeof r.image === 'string' ? r.image.split('?')[0] : '';
    return raw && M && M.imageOK(raw) ? raw : '';
  }
  /* The dock's framing: the saved crop (zoom + offset) inside a fixed box. */
  function framePortrait(box, r, w, h) {
    box.textContent = '';
    box.classList.remove('is-empty');
    const file = portraitPath(r);
    /* no photo of this look yet: its monogram, drawn on purpose — not a
       faded stand-in icon (most looks start without a photo) */
    const mono = function () {
      box.textContent = '';
      box.classList.add('is-empty');
      box.append(el('span', 'ww-mono', String(r.name || '?').trim().charAt(0).toUpperCase() || '?'));
    };
    if (!file) { mono(); return; }
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    const crop = (doc().imageCrops || {})[file.split('/').pop()] || {};
    const z = Math.max(1, Math.min(8, Number(crop.z) || 1));
    img.style.width = 'calc(' + (w * z) + 'px * var(--ww-k))';
    img.style.height = 'calc(' + (h * z) + 'px * var(--ww-k))';
    img.style.left = 'calc(' + ((w - w * z) / 2 + (Number(crop.x) || 0) * w) + 'px * var(--ww-k))';
    img.style.top = 'calc(' + ((h - h * z) / 2 + (Number(crop.y) || 0) * h) + 'px * var(--ww-k))';
    img.onerror = function () { this.onerror = null; mono(); };
    img.src = file;
    box.append(img);
  }
  /* One petal's art: the pieces' renders — one fills, two to four tile, more
     show three and a count. A piece still rendering shows its initial in the
     same tile, never a blank. */
  function pieceTile(p, cls) {
    const t = el('div', cls || 'ww-tile');
    const src = renderOf(p);
    if (src) {
      const img = el('img');
      img.alt = '';
      img.draggable = false;
      img.onerror = function () { this.onerror = null; this.remove(); t.classList.add('is-pending'); t.append(el('span', 'ww-initial', initial(p))); };
      img.src = src;
      t.append(img);
    } else {
      t.classList.add('is-pending');
      t.append(el('span', 'ww-initial', initial(p)));
    }
    return t;
  }
  function initial(p) { const n = String((p && p.name) || '?').trim(); return n ? n.charAt(0).toUpperCase() : '?'; }
  function fillArt(art, choice) {
    art.textContent = '';
    const items = choice.items || [];
    const many = items.length > 4;
    const shown = many ? items.slice(0, 3) : items.slice(0, 4);
    art.className = 'ww-art n' + Math.min(4, Math.max(1, many ? 4 : shown.length));
    shown.forEach(function (p) { art.append(pieceTile(p)); });
    if (many) art.append(el('div', 'ww-tile ww-more', '+' + (items.length - 3)));
    if (!items.length) art.append(el('div', 'ww-tile is-pending', ''));
  }

  /* ---- build ----------------------------------------------------------------- */
  function sizePx() {
    /* the player's size (40..80, 64 default = 86vh) — and always leave the
       side panel its room beside the wheel */
    const w = (doc().flair && doc().flair.wheel) || {};
    const size = isFinite(Number(w.size)) ? Math.max(40, Math.min(80, Number(w.size))) : 64;
    const vh = window.innerHeight || 720, vw = window.innerWidth || 1280;
    return Math.round(Math.max(380, Math.min(vh * size * 1.34 / 100, vh - 150, vw - sideWidth() - 120)));
  }
  function sideWidth() { const vw = window.innerWidth || 1280; return Math.round(Math.max(300, Math.min(460, vw * 0.27))); }

  function build() {
    root = host();
    if (!root) return false;
    root.textContent = '';
    wedgeEls = []; faceEls = []; petalEls = [];

    frame = el('section', 'ww-frame');
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-label', 'Wardrobe wheel');

    const slow = Number(st && st.slow);
    const title = el('div', 'ww-title');
    title.append(el('span', 'ww-title-k', 'Wardrobe'),
      el('span', 'ww-title-s', (isFinite(slow) && slow >= 0.999) ? 'time running' : 'time slowed'));

    const body = el('div', 'ww-body');
    wrap = el('div', 'ww-wrap');
    const px = sizePx();
    wrap.style.width = wrap.style.height = px + 'px';
    const k = px / SIZE;
    wrap.style.setProperty('--ww-k', k.toFixed(4));
    /* text never drops below ~72% of its 1440p size (No small text — Rober
       reads this from the couch); a long name ellipsizes instead */
    wrap.style.setProperty('--ww-tk', Math.max(k, 0.72).toFixed(4));

    svgEl = svg('svg', { class: 'ww-svg', viewBox: '0 0 ' + SIZE + ' ' + SIZE, width: SIZE, height: SIZE });
    svgEl.append(
      svg('circle', { class: 'ww-flyband', cx: C, cy: C, r: R_FLY }),
      svg('circle', { class: 'ww-halo', cx: C, cy: C, r: R_OUT + 14 }),
      svg('circle', { class: 'ww-rim', cx: C, cy: C, r: R_OUT + 6 })
    );
    const n = rows.length, sp = span();
    rows.forEach(function (r, i) {
      const a0 = i * sp - sp / 2 + (n > 1 ? GAP_DEG / 2 : 0);
      const a1 = (i + 1) * sp - sp / 2 - (n > 1 ? GAP_DEG / 2 : 0);
      const g = svg('g', { class: 'ww-wedge' });
      wedgePaths(a0, a1, R_OUT, R_IN).forEach(function (d) {
        g.append(svg('path', { class: 'ww-edge', d: d }), svg('path', { class: 'ww-fill', d: d }));
      });
      g.append(svg('path', { class: 'ww-accent', d: arcPath(R_OUT - 5, n > 1 ? a0 + 1 : 0.5, n > 1 ? a1 - 1 : 359.5) }));
      svgEl.append(g);
      wedgeEls.push(g);

      /* the face: the look's portrait, its name, and how many choices fan
         out from it */
      const c = pt((R_IN + R_OUT) / 2, slotMid(i));
      const face = el('div', 'ww-face');
      face.style.left = (c[0] / SIZE * 100).toFixed(3) + '%';
      face.style.top = (c[1] / SIZE * 100).toFixed(3) + '%';
      const pic = el('div', 'ww-pic');
      framePortrait(pic, r, 100, 124);
      const name = el('div', 'ww-name', r.name);
      const more = el('div', 'ww-more-n', r.flyout.length ? '+' + r.flyout.length + ' to layer' : (r.kind === 'wardrobe' ? 'Pool · ' + (r.count || 0) : ''));
      face.append(pic, name, more);
      wrap.append(face);
      faceEls.push(face);
    });
    svgEl.append(
      svg('circle', { class: 'ww-hubdisc', cx: C, cy: C, r: R_HUB }),
      svg('circle', { class: 'ww-hubring', cx: C, cy: C, r: R_HUB })
    );
    wrap.prepend(svgEl);

    flyLayer = el('div', 'ww-fly');
    wrap.append(flyLayer);

    const hub = el('div', 'ww-hub');
    hubName = el('div', 'ww-hub-name');
    hubSub = el('div', 'ww-hub-sub');
    hub.append(hubName, hubSub);
    wrap.append(hub);

    side = el('aside', 'ww-side');
    side.style.width = sideWidth() + 'px';
    /* one fixed height, lined up with the ring: the panel never jumps as the
       aim moves, and it is never taller than the wheel (the frame must fit) */
    side.style.height = Math.round(Math.min(px, Math.max(380, px * 0.7))) + 'px';
    side.classList.toggle('is-compact', px < 640);
    body.append(wrap, side);

    const foot = el('div', 'ww-foot');
    const hint = el('div', 'ww-hint');
    const key = st && st.key ? st.key : '';
    hint.append(
      el('span', 'ww-hint-l', 'Aim and click · aim past a look for what goes over it'),
      el('span', 'ww-hint-s', 'A / D or arrows: look · W / S: layer · E or Enter' + (key ? ' or ' + key : '') + ' wears it · Esc cancels'));
    const x = el('button', 'ww-x', 'Cancel');
    x.type = 'button';
    x.addEventListener('click', function (e) { e.stopPropagation(); cancel(); });
    foot.append(hint, x);

    frame.append(title, body, foot);
    root.append(frame);
    fitNames();

    root.onmousemove = function (e) { try { steer(e.clientX, e.clientY); } catch (x2) {} };
    root.onmousedown = function (e) {
      try {
        if (busy) return;
        if (e.button === 2) { e.preventDefault(); cancel(); return; }
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('.ww-x')) return;
        steer(e.clientX, e.clientY);
        if (hiSlot >= 0) choose();
      } catch (x2) { log('mouse ' + x2.message); }
    };
    root.oncontextmenu = function (e) { try { e.preventDefault(); } catch (x2) {} };
    return true;
  }

  /* A look's name is one line inside its arc; a long one shrinks a little,
     then ellipsizes (the side panel always shows it whole). */
  function fitNames() {
    try {
      const k = parseFloat(wrap.style.getPropertyValue('--ww-k')) || 1;
      const arc = 2 * Math.PI * ((R_IN + R_OUT) / 2) / Math.max(1, rows.length) * k * 0.86;
      faceEls.forEach(function (f) {
        const nm = f.querySelector('.ww-name');
        if (!nm) return;
        nm.style.maxWidth = Math.max(80, Math.min(arc, 230 * k)) + 'px';
      });
    } catch (e) {}
  }

  /* ---- flyout petals ----------------------------------------------------------
     Drawn only for the aimed look, fanned outside its rim. Rebuilt when the
     aimed look changes or new renders land. */
  let petalsFor = -1;
  function buildPetals(slot) {
    if (!flyLayer) return;
    flyLayer.textContent = '';
    petalEls = [];
    petalsFor = slot;
    const r = rows[slot];
    if (!r || !r.flyout.length) { flyLayer.className = 'ww-fly'; return; }
    r.flyout.forEach(function (choice, j) {
      const c = pt(R_FLY, petalAngle(slot, j));
      const p = el('div', 'ww-petal');
      p.style.left = (c[0] / SIZE * 100).toFixed(3) + '%';
      p.style.top = (c[1] / SIZE * 100).toFixed(3) + '%';
      p.style.transitionDelay = (j * 28) + 'ms';
      const art = el('div', 'ww-art');
      fillArt(art, choice);
      art.append(el('div', 'ww-petal-name', choice.name));
      p.append(art);
      if (choice.item) p.classList.add('is-piece');
      flyLayer.append(p);
      petalEls.push(p);
    });
    flyLayer.className = 'ww-fly';
    /* one-shot fan-out: the class lands a frame after the DOM */
    setTimeout(function () { if (flyLayer && petalsFor === slot) flyLayer.className = 'ww-fly is-out'; }, 16);
  }

  /* ---- steering -----------------------------------------------------------------
     Inside the ring: the look under the cursor's ANGLE (a flick is enough).
     Past the rim: the aimed look's flyout, while the angle stays within its
     fan; outside the fan, the look under the angle (and its fan, if the
     cursor is already inside it). */
  function slotAt(deg) { return rows.length ? Math.floor(norm(deg + span() / 2) / span()) % rows.length : -1; }
  function steer(x, y) {
    if (!svgEl || busy || !rows.length) return;
    const b = svgEl.getBoundingClientRect();
    if (!b.width) return;
    const k = SIZE / b.width;
    const dx = (x - (b.left + b.width / 2)) * k, dy = (y - (b.top + b.height / 2)) * k;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < DEAD) { setHi(-1, -1); return; }
    const deg = norm(Math.atan2(dy, dx) * 180 / Math.PI + 90);
    if (r <= R_OUT + 18) { setHi(slotAt(deg), -1); return; }
    let slot = hiSlot >= 0 && Math.abs(angDiff(deg, slotMid(hiSlot))) <= fanHalf(hiSlot) ? hiSlot : slotAt(deg);
    if (slot < 0) { setHi(-1, -1); return; }
    const fly = rows[slot].flyout;
    if (!fly.length || Math.abs(angDiff(deg, slotMid(slot))) > fanHalf(slot)) { setHi(slot, -1); return; }
    let best = -1, bestD = 1e9;
    for (let j = 0; j < fly.length; j++) {
      const d = Math.abs(angDiff(deg, petalAngle(slot, j)));
      if (d < bestD) { bestD = d; best = j; }
    }
    setHi(slot, best);
  }
  function setHi(slot, choice) {
    if (slot === hiSlot && choice === hiChoice) return;
    hiSlot = slot; hiChoice = choice;
    paint();
  }

  /* ---- paint ------------------------------------------------------------------- */
  function paint() {
    if (!frame) return;
    if (hiSlot !== petalsFor) buildPetals(hiSlot);
    wedgeEls.forEach(function (g, i) { g.setAttribute('class', 'ww-wedge' + (i === hiSlot ? ' is-hi' : '') + (i === hiSlot && hiChoice >= 0 ? ' is-under' : '')); });
    faceEls.forEach(function (f, i) { f.className = 'ww-face' + (i === hiSlot ? ' is-hi' : '') + (i === hiSlot && hiChoice >= 0 ? ' is-under' : ''); });
    petalEls.forEach(function (p, j) { p.classList.toggle('is-hi', j === hiChoice); });
    if (wrap) wrap.className = 'ww-wrap' + (hiSlot >= 0 ? ' has-hi' : '');
    if (root) root.style.cursor = hiSlot >= 0 ? 'pointer' : 'default';
    const r = rows[hiSlot], c = r && hiChoice >= 0 ? r.flyout[hiChoice] : null;
    hubName.textContent = r ? r.name : 'Wardrobe';
    hubSub.textContent = !r ? 'Aim at a look' : c ? '+ ' + c.name : (r.flyout.length ? 'On its own' : 'Click to wear');
    fitHub();
    paintSide(r, c);
  }
  function fitHub() {
    try {
      hubName.style.fontSize = '';
      const w = hubName.clientWidth;
      if (!w) return;
      let fs = parseFloat(getComputedStyle(hubName).fontSize) || 30;
      for (let i = 0; i < 12 && hubName.scrollWidth > w + 1 && fs > 15; i++) {
        fs = Math.max(15, fs * 0.9);
        hubName.style.fontSize = fs.toFixed(1) + 'px';
      }
    } catch (e) {}
  }

  /* The side panel: what the aimed choice puts on, as large renders with
     names — the "3D rendering of the gear" view. */
  function paintSide(r, c) {
    if (!side) return;
    side.textContent = '';
    side.className = 'ww-side' + (r ? '' : ' is-idle') + (side.classList.contains('is-compact') ? ' is-compact' : '');
    if (!r) {
      side.append(el('div', 'ww-eyebrow', 'Wardrobe wheel'),
        el('h2', 'ww-side-name', 'Choose a look'),
        el('p', 'ww-side-p', 'Aim at a look to wear it on its own. Aim past its edge to layer a Flair set or a single piece over it.'),
        el('p', 'ww-side-p ww-side-dim', 'Change the looks and what fans out from each in Wardrobe → Wardrobe wheel.'));
      return;
    }
    side.append(el('div', 'ww-eyebrow', r.kind === 'wardrobe' ? 'Wardrobe pool · ' + (r.count || 0) + ' looks' : 'Outfit'),
      el('h2', 'ww-side-name', r.name));
    if (!c) {
      const pic = el('div', 'ww-side-pic');
      const compact = side.classList.contains('is-compact');
      framePortrait(pic, r, compact ? 128 : 200, compact ? 158 : 248);
      side.append(pic);
      side.append(el('p', 'ww-side-p', r.kind === 'wardrobe' ? 'Picks one look from this pool, on its own.' : 'This look on its own, nothing layered over it.'));
      if (r.flyout.length) {
        side.append(el('div', 'ww-eyebrow ww-gap', 'Layer over it — aim outward'));
        const list = el('div', 'ww-chips');
        r.flyout.forEach(function (x) { list.append(el('span', 'ww-chip', x.name)); });
        side.append(list);
      }
      return;
    }
    side.append(el('div', 'ww-plus', '+ ' + c.name + (c.item ? '' : ' · ' + c.items.length + (c.items.length === 1 ? ' piece' : ' pieces'))));
    if (c.items.length === 1) {
      /* one piece: show it big — the render IS the answer */
      const p1 = c.items[0], hero = el('div', 'ww-hero');
      hero.append(pieceTile(p1, 'ww-hero-art'));
      const t1 = el('div', 'ww-hero-txt');
      t1.append(el('div', 'ww-piece-name', p1.name || p1.formId), el('div', 'ww-piece-slot', [p1.slot, p1.plugin].filter(Boolean).join(' · ')));
      hero.append(t1);
      side.append(hero);
      return;
    }
    const grid = el('div', 'ww-pieces');
    const cap = c.items.length > 6 ? 5 : 6;
    c.items.slice(0, cap).forEach(function (p) {
      const row = el('div', 'ww-piece');
      row.append(pieceTile(p, 'ww-piece-art'));
      const txt = el('div', 'ww-piece-txt');
      txt.append(el('div', 'ww-piece-name', p.name || p.formId), el('div', 'ww-piece-slot', p.slot || p.plugin || ''));
      row.append(txt);
      grid.append(row);
    });
    if (c.items.length > cap) grid.append(el('div', 'ww-piece ww-piece-more', 'and ' + (c.items.length - cap) + ' more'));
    side.append(grid);
  }

  /* ---- actions ------------------------------------------------------------------ */
  function choose() {
    if (busy || !open) return;
    const r = rows[hiSlot];
    if (!r) return;
    const c = hiChoice >= 0 ? r.flyout[hiChoice] : null;
    busy = true;
    /* close FIRST: C++ releases focus and restores time before it dresses */
    closeLocal();
    toGame('wwPick', JSON.stringify({ kind: r.kind, id: r.id, choice: c ? c.key : '' }));
    log('pick ' + r.kind + ' ' + r.id + (c ? ' + ' + c.key : ''));   // marker: wardrobe-wheel-view-pick
  }
  function cancel() {
    if (!open) return;
    closeLocal();
    toGame('wwClose');
  }

  /* Missing renders: ask again (C++ also pushes when a render batch lands). */
  function missingItems() {
    const out = [], seen = {};
    rows.forEach(function (r) { r.flyout.forEach(function (c) { (c.items || []).forEach(function (p) {
      const k = pieceKey(p);
      if (k && !renders[k] && !seen[k]) { seen[k] = 1; out.push({ formId: p.formId, plugin: p.plugin, name: p.name || '' }); }
    }); }); });
    return out;
  }
  function pollIcons() {
    clearTimeout(iconTimer);
    if (!open) return;
    const miss = missingItems();
    if (!miss.length || iconTries >= 12) return;
    iconTries++;
    iconTimer = setTimeout(function () {
      if (!open) return;
      toGame('wwIcons', JSON.stringify({ items: miss.slice(0, 64) }));
      pollIcons();
    }, 1800);
  }

  function reshape() {
    rows = M ? M.wheelRows(doc()) : [];
    if (hiSlot >= rows.length) { hiSlot = -1; hiChoice = -1; }
  }
  function doOpen() {
    if (open) return;
    if (!M) { log('wardrobe-flair-model.js missing'); toGame('wwClose'); return; }
    open = true; busy = false; keySeen = false; hiSlot = -1; hiChoice = -1; petalsFor = -1; iconTries = 0;
    renders = {};
    if (st && st.renders) takeIndex({ icons: st.renders });
    reshape();
    if (!rows.length) { open = false; log('nothing on the wheel'); toGame('wwClose'); return; }
    /* visible BEFORE build: build measures layout */
    document.body.classList.add('ww-open');
    if (!build()) { open = false; document.body.classList.remove('ww-open'); toGame('wwClose'); return; }
    paint();
    setTimeout(function () { if (frame) frame.classList.add('ww-in'); }, 16);
    pollIcons();
    log('open with ' + rows.length + ' look(s)');   // marker: wardrobe-wheel-view
  }
  function closeLocal() {
    open = false;
    hiSlot = -1; hiChoice = -1; petalsFor = -1;
    clearTimeout(iconTimer);
    document.body.classList.remove('ww-open');
    if (root) { root.onmousemove = root.onmousedown = root.oncontextmenu = null; root.textContent = ''; }
    root = frame = wrap = svgEl = flyLayer = side = null;
    wedgeEls = []; faceEls = []; petalEls = [];
  }

  /* Keys: A/D or Left/Right walk the looks; W/S or Up/Down walk out along the
     aimed look's flyout and back (S past the first petal = the look alone);
     E or Enter wears; Esc cancels. A focused view stops the player moving, so
     WASD is safe here (the Combat Wheel's 2026-10-11 finding). */
  function stepSlot(dir) {
    if (!rows.length || busy) return;
    const i = hiSlot < 0 ? (dir > 0 ? -1 : 0) : hiSlot;
    setHi((i + dir + rows.length) % rows.length, -1);
  }
  function stepChoice(dir) {
    if (busy) return;
    if (hiSlot < 0) { setHi(0, -1); return; }
    const n = rows[hiSlot].flyout.length;
    if (!n) return;
    setHi(hiSlot, Math.max(-1, Math.min(n - 1, hiChoice + dir)));
  }
  window.addEventListener('keydown', function (e) {
    if (!open) return;
    const k = e.key, c = e.code, kc = e.keyCode;
    if (!keySeen) { keySeen = true; log('first key ' + (k || c || kc)); }   // marker: wardrobe-wheel-first-key
    const lk = typeof k === 'string' ? k.toLowerCase() : '';
    let handled = true;
    if (k === 'Escape' || kc === 27) cancel();
    else if (k === 'Enter' || c === 'NumpadEnter' || kc === 13 || lk === 'e' || kc === 69) { if (hiSlot >= 0) choose(); }
    else if (k === 'ArrowRight' || kc === 39 || lk === 'd' || kc === 68) stepSlot(1);
    else if (k === 'ArrowLeft' || kc === 37 || lk === 'a' || kc === 65) stepSlot(-1);
    else if (k === 'ArrowUp' || kc === 38 || lk === 'w' || kc === 87) stepChoice(1);
    else if (k === 'ArrowDown' || kc === 40 || lk === 's' || kc === 83) stepChoice(-1);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('resize', function () {
    /* a resize (resolution change, the HUD view resized) rebuilds at the new
       size and keeps the aim; nothing replays its entrance */
    try { if (open) { const s = hiSlot, ch = hiChoice; build(); petalsFor = -1; hiSlot = s; hiChoice = ch; paint(); if (frame) frame.classList.add('ww-in'); if (flyLayer && petalsFor >= 0) flyLayer.className = 'ww-fly is-out'; } } catch (e) {}
  });

  /* ---- C++ -> view ---------------------------------------------------------- */
  window.wwShow = function (v) {
    try {
      if (String(v) === '1') doOpen();
      else if (open) closeLocal();
    } catch (e) { log('show ' + e.message); closeLocal(); toGame('wwClose'); }
  };
  window.wwState = function (raw) {
    try {
      const j = parse(raw);
      if (!j || typeof j !== 'object') return;
      st = j;
      if (j.renders) takeIndex({ icons: j.renders });
      if (!open) return;
      const s = hiSlot;
      reshape();
      build(); petalsFor = -1; hiSlot = s < rows.length ? s : -1; hiChoice = -1;
      paint();
      if (frame) frame.classList.add('ww-in');
    } catch (e) { log('state ' + e.message); }
  };
  window.wwIconsData = function (raw) {
    try {
      const j = parse(raw);
      if (!takeIndex(j) || !open) return;
      /* art landed: refresh the petals and the side panel in place */
      const s = hiSlot;
      petalsFor = -1;
      if (s >= 0) { buildPetals(s); if (flyLayer) flyLayer.className = 'ww-fly is-out'; }
      paint();
    } catch (e) { log('icons ' + e.message); }
  };
  window.wwKey = function () {
    try {
      if (!open) return;
      if (hiSlot >= 0) choose(); else cancel();
    } catch (e) { log('key ' + e.message); }
  };

  window.HudWardrobeWheel = {
    isOpen: function () { return open; },
    _debug: function () { return { open: open, hiSlot: hiSlot, hiChoice: hiChoice, rows: rows, renders: renders }; },
    _steer: function (x, y) { steer(x, y); },
    _geom: { SIZE: SIZE, R_IN: R_IN, R_OUT: R_OUT, R_FLY: R_FLY, petalAngle: petalAngle, slotMid: slotMid }
  };
})();
