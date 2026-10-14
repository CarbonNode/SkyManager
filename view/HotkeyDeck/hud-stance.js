'use strict';

/* ============================================================================
   Combat Wheel (was the Stance Wheel; renamed 2026-10-11 when the two party
   menus joined it) — a slow-time radial picker for Stances NG (Rober, 2026-10-03:
   "a popout ui button that slows time shows the stances with their icons as a
   selector wheel then you select and it closes").

   Lives in the HUD view (hud.html) as its own fixed layer #hud-stance — a
   sibling of #hud-td / #hud-align. C++ opens it (seeded action `stance-wheel`),
   slows the world with BSTimer's global time multiplier, and gives this view
   UNPAUSED focus (the alignment overlay's discipline). Picking a stance closes
   the wheel FIRST, restores time, and only then presses Stances NG's OWN key
   for that stance, read live from StancesNG.toml — so Stances NG Combat
   Expansion's hotkey rules (Revert Stance holding Neutral) still apply. The
   deck implements no stance mechanics of its own.

   ---------------------------------------------------------------- bridge ----
   view -> C++ (listeners on the HUD view):
     swGet()            — "push me the state" (once on open)
     swPick(json)       — {stance: 0|1|2|3|4} or {tool: "battle-plan"|"wwm-menu"|
                          "wwm-wheel"|"wwm-party"|"nff-menu"|"sic-em"|"command-ring"};
                          the view has ALREADY closed itself. The Walk With Me
                          wedge never picks by itself: it opens a flyout of
                          three (its order wheel, its Party actions page, its
                          SKSE menu page) and the choice is what is sent.
     swClose()          — the view closed itself without a pick (Esc, ✕);
                          C++ restores time and releases Focus
     swCfg(json)        — the settings card (right-click, 2026-10-11): the
                          SAME request the deck's Home > UI Elements row sends,
                          {op:"get"} | {op:"set", slow?, size?, wedges?} |
                          {op:"set", reset:true}; C++ answers swCfgState here
                          too and re-pushes swState so the open wheel redraws
   C++ -> view:
     window.swShow("1"|"0")  — open / close
     window.swState(json)    — {ok, current, stances:[{id,name,key}], tarnished,
                                cycling, expansion,
                                icons:{bear,wolf,hawk,tarnished}, hand, msg,
                                stancesOk, tools:[{id,name,desc,ok,why}]}
     window.swKey()          — the wheel's own key was pressed again while it
                                is up: choose the highlighted stance, or close
     window.swCfgState(json) — {slow,size,defSlow,defSize,wedges,tools,
                                stancesOk,stancesWhy,tarnished,icons,ok,msg,key}
                                (home-pane.js receiveStance reads the same)

   ⚠ Keys are delivered to BOTH this view and the game (the 2026-09-22 lesson
   in hud-align.js), and the world is still running — slowly. So no number
   keys (they are Skyrim's favorites hotkeys), no WASD (movement), no Tab or
   Q (they open menus, which close the wheel). The arrow keys step the
   highlight round the wheel (vanilla binds them to nothing in play), Enter
   confirms, Esc cancels; every control is also a click.

   ⚠ The HUD document is body{pointer-events:none} (hud.css) so it never eats
   a click meant for the game; a layer that wants the mouse turns it back on
   for itself (#hud-td .td-frame, .ag-card). This one forgot until
   2026-10-10 — Rober: "nothing seems clickable either... with mouse or by
   using keyboard" — so every move and click fell straight through it.

   ⚠ Ultralight laws observed: everything is wrapped so an uncaught error can
   never take the shared renderer down; no looping animations (one-shot class
   flips only); wedge geometry is written as SVG ATTRIBUTES, never CSS
   transforms on SVG children; explicit rgba() colours, no color-mix().
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('sw bridge error', fn, e); }
      return true;
    }
    if (DEV) console.log('[sw->game]', fn, arg);
    return false;
  }
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

  /* ---- the four stances --------------------------------------------------
     Ids are Stances NG's own (stance-manager.h available_stances, and the
     value of its CurrentStance global 0x917): 0 Neutral, 1 Bear, 2 Wolf,
     3 Hawk. Colours are Stances NG - Combat Expansion's own palette, so the
     wheel and its on-screen indicator agree. Traits are Combat Expansion's
     DEFAULT effects, worded from its description — only shown when it is
     installed, because without it a stance is purely an animation set. */
  const DEF = {
    1: { slug: 'bear',    name: 'Bear',    rgb: '214, 69, 56',
         trait: 'Hits the hardest — but slow, exposed and tiring.' },
    2: { slug: 'wolf',    name: 'Wolf',    rgb: '148, 179, 214',
         trait: 'Trades a little damage for safer blocks and steadier footing.' },
    3: { slug: 'hawk',    name: 'Hawk',    rgb: '230, 179, 77',
         trait: 'Light and quick: faster swings and steps, cheaper power attacks, weaker blows.' },
    /* Neutral is the DEFAULT option (Rober, 2026-10-10: "a default animation
       option would be nice (like whatever is default installed)... i guess
       that is what neutral should be"): no stance effect on the player, so
       no stance's OAR folder matches and the animations you installed play.
       Always on the wheel since then — with no Stances NG key for it, the
       engine mirrors Stances NG's own Neutral steps (stance_wheel.cpp). */
    0: { slug: 'neutral', name: 'Default', rgb: '161, 161, 170',
         trait: 'Your normal installed animations. No stance bonuses or drawbacks.',
         always: true },
    /* The fourth stance (Rober, 2026-10-07): not one of Stances NG's three but
       its own plugin, TarnishedStance.esp, carrying the Elden Ring movesets.
       Ash-gold, so it never reads as Hawk's amber. It has no stat changes, so
       its trait is shown with or without Combat Expansion. */
    4: { slug: 'tarnished', name: 'Tarnished', rgb: '236, 222, 182',
         trait: 'Elden Ring movesets for every weapon that has one. No stat changes.',
         always: true },
    /* The two party menus (Rober, 2026-10-11). Not stances: a pick OPENS the
       mod's own window (Fight With Me's battle plan through its DLL export,
       Walk With Me's Party page in SkyManager's SMF window). They wear the
       same diamond badge as the stances (Rober, same day: "make the icon feel
       like the other icons in stance bar"); the glyphs are our own art,
       shipped in icons/custom, tinted like Combat Expansion's. */
    10: { slug: 'battle-plan', tool: 'battle-plan', name: 'Battle Plan', rgb: '226, 120, 92',
          art: 'icons/custom/sw-battle-plan.png', always: true,
          trait: 'Roles, focus and positions for every follower. Time slows further while you plan.' },
    11: { slug: 'wwm', tool: 'wwm-menu', name: 'Walk With Me', rgb: '118, 196, 156',
          art: 'icons/custom/sw-wwm-menu.png', always: true, verb: 'Wheel · Party · Menu',
          trait: 'Your travelling party: who walks with you, formation, rest and orders.',
          /* A flyout, not a pick (Rober, 2026-10-12: "can we add a walk with me
             button that toggles their wheel? ... and the party actions one too
             ... like it does a flyout for SKSE menu, wheel, party"). The first
             two press Walk With Me's OWN Command key, read live from
             Wayfarer.ini (the party menu has no API); Party then steps the
             open menu to its Party actions page with the mod's own Down key.
             The third is the SMF page the wedge always opened.
             marker: combat-wheel-wwm-flyout */
          fly: [
            { tool: 'wwm-wheel', name: 'Order wheel', art: 'icons/custom/hk-wheel.png',
              desc: 'Its own wheel: Lead, Companion, Rear, Relax and more' },
            { tool: 'wwm-party', name: 'Party actions', art: 'icons/custom/hk-party-summon.png',
              desc: 'Teleport party, rest, loot scouting, pathfinder, battle plan' },
            { tool: 'wwm-menu', name: 'SKSE menu', art: 'icons/custom/hk-skse-menu.png',
              desc: 'Every Walk With Me setting, in SkyManager’s mod-menu window' }
          ] },
    /* Opt-in wedges (Rober, 2026-10-11: "Maybe we add NFF's main hotkey as
       well?" / "as well as the sic em spell that fires? as options you can
       toggle on"). Off until switched on in Home > UI Elements. NFF runs its
       own command-key handler; Sic 'em is the deck's own attack-target bolt. */
    12: { slug: 'nff', tool: 'nff-menu', name: 'NFF', rgb: '172, 146, 232',
          art: 'icons/custom/sw-nff-menu.png', always: true,
          trait: "Nether's Follower Framework's command menu — orders for everyone, as its main key opens it." },
    13: { slug: 'sic-em', tool: 'sic-em', name: "Sic 'em", rgb: '104, 196, 228',
          art: 'icons/custom/sw-sic-em.png', always: true, verb: 'Fires at your crosshair',
          trait: 'A bolt down your crosshair: every follower attacks whoever it lands on.' },
    /* The Command Ring (Rober, 2026-10-12: "add it as a button for the stance
       wheel"). Picking it closes the wheel and opens the ring (hud-command.js),
       Warband's orders over NFF, My Home is Your Home, Campfire and Fight With
       Me. On by default; it needs no mod to open. marker: combat-wheel-command-ring */
    14: { slug: 'command-ring', tool: 'command-ring', name: 'Command Ring', rgb: '214, 178, 110',
          art: 'icons/custom/sw-command-ring.png', always: true, verb: 'Opens the ring',
          trait: 'Your band at a word: orders, camp, homes and battle.' }
  };
  /* Clockwise from the top. Tarnished only when its plugin is loaded
     (state.tarnished); Default (Neutral) always; each menu only while its
     mod is loaded (state.tools[].ok). */
  const ORDER = [1, 2, 3, 4, 0, 10, 11, 14, 12, 13];
  /* the switch each wedge answers to (stance-wheel.json "wedges") */
  function wedgeKey(id) { const d = DEF[id]; return d.tool || d.slug; }
  const OFF_BY_DEFAULT = { 'nff-menu': 1, 'sic-em': 1 };
  function wedgeOn(s, id) {
    const k = wedgeKey(id), w = s && s.wedges;
    if (w && typeof w[k] === 'boolean') return w[k];
    return !OFF_BY_DEFAULT[k];      /* an older DLL sends no wedges */
  }
  function toolOf(s, tool) {
    const list = (s && s.tools) || [];
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === tool) return list[i];
    return null;
  }
  function toolOk(s, tool) { const t = toolOf(s, tool); return !!(t && t.ok); }
  function wheelIds(s) {
    /* an older DLL sends no stancesOk: its wheel only opened with Stances NG */
    const stances = !(s && s.stancesOk === false);
    return ORDER.filter(function (id) {
      if (!wedgeOn(s, id)) return false;
      if (DEF[id].tool) return toolOk(s, DEF[id].tool);
      if (!stances) return false;
      return id !== 4 || !!(s && s.tarnished);
    });
  }

  /* ---- geometry ---------------------------------------------------------- */
  const SIZE = 640, C = SIZE / 2;
  const R_OUT = 300, R_IN = 124;     // the wedge band
  const GAP_DEG = 3;                 // hairline between wedges
  const DEAD = 70;                   // centre dead zone: no highlight in here

  function pt(r, deg) {              // deg clockwise from the top
    const a = (deg - 90) * Math.PI / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  }
  function sectorPath(a0, a1) {
    const large = (a1 - a0) > 180 ? 1 : 0;
    const p0 = pt(R_OUT, a0), p1 = pt(R_OUT, a1), p2 = pt(R_IN, a1), p3 = pt(R_IN, a0);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      ' A' + R_OUT + ' ' + R_OUT + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
      ' L' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2) +
      ' A' + R_IN + ' ' + R_IN + ' 0 ' + large + ' 0 ' + p3[0].toFixed(2) + ' ' + p3[1].toFixed(2) + ' Z';
  }

  function arcPath(r, a0, a1) {
    const large = (a1 - a0) > 180 ? 1 : 0;
    const p0 = pt(r, a0), p1 = pt(r, a1);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }

  /* ---- state ------------------------------------------------------------- */
  let open = false;
  let keySeen = false;   // the first key of each open is logged (did keys reach the view at all?)
  let st = null;          // last swState
  let ids = [];           // stance ids on the wheel, in ORDER
  let hi = -1;            // highlighted stance id, -1 = none
  let busy = false;       // a pick is on its way — ignore further input
  let root = null, frame = null, svgEl = null, wedges = {}, faces = {};
  let builtShape = '';    // wedges + icons + size + slow the open wheel was built with
  /* the settings card (marker: combat-wheel-cfg-card) */
  let cfgOpen = false, cfgEl = null, cfgNote = '';
  let rcAt = 0;           // when a right MOUSEDOWN last toggled the card (contextmenu de-dupe)
  /* the Walk With Me flyout (marker: combat-wheel-wwm-flyout) */
  let flyOpen = false, flyId = -1, flyHi = 0, flyEl = null;
  const cfg = { known: false, defSlow: 0.2, defSize: 64, stancesOk: null, stancesWhy: '',
                tarnished: false, tools: null, icons: null };
  let hubName = null, hubTrait = null, hubCur = null, hubKey = null, noteEl = null;

  function host() { return document.getElementById('hud-stance'); }

  /* ---- build ------------------------------------------------------------- */
  function build() {
    root = host();
    if (!root) return false;
    root.textContent = '';
    wedges = {}; faces = {};
    builtShape = shapeOf(ids);

    frame = el('section', 'sw-frame');
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-label', 'Combat wheel');

    const title = el('div', 'sw-title');
    /* stance-wheel-options (2026-10-08): the player's own time multiplier and
       wheel size ride the state (stance-wheel.json, set from Home -> UI
       Elements). At 1 the world is not slowed, and the title must not claim
       it is. Titled Combat since 2026-10-11 (the party menus joined it). */
    const slow = Number(st && st.slow);
    title.append(el('span', 'sw-title-k', 'Combat'),
      el('span', 'sw-title-s', (isFinite(slow) && slow >= 0.999) ? 'time running' : 'time slowed'));

    const wrap = el('div', 'sw-wrap');
    /* The sheet's 64vh / 860px pair is the default. Another size keeps the
       same proportion between the two, so "Huge" is bigger at 1440p too
       (64vh alone is already past the 860px cap there). */
    const vh = Number(st && st.size);
    if (isFinite(vh) && vh >= 30 && vh <= 90 && Math.round(vh) !== 64) {
      const cap = Math.round(860 * vh / 64) + 'px';
      wrap.style.width = wrap.style.height = vh + 'vh';
      wrap.style.maxWidth = wrap.style.maxHeight = cap;
    }
    svgEl = svg('svg', { class: 'sw-svg', viewBox: '0 0 ' + SIZE + ' ' + SIZE, width: SIZE, height: SIZE });
    svgEl.append(
      svg('circle', { class: 'sw-halo', cx: C, cy: C, r: R_OUT + 14 }),
      svg('circle', { class: 'sw-rim', cx: C, cy: C, r: R_OUT + 6 }),
      svg('circle', { class: 'sw-hubdisc', cx: C, cy: C, r: R_IN - 10 }),
      svg('circle', { class: 'sw-hubring', cx: C, cy: C, r: R_IN - 10 })
    );

    const n = ids.length;
    const span = 360 / n;
    ids.forEach(function (id, i) {
      /* the first wedge is centred on the top */
      const a0 = i * span - span / 2 + GAP_DEG / 2;
      const a1 = (i + 1) * span - span / 2 - GAP_DEG / 2;
      const d = DEF[id];
      const g = svg('g', { class: 'sw-wedge', 'data-id': String(id) });
      /* dark base + gold edge first, the stance-colour tint drawn over it */
      /* hover: the stance colour floods the wedge and a bright band runs
         along its outer rim (sw-accent, an arc drawn just inside R_OUT) */
      g.append(
        svg('path', { class: 'sw-edge', d: sectorPath(a0, a1) }),
        svg('path', { class: 'sw-fill', d: sectorPath(a0, a1), style: 'fill: rgba(' + d.rgb + ', 0)' }),
        svg('path', { class: 'sw-accent', d: arcPath(R_OUT - 5, a0 + 1, a1 - 1),
          style: 'stroke: rgba(' + d.rgb + ', 0)' })
      );
      svgEl.append(g);
      wedges[id] = g;

      /* the face — icon + name + key — is HTML laid over the wedge centre */
      const mid = i * span;
      /* a touch outside the band's middle: the label hangs BELOW the badge,
         so on the upper wedges it points at the hub and needs the room */
      const c = pt(R_IN + (R_OUT - R_IN) * 0.56, mid);
      const face = el('div', 'sw-face' + (d.tool ? ' is-tool' : ''));
      face.style.left = (c[0] / SIZE * 100).toFixed(3) + '%';
      face.style.top = (c[1] / SIZE * 100).toFixed(3) + '%';
      face.style.setProperty('--sw-rgb', d.rgb);
      face.append(iconFor(id), el('div', 'sw-name', d.name), el('div', 'sw-key'));
      wrap.append(face);
      faces[id] = face;
    });

    /* centre hub: what the hovered stance does, and what you are in now */
    const hub = el('div', 'sw-hub');
    hubName = el('div', 'sw-hub-name');
    hubTrait = el('div', 'sw-hub-trait');
    hubCur = el('div', 'sw-hub-cur');
    hub.append(hubName, hubTrait, hubCur);
    wrap.prepend(svgEl);
    wrap.append(hub);

    noteEl = el('div', 'sw-note');

    /* The hint lines can be switched off (2026-10-12, Rober: "ability to hide
       text below bar"); Cancel stays, centred. marker: combat-wheel-hints-off */
    const foot = el('div', 'sw-foot' + (hintsOn() ? '' : ' sw-foot-bare'));
    hubKey = el('div', 'sw-hint');
    hubKey.append(
      el('span', 'sw-hint-l', 'Aim and click · WASD or arrows, then E or Enter · Esc cancels · Right-click: settings'),
      el('span', 'sw-hint-s', 'Give each stance its own key in Hotkeys (F2)'));
    const x = el('button', 'sw-x', 'Cancel');
    x.type = 'button';
    x.addEventListener('click', function (e) { e.stopPropagation(); cancel(); });
    if (hintsOn()) foot.append(hubKey, x);
    else foot.append(x);

    frame.append(title, wrap, noteEl, foot);
    root.append(frame);
    /* a rebuild under the open card (a wedge or size switched) keeps the card */
    if (cfgOpen && cfgEl) { frame.classList.add('sw-under'); root.append(cfgEl); }
    if (flyOpen && flyEl) { frame.classList.add('sw-flying'); root.append(flyEl); }
    /* Never taller than the screen (2026-10-12): the slider reaches 90% of the
       screen height, and the title above and the hint below need room too, so
       a wheel that would push them off-screen gives back exactly the overflow
       (layout sizes, before the faces are fitted). marker: combat-wheel-fit-screen */
    const roomOver = frame.offsetHeight - ((window.innerHeight || 1080) - 24);
    if (roomOver > 0 && wrap.offsetWidth) {
      const px = Math.max(320, Math.floor(wrap.offsetWidth - roomOver)) + 'px';
      wrap.style.width = wrap.style.height = px;
      wrap.style.maxWidth = wrap.style.maxHeight = px;
      wrap.style.minWidth = wrap.style.minHeight = '0';
    }
    /* Faces and hub are drawn for a 640 px wheel; scale them to the real one
       (offsetWidth is the LAYOUT size, unaffected by the entrance scale). */
    const k = wrap.offsetWidth ? wrap.offsetWidth / SIZE : 1;
    wrap.style.setProperty('--sw-k', k.toFixed(4));
    /* A crowded wheel (the menus joined the stances, 2026-10-11): with seven
       or nine wedges a full-size face is wider than its own arc and the labels
       run into their neighbours. Shrink the faces — never the hub — just
       enough that the longest name on THIS wheel fits its arc (~17 px per
       uppercase letter at 24 px with its tracking), floor 0.6. */
    const arc = 2 * Math.PI * ((R_OUT + R_IN) / 2) / Math.max(1, ids.length);
    const longest = ids.reduce(function (m, id) { return Math.max(m, DEF[id].name.length); }, 1);
    const fit = Math.max(0.6, Math.min(1, (arc * 0.9) / (longest * 17)));
    wrap.style.setProperty('--sw-fk', (k * fit).toFixed(4));
    wrap.dataset.fit = fit.toFixed(3);
    fitFaces(wrap, k, fit);
    ids.forEach(function (id) { paintGlyph(id); });
    if (flyOpen && flyEl) placeFly();

    /* Pointer: the highlight follows the cursor's ANGLE from the centre (a
       flick toward a stance is enough — no need to land on the wedge), and a
       click anywhere outside the hub chooses it. Registered on the whole
       layer so a cursor that overshoots the wheel still steers. */
    root.onmousemove = function (e) {
      if (cfgOpen || flyOpen) return;    /* a card is up: the wheel does not steer */
      steer(e.clientX, e.clientY);
    };
    /* Right-click toggles the settings card (Rober, 2026-10-11: "right click
       could open floating configuration as well when open"). It used to
       cancel; Esc and the Cancel button still do. Ultralight does not
       reliably fire the DOM contextmenu event in-game (domains-pane.js), so
       the right MOUSEDOWN is the real trigger; contextmenu is only a fallback
       and is ignored when a right mousedown just toggled (one right-click
       must never open and at once close the card). */
    root.onmousedown = function (e) {
      try {
        if (busy) return;
        if (e.button === 2) {
          e.preventDefault();
          rcAt = Date.now();
          if (flyOpen) closeFly();       /* right-click steps back out of the flyout */
          else toggleCfg();
          return;
        }
        if (e.button !== 0) return;
        rcAt = 0;                        /* a left press ends any right-click pairing */
        if (flyOpen) {
          /* an option opens; the card's own body does nothing; anywhere else
             goes back to the wheel (a second press then aims again) */
          const o = e.target && e.target.closest && e.target.closest('.sw-fly-o');
          if (o) pickFly(Number(o.dataset.i));
          else if (!(e.target && e.target.closest && e.target.closest('.sw-fly'))) closeFly();
          return;
        }
        if (cfgOpen) {
          /* a click on the card works its buttons; a click outside it closes
             the card — while it is up nothing on the wheel can be picked */
          if (!(e.target && e.target.closest && e.target.closest('.sw-cfg'))) closeCfg();
          return;
        }
        if (e.target && e.target.closest && e.target.closest('.sw-x')) return;
        steer(e.clientX, e.clientY);
        if (hi >= 0) choose(hi);
      } catch (x) { try { toGame('hudLog', 'stance wheel mouse: ' + x.message); } catch (x2) {} }
    };
    root.oncontextmenu = function (e) {
      try {
        e.preventDefault();
        if (busy) return;
        if (rcAt && Date.now() - rcAt < 700) { rcAt = 0; return; }   /* the mousedown already did it */
        rcAt = 0;
        if (flyOpen) closeFly(); else toggleCfg();
      } catch (x) {}
    };
    return true;
  }

  /* The badge is Stances NG - Combat Expansion's own look (its on-screen
     stance indicator): a diamond in the stance colour with a hairline inner
     diamond, the stance's glyph tinted inside, and for Neutral a hollow
     centre diamond. The mod draws that frame itself and ships only the white
     bear/wolf/hawk glyphs (512 px, transparent), so the frame is geometry
     here too and the glyph is the INSTALLED mod's own file: C++ mirrors it
     into icons/sh, which every release excludes, so the deck never
     redistributes it. No file (Combat Expansion absent, or a load error) ->
     the stance's initial in the same badge. */
  const BADGE = 120;                         // px at a 640 px wheel (k = 1)
  const GLYPH = 0.56;                        // glyph box, share of the badge

  function iconFor(id) {
    const box = el('div', 'sw-icon');
    const d = DEF[id];
    const f = svg('svg', { class: 'sw-badge', viewBox: '0 0 100 100' });
    f.append(
      svg('polygon', { class: 'sw-b-out', points: '50,3 97,50 50,97 3,50',
        style: 'stroke: rgb(' + d.rgb + ')' }),
      svg('polygon', { class: 'sw-b-in', points: '50,12 88,50 50,88 12,50',
        style: 'stroke: rgba(' + d.rgb + ', .42)' })
    );
    if (id === 0)
      f.append(svg('polygon', { class: 'sw-b-mark', points: '50,37 63,50 50,63 37,50',
        style: 'stroke: rgb(' + d.rgb + ')' }));
    /* hover glow behind the badge, in the stance colour (CSS fades it in) */
    box.append(el('div', 'sw-glow'), f);
    if (id !== 0) {
      const cv = el('canvas', 'sw-glyph');
      cv.setAttribute('aria-hidden', 'true');
      box.append(cv);
    }
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', d.tool ? d.name + ' menu' : d.name + ' stance');
    return box;
  }

  /* Draw one face's glyph at its REAL layout size (Ultralight rasterises at
     layout size; a scaled raster only gets blurrier), tinted to the stance
     colour with source-in. Async when the file has to load. */
  function paintGlyph(id) {
    const face = faces[id];
    const cv = face && face.querySelector('.sw-glyph');
    if (cv) paintCanvas(cv, id);
  }
  function paintCanvas(cv, id) {
    const d = DEF[id];
    const icons = (st && st.icons) || cfg.icons || {};
    paintArt(cv, d.rgb, d.art || icons[d.slug], d.name);
  }
  /* any glyph file, tinted one colour at the canvas's real layout size; the
     name's initial stands in when the file does not load */
  function paintArt(cv, rgb, src, name) {
    const px = Math.max(24, Math.round(cv.offsetWidth || BADGE * GLYPH));
    cv.width = px; cv.height = px;
    const d = { rgb: rgb, name: name || '?' };
    const letter = function () {
      try {
        const c = cv.getContext('2d');
        if (!c) return;
        c.clearRect(0, 0, px, px);
        c.fillStyle = 'rgb(' + d.rgb + ')';
        c.font = '600 ' + Math.round(px * 0.62) + 'px Georgia, serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(d.name.charAt(0), px / 2, px / 2 + px * 0.03);
      } catch (e) {}
    };
    if (!src) { letter(); return; }
    const img = new Image();
    img.onload = function () {
      try {
        const c = cv.getContext('2d');
        if (!c) { letter(); return; }
        c.clearRect(0, 0, px, px);
        c.globalCompositeOperation = 'source-over';
        c.drawImage(img, 0, 0, px, px);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = 'rgb(' + d.rgb + ')';
        c.fillRect(0, 0, px, px);
        c.globalCompositeOperation = 'source-over';
        cv.dataset.art = '1';
      } catch (e) { letter(); }
    };
    img.onerror = letter;
    img.src = src;
  }

  /* ---- steering ---------------------------------------------------------- */
  function steer(x, y) {
    if (!svgEl || busy || cfgOpen) return;
    if (!ids.length) { setHi(-1); return; }
    const r = svgEl.getBoundingClientRect();
    if (!r.width) return;
    const k = SIZE / r.width;
    const dx = (x - (r.left + r.width / 2)) * k, dy = (y - (r.top + r.height / 2)) * k;
    if (dx * dx + dy * dy < DEAD * DEAD) { setHi(-1); return; }
    let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;      // 0 = top, clockwise
    deg = ((deg % 360) + 360) % 360;
    const span = 360 / ids.length;
    const i = Math.floor(((deg + span / 2) % 360) / span);
    setHi(ids[i]);
  }

  function setHi(id) {
    if (flyOpen) return;               /* the flyout holds its wedge lit */
    if (id === hi) return;
    hi = id;
    paint();
  }

  /* ---- paint ------------------------------------------------------------- */
  function keyFor(id) {
    /* a menu: the deck's own binding on its battle-plan / wwm-menu entry */
    if (DEF[id] && DEF[id].tool) { const t = toolOf(st, DEF[id].tool); return (t && t.key) || ''; }
    const list = (st && st.stances) || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i].key || '';
    return '';
  }
  function keyLabel(id) { return keyFor(id); }
  function paint() {
    if (!frame) return;
    const cur = st && typeof st.current === 'number' ? st.current : -1;
    ids.forEach(function (id) {
      const on = id === hi, isCur = id === cur;
      const d = DEF[id];
      const g = wedges[id];
      if (g) {
        g.setAttribute('class', 'sw-wedge' + (on ? ' is-hi' : '') + (isCur ? ' is-cur' : ''));
        /* opacity lives in the inline rgba so the hover tint never depends on
           fill-opacity support */
        const fill = g.querySelector('.sw-fill'), acc = g.querySelector('.sw-accent');
        if (fill) fill.setAttribute('style', 'fill: rgba(' + d.rgb + ', ' + (on ? 0.30 : isCur ? 0.12 : 0.0) + ')');
        if (acc) acc.setAttribute('style', 'stroke: rgba(' + d.rgb + ', ' + (on ? 0.95 : isCur ? 0.40 : 0.0) + ')');
      }
      const f = faces[id];
      if (f) {
        f.className = 'sw-face' + (d.tool ? ' is-tool' : '') + (on ? ' is-hi' : '') + (isCur ? ' is-cur' : '');
        const k = f.querySelector('.sw-key');
        if (k) k.textContent = isCur ? 'Current' : keyLabel(id);
      }
    });
    const wrap = frame.querySelector('.sw-wrap');
    if (wrap) wrap.className = 'sw-wrap' + (hi >= 0 ? ' has-hi' : '');
    if (root) root.style.cursor = hi >= 0 ? 'pointer' : 'default';
    /* the hub rests on the current stance only when it is on the wheel — a
       menus-only wheel (no Stances NG) has no stance to describe */
    const show = hi >= 0 ? hi : (ids.indexOf(cur) !== -1 ? cur : -1);
    const d = DEF[show];
    hubName.textContent = d ? d.name : 'Combat';
    hubName.style.color = d ? 'rgb(' + d.rgb + ')' : '';
    fitHubName();
    hubTrait.textContent = !d ? 'Aim at a wedge.' : (d.always || (st && st.expansion)) ? d.trait
      : 'Its own animation set.';
    hubCur.textContent = d && d.tool ? (d.verb || 'Opens its window')
      : cur < 0 || !DEF[cur] ? (ids.indexOf(1) !== -1 ? 'No stance yet' : '')
      : hi >= 0 && hi !== cur ? 'Now: ' + DEF[cur].name
      : hi === cur ? 'You are in this stance' : 'Current stance';
  }

  /* The letter-count estimate above is only a first guess: in game a label
     ran wider than it and "WALK WITH ME" sat on top of the hub (Rober,
     2026-10-11, "texture in center overlapping badly"). So MEASURE: shrink
     the faces until no badge or label touches the hub disc or another face.
     Layout sizes (rects), a handful of passes, floor 0.5.
     marker: stance-wheel-fit-measured */
  function fitFaces(wrap, k, fit) {
    try {
      const r0 = wrap.getBoundingClientRect();
      if (!r0.width) return;
      const s = r0.width / SIZE;                       // px per wheel unit
      const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
      const hubR = (R_IN - 10 + 14) * s;               // the hub ring, plus a clear gap
      /* a badge is a DIAMOND in a square box: its empty corners may sit over
         the hub, so it counts as a circle of 0.42 x its width; a label is
         its text rect */
      const shapes = function () {
        const out = [];
        ids.forEach(function (id) {
          const f = faces[id];
          if (!f) return;
          const ic = f.querySelector('.sw-icon'), nm = f.querySelector('.sw-name');
          if (ic) {
            const b = ic.getBoundingClientRect();
            if (b.width) out.push({ id: id, c: true, x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2, r: b.width * 0.42 });
          }
          if (nm) {
            const b = nm.getBoundingClientRect();
            if (b.width) out.push({ id: id, c: false, l: b.left, t: b.top, r: b.right, b: b.bottom });
          }
        });
        return out;
      };
      const rectDist = function (q, x, y) {
        const nx = Math.max(q.l, Math.min(x, q.r)), ny = Math.max(q.t, Math.min(y, q.b));
        return Math.hypot(nx - x, ny - y);
      };
      const hitsHub = function (q) {
        return q.c ? Math.hypot(q.x - cx, q.y - cy) - q.r < hubR : rectDist(q, cx, cy) < hubR;
      };
      const overlap = function (a, b) {
        if (a.id === b.id) return false;
        if (a.c && b.c) return Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 2;
        if (a.c) return rectDist(b, a.x, a.y) < a.r - 2;
        if (b.c) return rectDist(a, b.x, b.y) < b.r - 2;
        return a.l < b.r - 2 && b.l < a.r - 2 && a.t < b.b - 2 && b.t < a.b - 2;
      };
      /* and a label must stay inside its OWN wedge: both ends of its text line
         (inset a little vertically) at an angle within the wedge's span — at
         nine wedges "Walk With Me" crossed the divider into its neighbour */
      const span = 360 / Math.max(1, ids.length);
      const angOf = function (x, y) { let a = Math.atan2(y - cy, x - cx) * 180 / Math.PI + 90; return (a + 360) % 360; };
      const offWedge = function () {
        for (let i = 0; i < ids.length; i++) {
          const f = faces[ids[i]], nm = f && f.querySelector('.sw-name');
          if (!nm) continue;
          const b = nm.getBoundingClientRect();
          if (!b.width) continue;
          const half = span / 2 - GAP_DEG / 2 - 0.5;
          const ym = b.top + b.height * 0.5;
          const pts = [[b.left, ym], [b.right, ym]];
          for (let j = 0; j < pts.length; j++) {
            let d = angOf(pts[j][0], pts[j][1]) - i * span;
            d = ((d + 540) % 360) - 180;
            if (Math.abs(d) > half) return true;
          }
        }
        return false;
      };
      for (let pass = 0; pass < 10 && fit > 0.5; pass++) {
        const bx = shapes();
        let bad = ids.length > 2 && offWedge();
        for (let i = 0; i < bx.length && !bad; i++) {
          if (hitsHub(bx[i])) bad = true;
          for (let j = i + 1; j < bx.length && !bad; j++) if (overlap(bx[i], bx[j])) bad = true;
        }
        if (!bad) break;
        fit = Math.max(0.5, fit * 0.92);
        wrap.style.setProperty('--sw-fk', (k * fit).toFixed(4));
      }
      wrap.dataset.fit = fit.toFixed(3);
    } catch (e) {}
  }

  /* The hub title is one line: a long name ("Walk With Me") shrinks to the
     hub's width instead of wrapping up into the wedge above it. */
  function fitHubName() {
    try {
      if (!hubName) return;
      hubName.style.fontSize = '';
      const w = hubName.clientWidth;
      if (!w) return;
      let fs = parseFloat(getComputedStyle(hubName).fontSize) || 28;
      for (let i = 0; i < 12 && hubName.scrollWidth > w + 1 && fs > 14; i++) {
        fs = Math.max(14, fs * 0.9);
        hubName.style.fontSize = fs.toFixed(1) + 'px';
      }
    } catch (e) {}
  }

  function note(msg) {
    if (!noteEl) return;
    noteEl.textContent = msg || '';
    noteEl.className = 'sw-note' + (msg ? ' show' : '');
  }

  /* ---- actions ----------------------------------------------------------- */
  function choose(id) {
    if (busy || !open || cfgOpen) return;
    if (flyOpen) { pickFly(flyHi); return; }
    if (DEF[id] && DEF[id].fly) { openFly(id); return; }
    const cur = st && typeof st.current === 'number' ? st.current : -1;
    busy = true;
    /* The view closes FIRST and tells C++ in the same breath: C++ releases the
       focus and restores time before it presses any key, so the stance key
       lands in a world running at full speed with no menu in the way. */
    closeLocal();
    if (DEF[id] && DEF[id].tool) toGame('swPick', JSON.stringify({ tool: DEF[id].tool }));
    else toGame('swPick', JSON.stringify({ stance: id, same: id === cur }));
  }
  function cancel() {
    if (!open) return;
    closeLocal();
    toGame('swClose');
  }

  function doOpen() {
    if (open) return;
    open = true; busy = false; hi = -1; keySeen = false;
    ids = wheelIds(st);
    /* Visible BEFORE build: build() measures the wheel's layout width to size
       the faces and glyph canvases, and a display:none layer measures 0. */
    document.body.classList.add('sw-open');
    if (!build()) { open = false; document.body.classList.remove('sw-open'); toGame('swClose'); return; }
    paint();
    note(st && st.msg ? st.msg : '');
    /* one-shot entrance: the class lands a frame after the DOM */
    setTimeout(function () { if (frame) frame.classList.add('sw-in'); }, 16);
    toGame('swGet');
  }
  function closeLocal() {
    open = false;
    hi = -1;
    cfgOpen = false; cfgEl = null; cfgNote = ''; rcAt = 0;
    flyOpen = false; flyEl = null; flyId = -1; flyHi = 0;
    document.body.classList.remove('sw-open');
    if (root) { root.onmousemove = root.onmousedown = root.oncontextmenu = null; root.textContent = ''; }
    root = frame = svgEl = null;
    wedges = {}; faces = {};
  }

  /* ---- the Walk With Me flyout (2026-10-12) ----------------------------
     A wedge with `fly` options opens a small card BESIDE the wheel, on the
     wedge's own side, level with it (centred over the wheel only when the
     screen has no room at the side). The wedge stays lit, the rest of the
     wheel steps back, and nothing on the wheel steers while it is up. Pick
     with the mouse, or W/S / arrows then E / Enter, or the wheel's own key
     again (the lit option, Order wheel first). Esc, right-click or a click
     outside the card goes back to the wheel.
     marker: combat-wheel-wwm-flyout */
  function openFly(id) {
    if (!open || busy || !root || cfgOpen || flyOpen) return;
    const d = DEF[id];
    if (!d || !d.fly || !d.fly.length) return;
    flyOpen = true; flyId = id; flyHi = 0;
    hi = id;
    paint();
    if (frame) frame.classList.add('sw-flying');
    flyEl = el('div', 'sw-fly');
    flyEl.setAttribute('role', 'dialog');
    flyEl.setAttribute('aria-label', d.name);
    flyEl.style.setProperty('--sw-rgb', d.rgb);

    const head = el('div', 'sw-fly-head');
    const tt = el('div', 'sw-fly-tt');
    tt.append(el('div', 'sw-fly-title', d.name), el('div', 'sw-fly-sub', 'Open which?'));
    head.append(iconFor(id), tt);

    const list = el('div', 'sw-fly-list');
    list.setAttribute('role', 'menu');
    d.fly.forEach(function (o, i) {
      const b = el('button', 'sw-fly-o');
      b.type = 'button';
      b.dataset.i = String(i);
      b.dataset.tool = o.tool;
      b.setAttribute('role', 'menuitem');
      const ic = el('div', 'sw-fly-ic');
      const cv = el('canvas', 'sw-fly-glyph');
      cv.setAttribute('aria-hidden', 'true');
      ic.append(cv);
      const tx = el('span', 'sw-fly-tx');
      tx.append(el('span', 'sw-fly-n', o.name), el('span', 'sw-fly-d', o.desc));
      b.append(ic, tx, el('span', 'sw-fly-go', '›'));
      b.addEventListener('mouseenter', function () { setFlyHi(i); });
      list.append(b);
    });

    flyEl.append(head, list,
      el('div', 'sw-fly-keys', 'W / S or arrows · E or Enter opens · Esc or right-click: back'));
    root.append(flyEl);
    if (root) root.style.cursor = 'default';
    /* glyphs at their real layout size, now the card is in the document */
    const icons = flyEl.querySelectorAll('.sw-fly-glyph');
    for (let i = 0; i < icons.length; i++) paintArt(icons[i], d.rgb, d.fly[i].art, d.fly[i].name);
    const badge = flyEl.querySelector('.sw-fly-head .sw-glyph');
    if (badge) paintCanvas(badge, id);
    paintFly();
    placeFly();
    setTimeout(function () { if (flyEl) flyEl.classList.add('sw-in'); }, 16);
    toGame('hudLog', 'combat-wheel-wwm-flyout: open');
  }
  function closeFly() {
    if (!flyOpen) return;
    flyOpen = false;
    if (flyEl && flyEl.parentNode) flyEl.parentNode.removeChild(flyEl);
    flyEl = null; flyId = -1; flyHi = 0;
    if (frame) { frame.classList.remove('sw-flying'); frame.classList.remove('sw-under'); }
    paint();
  }
  function setFlyHi(i) {
    if (!flyOpen || i === flyHi) return;
    flyHi = i;
    paintFly();
  }
  function stepFly(dir) {
    const d = DEF[flyId];
    if (!flyOpen || !d || !d.fly) return;
    setFlyHi((flyHi + dir + d.fly.length) % d.fly.length);
  }
  function paintFly() {
    if (!flyEl) return;
    const bs = flyEl.querySelectorAll('.sw-fly-o');
    for (let i = 0; i < bs.length; i++) {
      bs[i].className = 'sw-fly-o' + (i === flyHi ? ' is-hi' : '');
      bs[i].setAttribute('aria-current', i === flyHi ? 'true' : 'false');
    }
  }
  function pickFly(i) {
    const d = DEF[flyId];
    const o = d && d.fly && d.fly[i];
    if (!o || busy || !open) return;
    busy = true;
    toGame('hudLog', 'combat-wheel-wwm-flyout: ' + o.tool);
    /* closes FIRST, exactly like a wedge pick: C++ releases Focus and
       restores time before it presses Walk With Me's key */
    closeLocal();
    toGame('swPick', JSON.stringify({ tool: o.tool }));
  }
  /* Beside the wheel on the wedge's side, level with its face, kept on
     screen. Layout rects, so the frame's entrance scale is already in them. */
  function placeFly() {
    try {
      if (!flyEl || !root || !frame) return;
      const wrap = frame.querySelector('.sw-wrap');
      const face = faces[flyId];
      if (!wrap || !face) return;
      const W = window.innerWidth || 1920, H = window.innerHeight || 1080;
      const cw = flyEl.offsetWidth, ch = flyEl.offsetHeight;
      const wr = wrap.getBoundingClientRect(), fr = face.getBoundingClientRect();
      const fx = (fr.left + fr.right) / 2, fy = (fr.top + fr.bottom) / 2;
      const gap = 28, edge = 20;
      const rightOk = wr.right + gap + cw <= W - edge, leftOk = wr.left - gap - cw >= edge;
      const wantRight = fx >= (wr.left + wr.right) / 2;
      let left, top, side;
      if (wantRight ? rightOk : !leftOk && rightOk) { left = wr.right + gap; side = 'r'; }
      else if (leftOk) { left = wr.left - gap - cw; side = 'l'; }
      else { left = (W - cw) / 2; side = 'c'; }
      top = side === 'c' ? (H - ch) / 2 : fy - ch / 2;
      top = Math.max(edge, Math.min(H - ch - edge, top));
      flyEl.style.left = Math.round(left) + 'px';
      flyEl.style.top = Math.round(top) + 'px';
      flyEl.dataset.side = side;
      flyEl.className = 'sw-fly sw-fly-' + side + (flyEl.classList.contains('sw-in') ? ' sw-in' : '');
      /* no room at the side: the card sits over the wheel, which steps right
         back like it does under the settings card */
      frame.classList.toggle('sw-under', side === 'c');
    } catch (e) {}
  }

  /* ---- the settings card (2026-10-11) -----------------------------------
     Rober, mid-play: "right click could open floating configuration as well
     when open" — and "i dont see sic em or nff in wheel": those two wedges are
     opt-in, and until now only the deck's Home > UI Elements row could switch
     them on. The card is that row's twin, on the wheel itself: the same
     switches, ids, stops and bridge (swCfg -> swCfgState, home-pane.js
     buildStanceInline). Every change is sent at once and drawn at once (the
     wheel rebuilds under the card); C++ confirms with swCfgState + swState.
     While the card is up nothing on the wheel can be aimed or picked.
     marker: combat-wheel-cfg-card */
  const SW_SLOW = [
    { v: 0.1, name: 'Crawl', hint: 'One second of the world takes ten' },
    { v: 0.2, name: 'Slow', hint: 'One second of the world takes five' },
    { v: 0.35, name: 'Eased', hint: 'One second of the world takes about three' },
    { v: 0.5, name: 'Half', hint: 'One second of the world takes two' },
    { v: 1, name: 'Normal', hint: 'Time is not slowed at all while you choose' }
  ];
  const SW_SIZE = [ { v: 48, name: 'Small' }, { v: 56, name: 'Medium' }, { v: 64, name: 'Large' }, { v: 74, name: 'Huge' } ];
  /* the size slider's range, % of the screen height (2026-10-12, Rober: "combat
     wheel needs scaling slider"). stance_wheel.cpp clamps to the same pair. */
  const SZ_MIN = 30, SZ_MAX = 90;
  function nearest(list, v) {
    let best = 0, d = Infinity;
    for (let i = 0; i < list.length; i++) { const di = Math.abs(list[i].v - v); if (di < d) { d = di; best = i; } }
    return best;
  }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function curSlow() { return Math.max(0.05, Math.min(1, num(st && st.slow, cfg.defSlow))); }
  function curSize() { return Math.max(SZ_MIN, Math.min(SZ_MAX, Math.round(num(st && st.size, cfg.defSize)))); }
  /* an older DLL sends no `hints`: shown, as it always was */
  function hintsOn() { return !(st && st.hints === false); }

  /* everything the wheel's look depends on: a change to any of it rebuilds */
  function shapeOf(list) {
    const s = st || {};
    return list.join(',') + '|' + JSON.stringify(s.icons || {}) + '|' + curSize() + '|' +
      (curSlow() >= 0.999 ? 'run' : 'slow') + '|' + (hintsOn() ? 'hints' : 'bare');
  }
  function reshape() {
    const want = wheelIds(st);
    if (shapeOf(want) === builtShape) return false;
    const keepHi = hi;
    ids = want;
    build();
    document.body.classList.add('sw-open');
    if (frame) frame.classList.add('sw-in');
    hi = ids.indexOf(keepHi) !== -1 ? keepHi : -1;
    if (flyOpen && ids.indexOf(flyId) === -1) closeFly();
    return true;
  }

  function canSave() { return typeof window.swCfg === 'function'; }
  function sendCfg(patch) { return toGame('swCfg', JSON.stringify(Object.assign({ op: 'set' }, patch))); }
  function resolvedWedges() {
    const w = {};
    ORDER.forEach(function (id) { w[wedgeKey(id)] = wedgeOn(st, id); });
    return w;
  }
  /* why a wedge cannot show even when on — home-pane.js naWhy, word for word */
  function cfgWhy(id) {
    const d = DEF[id], s = st || {};
    if (!d.tool) {
      const ok = cfg.known && cfg.stancesOk !== null ? cfg.stancesOk : s.stancesOk !== false;
      if (!ok) return cfg.stancesWhy || 'Needs Stances NG';
      const tarn = cfg.known ? cfg.tarnished : !!s.tarnished;
      return id === 4 && !tarn ? 'Needs TarnishedStance.esp' : '';
    }
    const list = (cfg.known && cfg.tools) ? cfg.tools : (s.tools || []);
    let t = null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === d.tool) { t = list[i]; break; }
    return !t ? 'Needs a newer SkyManager DLL' : (t.ok ? '' : (t.why || 'Its mod is not loaded'));
  }
  /* apply a change locally (optimistic; swCfgState / swState confirm) */
  function applyLocal(patch) {
    st = Object.assign({}, st || {}, patch);
    cfgNote = '';
    reshape();
    paint();
    paintCfg();
  }
  function refuse(msg) { cfgNote = msg; paintCfg(); }
  const NO_BRIDGE = 'This SkyManager DLL cannot save from the wheel. Use Home > UI Elements > Combat Wheel.';

  function toggleWedge(id) {
    if (!canSave()) { refuse(NO_BRIDGE); return; }
    const k = wedgeKey(id), on = wedgeOn(st, id);
    const next = resolvedWedges(); next[k] = !on;
    if (on && !wheelIds(Object.assign({}, st || {}, { wedges: next })).length) {
      refuse('Keep at least one wedge on: the wheel would be empty.');
      return;
    }
    const p = {}; p[k] = !on;
    sendCfg({ wedges: p });
    applyLocal({ wedges: next });
  }
  function setSlow(v) {
    if (!canSave()) { refuse(NO_BRIDGE); return; }
    sendCfg({ slow: v });
    applyLocal({ slow: v });
  }
  function setSize(v) {
    if (!canSave()) { refuse(NO_BRIDGE); return; }
    sendCfg({ size: v });
    applyLocal({ size: v });
  }
  /* ---- the size slider (2026-10-12) ---------------------------------------
     Rober: "combat wheel needs scaling slider". A drawn track, not a native
     range input: Ultralight's own range drag moves one step per click in game,
     and held-mouse input can report buttons === 0, so the drag is tracked the
     deck's proven way (rooms-pane.js smoothRange) — mousedown on the track,
     mousemove / mouseup on the DOCUMENT, never reading e.buttons; a window
     blur ends it too. While it drags only the wheel under the card is redrawn
     (throttled) and the readout updated in place; the card itself is NOT
     rebuilt, or the track would be torn out from under the cursor. The value
     is sent once, on release. Keys on the focused track: arrows 1, Page 5,
     Home / End the ends. marker: combat-wheel-size-slider */
  let szDrag = null, szTimer = 0;
  function szClamp(v) { return Math.max(SZ_MIN, Math.min(SZ_MAX, Math.round(v))); }
  function szFrac(v) { return (v - SZ_MIN) / (SZ_MAX - SZ_MIN); }
  function szShow(v) {
    if (!cfgEl) return;
    const f = (szFrac(v) * 100).toFixed(2) + '%';
    const fill = cfgEl.querySelector('.sw-cfg-fill'), thumb = cfgEl.querySelector('.sw-cfg-thumb');
    const val = cfgEl.querySelector('.sw-cfg-val'), track = cfgEl.querySelector('.sw-cfg-track');
    const capEl = cfgEl.querySelector('.sw-cfg-szcap');
    if (fill) fill.style.width = f;
    if (thumb) thumb.style.left = f;
    if (val) val.textContent = v + '%';
    if (track) track.setAttribute('aria-valuenow', String(v));
    if (capEl) capEl.textContent = szCaption(v);
    cfgEl.querySelectorAll('.sw-cfg-stop[data-size]').forEach(function (b) {
      const on = Number(b.dataset.size) === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function szCaption(v) {
    let name = '';
    SW_SIZE.forEach(function (o) { if (o.v === v) name = o.name + ' · '; });
    return name + v + '% of the screen height';
  }
  /* live: the wheel follows the thumb, at most every 80 ms */
  function szPreview(v) {
    v = szClamp(v);
    if (curSize() === v) { szShow(v); return; }
    st = Object.assign({}, st || {}, { size: v });
    szShow(v);
    if (!szTimer) szTimer = setTimeout(function () {
      szTimer = 0;
      try { reshape(); paint(); } catch (x) {}
    }, 80);
  }
  function szCommit(v) {
    v = szClamp(v);
    if (szTimer) { clearTimeout(szTimer); szTimer = 0; }
    if (!canSave()) { refuse(NO_BRIDGE); return; }
    sendCfg({ size: v });
    applyLocal({ size: v });
  }
  function szFromX(track, x) {
    const r = track.getBoundingClientRect();
    if (!r.width) return curSize();
    const t = Math.max(0, Math.min(1, (x - r.left) / r.width));
    return szClamp(SZ_MIN + t * (SZ_MAX - SZ_MIN));
  }
  function szEnd() {
    if (!szDrag) return;
    const v = curSize();
    document.removeEventListener('mousemove', szDrag.move, true);
    document.removeEventListener('mouseup', szDrag.up, true);
    window.removeEventListener('blur', szDrag.up);
    szDrag = null;
    szCommit(v);
  }
  function szStart(track, e) {
    if (szDrag || !canSave()) return;
    const move = function (ev) { try { szPreview(szFromX(track, ev.clientX)); } catch (x) {} };
    const up = function () { try { szEnd(); } catch (x) {} };
    szDrag = { move: move, up: up };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
    window.addEventListener('blur', up);
    szPreview(szFromX(track, e.clientX));
  }
  function szKey(e) {
    const k = e.key, kc = e.keyCode, v = curSize();
    let to = null;
    if (k === 'ArrowRight' || k === 'ArrowUp' || kc === 39 || kc === 38) to = v + 1;
    else if (k === 'ArrowLeft' || k === 'ArrowDown' || kc === 37 || kc === 40) to = v - 1;
    else if (k === 'PageUp' || kc === 33) to = v + 5;
    else if (k === 'PageDown' || kc === 34) to = v - 5;
    else if (k === 'Home' || kc === 36) to = SZ_MIN;
    else if (k === 'End' || kc === 35) to = SZ_MAX;
    if (to === null) return false;
    szCommit(to);
    const t = cfgEl && cfgEl.querySelector('.sw-cfg-track');
    if (t) t.focus();
    return true;
  }
  function sizeSlider(size, enabled) {
    const row = el('div', 'sw-cfg-slide' + (enabled ? '' : ' is-off'));
    const minus = cfgBtn('sw-cfg-stop sw-cfg-nudge', '\u2212', 'Smaller (2% of the screen height)',
      function () { szCommit(curSize() - 2); });
    const plus = cfgBtn('sw-cfg-stop sw-cfg-nudge', '+', 'Bigger (2% of the screen height)',
      function () { szCommit(curSize() + 2); });
    minus.disabled = plus.disabled = !enabled;
    const track = el('div', 'sw-cfg-track');
    track.setAttribute('role', 'slider');
    track.setAttribute('tabindex', enabled ? '0' : '-1');
    track.setAttribute('aria-label', 'Wheel size');
    track.setAttribute('aria-valuemin', String(SZ_MIN));
    track.setAttribute('aria-valuemax', String(SZ_MAX));
    track.setAttribute('aria-valuenow', String(size));
    track.title = 'Drag, or click anywhere on it. Arrow keys fine-tune.';
    const rail = el('div', 'sw-cfg-rail');
    const fill = el('div', 'sw-cfg-fill');
    const thumb = el('div', 'sw-cfg-thumb');
    fill.style.width = thumb.style.left = (szFrac(size) * 100).toFixed(2) + '%';
    rail.append(fill);
    track.append(rail, thumb);
    if (enabled) track.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      try { track.focus(); } catch (x) {}
      szStart(track, e);
    });
    const val = el('div', 'sw-cfg-val', size + '%');
    row.append(minus, track, plus, val);
    return row;
  }

  function setHints(on) {
    if (!canSave()) { refuse(NO_BRIDGE); return; }
    sendCfg({ hints: !!on });
    applyLocal({ hints: !!on });
  }
  function resetBoth() {
    if (!canSave()) { refuse(NO_BRIDGE); return; }
    sendCfg({ reset: true });
    applyLocal({ slow: cfg.defSlow, size: cfg.defSize });
  }

  function cfgBtn(cls, text, title, fn) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      try { fn(); } catch (x) { try { toGame('hudLog', 'combat wheel card: ' + x.message); } catch (x2) {} }
    });
    return b;
  }
  function cfgSection(head, sub) {
    const sec = el('div', 'sw-cfg-sec');
    const h = el('div', 'sw-cfg-h', head);
    if (sub) h.append(el('span', 'sw-cfg-hs', sub));
    sec.append(h);
    return sec;
  }

  function paintCfg() {
    if (!cfgOpen || !cfgEl) return;
    cfgEl.textContent = '';
    const saveOk = canSave();

    const head = el('div', 'sw-cfg-head');
    const tt = el('div', 'sw-cfg-tt');
    tt.append(el('div', 'sw-cfg-title', 'Combat Wheel'),
      el('div', 'sw-cfg-sub', 'Settings · every change shows on the wheel at once and is saved'));
    head.append(tt, cfgBtn('sw-cfg-btn sw-cfg-close', 'Close', 'Back to the wheel (Esc or right-click)', closeCfg));
    cfgEl.append(head);

    /* --- wedges, wheel order --- */
    const ws = cfgSection('Wedges', 'switch each one on or off');
    const grid = el('div', 'sw-cfg-grid');
    const na = [];
    ORDER.forEach(function (id) {
      const d = DEF[id], on = wedgeOn(st, id), why = cfgWhy(id);
      if (why) na.push(d.name);
      const b = cfgBtn('sw-cfg-w' + (on ? ' is-on' : '') + (why ? ' is-na' : ''), undefined,
        (on ? 'Hide ' : 'Show ') + d.name + ' on the wheel' + (why ? ' (' + why + ')' : ''),
        function () { toggleWedge(id); });
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.dataset.wedge = wedgeKey(id);
      b.style.setProperty('--sw-rgb', d.rgb);
      b.disabled = !saveOk;
      const ic = iconFor(id);
      const tx = el('span', 'sw-cfg-wtx');
      tx.append(el('span', 'sw-cfg-wn', d.name),
        el('span', 'sw-cfg-ws', why || (on ? 'On the wheel' : 'Off the wheel')));
      b.append(ic, tx, el('span', 'sw-cfg-pill' + (on ? ' on' : ''), on ? 'ON' : 'OFF'));
      grid.append(b);
    });
    ws.append(grid, el('div', 'sw-cfg-cap', na.length
      ? 'Dimmed: ' + na.join(', ') + '. Their mod is not loaded, so they stay off the wheel whatever the switch says.'
      : 'Every wedge has its mod loaded. Off means it never appears on the wheel.'));
    cfgEl.append(ws);

    /* --- world speed + size, side by side --- */
    const two = el('div', 'sw-cfg-two');
    const slow = curSlow(), ti = nearest(SW_SLOW, slow);
    const ss = cfgSection('World speed while the wheel is up');
    const sr = el('div', 'sw-cfg-stops');
    SW_SLOW.forEach(function (o, i) {
      const b = cfgBtn('sw-cfg-stop' + (i === ti ? ' is-on' : ''), o.name, o.hint + ' (' + Math.round(o.v * 100) + '%)',
        function () { setSlow(o.v); });
      b.setAttribute('aria-pressed', i === ti ? 'true' : 'false');
      b.dataset.slow = String(o.v);
      b.disabled = !saveOk;
      sr.append(b);
    });
    ss.append(sr, el('div', 'sw-cfg-cap', SW_SLOW[ti].hint + ' · ' + Math.round(slow * 100) + '% speed, from now'));
    const size = curSize();
    const zs = cfgSection('Wheel size');
    /* the slider, then the four named sizes as quick picks (lit only when the
       size is exactly theirs) */
    const zr = el('div', 'sw-cfg-stops sw-cfg-presets');
    SW_SIZE.forEach(function (o) {
      const on = o.v === size;
      const b = cfgBtn('sw-cfg-stop' + (on ? ' is-on' : ''), o.name, o.name + ': ' + o.v + '% of the screen height',
        function () { setSize(o.v); });
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.dataset.size = String(o.v);
      b.disabled = !saveOk;
      zr.append(b);
    });
    zs.append(sizeSlider(size, saveOk), zr, el('div', 'sw-cfg-cap sw-cfg-szcap', szCaption(size)));
    /* the hint lines under the wheel: Show / Hide */
    const hs = el('div', 'sw-cfg-hints');
    hs.append(el('div', 'sw-cfg-h sw-cfg-hh', 'Hints under the wheel'));
    const hr = el('div', 'sw-cfg-stops');
    [[true, 'Show', 'The two lines of keys and tips under the wheel'], [false, 'Hide', 'Only the Cancel button stays under the wheel']]
      .forEach(function (o) {
        const on = hintsOn() === o[0];
        const b = cfgBtn('sw-cfg-stop' + (on ? ' is-on' : ''), o[1], o[2], function () { setHints(o[0]); });
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.dataset.hints = o[0] ? '1' : '0';
        b.disabled = !saveOk;
        hr.append(b);
      });
    hs.append(hr);
    ss.append(hs);
    two.append(ss, zs);
    cfgEl.append(two);

    /* --- footer --- */
    const foot = el('div', 'sw-cfg-foot');
    const msg = cfgNote || (!saveOk ? NO_BRIDGE : '');
    foot.append(el('div', 'sw-cfg-note' + (msg ? ' show' : ''), msg),
      el('div', 'sw-cfg-keys', 'Esc or right-click closes this card'));
    const rb = cfgBtn('sw-cfg-btn sw-cfg-reset', 'Reset speed + size',
      'Back to ' + Math.round(cfg.defSlow * 100) + '% speed and the Large wheel. Wedges are kept.', resetBoth);
    rb.disabled = !saveOk || (Math.abs(slow - cfg.defSlow) < 0.001 && size === cfg.defSize);
    foot.append(rb);
    cfgEl.append(foot);

    /* glyphs at their real layout size, now the card is in the document */
    ORDER.forEach(function (id) {
      const t = cfgEl.querySelector('.sw-cfg-w[data-wedge="' + wedgeKey(id) + '"] .sw-glyph');
      if (t) paintCanvas(t, id);
    });
  }

  function openCfgCard() {
    if (!open || busy || !root || cfgOpen) return;
    closeFly();
    cfgOpen = true;
    cfgNote = '';
    setHi(-1);
    if (frame) frame.classList.add('sw-under');
    cfgEl = el('div', 'sw-cfg');
    cfgEl.setAttribute('role', 'dialog');
    cfgEl.setAttribute('aria-label', 'Combat Wheel settings');
    root.append(cfgEl);
    if (root) root.style.cursor = 'default';
    paintCfg();
    toGame('swCfg', JSON.stringify({ op: 'get' }));   /* defaults + why each wedge is missing */
    toGame('hudLog', 'combat-wheel-cfg: card open');
  }
  function closeCfg() {
    if (!cfgOpen) return;
    if (szDrag) { try { szEnd(); } catch (x) {} }   /* a drag cut short still saves where it was */
    cfgOpen = false;
    cfgNote = '';
    if (cfgEl && cfgEl.parentNode) cfgEl.parentNode.removeChild(cfgEl);
    cfgEl = null;
    if (frame) frame.classList.remove('sw-under');
  }
  function toggleCfg() { if (cfgOpen) closeCfg(); else openCfgCard(); }

  /* swCfgState — the reply to swCfg, from this view or the deck's row */
  function receiveCfg(raw) {
    const j = parse(raw);
    if (!j || typeof j !== 'object') return;
    cfg.known = true;
    cfg.defSlow = num(j.defSlow, 0.2);
    cfg.defSize = Math.round(num(j.defSize, 64));
    cfg.stancesOk = j.stancesOk === false ? false : (j.stancesOk === true ? true : null);
    cfg.stancesWhy = typeof j.stancesWhy === 'string' ? j.stancesWhy : '';
    cfg.tarnished = j.tarnished === true;
    cfg.tools = Array.isArray(j.tools) ? j.tools.filter(function (t) { return t && typeof t.id === 'string'; }) : null;
    cfg.icons = (j.icons && typeof j.icons === 'object') ? j.icons : null;
    /* the option values are the sidecar's truth: fold them into the wheel's state */
    if (st && typeof st === 'object') {
      const patch = {};
      if (typeof j.slow === 'number' && isFinite(j.slow)) patch.slow = Math.max(0.05, Math.min(1, j.slow));
      if (typeof j.size === 'number' && isFinite(j.size)) patch.size = Math.max(SZ_MIN, Math.min(SZ_MAX, Math.round(j.size)));
      if (typeof j.hints === 'boolean') patch.hints = j.hints;
      if (j.wedges && typeof j.wedges === 'object') {
        const w = {};
        for (const k in j.wedges) if (typeof j.wedges[k] === 'boolean') w[k] = j.wedges[k];
        patch.wedges = w;
      }
      st = Object.assign({}, st, patch);
    }
    if (!open) return;
    reshape();
    paint();
    if (cfgOpen) paintCfg();
  }

  /* ---- C++ -> view ------------------------------------------------------- */
  window.swShow = function (v) {
    try {
      if (String(v) === '1') doOpen();
      else if (open) closeLocal();
    } catch (e) { try { toGame('hudLog', 'stance wheel: ' + e.message); } catch (e2) {} closeLocal(); toGame('swClose'); }
  };
  window.swState = function (raw) {
    try {
      const j = parse(raw);
      if (!j || typeof j !== 'object') return;
      st = j;
      if (!open) return;
      reshape();
      paint();
      note(j.msg || '');
      if (cfgOpen) paintCfg();
    } catch (e) { try { toGame('hudLog', 'stance wheel state: ' + e.message); } catch (e2) {} }
  };
  /* chained: nothing else on hud.html answers swCfgState today, but a later
     script that does must not be silenced (nor silence this one) */
  (function () {
    const prev = typeof window.swCfgState === 'function' ? window.swCfgState : null;
    window.swCfgState = function (raw) {
      if (prev) { try { prev(raw); } catch (e) {} }
      try { receiveCfg(raw); } catch (e) { try { toGame('hudLog', 'combat wheel cfg state: ' + e.message); } catch (e2) {} }
    };
  })();
  window.swKey = function () {
    try {
      if (!open) return;
      if (cfgOpen) { closeCfg(); return; }   /* the card first, like Esc */
      if (flyOpen) { pickFly(flyHi); return; } /* the lit option: Order wheel first */
      if (hi >= 0) choose(hi); else cancel();
    } catch (e) { try { toGame('hudLog', 'stance wheel key: ' + e.message); } catch (e2) {} }
  };

  /* Arrow keys walk the wheel clockwise (Right/Down) or back (Left/Up). The
     first press starts from the stance you are in, so Right+Enter is "the
     next stance round". */
  function stepHi(dir) {
    if (!ids.length || busy || cfgOpen) return;
    const cur = st && typeof st.current === 'number' ? st.current : -1;
    let i = ids.indexOf(hi >= 0 ? hi : cur);
    if (i < 0) i = dir > 0 ? -1 : 0;
    setHi(ids[(i + dir + ids.length) % ids.length]);
  }

  /* Keys: WASD or the arrows walk the wheel, E or Enter picks, Esc cancels
     (Rober, 2026-10-11: "stances doesnt support wasd or arrows to navigate,
     e or enter to select"). WASD/E were left out at first because keys reach
     the game too — but a focused view stops the player moving (browse mode's
     proven "the player stops moving"), so they are safe here; arrow keys stay
     for anyone who reaches for them. Capture phase so nothing else in the HUD
     document acts on them while the wheel is up. */
  window.addEventListener('keydown', function (e) {
    if (!open) return;
    const k = e.key, c = e.code, kc = e.keyCode;
    if (!keySeen) {
      keySeen = true;
      /* marker: stance-wheel-first-key — proof in HotkeyDeck.log that keys
         reach the wheel at all, the first thing to read if they "do nothing" */
      try { toGame('hudLog', 'stance-wheel-first-key: ' + (k || c || kc)); } catch (x) {}
    }
    const lk = typeof k === 'string' ? k.toLowerCase() : '';
    if (k === 'Escape' || c === 'Escape' || kc === 27) {
      /* Esc closes a card first; the next Esc cancels the wheel */
      try { if (cfgOpen) closeCfg(); else if (flyOpen) closeFly(); else cancel(); } catch (x) {}
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (cfgOpen) {
      /* the card is up: no key steers or picks. Enter / Space on a focused
         card button still press it. */
      const onCard = e.target && e.target.closest && e.target.closest('.sw-cfg');
      if (onCard && (k === 'Enter' || k === ' ' || kc === 13 || kc === 32)) return;
      /* the size slider, focused: arrows / Page / Home / End move it */
      if (e.target && e.target.closest && e.target.closest('.sw-cfg-track') && szKey(e)) {
        e.preventDefault(); e.stopPropagation(); return;
      }
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (k === 'Enter' || c === 'Enter' || c === 'NumpadEnter' || kc === 13 || lk === 'e' || c === 'KeyE' || kc === 69) {
      if (flyOpen) pickFly(flyHi);
      else if (hi >= 0) choose(hi);
      e.preventDefault(); e.stopPropagation(); return;
    }
    /* clockwise: Right / Down / D / S · back: Left / Up / A / W */
    const next = k === 'ArrowRight' || k === 'ArrowDown' || kc === 39 || kc === 40 ||
                 lk === 'd' || lk === 's' || c === 'KeyD' || c === 'KeyS' || kc === 68 || kc === 83;
    const prev = k === 'ArrowLeft' || k === 'ArrowUp' || kc === 37 || kc === 38 ||
                 lk === 'a' || lk === 'w' || c === 'KeyA' || c === 'KeyW' || kc === 65 || kc === 87;
    if (next || prev) {
      if (flyOpen) stepFly(next ? 1 : -1);
      else stepHi(next ? 1 : -1);
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  window.HudStance = {
    isOpen: function () { return open; },
    cfgOpen: function () { return cfgOpen; },
    flyOpen: function () { return flyOpen; },
    openCfg: function () { try { if (open && !cfgOpen) toggleCfg(); } catch (e) {} },
    _debug: function () { return { open: open, hi: hi, ids: ids.slice(), st: st, cfgOpen: cfgOpen, flyOpen: flyOpen, flyHi: flyHi }; },
    _step: stepHi
  };
})();
