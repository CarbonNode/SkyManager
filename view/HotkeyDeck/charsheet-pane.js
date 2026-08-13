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

    /* progress-to-next-level: only when the DLL actually sent XP. Otherwise the
       card shows a decorative divider + "next" hint, never a fake bar. The
       progress elements are provisioned by JS (index.html only carries the cap
       + number), so the card gains the treatment with no index.html edit. */
    const card = levelCard();
    if (!card) return;
    const foot = provisionLevelExtras(card);
    const lp = d.levelProgress || {};
    const fill = $('ps-level-fill');
    const track = $('ps-level-track');
    card.classList.toggle('ps-level-has-xp', !!lp.has);
    if (fill) fill.style.width = (lp.has ? lp.pct : 0).toFixed(1) + '%';
    if (track) track.title = lp.has
      ? (fmtInt(lp.cur) + ' / ' + fmtInt(lp.next) + ' XP to level ' + ((d.level || 0) + 1))
      : 'Experience to the next level';
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

  /* Add the progress track + foot line to the Level card once. Keeping this in
     JS means the visual integration ships without touching index.html. */
  function provisionLevelExtras(card) {
    let foot = $('ps-level-foot');
    if (foot) return foot;
    const track = document.createElement('div');
    track.id = 'ps-level-track';
    track.className = 'ps-level-track';
    track.innerHTML = '<div id="ps-level-fill" class="ps-level-fill"></div>';
    foot = document.createElement('div');
    foot.id = 'ps-level-foot';
    foot.className = 'ps-level-foot';
    card.appendChild(track);
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

  function applyPortraitCrop(img, crop) {
    if (!img) return;
    if (!crop) { img.style.transform = ''; img.style.objectPosition = ''; return; }
    img.style.transformOrigin = '50% 50%';
    img.style.transform = 'translate(' + (crop.x * 100).toFixed(3) + '%,' +
      (crop.y * 100).toFixed(3) + '%) scale(' + crop.z.toFixed(4) + ')';
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
    b.title = 'Photograph your character in-game (switches to third person if needed)';
    b.textContent = capturePending ? '… hold still' : label;
    b.disabled = capturePending;
    b.addEventListener('click', function (e) { e.stopPropagation(); takePortrait(); });
    return b;
  }

  function takePortrait() {
    if (capturePending) return;
    capturePending = true;
    /* repaint the button into its pending state immediately */
    if (state.data && ui.visible) renderPortrait(state.data);
    if (typeof window.toast === 'function') window.toast('Taking your portrait…');
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
    FolPane.openCropEditor({
      src: d.meta.portrait,
      crop: crop ? { z: crop.z, x: crop.x, y: crop.y } : null,
      name: d.name || 'Portrait',
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
    const rows = [
      ['health', 'Health', p.health, 'icons/custom/ps-health.png'],
      ['magicka', 'Magicka', p.magicka, 'icons/custom/ps-magicka.png'],
      ['stamina', 'Stamina', p.stamina, 'icons/custom/ps-stamina.png'],
      ['utility', 'Other', p.other, 'icons/custom/ps-utility.png'],
      ['lockpicks', 'Lockpicks', inv.lockpicks, 'icons/custom/ps-lockpicks.png'],
    ];
    grid.innerHTML = rows.map(function (r) {
      return '<div class="ps-inv ps-inv-' + r[0] + '" title="' + esc(r[1]) + ' carried">' +
        '<img src="' + r[3] + '" alt=""><span class="ps-inv-body"><span class="ps-inv-name">' +
        esc(r[1]) + '</span><span class="ps-inv-count">' + fmtInt(r[2]) + '</span></span></div>';
    }).join('');
    const total = $('ps-potion-total');
    if (total) total.textContent = fmtInt(p.total) + ' potion' + (Number(p.total) === 1 ? '' : 's');
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
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.CharSheetPane.init(); });
} else {
  window.CharSheetPane.init();
}
