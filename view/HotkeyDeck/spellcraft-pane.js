'use strict';

/* ====================================================================== *
 *  Spell Crafting — the Oblivion-style spellmaker (Rober's ask), driving
 *  the Fourth Era Spell-Crafting mod through the sc* C++ bridge.
 *
 *  C++ owns detection, the known-spell/effect harvest, the actual craft /
 *  erase / settings / tome verbs; this pane owns the Workbench (basket +
 *  live cost math mirrored EXACTLY from the mod), the Library (search +
 *  school groups), the crafted-spell shelf, and the settings sheet.
 *
 *  Bridge — requests: scState('') · scOpen('') · scCraft(json) ·
 *  scErase(json) · scLearn(json) · scSettings(json) · scTome('') ·
 *  scIcon(json) · scDeck(json) · hdOmniCast(json)  (casting reuses the
 *  EXISTING omni cast — zero new C++ for it).
 *  Replies (response-style, so no hd-boot STUB_FNS entry): scStateResult ·
 *  scOpenData · scCraftResult · scEraseResult · scLearnResult ·
 *  scSettingsResult · scTomeResult · scIconResult · scDeckResult.
 *  Every receiver accepts a JSON string OR an already-parsed object.
 *
 *  Host contract (mirrors ItemsPane): SpellCraftPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 *
 *  Modify sub-tab (2026-08-17, spell_edit.cpp — item_edit's twin): the seg
 *  row up top switches Craft ⇄ Modify. Modify searches EVERY spell the load
 *  order ships and edits its effects' magnitude/duration/area in place —
 *  persisted in the DLL's spell-edits.json, originals kept, live revert.
 *  Bridge: sxQuery/sxGet/sxApply/sxRevert/sxList · replies sxResultData/
 *  sxGetResult/sxApplyResult/sxRevertResult/sxListResult. Works even when
 *  Fourth Era Spell-Crafting is absent — editing needs no crafting mod.
 * ====================================================================== */

window.SpellCraftPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  /* ============================================================ schools == */

  /* Index 0-4 is the wire order scCraft sends; 5 = "no school" sentinel used
     when the lead effect is NOT overridden (C++ derives the real school from
     the costliest effect then). Hues pull from the deck's existing family —
     never a new near-duplicate. */
  const SCHOOLS = [
    ['Alteration',  '#8fb8ff'],   // blue
    ['Conjuration', '#b79bff'],   // purple
    ['Destruction', '#e08a8a'],   // red
    ['Illusion',    '#8fd8ff'],   // cyan
    ['Restoration', '#ffd36a'],   // gold
  ];
  const NOSCHOOL_HUE = '#c79be8';  // violet
  const ALCH_HUE = '#9dcb8f';      // green

  /* Accepts a number (0-4 wire index, or the engine's 18-22 actor values) or a
     school NAME string; anything else = -1 (no school). */
  function schoolIdx(v) {
    if (v == null || v === '') return -1;
    if (typeof v === 'number') {
      if (v >= 0 && v <= 4) return v;
      if (v >= 18 && v <= 22) return v - 18;
      return -1;
    }
    const s = String(v).toLowerCase();
    for (let i = 0; i < SCHOOLS.length; i++)
      if (SCHOOLS[i][0].toLowerCase() === s) return i;
    return -1;
  }

  function schoolName(i) { return (i >= 0 && i <= 4) ? SCHOOLS[i][0] : 'No school'; }
  function schoolHue(i) { return (i >= 0 && i <= 4) ? SCHOOLS[i][1] : NOSCHOOL_HUE; }
  /* The deck's own gold-glyph school art (sc-alteration.png … sc-restoration.png,
     already shipped in both view trees). '' for No-school / Alchemy — those fall
     back to a hued dot/plate, never a broken <img>. */
  function schoolIcon(i) {
    return (i >= 0 && i <= 4) ? 'icons/custom/sc-' + SCHOOLS[i][0].toLowerCase() + '.png' : '';
  }

  /* Delivery / casting arrive as the ENGINE's raw enum ints (the harness
     fixtures use names, which is why "2 · 1" only ever showed up in game —
     Rober's 2026-08-15 screenshot). Render words; pass a name through
     untouched; drop an unknown code rather than print a number. Note 0 is a
     real value on both (Self, Constant effect), so callers must not
     `filter(Boolean)` the raw ints — they go through here first. */
  const DELIVERY_NAMES = ['Self', 'Touch', 'Aimed', 'Target actor', 'Target location'];
  const CASTING_NAMES = ['Constant effect', 'Fire and forget', 'Concentration'];
  function enumName(v, names) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' || /^\d+$/.test(String(v)))
      return names[Number(v)] || '';
    return String(v).replace(/([a-z])([A-Z])/g, '$1 $2');   // "FireAndForget" -> "Fire And Forget"
  }
  function deliveryName(v) { return enumName(v, DELIVERY_NAMES); }
  function castingName(v) { return enumName(v, CASTING_NAMES); }
  function castLine(o) {
    return [deliveryName(o && o.delivery), castingName(o && o.casting)].filter(Boolean).join(' · ');
  }

  /* Constant-effect casting, whatever shape the DLL ships it in (Bethesda's
     CastingType 0 = ConstantEffect, or a name string). */
  function isConstant(c) {
    if (c === 0) return true;
    return /const/i.test(String(c == null ? '' : c));
  }

  /* ============================================================== state == */

  const state = {
    present: null,          // null = not answered yet, false = absent, true = there
    reason: '',
    dpfPex: false,
    learnMode: false,
    hasTome: false,
    gold: -1,               // -1 = unknown
    settings: { effectCost: 0, tomeCost: 250, mustKnowPerk: true,
                magExp: 1.0, dMult: 1.0, aMult: 15, sliderMax: 500 },
    loaded: false,          // scOpenData landed at least once
    spells: [],             // known spells (contract rows)
    alch: [],               // learned alchemy effects
    crafted: [],            // spells crafted through the mod
    icons: {},              // normalized override map: "plugin(lower)|dec" -> path
  };

  const ui = {
    visible: false,
    mode: 'craft',          // 'craft' | 'modify' — the seg row up top
    name: '',
    basket: [],             // workbench effects (see basketAdd for the row shape)
    q: '',                  // library search
    craftedQ: '',           // crafted-shelf filter
    override: false,
    ovSchool: -1,           // 0-4 when picked
    ovBase: null,           // {plugin, localId, name}
    expanded: {},           // library spell key -> per-effect rows open
    sheet: null,            // what the in-pane sheet is showing right now
    armedErase: '',         // crafted key whose Erase is armed
    armedEraseT: null,
    armedTome: false,
    armedTomeT: null,
    flashKey: '',           // basket row to flash (duplicate add)
    flashT: null,
    toastT: null,
    pendingIcon: null,      // {plugin, localId, icon} awaiting scIconResult
    nextSeed: 1,
    libShown: 120,          // library rows currently in the DOM (see LIB_PAGE)
  };

  /* How many library rows a page reveals. A full load order is thousands of
     spells and every one of them carries an <img>; the cap is what keeps a
     keystroke a keystroke rather than a full rebuild of the whole spellbook. */
  const LIB_PAGE = 120;

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'scState') setTimeout(devState, 30);
      if (DEV && fn === 'scOpen') setTimeout(devOpen, 40);
      if (DEV && fn === 'sxQuery') setTimeout(function () { devSxQuery(arg); }, 30);
      if (DEV && fn === 'sxGet') setTimeout(function () { devSxGet(arg); }, 30);
      if (DEV && fn === 'sxApply') setTimeout(function () { devSxApply(arg); }, 30);
      if (DEV && fn === 'sxRevert') setTimeout(function () { devSxRevert(arg); }, 30);
      if (DEV && fn === 'sxList') setTimeout(devSxList, 30);
    }
  }

  /* Replies may arrive as a JSON string (PrismaUI Invoke) or a parsed object
     (harness / inline script) — accept both, refuse garbage. */
  function parseReply(d) {
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return null; } }
    return (d && typeof d === 'object') ? d : null;
  }

  window.scStateResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    state.present = !!d.present;
    state.reason = String(d.reason || '');
    state.dpfPex = !!d.dpfPex;
    state.learnMode = !!d.learnMode;
    state.hasTome = !!d.hasTome;
    if (typeof d.gold === 'number') state.gold = d.gold;
    if (d.settings && typeof d.settings === 'object') applySettings(d.settings);
    if (ui.visible) render();
  };

  window.scOpenData = function (d) {
    d = parseReply(d);
    if (!d) return;
    if (d.ok === false) {
      /* an honest refusal — surface it and treat as absent-ish detail */
      state.loaded = true;
      if (d.reason) state.reason = String(d.reason);
      if (ui.visible) render();
      return;
    }
    state.loaded = true;
    state.spells = Array.isArray(d.spells) ? d.spells : [];
    state.alch = Array.isArray(d.alch) ? d.alch : [];
    state.crafted = Array.isArray(d.crafted) ? d.crafted : [];
    state.icons = normIconMap(d.icons);
    /* A new library invalidates everything the row cache remembers, and the
       search haystacks are built ONCE here rather than per keystroke — see
       hayFor(). */
    libCacheReset();
    if (typeof d.learnMode === 'boolean') state.learnMode = d.learnMode;
    if (typeof d.hasTome === 'boolean') state.hasTome = d.hasTome;
    if (typeof d.gold === 'number') state.gold = d.gold;
    if (d.settings && typeof d.settings === 'object') applySettings(d.settings);
    if (ui.visible) render();
  };

  window.scCraftResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    toast(d.msg || (d.ok ? 'Crafted' : 'Could not craft'), !d.ok);
    if (d.ok) {
      /* the craft landed — clear the bench and refresh the shelf */
      ui.basket = [];
      ui.name = '';
      ui.override = false; ui.ovSchool = -1; ui.ovBase = null;
      const n = $('sc-name');
      if (n) n.value = '';
      toGame('scOpen', '');
    }
    if (ui.visible) render();
  };

  window.scEraseResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    toast(d.msg || (d.ok ? 'Erased' : 'Could not erase'), !d.ok);
    ui.armedErase = '';
    if (d.ok) toGame('scOpen', '');   // in-place erase, then refresh (contract)
    else if (ui.visible) renderCrafted();
  };

  window.scLearnResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    if (d.ok) state.learnMode = !!d.on;
    if (d.msg) toast(d.msg, !d.ok);
    if (ui.visible) { renderHead(); renderLib(); }
  };

  window.scSettingsResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    toast(d.msg || (d.ok ? 'Settings saved' : 'Could not save'), !d.ok);
    if (d.ok) {
      if (ui.sheet && ui.sheet.kind === 'settings') {
        applySettings(ui.sheet.pending);
        closeSheet();
      }
      if (ui.visible) render();     // costs everywhere follow the new dials
    }
  };

  window.scTomeResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    toast(d.msg || (d.ok ? 'The tome is yours' : 'No tome'), !d.ok);
    ui.armedTome = false;
    if (d.ok) state.hasTome = true;
    if (ui.visible) renderHead();
  };

  window.scIconResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    const p = ui.pendingIcon;
    ui.pendingIcon = null;
    if (d.ok && p) {
      const k = String(p.plugin).toLowerCase() + '|' + (p.localId >>> 0);
      if (p.icon) state.icons[k] = p.icon;
      else delete state.icons[k];
      toast(p.icon ? 'Icon set' : 'Back to the automatic icon', false);
    } else if (!d.ok) {
      toast('Could not save the icon', true);
    }
    if (ui.visible) renderCrafted();
  };

  window.scDeckResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    toast(d.msg || (d.ok ? 'Added to the Spell Deck' : 'Could not add'), !d.ok);
  };

  /* =========================================================== settings == */

  function applySettings(s) {
    const t = state.settings;
    if (typeof s.effectCost === 'number') t.effectCost = s.effectCost;
    if (typeof s.tomeCost === 'number') t.tomeCost = s.tomeCost;
    if (typeof s.mustKnowPerk === 'boolean') t.mustKnowPerk = s.mustKnowPerk;
    if (typeof s.magExp === 'number') t.magExp = s.magExp;
    if (typeof s.dMult === 'number') t.dMult = s.dMult;
    if (typeof s.aMult === 'number') t.aMult = s.aMult;
    if (typeof s.sliderMax === 'number' && s.sliderMax > 0) t.sliderMax = s.sliderMax;
  }

  /* ========================================================== cost math == */

  /* THE formula, mirrored exactly from the mod (contract):
       AreaDiv    = max(AMult, ogArea)
       extra(v,og,mn) = og<mn ? (v<mn ? max(0,(v-og)/20) : mn/20-og/20) : 0
       durExtra   = extra(dur,  ogDur,  10)
       areaExtra  = extra(area, ogArea, AreaDiv)
       Dcost      = max(dur/10, 1) + durExtra
       cost       = D * DMult * pow(max(mag,1)*Dcost, magExp)
                      * (max(area/AreaDiv, 1) + areaExtra)
     Display rounded; SEND floats. AreaDiv==0 (aMult 0 with a 0 ogArea) would
     divide by zero — guarded to "no area factor" (the max(...,1) branch),
     which is what the mod's own defaults make unreachable anyway. */
  function extraPart(v, og, mn) {
    return og < mn ? (v < mn ? Math.max(0, (v - og) / 20) : mn / 20 - og / 20) : 0;
  }

  function effCost(e, s) {
    s = s || state.settings;
    const DMult = Number(s.dMult) || 0;
    const AMult = Number(s.aMult) || 0;
    const magExp = Number(s.magExp) || 0;
    const mag = Number(e.mag) || 0;
    const area = Number(e.area) || 0;
    const dur = Number(e.dur) || 0;
    const ogDur = Number(e.ogDur) || 0;
    const ogArea = Number(e.ogArea) || 0;
    const D = Number(e.D) || 0;
    const AreaDiv = Math.max(AMult, ogArea);
    const durExtra = extraPart(dur, ogDur, 10);
    const areaExtra = extraPart(area, ogArea, AreaDiv);
    const Dcost = Math.max(dur / 10, 1) + durExtra;
    const areaRatio = AreaDiv > 0 ? area / AreaDiv : 0;
    return D * DMult * Math.pow(Math.max(mag, 1) * Dcost, magExp)
      * (Math.max(areaRatio, 1) + areaExtra);
  }

  /* Gold per effect: trunc(effectCost × cost) — the truncation is the mod's,
     mirror it exactly (contract). */
  function effGold(e, s) {
    s = s || state.settings;
    const ec = Number(s.effectCost) || 0;
    if (ec <= 0) return 0;
    return Math.trunc(ec * effCost(e, s));
  }

  function totalMagicka() {
    let t = 0;
    for (let i = 0; i < ui.basket.length; i++) t += effCost(ui.basket[i]);
    return t;
  }

  function totalGold() {
    let t = 0;
    for (let i = 0; i < ui.basket.length; i++) t += effGold(ui.basket[i]);
    return t;
  }

  function costliest() {
    let best = null, bestC = -1;
    for (let i = 0; i < ui.basket.length; i++) {
      const c = effCost(ui.basket[i]);
      if (c > bestC) { bestC = c; best = ui.basket[i]; }
    }
    return best;
  }

  /* ============================================================= basket == */

  const MAX_EFFECTS = 8;   // the engine's own per-spell effect ceiling

  function keyOfMgef(mgef) {
    if (!mgef) return '';
    return String(mgef.plugin || '').toLowerCase() + '|' + ((mgef.localId >>> 0) || 0);
  }
  function keyOfSrc(src) {
    if (!src) return 'alch';
    return String(src.plugin || '').toLowerCase() + '|' + ((src.localId >>> 0) || 0);
  }

  /* Add one effect to the bench. eff = a contract effect row (spell) or an alch
     row; src = the owning spell (or null for alchemy). Returns:
       'added' | 'dup' (same mgef from the same source — flash, don't duplicate)
       | 'gated' | 'full'. */
  function basketAdd(eff, src) {
    if (!eff) return 'gated';
    if (eff.gated) return 'gated';
    const isAlch = !src;
    const mgef = isAlch
      ? { plugin: eff.plugin || '', localId: (eff.localId >>> 0) || 0 }
      : { plugin: eff.mgefPlugin || '', localId: (eff.mgefLocalId >>> 0) || 0 };
    const srcSpell = isAlch ? null
      : { plugin: src.plugin || '', localId: (src.localId >>> 0) || 0 };
    const dupKey = keyOfMgef(mgef) + '@' + keyOfSrc(srcSpell);
    for (let i = 0; i < ui.basket.length; i++) {
      if (ui.basket[i].dupKey === dupKey) {
        flashRow(ui.basket[i].k);
        return 'dup';
      }
    }
    if (ui.basket.length >= MAX_EFFECTS) return 'full';
    const row = {
      k: 'b' + (ui.nextSeed++),
      dupKey: dupKey,
      name: String(eff.name || '(effect)'),
      srcName: isAlch ? 'Alchemy · learned' : String(src.name || ''),
      school: schoolIdx(eff.school),
      srcSpell: srcSpell,
      mgef: mgef,
      /* alchemy defaults per the contract: mag 15, area 0, dur 10, og* 0 */
      mag: isAlch ? 15 : (Number(eff.mag) || 0),
      area: isAlch ? 0 : (Number(eff.area) || 0),
      dur: isAlch ? 10 : (Number(eff.dur) || 0),
      D: Number(eff.D) || 0,
      ogDur: isAlch ? 0 : (Number(eff.ogDur) || 0),
      ogArea: isAlch ? 0 : (Number(eff.ogArea) || 0),
      noMag: !isAlch && !!eff.noMag,
      noArea: !isAlch && !!eff.noArea,
      noDur: !isAlch && !!eff.noDur,
      hostile: !!eff.hostile,
      casting: isAlch ? (eff.casting != null ? eff.casting : 'FireAndForget') : eff.casting,
      delivery: eff.delivery,
      alch: isAlch,
    };
    ui.basket.push(row);
    return 'added';
  }

  function basketRemove(k) {
    for (let i = 0; i < ui.basket.length; i++) {
      if (ui.basket[i].k === k) { ui.basket.splice(i, 1); return true; }
    }
    return false;
  }

  function basketRow(k) {
    for (let i = 0; i < ui.basket.length; i++) if (ui.basket[i].k === k) return ui.basket[i];
    return null;
  }

  /* Set one stat on one basket row, clamped to 0..sliderMax; syncs the row's
     controls + the totals in place (called by the bar drag, the steppers and
     the typed number — all three stay in agreement). */
  function setStat(k, stat, v) {
    const row = basketRow(k);
    if (!row) return;
    if (stat !== 'mag' && stat !== 'area' && stat !== 'dur') return;
    const max = Number(state.settings.sliderMax) || 500;
    v = Math.round(Number(v) || 0);
    row[stat] = Math.max(0, Math.min(max, v));
    syncRowControls(k);
    renderBenchFoot();
  }

  function flashRow(k) {
    ui.flashKey = k;
    if (ui.flashT) clearTimeout(ui.flashT);
    const el = document.querySelector('#sc-basket .sc-brow[data-k="' + k + '"]');
    if (el) {
      el.classList.remove('sc-flash');
      void el.offsetWidth;   // restart the animation
      el.classList.add('sc-flash');
    }
    ui.flashT = setTimeout(function () {
      ui.flashKey = '';
      const e2 = document.querySelector('#sc-basket .sc-brow.sc-flash');
      if (e2) e2.classList.remove('sc-flash');
    }, 900);
  }

  /* Adding a whole spell = all its non-gated effects, deduped (contract).
     Says out loud when nothing could land. */
  function addSpell(sp) {
    if (!sp) return;
    const effs = Array.isArray(sp.effects) ? sp.effects : [];
    let added = 0, dup = 0, gated = 0, full = 0;
    for (let i = 0; i < effs.length; i++) {
      const r = basketAdd(effs[i], sp);
      if (r === 'added') added++;
      else if (r === 'dup') dup++;
      else if (r === 'gated') gated++;
      else if (r === 'full') full++;
    }
    if (added) { renderBench(); }
    else if (dup) { /* the flash on the existing row is the answer */ }
    else if (full) toast('The bench is full — ' + MAX_EFFECTS + ' effects at most', true);
    else if (gated) toast('Every effect of that spell needs a perk you don\'t have', true);
  }

  /* ============================================================== gates == */

  /* Why the Craft button is disabled — '' means it isn't. The order mirrors
     what the user can actually fix first. */
  function craftGate() {
    if (!ui.basket.length)
      return { ok: false, why: 'Add at least one effect from the library' };
    if (ui.override) {
      if (ui.ovSchool < 0 || ui.ovSchool > 4)
        return { ok: false, why: 'Pick a school for the custom lead effect' };
      if (!ui.ovBase)
        return { ok: false, why: 'Pick a base spell for visuals' };
    } else {
      const top = costliest();
      if (top && top.school < 0)
        return { ok: false, why: 'the costliest effect has no school — use a custom lead effect' };
      if (top && isConstant(top.casting))
        return { ok: false, why: 'the costliest effect comes from a constant-effect spell — use a custom lead effect' };
    }
    const g = totalGold();
    if (g > 0 && state.gold >= 0 && g > state.gold)
      return { ok: false, why: 'You carry ' + fmtNum(state.gold) + ' g — this craft costs ' + fmtNum(g) + ' g' };
    return { ok: true, why: '' };
  }

  /* ============================================================== craft == */

  function craftPayload() {
    return {
      name: ui.name.trim(),
      override: !!ui.override,
      school: ui.override ? ui.ovSchool : 5,
      overrideBase: (ui.override && ui.ovBase)
        ? { plugin: ui.ovBase.plugin, localId: ui.ovBase.localId >>> 0 } : null,
      effects: ui.basket.map(function (e) {
        return {
          srcSpell: e.srcSpell,
          mgef: e.mgef,
          mag: Number(e.mag) || 0,
          area: Number(e.area) || 0,
          dur: Number(e.dur) || 0,
          cost: effCost(e),          // the FLOAT — display rounds, the wire doesn't
        };
      }),
    };
  }

  function doCraft() {
    toGame('scCraft', JSON.stringify(craftPayload()));
  }

  function tryCraft() {
    const gate = craftGate();
    if (!gate.ok) return;
    if (!ui.name.trim()) {
      openConfirm(
        'Craft it unnamed?',
        'The spell will land without a name. You can erase it and craft again with one.',
        'Craft unnamed', doCraft);
      return;
    }
    doCraft();
  }

  /* ============================================================= render == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtNum(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmt2(n) {
    /* settings dials: show up to 2 decimals without float dust */
    return String(Math.round((Number(n) || 0) * 100) / 100);
  }

  /* ---- shell (built once — the inputs must survive repaints) ------------ */

  let domBuilt = false;
  function ensureDom() {
    if (domBuilt) return;
    const pane = $('sc-pane');
    if (!pane) return;
    domBuilt = true;
    pane.innerHTML =
      '<div id="sc-head"></div>' +
      '<div id="sc-absent" class="hidden"></div>' +
      '<div id="sc-main">' +
      '  <div id="sc-grid">' +
      '    <div id="sc-bench" class="sc-col">' +
      '      <div class="sc-col-title">⚒ Your new spell</div>' +
      '      <div class="sc-name-row">' +
      '        <input id="sc-name" type="text" maxlength="60" autocomplete="off" spellcheck="false"' +
      '               placeholder="Name the spell — e.g. \'Stormwrack\'">' +
      '      </div>' +
      '      <div id="sc-basket"></div>' +
      '      <div id="sc-override"></div>' +
      '      <div id="sc-benchfoot"></div>' +
      '    </div>' +
      '    <div id="sc-lib" class="sc-col">' +
      '      <div class="sc-col-title">✦ The library <span id="sc-lib-count"></span></div>' +
      '      <div class="sc-bar">' +
      '        <span class="sc-bar-glyph">⌕</span>' +
      '        <input id="sc-q" type="text" autocomplete="off" spellcheck="false"' +
      '               placeholder="Search spells and effects… (Enter = add top hit)">' +
      '      </div>' +
      '      <div id="sc-lib-body"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div id="sc-crafted-wrap">' +
      '    <div class="sc-col-title sc-crafted-title">✨ Spells you\'ve crafted <span id="sc-crafted-count"></span>' +
      '      <span class="sc-crafted-bar hidden" id="sc-craftedbar">' +
      '        <span class="sc-bar-glyph">⌕</span>' +
      '        <input id="sc-craftedq" type="text" autocomplete="off" spellcheck="false" placeholder="Filter your spells…">' +
      '      </span>' +
      '    </div>' +
      '    <div id="sc-crafted"></div>' +
      '  </div>' +
      '</div>' +
      '<div id="sc-modify" class="hidden">' +
      '  <div id="sc-mx-bar">' +
      '    <span class="sc-bar-glyph">⌕</span>' +
      '    <input id="sc-mx-q" type="text" autocomplete="off" spellcheck="false"' +
      '           placeholder="Search every spell the load order ships — fireball, ward, Apocalypse… (Enter = top hit)">' +
      '  </div>' +
      '  <div id="sc-mx-body"></div>' +
      '</div>' +
      '<div id="sc-sheet" class="hidden"></div>' +
      '<div id="sc-toast" class="sc-toast" role="status" aria-live="polite"></div>';

    const name = $('sc-name');
    name.addEventListener('input', function () {
      ui.name = name.value;
      renderBenchFoot();      // the craft button's confirm path depends on it
    });
    name.addEventListener('keydown', function (e) { e.stopPropagation(); });

    wireLibDelegate($('sc-lib-body'));

    const q = $('sc-q');
    q.addEventListener('input', function () {
      ui.q = q.value.trim();
      ui.libShown = LIB_PAGE;      // a new query starts the reveal over
      renderLibBody();
    });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        addTopHit();
      } else if (e.key === 'Escape') {
        if (q.value) { q.value = ''; ui.q = ''; ui.libShown = LIB_PAGE; renderLibBody(); e.stopPropagation(); }
        /* bare Esc falls through to the palette close, on purpose */
      } else {
        e.stopPropagation();
      }
    });

    const cq = $('sc-craftedq');
    cq.addEventListener('input', function () {
      ui.craftedQ = cq.value.trim();
      renderCraftedGrid();
    });
    cq.addEventListener('keydown', function (e) { e.stopPropagation(); });

    const mq = $('sc-mx-q');
    mq.addEventListener('input', function () {
      mx.q = mq.value.trim();
      if (mx.debT) clearTimeout(mx.debT);
      mx.debT = setTimeout(mxRunQuery, 180);
    });
    mq.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (mx.rows.length) mxOpen(mx.rows[0].id);
      } else if (e.key === 'Escape') {
        if (mx.sel) { mxBack(); e.stopPropagation(); }
        else if (mq.value) { mq.value = ''; mx.q = ''; mxRunQuery(); e.stopPropagation(); }
        /* bare Esc falls through to the palette close, on purpose */
      } else {
        e.stopPropagation();
      }
    });
  }

  function render() {
    ensureDom();
    if (!domBuilt) return;
    const absent = state.present === false;
    const main = $('sc-main');
    const ab = $('sc-absent');
    const mod = $('sc-modify');
    renderHead();
    /* Modify needs no crafting mod — it edits records the ENGINE holds, so it
       renders even when Fourth Era Spell-Crafting is absent. */
    if (ui.mode === 'modify') {
      main.classList.add('hidden');
      ab.classList.add('hidden');
      mod.classList.remove('hidden');
      renderModify();
      return;
    }
    mod.classList.add('hidden');
    if (absent) {
      main.classList.add('hidden');
      ab.classList.remove('hidden');
      renderAbsent();
      return;
    }
    ab.classList.add('hidden');
    main.classList.remove('hidden');
    renderBench();
    renderLib();
    renderCrafted();
  }

  /* ---- header ----------------------------------------------------------- */

  function renderHead() {
    const head = $('sc-head');
    if (!head) return;
    const absent = state.present === false;
    const unknown = state.present === null;

    let html = '<div class="sc-title">Spell Crafting</div>';

    /* Craft ⇄ Modify seg (2026-08-17). Modify carries its edited-count chip on
       the button so the state is visible from either mode. */
    html += '<span id="sc-modeseg" role="tablist" aria-label="Spellcraft mode">' +
      '<button class="sc-mode' + (ui.mode === 'craft' ? ' sc-mode-on' : '') + '" data-mode="craft" ' +
      'title="Design a new spell from effects you know (Fourth Era Spell-Crafting)">⚒ Craft</button>' +
      '<button class="sc-mode' + (ui.mode === 'modify' ? ' sc-mode-on' : '') + '" data-mode="modify" ' +
      'title="Edit any existing spell — magnitude, duration, area. Kept across launches, revertable.">✎ Modify' +
      (mx.count ? ' <span class="sc-mode-count">' + mx.count + '</span>' : '') + '</button></span>';

    if (ui.mode === 'modify') {
      /* Modify: the FESC chips (tome/learning/settings) belong to crafting —
         only the gold-free essentials stay. */
      head.innerHTML = html;
      head.querySelectorAll('.sc-mode').forEach(function (b) {
        b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
      });
      return;
    }

    html += '<span class="sc-chip ' + (absent ? 'sc-chip-bad' : unknown ? '' : 'sc-chip-ok') +
      '" title="' + (absent ? esc(state.reason || 'The mod is not in the load order')
        : 'Fourth Era Spell-Crafting — the mod doing the actual crafting') + '">⚗ Fourth Era Spell-Crafting' +
      (unknown ? ' · …' : absent ? ' · missing' : '') + '</span>';

    if (!absent && !unknown) {
      if (state.hasTome) {
        html += '<span class="sc-chip sc-chip-ok" title="The crafting tome is in your inventory">📖 Tome</span>';
      } else {
        html += '<button class="sc-chip sc-chip-act' + (ui.armedTome ? ' sc-armed' : '') + '" id="sc-tome-btn" title="' +
          (ui.armedTome ? 'Click again — the deck closes while the tome is granted'
            : 'You don\'t carry the crafting tome — get it' +
              (state.settings.tomeCost > 0 ? ' for ' + fmtNum(state.settings.tomeCost) + ' g' : '')) + '">📖 ' +
          (ui.armedTome ? 'Sure? Closes the deck' : 'Get the tome') + '</button>';
      }

      html += '<button class="sc-chip sc-chip-act' + (state.learnMode ? ' sc-chip-gold' : '') + '" id="sc-learn-btn"' +
        ' title="Brew potions at any alchemy bench while ON to learn their effects for crafting">' +
        '🧪 Learning effects ' + (state.learnMode ? 'ON' : 'OFF') + '</button>';

      html += '<span class="sc-gold" title="Your gold — crafting can cost it">🜚 ' +
        (state.gold < 0 ? '?' : fmtNum(state.gold)) + '</span>';

      html += '<button class="sc-chip sc-chip-act" id="sc-settings-btn" title="The mod\'s own crafting dials — shared with its F1 menu">⚙</button>';

      if (!state.dpfPex) {
        html += '<span class="sc-chip sc-chip-warn" title="The mod\'s DPF script piece was not found — crafted spells may not land. Reinstall Fourth Era Spell-Crafting.">⚠ DPF script missing</span>';
      }
    }

    head.innerHTML = html;

    head.querySelectorAll('.sc-mode').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });

    const tome = $('sc-tome-btn');
    if (tome) tome.addEventListener('click', function () {
      if (!ui.armedTome) {
        ui.armedTome = true;
        if (ui.armedTomeT) clearTimeout(ui.armedTomeT);
        ui.armedTomeT = setTimeout(function () { ui.armedTome = false; renderHead(); }, 4000);
        renderHead();
        return;
      }
      if (ui.armedTomeT) { clearTimeout(ui.armedTomeT); ui.armedTomeT = null; }
      toGame('scTome', '');
    });
    const learn = $('sc-learn-btn');
    if (learn) learn.addEventListener('click', function () {
      toGame('scLearn', JSON.stringify({ on: !state.learnMode }));
    });
    const st = $('sc-settings-btn');
    if (st) st.addEventListener('click', openSettings);
  }

  /* ---- absent hero ------------------------------------------------------ */

  function renderAbsent() {
    const ab = $('sc-absent');
    if (!ab) return;
    ab.innerHTML =
      '<div class="sc-hero">' +
      '<img class="sc-hero-img" src="icons/custom/sc-hero.png" alt="" draggable="false" onerror="this.remove()">' +
      '<div class="sc-hero-title">Spell crafting needs its mod</div>' +
      '<div class="sc-hero-sub">' + esc(state.reason ||
        'Fourth Era Spell-Crafting is not in the load order.') + '</div>' +
      '<div class="sc-hero-foot">Install and enable <b>Fourth Era Spell-Crafting</b> (and its DPF requirement), ' +
      'then reopen this tab — the workbench appears on its own.</div>' +
      '</div>';
  }

  /* ---- workbench -------------------------------------------------------- */

  /* Fill-bar percent, rounded to 2 decimals — (55/500)*100 is 11.000000000000002
     in doubles, and that dust would leak into style.width. */
  function pctOf(v, max) {
    const p = max > 0 ? (v / max) * 100 : 0;
    return Math.max(0, Math.min(100, Math.round(p * 100) / 100));
  }

  function statRowHtml(row, stat, label) {
    const max = Number(state.settings.sliderMax) || 500;
    const v = Number(row[stat]) || 0;
    const pct = pctOf(v, max);
    return '<div class="sc-stat" data-stat="' + stat + '">' +
      '<span class="sc-stat-l">' + label + '</span>' +
      '<div class="sc-slider" data-k="' + row.k + '" data-stat="' + stat +
      '" title="Drag to set ' + label.toLowerCase() + ' (0–' + max + ')" role="slider"' +
      ' aria-valuemin="0" aria-valuemax="' + max + '" aria-valuenow="' + v + '">' +
      '<div class="sc-slider-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="sc-step">' +
      '<button class="sc-step-btn" data-k="' + row.k + '" data-stat="' + stat + '" data-d="-1" title="Less">−</button>' +
      '<input class="sc-stat-num" data-k="' + row.k + '" data-stat="' + stat +
      '" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="' + v + '">' +
      '<button class="sc-step-btn" data-k="' + row.k + '" data-stat="' + stat + '" data-d="1" title="More">＋</button>' +
      '</span></div>';
  }

  function benchRowHtml(row) {
    const cost = effCost(row);
    const gold = effGold(row);
    let stats = '';
    if (!row.noMag) stats += statRowHtml(row, 'mag', 'Magnitude');
    if (!row.noArea) stats += statRowHtml(row, 'area', 'Area');
    if (!row.noDur) stats += statRowHtml(row, 'dur', 'Duration');
    if (!stats) stats = '<div class="sc-stat-none">This effect has no tunable numbers.</div>';
    return '<div class="sc-brow' + (ui.flashKey === row.k ? ' sc-flash' : '') +
      '" data-k="' + row.k + '">' +
      '<div class="sc-brow-head">' +
      '<span class="sc-dot" style="background:' + schoolHue(row.school) + '" title="' +
      esc(schoolName(row.school)) + '"></span>' +
      '<span class="sc-brow-name" title="' + esc(row.name) + '">' + esc(row.name) + '</span>' +
      '<span class="sc-brow-src" title="Where this effect came from">' + esc(row.srcName) + '</span>' +
      '<span class="sc-brow-cost" title="Live magicka cost of this effect' +
      (gold > 0 ? ' · plus its gold cost to craft' : '') + '">' +
      '<b>' + fmtNum(Math.round(cost)) + '</b> mag' +
      (gold > 0 ? ' · <b class="sc-goldnum">' + fmtNum(gold) + '</b> g' : '') + '</span>' +
      '<button class="sc-brow-x" data-k="' + row.k + '" title="Take this effect off the bench">✕</button>' +
      '</div>' +
      '<div class="sc-brow-stats">' + stats + '</div>' +
      '</div>';
  }

  function renderBench() {
    const box = $('sc-basket');
    if (!box) return;
    if (!state.loaded && state.present !== false) {
      box.innerHTML = new Array(3).fill(
        '<div class="sc-brow sc-skel"><div class="sc-skel-box sc-skel-w1"></div>' +
        '<div class="sc-skel-box sc-skel-w2"></div></div>').join('');
      renderOverride();
      renderBenchFoot();
      return;
    }
    if (!ui.basket.length) {
      box.innerHTML = '<div class="sc-bench-empty">' +
        '<img class="sc-bench-hero" src="icons/custom/sc-hero.png" alt="" draggable="false" onerror="this.remove()">' +
        '<div class="sc-bench-empty-txt">Nothing on the bench yet. ' +
        'Click a spell in the library — its effects land here, tunable.</div>' +
        '</div>';
    } else {
      box.innerHTML = ui.basket.map(benchRowHtml).join('');
      wireBenchRows(box);
    }
    renderOverride();
    renderBenchFoot();
  }

  function wireBenchRows(box) {
    box.querySelectorAll('.sc-brow-x').forEach(function (b) {
      b.addEventListener('click', function () {
        basketRemove(b.getAttribute('data-k'));
        renderBench();
      });
    });
    box.querySelectorAll('.sc-step-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = b.getAttribute('data-k');
        const stat = b.getAttribute('data-stat');
        const d = parseInt(b.getAttribute('data-d'), 10) || 0;
        const row = basketRow(k);
        if (row) setStat(k, stat, (Number(row[stat]) || 0) + d);
      });
    });
    box.querySelectorAll('.sc-stat-num').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { inp.blur(); }
      });
      inp.addEventListener('change', function () {
        const n = parseInt(String(inp.value).replace(/[^0-9]/g, ''), 10);
        setStat(inp.getAttribute('data-k'), inp.getAttribute('data-stat'), isNaN(n) ? 0 : n);
      });
    });
    /* pointer-drag fill bars (deck law: never <input type=range>) */
    box.querySelectorAll('.sc-slider').forEach(function (bar) {
      const k = bar.getAttribute('data-k');
      const stat = bar.getAttribute('data-stat');
      function fromEvent(e) {
        const r = bar.getBoundingClientRect();
        if (!r.width) return;
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        setStat(k, stat, frac * (Number(state.settings.sliderMax) || 500));
      }
      bar.addEventListener('pointerdown', function (e) {
        if (bar.setPointerCapture) { try { bar.setPointerCapture(e.pointerId); } catch (err) {} }
        bar.classList.add('sc-dragging');
        fromEvent(e);
        function move(ev) { fromEvent(ev); }
        function up() {
          bar.classList.remove('sc-dragging');
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
        }
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
        e.preventDefault();
      });
    });
  }

  /* Keep one row's three control shapes in agreement without a rebuild (the
     drag would otherwise fight the repaint). */
  function syncRowControls(k) {
    const row = basketRow(k);
    if (!row) return;
    const el = document.querySelector('#sc-basket .sc-brow[data-k="' + k + '"]');
    if (!el) return;
    const max = Number(state.settings.sliderMax) || 500;
    ['mag', 'area', 'dur'].forEach(function (stat) {
      const v = Number(row[stat]) || 0;
      const bar = el.querySelector('.sc-slider[data-stat="' + stat + '"]');
      if (bar) {
        const fill = bar.querySelector('.sc-slider-fill');
        if (fill) fill.style.width = pctOf(v, max) + '%';
        bar.setAttribute('aria-valuenow', String(v));
      }
      const num = el.querySelector('.sc-stat-num[data-stat="' + stat + '"]');
      if (num && document.activeElement !== num) num.value = String(v);
    });
    const costEl = el.querySelector('.sc-brow-cost');
    if (costEl) {
      const gold = effGold(row);
      costEl.innerHTML = '<b>' + fmtNum(Math.round(effCost(row))) + '</b> mag' +
        (gold > 0 ? ' · <b class="sc-goldnum">' + fmtNum(gold) + '</b> g' : '');
    }
  }

  /* ---- override card ---------------------------------------------------- */

  function renderOverride() {
    const box = $('sc-override');
    if (!box) return;
    if (!state.loaded && state.present !== false) { box.innerHTML = ''; return; }
    let html = '<div class="sc-ov-card' + (ui.override ? ' sc-ov-on' : '') + '">' +
      '<button class="sc-ov-toggle" id="sc-ov-toggle" aria-pressed="' + (ui.override ? 'true' : 'false') +
      '" title="Choose the spell\'s look, delivery and school yourself instead of inheriting from the costliest effect">' +
      '<span class="sc-ov-box">' + (ui.override ? '✓' : '') + '</span>' +
      'Custom lead effect <span class="sc-ov-sub">(override visuals, delivery &amp; school)</span></button>';
    if (ui.override) {
      html += '<div class="sc-ov-body">' +
        '<div class="sc-ov-schools">' +
        SCHOOLS.map(function (s, i) {
          return '<button class="sc-school-chip' + (ui.ovSchool === i ? ' sc-school-on' : '') +
            '" data-school="' + i + '" style="--sch:' + s[1] + '" title="' + esc(s[0]) + '">' + esc(s[0]) + '</button>';
        }).join('') +
        '</div>' +
        '<button class="sc-ov-base" id="sc-ov-base" title="The known spell whose art, sound and delivery your creation borrows">' +
        (ui.ovBase ? '◈ ' + esc(ui.ovBase.name) : '◈ Base spell for visuals…') + '</button>' +
        '</div>';
    }
    html += '</div>';
    box.innerHTML = html;

    $('sc-ov-toggle').addEventListener('click', function () {
      ui.override = !ui.override;
      renderOverride();
      renderBenchFoot();
    });
    box.querySelectorAll('.sc-school-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.ovSchool = parseInt(b.getAttribute('data-school'), 10);
        renderOverride();
        renderBenchFoot();
      });
    });
    const base = $('sc-ov-base');
    if (base) base.addEventListener('click', openBasePicker);
  }

  /* ---- bench footer (totals + Craft) ------------------------------------ */

  function renderBenchFoot() {
    const foot = $('sc-benchfoot');
    if (!foot) return;
    if (!state.loaded && state.present !== false) { foot.innerHTML = ''; return; }
    const gate = craftGate();
    const mag = totalMagicka();
    const gold = totalGold();
    foot.innerHTML =
      '<div class="sc-totals">' +
      '<span class="sc-total" title="Total magicka the spell will cost to cast">Magicka <b>' +
      fmtNum(Math.round(mag)) + '</b></span>' +
      (Number(state.settings.effectCost) > 0
        ? '<span class="sc-total" title="Gold the craft itself costs (per-effect, truncated — the mod\'s own math)">Gold <b class="sc-goldnum">' +
          fmtNum(gold) + '</b></span>'
        : '') +
      '</div>' +
      (!gate.ok && ui.basket.length
        ? '<div class="sc-gate-why" title="Why the Craft button is off">' + esc(gate.why) + '</div>' : '') +
      '<button id="sc-craft-btn" class="sc-craft"' + (gate.ok ? '' : ' disabled') +
      ' title="' + esc(gate.ok ? 'Craft this spell — the deck closes while it lands' : gate.why) + '">' +
      '⚒ Craft the spell</button>';
    $('sc-craft-btn').addEventListener('click', tryCraft);
  }

  /* ---- library ---------------------------------------------------------- */

  function spellKey(sp) { return String(sp.plugin || '').toLowerCase() + '|' + ((sp.localId >>> 0) || 0); }

  /* The search haystack — built ONCE per row and hung off the row object, not
     rebuilt per keystroke. On a 3,000-spell library the old shape re-lowercased
     and re-concatenated every spell name, every effect name and the school on
     EVERY letter typed; the string work alone was thousands of allocations a
     keystroke. A row object only ever arrives from scOpenData, and
     libCacheReset() runs there, so the cache can never go stale. */
  function hayFor(row, extra) {
    let h = row.__scHay;
    if (h === undefined) {
      h = String(row.name || '').toLowerCase();
      const effs = Array.isArray(row.effects) ? row.effects : [];
      for (let i = 0; i < effs.length; i++) h += ' ' + String(effs[i].name || '').toLowerCase();
      h += extra;
      try { row.__scHay = h; } catch (e) { /* frozen row — fall back to per-call */ }
    }
    return h;
  }

  function spellMatches(sp, toks) {
    if (!toks.length) return true;
    const hay = hayFor(sp, ' ' + schoolName(schoolIdx(sp.school)).toLowerCase());
    for (let t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) === -1) return false;
    return true;
  }

  function alchMatches(a, toks) {
    if (!toks.length) return true;
    const hay = hayFor(a, ' alchemy');
    for (let t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) === -1) return false;
    return true;
  }

  /* Filtered spells in display order: school groups 0-4, then no-school. */
  function visibleSpells() {
    const toks = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    const groups = [[], [], [], [], [], []];   // 5 schools + no-school
    for (let i = 0; i < state.spells.length; i++) {
      const sp = state.spells[i];
      if (!spellMatches(sp, toks)) continue;
      const gi = schoolIdx(sp.school);
      groups[gi >= 0 ? gi : 5].push(sp);
    }
    return groups;
  }

  function visibleAlch() {
    const toks = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    return state.alch.filter(function (a) { return alchMatches(a, toks); });
  }

  /* The Enter target: the first spell in group order, else the first alchemy
     effect. Returns what it added (for the harness). */
  function addTopHit() {
    const groups = visibleSpells();
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].length) { addSpell(groups[g][0]); return groups[g][0]; }
    }
    const al = visibleAlch();
    if (al.length) {
      const r = basketAdd(al[0], null);
      if (r === 'added') renderBench();
      else if (r === 'full') toast('The bench is full — ' + MAX_EFFECTS + ' effects at most', true);
      return al[0];
    }
    return null;
  }

  function effLineHtml(sp, eff, ei) {
    const gi = schoolIdx(eff.school);
    const bits = [];
    if (!eff.noMag) bits.push(fmtNum(eff.mag) + ' pts');
    if (!eff.noDur && Number(eff.dur) > 0) bits.push(fmtNum(eff.dur) + 's');
    if (!eff.noArea && Number(eff.area) > 0) bits.push(fmtNum(eff.area) + 'ft');
    return '<div class="sc-eff' + (eff.gated ? ' sc-gated' : '') + '" data-sp="' + esc(spellKey(sp)) +
      '" data-ei="' + ei + '"' +
      (eff.gated ? ' title="Locked — this effect needs its perk before it can be crafted with"' : '') + '>' +
      '<span class="sc-dot" style="background:' + schoolHue(gi) + '"></span>' +
      '<span class="sc-eff-name" title="' + esc(eff.name || '') + '">' + esc(eff.name || '(effect)') + '</span>' +
      '<span class="sc-eff-meta">' + esc(bits.join(' · ') || '—') +
      (eff.hostile ? ' · <span class="sc-hostile">hostile</span>' : '') + '</span>' +
      (eff.gated ? '<span class="sc-eff-lock">🔒 needs its perk</span>'
        : '<button class="sc-eff-add" title="Add just this effect">＋</button>') +
      '</div>';
  }

  /* Library row art (Rober, 2026-08-15: "the library needs to show spell icons
     … like spell deck does"). Same ladder the crafted cards already use, minus
     the per-spell override map (that store is for spells YOU made): the deck's
     mirrored Spell-Hotbar library first — window.hdSpellIconPath resolves the
     exact (plugin, localId) row out of icons/sh_index.json, else a school/tier
     generic — then the school sigil, then the hued ✦ plate. Feature-detected,
     and a miss on disk collapses to the plate via ICO_ERR, so a rig without the
     icon pool renders exactly what it renders today. */
  /* Tier for the generic fallback: the engine gives no tier on a SPEL, but each
     effect carries the skill level that gates it — the same 0/25/50/75/100
     ladder the vanilla tier names come from. Take the spell's costliest gate. */
  function tierOf(sp) {
    let lv = 0;
    const effs = Array.isArray(sp.effects) ? sp.effects : [];
    for (let i = 0; i < effs.length; i++) lv = Math.max(lv, Number(effs[i].skillLvl) || 0);
    return lv >= 100 ? 'master' : lv >= 75 ? 'expert' : lv >= 50 ? 'adept'
      : lv >= 25 ? 'apprentice' : 'novice';
  }

  /* Destruction art is filed by element. Nothing on the record names it, so
     sniff the spell + effect names; unknown lands on DESTRUCTION_GENERIC_*. */
  const ELEMENTS = [
    ['fire', /fire|flame|burn|incinerat|scorch|ember|inferno/i],
    ['frost', /frost|ice|freez|cold|glacial|winter/i],
    ['shock', /shock|lightning|spark|thunder|storm|volt/i],
  ];
  function elementOf(sp) {
    let hay = String(sp.name || '');
    const effs = Array.isArray(sp.effects) ? sp.effects : [];
    for (let i = 0; i < effs.length; i++) hay += ' ' + String(effs[i].name || '');
    for (let i = 0; i < ELEMENTS.length; i++) if (ELEMENTS[i][1].test(hay)) return ELEMENTS[i][0];
    return '';
  }

  /* The spec HDArt needs to resolve a spell. `override` is the per-spell picture
     YOU chose — HDArt's rung 1 — and everything else feeds its interface ladder
     (exact plugin+localId out of sh_index.json, then a school/tier generic). */
  function spellArtSpec(sp, override) {
    /* A LIBRARY spell carries effect RECORDS (skillLvl is readable, so the tier
       is real); a CRAFTED spell carries effect NAMES, where tierOf would read
       every gate as 0 and wrongly claim Novice. Send no tier there and let
       HDArt use its Adept default — the same rung the old ladder landed on. */
    const effs = Array.isArray(sp.effects) ? sp.effects : [];
    let tier = '';
    for (let i = 0; i < effs.length; i++) {
      if (effs[i] && typeof effs[i] === 'object') { tier = tierOf(sp); break; }
    }
    return {
      kind: 'spell',
      plugin: sp.plugin, localId: sp.localId,
      icon: override || '',
      name: sp.name || '',
      school: String(schoolName(schoolIdx(sp.school))).toLowerCase(),
      element: elementOf(sp),
      tier: tier,
      glyph: '✦',
    };
  }

  /* ONE ladder for both the library rows and the crafted cards:
        HDArt (custom override -> interface icon)  ->  the school sigil  ->  ✦
     HDArt owns the first two rungs, including the exact-form match and the
     archetype-aware generics that used to exist only in the Spell Deck's copy.
     window.hdSpellIconPath is kept purely as a safety net for a view where
     hd-art.js failed to load — without it that rig would lose ALL spell art. */
  function spellArt(sp, override) {
    if (window.HDArt) {
      try { const a = HDArt.for(spellArtSpec(sp, override)); if (a.src) return a.src; }
      catch (e) { /* HDArt is total, but never let art take the pane down */ }
    } else if (override) {
      return override;
    }
    if (typeof window.hdSpellIconPath === 'function') {
      try {
        const p = window.hdSpellIconPath({
          plugin: sp.plugin, localId: sp.localId,
          school: String(schoolName(schoolIdx(sp.school))).toLowerCase(),
          element: elementOf(sp),
          tier: tierOf(sp),
        });
        if (p) return p;
      } catch (e) {}
    }
    return schoolIcon(schoolIdx(sp.school));
  }

  function libIcon(sp) { return spellArt(sp, ''); }

  function libPlateHtml(sp) {
    const gi = schoolIdx(sp.school);
    const icon = libIcon(sp);
    return '<div class="sc-lib-plate' + (icon ? ' sc-has-art' : '') +
      '" style="--sch:' + schoolHue(gi) + '" aria-hidden="true">✦' +
      (icon ? '<img class="sc-lib-img" src="' + esc(icon) + '" alt="" draggable="false"' + ICO_ERR + '>' : '') +
      '</div>';
  }

  /* The row and its effects block are built SEPARATELY so the reconciler can
     key them independently — the effects block appears and disappears with the
     expander while the row (and its already-decoded <img>) stays put. */
  function spellRowHtml(sp) {
    const k = spellKey(sp);
    const effs = Array.isArray(sp.effects) ? sp.effects : [];
    const open = !!ui.expanded[k];
    const allGated = effs.length > 0 && effs.every(function (e) { return e.gated; });
    return '<div class="sc-spell' + (open ? ' sc-open' : '') + (allGated ? ' sc-gated' : '') +
      '" data-sp="' + esc(k) + '"' +
      (allGated ? ' title="Locked — every effect of this spell needs a perk you don\'t have"'
        : ' title="Add all its effects to the bench"') + '>' +
      libPlateHtml(sp) +
      '<div class="sc-spell-main">' +
      '<div class="sc-spell-name">' + esc(sp.name || '(spell)') + '</div>' +
      '<div class="sc-spell-sub">' + esc(castLine(sp) || '—') + '</div>' +
      '</div>' +
      '<span class="sc-effcount" title="' + effs.length + ' effect' + (effs.length === 1 ? '' : 's') + '">' +
      effs.length + '</span>' +
      '<button class="sc-expand" data-sp="' + esc(k) + '" title="' +
      (open ? 'Fold the effects' : 'Pick effects one by one') + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      (open ? '⌃' : '⌄') + '</button>' +
      '</div>';
  }

  function spellEffsHtml(sp) {
    const k = spellKey(sp);
    const effs = Array.isArray(sp.effects) ? sp.effects : [];
    return '<div class="sc-effs" data-owner="' + esc(k) + '">' +
      effs.map(function (e, i) { return effLineHtml(sp, e, i); }).join('') +
      '</div>';
  }

  function renderLib() {
    renderLibCount();
    renderLibBody();
  }

  function renderLibCount() {
    const c = $('sc-lib-count');
    if (!c) return;
    c.textContent = state.loaded
      ? (fmtNum(state.spells.length) + ' spells · ' + fmtNum(state.alch.length) + ' learned')
      : '';
  }

  function renderLibBody() {
    const body = $('sc-lib-body');
    if (!body) return;
    if (!state.loaded && state.present !== false) {
      /* skeleton rows carry the icon plate too, so nothing jumps sideways when
         the real library lands (the rows are 44px-plate tall either way) */
      body.innerHTML = new Array(6).fill(
        '<div class="sc-spell sc-skel"><div class="sc-skel-box sc-skel-lplate"></div>' +
        '<div class="sc-skel-col"><div class="sc-skel-box sc-skel-w1"></div>' +
        '<div class="sc-skel-box sc-skel-w2"></div></div></div>').join('');
      return;
    }
    /* ---- the display list: one flat, keyed array ------------------------
       Everything below reconciles against THIS. Each item is
       {k: cache key, sig: what its HTML depends on, html: builder}. */
    const groups = visibleSpells();
    const alch = visibleAlch();
    const list = [];
    let any = false;
    for (let g = 0; g < groups.length; g++) {
      if (!groups[g].length) continue;
      any = true;
      const gi = g, gn = groups[g].length;
      list.push({ k: 'h' + g, sig: 'h' + gn, html: function () {
        const hue = gi < 5 ? SCHOOLS[gi][1] : NOSCHOOL_HUE;
        const label = gi < 5 ? SCHOOLS[gi][0] : 'No school';
        const gico = gi < 5 ? schoolIcon(gi) : '';
        return '<div class="sc-group-h" style="--sch:' + hue + '">' +
          (gico ? '<img class="sc-sch-ico" src="' + gico + '" alt="" draggable="false" ' +
            'onerror="this.remove()">' : '') +
          esc(label) + ' <b>' + gn + '</b></div>';
      } });
      for (let i = 0; i < groups[g].length; i++) {
        const sp = groups[g][i];
        const k = spellKey(sp);
        const open = !!ui.expanded[k];
        list.push({ k: 's' + k, sig: open ? '1' : '0', html: function () { return spellRowHtml(sp); } });
        if (open) list.push({ k: 'e' + k, sig: '1', html: function () { return spellEffsHtml(sp); } });
      }
    }
    /* alchemy — always its own section so the teaching empty state has a home.
       It rides a SEPARATE tail list so the reveal cap below can never bury it
       behind a thousand spell rows: capping the spells must not make the
       learned effects unreachable. */
    const tail = [];
    tail.push({ k: 'ha', sig: 'a' + alch.length, html: function () {
      return '<div class="sc-group-h sc-group-alch" style="--sch:' + ALCH_HUE + '">Alchemy <b>' +
        alch.length + '</b></div>';
    } });
    if (state.alch.length === 0) {
      tail.push({ k: 'ae', sig: 'none', html: function () {
        return '<div class="sc-alch-empty">Turn on <b>Learning</b> and brew a potion — its effects land here, craftable.</div>';
      } });
    } else if (!alch.length) {
      tail.push({ k: 'ae', sig: 'q' + ui.q, html: function () {
        return '<div class="sc-alch-empty">No learned effect matches “' + esc(ui.q) + '”.</div>';
      } });
    } else {
      any = true;
      for (let i = 0; i < alch.length; i++) {
        const a = alch[i], ai = i;
        tail.push({ k: 'a' + (a.name || ('#' + i)), sig: 'i' + ai, html: function () {
          return '<div class="sc-spell sc-alch-row" data-alch="' + ai + '" title="Add this learned effect to the bench">' +
            '<div class="sc-lib-plate" style="--sch:' + ALCH_HUE + '" aria-hidden="true">⚗</div>' +
            '<div class="sc-spell-main">' +
            '<div class="sc-spell-name">' + esc(a.name || '(effect)') + '</div>' +
            '<div class="sc-spell-sub">' + esc(castLine(a) || 'Learned from a potion') + '</div>' +
            '</div>' +
            (a.hostile ? '<span class="sc-hostile">hostile</span>' : '') +
            '<button class="sc-eff-add" title="Add this effect">＋</button>' +
            '</div>';
        } });
      }
    }
    if (!any && ui.q && !alch.length) {
      list.unshift({ k: 'nomatch', sig: 'q' + ui.q, html: function () {
        return '<div class="sc-lib-empty"><div class="sc-lib-empty-t">Nothing matches</div>' +
          '<div class="sc-lib-empty-s">No spell or effect called “' + esc(ui.q) + '”. Fewer letters?</div></div>';
      } });
    }

    /* ---- the reveal cap --------------------------------------------------
       A full library is thousands of rows, and drawing all of them on every
       keystroke is what made this tab tar. Only the first `libShown` items go
       into the DOM; the footer SAYS how many are held back and reveals the next
       page on a click, and a scroll near the bottom does the same, so the cap
       is invisible in normal use. Order and content are untouched — this
       defers rows, it never drops them. */
    let shown = list;
    if (list.length > ui.libShown) {
      shown = list.slice(0, ui.libShown);
      const held = list.length - ui.libShown;
      shown.push({ k: 'more', sig: 'm' + held, html: function () {
        return '<button class="sc-lib-more" title="Show the next ' + LIB_PAGE +
          ' — or just keep scrolling">＋ ' + fmtNum(held) + ' more spell' +
          (held === 1 ? '' : 's') + ' · show ' + Math.min(LIB_PAGE, held) + '</button>';
      } });
    }
    shown = shown.concat(tail);

    reconcile(body, shown, libNodes);
  }

  /* Keyed DOM reconcile. Walks the desired list against the container's live
     children, reusing every node whose key AND signature are unchanged — so a
     keystroke that only narrows the list creates no elements and re-decodes no
     <img> (an <img> recreated is an <img> re-decoded, which is the whole cost
     in Ultralight). Nodes that fall out of the list stay in the cache,
     detached, ready for the backspace that brings them back. */
  const scTmpl = document.createElement('div');
  function reconcile(host, items, cache) {
    let cur = host.firstChild;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let node = cache.get(it.k);
      if (!node || node.__scSig !== it.sig) {
        scTmpl.innerHTML = it.html();
        node = scTmpl.firstElementChild;
        if (!node) continue;
        scTmpl.removeChild(node);
        node.__scSig = it.sig;
        cache.set(it.k, node);
      }
      if (cur === node) { cur = cur.nextSibling; continue; }
      host.insertBefore(node, cur);          // insertBefore MOVES an attached node
    }
    while (cur) { const nx = cur.nextSibling; host.removeChild(cur); cur = nx; }
  }

  /* Row cache + the O(1) key index. Both are rebuilt from scratch whenever a
     new library lands, which is the only moment either can go stale. */
  let libNodes = new Map();
  let spellIndex = null;
  function libCacheReset() {
    libNodes = new Map();
    spellIndex = null;
    ui.libShown = LIB_PAGE;
  }

  function spellByKey(k) {
    if (!spellIndex) {
      spellIndex = new Map();
      for (let i = 0; i < state.spells.length; i++)
        spellIndex.set(spellKey(state.spells[i]), state.spells[i]);
    }
    return spellIndex.get(k) || null;
  }

  /* ONE delegated listener for the whole library, installed once with the
     shell. The old shape re-attached four listeners per row on every repaint:
     18,400 addEventListener calls across ten keystrokes on a 3,000-spell
     library, every one of them garbage the next keystroke threw away. */
  function wireLibDelegate(body) {
    body.addEventListener('click', function (e) {
      if (e.target.closest('.sc-lib-more')) { revealMore(); return; }

      const exp = e.target.closest('.sc-expand');
      if (exp) {
        e.stopPropagation();
        const k = exp.getAttribute('data-sp');
        ui.expanded[k] = !ui.expanded[k];
        renderLibBody();
        return;
      }

      const line = e.target.closest('.sc-eff');
      if (line && line.parentNode && line.parentNode.classList.contains('sc-effs')) {
        e.stopPropagation();
        const sp = spellByKey(line.getAttribute('data-sp'));
        const ei = parseInt(line.getAttribute('data-ei'), 10) || 0;
        if (!sp || !sp.effects || !sp.effects[ei]) return;
        const r = basketAdd(sp.effects[ei], sp);
        if (r === 'added') renderBench();
        else if (r === 'gated') toast('That effect needs its perk first', true);
        else if (r === 'full') toast('The bench is full — ' + MAX_EFFECTS + ' effects at most', true);
        return;
      }

      const arow = e.target.closest('.sc-alch-row');
      if (arow) {
        const a = visibleAlch()[parseInt(arow.getAttribute('data-alch'), 10) || 0];
        if (!a) return;
        const r = basketAdd(a, null);
        if (r === 'added') renderBench();
        else if (r === 'full') toast('The bench is full — ' + MAX_EFFECTS + ' effects at most', true);
        return;
      }

      const row = e.target.closest('.sc-spell[data-sp]');
      if (row) {
        const sp = spellByKey(row.getAttribute('data-sp'));
        if (sp) addSpell(sp);
      }
    });

    /* Scrolling to the bottom reveals the next page. The library scrolls itself
       on a wide deck and hands its scroll to #sc-main under 980px
       (spellcraft-pane.css), so both are watched — and the ＋ more button
       stays as the affordance that never depends on a scroll event firing. */
    const onScroll = function (e) {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return;
      revealMore();
    };
    body.addEventListener('scroll', onScroll);
    const main = $('sc-main');
    if (main) main.addEventListener('scroll', onScroll);
  }

  function revealMore() {
    const body = $('sc-lib-body');
    if (!body || !body.querySelector('.sc-lib-more')) return;
    ui.libShown += LIB_PAGE;
    renderLibBody();
  }

  /* ---- crafted shelf ---------------------------------------------------- */

  /* The DLL's icons map may key hex with any case/width — normalise once at
     ingest to "plugin(lower)|decimal", look up the same way. */
  function normIconMap(m) {
    const out = {};
    if (!m || typeof m !== 'object') return out;
    for (const k in m) {
      if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
      const bar = String(k).lastIndexOf('|');
      if (bar < 1) continue;
      const dec = parseInt(String(k).slice(bar + 1), 16);
      if (isNaN(dec)) continue;
      out[String(k).slice(0, bar).toLowerCase() + '|' + (dec >>> 0)] = String(m[k] || '');
    }
    return out;
  }

  function iconOverrideFor(c) {
    return state.icons[String(c.plugin || '').toLowerCase() + '|' + ((c.localId >>> 0) || 0)] || '';
  }

  /* Icon ladder (contract): explicit override -> the interface pool -> the
     spell's own SCHOOL glyph (a Destruction spell wears the destruction sigil,
     far richer than a bare ✦) -> '' (a hued ✦ plate for No-school). The first
     two rungs are HDArt's precedence law; the pane owns only the last two. */
  function craftedIcon(c) {
    return spellArt(c, iconOverrideFor(c));
  }

  function craftedKey(c) { return String(c.plugin || '').toLowerCase() + '|' + ((c.localId >>> 0) || 0); }

  function craftedFiltered() {
    const toks = ui.craftedQ.toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return state.crafted.slice();
    return state.crafted.filter(function (c) {
      let hay = String(c.name || '').toLowerCase();
      (c.effects || []).forEach(function (n) { hay += ' ' + String(n).toLowerCase(); });
      for (let t = 0; t < toks.length; t++) if (hay.indexOf(toks[t]) === -1) return false;
      return true;
    });
  }

  /* The shared inline degrade: a picture that is not on disk drops its <img> and
     the has-art class, so the plate's glyph shows through — never a broken box.
     Local copy only for a view where hd-art.js failed to load. */
  const ICO_ERR = window.HDArt ? HDArt.errFor('sc-has-art')
    : ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;sc-has-art&quot;);' +
      'b.removeChild(this);}"';

  function craftedCardHtml(c) {
    const k = craftedKey(c);
    const gi = schoolIdx(c.school);
    const icon = craftedIcon(c);
    const armed = ui.armedErase === k;
    const effLine = (c.effects || []).join(' · ');
    return '<div class="sc-card" data-c="' + esc(k) + '">' +
      '<div class="sc-card-plate' + (icon ? ' sc-has-art' : '') + '" style="--sch:' + schoolHue(gi) + '">✦' +
      (icon ? '<img class="sc-card-img" src="' + esc(icon) + '" alt="" draggable="false"' + ICO_ERR + '>' : '') +
      '</div>' +
      '<div class="sc-card-name" title="' + esc(c.name || '') + '">' + esc(c.name || '(unnamed)') + '</div>' +
      '<div class="sc-card-meta"><span class="sc-school-tag" style="--sch:' + schoolHue(gi) + '">' +
      esc(schoolName(gi)) + '</span></div>' +
      '<div class="sc-card-effs" title="' + esc(effLine) + '">' + esc(effLine || '—') + '</div>' +
      '<div class="sc-card-btns">' +
      '<button class="sc-cbtn sc-cbtn-cast" data-act="cast" title="Close the deck and cast it">Cast</button>' +
      '<button class="sc-cbtn" data-act="deck" title="Put it on the Spell Deck">Add to Spell Deck</button>' +
      '<button class="sc-cbtn" data-act="icon" title="Choose its picture">🖼 Icon</button>' +
      '<button class="sc-cbtn sc-cbtn-erase' + (armed ? ' sc-armed' : '') + '" data-act="erase" title="' +
      (armed ? 'Click again — crafted spells are gone for good; other spells can be re-learned, these cannot'
        : 'Erase this crafted spell (asks twice)') + '">' +
      (armed ? 'Really erase?' : 'Erase') + '</button>' +
      '</div>' +
      (armed ? '<div class="sc-erase-warn">Crafted spells are gone for good — other spells can be re-learned.</div>' : '') +
      '</div>';
  }

  function renderCrafted() {
    const count = $('sc-crafted-count');
    const bar = $('sc-craftedbar');
    if (count) count.textContent = state.loaded ? String(state.crafted.length || '') : '';
    if (bar) bar.classList.toggle('hidden', state.crafted.length < 8);   // filter appears at 8+
    renderCraftedGrid();
  }

  function renderCraftedGrid() {
    const grid = $('sc-crafted');
    if (!grid) return;
    if (!state.loaded && state.present !== false) {
      grid.innerHTML = new Array(3).fill(
        '<div class="sc-card sc-skel"><div class="sc-skel-box sc-skel-plate"></div>' +
        '<div class="sc-skel-box sc-skel-w1"></div></div>').join('');
      return;
    }
    if (!state.crafted.length) {
      grid.innerHTML = '<div class="sc-crafted-empty">Nothing crafted yet — your first creation lands here, ' +
        'castable and pinnable like any other spell.</div>';
      return;
    }
    const list = craftedFiltered();
    if (!list.length) {
      grid.innerHTML = '<div class="sc-crafted-empty">None of your spells match “' + esc(ui.craftedQ) + '”.</div>';
      return;
    }
    grid.innerHTML = list.map(craftedCardHtml).join('');
    grid.querySelectorAll('.sc-card').forEach(function (card) {
      const k = card.getAttribute('data-c');
      function crafted() {
        for (let i = 0; i < state.crafted.length; i++)
          if (craftedKey(state.crafted[i]) === k) return state.crafted[i];
        return null;
      }
      card.querySelectorAll('.sc-cbtn').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          const c = crafted();
          if (!c) return;
          const act = b.getAttribute('data-act');
          if (act === 'cast') castCrafted(c);
          else if (act === 'deck') toGame('scDeck', JSON.stringify({ plugin: c.plugin, localId: c.localId >>> 0 }));
          else if (act === 'icon') openIconSheet(c);
          else if (act === 'erase') eraseClick(c);
        });
      });
    });
  }

  /* Casting reuses the EXISTING omni cast bridge — closes the palette and
     casts, zero new C++ (contract). */
  function castCrafted(c) {
    toGame('hdOmniCast', JSON.stringify({
      kind: 'spell', name: c.name || '',
      plugin: c.plugin || '', localId: c.localId >>> 0, formId: (c.formId >>> 0) || 0,
    }));
  }

  function eraseClick(c) {
    const k = craftedKey(c);
    if (ui.armedErase !== k) {
      ui.armedErase = k;
      if (ui.armedEraseT) clearTimeout(ui.armedEraseT);
      ui.armedEraseT = setTimeout(function () {
        ui.armedErase = '';
        if (ui.visible) renderCraftedGrid();
      }, 4000);
      renderCraftedGrid();
      return;
    }
    if (ui.armedEraseT) { clearTimeout(ui.armedEraseT); ui.armedEraseT = null; }
    toGame('scErase', JSON.stringify({ plugin: c.plugin, localId: c.localId >>> 0 }));
  }

  /* ============================================================= sheets == */
  /* All popups mount INSIDE the pane section (the ix-sheet idiom): #sc-sheet
     is an absolute overlay over #sc-pane, so --ui-scale needs no dividing. */

  function openSheetBox(kind, innerHtml) {
    const sh = $('sc-sheet');
    if (!sh) return null;
    ui.sheet = { kind: kind };
    sh.classList.remove('hidden');
    sh.innerHTML = '<div class="sc-sheet-card">' + innerHtml + '</div>';
    sh.onclick = function (e) { if (e.target === sh) closeSheet(); };
    return sh;
  }

  function closeSheet() {
    ui.sheet = null;
    const sh = $('sc-sheet');
    if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; sh.onclick = null; }
  }

  /* ---- generic confirm -------------------------------------------------- */

  function openConfirm(title, sub, okLabel, onOk) {
    const sh = openSheetBox('confirm',
      '<div class="sc-sheet-title">' + esc(title) + '</div>' +
      '<div class="sc-sheet-sub">' + esc(sub) + '</div>' +
      '<div class="sc-sheet-actions">' +
      '<button class="sc-btn" id="sc-conf-no">Cancel</button>' +
      '<button class="sc-btn sc-btn-primary" id="sc-conf-yes">' + esc(okLabel) + '</button>' +
      '</div>');
    if (!sh) return;
    $('sc-conf-no').addEventListener('click', closeSheet);
    $('sc-conf-yes').addEventListener('click', function () { closeSheet(); onOk(); });
  }

  /* ---- base-spell picker ------------------------------------------------ */

  function openBasePicker() {
    const sh = openSheetBox('base',
      '<div class="sc-sheet-title">Base spell for visuals</div>' +
      '<div class="sc-sheet-sub">Your creation borrows this spell\'s art, sound and delivery.</div>' +
      '<div class="sc-bar sc-sheet-bar"><span class="sc-bar-glyph">⌕</span>' +
      '<input id="sc-base-q" type="text" autocomplete="off" spellcheck="false" placeholder="Search your known spells… (Enter = top hit)"></div>' +
      '<div class="sc-base-list" id="sc-base-list"></div>' +
      '<div class="sc-sheet-actions"><button class="sc-btn" id="sc-base-cancel">Cancel</button></div>');
    if (!sh) return;
    const input = $('sc-base-q');
    const list = $('sc-base-list');

    function candidates() {
      const toks = String(input ? input.value : '').toLowerCase().split(/\s+/).filter(Boolean);
      return state.spells.filter(function (sp) { return spellMatches(sp, toks); });
    }
    function paint() {
      const rows = candidates();
      if (!rows.length) {
        list.innerHTML = '<div class="sc-lib-empty-s">No known spell matches.</div>';
        return;
      }
      list.innerHTML = rows.slice(0, 60).map(function (sp, i) {
        const gi = schoolIdx(sp.school);
        return '<div class="sc-base-row' + (i === 0 ? ' sc-base-top' : '') + '" data-i="' + i + '">' +
          '<span class="sc-dot" style="background:' + schoolHue(gi) + '"></span>' +
          '<span class="sc-base-name">' + esc(sp.name || '(spell)') + '</span>' +
          '<span class="sc-base-sub">' + esc(castLine(sp)) + '</span>' +
          '</div>';
      }).join('');
      list.querySelectorAll('.sc-base-row').forEach(function (row) {
        row.addEventListener('click', function () {
          pickBase(candidates()[parseInt(row.getAttribute('data-i'), 10) || 0]);
        });
      });
    }
    if (input) {
      input.addEventListener('input', paint);
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); pickBase(candidates()[0]); }
        else if (e.key === 'Escape') closeSheet();
      });
      setTimeout(function () { input.focus(); }, 30);
    }
    $('sc-base-cancel').addEventListener('click', closeSheet);
    paint();
  }

  function pickBase(sp) {
    if (!sp) return;
    ui.ovBase = { plugin: sp.plugin || '', localId: (sp.localId >>> 0) || 0, name: sp.name || '' };
    closeSheet();
    renderOverride();
    renderBenchFoot();
  }

  /* ---- icon sheet ------------------------------------------------------- */

  /* Pool: any icon already overriding a crafted spell, plus whatever custom-
     icon list the deck exposes (feature-detected — none today, so the sheet
     says so honestly and offers the typeable path row). */
  function iconPool() {
    const seen = {};
    const out = [];
    for (const k in state.icons) {
      const p = state.icons[k];
      if (p && !seen[p]) { seen[p] = 1; out.push({ file: p, label: '' }); }
    }
    try {
      if (window.HDDeckIcons && typeof window.HDDeckIcons.list === 'function') {
        (window.HDDeckIcons.list() || []).forEach(function (c) {
          const f = c && (c.file || c.path);
          if (f && !seen[f]) { seen[f] = 1; out.push({ file: f, label: c.label || '' }); }
        });
      }
    } catch (e) { /* feature-detect only */ }
    return out;
  }

  /* View-relative icons/... paths only — same guard everywhere else uses. */
  function validIconPath(p) {
    p = String(p || '');
    if (!/^icons\//.test(p)) return false;
    if (p.indexOf('..') !== -1 || p.indexOf(':') !== -1 || p.indexOf('\\') !== -1) return false;
    return true;
  }

  function sendIcon(c, icon) {
    ui.pendingIcon = { plugin: c.plugin || '', localId: (c.localId >>> 0) || 0, icon: String(icon || '') };
    toGame('scIcon', JSON.stringify(ui.pendingIcon));
    closeSheet();
  }

  function openIconSheet(c) {
    const pool = iconPool();
    const cur = iconOverrideFor(c);
    let tiles = '<button class="sc-ico-tile sc-ico-auto' + (cur ? '' : ' sc-ico-on') +
      '" data-auto="1" title="No override — the deck picks the picture on its own">Auto</button>';
    tiles += pool.map(function (p, i) {
      return '<button class="sc-ico-tile' + (cur === p.file ? ' sc-ico-on' : '') + '" data-i="' + i +
        '" title="' + esc(p.label || p.file) + '">' +
        '<img src="' + esc(p.file) + '" alt="" draggable="false"' + ICO_ERR + '></button>';
    }).join('');
    const sh = openSheetBox('icon',
      '<div class="sc-sheet-title">Icon for “' + esc(c.name || '(unnamed)') + '”</div>' +
      (pool.length > 8
        ? '<div class="sc-bar sc-sheet-bar"><span class="sc-bar-glyph">⌕</span>' +
          '<input id="sc-ico-q" type="text" autocomplete="off" spellcheck="false" placeholder="Filter icons…"></div>'
        : '') +
      '<div class="sc-ico-grid" id="sc-ico-grid">' + tiles + '</div>' +
      (pool.length === 0
        ? '<div class="sc-sheet-sub">The deck exposes no icon library to this tab yet — paste a view-relative path instead.</div>'
        : '') +
      '<div class="sc-ico-pathrow">' +
      '<input id="sc-ico-path" type="text" autocomplete="off" spellcheck="false" placeholder="icons/custom/my-spell.png">' +
      '<button class="sc-btn" id="sc-ico-use" title="Use this view-relative path (must start with icons/)">Use</button>' +
      '</div>' +
      '<div class="sc-ico-patherr hidden" id="sc-ico-patherr">Paths must be view-relative and start with <b>icons/</b>.</div>' +
      '<div class="sc-sheet-actions"><button class="sc-btn" id="sc-ico-cancel">Cancel</button></div>');
    if (!sh) return;
    ui.sheet.crafted = c;

    function wireTiles() {
      sh.querySelectorAll('.sc-ico-tile').forEach(function (t) {
        t.addEventListener('click', function () {
          if (t.getAttribute('data-auto')) { sendIcon(c, ''); return; }
          const p = iconPool()[parseInt(t.getAttribute('data-i'), 10) || 0];
          if (p) sendIcon(c, p.file);
        });
      });
    }
    wireTiles();
    const q = $('sc-ico-q');
    if (q) {
      q.addEventListener('keydown', function (e) { e.stopPropagation(); });
      q.addEventListener('input', function () {
        const f = q.value.trim().toLowerCase();
        sh.querySelectorAll('.sc-ico-tile').forEach(function (t) {
          if (t.getAttribute('data-auto')) return;
          const hay = (t.getAttribute('title') || '').toLowerCase();
          t.classList.toggle('hidden', !!f && hay.indexOf(f) === -1);
        });
      });
    }
    const path = $('sc-ico-path');
    const use = $('sc-ico-use');
    const err = $('sc-ico-patherr');
    if (path) path.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') use.click();
      if (e.key === 'Escape') closeSheet();
    });
    use.addEventListener('click', function () {
      const p = path.value.trim();
      if (!validIconPath(p)) { err.classList.remove('hidden'); return; }
      err.classList.add('hidden');
      sendIcon(c, p);
    });
    $('sc-ico-cancel').addEventListener('click', closeSheet);
  }

  /* ---- settings sheet --------------------------------------------------- */

  /* Steppers + typeable numbers, per the deck law. The dials are the MOD's own
     (shared with its F1 menu) — the sheet says so, and that saving closes the
     deck for a moment (the mod applies them game-side). */
  const SETTING_DEFS = [
    ['effectCost', 'Gold per magicka', 1, 0, 1000, 'Crafting cost: every point of an effect\'s magicka costs this much gold (0 = free)'],
    ['tomeCost', 'Tome price', 10, 0, 100000, 'What the crafting tome costs to get'],
    ['sliderMax', 'Stat ceiling', 50, 50, 5000, 'The highest magnitude / area / duration the bench allows'],
    ['magExp', 'Magnitude exponent', 0.05, 0.05, 5, 'How steeply cost grows with magnitude (the mod\'s magExp)'],
    ['dMult', 'Cost multiplier', 0.05, 0.05, 10, 'Global cost multiplier (the mod\'s dMult)'],
    ['aMult', 'Area divisor', 0.05, 0.05, 500, 'Area is divided by this before it multiplies cost (the mod\'s aMult)'],
  ];

  function openSettings() {
    const pending = {};
    for (const k in state.settings) pending[k] = state.settings[k];
    const rows = SETTING_DEFS.map(function (d) {
      return '<div class="sc-set-row" title="' + esc(d[5]) + '">' +
        '<span class="sc-set-l">' + esc(d[1]) + '</span>' +
        '<span class="sc-step">' +
        '<button class="sc-step-btn" data-set="' + d[0] + '" data-d="-1" title="Less">−</button>' +
        '<input class="sc-set-num" id="sc-set-' + d[0] + '" type="text" inputmode="decimal" autocomplete="off"' +
        ' spellcheck="false" value="' + fmt2(pending[d[0]]) + '">' +
        '<button class="sc-step-btn" data-set="' + d[0] + '" data-d="1" title="More">＋</button>' +
        '</span></div>';
    }).join('');
    const sh = openSheetBox('settings',
      '<div class="sc-sheet-title">Crafting settings</div>' +
      '<div class="sc-sheet-sub">These are the MOD\'s own settings, shared with its F1 menu.</div>' +
      rows +
      '<div class="sc-set-row" title="Only effects whose school perk you own can be crafted with">' +
      '<span class="sc-set-l">Must know the perk</span>' +
      '<button class="sc-chip sc-chip-act" id="sc-set-perk"></button></div>' +
      '<div class="sc-set-preview" id="sc-set-preview"></div>' +
      '<div class="sc-sheet-note">Saving closes the deck for a moment while the mod takes the new dials.</div>' +
      '<div class="sc-sheet-actions">' +
      '<button class="sc-btn" id="sc-set-cancel">Cancel</button>' +
      '<button class="sc-btn sc-btn-primary" id="sc-set-save">Save</button>' +
      '</div>');
    if (!sh) return;
    ui.sheet.pending = pending;

    function paintPerk() {
      const b = $('sc-set-perk');
      b.textContent = pending.mustKnowPerk ? '✓ Required' : 'Not required';
      b.classList.toggle('sc-chip-gold', !!pending.mustKnowPerk);
    }
    function paintPreview() {
      /* one live sample so the dials mean something at a glance */
      const sample = { D: 1, mag: 25, dur: 10, area: 0, ogDur: 10, ogArea: 0 };
      const cst = effCost(sample, pending);
      const g = Number(pending.effectCost) > 0 ? Math.trunc(Number(pending.effectCost) * cst) : 0;
      $('sc-set-preview').textContent = 'Sample effect (25 mag · 10 s · no area): ' +
        fmtNum(Math.round(cst)) + ' magicka' + (g > 0 ? ' · ' + fmtNum(g) + ' g to craft' : '');
    }
    function clampSet(key, v) {
      const d = SETTING_DEFS.filter(function (x) { return x[0] === key; })[0];
      if (!d) return v;
      v = Number(v);
      if (isNaN(v)) v = d[3];
      return Math.max(d[3], Math.min(d[4], Math.round(v * 100) / 100));
    }
    sh.querySelectorAll('.sc-step-btn[data-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        const key = b.getAttribute('data-set');
        const d = SETTING_DEFS.filter(function (x) { return x[0] === key; })[0];
        const dir = parseInt(b.getAttribute('data-d'), 10) || 0;
        pending[key] = clampSet(key, (Number(pending[key]) || 0) + dir * d[2]);
        $('sc-set-' + key).value = fmt2(pending[key]);
        paintPreview();
      });
    });
    SETTING_DEFS.forEach(function (d) {
      const inp = $('sc-set-' + d[0]);
      inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', function () {
        pending[d[0]] = clampSet(d[0], parseFloat(String(inp.value).replace(/[^0-9.]/g, '')));
        inp.value = fmt2(pending[d[0]]);
        paintPreview();
      });
    });
    $('sc-set-perk').addEventListener('click', function () {
      pending.mustKnowPerk = !pending.mustKnowPerk;
      paintPerk();
    });
    $('sc-set-cancel').addEventListener('click', closeSheet);
    $('sc-set-save').addEventListener('click', function () {
      toGame('scSettings', JSON.stringify({
        tomeCost: Number(pending.tomeCost) || 0,
        effectCost: Number(pending.effectCost) || 0,
        mustKnowPerk: !!pending.mustKnowPerk,
        magExp: Number(pending.magExp) || 1,
        dMult: Number(pending.dMult) || 1,
        aMult: Number(pending.aMult) || 1,
        sliderMax: Number(pending.sliderMax) || 500,
      }));
    });
    paintPerk();
    paintPreview();
  }

  /* =============================================================== toast == */

  /* ======================================================= Modify mode == */
  /* spell_edit.cpp's front — search every spell the order ships, open one,
     edit its effects' mag/dur/area, apply/revert. Draft law: typed values
     survive re-renders via mx.draft (the Finder Modify sheet's rule). */

  const mx = {
    q: '', seq: 0, rows: [], total: 0, awaiting: false, debT: null,
    sel: '',                // id of the spell open in the detail card
    data: null,             // sxGetResult payload for sel
    draft: {},              // "e<i>:mag|dur|area" -> typed value
    busy: false,
    count: 0,               // edited-spell count (sxListResult) for the seg chip
  };

  function setMode(m) {
    if (m !== 'craft' && m !== 'modify') return;
    if (ui.mode === m) return;
    ui.mode = m;
    if (m === 'modify') {
      toGame('sxList', '');
      render();
      const mq = $('sc-mx-q');
      if (mq) setTimeout(function () { mq.focus(); }, 30);
    } else {
      render();
      const q = $('sc-q');
      if (q) setTimeout(function () { q.focus(); }, 30);
    }
  }

  function mxRunQuery() {
    if (!mx.q) { mx.rows = []; mx.total = 0; mx.awaiting = false; renderModify(); return; }
    mx.seq++;
    mx.awaiting = true;
    toGame('sxQuery', JSON.stringify({ q: mx.q, seq: mx.seq, limit: 40 }));
    renderModify();
  }

  function mxOpen(id) {
    mx.sel = id;
    mx.data = null;
    mx.draft = {};
    mx.busy = false;
    renderModify();
    toGame('sxGet', JSON.stringify({ id: id }));
  }

  function mxBack() {
    mx.sel = '';
    mx.data = null;
    mx.draft = {};
    renderModify();
    const mq = $('sc-mx-q');
    if (mq) setTimeout(function () { mq.focus(); }, 30);
  }

  function mxCaptureDraft() {
    const body = $('sc-mx-body');
    if (!body) return;
    body.querySelectorAll('.sc-mx-num').forEach(function (input) {
      mx.draft[input.getAttribute('data-k')] = input.value;
    });
  }

  window.sxResultData = function (d) {
    d = parseReply(d);
    if (!d || (d.seq | 0) !== mx.seq) return;
    mx.awaiting = false;
    mx.rows = Array.isArray(d.spells) ? d.spells : [];
    mx.total = d.total | 0;
    if (ui.visible && ui.mode === 'modify' && !mx.sel) renderModify();
  };

  window.sxGetResult = function (d) {
    d = parseReply(d);
    if (!d || !mx.sel || d.id !== mx.sel) return;
    if (!d.ok) { toast(d.msg || 'Could not read that spell', true); mxBack(); return; }
    mx.data = d;
    if (ui.visible && ui.mode === 'modify') renderModify();
  };

  function mxLanded(d) {
    d = parseReply(d);
    if (!d) return;
    mx.busy = false;
    if (!d.ok) { toast(d.msg || 'Failed', true); if (ui.visible) renderModify(); return; }
    toast(d.msg || 'Done', false);
    if (typeof d.count === 'number') mx.count = d.count;
    if (mx.sel && d.id === mx.sel) {
      mx.data = d;
      mx.draft = {};
    }
    /* the row list's ✎ flags may have changed */
    for (let i = 0; i < mx.rows.length; i++)
      if (mx.rows[i].id === d.id)
        mx.rows[i].edited = Array.isArray(d.edited) && d.edited.length > 0;
    if (ui.visible && ui.mode === 'modify') { renderModify(); renderHead(); }
  }

  window.sxApplyResult = function (d) { mxLanded(d); };
  window.sxRevertResult = function (d) { mxLanded(d); };

  window.sxListResult = function (d) {
    d = parseReply(d);
    if (!d) return;
    mx.count = d.count | 0;
    if (ui.visible) renderHead();
  };

  function mxRowHtml(s, top) {
    const si = schoolIdx(s.school);
    const hue = schoolHue(si);
    return '<div class="sc-mx-row' + (top ? ' sc-mx-top' : '') + '" data-id="' + esc(s.id) + '">' +
      '<span class="sc-mx-school" style="color:' + hue + ';border-color:' + hue + '44">' +
      esc(s.school || s.type || 'Spell') + '</span>' +
      '<span class="sc-mx-name" title="' + esc(s.n) + '">' + esc(s.n) +
      (s.edited ? '<span class="sc-mx-chip" title="Carries Modify edits">✎</span>' : '') + '</span>' +
      '<span class="sc-mx-meta">' + esc(s.type || '') + ' · ' + (s.effs | 0) + ' effect' + ((s.effs | 0) === 1 ? '' : 's') + '</span>' +
      '<span class="sc-mx-plug" title="' + esc(s.p) + '">' + esc(s.p) + '</span>' +
      '</div>';
  }

  function mxNumCell(effIdx, field, label, cur, origVal) {
    const k = 'e' + effIdx + ':' + field;
    const shown = mx.draft[k] !== undefined ? mx.draft[k]
      : (Math.round(Number(cur) * 100) / 100);
    return '<span class="sc-mx-cell">' +
      '<span class="sc-mx-cl">' + label + '</span>' +
      '<input class="sc-mx-num" data-k="' + k + '" type="text" inputmode="decimal" ' +
      'autocomplete="off" spellcheck="false" value="' + esc(String(shown)) + '">' +
      (origVal !== undefined && origVal !== null
        ? '<span class="sc-mx-was" title="Before any Modify edit — Revert restores it">was ' + origVal + '</span>'
        : '<span class="sc-mx-was"></span>') +
      '</span>';
  }

  function renderModify() {
    const body = $('sc-mx-body');
    if (!body) return;

    /* detail card */
    if (mx.sel) {
      if (!mx.data) {
        body.innerHTML = '<div class="sc-mx-load">Reading the spell…</div>';
        return;
      }
      const d = mx.data;
      const orig = d.orig || {};
      const editedN = Array.isArray(d.edited) ? d.edited.length : 0;
      const si = schoolIdx(d.school);
      let html =
        '<div class="sc-mx-card">' +
        '<div class="sc-mx-cardhead">' +
        '<button id="sc-mx-back" class="sc-mx-btn" title="Back to the results">‹ Back</button>' +
        '<span class="sc-mx-cardname" title="' + esc(d.n) + '">' + esc(d.n) + '</span>' +
        '<span class="sc-mx-school" style="color:' + schoolHue(si) + '">' + esc(d.school || d.type || '') + '</span>' +
        '<span class="sc-mx-meta">' + esc(d.plugin || '') +
        (typeof d.cost === 'number' && d.cost > 0 ? ' · ' + Math.round(d.cost) + ' magicka' : '') + '</span>' +
        (editedN ? '<span class="sc-mx-chip">✎ ' + editedN + ' effect' + (editedN === 1 ? '' : 's') + ' edited</span>' : '') +
        '</div>' +
        '<div class="sc-mx-warn">Rewrites the spell itself — everyone who casts it, every save. ' +
        'Kept across launches; Revert restores the originals.</div>';

      const effs = Array.isArray(d.effects) ? d.effects : [];
      if (!effs.length) {
        html += '<div class="sc-mx-load">This spell lists no editable effects.</div>';
      }
      effs.forEach(function (e) {
        const o = orig['e' + e.i];
        html += '<div class="sc-mx-eff' + (e.harm ? ' sc-mx-harm' : '') + '">' +
          '<div class="sc-mx-effname" title="' + esc(e.n) + '">' + esc(e.n) +
          (e.school ? '<span class="sc-mx-effschool">' + esc(e.school) + '</span>' : '') + '</div>' +
          '<div class="sc-mx-cells">' +
          mxNumCell(e.i, 'mag', 'Magnitude', e.mag, o ? o.mag : undefined) +
          mxNumCell(e.i, 'dur', 'Duration s', e.dur, o ? o.dur : undefined) +
          mxNumCell(e.i, 'area', 'Area ft', e.area, o ? o.area : undefined) +
          '</div></div>';
      });

      html += '<div class="sc-mx-acts">' +
        (editedN ? '<button id="sc-mx-revert" class="sc-mx-btn sc-mx-revert" title="Restore every original number and forget the edits">↺ Revert all</button>' : '') +
        '<span class="sc-mx-gap"></span>' +
        '<button id="sc-mx-apply" class="sc-mx-apply"' + (mx.busy ? ' disabled' : '') + '>' +
        (mx.busy ? 'Applying…' : 'Apply changes') + '</button>' +
        '</div></div>';
      body.innerHTML = html;

      $('sc-mx-back').addEventListener('click', mxBack);
      const ap = $('sc-mx-apply');
      if (ap) ap.addEventListener('click', mxApply);
      const rv = $('sc-mx-revert');
      if (rv) rv.addEventListener('click', function () {
        if (mx.busy) return;
        mx.busy = true;
        renderModify();
        toGame('sxRevert', JSON.stringify({ id: mx.sel }));
      });
      body.querySelectorAll('.sc-mx-num').forEach(function (input) {
        input.addEventListener('keydown', function (e) {
          e.stopPropagation();
          if (e.key === 'Enter') mxApply();
          if (e.key === 'Escape') mxBack();
        });
      });
      return;
    }

    /* results / hero */
    if (!mx.q) {
      body.innerHTML =
        '<div class="sc-mx-hero">' +
        '<div class="sc-hero-title">Rewrite any spell</div>' +
        '<div class="sc-hero-sub">Type a spell above — yours, a follower\'s, a mod\'s. ' +
        'Open it and turn its magnitude, duration and area into what they should have been. ' +
        'Every change is saved across launches and revertable.</div>' +
        '</div>';
      return;
    }
    if (mx.awaiting && !mx.rows.length) {
      body.innerHTML = '<div class="sc-mx-load">Searching…</div>';
      return;
    }
    if (!mx.rows.length) {
      body.innerHTML = '<div class="sc-mx-load">No spell matches “' + esc(mx.q) + '”.</div>';
      return;
    }
    body.innerHTML =
      '<div class="sc-mx-count">' + fmtNum(mx.total) + ' match' + (mx.total === 1 ? '' : 'es') +
      (mx.total > mx.rows.length ? ' · showing the best ' + mx.rows.length : '') + '</div>' +
      mx.rows.map(function (s, i) { return mxRowHtml(s, i === 0); }).join('');
    body.querySelectorAll('.sc-mx-row').forEach(function (row) {
      row.addEventListener('click', function () { mxOpen(row.getAttribute('data-id')); });
    });
  }

  /* Only effects whose numbers DIFFER go on the wire; each carries its full
     {mag,dur,area} triple so the C++ replay restores all three coherently. */
  function mxApply() {
    if (!mx.data || mx.busy) return;
    mxCaptureDraft();
    const set = {};
    (mx.data.effects || []).forEach(function (e) {
      const read = function (field, cur) {
        const raw = mx.draft['e' + e.i + ':' + field];
        if (raw === undefined) return Number(cur);
        const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
        return isNaN(n) || n < 0 ? Number(cur) : n;
      };
      const mag = read('mag', e.mag), dur = read('dur', e.dur), area = read('area', e.area);
      if (Math.abs(mag - e.mag) > 1e-3 || Math.abs(dur - e.dur) > 1e-3 || Math.abs(area - e.area) > 1e-3)
        set['e' + e.i] = { mag: mag, dur: dur, area: area };
    });
    if (!Object.keys(set).length) { toast('Nothing changed', false); return; }
    mx.busy = true;
    renderModify();
    toGame('sxApply', JSON.stringify({ id: mx.sel, set: set }));
  }

  /* ---- Modify dev fixtures --------------------------------------------- */
  const DEV_SX = {
    'Skyrim.esm|01C789': { n: 'Fireball', type: 'Spell', school: 'Destruction', p: 'Skyrim.esm',
      effects: [
        { i: 0, n: 'Fire Damage', mag: 40, dur: 0, area: 15, harm: true, school: 'Destruction' } ] },
    'Skyrim.esm|012FCD': { n: 'Candlelight', type: 'Spell', school: 'Alteration', p: 'Skyrim.esm',
      effects: [
        { i: 0, n: 'Candlelight', mag: 0, dur: 60, area: 0, harm: false, school: 'Alteration' } ] },
  };
  const DEV_SX_STORE = {};   // id -> {set,orig}

  function devSxState(id) {
    const f = DEV_SX[id];
    const st = DEV_SX_STORE[id];
    return { ok: true, id: id, n: f.n, plugin: f.p, type: f.type, school: f.school, cost: 133,
      effects: JSON.parse(JSON.stringify(f.effects)),
      orig: st ? st.orig : undefined,
      edited: st ? Object.keys(st.set) : [], count: Object.keys(DEV_SX_STORE).length };
  }

  function devSxQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const q = String(req.q || '').toLowerCase();
    const rows = Object.keys(DEV_SX).filter(function (id) {
      return DEV_SX[id].n.toLowerCase().indexOf(q) !== -1;
    }).map(function (id) {
      const f = DEV_SX[id];
      return { id: id, n: f.n, type: f.type, school: f.school, p: f.p,
        effs: f.effects.length, edited: !!DEV_SX_STORE[id] };
    });
    window.sxResultData({ seq: req.seq | 0, total: rows.length, spells: rows });
  }

  function devSxGet(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    window.sxGetResult(DEV_SX[req.id] ? devSxState(req.id) : { ok: false, id: req.id, msg: 'No fixture' });
  }

  function devSxApply(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const f = DEV_SX[req.id];
    if (!f) { window.sxApplyResult({ ok: false, id: req.id, msg: 'No fixture' }); return; }
    const st = DEV_SX_STORE[req.id] || (DEV_SX_STORE[req.id] = { set: {}, orig: {} });
    Object.keys(req.set || {}).forEach(function (k) {
      const i = parseInt(k.slice(1), 10);
      const e = f.effects[i];
      if (!e) return;
      if (!st.orig[k]) st.orig[k] = { mag: e.mag, dur: e.dur, area: e.area };
      e.mag = req.set[k].mag; e.dur = req.set[k].dur; e.area = req.set[k].area;
      st.set[k] = req.set[k];
    });
    const out = devSxState(req.id);
    out.msg = 'Changed - saved across launches';
    window.sxApplyResult(out);
  }

  function devSxRevert(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const f = DEV_SX[req.id];
    const st = DEV_SX_STORE[req.id];
    if (f && st) Object.keys(st.orig).forEach(function (k) {
      const i = parseInt(k.slice(1), 10);
      const e = f.effects[i];
      if (e) { e.mag = st.orig[k].mag; e.dur = st.orig[k].dur; e.area = st.orig[k].area; }
    });
    delete DEV_SX_STORE[req.id];
    const out = f ? devSxState(req.id) : { ok: true, id: req.id, edited: [] };
    out.msg = 'Restored to its original values';
    window.sxRevertResult(out);
  }

  function devSxList() {
    window.sxListResult({ edits: Object.keys(DEV_SX_STORE).map(function (id) {
      return { id: id, n: DEV_SX[id].n, p: id.split('|')[0],
        fields: Object.keys(DEV_SX_STORE[id].set).length };
    }), count: Object.keys(DEV_SX_STORE).length });
  }

  function toast(msg, err) {
    const t = $('sc-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('sc-toast-err', !!err);
    t.classList.add('sc-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('sc-toast-show'); }, 2600);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    ensureDom();
    toGame('scState', '');
    toGame('scOpen', '');
    render();
    const q = $('sc-q');
    if (q) setTimeout(function () { q.focus(); }, 30);
  }

  function onHide() {
    ui.visible = false;
    closeSheet();
    ui.armedErase = '';
    ui.armedTome = false;
    if (ui.armedEraseT) { clearTimeout(ui.armedEraseT); ui.armedEraseT = null; }
    if (ui.armedTomeT) { clearTimeout(ui.armedTomeT); ui.armedTomeT = null; }
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni jump: land with the library search pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.libShown = LIB_PAGE;
    const q = $('sc-q');
    if (q) q.value = ui.q;
    if (ui.visible) renderLibBody();
  }

  function init() {
    ensureDom();
    if (DEV) { /* visual harness mode: fixtures flow through toGame's dev arm */ }
  }

  /* =============================================================== dev == */

  function devState() {
    window.scStateResult({
      present: true, reason: '', dpfPex: true, learnMode: false, hasTome: true, gold: 4321,
      settings: { effectCost: 2, tomeCost: 250, mustKnowPerk: true, magExp: 1, dMult: 1, aMult: 15, sliderMax: 500 },
    });
  }
  function devOpen() {
    window.scOpenData({
      ok: true, learnMode: false, hasTome: true, gold: 4321,
      settings: { effectCost: 2, tomeCost: 250, mustKnowPerk: true, magExp: 1, dMult: 1, aMult: 15, sliderMax: 500 },
      spells: [
        { plugin: 'Skyrim.esm', localId: 0x12FCD, formId: 0x12FCD, name: 'Firebolt', school: 'Destruction',
          delivery: 'Aimed', casting: 'FireAndForget', effects: [
            { name: 'Fire Damage', mgefPlugin: 'Skyrim.esm', mgefLocalId: 0x13CA9, mag: 25, area: 0, dur: 1,
              D: 1, ogDur: 1, ogArea: 0, noMag: false, noArea: false, noDur: false, hostile: true,
              school: 'Destruction', skillLvl: 25, delivery: 'Aimed', casting: 'FireAndForget', gated: false }] },
        { plugin: 'Skyrim.esm', localId: 0x12FCC, formId: 0x12FCC, name: 'Fast Healing', school: 'Restoration',
          delivery: 'Self', casting: 'FireAndForget', effects: [
            { name: 'Restore Health', mgefPlugin: 'Skyrim.esm', mgefLocalId: 0x13CAD, mag: 50, area: 0, dur: 0,
              D: 1, ogDur: 0, ogArea: 0, noMag: false, noArea: false, noDur: true, hostile: false,
              school: 'Restoration', skillLvl: 25, delivery: 'Self', casting: 'FireAndForget', gated: false }] },
      ],
      alch: [
        { name: 'Regenerate Magicka', plugin: 'Skyrim.esm', localId: 0x3EB07, D: 1.5,
          delivery: 'Self', casting: 'FireAndForget', school: '', hostile: false },
      ],
      crafted: [],
      icons: {},
    });
  }

  /* ---- Omni search provider ------------------------------------------------
     Crafted spells, castable straight from omni (hdOmniCast — the same cast
     the Spell Deck twin uses); the tab itself is findable by its nav label.

     Everything a player can NAME is its own row (2026-08-19). Modify, the
     crafting settings and Learning effects were reachable only by clicking
     into this tab and then hitting an unlabelled chip, so searching the deck
     for "edit fireball damage", "tome cost" or "learn effects" found nothing —
     half the tab was invisible to the search that is supposed to reach all of
     it. Each of those rows lands ON the thing it names rather than merely on
     the tab. */

  /* A row that has to act INSIDE the pane opens the tab first: setTab runs the
     pane's onShow (its DOM, its data), and re-selecting the tab you are already
     on is a no-op, so this is safe from either place. */
  function omniLand() {
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('spellcraft');
  }

  if (window.HDOmni) HDOmni.register({
    id: 'spellcraft', label: 'Spell Crafting', tab: 'spellcraft',
    setFilter: setFilter,
    /* The crafted shelf only exists after scOpen has answered, which used to
       mean the tab had to be visited once per session before omni knew a single
       crafted spell. Asking on omni-open costs one bridge call and makes them
       searchable from a cold launch (the finances/wardrobe precedent). scState
       comes along because it is what carries learn mode and the mod's presence,
       which the rows below tell the truth with. */
    warm: function () {
      toGame('scState', '');
      toGame('scOpen', '');
    },
    pinRun: function (snap) {
      if (snap && snap.kind) toGame('hdOmniCast', JSON.stringify(snap));
    },
    index: function () {
      const items = [{
        label: 'Spell Crafting',
        detail: 'Craft your own spells — Oblivion-style spellmaking',
        kind: 'spellcraft',
        keywords: 'spell crafting spellmaker spellmaking craft custom spell fourth era',
      }];

      /* Modify is the tab's whole second half and needs no crafting mod at all
         (spell_edit.cpp edits records the load order already ships), so it is
         listed even when Fourth Era Spell-Crafting is absent. */
      items.push({
        label: 'Modify a spell',
        detail: 'Edit any spell the load order ships — magnitude, duration, area' +
          (mx.count ? ' · ' + mx.count + ' already edited' : '') + ', revertable',
        kind: 'spellcraft',
        keywords: 'modify edit change spell magnitude duration area damage stronger weaker ' +
          'buff nerf rebalance tweak revert restore original spell editor',
        run: function () { omniLand(); setMode('modify'); },
      });

      /* The crafting dials and learn mode belong to the mod — with it absent the
         pane paints its "install it" hero, and a row promising to open a sheet
         that cannot exist would be a lie. Unknown (null, before scState answers)
         still shows: the sheet is what the player asked for. */
      if (state.present !== false) {
        items.push({
          label: 'Crafting settings',
          detail: 'The mod\'s own dials — tome price, gold per magicka, whether the school perk is required',
          kind: 'spellcraft',
          keywords: 'crafting settings dials options ' +
            SETTING_DEFS.map(function (d) { return d[1]; }).join(' ').toLowerCase() +
            ' perk required free cost price cheaper expensive',
          run: function () { omniLand(); openSettings(); },
        });

        items.push({
          label: 'Learning effects',
          detail: state.learnMode
            ? 'ON — brewing a potion at an alchemy bench teaches its effects. Run to turn it off.'
            : 'OFF — run to turn it on, then brew at any alchemy bench to learn effects for crafting.',
          kind: 'spellcraft',
          keywords: 'learn learning effects alchemy bench brew potion teach discover new effects toggle',
          /* The tab comes along so the chip visibly flips and the reply's toast
             has somewhere to land — a silent toggle of a persistent mode reads
             as a dead button. */
          run: function () {
            omniLand();
            toGame('scLearn', JSON.stringify({ on: !state.learnMode }));
          },
        });
      }

      for (let i = 0; i < state.crafted.length; i++) {
        (function (c) {
          const cast = { kind: 'spell', name: c.name || '',
            plugin: c.plugin || '', localId: c.localId >>> 0, formId: (c.formId >>> 0) || 0 };
          items.push({
            label: c.name || '(unnamed crafted spell)',
            detail: 'Crafted · ' + schoolName(schoolIdx(c.school)) +
              ((c.effects || []).length ? ' · ' + (c.effects || []).join(' + ') : ''),
            kind: 'crafted spell',
            keywords: 'crafted custom ' + (c.effects || []).join(' '),
            pin: 'scc:' + (c.plugin || '') + ':' + (c.localId >>> 0),
            icon: craftedIcon(c),
            snap: cast,
            run: function () { toGame('hdOmniCast', JSON.stringify(cast)); },
          });
        })(state.crafted[i]);
      }
      return items;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    /* harness surface */
    _state: state, _ui: ui,
    _mx: mx, _setMode: setMode, _mxOpen: mxOpen, _mxBack: mxBack,
    _mxApply: mxApply, _renderModify: renderModify, _mxRunQuery: mxRunQuery,
    _cost: effCost, _effGold: effGold, _totalMagicka: totalMagicka, _totalGold: totalGold,
    _costliest: costliest, _craftGate: craftGate, _craftPayload: craftPayload,
    _basketAdd: basketAdd, _basketRemove: basketRemove, _setStat: setStat,
    _addSpell: addSpell, _addTopHit: addTopHit, _visibleSpells: visibleSpells, _visibleAlch: visibleAlch,
    _schoolIdx: schoolIdx, _isConstant: isConstant,
    _normIconMap: normIconMap, _iconOverrideFor: iconOverrideFor, _craftedIcon: craftedIcon,
    _craftedFiltered: craftedFiltered, _validIconPath: validIconPath,
    _tryCraft: tryCraft, _doCraft: doCraft, _eraseClick: eraseClick, _castCrafted: castCrafted,
    _openSettings: openSettings, _openBasePicker: openBasePicker, _pickBase: pickBase,
    _openIconSheet: openIconSheet, _closeSheet: closeSheet, _render: render,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.SpellCraftPane.init(); });
} else {
  window.SpellCraftPane.init();
}
