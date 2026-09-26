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
    /* Active-effect pile filter (2026-08-17): '' = all, else a GROUPS id.
       Session-only on purpose — you narrow to Debuffs to strip one, and next
       time you open the tab you want to see everything again. */
    group: '',
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
      if (DEV && fn === 'psTuneGet') setTimeout(devTuneData, 30);
      if (DEV && fn === 'psTuneSet') setTimeout(function () { devTuneSet(arg); }, 30);
    }
  }

  /* Tune dev fixtures — a compact but shape-complete character. */
  const DEV_TUNE = {
    ok: true, level: 52, perkPoints: 3, dragonSouls: 14,
    attrs: [
      { key: 'health', label: 'Health', base: 420 },
      { key: 'magicka', label: 'Magicka', base: 250 },
      { key: 'stamina', label: 'Stamina', base: 310 },
      { key: 'carryweight', label: 'Carry weight', base: 300 },
      { key: 'speedmult', label: 'Speed %', base: 100 },
      { key: 'unarmed', label: 'Unarmed damage', base: 12 },
    ],
    regen: [
      { key: 'healrate', label: 'Health regen', base: 0.7 },
      { key: 'magickarate', label: 'Magicka regen', base: 3 },
      { key: 'staminarate', label: 'Stamina regen', base: 5 },
    ],
    resists: [
      { key: 'resistfire', label: 'Fire', base: 20 },
      { key: 'resistfrost', label: 'Frost', base: 50 },
      { key: 'resistshock', label: 'Shock', base: 0 },
      { key: 'resistmagic', label: 'Magic', base: 10 },
      { key: 'resistpoison', label: 'Poison', base: 100 },
      { key: 'resistdisease', label: 'Disease', base: 100 },
    ],
    skills: [
      { key: 'onehanded', label: 'One-Handed', base: 87 },
      { key: 'sneak', label: 'Sneak', base: 64 },
      { key: 'destruction', label: 'Destruction', base: 71 },
      { key: 'restoration', label: 'Restoration', base: 55 },
    ],
  };

  function devTuneData() { window.psTuneData(JSON.parse(JSON.stringify(DEV_TUNE))); }

  function devTuneSet(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const set = req.set || {};
    ['attrs', 'regen', 'resists', 'skills'].forEach(function (g) {
      DEV_TUNE[g].forEach(function (f) { if (set[f.key] !== undefined) f.base = set[f.key]; });
    });
    if (set.perkPoints !== undefined) DEV_TUNE.perkPoints = set.perkPoints;
    if (set.dragonSouls !== undefined) DEV_TUNE.dragonSouls = set.dragonSouls;
    const out = JSON.parse(JSON.stringify(DEV_TUNE));
    out.msg = 'Changed - lives in your save from here on';
    window.psTuneResult(out);
  }

  window.psData = function (d) {
    if (!d || typeof d !== 'object') return;
    state.data = normalize(d);
    state.loaded = true;
    state.recvAt = Date.now();
    /* Other surfaces borrow the player's portrait from here (the Scene
       page's cast strip). They cannot know when this lands, so say so —
       the hd-portrait-crops-changed idiom, one event, no coupling. */
    try { window.dispatchEvent(new CustomEvent('hd-charsheet-data')); } catch (e) {}
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
        /* Consumable cards (2026-08-15): poison/food/drink/water counts, plus
           waterOk so the Water card can hide when no water mod is present. */
        consumables: (function () {
          const c = v(inventory.consumables);
          return { poison: num(c.poison), food: num(c.food),
                   drink: num(c.drink), water: num(c.water) };
        })(),
        waterOk: inventory.waterOk !== false,
        lockpicks: num(inventory.lockpicks),
      },
      skills: Array.isArray(d.skills) ? d.skills.map(function (s) {
        s = v(s); return { name: String(s.name || ''), level: num(s.level) };
      }) : [],
      effects: Array.isArray(d.effects) ? d.effects.map(function (e) {
        e = v(e);
        const dur = num(e.durSec), harm = !!e.harmful;
        return {
          id: (e.id === undefined || e.id === null) ? '' : String(e.id),
          key: String(e.key || ('id:' + String(e.id == null ? '' : e.id))),
          name: String(e.name || 'Effect'),
          source: String(e.source || ''),
          plugin: String(e.plugin || ''),
          magnitude: num(e.magnitude),
          durSec: dur,
          remainSec: num(e.remainSec),
          harmful: harm,
          /* Grouping (2026-08-17). C++ decides it off the source record's spell
             type; a pre-1.12 DLL sends nothing, and rather than drop the whole
             card back to a flat list we derive the same five buckets from the
             two fields every build has ever sent. GROUPS below is the order. */
          group: GROUP_IDS.indexOf(String(e.group || '')) !== -1 ? String(e.group)
                 : (harm ? 'debuff' : (dur > 0 ? 'buff' : 'constant')),
          sourceKind: String(e.sourceKind || ''),
          av: String(e.av || ''),
          hidden: !!e.hidden,
          wantsRemove: e.wantsRemove !== false,   // default removable
          removeMode: e.removeMode === 'locked' ? 'locked' :
            (e.removeMode === 'confirm' ? 'confirm' : (e.wantsRemove === false ? 'locked' : 'safe')),
        };
      }) : [],
      /* ---- 2026-08-17 blocks: regen · resistances · combat · worn gear ----
         Every one is OPTIONAL. A deck view is routinely newer than the DLL
         beside it (staged deploys, an old archive), so each block carries a
         `has` / emptiness test and the card that draws it is simply absent when
         the numbers are not there — never a card full of zeroes, which reads as
         "your fire resist is 0" rather than "this build cannot tell you". */
      regen: (function () {
        const r = v(d.regen);
        return { has: !!r.has, hp: num(r.hp), mag: num(r.mag), sta: num(r.sta),
                 inCombat: !!r.inCombat };
      })(),
      resist: (function () {
        const r = v(d.resist);
        return {
          has: d.resist !== undefined && d.resist !== null,
          armor: num(r.armor), phys: num(r.phys),
          fire: num(r.fire), frost: num(r.frost), shock: num(r.shock),
          magic: num(r.magic), poison: num(r.poison), disease: num(r.disease),
          pieces: num(r.pieces),
          /* Caps ride the payload: magic tops out at 85 in vanilla, physical
             reduction at 80. Drawing either against 100 would make a capped
             character look short of the cap they are actually sitting on. */
          capMagic: num(r.capMagic) || 85,
          capPhys: num(r.capPhys) || 80,
        };
      })(),
      combat: (function () {
        const c = v(d.combat);
        return {
          has: d.combat !== undefined && d.combat !== null,
          damage: num(c.damage), speed: num(c.speed), reach: num(c.reach),
          move: num(c.move), perks: num(c.perks), unarmed: !!c.unarmed,
        };
      })(),
      equip: Array.isArray(d.equip) ? d.equip.map(function (s) {
        s = v(s);
        const has = function (k) { return s[k] !== undefined && s[k] !== null; };
        return {
          slot: String(s.slot || ''),
          label: String(s.label || ''),
          kind: String(s.kind || 'empty'),
          name: String(s.name || ''),
          formId: String(s.formId || ''),
          plugin: String(s.plugin || ''),
          /* null, not 0 — an unarmoured slot has NO rating, and "0" beside a
             bare hand is a claim the engine never made. */
          armor: has('armor') ? num(s.armor) : null,
          damage: has('damage') ? num(s.damage) : null,
          damageEstimated: !!s.damageEstimated,
          count: has('count') ? num(s.count) : null,
          speed: has('speed') ? num(s.speed) : null,
          reach: has('reach') ? num(s.reach) : null,
          ranged: !!s.ranged,
          badges: Array.isArray(s.badges) ? s.badges.slice(0, 3).map(function (b) {
            b = v(b);
            return { text: String(b.text || ''), av: String(b.av || '') };
          }).filter(function (b) { return !!b.text; }) : [],
        };
      }) : [],
      /* Faith (Wintersun). Every number is optional on purpose: char_sheet.cpp
         omits a threshold / drain it could not read rather than sending a zero,
         and the card must then draw one fewer line, never a bar against 0. */
      faith: (function () {
        const f = v(d.faith);
        const has = function (k) { return f[k] !== undefined && f[k] !== null; };
        return {
          present: !!f.present,
          active: !!f.active,
          deity: String(f.deity || ''),
          pantheon: String(f.pantheon || ''),
          favor: num(f.favor),
          threshold: has('threshold') ? num(f.threshold) : 0,
          target: has('target') ? num(f.target) : 0,
          favored: !!f.favored,
          raceFavored: !!f.raceFavored,
          raceMult: num(f.raceMult),
          drainPerDay: has('drainPerDay') ? num(f.drainPerDay) : 0,
          prayerGain: has('prayerGain') ? num(f.prayerGain) : 0,
          /* Losing your god at 0 favour is Wintersun's default; its MCM can turn
             that off, and then the bottom of the meter is merely the bottom. */
          apostasy: f.apostasy !== false,
          entries: Array.isArray(f.entries) ? f.entries.map(function (e) {
            e = v(e);
            return {
              slot: String(e.slot || ''),
              label: String(e.label || ''),
              name: String(e.name || ''),
              text: String(e.text || ''),
              /* tri-state: true / false / null = "the DLL did not say", which is
                 the honest answer for a blessing you cast at an altar. */
              have: (e.have === undefined || e.have === null) ? null : !!e.have,
              note: String(e.note || ''),
            };
          }) : [],
          prayer: (f.prayer && typeof f.prayer === 'object')
            ? { name: String(f.prayer.name || ''),
                have: (f.prayer.have === undefined || f.prayer.have === null) ? null : !!f.prayer.have }
            : null,
        };
      })(),
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

  /* ================================================== 2026-08-17 tables == *
   * Rober, after seeing Skyrim Party Sheet: "the visuals of this is super
   * nice… we could grab a lot of the features. and improve our visuals —
   * active effects", then "look at the equipment has +20, damage and count for
   * arrows, a red number for swords, +x on trinkets", with the standing rule
   * "do not obviously copy… but can take all the inspiration and flare".
   * So: their IDEAS (grouped effects, badge-per-piece, a resistance panel,
   * regen under the bars), our LOOK — the deck's antique gold, dark plates and
   * existing tokens throughout. */

  /* Effect piles, in the order they are drawn. Debuffs first because that is
     what you opened this card to deal with; `constant` last because a modded
     save carries scores of permanent controller abilities and they would
     otherwise bury the twelve rows that actually change. */
  const GROUPS = [
    { id: 'debuff',   label: 'Debuffs',  hint: 'Working against you right now' },
    { id: 'disease',  label: 'Diseases', hint: 'Cure at a shrine, or with a potion' },
    { id: 'poison',   label: 'Poisons',  hint: 'Applied to you, or wearing off' },
    { id: 'buff',     label: 'Buffs',    hint: 'Timed help — potions, blessings, spells' },
    { id: 'constant', label: 'Constant', hint: 'Permanent abilities and mod controllers' },
  ];
  const GROUP_IDS = GROUPS.map(function (g) { return g.id; });

  /* The vanilla guardian-stone families. NOT the reference's grouping — it puts
     Archery under Thief and Light Armor under Warrior; Skyrim's own Warrior /
     Thief / Mage stones do the opposite, and the stones are the thing a player
     recognises. Six each, eighteen total. */
  const SKILL_GROUPS = [
    { id: 'warrior', label: 'Warrior', names: ['One-Handed', 'Two-Handed', 'Archery', 'Block', 'Smithing', 'Heavy Armor'] },
    { id: 'thief',   label: 'Thief',   names: ['Light Armor', 'Sneak', 'Lockpicking', 'Pickpocket', 'Speech', 'Alchemy'] },
    { id: 'mage',    label: 'Mage',    names: ['Alteration', 'Conjuration', 'Destruction', 'Illusion', 'Restoration', 'Enchanting'] },
  ];

  /* Resistance rows: [key, label, cap-key|number, glyph, art].
     `cap` is what a FULL meter means for that stat — magic caps at 85 and
     physical reduction at 80 in vanilla, and both ship in the payload so a
     capped character reads as capped instead of as 85% of the way there.
     Armour is the raw rating and has no cap, so it draws no meter at all. */
  /* The last column is the ICON FILE STEM, not a class name — resistRow()
     builds `icons/custom/<stem>.png` from it and the row's class comes from the
     key beside it. It said `ps-res-fire` until 2026-08-17, and the art actually
     shipped that day is `res-fire.png`, so all six <img>s 404'd and every
     resist row drew an empty 26px hole in game (found by the Ultralight probe;
     the emoji in column four is only the onerror fallback and never appeared). */
  const RESIST_ROWS = [
    ['fire',    'Fire',    100,  '🔥', 'res-fire'],
    ['frost',   'Frost',   100,  '❄',  'res-frost'],
    ['shock',   'Shock',   100,  '⚡', 'res-shock'],
    ['magic',   'Magic',   'capMagic', '✦', 'res-magic'],
    ['poison',  'Poison',  100,  '☠',  'res-poison'],
    ['disease', 'Disease', 100,  '🜏',  'res-disease'],
  ];

  /* Equipment tiles, in draw order, with the glyph an EMPTY slot wears. The
     order is fixed and the C++ always sends all nine, so swapping gear can
     never make the grid reflow under the cursor. */
  const GEAR_GLYPH = {
    head: '⛑', body: '🛡', hands: '🧤', feet: '🥾', amulet: '📿', ring: '💍',
    right: '⚔', left: '🗡', ammo: '➶',
  };

  /* A rate, in points per second. One decimal below 10 (the difference between
     2.1/s and 2/s is the whole point of showing it), whole numbers above. */
  function fmtRate(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    const body = a < 10 ? (Math.round(a * 10) / 10).toFixed(1) : fmtInt(Math.round(a));
    return (n < 0 ? '−' : '+') + body;
  }
  /* A percentage that may be fractional. Skyrim's resist values are floats; a
     21.2% damage resist is not 21%. Trailing ".0" is dropped. */
  function fmtPct(n) {
    n = Number(n) || 0;
    const r = Math.round(n * 10) / 10;
    return (Math.round(r) === r ? String(Math.round(r)) : r.toFixed(1)) + '%';
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
    renderGear(d);      // 2026-08-17: the real equipment grid
    renderSos();        // 2026-09-21: SOS size, the player's own slider
    renderBattle(d);    // 2026-08-17: stat block + resistances
    renderFaith(d);
    renderSkills(d);
    renderInventory(d);
    renderEffects();
    renderStory(d);
  }

  function renderSkeleton() {
    const root = $('ps-pane');
    if (root) root.classList.add('ps-loading');
    /* Drop the signatures the 2026-08-17 cards patch against. They are a
       promise that "what is on screen already matches this data" — and a
       skeleton has just broken that promise, so a snapshot identical to the
       last one would otherwise skip its rebuild and leave the placeholder up. */
    gear.sig = '';
    const battle = $('ps-battle');
    if (battle) battle._sig = '';
    const body = $('ps-eff-body');
    if (body) body._sig = '';
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
    b.title = 'Arm the shot, then press Enter in-game to capture (switches to third person if needed)';
    b.textContent = capturePending ? '⌛ press Enter in-game' : label;
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
    if (typeof window.toast === 'function') window.toast('Portrait armed — line up your shot, then press Enter');
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
    const rg = d.regen || { has: false };
    setBar('hp', d.hp, rg.has ? rg.hp : null, rg.inCombat);
    setBar('mag', d.mag, rg.has ? rg.mag : null, false);
    setBar('sta', d.sta, rg.has ? rg.sta : null, false);

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
      box.classList.remove('hidden', 'ps-slots-empty');
      box.innerHTML = slots.map(function (s) { return slotTile(s); }).join('');
      return;
    }
    /* 2026-08-17: the placeholder tiles were an explicit promise of an
       equipment strip. That promise is KEPT now, by the real #ps-gear card
       below — so the coming-soon row retires rather than sitting above the
       thing it was standing in for. It still draws if a DLL ever sends the
       `slots` contract, which is a different (arbitrary tile) feature. */
    if (d && d.equip && d.equip.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    /* placeholder mode */
    box.classList.remove('hidden');
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

  function setBar(k, v, rate, inCombat) {
    const fill = $('ps-bar-' + k + '-fill');
    const nums = $('ps-bar-' + k + '-nums');
    if (fill) fill.style.width = clampPct(v.cur, v.max).toFixed(1) + '%';
    if (nums) nums.innerHTML = fmtInt(v.cur) +
      '<span class="ps-bar-max"> / ' + fmtInt(v.max) + '</span>';

    /* Regen rate under the track (2026-08-17). Provisioned here rather than in
       index.html — the pane already provisions its own extras (see
       provisionSlots) and index.html is shared with three other panes' agents.
       Text is written IN PLACE on every poll; the node is built once. */
    const track = fill && fill.parentNode;
    if (!track || !track.parentNode) return;
    let line = $('ps-bar-' + k + '-rate');
    if (rate === null || rate === undefined) {
      /* No honest number available (a DLL that does not send `regen`). Say
         nothing at all — an empty or zeroed rate line would read as "you do
         not regenerate", which is a different and wrong claim. */
      if (line) line.classList.add('hidden');
      return;
    }
    if (!line) {
      line = document.createElement('div');
      line.id = 'ps-bar-' + k + '-rate';
      line.className = 'ps-bar-rate';
      track.parentNode.appendChild(line);
    }
    line.classList.remove('hidden');
    const txt = fmtRate(rate) + '/s';
    if (line.firstChild && line.firstChild.textContent === txt) {
      /* unchanged — leave the node completely alone (Ultralight repaints the
         whole line otherwise, and this runs every 2 s) */
    } else {
      line.textContent = '';
      const b = document.createElement('b');
      b.textContent = txt;
      line.appendChild(b);
    }
    line.classList.toggle('ps-rate-down', Number(rate) < 0);
    /* The engine applies a further combat penalty to HEALTH regeneration out of
       a game setting we cannot read, so the figure is labelled rather than
       silently wrong. Magicka and Stamina carry no such penalty. */
    line.title = k === 'hp'
      ? (inCombat
          ? 'Out-of-combat health regeneration. In combat the game applies its own further penalty on top of this.'
          : 'Health regenerated per second, out of combat.')
      : (k === 'mag' ? 'Magicka regenerated per second.' : 'Stamina regenerated per second, while not sprinting.');
    line.classList.toggle('ps-rate-caveat', k === 'hp' && !!inCombat);
  }

  /* ============================================== 2026-08-17 · equipment == *
   * Rober: "look at the equipment has +20, damage and count for arrows, a red
   * number for swords, +x on trinkets and things." So every worn piece carries
   * its own numbers: armour rating on armour, damage in the warm red on
   * weapons, the quiver count on ammo, and the enchantment's magnitude as a
   * gold badge. Nine tiles, always — the C++ sends an empty tile for an empty
   * slot so the grid cannot reflow while you are looking at it.
   *
   * Art rides the deck's EXISTING render route and no other: ask the icon index
   * through WardrobePane.itemIconFor, queue misses through the Wheel's whIcons,
   * upgrade in place on the shared 'hd-item-icons' event. A form with no world
   * model (an amulet with no mesh, a spell) keeps its glyph BY DESIGN. */

  const gear = {
    asked: {},        // ikey -> 1, so a render is requested at most once a session
    dead: {},         // ikey -> 1, an <img> path that already 404'd
    lastLand: 0,      // when we last armed / saw a render land
    pollT: null,
    pollN: 0,
    settleT: null,
    sig: '',          // last DRAWN tile signature (see renderGear)
  };
  const GEAR_RENDER_IDLE_MS = 9000;

  function gearKey(s) {
    if (!s || !s.formId || !s.plugin) return '';
    return String(s.formId).toUpperCase() + '|' + String(s.plugin).toLowerCase();
  }
  function gearArtFor(s) {
    if (!s || !s.formId || !s.plugin) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      const path = WardrobePane.itemIconFor({ formId: s.formId, plugin: s.plugin }) || '';
      if (!path || path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
      return path;
    } catch (e) { return ''; }
  }
  function gearLiveArt(s) {
    const k = gearKey(s);
    if (k && gear.dead[k]) return '';
    return gearArtFor(s);
  }
  function gearMissingArt() {
    const list = (state.data && state.data.equip) || [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.formId && s.plugin && !gearArtFor(s)) return true;
    }
    return false;
  }

  /* The settle gate, copied in SPIRIT from the Items tab: never queue renders
     off a render pass, only once the content has stopped changing. Gear changes
     when you swap a sword, not per keystroke, but the 2 s poll would otherwise
     re-arm the poll timer forever. */
  function armGearIcons() {
    if (gear.settleT) clearTimeout(gear.settleT);
    gear.settleT = setTimeout(function () {
      gear.settleT = null;
      requestGearIcons();
    }, 400);
  }

  function requestGearIcons() {
    const list = (state.data && state.data.equip) || [];
    if (!list.length) return;
    if (gear.lastLand === 0) gear.lastLand = Date.now();
    const items = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const k = gearKey(s);
      if (!k || gear.asked[k]) continue;
      gear.asked[k] = 1;
      if (gearArtFor(s)) continue;      // already on disk
      items.push({ formId: s.formId, plugin: s.plugin, name: s.name });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
    startGearPoll();
  }

  /* Renders land one at a time and the batch-done push only fires when the
     WHOLE queue drains — so nudge the on-disk index while tiles still show a
     glyph. An EMPTY whIcons queues nothing; it just makes C++ answer with the
     current index. Bounded: a piece with no world model never lands, and an
     unbounded poll would run for the whole session. */
  function stopGearPoll() {
    if (gear.pollT) { clearInterval(gear.pollT); gear.pollT = null; }
  }
  function startGearPoll() {
    stopGearPoll();
    gear.pollN = 0;
    if (!gearMissingArt()) return;
    gear.pollT = setInterval(function () {
      if (!ui.visible || !gearMissingArt() || ++gear.pollN > 10) { stopGearPoll(); return; }
      toGame('whIcons', JSON.stringify({ items: [] }));
    }, 2500);
  }

  /* Attach a load-gated render to one plate: the glyph stays until real bytes
     decode, a dead path is remembered so it is never retried, and nothing here
     ever rebuilds the grid (a rebuild on every landed render is what made the
     Items tab look like it was never upgrading). */
  function attachGearArt(plate, url, s) {
    if (!plate || !url) return;
    if (plate.querySelector('img.ps-gear-art')) return;
    const key = plate.getAttribute('data-ikey') || gearKey(s);
    const img = document.createElement('img');
    img.className = 'ps-gear-art';
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', function () { plate.classList.add('ps-has-art'); });
    img.addEventListener('error', function () {
      if (key) gear.dead[key] = 1;
      plate.classList.remove('ps-has-art');
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    plate.appendChild(img);
    img.src = url;   // src AFTER the listeners, so a cached hit still fires load
  }

  function hydrateGearPlates() {
    const card = $('ps-gear');
    if (!card || !state.data) return false;
    const byKey = {};
    state.data.equip.forEach(function (s) { const k = gearKey(s); if (k) byKey[k] = s; });
    let attached = false;
    card.querySelectorAll('.ps-gear-plate[data-ikey]').forEach(function (plate) {
      if (plate.querySelector('img.ps-gear-art')) return;
      const s = byKey[plate.getAttribute('data-ikey')];
      if (!s) return;
      const art = gearLiveArt(s);
      if (!art) return;
      attachGearArt(plate, art, s);
      attached = true;
    });
    return attached;
  }

  try {
    document.addEventListener('hd-item-icons', function () {
      if (!ui.visible) return;
      if (hydrateGearPlates()) gear.lastLand = Date.now();
      startGearPoll();
    });
  } catch (e) { /* no DOM in some harnesses */ }

  /* One badge cluster. `+20` / `25%` in gold; the AV name only as a tooltip,
     because a tile that spells "Fortify Two-Handed" is a tile you cannot read
     at a glance — which is the whole complaint the redesign answers. */
  function gearBadges(s, extra) {
    extra = extra || '';
    if (!s.badges.length && !extra) return '';
    return '<span class="ps-gear-badges">' + extra + s.badges.map(function (b) {
      return '<span class="ps-gear-badge" title="' +
        esc(b.av ? b.av + ' ' + b.text : 'Enchanted — ' + b.text) + '">' +
        esc(b.text) + '</span>';
    }).join('') + '</span>';
  }

  /* The number a tile leads with: armour rating (cool), damage (the reference's
     warm red — and Rober asked for it by name), or an ammo count. */
  function gearFigure(s) {
    if (s.damage !== null && s.damage > 0) {
      return '<span class="ps-gear-fig ps-gear-dmg" title="' +
        esc(s.damageEstimated
          ? 'Estimated attack damage — the engine could not be asked directly for this hand'
          : 'Attack damage, as the engine calculates it: skill, fortify effects and temper included') +
        '">' + fmtInt(s.damage) + '</span>';
    }
    if (s.armor !== null && s.armor > 0) {
      return '<span class="ps-gear-fig ps-gear-arm" title="Armour rating of this piece">' +
        fmtInt(s.armor) + '</span>';
    }
    return '';
  }

  /* The quiver count. It used to sit on the plate opposite the damage figure,
     which was fine until the overlap pass tried 3,421 arrows and the two
     numbers ran into each other on an 84px plate. It lives in the badge row
     now, where it can be as wide as it likes and wraps like everything else. */
  function gearCountChip(s) {
    if (s.count === null) return '';
    return '<span class="ps-gear-badge ps-gear-qty" title="How many you are carrying">×' +
      fmtInt(s.count) + '</span>';
  }

  function gearTile(s) {
    const ikey = gearKey(s);
    const empty = !s.name;
    const glyph = GEAR_GLYPH[s.slot] || '◆';
    const bits = [s.label];
    if (s.name) bits.push(s.name);
    if (s.armor !== null) bits.push(fmtInt(s.armor) + ' armour');
    if (s.damage !== null) bits.push(fmtInt(s.damage) + ' damage');
    if (s.speed) bits.push('speed ' + (Math.round(s.speed * 100) / 100));
    if (s.reach) bits.push('reach ' + (Math.round(s.reach * 100) / 100));
    if (s.count !== null) bits.push(fmtInt(s.count) + ' left');
    s.badges.forEach(function (b) { bits.push((b.av ? b.av + ' ' : '') + b.text); });

    /* The figure sits on the plate's bottom edge, so a plate that HAS one gives
       the glyph a shorter box to centre in. Without this the two collided at
       the deck's 640px floor, where the plate is 64px (2026-08-17 overlap
       pass). A class, not :has() — Ultralight's support for that is unproven. */
    const fig = gearFigure(s);
    return '<div class="ps-gear-tile ps-gear-' + esc(s.slot) +
      (empty ? ' ps-gear-none' : '') + ' ps-gear-k-' + esc(s.kind) +
      '" title="' + esc(bits.join(' · ')) + '">' +
      '<div class="ps-gear-plate' + (fig ? ' ps-plate-fig' : '') + '"' +
        (ikey ? ' data-ikey="' + esc(ikey) + '"' : '') + '>' +
        '<span class="ps-gear-glyph" aria-hidden="true">' + glyph + '</span>' + fig +
      '</div>' +
      '<div class="ps-gear-name">' + (empty ? '—' : esc(s.name)) + '</div>' +
      '<div class="ps-gear-slot">' + esc(s.label) + '</div>' +
      gearBadges(s, gearCountChip(s)) +
    '</div>';
  }

  /* Provision the card once. index.html is deliberately not touched — three
     other agents are in that file today, and this pane already provisions its
     own extras (provisionSlots). Idempotent. */
  function provisionCard(id, cls, label, afterSel) {
    let el = $(id);
    if (el) return el;
    const pane = $('ps-pane');
    const anchor = pane && pane.querySelector(afterSel);
    if (!pane || !anchor) return null;
    el = document.createElement('div');
    el.id = id;
    el.className = cls;
    el.setAttribute('aria-label', label);
    if (anchor.nextSibling) pane.insertBefore(el, anchor.nextSibling);
    else pane.appendChild(el);
    return el;
  }

  /* ---------------------------------------------------------- SOS size ----
     Rober, 2026-09-21: "add a schlong (SOS) slider to characters tab".

     The engine work already existed — SosActions::SizeStateJson / SetActorSize,
     built for the OStim scene tools — but only reachable through the SCENE
     bridge (osTools + a live scene signature), so the Character tab could not
     ask. It now goes through hdSosSize, which is scene-free.

     ⚠ The card REPORTS rather than assumes. SOS's own setup quest skips PLAYER
     bone scaling whenever its SOSRaceMenu flag is set — SetSize still returns
     true and still moves the faction rank, so a slider that just drew itself
     would appear to work and change nothing. SizeStateJson already decides
     this; when it says `available:false` the card shows its reason instead of
     a control that lies. Absent SOS entirely and the card is not drawn at all,
     rather than sitting there empty on a deck that has no SOS. */
  var sos = { data: null, asked: false, busy: false };

  function sosAsk(op, extra) {
    if (typeof window.toGame !== 'function') return;
    var msg = { op: op, who: 'player' };
    if (extra) for (var k in extra) msg[k] = extra[k];
    window.toGame('hdSosSize', JSON.stringify(msg));
  }

  /* One reply channel for every asker (the card and the palette rows), so the
     card only claims a payload that is about the PLAYER. */
  window.hdSosSizeData = function (payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || d.who !== 'player') {
      /* A palette row aimed at the crosshair NPC. The card must not repaint
         from it, but the press still has to say what happened — silence after
         a button is the failure mode this deck keeps fixing. */
      if (d && d.msg && typeof window.toast === 'function') window.toast(d.msg);
      return;
    }
    sos.data = d;
    sos.busy = false;
    renderSos();
    try { window.dispatchEvent(new CustomEvent('hd-sos-size', { detail: d })); } catch (e) {}
  };

  /* Used by the palette rows. `who` is 'player' or 'crosshair'; the DELTA is
     resolved against the live size in C++ (op:"step"), so two presses in a row
     cannot both read the same stale base. */
  function sosStep(who, delta) {
    if (typeof window.toGame !== 'function') return;
    window.toGame('hdSosSize', JSON.stringify({ op: 'step', who: who, size: delta }));
  }

  function sosSet(n) {
    if (!sos.data || !sos.data.available || sos.busy) return;
    var lo = Number(sos.data.min) || 1, hi = Number(sos.data.max) || 20;
    var v = Math.max(lo, Math.min(hi, Math.round(n)));
    if (v === Number(sos.data.size)) return;
    sos.busy = true;
    renderSos();
    sosAsk('set', { size: v });
  }

  function renderSos() {
    if (!sos.asked) { sos.asked = true; sosAsk('state'); }
    var d = sos.data;
    /* No answer yet, or no SOS in the load order: draw nothing. A card that
       says "reading…" forever on a deck without SOS is worse than no card. */
    if (!d || d.present === false) {
      var gone = $('ps-sos');
      if (gone) { gone.classList.add('hidden'); gone.innerHTML = ''; }
      return;
    }
    /* Anchor after the gear card when it exists, else after vitals. provisionCard
       returns null if its anchor is missing, and .ps-gear is itself provisioned
       — so a reply that lands before renderGear has run (the palette rows can
       trigger exactly that) would otherwise silently draw nothing. .ps-vitals is
       in the static markup and always there. */
    var card = provisionCard('ps-sos', 'ps-card ps-sos', 'SOS size', '.ps-gear') ||
               provisionCard('ps-sos', 'ps-card ps-sos', 'SOS size', '.ps-vitals');
    if (!card) return;
    card.classList.remove('hidden');

    var lo = Number(d.min) || 1, hi = Number(d.max) || 20;
    var n = Number(d.size);
    var have = d.available && Number.isFinite(n);
    var pct = have ? Math.round(((n - lo) / (hi - lo)) * 100) : 0;

    var head = '<div class="ps-card-h"><span class="ps-card-t">Schlongs of Skyrim</span>' +
      '<span class="ps-sos-val">' + (have ? ('Size <b>' + n + '</b> / ' + hi) : '—') + '</span></div>';

    if (!have) {
      card.innerHTML = head + '<div class="ps-sos-off">' + esc(d.msg || 'SOS cannot size you right now') + '</div>';
      return;
    }

    var steps = '';
    for (var i = 0; i < 5; i++) {
      var v = [1, 5, 10, 15, 20][i];
      steps += '<button class="ps-sos-preset' + (v === n ? ' on' : '') + '" data-sos="' + v + '">' + v + '</button>';
    }
    card.innerHTML = head +
      '<div class="ps-sos-row">' +
        '<button class="ps-sos-step" data-sos-step="-1" ' + (n <= lo ? 'disabled' : '') +
          ' title="One size smaller">−</button>' +
        '<div class="ps-sos-track" role="slider" tabindex="0" aria-label="SOS size"' +
          ' aria-valuemin="' + lo + '" aria-valuemax="' + hi + '" aria-valuenow="' + n + '">' +
          '<div class="ps-sos-fill" style="width:' + pct + '%"></div>' +
        '</div>' +
        '<button class="ps-sos-step" data-sos-step="1" ' + (n >= hi ? 'disabled' : '') +
          ' title="One size larger">+</button>' +
      '</div>' +
      '<div class="ps-sos-presets">' + steps + '</div>' +
      '<div class="ps-sos-note">' + (sos.busy ? 'Applying…' :
        'Through SOS\u2019s own SetSize, so the change sticks after you close the deck.') + '</div>';
  }

  /* Delegated, because the card is rebuilt on every reply. */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest('#ps-sos')) return;
    var preset = t.closest('[data-sos]');
    if (preset) { e.stopPropagation(); sosSet(Number(preset.getAttribute('data-sos'))); return; }
    var step = t.closest('[data-sos-step]');
    if (step && !step.disabled) {
      e.stopPropagation();
      sosSet((Number(sos.data && sos.data.size) || 0) + Number(step.getAttribute('data-sos-step')));
      return;
    }
    var track = t.closest('.ps-sos-track');
    if (track && sos.data && sos.data.available) {
      e.stopPropagation();
      var r = track.getBoundingClientRect();
      if (!r.width) return;
      var lo2 = Number(sos.data.min) || 1, hi2 = Number(sos.data.max) || 20;
      sosSet(lo2 + ((e.clientX - r.left) / r.width) * (hi2 - lo2));
    }
  }, true);

  function renderGear(d) {
    const card = provisionCard('ps-gear', 'ps-card ps-gear', 'Worn equipment', '.ps-vitals');
    if (!card) return;
    const list = d.equip || [];
    if (!list.length) {
      /* Nothing sent at all = an older DLL. Drop the card entirely rather than
         show nine empty slots, which would read as "you are naked". */
      card.classList.add('hidden');
      card.innerHTML = '';
      gear.sig = '';
      return;
    }
    card.classList.remove('hidden');

    /* Redraw only when something actually CHANGED (the pane repolls every 2 s
       and a full innerHTML rebuild under a scroll is what made the skill
       numbers jump — same lesson, same fix). The signature covers everything
       the tiles draw; art is attached separately and survives, because a
       rebuild re-runs hydrateGearPlates below. */
    const sig = list.map(function (s) {
      return [s.slot, s.name, s.armor, s.damage, s.count, s.kind,
              s.badges.map(function (b) { return b.text; }).join('~')].join('|');
    }).join('§');
    if (sig !== gear.sig) {
      gear.sig = sig;
      const worn = list.filter(function (s) { return !!s.name; }).length;
      const rating = d.resist && d.resist.has ? d.resist.armor : 0;
      card.innerHTML = '<div class="ps-card-head">' +
          '<div class="ps-card-title">Equipment ' +
            '<span class="ps-card-sub">' + worn + ' of ' + list.length + ' worn</span></div>' +
          (rating > 0 ? '<span class="ps-gear-total" title="Your total armour rating, ' +
            'every worn piece and effect included">🛡 ' + fmtInt(rating) + '</span>' : '') +
        '</div>' +
        '<div class="ps-gear-grid">' + list.map(gearTile).join('') + '</div>';
    }
    hydrateGearPlates();
    armGearIcons();
  }

  /* ==================================== 2026-08-17 · stats + resistances == *
   * The reference pairs a stat block with a resistance panel; so do we, but in
   * the deck's own plates and with our numbers labelled honestly — a resist
   * meter is drawn against ITS OWN cap (magic 85, physical 80), never a flat
   * 100, so a capped character reads as capped. */

  function statRow(glyph, label, value, cls, title) {
    return '<div class="ps-stat' + (cls ? ' ' + cls : '') + '" title="' + esc(title || label) + '">' +
      '<span class="ps-stat-ico" aria-hidden="true">' + glyph + '</span>' +
      '<span class="ps-stat-label">' + esc(label) + '</span>' +
      '<span class="ps-stat-val">' + value + '</span></div>';
  }

  /* A resist meter. `pct` is the share of the CAP, so the bar is full exactly
     when the stat is maxed. Stepped on the poll, no animation loop — the
     compositor is off in Ultralight and an animated fill smears. */
  function resistRow(key, label, cap, glyph, art, val) {
    const pct = clampPct(val, cap);
    const capped = val >= cap - 0.05;
    return '<div class="ps-res ps-res-' + key + (capped ? ' is-capped' : '') +
      '" title="' + esc(label + ' resistance: ' + fmtPct(val) +
        (capped ? ' — at the game’s cap of ' + fmtPct(cap) : ' of a possible ' + fmtPct(cap))) + '">' +
      '<span class="ps-res-ico" aria-hidden="true">' +
        '<img src="icons/custom/' + art + '.png" alt="" onerror="this.parentNode.textContent=\'' + glyph + '\'">' +
      '</span>' +
      '<span class="ps-res-body">' +
        '<span class="ps-res-head"><span class="ps-res-name">' + esc(label) + '</span>' +
        '<span class="ps-res-val">' + fmtPct(val) + '</span></span>' +
        '<span class="ps-res-track"><span class="ps-res-fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
      '</span></div>';
  }

  function renderBattle(d) {
    const card = provisionCard('ps-battle', 'ps-card ps-battle', 'Combat and resistances', '#ps-gear');
    if (!card) return;
    const c = d.combat || { has: false }, r = d.resist || { has: false };
    if (!c.has && !r.has) {
      card.classList.add('hidden');
      card.innerHTML = '';
      card._sig = '';
      return;
    }
    card.classList.remove('hidden');

    /* Same signature discipline as the gear card: these numbers move (damage
       shifts the moment a fortify potion lands) but the STRUCTURE does not, so
       a changed value repaints only its own text node. */
    const sig = [c.has, r.has, c.unarmed, r.pieces].join('|');
    if (card._sig !== sig) {
      card._sig = sig;
      let html = '<div class="ps-card-head"><div class="ps-card-title">In a Fight</div></div>' +
        '<div class="ps-battle-cols">';
      if (c.has) {
        html += '<div class="ps-battle-sec">' +
          '<div class="ps-battle-lab">What you deal</div>' +
          '<div class="ps-stats" id="ps-stats"></div></div>';
      }
      if (r.has) {
        html += '<div class="ps-battle-sec">' +
          '<div class="ps-battle-lab">What you shrug off</div>' +
          '<div class="ps-resists" id="ps-resists"></div></div>';
      }
      html += '</div>';
      card.innerHTML = html;
    }

    if (c.has) {
      const box = $('ps-stats');
      if (box) {
        const rows = [];
        rows.push(statRow('⚔', c.unarmed ? 'Unarmed' : 'Damage', fmtInt(c.damage), 'ps-stat-dmg',
          c.unarmed ? 'Your fists — nothing is in your right hand'
                    : 'What your right hand hits for, straight from the engine'));
        if (!c.unarmed) {
          rows.push(statRow('⟳', 'Speed', (Math.round(c.speed * 100) / 100).toFixed(2), '',
            'Swing speed — 1.00 is a standard weapon'));
          rows.push(statRow('↔', 'Reach', (Math.round(c.reach * 100) / 100).toFixed(1), '',
            'How far the weapon reaches — 1.0 is a standard weapon'));
        }
        rows.push(statRow('👣', 'Move', fmtPct(c.move), '', 'Movement speed — 100% is unmodified'));
        if (r.has) {
          rows.push(statRow('🛡', 'Armour', fmtInt(r.armor), '',
            'Total armour rating across every worn piece'));
          rows.push(statRow('◈', 'Damage cut', fmtPct(r.phys), 'ps-stat-good',
            'How much physical damage that rating actually stops — ' +
            r.pieces + ' worn piece' + (r.pieces === 1 ? '' : 's') + ' counted, capped at ' + fmtPct(r.capPhys)));
        }
        /* Gold, carry weight and dragon souls deliberately do NOT repeat here —
           they already have their own chips above the card, and the reference's
           habit of listing everything twice is one of the things not taken. */
        rows.push(statRow('✧', 'Perks', fmtInt(c.perks), c.perks > 0 ? 'ps-stat-gold' : '',
          c.perks > 0 ? 'Perk points you have not spent' : 'No perk points waiting'));
        box.innerHTML = rows.join('');
      }
    }
    if (r.has) {
      const box = $('ps-resists');
      if (box) {
        box.innerHTML = RESIST_ROWS.map(function (row) {
          const cap = typeof row[2] === 'number' ? row[2] : (r[row[2]] || 100);
          return resistRow(row[0], row[1], cap, row[3], row[4], r[row[0]]);
        }).join('');
      }
    }
  }

  /* ================================================================ faith == */
  /* Wintersun, read off its own tracker quest (see src/faith.cpp). The card is
     ENTIRELY absent unless that quest binds — a deck on a load order without
     Wintersun must not grow an empty box promising a feature. When it IS there
     and you follow nobody, that is a real state and gets its own line. */

  /* Our own gold-glyph art, not emoji (Rober, 2026-08-16: "no lame emojis. we
     can use our generated icons") — made by the documented pipeline and shipped
     in icons/custom/. The character is the FALLBACK only: if the PNG is missing
     (an icons/ folder that did not deploy — the deploy does not recurse into
     it) the row shows a mark rather than a broken-image box. */
  const FAITH_ICON = {
    boon1: { img: 'icons/custom/hk-faith-boon.png', ch: '✦' },
    boon2: { img: 'icons/custom/hk-faith-favoured.png', ch: '★' },
    blessing: { img: 'icons/custom/hk-faith-blessing.png', ch: '✚' },
    tenets: { img: 'icons/custom/hk-faith-tenets.png', ch: '▤' },
  };

  function faithIcon(slot, cls) {
    const def = FAITH_ICON[slot] || FAITH_ICON.boon1;
    return '<img class="' + cls + '" src="' + def.img + '" alt="" ' +
      'onerror="this.parentNode.textContent=\'' + def.ch + '\'">';
  }

  /* One favour figure, rounded for reading. Wintersun's favour is a float that
     drifts every few in-game minutes; showing two decimals would make the card
     flicker on every 2 s poll for no information gained. */
  function faithNum(n) { return fmtInt(Math.round(Number(n) || 0)); }

  /* Rates, unlike favour, are small and fractional — Wintersun ships −2.5 a day
     and +7.5 a prayer, and rounding those to "3" and "+8" states numbers the mod
     does not use. One decimal below 10, whole numbers above (nobody needs
     "12.4 favour a day"). */
  function faithRate(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a < 10 && Math.round(a) !== a) return (Math.round(a * 10) / 10).toString();
    return fmtInt(Math.round(a));
  }

  function faithSub(f) {
    const bits = [];
    if (f.pantheon) bits.push(esc(f.pantheon));
    if (f.raceFavored) {
      bits.push(f.raceMult > 0
        ? 'your race is favoured — gains ×' + (Math.round(f.raceMult * 100) / 100)
        : 'your race is favoured');
    }
    return bits.join(' · ');
  }

  function faithMeter(f) {
    /* The scale is Wintersun's own: gains stop at the diminish target, so that
       is the right right-hand end. With no target sent, the Favoured threshold
       plus half again keeps the marker off the edge; with neither, there is no
       honest scale and the bar is dropped rather than invented. */
    const scale = f.target > 0 ? f.target : (f.threshold > 0 ? f.threshold * 1.5 : 0);
    if (scale <= 0) return '';
    const fill = clampPct(f.favor, scale);
    const tick = f.threshold > 0 ? Math.max(0, Math.min(100, (f.threshold / scale) * 100)) : -1;

    /* The Favoured mark gets its OWN row above the track, anchored to the tick's
       percentage. It used to sit in the space-between legend, where it lined up
       with the tick only by the coincidence that 100 of 200 is halfway — at any
       other threshold the label would have pointed at the wrong place, which is
       worse than no label. Its own row also makes a collision with the end
       labels impossible. Nudged in at the extremes so it can never hang off the
       card. */
    let mark = '';
    if (tick >= 0) {
      const shift = tick < 8 ? '0' : (tick > 92 ? '-100%' : '-50%');
      mark = '<div class="ps-faith-mark"><span style="left:' + tick.toFixed(1) +
        '%;transform:translateX(' + shift + ')">Favoured ' + esc(faithNum(f.threshold)) + '</span></div>';
    }
    const ends = ['<span>' + (f.apostasy ? '0 — cast out' : '0') + '</span>'];
    if (f.target > 0) ends.push('<span>' + faithNum(f.target) + ' — gains stop</span>');
    return '<div class="ps-faith-meter">' + mark +
      '<div class="ps-faith-track">' +
        '<div class="ps-faith-fill' + (f.favored ? ' is-favoured' : '') +
          '" style="width:' + fill.toFixed(1) + '%"></div>' +
        (tick >= 0 ? '<div class="ps-faith-tick" style="left:' + tick.toFixed(1) + '%" title="Favoured at ' +
          esc(faithNum(f.threshold)) + '"></div>' : '') +
      '</div>' +
      '<div class="ps-faith-scale">' + ends.join('') + '</div>' +
    '</div>';
  }

  function faithFacts(f) {
    const chips = [];
    if (f.drainPerDay < 0) {
      chips.push('<span class="ps-faith-fact ps-faith-fact-down" title="Wintersun bleeds favour every game day unless you keep the faith">' +
        '▼ ' + faithRate(f.drainPerDay) + ' favour a day</span>');
    } else if (f.drainPerDay > 0) {
      chips.push('<span class="ps-faith-fact ps-faith-fact-up">▲ ' + faithRate(f.drainPerDay) +
        ' favour a day</span>');
    }
    if (f.prayerGain > 0) {
      chips.push('<span class="ps-faith-fact" title="A prayer is worth less the sooner you repeat it — this is a full day&#39;s worth">' +
        '<img class="ps-faith-facticon" src="icons/custom/hk-faith-pray.png" alt="" ' +
        'onerror="this.remove()">praying: up to +' + faithRate(f.prayerGain) + '</span>');
    }
    if (f.prayer && f.prayer.name && f.prayer.have === false) {
      chips.push('<span class="ps-faith-fact ps-faith-fact-warn">you do not have ' + esc(f.prayer.name) + '</span>');
    }
    return chips.length ? '<div class="ps-faith-facts">' + chips.join('') + '</div>' : '';
  }

  function faithRow(e) {
    const locked = e.have === false;
    const glyph = faithIcon(e.slot, 'ps-faith-glyph-img');
    const tags = [];
    if (e.label) tags.push('<span class="ps-faith-tag">' + esc(e.label) + '</span>');
    if (e.note) tags.push('<span class="ps-faith-note">' + esc(e.note) + '</span>');
    else if (locked) tags.push('<span class="ps-faith-note">not yours yet</span>');
    return '<div class="ps-faith-row ps-faith-' + esc(e.slot || 'boon1') +
      (locked ? ' is-locked' : '') + '">' +
      '<span class="ps-faith-glyph">' + glyph + '</span>' +
      '<span class="ps-faith-body">' +
        '<span class="ps-faith-rowhead">' +
          '<span class="ps-faith-rowname">' + esc(e.name || e.label || '—') + '</span>' +
          tags.join('') +
        '</span>' +
        /* No text is a real answer for a boon whose effects are pure script —
           say so rather than leaving a blank line that reads as a load failure. */
        '<span class="ps-faith-text">' + (e.text ? esc(e.text) :
          '<i>Wintersun gives this one no description.</i>') + '</span>' +
      '</span>' +
    '</div>';
  }

  function renderFaith(d) {
    const root = $('ps-faith');
    if (!root) return;
    const f = (d && d.faith) || { present: false };
    if (!f.present) {
      root.classList.add('hidden');
      root.innerHTML = '';
      return;
    }
    root.classList.remove('hidden');

    /* NOT `state` — that name is the module's own snapshot store, and shadowing
       it inside a render function is how a later edit reaches for state.data and
       silently gets a string. */
    const stateChip = f.active
      ? (f.favored ? '<span class="ps-faith-state is-favoured">Favoured</span>'
                   : '<span class="ps-faith-state">Devoted</span>')
      : '';
    let html = '<div class="ps-card-head">' +
      '<div class="ps-card-title">Faith <span class="ps-card-sub">Wintersun</span></div>' +
      stateChip + '</div>';

    if (!f.active) {
      html += '<div class="ps-faith-none">You follow no god. Pray at a shrine or altar to take ' +
        'one up — Wintersun is watching, it simply has nobody to report.</div>';
      root.innerHTML = html;
      return;
    }

    html += '<div class="ps-faith-top">' +
      '<div class="ps-faith-sigil">' + esc((f.deity || '?').charAt(0).toUpperCase()) + '</div>' +
      '<div class="ps-faith-who">' +
        '<div class="ps-faith-name">' + esc(f.deity || 'Your god') + '</div>' +
        '<div class="ps-faith-pantheon">' + faithSub(f) + '</div>' +
      '</div>' +
      '<div class="ps-faith-num"><b>' + faithNum(f.favor) + '</b><span>favour</span></div>' +
    '</div>';
    html += faithMeter(f);
    html += faithFacts(f);

    if (f.entries.length) {
      html += '<div class="ps-faith-list">' + f.entries.map(faithRow).join('') + '</div>';
    }
    root.innerHTML = html;
  }

  function renderSkills(d) {
    const grid = $('ps-skills-grid');
    if (!grid) return;
    if (!d.skills.length) {
      grid.innerHTML = '<div class="ps-eff-empty" style="grid-column:1/-1">No skill data.</div>';
      grid._skillNames = null;
      return;
    }
    /* 2026-08-17: grouped Warrior / Thief / Mage, the vanilla guardian-stone
       families (see SKILL_GROUPS). Anything the DLL sends that is NOT one of
       the eighteen -- a skill a mod added -- falls into a trailing "Other"
       group rather than vanishing: a skill that exists and is not shown is
       worse than an unexpected heading.

       PATCH IN PLACE when the roster is unchanged (the ONLY thing that moves
       between polls is the level number). Replacing the whole grid's innerHTML
       on every 2 s poll is what let a poll landing mid-scroll jump/distort the
       numbers; touching only the changed level text nodes leaves the scrolled
       layout untouched. A full rebuild happens only when the skill SET itself
       changes (first paint, or a mod adding/removing a skill). */
    const names = d.skills.map(function (s) { return s.name; }).join('');
    const byName = {};
    d.skills.forEach(function (s) { byName[s.name] = s; });
    if (grid._skillNames === names) {
      const tiles = grid.querySelectorAll('.ps-skill');
      if (tiles.length === d.skills.length) {
        tiles.forEach(function (tile) {
          const s = byName[tile.getAttribute('data-skill')];
          if (!s) return;
          const lvl = tile.querySelector('.ps-skill-lvl');
          const txt = String(s.level);
          if (lvl && lvl.textContent !== txt) lvl.textContent = txt;
          skillWeight(tile, s.level);
        });
        return;
      }
    }

    const taken = {};
    let html = '';
    SKILL_GROUPS.forEach(function (g) {
      const rows = g.names.map(function (n) { taken[n] = 1; return byName[n]; }).filter(Boolean);
      if (rows.length) html += skillGroupHtml(g.id, g.label, rows);
    });
    const rest = d.skills.filter(function (s) { return !taken[s.name]; });
    if (rest.length) html += skillGroupHtml('other', 'Other', rest);
    grid.innerHTML = html;
    grid.querySelectorAll('.ps-skill').forEach(function (tile) {
      const s = byName[tile.getAttribute('data-skill')];
      if (s) skillWeight(tile, s.level);
    });
    grid._skillNames = names;
  }

  function skillGroupHtml(id, label, rows) {
    return '<div class="ps-skgroup ps-skgroup-' + esc(id) + '">' +
      '<div class="ps-skgroup-head">' + esc(label) + '</div>' +
      '<div class="ps-skgroup-rows">' +
      rows.map(function (s) {
        return '<div class="ps-skill" data-skill="' + esc(s.name) + '" title="' +
          esc(s.name) + ' — level ' + s.level + '">' +
          '<span class="ps-skill-name">' + esc(s.name) + '</span>' +
          '<span class="ps-skill-lvl">' + s.level + '</span></div>';
      }).join('') + '</div></div>';
  }

  /* Visual weight by level, so a wall of eighteen numbers has a shape: a
     mastered skill glows, a low one recedes.
     WARNING -- this is a LEGIBILITY RAMP, never a claim. The reference greys
     out "unleveled" skills, but there is no honest way to ask the engine
     whether a skill was ever used: every skill starts at 15, race bonuses push
     some to 25 for free, and a legendary reset puts a 100 back to 15. So
     nothing here says "untrained", the number is always shown in full, and the
     tooltip states the real level. Only "mastered" is asserted, because 100 is
     a fact. Guarded on a cached tier so the 2 s poll does not touch classList
     on eighteen nodes for nothing. */
  function skillWeight(tile, level) {
    level = Number(level) || 0;
    const tier = level >= 100 ? 3 : (level >= 70 ? 2 : (level >= 40 ? 1 : 0));
    if (tile._sw === tier) return;
    tile._sw = tier;
    tile.classList.toggle('ps-skill-max', tier === 3);
    tile.classList.toggle('ps-skill-high', tier === 2);
    tile.classList.toggle('ps-skill-mid', tier === 1);
    tile.classList.toggle('ps-skill-low', tier === 0);
  }

  function renderInventory(d) {
    const grid = $('ps-inventory-grid');
    if (!grid) return;
    const inv = d.inventory || {}, p = inv.potions || {};
    const c = inv.consumables || {};
    /* [cardClass, label, count, icon, packCategory | null, glyph].
       The potion + consumable cards carry a packCategory the modal fetches by
       (health / magicka / stamina / other / poison / food / drink / water);
       Lockpicks are not potions, so they open no modal. The Water card hides
       itself when no water mod is in the load order (d.waterOk === false) —
       an always-zero card would read as broken, not empty. */
    const rows = [
      ['health', 'Health', p.health, 'icons/custom/ps-health.png', 'health', '❤'],
      ['magicka', 'Magicka', p.magicka, 'icons/custom/ps-magicka.png', 'magicka', '✦'],
      ['stamina', 'Stamina', p.stamina, 'icons/custom/ps-stamina.png', 'stamina', '➤'],
      ['utility', 'Other', p.other, 'icons/custom/ps-utility.png', 'other', '◇'],
      ['poison', 'Poisons', c.poison, 'icons/custom/ps-poison.png', 'poison', '☠'],
      ['food', 'Food', c.food, 'icons/custom/ps-food.png', 'food', '🍖'],
      ['drink', 'Drinks', c.drink, 'icons/custom/ps-drink.png', 'drink', '🍺'],
      ['water', 'Water', c.water, 'icons/custom/ps-water.png', 'water', '💧'],
      ['lockpicks', 'Lockpicks', inv.lockpicks, 'icons/custom/ps-lockpicks.png', null, '🗝'],
    ].filter(function (r) { return r[0] !== 'water' || inv.waterOk !== false; });
    grid.innerHTML = rows.map(function (r) {
      const cat = r[4];
      const clickable = !!cat && Number(r[2]) > 0;
      return '<div class="ps-inv ps-inv-' + r[0] +
        (cat ? ' ps-inv-pot' : '') + (clickable ? ' ps-inv-open' : '') +
        '"' + (cat ? ' data-cat="' + esc(cat) + '"' : '') +
        ' title="' + esc(r[1]) +
        (clickable ? ' — click to list every ' + esc(r[1].toLowerCase()) + ' item you carry'
                   : (cat ? ' — none carried' : ' carried')) + '"' +
        (clickable ? ' tabindex="0" role="button"' : '') + '>' +
        '<span class="ps-inv-glyph" aria-hidden="true">' + r[5] + '</span>' +
        '<img src="' + r[3] + '" alt=""><span class="ps-inv-body"><span class="ps-inv-name">' +
        esc(r[1]) + '</span><span class="ps-inv-count">' + fmtInt(r[2]) + '</span></span>' +
        (clickable ? '<span class="ps-inv-more" aria-hidden="true">⋯</span>' : '') +
        '</div>';
    }).join('');
    /* Missing card art degrades to the glyph, never a broken image box —
       ps-food/ps-drink/ps-water ship later; plain remove-on-error idiom. */
    grid.querySelectorAll('.ps-inv > img').forEach(function (img) {
      img.addEventListener('error', function () {
        const card = img.parentNode;
        if (card) card.classList.add('ps-inv-noart');
        img.remove();
      });
      if (img.complete && img.naturalWidth === 0 && img.src) {
        const card = img.parentNode;
        if (card) card.classList.add('ps-inv-noart');
        img.remove();
      }
    });
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

  const PACK_LABELS = { health: 'Health', magicka: 'Magicka', stamina: 'Stamina', other: 'Other',
                        poison: 'Poisons', food: 'Food', drink: 'Drinks', water: 'Water' };

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
      spin: { kind: 'item', formId: it.formId, plugin: it.plugin },
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

  /* ============================================ 2026-08-17 · active effects ==
   * Rober named this one first: "we could grab a lot of the features. and
   * improve our visuals - active effects." The old card was a flat, correct,
   * unreadable list. Now:
   *   - GROUPED (debuff / disease / poison / buff / constant), the piles a
   *     player actually thinks in, decided in C++ off the source record's own
   *     spell type -- never off its English name, which breaks the moment the
   *     game is not in English.
   *   - a DURATION RING around the magnitude, which DECREASES honestly: the
   *     bright arc is what is LEFT (remaining / total), stepped on the 1 s tick
   *     with no animation loop (Ultralight runs compositor-off and an animated
   *     sweep smears -- the tree-wide purge of 2026-08-16).
   *   - magnitude legible at a glance, source and mod named underneath, and
   *     every row carrying full detail on hover.
   *
   * REDRAW DISCIPLINE. The pane repolls every 2 s. Rebuilding this list and
   * rebinding one listener per row each time is exactly the pattern that was
   * found making the big lists jitter; so the body is rebuilt only when its
   * SIGNATURE changes (which rows, in which order, with what armed state), the
   * volatile numbers are written in place by tick(), and there is ONE delegated
   * click listener for the whole body. */

  /* Group filter chips. '' = everything. */
  function groupCounts() {
    const c = {};
    const d = state.data;
    if (!d) return c;
    d.effects.forEach(function (e) { c[e.group] = (c[e.group] || 0) + 1; });
    return c;
  }

  /* The visible rows, already sorted, split into their piles in GROUPS order.
     Within a pile: soonest-expiring first (that is the one about to matter),
     permanent last, and an engine-hidden row last of all. */
  function groupedEffects() {
    const list = visibleEffects();
    const out = [];
    GROUPS.forEach(function (g) {
      if (ui.group && ui.group !== g.id) return;
      const rows = list.filter(function (e) { return e.group === g.id; });
      if (!rows.length) return;
      rows.sort(function (a, b) {
        if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
        const pa = a.remainSec <= 0 ? 1 : 0, pb = b.remainSec <= 0 ? 1 : 0;
        if (pa !== pb) return pa - pb;
        if (pa) return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        return a.remainSec - b.remainSec;
      });
      out.push({ id: g.id, label: g.label, hint: g.hint, rows: rows });
    });
    return out;
  }

  /* The remaining share of an effect's life, 0..100. A permanent effect has no
     honest fraction, so it gets a full quiet ring rather than an empty one --
     an empty ring reads as "about to expire", which is the opposite. */
  function effPct(e) {
    if (!e || e.durSec <= 0) return 100;
    return clampPct(liveRemain(e), e.durSec);
  }

  function effTimeText(e) {
    if (e.durSec <= 0 && e.remainSec <= 0) return 'permanent';
    const r = liveRemain(e);
    return r > 0 ? fmtDur(r) + ' left' : 'expiring';
  }

  /* The plate at the head of a row: the magnitude inside a ring that empties as
     the effect runs out. No magnitude (a script effect, a disease) shows the
     group's mark instead of a bare "0", which would be a number the engine
     never gave us. */
  function effPlate(e) {
    const perm = e.durSec <= 0;
    const mark = e.group === 'disease' ? '☣' : (e.group === 'poison' ? '☠' :
                 (e.harmful ? '▼' : '✦'));
    const inner = e.magnitude
      ? '<b>' + fmtInt(Math.abs(e.magnitude)) + '</b>'
      : '<span class="ps-eff-mark">' + mark + '</span>';
    return '<span class="ps-eff-ring' + (perm ? ' is-perm' : '') + '" data-key="' +
      esc(e.key) + '" style="--ps-eff-pct:' + effPct(e).toFixed(1) + '">' +
      '<span class="ps-eff-face">' + inner + '</span></span>';
  }

  function effRowHtml(e) {
    const armed = !!ui.armed[e.key];
    const risky = e.removeMode === 'confirm';
    const sub = [];
    if (e.source) sub.push('<span class="ps-eff-src">' + esc(e.source) + '</span>');
    if (e.plugin) sub.push('<span class="ps-eff-plugin">' + esc(e.plugin) + '</span>');
    const kind = e.sourceKind
      ? '<span class="ps-eff-kind" title="Where this came from">' + esc(e.sourceKind) + '</span>' : '';
    /* The engine keeps kHideInUI effects off the magic menu because they are
       plumbing. We KEEP the row -- this tab is an inspector and you may well
       want to dispel one -- and mark it, so it is never mistaken for something
       you cast. */
    const hid = e.hidden
      ? '<span class="ps-eff-hid" title="The game hides this one from the magic menu -- it is usually a mod controller">engine</span>' : '';
    const btn = e.wantsRemove
      ? '<button class="ps-eff-rm' + (risky ? ' ps-eff-risk' : '') + (armed ? ' ps-armed' : '') +
        '" data-key="' + esc(e.key) + '" title="' + (risky
          ? 'Permanent ability -- removable, but it may be a mod controller'
          : 'Remove this effect') + '">' +
        (armed ? (risky ? 'Remove anyway?' : 'Remove?') : (risky ? '◆' : '✕')) + '</button>'
      : '<span class="ps-eff-lock" title="Inherited from your race -- protected from removal">🔒</span>';

    const detail = [e.name];
    if (e.av) detail.push(e.av);
    if (e.magnitude) detail.push(fmtInt(Math.abs(e.magnitude)) + ' points');
    if (e.durSec > 0) detail.push('lasts ' + fmtDur(e.durSec));
    if (e.source) detail.push('from ' + e.source);
    if (e.plugin) detail.push(e.plugin);

    return '<div class="ps-eff' + (e.harmful ? ' ps-eff-harm-row' : '') +
      (e.hidden ? ' ps-eff-is-hidden' : '') + ' ps-eff-g-' + esc(e.group) +
      '" title="' + esc(detail.join(' · ')) + '">' +
      effPlate(e) +
      '<div class="ps-eff-main">' +
        '<div class="ps-eff-name">' + esc(e.name) + kind + hid + '</div>' +
        (sub.length ? '<div class="ps-eff-sub">' + sub.join('<span class="ps-eff-dot">·</span>') + '</div>' : '') +
      '</div>' +
      '<div class="ps-eff-meta">' +
        '<span class="ps-eff-time' + (e.durSec <= 0 && e.remainSec <= 0 ? ' ps-eff-perm' : '') +
          '" data-key="' + esc(e.key) + '">' + esc(effTimeText(e)) + '</span>' +
        (e.durSec > 0
          ? '<span class="ps-eff-bar"><i data-key="' + esc(e.key) + '" style="width:' +
            effPct(e).toFixed(1) + '%"></i></span>'
          : '') +
      '</div>' + btn + '</div>';
  }

  function renderEffects() {
    const d = state.data;
    const body = $('ps-eff-body');
    const chip = $('ps-eff-count');
    if (!body) return;

    if (chip && d) {
      /* "harmful" for the headline count deliberately EXCLUDES the engine's own
         hidden plumbing: a save carrying forty hidden controller effects would
         otherwise scream about harm you cannot act on. */
      const harm = d.effects.filter(function (e) { return e.harmful && !e.hidden; }).length;
      chip.textContent = d.effects.length
        ? (d.effects.length + ' effect' + (d.effects.length === 1 ? '' : 's') +
           (harm ? ' · ' + harm + ' harmful' : ''))
        : '';
      chip.classList.toggle('ps-eff-harm', harm > 0);
    }

    renderEffectChips();

    const groups = groupedEffects();
    const total = groups.reduce(function (n, g) { return n + g.rows.length; }, 0);
    if (!total) {
      body._sig = '';
      body.innerHTML = '<div class="ps-eff-empty">' +
        (d && d.effects.length
          ? 'Nothing matches ' + (ui.filter ? '“' + esc(ui.filter) + '”' : 'that filter') + '.'
          : '<b>No active effects.</b><br>Spells, diseases and enchantments you\'re under will show here.') +
        '</div>';
      return;
    }

    /* Rebuild only when the LIST changes, not when its numbers do. */
    const sig = ui.filter + '¶' + ui.group + '¶' + groups.map(function (g) {
      return g.id + ':' + g.rows.map(function (e) {
        return e.key + (ui.armed[e.key] ? '!' : '') + '~' + e.magnitude + '~' + (e.durSec > 0 ? 't' : 'p');
      }).join(',');
    }).join('|');
    if (body._sig === sig) { tick(); return; }
    body._sig = sig;

    body.innerHTML = groups.map(function (g) {
      return '<div class="ps-eff-group ps-eff-group-' + esc(g.id) + '">' +
        '<div class="ps-eff-ghead" title="' + esc(g.hint) + '">' +
          '<span class="ps-eff-gname">' + esc(g.label) + '</span>' +
          '<span class="ps-eff-gcount">' + g.rows.length + '</span>' +
        '</div>' + g.rows.map(effRowHtml).join('') + '</div>';
    }).join('');
    bindEffectBody(body);
  }

  /* The group filter row: one chip per pile that actually has rows, with live
     counts. Past a handful of permanent abilities an unfiltered list is a wall,
     and the deck's rule is that anything you browse can be narrowed. */
  function renderEffectChips() {
    const filterEl = $('ps-eff-filter');
    if (!filterEl || !filterEl.parentNode) return;
    let row = $('ps-eff-groups');
    const counts = groupCounts();
    const have = GROUPS.filter(function (g) { return counts[g.id]; });
    if (have.length < 2) {           // one pile needs no chooser
      if (row) row.classList.add('hidden');
      return;
    }
    if (!row) {
      row = document.createElement('div');
      row.id = 'ps-eff-groups';
      row.className = 'ps-eff-groups';
      filterEl.parentNode.insertBefore(row, filterEl.nextSibling);
      row.addEventListener('click', function (ev) {
        const b = ev.target && ev.target.closest ? ev.target.closest('.ps-eff-gchip') : null;
        if (!b) return;
        ev.stopPropagation();
        const want = b.getAttribute('data-group') || '';
        ui.group = (ui.group === want) ? '' : want;
        renderEffects();
      });
    }
    row.classList.remove('hidden');
    const sig = ui.group + '¶' + have.map(function (g) { return g.id + counts[g.id]; }).join(',');
    if (row._sig === sig) return;
    row._sig = sig;
    const all = '<button class="ps-eff-gchip' + (ui.group ? '' : ' is-on') +
      '" data-group="" title="Every active effect">All' +
      '<span class="ps-eff-gchip-n">' + (state.data ? state.data.effects.length : 0) + '</span></button>';
    row.innerHTML = all + have.map(function (g) {
      return '<button class="ps-eff-gchip ps-eff-gchip-' + g.id +
        (ui.group === g.id ? ' is-on' : '') + '" data-group="' + g.id +
        '" title="' + esc(g.hint) + '">' + esc(g.label) +
        '<span class="ps-eff-gchip-n">' + counts[g.id] + '</span></button>';
    }).join('');
  }

  /* ONE delegated listener for the whole body, bound once per rebuild target.
     The old code bound a listener per remove button on every 2 s poll. */
  function bindEffectBody(body) {
    if (body._bound) return;
    body._bound = true;
    body.addEventListener('click', function (ev) {
      const b = ev.target && ev.target.closest ? ev.target.closest('.ps-eff-rm') : null;
      if (!b) return;
      ev.stopPropagation();
      const key = b.getAttribute('data-key');
      if (!key) return;
      if (!ui.armed[key]) { ui.armed[key] = true; renderEffects(); return; }
      delete ui.armed[key];
      const effect = state.data && state.data.effects.find(function (e) { return e.key === key; });
      toGame('psRemoveEffect', JSON.stringify({ key: key, force: !!(effect && effect.removeMode === 'confirm') }));
      renderEffects();
    });
  }

  /* Live countdown -- patch only the volatile nodes (the time text, the ring
     sweep, the bar width). No re-render, so the armed-remove state, the scroll
     position and the filter caret all survive, and Ultralight repaints three
     small things instead of the list. */
  function tick() {
    if (!ui.visible || !state.data) return;
    const body = $('ps-eff-body');
    if (!body) return;
    const byKey = {};
    state.data.effects.forEach(function (e) { byKey[e.key] = e; });

    body.querySelectorAll('.ps-eff-time:not(.ps-eff-perm)').forEach(function (n) {
      const e = byKey[n.getAttribute('data-key')];
      if (!e) return;
      const txt = effTimeText(e);
      if (n.textContent !== txt) n.textContent = txt;
    });
    body.querySelectorAll('.ps-eff-ring:not(.is-perm)').forEach(function (n) {
      const e = byKey[n.getAttribute('data-key')];
      if (!e) return;
      n.style.setProperty('--ps-eff-pct', effPct(e).toFixed(1));
    });
    body.querySelectorAll('.ps-eff-bar > i').forEach(function (n) {
      const e = byKey[n.getAttribute('data-key')];
      if (!e) return;
      n.style.width = effPct(e).toFixed(1) + '%';
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
    /* The gear render poll must die with the tab — it nudges C++ every 2.5 s
       and would otherwise keep asking about equipment nobody is looking at. */
    stopGearPoll();
    if (gear.settleT) { clearTimeout(gear.settleT); gear.settleT = null; }
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

  /* ======================================================== Tune modal == */
  /* ⚒ Tune (2026-08-17) — PROTEUS's player editor as a Character-sheet modal.
     C++ (player_tune.cpp) reads/writes BASE ActorValues; they live in the
     SAVE, so there is no sidecar and no revert file — the modal says so.
     Bridge: psTuneGet('') -> psTuneData({level,perkPoints,dragonSouls,attrs,
     regen,resists,skills}) · psTuneSet({set:{key:num}}) -> psTuneResult
     (fresh psTuneData shape + msg). */

  const tune = { open: false, data: null, busy: false, filter: '', status: '', draft: {} };

  function openTuneModal() {
    tune.open = true;
    tune.data = null;
    tune.busy = false;
    tune.filter = '';
    tune.status = '';
    tune.draft = {};
    renderTuneModal();
    toGame('psTuneGet', '');
  }

  /* Typed-but-unapplied numbers must survive a modal re-render (the filter
     narrows sections by rebuilding) — the Finder Modify sheet's draft law. */
  function captureTuneDraft() {
    const ov = $('ps-tune-overlay');
    if (!ov) return;
    ov.querySelectorAll('.ps-tune-row').forEach(function (row) {
      const input = row.querySelector('.ps-tune-num');
      if (input) tune.draft[row.getAttribute('data-key')] = input.value;
    });
  }

  function closeTuneModal() {
    tune.open = false;
    tune.data = null;
    const ov = $('ps-tune-overlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  window.psTuneData = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object' || !tune.open) return;
    if (!d.ok) { tune.status = d.msg || 'Could not read your character.'; renderTuneModal(); return; }
    tune.data = d;
    renderTuneModal();
  };

  window.psTuneResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    tune.busy = false;
    if (!tune.open) return;
    if (d.ok) {
      tune.data = d;
      tune.draft = {};        // the record is the truth again
      tune.status = d.msg || 'Changed.';
      renderTuneModal();
      toGame('psGet', '');    // the sheet's own skills/vitals reflect it now
    } else {
      tune.status = d.msg || 'Failed.';
      renderTuneModal();
    }
  };

  function tuneRowHtml(f) {
    const shown = tune.draft[f.key] !== undefined ? tune.draft[f.key] : f.base;
    return '<div class="ps-tune-row" data-key="' + esc(f.key) + '" data-base="' + f.base + '">' +
      '<span class="ps-tune-label" title="' + esc(f.label) + '">' + esc(f.label) + '</span>' +
      '<span class="ps-tune-ctrl">' +
      '<button class="ps-tune-step" data-d="-1" title="Less">−</button>' +
      '<input class="ps-tune-num" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + esc(String(shown)) + '">' +
      '<button class="ps-tune-step" data-d="1" title="More">+</button>' +
      '</span></div>';
  }

  function tuneSectionHtml(title, fields) {
    const flt = tune.filter.toLowerCase();
    const rows = fields.filter(function (f) {
      return !flt || f.label.toLowerCase().indexOf(flt) !== -1 || f.key.indexOf(flt) !== -1;
    });
    if (!rows.length) return '';
    return '<div class="ps-tune-sect"><div class="ps-tune-h">' + esc(title) + '</div>' +
      '<div class="ps-tune-grid">' + rows.map(tuneRowHtml).join('') + '</div></div>';
  }

  function renderTuneModal() {
    let ov = $('ps-tune-overlay');
    if (!tune.open) { if (ov && ov.parentNode) ov.parentNode.removeChild(ov); return; }
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ps-tune-overlay';
      ov.className = 'ps-pack-overlay';   // same dim + centering as the pack modal
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeTuneModal(); });
      ov.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); closeTuneModal(); }
      });
      (($('ps-pane')) || document.body).appendChild(ov);
    }

    const d = tune.data;
    let body;
    if (!d) {
      body = tune.status
        ? '<div class="ps-pack-empty">' + esc(tune.status) + '</div>'
        : '<div class="ps-pack-empty">Reading your character…</div>';
    } else {
      const pools = [
        { key: 'perkPoints', label: 'Perk points', base: d.perkPoints | 0 },
        { key: 'dragonSouls', label: 'Dragon souls', base: d.dragonSouls | 0 },
      ];
      body =
        '<div class="ps-tune-warn">Writes straight into your character — the numbers live in your save ' +
        'from the next save on. There is no revert file: note what you change.</div>' +
        '<div class="ps-tune-filterrow"><input id="ps-tune-filter" type="text" autocomplete="off" ' +
        'spellcheck="false" placeholder="Filter the dials — try \'regen\', \'fire\', \'sneak\'…" value="' +
        esc(tune.filter) + '"></div>' +
        tuneSectionHtml('Progression', pools) +
        tuneSectionHtml('Attributes', d.attrs || []) +
        tuneSectionHtml('Regeneration', d.regen || []) +
        tuneSectionHtml('Resistances', d.resists || []) +
        tuneSectionHtml('Skills', d.skills || []);
    }

    ov.innerHTML =
      '<div class="ps-pack-card ps-tune-card" role="dialog" aria-modal="true" aria-label="Tune your character">' +
      '<div class="ps-pack-head"><span class="ps-pack-title">⚒ Tune' +
      (d ? ' <span class="ps-tune-lvl">Level ' + (d.level | 0) + '</span>' : '') + '</span>' +
      '<button class="ps-pack-x" title="Close">✕</button></div>' +
      '<div class="ps-tune-body">' + body + '</div>' +
      '<div class="ps-tune-foot">' +
      '<span id="ps-tune-status" class="ps-tune-status">' + esc(tune.status) + '</span>' +
      '<button id="ps-tune-cancel" class="ps-tune-btn">Close</button>' +
      '<button id="ps-tune-apply" class="ps-tune-apply"' + (d && !tune.busy ? '' : ' disabled') + '>' +
      (tune.busy ? 'Applying…' : 'Apply changes') + '</button>' +
      '</div></div>';

    ov.querySelector('.ps-pack-x').addEventListener('click', function (e) { e.stopPropagation(); closeTuneModal(); });
    const cancel = $('ps-tune-cancel');
    if (cancel) cancel.addEventListener('click', closeTuneModal);
    const apply = $('ps-tune-apply');
    if (apply) apply.addEventListener('click', applyTune);
    const flt = $('ps-tune-filter');
    if (flt) {
      flt.addEventListener('input', function () {
        captureTuneDraft();
        tune.filter = flt.value;
        /* rebuild only the sections; keep the input focused with its caret */
        const pos = flt.selectionStart;
        renderTuneModal();
        const again = $('ps-tune-filter');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
      flt.addEventListener('keydown', function (e) { e.stopPropagation(); });
    }
    ov.querySelectorAll('.ps-tune-step').forEach(function (b) {
      b.addEventListener('click', function () {
        const row = b.closest('.ps-tune-row');
        const input = row.querySelector('.ps-tune-num');
        const dd = parseInt(b.getAttribute('data-d'), 10) || 0;
        const key = row.getAttribute('data-key');
        /* sensible steps: percent-ish dials move by 5, everything big by 10,
           regen (small floats) by 0.5, counters by 1 */
        let step = 10;
        if (key === 'perkPoints' || key === 'dragonSouls') step = 1;
        else if (key.indexOf('rate') !== -1) step = 0.5;
        else if (key.indexOf('resist') === 0 || key === 'speedmult') step = 5;
        else if ((tune.data.skills || []).some(function (s) { return s.key === key; })) step = 5;
        const cur = parseFloat(String(input.value).replace(/[^0-9.\-]/g, ''));
        const next = (isNaN(cur) ? 0 : cur) + dd * step;
        input.value = String(Math.round(next * 100) / 100);
      });
    });
    ov.querySelectorAll('.ps-tune-num').forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') applyTune();
        if (e.key === 'Escape') closeTuneModal();
      });
    });
  }

  /* Only fields that DIFFER from the read state go on the wire — the C++ apply
     is then exactly "what you touched". Reads the DRAFT, not the DOM: a filter
     hides rows, and a number typed before filtering must still apply. */
  function applyTune() {
    if (!tune.data || tune.busy) return;
    captureTuneDraft();
    const d = tune.data;
    const fields = [
      { key: 'perkPoints', base: d.perkPoints | 0 },
      { key: 'dragonSouls', base: d.dragonSouls | 0 },
    ].concat(d.attrs || [], d.regen || [], d.resists || [], d.skills || []);
    const set = {};
    fields.forEach(function (f) {
      if (tune.draft[f.key] === undefined) return;
      const n = parseFloat(String(tune.draft[f.key]).replace(/[^0-9.\-]/g, ''));
      if (isNaN(n)) return;
      if (Math.abs(n - Number(f.base)) > 1e-3) set[f.key] = n;
    });
    if (!Object.keys(set).length) { tune.status = 'Nothing changed.'; renderTuneModal(); return; }
    tune.busy = true;
    tune.status = '';
    renderTuneModal();
    toGame('psTuneSet', JSON.stringify({ set: set }));
  }

  function init() {
    /* Hold poll-driven rebuilds while the sheet is being scrolled — the fix for
       the skill-number jitter. Passive: we only observe, never preventDefault. */
    const pane = $('ps-pane');
    if (pane) pane.addEventListener('scroll', onScrollActivity, { passive: true });
    const effBody = $('ps-eff-body');
    if (effBody) effBody.addEventListener('scroll', onScrollActivity, { passive: true });

    const tuneBtn = $('ps-tune-open');
    if (tuneBtn) tuneBtn.addEventListener('click', function (e) { e.stopPropagation(); openTuneModal(); });
    const appearances = $('ps-appearances-open');
    if (appearances) appearances.addEventListener('click', function () {
      if (window.AppearanceGallery) AppearanceGallery.open();
      else if (typeof window.toast === 'function') window.toast('Appearances is still loading. Try again in a moment.');
    });

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
        /* Esc peels back one layer at a time (the Finder idiom): the typed
           query first, then the pile chip, so a stray Esc never throws away
           both narrowings at once. */
        if (e.key === 'Escape' && (f.value || ui.group)) {
          if (f.value) { f.value = ''; ui.filter = ''; }
          else { ui.group = ''; }
          renderEffects();
          e.stopPropagation();
        }
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
      /* 2026-08-17 blocks. Deliberately a NASTY fixture: a six-digit gold
         purse, a negative stamina regen, a capped magic resist, a very long
         enchanted name, an empty ring slot and a spell in the left hand. */
      regen: { has: true, hp: 5.04, mag: 9.36, sta: -2.3, inCombat: true },
      resist: { armor: 567, phys: 71.04, fire: 35, frost: 75, shock: 55,
                magic: 85, poison: 0, disease: 100, pieces: 4,
                capMagic: 85, capPhys: 80 },
      combat: { damage: 124, speed: 0.75, reach: 1.3, move: 126, perks: 3, unarmed: false },
      equip: [
        { slot: 'head', label: 'Head', kind: 'armor', name: 'Nightingale Hood', armor: 18,
          formId: '0x0FCC30', plugin: 'Skyrim.esm', badges: [{ text: '+20', av: 'Illusion' }] },
        { slot: 'body', label: 'Body', kind: 'armor', name: 'Ancient Shrouded Armour of Extreme Eminent Destruction', armor: 37,
          formId: '0x0FCC31', plugin: 'Skyrim.esm', badges: [{ text: '25%', av: 'One-Handed' }, { text: '+60', av: 'Stamina' }] },
        { slot: 'hands', label: 'Hands', kind: 'armor', name: 'Nightingale Gloves', armor: 25,
          formId: '0x0FCC32', plugin: 'Skyrim.esm', badges: [{ text: '+11', av: 'Lockpicking' }] },
        { slot: 'feet', label: 'Feet', kind: 'armor', name: 'Nightingale Boots', armor: 10,
          formId: '0x0FCC33', plugin: 'Skyrim.esm', badges: [] },
        { slot: 'amulet', label: 'Amulet', kind: 'armor', name: 'Gauldur Amulet Fragment', armor: 0,
          formId: '0x0FCC34', plugin: 'Skyrim.esm', badges: [{ text: '+50', av: 'Magicka' }] },
        { slot: 'ring', label: 'Ring', kind: 'armor', name: '', badges: [] },
        { slot: 'right', label: 'Right hand', kind: 'weapon', name: 'Nightingale Blade', damage: 124,
          speed: 0.75, reach: 1.3, formId: '0x0FCC35', plugin: 'Skyrim.esm',
          badges: [{ text: '+30', av: 'Fire damage' }] },
        { slot: 'left', label: 'Left hand', kind: 'spell', name: 'Sparks', badges: [] },
        { slot: 'ammo', label: 'Ammo', kind: 'ammo', name: 'Daedric Arrow', damage: 24, count: 342,
          formId: '0x0139C0', plugin: 'Skyrim.esm', badges: [] },
      ],
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
        { key: 'A1', id: 0, name: 'Ataxia', source: 'Ataxia', plugin: 'Skyrim.esm', magnitude: 0, durSec: 0, remainSec: 0, harmful: true, group: 'disease', sourceKind: 'disease', av: 'Lockpicking', wantsRemove: true, removeMode: 'safe' },
        { key: 'A2', id: 0, name: 'Blessing of Talos', source: 'Shrine Blessing', plugin: 'Skyrim.esm', magnitude: 20, durSec: 28800, remainSec: 14230, harmful: false, group: 'buff', sourceKind: 'ability', av: 'Shout recovery', wantsRemove: true, removeMode: 'safe' },
        { key: 'A3', id: 3, name: 'Well Rested', source: 'Sleep', plugin: 'Skyrim.esm', magnitude: 10, durSec: 28800, remainSec: 620, harmful: false, group: 'buff', sourceKind: 'ability', av: '', wantsRemove: true, removeMode: 'safe' },
        { key: 'A4', id: 4, name: 'Vampire Controller', source: 'Vampire Lord', plugin: 'Dawnguard.esm', magnitude: 15, durSec: 0, remainSec: 0, harmful: false, group: 'constant', sourceKind: 'ability', av: '', hidden: true, wantsRemove: true, removeMode: 'confirm' },
        { key: 'A5', id: 5, name: 'Fortify Smithing', source: "Blacksmith's Elixir", plugin: 'Skyrim.esm', magnitude: 32, durSec: 30, remainSec: 12, harmful: false, group: 'buff', sourceKind: 'potion', av: 'Smithing', wantsRemove: true, removeMode: 'safe' },
        { key: 'A7', id: 7, name: 'Ravage Stamina', source: 'Deathbell Poison', plugin: 'Skyrim.esm', magnitude: 26, durSec: 20, remainSec: 7, harmful: true, group: 'poison', sourceKind: 'poison', av: 'Stamina', wantsRemove: true, removeMode: 'safe' },
        { key: 'A8', id: 8, name: 'Frost Damage', source: 'Ice Spike', plugin: 'Skyrim.esm', magnitude: 41, durSec: 12, remainSec: 9.4, harmful: true, group: 'debuff', sourceKind: 'spell', av: 'Health', wantsRemove: true, removeMode: 'safe' },
        { key: 'A6', id: 6, name: 'Highborn', source: 'Racial', plugin: 'Skyrim.esm', magnitude: 0, durSec: 0, remainSec: 0, harmful: false, group: 'constant', sourceKind: 'ability', av: '', wantsRemove: false, removeMode: 'locked' },
      ],
      /* Faith fixture — shaped exactly like Faith::BuildJson: a Favoured
         follower whose second boon IS held, a blessing with no `have` (you cast
         it at an altar, you do not carry it), and tenets prose. */
      faith: {
        present: true, active: true, deity: 'Mara', pantheon: 'Divine',
        favor: 128.4, threshold: 100, target: 150, favored: true,
        raceFavored: true, raceMult: 1.5,
        drainPerDay: -2.5, prayerGain: 10, apostasy: true,
        entries: [
          { slot: 'boon1', label: 'Boon', name: "Mara's Gift", have: true,
            text: 'Restoration spells cost 10% less. Cure disease on those you heal.' },
          { slot: 'boon2', label: 'Favoured boon', name: 'Peace of Mara', have: true,
            text: 'Nearby enemies below 20% health flee rather than fight.' },
          { slot: 'blessing', label: 'Altar blessing', name: 'Blessing of Mara',
            text: 'Healing spells are 10% more effective.' },
          { slot: 'tenets', label: 'Tenets', name: 'Tenets of Mara', have: true,
            text: 'Favour is gained by marrying, by owning a home, and by healing others. ' +
                  'It is lost by murder.' },
        ],
        prayer: { name: 'Prayer', have: true },
      },
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
      /* SOS size from the palette (Rober, 2026-09-21: "add options for it in
         command k … with buttons to size up or down player (or npc
         highlighted)"). Two scopes, named in the label so neither press is a
         guess: YOU, and whoever is under your crosshair. The player rows carry
         the live size in their detail when the card has read it; the crosshair
         rows cannot know it before you aim, and say so rather than inventing a
         number. Gated on SOS actually being loaded. */
      if (!sos.data || sos.data.present !== false) {
        var cur = (sos.data && sos.data.available && Number.isFinite(Number(sos.data.size)))
          ? ('now ' + sos.data.size + ' / ' + (sos.data.max || 20))
          : (sos.data && sos.data.msg ? sos.data.msg : 'Schlongs of Skyrim');
        [['Bigger', 1], ['Smaller', -1]].forEach(function (pair) {
          items.push({
            label: 'SOS size: ' + pair[0].toLowerCase() + ' — you',
            detail: cur + ' · one step through SOS\u2019s own SetSize',
            kind: 'sos',
            keywords: 'sos schlong size grow shrink bigger smaller player me self penis scale',
            run: function () { sosStep('player', pair[1]); },
          });
          items.push({
            label: 'SOS size: ' + pair[0].toLowerCase() + ' — crosshair NPC',
            detail: 'Whoever you are looking at — aim first, or it refuses',
            kind: 'sos',
            keywords: 'sos schlong size grow shrink bigger smaller npc target crosshair them penis scale',
            run: function () { sosStep('crosshair', pair[1]); },
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
    /* The PLAYER's portrait, for any other surface that draws him (the OStim
       Scene page's cast strip is the first — Rober, 2026-09-21: "The player
       should use the profile image from the characters tab").
       Returns { file, crop } or null. `file` is already view-relative, and the
       crop is this pane's own normalised display crop, so a caller that
       applies it gets exactly the framing shown here. */
    playerPortrait: function () {
      const meta = (state.data && state.data.meta) || null;
      const file = meta && String(meta.portrait || '');
      if (!file) return null;
      return { file: file, crop: normCrop(meta.portraitCrop) };
    },
    init: init, onShow: onShow, onHide: onHide, toggleEdit: toggleEdit,
    wantsPause: wantsPause, setFilter: setFilter, _emptyPortrait: emptyPortrait,
    _state: state, _ui: ui, _visibleEffects: visibleEffects, _normalize: normalize,
    _fmtDur: fmtDur, _clampPct: clampPct, _normCrop: normCrop,
    _renderFaith: renderFaith,
    _renderPortrait: renderPortrait, _onScroll: onScrollActivity,
    _pack: pack, _openPackModal: openPackModal, _closePackModal: closePackModal,
    _packVisibleItems: packVisibleItems,
    _tune: tune, _openTuneModal: openTuneModal, _closeTuneModal: closeTuneModal,
    _applyTune: applyTune,
    /* pack-render test hooks: drive the load-gated art flow deterministically
       under jsdom (which fires no real <img> load/error). */
    _packRenderActive: packRenderActive,
    _hydratePackPlates: hydratePackPlates,
    _repaintPackShimmer: repaintPackShimmer,
    _packWindow: function (ms) {
      if (ms !== undefined) packLastLand = ms;
      return packLastLand;
    },
    /* 2026-08-17 test hooks: the gear/battle/effect-group work. */
    _gear: gear,
    _hydrateGearPlates: hydrateGearPlates,
    _groupedEffects: groupedEffects,
    _effPct: effPct,
    _tick: tick,
    _fmtRate: fmtRate,
    _fmtPct: fmtPct,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.CharSheetPane.init(); });
} else {
  window.CharSheetPane.init();
}
