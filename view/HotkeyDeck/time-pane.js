'use strict';

/* ====================================================================== *
 *  Time — instant waiting, as a Hotkey Deck tab.
 *
 *  Why it exists: the vanilla Sleep/Wait menu advances one game hour per
 *  REAL simulation frame, and this rig's frame generation throttles real
 *  frames while inflating the FPS counter — so vanilla waiting crawls at
 *  any displayed frame rate and no Engine Fixes setting can help. This
 *  pane skips the ticking entirely: C++ adds the hours to the Calendar's
 *  GameHour global in ONE step and the world catches up in a single beat.
 *
 *  Self-contained like the other panes: owns its DOM (tm- prefixed), never
 *  touches app.js state.
 *
 *  Bridge — C++ registers these JS→C++ listeners on the deck view:
 *    tmGet() · tmWait(hoursFloatString)
 *  C++ pushes back (one name per direction, per the deck law):
 *    tmInfo(json {hour,day,month,year,daysPassed})
 *    tmResult(json {ok,msg,hours})
 *
 *  Host contract (mirrors RoomsPane): TimePane.init() · onShow() · onHide()
 * ====================================================================== */

window.TimePane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand",
    'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire',
    'Frostfall', "Sun's Dusk", 'Evening Star'];
  const WEEKDAYS = ['Sundas', 'Morndas', 'Tirdas', 'Middas', 'Turdas', 'Fredas', 'Loredas'];

  let cur = null;        // last tmInfo {hour,day,month,year,daysPassed}
  let busy = false;      // one jump in flight at a time
  let noteTimer = 0;

  function $(id) { return document.getElementById(id); }

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'tmGet') {
        window.tmInfo(JSON.stringify({ hour: 21.78, day: 17, month: 7, year: 204, daysPassed: 1093.4 }));
      }
      if (DEV && fn === 'tmWait') {
        let h = parseFloat(arg) || 0;
        try { const r = JSON.parse(arg); if (r && typeof r === 'object') h = r.until != null ? HDTimeControls.until(cur.hour,r.until) : HDTimeControls.hours(cur,r.amount,r.unit); } catch (_) {}
        const next = Object.assign({}, cur || { hour: 8, day: 17, month: 7, year: 204, daysPassed: 0 });
        Object.assign(next, HDTimeControls.advance(next,h));
        window.tmResult(JSON.stringify({ ok: true, hours: h }));
        window.tmInfo(JSON.stringify(next));
      }
      if (DEV && fn === 'tmWeatherList') {
        let q = '';
        try { q = (JSON.parse(arg).q || '').toLowerCase(); } catch (e) {}
        const all = [
          { id: 'Skyrim.esm|00010E1F', n: 'Skyrim Clear', kind: 'clear', p: 'Skyrim.esm', cur: true },
          { id: 'Skyrim.esm|0001F0A2', n: 'Skyrim Storm Rain', kind: 'rain', p: 'Skyrim.esm', cur: false },
          { id: 'Cathedral.esp|000842', n: 'Cathedral Snow Heavy', kind: 'snow', p: 'Cathedral.esp', cur: false },
        ];
        window.tmWeatherListData(JSON.stringify({
          weathers: all.filter((w) => !q || (w.n + ' ' + w.p + ' ' + w.kind).toLowerCase().indexOf(q) !== -1),
          current: { id: all[0].id, n: all[0].n, kind: all[0].kind },
        }));
      }
      if (DEV && fn === 'tmWeatherSet') {
        let id = '';
        try { id = JSON.parse(arg).id || ''; } catch (e) {}
        window.tmWeatherResult(JSON.stringify({ ok: true, msg: id === 'release' ? 'The sky decides again' : 'The sky turns', id: id }));
      }
    }
  }

  /* ------------------------------------------------------------ format -- */

  function fmtClock(hour) {
    hour = ((hour % 24) + 24) % 24;
    let h = Math.floor(hour), m = Math.floor((hour - h) * 60);
    const am = h < 12;
    let disp = h % 12; if (disp === 0) disp = 12;
    return disp + ':' + (m < 10 ? '0' : '') + m + ' ' + (am ? 'AM' : 'PM');
  }

  function ordinal(n) {
    if (n % 10 === 1 && n !== 11) return n + 'st';
    if (n % 10 === 2 && n !== 12) return n + 'nd';
    if (n % 10 === 3 && n !== 13) return n + 'rd';
    return n + 'th';
  }

  function weekday(daysPassed) {
    /* Vanilla anchor: the playthrough clock starts on a Sundas. Good enough
       for flavor; the engine owns the truth. */
    const d = Math.floor(Number(daysPassed) || 0) % 7;
    return WEEKDAYS[(d + 7) % 7];
  }

  function fmtDate(info) {
    const mon = MONTHS[Math.max(0, Math.min(11, (info.month | 0)))] || '?';
    return weekday(info.daysPassed) + ', ' + ordinal(info.day | 0) + ' of ' + mon + ', 4E ' + (info.year | 0);
  }

  /* hours until a target o'clock, from the current hour; a target we are
     already AT means a full day around the dial. */
  function hoursUntil(target) {
    if (!cur) return null;
    return HDTimeControls.until(cur.hour, target);
  }

  /* ------------------------------------------------------------ render -- */

  function renderClock(jumped) {
    if (!cur) return;
    $('tm-clock-time').textContent = fmtClock(cur.hour);
    $('tm-clock-date').textContent = fmtDate(cur);
    /* dial: 0h = dot at bottom (midnight), noon at top */
    const deg = (cur.hour / 24) * 360 + 180;
    $('tm-dial-dot').style.transform = 'rotate(' + deg + 'deg) translateY(-33px)';
    if (jumped) {
      const card = $('tm-clock-card');
      card.classList.add('tm-jumped');
      setTimeout(() => card.classList.remove('tm-jumped'), 900);
    }
  }

  function note(msg, ok) {
    const el = $('tm-note');
    el.textContent = msg;
    el.classList.remove('tm-hiddenish', 'tm-err', 'tm-ok');
    el.classList.add(ok ? 'tm-ok' : 'tm-err');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => el.classList.add('tm-hiddenish'), 3500);
  }

  function setBusy(b) {
    busy = b;

  }

  /* ------------------------------------------------------------- jumps -- */

  function wait(hours) {
    hours = Math.round(Number(hours) * 10) / 10;
    if (!(hours > 0) || busy) return;
    setBusy(true);
    toGame('tmWait', hours);
    /* the reply un-busies us; this is the belt for a dropped bridge */
    // No automatic retry: a lost acknowledgement must never stack another wait.
  }

  /* ----------------------------------------------------- C++ -> view ---- */

  const previousTimeInfo = window.tmInfo;
  window.tmInfo = function (payload) {
    if (typeof previousTimeInfo === 'function') previousTimeInfo(payload);
    try { cur = JSON.parse(String(payload)); } catch (e) { return; }
    if (!HDTimeControls.valid(cur)) { cur = null; return; }
    busy = false;
    renderClock(window.__tmJustJumped === true);
    window.__tmJustJumped = false;
  };

  const previousTimeResult = window.tmResult;
  window.tmResult = function (payload) {
    if (typeof previousTimeResult === 'function') previousTimeResult(payload);
    let r = null;
    try { r = JSON.parse(String(payload)); } catch (e) {}
    setBusy(false);
    if (!r) return;
    if (r.ok) {
      window.__tmJustJumped = true;
      const f = $('tm-jump-flash');
      f.textContent = '+' + r.hours + ' h';
      f.classList.remove('tm-show');
      void f.offsetWidth;   // restart the drift animation
      f.classList.remove('tm-hiddenish');
      f.classList.add('tm-show');
      note('⏩ ' + r.hours + ' hour' + (r.hours === 1 ? '' : 's') + ' passed', true);
    } else {
      note(r.msg || 'Could not wait here.', false);
    }
  };

  /* -------------------------------------------------------------- wire -- */

  let wired = false;

  function init() {
    if (wired) return;   // self-init on load + a host init() call must not double the listeners
    wired = true;
    HDTimeControls.mount($('tm-wait-controls'), toGame);
    initSky();
  }

  /* ------------------------------------------------------------ sky ----- */
  /* Weather picker (2026-08-17): C++ walks every WTHR the load order ships
     (weather_actions.cpp); this side owns search-as-you-type, Enter = top
     hit, the current-weather line, and "Let the sky decide". Bridge:
     tmWeatherList({q}) -> tmWeatherListData({weathers,current}) ·
     tmWeatherSet({id|'release'}) -> tmWeatherResult({ok,msg}). */
  const sky = { rows: [], current: null, debT: null, open: false };

  function skyAsk(q) {
    toGame('tmWeatherList', JSON.stringify({ q: String(q || '') }));
  }

  function renderSkyNow() {
    const el = $('tm-sky-now');
    if (!el) return;
    el.innerHTML = sky.current && sky.current.n
      ? 'Right now: <b>' + escSky(sky.current.n) + '</b>'
      : 'Right now: the sky is doing its own thing.';
  }

  function escSky(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderSkyList() {
    const list = $('tm-sky-list');
    if (!list) return;
    if (!sky.open || !sky.rows.length) {
      list.classList.add('tm-hiddenish');
      list.innerHTML = sky.open ? '<div class="tm-sky-row">No weather matches that.</div>' : '';
      if (sky.open && !sky.rows.length) list.classList.remove('tm-hiddenish');
      return;
    }
    list.classList.remove('tm-hiddenish');
    list.innerHTML = sky.rows.map(function (w, i) {
      return '<div class="tm-sky-row' + (i === 0 ? ' tm-sky-top' : '') + (w.cur ? ' tm-sky-cur' : '') +
        '" data-id="' + escSky(w.id) + '" title="Force this weather now — from ' + escSky(w.p) + '">' +
        '<span class="tm-sky-kind k-' + escSky(w.kind) + '">' + escSky(w.kind) + '</span>' +
        '<span class="tm-sky-name">' + escSky(w.n) + (w.cur ? ' · current' : '') + '</span>' +
        '<span class="tm-sky-plug">' + escSky(w.p) + '</span>' +
        '</div>';
    }).join('');
  }

  window.tmWeatherListData = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    sky.rows = Array.isArray(d.weathers) ? d.weathers : [];
    sky.current = d.current || null;
    renderSkyNow();
    renderSkyList();
  };

  window.tmWeatherResult = function (payload) {
    let d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    note(d.msg || (d.ok ? 'Done' : 'Failed'), !!d.ok);
    if (d.ok) skyAsk($('tm-sky-q') ? $('tm-sky-q').value : '');   // refresh the "current" mark
  };

  function skyPick(id) {
    if (!id) return;
    toGame('tmWeatherSet', JSON.stringify({ id: id }));
  }

  function initSky() {
    const q = $('tm-sky-q');
    const list = $('tm-sky-list');
    const rel = $('tm-sky-release');
    if (!q || !list || !rel) return;
    q.addEventListener('input', function () {
      sky.open = true;
      clearTimeout(sky.debT);
      sky.debT = setTimeout(function () { skyAsk(q.value); }, 200);
    });
    q.addEventListener('focus', function () {
      sky.open = true;
      renderSkyList();
      if (!sky.rows.length) skyAsk(q.value);
    });
    q.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && sky.rows.length) skyPick(sky.rows[0].id);
      if (e.key === 'Escape') { sky.open = false; renderSkyList(); q.blur(); }
    });
    list.addEventListener('click', function (ev) {
      const row = ev.target.closest('.tm-sky-row');
      if (row) skyPick(row.getAttribute('data-id'));
    });
    rel.addEventListener('click', function () { skyPick('release'); });
  }

  function onShow() { toGame('tmGet', ''); skyAsk(''); renderSkyNow(); }
  function onHide() {
    clearTimeout(noteTimer); $('tm-note').classList.add('tm-hiddenish');
    sky.open = false;
    if ($('tm-sky-list')) renderSkyList();
  }

  /* Omni: the presets are searchable the day this lands — "wait", "sleep",
     "morning" etc. all hit. Enter jumps straight from the omni row. */
  if (window.HDOmni) HDOmni.register({
    id: 'time', label: 'Time', tab: 'time',
    setFilter: function () {},
    index: function () {
      /* pins: the preset target/length IS the identity — static rows, so a
         pinned wait resolves live forever */
      const rows = [
        { label: 'Wait until Morning', detail: 'jump to 7:00 AM · instant, skips the slow sleep wait menu', kind: 'wait', keywords: 'sleep fast rest until', pin: 't:until:7', run: () => toGame('tmWait', JSON.stringify({until:7})) },
        { label: 'Wait until Noon', detail: 'jump to 12:00 · instant wait', kind: 'wait', keywords: 'sleep fast rest until', pin: 't:until:12', run: () => toGame('tmWait', JSON.stringify({until:12})) },
        { label: 'Wait until Evening', detail: 'jump to 6:00 PM · instant wait', kind: 'wait', keywords: 'sleep fast rest until', pin: 't:until:18', run: () => toGame('tmWait', JSON.stringify({until:18})) },
        { label: 'Wait until Night', detail: 'jump to 10:00 PM · instant wait', kind: 'wait', keywords: 'sleep fast rest until', pin: 't:until:22', run: () => toGame('tmWait', JSON.stringify({until:22})) },
      ];
      [1, 6, 12, 24].forEach((h) => rows.push({
        label: 'Wait ' + h + ' hour' + (h === 1 ? '' : 's'),
        detail: 'instant — one step, no ticking', kind: 'wait',
        keywords: 'sleep fast rest', pin: 't:hours:' + h, run: () => wait(h),
      }));
      rows.push({
        label: 'Time Dial',
        detail: 'open the circular wait dial — drag the ring, confirm, done',
        kind: 'wait', keywords: 'time dial wait clock sundial widget ring',
        run: () => toGame('hdFire', 'hd-time-dial'),
      });
      rows.push({
        label: 'Change the weather',
        detail: 'every weather the load order ships, the lock and your weather mods — the Weather tab',
        kind: 'wait', keywords: 'weather sky rain snow storm clear fog sun force fw',
        /* the Weather tab (2026-10-08) is the home for this now; the Sky card
           here stays as the quick picker beside the clock */
        jump: () => { if (typeof window.__omniSetTab === 'function') window.__omniSetTab('weather'); else if (typeof setTab === 'function') setTab('weather'); },
      });
      rows.push({
        label: 'Let the sky decide',
        detail: 'release a forced weather so natural weather resumes',
        kind: 'wait', keywords: 'weather sky release natural reset',
        pin: 't:sky:release', run: () => skyPick('release'),
      });
      return rows;
    },
  });

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  return { init, onShow, onHide, wantsPause: () => true };
})();
