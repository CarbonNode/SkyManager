'use strict';

/* ====================================================================== *
 *  Faces — the RaceMenu-preset tab inside the Hotkey Deck view.
 *
 *  The ask (Rober, 2026-08-04): its OWN tab to browse presets, SEE what they
 *  look like (images you set yourself — try a preset on your character, take a
 *  picture, revert, assign it), and apply to whoever you're looking at, a
 *  follower you search for, or your own character.
 *
 *  This pane OWNS the preset feature end to end — the gallery, the
 *  fdPreset bridge, and the fdPresetData / fdPresetResult receivers. The
 *  Followers card's 🎭 button is a DEEP-LINK into here (one system, not two
 *  copies), aimed at whoever the card was showing.
 *
 *  Bridge — C++ registers `fdPreset` (JS→C++) and pushes `fdPresetData` /
 *  `fdPresetResult` back; both already exist for the old inline block.
 *    fdPreset {op:'index'}                         → fdPresetData(index)
 *    fdPreset {op:'img', preset, icon}             → fdPresetData(index)
 *    fdPreset {op:'apply', formId, preset, flags}  → fdPresetResult(...)
 *    fdPreset {op:'spawn', base?, name, preset, flags} → fdPresetResult(...)
 *    fdPreset {op:'saveplayer', name}              → fdPresetResult(saved)
 *
 *  Host contract (mirrors LootPane/RoomsPane): FacesPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome — the shared size card covers it) ·
 *  wantsPause() -> true · aimAt(formId, name) for the Followers deep-link.
 * ====================================================================== */

window.FacesPane = (function () {

  const PLAYER_FORMID = 0x14;      // the player's ref, for "try it on me"
  const BACKUP_PRESET = 'PD_MyFaceBackup';

  /* toGame / toast come from app.js globals; h() is the followers/loot DOM
     builder — reuse the one app.js exposes so a tag helper isn't duplicated. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ---- state ---- */
  let host = null;
  let pdState = null;           // last index push
  let pdBusy = false;
  let backedUp = false;         // did we snapshot the player's face this session?
  let fqStatus = null;          // {msg, ok, pending}

  /* Target: who gets the face. kind = 'crosshair' | 'me' | 'pick'.
     For 'crosshair' we read the live crosshair snapshot the Followers pane
     already holds (it is the roster/target authority); 'pick' names a follower
     by form id; 'me' is the player. */
  const target = { kind: 'crosshair', formId: 0, name: '' };

  /* ui bag persists mode / filter / selection across repaints. */
  const ui = { mode: '', full: false, filter: '', sel: 0, summonName: '', assignFor: null,
    catFilter: '', catFor: null, renameCat: null };

  const DEV = location.search.indexOf('dev=1') !== -1;

  function isActive() { return window.__hdActiveTab === 'faces'; }

  /* ---- target resolution ---- */

  function crosshairTarget() {
    // FolPane owns the crosshair snapshot pushed at open (fdTarget). Read it
    // rather than duplicating a second receiver for the same push.
    try {
      const fp = window.FolPane;
      const t = fp && fp._state && fp._state.target;
      if (t && t.formId) return { formId: Number(t.formId) || 0, name: t.name || '' };
    } catch (e) { /* FolPane not up yet */ }
    return { formId: 0, name: '' };
  }

  function resolvedTarget() {
    if (target.kind === 'me') return { formId: PLAYER_FORMID, name: 'you' };
    if (target.kind === 'pick') return { formId: target.formId, name: target.name || 'her' };
    const c = crosshairTarget();
    return { formId: c.formId, name: c.name || 'the NPC you’re looking at' };
  }

  /* Followers deep-link: aim at a specific person and show the tab. */
  function aimAt(formId, name) {
    target.kind = 'pick';
    target.formId = Number(formId) || 0;
    target.name = name || '';
    if (window.__omniSetTab) window.__omniSetTab('faces');
    else render();
  }

  /* ---- preset list + images (ported from the proven inline block) ---- */

  function pdNames() {
    if (!pdState || !pdState.presets) return [];
    const seen = {}, out = [];
    const take = (arr) => (arr || []).forEach((n) => {
      const k = String(n).toLowerCase();
      if (!seen[k]) { seen[k] = true; out.push(String(n)); }
    });
    take(pdState.presets.exported);
    take(pdState.presets.presets);
    out.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
    return out;
  }
  function pdIconFor(name) {
    if (!pdState) return '';
    const a = pdState.assign && pdState.assign[name];
    if (a) return a;
    const stem = String(name).toLowerCase();
    return (pdState.icons || []).filter((f) => f.replace(/\.[^.]+$/, '').toLowerCase() === stem)[0] || '';
  }
  function pdHex8(id) { let s = (Number(id) >>> 0).toString(16).toUpperCase(); while (s.length < 8) s = '0' + s; return s; }
  function pdWearing(formId) {
    if (!formId || !pdState || !pdState.registry || !pdState.registry.entries) return null;
    const hx = pdHex8(formId);
    return pdState.registry.entries.filter((e) => e.ref === hx)[0] || null;
  }

  /* ---- bridge ---- */
  function requestIndex() { toGame('fdPreset', '{"op":"index"}'); }

  function pdSend(payload, pendingMsg) {
    pdBusy = true;
    fqStatus = { msg: pendingMsg, ok: true, pending: true };
    toGame('fdPreset', JSON.stringify(payload));
    render();
  }

  /* ================================================================= UI == */

  function render() {
    if (!host || !host.isConnected) return;
    host.textContent = '';
    host.append(buildHeader());
    host.append(buildBody());
  }

  function buildHeader() {
    const rt = resolvedTarget();
    const bar = h('div', { class: 'fc-head' });

    bar.append(h('div', { class: 'fc-title' }, 'Faces',
      h('span', { class: 'fc-sub' }, 'RaceMenu presets')));

    // Target chips: Looking-at · Me · (a picked follower shows as its own chip)
    const chips = h('div', { class: 'fc-targets' });
    const chip = (kind, label, tip) => h('button', {
      class: 'fc-chip' + (target.kind === kind ? ' on' : ''), type: 'button',
      'aria-pressed': String(target.kind === kind), title: tip,
      onClick: () => {
        target.kind = kind;
        if (kind !== 'pick') { target.formId = 0; target.name = ''; }
        render();
      },
    }, label);
    const c = crosshairTarget();
    chips.append(chip('crosshair', c.name ? '⌖ ' + c.name : '⌖ Looking at…',
      c.name ? 'Apply to ' + c.name + ', who you’re looking at' : 'Look at someone in-game, then apply to them'));
    chips.append(chip('me', '☺ Me', 'Try a preset on your own character (backed up so you can revert)'));
    if (target.kind === 'pick' && target.name)
      chips.append(h('span', { class: 'fc-chip on fc-chip-pick', title: 'From the Followers tab' }, '★ ' + target.name));
    bar.append(chips);

    // Status line — a refusal is the useful sentence, keep it on screen.
    if (fqStatus) {
      bar.append(h('div', {
        class: 'fc-status' + (fqStatus.pending ? ' pending' : (fqStatus.ok ? ' ok' : ' bad')),
      }, (fqStatus.pending ? '… ' : (fqStatus.ok ? '✓ ' : '✕ ')) + fqStatus.msg));
    }

    // Me-mode revert affordance: restoring the pre-try-on face.
    if (target.kind === 'me' && backedUp) {
      bar.append(h('button', {
        class: 'fc-restore', type: 'button',
        title: 'Put your own face back — the one saved before you started trying presets',
        onClick: () => {
          if (pdBusy) return;
          pdSend({ op: 'apply', formId: PLAYER_FORMID, preset: BACKUP_PRESET, flags: 15 },
            'Restoring your face…');
        },
      }, '⟲ Restore my face'));
    }
    return bar;
  }

  function buildBody() {
    const body = h('div', { class: 'fc-body' });

    if (!pdState) { body.append(h('div', { class: 'pd-empty' }, 'Reading the preset list…')); return body; }
    if (!pdState.available) {
      body.append(h('div', { class: 'pd-empty' },
        'Preset Director isn’t loaded — tick the mod in MO2 and restart the game.'));
      return body;
    }
    const names = pdNames();
    if (!names.length) {
      body.append(h('div', { class: 'pd-empty' },
        'No .jslot presets found in CharGen/Exported or CharGen/Presets.'));
      return body;
    }

    const rt = resolvedTarget();
    const worn = pdWearing(rt.formId);
    if (worn) body.append(h('div', { class: 'pd-worn' }, rt.name + ' is wearing “' + worn.preset + '”'));

    // ---- favorites + categories (from pdState.fav / cats / catOf) ----
    const favSet = () => { const s = {}; (pdState.fav || []).forEach((n) => { s[n] = true; }); return s; };
    const isFav = (n) => (pdState.fav || []).indexOf(n) !== -1;
    const catOf = (n) => (pdState.catOf && pdState.catOf[n]) || '';
    const catList = () => (pdState.cats || []).slice();
    const toggleFav = (n) => toGame('fdPreset', JSON.stringify({ op: 'fav', preset: n, on: !isFav(n) }));
    const setCat = (n, c) => toGame('fdPreset', JSON.stringify({ op: 'cat-set', preset: n, cat: c }));

    // Mode chips
    const modeRow = h('div', { class: 'pd-modes' });
    const chip = (label, key, tip) => {
      const on = ui.mode === key;
      return h('button', { class: 'fc-set pd-chip' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': String(on), title: tip,
        onClick: () => { ui.mode = on ? '' : key; ui.assignFor = null; ui.catFor = null; render(); } }, label);
    };
    modeRow.append(chip('＋ Summon', 'summon', 'A tile click SPAWNS a new person wearing that preset. Name her below.'));
    modeRow.append(chip('🖼 Set image', 'assign',
      'A tile click sets which image represents that preset. Take a photo of your character wearing it, then pick the file here.'));
    modeRow.append(chip('🗂 Categorize', 'cat',
      'A tile click files that preset into a category. Make new categories below. ☆ on any tile favourites it.'));
    const fullOn = !!ui.full;
    modeRow.append(h('button', { class: 'fc-set pd-chip' + (fullOn ? ' on' : ''), type: 'button',
      'aria-pressed': String(fullOn),
      title: fullOn ? 'Applying the FULL preset incl. skin overrides — can tint skin. Click for face-only.'
                    : 'Face shape + morphs only (safe). Click to also apply the preset’s skin overrides.',
      onClick: () => { ui.full = !fullOn; render(); } }, fullOn ? '⚠ Full look' : '◇ Face only'));
    body.append(modeRow);

    // Category filter row: All · ★ Favorites · <each category> · Uncategorized.
    // In Categorize mode each category chip grows rename/delete, plus ＋ New.
    const catRow = h('div', { class: 'fc-catfilter' });
    const fchip = (key, label, tip) => {
      const on = (ui.catFilter || '') === key;
      return h('button', { class: 'fc-set fc-catchip' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': String(on), title: tip || label,
        onClick: () => { ui.catFilter = on ? '' : key; ui.sel = 0; render(); } }, label);
    };
    catRow.append(fchip('', 'All'));
    catRow.append(fchip('__fav__', '★ Favorites', 'Only presets you starred'));
    catList().forEach((c) => {
      if (ui.mode === 'cat' && ui.renameCat === c) {
        // Inline rename (PrismaUI has no window.prompt): the chip becomes a field.
        const ri = h('input', { class: 'fc-newcat fc-rename-input', type: 'text', value: c });
        ri.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const to = ri.value.trim();
            if (to && to !== c) toGame('fdPreset', JSON.stringify({ op: 'cat-rename', from: c, to }));
            ui.renameCat = null;
            if (!to || to === c) render();
          } else if (e.key === 'Escape') { ui.renameCat = null; render(); }
          e.stopPropagation();
        });
        ri.addEventListener('click', (e) => e.stopPropagation());
        catRow.append(ri);
      } else if (ui.mode === 'cat') {
        const wrap = h('span', { class: 'fc-catedit' });
        wrap.append(fchip(c, c));
        wrap.append(h('button', { class: 'fc-catx', type: 'button', title: 'Rename “' + c + '”',
          onClick: (e) => { e.stopPropagation(); ui.renameCat = c; render(); } }, '✎'));
        wrap.append(h('button', { class: 'fc-catx', type: 'button', title: 'Delete “' + c + '” (presets are kept, just un-filed)',
          onClick: (e) => { e.stopPropagation(); toGame('fdPreset', JSON.stringify({ op: 'cat-del', name: c })); } }, '✕'));
        catRow.append(wrap);
      } else {
        catRow.append(fchip(c, c));
      }
    });
    catRow.append(fchip('__none__', 'Uncategorized'));
    if (ui.mode === 'cat') {
      const nc = h('input', { class: 'fc-newcat', type: 'text', placeholder: '＋ New category…', value: '' });
      nc.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const v = nc.value.trim();
          if (v) toGame('fdPreset', JSON.stringify({ op: 'cat-new', name: v }));
        }
        e.stopPropagation();
      });
      nc.addEventListener('click', (e) => e.stopPropagation());
      catRow.append(nc);
    }
    body.append(catRow);

    if (ui.mode === 'summon') {
      const nameIn = h('input', { class: 'pd-name', type: 'text',
        placeholder: 'Her name (e.g. Testa) — Enter jumps to search', value: ui.summonName || '' });
      nameIn.addEventListener('input', () => { ui.summonName = nameIn.value; });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const s = body.querySelector('.pd-search'); if (s) s.focus(); }
        e.stopPropagation();
      });
      body.append(h('div', { class: 'pd-summon-row' }, nameIn));
    }

    // Search + count + grid + assign strip
    const search = h('input', { class: 'pd-search', type: 'text',
      placeholder: 'Type to find a preset… ↑↓ pick, Enter applies', value: ui.filter || '' });
    body.append(search);
    const count = h('div', { class: 'pd-count' });
    body.append(count);
    const grid = h('div', { class: 'pd-grid fc-grid' });
    body.append(grid);
    const strip = h('div', { class: 'pd-iconstrip' });
    body.append(strip);

    // Ordered render model: a list of {head} and {name} items, plus a flat
    // name list for keyboard nav. Grouping only when unfiltered + "All".
    const buildItems = () => {
      const q = String(ui.filter || '').toLowerCase().trim();
      const items = [], flat = [];
      const push = (n) => { items.push({ name: n }); flat.push(n); };
      const head = (t) => items.push({ head: t });

      if (q) {
        names.filter((n) => n.toLowerCase().indexOf(q) !== -1).forEach(push);
        return { items, flat };
      }
      const filt = ui.catFilter || '';
      if (filt === '__fav__') { names.filter(isFav).forEach(push); return { items, flat }; }
      if (filt === '__none__') { names.filter((n) => !catOf(n)).forEach(push); return { items, flat }; }
      if (filt) { names.filter((n) => catOf(n) === filt).forEach(push); return { items, flat }; }

      // "All": Favorites, then each category, then Uncategorized.
      const favs = names.filter(isFav);
      if (favs.length) { head('★ Favorites'); favs.forEach(push); }
      catList().forEach((c) => {
        const inC = names.filter((n) => catOf(n) === c);
        if (inC.length) { head(c); inC.forEach(push); }
      });
      const none = names.filter((n) => !catOf(n));
      if (none.length) { if (catList().length || favs.length) head('Uncategorized'); none.forEach(push); }
      return { items, flat };
    };
    const flatList = () => buildItems().flat;
    const selIdx = () => Math.min(Math.max(0, ui.sel | 0), Math.max(0, flatList().length - 1));

    const fire = (name) => {
      if (pdBusy) return;
      if (ui.mode === 'assign') { ui.assignFor = (ui.assignFor === name) ? null : name; paintStrip(); paintGrid(); return; }
      if (ui.mode === 'cat') { ui.catFor = (ui.catFor === name) ? null : name; paintStrip(); paintGrid(); return; }
      const flags = ui.full ? 15 : 3;
      if (ui.mode === 'summon') {
        const nm = String(ui.summonName || '').trim() || ('New ' + name);
        pdSend({ op: 'spawn', name: nm, preset: name, flags }, 'Summoning ' + nm + ' as “' + name + '”…');
        return;
      }
      const t = resolvedTarget();
      if (!t.formId) {
        fqStatus = { msg: target.kind === 'crosshair' ? 'Look at someone in-game first' : 'No target', ok: false, pending: false };
        render(); return;
      }
      if (target.kind === 'me' && !backedUp) {
        backedUp = true;
        toGame('fdPreset', JSON.stringify({ op: 'saveplayer', name: BACKUP_PRESET }));
      }
      pdSend({ op: 'apply', formId: t.formId, preset: name, flags },
        'Applying “' + name + '” to ' + t.name + '…');
    };

    function paintGrid() {
      grid.textContent = '';
      grid.classList.toggle('pd-busy', pdBusy);
      const { items, flat } = buildItems();
      const withImg = names.filter((n) => pdIconFor(n)).length;
      const favN = (pdState.fav || []).length;
      count.textContent = (String(ui.filter || '').trim() ? flat.length + ' of ' + names.length + ' presets'
        : names.length + ' presets') + (favN ? ' · ' + favN + ' ★' : '') + (withImg ? ' · ' + withImg + ' with images' : '');
      if (!flat.length) { grid.append(h('div', { class: 'pd-empty' }, 'Nothing here' + (ui.filter ? ' matches “' + ui.filter + '”' : ''))); return; }
      const sel = selIdx();
      let tileIdx = -1;
      items.forEach((it) => {
        if (it.head != null) { grid.append(h('div', { class: 'pd-group-head' }, it.head)); return; }
        tileIdx++;
        const i = tileIdx, name = it.name;
        const icon = pdIconFor(name), fav = isFav(name), mine = catOf(name);
        const cls = 'pd-tile' + (i === sel ? ' is-sel' : '')
          + (ui.assignFor === name ? ' is-assigning' : '')
          + (ui.catFor === name ? ' is-assigning' : '')
          + (worn && worn.preset === name ? ' is-worn' : '');
        const tile = h('button', { class: cls, type: 'button',
          title: (ui.mode === 'summon' ? 'Summon a new person wearing “' + name + '”'
            : ui.mode === 'assign' ? 'Set the image for “' + name + '”'
            : ui.mode === 'cat' ? 'File “' + name + '” into a category (below)'
            : 'Apply “' + name + '” to ' + rt.name),
          onClick: () => { ui.sel = i; fire(name); } });
        // ☆ favourite corner — always available, one click, never fires the tile.
        tile.append(h('button', { class: 'pd-fav' + (fav ? ' on' : ''), type: 'button',
          title: fav ? 'Un-favourite' : 'Favourite this preset',
          onClick: (e) => { e.stopPropagation(); toggleFav(name); } }, fav ? '★' : '☆'));
        const face = h('div', { class: 'pd-face' });
        if (icon) face.style.backgroundImage = 'url("preset-icons/' + cssEsc(encodeURIComponent(icon)) + '")';
        else face.append(h('span', { class: 'pd-initial' }, name.slice(0, 1).toUpperCase()));
        tile.append(face, h('span', { class: 'pd-tile-name', title: name }, name));
        if (ui.mode === 'cat' && mine) tile.append(h('span', { class: 'pd-tile-cat' }, mine));
        grid.append(tile);
      });
      const selEl = grid.querySelector('.pd-tile.is-sel');
      if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: 'nearest' });
    }

    function paintStrip() {
      strip.textContent = '';
      // Image picker (Set-image mode)
      if (ui.mode === 'assign' && ui.assignFor) {
        const current = pdState.assign && pdState.assign[ui.assignFor];
        strip.append(h('div', { class: 'pd-strip-head' },
          'Image for “' + ui.assignFor + '” — pick a file you dropped in preset-icons/:'));
        const row = h('div', { class: 'pd-strip-row' });
        (pdState.icons || []).forEach((f) => {
          const b = h('button', { class: 'pd-icon' + (current === f ? ' on' : ''), type: 'button',
            title: f + (current === f ? ' — current' : ''),
            onClick: () => { toGame('fdPreset', JSON.stringify({ op: 'img', preset: ui.assignFor, icon: f })); ui.assignFor = null; } });
          b.style.backgroundImage = 'url("preset-icons/' + cssEsc(encodeURIComponent(f)) + '")';
          row.append(b);
        });
        row.append(h('button', { class: 'pd-icon is-none', type: 'button', title: 'No image — back to the letter tile',
          onClick: () => { toGame('fdPreset', JSON.stringify({ op: 'img', preset: ui.assignFor, icon: '' })); ui.assignFor = null; } }, '✕'));
        strip.append(row);
        if (!(pdState.icons || []).length)
          strip.append(h('div', { class: 'pd-empty' },
            'No image files yet — take a picture of your character wearing a preset (F12, or the Followers ◉ Portrait on yourself), then drop the PNG into PrismaUI/views/HotkeyDeck/preset-icons/.'));
        return;
      }
      // Category picker (Categorize mode) — file the picked preset.
      if (ui.mode === 'cat' && ui.catFor) {
        const cur = catOf(ui.catFor);
        strip.append(h('div', { class: 'pd-strip-head' }, 'File “' + ui.catFor + '” into:'));
        const row = h('div', { class: 'fc-catfilter' });
        catList().forEach((c) => {
          row.append(h('button', { class: 'fc-set fc-catchip' + (cur === c ? ' on' : ''), type: 'button',
            onClick: () => { setCat(ui.catFor, c); ui.catFor = null; } }, c));
        });
        row.append(h('button', { class: 'fc-set fc-catchip' + (!cur ? ' on' : ''), type: 'button',
          title: 'Remove from any category',
          onClick: () => { setCat(ui.catFor, ''); ui.catFor = null; } }, 'Uncategorized'));
        strip.append(row);
        if (!catList().length)
          strip.append(h('div', { class: 'pd-empty' }, 'No categories yet — make one with ＋ New category above.'));
        return;
      }
    }

    search.addEventListener('input', () => { ui.filter = search.value; ui.sel = 0; paintGrid(); });
    search.addEventListener('keydown', (e) => {
      const flat = flatList();
      const cols = Math.max(1, Math.floor(grid.clientWidth / 98) || 1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        ui.sel = Math.min(Math.max(0, selIdx() + (e.key === 'ArrowDown' ? cols : -cols)), Math.max(0, flat.length - 1));
        paintGrid();
      } else if (e.key === 'Enter') { if (flat.length) fire(flat[selIdx()]); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (ui.assignFor) { ui.assignFor = null; paintStrip(); paintGrid(); }
        else if (ui.catFor) { ui.catFor = null; paintStrip(); paintGrid(); }
        else if (ui.mode) { ui.mode = ''; render(); }
      }
      e.stopPropagation();
    });

    paintGrid();
    paintStrip();
    return body;
  }

  /* ---- bridge receivers (this pane OWNS them) ---- */

  window.fdPresetData = function (env) {
    pdState = (env && typeof env === 'object') ? env : null;
    if (isActive()) render();
  };

  window.fdPresetResult = function (env) {
    pdBusy = false;
    let ok = !!(env && env.ok !== false && !env.error);
    let msg;
    if (!env) { ok = false; msg = 'Preset Director gave no answer'; }
    else if (env.error) msg = env.error;
    else if (env.apply) {
      msg = 'Summoned ' + (env.name || 'her');
      if (env.apply.ok) msg += ' wearing “' + (env.apply.preset || '') + '”';
      else { ok = false; msg += ' — but the preset failed: ' + (env.apply.error || 'refused'); }
    } else if (env.saved || env.preset === BACKUP_PRESET) { msg = 'Your face is backed up — try presets freely'; }
    else if (env.ok) msg = 'Preset “' + (env.preset || '') + '” applied' + (env.name ? ' to ' + env.name : '');
    else msg = 'Refused';
    fqStatus = { msg, ok, pending: false };
    requestIndex();   // registry changed
    if (isActive()) render();
  };

  /* ---- host contract ---- */
  return {
    aimAt,
    init() { /* nothing to bind until shown */ },
    onShow() {
      host = document.getElementById('faces-host');
      if (!pdState) requestIndex();
      render();
    },
    onHide() { /* keep state; nothing live to stop */ },
    toggleEdit() { /* the shared size card is the only edit chrome */ },
    wantsPause() { return true; },
    // test seams
    _state: () => ({ pdState, target, ui, pdBusy, backedUp }),
    _render: render,
    _setHost: (el) => { host = el; },
    _aimAt: aimAt,
  };
})();
