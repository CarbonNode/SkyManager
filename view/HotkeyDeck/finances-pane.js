'use strict';

/* ====================================================================== *
 *  Finances — a Financial Manager tab pane inside the Hotkey Deck view.
 *
 *  Run a lord's economy live: recurring income/expense/tax LINES (optionally
 *  tied to a Domain), a once-a-month **Settle** that nets it all against your
 *  gold and carries the shortfall as a rolling DEBT, saved **Market** buttons
 *  that Buy (spend) or Sell (gain) at a set price, and a LEDGER of what moved.
 *
 *  Self-contained by design: the pane owns its own state, its own DOM (every
 *  id fin- prefixed), and its own document listeners. It never reads or writes
 *  app.js's `state` / `ui`.
 *
 *  Ownership split (important):
 *    - VIEW owns  lines / market / settings  → mutated here, pushed whole via
 *      a debounced `finSave`. C++ parses these into the "finances" slice.
 *    - C++ owns   gold / debt / ledger  → only C++ mutates them (Settle/Buy/
 *      Sell move real Gold001), and pushes them back via `finState`. The view
 *      never writes them, so the two can't race.
 *
 *  Bridge — C++ registers these JS→C++ listeners on the DECK view:
 *    finGet() · finSave(json) · finSettle() · finBuy(json) · finSell(json) ·
 *    finIcons() · finLog(str)
 *  C++ calls into us (names disjoint from the above):
 *    finOpen(cfg) · finState(json) · finResult(json) · finSaved(ok) ·
 *    finIconList(json) · finShow()
 *  Request and response names stay disjoint — PrismaUI installs each JS
 *  listener as a global of that name, so a shared name clobbers the handler.
 *
 *  Host contract (see docs/finance-wiring.md):
 *    FinancesPane.init() · onShow() · onHide() · receive(fn, payload) ·
 *    wantsPause() -> true
 * ====================================================================== */

window.FinancesPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const SAVE_DEBOUNCE = 350;                 // same cadence as the other panes
  const CATEGORIES = ['tax', 'service', 'household', 'employee', 'property', 'other'];
  const CAT_LABEL = { tax: 'Tax', service: 'Service', household: 'Household', employee: 'Employee', property: 'Property', other: 'Other' };
  /* categories renamed in v1.0 — an older config's key still lands somewhere sane */
  const CAT_LEGACY = { slave: 'household', staff: 'employee' };
  const SUBS = ['recurring', 'market', 'properties', 'ledger'];

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }
  function glog(msg) { toGame('finLog', msg); }

  /* ============================================================= state == */
  /* view-owned */
  const state = {
    lines: [],        // {id,name,kind:'income'|'expense',category,amount,domainId,note,icon}
    market: [],       // {id,name,side:'buy'|'sell',price,note,icon}
    properties: [],   // VIEW-owned defs {id,name,cost,value,upkeep,domainId,note,icon}
    settings: { ledgerMax: 120, autoSettle: false },
    /* C++-owned mirror (pushed via finOpen / finState — never sent back) */
    gold: 0,
    debt: 0,
    netWorth: 0,      // gold + owned property value − debt (computed by C++)
    ownedIds: [],     // ids of properties currently owned (C++-owned)
    ledger: [],       // {id,stamp,kind,label,delta,goldBefore,goldAfter,debtAfter}
  };

  const ui = {
    sub: 'recurring',
    editing: false,
    filter: '',
    sel: -1,
    shown: false,
    inited: false,
    icons: [],        // available custom icon paths (from finIconList), for the picker
    iconFor: null,    // {kind:'line'|'market', id} while the icon picker is open
    collapsed: {},    // group key -> true while that Recurring section is collapsed
  };

  /* =========================================================== helpers == */

  const $ = (id) => document.getElementById(id);
  const els = {};

  function h(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'data') { for (const d in v) e.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach((c) => {
        if (c == null || c === false) return;
        e.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }

  function nameNodes(text, q) {
    text = String(text == null ? '' : text);
    if (!q) return [document.createTextNode(text)];
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [document.createTextNode(text)];
    return [
      document.createTextNode(text.slice(0, i)),
      h('mark', null, text.slice(i, i + q.length)),
      document.createTextNode(text.slice(i + q.length)),
    ];
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  let toastT = null;
  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = $('fin-toast');
      if (!t) { t = h('div', { id: 'fin-toast', class: 'hidden' }); document.body.append(t); }
    }
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), 2100);
  }

  function coerce(x) {
    if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
    return x;
  }

  /* gold is an integer count of septims; parse tolerant of commas/spaces, clamp >= 0 */
  function parseGold(raw) {
    const n = parseInt(String(raw == null ? '' : raw).replace(/[^0-9-]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : 0;
  }
  /* manual thousands separator (Ultralight's toLocaleString is unreliable) */
  function fmtGold(n) {
    n = Math.round(Number(n) || 0);
    const sign = n < 0 ? '-' : '';
    let s = String(Math.abs(n));
    for (let i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + ',' + s.slice(i);
    return sign + s;
  }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '\u2212' : '') + fmtGold(Math.abs(n)); }

  function initialsOf(name) {
    const parts = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '\u00A7';   // section sign — a coin-ish glyph
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }
  function hueOf(s) {
    s = String(s || '');
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
    return s ? n : 45;
  }

  /* view-relative icon path only: no ../, no absolute, no scheme, no ?v= (Ultralight
     may fold a query into the filename). Anything else collapses to '' -> medallion. */
  function iconSrc(p) {
    p = String(p || '').replace(/\\/g, '/').trim();
    if (!p) return '';
    if (p.indexOf('..') !== -1) return '';
    if (p.charAt(0) === '/') return '';
    if (/^[A-Za-z]:/.test(p)) return '';
    if (/^(?:file|https?|data):/i.test(p)) return '';
    return p;
  }

  let idSeq = 0;
  function newId(prefix) {
    idSeq++;
    return prefix + '-' + Date.now().toString(36) + '-' + idSeq;
  }

  /* ------------------------------------------------------------ saving -- */
  /* view-owned slice ONLY (lines/market/settings). debt/ledger/gold are C++-owned. */

  function payload() {
    return {
      lines: state.lines.map((l) => ({
        id: l.id, name: l.name, kind: l.kind, category: l.category,
        amount: l.amount >>> 0, domainId: l.domainId || '', note: l.note || '', icon: l.icon || '',
      })),
      market: state.market.map((m) => ({
        id: m.id, name: m.name, side: m.side, price: m.price >>> 0,
        note: m.note || '', icon: m.icon || '',
      })),
      properties: state.properties.map((p) => ({
        id: p.id, name: p.name, cost: p.cost >>> 0, value: p.value >>> 0, upkeep: p.upkeep >>> 0,
        domainId: p.domainId || '', note: p.note || '', icon: p.icon || '',
      })),
      settings: { ledgerMax: state.settings.ledgerMax >>> 0 || 120, autoSettle: !!state.settings.autoSettle },
    };
  }
  function save() { toGame('finSave', JSON.stringify(payload())); }
  let saveT = null;
  function saveSoon() { if (saveT) clearTimeout(saveT); saveT = setTimeout(() => { saveT = null; save(); }, SAVE_DEBOUNCE); }
  function flushSave() { if (saveT) { clearTimeout(saveT); saveT = null; save(); } }

  /* ------------------------------------------------------ model helpers -- */

  function lineById(id) { return state.lines.find((l) => l.id === id) || null; }
  function marketById(id) { return state.market.find((m) => m.id === id) || null; }
  function propById(id) { return state.properties.find((p) => p.id === id) || null; }
  function isOwned(id) { return state.ownedIds.indexOf(id) !== -1; }

  function incomeTotal() { return state.lines.reduce((s, l) => s + (l.kind === 'income' ? l.amount : 0), 0); }
  /* owned properties bill their monthly upkeep alongside the expense lines — matches
     what C++ Settle() folds in, so the "Monthly net" preview stays honest. */
  function ownedUpkeepTotal() { return state.properties.reduce((s, p) => s + (isOwned(p.id) ? (p.upkeep || 0) : 0), 0); }
  function expenseTotal() { return state.lines.reduce((s, l) => s + (l.kind === 'expense' ? l.amount : 0), 0) + ownedUpkeepTotal(); }
  function monthlyNet() { return incomeTotal() - expenseTotal(); }

  function lineHay(l) { return (l.name + '\n' + l.note + '\n' + (CAT_LABEL[l.category] || l.category) + '\n' + l.kind).toLowerCase(); }
  function marketHay(m) { return (m.name + '\n' + m.note + '\n' + m.side).toLowerCase(); }
  function propHay(p) { return (p.name + '\n' + p.note + '\n' + (p.domainId || '') + '\n' + (isOwned(p.id) ? 'owned' : 'unowned')).toLowerCase(); }
  function visibleProps() {
    const q = ui.filter.trim().toLowerCase();
    // owned first, then by name — the roster reads as "what you have" before "what you could buy".
    return state.properties
      .filter((p) => !q || propHay(p).includes(q))
      .map((p, i) => [p, i])
      .sort((a, b) => (Number(isOwned(b[0].id)) - Number(isOwned(a[0].id))) || (a[1] - b[1]))
      .map((p) => p[0]);
  }

  function lineRank(l) {
    if (l.kind === 'income') return -1;
    const i = CATEGORIES.indexOf(l.category);
    return i >= 0 ? i : 99;
  }
  function visibleLines() {
    const q = ui.filter.trim().toLowerCase();
    const list = state.lines.filter((l) => !q || lineHay(l).includes(q));
    // Group order: Income first, then expenses in CATEGORIES order. Index tiebreak
    // keeps it stable, so renderRecurring can drop a header on each group change and
    // the flat index still matches ui.sel / keyboard nav.
    return list
      .map((l, i) => [l, i])
      .sort((a, b) => (lineRank(a[0]) - lineRank(b[0])) || (a[1] - b[1]))
      .map((p) => p[0]);
  }
  function visibleMarket() {
    const q = ui.filter.trim().toLowerCase();
    return state.market.filter((m) => !q || marketHay(m).includes(q));
  }

  /* ============================================================ render == */

  function render() { renderSummary(); renderNav(); renderBody(); syncChrome(); }

  function syncChrome() {
    const onLedger = ui.sub === 'ledger';
    if (els.editBtn) {
      els.editBtn.classList.toggle('on', ui.editing);
      els.editBtn.textContent = ui.editing ? 'Done' : 'Edit';
      els.editBtn.classList.toggle('hidden', onLedger);   // nothing to edit in the ledger
    }
    if (els.addBtn) {
      els.addBtn.classList.toggle('hidden', onLedger);
      els.addBtn.textContent = ui.sub === 'market' ? '＋ Item' : ui.sub === 'properties' ? '＋ Property' : '＋ Line';
    }
    /* The size strip follows the Edit button exactly — including hiding on the
       Ledger, where Edit itself is hidden and an orphan strip would be the only
       thing edit mode appeared to do. */
    if (els.editRow) {
      els.editRow.classList.toggle('hidden', !(ui.editing && !onLedger));
      if (window.HDScale) HDScale.sync('finances');
    }
    if (els.autoBtn) {
      els.autoBtn.classList.toggle('on', !!state.settings.autoSettle);
      els.autoBtn.textContent = state.settings.autoSettle ? '⟳ Auto: On' : '⟳ Auto';
      els.autoBtn.classList.toggle('hidden', onLedger);
    }
    document.body.classList.toggle('fin-editing', ui.editing);
  }

  function renderSummary() {
    const net = monthlyNet();
    els.gold.textContent = fmtGold(state.gold) + ' g';
    els.net.textContent = signed(net) + ' g';
    els.net.className = 'fin-stat-v ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : '');
    els.debt.textContent = fmtGold(state.debt) + ' g';
    els.debt.className = 'fin-stat-v ' + (state.debt > 0 ? 'neg' : '');
    if (els.worth) {
      els.worth.textContent = fmtGold(state.netWorth) + ' g';
      els.worth.className = 'fin-stat-v ' + (state.netWorth > 0 ? 'pos' : state.netWorth < 0 ? 'neg' : '');
    }

    // Settle button shows what the press will do this cycle.
    const income = incomeTotal(), expense = expenseTotal();
    const bill = expense + state.debt;
    els.settleBtn.disabled = (income === 0 && bill === 0);
    els.settleBtn.title = 'Collect ' + fmtGold(income) + ' income, pay ' + fmtGold(bill) +
      ' (expenses' + (state.debt ? ' + debt' : '') + '). Unpaid remainder becomes debt.';
    els.settleBtn.querySelector('.fin-settle-sub').textContent =
      '+' + fmtGold(income) + ' / \u2212' + fmtGold(bill);
  }

  function renderNav() {
    els.nav.textContent = '';
    SUBS.forEach((s) => {
      const count = s === 'recurring' ? state.lines.length : s === 'market' ? state.market.length
        : s === 'properties' ? state.properties.length : state.ledger.length;
      els.nav.append(h('button', {
        class: 'fin-subtab' + (ui.sub === s ? ' active' : ''),
        data: { sub: s },
        onClick: () => { ui.sub = s; ui.sel = -1; render(); },
      }, s.charAt(0).toUpperCase() + s.slice(1),
        h('span', { class: 'fin-subcount' }, String(count))));
    });
  }

  function medalOf(rec, hueKey) {
    const src = iconSrc(rec.icon);
    if (src) {
      const img = h('img', { class: 'fin-medal img', src: src, alt: '' });
      img.addEventListener('error', function () {
        const m = h('span', { class: 'fin-medal' }, initialsOf(rec.name));
        m.style.setProperty('--fin-hue', String(hueOf(hueKey)));
        if (img.parentNode) img.parentNode.replaceChild(m, img);
      });
      return img;
    }
    const m = h('span', { class: 'fin-medal' }, initialsOf(rec.name));
    m.style.setProperty('--fin-hue', String(hueOf(hueKey)));
    return m;
  }

  function renderBody() {
    els.list.textContent = '';
    els.list.classList.remove('hidden');
    els.empty.classList.add('hidden');

    if (ui.sub === 'recurring') return renderRecurring();
    if (ui.sub === 'market') return renderMarket();
    if (ui.sub === 'properties') return renderProperties();
    return renderLedger();
  }

  /* ---- Recurring ---- */
  function lineRow(l, i) {
    const q = ui.filter.trim();
    const sub = [
      h('span', { class: 'fin-chip cat', title: 'Category' }, CAT_LABEL[l.category] || l.category),
    ];
    if (l.domainId) sub.push(h('span', { class: 'fin-chip dom', title: 'Tied to a domain' }, '\u2302 ' + l.domainId));
    if (l.note) sub.push(h('span', { class: 'fin-note', title: l.note }, nameNodes(l.note, q)));

    const amt = h('span', {
      class: 'fin-amt ' + (l.kind === 'income' ? 'pos' : 'neg'),
      title: l.kind === 'income' ? 'Monthly income' : 'Monthly expense',
    }, (l.kind === 'income' ? '+' : '\u2212') + fmtGold(l.amount) + ' g');

    const right = h('div', { class: 'fin-row-right' }, amt);
    if (ui.editing) {
      right.append(h('button', {
        class: 'fin-icon-btn danger', title: 'Remove this line',
        onClick: (e) => { e.stopPropagation(); deleteLine(l); },
      }, '\uD83D\uDDD1'));
    }

    return h('div', {
      class: 'fin-row' + (i === ui.sel ? ' sel' : ''),
      role: 'listitem', data: { id: l.id },
      title: 'Right-click to edit',
      onContextmenu: (e) => { e.preventDefault(); openLineMenu(l, e.clientX, e.clientY); },
      onClick: (e) => { if (!ui.editing) openLineMenu(l, e.clientX, e.clientY); },
    },
      medalOf(l, l.category),
      h('div', { class: 'fin-body' },
        h('div', { class: 'fin-name' }, nameNodes(l.name, q)),
        h('div', { class: 'fin-subline' }, sub)),
      right);
  }

  function groupKeyOf(l) { return l.kind === 'income' ? 'income' : 'exp:' + l.category; }
  function groupLabelOf(l) { return l.kind === 'income' ? 'Income' : (CAT_LABEL[l.category] || l.category); }

  function renderRecurring() {
    const rows = visibleLines();
    els.count.textContent = String(rows.length);
    if (ui.sel >= rows.length) ui.sel = rows.length - 1;
    if (!rows.length) return showEmpty(
      ui.filter.trim() ? 'No line matches' : 'No recurring lines yet',
      ui.filter.trim() ? 'Nothing matches \u201C' + ui.filter.trim() + '\u201D.'
        : 'Add taxes, wages, upkeep and income. Hit Settle once a month to net them against your gold.');

    // Section header per group (Income, then each expense category present), with
    // its count + monthly subtotal. Click a header to collapse / expand the group.
    const sums = {}, counts = {};
    rows.forEach((l) => { const k = groupKeyOf(l); sums[k] = (sums[k] || 0) + (l.amount || 0); counts[k] = (counts[k] || 0) + 1; });

    let cur = null, hidden = false;
    rows.forEach((l, i) => {
      const k = groupKeyOf(l);
      if (k !== cur) {
        cur = k;
        hidden = !!ui.collapsed[k];
        const inc = l.kind === 'income';
        els.list.append(h('div', {
          class: 'fin-group-head ' + (inc ? 'inc' : 'exp') + (hidden ? ' collapsed' : ''),
          role: 'button', title: (hidden ? 'Show ' : 'Hide ') + groupLabelOf(l),
          onClick: () => { ui.collapsed[k] = !ui.collapsed[k]; render(); },
        },
          h('span', { class: 'fin-group-chev' }, hidden ? '\u25b8' : '\u25be'),
          h('span', { class: 'fin-group-label' }, groupLabelOf(l)),
          h('span', { class: 'fin-group-count' }, String(counts[k])),
          h('span', { class: 'fin-group-sum ' + (inc ? 'pos' : 'neg') },
            (inc ? '+' : '\u2212') + fmtGold(sums[k]) + ' g')));
      }
      if (!hidden) els.list.append(lineRow(l, i));
    });
  }

  /* ---- Market ---- */
  function marketRow(m, i) {
    const q = ui.filter.trim();
    const isBuy = m.side === 'buy';
    const right = h('div', { class: 'fin-row-right' },
      h('span', { class: 'fin-price', title: isBuy ? 'Costs' : 'Sells for' }, fmtGold(m.price) + ' g'),
      h('button', {
        class: 'fin-act ' + (isBuy ? 'buy' : 'sell'),
        title: isBuy ? 'Spend ' + fmtGold(m.price) + ' g' : 'Gain ' + fmtGold(m.price) + ' g',
        onClick: (e) => { e.stopPropagation(); isBuy ? buy(m) : sell(m); },
      }, isBuy ? 'Buy' : 'Sell'));
    if (ui.editing) {
      right.append(h('button', {
        class: 'fin-icon-btn danger', title: 'Remove this item',
        onClick: (e) => { e.stopPropagation(); deleteMarket(m); },
      }, '\uD83D\uDDD1'));
    }
    const sub = [h('span', { class: 'fin-chip ' + (isBuy ? 'buyc' : 'sellc') }, isBuy ? 'Buy' : 'Sell')];
    if (m.note) sub.push(h('span', { class: 'fin-note', title: m.note }, nameNodes(m.note, q)));

    return h('div', {
      class: 'fin-row' + (i === ui.sel ? ' sel' : ''),
      role: 'listitem', data: { id: m.id },
      onContextmenu: (e) => { e.preventDefault(); openMarketMenu(m, e.clientX, e.clientY); },
    },
      medalOf(m, m.side),
      h('div', { class: 'fin-body' },
        h('div', { class: 'fin-name' }, nameNodes(m.name, q)),
        h('div', { class: 'fin-subline' }, sub)),
      right);
  }

  function renderMarket() {
    const rows = visibleMarket();
    els.count.textContent = String(rows.length);
    if (!rows.length) return showEmpty(
      ui.filter.trim() ? 'No item matches' : 'No market items yet',
      ui.filter.trim() ? 'Nothing matches \u201C' + ui.filter.trim() + '\u201D.'
        : 'Add a thing with a name + price; press Buy to spend that gold or Sell to gain it.');
    rows.forEach((m, i) => els.list.append(marketRow(m, i)));
  }

  /* ---- Properties ---- *
   * A durable asset: Buy spends its cost and marks it owned; Sell returns its value
   * in gold and drops it. Net worth counts owned properties' value. Ownership is
   * C++-owned (state.ownedIds), pushed back after each op. */
  function propRow(p, i) {
    const q = ui.filter.trim();
    const owned = isOwned(p.id);

    const sub = [];
    sub.push(h('span', { class: 'fin-chip ' + (owned ? 'owned' : 'unowned'), title: owned ? 'You own this' : 'Not yet acquired' },
      owned ? '★ Owned' : 'For sale'));
    sub.push(h('span', { class: 'fin-chip val', title: 'Worth (counts toward net worth)' }, 'value ' + fmtGold(p.value) + ' g'));
    if (p.upkeep) sub.push(h('span', { class: 'fin-chip cat', title: 'Monthly upkeep while owned' }, '−' + fmtGold(p.upkeep) + '/mo'));
    if (p.domainId) sub.push(h('span', { class: 'fin-chip dom', title: 'Tied to a domain' }, '⌂ ' + p.domainId));
    if (p.note) sub.push(h('span', { class: 'fin-note', title: p.note }, nameNodes(p.note, q)));

    const right = h('div', { class: 'fin-row-right' },
      h('span', { class: 'fin-price', title: owned ? 'Sells for its value' : 'Costs to buy' },
        fmtGold(owned ? p.value : p.cost) + ' g'),
      h('button', {
        class: 'fin-act ' + (owned ? 'sell' : 'buy'),
        title: owned ? 'Sell for ' + fmtGold(p.value) + ' g' : 'Spend ' + fmtGold(p.cost) + ' g to acquire',
        onClick: (e) => { e.stopPropagation(); owned ? sellProp(p) : buyProp(p); },
      }, owned ? 'Sell' : 'Buy'));
    if (ui.editing) {
      right.append(h('button', {
        class: 'fin-icon-btn danger', title: 'Remove this property',
        onClick: (e) => { e.stopPropagation(); deleteProperty(p); },
      }, '🗑'));
    }

    return h('div', {
      class: 'fin-row' + (i === ui.sel ? ' sel' : '') + (owned ? ' owned' : ''),
      role: 'listitem', data: { id: p.id },
      title: 'Right-click to edit',
      onContextmenu: (e) => { e.preventDefault(); openPropertyMenu(p, e.clientX, e.clientY); },
      onClick: (e) => { if (ui.editing) openPropertyMenu(p, e.clientX, e.clientY); },
    },
      medalOf(p, p.id),
      h('div', { class: 'fin-body' },
        h('div', { class: 'fin-name' }, nameNodes(p.name, q)),
        h('div', { class: 'fin-subline' }, sub)),
      right);
  }

  function renderProperties() {
    const rows = visibleProps();
    els.count.textContent = String(rows.length);
    if (ui.sel >= rows.length) ui.sel = rows.length - 1;
    if (!rows.length) return showEmpty(
      ui.filter.trim() ? 'No property matches' : 'No properties yet',
      ui.filter.trim() ? 'Nothing matches “' + ui.filter.trim() + '”.'
        : 'Add an estate with a cost + value. Buy spends the gold and adds its value to your net worth; Sell gives the gold back.');
    rows.forEach((p, i) => els.list.append(propRow(p, i)));
  }

  /* ---- Ledger ---- */
  function ledgerRow(e) {
    const cls = e.delta > 0 ? 'pos' : e.delta < 0 ? 'neg' : '';
    return h('div', { class: 'fin-led-row' },
      h('span', { class: 'fin-led-kind k-' + (e.kind || 'settle') }, (e.kind || 'settle')),
      h('div', { class: 'fin-led-body' },
        h('div', { class: 'fin-led-label' }, e.label || '\u2014'),
        h('div', { class: 'fin-led-stamp' }, (e.stamp || '') +
          (e.debtAfter ? ' \u00B7 debt ' + fmtGold(e.debtAfter) : ''))),
      h('span', { class: 'fin-led-delta ' + cls }, signed(e.delta) + ' g'));
  }

  function renderLedger() {
    els.count.textContent = String(state.ledger.length);
    if (!state.ledger.length) return showEmpty('No history yet',
      'Settle, Buy and Sell all record here — newest first, with your gold before/after.');
    state.ledger.forEach((e) => els.list.append(ledgerRow(e)));
  }

  function showEmpty(title, subtext) {
    els.list.classList.add('hidden');
    els.empty.classList.remove('hidden');
    els.empty.textContent = '';
    els.empty.append(h('div', { class: 'empty-icon' }, ui.filter.trim() ? '\u2315' : '\u00A7'));
    els.empty.append(h('div', { class: 'empty-title' }, title));
    els.empty.append(h('div', { class: 'empty-sub' }, subtext));
  }

  /* ======================================================== actions ===== */

  function settle() {
    closeCtx();
    els.settleBtn.classList.add('flash');
    setTimeout(() => els.settleBtn.classList.remove('flash'), 400);
    toGame('finSettle');
  }
  function buy(m) {
    const row = els.list.querySelector('.fin-row[data-id="' + cssEsc(m.id) + '"]');
    if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 400); }
    toGame('finBuy', JSON.stringify({ id: m.id, name: m.name, price: m.price >>> 0 }));
  }
  function sell(m) {
    const row = els.list.querySelector('.fin-row[data-id="' + cssEsc(m.id) + '"]');
    if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 400); }
    toGame('finSell', JSON.stringify({ id: m.id, name: m.name, value: m.price >>> 0 }));
  }
  function flashRow(id) {
    const row = els.list.querySelector('.fin-row[data-id="' + cssEsc(id) + '"]');
    if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 400); }
  }
  function buyProp(p) { flashRow(p.id); toGame('finBuyProp', JSON.stringify({ id: p.id })); }
  function sellProp(p) { flashRow(p.id); toGame('finSellProp', JSON.stringify({ id: p.id })); }

  /* ======================================================= mutations ==== */

  function addLine() {
    const l = { id: newId('l'), name: 'New line', kind: 'expense', category: 'other', amount: 0, domainId: '', note: '', icon: '' };
    state.lines.unshift(l);
    ui.sub = 'recurring';
    saveSoon(); render();
    openLineMenu(l, 120, 140);
  }
  function deleteLine(l) {
    const i = state.lines.findIndex((x) => x.id === l.id);
    if (i < 0) return;
    state.lines.splice(i, 1);
    saveSoon(); render();
    toast('Removed \u201C' + l.name + '\u201D');
  }
  function setLine(l, field, value) {
    if (l[field] === value) return;
    l[field] = value;
    saveSoon(); render();
  }

  function addMarket() {
    const m = { id: newId('m'), name: 'New item', side: 'buy', price: 0, note: '', icon: '' };
    state.market.unshift(m);
    ui.sub = 'market';
    saveSoon(); render();
    openMarketMenu(m, 120, 140);
  }
  function deleteMarket(m) {
    const i = state.market.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    state.market.splice(i, 1);
    saveSoon(); render();
    toast('Removed \u201C' + m.name + '\u201D');
  }
  function setMarket(m, field, value) {
    if (m[field] === value) return;
    m[field] = value;
    saveSoon(); render();
  }

  function addProperty() {
    const p = { id: newId('p'), name: 'New property', cost: 0, value: 0, upkeep: 0, domainId: '', note: '', icon: '' };
    state.properties.unshift(p);
    ui.sub = 'properties';
    saveSoon(); render();
    openPropertyMenu(p, 120, 140);
  }
  function deleteProperty(p) {
    const i = state.properties.findIndex((x) => x.id === p.id);
    if (i < 0) return;
    state.properties.splice(i, 1);
    saveSoon(); render();
    toast('Removed “' + p.name + '”');
  }
  function setProperty(p, field, value) {
    if (p[field] === value) return;
    p[field] = value;
    saveSoon(); render();
  }

  /* ========================================================= ctx menu === */

  let ctxEl = null;
  function ctxHost() { return $('overlay') || document.body; }
  function ctxOutside(e) { if (ctxEl && !ctxEl.contains(e.target)) dismissCtx(); }
  // DOM-only teardown: the icon-picker rebuild goes THROUGH closeCtx, so it must
  // NOT clear ui.iconFor (that would wipe the picker it's re-opening). A genuine
  // dismiss (outside click / Esc / pane hide) goes through dismissCtx instead.
  function closeCtx() {
    if (!ctxEl) return;
    ctxEl.remove(); ctxEl = null;
    document.removeEventListener('mousedown', ctxOutside, true);
  }
  function dismissCtx() { ui.iconFor = null; closeCtx(); }
  function clampCtx(x, y) {
    const r = ctxEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let nx = x, ny = y;
    if (nx + r.width > vw - 6) nx = vw - r.width - 6;
    if (ny + r.height > vh - 6) ny = vh - r.height - 6;
    ctxEl.style.left = Math.max(6, nx) + 'px';
    ctxEl.style.top = Math.max(6, ny) + 'px';
  }
  function mountCtx(items, x, y) {
    ctxEl = h('div', { id: 'fin-ctx', role: 'menu' }, items);
    ctxHost().append(ctxEl);
    clampCtx(x, y);
    setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
  }
  function fieldRow(label, input) { return h('div', { class: 'fin-ctx-field' }, h('label', null, label), input); }
  function textInput(value, ph, on) {
    return h('input', {
      class: 'fin-ctx-input', type: 'text', value: value == null ? '' : String(value), spellcheck: 'false',
      placeholder: ph || '',
      onClick: (e) => e.stopPropagation(),
      onChange: (e) => on(e.target.value),
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
    });
  }
  function armedDelete(label, on) {
    let armed = false;
    const lbl = h('span', { class: 'fin-ctx-lbl' }, label);
    const btn = h('button', {
      class: 'fin-ctx-item danger',
      onClick: (e) => {
        e.stopPropagation();
        if (!armed) { armed = true; btn.classList.add('confirm'); lbl.textContent = label + ' — click again'; return; }
        closeCtx(); on();
      },
    }, h('span', { class: 'fin-ctx-check' }, '\uD83D\uDDD1'), lbl);
    return btn;
  }

  function openLineMenu(l, x, y) {
    closeCtx();
    const items = [h('div', { class: 'fin-ctx-head', title: l.name }, l.name)];

    // income / expense toggle
    items.push(fieldRow('Type', h('div', { class: 'fin-seg' },
      h('button', { class: 'fin-seg-b' + (l.kind === 'income' ? ' on pos' : ''), onClick: (e) => { e.stopPropagation(); setLine(l, 'kind', 'income'); rebuildLineMenu(l, x, y); } }, 'Income'),
      h('button', { class: 'fin-seg-b' + (l.kind === 'expense' ? ' on neg' : ''), onClick: (e) => { e.stopPropagation(); setLine(l, 'kind', 'expense'); rebuildLineMenu(l, x, y); } }, 'Expense'))));

    items.push(fieldRow('Name', textInput(l.name, 'What is it', (v) => setLine(l, 'name', (v || '').trim() || 'Untitled'))));
    items.push(fieldRow('Amount', textInput(l.amount ? fmtGold(l.amount) : '', 'gold / month', (v) => setLine(l, 'amount', parseGold(v)))));

    const catSel = h('select', {
      class: 'fin-ctx-select', onClick: (e) => e.stopPropagation(),
      onChange: (e) => setLine(l, 'category', e.target.value),
    });
    CATEGORIES.forEach((c) => { const o = h('option', { value: c }, CAT_LABEL[c]); if (c === l.category) o.selected = true; catSel.append(o); });
    items.push(fieldRow('Category', catSel));

    items.push(fieldRow('Domain', textInput(l.domainId, 'optional — a domain name', (v) => setLine(l, 'domainId', (v || '').trim()))));
    items.push(fieldRow('Note', textInput(l.note, 'optional', (v) => setLine(l, 'note', (v || '').trim()))));
    items.push(iconField(l, 'line'));

    items.push(h('div', { class: 'fin-ctx-sep' }));
    items.push(armedDelete('Delete line', () => deleteLine(l)));
    mountCtx(items, x, y);
  }
  function rebuildLineMenu(l, x, y) {
    const r = ctxEl ? ctxEl.getBoundingClientRect() : { left: x, top: y };
    closeCtx(); openLineMenu(l, r.left, r.top);
  }

  function openMarketMenu(m, x, y) {
    closeCtx();
    const items = [h('div', { class: 'fin-ctx-head', title: m.name }, m.name)];
    items.push(fieldRow('Action', h('div', { class: 'fin-seg' },
      h('button', { class: 'fin-seg-b' + (m.side === 'buy' ? ' on neg' : ''), onClick: (e) => { e.stopPropagation(); setMarket(m, 'side', 'buy'); rebuildMarketMenu(m, x, y); } }, 'Buy (spend)'),
      h('button', { class: 'fin-seg-b' + (m.side === 'sell' ? ' on pos' : ''), onClick: (e) => { e.stopPropagation(); setMarket(m, 'side', 'sell'); rebuildMarketMenu(m, x, y); } }, 'Sell (gain)'))));
    items.push(fieldRow('Name', textInput(m.name, 'What is it', (v) => setMarket(m, 'name', (v || '').trim() || 'Untitled'))));
    items.push(fieldRow('Price', textInput(m.price ? fmtGold(m.price) : '', 'gold', (v) => setMarket(m, 'price', parseGold(v)))));
    items.push(fieldRow('Note', textInput(m.note, 'optional', (v) => setMarket(m, 'note', (v || '').trim()))));
    items.push(iconField(m, 'market'));
    items.push(h('div', { class: 'fin-ctx-sep' }));
    items.push(armedDelete('Delete item', () => deleteMarket(m)));
    mountCtx(items, x, y);
  }
  function rebuildMarketMenu(m, x, y) {
    const r = ctxEl ? ctxEl.getBoundingClientRect() : { left: x, top: y };
    closeCtx(); openMarketMenu(m, r.left, r.top);
  }

  function openPropertyMenu(p, x, y) {
    closeCtx();
    const owned = isOwned(p.id);
    const items = [h('div', { class: 'fin-ctx-head', title: p.name }, p.name)];
    items.push(h('div', { class: 'fin-ctx-sub' + (owned ? ' owned' : '') },
      owned ? '★ Owned — Sell returns its value in gold' : 'Not owned — Buy spends its cost'));
    items.push(fieldRow('Name', textInput(p.name, 'What is it', (v) => setProperty(p, 'name', (v || '').trim() || 'Untitled'))));
    items.push(fieldRow('Cost', textInput(p.cost ? fmtGold(p.cost) : '', 'gold to buy', (v) => setProperty(p, 'cost', parseGold(v)))));
    items.push(fieldRow('Value', textInput(p.value ? fmtGold(p.value) : '', 'worth (net worth + sale)', (v) => setProperty(p, 'value', parseGold(v)))));
    items.push(fieldRow('Upkeep', textInput(p.upkeep ? fmtGold(p.upkeep) : '', 'gold / month (optional)', (v) => setProperty(p, 'upkeep', parseGold(v)))));
    items.push(fieldRow('Domain', textInput(p.domainId, 'optional — a domain name', (v) => setProperty(p, 'domainId', (v || '').trim()))));
    items.push(fieldRow('Note', textInput(p.note, 'optional', (v) => setProperty(p, 'note', (v || '').trim()))));
    items.push(iconField(p, 'property'));
    items.push(h('div', { class: 'fin-ctx-sep' }));
    items.push(armedDelete('Delete property', () => deleteProperty(p)));
    mountCtx(items, x, y);
  }
  function rebuildPropertyMenu(p, x, y) {
    const r = ctxEl ? ctxEl.getBoundingClientRect() : { left: x, top: y };
    closeCtx(); openPropertyMenu(p, r.left, r.top);
  }
  /* route an icon-picker rebuild to the menu that owns `kind` */
  function recById(kind, id) { return kind === 'line' ? lineById(id) : kind === 'market' ? marketById(id) : propById(id); }
  function rebuildMenuFor(kind, rec, x, y) {
    (kind === 'line' ? rebuildLineMenu : kind === 'market' ? rebuildMarketMenu : rebuildPropertyMenu)(rec, x, y);
  }

  /* ---- image field (view-relative icons/custom paths; upload is the portal's job) ---- */
  function iconField(rec, kind) {
    const cur = iconSrc(rec.icon);
    const thumb = cur
      ? h('img', { class: 'fin-ctx-thumb', src: cur, alt: '' })
      : h('span', { class: 'fin-ctx-thumb none' }, initialsOf(rec.name));
    const pickBtn = h('button', {
      class: 'fin-ctx-mini', onClick: (e) => { e.stopPropagation(); toggleIconPicker(rec, kind); },
    }, cur ? 'Change' : 'Pick image');
    const clearBtn = rec.icon ? h('button', {
      class: 'fin-ctx-mini danger', onClick: (e) => { e.stopPropagation(); setIcon(rec, kind, ''); },
    }, 'Clear') : null;
    const wrap = h('div', { class: 'fin-ctx-field icon' },
      h('label', null, 'Image'),
      h('div', { class: 'fin-ctx-iconrow' }, thumb, pickBtn, clearBtn),
      h('div', { class: 'fin-ctx-iconhint' }, 'Upload from the Deck Portal on your phone, or pick a custom icon.'));
    if (ui.iconFor && ui.iconFor.kind === kind && ui.iconFor.id === rec.id) {
      wrap.append(iconGrid(rec, kind));
    }
    return wrap;
  }
  function toggleIconPicker(rec, kind) {
    const open = ui.iconFor && ui.iconFor.kind === kind && ui.iconFor.id === rec.id;
    ui.iconFor = open ? null : { kind: kind, id: rec.id };
    if (!open && !ui.icons.length) toGame('finIcons');   // ask C++ for the custom pool
    const x = ctxEl ? ctxEl.getBoundingClientRect().left : 120;
    const y = ctxEl ? ctxEl.getBoundingClientRect().top : 140;
    rebuildMenuFor(kind, rec, x, y);
  }
  function iconGrid(rec, kind) {
    const grid = h('div', { class: 'fin-ctx-grid' });
    if (!ui.icons.length) { grid.append(h('div', { class: 'fin-ctx-iconhint' }, 'No custom icons found. Drop PNGs into the deck\u2019s icons\\custom folder, or upload from the phone.')); return grid; }
    ui.icons.forEach((p) => {
      grid.append(h('button', {
        class: 'fin-ctx-tile' + (rec.icon === p ? ' sel' : ''), title: p,
        onClick: (e) => { e.stopPropagation(); setIcon(rec, kind, p); },
      }, h('img', { src: iconSrc(p), alt: '' })));
    });
    return grid;
  }
  function setIcon(rec, kind, path) {
    rec.icon = path || '';
    saveSoon();
    const x = ctxEl ? ctxEl.getBoundingClientRect().left : 120;
    const y = ctxEl ? ctxEl.getBoundingClientRect().top : 140;
    rebuildMenuFor(kind, rec, x, y);
    render();
  }

  /* ========================================================== input ===== */

  function ours(el) {
    if (!el) return false;
    const pane = $('fin-pane');
    return !!((pane && pane.contains(el)) || (ctxEl && ctxEl.contains(el)));
  }
  function eat(e) { e.preventDefault(); e.stopPropagation(); }

  function onKey(e) {
    if (!ui.shown) return;
    const key = e.key;
    if (ctxEl) {
      if (key === 'Escape') { eat(e); dismissCtx(); }
      else e.stopPropagation();
      return;
    }
    const ae = document.activeElement;
    const inOurInput = ours(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT');
    if (key === 'Escape') {
      if (inOurInput && ae !== els.search) { eat(e); ae.blur(); return; }
      if (ui.filter) { eat(e); setFilter(''); return; }
      return;
    }
    if (key === 'F2') { eat(e); toggleEdit(); return; }
    if (key === 'Tab') return;
    // sub-tab cycling with [ and ]
    if ((key === '[' || key === ']') && !inOurInput) {
      eat(e);
      let idx = SUBS.indexOf(ui.sub);
      idx = (idx + (key === ']' ? 1 : SUBS.length - 1)) % SUBS.length;
      ui.sub = SUBS[idx]; ui.sel = -1; render();
      return;
    }
    if (inOurInput) { e.stopPropagation(); return; }
    if (key && key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.stopPropagation();
      if (els.search) els.search.focus();
    }
  }

  function setFilter(v) {
    ui.filter = v;
    if (els.search && els.search.value !== v) els.search.value = v;
    ui.sel = -1;
    renderBody();
    if (els.count) els.count.textContent = String(
      ui.sub === 'recurring' ? visibleLines().length : ui.sub === 'market' ? visibleMarket().length
        : ui.sub === 'properties' ? visibleProps().length : state.ledger.length);
  }
  function toggleEdit() { closeCtx(); ui.editing = !ui.editing; render(); }
  function toggleAuto() {
    state.settings.autoSettle = !state.settings.autoSettle;
    flushSave();               // persist now — C++ MergeViewSlice reads settings.autoSettle
    syncChrome();
    toast(state.settings.autoSettle
      ? '⟳ Auto-settle ON — settles once each in-game month'
      : 'Auto-settle turned off');
  }

  /* =========================================================== receive == */

  function onCfg(cfg) {
    cfg = cfg || {};
    state.lines = (Array.isArray(cfg.lines) ? cfg.lines : []).map(normLine).filter((l) => l.id);
    state.market = (Array.isArray(cfg.market) ? cfg.market : []).map(normMarket).filter((m) => m.id);
    state.properties = (Array.isArray(cfg.properties) ? cfg.properties : []).map(normProperty).filter((p) => p.id);
    state.settings = {
      ledgerMax: (cfg.settings && cfg.settings.ledgerMax >>> 0) || 120,
      autoSettle: !!(cfg.settings && cfg.settings.autoSettle),
    };
    if (typeof cfg.gold === 'number') state.gold = cfg.gold >>> 0;
    if (typeof cfg.debt === 'number') state.debt = cfg.debt >>> 0;
    if (typeof cfg.netWorth === 'number') state.netWorth = cfg.netWorth | 0;
    if (Array.isArray(cfg.ownedProps)) state.ownedIds = cfg.ownedProps.filter((s) => typeof s === 'string');
    if (Array.isArray(cfg.ledger)) state.ledger = cfg.ledger.map(normLedger);
    if (Array.isArray(cfg.icons)) ui.icons = cfg.icons.filter((p) => typeof p === 'string');
    ui.editing = false; ui.sel = -1;
    setFilter('');
    render();
  }
  function normCat(c) {
    c = String(c || '');
    if (CAT_LEGACY[c]) c = CAT_LEGACY[c];
    return CATEGORIES.indexOf(c) !== -1 ? c : 'other';
  }
  function normLine(l) {
    l = l || {};
    return {
      id: String(l.id || ''), name: String(l.name || 'Untitled'),
      kind: l.kind === 'income' ? 'income' : 'expense',
      category: normCat(l.category),
      amount: (l.amount >>> 0) || 0, domainId: String(l.domainId || ''),
      note: String(l.note || ''), icon: String(l.icon || ''),
    };
  }
  function normMarket(m) {
    m = m || {};
    return {
      id: String(m.id || ''), name: String(m.name || 'Untitled'),
      side: m.side === 'sell' ? 'sell' : 'buy', price: (m.price >>> 0) || 0,
      note: String(m.note || ''), icon: String(m.icon || ''),
    };
  }
  function normProperty(p) {
    p = p || {};
    return {
      id: String(p.id || ''), name: String(p.name || 'Untitled'),
      cost: (p.cost >>> 0) || 0, value: (p.value >>> 0) || 0, upkeep: (p.upkeep >>> 0) || 0,
      domainId: String(p.domainId || ''), note: String(p.note || ''), icon: String(p.icon || ''),
    };
  }
  function normLedger(e) {
    e = e || {};
    return {
      id: String(e.id || ''), stamp: String(e.stamp || ''), kind: String(e.kind || 'settle'),
      label: String(e.label || ''), delta: Number(e.delta) || 0,
      goldBefore: Number(e.goldBefore) || 0, goldAfter: Number(e.goldAfter) || 0,
      debtAfter: Number(e.debtAfter) || 0,
    };
  }

  /* C++ pushes the authoritative gold/debt/ledger after any op */
  function onState(s) {
    s = s || {};
    if (typeof s.gold === 'number') state.gold = s.gold >>> 0;
    if (typeof s.debt === 'number') state.debt = s.debt >>> 0;
    if (typeof s.netWorth === 'number') state.netWorth = s.netWorth | 0;
    if (Array.isArray(s.ownedProps)) state.ownedIds = s.ownedProps.filter((x) => typeof x === 'string');
    if (Array.isArray(s.ledger)) state.ledger = s.ledger.map(normLedger);
    renderSummary(); renderNav();
    // a buy/sell flips ownership → the Properties list must repaint too
    if (ui.sub === 'ledger' || ui.sub === 'properties') renderBody();
  }
  function onResult(r) {
    r = r || {};
    if (r.msg) toast(r.msg);
  }
  function onSaved(ok) { if (ok === false || ok === 'false') toast('\u26A0 Save failed \u2014 see HotkeyDeck.log'); }
  function onIconList(list) {
    ui.icons = (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string');
    if (ctxEl && ui.iconFor) {
      const rec = recById(ui.iconFor.kind, ui.iconFor.id);
      if (rec) { const r = ctxEl.getBoundingClientRect(); rebuildMenuFor(ui.iconFor.kind, rec, r.left, r.top); }
    }
  }
  function onClosed() {
    flushSave(); dismissCtx();
    ui.shown = false; ui.editing = false; ui.sel = -1;
    setFilter('');
  }

  function receive(fn, p) {
    switch (fn) {
      case 'finOpen': onCfg(coerce(p)); return true;
      case 'finState': onState(coerce(p)); return true;
      case 'finResult': onResult(coerce(p)); return true;
      case 'finSaved': onSaved(p); return true;
      case 'finIconList': onIconList(coerce(p)); return true;
      // observed, not consumed — app.js's hdClosed still hides the overlay
      case 'finClosed': onClosed(); return false;
      default: return false;
    }
  }

  /* ============================================================ tab ===== */

  function showTab() {
    const btn = document.querySelector('#tabs .tab[data-tab="finances"]');
    if (btn) { btn.click(); return true; }
    if (typeof window.hdSetTab === 'function') { window.hdSetTab('finances'); return true; }
    const pane = $('fin-pane');
    if (!pane) return false;
    pane.classList.remove('hidden');
    onShow();
    return true;
  }

  function onShow() {
    ui.shown = true;
    const pane = $('fin-pane');
    if (pane) pane.classList.remove('hidden');
    ui.sel = -1;
    setFilter('');
    render();
    toGame('finGet');   // pull fresh gold/debt/ledger + the persisted slice
    setTimeout(() => { if (els.search) els.search.focus(); }, 30);
  }
  function onHide() {
    ui.shown = false; dismissCtx(); flushSave();
    const pane = $('fin-pane');
    if (pane) pane.classList.add('hidden');
  }
  function wantsPause() { return true; }

  /* =========================================================== wiring === */

  function chain(name, key) {
    const prev = window[name];
    window[name] = function (info) {
      if (receive(key, info)) return;
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
  }

  function init() {
    if (ui.inited) return true;
    if (!$('fin-pane')) { console.log('[finances] #fin-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;

    els.pane = $('fin-pane');
    els.gold = $('fin-gold');
    els.net = $('fin-net');
    els.debt = $('fin-debt');
    els.settleBtn = $('fin-settle');

    // Net-worth stat — built here (not in the .frag) to keep this a self-contained
    // change: gold + owned property value − debt, pushed by C++. Inserted as a 4th
    // .fin-stat, just before the Settle button.
    if (els.settleBtn && els.settleBtn.parentNode && !$('fin-worth')) {
      const stat = h('div', { class: 'fin-stat', title: 'Gold + owned property value − debt' },
        h('span', { class: 'fin-stat-k' }, 'Net worth'),
        h('span', { id: 'fin-worth', class: 'fin-stat-v' }, '0 g'));
      els.settleBtn.parentNode.insertBefore(stat, els.settleBtn);
    }
    els.worth = $('fin-worth');
    els.nav = $('fin-nav');
    els.search = $('fin-search');
    els.count = $('fin-count');
    els.editBtn = $('fin-edit');
    els.addBtn = $('fin-add');
    els.list = $('fin-list');
    els.empty = $('fin-empty');
    els.editRow = $('fin-editrow');

    /* Size controls for this tab — whole-tab scale plus the round row medal,
       which is the only image the pane draws. Persisted by hd-scale.js into the
       deck's `settings.tabScales`, deliberately NOT into the finances slice:
       that slice is round-tripped whole by C++ and has already cost a reset
       once. Mounted once; hd-scale.js delegates its clicks from document, so
       the strip survives every re-render without re-wiring. */
    if (window.HDScale) HDScale.mount(els.editRow, 'finances');

    // Auto-settle toggle — built here (not in the .frag) to keep this a one-file
    // change; it sits in the toolbar just before Edit.
    els.autoBtn = h('button', {
      class: 'ghost-btn', id: 'fin-auto',
      title: 'Auto-settle: automatically run Settle once per in-game month',
      onClick: toggleAuto,
    }, '⟳ Auto');
    if (els.editBtn && els.editBtn.parentNode) els.editBtn.parentNode.insertBefore(els.autoBtn, els.editBtn);

    els.search.addEventListener('input', (e) => setFilter(e.target.value));
    els.editBtn.addEventListener('click', toggleEdit);
    els.addBtn.addEventListener('click', () => {
      ui.sub === 'market' ? addMarket() : ui.sub === 'properties' ? addProperty() : addLine();
    });
    els.settleBtn.addEventListener('click', settle);
    els.list.addEventListener('scroll', closeCtx, true);
    window.addEventListener('resize', closeCtx);
    window.addEventListener('keydown', onKey, true);

    // C++ -> view entry points
    window.finOpen = function (cfg) { receive('finOpen', cfg); };
    window.finState = function (s) { receive('finState', s); };
    window.finResult = function (r) { receive('finResult', r); };
    window.finSaved = function (ok) { receive('finSaved', ok); };
    window.finIconList = function (l) { receive('finIconList', l); };
    window.finShow = function () { showTab(); };

    chain('hdClosed', 'finClosed');

    render();
    if (DEV) devBoot();
    return true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);

  /* ============================================================== dev === */

  const STANDALONE = !$('deck-pane');

  function devCfg() {
    return {
      gold: 42150, debt: 3200,
      icons: ['icons/custom/coin.png', 'icons/custom/sword.png', 'icons/custom/ring.png'],
      settings: { ledgerMax: 120 },
      lines: [
        { id: 'l1', name: 'Riverwood tithe', kind: 'income', category: 'tax', amount: 1800, domainId: 'Proudspire Manor', note: 'Jarl\u2019s levy' },
        { id: 'l2', name: 'Solitude tribute', kind: 'income', category: 'tax', amount: 5200, domainId: 'Solitude' },
        { id: 'l3', name: 'Markarth customs', kind: 'income', category: 'tax', amount: 3400, domainId: 'Markarth' },
        { id: 'l4', name: 'Household upkeep', kind: 'expense', category: 'service', amount: 2600, note: 'clothes, food, comforts' },
        { id: 'l5', name: 'Stable hands', kind: 'expense', category: 'employee', amount: 900 },
        { id: 'l6', name: 'Household provisioning', kind: 'expense', category: 'household', amount: 700 },
        { id: 'l7', name: 'Breezehome staff', kind: 'expense', category: 'property', amount: 300 },
        { id: 'l8', name: 'Mercenary retainer (Jenassa)', kind: 'expense', category: 'employee', amount: 500 },
      ],
      market: [
        { id: 'm1', name: 'Daedric sword', side: 'buy', price: 12500, icon: 'icons/custom/sword.png' },
        { id: 'm2', name: 'Gift ring for a companion', side: 'buy', price: 2000, icon: 'icons/custom/ring.png' },
        { id: 'm3', name: 'Sell dragon bones (batch)', side: 'sell', price: 4800 },
        { id: 'm4', name: 'Sell enchanted loot', side: 'sell', price: 3200 },
      ],
      properties: [
        { id: 'p1', name: 'Breezehome', cost: 5000, value: 6500, upkeep: 300, domainId: 'Whiterun' },
        { id: 'p2', name: 'Proudspire Manor', cost: 25000, value: 42000, upkeep: 900, domainId: 'Proudspire Manor' },
        { id: 'p3', name: 'Vlindrel Hall', cost: 60000, value: 85000, upkeep: 1400, domainId: 'Markarth' },
      ],
      ownedProps: ['p1', 'p2'],
      netWorth: 42150 + 6500 + 42000 - 3200,   // gold + owned value − debt
      ledger: [
        { id: 'g1', stamp: '17 Last Seed 4E201', kind: 'settle', label: 'Monthly settle', delta: 6900, goldBefore: 35250, goldAfter: 42150, debtAfter: 3200 },
        { id: 'g2', stamp: '12 Last Seed 4E201', kind: 'buy', label: 'Ebony armor', delta: -9800, goldBefore: 45050, goldAfter: 35250, debtAfter: 3200 },
      ],
    };
  }

  function devBoot() {
    window.__finSent = { save: null, settle: 0, buy: null, sell: null, buyProp: null, sellProp: null, icons: 0 };

    window.finGet = function () { setTimeout(() => window.finOpen(devCfg()), 10); };
    window.finSave = function (j) { window.__finSent.save = JSON.parse(j); };
    window.finIcons = function () { window.__finSent.icons++; setTimeout(() => window.finIconList(devCfg().icons), 10); };
    window.finLog = function (s) { console.log('[dev] finances', s); };

    // fake the C++ economy so Settle/Buy/Sell move a mock gold/debt/ledger
    function push(kind, label, delta) {
      const before = state.gold;
      state.gold = Math.max(0, state.gold + delta);
      window.__finLastLedger = { id: 'x' + Date.now(), stamp: '18 Last Seed 4E201', kind: kind, label: label, delta: delta, goldBefore: before, goldAfter: state.gold, debtAfter: state.debt };
      const led = [window.__finLastLedger].concat(state.ledger).slice(0, 120);
      window.finState(JSON.stringify({ gold: state.gold, debt: state.debt, ledger: led }));
    }
    window.finSettle = function () {
      window.__finSent.settle++;
      const income = incomeTotal(), expense = expenseTotal();
      const bill = expense + state.debt;
      const pay = Math.min(state.gold + income, bill);
      const newGold = state.gold + income - pay;
      state.debt = bill - pay;
      const delta = income - pay;
      const before = state.gold; state.gold = newGold;
      const led = [{ id: 'x' + Date.now(), stamp: '18 Last Seed 4E201', kind: 'settle', label: 'Monthly settle', delta: delta, goldBefore: before, goldAfter: newGold, debtAfter: state.debt }].concat(state.ledger).slice(0, 120);
      window.finState(JSON.stringify({ gold: newGold, debt: state.debt, ledger: led }));
      window.finResult(JSON.stringify({ ok: true, msg: 'Settled: +' + fmtGold(income) + ' \u00B7 \u2212' + fmtGold(pay) + (state.debt ? ' \u00B7 debt ' + fmtGold(state.debt) : '') }));
    };
    window.finBuy = function (j) {
      const p = JSON.parse(j); window.__finSent.buy = p;
      if (state.gold < p.price) { window.finResult(JSON.stringify({ ok: false, msg: 'Not enough gold \u2014 short ' + fmtGold(p.price - state.gold) })); return; }
      push('buy', p.name, -p.price);
      window.finResult(JSON.stringify({ ok: true, msg: 'Bought ' + p.name + ' (\u2212' + fmtGold(p.price) + ')' }));
    };
    window.finSell = function (j) {
      const p = JSON.parse(j); window.__finSent.sell = p;
      push('sell', p.name, p.value);
      window.finResult(JSON.stringify({ ok: true, msg: 'Sold ' + p.name + ' (+' + fmtGold(p.value) + ')' }));
    };

    // fake property economy: flip ownership, move gold, recompute net worth, push
    // finState with ownedProps + netWorth exactly as C++ does.
    function ownedValue() { return state.properties.reduce((s, pr) => s + (state.ownedIds.indexOf(pr.id) !== -1 ? (pr.value || 0) : 0), 0); }
    function pushProp(kind, label, delta) {
      const before = state.gold;
      state.gold = Math.max(0, state.gold + delta);
      state.netWorth = state.gold + ownedValue() - state.debt;
      const row = { id: 'x' + Date.now(), stamp: '18 Last Seed 4E201', kind: kind, label: label, delta: delta, goldBefore: before, goldAfter: state.gold, debtAfter: state.debt };
      const led = [row].concat(state.ledger).slice(0, 120);
      window.finState(JSON.stringify({ gold: state.gold, debt: state.debt, netWorth: state.netWorth, ownedProps: state.ownedIds.slice(), ledger: led }));
    }
    window.finBuyProp = function (j) {
      const q = JSON.parse(j); window.__finSent.buyProp = q;
      const pr = propById(q.id);
      if (!pr) return;
      if (state.ownedIds.indexOf(pr.id) !== -1) { window.finResult(JSON.stringify({ ok: false, msg: 'Already own ' + pr.name })); return; }
      if (state.gold < pr.cost) { window.finResult(JSON.stringify({ ok: false, msg: 'Not enough gold — short ' + fmtGold(pr.cost - state.gold) })); return; }
      state.ownedIds = state.ownedIds.concat([pr.id]);
      pushProp('buy', 'Bought ' + pr.name, -pr.cost);
      window.finResult(JSON.stringify({ ok: true, msg: 'Bought ' + pr.name + ' (−' + fmtGold(pr.cost) + ')' }));
    };
    window.finSellProp = function (j) {
      const q = JSON.parse(j); window.__finSent.sellProp = q;
      const pr = propById(q.id);
      if (!pr) return;
      if (state.ownedIds.indexOf(pr.id) === -1) { window.finResult(JSON.stringify({ ok: false, msg: "You don't own " + pr.name })); return; }
      state.ownedIds = state.ownedIds.filter((x) => x !== pr.id);
      pushProp('sell', 'Sold ' + pr.name, pr.value);
      window.finResult(JSON.stringify({ ok: true, msg: 'Sold ' + pr.name + ' (+' + fmtGold(pr.value) + ')' }));
    };

    window.finGet();

    if (STANDALONE || location.search.indexOf('fin=1') !== -1) {
      document.body.classList.add('open');
      showTab();
      if (SELFTEST) setTimeout(runSelfTest, 340);
    }
  }

  /* ---------------------------------------------------------- selftest -- */

  function runSelfTest() {
    const results = [];
    const T = (name, fn) => {
      let pass = false;
      try { pass = !!fn(); } catch (e) { results.push({ name: name, pass: false, err: String(e) }); return; }
      results.push({ name: name, pass: pass });
    };
    // Data rows only — the Recurring list now interleaves .fin-group-head section
    // headers, which are chrome, not rows.
    const rowCount = () => [].filter.call(els.list.children, (c) => !c.classList.contains('fin-group-head')).length;

    /* ---- load + render ---- */
    T('config load: lines', () => state.lines.length === 8 && !!lineById('l1'));
    T('config load: market', () => state.market.length === 4 && !!marketById('m1'));
    T('config load: gold + debt from C++', () => state.gold === 42150 && state.debt === 3200);
    T('config load: properties + ownership from C++', () =>
      state.properties.length === 3 && !!propById('p1') && state.ownedIds.length === 2 && isOwned('p1') && isOwned('p2') && !isOwned('p3'));
    T('summary shows gold', () => els.gold.textContent.indexOf('42,150') !== -1);
    T('net worth stat renders the C++ figure', () =>
      !!els.worth && state.netWorth === (42150 + 6500 + 42000 - 3200) && els.worth.textContent.indexOf('87,450') !== -1);
    // expenseTotal now folds in owned properties' upkeep (p1 300 + p2 900), matching C++ Settle.
    T('monthly net = income - expense - owned upkeep', () =>
      monthlyNet() === (1800 + 5200 + 3400) - (2600 + 900 + 700 + 300 + 500) - (300 + 900));
    T('net stat renders positive', () => els.net.textContent.charAt(0) === '+' && els.net.classList.contains('pos'));
    T('recurring is the default sub', () => ui.sub === 'recurring' && rowCount() === 8);
    T('income + expense amounts render signed', () =>
      !!els.list.querySelector('.fin-amt.pos') && !!els.list.querySelector('.fin-amt.neg'));
    T('domain-tied line shows a domain chip', () => !!els.list.querySelector('.fin-chip.dom'));
    T('a line with an icon renders an <img> medal', () => {
      const t = lineById('l1'); t.icon = 'icons/custom/coin.png'; render();
      const ok = !!els.list.querySelector('.fin-row[data-id="l1"] img.fin-medal');
      t.icon = ''; render(); return ok;
    });

    /* ---- nav ---- */
    T('nav counts each sub', () => els.nav.querySelectorAll('.fin-subtab').length === 4 &&
      els.nav.querySelector('.fin-subtab[data-sub="market"] .fin-subcount').textContent === '4' &&
      els.nav.querySelector('.fin-subtab[data-sub="properties"] .fin-subcount').textContent === '3');
    T('switching to Market lists items + actions', () => {
      ui.sub = 'market'; render();
      return rowCount() === 4 && !!els.list.querySelector('.fin-act.buy') && !!els.list.querySelector('.fin-act.sell');
    });
    T('Ledger sub renders history newest-first', () => {
      ui.sub = 'ledger'; render();
      return rowCount() === 2 && els.list.querySelector('.fin-led-label').textContent === 'Monthly settle';
    });

    /* ---- search ---- */
    ui.sub = 'recurring'; render();
    T('search matches a line name', () => { setFilter('solitude'); return rowCount() === 1; });
    T('search matches a category', () => { setFilter('employee'); return rowCount() === 2; });
    T('search highlights the hit', () => { setFilter('markarth'); return !!els.list.querySelector('mark'); });
    T('no match shows empty state', () => { setFilter('zzz'); return !els.empty.classList.contains('hidden'); });
    setFilter('');

    /* ---- settle math (the load-bearing part) ---- */
    T('settle collects income, pays bill, moves gold', () => {
      const income = incomeTotal(), expense = expenseTotal();
      const bill = expense + state.debt;
      const g0 = state.gold, expectPay = Math.min(g0 + income, bill);
      const expectGold = g0 + income - expectPay, expectDebt = bill - expectPay;
      settle();
      return state.gold === expectGold && state.debt === expectDebt && window.__finSent.settle === 1;
    });
    T('settle appended a ledger row', () => state.ledger.length === 3 && state.ledger[0].kind === 'settle');

    // force a debt rollover: giant expense the gold can't cover
    T('settle rolls unpaid remainder into debt', () => {
      state.lines.push({ id: 'lbig', name: 'War chest', kind: 'expense', category: 'other', amount: state.gold + 999999, domainId: '', note: '', icon: '' });
      const income = incomeTotal(), expense = expenseTotal(), bill = expense + state.debt;
      const g0 = state.gold, pay = Math.min(g0 + income, bill);
      settle();
      const ok = state.gold === (g0 + income - pay) && state.debt === (bill - pay) && state.debt > 0;
      state.lines = state.lines.filter((l) => l.id !== 'lbig');
      return ok;
    });

    /* ---- buy / sell ---- */
    // the debt-rollover test above deliberately drained gold to 0; top it back
    // up (through the C++-owned path) so affordability is what's under test here.
    onState({ gold: 60000, debt: state.debt, ledger: state.ledger });
    ui.sub = 'market'; render();
    T('buy blocks when broke', () => {
      const g0 = state.gold;
      buy({ id: 'mx', name: 'Palace', price: g0 + 1 });
      return state.gold === g0 && window.__finSent.buy.price === g0 + 1;   // unchanged
    });
    T('buy spends gold when affordable', () => {
      const g0 = state.gold;
      buy(marketById('m2'));   // 2000
      return state.gold === g0 - 2000;
    });
    T('sell adds gold', () => {
      const g0 = state.gold;
      sell(marketById('m3'));  // 4800
      return state.gold === g0 + 4800;
    });

    /* ---- properties: buy = −cost + owned, sell = +value − owned, net worth tracks ---- */
    ui.sub = 'properties'; render();
    T('properties list renders owned-first with Buy/Sell actions', () => {
      const rows = els.list.querySelectorAll('.fin-row');
      return rows.length === 3 && rows[0].classList.contains('owned') &&
        !!els.list.querySelector('.fin-act.buy') && !!els.list.querySelector('.fin-act.sell');
    });
    T('buy an unowned property spends its cost and marks it owned', () => {
      onState({ gold: 100000, debt: state.debt, netWorth: 0, ownedProps: state.ownedIds, ledger: state.ledger });
      const g0 = state.gold;
      buyProp(propById('p3'));   // cost 60000
      return state.gold === g0 - 60000 && isOwned('p3') && window.__finSent.buyProp.id === 'p3';
    });
    T('net worth = gold + owned value − debt after a buy', () => {
      const owned = state.properties.reduce((s, pr) => s + (isOwned(pr.id) ? pr.value : 0), 0);
      return state.netWorth === state.gold + owned - state.debt;
    });
    T('buy is refused when already owned', () => {
      const g0 = state.gold;
      buyProp(propById('p1'));   // already owned
      return state.gold === g0;   // unchanged
    });
    T('sell an owned property returns its value in gold and clears ownership', () => {
      const g0 = state.gold;
      sellProp(propById('p3'));  // value 85000
      return state.gold === g0 + 85000 && !isOwned('p3') && window.__finSent.sellProp.id === 'p3';
    });
    T('property buy blocks when broke', () => {
      onState({ gold: 10, debt: state.debt, netWorth: 0, ownedProps: state.ownedIds, ledger: state.ledger });
      const g0 = state.gold;
      buyProp(propById('p3'));   // cost 60000
      return state.gold === g0 && !isOwned('p3');
    });
    T('add property prepends + opens editor', () => {
      const n = state.properties.length; addProperty();
      return state.properties.length === n + 1 && !!$('fin-ctx');
    });
    closeCtx();
    T('delete property removes it', () => {
      const id = state.properties[0].id, n = state.properties.length;
      deleteProperty(state.properties[0]);
      return state.properties.length === n - 1 && !propById(id);
    });

    /* ---- CRUD ---- */
    ui.sub = 'recurring'; render();
    T('add line prepends + opens editor', () => {
      const n = state.lines.length; addLine();
      return state.lines.length === n + 1 && !!$('fin-ctx');
    });
    T('edit line amount parses gold', () => {
      const l = state.lines[0]; setLine(l, 'amount', parseGold('12,500 g'));
      return l.amount === 12500;
    });
    T('edit line kind toggles income/expense', () => {
      const l = state.lines[0]; setLine(l, 'kind', 'income');
      return l.kind === 'income';
    });
    T('delete line removes it', () => {
      const id = state.lines[0].id, n = state.lines.length;
      deleteLine(state.lines[0]);
      return state.lines.length === n - 1 && !lineById(id);
    });
    closeCtx();
    T('add market item works', () => { const n = state.market.length; addMarket(); return state.market.length === n + 1; });
    closeCtx();

    /* ---- image picker ---- */
    T('icon picker lists the custom pool', () => {
      const m = marketById('m1'); openMarketMenu(m, 100, 100);
      toggleIconPicker(m, 'market');
      return !!ctxEl.querySelector('.fin-ctx-grid') && ctxEl.querySelectorAll('.fin-ctx-tile').length === 3;
    });
    T('picking an icon stores a view-relative path', () => {
      const m = marketById('m1'); setIcon(m, 'market', 'icons/custom/ring.png');
      return m.icon === 'icons/custom/ring.png';
    });
    T('icon sanitizer rejects traversal/scheme/absolute', () =>
      iconSrc('../secret.png') === '' && iconSrc('C:/x.png') === '' && iconSrc('http://x/y.png') === '' &&
      iconSrc('data:image/png;base64,AA') === '' && iconSrc('icons/custom/ok.png') === 'icons/custom/ok.png');
    closeCtx();

    /* ---- persistence (view-owned slice only) ---- */
    T('finSave payload carries lines/market/properties/settings, not gold/debt/ownership', () => {
      flushSave();
      const p = window.__finSent.save;
      return p && Array.isArray(p.lines) && Array.isArray(p.market) && Array.isArray(p.properties) && p.settings &&
        p.debt === undefined && p.gold === undefined && p.ledger === undefined &&
        p.netWorth === undefined && p.ownedProps === undefined;   // C++-owned, never sent back
    });
    T('save round-trips through the parser', () => {
      const p = window.__finSent.save;
      const nLines = p.lines.length, nMarket = p.market.length;
      onCfg({ lines: p.lines, market: p.market, settings: p.settings });
      return state.lines.length === nLines && state.market.length === nMarket;
    });

    /* ---- finState ownership ---- */
    T('finState updates gold/debt without touching lines', () => {
      const nLines = state.lines.length;
      onState({ gold: 99999, debt: 0, ledger: [] });
      return state.gold === 99999 && state.debt === 0 && state.lines.length === nLines;
    });

    /* ---- layout guards ---- */
    ui.sub = 'recurring'; setFilter(''); render();
    T('pane never scrolls horizontally', () => els.pane.scrollWidth <= els.pane.clientWidth + 1);

    /* ---- per-tab size (hd-scale.js) ---------------------------------- *
     *  Two controls, and each has a different way of being silently wrong:
     *  the strip can mount but never be revealed (it follows Edit, and Edit
     *  is itself hidden on the Ledger), and the image variable can be
     *  written under a name the stylesheet does not read. Both asserted.
     *  Sizes are probed by WIDTH, never by transform — #fin-scale carries a
     *  130ms transition, so a same-tick getComputedStyle().transform reports
     *  the value the animation starts from, not the one that lands.        */
    if (window.HDScale) {
      T('the edit strip mounts both a UI size and an image size', () => {
        const er = document.getElementById('fin-editrow');
        return !!er && !!er.querySelector('[data-hds-out="ui"]') &&
                       !!er.querySelector('[data-hds-out="img"]');
      });
      T('the strip follows Edit, and hides on the Ledger where Edit hides', () => {
        const er = document.getElementById('fin-editrow');
        const sub = ui.sub, editing = ui.editing;
        ui.sub = 'recurring'; ui.editing = true;  syncChrome();
        const shownInEdit = !er.classList.contains('hidden');
        ui.editing = false; syncChrome();
        const goneOutOfEdit = er.classList.contains('hidden');
        ui.sub = 'ledger'; ui.editing = true; syncChrome();
        const goneOnLedger = er.classList.contains('hidden');
        ui.sub = sub; ui.editing = editing; syncChrome();
        return shownInEdit && goneOutOfEdit && goneOnLedger;
      });
      T('UI size resizes the pane wrapper', () => {
        const sc = document.getElementById('fin-scale');
        const w = els.pane.getBoundingClientRect().width;
        HDScale.set('finances', 'ui', 1.4);
        const scaled = w > 0 && Math.abs(sc.getBoundingClientRect().width - w / 1.4) < 2;
        HDScale.nudge('finances', 'ui', 0);
        return scaled && Math.abs(sc.getBoundingClientRect().width - w) < 2;
      });
      T('Icon size drives the row medal, and reset returns it to the CSS default', () => {
        /* Measured on a FRESH probe element, not on a live row. .fin-medal
           carries `transition: width 120ms`, so re-measuring an existing
           medal in the same tick returns the width the animation is starting
           FROM — 35px either way, and the check passes or fails for reasons
           that have nothing to do with the control. A newly inserted element
           has no previous value to transition from, so it lays out at the
           final size immediately. */
        const probe = () => {
          const el = h('span', { class: 'fin-medal' }, 'XX');
          els.list.append(el);
          const w = el.getBoundingClientRect().width;
          el.remove();
          return w;
        };
        const dflt = probe();
        HDScale.set('finances', 'img', 64);
        const grew = Math.abs(probe() - 64) < 1;
        HDScale.nudge('finances', 'img', 0);
        return dflt === 35 && grew && Math.abs(probe() - dflt) < 1;
      });
      T('a size payload carries BOTH fields — a partial one resets the other', () => {
        /* C++ replaces this map wholesale on save. */
        HDScale.set('finances', 'img', 40);
        const rec = HDScale.dump().finances;
        HDScale.nudge('finances', 'img', 0);
        return rec && typeof rec.ui === 'number' && typeof rec.img === 'number';
      });
    }
    T('rows stay inside the list box', () => {
      const lb = els.list.getBoundingClientRect();
      return Array.prototype.every.call(els.list.children, (r) => r.getBoundingClientRect().right <= lb.right + 1);
    });
    T('the settle button stays inside the pane', () => {
      const pb = els.pane.getBoundingClientRect(), sb = els.settleBtn.getBoundingClientRect();
      return sb.right <= pb.right + 1 && sb.top >= pb.top - 1;
    });

    const pass = results.filter((r) => r.pass).length;
    const out = { pass: pass, total: results.length, results: results };
    window.__finSelftest = out;
    if (!window.__selftest) window.__selftest = out;
    console.log('[finances selftest] ' + pass + '/' + results.length, results.filter((r) => !r.pass));
    toast('Finances self-test ' + pass + '/' + results.length);
  }

  /* ---- Omni search provider (universal search, v0.14.0) ---------------- *
   * warm() pulls the slice on omni-open because finances data otherwise only
   * arrives the first time the tab is shown. setFilter is the pane's own —
   * omni jumps land with the query already narrowing the list. */
  if (window.HDOmni) HDOmni.register({
    id: 'finances', label: 'Finances', tab: 'finances',
    warm: function () { toGame('finGet'); },
    setFilter: function (q) { try { setFilter(String(q || '')); } catch (e) {} },
    index: function () {
      const items = [];
      (state.lines || []).forEach((l) => {
        items.push({
          label: l.name || '(unnamed)',
          detail: [(l.kind === 'income' ? '+' : '−') + (l.amount >>> 0) + 'g/mo',
                   CAT_LABEL[l.category] || l.category, l.note].filter(Boolean).join(' · '),
          kind: l.kind || 'line',
          /* names are the only stable handle a ledger line has — a renamed
             line greys its pin, honestly */
          pin: 'fin:' + (l.name || ''),
        });
      });
      (state.market || []).forEach((m) => {
        items.push({
          label: m.name || '(unnamed)',
          detail: [(m.side === 'buy' ? 'buy ' : 'sell ') + (m.price >>> 0) + 'g', m.note]
            .filter(Boolean).join(' · '),
          kind: 'market',
          pin: 'mkt:' + (m.name || ''),
        });
      });
      (state.properties || []).forEach((p) => {
        items.push({
          label: p.name || '(unnamed)',
          detail: [isOwned(p.id) ? 'owned' : 'for sale',
                   'worth ' + (p.value >>> 0) + 'g', 'cost ' + (p.cost >>> 0) + 'g', p.note]
            .filter(Boolean).join(' · '),
          kind: 'property',
          pin: 'prop:' + (p.name || ''),
        });
      });
      return items;
    },
  });

  /* =========================================================== exports == */

  return {
    init: init,
    onShow: onShow,
    onHide: onHide,
    receive: receive,
    wantsPause: wantsPause,
    show: showTab,
    toggleEdit: toggleEdit,
    isShown: function () { return ui.shown; },
  };
})();
