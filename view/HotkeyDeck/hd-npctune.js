'use strict';

/* ====================================================================== *
 *  NPC Tune — the F7 quick card's "⚒ Tune" modal (Rober, 2026-08-18:
 *  "this would be nice as a f7 button with a really polished nice UI
 *  modal popout, spacious"). PROTEUS's NPC editor, on our architecture.
 *
 *  C++ (src/npc_tune.cpp) owns every write; this module owns the modal:
 *  vitals / presence steppers, the four temperament dials as segmented
 *  rows, the Essential|Protected|Killable tri-state, level (with the
 *  honest "stops scaling with you" note), and collapsible regen /
 *  resistances / skills grids. Two persistence tiers, said out loud:
 *  stats + scale live in the save; level + protection ride the DLL's
 *  npc-edits.json sidecar and are revertable.
 *
 *  Bridge — requests: ntGet({formId}) · ntApply({formId,set}) ·
 *  ntRevert({formId}). Replies: ntGetResult · ntApplyResult ·
 *  ntRevertResult (string or parsed object, both accepted).
 *
 *  Mount: a BODY-level overlay (a #panel sibling), flex-centered and
 *  self-scaled — CSS transform scale(--ui-scale) with divided caps, the
 *  .fd-modal idiom from the 2026-08-14 popup audit's second pass.
 *
 *  API: HDNpcTune.open({formId, name, portrait}) · close() · isOpen()
 * ====================================================================== */

window.HDNpcTune = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  /* ---- the temperament dials: AV key -> ordered option labels ---------- */
  const TEMPER = [
    ['aggression', 'Aggression', ['Calm', 'Aggressive', 'Very aggressive', 'Frenzied'],
      'How readily they start a fight'],
    ['confidence', 'Confidence', ['Cowardly', 'Cautious', 'Average', 'Brave', 'Foolhardy'],
      'When they flee — Cowardly always runs, Foolhardy never does'],
    ['assistance', 'Assistance', ['Helps nobody', 'Helps allies', 'Helps friends & allies'],
      'Who they jump in for'],
    ['morality', 'Morality', ['Any crime', 'Violence only', 'Property only', 'No crime'],
      'What they will do if ordered or provoked'],
  ];

  const PROTECTION = [
    ['essential', 'Essential', 'Cannot die — anything fatal knocks them down instead'],
    ['protected', 'Protected', 'Only YOU can kill them'],
    ['none', 'Killable', 'Anything can kill them'],
  ];

  /* numeric field groups: [key, step, decimals] — labels come from the reply */
  const STEP = {
    health: [10, 0], magicka: [10, 0], stamina: [10, 0], carryweight: [10, 0],
    speedmult: [5, 0], unarmed: [1, 0],
    healrate: [0.5, 2], magickarate: [0.5, 2], staminarate: [0.5, 2],
    resistfire: [5, 0], resistfrost: [5, 0], resistshock: [5, 0],
    resistmagic: [5, 0], resistpoison: [5, 0], resistdisease: [5, 0],
    scale: [0.05, 2], level: [1, 0],
  };
  const SKILL_STEP = [5, 0];

  const nt = {
    open: false,
    formId: 0,
    name: '',
    portrait: '',
    data: null,
    draft: {},          // input key -> typed value (survives re-renders)
    pendTemper: {},     // av key -> pending option index
    pendProt: null,     // pending protection value
    sects: { regen: false, resists: false, skills: false },
    filter: '',         // the dial filter — "fire" finds the resist, "sneak" the skill
    busy: false,
    status: '',
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'ntGet') setTimeout(function () { devGet(arg); }, 30);
      if (DEV && fn === 'ntApply') setTimeout(function () { devApply(arg); }, 30);
      if (DEV && fn === 'ntRevert') setTimeout(function () { devRevert(arg); }, 30);
    }
  }

  function parseReply(d) {
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return null; } }
    return (d && typeof d === 'object') ? d : null;
  }

  /* =============================================================== open == */

  function open(opts) {
    opts = opts || {};
    const fid = Number(opts.formId) || 0;
    if (!fid) return;
    nt.open = true;
    nt.formId = fid;
    nt.name = String(opts.name || '');
    nt.portrait = String(opts.portrait || '');
    if (window.FolPane && FolPane.requestPortraitFaces) FolPane.requestPortraitFaces();
    nt.data = null;
    nt.draft = {};
    nt.pendTemper = {};
    nt.pendProt = null;
    nt.filter = '';
    nt.busy = false;
    nt.status = '';
    render();
    toGame('ntGet', JSON.stringify({ formId: fid.toString(16).toUpperCase() }));
  }

  function close() {
    if (!nt.open) return;
    nt.open = false;
    nt.data = null;
    const ov = $('hd-nt-overlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  function isOpen() { return nt.open; }

  /* ============================================================ replies == */

  window.ntGetResult = function (d) {
    d = parseReply(d);
    if (!d || !nt.open) return;
    if (!d.ok) { nt.status = d.msg || 'Could not read them.'; nt.data = null; render(); return; }
    nt.data = d;
    if (d.n && !nt.name) nt.name = d.n;
    render();
  };

  function landed(d) {
    d = parseReply(d);
    if (!d) return;
    nt.busy = false;
    if (!nt.open) return;
    if (!d.ok) { nt.status = d.msg || 'Failed.'; render(); return; }
    nt.data = d;
    nt.draft = {};
    nt.pendTemper = {};
    nt.pendProt = null;
    nt.status = d.msg || 'Changed.';
    render();
  }

  window.ntApplyResult = function (d) { landed(d); };
  window.ntRevertResult = function (d) { landed(d); };

  /* ============================================================= render == */

  function captureDraft() {
    const ov = $('hd-nt-overlay');
    if (!ov) return;
    ov.querySelectorAll('.nt-num').forEach(function (input) {
      nt.draft[input.getAttribute('data-k')] = input.value;
    });
  }

  function shownVal(key, base, dec) {
    if (nt.draft[key] !== undefined) return nt.draft[key];
    const n = Number(base) || 0;
    return String(dec > 0 ? Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec) : Math.round(n));
  }

  function numRow(key, label, base, step, dec, hint) {
    return '<div class="nt-row" data-key="' + esc(key) + '" data-base="' + Number(base) +
      '" data-step="' + step + '" data-dec="' + dec + '">' +
      '<span class="nt-label" title="' + esc(hint || label) + '">' + esc(label) + '</span>' +
      '<span class="nt-ctrl">' +
      '<button class="nt-step" data-d="-1" title="Less">−</button>' +
      '<input class="nt-num" data-k="' + esc(key) + '" type="text" inputmode="decimal" ' +
      'autocomplete="off" spellcheck="false" value="' + esc(shownVal(key, base, dec)) + '">' +
      '<button class="nt-step" data-d="1" title="More">+</button>' +
      '</span></div>';
  }

  function segRow(key, label, options, cur, pend, hint) {
    const sel = pend !== undefined && pend !== null ? pend : cur;
    return '<div class="nt-seg-row" title="' + esc(hint || '') + '">' +
      '<span class="nt-label">' + esc(label) + '</span>' +
      '<span class="nt-seg" data-seg="' + esc(key) + '">' +
      options.map(function (o, i) {
        const on = i === sel;
        const was = pend !== undefined && pend !== null && i === cur && pend !== cur;
        return '<button class="nt-seg-btn' + (on ? ' nt-seg-on' : '') + (was ? ' nt-seg-was' : '') +
          '" data-i="' + i + '"' + (was ? ' title="What they are now — Apply moves them"' : '') + '>' +
          esc(o) + '</button>';
      }).join('') +
      '</span></div>';
  }

  function sectHead(key, label, count) {
    return '<button class="nt-sect-head" data-sect="' + key + '" aria-expanded="' +
      (nt.sects[key] ? 'true' : 'false') + '">' +
      '<span class="nt-sect-arrow">' + (nt.sects[key] ? '▾' : '▸') + '</span>' +
      esc(label) + ' <span class="nt-sect-n">' + count + '</span></button>';
  }

  function gridOf(rows, stepDef) {
    return '<div class="nt-grid">' + rows.map(function (f) {
      const sd = STEP[f.key] || stepDef;
      return numRow(f.key, f.label, f.base, sd[0], sd[1]);
    }).join('') + '</div>';
  }

  function render() {
    let ov = $('hd-nt-overlay');
    if (!nt.open) { if (ov && ov.parentNode) ov.parentNode.removeChild(ov); return; }
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'hd-nt-overlay';
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
      ov.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
      });
      document.body.appendChild(ov);
    }

    const d = nt.data;
    let body;
    if (!d) {
      body = '<div class="nt-load">' +
        (nt.status ? esc(nt.status) : '<span class="nt-spin"></span> Reading ' + esc(nt.name || 'them') + '…') +
        '</div>';
    } else {
      const editedN = Array.isArray(d.edited) ? d.edited.length : 0;
      /* the dial filter: label/key substring; while active, sections with
         matches fold OPEN and empty cards hide entirely */
      const flt = nt.filter.trim().toLowerCase();
      const hit = function (f) {
        return !flt || String(f.label).toLowerCase().indexOf(flt) !== -1 ||
          String(f.key).indexOf(flt) !== -1;
      };
      const fAttrs = (d.attrs || []).filter(hit);
      const fRegen = (d.regen || []).filter(hit);
      const fResists = (d.resists || []).filter(hit);
      const fSkills = (d.skills || []).filter(hit);
      const fTemper = TEMPER.filter(function (t) { return !flt || t[1].toLowerCase().indexOf(flt) !== -1; });
      const showProt = !flt || 'protection essential protected killable'.indexOf(flt) !== -1;
      const showLevel = !flt || 'level'.indexOf(flt) !== -1;
      const showScale = !flt || 'size scale'.indexOf(flt) !== -1;
      const vitalsRows = fAttrs.filter(function (f) {
        return ['health', 'magicka', 'stamina', 'carryweight'].indexOf(f.key) !== -1;
      });
      const presenceRows = fAttrs.filter(function (f) {
        return ['speedmult', 'unarmed'].indexOf(f.key) !== -1;
      });
      const anyMatch = vitalsRows.length || presenceRows.length || showScale || showProt ||
        showLevel || fTemper.length || fRegen.length || fResists.length || fSkills.length;
      /* a section is open when toggled open, OR while the filter matches into
         it — a hit hidden behind a folded header would read as "not found" */
      const secOpen = function (key, rows) { return flt ? rows.length > 0 : nt.sects[key]; };
      body =
        '<div class="nt-warn">Stats, temperament and size live in <b>your save</b>. ' +
        (d.durable
          ? 'Level and protection are kept across launches by the deck' + (editedN ? '' : '') +
            ' and can be reverted.'
          : 'This one is a dynamic NPC — level/protection cannot outlive a relaunch.') +
        '</div>' +

        '<div class="nt-filter"><span class="nt-filter-glyph">⌕</span>' +
        '<input id="nt-filter" type="text" autocomplete="off" spellcheck="false" ' +
        'placeholder="Filter the dials — try \'fire\', \'sneak\', \'confidence\', \'level\'…" ' +
        'value="' + esc(nt.filter) + '"></div>' +

        (!anyMatch ? '<div class="nt-nomatch">No dial matches “' + esc(nt.filter) + '”.</div>' :

        '<div class="nt-cols">' +
        '<div class="nt-col">' +

        (vitalsRows.length
          ? '<div class="nt-card"><div class="nt-card-h">Vitals</div>' +
            gridOf(vitalsRows, [10, 0]) + '</div>' : '') +

        (presenceRows.length || showScale
          ? '<div class="nt-card"><div class="nt-card-h">Presence</div>' +
            '<div class="nt-grid">' +
            presenceRows.map(function (f) {
              const sd = STEP[f.key] || [1, 0];
              return numRow(f.key, f.key === 'speedmult' ? 'Speed %' :
                f.key === 'unarmed' ? 'Unarmed dmg' : f.label, f.base, sd[0], sd[1]);
            }).join('') +
            (showScale ? numRow('scale', 'Size', d.scale, 0.05, 2,
              '1.00 = normal. 0.10–10 — she is resized in the world, saved with your save.') : '') +
            '</div></div>' : '') +

        (showProt || showLevel
          ? '<div class="nt-card"><div class="nt-card-h">Mortality</div>' +
            (showProt
              ? '<div class="nt-seg-col">' +
                segRow('protection', 'Protection',
                  PROTECTION.map(function (p) { return p[1]; }),
                  Math.max(0, PROTECTION.findIndex(function (p) { return p[0] === d.protection; })),
                  nt.pendProt === null ? null : PROTECTION.findIndex(function (p) { return p[0] === nt.pendProt; }),
                  PROTECTION.map(function (p) { return p[1] + ': ' + p[2]; }).join('  ·  ')) +
                '</div>' : '') +
            (showLevel
              ? '<div class="nt-levelrow">' +
                numRow('level', 'Level', d.level, 1, 0) +
                '<div class="nt-levelnote">' +
                (d.pcMult ? 'Scales with you now — setting a level FIXES it and stops the scaling.'
                          : 'Fixed level' + (editedN ? ' (deck-kept across launches)' : '') + '.') +
                '</div></div>' : '') +
            '</div>' : '') +

        '</div>' +
        '<div class="nt-col">' +

        (fTemper.length
          ? '<div class="nt-card"><div class="nt-card-h">Temperament</div>' +
            '<div class="nt-seg-col">' +
            fTemper.map(function (t) {
              const cur = d.temper && typeof d.temper[t[0]] === 'number' ? d.temper[t[0]] : 0;
              return segRow(t[0], t[1], t[2], cur,
                nt.pendTemper[t[0]] !== undefined ? nt.pendTemper[t[0]] : null, t[3]);
            }).join('') +
            '</div></div>' : '') +

        (fRegen.length || fResists.length || fSkills.length
          ? '<div class="nt-card nt-card-sects">' +
            (fRegen.length
              ? sectHead('regen', 'Regeneration', fRegen.length) +
                (secOpen('regen', fRegen) ? gridOf(fRegen, [0.5, 2]) : '') : '') +
            (fResists.length
              ? sectHead('resists', 'Resistances', fResists.length) +
                (secOpen('resists', fResists) ? gridOf(fResists, [5, 0]) : '') : '') +
            (fSkills.length
              ? sectHead('skills', 'Skills', fSkills.length) +
                (secOpen('skills', fSkills) ? gridOf(fSkills, SKILL_STEP) : '') : '') +
            '</div>' : '') +

        '</div></div>');
    }

    const chips = [];
    if (d) {
      if (d.race) chips.push(esc(d.race));
      chips.push('Level ' + (d.level | 0) + (d.pcMult ? ' · scales with you' : ''));
      chips.push(d.unique ? 'Unique' : 'Common');
      const prot = PROTECTION.filter(function (p) { return p[0] === d.protection; })[0];
      if (prot) chips.push(prot[1]);
      if (d.dead) chips.push('<span class="nt-chip-dead-txt">Dead</span>');
    }

    const editedN = d && Array.isArray(d.edited) ? d.edited.length : 0;
    ov.innerHTML =
      '<div class="nt-card-outer" role="dialog" aria-modal="true" aria-label="Tune ' + esc(nt.name) + '">' +
      '<div class="nt-head">' +
      '<div class="nt-face' + (nt.portrait ? '' : ' nt-face-glyph') + '">' +
      (nt.portrait
        ? '<img src="' + esc(nt.portrait) + '" alt="" draggable="false" ' +
          'onerror="this.parentNode.classList.add(\'nt-face-glyph\');this.remove()">' +
          '<span class="nt-face-fallback">' + esc((nt.name || '?').charAt(0)) + '</span>'
        : '<span class="nt-face-fallback">' + esc((nt.name || '?').charAt(0)) + '</span>') +
      '</div>' +
      '<div class="nt-title-wrap">' +
      '<div class="nt-title">⚒ ' + esc(nt.name || 'Tune') + '</div>' +
      (chips.length ? '<div class="nt-chips">' + chips.map(function (c) {
        return '<span class="nt-chip' + (c.indexOf('nt-chip-dead-txt') !== -1 ? ' nt-chip-dead' : '') +
          '">' + c + '</span>';
      }).join('') + '</div>' : '') +
      '</div>' +
      '<button class="nt-x" title="Close">✕</button>' +
      '</div>' +
      '<div class="nt-body">' + body + '</div>' +
      '<div class="nt-foot">' +
      '<span id="nt-status" class="nt-status">' + esc(nt.status) + '</span>' +
      (editedN ? '<button id="nt-revert" class="nt-btn nt-revert" title="Restore the original level and protection and forget the deck-kept edits. Stat edits stay — they live in the save.">↺ Revert level/protection</button>' : '') +
      '<button id="nt-cancel" class="nt-btn">Close</button>' +
      '<button id="nt-apply" class="nt-apply"' + (d && !nt.busy ? '' : ' disabled') + '>' +
      (nt.busy ? 'Applying…' : 'Apply changes') + '</button>' +
      '</div></div>';

    /* ---- wiring ---- */
    /* The head face is built into the innerHTML above, so it gets framed here
       rather than at build time — without it the dialog centre-cropped a face
       the user had already framed (2026-08-19 sweep). */
    if (window.HDFaceFit && HDFaceFit.paintPortraitsIn)
      HDFaceFit.paintPortraitsIn(ov, '.nt-face img');
    ov.querySelector('.nt-x').addEventListener('click', close);
    const cancel = $('nt-cancel');
    if (cancel) cancel.addEventListener('click', close);
    const apply = $('nt-apply');
    if (apply) apply.addEventListener('click', doApply);
    const revert = $('nt-revert');
    if (revert) revert.addEventListener('click', function () {
      if (nt.busy) return;
      nt.busy = true;
      render();
      toGame('ntRevert', JSON.stringify({ formId: nt.formId.toString(16).toUpperCase() }));
    });
    ov.querySelectorAll('.nt-step').forEach(function (b) {
      b.addEventListener('click', function () {
        const row = b.closest('.nt-row');
        const input = row.querySelector('.nt-num');
        const step = parseFloat(row.getAttribute('data-step')) || 1;
        const dec = parseInt(row.getAttribute('data-dec'), 10) || 0;
        const dd = parseInt(b.getAttribute('data-d'), 10) || 0;
        const cur = parseFloat(String(input.value).replace(/[^0-9.\-]/g, ''));
        const next = (isNaN(cur) ? 0 : cur) + dd * step;
        input.value = String(Math.max(0, Math.round(next * Math.pow(10, dec)) / Math.pow(10, dec)));
      });
    });
    ov.querySelectorAll('.nt-num').forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') doApply();
        if (e.key === 'Escape') close();
      });
    });
    ov.querySelectorAll('.nt-seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        const seg = b.closest('.nt-seg').getAttribute('data-seg');
        const i = parseInt(b.getAttribute('data-i'), 10) | 0;
        captureDraft();
        if (seg === 'protection') {
          const cur = Math.max(0, PROTECTION.findIndex(function (p) { return p[0] === nt.data.protection; }));
          nt.pendProt = (i === cur) ? null : PROTECTION[i][0];
        } else {
          const cur = nt.data.temper && typeof nt.data.temper[seg] === 'number' ? nt.data.temper[seg] : 0;
          if (i === cur) delete nt.pendTemper[seg];
          else nt.pendTemper[seg] = i;
        }
        render();
      });
    });
    ov.querySelectorAll('.nt-sect-head').forEach(function (b) {
      b.addEventListener('click', function () {
        captureDraft();
        const key = b.getAttribute('data-sect');
        nt.sects[key] = !nt.sects[key];
        render();
      });
    });
    const flt = $('nt-filter');
    if (flt) {
      flt.addEventListener('input', function () {
        captureDraft();                    // typed dial values survive the narrowing
        nt.filter = flt.value;
        const pos = flt.selectionStart;
        render();
        const again = $('nt-filter');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
      flt.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') {
          if (flt.value) { captureDraft(); nt.filter = ''; render(); const a = $('nt-filter'); if (a) a.focus(); }
          else close();
        }
      });
    }
  }

  /* ============================================================== apply == */

  /* Only what DIFFERS goes on the wire — numeric drafts vs the record,
     pending seg picks vs the current dial. Reads the DRAFT, not the DOM
     (a collapsed section's typed value must still apply). */
  function collect() {
    const d = nt.data;
    if (!d) return null;
    captureDraft();
    const set = {};
    const numeric = (d.attrs || []).concat(d.regen || [], d.resists || [], d.skills || [],
      [{ key: 'scale', base: d.scale }, { key: 'level', base: d.level }]);
    numeric.forEach(function (f) {
      if (nt.draft[f.key] === undefined) return;
      const n = parseFloat(String(nt.draft[f.key]).replace(/[^0-9.\-]/g, ''));
      if (isNaN(n)) return;
      if (Math.abs(n - Number(f.base)) > 1e-3) set[f.key] = n;
    });
    Object.keys(nt.pendTemper).forEach(function (k) { set[k] = nt.pendTemper[k]; });
    if (nt.pendProt !== null) set.protection = nt.pendProt;
    return set;
  }

  function doApply() {
    if (!nt.data || nt.busy) return;
    const set = collect();
    if (!set || !Object.keys(set).length) { nt.status = 'Nothing changed.'; render(); return; }
    nt.busy = true;
    nt.status = '';
    render();
    toGame('ntApply', JSON.stringify({ formId: nt.formId.toString(16).toUpperCase(), set: set }));
  }

  /* ======================================================== dev fixtures == */

  const DEV_NPC = {
    ok: true, formId: '14', n: 'Lydia', race: 'Nord', level: 50, pcMult: true,
    unique: true, protection: 'protected', female: true, dead: false, scale: 1,
    baseId: 'Skyrim.esm|0A2C8E', durable: true,
    attrs: [
      { key: 'health', label: 'Health', base: 354 },
      { key: 'magicka', label: 'Magicka', base: 50 },
      { key: 'stamina', label: 'Stamina', base: 226 },
      { key: 'carryweight', label: 'Carry weight', base: 300 },
      { key: 'speedmult', label: 'Speed %', base: 100 },
      { key: 'unarmed', label: 'Unarmed damage', base: 4 },
    ],
    regen: [
      { key: 'healrate', label: 'Health regen', base: 0.7 },
      { key: 'magickarate', label: 'Magicka regen', base: 3 },
      { key: 'staminarate', label: 'Stamina regen', base: 5 },
    ],
    resists: [
      { key: 'resistfire', label: 'Fire', base: 0 },
      { key: 'resistfrost', label: 'Frost', base: 0 },
      { key: 'resistshock', label: 'Shock', base: 0 },
      { key: 'resistmagic', label: 'Magic', base: 0 },
      { key: 'resistpoison', label: 'Poison', base: 0 },
      { key: 'resistdisease', label: 'Disease', base: 0 },
    ],
    skills: [
      { key: 'onehanded', label: 'One-Handed', base: 78 },
      { key: 'block', label: 'Block', base: 62 },
      { key: 'heavyarmor', label: 'Heavy Armor', base: 71 },
    ],
    temper: { aggression: 1, confidence: 3, assistance: 2, morality: 3 },
    edited: [],
  };

  function devGet() { window.ntGetResult(JSON.parse(JSON.stringify(DEV_NPC))); }

  function devApply(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const set = req.set || {};
    ['attrs', 'regen', 'resists', 'skills'].forEach(function (g) {
      DEV_NPC[g].forEach(function (f) { if (set[f.key] !== undefined) f.base = set[f.key]; });
    });
    ['aggression', 'confidence', 'assistance', 'morality'].forEach(function (k) {
      if (set[k] !== undefined) DEV_NPC.temper[k] = set[k];
    });
    if (set.scale !== undefined) DEV_NPC.scale = set.scale;
    if (set.level !== undefined) { DEV_NPC.level = set.level; DEV_NPC.pcMult = false; }
    if (set.protection !== undefined) DEV_NPC.protection = set.protection;
    const edited = [];
    if (set.level !== undefined || DEV_NPC.__lvlEdit) { edited.push('level'); DEV_NPC.__lvlEdit = true; }
    if (set.protection !== undefined || DEV_NPC.__protEdit) { edited.push('protection'); DEV_NPC.__protEdit = true; }
    const out = JSON.parse(JSON.stringify(DEV_NPC));
    out.edited = edited;
    out.msg = 'Changed - stats live in your save; level/protection kept across launches';
    window.ntApplyResult(out);
  }

  function devRevert() {
    DEV_NPC.__lvlEdit = DEV_NPC.__protEdit = false;
    DEV_NPC.pcMult = true; DEV_NPC.level = 50; DEV_NPC.protection = 'protected';
    const out = JSON.parse(JSON.stringify(DEV_NPC));
    out.edited = [];
    out.msg = 'Level and protection restored - stat edits stay (they live in the save)';
    window.ntRevertResult(out);
  }

  /* ================================================================ omni == *
   * The modal had exactly one door: the ⚒ button on the F7 quick card. That
   * button only exists while you are already looking at someone with the
   * Followers tab in front of you, so "essential", "aggression" and "carry
   * weight" — the words someone actually comes here with — found nothing
   * anywhere in the deck.
   *
   * `tab` is empty on purpose: the modal IS the destination, and the obvious
   * alternative ('followers') is gated on Follower Organizer being installed,
   * which would hide a feature that needs no mod at all — C++ tunes the actor
   * in your crosshair whatever else is in the load order.
   */

  /* The person under the crosshair, from the snapshot the palette takes at
     open — the same one the quick card's ⚒ button reads, so search lands on
     exactly who the button would have. Returns null when you are not looking
     at anybody, which the row then says out loud rather than opening an empty
     modal. */
  function crosshairNpc() {
    try {
      const t = window.FolPane && FolPane._state && FolPane._state.target;
      const id = t ? (Number(t.formId) || 0) >>> 0 : 0;
      if (id) return { formId: id, name: String(t.name || ''), dead: !!t.dead };
    } catch (e) {}
    return null;
  }

  /* Her captured portrait or facegen head render, resolved through the
     Followers pane exactly as the quick card does — same pseudo-member, same
     two helpers, so the modal wears the same face the card would have handed
     it. Any part of that chain missing is simply no picture: the head plate
     falls back to her initial. */
  function portraitOf(npc) {
    try {
      const fp = window.FolPane;
      if (!fp || typeof fp._portraitFor !== 'function' ||
          typeof fp._portraitSrc !== 'function') return '';
      const shot = (fp.portraitInfoFor || fp._portraitFor).call(fp, {
        name: npc.name, original: npc.name,
        formId: '0x' + npc.formId.toString(16), dead: npc.dead,
      });
      return shot ? fp._portraitSrc(shot) : '';
    } catch (e) { return ''; }
  }

  // Repaint only the face: a portrait completion must not interrupt a slider or typed edit.
  window.addEventListener('hd-portraits-changed', function () {
    if (!nt.open) return;
    const ov = $('hd-nt-overlay');
    const face = ov && ov.querySelector('.nt-face');
    if (!face) return;
    nt.portrait = portraitOf(nt);
    let img = face.querySelector('img');
    if (!nt.portrait) { if (img) img.remove(); face.classList.add('nt-face-glyph'); return; }
    if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; face.appendChild(img); }
    img.onerror = function () { face.classList.add('nt-face-glyph'); img.remove(); };
    img.src = nt.portrait;
    face.classList.remove('nt-face-glyph');
    if (window.HDFaceFit) HDFaceFit.paintPortrait(img, nt.portrait);
  });

  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'npctune', label: 'Tune an NPC', tab: '',
      index: function () {
        const npc = crosshairNpc();
        const named = npc && npc.name;
        return [{
          label: named ? ('Tune ' + npc.name) : 'Tune whoever you are looking at',
          detail: npc
            ? 'Level, health, magicka, stamina, carry weight, size, the four ' +
              'temperament dials, and Essential / Protected / Killable'
            : 'Look at someone first — this rewrites the person in your ' +
              'crosshair: level, stats, size, temperament, Essential / ' +
              'Protected / Killable',
          kind: 'npc',
          keywords: 'tune edit npc actor proteus essential protected killable ' +
            'immortal invincible mortal aggression confidence assistance ' +
            'morality temperament level scale size height health magicka ' +
            'stamina carry weight speed unarmed regen regeneration resist ' +
            'resistance fire frost shock poison disease skills stats',
          run: function () {
            const target = crosshairNpc();
            if (!target) {
              if (typeof window.toast === 'function') {
                window.toast('Look at someone first — Tune edits the person in your crosshair');
              }
              return;
            }
            open({ formId: target.formId, name: target.name,
                   portrait: portraitOf(target) });
          },
        }];
      },
    });
  }

  return {
    open: open, close: close, isOpen: isOpen,
    portraitIds: function () { return nt.open ? [nt.formId] : []; },
    _nt: nt, _collect: collect, _render: render, _doApply: doApply,
  };
})();
