/* =====================================================================
 *  Mod settings popout (hd-mcm.css owns the looks).
 *
 *  Rober, 2026-09-14: "What about capturing mcm settings as well in a
 *  config settings popout?" → "get it all in".
 *
 *  Every MCM Helper setting in the load order, read from the same files the
 *  Keys tab already parses, in one searchable overlay. The honest split the
 *  C++ side enforces and this view SHOWS rather than hides:
 *
 *    GlobalValue   → live from the engine, and editable here (writing it is
 *                    exactly what the mod's own MCM does)
 *    ModSetting*   → read from the settings ini, shown READ-ONLY: the value
 *                    lives in a file the running game has already cached, so
 *                    a write would look like it took and would not be seen
 *    PropertyValue → neither read nor written; the row says so
 *
 *  A row the deck cannot write is drawn dimmed with its reason on the row —
 *  never hidden, and never given a control that would lie about working.
 *
 *  A THIRD source (2026-10-12, Rober: IHarvest NG, "skymanager detects add a
 *  customization menu"): SKSE mods whose whole configuration is one ini
 *  (src/ini_mods.cpp, mcIni* bridge). They are listed only when their DLL is
 *  loaded, sit at the top of the list, and every row is writable, but a
 *  write applies on the NEXT LAUNCH (the mod reads its ini once). A row
 *  whose file value differs from what the game started with says so on the
 *  row, and the mod's own live menu is one button away.
 *
 *  Mounted INSIDE #panel (inset:0), the same idiom as #hk-icon-modal, so it
 *  inherits --ui-scale instead of needing its own scale maths.
 *  No range inputs anywhere — the deck's standing law; sliders are steppers.
 * ===================================================================== */
window.HDMcm = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var st = { mods: [], count: 0, writable: 0, loaded: false, loading: false,
             syLoaded: false, syWhy: '', iniLoaded: false };
  /* want: a mod open() was asked to show that has not arrived yet */
  var ui = { open: false, q: '', mod: '', want: '', toastT: null, err: '', scanning: '' };

  var CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  /* ---------------------------------------------------------- receive -- */

  window.mcStateResult = function (d) {
    st.loading = false;
    if (!d || typeof d !== 'object') { st.loaded = true; render(); return; }
    /* Only the MCM Helper rows are replaced. The SkyUI list and the ini mods
       arrive on their own bridges, often FIRST (this scan is the slow one),
       and must survive it. Order: ini mods, MCM Helper, SkyUI. */
    var ini = st.mods.filter(function (m) { return m.src === 'ini'; });
    var sky = st.mods.filter(function (m) { return m.src === 'skyui'; });
    st.mods = ini.concat(Array.isArray(d.mods) ? d.mods : [], sky);
    st.count = d.count || 0;
    st.writable = d.writable || 0;
    st.loaded = true;
    if (!ui.mod && st.mods.length) ui.mod = st.mods[0].id;
    render();
  };

  window.mcSetResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (d.msg) toast(d.msg, !d.ok);
    if (d.ok) {
      /* write the new value straight into our model rather than re-scanning:
         a rescan reparses every config on disk for one flipped flag. */
      for (var i = 0; i < st.mods.length; i++) {
        if (st.mods[i].id !== d.mod) continue;
        var pg = st.mods[i].pages || [];
        for (var p = 0; p < pg.length; p++) {
          var rows = pg[p].rows || [];
          for (var r = 0; r < rows.length; r++) {
            if (rows[r].i === d.i) rows[r].value = d.value;
          }
        }
      }
      render();
    }
  };

  /* ---- INI-configured SKSE mods (ini_mods.cpp) -------------------------
     One small file read per mod, so the whole list arrives at once with its
     rows. They go to the TOP: there are few of them, and each is here
     because its DLL is loaded right now. */
  window.mcIniResult = function (d) {
    st.iniLoaded = true;
    var mods = (d && Array.isArray(d.mods)) ? d.mods : [];
    for (var i = 0; i < mods.length; i++) {
      mods[i].src = 'ini';
      var pg = mods[i].pages || [];
      for (var p = 0; p < pg.length; p++) {
        var rows = pg[p].rows || [];
        for (var r = 0; r < rows.length; r++) rows[r].__ini = true;
      }
    }
    st.mods = mods.concat(st.mods.filter(function (m) { return m.src !== 'ini'; }));
    if (ui.want) {
      for (var w = 0; w < mods.length; w++) if (mods[w].id === ui.want) ui.mod = ui.want;
      ui.want = '';
    }
    if (!ui.mod && st.mods.length) ui.mod = st.mods[0].id;
    render();
    /* the Omni's warm() asked for this; a search typed before it landed must redraw */
    if (window.HDOmni && typeof HDOmni.refresh === 'function') HDOmni.refresh();
  };

  window.mcIniSetResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (d.msg) toast(d.msg, !d.ok);
    if (!d.ok) return;
    /* C++ read the file back after writing: this is what it now says. */
    var row = iniRow(d.mod, d.i);
    if (row) {
      row.value = d.value;
      if (d.launch != null) row.launch = d.launch;
      delete row.why;   /* a missing key is in the file now */
    }
    render();
  };

  function iniRow(modId, i) {
    for (var m = 0; m < st.mods.length; m++) {
      if (st.mods[m].src !== 'ini' || st.mods[m].id !== modId) continue;
      var pg = st.mods[m].pages || [];
      for (var p = 0; p < pg.length; p++) {
        var rows = pg[p].rows || [];
        for (var r = 0; r < rows.length; r++) if (rows[r].i === i) return rows[r];
      }
    }
    return null;
  }

  /* ---- SkyUI (Papyrus) MCMs -------------------------------------------
     These arrive as a LIST first (cheap) and are scanned one at a time, on
     demand, when the reader opens one: a scan is a chain of Papyrus round
     trips, so scanning all ~49 up front would stall for many seconds and
     fire every mod's OnConfigOpen for nothing. */

  window.syListResult = function (d) {
    st.syLoaded = true;
    st.syWhy = (d && d.why) || '';
    var mods = (d && Array.isArray(d.mods)) ? d.mods : [];
    /* drop any previous SkyUI rows, then re-add -- a re-list must not double up */
    st.mods = st.mods.filter(function (m) { return m.src !== 'skyui'; });
    for (var i = 0; i < mods.length; i++) {
      st.mods.push({ id: mods[i].id, name: mods[i].name, src: 'skyui',
                     pages: null, scanned: false });
    }
    if (!ui.mod && st.mods.length) ui.mod = st.mods[0].id;
    render();
  };

  window.syScanResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (ui.scanning === d.id) ui.scanning = '';
    for (var i = 0; i < st.mods.length; i++) {
      var m = st.mods[i];
      if (m.src !== 'skyui' || m.id !== d.id) continue;
      m.scanned = true;
      m.why = d.ok ? '' : (d.why || 'that MCM did not answer');
      m.note = d.note || '';
      m.pages = markSy(d.pages || []);
      if (d.name) m.name = d.name;
    }
    render();
  };

  window.sySetResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (d.msg) toast(d.msg, !d.ok);
    if (!d.ok || !Array.isArray(d.rows)) return;
    /* C++ re-read the page AFTER the mod's own handler ran, so this is what
       the mod actually did -- not what we asked it to do. Replace the page's
       rows wholesale: one handler is free to change several rows. */
    for (var i = 0; i < st.mods.length; i++) {
      var m = st.mods[i];
      if (m.src !== 'skyui' || m.id !== d.id || !m.pages) continue;
      for (var p = 0; p < m.pages.length; p++) {
        if (p !== d.p && !(d.p < 0 && m.pages.length === 1)) continue;
        var keep = m.pages[p].name;
        m.pages[p] = markSyPage({ name: keep, rows: d.rows });
      }
    }
    render();
  };

  function markSyPage(pg) {
    var rows = pg.rows || [];
    for (var i = 0; i < rows.length; i++) rows[i].__sy = true;
    return pg;
  }
  function markSy(pages) {
    for (var i = 0; i < pages.length; i++) markSyPage(pages[i]);
    return pages;
  }

  function toast(msg, err) {
    var t = $('mc-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', !!err);
    t.classList.remove('hidden');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.add('hidden'); }, 3200);
  }

  /* ------------------------------------------------------------ open --- */

  function ensureEl() {
    var el = $('mc-modal');
    if (el) return el;
    var host = $('panel') || document.body;
    el = document.createElement('div');
    el.id = 'mc-modal';
    el.className = 'hidden';
    el.innerHTML =
      '<div class="mc-box" role="dialog" aria-label="Mod settings">' +
        '<div class="mc-head">' +
          '<div class="mc-title">Mod settings</div>' +
          '<div class="mc-sub" id="mc-sub"></div>' +
          '<button type="button" class="mc-x" id="mc-close" title="Close">&#10005;</button>' +
        '</div>' +
        '<div class="mc-bar">' +
          '<span aria-hidden="true">&#8981;</span>' +
          '<input id="mc-search" type="text" autocomplete="off" spellcheck="false"' +
          ' placeholder="Search every mod setting" aria-label="Search mod settings">' +
          '<button type="button" class="mc-rescan" id="mc-rescan" title="Re-read every MCM config from disk">Rescan</button>' +
        '</div>' +
        '<div class="mc-cols">' +
          '<div class="mc-mods" id="mc-mods"></div>' +
          '<div class="mc-body" id="mc-body"></div>' +
        '</div>' +
        '<div id="mc-toast" class="hidden"></div>' +
      '</div>';
    host.appendChild(el);

    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    return el;
  }

  /* open(filter, modId): modId (optional) opens on that mod -- the Omni's
     "IHarvest NG settings" row. It may not have arrived yet; mcIniResult
     honours it when it does. */
  function open(filter, modId) {
    ensureEl();
    ui.open = true;
    ui.q = filter || '';
    if (modId) {
      ui.want = modId;
      for (var i = 0; i < st.mods.length; i++) if (st.mods[i].id === modId) { ui.mod = modId; ui.want = ''; }
    }
    $('mc-modal').classList.remove('hidden');
    if (!st.loaded && !st.loading) { st.loading = true; toGame('mcState', '{}'); }
    if (!st.syLoaded) toGame('syList', '{}');
    /* re-read every open: the file may have changed under us (its own menu) */
    toGame('mcIni', '{}');
    render();
    var s = $('mc-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
  }

  function close() {
    ui.open = false;
    var el = $('mc-modal');
    if (el) el.classList.add('hidden');
  }

  function isOpen() { return ui.open; }

  /* ---------------------------------------------------------- render -- */

  function rowMatches(r, q) {
    if (!q) return true;
    return String(r.label || '').toLowerCase().indexOf(q) !== -1 ||
           String(r.setting || '').toLowerCase().indexOf(q) !== -1;
  }

  function modMatches(m, q) {
    if (!q) return true;
    if (String(m.name || '').toLowerCase().indexOf(q) !== -1) return true;
    var pg = m.pages || [];
    for (var p = 0; p < pg.length; p++) {
      var rows = pg[p].rows || [];
      for (var i = 0; i < rows.length; i++) if (rowMatches(rows[i], q)) return true;
    }
    return false;
  }

  function countRows(m, q) {
    var n = 0, pg = m.pages || [];
    for (var p = 0; p < pg.length; p++) {
      var rows = pg[p].rows || [];
      for (var i = 0; i < rows.length; i++) if (rowMatches(rows[i], q)) n++;
    }
    return n;
  }

  /* A SkyUI row. Its verbs are the mod's OWN handlers (see skyui_mcm.h), so
     a toggle sends no value -- SelectOption flips whatever the mod thinks the
     value is, which is the only definition that can't drift. */
  function syRowHtml(modId, r) {
    var t = String(r.type || '').toLowerCase();
    if (t === 'header') return '<div class="mc-sec">' + esc(r.label || '') + '</div>';

    var ro = !r.writable;
    var h = '<div class="mc-row' + (ro ? ' ro' : '') + '">';
    h += '<div class="mc-row-id"><span class="mc-row-label">' + esc(r.label || '\u2014') + '</span>';
    if (r.info) h += '<span class="mc-row-info">' + esc(r.info) + '</span>';
    if (r.why) h += '<span class="mc-row-why">' + esc(r.why) + '</span>';
    h += '</div>';

    var base = ' data-sy="' + esc(modId) + '" data-p="' + (r.p != null ? r.p : -1) +
               '" data-i="' + r.i + '"';

    if (t === 'toggle') {
      var on = Number(r.value) >= 1;
      h += ro
        ? '<span class="mc-row-val">' + (on ? 'on' : 'off') + '</span>'
        : '<button type="button" class="mc-toggle' + (on ? ' on' : '') + '"' + base +
          ' data-act="toggle" title="Turn ' + (on ? 'off' : 'on') + '"><span></span>' +
          (on ? 'on' : 'off') + '</button>';
    } else if (t === 'slider') {
      var v = Number(r.value) || 0;
      var step = Number(r.step) || 1;
      var lo = (r.min != null) ? Number(r.min) : null;
      var hi = (r.max != null) ? Number(r.max) : null;
      var down = (lo != null) ? Math.max(lo, v - step) : v - step;
      var up = (hi != null) ? Math.min(hi, v + step) : v + step;
      var shown = Math.round(v * 1000) / 1000;
      h += ro
        ? '<span class="mc-row-val">' + shown + '</span>'
        : '<span class="mc-step"><button type="button"' + base +
          ' data-act="slider" data-to="' + down + '" title="Down">&#8722;</button>' +
          '<b>' + shown + '</b><button type="button"' + base +
          ' data-act="slider" data-to="' + up + '" title="Up">&#43;</button></span>';
    } else if (t === 'text') {
      h += ro
        ? '<span class="mc-row-val">' + esc(r.text || '\u2014') + '</span>'
        : '<button type="button" class="mc-press"' + base + ' data-act="press" ' +
          'title="Run this">' + esc(r.text || 'Press') + '</button>';
    } else if (t === 'keymap') {
      var code = Number(r.value) || 0;
      h += '<span class="mc-row-val">' + (code > 0 ? 'key ' + code : 'unbound') + '</span>';
    } else {
      h += '<span class="mc-row-val">' + esc(r.text || (r.value != null ? r.value : '\u2014')) + '</span>';
    }

    if (r.resettable) {
      h += '<button type="button" class="mc-reset"' + base +
           ' data-act="reset" title="Back to this mod\u2019s default">\u21ba</button>';
    }
    h += '</div>';
    return h;
  }

  /* An ini value as the reader sees it: on/off, the enum's word, a number. */
  function iniShow(r, v) {
    var t = String(r.type || '').toLowerCase();
    if (t === 'toggle') return Number(v) >= 1 ? 'on' : 'off';
    if (t === 'enum' && r.options && r.options[Math.round(Number(v))] != null)
      return String(r.options[Math.round(Number(v))]);
    return String(Math.round(Number(v) * 1000) / 1000);
  }
  function r4(x) { return Math.round(x * 10000) / 10000; }

  /* An ini row: always writable, written to the file, live NEXT launch.
     Same controls as an MCM Helper row, plus the info line, a chip when the
     file no longer matches what this game started with, and a reset to the
     mod's own default. */
  function iniRowHtml(modId, r) {
    var t = String(r.type || '').toLowerCase();
    var v = Number(r.value);
    var base = ' data-ini="' + esc(modId) + '" data-i="' + r.i + '"';
    var changed = r.launch != null && Math.abs(Number(r.launch) - v) > 1e-6;
    var h = '<div class="mc-row' + (changed ? ' pend' : '') + '">';
    h += '<div class="mc-row-id"><span class="mc-row-label">' + esc(r.label || r.setting || '\u2014') + '</span>';
    if (r.info) h += '<span class="mc-row-info">' + esc(r.info) + '</span>';
    if (changed) {
      h += '<span class="mc-chip" title="Saved to the file. This game started with ' +
        esc(iniShow(r, r.launch)) + '.">Next launch \u00b7 started at ' + esc(iniShow(r, r.launch)) + '</span>';
    }
    if (r.why) h += '<span class="mc-row-why">' + esc(r.why) + '</span>';
    h += '</div>';

    if (t === 'toggle') {
      var on = v >= 1;
      h += '<button type="button" class="mc-toggle' + (on ? ' on' : '') + '"' + base +
        ' data-to="' + (on ? 0 : 1) + '" title="Turn ' + (on ? 'off' : 'on') + '"><span></span>' +
        (on ? 'on' : 'off') + '</button>';
    } else if (t === 'enum') {
      var opts = r.options || [];
      var idx = Math.max(0, Math.min(opts.length - 1, Math.round(v) || 0));
      h += '<span class="mc-step"><button type="button"' + base +
        ' data-to="' + (idx > 0 ? idx - 1 : opts.length - 1) + '" title="Previous">&#8722;</button>' +
        '<b>' + esc(opts[idx] != null ? opts[idx] : v) + '</b><button type="button"' + base +
        ' data-to="' + ((idx + 1) % Math.max(1, opts.length)) + '" title="Next">&#43;</button></span>';
    } else {
      var step = Number(r.step) || 1;
      var lo = Number(r.min), hi = Number(r.max);
      var down = r4(Math.max(lo, v - step)), up = r4(Math.min(hi, v + step));
      h += '<span class="mc-step"><button type="button"' + base + ' data-to="' + down + '"' +
        (v <= lo ? ' disabled' : '') + ' title="Down">&#8722;</button>' +
        '<b>' + esc(iniShow(r, v)) + '</b><button type="button"' + base + ' data-to="' + up + '"' +
        (v >= hi ? ' disabled' : '') + ' title="Up">&#43;</button></span>';
    }
    var atDef = r.def != null && Math.abs(Number(r.def) - v) < 1e-6;
    h += '<button type="button" class="mc-reset' + (atDef ? ' idle' : '') + '"' + base +
      ' data-to="' + r.def + '"' + (atDef ? ' disabled' : '') +
      ' title="Back to the mod\u2019s default (' + esc(iniShow(r, r.def)) + ')">\u21ba</button>';
    h += '</div>';
    return h;
  }

  function rowHtml(modId, r) {
    if (r.__sy) return syRowHtml(modId, r);
    if (r.__ini) return iniRowHtml(modId, r);
    var t = String(r.type || '').toLowerCase();
    var ro = !r.writable;
    var h = '<div class="mc-row' + (ro ? ' ro' : '') + '">';
    h += '<div class="mc-row-id"><span class="mc-row-label">' + esc(r.label || r.setting || '—') + '</span>';
    if (r.why) h += '<span class="mc-row-why">' + esc(r.why) + '</span>';
    h += '</div>';

    if (r.readable === false) {
      h += '<span class="mc-row-val none">not readable</span>';
    } else if (t === 'toggle') {
      var on = Number(r.value) >= 1;
      h += ro
        ? '<span class="mc-row-val">' + (on ? 'on' : 'off') + '</span>'
        : '<button type="button" class="mc-toggle' + (on ? ' on' : '') +
          '" data-set="' + esc(modId) + '" data-i="' + r.i + '" data-to="' + (on ? 0 : 1) +
          '" title="Turn ' + (on ? 'off' : 'on') + '"><span></span>' + (on ? 'on' : 'off') + '</button>';
    } else if (t === 'enum' || t === 'stepper') {
      var opts = r.options || [];
      var idx = Math.max(0, Math.min(opts.length - 1, Math.round(Number(r.value) || 0)));
      var label = opts.length ? opts[idx] : String(r.value);
      h += ro
        ? '<span class="mc-row-val">' + esc(label) + '</span>'
        : '<span class="mc-step"><button type="button" data-set="' + esc(modId) + '" data-i="' + r.i +
          '" data-to="' + (idx > 0 ? idx - 1 : (opts.length ? opts.length - 1 : 0)) +
          '" title="Previous">&#8722;</button><b>' + esc(label) + '</b>' +
          '<button type="button" data-set="' + esc(modId) + '" data-i="' + r.i +
          '" data-to="' + (opts.length ? (idx + 1) % opts.length : 0) + '" title="Next">&#43;</button></span>';
    } else if (t === 'slider') {
      var v = Number(r.value) || 0;
      var step = Number(r.step) || 1;
      var lo = Number(r.min) || 0, hi = Number(r.max) || 0;
      var shown = (Math.round(v * 1000) / 1000);
      h += ro
        ? '<span class="mc-row-val">' + shown + '</span>'
        : '<span class="mc-step"><button type="button" data-set="' + esc(modId) + '" data-i="' + r.i +
          '" data-to="' + Math.max(lo, v - step) + '" title="Down">&#8722;</button>' +
          '<b>' + shown + '</b>' +
          '<button type="button" data-set="' + esc(modId) + '" data-i="' + r.i +
          '" data-to="' + (hi ? Math.min(hi, v + step) : v + step) + '" title="Up">&#43;</button></span>';
    } else {
      h += '<span class="mc-row-val">' + esc(r.value != null ? r.value : '—') + '</span>';
    }
    h += '</div>';
    return h;
  }

  function render() {
    if (!$('mc-modal')) return;
    var q = ui.q.trim().toLowerCase();

    var sub = $('mc-sub');
    if (sub) {
      var nSy = 0, nIni = 0;
      for (var si = 0; si < st.mods.length; si++) {
        if (st.mods[si].src === 'skyui') nSy++;
        else if (st.mods[si].src === 'ini') nIni++;
      }
      sub.textContent = !st.loaded
        ? (st.loading ? 'reading every MCM config…' : '')
        : st.count + ' settings across ' + (st.mods.length - nSy - nIni) + ' MCM Helper mods · ' +
          st.writable + ' the deck can change' +
          (nSy ? ' · ' + nSy + ' SkyUI mods, opened one at a time' : '') +
          (nIni ? ' · ' + nIni + ' SKSE ' + (nIni === 1 ? 'mod' : 'mods') + ' by settings file' : '');
    }

    var mods = st.mods.filter(function (m) { return modMatches(m, q); });
    if (mods.length && !mods.some(function (m) { return m.id === ui.mod; })) ui.mod = mods[0].id;

    var list = $('mc-mods');
    if (list) {
      /* the ini mods and the SkyUI list arrive on their own bridges, long
         before the MCM Helper scan, so they are listed while it still runs */
      var early = st.loaded ? mods : mods.filter(function (m) { return m.src === 'ini' || m.src === 'skyui'; });
      if (!st.loaded && !early.length) {
        list.innerHTML = '<div class="mc-empty">' + (st.loading ? 'Scanning…' : '') + '</div>';
      } else if (!early.length) {
        list.innerHTML = '<div class="mc-empty">No mod matches.</div>';
      } else {
        var lh = '';
        for (var i = 0; i < early.length; i++) {
          var m = early[i];
          var tally = (m.src === 'skyui' && !m.scanned) ? '\u00b7' : countRows(m, q);
          lh += '<button type="button" class="mc-mod' + (m.id === ui.mod ? ' on' : '') +
            (m.src === 'skyui' ? ' sky' : '') + (m.src === 'ini' ? ' ini' : '') +
            '" data-mod="' + esc(m.id) + '"><span>' + esc(m.name) + '</span>' +
            '<i>' + tally + '</i></button>';
        }
        if (!st.loaded && st.loading) lh += '<div class="mc-empty">Scanning MCMs…</div>';
        list.innerHTML = lh;
      }
    }

    var body = $('mc-body');
    if (!body) return;
    var curIni = null;
    for (var ci = 0; ci < st.mods.length; ci++)
      if (st.mods[ci].id === ui.mod && st.mods[ci].src === 'ini') curIni = st.mods[ci];
    if (!st.loaded && !curIni) {
      body.innerHTML = '<div class="mc-empty">' +
        (st.loading ? 'Reading every MCM config from disk…' : '') + '</div>';
      return;
    }
    var cur = null;
    for (var k = 0; k < st.mods.length; k++) if (st.mods[k].id === ui.mod) cur = st.mods[k];
    if (!cur) {
      body.innerHTML = '<div class="mc-empty">' +
        (st.mods.length ? 'Pick a mod on the left.'
                        : 'No MCM Helper configs found in this load order.') + '</div>';
      return;
    }
    /* A SkyUI mod is read only when someone actually opens it -- one scan is
       a chain of Papyrus round trips AND fires the mod's OnConfigOpen, so it
       is never speculative. */
    if (cur.src === 'skyui' && !cur.scanned) {
      if (ui.scanning !== cur.id) {
        ui.scanning = cur.id;
        toGame('syScan', JSON.stringify({ id: cur.id }));
      }
      body.innerHTML = '<div class="mc-empty">Asking ' + esc(cur.name) +
        ' to build its menu\u2026</div>';
      return;
    }
    if (cur.src === 'skyui' && cur.why) {
      body.innerHTML = '<div class="mc-empty">' + esc(cur.why) + '</div>';
      return;
    }

    var bh = '';
    if (cur.src === 'ini') {
      bh += '<div class="mc-inihead"><div class="mc-inihead-txt"><span>Settings file</span><b>' +
        esc(cur.path || '') + '</b></div>' +
        /* the loaded build decides this, not us: ini_mods.cpp checks the DLL's own export */
        '<span class="mc-when' + (cur.live ? ' live' : '') + '">' +
        (cur.live ? 'Applies live' : 'Applies next launch') + '</span>';
      if (cur.smf && cur.smfPage) {
        bh += '<button type="button" class="mc-own" data-smf="' + esc(cur.smfPage) + '" title="Opens ' +
          esc(cur.name) + '\u2019s own SKSE Menu Framework page, where changes apply live">Open ' +
          esc(cur.name) + '\u2019s live menu</button>';
      }
      bh += '</div>';
    }
    if (cur.note) bh += '<div class="mc-note">' + esc(cur.note) + '</div>';
    var shown = 0;
    for (var p = 0; p < (cur.pages || []).length; p++) {
      var pg = cur.pages[p];
      var rows = (pg.rows || []).filter(function (r) { return rowMatches(r, q); });
      if (!rows.length) continue;
      bh += '<div class="mc-page">';
      if (pg.name) bh += '<div class="mc-page-name">' + esc(pg.name) + '</div>';
      for (var r2 = 0; r2 < rows.length; r2++) { bh += rowHtml(cur.id, rows[r2]); shown++; }
      bh += '</div>';
    }
    body.innerHTML = shown ? bh
      : '<div class="mc-empty">Nothing in ' + esc(cur.name) + ' matches.</div>';
  }

  /* --------------------------------------------------------- handlers -- */

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#mc-close')) { close(); return; }
    if (t.closest('#mc-rescan')) {
      st.loaded = false; st.loading = true; st.syLoaded = false;
      for (var ri = 0; ri < st.mods.length; ri++) {
        if (st.mods[ri].src === 'skyui') { st.mods[ri].scanned = false; st.mods[ri].pages = null; }
      }
      ui.scanning = '';
      render();
      toGame('mcState', JSON.stringify({ force: true }));
      toGame('syList', '{}');
      toGame('mcIni', '{}');
      return;
    }
    var own = t.closest('[data-smf]');
    if (own) { toGame('hdSmfOpen', own.getAttribute('data-smf')); return; }
    var ini = t.closest('[data-ini]');
    if (ini) {
      if (ini.hasAttribute('disabled')) return;
      toGame('mcIniSet', JSON.stringify({
        mod: ini.getAttribute('data-ini'),
        i: parseInt(ini.getAttribute('data-i'), 10),
        value: parseFloat(ini.getAttribute('data-to'))
      }));
      return;
    }
    var mod = t.closest('[data-mod]');
    if (mod) { ui.mod = mod.getAttribute('data-mod'); render(); return; }
    var sy = t.closest('[data-sy]');
    if (sy) {
      var payload = {
        id: sy.getAttribute('data-sy'),
        act: sy.getAttribute('data-act'),
        p: parseInt(sy.getAttribute('data-p'), 10),
        i: parseInt(sy.getAttribute('data-i'), 10)
      };
      var to = sy.getAttribute('data-to');
      if (to != null) payload.value = parseFloat(to);
      toGame('sySet', JSON.stringify(payload));
      return;
    }
    var set = t.closest('[data-set]');
    if (set) {
      toGame('mcSet', JSON.stringify({
        act: 'set',
        mod: set.getAttribute('data-set'),
        i: parseInt(set.getAttribute('data-i'), 10),
        value: parseFloat(set.getAttribute('data-to'))
      }));
      return;
    }
    /* click the dim surround to dismiss, like the deck's other modals */
    if (t.id === 'mc-modal') close();
  }

  function onInput(e) {
    if (!e.target || e.target.id !== 'mc-search') return;
    ui.q = String(e.target.value || '');
    render();
    var s = $('mc-search');
    if (s && document.activeElement !== s) {
      s.focus();
      try { s.setSelectionRange(s.value.length, s.value.length); } catch (err) {}
    }
  }

  /* ---------------------------------------------------------- harness -- */
  function demo(payload) {
    ensureEl();
    window.mcStateResult(payload || {
      count: 4, writable: 2,
      mods: [
        { id: 'Demo Mod', name: 'Demo Mod', pages: [ { name: 'General', rows: [
          { i: 0, label: 'Enable feature', type: 'toggle', source: 'GlobalValue',
            readable: true, writable: true, value: 1 },
          { i: 1, label: 'Difficulty', type: 'enum', source: 'GlobalValue',
            readable: true, writable: true, value: 1, options: ['Easy', 'Normal', 'Hard'] },
          { i: 2, label: 'Radius', type: 'slider', source: 'GlobalValue',
            readable: true, writable: true, value: 40, min: 0, max: 100, step: 10 },
          { i: 3, label: 'Saved in its ini', type: 'toggle', source: 'ModSettingBool',
            readable: true, writable: false, value: 0,
            why: "saved in this mod's settings file — change it in its own MCM" }
        ] } ] },
        { id: 'Other Mod', name: 'Other Mod', pages: [ { name: 'Main', rows: [
          { i: 0, label: 'On a script', type: 'toggle', source: 'PropertyValueBool',
            readable: false, writable: false,
            why: "lives on the mod's own script, which the deck does not read" }
        ] } ] }
      ]
    });
    ui.open = true;
    $('mc-modal').classList.remove('hidden');
    render();
  }

  /* The ini half, as the C++ side sends it (a trimmed IHarvest NG). */
  function demoIni(payload) {
    ensureEl();
    window.mcIniResult(payload || { ok: true, mods: [ {
      id: 'ini:IHarvestNG', name: 'IHarvest NG', path: 'Data/SKSE/Plugins/IHarvestNG.ini',
      file: true, smf: true, smfPage: 'IHarvest NG/Settings',
      note: 'IHarvest NG reads this file when the game starts, so a change here applies on your next launch.',
      pages: [
        { name: 'Casting', rows: [
          { i: 0, setting: 'Casting.fMagickaCostPerWisp', label: 'Magicka per wisp (spell)',
            info: 'Magicka drained for every wisp sent.', type: 'slider', value: 9, launch: 8, def: 8,
            min: 0, max: 100, step: 1, writable: true },
          { i: 3, setting: 'Casting.iMaxWisps', label: 'Max wisps at once', info: '',
            type: 'slider', value: 128, launch: 128, def: 64, min: 1, max: 128, step: 4, writable: true } ] },
        { name: 'What to harvest', rows: [
          { i: 10, setting: 'Harvest.bArrows', label: 'Arrows & bolts', info: 'Loose ammo.',
            type: 'toggle', value: 0, launch: 0, def: 0, writable: true,
            why: 'not in the file yet, so the mod uses its default; a change here adds it' } ] },
        { name: 'Diagnostics', rows: [
          { i: 17, setting: 'General.iLogLevel', label: 'Log level', info: '', type: 'enum',
            value: 2, launch: 2, def: 2, options: ['trace', 'debug', 'info', 'warn', 'error', 'critical', 'off'],
            writable: true } ] }
      ] } ] });
  }

  /* ---------------------------------------------------------- omni ----- */
  /* Each detected ini mod is findable by name AND by any of its settings
     ("arrows" finds IHarvest NG), and Enter opens the popout on it. warm()
     asks once per omni open; until the answer lands the provider is empty. */
  if (window.HDOmni) {
    HDOmni.register({
      id: 'ini-mods',
      label: 'Mod settings',
      tab: '',
      /* Rober, 2026-10-12, searching "harvest": the row sat under 3 hotkeys and 12 items because
         "harvest" is only a mid-word hit on "IHarvest NG settings" (25) against their exact
         "Harvest" (100). Rank orders only groups whose hit is ON THE LABEL (omni-label-first), and
         this label is the mod's name: typing the mod's name means its settings, so it leads.
         A hit on one of its setting names (keywords) still sorts after every label match. */
      rank: 10,
      warm: function () { toGame('mcIni', '{}'); },
      index: function () {
        var out = [];
        for (var i = 0; i < st.mods.length; i++) {
          var m = st.mods[i];
          if (m.src !== 'ini') continue;
          var labels = [], n = 0;
          var pg = m.pages || [];
          for (var p = 0; p < pg.length; p++) {
            var rows = pg[p].rows || [];
            for (var r = 0; r < rows.length; r++) { labels.push(rows[r].label); n++; }
          }
          (function (id) {
            out.push({
              label: m.name + ' settings',
              detail: n + ' settings from its settings file \u00b7 changes apply ' +
                (m.live ? 'live' : 'next launch'),
              kind: 'settings',
              keywords: 'mod settings config ini ' + labels.join(' '),
              pin: 'ini:' + id,
              run: function () { open('', id); }
            });
          })(m.id);
        }
        return out;
      }
    });
  }

  return { open: open, close: close, isOpen: isOpen, demo: demo, demoIni: demoIni,
           _state: function () { return st; } };
})();
