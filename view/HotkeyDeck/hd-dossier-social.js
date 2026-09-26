/* Gilded dossier: shared family graph, household and an evidence-only timeline.
 * Backend owns identities and validation. This module never issues gameplay verbs.
 * mount(host, options) -> { update(data), destroy(), hasModal(), onKey(event) }
 * request({op,...}) resolves {ok,msg,data,personId}; data is the full sidecar snapshot.
 */
(function (g) {
  'use strict';
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function append(n, children) { children.forEach(function (c) { if (c) n.appendChild(c); }); return n; }
  function button(text, fn, cls) { var b = el('button', cls || 'dso-button', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function input(label, placeholder, type) { var n = el('input', 'dso-input'); n.type = type || 'text'; n.name = label.toLowerCase().replace(/\W+/g, '-'); n.setAttribute('aria-label', label); n.setAttribute('autocomplete', 'off'); n.placeholder = placeholder || ''; return n; }
  function field(label, control) { return append(el('label', 'dso-field'), [el('span', '', label), control]); }
  function lower(s) { return String(s || '').toLowerCase(); }
  function cleanData(d) { return { people: d && Array.isArray(d.people) ? d.people : [], relations: d && Array.isArray(d.relations) ? d.relations : [], history: d && Array.isArray(d.history) ? d.history : [] }; }
  function actorKey(p) { var a = p && p.actor; if (!a) return ''; var f = typeof a.formId === 'number' ? a.formId : parseInt(String(a.formId), 16); return lower(a.plugin) + ':' + (isNaN(f) ? lower(a.formId) : f.toString(16)); }
  function safeImage(s) { return typeof s === 'string' && !/^(?:javascript|data|file):/i.test(s) ? s : ''; }
  function picture(file, alt, cls) { var img = el('img', cls || 'dso-face'); img.src = safeImage(file); img.alt = alt; img.width = cls === 'dso-home-image' ? 720 : 64; img.height = cls === 'dso-home-image' ? 320 : 64; img.loading = 'lazy'; img.addEventListener('error', function () { img.hidden = true; }); return img; }
  function title(label, description) { return append(el('header', 'dso-heading'), [el('h2', '', label), description ? el('p', 'dso-muted', description) : null]); }
  function identity(p) { return p && (p.personId || p.id) || ''; }
  function connections(data, id) {
    var result = { parents: [], partners: [], children: [] };
    data.relations.forEach(function (r) {
      if (r.from !== id && r.to !== id) return;
      var parent = r.kind === 'parent' || r.kind === 'adoptive-parent';
      var other = data.people.find(function (p) { return p.id === (r.from === id ? r.to : r.from); });
      if (!other) return;
      var group = parent ? (r.from === id ? 'children' : 'parents') : 'partners';
      var label = r.kind === 'adoptive-parent' ? (group === 'children' ? 'Adopted child' : 'Adoptive parent') : parent ? (group === 'children' ? 'Child' : 'Parent') : ({ spouse: 'Spouse', partner: 'Partner', 'ex-partner': 'Former partner' }[r.kind] || r.kind);
      result[group].push({ person: other, relation: r, label: label });
    });
    Object.keys(result).forEach(function (k) { result[k].sort(function (a, b) { return a.person.name.localeCompare(b.person.name); }); });
    return result;
  }
  function mount(host, opts) {
    var o = opts || {}, data = cleanData(o.store && (o.store.data || o.store)), subject = o.subject || { name: 'Person' };
    var treeModule = null, focus = null, dead = false, modal = null, modalReturn = null, busy = false, search = '', historyType = '', pageNumber = 0, noteDraft = '';
    var page = o.page || 'household';
    host.classList.add('dso-host');
    function personOf(p) { var id = identity(p), ak = actorKey(p); return data.people.find(function (x) { return id && x.id === id || ak && actorKey(x) === ak; }); }
    function current() { return focus || personOf(subject) || subject; }
    function message(text, bad, parent) { var n = el('p', bad ? 'dso-message dso-error' : 'dso-message', text); n.setAttribute('role', bad ? 'alert' : 'status'); n.setAttribute('aria-live', 'polite'); (parent || host).appendChild(n); return n; }
    async function request(q) {
      if (typeof o.request !== 'function') throw new Error('The dossier connection is unavailable. Reopen the page to try again.');
      var r = await o.request(q);
      if (!r || !r.ok) throw new Error(r && r.msg || 'The change could not be saved. Try again.');
      if (r.data) data = cleanData(r.data);
      return r;
    }
    async function ensure(p) {
      var existing = personOf(p); if (existing) return existing.id;
      var q = { op: 'ensure', name: p.name || 'Unnamed person' };
      if (p.actor) q.actor = p.actor;
      else if (p.formId) q.actor = { formId: p.formId, plugin: p.plugin || '' };
      else if (!p.manual) throw new Error('This NPC has no stable identity yet. Locate them in the game and reopen their page.');
      var reply = await request(q), id = reply.personId || identity(personOf(p));
      if (id) { p.personId = id; p.id = id; }
      return id;
    }
    function closeModal() {
      if (!modal) return;
      document.removeEventListener('keydown', modalKey, true);
      modal.remove(); modal = null; busy = false;
      if (modalReturn && modalReturn.focus) modalReturn.focus();
      modalReturn = null;
    }
    function modalKey(e) {
      if (!modal) return;
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (!busy) closeModal(); return; }
      if (e.key === 'Tab') {
        var all = Array.prototype.slice.call(modal.querySelectorAll('button,input,select,textarea,[tabindex]')).filter(function (n) { return !n.disabled && !n.hidden; });
        if (!all.length) { e.preventDefault(); return; }
        var at = all.indexOf(document.activeElement);
        if (e.shiftKey && at <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
        else if (!e.shiftKey && (at < 0 || at === all.length - 1)) { e.preventDefault(); all[0].focus(); }
      }
    }
    function openModal(name, subtitle) {
      closeModal(); modalReturn = document.activeElement;
      modal = el('div', 'dso-backdrop'); var box = el('section', 'dso-modal'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', name);
      append(box, [append(el('div', 'dso-modal-head'), [title(name, subtitle), button('Close', function () { if (!busy) closeModal(); })])]);
      modal.addEventListener('keydown', function (e) { e.stopPropagation(); });
      modal.appendChild(box); document.body.appendChild(modal); document.addEventListener('keydown', modalKey, true);
      return box;
    }
    function mutateButton(label, box, operation) {
      var b = button(label, async function () {
        if (busy) return; busy = true;
        var controls = Array.prototype.slice.call(box.querySelectorAll('button,input,select,textarea')).map(function (n) { var prev = n.disabled; n.disabled = true; return { node: n, disabled: prev }; });
        b.textContent = 'Saving…';
        var old = box.querySelector('.dso-error'); if (old) old.remove();
        try { await operation(); if (dead) return; closeModal(); render(); }
        catch (err) { if (dead) return; busy = false; controls.forEach(function (c) { c.node.disabled = c.disabled; }); b.textContent = label; message(err.message, true, box); }
      }, 'dso-button dso-primary'); return b;
    }
    function navigate(p) {
      if (typeof o.onFocusPerson === 'function') o.onFocusPerson(p);
      var opened = false;
      if (p.actor || p.formId) opened = typeof o.openPerson === 'function' ? o.openPerson(p) : false;
      if (opened === false || (!p.actor && !p.formId)) { focus = p; search = ''; pageNumber = 0; render(); }
    }
    function personRow(p, caption, onOpen) {
      var row = button('', function () { (onOpen || navigate)(p); }, 'dso-person');
      var src = (typeof p.portrait === 'string' ? p.portrait : p.portrait && p.portrait.file) || p.image || p.portraitUrl;
      if (src) row.appendChild(picture(src, ''));
      else row.appendChild(el('span', 'dso-initial', (p.name || '?').slice(0, 1)));
      append(row, [append(el('span', 'dso-person-text'), [el('strong', '', p.name || 'Unnamed person'), el('span', 'dso-muted', caption || p.householdRole || '')]), el('span', 'dso-arrow', '›')]);
      return row;
    }
    function filterList(container, rows, query, draw, empty) {
      container.textContent = ''; var hits = rows.filter(function (p) { return lower(p.name).indexOf(lower(query)) !== -1; });
      hits.slice(0, 40).forEach(function (p) { container.appendChild(draw(p)); });
      if (!hits.length) container.appendChild(el('p', 'dso-empty', empty || 'No matching people. Try a different name.'));
      if (hits.length > 40) container.appendChild(el('p', 'dso-muted', 'Showing 40 of ' + hits.length + '. Type more of the name to narrow the list.'));
    }
    function relationEditor() {
      var p = current(), box = openModal('Add a family connection', 'Saved links appear on both people’s pages. They do not change in-game marriage or adoption.');
      var kind = el('select', 'dso-input'); kind.setAttribute('aria-label', 'Relationship to ' + p.name);
      [['child', 'Their child'], ['parent', 'Their parent'], ['adopted-child', 'Their adopted child'], ['adoptive-parent', 'Their adoptive parent'], ['spouse', 'Their spouse'], ['partner', 'Their partner'], ['ex-partner', 'Their former partner']].forEach(function (v) { var n = el('option', '', v[1]); n.value = v[0]; kind.appendChild(n); }); kind.value = 'child';
      var query = input('Find a person', 'Search NPCs and saved people…'), list = el('div', 'dso-picker'), selected = null, selection = el('p', 'dso-selection', 'Choose someone below.'), manualName = input('New person name', 'Name of a child or another person…');
      var all = data.people.slice(); (o.roster || []).forEach(function (r) { if (!personOf(r)) all.push(r); });
      all = all.filter(function (r) { if (identity(p) === identity(personOf(subject)) && r.formId && subject.formId && parseInt(r.formId,16) === parseInt(subject.formId,16)) return false; return !(identity(r) && identity(r) === identity(p)) && !(actorKey(r) && actorKey(r) === actorKey(p)); });
      function choose(r) { selected = r; selection.textContent = 'Connect ' + p.name + ' with ' + r.name; list.querySelectorAll('.dso-person').forEach(function (b) { b.classList.remove('selected'); }); }
      function draw() { filterList(list, all, query.value, function (r) { return personRow(r, r.actor || r.formId ? 'NPC' : 'Saved person', choose); }); }
      query.addEventListener('input', draw); query.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var b = list.querySelector('button'); if (b) b.click(); e.preventDefault(); } });
      var manual = append(el('div', 'dso-manual'), [field('Not in the game yet?', manualName), button('Use this name', function () { if (!manualName.value.trim()) { manualName.focus(); return; } choose({ name: manualName.value.trim(), manual: true }); })]);
      append(box, [field('Relationship to ' + p.name, kind), query, list, manual, selection, mutateButton('Save connection', box, async function () {
        if (!selected) throw new Error('Choose an NPC or enter a new person’s name first.');
        var from = await ensure(p), to = await ensure(selected), k = kind.value;
        if (k === 'parent' || k === 'adoptive-parent') { var swap = from; from = to; to = swap; }
        if (k === 'child') k = 'parent'; if (k === 'adopted-child') k = 'adoptive-parent';
        await request({ op: 'addRelation', from: from, to: to, kind: k });
      })]); draw(); query.focus();
    }
    function portraitChooser(person) {
      var p = person || current(), box = openModal('Portrait for ' + p.name, 'Choose a saved image for this family record. The image file is left unchanged.'), query = input('Find a saved portrait', 'Search saved portraits…'), list = el('div', 'dso-photo-grid'), photos = [], status = message('Loading saved portraits…', false, box);
      function draw() {
        list.textContent = ''; var hits = photos.filter(function (photo) { return lower((photo.label || '') + ' ' + photo.file).indexOf(lower(query.value)) !== -1; });
        hits.slice(0, 48).forEach(function (photo) {
          var b = mutateButton(photo.label || photo.file, box, async function () { await request({op:'setPortrait',personId:await ensure(p),file:photo.file}); if (focus && identity(focus) === identity(p)) focus = personOf(p) || p; });
          b.classList.add('dso-photo-choice'); b.appendChild(picture(photo.src || photo.file, photo.label || 'Saved portrait', 'dso-photo-preview')); list.appendChild(b);
        });
        if (!hits.length) list.appendChild(el('p', 'dso-empty', 'No matching portraits. Capture an image in an NPC’s Gallery first.'));
        if (hits.length > 48) list.appendChild(el('p', 'dso-muted', 'Showing 48 portraits. Search to narrow the list.'));
      }
      query.addEventListener('input', draw); query.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var first = list.querySelector('button'); if (first) first.click(); e.preventDefault(); } });
      append(box, [query, list]);
      if (typeof o.loadPortraits !== 'function') { status.textContent = 'The portrait library is unavailable in this view.'; return; }
      Promise.resolve().then(function () { return o.loadPortraits(p); }).then(function (rows) {
        if (dead || !modal || !modal.contains(box)) return;
        photos = Array.isArray(rows) ? rows.filter(function (r) { return r && safeImage(r.file); }) : []; status.textContent = 'Choose a portrait to save it for ' + p.name + '.'; draw();
      }, function (err) { if (!dead && modal && modal.contains(box)) { status.classList.add('dso-error'); status.textContent = err.message || 'The portrait library could not be loaded. Close and try again.'; } }); query.focus();
    }
    function bindPerson() {
      var p = current(), box = openModal('Link ' + p.name + ' to an NPC', 'Keep this person’s family links and history when they appear in the game.'), query = input('Find an NPC', 'Search NPCs…'), list = el('div', 'dso-picker'), chosen = null, selection = el('p', 'dso-selection', 'Choose an NPC.');
      function draw() { filterList(list, (o.roster || []).filter(function (r) { return r.actor || r.formId; }), query.value, function (r) { return personRow(r, 'NPC', function (x) { chosen = x; selection.textContent = 'Link to ' + x.name; }); }); }
      query.addEventListener('input', draw);
      query.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var first = list.querySelector('button'); if (first) first.click(); e.preventDefault(); } });
      append(box, [query, list, selection, mutateButton('Link NPC', box, async function () {
        if (!chosen) throw new Error('Choose an NPC first.');
        var actor = chosen.actor || { formId: chosen.formId, plugin: chosen.plugin || '' };
        await request({ op: 'bindActor', personId: await ensure(p), actor: actor });
        focus = personOf(p) || p;
      })]); draw(); query.focus();
    }
    function removeRelation(r, other) {
      var box = openModal('Remove family connection?', 'Remove the saved link with ' + other.name + ' from both pages. In-game relationships remain unchanged.');
      box.appendChild(mutateButton('Remove connection', box, function () { return request({ op: 'removeRelation', relationId: r.id }); }));
    }
    function renderFamily() {
      var p = current(), links = connections(data, identity(personOf(p) || p));
      var head = append(el('div', 'dso-toolbar'), [title('Family tree', 'A shared family record. Add children, parents and partners across your NPCs.'), button('Add connection', relationEditor, 'dso-button dso-primary')]); host.appendChild(head);
      if (focus) host.appendChild(button('‹ Back to ' + subject.name, function () { focus = null; render(); }, 'dso-back'));
      var personTools = el('div', 'dso-person-tools');
      if (!p.actor && !p.formId && identity(p)) personTools.appendChild(button('Link to an NPC…', bindPerson));
      if (typeof o.loadPortraits === 'function') personTools.appendChild(button('Choose portrait…', function () { portraitChooser(p); }));
      if (focus && (p.actor || p.formId) && typeof o.openPerson === 'function') personTools.appendChild(button('Open character page ›', function () { o.openPerson(p); }));
      personTools.classList.add('dso-family-actions');
      var addConnection = head.querySelector('button'); if (addConnection) personTools.appendChild(addConnection);
      head.appendChild(personTools);
      var marriage = o.observedMarriage || subject.observedMarriage;
      if (marriage && !focus) head.querySelector('.dso-heading').appendChild(el('p', 'dso-observed', 'Game reports: ' + marriage));
      var familyQuery = input('Search family connections', 'Find someone in this branch…');
      host.appendChild(familyQuery);
      var tree = el('div', 'dso-tree');
      function band(name, rows, cls) {
        var band = append(el('section', 'dso-branch ' + cls), [el('h3', '', name)]), list = el('div', 'dso-family-list');
        rows.forEach(function (r) { var wrap = el('div', 'dso-family-row'); append(wrap, [personRow(r.person, r.label + ' · Recorded', navigate), button('Remove', function () { removeRelation(r.relation, r.person); }, 'dso-link-remove')]); list.appendChild(wrap); });
        if (!rows.length) list.appendChild(el('p', 'dso-empty', 'No ' + name.toLowerCase() + ' recorded.')); band.appendChild(list); return band;
      }
      tree.appendChild(band('Parents', links.parents, 'dso-parents'));
      tree.appendChild(append(el('div', 'dso-tree-focus'), [el('span', 'dso-eyebrow', 'Family of'), el('h3', '', p.name || 'Unnamed person'), el('p', 'dso-muted', p.actor || p.formId ? 'NPC record' : 'Personal family record')]));
      tree.appendChild(band('Partners', links.partners, 'dso-partners'));
      tree.appendChild(band('Children', links.children, 'dso-children'));
      if (g.HDFamilyTree) {
        familyQuery.hidden = true;
        var graphFocus = identity(personOf(p) || p) || 'dso-current', graphPeople = data.people.slice();
        if (!graphPeople.some(function (person) { return person.id === graphFocus; })) graphPeople.push(Object.assign({}, p, {id:graphFocus}));
        var graph = el('div', 'dso-graph-host'); host.appendChild(graph);
        treeModule = g.HDFamilyTree.mount(graph, {people:graphPeople,relations:data.relations,focusId:graphFocus,
          getPortrait:function (person) { return typeof o.portraitFor === 'function' ? o.portraitFor(person) : person.portrait && person.portrait.file || person.image || ''; },
          onSelect:function (person) { if (typeof o.onFocusPerson === 'function') o.onFocusPerson(person); focus = person; render(); },
          onEdit:typeof o.loadPortraits === 'function' ? function (person) { portraitChooser(person); } : null});
        host.appendChild(button('Connections list…', function () { var box = openModal('Connections of ' + p.name, 'Open another branch or remove a recorded link.'); box.appendChild(tree); }));
      } else host.appendChild(tree);
      var noMatch = el('p', 'dso-empty', 'No family connections match that name.'); noMatch.hidden = true; host.appendChild(noMatch);
      familyQuery.addEventListener('input', function () { var hits = 0; tree.querySelectorAll('.dso-family-row').forEach(function (r) { r.hidden = lower(r.querySelector('.dso-person-text strong').textContent).indexOf(lower(familyQuery.value)) === -1; if (!r.hidden) hits++; }); noMatch.hidden = !familyQuery.value || hits > 0; });
      familyQuery.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var row = Array.prototype.slice.call(tree.querySelectorAll('.dso-family-row')).find(function (r) { return !r.hidden; }); if (treeModule) { var match = data.people.find(function (person) { return lower(person.name).indexOf(lower(familyQuery.value)) !== -1; }); if (match) treeModule.focus(match.id); } else if (row) row.querySelector('.dso-person').click(); e.preventDefault(); } });
      host.appendChild(el('p', 'dso-muted dso-footnote', 'Choose any person to follow their branch. These are your recorded family links; observed marriage is shown separately.'));
    }
    function roleEditor() {
      var p = current(), box = openModal('Household role', 'A personal label for this NPC. It does not change their AI or job.'), role = input('Household role', 'Steward, guard, cook…'); role.value = p.householdRole || '';
      append(box, [field('Role', role), mutateButton('Save role', box, async function () { await request({ op: 'updatePerson', personId: await ensure(p), householdRole: role.value.trim() }); })]); role.focus();
    }
    function renderHousehold() {
      var p = current(), home = o.homeDomain, residents = o.residents || [], schedule = o.schedule || {};
      host.appendChild(append(el('div', 'dso-toolbar'), [title('Household', 'Their home, the people who share it, and the shape of their day.'), button('Edit role', roleEditor)]));
      var grid = el('div', 'dso-house-grid'), left = el('section', 'dso-house-main'), right = el('section', 'dso-house-members');
      if (home) {
        if (home.image) { var cover = picture(home.image, home.name || 'Home', 'dso-home-image'); cover.addEventListener('error', function () { if (!left.querySelector('.dso-image-error')) left.appendChild(el('p', 'dso-muted dso-image-error', 'Home cover unavailable. Open the domain to choose another image.')); }); left.appendChild(cover); }
        append(left, [el('span', 'dso-eyebrow', 'Home domain'), el('h3', 'dso-home-title', home.name || 'Unnamed domain')]);
        if (typeof o.openDomain === 'function') left.appendChild(button('Open domain ›', function () { o.openDomain(home); }, 'dso-back'));
      } else append(left, [el('h3', '', 'No linked home domain'), el('p', 'dso-empty', o.homeLabel ? o.homeLabel + ' is their home. Link its location in Domains to show its cover and household here.' : 'Assign a home in Daily rhythm to build this household.')]);
      var stats = el('dl', 'dso-facts');
      [['Household role', p.householdRole || 'Not recorded'], ['Observed location', o.observedLocation || subject.location || 'Not available'], ['Scheduled now', schedule.currentLabel || 'No current schedule data'], ['Scheduled next', schedule.nextLabel ? schedule.nextLabel + (schedule.nextHour !== undefined ? ' · ' + schedule.nextHour : '') : 'Open Daily rhythm for the full schedule']].forEach(function (r) { append(stats, [el('dt', '', r[0]), el('dd', '', r[1])]); }); left.appendChild(stats);
      left.appendChild(el('p', 'dso-muted', 'A scheduled destination is not proof of where they are standing.'));
      if (typeof o.openRhythms === 'function') left.appendChild(button('Saved rhythms…', function () { o.openRhythms(subject); }, 'dso-button dso-primary'));
      var query = input('Search household residents', 'Find someone in this household…'), list = el('div', 'dso-resident-list');
      append(right, [el('h3', '', 'Under the same roof'), el('p', 'dso-muted', home ? residents.length + ' linked resident' + (residents.length === 1 ? '' : 's') : 'Residents appear when a home domain is linked.'), query, list]);
      function draw() { filterList(list, residents, query.value, function (r) { var record = personOf(r); return personRow(r, record && record.householdRole || r.householdRole || 'Resident'); }, 'No residents found for this home.'); }
      query.addEventListener('input', draw); query.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var first = list.querySelector('button'); if (first) first.click(); e.preventDefault(); } }); draw(); append(grid, [left, right]); host.appendChild(grid);
    }
    function noteEditor() {
      var p = current(), box = openModal('Add a history note', 'Record what happened. Notes are dated when saved; earlier events are never invented.'), text = el('textarea', 'dso-input dso-note'); text.setAttribute('aria-label', 'History note'); text.name = 'history-note'; text.value = noteDraft; text.maxLength = 4000; text.placeholder = 'What would you like to remember?'; text.addEventListener('input', function () { noteDraft = text.value; });
      append(box, [field('Note', text), mutateButton('Save note', box, async function () { if (!text.value.trim()) throw new Error('Write a note before saving.'); await request({ op: 'addNote', personId: await ensure(p), text: text.value.trim() }); noteDraft = ''; })]); text.focus();
    }
    function removeNote(event) {
      var box = openModal('Delete this note?', 'This removes your note from this NPC’s history. Recorded changes remain in the timeline.');
      append(box, [el('blockquote', 'dso-note-quote', event.text), mutateButton('Delete note', box, function () { return request({ op: 'deleteNote', personId: identity(personOf(current()) || current()), eventId: event.id }); })]);
    }
    function renderHistory() {
      host.appendChild(append(el('div', 'dso-toolbar'), [title('History', 'Your notes and recorded changes, newest first.'), button('Add note', noteEditor, 'dso-button dso-primary')]));
      if (typeof o.openDiary === 'function') host.appendChild(button('Open CHIM diary ›', function () { o.openDiary(subject); }, 'dso-back'));
      var query = input('Search history', 'Search names, places and notes…'), type = el('select', 'dso-input'); query.value = search; type.setAttribute('aria-label', 'History category');
      [['', 'All recorded events'], ['note', 'Personal notes'], ['family', 'Family connections'], ['portrait', 'Portrait changes'], ['pins', 'Pinned actions'], ['equipment', 'Wardrobe presets']].forEach(function (r) { var opt = el('option', '', r[1]); opt.value = r[0]; type.appendChild(opt); }); type.value = historyType;
      var filter = append(el('div', 'dso-filters'), [query, type]), list = el('div', 'dso-timeline'), paging = el('div', 'dso-paging'); host.appendChild(filter); host.appendChild(list); host.appendChild(paging);
      function draw() {
        search = query.value; historyType = type.value; var id = identity(personOf(current()) || current());
        var rows = data.history.filter(function (e) { return Array.isArray(e.personIds) && e.personIds.indexOf(id) !== -1 && (!search || lower(e.text).indexOf(lower(search)) !== -1) && (!historyType || (historyType === 'family' ? /relation|family/.test(e.type) : e.type.indexOf(historyType) !== -1)); });
        rows.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
        var pages = Math.max(1, Math.ceil(rows.length / 40)); pageNumber = Math.min(pageNumber, pages - 1); list.textContent = ''; paging.textContent = '';
        rows.slice(pageNumber * 40, (pageNumber + 1) * 40).forEach(function (e) {
          var article = el('article', 'dso-event'), date = new Date(e.createdAt), when = isNaN(date.getTime()) ? 'Date not recorded' : date.toLocaleString();
          append(article, [el('time', 'dso-event-date', when), el('span', 'dso-eyebrow', e.type === 'note' ? 'Personal note' : 'Recorded change'), el('p', 'dso-event-text', e.text || '')]);
          if (e.type === 'note') article.appendChild(button('Delete note', function () { removeNote(e); }, 'dso-link-remove')); list.appendChild(article);
        });
        if (!rows.length) list.appendChild(el('p', 'dso-empty', search || historyType ? 'No events match these filters.' : 'Their story starts here. Add a note; future family, portrait and pinned-action changes will appear as they are saved.'));
        if (pages > 1) { var prev = button('‹ Previous', function () { pageNumber--; draw(); }), next = button('Next ›', function () { pageNumber++; draw(); }); prev.disabled = pageNumber === 0; next.disabled = pageNumber === pages - 1; append(paging, [prev, el('span', '', (pageNumber + 1) + ' / ' + pages), next]); }
      }
      query.addEventListener('input', function () { pageNumber = 0; draw(); }); type.addEventListener('change', function () { pageNumber = 0; draw(); }); draw();
    }
    function render() { if (dead) return; if (treeModule) { treeModule.destroy(); treeModule = null; } host.textContent = ''; if (page === 'family') renderFamily(); else if (page === 'history') renderHistory(); else renderHousehold(); }
    render();
    return {
      update: function (next) { data = cleanData(next && (next.data || next)); if (focus) focus = personOf(focus) || focus; render(); },
      destroy: function () { dead = true; closeModal(); if (treeModule) {treeModule.destroy();treeModule=null;} host.textContent = ''; host.classList.remove('dso-host'); },
      refreshPortraits: function () { if (treeModule) treeModule.update({getPortrait:function (person) {return typeof o.portraitFor === 'function' ? o.portraitFor(person) : person.portrait && person.portrait.file || person.image || '';}}); },
      hasModal: function () { return !!modal; },
      onKey: function (e) { if (!modal) return false; modalKey(e); return true; }
    };
  }
  g.HDDossierSocial = { mount: mount, connections: function (data, id) { return connections(cleanData(data), id); } };
})(window);
