'use strict';

/* ====================================================================== *
 *  Character — a personal character sheet: live pools and skills, searchable
 *  active effects, a freeform role-play identity and a portrait.
 *
 *  C++ (charsheet.cpp) owns the live read of player stats + the active
 *  magic-effect list, and persists the free-text meta. This pane owns
 *  layout, the effect search + armed-remove, live countdowns, and the
 *  debounced meta autosave.
 *
 *  Bridge — requests (JS -> C++):
 *    psGet()                     pull a fresh snapshot
 *    psRemoveEffect(json)        {key,force} — dispel one active effect
 *    psSetMeta(json)             partial RP profile/story save
 *  Replies (global fns C++ calls; names disjoint per the deck law):
 *    psData(payload)             full snapshot (see the contract below)
 *    psResult({ok,msg})          outcome of a remove/setMeta; a fresh psData
 *                                follows so state re-syncs
 *
 *  Payload contract:
 *   { name, race, raceEditorId, level,
 *     hp:{cur,max}, mag:{cur,max}, sta:{cur,max},
 *     carry:{cur,max}, gold, souls:{dragon}, bounty, beast,
 *     skills:[{name,level} ×18], inventory:{potions:{health,magicka,
 *     stamina,other,total},lockpicks}, effects:[{key,id,name,source,plugin,
 *     magnitude,durSec,remainSec,harmful,removeMode,wantsRemove}],
 *     meta:{charClass,alignment,title,eyeColor,height,age,homeland,deity,
 *           background,history,portrait} }
 *   meta.portrait is a view-relative path ("portraits/…"), plain <img> src,
 *   NO query string (Ultralight eats them).
 *
 *   FORWARD-COMPATIBLE, not yet sent by char_sheet.cpp (see notes / renderReserved):
 *     levelProgress:{cur,next,pct}  — XP into the current level, for the Level
 *                                     card's progress-to-next treatment.
 *     slots:[{icon,label,value,detail,accent,kind}]  — a strip of equipped-item
 *                                     / active-content tiles beside the stat
 *                                     chips. Until the DLL sends these, the strip
 *                                     shows deliberately-reserved placeholder
 *                                     tiles (dashed, glyph + label) so the row
 *                                     reads as coming-soon, never broken.
 *
 *  Host contract (mirrors KeysPane/LootPane): CharSheetPane.init() ·
 *  onShow() · onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.CharSheetPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const POLL_MS = 2000;    // vitals move in play; re-pull while the tab is up
  const SAVE_DEBOUNCE = 350;
  const TICK_MS = 1000;    // live effect countdown

  /* ============================================================= state == */

  const state = {
    loaded: false,
    data: null,            // last psData payload
    recvAt: 0,             // Date.now() when this snapshot's remainSec was true
  };

  const ui = {
    visible: false,
    filter: '',
    armed: {},             // effect instance key -> true when its remove is armed
    pollT: null,
    tickT: null,
    savePend: {},          // pending meta subset waiting on the debounce
    saveT: null,
    /* Scroll-jitter guard (Rober, 2026-08-13: "the skills numbers kinda jump or
       distort when scrolling"). The 2 s poll rebuilds the skills/chips/inventory
       grids with innerHTML while #ps-pane is the scroller — replacing the DOM
       under an in-progress scroll makes Ultralight reflow and repaint, which is
       the jump/distort. So a POLL-driven refresh is DEFERRED while a scroll is in
       flight and flushed ~140 ms after it settles; a show / tab-switch / filter
       still renders immediately. */
    scrolling: false,
    scrollT: null,
    deferred: false,       // a poll snapshot arrived mid-scroll and is waiting
  };
  const SCROLL_IDLE_MS = 140;

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'psGet') setTimeout(devData, 30);
      if (DEV && fn === 'psRemoveEffect') setTimeout(function () { devRemove(arg); }, 30);
      if (DEV && fn === 'psSetMeta') setTimeout(function () { window.psResult({ ok: true, msg: '' }); }, 20);
      if (DEV && fn === 'psPackList') setTimeout(function () { devPackList(arg); }, 30);
    }
  }

  window.psData = function (d) {
    if (!d || typeof d !== 'object') return;
    state.data = normalize(d);
    state.loaded = true;
    state.recvAt = Date.now();
    /* an armed remove that no longer matches a present effect is stale */
    const live = {};
    state.data.effects.forEach(function (e) { live[e.key] = true; });
    Object.keys(ui.armed).forEach(function (k) { if (!live[k]) delete ui.armed[k]; });
    if (!ui.visible) return;
    /* Poll snapshots that land mid-scroll are HELD — rebuilding the grids under
       an active scroll is what makes the numbers jump. The scroll-idle timer
       flushes the newest snapshot. A first paint (nothing on screen yet) must
       still draw so the skeleton is replaced. */
    if (ui.scrolling && state.loaded && $('ps-skills-grid') && $('ps-skills-grid').childNodes.length) {
      ui.deferred = true;
      return;
    }
    render();
  };

  window.psResult = function (r) {
    /* C++ pushes a fresh psData right after; nothing to render here beyond a
       transient toast, which the effect list's re-render already conveys. A
       failed remove keeps the row — psData will still list it. */
    if (r && r.msg) {
      if (r.ok === false) console.log('[charsheet] result', r.msg);
      if (typeof window.toast === 'function') window.toast(r.msg);
    }
  };

  /* Defensive normalize — a missing sub-object must never throw a render. */
  function normalize(d) {
    const v = function (o) { return (o && typeof o === 'object') ? o : {}; };
    const num = function (n) { return Number(n) || 0; };
    const hp = v(d.hp), mag = v(d.mag), sta = v(d.sta), carry = v(d.carry),
          souls = v(d.souls), meta = v(d.meta), inventory = v(d.inventory),
          potions = v(inventory.potions), lp = v(d.levelProgress);
    /* levelProgress: forward-compatible. Only meaningful when max>0 (the DLL
       actually sent XP). pct is derived if not given, clamped 0..100. */
    const lpNext = num(lp.next);
    let lpPct = num(lp.pct);
    if (!lpPct && lpNext > 0) lpPct = (num(lp.cur) / lpNext) * 100;
    lpPct = Math.max(0, Math.min(100, lpPct));
    return {
      name: String(d.name || ''),
      race: String(d.race || ''),
      raceEditorId: String(d.raceEditorId || ''),
      level: num(d.level),
      levelProgress: { cur: num(lp.cur), next: lpNext, pct: lpPct,
                       has: lpNext > 0 || num(lp.pct) > 0 },
      slots: Array.isArray(d.slots) ? d.slots.map(function (s) {
        s = v(s);
        return {
          icon: String(s.icon || ''),
          label: String(s.label || ''),
          value: String(s.value == null ? '' : s.value),
          detail: String(s.detail || ''),
          accent: String(s.accent || ''),
          kind: String(s.kind || ''),
        };
      }) : [],
      hp: { cur: num(hp.cur), max: num(hp.max) },
      mag: { cur: num(mag.cur), max: num(mag.max) },
      sta: { cur: num(sta.cur), max: num(sta.max) },
      carry: { cur: num(carry.cur), max: num(carry.max) },
      gold: num(d.gold),
      souls: { dragon: num(souls.dragon) },
      bounty: num(d.bounty),
      beast: String(d.beast || ''),
      inventory: {
        potions: {
          health: num(potions.health), magicka: num(potions.magicka),
          stamina: num(potions.stamina), other: num(potions.other),
          total: num(potions.total),
        },
        lockpicks: num(inventory.lockpicks),
      },
      skills: Array.isArray(d.skills) ? d.skills.map(function (s) {
        s = v(s); return { name: String(s.name || ''), level: num(s.level) };
      }) : [],
      effects: Array.isArray(d.effects) ? d.effects.map(function (e) {
        e = v(e);
        return {
          id: (e.id === undefined || e.id === null) ? '' : String(e.id),
          key: String(e.key || ('id:' + String(e.id == null ? '' : e.id))),
          name: String(e.name || 'Effect'),
          source: String(e.source || ''),
          plugin: String(e.plugin || ''),
          magnitude: num(e.magnitude),
          durSec: num(e.durSec),
          remainSec: num(e.remainSec),
          harmful: !!e.harmful,
          wantsRemove: e.wantsRemove !== false,   // default removable
          removeMode: e.removeMode === 'locked' ? 'locked' :
            (e.removeMode === 'confirm' ? 'confirm' : (e.wantsRemove === false ? 'locked' : 'safe')),
        };
      }) : [],
      meta: {
        charClass: String(meta.charClass || ''),
        alignment: String(meta.alignment || ''),
        title: String(meta.title || ''),
        eyeColor: String(meta.eyeColor || ''),
        height: String(meta.height || ''),
        age: String(meta.age || ''),
        homeland: String(meta.homeland || ''),
        deity: String(meta.deity || ''),
        background: String(meta.background || ''),
        history: String(meta.history || ''),
        portrait: String(meta.portrait || ''),
        /* Portrait display crop, same {z,x,y} model the follower roster uses.
           C++ sends it under meta.portraitCrop; clamped there, re-clamped in the
           crop editor. Missing / identity => the photo is drawn as shot. */
        portraitCrop: normCrop(meta.portraitCrop),
      },
    };
  }

  /* Clamp a portrait crop to the SAME invariant followers-pane.js and
     char_sheet.cpp enforce: z in [1,4]; |x|,|y| <= (z-1)/2. Returns null for an
     identity crop (nothing to draw), so the caller can skip the transform. */
  function normCrop(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const n = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
    let z = n(raw.z); if (!(z >= 1)) z = 1;
    z = Math.max(1, Math.min(4, z));
    const lim = (z - 1) / 2;
    let x = Math.max(-lim, Math.min(lim, n(raw.x)));
    let y = Math.max(-lim, Math.min(lim, n(raw.y)));
    z = Math.round(z * 1e4) / 1e4; x = Math.round(x * 1e4) / 1e4; y = Math.round(y * 1e4) / 1e4;
    if (z === 1 && x === 0 && y === 0) return null;
    return { z: z, x: x, y: y };
  }

  /* ============================================================ helpers == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtInt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function clampPct(cur, max) {
    if (!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, (cur / max) * 100));
  }

  /* remainSec was true at recvAt; a live view subtracts the wall clock so the
     countdown moves without another pull. Never below 0. */
  function liveRemain(e) {
    if (!e || e.remainSec <= 0) return 0;
    const elapsed = (Date.now() - state.recvAt) / 1000;
    return Math.max(0, e.remainSec - elapsed);
  }
  function fmtDur(sec) {
    sec = Math.round(sec);
    if (sec <= 0) return '';
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
    const h = Math.floor(m / 60), mm = m % 60;
    return h + 'h' + (mm ? ' ' + mm + 'm' : '');
  }

  /* filter-as-you-type across effect name / source / plugin */
  function visibleEffects() {
    const d = state.data;
    if (!d) return [];
    const n = ui.filter.toLowerCase();
    let list = d.effects;
    if (n) list = list.filter(function (e) {
      return e.name.toLowerCase().indexOf(n) !== -1 ||
             e.source.toLowerCase().indexOf(n) !== -1 ||
             e.plugin.toLowerCase().indexOf(n) !== -1;
    });
    /* harmful first (you came here to strip a debuff), then longest-remaining,
       then permanent, so the actionable rows sit at the top */
    return list.slice().sort(function (a, b) {
      if (a.harmful !== b.harmful) return a.harmful ? -1 : 1;
      const ra = a.remainSec, rb = b.remainSec;
      const pa = ra <= 0 ? 1 : 0, pb = rb <= 0 ? 1 : 0;   // permanent last
      if (pa !== pb) return pa - pb;
      return rb - ra;
    });
  }

  /* ============================================================ render == */

  function render() {
    if (!state.loaded && !state.data) { renderSkeleton(); return; }
    const d = state.data;
    const root = $('ps-pane');
    if (root) root.classList.remove('ps-loading');

    renderHeader(d);
    renderVitals(d);
    renderReserved(d);
    renderSkills(d);
    renderInventory(d);
    renderEffects();
    renderStory(d);
  }

  function renderSkeleton() {
    const root = $('ps-pane');
    if (root) root.classList.add('ps-loading');
    const body = $('ps-eff-body');
    if (body) {
      body.innerHTML = new Array(5).fill(
        '<div class="ps-eff"><div class="ps-eff-main">' +
        '<span class="ps-skel-box" style="width:150px;height:16px;display:block"></span>' +
        '<span class="ps-skel-box" style="width:110px;height:12px;display:block;margin-top:5px"></span>' +
        '</div><span class="ps-skel-box" style="width:38px;height:38px;display:block"></span></div>').join('');
    }
  }

  function renderHeader(d) {
    renderPortrait(d);
    const name = $('ps-name');
    if (name) name.textContent = d.name || 'Unnamed';

    const race = $('ps-race');
    if (race) {
      const rt = d.race || d.raceEditorId || 'Unknown';
      race.innerHTML = '<b>Race</b>' + esc(rt);
      race.title = d.raceEditorId && d.raceEditorId !== d.race
        ? (d.race + ' (' + d.raceEditorId + ')') : rt;
    }
    const cls = $('ps-class-input');
    if (cls && document.activeElement !== cls) cls.value = d.meta.charClass || '';
    setProfileInput('ps-alignment-input', d.meta.alignment);
    setProfileInput('ps-title-input', d.meta.title);
    setProfileInput('ps-eyes-input', d.meta.eyeColor);
    setProfileInput('ps-height-input', d.meta.height);
    setProfileInput('ps-age-input', d.meta.age);
    setProfileInput('ps-homeland-input', d.meta.homeland);
    setProfileInput('ps-deity-input', d.meta.deity);

    const lvl = $('ps-level-num');
    if (lvl) lvl.textContent = d.level || '—';

    /* progress-to-next-level ring: only sweep the ring when the DLL actually
       sent XP. Otherwise the ring is a quiet full gold band (via the
       :not(.ps-level-has-xp) CSS rule) and the foot reads "next: N+1" — never a
       fake partial fill. The foot line is static in index.html; the ring's
       sweep is a CSS var on the .ps-level element. */
    const card = levelCard();
    if (!card) return;
    const foot = provisionLevelExtras(card);
    const lp = d.levelProgress || {};
    card.classList.toggle('ps-level-has-xp', !!lp.has);
    card.style.setProperty('--ps-ring', (lp.has ? lp.pct : 0).toFixed(1));
    const ring = card.querySelector('.ps-level-ring');
    if (ring) ring.title = lp.has
      ? (fmtInt(lp.cur) + ' / ' + fmtInt(lp.next) + ' XP to level ' + ((d.level || 0) + 1))
      : (d.level ? 'Level ' + d.level + ' — advance to reach ' + (d.level + 1) : 'Level');
    if (foot) {
      foot.textContent = lp.has
        ? (Math.round(lp.pct) + '% to ' + ((d.level || 0) + 1))
        : (d.level ? 'next: ' + (d.level + 1) : '');
      foot.title = lp.has
        ? (fmtInt(lp.cur) + ' / ' + fmtInt(lp.next) + ' XP to level ' + ((d.level || 0) + 1))
        : 'Advance to your next level';
    }
  }

  /* The Level card in index.html has a class, not an id; grab it by class and
     memoise. It sits in the header beside the identity cluster. */
  let _levelCard = null;
  function levelCard() {
    if (_levelCard && document.body.contains(_levelCard)) return _levelCard;
    const pane = $('ps-pane');
    _levelCard = (pane || document).querySelector('.ps-level');
    return _levelCard;
  }

  /* The medallion's foot line lives in index.html now (under the ring). This
     stays for resilience: if an older skeleton without the foot is loaded, it
     appends one so the "next: N+1" hint still shows. Idempotent. */
  function provisionLevelExtras(card) {
    let foot = $('ps-level-foot');
    if (foot) return foot;
    foot = document.createElement('div');
    foot.id = 'ps-level-foot';
    foot.className = 'ps-level-foot';
    card.appendChild(foot);
    return foot;
  }

  function setProfileInput(id, value) {
    const n = $(id);
    if (n && document.activeElement !== n) n.value = value || '';
  }

  function emptyPortrait() {
    return '<div class="ps-portrait-hint"><div class="ps-portrait-glyph">🖼</div>' +
      '<div class="ps-portrait-cap">Take a portrait in-game, add one from ' +
      'the Deck Portal, or capture one in the CHIM tab</div></div>';
  }

  /* ---- portrait: capture + crop ---------------------------------------- *
   *  The photo is grabbed by the SAME D3D11 capture the followers use
   *  (portrait_capture.cpp), pointed at the player and written to the fixed
   *  file portraits/player-sheet.png. The crop is a DISPLAY crop — a CSS
   *  transform on the <img>, the exact model the follower roster uses, because
   *  the plugin cannot re-cut PNG pixels. Framing is done through the followers'
   *  own crop popout (FolPane.openCropEditor), so there is one crop editor in
   *  the whole deck, not two. */

  let capturePending = false;   // true between psTakePortrait and psPortraitTaken

  /* The <img> src carries a cache-buster so a RE-capture of the same filename
     repaints — but Ultralight eats query strings on an <img> src at load, so we
     tag with the mtime-style token ONLY on a real path and retry bare on error,
     the same query-hostile-loader dance the followers medallions use. */
  function portraitSrc(path) { return path; }

  /* The portrait's identity object-position: '' inherits .ps-portrait img,
     whose object-fit:cover defaults to 50% 50% — the portrait is centred with
     no crop. This is the baseline the crop editor is told to match
     (openPortraitCrop passes baseline:'50% 50%' + aspect 156/200), so reframing
     is WYSIWYG: the editor shows what the square-source cover-crops into the
     156x200 frame, not the raw square. */
  const PORTRAIT_BASELINE = '';   // inherit .ps-portrait img (cover default = 50% 50%)

  function applyPortraitCrop(img, crop) {
    if (!img) return;
    /* Route through the ONE shared crop->CSS mapping (hd-facefit.js) so the
       character portrait, the follower medallions AND the crop editor preview
       all render a given {z,x,y} byte-identically. cropCss forces 50% 50% when
       a crop is present and clears the transform when it is not — exactly the
       old behaviour, so no saved crop changes on screen. The inline fallback is
       the SAME formula for a bare harness that hasn't loaded the module. */
    if (window.HDFaceFit && HDFaceFit.applyCrop) {
      HDFaceFit.applyCrop(img, crop, PORTRAIT_BASELINE);
      return;
    }
    if (!crop || (crop.z === 1 && !crop.x && !crop.y)) {
      img.style.transform = ''; img.style.transformOrigin = '50% 50%';
      img.style.objectPosition = PORTRAIT_BASELINE; return;
    }
    img.style.transformOrigin = '50% 50%';
    img.style.transform = 'translate(' + ((crop.x || 0) * 100).toFixed(3) + '%,' +
      ((crop.y || 0) * 100).toFixed(3) + '%) scale(' + crop.z.toFixed(4) + ')';
    img.style.objectPosition = '50% 50%';
  }

  function renderPortrait(d) {
    const port = $('ps-portrait');
    if (!port) return;
    port.textContent = '';

    if (d.meta.portrait) {
      port.className = 'ps-portrait';
      const img = document.createElement('img');
      img.alt = 'portrait';
      img.src = portraitSrc(d.meta.portrait);
      applyPortraitCrop(img, d.meta.portraitCrop);
      img.addEventListener('error', function () {
        /* the path the sheet believes in is gone — fall back to the empty card,
           which still offers Take portrait */
        port.className = 'ps-portrait ps-portrait-empty';
        port.textContent = '';
        port.appendChild(emptyCardNode());
      });
      port.appendChild(img);
      /* an overlay action bar: retake + reframe, revealed on hover/focus */
      port.appendChild(portraitActions(true));
    } else {
      port.className = 'ps-portrait ps-portrait-empty';
      port.appendChild(emptyCardNode());
    }
  }

  /* The empty state: the hint text PLUS a real Take-portrait button, so the
     first portrait is one click from here — no hunting for the CHIM tab. */
  function emptyCardNode() {
    const wrap = document.createElement('div');
    wrap.innerHTML = emptyPortrait();
    const node = wrap.firstChild;
    node.appendChild(takeButton('ps-portrait-take', '📷 Take portrait'));
    return node;
  }

  /* Retake + reframe, shown over an existing portrait. */
  function portraitActions(hasCrop) {
    const bar = document.createElement('div');
    bar.className = 'ps-portrait-actions';
    bar.appendChild(takeButton('ps-portrait-retake', '📷 Retake'));
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'ps-portrait-btn ps-portrait-frame';
    frame.textContent = '✎ Reframe';
    frame.title = 'Pan and zoom the portrait — nothing is re-saved to disk';
    frame.addEventListener('click', function (e) { e.stopPropagation(); openPortraitCrop(); });
    bar.appendChild(frame);
    return bar;
  }

  function takeButton(cls, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ps-portrait-btn ' + cls;
    b.title = 'Arm the shot, then press E in-game to capture (switches to third person if needed)';
    b.textContent = capturePending ? '⌛ press E in-game' : label;
    b.disabled = capturePending;
    b.addEventListener('click', function (e) { e.stopPropagation(); takePortrait(); });
    return b;
  }

  function takePortrait() {
    if (capturePending) return;
    capturePending = true;
    /* repaint the button into its pending state immediately */
    if (state.data && ui.visible) renderPortrait(state.data);
    /* ARM flow (2026-08-13): the palette closes and the shot fires on the next E,
       so the player can pose and frame first. The in-game notification is the
       real instruction; this toast is a fallback for the frame before the deck
       hides. */
    if (typeof window.toast === 'function') window.toast('Portrait armed — line up your shot, then press E');
    toGame('psTakePortrait', '');
  }

  /* C++ replies here after the shot lands (or fails). On success it has already
     set meta.portrait + pushed a fresh psData, so state.data is current; open
     the crop editor on the new frame so framing is one gesture away. */
  window.psPortraitTaken = function (r) {
    capturePending = false;
    let ok = false, file = '';
    if (r && typeof r === 'object') { ok = !!r.ok; file = String(r.file || ''); }
    else { try { const j = JSON.parse(r); ok = !!j.ok; file = String(j.file || ''); } catch (e) {} }
    if (!ui.visible) return;
    if (state.data) renderPortrait(state.data);   // clear the pending state either way
    if (ok && state.data && state.data.meta.portrait) openPortraitCrop();
  };

  /* Open the followers' crop popout on the current portrait and save the result
     back through psSetMeta as the flat crop fields char_sheet.cpp accepts. */
  function openPortraitCrop() {
    const d = state.data;
    if (!d || !d.meta.portrait) return;
    if (!window.FolPane || typeof FolPane.openCropEditor !== 'function') {
      if (typeof window.toast === 'function') window.toast('Crop editor unavailable');
      return;
    }
    const crop = d.meta.portraitCrop;
    /* Tell the editor the portrait's REAL frame aspect + identity baseline so
       reframing is WYSIWYG. The portrait square is not square (156x200 desktop,
       ~0.78) and centres its cover-fit; a square editor showing the raw source
       is why the popout never matched the thumbnail. Measure the live element so
       the narrow breakpoints (120x156, 110x143 — same ~0.77 aspect) self-correct;
       fall back to the desktop ratio when layout isn't measurable (jsdom). */
    const pel = $('ps-portrait');
    let aspect = 156 / 200;
    if (pel && pel.clientWidth > 0 && pel.clientHeight > 0) aspect = pel.clientWidth / pel.clientHeight;
    FolPane.openCropEditor({
      src: d.meta.portrait,
      crop: crop ? { z: crop.z, x: crop.x, y: crop.y } : null,
      name: d.name || 'Portrait',
      aspect: aspect,
      baseline: '50% 50%',   // .ps-portrait img cover-fit centres with no crop
      onSave: function (c) {
        /* c is {z,x,y} or null (reset). Store locally so the redraw is instant,
           then persist via the same meta path the profile fields use. */
        d.meta.portraitCrop = c ? { z: c.z, x: c.x, y: c.y } : null;
        renderPortrait(d);
        queueMeta({
          portraitZoom: c ? c.z : 1,
          portraitX: c ? c.x : 0,
          portraitY: c ? c.y : 0,
        });
        flushMeta();   // a crop is a deliberate action, not a keystroke — save now
        if (typeof window.toast === 'function') window.toast(c ? 'Framing saved' : 'Framing reset');
      },
    });
  }

  function renderVitals(d) {
    setBar('hp', d.hp);
    setBar('mag', d.mag);
    setBar('sta', d.sta);

    /* stat chips: carry / gold / dragon souls / bounty, + beast callout */
    const box = $('ps-chips');
    if (!box) return;
    const chips = [];
    const carryOver = d.carry.max > 0 && d.carry.cur > d.carry.max;
    chips.push(chip('carry' + (carryOver ? ' ps-over' : ''), '🎒', 'Carry',
      fmtInt(d.carry.cur) + ' / ' + fmtInt(d.carry.max),
      carryOver ? 'Over-encumbered' : 'Carry weight'));
    chips.push(chip('gold', '🪙', 'Gold', fmtInt(d.gold), 'Gold on hand'));
    chips.push(chip('souls', '🐉', 'Dragon Souls', fmtInt(d.souls.dragon), 'Unspent dragon souls'));
    if (d.bounty > 0)
      chips.push(chip('bounty', '⚔', 'Bounty', fmtInt(d.bounty), 'Active bounty on your head'));
    if (d.beast)
      chips.push(chip('beast', '🌙', 'Beast Form', d.beast, 'Your active beast/undead form'));
    box.innerHTML = chips.join('');
  }

  function chip(cls, ico, label, val, title) {
    return '<div class="ps-chip ps-chip-' + cls + '" title="' + esc(title) + '">' +
      '<span class="ps-chip-ico">' + ico + '</span>' +
      '<span class="ps-chip-body"><span class="ps-chip-label">' + esc(label) + '</span>' +
      '<span class="ps-chip-val">' + esc(val) + '</span></span></div>';
  }

  /* The strip to the right of the stat chips. When the DLL sends `slots`
     (equipped gear / active-content tiles) we fill it with real content; until
     then it shows deliberately-reserved placeholder tiles so the row reads as
     coming-soon rather than a broken empty gap. Sized on the same rhythm as the
     stat chips (see .ps-slot / .ps-slot-empty in the sheet). */
  const RESERVED_PLACEHOLDERS = [
    { icon: '⚔', label: 'Weapon' },
    { icon: '🛡', label: 'Shield' },
    { icon: '👑', label: 'Head' },
    { icon: '💍', label: 'Ring' },
  ];

  function renderReserved(d) {
    const box = provisionSlots();
    if (!box) return;
    const slots = (d && Array.isArray(d.slots)) ? d.slots : [];
    if (slots.length) {
      box.classList.remove('ps-slots-empty');
      box.innerHTML = slots.map(function (s) { return slotTile(s); }).join('');
      return;
    }
    /* placeholder mode */
    box.classList.add('ps-slots-empty');
    box.innerHTML = RESERVED_PLACEHOLDERS.map(function (p) {
      return '<div class="ps-slot ps-slot-empty" title="' + esc(p.label) +
        ' — coming soon">' +
        '<span class="ps-slot-ico" aria-hidden="true">' + p.icon + '</span>' +
        '<span class="ps-slot-body">' +
        '<span class="ps-slot-label">' + esc(p.label) + '</span>' +
        '<span class="ps-slot-val">—</span></span></div>';
    }).join('');
  }

  /* Provision the reserved-slots strip and pair it with the stat chips in a
     shared row so the strip fills the space that used to sit empty to the right
     of the small chips. Done in JS so index.html needs no edit; idempotent. */
  function provisionSlots() {
    let box = $('ps-slots');
    if (box) return box;
    const chips = $('ps-chips');
    if (!chips || !chips.parentNode) return null;
    const row = document.createElement('div');
    row.className = 'ps-statrow';
    chips.parentNode.insertBefore(row, chips);
    row.appendChild(chips);            // move chips into the row
    box = document.createElement('div');
    box.id = 'ps-slots';
    box.className = 'ps-slots ps-slots-empty';
    box.setAttribute('aria-label', 'Equipped and reserved tiles');
    row.appendChild(box);
    return box;
  }

  function slotTile(s) {
    const style = s.accent ? ' style="--ps-slot-accent:' + esc(s.accent) + '"' : '';
    const img = s.icon && s.icon.indexOf('/') !== -1
      ? '<img class="ps-slot-img" src="' + esc(s.icon) + '" alt="" ' +
        'onerror="this.style.display=\'none\'">'
      : '<span class="ps-slot-ico" aria-hidden="true">' + (esc(s.icon) || '◆') + '</span>';
    const title = [s.label, s.value, s.detail].filter(Boolean).join(' — ');
    return '<div class="ps-slot ps-slot-filled' + (s.kind ? ' ps-slot-' + esc(s.kind) : '') +
      '"' + style + ' title="' + esc(title) + '">' + img +
      '<span class="ps-slot-body">' +
      '<span class="ps-slot-label">' + esc(s.label || '') + '</span>' +
      '<span class="ps-slot-val">' + (esc(s.value) || '—') + '</span></span></div>';
  }

  function setBar(k, v) {
    const fill = $('ps-bar-' + k + '-fill');
    const nums = $('ps-bar-' + k + '-nums');
    if (fill) fill.style.width = clampPct(v.cur, v.max).toFixed(1) + '%';
    if (nums) nums.innerHTML = fmtInt(v.cur) +
      '<span class="ps-bar-max"> / ' + fmtInt(v.max) + '</span>';
  }

  function renderSkills(d) {
    const grid = $('ps-skills-grid');
    if (!grid) return;
    if (!d.skills.length) {
      grid.innerHTML = '<div class="ps-eff-empty" style="grid-column:1/-1">No skill data.</div>';
      grid._skillNames = null;
      return;
    }
    /* PATCH IN PLACE when the roster is unchanged (the ONLY thing that moves
       between polls is the level number). Replacing the whole grid's innerHTML
       on every 2 s poll is what let a poll landing mid-scroll jump/distort the
       numbers; touching only the changed level text nodes leaves the scrolled
       layout untouched. A full rebuild happens only when the skill SET itself
       changes (first paint, or a mod adding/removing a skill). */
    const names = d.skills.map(function (s) { return s.name; }).join('');
    if (grid._skillNames === names && grid.childNodes.length === d.skills.length) {
      const tiles = grid.childNodes;
      for (let i = 0; i < d.skills.length; i++) {
        const s = d.skills[i], tile = tiles[i];
        const lvl = tile && tile.querySelector('.ps-skill-lvl');
        const txt = String(s.level);
        if (lvl && lvl.textContent !== txt) lvl.textContent = txt;
        const title = s.name + ' — level ' + s.level;
        if (tile && tile.getAttribute('title') !== title) tile.setAttribute('title', title);
      }
      return;
    }
    grid.innerHTML = d.skills.map(function (s) {
      return '<div class="ps-skill" title="' + esc(s.name) + ' — level ' + s.level + '">' +
        '<span class="ps-skill-name">' + esc(s.name) + '</span>' +
        '<span class="ps-skill-lvl">' + s.level + '</span></div>';
    }).join('');
    grid._skillNames = names;
  }

  function renderInventory(d) {
    const grid = $('ps-inventory-grid');
    if (!grid) return;
    const inv = d.inventory || {}, p = inv.potions || {};
    /* [cardClass, label, count, icon, packCategory | null].
       The four potion cards carry a packCategory the modal fetches by (health /
       magicka / stamina / other); Lockpicks are not potions, so they open no
       modal. */
    const rows = [
      ['health', 'Health', p.health, 'icons/custom/ps-health.png', 'health'],
      ['magicka', 'Magicka', p.magicka, 'icons/custom/ps-magicka.png', 'magicka'],
      ['stamina', 'Stamina', p.stamina, 'icons/custom/ps-stamina.png', 'stamina'],
      ['utility', 'Other', p.other, 'icons/custom/ps-utility.png', 'other'],
      ['lockpicks', 'Lockpicks', inv.lockpicks, 'icons/custom/ps-lockpicks.png', null],
    ];
    grid.innerHTML = rows.map(function (r) {
      const cat = r[4];
      const clickable = !!cat && Number(r[2]) > 0;
      return '<div class="ps-inv ps-inv-' + r[0] +
        (cat ? ' ps-inv-pot' : '') + (clickable ? ' ps-inv-open' : '') +
        '"' + (cat ? ' data-cat="' + esc(cat) + '"' : '') +
        ' title="' + esc(r[1]) +
        (clickable ? ' — click to list every ' + esc(r[1].toLowerCase()) + ' potion you carry'
                   : (cat ? ' — none carried' : ' carried')) + '"' +
        (clickable ? ' tabindex="0" role="button"' : '') + '>' +
        '<img src="' + r[3] + '" alt=""><span class="ps-inv-body"><span class="ps-inv-name">' +
        esc(r[1]) + '</span><span class="ps-inv-count">' + fmtInt(r[2]) + '</span></span>' +
        (clickable ? '<span class="ps-inv-more" aria-hidden="true">⋯</span>' : '') +
        '</div>';
    }).join('');
    grid.querySelectorAll('.ps-inv-open').forEach(function (card) {
      const cat = card.getAttribute('data-cat');
      const open = function (ev) { ev.stopPropagation(); openPackModal(cat); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev); }
      });
    });
    const total = $('ps-potion-total');
    if (total) total.textContent = fmtInt(p.total) + ' potion' + (Number(p.total) === 1 ? '' : 's');
  }

  /* ---- Pack Check modal: every potion of one category --------------------- *
   * A chip click opens a centered overlay listing the player's potions of that
   * category (name, count, effect + magnitude). Data comes from C++ via
   * psPackList(cat) -> psPackListData(payload); the modal shows a skeleton until
   * it lands. Filter-as-you-type appears past 10 rows (Enter highlights the top
   * hit — the deck idiom). Esc / click-outside / ✕ close. Display-only: there is
   * no safe "drink from the sheet" bridge, so a row is not a drink button. */

  const pack = {
    open: false,
    cat: '',           // category being shown
    label: '',
    data: null,        // last psPackListData payload for this cat
    filter: '',
    loading: false,
  };

  const PACK_LABELS = { health: 'Health', magicka: 'Magicka', stamina: 'Stamina', other: 'Other' };

  function openPackModal(cat) {
    if (!cat) return;
    pack.open = true;
    pack.cat = cat;
    pack.label = PACK_LABELS[cat] || cat;
    pack.data = null;
    pack.filter = '';
    pack.loading = true;
    /* fresh render window + dead-path memory per open (packIconAsked persists so
       we don't re-ask C++ for a render already requested this session) */
    packLastLand = 0;
    Object.keys(packDeadArt).forEach(function (k) { delete packDeadArt[k]; });
    if (packWinT) { clearTimeout(packWinT); packWinT = null; }
    renderPackModal();
    toGame('psPackList', cat);
  }

  function closePackModal() {
    if (!pack.open) return;
    pack.open = false;
    pack.data = null;
    stopPackIconPoll();
    if (packWinT) { clearTimeout(packWinT); packWinT = null; }
    if (window.HDLightbox) HDLightbox.close();
    const ov = $('ps-pack-overlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  /* C++ reply: the per-category potion detail. Ignored if it's for a category we
     are no longer showing (a fast re-click), or the modal was closed. */
  window.psPackListData = function (payload) {
    let d = payload;
    if (typeof payload === 'string') { try { d = JSON.parse(payload); } catch (e) { d = null; } }
    if (!d || typeof d !== 'object') return;
    if (!pack.open || String(d.category || '') !== pack.cat) return;
    pack.data = {
      category: String(d.category || pack.cat),
      label: String(d.label || pack.label),
      ok: d.ok !== false,
      total: Number(d.total) || 0,
      items: Array.isArray(d.items) ? d.items.map(function (it) {
        it = (it && typeof it === 'object') ? it : {};
        return {
          name: String(it.name || 'Potion'),
          count: Number(it.count) || 0,
          magnitude: Number(it.magnitude) || 0,
          effect: String(it.effect || ''),
          formId: String(it.formId || ''),
          plugin: String(it.plugin || ''),
        };
      }) : [],
    };
    pack.loading = false;
    /* arm the render window the instant data lands (before the first paint) so a
       not-yet-landed identified row shimmers on that first paint instead of
       flashing as a blank plate. Only if a row can actually get a render. */
    if (packLastLand === 0 && pack.data.items.some(function (it) { return it.formId && it.plugin; })) {
      packLastLand = Date.now();
    }
    renderPackModal();
  };

  /* ---- mesh icons for the potion rows (Rober, 2026-08-14: "show mesh
     icons") — the Items tab's pipeline, scoped to the modal: resolve through
     WardrobePane's ONE icon index, ask C++ (whIcons) for rows with no art,
     and let the shared 'hd-item-icons' event upgrade the open modal IN PLACE
     as renders land. A row with no formId (dynamic potion, or a DLL from
     before row identity shipped) just keeps its glyph.

     Why in-place, not a full body rebuild (2026-08-13 play-test — rows never
     upgraded): 'hd-item-icons' fires on EVERY render batch anywhere in the
     deck (the wheel / wardrobe / items tab all share the one index + event),
     and the WardrobePane receiver only re-fires it when the index actually
     CHANGED. So the first push after the modal opens can arrive while the
     wardrobe index already held all its other keys — the potion keys land one
     by one on the per-render pushes, and a plate that was drawn as a glyph
     must gain its <img> the instant its own key resolves. Rebuilding the whole
     pack body on each event dropped the filter caret and read as flicker;
     hydrating only the plates whose art just resolved keeps scroll, focus and
     the un-resolved rows' glyphs intact — the items-pane idiom.

     BLANK-PLATE FIX (Rober, 2026-08-14 play-test — the rows drew as empty dark
     boxes): the previous build flagged a plate `.ps-has-art` (which hides the
     🧪 glyph via color:transparent) at BUILD time, the instant the index
     answered a path — before the <img> proved it could load. On this launch the
     epoch purge had DELETED the old item PNGs while a cached index path still
     named one, so the plate hid its glyph and then showed a broken/empty <img>
     that Ultralight never fired onerror for. Now the glyph-hide is LOAD-GATED:
     every plate renders as a visible glyph, an <img> is inserted programmatically
     (never via innerHTML) with load/error listeners, and `.ps-has-art` is added
     ONLY when `load` fires. A path that 404s falls back to the glyph; a render
     still in flight shows the glyph + a shimmer. A plate is never an empty box. */
  const packIconAsked = {};
  let packIconPollT = null, packIconPollN = 0;

  /* Render window (mirrors items-pane's chipLastLand / renderWindowActive): a
     row whose art is EXPECTED but not landed shimmers while renders are still
     plausibly in flight, then concedes to a plain glyph once they stop arriving
     — a potion that never gets a mesh must not shimmer forever. Armed when the
     modal opens (we ask C++ for renders) and kept fresh each time art lands. */
  const PACK_RENDER_IDLE_MS = 30000;   // no new art for this long => window shut
  let packLastLand = 0;                // ms of the last landed render seen
  let packWinT = null;                 // watchdog: repaint at window-close

  /* dead <img> paths already seen this modal-open — a plate whose src 404'd must
     not be re-hydrated with the same dead path on the next 'hd-item-icons'
     event (the index still names it), or it would flicker glyph->broken forever.
     Keyed by data-ikey. Cleared when the modal closes. */
  const packDeadArt = {};

  /* The icon-index key for a potion row: UPPERCASE hex | lowercase plugin, the
     exact normalisation WardrobePane.itemIconFor / KeyOf(C++) use. Doubles as
     the plate's data-ikey so an in-place upgrade can find every plate for a
     landed render regardless of the current filter/sort order. '' when the row
     has no durable identity (a plate that can only ever be a glyph). */
  function packIconKey(it) {
    if (!it || !it.formId || !it.plugin) return '';
    return String(it.formId).toUpperCase() + '|' + String(it.plugin).toLowerCase();
  }

  function packIconFor(it) {
    if (!it || !it.formId || !it.plugin) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      const path = WardrobePane.itemIconFor({ formId: it.formId, plugin: it.plugin }) || '';
      if (!path || path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
      return path;
    } catch (e) { return ''; }
  }

  /* A live path for a row, treating a path we already saw 404 as absent so a
     dead cached index entry never re-hides the glyph. '' when the row has no
     durable identity or no (still-good) render on disk. */
  function packLiveArt(it) {
    const key = packIconKey(it);
    if (key && packDeadArt[key]) return '';
    return packIconFor(it);
  }

  /* Is a render still plausibly in flight? Armed (packLastLand set when we asked
     C++), a land seen within the idle window, and at least one identified row
     still without its (good) art. Mirrors items-pane.renderWindowActive so the
     two loading languages agree. */
  function packRenderActive() {
    return packLastLand > 0 && packMissingArt() &&
      (Date.now() - packLastLand) < PACK_RENDER_IDLE_MS;
  }

  /* An identified row for which the index has NO path at all — a render C++ has
     not produced yet, so the thing that keeps the render window / poll alive.
     A row whose index path is DEAD (points at a purged file) is deliberately NOT
     counted: the index already answered for it, so waiting longer is pointless —
     it concedes to a plain glyph instead of shimmering / polling forever. Uses
     the RAW index (packIconFor), not the dead-masked packLiveArt. */
  function packMissingArt() {
    const d = pack.data;
    if (!d) return false;
    for (let i = 0; i < d.items.length; i++) {
      const it = d.items[i];
      if (it.formId && it.plugin && !packIconFor(it)) return true;
    }
    return false;
  }

  function requestPackIcons() {
    const d = pack.data;
    if (!d) return;
    /* arm the render window: from here a not-yet-landed identified row shimmers
       rather than reading as a final blank plate */
    if (packLastLand === 0) packLastLand = Date.now();
    const items = [];
    for (let i = 0; i < d.items.length; i++) {
      const it = d.items[i];
      if (!it.formId || !it.plugin) continue;
      const key = it.formId.toUpperCase() + '|' + it.plugin.toLowerCase();
      if (packIconAsked[key]) continue;
      if (packIconFor(it)) { packIconAsked[key] = 1; continue; }
      packIconAsked[key] = 1;
      items.push({ formId: it.formId, plugin: it.plugin, name: it.name });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
    startPackIconPoll();
    armPackWindowWatch();
  }

  /* renders land one by one; the batch-done push only fires when the whole
     queue drains — nudge the on-disk index every few seconds while the modal
     still shows glyphs (the Items tab's empty-whIcons idiom, bounded) */
  function stopPackIconPoll() {
    if (packIconPollT) { clearInterval(packIconPollT); packIconPollT = null; }
  }
  function startPackIconPoll() {
    stopPackIconPoll();
    packIconPollN = 0;
    if (!packMissingArt()) return;
    packIconPollT = setInterval(function () {
      if (!pack.open || !packMissingArt() || ++packIconPollN > 12) { stopPackIconPoll(); return; }
      toGame('whIcons', JSON.stringify({ items: [] }));
    }, 2500);
  }

  /* watchdog: when the render window closes (renders stopped arriving), repaint
     the plates once so any still-shimmering rows concede to a plain glyph — a
     potion that never gets a mesh must not shimmer forever. */
  function armPackWindowWatch() {
    if (packWinT) { clearTimeout(packWinT); packWinT = null; }
    if (!packRenderActive()) return;
    const left = Math.max(250, PACK_RENDER_IDLE_MS - (Date.now() - packLastLand) + 60);
    packWinT = setTimeout(function () {
      packWinT = null;
      if (pack.open) repaintPackShimmer();
    }, left);
  }

  /* A render batch landed somewhere in the deck (WardrobePane pushed a fresh
     index and fired the shared event). Hydrate the modal's plates IN PLACE —
     never a full body rebuild: a rebuild on every batch drops the filter caret
     and re-runs the whole list, which is why the rows never seemed to upgrade.
     We only touch the plates whose art JUST resolved, leaving scroll, focus and
     the un-resolved glyphs untouched, then re-arm the poll in case more of the
     batch is still in flight. Bounded to when the modal is actually open. */
  try {
    document.addEventListener('hd-item-icons', function () {
      if (!pack.open) return;
      const grew = hydratePackPlates();
      if (grew) packLastLand = Date.now();   // fresh land keeps the window open
      repaintPackShimmer();
      startPackIconPoll();
      armPackWindowWatch();
    });
  } catch (e) { /* no DOM in some harnesses */ }

  /* The plate's inner: ALWAYS just the 🧪 glyph. The <img> is NEVER put here as
     an HTML string — it is inserted programmatically by attachPackArt() so its
     load/error can be watched, and `.ps-has-art` (which hides the glyph) is set
     only once `load` actually fires. So the glyph is the honest state until real
     bytes decode, and the plate is never an empty box. */
  function packPlateInner() { return '🧪'; }

  /* Insert a load-gated render <img> into a plate. The plate keeps its glyph +
     shimmer WHILE the <img> decodes (so there is no static-glyph gap between
     attach and load); on `load` the glyph is hidden (.ps-has-art), the plate
     becomes zoomable and the shimmer stops; on `error` the <img> removes itself,
     the dead path is remembered so it is never retried, and the plate falls back
     to a plain glyph. Idempotent — a plate already carrying an <img> (loaded or
     still-pending) is left alone so we don't stack images or re-decode. */
  function attachPackArt(plate, url, it) {
    if (!plate || !url) return;
    if (plate.querySelector('img.ps-pack-art')) return;   // already has one
    const key = plate.getAttribute('data-ikey') || packIconKey(it);
    const img = document.createElement('img');
    img.className = 'ps-pack-art';
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', function () {
      plate.classList.add('ps-has-art', 'ps-zoomable');
      plate.classList.remove('ps-pack-loading');
      if (it) plate.title = it.name + ' — click for a bigger look';
    });
    img.addEventListener('error', function () {
      if (key) packDeadArt[key] = 1;   // never retry this dead path this open
      plate.classList.remove('ps-has-art', 'ps-zoomable');
      if (img.parentNode) img.parentNode.removeChild(img);
      /* concede to a plain glyph, or keep shimmering only if other renders are
         still genuinely in flight (repaintPackShimmer decides) */
      repaintPackShimmer();
    });
    /* keep the loading shimmer up through decode while the window is open */
    if (packRenderActive()) plate.classList.add('ps-pack-loading');
    plate.appendChild(img);
    img.src = url;   // set src AFTER wiring listeners so a cached hit still fires
  }

  /* For each identified plate with no <img> yet, ask the (now-updated) index and,
     if it answers a still-good path, attach a load-gated picture — no innerHTML
     churn on the body, no lost caret. Returns true if it attached at least one
     (a fresh land, worth keeping the window open for). Idempotent. */
  function hydratePackPlates() {
    const ov = $('ps-pack-overlay');
    if (!ov || !pack.data) return false;
    const byKey = {};
    pack.data.items.forEach(function (it) { const k = packIconKey(it); if (k) byKey[k] = it; });
    let attached = false;
    ov.querySelectorAll('.ps-pack-ico[data-ikey]').forEach(function (plate) {
      if (plate.querySelector('img.ps-pack-art')) return;   // already hydrated
      const key = plate.getAttribute('data-ikey');
      const it = key && byKey[key];
      if (!it) return;
      const art = packLiveArt(it);
      if (!art) return;
      attachPackArt(plate, art, it);
      attached = true;
    });
    return attached;
  }

  /* Repaint only the loading shimmer on each plate — an identified plate shimmers
     while a render is still plausibly in flight for it: either no path has landed
     yet, OR an <img> is attached but hasn't fired `load` (decoding). Everything
     else (landed=has-art, no identity, dead, or the window closed) does not.
     Never touches the <img>s, so it can't disturb a landed picture or the caret. */
  function repaintPackShimmer() {
    const ov = $('ps-pack-overlay');
    if (!ov || !pack.data) return;
    const active = packRenderActive();
    const byKey = {};
    pack.data.items.forEach(function (it) { const k = packIconKey(it); if (k) byKey[k] = it; });
    ov.querySelectorAll('.ps-pack-ico').forEach(function (plate) {
      if (plate.classList.contains('ps-has-art')) { plate.classList.remove('ps-pack-loading'); return; }
      const key = plate.getAttribute('data-ikey');
      const it = key && byKey[key];
      /* an attached-but-unloaded <img> is LOCALLY in flight (decoding) — shimmer
         regardless of the window; otherwise shimmer only while a render is still
         genuinely expected from C++ (identified, window active, no index path yet
         — a dead path has an entry so it is NOT expected and concedes to glyph). */
      const imgPending = !!plate.querySelector('img.ps-pack-art');
      const loading = !!it && (imgPending || (active && !packIconFor(it)));
      plate.classList.toggle('ps-pack-loading', loading);
    });
  }

  /* the ONE pack-row template — renderPackModal and repaintPackBody must
     paint identical rows or a filter keystroke would drop the icon plates.
     data-idx resolves the clicked row against the CURRENT (filtered) order;
     data-ikey is the stable icon-index key hydration targets. The plate is
     built as a GLYPH ONLY (no build-time .ps-has-art, no inline <img>); the
     hydratePackPlates() post-pass in renderPackModal / repaintPackBody attaches
     the load-gated picture. A shimmer marks an identified row whose render is
     still expected. */
  function packRowHtml(it, i) {
    const meta = [];
    if (it.effect) meta.push(esc(it.effect));
    if (it.magnitude) meta.push(fmtInt(it.magnitude) + ' pts');
    const metaHtml = meta.length ? '<div class="ps-pack-sub">' + meta.join(' <span class="ps-pack-dot">·</span> ') + '</div>' : '';
    const ikey = packIconKey(it);
    /* shimmer at build only for an identified row still genuinely awaiting a
       render (window active, no index path — raw, so a known-dead path doesn't
       shimmer). hydratePackPlates + repaintPackShimmer reconcile right after. */
    const loading = !!ikey && packRenderActive() && !packIconFor(it);
    const plate = '<div class="ps-pack-ico' + (loading ? ' ps-pack-loading' : '') +
      '" data-idx="' + i + '"' + (ikey ? ' data-ikey="' + esc(ikey) + '"' : '') + '>' +
      packPlateInner() + '</div>';
    return '<div class="ps-pack-row' + (i === 0 && pack.filter ? ' ps-pack-top' : '') + '">' + plate +
      '<div class="ps-pack-main"><div class="ps-pack-name">' + esc(it.name) + '</div>' + metaHtml + '</div>' +
      '<div class="ps-pack-count">×' + fmtInt(it.count) + '</div></div>';
  }

  /* click a rendered plate -> the shared big view (Items-tab lightbox), with
     the turntable siblings offered as probe candidates */
  function openPackLightbox(it) {
    const url = packIconFor(it);
    if (!url || !window.HDLightbox) return;
    const bits = [];
    if (it.effect) bits.push(it.effect);
    if (it.magnitude) bits.push(fmtInt(it.magnitude) + ' pts');
    bits.push('×' + fmtInt(it.count) + ' in your pack');
    HDLightbox.open({
      host: $('ps-pane'),
      src: url,
      glyph: '🧪',
      title: it.name,
      sub: bits.join(' · '),
      frames: ['-a090', '-a180', '-a270'].map(function (sfx) { return url.replace(/\.png$/, sfx + '.png'); }),
    });
  }

  function packVisibleItems() {
    if (!pack.data) return [];
    const n = pack.filter.toLowerCase();
    let list = pack.data.items;
    if (n) list = list.filter(function (it) {
      return it.name.toLowerCase().indexOf(n) !== -1 ||
             it.effect.toLowerCase().indexOf(n) !== -1;
    });
    /* highest count first (your biggest stack is usually what you came for),
       then alphabetical — the C++ sends alphabetical, this stabilises on count */
    return list.slice().sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
  }

  function renderPackModal() {
    let ov = $('ps-pack-overlay');
    if (!pack.open) { if (ov && ov.parentNode) ov.parentNode.removeChild(ov); return; }
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ps-pack-overlay';
      ov.className = 'ps-pack-overlay';
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) closePackModal(); });
      ov.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); closePackModal(); }
      });
      (($('ps-pane')) || document.body).appendChild(ov);
    }

    const d = pack.data;
    const items = packVisibleItems();
    const showFilter = d && d.items.length > 10;
    const countLabel = d
      ? (d.total + ' potion' + (d.total === 1 ? '' : 's') +
         (d.items.length ? ' · ' + d.items.length + ' kind' + (d.items.length === 1 ? '' : 's') : ''))
      : '';

    let body;
    if (pack.loading && !d) {
      body = new Array(4).fill(
        '<div class="ps-pack-row ps-pack-skel">' +
        '<span class="ps-skel-box" style="width:170px;height:15px;display:block"></span>' +
        '<span class="ps-skel-box" style="width:44px;height:15px;display:block"></span></div>').join('');
    } else if (!d || !d.ok) {
      body = '<div class="ps-pack-empty">Could not read your inventory. Try again in a moment.</div>';
    } else if (!d.items.length) {
      body = '<div class="ps-pack-empty"><b>No ' + esc(pack.label.toLowerCase()) +
        ' potions.</b><br>Nothing in this category is in your pack right now.</div>';
    } else if (!items.length) {
      body = '<div class="ps-pack-empty">Nothing matches “' + esc(pack.filter) + '”.</div>';
    } else {
      body = items.map(packRowHtml).join('');
    }

    ov.innerHTML =
      '<div class="ps-pack-card ps-pack-' + esc(pack.cat) + '" role="dialog" aria-modal="true" aria-label="' +
        esc(pack.label) + ' potions">' +
        '<div class="ps-pack-head">' +
          '<div class="ps-pack-title"><span class="ps-pack-dot-ico"></span>' + esc(pack.label) +
            ' Potions <span class="ps-pack-sub-count">' + esc(countLabel) + '</span></div>' +
          '<button class="ps-pack-x" type="button" title="Close (Esc)" aria-label="Close">✕</button>' +
        '</div>' +
        (showFilter
          ? '<input id="ps-pack-filter" class="ps-pack-filter" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Filter potions — name or effect (Enter = top hit)">'
          : '') +
        '<div class="ps-pack-body">' + body + '</div>' +
      '</div>';

    ov.querySelector('.ps-pack-x').addEventListener('click', function (e) { e.stopPropagation(); closePackModal(); });
    const bodyHost = ov.querySelector('.ps-pack-body');
    if (bodyHost) bodyHost.addEventListener('click', function (e) {
      const plate = e.target.closest('.ps-pack-ico.ps-has-art');
      if (!plate) return;
      e.stopPropagation();
      const it = packVisibleItems()[Number(plate.getAttribute('data-idx'))];
      if (it) openPackLightbox(it);
    });
    requestPackIcons();
    /* attach load-gated <img>s for renders already on disk, then reconcile the
       shimmer so the freshly-built glyph plates read as loading where a render
       is still expected — a plate is never a bare blank box. */
    hydratePackPlates();
    repaintPackShimmer();
    armPackWindowWatch();

    const f = $('ps-pack-filter');
    if (f) {
      f.value = pack.filter;
      f.addEventListener('input', function () { pack.filter = f.value.trim(); repaintPackBody(); });
      f.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const top = packVisibleItems()[0];
          if (top) {
            const row = ov.querySelector('.ps-pack-body .ps-pack-row');
            if (row) { row.classList.add('ps-pack-flash'); setTimeout(function () { row.classList.remove('ps-pack-flash'); }, 600); }
          }
        }
        if (e.key === 'Escape') { if (f.value) { f.value = ''; pack.filter = ''; repaintPackBody(); } else closePackModal(); }
      });
      /* focus the filter so a keyboard user can type immediately */
      try { f.focus(); } catch (e) {}
    }
  }

  /* Repaint only the body + count on a filter keystroke, so the input keeps
     focus and the caret doesn't jump (the effect-search idiom). */
  function repaintPackBody() {
    const ov = $('ps-pack-overlay');
    if (!ov || !pack.data) return;
    const d = pack.data;
    const items = packVisibleItems();
    const bodyEl = ov.querySelector('.ps-pack-body');
    if (!bodyEl) return;
    if (!items.length) {
      bodyEl.innerHTML = '<div class="ps-pack-empty">Nothing matches “' + esc(pack.filter) + '”.</div>';
      return;
    }
    bodyEl.innerHTML = items.map(packRowHtml).join('');
    requestPackIcons();
    /* re-attach load-gated art to the rebuilt (filtered) plates + reconcile the
       shimmer, same as the full render — a filtered view's plates are never
       blank boxes either. */
    hydratePackPlates();
    repaintPackShimmer();
  }

  function renderEffects() {
    const d = state.data;
    const body = $('ps-eff-body');
    const chip = $('ps-eff-count');
    if (!body) return;

    if (chip && d) {
      const harm = d.effects.filter(function (e) { return e.harmful; }).length;
      chip.textContent = d.effects.length
        ? (d.effects.length + ' effect' + (d.effects.length === 1 ? '' : 's') +
           (harm ? ' · ' + harm + ' harmful' : ''))
        : '';
      chip.classList.toggle('ps-eff-harm', harm > 0);
    }

    const list = visibleEffects();
    if (!list.length) {
      body.innerHTML = '<div class="ps-eff-empty">' +
        (d && d.effects.length
          ? 'Nothing matches “' + esc(ui.filter) + '”.'
          : '<b>No active effects.</b><br>Spells, diseases and enchantments you\'re under will show here.') +
        '</div>';
      return;
    }

    body.innerHTML = list.map(function (e) {
      const remain = liveRemain(e);
      const perm = e.durSec <= 0 && e.remainSec <= 0;
      const timeHtml = perm
        ? '<span class="ps-eff-time ps-eff-perm" data-key="' + esc(e.key) + '">permanent</span>'
        : '<span class="ps-eff-time" data-key="' + esc(e.key) + '">' +
          (remain > 0 ? fmtDur(remain) + ' left' : 'expiring') + '</span>';
      const magHtml = e.magnitude
        ? '<span class="ps-eff-mag">' + fmtInt(e.magnitude) + '</span>' : '';
      const sub = [e.source, e.plugin].filter(Boolean);
      const subHtml = sub.length
        ? '<div class="ps-eff-sub">' + esc(e.source || '') +
          (e.plugin ? ' <span class="ps-eff-plugin">· ' + esc(e.plugin) + '</span>' : '') + '</div>'
        : '';
      const armed = !!ui.armed[e.key];
      const risky = e.removeMode === 'confirm';
      const btn = e.wantsRemove
        ? '<button class="ps-eff-rm' + (risky ? ' ps-eff-risk' : '') + (armed ? ' ps-armed' : '') +
          '" data-key="' + esc(e.key) + '" title="' + (risky
            ? 'Permanent ability — removable, but it may be a mod controller'
            : 'Remove this effect') + '">' +
          (armed ? (risky ? 'Remove anyway?' : 'Remove?') : (risky ? '◆' : '✕')) + '</button>'
        : '<span class="ps-eff-lock" title="Inherited from your race — protected from removal">🔒</span>';
      return '<div class="ps-eff' + (e.harmful ? ' ps-eff-harm-row' : '') + '">' +
        '<div class="ps-eff-main"><div class="ps-eff-name">' + esc(e.name) + '</div>' +
        subHtml + '</div>' +
        '<div class="ps-eff-meta">' + magHtml + timeHtml + '</div>' +
        btn + '</div>';
    }).join('');

    body.querySelectorAll('.ps-eff-rm').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const key = b.getAttribute('data-key');
        if (!ui.armed[key]) { ui.armed[key] = true; renderEffects(); return; }
        delete ui.armed[key];
        const effect = state.data.effects.find(function (e) { return e.key === key; });
        toGame('psRemoveEffect', JSON.stringify({ key: key, force: !!(effect && effect.removeMode === 'confirm') }));
      });
    });
  }

  /* live countdown — patch only the time nodes, no full re-render (keeps the
     armed-remove state and doesn't fight the effect filter's focus). */
  function tick() {
    if (!ui.visible || !state.data) return;
    const nodes = document.querySelectorAll('#ps-eff-body .ps-eff-time:not(.ps-eff-perm)');
    if (!nodes.length) return;
    const byKey = {};
    state.data.effects.forEach(function (e) { byKey[e.key] = e; });
    nodes.forEach(function (n) {
      const e = byKey[n.getAttribute('data-key')];
      if (!e) return;
      const r = liveRemain(e);
      n.textContent = r > 0 ? fmtDur(r) + ' left' : 'expiring';
    });
  }

  function renderStory(d) {
    const bg = $('ps-background');
    if (bg && document.activeElement !== bg) bg.value = d.meta.background || '';
    const hs = $('ps-history');
    if (hs && document.activeElement !== hs) hs.value = d.meta.history || '';
  }

  /* ============================================================ meta save == */

  /* debounce + coalesce partial meta edits, flush on tab hide — the app.js
     saveSoon/flushSave idiom, kept local so the pane owns its own field set. */
  function queueMeta(subset) {
    Object.keys(subset).forEach(function (k) { ui.savePend[k] = subset[k]; });
    if (ui.saveT) clearTimeout(ui.saveT);
    ui.saveT = setTimeout(flushMeta, SAVE_DEBOUNCE);
  }
  function flushMeta() {
    if (ui.saveT) { clearTimeout(ui.saveT); ui.saveT = null; }
    if (!Object.keys(ui.savePend).length) return;
    const payload = ui.savePend;
    ui.savePend = {};
    /* keep local state in step so a poll-driven psData mid-typing doesn't clobber */
    if (state.data) {
      Object.keys(payload).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(state.data.meta, k)) state.data.meta[k] = payload[k];
      });
    }
    toGame('psSetMeta', JSON.stringify(payload));
    flashSaved();
  }
  let savedT = null;
  function flashSaved() {
    const s = $('ps-story-saved');
    if (!s) return;
    s.classList.add('ps-show');
    if (savedT) clearTimeout(savedT);
    savedT = setTimeout(function () { s.classList.remove('ps-show'); }, 1400);
  }

  /* ============================================================ lifecycle == */

  function startPoll() {
    stopPoll();
    ui.pollT = setInterval(function () {
      if (ui.visible) toGame('psGet', '');
    }, POLL_MS);
    ui.tickT = setInterval(tick, TICK_MS);
  }
  function stopPoll() {
    if (ui.pollT) { clearInterval(ui.pollT); ui.pollT = null; }
    if (ui.tickT) { clearInterval(ui.tickT); ui.tickT = null; }
  }

  function onShow() {
    ui.visible = true;
    if (!state.loaded) renderSkeleton();
    else render();
    toGame('psGet', '');
    startPoll();
    const f = $('ps-eff-filter');
    if (f) f.value = ui.filter;
  }

  function onHide() {
    ui.visible = false;
    closePackModal();   // a tab switch must not leave the potion modal hanging
    stopPoll();
    if (ui.scrollT) { clearTimeout(ui.scrollT); ui.scrollT = null; }
    ui.scrolling = false;
    ui.deferred = false;
    flushMeta();   // never lose an in-flight edit to a tab switch
  }

  /* A scroll is "in flight" from the first scroll event until SCROLL_IDLE_MS
     after the last one. While it is, poll snapshots are held (see psData). When
     it settles, flush the newest held snapshot with one clean render — the
     layout is stationary, so nothing jumps. */
  function onScrollActivity() {
    ui.scrolling = true;
    if (ui.scrollT) clearTimeout(ui.scrollT);
    ui.scrollT = setTimeout(function () {
      ui.scrolling = false;
      ui.scrollT = null;
      if (ui.deferred && ui.visible && state.data) {
        ui.deferred = false;
        render();
      }
    }, SCROLL_IDLE_MS);
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni focus-jump: land on the tab with an effect spotlighted */
  function setFilter(text) {
    ui.filter = String(text || '');
    const f = $('ps-eff-filter');
    if (f) f.value = ui.filter;
    if (ui.visible) renderEffects();
  }

  function init() {
    /* Hold poll-driven rebuilds while the sheet is being scrolled — the fix for
       the skill-number jitter. Passive: we only observe, never preventDefault. */
    const pane = $('ps-pane');
    if (pane) pane.addEventListener('scroll', onScrollActivity, { passive: true });
    const effBody = $('ps-eff-body');
    if (effBody) effBody.addEventListener('scroll', onScrollActivity, { passive: true });

    const cls = $('ps-class-input');
    if (cls) {
      cls.addEventListener('input', function () { queueMeta({ charClass: cls.value }); });
      cls.addEventListener('blur', flushMeta);
      cls.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { cls.blur(); e.preventDefault(); }
        e.stopPropagation();
      });
    }
    [
      ['ps-alignment-input', 'alignment'], ['ps-title-input', 'title'],
      ['ps-eyes-input', 'eyeColor'], ['ps-height-input', 'height'],
      ['ps-age-input', 'age'], ['ps-homeland-input', 'homeland'],
      ['ps-deity-input', 'deity'],
    ].forEach(function (pair) {
      const n = $(pair[0]), key = pair[1];
      if (!n) return;
      n.addEventListener('input', function () { const patch = {}; patch[key] = n.value; queueMeta(patch); });
      n.addEventListener('blur', flushMeta);
      n.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { n.blur(); e.preventDefault(); }
        e.stopPropagation();
      });
    });
    const f = $('ps-eff-filter');
    if (f) {
      f.addEventListener('input', function () { ui.filter = f.value.trim(); renderEffects(); });
      f.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          /* Enter = arm the top hit's remove (the deck's top-hit idiom, here
             the actionable thing is "get rid of this one") */
          const top = visibleEffects()[0];
          if (top && top.wantsRemove) { ui.armed[top.key] = true; renderEffects(); }
          e.stopPropagation();
        }
        if (e.key === 'Escape' && f.value) { f.value = ''; ui.filter = ''; renderEffects(); e.stopPropagation(); }
      });
    }
    const bg = $('ps-background');
    if (bg) {
      bg.addEventListener('input', function () { queueMeta({ background: bg.value }); });
      bg.addEventListener('blur', flushMeta);
    }
    const hs = $('ps-history');
    if (hs) {
      hs.addEventListener('input', function () { queueMeta({ history: hs.value }); });
      hs.addEventListener('blur', flushMeta);
    }
    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  function devData() {
    window.psData({
      name: 'Aldren', race: 'Nord', raceEditorId: 'NordRace', level: 62,
      hp: { cur: 540, max: 720 }, mag: { cur: 210, max: 300 }, sta: { cur: 300, max: 300 },
      carry: { cur: 412, max: 380 }, gold: 128450, souls: { dragon: 7 }, bounty: 1000,
      beast: 'Vampire Lord',
      inventory: { potions: { health: 14, magicka: 8, stamina: 11, other: 6, total: 39 }, lockpicks: 27 },
      skills: [
        { name: 'One-Handed', level: 100 }, { name: 'Two-Handed', level: 42 },
        { name: 'Archery', level: 70 }, { name: 'Block', level: 55 },
        { name: 'Smithing', level: 100 }, { name: 'Heavy Armor', level: 88 },
        { name: 'Light Armor', level: 30 }, { name: 'Pickpocket', level: 25 },
        { name: 'Lockpicking', level: 40 }, { name: 'Sneak', level: 62 },
        { name: 'Alchemy', level: 90 }, { name: 'Speech', level: 78 },
        { name: 'Alteration', level: 45 }, { name: 'Conjuration', level: 66 },
        { name: 'Destruction', level: 80 }, { name: 'Illusion', level: 33 },
        { name: 'Restoration', level: 72 }, { name: 'Enchanting', level: 100 },
      ],
      effects: [
        { key: 'A1', id: 0, name: 'Ataxia', source: 'Disease', plugin: 'Skyrim.esm', magnitude: 0, durSec: 0, remainSec: 0, harmful: true, wantsRemove: true, removeMode: 'safe' },
        { key: 'A2', id: 0, name: 'Blessing of Talos', source: 'Shrine Blessing', plugin: 'Skyrim.esm', magnitude: 20, durSec: 28800, remainSec: 14230, harmful: false, wantsRemove: true, removeMode: 'safe' },
        { key: 'A3', id: 3, name: 'Well Rested', source: 'Sleep', plugin: 'Skyrim.esm', magnitude: 10, durSec: 28800, remainSec: 620, harmful: false, wantsRemove: true, removeMode: 'safe' },
        { key: 'A4', id: 4, name: 'Vampire Controller', source: 'Vampire Lord', plugin: 'Dawnguard.esm', magnitude: 15, durSec: 0, remainSec: 0, harmful: false, wantsRemove: true, removeMode: 'confirm' },
        { key: 'A5', id: 5, name: 'Fortify Smithing', source: 'Blacksmith Potion', plugin: 'Skyrim.esm', magnitude: 32, durSec: 30, remainSec: 12, harmful: false, wantsRemove: true, removeMode: 'safe' },
        { key: 'A6', id: 6, name: 'Highborn', source: 'Racial', plugin: 'Skyrim.esm', magnitude: 0, durSec: 0, remainSec: 0, harmful: false, wantsRemove: false, removeMode: 'locked' },
      ],
      meta: {
        charClass: 'Blood Knight',
        alignment: 'Lawful Evil', title: 'The Ashen King', eyeColor: 'Ember gold',
        height: '6′ 2″', age: '38', homeland: 'The Reach', deity: 'Molag Bal',
        background: 'Born under a red moon in the reach…',
        history: 'Broke the siege of Morthal and claimed the old watchtower.',
        portrait: '',
      },
    });
  }

  function devRemove(arg) {
    let key = '';
    try { key = String(JSON.parse(arg).key); } catch (e) {}
    if (state.data) state.data.effects = state.data.effects.filter(function (e) { return e.key !== key; });
    window.psResult({ ok: true, msg: '' });
    if (ui.visible) renderEffects();
  }

  /* DEV fixture for the pack modal: a plausible per-category potion list so the
     harness (and ?dev=1 preview) exercise the modal without the game. */
  function devPackList(cat) {
    cat = String(cat || 'health').replace(/["\s]/g, '');
    const seed = {
      health: [
        { name: 'Potion of Ultimate Healing', count: 3, magnitude: 200, effect: 'Restore Health' },
        { name: 'Potion of Healing', count: 12, magnitude: 50, effect: 'Restore Health' },
        { name: 'Potion of Minor Healing', count: 7, magnitude: 25, effect: 'Restore Health' },
        { name: 'Blood Potion', count: 1, magnitude: 100, effect: 'Restore Health' },
      ],
      magicka: [
        { name: 'Potion of Magicka', count: 8, magnitude: 50, effect: 'Restore Magicka' },
        { name: 'Potion of Plentiful Magicka', count: 2, magnitude: 100, effect: 'Restore Magicka' },
      ],
      stamina: [
        { name: 'Potion of Stamina', count: 11, magnitude: 50, effect: 'Restore Stamina' },
      ],
      other: [
        { name: 'Elixir of the Knight', count: 2, magnitude: 60, effect: 'Fortify Block' },
        { name: 'Philter of Waterbreathing', count: 4, magnitude: 0, effect: 'Waterbreathing' },
      ],
    };
    const items = seed[cat] || [];
    const total = items.reduce(function (n, it) { return n + it.count; }, 0);
    window.psPackListData({
      category: cat, label: (PACK_LABELS[cat] || cat), ok: true, total: total, items: items,
    });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }
    devData();
    ui.visible = true; render();
    ok('name shown', $('ps-name').textContent === 'Aldren');
    ok('level shown', $('ps-level-num').textContent === '62');
    ok('hp bar over 50%', parseFloat($('ps-bar-hp-fill').style.width) > 50);
    ok('carry over-flag', document.querySelector('.ps-chip-carry.ps-over'));
    ok('bounty chip present', !!document.querySelector('.ps-chip-bounty'));
    ok('beast chip present', !!document.querySelector('.ps-chip-beast'));
    ok('skills rendered', document.querySelectorAll('.ps-skill').length === 18);
    ok('pack check rendered', document.querySelectorAll('.ps-inv').length === 5);
    ok('profile filled', $('ps-alignment-input').value === 'Lawful Evil');
    ok('effects rendered', document.querySelectorAll('#ps-eff-body .ps-eff').length === 6);
    ok('harmful sorted first', document.querySelector('#ps-eff-body .ps-eff').classList.contains('ps-eff-harm-row'));
    ok('only racial effect shows lock', document.querySelectorAll('.ps-eff-lock').length === 1);
    ok('controller effect shows caution', document.querySelectorAll('.ps-eff-risk').length === 1);
    ui.filter = 'ataxia'; renderEffects();
    ok('filter narrows', document.querySelectorAll('#ps-eff-body .ps-eff').length === 1);
    ui.filter = ''; renderEffects();
    const fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
  }

  /* ---- Omni search provider ------------------------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'charsheet', label: 'Character', tab: 'sheet',
    setFilter: setFilter,
    index: function () {
      const d = state.data;
      const items = [];
      if (d) {
        d.effects.forEach(function (e) {
          items.push({
            label: (e.wantsRemove ? 'Remove ' : '') + e.name,
            detail: 'Active effect' + (e.source ? ' · ' + e.source : '') + (e.harmful ? ' · harmful' : ''),
            kind: 'effect',
            keywords: 'effect magic remove dispel ' + e.name + ' ' + e.source + ' ' + e.plugin,
            filter: e.name,
          });
        });
      }
      items.push({ label: 'Character Sheet', kind: 'tab',
        detail: 'Your stats, effects, class and story',
        keywords: 'character sheet level hp magicka stamina class race background history skills' });
      return items;
    },
  });

  return {
    init: init, onShow: onShow, onHide: onHide, toggleEdit: toggleEdit,
    wantsPause: wantsPause, setFilter: setFilter, _emptyPortrait: emptyPortrait,
    _state: state, _ui: ui, _visibleEffects: visibleEffects, _normalize: normalize,
    _fmtDur: fmtDur, _clampPct: clampPct, _normCrop: normCrop,
    _renderPortrait: renderPortrait, _onScroll: onScrollActivity,
    _pack: pack, _openPackModal: openPackModal, _closePackModal: closePackModal,
    _packVisibleItems: packVisibleItems,
    /* pack-render test hooks: drive the load-gated art flow deterministically
       under jsdom (which fires no real <img> load/error). */
    _packRenderActive: packRenderActive,
    _hydratePackPlates: hydratePackPlates,
    _repaintPackShimmer: repaintPackShimmer,
    _packWindow: function (ms) {
      if (ms !== undefined) packLastLand = ms;
      return packLastLand;
    },
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.CharSheetPane.init(); });
} else {
  window.CharSheetPane.init();
}
