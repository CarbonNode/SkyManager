/* Magic Workbench chrome. Spell actions, icons, descriptions and packages stay
   owned by app.js / library-ui.js; automatic rows never rewrite the saved deck. */
(function () {
  'use strict';
  var W = MagicWorkbenchModel, selected = null, inspectionKey = '', originalDetails;
  var schools = ['Destruction','Restoration','Conjuration','Illusion','Alteration'];
  function prefs() {
    if (!state.library.workbench) state.library.workbench = W.normalize({});
    return state.library.workbench;
  }
  function button(label, fn, cls) { return h('button', {type:'button',class:cls || 'ml-button',onClick:fn}, label); }
  function cap(s) { return String(s || '').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function image(src, size) { return h('img', {src:src,width:size,height:size,alt:'',draggable:'false'}); }
  function groupIcon(g) { return g.icon ? image(g.icon,28) : image('icons/custom/cat-mages.png',28); }
  function currentGroup(id) { return prefs().groups.find(function (g) { return g.id === id; }); }
  function groupRows(spec) {
    var rows = librarySpells();
    if (spec.kind === 'category') return rows.filter(function (s) { return SpellLibrary.inside(s.category,spec.name,state.library.parents); });
    if (spec.kind === 'school') return rows.filter(function (s) { return String(metaFor(s).school).toLowerCase() === spec.name.toLowerCase(); });
    var g = currentGroup(spec.id); return g ? W.groupRows(rows,g) : [];
  }
  /* The school quick-filter is its own dimension, so it COMPOSES with everything
     else: "my deck, Destruction only" is two chips, not a choice between them.
     It sits here rather than in SpellLibrary.visible because only this module
     knows a spell's live school (metaFor merges the engine's answer over the
     saved snapshot). */
  function setSchool(name) {
    ui.school = ui.school === name ? '' : (name || '');
    ui.sel = -1;
    render();
    var list = $('list'); if (list) list.scrollTop = 0;
  }
  function filter(rows) {
    if (ui.school) {
      var want = String(ui.school).toLowerCase();
      rows = rows.filter(function (s) { return String(metaFor(s).school || '').toLowerCase() === want; });
    }
    var f = ui.workbenchFilter; if (!f) return rows;
    if (f.kind === 'deck') return rows.filter(function (s) { return !s._learned; });
    if (f.kind === 'equipped') return rows.filter(function (s) { var id = liveHex(s); return ui.equip.left === id || ui.equip.right === id || ui.equip.voice.has(id); });
    var members = Object.create(null); groupRows(f).forEach(function (s) { members[s.id] = true; });
    return rows.filter(function (s) { return members[s.id]; });
  }
  function choose(spec) {
    ui.workbenchFilter = spec; ui.cat = ALL; ui.kind = ui.mode = 'all'; ui.sel = -1;
    render(); $('list').scrollTop = 0;
  }
  function rail(host, query) {
    var extra = h('div',{class:'mw-rail-extra'});
    [['My deck','deck'],['Equipped','equipped']].forEach(function (s) {
      var b = button(s[0], function () { choose({kind:s[1],name:s[0]}); },'rail-item mw-scope');
      b.setAttribute('aria-pressed',String(!!ui.workbenchFilter && ui.workbenchFilter.kind === s[1])); extra.append(b);
    });
    extra.append(h('div',{class:'ml-rail-heading'},'SCHOOLS'));
    schools.forEach(function (name) {
      if (query && name.toLowerCase().indexOf(query) < 0) return;
      // The rail and the bar's school chips are ONE filter, so a school picked
      // in either place reads as picked in both.
      var spec = {kind:'school',name:name}, row = h('div',{class:'mw-group-nav'});
      var b = button(name,function () { setSchool(name); },'rail-item mw-group-filter' + (ui.school === name ? ' sel' : ''));
      b.setAttribute('aria-pressed',String(ui.school === name));
      row.append(b,arrow(spec)); extra.append(row);
    });
    extra.append(h('div',{class:'ml-category-head'},h('span',{class:'ml-rail-heading'},'SPELL GROUPS'),
      button('+',function () { editGroup(); },'ml-add-category')));
    extra.querySelector('.ml-add-category').setAttribute('aria-label','Create spell group');
    prefs().groups.forEach(function (g) {
      if (query && g.name.toLowerCase().indexOf(query) < 0) return;
      var spec = {kind:'group',id:g.id,name:g.name}, b = button('',function () { choose(spec); },'rail-item mw-group-filter');
      b.append(groupIcon(g),h('span',{class:'rail-name'},g.name),h('span',{class:'rail-count'},groupRows(spec).length));
      extra.append(h('div',{class:'mw-group-nav'},b,arrow(spec)));
    });
    if (!prefs().groups.length) extra.append(button('Create a spell group',function () { editGroup(); },'mw-create-group'));
    host.insertBefore(extra,host.querySelector('.ml-category-head'));
  }
  function arrow(spec) {
    var b = button('›',function () { openGroup(spec); },'mw-flyout-open');
    b.setAttribute('aria-label','Open '+spec.name+' flyout'); b.setAttribute('aria-haspopup','dialog'); return b;
  }
  function categoryArrow(name) { return arrow({kind:'category',name:name}); }
  function action(spell, mode, hand) {
    cancelDesc();
    if (spell._learned || knownFor(spell)) {
      toGame('mdLibraryFire',JSON.stringify({plugin:spell.plugin || '',localId:spell.localId >>> 0,formId:spell.formId >>> 0,mode:mode,hand:hand || 'right'}));
    } else { fireEntry(spell.id); }
  }
  function equipLabel(spell,hand) {
    var id = liveHex(spell), on = slotOf(spell) === 'voice' ? ui.equip.voice.has(id) : ui.equip[hand] === id;
    return (on ? 'Unequip ' : 'Equip ') + (slotOf(spell) === 'voice' ? 'voice' : hand);
  }
  function actionButtons(spell) {
    var box = h('div',{class:'mw-actions'});
    if (!spell._learned && !knownFor(spell)) { box.append(button('Use saved action',function(){fireEntry(spell.id);},'ml-button ml-primary'));return box; }
    box.append(button('Cast now',function () { castNow(spell); },'ml-button ml-primary mw-cast-now'));
    if (slotOf(spell) === 'voice') box.append(button(equipLabel(spell,'right'),function () { action(spell,'equip','right'); },'ml-button'));
    else ['left','right'].forEach(function (hand) { box.append(button(equipLabel(spell,hand),function () { action(spell,'equip',hand); },'ml-button')); });
    return box;
  }
  function artwork(spell) {
    if (!prefs().artwork) return '';
    var m = metaFor(spell), el = String(m.element || '').toLowerCase(), sc = String(m.school || '').toLowerCase();
    var key = isShout(spell) ? 'voice' : el === 'fire' ? 'fire' : el === 'frost' ? 'frost' : el === 'shock' ? 'shock' :
      sc === 'restoration' ? 'healing' : sc === 'conjuration' ? 'soul' : sc === 'illusion' ? 'shadow' : sc === 'alteration' ? 'bark' : 'light';
    return 'workbench-art/'+key+'.webp';
  }
  function inspect(spell) {
    if (!spell) return;
    selected = spell; cancelDesc();
    if (!prefs().inspector || $('panel').clientWidth < 1450 || $('panel').clientHeight < 750 || MagicLibraryUI.isOpen()) { originalDetails(spell); return; }
    drawInspector();
  }
  function drawInspector() {
    var host = $('mw-inspector'); if (!host) return;
    var show = prefs().inspector && $('panel').clientWidth >= 1450 && $('panel').clientHeight >= 750 && !isArtsPage();
    host.hidden = !show; $('panel').classList.toggle('mw-with-inspector',show);
    var fold = $('mw-toggle-inspector');
    if (fold) {
      // No room for a pinned inspector (small panel, Combat Arts): nothing to fold, so no chevron.
      fold.hidden = !($('panel').clientWidth >= 1450 && $('panel').clientHeight >= 750 && !isArtsPage());
      fold.textContent = show ? '›' : '‹'; fold.setAttribute('aria-expanded',String(show));
      fold.title = show ? 'Hide spell details' : 'Show spell details'; fold.setAttribute('aria-label',fold.title);
    }
    if (!show) return;
    var rows = visibleSpells();
    if (!selected || !findSpellEntry(selected.id)) selected = rows[0] || null;
    else selected = findSpellEntry(selected.id);
    if (!selected) { host.textContent = ''; host.append(h('p',{class:'mw-no-selection'},'Select a spell to see its effects and equip it.')); inspectionKey=''; return; }
    var s = selected, m = metaFor(s), key = [s.id,liveHex(s),resolveIconPath(m),prefs().artwork,ui.equip.left,ui.equip.right,Array.from(ui.equip.voice).join(',')].join('|');
    if (key === inspectionKey) return;
    inspectionKey = key; host.textContent = '';
    var art = artwork(s);
    if (art) host.append(h('div',{class:'mw-inspector-art',style:'background-image:url("'+art+'")','aria-hidden':'true'}));
    var scroll = h('div',{class:'mw-inspector-scroll'});
    scroll.append(iconEl(m),h('p',{class:'mw-eyebrow'},[m.school || cap(SpellLibrary.kind(m)),m.tier].filter(Boolean).join(' / ')),h('h2',null,s.name),
      h('p',{id:'mw-description',class:'mw-description','aria-live':'polite'},'Reading spell effects…'),
      h('div',{id:'mw-stats',class:'mw-stats'}),h('div',{id:'mw-effects'}),
      h('p',{class:'mw-source'},m.plugin || 'Runtime spell'));
    var actions = actionButtons(s);
    actions.append(button('Full details',function () { originalDetails(s); }),button('Add to group',function () { addToGroup(s); }),
      button('Change icon',function () { openIconPicker(s); }));
    host.append(scroll,actions);
    var k = hexId(m.formId); descriptionData(k,desc.cache.get(k) || desc.failures.get(k) || null); ensureDesc(m);
  }
  function descriptionData(key,data) {
    if (!selected || hexId(metaFor(selected).formId) !== key || !$('mw-description')) return;
    $('mw-description').textContent = !data ? 'Reading spell effects…' : !data.ok ? 'Description unavailable. Open Full details to retry.' : data.text || 'This mod supplies no effect description.';
    var stats = $('mw-stats'); stats.textContent = '';
    SpellLibrary.stats(data).forEach(function (s) { stats.append(h('div',null,h('strong',null,s.value),h('span',null,s.label))); });
    var effects = $('mw-effects'); effects.textContent = '';
    SpellLibrary.effectRows(data).forEach(function (r) { effects.append(h('p',null,h('strong',null,r.name),h('span',null,r.text))); });
  }
  /* ---- side panes: drag a divider to size it, chevron to fold it -------------
     Widths are PRE-scale layout px (the panel's own drag-size rule), so pointer
     travel on screen is divided by the panel's painted scale. A drag is tracked
     from mouse-down to mouse-up / blur and never from MouseEvent.buttons:
     Ultralight reports 0 there while a button is held. Applying a width clamps
     it to what the panel can hold today but never edits the saved number, so a
     size chosen at 1440p survives one open at 1080p. */
  var MAIN_MIN = 560, SPLIT_STEP = 24, split = null, paneSig = '';
  var PANE = { rail: { el: 'rail', bar: 'mw-split-rail', css: '--mw-rail-w', name: 'Categories' },
    inspector: { el: 'mw-inspector', bar: 'mw-split-inspector', css: '--mw-inspector-w', name: 'Spell details' } };
  function paneShown(pane) {
    var el = $(PANE[pane].el);
    return !!el && !el.hidden && el.parentNode === $('body') && el.offsetWidth > 0;
  }
  function paneLimit(pane) {
    var spec = W.PANES[pane], other = pane === 'rail' ? 'inspector' : 'rail';
    var room = $('body').clientWidth - (paneShown(other) ? $(PANE[other].el).offsetWidth : 0) - MAIN_MIN;
    return { min: spec.min, max: Math.max(spec.min, Math.min(spec.max, Math.floor(room))) };
  }
  function applyPanes() {
    var panel = $('panel'); if (!panel || !$('mw-split-rail')) return;
    var p = prefs(), sig = [p.railW, p.inspectorW, panel.clientWidth, panel.className, $('mw-inspector').hidden].join('|');
    if (sig === paneSig) return; paneSig = sig;
    ['rail','inspector'].forEach(function (pane) {
      var cfg = PANE[pane], saved = p[W.PANES[pane].key], bar = $(cfg.bar), lim = paneLimit(pane);
      if (saved > 0) panel.style.setProperty(cfg.css,Math.min(lim.max,Math.max(lim.min,saved))+'px');
      else panel.style.removeProperty(cfg.css);
      bar.setAttribute('aria-valuemin',lim.min); bar.setAttribute('aria-valuemax',lim.max);
      bar.setAttribute('aria-valuenow',paneShown(pane) ? $(cfg.el).offsetWidth : 0);
    });
  }
  function setPane(pane, width, commit) {
    var lim = paneLimit(pane);
    prefs()[W.PANES[pane].key] = width > 0 ? Math.round(Math.min(lim.max,Math.max(lim.min,width))) : 0;
    paneSig = ''; applyPanes(); MagicLibraryUI.fit();
    if (commit) saveSoon();
  }
  function resetPane(pane) { setPane(pane,0,true); toast(PANE[pane].name+' width reset'); }
  function splitDown(pane, e) {
    if (e.button !== 0 || !paneShown(pane)) return;
    e.preventDefault(); closeCtx(); cancelDesc();
    var panel = $('panel'), r = $(PANE[pane].el).getBoundingClientRect();
    split = { pane: pane, scale: (panel.getBoundingClientRect().width / panel.offsetWidth) || 1,
      anchor: pane === 'rail' ? r.left : r.right,                     // the pane's fixed edge, screen px
      grab: e.clientX - (pane === 'rail' ? r.right : r.left) };       // grab point vs its moving edge
    document.body.classList.add('mw-splitting'); $(PANE[pane].bar).classList.add('dragging');
    document.addEventListener('mousemove',splitMove,true);
    document.addEventListener('mouseup',splitUp,true);
    window.addEventListener('blur',splitUp);
  }
  function splitMove(e) {
    if (!split) return;
    e.preventDefault();
    var edge = e.clientX - split.grab, width = (split.pane === 'rail' ? edge - split.anchor : split.anchor - edge) / split.scale;
    setPane(split.pane,Math.max(W.PANES[split.pane].min,width),false);   // past the floor stops at the floor; 0 means automatic
  }
  function splitUp() {
    if (!split) return;
    $(PANE[split.pane].bar).classList.remove('dragging'); split = null;
    document.body.classList.remove('mw-splitting');
    document.removeEventListener('mousemove',splitMove,true);
    document.removeEventListener('mouseup',splitUp,true);
    window.removeEventListener('blur',splitUp);
    saveSoon();
  }
  function splitKey(e) {
    var bar = e.target && e.target.classList && e.target.classList.contains('mw-splitter') ? e.target : null;
    if (!bar) return false;
    var pane = bar.id === PANE.rail.bar ? 'rail' : 'inspector', grow = pane === 'rail' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setPane(pane,$(PANE[pane].el).offsetWidth + (e.key === grow ? SPLIT_STEP : -SPLIT_STEP),true);
    else if (e.key === 'Home') setPane(pane,W.PANES[pane].min,true);
    else if (e.key === 'End') setPane(pane,W.PANES[pane].max,true);
    else if (e.key === 'Enter') resetPane(pane);
    else return false;
    e.preventDefault(); return true;
  }
  function toggleInspector() {
    var p = prefs(); p.inspector = !p.inspector; inspectionKey = '';
    saveSoon(); dropRowCache(); render(); MagicLibraryUI.fit();
  }
  /* The equipped-hands dock folds to a slim strip (Rober, 2026-10-15, pointing at
     it: "this bar as well"). It is not hidden outright — the chevron has to stay
     somewhere you can hit it, and a control that vanishes with the thing it
     controls cannot bring it back. Folded, --mw-dock-slot shrinks, which the
     Hotkeys tab beside it already sizes itself from. */
  function toggleDock() {
    var p = prefs();
    p.dock = p.dock === false;
    saveSoon(); sync(); MagicLibraryUI.fit();
  }
  function dock() {
    var host = $('mw-dock-slots'); if (!host) return;
    var sig = [ui.equip.left,ui.equip.right,Array.from(ui.equip.voice).join(','),ui.known.length].join('|');
    if (host.dataset.signature === sig) return; host.dataset.signature = sig; host.textContent = '';
    ['left','right','voice'].forEach(function (slot) {
      var id = slot === 'voice' ? Array.from(ui.equip.voice)[0] : ui.equip[slot];
      var s = librarySpells().find(function (s) { return liveHex(s) === id; });
      var b = button('',function () { if(s) inspect(s); },'mw-equipped-slot');
      b.disabled = !s;
      if (s) b.append(iconEl(metaFor(s)));
      b.append(h('span',null,h('small',null,slot === 'voice' ? 'VOICE' : slot.toUpperCase()+' HAND'),h('strong',null,s ? s.name : id ? 'Other equipment' : 'Empty'))); host.append(b);
    });
  }
  function sync() {
    if (!$('mw-top')) return;
    var p = prefs(), panel = $('panel');
    panel.setAttribute('data-mw-theme',p.theme); panel.setAttribute('data-mw-text',p.textSize);
    document.documentElement.setAttribute('data-mw-theme',p.theme);   // popouts live outside #panel
    panel.classList.toggle('mw-no-motion',!p.motion);
    // Search is the control bar's, not the title block's — library-ui.sync places
    // it. Pulling it back into #mw-top here would undo that every sync, and the
    // fold would take search down with the heading.
    $('md-page-title').textContent = isArtsPage() ? 'Combat Arts' : 'Magic';
    $('ml-heading').textContent = ui.workbenchFilter ? ui.workbenchFilter.name : ui.cat === ALL ? 'Your spellbook' : ui.cat;
    $('ml-breadcrumb').textContent = ui.workbenchFilter && ui.workbenchFilter.kind === 'deck' ? 'YOUR SAVED DECK' : 'EVERY LEARNED SPELL. READY WHEN YOU ARE.';
    var q = $('mw-pins'), sig = JSON.stringify(p.groups.map(function (g) { return [g.id,g.name,g.icon,g.pinned]; }));
    if (q.dataset.signature !== sig) {
      q.dataset.signature = sig; q.textContent='';
      q.append(h('span',{class:'mw-pin-label'},'QUICK GROUPS'));
      p.groups.filter(function (g) { return g.pinned; }).forEach(function (g) {
        var b = button('',function () { openGroup({kind:'group',id:g.id,name:g.name}); },'mw-pin'); b.append(groupIcon(g),g.name,h('span',{'aria-hidden':'true'},'›')); q.append(b);
      });
      q.append(button('+ New group',function () { editGroup(); },'mw-pin'));
    }
    $('mw-status').textContent = ui.knownLoading ? 'Reading your spellbook…' : ui.known.length+' learned · '+state.spells.length+' saved deck entries';
    var dockOpen = p.dock !== false, dockFold = $('mw-toggle-dock');
    panel.classList.toggle('mw-dock-folded',!dockOpen);
    if (dockFold) {
      dockFold.setAttribute('aria-expanded',String(dockOpen));
      dockFold.title = dockOpen ? 'Hide what you have equipped' : 'Show what you have equipped';
      dockFold.setAttribute('aria-label',dockFold.title);
    }
    dock(); drawInspector(); applyPanes();
  }
  function openGroup(spec, restore) {
    var g = spec.kind === 'group' ? currentGroup(spec.id) : null;
    if (spec.kind === 'group' && !g) return;
    spec.name = g ? g.name : spec.name;
    var box = MagicLibraryUI.openModal(spec.name), layout = g ? g.layout : 'list';
    box.classList.add('mw-group-flyout'); box.parentNode.classList.add('mw-flyout-backdrop');
    box.append(h('p',{class:'mw-group-copy'},'Browse this group without losing your place.'));
    var input = h('input',{type:'search',placeholder:'Search this group…','aria-label':'Search '+spec.name,autocomplete:'off'});
    var modes = h('div',{class:'mw-group-toolbar'}), count = h('span',{role:'status'}), list = h('div',{class:'mw-group-list'});
    function draw() {
      var rows = W.search(groupRows(spec),input.value); list.textContent=''; list.setAttribute('data-view',layout);
      count.textContent=rows.length+' spells';
      modes.querySelectorAll('[data-view]').forEach(function (b) { b.setAttribute('aria-pressed',String(b.dataset.view === layout)); });
      rows.forEach(function (s) {
        var row = h('div',{class:'mw-flyout-row'}), b = button('',function () { var place={query:input.value,scroll:list.scrollTop}; originalDetails(s);var detail=document.querySelector('.ml-spell-dialog');if(detail)detail.append(button('‹ Back to '+spec.name,function(){openGroup(spec,place);})); },'mw-flyout-spell');
        b.append(iconEl(metaFor(s)),h('span',null,h('strong',null,s.name),h('small',null,cap(metaFor(s).school || SpellLibrary.kind(metaFor(s))))));
        row.append(b,actionButtons(s)); list.append(row);
      });
      if (!rows.length) list.append(h('p',{class:'mw-empty'},input.value ? 'No matching spells. Try another name or school.' : 'No available spells in this group. Edit it to add members.'));
    }
    ['list','icons'].forEach(function (v) { var b=button(cap(v),function () { layout=v; if(g){g.layout=v;saveSoon();} draw(); }); b.dataset.view=v; modes.append(b); });
    modes.append(count,button(g ? 'Edit group' : 'Copy to group',function () { editGroup(g,groupRows(spec),spec.name); }));
    input.addEventListener('input',draw); input.addEventListener('keydown',function (e) { if(e.key==='Enter'){e.preventDefault();var first=list.querySelector('.mw-flyout-spell');if(first)first.click();} });
    box.append(input,modes,list); if(restore)input.value=restore.query; draw(); if(restore)list.scrollTop=restore.scroll; input.focus();
  }
  function editGroup(existing, initial, name) {
    var draft=existing ? JSON.parse(JSON.stringify(existing)) : {id:'group-'+Date.now().toString(36),name:name || '',icon:'',layout:'list',pinned:true,members:(initial || []).map(W.key).filter(Boolean)};
    var box=MagicLibraryUI.openModal(existing ? 'Edit spell group' : 'New spell group'); box.classList.add('mw-group-editor');
    var nameInput=h('input',{type:'text',value:draft.name,maxlength:100,'aria-label':'Group name',placeholder:'For example, Battle magic'});
    var find=h('input',{type:'search',placeholder:'Find spells to include…','aria-label':'Find group members',autocomplete:'off'});
    var iconFind=h('input',{type:'search',placeholder:'Find an icon…','aria-label':'Find group icon',autocomplete:'off'}), icons=h('div',{class:'mw-group-icons'});
    function drawIcons() {
      icons.textContent=''; var paths=[];
      librarySpells().forEach(function (s) { var src=resolveIconPath(metaFor(s)); if(src && paths.indexOf(src)<0 && (!iconFind.value || W.search([s],iconFind.value).length)) paths.push(src); });
      if(draft.icon && paths.indexOf(draft.icon)<0)paths.unshift(draft.icon);
      paths.slice(0,48).forEach(function (src) { var b=button('',function () {draft.icon=src;drawIcons();},'mw-icon-choice'); b.append(image(src,40));b.setAttribute('aria-label','Use '+src.split('/').pop()+' icon');b.setAttribute('aria-pressed',String(src===draft.icon));icons.append(b); });
      if(!paths.length)icons.append(h('p',null,'No matching spell icons.'));
    }
    iconFind.addEventListener('input',drawIcons);
    var pin=h('input',{type:'checkbox','aria-label':'Pin in quick groups'});pin.checked=draft.pinned;
    var layout=h('select',{'aria-label':'Default flyout view'},h('option',{value:'list'},'List with icons'),h('option',{value:'icons'},'Icon grid'));layout.value=draft.layout;
    var list=h('div',{class:'mw-member-list'}),count=h('span',{role:'status'}),errors=h('p',{class:'mw-validation',role:'alert'});
    function drawMembers() {
      list.textContent='';var seen=Object.create(null);
      var rows=W.search(librarySpells(),find.value).filter(function(s){var k=W.key(s);if(!k||seen[k])return false;seen[k]=true;return true;});
      count.textContent=draft.members.length+' selected';
      rows.forEach(function(s){var k=W.key(s),b=button('',function(){var at=draft.members.indexOf(k);if(at<0)draft.members.push(k);else draft.members.splice(at,1);drawMembers();},'mw-member');
        b.setAttribute('aria-pressed',String(draft.members.indexOf(k)>=0));b.append(iconEl(metaFor(s)),h('span',null,s.name),h('span',{class:'mw-member-check','aria-hidden':'true'},draft.members.indexOf(k)>=0?'✓':'+'));list.append(b);});
      if(!rows.length)list.append(h('p',{class:'mw-empty'},'No matching spells. Runtime-only forms cannot be saved as group members.'));
    }
    find.addEventListener('input',drawMembers); find.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var b=list.querySelector('button');if(b)b.click();}});
    box.append(h('label',null,'Group name',nameInput),h('div',{class:'mw-group-settings'},h('label',null,pin,' Pin in quick groups'),layout),
      h('label',null,'Group icon',iconFind),icons,h('label',null,'Spells in this group',find),
      h('div',{class:'mw-group-toolbar'},count,button('Add matching spells',function(){W.search(librarySpells(),find.value).forEach(function(s){var k=W.key(s);if(k&&draft.members.indexOf(k)<0)draft.members.push(k);});drawMembers();})),list,errors);
    var actions=h('div',{class:'mw-editor-actions'}),armed=false;
    if(existing) actions.append(button('Delete group…',function(e){if(!armed){armed=true;e.currentTarget.textContent='Confirm delete group';errors.textContent='Only the group is deleted. All spells stay in your spellbook.';return;}prefs().groups=prefs().groups.filter(function(g){return g.id!==existing.id;});ui.workbenchFilter=null;saveSoon();MagicLibraryUI.close();render();}));
    actions.append(button('Cancel',function(){MagicLibraryUI.close();}),button('Save group',function(){
      if(!nameInput.value.trim()){errors.textContent='Give your group a name.';nameInput.focus();return;}
      draft.name=nameInput.value.trim();draft.layout=layout.value;draft.pinned=pin.checked;
      var at=prefs().groups.findIndex(function(g){return g.id===draft.id;});
      if(at<0){if(prefs().groups.length>=128){errors.textContent='You have 128 groups. Edit an existing group to continue.';return;}prefs().groups.push(draft);}else prefs().groups[at]=draft;
      saveSoon();MagicLibraryUI.close();render();openGroup({kind:'group',id:draft.id,name:draft.name});
    },'ml-button ml-primary'));box.append(actions);
    drawIcons();drawMembers();nameInput.focus();
  }
  function addToGroup(spell) {
    var k=W.key(spell);if(!k){toast('This runtime spell has no stable identity for a saved group.');return;}
    var box=MagicLibraryUI.openModal('Add '+spell.name+' to a group'),input=h('input',{type:'search',placeholder:'Find a group…','aria-label':'Find a group'}),list=h('div',{class:'mw-member-list'});
    function draw(){list.textContent='';prefs().groups.filter(function(g){return g.name.toLowerCase().indexOf(input.value.toLowerCase())>=0;}).forEach(function(g){var b=button('',function(){if(g.members.indexOf(k)<0)g.members.push(k);saveSoon();MagicLibraryUI.close();render();toast('Added to '+g.name);});b.append(groupIcon(g),g.name);list.append(b);});}
    input.addEventListener('input',draw);input.addEventListener('keydown',function(e){if(e.key==='Enter'){var first=list.querySelector('button');if(first){e.preventDefault();first.click();}}});box.append(input,list,button('Create group with this spell',function(){editGroup(null,[spell]);}));draw();input.focus();
  }
  function customize() {
    var p=prefs(),box=MagicLibraryUI.openModal('Customize Magic');box.classList.add('mw-customize');
    function toggle(label,key){var input=h('input',{type:'checkbox'});input.checked=p[key];input.addEventListener('change',function(){p[key]=input.checked;inspectionKey='';saveSoon();dropRowCache();render();});box.append(h('label',null,input,label));}
    toggle('Pin spell details beside the library','inspector');toggle('Show school artwork in Gallery and Details','artwork');toggle('Use subtle interface motion','motion');
    function select(label,key,options){var s=h('select',{'aria-label':label});options.forEach(function(o){s.append(h('option',{value:o[0]},o[1]));});s.value=p[key];s.addEventListener('change',function(){p[key]=key==='textSize'?Number(s.value):s.value;saveSoon();sync();});box.append(h('label',null,label,s));}
    select('Text size','textSize',[[100,'100%'],[115,'115%'],[130,'130%']]);select('Accent','theme',[['gold','Aged gold'],['frost','Frost'],['contrast','High contrast']]);
    box.append(h('p',null,'Columns, Gallery, List and Icons keep the same spells, icons and actions. Your existing quick-fire keys stay active.'),button('Edit keys and deck settings',function(){MagicLibraryUI.close();if(!ui.editing)$('edit-btn').click();}));
    box.querySelector('input').focus();
  }
  function onKey(e) {
    // The combo menu owns the keyboard while it is up. app.js's onKeyDown is a
    // document CAPTURE listener registered at startup, so a listener the menu
    // added itself would run after it and Escape would shut the whole deck.
    if (window.MdCombo && MdCombo.onKey(e)) return true;
    if (splitKey(e)) return true;
    if((e.ctrlKey||e.metaKey)&&String(e.key).toLowerCase()==='k'){
      e.preventDefault();var box=document.querySelector('.ml-backdrop .ml-dialog');var input=box&&box.querySelector('input[type=search]');(input || (box && box.querySelector('input,button,select')) || $('search')).focus();return true;
    }
    return false;
  }
  function init() {
    originalDetails=MagicLibraryUI.spellDetails;MagicLibraryUI.spellDetails=inspect;
    var main=$('main'),top=h('div',{id:'mw-top'});top.append($('ml-heading-block'));main.insertBefore(top,main.firstChild);
    main.insertBefore(h('div',{id:'mw-pins','aria-label':'Pinned spell groups'}),$('ml-library-bar'));
    main.append(h('div',{id:'mw-status',role:'status'}));
    ['rail','inspector'].forEach(function (pane) {
      var bar = h('div',{id:PANE[pane].bar,class:'mw-splitter',role:'separator',tabindex:'0','aria-orientation':'vertical',
        'aria-controls':PANE[pane].el,'aria-label':'Resize '+PANE[pane].name.toLowerCase(),
        title:'Drag to resize · double-click to reset'});
      bar.addEventListener('mousedown',function (e) { splitDown(pane,e); });
      bar.addEventListener('dblclick',function () { resetPane(pane); });
      if (pane === 'rail') $('body').insertBefore(bar,$('main')); else $('body').append(bar);
    });
    $('body').append(h('aside',{id:'mw-inspector','aria-label':'Selected spell'}));
    var fold = button('›',toggleInspector,'ml-chrome-toggle ml-rail-toggle'); fold.id = 'mw-toggle-inspector';
    fold.setAttribute('aria-controls','mw-inspector'); $('mw-bar-main').append(fold);
    var dockBox = h('div',{id:'mw-equipped','aria-label':'Equipped magic'});
    var dockFold = button('‹',toggleDock,'ml-chrome-toggle mw-dock-toggle'); dockFold.id = 'mw-toggle-dock';
    dockFold.setAttribute('aria-controls','mw-dock-slots');
    dockBox.append(h('div',{id:'mw-dock-slots',class:'mw-dock-slots'}),dockFold);
    $('panel').insertBefore(dockBox,$('hints'));
    var customizeButton=button('Customize',customize,'ghost-btn');customizeButton.id='mw-customize';$('md-more-btn').parentNode.insertBefore(customizeButton,$('md-more-btn'));
    document.querySelector('[data-library-view=cards]').textContent='Gallery';
    $('search').placeholder='Search spells, schools, mods…';
    $('search-wrap').append(h('kbd',{class:'mw-search-key'},'Ctrl K'));
    // No ml-clear listener here: library-ui's choose() already nulls
    // ui.workbenchFilter, so a second one only cost a duplicate render.
  }
  window.MagicWorkbench={init:init,sync:sync,filter:filter,rail:rail,categoryArrow:categoryArrow,openGroup:openGroup,editGroup:editGroup,
    groupRows:groupRows,inspect:inspect,artwork:artwork,onKey:onKey,descriptionData:descriptionData,action:action,customize:customize,
    setPane:setPane,toggleInspector:toggleInspector,setSchool:setSchool,toggleDock:toggleDock,schools:schools};
})();
