'use strict';

/* ====================================================================== *
 *  High King — the Become High King of Skyrim TNG dashboard (Rober,
 *  2026-08-18: "if this mod is detected show a new high king of skyrim
 *  tab that shows analytics, hotkeyable quick use abilities (i think
 *  dialogue options), and more").
 *
 *  C++ (high_king.cpp) reads the mod's own ~165 kingdom globals by FormID
 *  and dispatches its own scripts; this pane owns arrangement, the tax-rate
 *  picker, search and presentation. Royal power casts ride the existing
 *  hdOmniCast bridge (close → cast → reopen), so casting here IS the omni
 *  cast, not a new road.
 *
 *  Bridge — requests: kgState() · kgAct({op}) · kgTax({hold,rate})
 *  Replies (disjoint, per the deck law): kgStateResult(payload) ·
 *  kgActResult({ok,msg,...})
 *
 *  Host contract (mirrors KeysPane): HighKingPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true ·
 *  setFilter(text)
 * ====================================================================== */

window.HighKingPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const $ = (id) => document.getElementById(id);

  const state = {
    loaded: false,
    present: null,      // null = not answered yet; false = mod absent
    data: null,         // the whole kgStateResult payload
    pendingTax: '',     // hold id whose rate picker is waiting on C++
  };

  const ui = {
    visible: false,
    filter: '',
  };

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'kgState') setTimeout(devState, 30);
      if (DEV && fn === 'kgTax') setTimeout(() => devTax(arg), 30);
      if (DEV && fn === 'kgAct') setTimeout(() => devAct(arg), 30);
    }
  }

  window.kgStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.loaded = true;
    state.present = d.present !== false;
    state.data = d;
    state.pendingTax = '';
    render();
  };

  window.kgActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done.' : 'Refused.'), !!d.ok);
  };

  /* ============================================================ helpers == */

  function fmtGold(n) {
    const v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* Game-days countdown → couch-readable text ("2 days 4 hrs"). */
  function fmtDays(d) {
    if (!(d > 0)) return 'now';
    const days = Math.floor(d);
    const hrs = Math.round((d - days) * 24);
    if (days <= 0) return hrs + ' hr' + (hrs === 1 ? '' : 's');
    return days + ' day' + (days === 1 ? '' : 's') + (hrs ? ' ' + hrs + ' hrs' : '');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const RATE_STEPS = [0, 5, 10, 15, 20, 25];
  const RATE_APPROVAL = { 0: '+20', 5: '+10', 10: '±0', 15: '−10', 20: '−20', 25: '−30' };

  function approvalHue(v) {
    if (v >= 60) return 'hx-good';
    if (v >= 30) return 'hx-mid';
    return 'hx-low';
  }

  let toastTimer = 0;
  function toast(msg, ok) {
    const t = $('hx-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('hx-toast-ok', !!ok);
    t.classList.toggle('hx-toast-bad', !ok);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
  }

  function matches(text) {
    if (!ui.filter) return true;
    return String(text || '').toLowerCase().indexOf(ui.filter.toLowerCase()) !== -1;
  }

  /* ============================================================= render == */

  function render() {
    const hero = $('hx-hero');
    const body = $('hx-body');
    const empty = $('hx-empty');
    const chip = $('hx-crown-chip');
    if (!body) return;

    if (!state.loaded) {
      hero.classList.add('hidden');
      empty.classList.add('hidden');
      body.innerHTML = '<div class="hx-skeleton"><div></div><div></div><div></div></div>';
      return;
    }

    /* The gated tab should make this unreachable, but the pane stays honest
       on its own feet (the survival/spellcraft precedent). */
    if (state.present === false) {
      hero.classList.add('hidden');
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = '<div class="hx-absent"><img class="hx-absent-ico" src="icons/custom/hm-highking.png" alt="" onerror="this.remove()"><h3>Become High King of Skyrim is not in the load order</h3>' +
        '<p>This tab reads that mod\'s own kingdom ledgers — install and enable BecomeKingofSkyrimTNG.esp and it lights up.</p></div>';
      if (chip) chip.textContent = '';
      return;
    }

    const d = state.data;
    const king = d.king || {};
    const t = d.treasury || {};
    const econ = d.economy || {};
    const sky = d.skyrim || {};
    const counts = d.counts || {};
    const reb = d.rebellion || {};
    const holds = Array.isArray(d.holds) ? d.holds : [];
    const stones = Array.isArray(d.stones) ? d.stones : [];
    const council = Array.isArray(d.council) ? d.council : [];
    const powers = Array.isArray(d.powers) ? d.powers : [];

    /* The path quest is Start Game Enabled — it's IsRunning() from the very
       first load, sitting at stage 0, quietly counting supporters/gold in
       the background. So pathRunning alone can't say "you've begun";
       pathStage is the only honest signal (2026-08-19: a fresh save read
       "Claimant" and showed a live kingdom before Rober had done anything). */
    const notStarted = !king.isKing && !(king.pathStage > 0);

    if (chip) {
      chip.textContent = king.isKing ? 'High King of Skyrim' : (notStarted ? 'Not yet crowned' : 'Claimant');
      chip.className = 'hx-chip ' + (king.isKing ? 'hx-chip-gold' : 'hx-chip-dim');
    }

    /* Nothing below this is real until the questline actually begins — the
       treasury, approval and economy tier are the mod's baked-in ESP
       defaults, not progress (same 2026-08-19 confusion). Replace the whole
       dashboard with one clear "begin" screen instead of dressing up
       placeholder numbers with a footnote. */
    if (notStarted) {
      hero.classList.add('hidden');
      empty.classList.add('hidden');
      body.innerHTML =
        '<div class="hx-begin">' +
          '<div class="hx-begin-crown"><img src="icons/custom/hm-highking.png" alt="" onerror="this.remove()"></div>' +
          '<h2>The road to the throne awaits</h2>' +
          '<p class="hx-begin-copy">Win the Civil War, then rally 40 supporters and fill the war chest to ' +
          fmtGold(50000) + ' gold — or win the Moot of Jarls instead. It all starts the moment someone in ' +
          'Skyrim mentions Highreach.</p>' +
          '<button id="hx-begin-btn" class="hx-btn hx-btn-gold hx-begin-btn">Begin the road to the throne</button>' +
          '<p class="hx-begin-hint">You\'ll receive Surgus\'s Note — read it in your inventory to take the first step.</p>' +
        '</div>';
      wireBody();
      return;
    }

    /* ---- hero strip ---------------------------------------------------- */
    hero.classList.remove('hidden');
    const rebelHolds = holds.filter((h) => h.rebel && !h.bribed).map((h) => h.name);
    hero.innerHTML =
      '<div class="hx-stat"><div class="hx-stat-label">Treasury</div>' +
        '<div class="hx-stat-num">🜚 ' + fmtGold(t.total) + '</div></div>' +
      '<div class="hx-stat"><div class="hx-stat-label">Next collection</div>' +
        '<div class="hx-stat-num">' + fmtGold(t.projected) + '</div>' +
        '<div class="hx-stat-sub">in ' + fmtDays(t.daysUntilCollection) +
        (t.coinStone ? ' · Coin +10%' : '') + (t.lawgiverStone ? ' · Lawgiver −10%' : '') + '</div></div>' +
      '<div class="hx-stat"><div class="hx-stat-label">Economy</div>' +
        '<div class="hx-stat-num">' + esc(econ.tierName || '—') + '</div>' +
        '<div class="hx-stat-sub">score ' + Math.round(econ.score || 0) + ' / 100' +
        (econ.tariffs ? ' · tariffs on' : '') + '</div></div>' +
      '<div class="hx-stat"><div class="hx-stat-label">Skyrim\'s approval</div>' +
        '<div class="hx-stat-num ' + approvalHue(sky.approval || 0) + '">' + Math.round(sky.approval || 0) + '</div>' +
        '<div class="hx-stat-sub">faith ' + Math.round(sky.faith || 0) + '</div></div>' +
      '<div class="hx-stat"><div class="hx-stat-label">The realm</div>' +
        '<div class="hx-stat-num">' + (counts.citizens || 0) + '</div>' +
        '<div class="hx-stat-sub">citizens · ' + (counts.nobles || 0) + ' nobles · ' +
        (counts.rangers || 0) + ' rangers</div></div>' +
      (rebelHolds.length ?
        '<div class="hx-banner">Rebellion in ' + esc(rebelHolds.join(', ')) + '</div>' : '');

    /* ---- cards ---------------------------------------------------------- */
    empty.classList.add('hidden');
    let html = '';

    /* Pre-king progress — only while the crown is still unwon. */
    if (!king.isKing) {
      /* Denominator from the DLL (the mod's AABecomeKingSupportersAlt target
         global) — an old DLL sends nothing and 40 stays the honest fallback.
         The COUNT itself comes from AAKingSupportNum since 2026-08-19; the
         pre-fix DLL read the target global as the count, which is why a fresh
         save opened on a full "40/40" bar. */
      const supNeed = king.supportersNeeded > 0 ? king.supportersNeeded : 40;
      const supPct = Math.min(100, Math.round((king.supporters || 0) / supNeed * 100));
      const goldPct = Math.min(100, Math.round((king.goldCounted || 0) / (king.goldNeeded || 50000) * 100));
      html += '<div class="hx-card" data-hx="path"><div class="hx-card-title">The road to the throne</div>' +
        '<div class="hx-path-row"><span>Supporters</span><div class="hx-bar"><div style="width:' + supPct + '%"></div></div>' +
          '<b>' + (king.supporters || 0) + ' / ' + supNeed + '</b></div>' +
        '<div class="hx-path-row"><span>War chest</span><div class="hx-bar"><div style="width:' + goldPct + '%"></div></div>' +
          '<b>' + fmtGold(king.goldCounted) + ' / ' + fmtGold(king.goldNeeded) + '</b></div>' +
        '<div class="hx-note">Win the civil war, then either ' + supNeed + ' supporters + the war chest, or the Moot of Jarls. Quest stage ' +
          (king.pathStage || 0) + '.</div></div>';
    }

    /* Taxes — the rate picker per hold + the collect verb. */
    const taxRows = holds.filter((h) => matches(h.name + ' ' + h.city)).map((h) => {
      const rate = Math.round(h.rate);
      const segs = RATE_STEPS.map((r) =>
        '<button class="hx-seg' + (r === rate ? ' hx-seg-on' : '') + '" data-hold="' + h.id + '" data-rate="' + r + '"' +
        ' title="' + r + '% — ' + RATE_APPROVAL[r] + ' approval each Sundas"' +
        (state.pendingTax === h.id ? ' disabled' : '') + '>' + r + '</button>').join('');
      return '<div class="hx-tax-row"><div class="hx-tax-name">' + esc(h.name) +
        '<span class="hx-tax-city">' + esc(h.city) + '</span></div>' +
        '<div class="hx-segs">' + segs + '</div>' +
        '<div class="hx-tax-proj" title="base ' + fmtGold(h.base) + ' × ' + rate + '% + head tax ' + fmtGold(h.head) + '">' +
          fmtGold(h.projected) + '<span>/wk</span></div>' +
        '<div class="hx-tax-appr ' + (h.rateApprovalDelta > 0 ? 'hx-good' : h.rateApprovalDelta < 0 ? 'hx-low' : 'hx-mid') + '">' +
          (h.rateApprovalDelta > 0 ? '+' : '') + h.rateApprovalDelta + ' appr</div></div>';
    }).join('');
    html += '<div class="hx-card hx-card-wide" data-hx="taxes"><div class="hx-card-title">Taxes' +
      '<span class="hx-card-sub">last collected ' +
      (t.daysSinceCollection >= 0 ? fmtDays(t.daysSinceCollection) + ' ago' : 'never') + '</span>' +
      '<span class="hx-card-actions"><button id="hx-collect" class="hx-btn hx-btn-gold" title="The mod\'s own weekly collection, right now — approval effects included">Collect now</button>' +
      '<button id="hx-ledger" class="hx-btn" title="Have the council\'s ledger book take a fresh snapshot">Ledger</button></span></div>' +
      (taxRows || '<div class="hx-none">No hold matches the filter.</div>') + '</div>';

    /* Holds — approval / faith / economy / rebellion at a glance. */
    const holdRows = holds.filter((h) => matches(h.name + ' ' + h.city)).map((h) => {
      const delta = Math.round(h.approvalDelta || 0);
      const rebelChip = h.rebel ? (h.bribed ? '<span class="hx-tag hx-tag-mid">bribed</span>'
                                            : '<span class="hx-tag hx-tag-bad">rebellion</span>')
                                : (h.hasRebel ? '<span class="hx-tag hx-tag-ok">quiet</span>'
                                              : '<span class="hx-tag">crown seat</span>');
      return '<div class="hx-hold-row"><div class="hx-hold-name">' + esc(h.city) +
          '<span class="hx-tax-city">' + esc(h.name) + '</span></div>' +
        '<div class="hx-hold-cell"><span class="hx-cell-label">approval</span><b class="' + approvalHue(h.approval) + '">' +
          Math.round(h.approval) + '</b>' +
          (delta ? '<span class="hx-delta ' + (delta > 0 ? 'hx-good' : 'hx-low') + '">' + (delta > 0 ? '▲' : '▼') + Math.abs(delta) + '</span>' : '') + '</div>' +
        '<div class="hx-hold-cell"><span class="hx-cell-label">faith</span><b>' + Math.round(h.faith) + '</b></div>' +
        '<div class="hx-hold-cell"><span class="hx-cell-label">economy</span><b>' + Math.round(h.econScore) + '</b></div>' +
        rebelChip + '</div>';
    }).join('');
    html += '<div class="hx-card hx-card-wide" data-hx="holds"><div class="hx-card-title">The holds</div>' +
      (holdRows || '<div class="hx-none">No hold matches the filter.</div>') + '</div>';

    /* Royal powers — grouped, cast through hdOmniCast. */
    const groups = [['travel', 'Travel'], ['summon', 'Summons'], ['command', 'Command']];
    let powerHtml = '';
    let shown = 0;
    groups.forEach(([key, label]) => {
      const rows = powers.filter((p) => p.group === key && matches(p.name)).map((p) => {
        shown++;
        return '<div class="hx-power' + (p.known ? '' : ' hx-power-locked') + '" data-cast="' + p.localId + '"' +
          ' title="' + (p.known ? 'Cast now — the deck closes, the power fires' : 'Not yet earned — the mod grants this as you rule') + '">' +
          '<span class="hx-power-name">' + esc(p.name) + '</span>' +
          (p.cost > 0 ? '<span class="hx-power-cost">' + Math.round(p.cost) + ' mag</span>' : '') +
          (p.known ? '<span class="hx-power-go">✦ Cast</span>' : '<span class="hx-power-lock">locked</span>') + '</div>';
      }).join('');
      if (rows) powerHtml += '<div class="hx-group-label">' + label + '</div><div class="hx-powers">' + rows + '</div>';
    });
    html += '<div class="hx-card hx-card-wide" data-hx="powers"><div class="hx-card-title">Royal powers' +
      '<span class="hx-card-sub">click to cast · bind any of them on the Action Bar or as a deck entry</span></div>' +
      (powerHtml || '<div class="hx-none">No power matches the filter.</div>') + '</div>';

    /* Council — the twelve seats. */
    const seatRows = council.filter((c) => matches(c.name)).map((c) =>
      '<div class="hx-seat hx-seat-' + c.state + '" title="' +
        (c.state === 'filled' ? 'Seat filled' : c.state === 'seeking' ? 'The search is under way' : 'No one holds this seat yet') + '">' +
        '<span class="hx-seat-dot"></span>' + esc(c.name) + '</div>').join('');
    const filled = council.filter((c) => c.state === 'filled').length;
    html += '<div class="hx-card" data-hx="council"><div class="hx-card-title">The council' +
      '<span class="hx-card-sub">' + filled + ' of ' + council.length + ' seats filled</span></div>' +
      '<div class="hx-seats">' + (seatRows || '<div class="hx-none">No seat matches the filter.</div>') + '</div></div>';

    /* King Stones. */
    const stoneRows = stones.filter((s) => matches(s.name)).map((s) =>
      '<div class="hx-stone' + (s.active ? ' hx-stone-on' : '') + '"' +
        (s.note ? ' title="' + esc(s.note) + '"' : '') + '>' + esc(s.name.replace(/^The /, '').replace(/ Stone$/, '')) + '</div>').join('');
    const lit = stones.filter((s) => s.active).length;
    html += '<div class="hx-card" data-hx="stones"><div class="hx-card-title">King Stones' +
      '<span class="hx-card-sub">' + lit + ' of ' + stones.length + ' attuned</span></div>' +
      '<div class="hx-stones">' + (stoneRows || '<div class="hx-none">No stone matches the filter.</div>') + '</div></div>';

    /* Weekly upkeep — only once the crown actually spends. */
    const exp = d.expenses || {};
    if ((exp.total || 0) > 0) {
      const items = [['Guards', exp.guards], ['Castles', exp.castles], ['Infrastructure', exp.infrastructure],
        ['Lighting', exp.lighting], ['Water', exp.water], ['Priests', exp.priests]];
      html += '<div class="hx-card" data-hx="upkeep"><div class="hx-card-title">Weekly upkeep' +
        '<span class="hx-card-sub">🜚 ' + fmtGold(exp.total) + ' total</span></div>' +
        items.filter(([, v]) => v > 0).map(([n, v]) =>
          '<div class="hx-exp-row"><span>' + n + '</span><b>🜚 ' + fmtGold(v) + '</b></div>').join('') + '</div>';
    }

    body.innerHTML = html;
    wireBody();
  }

  /* Delegated wiring for the freshly rendered body. */
  function wireBody() {
    const body = $('hx-body');
    if (!body || body.dataset.wired) {
      return;
    }
    body.dataset.wired = '1';
    body.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'hx-begin-btn') {
        toGame('kgAct', JSON.stringify({ op: 'start' }));
        return;
      }
      const seg = e.target.closest ? e.target.closest('.hx-seg') : null;
      if (seg && !seg.disabled) {
        state.pendingTax = seg.dataset.hold;
        toGame('kgTax', JSON.stringify({ hold: seg.dataset.hold, rate: Number(seg.dataset.rate) }));
        render();
        return;
      }
      const power = e.target.closest ? e.target.closest('.hx-power') : null;
      if (power) {
        castPower(Number(power.dataset.cast));
        return;
      }
      if (e.target && e.target.id === 'hx-collect') {
        toGame('kgAct', JSON.stringify({ op: 'collect' }));
        return;
      }
      if (e.target && e.target.id === 'hx-ledger') {
        toGame('kgAct', JSON.stringify({ op: 'ledger' }));
      }
    });
  }

  function castPower(localId) {
    const d = state.data;
    const p = d && Array.isArray(d.powers) ? d.powers.find((x) => x.localId === localId) : null;
    if (!p) return;
    if (!p.known) {
      toast('You haven\'t earned ' + p.name + ' yet — the crown grants it as you rule.', false);
      return;
    }
    /* The omni cast road: deck closes, the power fires into the live world,
       closeAfterFire decides the reopen — exactly the Spell Deck behaviour. */
    toGame('hdOmniCast', JSON.stringify({
      kind: 'spell', plugin: p.plugin, localId: p.localId, formId: p.formId, name: p.name,
    }));
  }

  /* ============================================================== host == */

  function onShow() {
    ui.visible = true;
    const f = $('hx-filter');
    if (f) { f.value = ui.filter; setTimeout(() => f.focus(), 30); }
    toGame('kgState', '');
    render();
  }

  function onHide() {
    ui.visible = false;
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  function setFilter(text) {
    ui.filter = String(text || '');
    const f = $('hx-filter');
    if (f) f.value = ui.filter;
    render();
  }

  function init() {
    const f = $('hx-filter');
    if (f) {
      f.addEventListener('input', () => { ui.filter = f.value.trim(); render(); });
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          /* Enter = cast the top matching KNOWN power — the deck's standing
             top-hit idiom, aimed at the one list on this tab you fire. */
          const d = state.data;
          const top = d && Array.isArray(d.powers) ?
            d.powers.find((p) => p.known && matches(p.name)) : null;
          if (top) castPower(top.localId);
          e.stopPropagation();
        }
        if (e.key === 'Escape' && f.value) {
          f.value = ''; ui.filter = ''; render();
          e.stopPropagation();
        }
      });
    }
    const re = $('hx-refresh');
    if (re) re.addEventListener('click', () => toGame('kgState', ''));
    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  function devFixture() {
    const mk = (id, name, city, rate, appr, faith, rebel) => ({
      id, name, city, rate, base: 3000, head: 250, revenue: rate * 30 + 250,
      projected: Math.floor(3000 * rate / 100 + 250 + 0.5), rateApprovalDelta: ({ 0: 20, 5: 10, 10: 0, 15: -10, 20: -20, 25: -30 })[rate],
      approval: appr, approvalDelta: rate <= 5 ? 10 : -10, approvalTier: 2,
      faith, faithTier: 2, econScore: 55, hasRebel: id !== 'highreach', rebel, bribed: false,
    });
    return {
      present: true,
      king: { isKing: true, reigning: true, pathStage: 50, pathRunning: false, supporters: 41, goldCounted: 61250, goldNeeded: 50000 },
      treasury: { total: 128400, lastCollectionDay: 812.4, daysNow: 815.1, daysSinceCollection: 2.7, daysUntilCollection: 4.3, projected: 6710, projectedRaw: 6100, coinStone: true, lawgiverStone: false, mineLast: 900 },
      economy: { score: 62, tier: 3, tierName: 'Prosperous', lastApproval: 48, difficulty: 1, tariffs: false },
      skyrim: { approval: 57, approvalDelta: 4, faith: 44 },
      counts: { citizens: 38, nobles: 6, heroes: 3, rangers: 9, detainees: 2 },
      expenses: { guards: 800, castles: 400, infrastructure: 250, lighting: 60, water: 90, priests: 120, total: 1720 },
      rebellion: { enabled: true, any: true },
      holds: [
        mk('whiterun', 'Whiterun', 'Whiterun', 10, 62, 51, false),
        mk('eastmarch', 'Eastmarch', 'Windhelm', 15, 41, 38, false),
        mk('falkreath', 'Falkreath', 'Falkreath', 5, 71, 47, false),
        mk('hjaalmarch', 'Hjaalmarch', 'Morthal', 10, 55, 33, false),
        mk('pale', 'The Pale', 'Dawnstar', 20, 24, 29, true),
        mk('winterhold', 'Winterhold', 'Winterhold', 0, 80, 60, false),
        mk('rift', 'The Rift', 'Riften', 10, 49, 42, false),
        mk('haafingar', 'Haafingar', 'Solitude', 10, 66, 58, false),
        mk('reach', 'The Reach', 'Markarth', 25, 18, 22, true),
        mk('highreach', 'Highreach Keep', 'Highreach', 5, 88, 74, false),
      ],
      stones: [
        { key: 'coin', name: 'The Coin Stone', active: true, note: '+10% on every tax collection' },
        { key: 'seal', name: 'The Seal Stone', active: true, note: '+10 economy score each week' },
        { key: 'chain', name: 'The Chain Stone', active: false, note: '' },
        { key: 'lawgiver', name: 'The Lawgiver Stone', active: false, note: '-10% on every tax collection' },
        { key: 'blood', name: 'The Blood Stone', active: false, note: '' },
        { key: 'pilgrim', name: 'The Pilgrim Stone', active: false, note: '' },
        { key: 'warden', name: 'The Warden Stone', active: true, note: '' },
        { key: 'captain', name: "The Captain's Stone", active: false, note: '' },
        { key: 'commander', name: 'The Commander Stone', active: false, note: '' },
        { key: 'court', name: 'The Court Stone', active: false, note: '' },
        { key: 'crown', name: 'The Crown Stone', active: true, note: '' },
        { key: 'taxman', name: 'The Taxman Stone', active: false, note: '' },
      ],
      council: [
        { name: 'High Priest of Skyrim', state: 'filled' },
        { name: 'Master of Coin', state: 'filled' },
        { name: 'Steward of Highreach', state: 'seeking' },
        { name: 'Overseer of Slaves', state: 'vacant' },
        { name: 'Master of Assassins', state: 'vacant' },
        { name: 'First Mage of Skyrim', state: 'filled' },
        { name: 'Master of Chains', state: 'vacant' },
        { name: 'Lord Commander', state: 'seeking' },
        { name: 'Voice of the Crown', state: 'vacant' },
        { name: 'Royal Blacksmith', state: 'filled' },
        { name: 'Royal Chronicler', state: 'vacant' },
        { name: 'Will of the Crown', state: 'vacant' },
      ],
      powers: [
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x05FDF6, formId: 1, name: 'Teleport to Highreach', group: 'travel', known: true, cost: 0 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x064363, formId: 2, name: 'Teleport to Royal Spouse', group: 'travel', known: true, cost: 0 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x059E30, formId: 3, name: 'Teleport to Highreach Rangers', group: 'travel', known: false, cost: 0 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x06609A, formId: 4, name: 'Summon Crownsguard', group: 'summon', known: true, cost: 100 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x06609B, formId: 5, name: 'Summon Lady of the Lake', group: 'summon', known: false, cost: 50 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x0660A5, formId: 6, name: 'Voice of the King', group: 'command', known: true, cost: 256 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x0660A6, formId: 7, name: 'Edict of Terror', group: 'command', known: true, cost: 269 },
        { plugin: 'BecomeKingofSkyrimTNG.esp', localId: 0x0AD598, formId: 8, name: "Blessing of Skyrim's Crown", group: 'command', known: false, cost: 0 },
      ],
    };
  }

  function devState() { window.kgStateResult(devFixture()); }

  function devTax(arg) {
    let hold = '', rate = 0;
    try { const j = JSON.parse(arg); hold = j.hold; rate = j.rate; } catch (e) { /* dev only */ }
    const d = devFixture();
    d.holds.forEach((h) => { if (h.id === hold) { h.rate = rate; h.projected = Math.floor(h.base * rate / 100 + h.head + 0.5); } });
    window.kgActResult({ ok: true, msg: hold + ' set to ' + rate + '%' });
    window.kgStateResult(d);
  }

  function devAct(arg) {
    let op = '';
    try { op = JSON.parse(arg).op; } catch (e) { /* dev only */ }
    if (op === 'start') {
      window.kgActResult({ ok: true, msg: 'Surgus\'s Note is in your inventory — read it to begin the road to the throne.' });
      const d = state.data ? JSON.parse(JSON.stringify(state.data)) : devFixture();
      d.king = d.king || {};
      d.king.isKing = false;
      d.king.pathRunning = true;
      d.king.pathStage = 1;
      window.kgStateResult(d);
      return;
    }
    window.kgActResult({ ok: true, msg: op === 'collect' ? 'Tax collectors sent to every hold — the count lands in a moment.' : 'The council\'s ledger takes a fresh snapshot.' });
  }

  /* The "not started" fixture — Rober's own 2026-08-19 fresh-save numbers
     (treasury 45,000, approval 61, economy score under 20), so the begin
     screen and the dashboard it replaces can both be exercised in DEV/test. */
  function freshFixture() {
    const f = devFixture();
    f.king = { isKing: false, reigning: false, pathStage: 0, pathRunning: true,
      supporters: 0, goldCounted: 0, goldNeeded: 50000, supportersNeeded: 40 };
    f.treasury.total = 45000;
    f.economy = { score: 15, tier: 0, tierName: 'Collapsing', lastApproval: 0, difficulty: 0, tariffs: false };
    f.skyrim = { approval: 61, approvalDelta: 0, faith: 45 };
    f.holds.forEach((h) => { h.rate = 10; h.rebel = false; });
    f.rebellion = { enabled: false, any: false };
    return f;
  }

  /* ============================================================ selftest == */

  function selftest() {
    const out = [];
    const t = (name, cond) => out.push((cond ? 'OK  ' : 'FAIL') + '  ' + name);

    window.kgStateResult(devFixture());
    t('state loaded', state.loaded && state.present === true);
    t('hero renders treasury', ($('hx-hero').textContent || '').indexOf('128,400') !== -1);
    t('crown chip says king', ($('hx-crown-chip').textContent || '').indexOf('High King') !== -1);
    t('10 tax rows', document.querySelectorAll('#hx-body .hx-tax-row').length === 10);
    t('rate segs render 6 steps', (document.querySelector('#hx-body .hx-tax-row') || document.createElement('div')).querySelectorAll('.hx-seg').length === 6);
    t('10 hold rows', document.querySelectorAll('#hx-body .hx-hold-row').length === 10);
    t('rebellion banner names the Pale', ($('hx-hero').innerHTML || '').indexOf('The Pale') !== -1);
    t('12 council seats', document.querySelectorAll('#hx-body .hx-seat').length === 12);
    t('council sub counts filled', ($('hx-body').textContent || '').indexOf('4 of 12 seats filled') !== -1);
    t('12 stones, 4 lit', document.querySelectorAll('#hx-body .hx-stone').length === 12 &&
      document.querySelectorAll('#hx-body .hx-stone-on').length === 4);
    t('powers render', document.querySelectorAll('#hx-body .hx-power').length === 8);
    t('locked power wears the lock', document.querySelectorAll('#hx-body .hx-power-locked').length === 3);
    t('upkeep card renders', ($('hx-body').textContent || '').indexOf('Weekly upkeep') !== -1);

    setFilter('whiterun');
    t('filter narrows tax rows', document.querySelectorAll('#hx-body .hx-tax-row').length === 1);
    t('filter narrows hold rows', document.querySelectorAll('#hx-body .hx-hold-row').length === 1);
    setFilter('');

    /* pre-king render */
    const pre = devFixture();
    pre.king.isKing = false; pre.king.pathRunning = true; pre.king.supporters = 12; pre.king.goldCounted = 20000;
    window.kgStateResult(pre);
    t('claimant chip', ($('hx-crown-chip').textContent || '').indexOf('Claimant') !== -1);
    t('path card renders', document.querySelector('#hx-body [data-hx="path"]') !== null);
    t('supporter bar counts', ($('hx-body').textContent || '').indexOf('12 / 40') !== -1);

    /* fresh (not-started) render — the begin screen, not the dashboard */
    window.kgStateResult(freshFixture());
    t('fresh: chip says not yet crowned', ($('hx-crown-chip').textContent || '').indexOf('Not yet crowned') !== -1);
    t('fresh: hero hidden', $('hx-hero').classList.contains('hidden'));
    t('fresh: begin screen renders', document.querySelector('#hx-body .hx-begin') !== null);
    t('fresh: no tax rows (dashboard replaced, not dimmed)', document.querySelectorAll('#hx-body .hx-tax-row').length === 0);
    let beginActed = null;
    window.kgAct = function (arg) { beginActed = JSON.parse(arg); };
    $('hx-begin-btn').click();
    t('begin button sends kgAct start', beginActed && beginActed.op === 'start');
    delete window.kgAct;
    window.kgStateResult(devFixture());

    /* absent render */
    window.kgStateResult({ present: false });
    t('absent hero honest', ($('hx-empty').textContent || '').indexOf('not in the load order') !== -1);
    window.kgStateResult(devFixture());

    /* act toast */
    window.kgActResult({ ok: true, msg: 'Tax collectors sent' });
    t('toast shows act result', ($('hx-toast').textContent || '').indexOf('Tax collectors') !== -1 &&
      !$('hx-toast').classList.contains('hidden'));

    const fails = out.filter((l) => l.indexOf('FAIL') === 0);
    const box = document.createElement('pre');
    box.id = 'hx-selftest';
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'highking', label: 'High King', tab: 'highking',
    setFilter: setFilter,
    index: function () {
      const items = [];
      const d = state.data;
      if (d && Array.isArray(d.powers)) {
        d.powers.forEach((p) => {
          items.push({
            label: p.name,
            detail: 'Royal power · ' + (p.known ? 'Enter casts it' : 'not yet earned'),
            kind: 'highking',
            keywords: 'high king royal power kingdom ' + p.name + ' ' + p.group,
            filter: p.name,
            run: p.known ? function () { castPower(p.localId); } : undefined,
          });
        });
      }
      if (d && Array.isArray(d.holds)) {
        d.holds.forEach((h) => {
          items.push({
            label: h.city + ' — approval ' + Math.round(h.approval) + ', tax ' + Math.round(h.rate) + '%',
            detail: 'Hold ledger · ' + h.name + (h.rebel ? ' · REBELLION' : ''),
            kind: 'highking',
            keywords: 'high king hold approval tax faith rebellion ' + h.name + ' ' + h.city,
            filter: h.city,
          });
        });
      }
      items.push({ label: 'Collect taxes now', detail: 'High King · the mod\'s own weekly collection, on demand',
        kind: 'highking', keywords: 'high king collect taxes gold treasury kingdom',
        run: function () { toGame('kgAct', JSON.stringify({ op: 'collect' })); } });
      items.push({ label: 'High King', detail: 'The kingdom dashboard — treasury, taxes, approval, council, powers',
        kind: 'highking', keywords: 'high king kingdom throne crown dashboard taxes approval rebellion council stones' });
      return items;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _state: state, _ui: ui, _render: render, _fixture: devFixture, _freshFixture: freshFixture, _castPower: castPower,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.HighKingPane.init());
} else {
  window.HighKingPane.init();
}
