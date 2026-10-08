'use strict';

/* ====================================================================== *
 *  Weather — every weather in the load order, and the weather MODS'
 *  own controls, as a Hotkey Deck tab (wth- prefix).
 *
 *  Rober, 2026-10-08: "weather control in Skymanager? A new tab or
 *  something that auto populates and lets you configure stuff" →
 *  "id want the list to be dynamic, and hook to a lot of the weather
 *  systems we have".
 *
 *  Left column: what the sky is doing NOW (and the lock), then every
 *  weather record the load order ships — searchable, filterable by kind
 *  and by the plugin that made it, starred, one click to bring it in.
 *  Right column: one card per weather mod that is actually installed
 *  (Storm Lightning · Seasons of Skyrim · Seasonal Weathers · R.A.S.S. ·
 *  Community Shaders · Splashes of Storms). Nothing here is hardcoded to a
 *  load order: C++ walks the WTHR records and probes each mod, and an
 *  absent mod's card simply is not drawn.
 *
 *  Bridge (src/weather_hub.cpp, main.cpp OnJsWx*):
 *    wxState({full}) -> wxStateData({now,lock,how,favs,systems,weathers?})
 *    wxSet({act,...}) -> wxResult({ok,msg,state})
 *  Both replies are response-style (this pane always asks first), so the
 *  pane needs no hd-boot STUB_FNS entry.
 *
 *  Host contract (mirrors TimePane): init() · onShow() · onHide() · onKey(e)
 * ====================================================================== */

window.WeatherPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  /* Rows drawn per pass. Ultralight lays out every row it is given; a 600-
     weather load order would cost a visible beat per keystroke. The count
     line says how many more matched and asks for a narrower search. */
  const ROW_CAP = 160;
  /* Plugins shown as chips before "More sources…" opens the popout. */
  const SRC_CHIPS = 6;

  const KIND_ICON = {
    clear: 'icons/custom/wx-clear.png', cloudy: 'icons/custom/wx-cloudy.png',
    rain: 'icons/custom/wx-rain.png', snow: 'icons/custom/wx-snow.png',
    other: 'icons/custom/wx-fog.png',
  };
  const KIND_NAME = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', snow: 'Snow', other: 'Other' };
  const CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'fav', label: '★ Starred' },
    { id: 'clear', label: 'Clear', icon: KIND_ICON.clear },
    { id: 'cloudy', label: 'Cloudy', icon: KIND_ICON.cloudy },
    { id: 'rain', label: 'Rain', icon: KIND_ICON.rain },
    { id: 'storm', label: 'Storms', icon: 'icons/custom/wx-storm.png' },
    { id: 'snow', label: 'Snow', icon: KIND_ICON.snow },
    { id: 'aurora', label: 'Aurora', icon: 'icons/custom/wx-aurora.png' },
  ];
  const SEASONS = [
    { n: 1, id: 'winter', name: 'Winter' }, { n: 2, id: 'spring', name: 'Spring' },
    { n: 3, id: 'summer', name: 'Summer' }, { n: 4, id: 'autumn', name: 'Autumn' },
  ];
  /* Frequency sliders span 0-50 while the values people actually use sit
     between 0.05 and 15, so they step along a ladder instead of by 0.05. */
  const FREQ_LADDER = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 40, 50];

  let st = null;            // the light state (no weather list)
  let weathers = [];        // the full list, from the last full read
  let q = '';
  let chip = 'all';
  let src = '';             // a plugin name, '' = every source
  let wired = false;
  let shown = false;
  let toastT = 0;
  let asked = false;        // a full read is in flight
  const slSend = {};        // key -> timer, the debounced writes
  let pop = null;           // the open popout's root, or null
  let popKey = null;        // its capture-phase key listener

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------ bridge -- */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(typeof arg === 'string' ? arg : JSON.stringify(arg || {})); } catch (e) { console.log('bridge error', fn, e); }
      return;
    }
    if (DEV && window.WeatherPaneDev) window.WeatherPaneDev(fn, arg);
    else console.log('[dev->game]', fn, arg);
  }

  function ask(full) {
    if (full) asked = true;
    toGame('wxState', { full: !!full });
  }
  function act(o) { toGame('wxSet', o); }

  /* ------------------------------------------------------------- state -- */

  function systems() { return (st && Array.isArray(st.systems)) ? st.systems : []; }
  function sys(id) {
    const list = systems();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function isFav(id) { return !!(st && Array.isArray(st.favs) && st.favs.indexOf(id) !== -1); }

  /* The light state carries the current weather and the stars; the list rows
     are refreshed from it so a reply never needs to resend 600 rows. */
  function syncRows() {
    const cur = st && st.now ? st.now.id : '';
    for (let i = 0; i < weathers.length; i++) {
      const w = weathers[i];
      w.cur = !!cur && w.id === cur;
      w.fav = isFav(w.id);
    }
  }

  function apply(state) {
    if (!state || typeof state !== 'object') return;
    st = state;
    syncRows();
  }

  /* ----------------------------------------------------------- filters -- */

  /* Display name. The label is the record's editor id split at its capitals
     (C++), so "SkyrimStormRain_MA" arrives as "Skyrim Storm Rain_ MA". */
  function nice(n) {
    return String(n || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* Words people type for a sky, mapped to what the RECORD can prove. A
     synonym is a test, not more text: "thunderstorm" finds every weather
     with lightning even when its editor id says "Storm" or nothing at all. */
  const SYN = [
    { w: ['thunder', 'thunderstorm', 'lightning', 'bolt', 'bolts', 'electric'], t: function (x) { return !!x.th; } },
    { w: ['storm', 'stormy', 'tempest'], t: function (x) { return !!x.th || /storm|blizzard/i.test(x.n); } },
    { w: ['aurora', 'northern', 'lights', 'borealis'], t: function (x) { return !!x.au; } },
    { w: ['sunny', 'sun', 'fair', 'pleasant', 'nice', 'bright', 'clear'], t: function (x) { return x.kind === 'clear'; } },
    { w: ['overcast', 'cloud', 'clouds', 'cloudy', 'grey', 'gray', 'gloomy'], t: function (x) { return x.kind === 'cloudy'; } },
    { w: ['rain', 'rainy', 'raining', 'drizzle', 'shower', 'showers', 'wet', 'downpour'], t: function (x) { return x.kind === 'rain'; } },
    { w: ['snow', 'snowy', 'snowing', 'blizzard', 'flurry', 'flurries', 'winter', 'frost'], t: function (x) { return x.kind === 'snow'; } },
    { w: ['fog', 'foggy', 'mist', 'misty', 'haze', 'hazy'], t: function (x) { return /fog|mist|haze/i.test(x.n); } },
    { w: ['ash', 'ashstorm', 'volcanic', 'red'], t: function (x) { return /ash|volcan|red/i.test(x.n); } },
    { w: ['windy', 'wind', 'gale', 'gusty'], t: function (x) { return (x.ws || 0) >= 128; } },
    { w: ['calm', 'still'], t: function (x) { return (x.ws || 0) < 40; } },
    { w: ['star', 'starred', 'fav', 'favourite', 'favorite', 'favourites', 'favorites'], t: function (x) { return !!x.fav; } },
    { w: ['now', 'current', 'active'], t: function (x) { return !!x.cur; } },
  ];
  function synFor(tok) {
    for (let i = 0; i < SYN.length; i++) {
      const list = SYN[i].w;
      for (let j = 0; j < list.length; j++) if (list[j].indexOf(tok) === 0 && tok.length >= Math.min(3, list[j].length)) return SYN[i].t;
    }
    return null;
  }

  /* Score one token against one weather. 0 = no match. Name hits beat source
     hits beat what-it-is hits, prefix beats substring — the deck-wide ranking
     (hd-omni.js scoreText), so the two searches order things the same way. */
  function tokScore(w, tok) {
    const name = nice(w.n).toLowerCase();
    if (name === tok) return 100;
    if (name.indexOf(tok) === 0) return 70;
    const words = name.split(/[\s\-·.,:]+/);
    for (let i = 0; i < words.length; i++) if (words[i].indexOf(tok) === 0) return 55;
    if (name.indexOf(tok) !== -1) return 40;
    const syn = synFor(tok);
    if (syn && syn(w)) return 35;
    const src = (w.p + ' ' + (w.by || '')).toLowerCase();
    if (src.indexOf(tok) !== -1) return 25;
    if (w.kind.indexOf(tok) === 0) return 30;
    return 0;
  }

  function score(w, toks) {
    let total = 0;
    for (let i = 0; i < toks.length; i++) {
      const sc = tokScore(w, toks[i]);
      if (!sc) return 0;
      total += sc;
    }
    return total / toks.length + (w.cur ? 3 : 0) + (w.fav ? 2 : 0);
  }

  function passesChips(w) {
    if (chip === 'fav' && !w.fav) return false;
    if (chip === 'storm' && !w.th) return false;
    if (chip === 'aurora' && !w.au) return false;
    if ((chip === 'clear' || chip === 'cloudy' || chip === 'rain' || chip === 'snow') && w.kind !== chip) return false;
    if (src && w.p !== src && w.by !== src) return false;
    return true;
  }

  function tokens() { return q.toLowerCase().split(/\s+/).filter(function (t) { return t; }); }

  function matches(w) {
    if (!passesChips(w)) return false;
    const toks = tokens();
    return !toks.length || score(w, toks) > 0;
  }

  function byName(a, b) {
    const an = nice(a.n).toLowerCase(), bn = nice(b.n).toLowerCase();
    return an < bn ? -1 : (an > bn ? 1 : 0);
  }

  /* With a query: ranked, best first. Without: current, then starred, then
     by kind and name — renderList draws that order under kind headings. */
  function filtered() {
    const toks = tokens();
    const out = [];
    for (let i = 0; i < weathers.length; i++) {
      const w = weathers[i];
      if (!passesChips(w)) continue;
      if (toks.length) {
        const sc = score(w, toks);
        if (sc > 0) out.push({ w: w, s: sc });
      } else out.push({ w: w, s: 0 });
    }
    if (toks.length) out.sort(function (a, b) { return b.s - a.s || byName(a.w, b.w); });
    else out.sort(function (a, b) {
      const A = a.w, B = b.w;
      if (!!A.cur !== !!B.cur) return A.cur ? -1 : 1;
      if (!!A.fav !== !!B.fav) return A.fav ? -1 : 1;
      const ka = KIND_ORDER.indexOf(A.kind), kb = KIND_ORDER.indexOf(B.kind);
      if (ka !== kb) return ka - kb;
      return byName(A, B);
    });
    return out.map(function (x) { return x.w; });
  }
  const KIND_ORDER = ['clear', 'cloudy', 'rain', 'snow', 'other'];

  /* <mark> the typed words inside a name (the omni's highlight, per word). */
  function hl(text) {
    const t = String(text == null ? '' : text);
    const toks = tokens().filter(function (x) { return x.length >= 2; });
    if (!toks.length) return esc(t);
    const lower = t.toLowerCase();
    const spans = [];
    toks.forEach(function (tok) {
      let at = lower.indexOf(tok);
      while (at !== -1) { spans.push([at, at + tok.length]); at = lower.indexOf(tok, at + tok.length); }
    });
    if (!spans.length) return esc(t);
    spans.sort(function (a, b) { return a[0] - b[0]; });
    let out = '', pos = 0;
    spans.forEach(function (sp) {
      if (sp[0] < pos) return;
      out += esc(t.slice(pos, sp[0])) + '<mark>' + esc(t.slice(sp[0], sp[1])) + '</mark>';
      pos = sp[1];
    });
    return out + esc(t.slice(pos));
  }

  /* plugin -> count, over every weather (a plugin that only EDITS weathers
     counts too: NAT III rewrites vanilla's skies rather than adding its own) */
  function sources() {
    const n = {};
    for (let i = 0; i < weathers.length; i++) {
      const w = weathers[i];
      n[w.p] = (n[w.p] || 0) + 1;
      if (w.by && w.by !== w.p) n[w.by] = (n[w.by] || 0) + 1;
    }
    return Object.keys(n).map(function (k) { return { p: k, n: n[k] }; })
      .sort(function (a, b) { return b.n - a.n || (a.p < b.p ? -1 : 1); });
  }

  /* ------------------------------------------------------------ render -- */

  function badges(w) {
    let h = '';
    if (w.th) h += '<span class="wth-badge wth-b-storm" title="Has lightning — Storm Lightning works under this sky"><img src="icons/custom/wx-storm.png" alt="">Lightning</span>';
    if (w.au) h += '<span class="wth-badge wth-b-aurora" title="Shows the aurora at night"><img src="icons/custom/wx-aurora.png" alt="">Aurora</span>';
    return h;
  }

  function renderHead() {
    const how = st && st.how === 'now' ? 'now' : 'blend';
    const seg = $('wth-how');
    if (seg) {
      const bs = seg.querySelectorAll('button');
      for (let i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-how') === how);
    }
    const sub = $('wth-sub');
    if (sub) {
      const n = weathers.length, s = sources().length;
      sub.innerHTML = n
        ? '<b>' + n + '</b> weathers from <b>' + s + '</b> plugin' + (s === 1 ? '' : 's') + ' in your load order'
        : 'Reading every weather in your load order…';
    }
  }

  function renderNow() {
    const el = $('wth-now');
    if (!el) return;
    const now = st && st.now ? st.now : null;
    const lock = st && st.lock ? st.lock : { on: false };
    if (!now || !now.id) {
      el.innerHTML = '<div class="wth-now-empty">' + (st ? 'No sky to read here.' : 'Reading the sky…') + '</div>';
      return;
    }
    const kind = now.kind || 'other';
    let meta = 'From <b>' + esc(now.p) + '</b>' + (now.by ? ' · edited by <b>' + esc(now.by) + '</b>' : '');
    if (now.where) meta = esc(now.where) + ' · ' + meta;
    let blend = '';
    if (typeof now.pct === 'number' && now.from) {
      const pct = Math.round(now.pct * 100);
      blend = '<div class="wth-blend"><div class="wth-blend-txt">Rolling in from ' + esc(nice(now.from)) + ' — ' + pct + '%</div>' +
        '<div class="wth-blend-bar"><div class="wth-blend-fill" style="width:' + pct + '%"></div></div></div>';
    }
    let inside = '';
    if (now.outdoors === false) {
      inside = '<div class="wth-inside">You are indoors. A weather you pick now is what you will walk out into.</div>';
    }
    let lockLine = '';
    if (lock.on) {
      lockLine = '<div class="wth-lockline">' + lockSvg() + '<span><b>Locked:</b> ' + esc(nice(lock.n)) +
        ' — it comes back whenever the region or a load screen changes the sky.</span>' +
        '<button type="button" class="wth-btn" data-act="unlock">Unlock</button></div>';
    }
    const storm = sys('storm');
    let flashes = '';
    if (now.th) {
      /* the record's own lightning colour, worn by the word itself */
      flashes = '<span class="wth-now-fact wth-fact-bolt"' + (now.lc ? ' style="color:' + esc(now.lc) + '"' : '') + '>' +
        '<img src="icons/custom/wx-storm.png" alt="">Lightning' + (storm && storm.present ? ' · Storm Lightning on' : '') + '</span>';
    }
    el.innerHTML =
      '<div class="wth-now-top">' +
        '<img class="wth-now-ic" src="' + (now.th ? 'icons/custom/wx-storm.png' : KIND_ICON[kind] || KIND_ICON.other) + '" alt="">' +
        '<div class="wth-now-main">' +
          '<div class="wth-now-kicker">Right now</div>' +
          '<div class="wth-now-name">' + esc(nice(now.n)) + (lock.on && lock.id === now.id ? '<span class="wth-now-locked">' + lockSvg() + 'Locked</span>' : '') + '</div>' +
          '<div class="wth-now-meta">' + meta + '</div>' +
          '<div class="wth-now-facts"><span class="wth-kind k-' + esc(kind) + '">' + esc(KIND_NAME[kind] || kind) + '</span>' +
            flashes +
            (now.au ? '<span class="wth-now-fact">Aurora</span>' : '') +
            (typeof now.ws === 'number' ? '<span class="wth-now-fact">Wind ' + Math.round(now.ws / 2.55) + '%</span>' : '') +
            (now.raining ? '<span class="wth-now-fact">Raining</span>' : '') +
            (now.snowing ? '<span class="wth-now-fact">Snowing</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      blend + inside + lockLine +
      '<div class="wth-now-acts">' +
        '<button type="button" class="wth-btn wth-btn-hero" data-act="storm" title="Bring in a thunderstorm — your starred storms first, otherwise any storm in the load order">' +
          '<img src="icons/custom/wx-storm.png" alt="">Storm now</button>' +
        (lock.on
          ? '<button type="button" class="wth-btn" data-act="unlock">Unlock the weather</button>'
          : '<button type="button" class="wth-btn" data-act="lock" title="Keep this weather until you unlock it — region changes and load screens will not move it">' + lockSvg() + 'Lock this weather</button>') +
        '<button type="button" class="wth-btn" data-act="release" title="Drop any forced or locked weather and let the climate decide">Let the sky decide</button>' +
      '</div>';
  }

  function lockSvg() {
    return '<svg class="wth-lock-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<rect x="5" y="10" width="14" height="11" rx="2" fill="currentColor"/></svg>';
  }

  function renderChips() {
    const el = $('wth-chips');
    if (!el) return;
    const count = {};
    for (let i = 0; i < weathers.length; i++) {
      const w = weathers[i];
      count.all = (count.all || 0) + 1;
      count[w.kind] = (count[w.kind] || 0) + 1;
      if (w.th) count.storm = (count.storm || 0) + 1;
      if (w.au) count.aurora = (count.aurora || 0) + 1;
      if (w.fav) count.fav = (count.fav || 0) + 1;
    }
    el.innerHTML = CHIPS.map(function (c) {
      const n = count[c.id] || 0;
      if (c.id !== 'all' && c.id !== 'fav' && !n) return '';
      return '<button type="button" class="wth-chip' + (chip === c.id ? ' on' : '') + '" data-act="chip" data-chip="' + c.id + '">' +
        (c.icon ? '<img src="' + c.icon + '" alt="">' : '') + esc(c.label) + '<span class="wth-chip-n">' + n + '</span></button>';
    }).join('');
  }

  function renderSources() {
    const el = $('wth-srcs');
    if (!el) return;
    const all = sources();
    if (all.length < 2) { el.innerHTML = ''; return; }
    let top = all.slice(0, SRC_CHIPS);
    if (src && !top.some(function (s) { return s.p === src; })) {
      const pick = all.filter(function (s) { return s.p === src; })[0];
      if (pick) top = top.slice(0, SRC_CHIPS - 1).concat([pick]);
    }
    el.innerHTML = '<span class="wth-srcs-label">From</span>' +
      '<button type="button" class="wth-src' + (!src ? ' on' : '') + '" data-act="src" data-src="">Every plugin</button>' +
      top.map(function (s) {
        return '<button type="button" class="wth-src' + (src === s.p ? ' on' : '') + '" data-act="src" data-src="' + esc(s.p) + '" title="' +
          esc(s.p) + ' — ' + s.n + ' weather' + (s.n === 1 ? '' : 's') + ' made or edited">' + esc(s.p.replace(/\.(esp|esm|esl)$/i, '')) +
          '<span class="wth-chip-n">' + s.n + '</span></button>';
      }).join('') +
      (all.length > top.length ? '<button type="button" class="wth-src wth-src-more" data-act="srcMore">More sources (' + all.length + ') ›</button>' : '');
  }

  let sel = 0;              // keyboard selection, an index into the drawn rows
  let drawn = [];           // the rows the list currently shows, in order

  function rowHtml(w, i) {
    const ic = w.th ? 'icons/custom/wx-storm.png' : (KIND_ICON[w.kind] || KIND_ICON.other);
    return '<div class="wth-row k-' + esc(w.kind) + (i === sel ? ' wth-sel' : '') + (w.cur ? ' wth-cur' : '') +
      '" data-act="force" data-id="' + esc(w.id) + '" data-i="' + i + '" role="option" aria-selected="' + (i === sel) + '">' +
      '<span class="wth-row-stripe" aria-hidden="true"></span>' +
      '<img class="wth-row-ic" src="' + ic + '" alt="">' +
      '<div class="wth-row-main">' +
        '<div class="wth-row-name">' + hl(nice(w.n)) + (w.cur ? '<span class="wth-now-tag">Now</span>' : '') + '</div>' +
        '<div class="wth-row-sub"><span class="wth-kind k-' + esc(w.kind) + '">' + esc(KIND_NAME[w.kind] || w.kind) + '</span>' +
          badges(w) +
          '<span class="wth-row-src">' + hl(w.p) + (w.by ? ' · edited by ' + hl(w.by) : '') + '</span></div>' +
      '</div>' +
      '<span class="wth-row-go" aria-hidden="true">Bring in</span>' +
      '<button type="button" class="wth-row-lock" data-act="lockId" data-id="' + esc(w.id) + '" title="Bring it in and lock it there (Shift+Enter)" aria-label="Bring in and lock">' + lockSvg() + '</button>' +
      '<button type="button" class="wth-star' + (w.fav ? ' on' : '') + '" data-act="fav" data-id="' + esc(w.id) + '" title="' + (w.fav ? 'Unstar' : 'Star — Storm now picks starred storms first') + '" aria-label="' + (w.fav ? 'Unstar' : 'Star') + '">★</button>' +
    '</div>';
  }

  function groupHead(label, icon, n) {
    return '<div class="wth-group">' + (icon ? '<img src="' + icon + '" alt="">' : '') +
      '<span class="wth-group-name">' + esc(label) + '</span><span class="wth-group-n">' + n + '</span></div>';
  }

  function renderList() {
    const el = $('wth-list'), cnt = $('wth-count');
    if (!el) return;
    if (!weathers.length) {
      el.innerHTML = '<div class="wth-empty"><img src="icons/custom/wx-cloudy.png" alt="">' +
        (asked ? 'Reading every weather in your load order…' : 'No weathers found in the load order.') + '</div>';
      if (cnt) cnt.textContent = '';
      drawn = [];
      return;
    }
    const rows = filtered();
    const toks = tokens();
    if (cnt) {
      cnt.textContent = rows.length === weathers.length ? weathers.length + ' weathers'
        : rows.length + ' of ' + weathers.length;
    }
    if (!rows.length) {
      drawn = [];
      el.innerHTML = '<div class="wth-empty"><img src="icons/custom/wx-fog.png" alt="">' +
        '<div>Nothing matches' + (q ? ' “' + esc(q) + '”' : ' those filters') + '.</div>' +
        '<div class="wth-empty-hint">Try a word for the sky — thunder, sunny, blizzard, fog, aurora — or a mod’s name.</div>' +
        '<button type="button" class="wth-btn" data-act="clearFilters">Clear the search and filters</button></div>';
      return;
    }
    drawn = rows.slice(0, ROW_CAP);
    if (sel >= drawn.length) sel = drawn.length - 1;
    if (sel < 0) sel = 0;
    let h = '';
    /* No query: headed sections (pinned, then one per kind), so the list
       reads like a menu. With a query: one ranked run, best first. */
    if (!toks.length) {
      let lastKey = '';
      const counts = {};
      rows.forEach(function (w) {
        const k = (w.cur || w.fav) ? 'pin' : w.kind;
        counts[k] = (counts[k] || 0) + 1;
      });
      drawn.forEach(function (w, i) {
        const k = (w.cur || w.fav) ? 'pin' : w.kind;
        if (k !== lastKey) {
          lastKey = k;
          h += k === 'pin'
            ? groupHead('Now & starred', 'icons/custom/wx-clear-night.png', counts.pin)
            : groupHead(KIND_NAME[k] || k, KIND_ICON[k], counts[k]);
        }
        h += rowHtml(w, i);
      });
    } else {
      drawn.forEach(function (w, i) { h += rowHtml(w, i); });
    }
    if (rows.length > drawn.length) {
      h += '<div class="wth-more">' + (rows.length - drawn.length) + ' more — keep typing to narrow it down</div>';
    } else if (toks.length) {
      h += '<div class="wth-foot">' + rows.length + (rows.length === 1 ? ' sky matches' : ' skies match') + ' “' + esc(q) + '”' +
        '<span class="wth-keys"><b>↑ ↓</b> choose <b>Enter</b> bring it in <b>Shift+Enter</b> lock it <b>Esc</b> clear</span></div>';
    }
    el.innerHTML = h;
  }

  /* Move the keyboard selection without redrawing the list. */
  function moveSel(d) {
    if (!drawn.length) return;
    const el = $('wth-list');
    const old = el && el.querySelector('.wth-row.wth-sel');
    sel = Math.max(0, Math.min(drawn.length - 1, sel + d));
    if (old) { old.classList.remove('wth-sel'); old.setAttribute('aria-selected', 'false'); }
    const row = el && el.querySelector('.wth-row[data-i="' + sel + '"]');
    if (row) {
      row.classList.add('wth-sel');
      row.setAttribute('aria-selected', 'true');
      /* keep it in view: scrollIntoView is unreliable in Ultralight, so
         nudge the list's own scrollTop */
      const top = row.offsetTop - el.offsetTop, bottom = top + row.offsetHeight;
      if (top < el.scrollTop + 40) el.scrollTop = Math.max(0, top - 40);
      else if (bottom > el.scrollTop + el.clientHeight - 10) el.scrollTop = bottom - el.clientHeight + 10;
    }
  }

  function bringSelected(lock) {
    const w = drawn[sel] || drawn[0];
    if (!w) return;
    if (lock) act({ act: 'lock', id: w.id });
    else act({ act: 'force', id: w.id, how: st && st.how === 'now' ? 'now' : 'blend' });
  }

  /* ------------------------------------------------------- the systems -- */

  function fmt(v, step) {
    v = Number(v);
    if (!isFinite(v)) return '—';
    const d = step && step < 1 ? Math.min(3, String(step).split('.')[1] ? String(step).split('.')[1].length : 2) : 0;
    return v.toFixed(d);
  }

  function isFreq(r) { return /Frequency$/.test(r.k); }

  /* value -> 0..1 along the track. Frequencies use a square-root track so the
     0.05-2 range everyone actually uses is not crushed into one pixel. */
  function toFrac(r, v) {
    const lo = Number(r.min || 0), hi = Number(r.max || 1);
    if (!(hi > lo)) return 0;
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return isFreq(r) ? Math.sqrt(t) : t;
  }
  function fromFrac(r, f) {
    const lo = Number(r.min || 0), hi = Number(r.max || 1);
    f = Math.max(0, Math.min(1, f));
    let v = lo + (isFreq(r) ? f * f : f) * (hi - lo);
    const step = Number(r.step || 1);
    v = Math.round(v / step) * step;
    return Math.max(lo, Math.min(hi, +v.toFixed(4)));
  }
  function stepped(r, v, dir) {
    if (isFreq(r)) {
      let i = 0;
      while (i < FREQ_LADDER.length && FREQ_LADDER[i] < v - 1e-6) i++;
      if (dir > 0) {
        if (i < FREQ_LADDER.length && Math.abs(FREQ_LADDER[i] - v) < 1e-6) i++;
        return Math.min(Number(r.max || 50), FREQ_LADDER[Math.min(i, FREQ_LADDER.length - 1)]);
      }
      return Math.max(Number(r.min || 0), FREQ_LADDER[Math.max(0, i - 1)]);
    }
    const step = Number(r.step || 1);
    return Math.max(Number(r.min || 0), Math.min(Number(r.max || 100), +(v + dir * step).toFixed(4)));
  }

  function slRow(r) {
    if (r.type === 'toggle') {
      const on = Number(r.value) !== 0;
      return '<button type="button" class="wth-tog' + (on ? ' on' : '') + '" data-act="slTog" data-k="' + esc(r.k) + '" aria-pressed="' + on + '">' +
        '<span class="wth-tog-sw" aria-hidden="true"></span>' +
        '<span class="wth-tog-txt"><span class="wth-tog-label">' + esc(String(r.help || r.label).replace(/\.$/, '')) + '</span>' +
        (r.later ? '<span class="wth-later">' + esc(r.later) + '</span>' : '') + '</span></button>';
    }
    const v = isFinite(Number(r.value)) ? Number(r.value) : Number(r.min || 0);
    const pct = Math.round(toFrac(r, v) * 1000) / 10;
    const defPct = typeof r.def === 'number' ? Math.round(toFrac(r, r.def) * 1000) / 10 : null;
    return '<div class="wth-num" data-k="' + esc(r.k) + '">' +
      '<div class="wth-num-top"><span class="wth-num-label">' + esc(r.label) + '</span>' +
        '<span class="wth-num-val">' + fmt(v, r.step) + '</span></div>' +
      (r.help ? '<div class="wth-num-help">' + esc(r.help) + '</div>' : '') +
      (r.later ? '<div class="wth-later">' + esc(r.later) + '</div>' : '') +
      '<div class="wth-num-ctl">' +
        '<button type="button" class="wth-step" data-act="slStep" data-k="' + esc(r.k) + '" data-dir="-1" aria-label="Less">‹</button>' +
        '<div class="wth-track" data-act="slTrack" data-k="' + esc(r.k) + '" title="Click to set">' +
          '<div class="wth-fill" style="width:' + pct + '%"></div>' +
          (defPct != null ? '<div class="wth-def" style="left:' + defPct + '%" title="The mod\'s default: ' + fmt(r.def, r.step) + '"></div>' : '') +
        '</div>' +
        '<button type="button" class="wth-step" data-act="slStep" data-k="' + esc(r.k) + '" data-dir="1" aria-label="More">›</button>' +
      '</div></div>';
  }

  /* The presets as ONE intensity scale (Minimum → Insane), not a grid of
     seven boxes that cannot divide evenly: a rising meter, lit up to the
     current preset, the chosen rung's own words underneath. */
  function presetSay(s, p) {
    if (p) return '<b>' + esc(p.name) + '</b> — ' + esc(p.blurb) +
      '<span class="wth-ladder-nums">ground bolts ' + p.fork + ' · cloud flashes ' + p.sheet + '</span>';
    const fork = slFind('fForkFrequency'), sheet = slFind('fSheetFrequency');
    return '<b>Your own mix</b> — set by hand' + (fork && sheet
      ? '<span class="wth-ladder-nums">ground bolts ' + fmt(fork.value, 0.05) + ' · cloud flashes ' + fmt(sheet.value, 0.05) + '</span>' : '');
  }

  function stormCard(s) {
    const list = s.presets || [];
    let at = -1;
    list.forEach(function (p, i) { if (p.id === s.preset) at = i; });
    const presets = list.map(function (p, i) {
      return '<button type="button" class="wth-rung' + (i === at ? ' on' : '') + (at >= 0 && i <= at ? ' lit' : '') +
        '" data-act="slPreset" data-preset="' + esc(p.id) + '" data-i="' + i + '" aria-pressed="' + (i === at) + '" title="' + esc(p.blurb) + '">' +
        '<span class="wth-rung-bar" style="height:' + (10 + i * 5) + 'px"></span>' +
        '<span class="wth-rung-name">' + esc(p.name) + '</span></button>';
    }).join('');
    const main = s.main || [];
    const nums = main.filter(function (r) { return r.type !== 'toggle'; }).map(slRow).join('');
    const togs = main.filter(function (r) { return r.type === 'toggle'; }).map(slRow).join('');
    const matched = (s.presets || []).filter(function (p) { return p.id === s.preset; })[0];
    return '<div class="wth-card wth-card-storm">' +
      '<div class="wth-card-head"><img class="wth-card-ic" src="icons/custom/wx-storm.png" alt="">' +
        '<div class="wth-card-titles"><div class="wth-card-title">' + esc(s.name) + '</div>' +
        '<div class="wth-card-sub">' + (matched ? 'Set to <b>' + esc(matched.name) + '</b>' : 'Your own mix') +
          (s.pending ? ' · <span class="wth-pending">changes apply as you close the deck</span>' : '') + '</div></div></div>' +
      (s.note && !s.main ? '<div class="wth-note">' + esc(s.note) + '</div>' : '') +
      (presets ? '<div class="wth-sec-label">How stormy — the mod\'s own seven presets</div><div class="wth-ladder" role="group" aria-label="Lightning presets">' + presets + '</div>' +
        '<div class="wth-ladder-say" id="wth-ladder-say">' + presetSay(s, matched) + '</div>' : '') +
      (nums ? '<div class="wth-sec-label">How much</div><div class="wth-nums">' + nums + '</div>' : '') +
      (togs ? '<div class="wth-sec-label">Where it strikes</div><div class="wth-togs">' + togs + '</div>' : '') +
      (s.all && s.all.length ? '<div class="wth-card-foot"><span class="wth-note">' + esc(s.note || '') + '</span>' +
        '<button type="button" class="wth-btn" data-act="slAll">Every setting (' + s.all.length + ') ›</button></div>' : '') +
    '</div>';
  }

  function seasonCard(s) {
    const se = s.season || null;
    const cur = se ? se.name : 'Not answering yet';
    const ovr = se && se.override;
    let line = '';
    if (se && se.next && !ovr) line = esc(se.next.name) + ' in ' + se.next.in + ' day' + (se.next.in === 1 ? '' : 's');
    else if (ovr) line = 'Held at ' + esc(se.overrideName || se.name) + ' by an override';
    else if (se && se.fixed) line = 'Pinned by its settings file';
    const btns = SEASONS.map(function (x) {
      const on = !!(se && ovr && (se.overrideName === x.name));
      return '<button type="button" class="wth-season s-' + x.id + (on ? ' on' : '') + (se && se.id === x.id ? ' cur' : '') + '" data-act="season" data-n="' + x.n + '">' + x.name + '</button>';
    }).join('');
    return '<div class="wth-card wth-card-season">' +
      '<div class="wth-card-head"><img class="wth-card-ic" src="icons/custom/wx-snow.png" alt="">' +
        '<div class="wth-card-titles"><div class="wth-card-title">' + esc(s.name) + '</div>' +
        '<div class="wth-card-sub">The world is in <b>' + esc(cur) + '</b>' + (line ? ' · ' + line : '') + '</div></div></div>' +
      '<div class="wth-sec-label">Hold a season</div>' +
      '<div class="wth-seasons">' + btns +
        '<button type="button" class="wth-season s-cal' + (ovr ? '' : ' on') + '" data-act="season" data-n="0">Follow the calendar</button></div>' +
      (s.note ? '<div class="wth-note">' + esc(s.note) + '</div>' : '') +
    '</div>';
  }

  function oddsBars(rows) {
    return rows.map(function (r) {
      return '<div class="wth-odd"><span class="wth-odd-label">' + esc(r.label) + '</span>' +
        '<div class="wth-odd-bar"><div class="wth-odd-fill" style="width:' + Math.max(0, Math.min(100, r.pct)) + '%"></div></div>' +
        '<span class="wth-odd-pct">' + (r.pct || 0) + '%</span></div>';
    }).join('');
  }

  function swfCard(s) {
    const a = Array.isArray(s.odds) ? s.odds : [], b = Array.isArray(s.snowOdds) ? s.snowOdds : [];
    return '<div class="wth-card wth-card-swf">' +
      '<div class="wth-card-head"><img class="wth-card-ic" src="icons/custom/wx-cloudy.png" alt="">' +
        '<div class="wth-card-titles"><div class="wth-card-title">' + esc(s.name) + '</div>' +
        '<div class="wth-card-sub">What the climate will roll this month</div></div></div>' +
      (a.length ? '<div class="wth-sec-label">Most of Skyrim</div><div class="wth-odds">' + oddsBars(a) + '</div>' : '') +
      (b.length ? '<div class="wth-sec-label">Snowy regions</div><div class="wth-odds">' + oddsBars(b) + '</div>' : '') +
      (!a.length && !b.length ? '<div class="wth-note">Its weights have not been set yet — they appear after its script runs on load.</div>' : '') +
      (s.note ? '<div class="wth-note">' + esc(s.note) + '</div>' : '') +
    '</div>';
  }

  function rassCard(s) {
    const rows = (s.rows || []).map(function (r) {
      let v = '—';
      if (typeof r.value === 'number') {
        if (r.type === 'toggle') v = r.value ? 'On' : 'Off';
        else if (Array.isArray(r.options) && r.options[r.value] != null) v = r.options[r.value];
        else v = String(r.value);
      }
      return '<div class="wth-ro"><span class="wth-ro-label">' + esc(r.label) + '</span><span class="wth-ro-val' + (v === 'Off' ? ' off' : '') + '">' + esc(v) + '</span></div>';
    }).join('');
    return '<div class="wth-card wth-card-rass">' +
      '<div class="wth-card-head"><img class="wth-card-ic" src="icons/custom/wx-rain.png" alt="">' +
        '<div class="wth-card-titles"><div class="wth-card-title">' + esc(s.name) + '</div>' +
        '<div class="wth-card-sub">What is on — read from its settings</div></div></div>' +
      '<div class="wth-ros">' + rows + '</div>' +
      (s.note ? '<div class="wth-note">' + esc(s.note) + '</div>' : '') +
    '</div>';
  }

  function noteCard(s, icon) {
    return '<div class="wth-card wth-card-note">' +
      '<div class="wth-card-head"><img class="wth-card-ic" src="' + icon + '" alt="">' +
        '<div class="wth-card-titles"><div class="wth-card-title">' + esc(s.name) + '</div></div></div>' +
      (s.note ? '<div class="wth-note">' + esc(s.note) + '</div>' : '') +
    '</div>';
  }

  function renderSystems() {
    const el = $('wth-sys');
    if (!el) return;
    if (!st) { el.innerHTML = '<div class="wth-empty">Reading your weather mods…</div>'; return; }
    let h = '<div class="wth-col-title">Your weather mods</div>';
    const absent = [];
    systems().forEach(function (s) {
      if (!s.present) { absent.push(s.name); return; }
      if (s.id === 'storm') h += stormCard(s);
      else if (s.id === 'seasons') h += seasonCard(s);
      else if (s.id === 'swf') h += swfCard(s);
      else if (s.id === 'rass') h += rassCard(s);
      else if (s.id === 'cs') h += noteCard(s, 'icons/custom/wx-fog.png');
      else if (s.id === 'splashes') h += noteCard(s, 'icons/custom/wx-rain.png');
    });
    if (absent.length) h += '<div class="wth-absent">Not installed: ' + absent.map(esc).join(' · ') + '</div>';
    el.innerHTML = h;
  }

  function renderAll() {
    renderHead();
    renderNow();
    renderChips();
    renderSources();
    renderList();
    renderSystems();
  }

  /* Push handlers hand their redraw to the burst (the push-burst law) and
     never draw a hidden pane — onShow draws from the stored state. */
  function redraw(fn) {
    if (!shown) return;
    if (window.HDBurst && HDBurst.defer('weather', fn)) return;
    fn();
  }

  /* ---------------------------------------------------------- the toast -- */

  function toast(msg, ok) {
    const el = $('wth-toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.classList.remove('hidden', 'ok', 'err');
    el.classList.add(ok ? 'ok' : 'err');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.add('hidden'); }, 3600);
  }

  /* ----------------------------------------------------- C++ -> view ---- */

  window.wxStateData = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.weathers)) { weathers = d.weathers; asked = false; }
    apply(d);
    /* a deck search that warmed us is still open — re-run it with the list */
    if (window.HDOmni && HDOmni.rerender) { try { HDOmni.rerender(); } catch (e) {} }
    redraw(renderAll);
  };

  window.wxResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    if (d.state) apply(d.state);
    redraw(function () { renderAll(); toast(d.msg || (d.ok ? 'Done' : 'That did not work'), !!d.ok); });
  };

  /* ------------------------------------------------- Storm Lightning io -- */

  function slFind(k) {
    const s = sys('storm');
    if (!s) return null;
    const lists = [s.main || [], s.all || []];
    for (let j = 0; j < lists.length; j++)
      for (let i = 0; i < lists[j].length; i++) if (lists[j][i].k === k) return lists[j][i];
    return null;
  }
  function slLocal(k, v) {
    const s = sys('storm');
    if (!s) return;
    [s.main || [], s.all || []].forEach(function (list) {
      list.forEach(function (r) { if (r.k === k) r.value = v; });
    });
    s.preset = '';
    s.pending = true;
  }
  /* Click-by-click writes are batched per key: the last value wins and goes
     out once the clicking stops, so ten presses are one Papyrus round. */
  function slSet(k, v) {
    slLocal(k, v);
    renderSystems();
    if (pop) renderPop();
    clearTimeout(slSend[k]);
    slSend[k] = setTimeout(function () { delete slSend[k]; act({ act: 'sl', k: k, value: v }); }, 350);
  }

  /* ---------------------------------------------------------- popouts -- */

  function closePop() {
    if (!pop) return;
    if (popKey) { window.removeEventListener('keydown', popKey, true); popKey = null; }
    try { pop.parentNode.removeChild(pop); } catch (e) {}
    pop = null;
  }

  function openPop(kind) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'wth-pop-back';
    pop.setAttribute('data-kind', kind);
    pop.innerHTML = '<div class="wth-pop" role="dialog" aria-modal="true"></div>';
    pop.addEventListener('click', onClick);
    pop.addEventListener('mousedown', function (e) { if (e.target === pop) closePop(); });
    document.body.appendChild(pop);
    /* The popout owns the keyboard while it is up (the popout law): its
       capture listener sits above the deck's, so Escape closes IT. */
    popKey = function (e) {
      if (e.key === 'Escape' || e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); return; }
      const inp = pop && pop.querySelector('.wth-pop-search');
      if (inp && document.activeElement === inp) {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const top = pop.querySelector('[data-act="srcPick"]');
          if (top) { e.preventDefault(); top.click(); }
        }
      }
    };
    window.addEventListener('keydown', popKey, true);
    renderPop();
    const inp = pop.querySelector('.wth-pop-search');
    if (inp) { try { inp.focus(); } catch (e) {} }
  }

  function renderPop() {
    if (!pop) return;
    const box = pop.querySelector('.wth-pop');
    const kind = pop.getAttribute('data-kind');
    const filt = (pop.getAttribute('data-q') || '').toLowerCase();
    if (kind === 'slAll') {
      const s = sys('storm');
      if (!s) { closePop(); return; }
      const pages = {};
      const order = [];
      (s.all || []).forEach(function (r) {
        if (filt && (r.label + ' ' + (r.help || '') + ' ' + r.k).toLowerCase().indexOf(filt) === -1) return;
        if (!pages[r.page]) { pages[r.page] = []; order.push(r.page); }
        pages[r.page].push(r);
      });
      const keepQ = pop.querySelector('.wth-pop-search');
      const qv = keepQ ? keepQ.value : '';
      box.innerHTML = '<div class="wth-pop-head"><div class="wth-pop-title">Storm Lightning — every setting</div>' +
        '<button type="button" class="wth-btn" data-act="popClose">Close</button></div>' +
        '<div class="wth-bar wth-pop-bar"><span class="wth-bar-glyph" aria-hidden="true">&#8981;</span>' +
        '<input class="wth-pop-search" type="text" placeholder="Search its settings" autocomplete="off" spellcheck="false" value="' + esc(qv) + '"></div>' +
        '<div class="wth-pop-note">Each change goes to Storm Lightning live as you close the deck, and into its MCM settings file so the next load keeps it.</div>' +
        '<div class="wth-pop-body">' + (order.length ? order.map(function (pg) {
          const rows = pages[pg];
          return '<div class="wth-sec-label">' + esc(pg || 'Settings') + '</div>' +
            '<div class="wth-nums">' + rows.filter(function (r) { return r.type !== 'toggle'; }).map(slRow).join('') + '</div>' +
            '<div class="wth-togs">' + rows.filter(function (r) { return r.type === 'toggle'; }).map(slRow).join('') + '</div>';
        }).join('') : '<div class="wth-empty">No setting matches “' + esc(filt) + '”.</div>') + '</div>';
      wirePopSearch();
      return;
    }
    if (kind === 'src') {
      const all = sources().filter(function (s) { return !filt || s.p.toLowerCase().indexOf(filt) !== -1; });
      const keepQ = pop.querySelector('.wth-pop-search');
      const qv = keepQ ? keepQ.value : '';
      box.innerHTML = '<div class="wth-pop-head"><div class="wth-pop-title">Weathers by plugin</div>' +
        '<button type="button" class="wth-btn" data-act="popClose">Close</button></div>' +
        '<div class="wth-bar wth-pop-bar"><span class="wth-bar-glyph" aria-hidden="true">&#8981;</span>' +
        '<input class="wth-pop-search" type="text" placeholder="Search plugins (Enter = top hit)" autocomplete="off" spellcheck="false" value="' + esc(qv) + '"></div>' +
        '<div class="wth-pop-body wth-src-list">' +
          '<button type="button" class="wth-src-row' + (!src ? ' on' : '') + '" data-act="srcPick" data-src="">Every plugin<span class="wth-chip-n">' + weathers.length + '</span></button>' +
          all.map(function (s) {
            return '<button type="button" class="wth-src-row' + (src === s.p ? ' on' : '') + '" data-act="srcPick" data-src="' + esc(s.p) + '">' + esc(s.p) +
              '<span class="wth-chip-n">' + s.n + '</span></button>';
          }).join('') +
        '</div>';
      /* with a filter typed, "Every plugin" is not the top hit */
      if (filt) {
        const first = box.querySelector('[data-act="srcPick"]');
        if (first && first.getAttribute('data-src') === '') first.parentNode.removeChild(first);
      }
      wirePopSearch();
    }
  }

  function wirePopSearch() {
    const inp = pop && pop.querySelector('.wth-pop-search');
    if (!inp || inp.__wthWired) return;
    inp.__wthWired = true;
    inp.addEventListener('input', function () {
      pop.setAttribute('data-q', inp.value);
      const pos = inp.selectionStart;
      renderPop();
      const again = pop && pop.querySelector('.wth-pop-search');
      if (again) { try { again.focus(); again.setSelectionRange(pos, pos); } catch (e) {} }
    });
  }

  /* ------------------------------------------------------------ clicks -- */

  function onClick(e) {
    const t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    const a = t.getAttribute('data-act');
    const id = t.getAttribute('data-id');
    const k = t.getAttribute('data-k');
    switch (a) {
      case 'force': act({ act: 'force', id: id, how: st && st.how === 'now' ? 'now' : 'blend' }); break;
      case 'lockId': e.stopPropagation(); act({ act: 'lock', id: id }); break;
      case 'fav': e.stopPropagation(); act({ act: 'fav', id: id, on: !isFav(id) }); break;
      case 'storm': act({ act: 'storm' }); break;
      case 'lock': act({ act: 'lock' }); break;
      case 'unlock': act({ act: 'unlock' }); break;
      case 'release': act({ act: 'release' }); break;
      case 'how': act({ act: 'how', how: t.getAttribute('data-how') }); break;
      case 'chip': chip = t.getAttribute('data-chip') || 'all'; sel = 0; renderChips(); renderList(); break;
      case 'src': src = t.getAttribute('data-src') || ''; sel = 0; renderSources(); renderList(); break;
      case 'srcMore': openPop('src'); break;
      case 'srcPick': src = t.getAttribute('data-src') || ''; sel = 0; closePop(); renderSources(); renderList(); break;
      case 'clearFilters': chip = 'all'; src = ''; renderChips(); renderSources(); setQ(''); break;
      case 'clearQ': setQ(''); try { $('wth-search').focus(); } catch (err) {} break;
      case 'slPreset': {
        const s = sys('storm');
        if (s) { s.preset = t.getAttribute('data-preset'); s.pending = true; renderSystems(); }
        act({ act: 'slPreset', preset: t.getAttribute('data-preset') });
        break;
      }
      case 'slTog': {
        const r = slFind(k);
        if (r) slSet(k, Number(r.value) ? 0 : 1);
        break;
      }
      case 'slStep': {
        const r = slFind(k);
        if (r) slSet(k, stepped(r, Number(r.value) || 0, Number(t.getAttribute('data-dir')) || 1));
        break;
      }
      case 'slTrack': {
        const r = slFind(k);
        if (!r) break;
        const box = t.getBoundingClientRect();
        if (!(box.width > 0)) break;
        slSet(k, fromFrac(r, (e.clientX - box.left) / box.width));
        break;
      }
      case 'slAll': openPop('slAll'); break;
      case 'season': act({ act: 'season', n: Number(t.getAttribute('data-n')) || 0 }); break;
      case 'popClose': closePop(); break;
    }
  }

  /* ---------------------------------------------------------- the keys -- */

  /* Called by app.js onKeyDown (capture phase) while this tab is up, BEFORE
     the search box's own listener. True = handled. */
  function onKey(e) {
    if (pop) {
      if (e.key === 'Escape' || e.code === 'Escape') { closePop(); return true; }
      return false;
    }
    const inp = $('wth-search');
    const inSearch = inp && document.activeElement === inp;
    const typing = !inSearch && document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (inSearch) {
      if ((e.key === 'Escape' || e.code === 'Escape') && inp.value) { setQ(''); return true; }
      return false;   // the box's own keydown owns arrows / Enter
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return false;
    /* the list keys work without the box focused too */
    if (e.key === 'ArrowDown') { moveSel(1); return true; }
    if (e.key === 'ArrowUp') { moveSel(-1); return true; }
    if (e.key === 'Enter' && drawn.length) { bringSelected(e.shiftKey); return true; }
    /* type-to-search: "/" focuses the box; any letter starts a search */
    if (inp && (e.key === '/' || (e.key && e.key.length === 1 && /[a-z0-9]/i.test(e.key)))) {
      try { inp.focus(); } catch (err) {}
      setQ((e.key === '/' ? inp.value : inp.value + e.key));
      return true;
    }
    return false;
  }

  function setQ(v) {
    const inp = $('wth-search');
    if (inp && inp.value !== v) inp.value = v;
    q = String(v || '').trim();
    sel = 0;
    syncClear();
    renderList();
    const el = $('wth-list');
    if (el) el.scrollTop = 0;
  }

  function syncClear() {
    const b = $('wth-clear');
    if (b) b.classList.toggle('hidden', !q);
  }

  /* -------------------------------------------------------------- wire -- */

  function init() {
    if (wired) return;
    const root = $('wth-pane');
    if (!root) return;
    wired = true;
    root.addEventListener('click', onClick);
    /* the preset scale says what a rung is while you hover it */
    root.addEventListener('mouseover', function (e) {
      const r = e.target.closest ? e.target.closest('.wth-rung') : null;
      const say = $('wth-ladder-say');
      const s = sys('storm');
      if (!say || !s) return;
      if (r) {
        const p = (s.presets || [])[Number(r.getAttribute('data-i'))];
        if (p) say.innerHTML = presetSay(s, p);
      } else if (!(e.target.closest && e.target.closest('.wth-ladder'))) {
        const cur = (s.presets || []).filter(function (p) { return p.id === s.preset; })[0];
        say.innerHTML = presetSay(s, cur);
      }
    });
    const inp = $('wth-search');
    if (inp) {
      /* the clear button lives in the bar; built here so the markup in
         index.html and the harness stay one line shorter and identical */
      if (!$('wth-clear')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = 'wth-clear';
        b.className = 'wth-clear hidden';
        b.setAttribute('data-act', 'clearQ');
        b.setAttribute('aria-label', 'Clear the search');
        b.title = 'Clear (Esc)';
        b.textContent = '×';
        inp.parentNode.appendChild(b);
      }
      inp.addEventListener('input', function () { setQ(inp.value); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveSel(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveSel(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); bringSelected(e.shiftKey); }
      });
    }
  }

  function onShow() {
    init();
    shown = true;
    renderAll();
    /* the list is walked fresh on every show: a weather mod enabled since the
       last open, or a lock set from the Omni, is reflected at once */
    ask(true);
  }

  function onHide() {
    shown = false;
    closePop();
    clearTimeout(toastT);
    const t = $('wth-toast');
    if (t) t.classList.add('hidden');
    /* flush any write still waiting on its debounce — closing the deck is
       exactly when the player expects the change to take */
    Object.keys(slSend).forEach(function (k) {
      clearTimeout(slSend[k]);
      delete slSend[k];
      const r = slFind(k);
      if (r) act({ act: 'sl', k: k, value: r.value });
    });
  }

  /* ---------------------------------------------------- deck search -- */
  /* Omni (the deck's global search): EVERY weather in the load order, the
     tab's verbs, the Storm Lightning presets and the season holds. The list
     is asked for when the search opens (warm), so it is searchable before the
     Weather tab has ever been shown; a reply re-runs the open search.
     Rows carry the same words the tab's own search understands (SYN), so
     "thunderstorm" finds the storms here too. */
  let warmAt = 0;
  function kindWords(w) {
    const words = ['weather', 'sky', w.kind, KIND_NAME[w.kind] || ''];
    for (let i = 0; i < SYN.length; i++) if (SYN[i].t(w)) words.push(SYN[i].w.join(' '));
    return words.join(' ');
  }
  function bringRow(w) {
    return {
      label: nice(w.n),
      detail: 'Weather · ' + (KIND_NAME[w.kind] || w.kind) + (w.th ? ' · lightning' : '') + (w.au ? ' · aurora' : '') +
        (w.cur ? ' · the sky right now' : '') + ' · ' + w.p,
      kind: w.fav ? '★ weather' : 'weather',
      icon: w.th ? 'icons/custom/wx-storm.png' : (KIND_ICON[w.kind] || KIND_ICON.other),
      keywords: kindWords(w) + ' ' + w.p + ' ' + (w.by || ''),
      pin: 'wx:f:' + w.id,
      snap: { id: w.id },
      run: function () { act({ act: 'force', id: w.id, how: st && st.how === 'now' ? 'now' : 'blend' }); },
    };
  }

  if (window.HDOmni) HDOmni.register({
    id: 'weather', label: 'Weather', tab: 'weather',
    warm: function () {
      if (!weathers.length || Date.now() - warmAt > 60000) { warmAt = Date.now(); ask(true); }
    },
    pinRun: function (snap) {
      if (snap && snap.id) act({ act: 'force', id: snap.id, how: st && st.how === 'now' ? 'now' : 'blend' });
      else if (snap && snap.act) act(snap);
    },
    setFilter: function (v) { setQ(String(v || '')); },
    index: function () {
      const lock = st && st.lock && st.lock.on;
      const rows = [
        { label: 'Storm now', detail: 'Weather · bring in a thunderstorm — your starred storms first', kind: 'weather',
          icon: 'icons/custom/wx-storm.png', keywords: 'weather thunder thunderstorm lightning storm rain sky bolts',
          pin: 'wx:storm', snap: { act: 'storm' }, run: function () { act({ act: 'storm' }); } },
        lock
          ? { label: 'Unlock the weather', detail: 'Weather · locked on ' + nice(st.lock.n) + ' — let it change again', kind: 'weather',
              icon: 'icons/custom/wx-cloudy.png', keywords: 'weather unlock release free sky lock',
              pin: 'wx:unlock', snap: { act: 'unlock' }, run: function () { act({ act: 'unlock' }); } }
          : { label: 'Lock the weather', detail: 'Weather · keep the sky as it is until you unlock it', kind: 'weather',
              icon: 'icons/custom/wx-cloudy.png', keywords: 'weather lock hold keep freeze sky stay',
              pin: 'wx:lock', snap: { act: 'lock' }, run: function () { act({ act: 'lock' }); } },
        { label: 'Let the sky decide', detail: 'Weather · drop any forced or locked weather', kind: 'weather',
          icon: 'icons/custom/wx-clear.png', keywords: 'weather release natural reset sky climate',
          pin: 'wx:release', snap: { act: 'release' }, run: function () { act({ act: 'release' }); } },
      ];
      const storm = sys('storm');
      if (storm && storm.present && Array.isArray(storm.presets)) {
        storm.presets.forEach(function (p) {
          rows.push({ label: 'Lightning: ' + p.name, detail: 'Storm Lightning preset · ' + p.blurb + (storm.preset === p.id ? ' · current' : ''),
            kind: 'weather', icon: 'icons/custom/wx-storm.png',
            keywords: 'storm lightning preset thunder bolts frequency more less ' + p.id,
            pin: 'wx:sl:' + p.id, snap: { act: 'slPreset', preset: p.id },
            run: function () { act({ act: 'slPreset', preset: p.id }); } });
        });
      }
      const seasons = sys('seasons');
      if (seasons && seasons.present) {
        SEASONS.forEach(function (x) {
          rows.push({ label: 'Hold ' + x.name.toLowerCase(), detail: 'Seasons of Skyrim · from the next time you step outside',
            kind: 'weather', icon: x.id === 'winter' ? KIND_ICON.snow : KIND_ICON.clear,
            keywords: 'season seasons override ' + x.id, pin: 'wx:se:' + x.n, snap: { act: 'season', n: x.n },
            run: function () { act({ act: 'season', n: x.n }); } });
        });
        rows.push({ label: 'Seasons follow the calendar', detail: 'Seasons of Skyrim · clear the held season',
          kind: 'weather', icon: KIND_ICON.cloudy, keywords: 'season seasons calendar clear override release',
          pin: 'wx:se:0', snap: { act: 'season', n: 0 }, run: function () { act({ act: 'season', n: 0 }); } });
      }
      for (let i = 0; i < weathers.length; i++) rows.push(bringRow(weathers[i]));
      return rows;
    },
  });

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  return {
    init: init, onShow: onShow, onHide: onHide, onKey: onKey, wantsPause: function () { return true; },
    /* harness hooks */
    _state: function () { return { st: st, weathers: weathers, q: q, chip: chip, src: src }; },
    _fromFrac: fromFrac, _toFrac: toFrac, _stepped: stepped,
  };
})();
