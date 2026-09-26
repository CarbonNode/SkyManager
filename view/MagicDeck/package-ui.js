/* Spell packages are the existing mdCastCombo / CastSequence verb, with a visual builder.
   Member snapshots and native serialization stay unchanged. No equipment actions here. */
(function () {
  'use strict';
  function button(text, fn, cls) { return h('button', { type: 'button', class: cls || 'ml-button', onClick: fn }, text); }
  function montage(c) { return h('div', { class: 'mp-montage', 'aria-hidden': 'true' }, c.spells.slice(0, 4).map(function (s) { return iconEl(s); })); }
  function school(s) { return s.school || (s.type === 'shout' ? 'Shout' : s.type === 'power' || s.type === 'lesser' ? 'Power' : 'Spell'); }
  function cast(c) {
    if (ui.editing) { toast('Finish Edit mode to cast a package'); return; }
    MagicLibraryUI.close(); castCombo(c);
  }
  function card(c, i) {
    var el = h('div', { class: 'combo-card mp-card', data: { cid: c.id },
      onContextmenu: function (e) { e.preventDefault(); edit(c); },
      onMousedown: function (e) { pdArm(e, { kind: 'combo', cid: c.id, comboIdx: i }); } });
    var detail = button('', function () { inspect(c); }, 'mp-card-detail');
    detail.setAttribute('aria-label', 'Open package ' + comboName(c));
    detail.append(montage(c), h('span', { class: 'mp-card-copy' },
      h('span', { class: 'mp-eyebrow' }, c.spells.length + ' SPELLS / ONE CAST'),
      h('strong', { class: 'mp-card-name' }, comboName(c)),
      h('span', { class: 'mp-card-members' }, c.spells.map(function (s) { return s.name || 'Spell'; }).join(' · '))));
    el.append(detail, button('Cast all', function () { cast(c); }, 'ml-button mp-cast'));
    return el;
  }
  function stripHeading() {
    return h('div', { class: 'mp-strip-heading' }, h('span', null, 'SPELL PACKAGES'),
      button('View all / Create', browse, 'mp-text-button'));
  }
  function inspect(c) {
    var box = MagicLibraryUI.openModal('Spell package'); box.classList.add('mp-dialog', 'mp-inspector');
    var art = montage(c); art.classList.add('mp-folio-art');
    var sequence = h('div', { class: 'mp-sequence', role: 'list', 'aria-label': 'Spells in cast order' });
    c.spells.forEach(function (s, i) {
      sequence.append(h('div', { class: 'mp-sequence-spell', role: 'listitem', data: { school: school(s).toLowerCase() } },
        h('span', { class: 'mp-sequence-number' }, String(i + 1).padStart(2, '0')),
        iconEl(s), h('strong', null, s.name || 'Spell'), h('span', { class: 'mp-sequence-school' }, school(s))));
    });
    var fire = button('Cast all ' + c.spells.length + ' spells', function () { cast(c); }, 'ml-button ml-primary');
    fire.disabled = ui.editing;
    box.append(h('div', { class: 'mp-inspect-hero' }, art, h('div', { class: 'mp-inspect-intro' },
      h('p', { class: 'mp-eyebrow' }, 'YOUR SPELL COMBINATION'), h('h3', null, comboName(c)),
      h('div', { class: 'mp-facts' }, h('span', null, c.spells.length + ' spells'), h('span', null, 'One trigger'), h('span', null, 'Direct cast')))),
      h('div', { class: 'mp-sequence-heading' }, h('h3', null, 'Inside this package'), h('span', null, 'Casts in the order shown')),
      sequence,
      h('div', { class: 'mp-footer' }, h('p', { class: 'mp-cast-note' }, ui.editing ? 'Finish Edit mode to cast this package.' : 'Every spell fires in sequence, 150 ms apart.'),
        h('div', { class: 'ml-dialog-actions' }, button('Edit package', function () { edit(c); }), fire)));
    box.querySelector('.ml-dialog-head button').focus();
  }
  function browse(seed) {
    var box = MagicLibraryUI.openModal('Spell packages'); box.classList.add('mp-dialog');
    box.append(h('p', { class: 'ml-dialog-copy' }, 'Your combinations, ready in one action. Open a package to inspect every spell and its cast order.'));
    var search = h('input', { type: 'search', placeholder: 'Search packages or the spells inside…', 'aria-label': 'Search spell packages' });
    var list = h('div', { class: 'mp-package-list' });
    function draw() {
      list.textContent = '';
      var q = search.value.toLowerCase().trim();
      state.combos.filter(function (c) { return (comboName(c) + ' ' + c.spells.map(function (s) { return s.name; }).join(' ')).toLowerCase().indexOf(q) >= 0; })
        .forEach(function (c) { list.append(card(c, state.combos.indexOf(c))); });
      if (!list.children.length) list.append(h('p', { class: 'ml-dialog-copy' }, q ? 'No matching packages.' : 'Build your first combination, or drag one spell onto another in the library.'));
    }
    search.addEventListener('input', draw);
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var first = list.querySelector('.mp-card-detail'); if (first) first.click(); } });
    box.append(h('div', { class: 'mp-browse-tools' }, search, button('+ Create package', function () { edit(null, seed); }, 'ml-button ml-primary')), list);
    draw(); search.focus();
  }
  function edit(original, seed) {
    var draft = { id: original ? original.id : newComboId(), name: original ? original.name : '',
      spells: original ? original.spells.map(function (s) { return Object.assign({}, s); }) : seed ? [comboMemberFrom(seed)] : [] };
    var box = MagicLibraryUI.openModal(original ? 'Spell package' : 'Create spell package'); box.classList.add('mp-dialog');
    var name = h('input', { type: 'text', value: draft.name, maxlength: '120', placeholder: 'Name your combination…', 'aria-label': 'Package name' });
    var visual = h('div', { class: 'mp-hero' });
    var members = h('div', { class: 'mp-members' });
    var search = h('input', { type: 'search', placeholder: 'Search your library to add spells…', 'aria-label': 'Add spells to package' });
    var choices = h('div', { class: 'mp-choices' });
    var error = h('p', { class: 'ml-error', role: 'alert' });
    var count = h('span', { class: 'mp-count' });
    var hint = h('p', { class: 'ml-dialog-copy' }, 'Build your cast sequence. Each spell fires 150 ms after the last, regardless of its Equip setting.');
    function drawChoices() {
      choices.textContent = '';
      var q = search.value.toLowerCase().trim(), seen = Object.create(null);
      state.spells.filter(function (s) {
        if (draft.spells.some(function (m) { return sameSpell(m, s); })) return false;
        var key = (s.plugin || '').toLowerCase() + ':' + (s.localId || s.formId); if (seen[key]) return false; seen[key] = true;
        return (s.name + ' ' + SpellLibrary.path(s.category, state.library.parents)).toLowerCase().indexOf(q) >= 0;
      }).forEach(function (s) {
        var b = button('', function () {
          if (draft.spells.length >= COMBO_MAX) { error.textContent = 'A package holds up to ' + COMBO_MAX + ' spells.'; return; }
          draft.spells.push(comboMemberFrom(s)); error.textContent = ''; draw(); search.focus();
        }, 'mp-choice');
        b.setAttribute('aria-label', 'Add ' + s.name);
        b.append(iconEl(metaFor(s)), h('span', null, h('strong', null, s.name), h('small', null, SpellLibrary.path(s.category, state.library.parents))), h('span', { class: 'mp-plus' }, '+'));
        choices.append(b);
      });
      if (!choices.children.length) choices.append(h('p', { class: 'ml-dialog-copy' }, 'No more matching spells. Add spells to your library from the spellbook first.'));
    }
    function draw() {
      visual.textContent = ''; visual.append(montage(draft), h('div', null, h('span', { class: 'mp-eyebrow' }, 'CAST PACKAGE'),
        h('h3', null, name.value.trim() || (draft.spells.length ? comboName(draft) : 'Your next combination')),
        h('p', null, draft.spells.length + ' of ' + COMBO_MAX + ' spells · one trigger')));
      count.textContent = 'CAST ORDER · ' + draft.spells.length;
      members.textContent = '';
      draft.spells.forEach(function (s, i) {
        function move(offset) { moveInArray(draft.spells, i, i + offset); draw(); }
        var up = button('↑', function () { move(-1); }, 'mp-order-button'); up.disabled = i === 0; up.setAttribute('aria-label', 'Cast ' + s.name + ' earlier');
        // moveInArray removes before inserting; moving downward needs the next gap.
        var down = button('↓', function () { move(2); }, 'mp-order-button'); down.disabled = i === draft.spells.length - 1; down.setAttribute('aria-label', 'Cast ' + s.name + ' later');
        var remove = button('Remove', function () { draft.spells.splice(i, 1); draw(); }, 'mp-remove'); remove.setAttribute('aria-label', 'Remove ' + s.name + ' from package');
        members.append(h('div', { class: 'mp-member' }, h('span', { class: 'mp-order' }, String(i + 1).padStart(2, '0')), iconEl(s),
          h('span', { class: 'mp-member-name' }, h('strong', null, s.name || 'Spell'), h('small', null, s.school || (s.type === 'shout' ? 'Shout' : 'Direct cast'))),
          h('div', { class: 'mp-member-actions' }, up, down, remove)));
      });
      if (!draft.spells.length) members.append(h('p', { class: 'ml-dialog-copy' }, 'Choose spells from the library to build your package.'));
      drawChoices();
    }
    function save() {
      if (draft.spells.length < (original ? 1 : 2)) { error.textContent = original ? 'Keep at least one spell, or delete the package.' : 'Choose at least two spells for a combination.'; return false; }
      draft.name = name.value.trim();
      if (original) { original.name = draft.name; original.spells = draft.spells.slice(); }
      else { state.combos.push(draft); original = draft; }
      saveSoon(); renderCombos(); MagicLibraryUI.rail(); return true;
    }
    name.addEventListener('input', function () { draft.name = name.value; draw(); });
    search.addEventListener('input', drawChoices);
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var b = choices.querySelector('button'); if (b) b.click(); } });
    var castButton = button('Cast all', function () { if (save()) cast(original); }, 'ml-button ml-primary');
    castButton.disabled = ui.editing; castButton.title = ui.editing ? 'Finish Edit mode to cast' : 'Cast every member directly';
    var actions = h('div', { class: 'ml-dialog-actions mp-footer' }, button('Save package', function () { if (save()) { MagicLibraryUI.close(); toast('Package saved'); } }), castButton);
    if (original) {
      var armed = false, del = button('Delete package', function () {
        if (!armed) { armed = true; del.textContent = 'Confirm delete'; return; }
        state.combos = state.combos.filter(function (c) { return c !== original; }); saveSoon(); renderCombos(); MagicLibraryUI.rail(); browse();
      }, 'ml-button danger'); actions.append(del);
    }
    box.append(visual, h('label', { class: 'ml-field-label' }, 'Package name', name), hint,
      h('div', { class: 'mp-builder' }, h('section', null, count, members), h('section', null, h('div', { class: 'mp-count' }, 'ADD FROM YOUR LIBRARY'), search, choices)), error, actions);
    draw(); name.focus();
  }
  window.MagicPackageUI = { card: card, stripHeading: stripHeading, browse: browse, edit: edit, inspect: inspect };
})();
