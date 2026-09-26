/* Arcane Library: organization chrome. Cast/equip and pointer gestures remain app.js verbs. */
(function () {
  'use strict';
  var M = window.SpellLibrary, railQuery = '', chipQuery = '', modal = null, previousFocus = null;
  var collapsed = Object.create(null), railInDialog = false, fitPending = false, details = null;
  var parked = [], categoryPickerOpen = false;
  var kinds = { all: 'All types', spell: 'Spells', power: 'Powers', shout: 'Shouts', unknown: 'Unclassified' };
  var modes = { all: 'Any action', equip: 'Equip', cast: 'Cast now' };
  function btn(label, action, cls) { return h('button', { type: 'button', class: cls || 'ml-button', onClick: action }, label); }
  function art(file, size) { size = size || 28; return h('img', { src: 'icons/custom/' + file + '.png', width: size, height: size, alt: '', draggable: 'false' }); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  var SMART = [['All spells', 'all', 'cat-scholars'], ['Spells', 'spell', 'cat-mages'], ['Powers', 'power', 'hk-faith-boon'], ['Shouts', 'shout', 'sc-shouts']];
  function title(text) { return h('div', { class: 'ml-rail-heading' }, text); }
  function choose(cat, kind, mode) {
    ui.cat = cat; ui.kind = kind || 'all'; ui.mode = mode || 'all'; ui.sel = -1;
    ui.armDelCat = null; ui.armBookCat = null; if (railInDialog || categoryPickerOpen) closeModal(); render(); $('list').scrollTop = 0;
  }
  function rail() {
    var host = $('rail-list'); if (!host) return;
    host.textContent = '';
    host.append(title('LIBRARY'));
    var smart = h('div', { class: 'ml-smart-grid' });
    [['All spells', 'all', 'all', 'cat-scholars'], ['Spells', 'spell', 'all', 'cat-mages'],
      ['Powers', 'power', 'all', 'hk-faith-boon'], ['Shouts', 'shout', 'all', 'sc-shouts'],
      ['Equip', 'all', 'equip', 'hk-grip-switch'], ['Cast now', 'all', 'cast', 'hk-faith-boon']].forEach(function (spec) {
      var filter = { cat: ALL, kind: spec[1], mode: spec[2], filter: '' };
      var count = M.visible(state.spells, state.library, filter, metaFor).length;
      var selected = ui.cat === ALL && (ui.kind || 'all') === spec[1] && (ui.mode || 'all') === spec[2];
      var b = btn('', function () { choose(ALL, spec[1], spec[2]); }, 'rail-item ml-smart' + (selected ? ' sel' : ''));
      b.setAttribute('aria-pressed', String(selected));
      b.append(art(spec[3]), h('span', { class: 'rail-name' }, spec[0]), h('span', { class: 'rail-count' }, count));
      smart.append(b);
    });
    host.append(smart);
    var packages = btn('', function () { MagicPackageUI.browse(); }, 'rail-item ml-packages-link');
    packages.append(art('cat-mages'), h('span', { class: 'rail-name' }, 'Spell packages'), h('span', { class: 'rail-count' }, state.combos.length));
    host.append(packages);
    host.append(h('div', { class: 'ml-category-head' }, title('MY CATEGORIES'),
      h('button', { class: 'ml-add-category', 'aria-label': 'New category', onClick: function () { categoryDialog(); } }, '+')));
    var q = railQuery.trim().toLowerCase();
    var rows = M.tree(state.categories, state.library.parents);
    rows.forEach(function (r) {
      var cat = r.name, parent = state.library.parents[cat], hidden = false;
      while (parent) { if (collapsed[parent]) hidden = true; parent = state.library.parents[parent]; }
      if (!q && hidden) return;
      if (q && M.path(cat, state.library.parents).toLowerCase().indexOf(q) < 0) return;
      var children = state.categories.some(function (c) { return state.library.parents[c] === cat; });
      var row = h('div', { class: 'ml-cat-row rail-item' + (ui.cat === cat ? ' sel' : ''), data: { cat: cat, depth: r.depth },
        style: 'padding-left:' + (8 + Math.min(r.depth, 6) * 18) + 'px;' });
      var fold = btn(children ? (collapsed[cat] ? '›' : '⌄') : '', function () { collapsed[cat] = !collapsed[cat]; rail(); }, 'ml-fold');
      fold.disabled = !children; fold.setAttribute('aria-label', (collapsed[cat] ? 'Expand ' : 'Collapse ') + cat);
      if (children) fold.setAttribute('aria-expanded', String(!collapsed[cat]));
      var select = btn('', function () { choose(cat, ui.kind, ui.mode); }, 'ml-cat-select');
      select.setAttribute('aria-pressed', String(ui.cat === cat)); select.title = M.path(cat, state.library.parents);
      if (state.catIcons[cat]) select.append(h('img', { src: state.catIcons[cat], width: 28, height: 28, alt: '' }));
      else select.append(art('cat-scholars'));
      select.append(h('span', { class: 'rail-name' }, cat), h('span', { class: 'rail-count' },
        state.spells.filter(function (s) { return M.inside(s.category, cat, state.library.parents); }).length));
      var edit = btn('Edit', function () { categoryDialog(cat); }, 'ml-cat-edit');
      edit.setAttribute('aria-label', 'Edit category ' + cat);
      row.append(fold, select, edit); host.append(row);
    });
    if (q && !host.querySelector('.ml-cat-row')) host.append(h('p', { class: 'ml-rail-note' }, 'No matching categories.'));
    chips();
  }
  /* The same category tree serves the rail and a searchable popout. Header
     width stays constant as categories grow; selecting one uses choose(). */
  function chips() {
    var host = $('cs-chips'); if (!host) return;
    host.textContent = '';
    var q = chipQuery.trim().toLowerCase(), lib = state.library;
    function chip(label, icon, count, selected, action, cls) {
      var b = btn('', action, 'cs-chip' + (cls ? ' ' + cls : '') + (selected ? ' sel' : ''));
      b.setAttribute('aria-pressed', String(selected)); b.title = label;
      if (icon) b.append(icon);
      b.append(h('span', { class: 'cs-name' }, label), h('span', { class: 'cs-count' }, String(count)));
      return b;
    }
    function smartChip(spec) {
      if (q && spec[0].toLowerCase().indexOf(q) < 0) return;
      var count = M.visible(state.spells, lib, { cat: ALL, kind: spec[1], mode: 'all', filter: '' }, metaFor).length;
      var selected = ui.cat === ALL && (ui.kind || 'all') === spec[1];
      host.append(chip(spec[0], art(spec[2], 24), count, selected, function () { choose(ALL, spec[1], ui.mode); }, 'cs-smart'));
    }
    smartChip(SMART[0]);                                   // All spells leads: the way back to everything
    M.tree(state.categories, lib.parents).forEach(function (r) {
      var cat = r.name, label = M.path(cat, lib.parents);
      if (q && label.toLowerCase().indexOf(q) < 0) return;
      var count = state.spells.filter(function (s) { return M.inside(s.category, cat, lib.parents); }).length;
      var icon = state.catIcons[cat] ? h('img', { src: state.catIcons[cat], width: 24, height: 24, alt: '', draggable: 'false' }) : art('cat-scholars', 24);
      var b = chip(cat, icon, count, ui.cat === cat, function () { choose(cat, ui.kind, ui.mode); }, r.depth ? 'cs-child' : '');
      b.title = label; b.dataset.cat = cat;
      if (r.depth) b.querySelector('.cs-name').append(h('small', { class: 'cs-path' }, label));
      host.append(b);
    });
    var before = host.children.length;
    SMART.slice(1).forEach(smartChip);                     // the kind filters ride at the end, behind a divider
    if (host.children.length > before && before) host.insertBefore(h('span', { class: 'cs-divider', 'aria-hidden': 'true' }), host.children[before]);
    if (q && !host.querySelector('.cs-chip')) host.append(h('span', { class: 'cs-none' }, 'No matching categories.'));
  }
  function borrow(box, node) {
    var marker = document.createComment('popout home');
    node.parentNode.insertBefore(marker, node); parked.push({ node: node, marker: marker }); box.append(node);
  }
  function openCategories() {
    var box = openModal('Browse categories'); box.classList.add('ml-category-dialog');
    categoryPickerOpen = true; $('md-category-btn').setAttribute('aria-expanded', 'true');
    chipQuery = ''; $('cs-find').value = ''; chips();
    borrow(box, $('md-catstrip'));
    box.append(btn('Organize categories', function () { $('ml-browse').click(); }, 'ml-button ml-category-actions'));
    box.__onEscape = function () {
      if (!chipQuery) return false;
      chipQuery = ''; $('cs-find').value = ''; chips(); $('cs-find').focus(); return true;
    };
    $('cs-find').focus();
  }
  function openMore() {
    var box = openModal('Spell Deck options'); box.classList.add('ml-more-dialog');
    $('md-more-btn').setAttribute('aria-expanded', 'true'); borrow(box, $('md-more-controls'));
    $('md-pages').querySelector('[aria-selected=true]').focus();
  }
  /* ---- size: the pinned density, the Auto ladder, and the two controls that
     drive them (the bar select and the Cards stepper in the edit tools). ---- */
  function appliedDensity() { return state.library.sizeAuto ? (ui.densityApplied || 'balanced') : state.library.density; }
  function setCardSize(v) {
    if (v === 'auto') state.library.sizeAuto = true;
    else if (M.densities.indexOf(v) >= 0) { state.library.sizeAuto = false; state.library.density = v; }
    else return;
    saveSoon(); sync(); fit();
  }
  function syncSizeControls() {
    var lib = state.library, applied = appliedDensity();
    var sel = $('ml-density'); if (sel) sel.value = lib.sizeAuto ? 'auto' : lib.density;
    var val = $('card-size-val'); if (val) { val.textContent = (lib.sizeAuto ? 'Auto · ' : '') + cap(applied); val.classList.toggle('custom', !lib.sizeAuto); }
    var dn = $('card-size-down'), up = $('card-size-up'), au = $('card-size-auto');
    if (dn) dn.disabled = applied === 'dense';
    if (up) up.disabled = applied === 'spacious';
    if (au) au.disabled = !!lib.sizeAuto;
  }
  /* The ladder, measured for real: set data-density, read the list, tighten
     until scrollHeight fits clientHeight (the pinned rule for a resting page —
     it must fit the screen at whatever zoom he runs, so the page measures itself
     instead of trusting a breakpoint). Coalesced onto the next frame because
     renderList runs on every keystroke. */
  function fit() {
    if (fitPending) return; fitPending = true;
    var run = function () { fitPending = false; fitNow(); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run); else setTimeout(run, 0);
  }
  function fitNow() {
    var lib = state.library, panel = $('panel'), list = $('list');
    if (!panel || !list) return;
    list.style.removeProperty('grid-template-columns');   // measure with the sheet's auto-fill first
    if (!lib.sizeAuto) { panel.setAttribute('data-density', lib.density); ui.densityApplied = lib.density; syncSizeControls(); balance(list); return; }
    if (typeof isArtsPage === 'function' && isArtsPage()) return;
    if (!document.body.classList.contains('open') || list.classList.contains('hidden') || !list.clientHeight) return;
    var picked = M.fitDensity(function (d) {
      panel.setAttribute('data-density', d);
      return list.scrollHeight <= list.clientHeight + 1;
    }, 'spacious');
    panel.setAttribute('data-density', picked);
    ui.densityApplied = picked;
    syncSizeControls();
    balance(list);
  }
  /* No lone card on the last row when the same row count can be had with
     fewer, wider columns: 16 spells in 5 columns is 5·5·5·1, in 4 it is
     4·4·4·4 (the "four rows" Rober described). Never fewer rows, never
     narrower cards, so the height fit above still holds. */
  function balance(list) {
    if (state.library.layout === 'list' || $('panel').classList.contains('ml-phone')) return;
    var cards = Array.prototype.slice.call(list.querySelectorAll('.spell'));
    var n = cards.length; if (n < 2) return;
    var top = cards[0].offsetTop, cols = 0;
    while (cols < n && cards[cols].offsetTop === top) cols++;
    if (cols < 2) return;
    var rows = Math.ceil(n / cols), want = Math.ceil(n / rows);
    if (want < cols) list.style.gridTemplateColumns = 'repeat(' + want + ', minmax(0, 1fr))';
  }
  function sync() {
    var lib = state.library || M.normalize({}, state.categories);
    $('panel').setAttribute('data-layout', ui.editing && lib.layout === 'icons' ? 'columns' : lib.layout);
    $('panel').setAttribute('data-density', appliedDensity());
    $('panel').setAttribute('data-size-auto', lib.sizeAuto ? 'true' : 'false');
    /* Art size rides the density rules in library.css; the Icons stepper, when
       set, overrides it on the panel itself (an inline value beats the
       attribute rule, and :root is too far up to win). */
    if (state.iconPx > 0) $('panel').style.setProperty('--ml-art-size', curIconPx() + 'px');
    else $('panel').style.removeProperty('--ml-art-size');
    document.documentElement.style.removeProperty('--ml-art-size');
    var folded = lib.controlsCollapsed && !ui.editing;
    $('panel').classList.toggle('ml-rail-collapsed', lib.sidebarCollapsed);
    $('panel').classList.toggle('ml-controls-collapsed', folded);
    var railToggle = $('ml-toggle-rail'), controlToggle = $('ml-toggle-controls');
    railToggle.textContent = lib.sidebarCollapsed ? '›' : '‹';
    railToggle.setAttribute('aria-expanded', String(!lib.sidebarCollapsed));
    railToggle.title = lib.sidebarCollapsed ? 'Show categories' : 'Collapse categories';
    railToggle.setAttribute('aria-label', railToggle.title);
    controlToggle.setAttribute('aria-expanded', String(!folded));
    controlToggle.disabled = !!ui.editing;
    controlToggle.title = ui.editing ? 'Leave Edit to collapse filters' : folded ? 'Show heading, filters and size' : 'Collapse heading and filters';
    var active = (ui.kind && ui.kind !== 'all' ? 1 : 0) + (ui.mode && ui.mode !== 'all' ? 1 : 0) + (ui.cat !== ALL ? 1 : 0);
    $('ml-controls-label').textContent = 'Filters' + (active ? ' · ' + active : '');
    $('ml-compact-packages').textContent = 'Packages · ' + state.combos.length;
    // Move the SAME input, keeping its listeners and value. Search stays
    // typeable when the large header is folded; no duplicate hidden field.
    var searchHost = folded ? $('ml-compact-search') : $('toolbar');
    if ($('search-wrap').parentNode !== searchHost) {
      var focused = document.activeElement === $('search');
      searchHost.insertBefore($('search-wrap'), searchHost.firstChild);
      if (focused) $('search').focus();
    }
    syncSizeControls();
    document.querySelectorAll('[data-library-view]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.libraryView === lib.layout)); });
    $('ml-sort').value = lib.sort; $('ml-kind').value = ui.kind || 'all'; $('ml-mode').value = ui.mode || 'all';
    var name = ui.cat === ALL ? ((ui.kind && ui.kind !== 'all') ? kinds[ui.kind] : (ui.mode && ui.mode !== 'all') ? modes[ui.mode] : 'All spells') : ui.cat;
    var arts = typeof isArtsPage === 'function' && isArtsPage();
    $('md-category-btn').classList.toggle('hidden', arts);
    $('md-category-name').textContent = name;
    $('md-category-btn').title = 'Browse categories · ' + (ui.cat === ALL ? name : M.path(ui.cat, lib.parents));
    $('md-page-title').textContent = arts ? 'Combat Arts' : 'Spell Deck';
    $('ml-heading').textContent = name;
    $('ml-breadcrumb').textContent = ui.cat === ALL ? 'YOUR ARCANE LIBRARY' : M.path(ui.cat, lib.parents);
    var count = visibleSpells().length;
    $('ml-result-count').textContent = count + (count === 1 ? ' spell' : ' spells');
    $('ml-clear').classList.toggle('hidden', !ui.filter && (!ui.kind || ui.kind === 'all') && (!ui.mode || ui.mode === 'all'));
    $('add-cat-btn').classList.remove('hidden');
    // Measure pre-transform width; window media queries alone miss a manually resized panel.
    $('panel').classList.toggle('ml-narrow', $('panel').clientWidth < 920);
    $('panel').classList.toggle('ml-phone', $('panel').clientWidth < 580);
  }
  function closeModal() {
    if (!modal) return;
    details = null; categoryPickerOpen = false;
    parked.forEach(function (item) { item.marker.parentNode.replaceChild(item.node, item.marker); }); parked = [];
    $('md-category-btn').setAttribute('aria-expanded', 'false'); $('md-more-btn').setAttribute('aria-expanded', 'false');
    if (railInDialog) { $('body').insertBefore($('rail'), $('main')); railInDialog = false; }
    modal.remove(); modal = null;
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    else if ($('search')) $('search').focus();
    scheduleCardStats();
  }
  function openModal(label) {
    closeModal(); cancelDesc(); closeCtx(); previousFocus = document.activeElement;
    modal = h('div', { class: 'ml-backdrop' });
    var box = h('section', { class: 'ml-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
    box.append(h('div', { class: 'ml-dialog-head' }, h('h2', null, label), btn('Close', closeModal)));
    modal.append(box); $('overlay').append(modal);
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) closeModal(); });
    return box;
  }
  function spellDetails(spell) {
    var meta = metaFor(spell), box = openModal('Spell details');
    box.classList.add('ml-spell-dialog');
    var text = h('div', { class: 'ml-effect-text', 'aria-live': 'polite' });
    var retry = btn('Retry description', function () {
      descriptionData(hexId(meta.formId), null); ensureDesc(meta, true);
    });
    retry.hidden = true;
    var hero = h('div', { class: 'ml-detail-hero' }, iconEl(meta),
      h('div', { class: 'ml-detail-identity' }, h('h3', null, spell.name || 'Spell'),
        h('p', null, [M.kind(meta) === 'unknown' ? '' : cap(M.kind(meta)), meta.school && cap(meta.school), meta.tier && cap(meta.tier)].filter(Boolean).join(' · '))));
    var facts = h('dl', { class: 'ml-detail-facts' });
    function fact(label, value) { if (value) facts.append(h('div', null, h('dt', null, label), h('dd', null, value))); }
    var live = knownFor(spell), delivery = deliveryOf(spell);
    fact('Target', delivery && delivery !== 'other' ? cap(delivery) : '');
    var castingLabels = { fire: 'Single cast', concentration: 'Hold to cast', constant: 'Constant effect', scroll: 'Scroll' };
    fact('Casting', live && castingLabels[live.casting]);
    fact('Category', spell.category ? M.path(spell.category, state.library.parents) : 'Unfiled');
    fact('Source', meta.plugin);
    var stats = h('div', { class: 'ml-detail-stats', 'aria-label': 'Spell numbers' });
    var effects = h('section', { class: 'ml-detail-effect-list', 'aria-label': 'Base effect values' });
    var content = h('div', { class: 'ml-detail-scroll' }, hero, stats,
      h('section', { class: 'ml-detail-effects', 'aria-label': 'Spell effects' }, h('h3', null, 'What it does'), text, retry), effects, facts);
    var action = spell.mode === 'equip' ? (slotOf(spell) === 'voice' ? 'Equip voice slot' : 'Equip ' + (spell.hand === 'both' ? 'both hands' : (spell.hand || 'right') + ' hand')) : 'Cast spell';
    box.append(content, h('div', { class: 'ml-detail-actions' },
      btn('Organize spell', function () { openCtxMenu(spell, 0, 0, true); }),
      btn(action, function () { closeModal(); fireEntry(spell.id); }, 'ml-button ml-primary')));
    details = { key: hexId(meta.formId), text: text, retry: retry, box: box, stats: stats, effects: effects };
    descriptionData(details.key, meta.formId ? desc.cache.get(details.key) || null : { ok: false });
    if (meta.formId) ensureDesc(meta);
    else retry.hidden = true;
    box.querySelector('.ml-dialog-head button').focus();
  }
  function descriptionData(key, data) {
    if (!details || details.key !== key || !details.box.isConnected) return;
    details.stats.textContent = ''; details.effects.textContent = '';
    M.stats(data).forEach(function (s) { details.stats.append(h('div', { class: 'ml-detail-stat' }, h('span', null, s.label), h('strong', null, s.value), h('small', null, s.note))); });
    M.effectRows(data).forEach(function (e) { details.effects.append(h('div', { class: 'ml-detail-effect-row' }, h('strong', null, e.name), h('span', null, e.text))); });
    var text = details.text;
    text.textContent = '';
    text.setAttribute('aria-busy', String(!data));
    details.retry.hidden = !data || data.ok;
    if (!data) text.append(h('p', { class: 'ml-detail-muted' }, 'Reading spell effects…'));
    else if (!data.ok) text.append(h('p', { class: 'ml-detail-muted' }, data.timedout
      ? 'The game has not returned this description. Retry when it is ready.'
      : 'The game could not resolve this spell. Retry or reopen the Spell Deck to refresh it.'));
    else text.append(h('p', { class: data.text ? '' : 'ml-detail-muted' }, data.text || 'This spell has no visible effect description. Its effects may be handled by its mod.'));
  }
  function parentPicker(box, value, omit) {
    var selected = value || '', search = h('input', { type: 'search', placeholder: 'Find a parent category…', 'aria-label': 'Find a parent category', autocomplete: 'off' });
    var list = h('div', { class: 'ml-parent-list', role: 'group', 'aria-label': 'Parent category' });
    function draw() {
      list.textContent = '';
      [{ name: '', depth: 0 }].concat(M.tree(state.categories, state.library.parents)).forEach(function (r) {
        if (omit && M.inside(r.name, omit, state.library.parents)) return;
        var label = r.name ? M.path(r.name, state.library.parents) : 'Top level';
        if (label.toLowerCase().indexOf(search.value.toLowerCase()) < 0) return;
        var b = btn(label, function () { selected = r.name; draw(); }, 'ml-parent-choice');
        b.setAttribute('aria-pressed', String(selected === r.name)); list.append(b);
      });
    }
    search.addEventListener('input', draw); search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var first = list.querySelector('button'); if (first) first.click(); }
    });
    box.append(search, list); draw(); return function () { return selected; };
  }
  function categoryDialog(cat, initialParent) {
    var box = openModal(cat ? 'Edit category' : 'New category');
    var name = h('input', { type: 'text', value: cat || '', maxlength: '100', placeholder: 'For example, DragonKnight…', 'aria-label': 'Category name', autocomplete: 'off' });
    box.append(h('label', { class: 'ml-field-label' }, 'Category name', name), h('p', { class: 'ml-dialog-copy' }, 'Choose a parent to make a subcategory. Parent categories include every spell filed beneath them.'));
    var getParent = parentPicker(box, cat ? state.library.parents[cat] : initialParent, cat);
    var error = h('p', { class: 'ml-error', role: 'alert' }); box.append(error);
    function commit() {
      var nm = name.value.trim();
      if (!nm || nm === ALL || nm === '__proto__' || nm === 'constructor') { error.textContent = 'Give this category a name.'; name.focus(); return; }
      if (state.categories.some(function (c) { return c !== cat && c.toLowerCase() === nm.toLowerCase(); })) {
        error.textContent = 'That name is already used. Choose a different name.'; name.focus(); return;
      }
      var parent = getParent();
      if (cat) {
        var i = state.categories.indexOf(cat); if (i < 0) { closeModal(); return; }
        state.categories[i] = nm;
        state.spells.forEach(function (s) { if (s.category === cat) s.category = nm; });
        Object.keys(state.library.parents).forEach(function (c) { if (state.library.parents[c] === cat) state.library.parents[c] = nm; });
        if (state.catIcons[cat]) { state.catIcons[nm] = state.catIcons[cat]; if (nm !== cat) delete state.catIcons[cat]; }
        delete state.library.parents[cat];
      } else state.categories.push(nm);
      if (parent) state.library.parents[nm] = parent;
      delete collapsed[parent]; ui.cat = nm; ui.sel = -1; saveSoon(); closeModal(); render();
      toast(cat ? 'Category updated' : 'Category created — drag spells into it');
    }
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    var actions = h('div', { class: 'ml-dialog-actions' }, btn(cat ? 'Save category' : 'Create category', commit, 'ml-button ml-primary'));
    if (cat) {
      ['up', 'down'].forEach(function (direction) { actions.append(btn('Move ' + direction, function () {
        var siblings = state.categories.filter(function (c) { return (state.library.parents[c] || '') === (state.library.parents[cat] || ''); });
        var index = siblings.indexOf(cat), other = siblings[index + (direction === 'up' ? -1 : 1)];
        if (!other) return;
        moveInArray(state.categories, state.categories.indexOf(cat), state.categories.indexOf(other) + (direction === 'down' ? 1 : 0));
        saveSoon(); renderRail(); toast('Category moved ' + direction);
      })); });
      actions.append(btn('Add subcategory', function () { categoryDialog(null, cat); }));
      actions.append(btn('Change icon', function () { closeModal(); openCatIconPicker(cat); }));
      var armed = false;
      actions.append(btn('Remove category', function (e) {
        if (!armed) { armed = true; e.currentTarget.textContent = 'Confirm removal'; error.textContent = 'Spells and subcategories will move to the parent, or to Unfiled. No spell is deleted.'; return; }
        var dest = state.library.parents[cat] || 'Unfiled';
        if (dest === cat) dest = 'Recovered spells';
        if (state.categories.indexOf(dest) < 0) state.categories.push(dest);
        state.spells.forEach(function (s) { if (s.category === cat) s.category = dest; });
        Object.keys(state.library.parents).forEach(function (c) {
          if (state.library.parents[c] === cat) { if (state.library.parents[cat]) state.library.parents[c] = dest; else delete state.library.parents[c]; }
        });
        state.categories = state.categories.filter(function (c) { return c !== cat; });
        delete state.library.parents[cat]; delete state.catIcons[cat]; ui.cat = dest;
        saveSoon(); closeModal(); render(); toast('Category removed; spells kept');
      }, 'ml-button danger'));
    }
    box.append(actions); name.focus(); if (cat) name.select();
  }
  function moveDialog(spell) {
    var box = openModal('Move ' + spell.name);
    box.append(h('p', { class: 'ml-dialog-copy' }, 'Choose where this spell belongs. Its action and icon stay the same.'));
    var getParent = parentPicker(box, spell.category);
    box.append(btn('Move spell', function () {
      var cat = getParent(); if (!cat) { toast('Choose a category'); return; }
      setCategory(spell, cat); closeModal(); toast('Moved to ' + cat);
    }, 'ml-button ml-primary'));
    box.querySelector('input').focus();
  }
  function onKey(e) {
    if (!modal) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      var box = modal.querySelector('.ml-dialog');
      if (box && typeof box.__onEscape === 'function' && box.__onEscape(e)) return true;
      closeModal();
    }
    if (e.key === 'Tab') {
      var nodes = modal.querySelectorAll('button:not([disabled]), input, select');
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return true;
  }
  function init() {
    $('ml-toggle-rail').addEventListener('click', function () { state.library.sidebarCollapsed = !state.library.sidebarCollapsed; saveSoon(); sync(); chips(); fit(); });
    $('ml-toggle-controls').addEventListener('click', function () { state.library.controlsCollapsed = !state.library.controlsCollapsed; saveSoon(); sync(); });
    $('ml-compact-packages').addEventListener('click', function () { MagicPackageUI.browse(); });
    $('ml-density').addEventListener('change', function (e) { setCardSize(e.target.value); });
    var csd = $('card-size-down'), csu = $('card-size-up'), csa = $('card-size-auto');
    if (csd) csd.addEventListener('click', function () { setCardSize(M.stepDensity(appliedDensity(), +1)); });
    if (csu) csu.addEventListener('click', function () { setCardSize(M.stepDensity(appliedDensity(), -1)); });
    if (csa) csa.addEventListener('click', function () { setCardSize('auto'); });
    var find = $('cs-find');
    if (find) {
      find.addEventListener('input', function (e) { chipQuery = e.target.value; chips(); });
      find.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); var first = $('cs-chips').querySelector('.cs-chip'); if (first) first.click(); }
      });
    }
    $('md-category-btn').addEventListener('click', openCategories);
    $('md-more-btn').addEventListener('click', openMore);
    var rb = $('removed-btn');
    if (rb) rb.addEventListener('click', function () { if (typeof openRemoved === 'function') openRemoved(); });
    $('ml-browse').addEventListener('click', function () { var box = openModal('Browse library'); railInDialog = true; box.append($('rail')); $('ml-category-search').focus(); });
    $('ml-category-search').addEventListener('input', function (e) { railQuery = e.target.value; rail(); });
    $('ml-category-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') { var b = $('rail-list').querySelector('.ml-cat-select'); if (b) b.click(); } });
    document.querySelectorAll('[data-library-view]').forEach(function (b) {
      b.addEventListener('click', function () { state.library.layout = b.dataset.libraryView; saveSoon(); renderList(); sync(); });
    });
    [['ml-kind', 'kind'], ['ml-mode', 'mode']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function (e) { ui[pair[1]] = e.target.value; ui.sel = -1; render(); });
    });
    $('ml-sort').addEventListener('change', function (e) { state.library.sort = e.target.value; ui.sel = -1; saveSoon(); renderList(); });
    $('ml-clear').addEventListener('click', function () { ui.filter = ''; $('search').value = ''; choose(ui.cat); });
    var onResize = function () { sync(); fit(); };
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) new ResizeObserver(onResize).observe($('panel'));
  }
  window.MagicLibraryUI = { init: init, rail: rail, chips: chips, sync: sync, fit: fit, fitNow: fitNow, setCardSize: setCardSize,
    openCategories: openCategories, openMore: openMore, categoryDialog: categoryDialog, moveDialog: moveDialog, onKey: onKey, close: closeModal, openModal: openModal,
    spellDetails: spellDetails, descriptionData: descriptionData, isOpen: function () { return !!modal; } };
})();
