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
  };

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
    if (ui.visible) render();
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
          potions = v(inventory.potions);
    return {
      name: String(d.name || ''),
      race: String(d.race || ''),
      raceEditorId: String(d.raceEditorId || ''),
      level: num(d.level),
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
      },
    };
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
    const port = $('ps-portrait');
    if (port) {
      if (d.meta.portrait) {
        port.className = 'ps-portrait';
        port.innerHTML = '<img src="' + esc(d.meta.portrait) + '" alt="portrait" ' +
          'onerror="this.parentNode.className=\'ps-portrait ps-portrait-empty\';' +
          'this.parentNode.innerHTML=CharSheetPane._emptyPortrait()">';
      } else {
        port.className = 'ps-portrait ps-portrait-empty';
        port.innerHTML = emptyPortrait();
      }
    }
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
  }

  function setProfileInput(id, value) {
    const n = $(id);
    if (n && document.activeElement !== n) n.value = value || '';
  }

  function emptyPortrait() {
    return '<div class="ps-portrait-hint"><div class="ps-portrait-glyph">🖼</div>' +
      '<div class="ps-portrait-cap">Add a portrait from the Deck Portal, ' +
      'or capture one in the CHIM tab</div></div>';
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
      return;
    }
    grid.innerHTML = d.skills.map(function (s) {
      return '<div class="ps-skill" title="' + esc(s.name) + ' — level ' + s.level + '">' +
        '<span class="ps-skill-name">' + esc(s.name) + '</span>' +
        '<span class="ps-skill-lvl">' + s.level + '</span></div>';
    }).join('');
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
    flushMeta();   // never lose an in-flight edit to a tab switch
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
    _fmtDur: fmtDur, _clampPct: clampPct,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.CharSheetPane.init(); });
} else {
  window.CharSheetPane.init();
}
