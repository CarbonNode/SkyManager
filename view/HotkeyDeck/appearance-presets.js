/* Shared native / phone appearance gallery. Progress belongs to the current
   character, never a card. All gameplay actions are acknowledged by the DLL. */
(function (global) {
  'use strict';
  var root=null, shell=null, dialog=null, previousFocus=null, dialogFocus=null;
  var config={}, data=null, query='', limit=24, pending=false, timer=null, waiter=null, notice='', failed=false;
  var cardsKey='',quickKey='';
  var actionSerial=0, requestSerial=0, refreshSerial=0, appliedRefresh=0, retiredSessions=[];
  var clientPrefix='looks-'+Date.now()+'-';
  function el(tag,cls,text) { var n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; }
  function button(text,fn,cls) { var b=el('button','looks-btn'+(cls?' '+cls:''),text);b.type='button';b.addEventListener('click',fn);return b; }
  function safe(v) {return typeof v==='string'?v:'';}
  function parse(v) {if(typeof v==='string'){try{return JSON.parse(v);}catch(_){return {};}}return v&&typeof v==='object'?v:{};}
  function capture(on) {if(!config.portal && typeof global.hdCapture==='function')global.hdCapture(on?'1':'0');}
  function list() {return data && Array.isArray(data.looks)?data.looks:[];}
  function matching() {var q=query.trim().toLowerCase();return list().filter(function(r){return !q || (safe(r.name)+' '+safe(r.race&&r.race.name)+' '+safe(r.sos&&r.sos.addon&&r.sos.addon.name)).toLowerCase().indexOf(q)!==-1;}).sort(function(a,b){function rank(r){return data&&r.id===data.normalId?0:data&&r.id===data.quickId?1:2;}return rank(a)-rank(b);});}
  function sosSummary(r) {
    var s=r.sos;
    if(!s||s.mode==='unmanaged')return {name:'SOS not recorded',detail:'Replace this look to capture your current SOS settings.'};
    if(s.mode==='none')return {name:'No SOS add-on',detail:'This look restores SOS without an add-on.'};
    return {name:safe(s.addon&&s.addon.name)||'Saved add-on',detail:s.sizeSource==='racemenu'?'Size follows saved RaceMenu sliders':'Size '+s.size+' of 20'};
  }
  function sosPanel(r) {
    var summary=sosSummary(r),s=r.sos,box=el('div','looks-sos');
    box.appendChild(el('p','looks-label','Saved SOS'));
    var line=el('div','looks-sos-line');line.appendChild(el('p','looks-sos-name',summary.name));box.appendChild(line);
    if(s&&s.mode==='addon') {
      line.appendChild(el('p','looks-sos-size',summary.detail));
      if(s.sizeSource==='sos'&&typeof s.size==='number'&&s.size>=1&&s.size<=20){
        var track=el('div','looks-size-track'),fill=el('span','looks-size-fill');
        track.setAttribute('aria-hidden','true');fill.style.width=(s.size/20*100)+'%';track.appendChild(fill);box.appendChild(track);
      }else box.classList.add('looks-sos-sliders');
    }else {
      box.classList.add('looks-sos-unset');
      box.appendChild(el('p','looks-sos-detail',s&&s.mode==='none'?'No add-on assigned.':'Replace this look to include SOS.'));
    }
    return box;
  }
  function row(id) {return list().find(function(r){return r.id===id;});}
  function blocked() {return pending || !!(data&&data.busy);}
  function online() {return !!(data&&data.online&&data.raceMenu);}
  function request(req) {
    if(config.request)return Promise.resolve().then(function(){return config.request(req);});
    return new Promise(function(resolve,reject){
      if(typeof global.smAppearanceAction!=='function'){reject(new Error('The appearance system is not available in this build.'));return;}
      if(waiter){reject(new Error('Wait for the current appearance action to finish.'));return;}
      waiter={resolve:resolve,reject:reject,id:req.clientRequestId,session:req.session};
      try {global.smAppearanceAction(JSON.stringify(req));}catch(e){waiter=null;reject(e);}
    });
  }
  function stopTimer() {if(!root&&!pending&&timer){clearInterval(timer);timer=null;}}
  function watchState() {if(timer)return;timer=setInterval(function(){if((root&&!dialog)||pending)refresh();if(root&&!config.portal&&!document.body.classList.contains('open'))close();stopTimer();},2500);}
  function accept(value) {
    var r=parse(value),next=r.data?parse(r.data):Array.isArray(r.looks)?r:null;
    var incoming=safe(next&&next.session)||safe(r.cancelled&&r.session),previous=safe(data&&data.session);
    if(incoming&&retiredSessions.indexOf(incoming)!==-1)return r;
    if(incoming&&previous&&incoming!==previous) {
      retiredSessions.push(previous);if(retiredSessions.length>16)retiredSessions.shift();
      ++actionSerial;pending=false;var old=waiter;waiter=null;
      if(old)old.resolve({ok:false,cancelled:true});
      closeDialog();notice='The loaded save changed. The previous appearance action was cancelled.';failed=false;
      if(!next)next=Object.assign({},data,{session:incoming,busy:false,online:false,selectedId:'',undo:false});
    }
    if(next)data=next;if(root)render();stopTimer();return r;
  }
  global.smAppearanceData=function(value){accept(value);};
  global.smAppearanceResult=function(value){var r=parse(value),w=waiter;
    if(!w||r.clientRequestId!==w.id||(r.requestSession&&w.session&&r.requestSession!==w.session))return;
    waiter=null;w.resolve(r);
  };
  function refresh() {
    var refreshId=++refreshSerial;
    if(config.request) return Promise.resolve().then(function(){return config.request({op:'get'});}).then(function(r){if(refreshId<appliedRefresh)return;appliedRefresh=refreshId;accept(r);}).catch(function(e){if(refreshId<appliedRefresh)return;notice=e.message;failed=true;if(root)render();});
    if(typeof global.smAppearanceGet==='function')global.smAppearanceGet('');
    else {notice='The appearance system is not available in this build.';failed=true;render();}
    return Promise.resolve();
  }
  function execute(req,onSuccess) {
    if(blocked())return Promise.resolve(false);
    var generation=++actionSerial;
    req=Object.assign({},req,{clientRequestId:clientPrefix+(++requestSerial),session:safe(data&&data.session)});
    pending=true;notice='Waiting for Skyrim…';failed=false;closeDialog();render();watchState();
    return request(req).then(function(value){
      if(generation!==actionSerial)return false;
      var r=accept(value);if(generation!==actionSerial)return false;
      pending=false;failed=!r.ok;notice=r.msg || r.error || (r.ok?'Done.':'The action could not finish.');
      if(root)render();stopTimer();if(r.ok&&onSuccess&&root)onSuccess(r);return !!r.ok;
    },function(e){if(generation!==actionSerial)return false;pending=false;failed=true;notice=e.message || 'The request could not reach Skyrim.';if(root)render();stopTimer();return false;});
  }
  function lookRequest(op,r,extra) {return Object.assign({op:op,id:r.id,expected:r.slot,expectedRevision:r.revision||0},extra||{});}
  function portraitUrl(r) {return config.portraitUrl?config.portraitUrl(r):safe(r.portrait);}
  function thumb(r) {
    var box=el('div','looks-photo');
    function placeholder(missing){var badge=box.querySelector('.looks-badge');box.textContent='';var p=el('div','looks-no-photo');p.appendChild(el('span','looks-monogram',(safe(r.name).trim()[0]||'A').toUpperCase()));p.appendChild(el('span','looks-photo-note',missing?'Portrait unavailable. You can take a new one.':'Give this look its own portrait.'));box.appendChild(p);if(badge)box.appendChild(badge);}
    if(r.portrait){var img=el('img');img.src=portraitUrl(r);img.alt='Portrait of '+safe(r.name);img.width=600;img.height=750;img.loading='lazy';img.onerror=function(){placeholder(true);};box.appendChild(img);}else placeholder(false);
    if(data && data.selectedId===r.id)box.appendChild(el('span','looks-badge','Last selected'));
    return box;
  }
  function card(r) {
    var c=el('article','looks-card'+(data.selectedId===r.id?' looks-selected':''));c.setAttribute('data-look-id',r.id);c.appendChild(thumb(r));
    var body=el('div','looks-card-body'),identity=el('div','looks-card-identity');identity.appendChild(el('h3','',safe(r.name)));
    identity.appendChild(el('p','looks-race',safe(r.race&&r.race.name)||'Unknown race'));
    if(r.id===data.normalId)identity.appendChild(el('p','looks-role-label','Protected normal form'));
    else if(r.id===data.quickId)identity.appendChild(el('p','looks-role-label','Quick form'));
    body.appendChild(identity);
    body.appendChild(sosPanel(r));
    if(r.available===false)body.appendChild(el('p','looks-unavailable',safe(r.availableReason)||'Race mod or saved appearance unavailable'));
    var actions=el('div','looks-card-actions');
    var sw=button(data.selectedId===r.id?'Apply this look again':'Switch look',function(){execute(lookRequest('switch',r));},'looks-primary looks-switch');
    sw.disabled=blocked()||!online()||r.available===false;actions.appendChild(sw);
    var photo=button(r.portrait?'Retake portrait':'Take portrait',function(){photoDialog(r);});photo.disabled=blocked()||!online()||r.available===false;actions.appendChild(photo);
    var manage=button('Manage',function(){manageDialog(r);});manage.disabled=blocked();manage.setAttribute('aria-label','Manage '+safe(r.name));actions.appendChild(manage);
    body.appendChild(actions);c.appendChild(body);return c;
  }
  function renderCards() {
    if(!root)return;var scroll=root.querySelector('.looks-scroll');if(!scroll)return;
    var key=JSON.stringify([list(),data&&data.ok,data&&data.selectedId,data&&data.normalId,data&&data.quickId,blocked(),online(),query,limit]);
    if(key===cardsKey)return;cardsKey=key;
    var focus=document.activeElement,focusId=focus&&focus.closest&&focus.closest('[data-look-id]'),focusText=focus&&focus.textContent;
    scroll.textContent='';var rows=matching();root.querySelector('.looks-count').textContent=rows.length+(rows.length===1?' look':' looks');
    if(!data || data.ok===false || !rows.length){
      var empty=el('div','looks-empty');
      var title=!data?'Loading your looks…':data.ok===false?'Your library needs attention':query?'No matching looks':'Keep every version of yourself.';
      var detail=!data?'Reading your saved appearances.':data.ok===false?(data.msg||'Your saved files have not been changed.'):query?'Try a name, race or SOS type, or clear your search.':'Save your current look first. Then customize, save another, and switch between them here.';
      empty.appendChild(el('h3','',title));empty.appendChild(el('p','',detail));
      var actions=el('div','looks-actions');
      if(query)actions.appendChild(button('Clear search',function(){query='';root.querySelector('.looks-search').value='';renderCards();root.querySelector('.looks-search').focus();}));
      else if(data&&data.ok!==false){var save=button('Save my current look',saveDialog,'looks-primary');save.disabled=blocked()||!online();actions.appendChild(save);}
      else if(data)actions.appendChild(button('Try again',refresh));
      empty.appendChild(actions);scroll.appendChild(empty);return;
    }
    var grid=el('div','looks-grid');rows.slice(0,limit).forEach(function(r){grid.appendChild(card(r));});scroll.appendChild(grid);
    if(rows.length>limit)scroll.appendChild(button('Show more looks',function(){limit+=24;renderCards();},'looks-more'));
    if(focusId){var next=Array.prototype.find.call(scroll.querySelectorAll('[data-look-id]'),function(n){return n.getAttribute('data-look-id')===focusId.getAttribute('data-look-id');});if(next){var b=Array.prototype.find.call(next.querySelectorAll('button'),function(n){return n.textContent===focusText;});if(b)b.focus();}}
  }
  function renderQuick() {
    var host=root.querySelector('.looks-quickbar'),normal=data&&row(data.normalId),quick=data&&row(data.quickId),next=data&&row(data.nextQuickId);
    var key=JSON.stringify([normal&&[normal.id,normal.name,normal.available],quick&&[quick.id,quick.name,quick.available],next&&next.id,blocked(),online()]);
    if(key===quickKey)return;quickKey=key;host.textContent='';host.hidden=!normal&&!quick;if(host.hidden)return;
    var text=el('div','looks-quick-copy');text.appendChild(el('p','looks-label','Your forms'));
    text.appendChild(el('p','',normal&&quick?'Normal: '+normal.name+' / Quick: '+quick.name:'Choose both forms in Manage to enable quick switching.'));host.appendChild(text);
    var actions=el('div','looks-actions');
    var toggle=button(next?'Switch to '+next.name:'Quick switch',function(){execute({op:'quick'});},'looks-primary looks-quick-toggle');
    toggle.disabled=blocked()||!online()||!normal||!quick||!next||normal.available===false||quick.available===false;actions.appendChild(toggle);
    var back=button(normal?'Return to '+normal.name:'Return to normal',function(){execute({op:'normal'});},'looks-normal-return');
    back.disabled=blocked()||!online()||!normal||normal.available===false;actions.appendChild(back);host.appendChild(actions);
  }
  function render() {
    if(!root)return;
    var busy=blocked(), enabled=online();
    root.querySelector('.looks-save').disabled=busy||!enabled;
    root.querySelector('.looks-customize').disabled=busy||!enabled||!data.customizeAvailable;
    root.querySelector('.looks-undo').hidden=!(data&&data.undo);
    root.querySelector('.looks-undo').disabled=busy||!enabled;
    var status=root.querySelector('.looks-status');
    var info=notice || (data&&data.msg) || 'Saved looks change appearance and race. Your current progress is kept.';
    if(data&&data.busy)info=data.phase || 'Waiting for Skyrim…';
    else if(!enabled && !pending)info=config.portal?'Launch Skyrim with a save loaded to switch or photograph a look.':'Load your character with RaceMenu enabled to save or switch looks.';
    status.textContent=info;status.className='looks-status'+(failed?' looks-error':'');
    root.querySelector('.looks-live').textContent=data&&data.currentRace?'Now: '+data.currentRace:'Your appearance collection';
    root.querySelector('.looks-scroll').setAttribute('aria-busy',String(busy));renderQuick();renderCards();
  }
  function closeDialog() {if(!dialog)return;dialog.remove();dialog=null;if(shell)shell.removeAttribute('aria-hidden');if(dialogFocus&&document.contains(dialogFocus))dialogFocus.focus();dialogFocus=null;}
  function dialogBase(title,description) {
    closeDialog();dialogFocus=document.activeElement;
    dialog=el('div','looks-dialog-back');var panel=el('section','looks-dialog');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','looks-dialog-title');
    var heading=el('h2','',title);heading.id='looks-dialog-title';panel.appendChild(heading);
    if(description)panel.appendChild(el('p','',description));dialog.appendChild(panel);root.appendChild(dialog);shell.setAttribute('aria-hidden','true');
    dialog.addEventListener('click',function(e){if(e.target===dialog)closeDialog();});return panel;
  }
  function focusDialog() {var n=dialog&&dialog.querySelector('input,button');if(n)n.focus();}
  function nameDialog(title,description,name,submit,withPhoto) {
    var panel=dialogBase(title,description),form=el('form');var label=el('label','','Look name');label.htmlFor='looks-name';
    var input=el('input','looks-input');input.id='looks-name';input.name='lookName';input.value=name||'';input.maxLength=160;input.autocomplete='off';input.placeholder='Nord, Minotaur, Ash wanderer…';
    var error=el('div','looks-dialog-error');error.setAttribute('role','status');error.setAttribute('aria-live','polite');
    form.appendChild(label);form.appendChild(input);form.appendChild(error);var actions=el('div','looks-actions');actions.appendChild(button('Cancel',closeDialog));var save=button('Save look',function(){submitName(false);},withPhoto?'':'looks-primary');actions.appendChild(save);
    if(withPhoto)actions.appendChild(button('Save & take portrait',function(){submitName(true);},'looks-primary'));
    form.appendChild(actions);panel.appendChild(form);
    function submitName(takePhoto){var name=input.value.trim();if(!name){error.textContent='Give this look a name.';input.focus();return;}submit(name,!!takePhoto);}
    form.addEventListener('submit',function(e){e.preventDefault();submitName(!!withPhoto);});focusDialog();
  }
  function saveDialog() {nameDialog('Save your current look','Save your face, race, body and current SOS settings. Choose “Save & take portrait” to frame your photo straight afterward; Escape skips the photo and keeps the saved look. Equipment and current progress stay with your character.','',function(name,takePhoto){execute({op:'save',name:name,takePortrait:takePhoto});},true);}
  function customizeDialog() {
    var panel=dialogBase('Make your next look','ShowRaceMenu Alternative opens its customization room. Change your race and appearance there, then return here and save the result. Your existing looks stay in the gallery.');
    panel.appendChild(el('p','','SkyManager keeps a recovery look and protects your skills, XP, legendary counts and perk points while you edit.'));
    var actions=el('div','looks-actions');actions.appendChild(button('Back',closeDialog));actions.appendChild(button('Open customization',function(){execute({op:'customize'});},'looks-primary'));panel.appendChild(actions);focusDialog();
  }
  function photoDialog(r) {
    var isSelected=data.selectedId===r.id;
    var panel=dialogBase('Portrait for '+safe(r.name),isSelected?'The gallery will close so you can frame your character. Press Enter to take the picture, or Escape to cancel.':'Switch to this saved look first, then take its portrait. Each look keeps its own picture.');
    var actions=el('div','looks-actions');actions.appendChild(button('Back',closeDialog));
    actions.appendChild(button(isSelected?'Start portrait':'Switch to this look',function(){execute(lookRequest(isSelected?'portrait':'switch',r));},'looks-primary'));panel.appendChild(actions);focusDialog();
  }
  function confirmDialog(title,detail,label,fn) {var panel=dialogBase(title,detail);var actions=el('div','looks-actions');actions.appendChild(button('Keep it',closeDialog));actions.appendChild(button(label,fn,'looks-danger'));panel.appendChild(actions);focusDialog();}
  function manageDialog(r) {
    var panel=dialogBase(safe(r.name),safe(r.race&&r.race.name)+' · '+(r.sex===1?'Female':'Male'));
    panel.appendChild(sosPanel(r));
    var protectedLook=data.normalId===r.id,quick=data.quickId===r.id,actions=el('div','looks-manage-actions');
    if(protectedLook)panel.appendChild(el('p','looks-protection','Your normal form is protected. Unpin it before changing its saved appearance or SOS settings, or removing it.'));
    actions.appendChild(button(protectedLook?'Unpin normal form':'Pin as normal form',function(){
      var previous=row(data.normalId),detail=protectedLook?'This unlocks “'+r.name+'” for editing. It stays in your library.':previous?'“'+r.name+'” will become your protected normal form. “'+previous.name+'” will be unlocked.':'Protect “'+r.name+'” from replacement or removal, and use it for Return to normal. Your character will not change.';
      confirmDialog(protectedLook?'Unpin your normal form?':'Set your normal form?',detail,protectedLook?'Unpin form':'Pin normal form',function(){execute(lookRequest('role',r,{role:'normal',libraryRevision:data.revision,confirm:true}));});
    }));
    var quickButton=button(quick?'Remove quick-form pin':'Use as quick form',function(){execute(lookRequest('role',r,{role:'quick',libraryRevision:data.revision}));});quickButton.disabled=protectedLook;actions.appendChild(quickButton);
    var sos=button('Edit saved SOS settings',function(){execute(lookRequest('sos-options',r),function(result){sosDialog(row(r.id)||r,result.options);});});sos.disabled=!online()||protectedLook;actions.appendChild(sos);
    actions.appendChild(button('Rename look',function(){nameDialog('Rename look','Only the name changes.',r.name,function(name){execute(lookRequest('rename',r,{name:name}));});}));
    var replace=button('Replace with my current appearance',function(){confirmDialog('Replace this saved look?','The saved appearance for “'+safe(r.name)+'” will become the character you are wearing now. Its portrait is cleared so it cannot show the wrong look.','Replace look',function(){execute(lookRequest('replace',r,{name:r.name,confirm:true}));});});replace.disabled=!online()||protectedLook;actions.appendChild(replace);
    var remove=button('Remove from library',function(){confirmDialog('Remove “'+safe(r.name)+'”?','This removes the gallery entry. It does not change your character. The original preset and portrait files are kept.','Remove look',function(){execute(lookRequest('delete',r,{confirm:true}));});},'looks-danger');remove.disabled=protectedLook;actions.appendChild(remove);
    panel.appendChild(actions);var foot=el('div','looks-actions');foot.appendChild(button('Done',closeDialog));panel.appendChild(foot);focusDialog();
  }
  function sosDialog(r,options) {
    options=parse(options);var choices=Array.isArray(options.choices)?options.choices:[],s=r.sos||{};
    var selectedKey=s.mode==='none'?'none':s.mode==='addon'?safe(s.addon.plugin)+'|'+s.addon.localId+'|'+safe(s.addon.editorId):'';
    var panel=dialogBase('SOS for '+r.name,'Edit this saved look, then apply it to see the change. Its face, body preset and portrait are kept; retake the portrait after applying if needed.');
    var label=el('label','','Compatible add-on');label.htmlFor='looks-addon-search';panel.appendChild(label);
    var search=el('input','looks-input');search.id='looks-addon-search';search.name='sosAddonSearch';search.type='search';search.placeholder='Search compatible add-ons…';search.autocomplete='off';panel.appendChild(search);
    var results=el('div','looks-addon-list');results.setAttribute('role','group');results.setAttribute('aria-label','Compatible SOS add-ons');panel.appendChild(results);
    var all=[{key:'none',addon:{name:'No SOS add-on'}}].concat(choices),shown=[];
    var sizeBox=el('div','looks-size-editor'),sizeLabel=el('label','','Size (1–20)');sizeLabel.htmlFor='looks-sos-size-input';sizeBox.appendChild(sizeLabel);
    var controls=el('div','looks-size-controls'),size=el('input','looks-input');size.id='looks-sos-size-input';size.name='sosSize';size.autocomplete='off';size.type='number';size.inputMode='numeric';size.min='1';size.max='20';size.step='1';size.value=String(s.size||10);
    var smaller=button('Smaller',function(){size.value=String(Math.max(1,Math.min(20,Number(size.value)||10)-1));});
    var larger=button('Larger',function(){size.value=String(Math.min(20,Math.max(1,Number(size.value)||10)+1));});
    controls.appendChild(smaller);controls.appendChild(size);controls.appendChild(larger);sizeBox.appendChild(controls);
    var sizeNote=el('p','looks-editor-note',options.sizeSource==='racemenu'?'Size follows this look’s saved RaceMenu sliders. Customize and save the look to change those sliders.':'This changes the saved SOS rank only. Your live character changes when you apply the look.');sizeBox.appendChild(sizeNote);panel.appendChild(sizeBox);
    var error=el('p','looks-dialog-error');error.setAttribute('role','status');panel.appendChild(error);
    function select(key){var restore=results.contains(document.activeElement);selectedKey=key;draw();if(restore){var active=results.querySelector('[aria-pressed="true"]');if(active)active.focus();}}
    function draw(){
      var q=search.value.trim().toLowerCase();shown=all.filter(function(c){return !q||safe(c.addon&&c.addon.name).toLowerCase().indexOf(q)!==-1;});results.textContent='';
      shown.forEach(function(c){var b=button(safe(c.addon&&c.addon.name)||'Saved add-on',function(){select(c.key);},'looks-addon-option');b.setAttribute('aria-pressed',String(selectedKey===c.key));results.appendChild(b);});
      if(!shown.length)results.appendChild(el('p','looks-editor-note','No compatible add-ons match this search.'));
      controls.hidden=options.sizeSource==='racemenu';sizeLabel.hidden=options.sizeSource==='racemenu';
      size.disabled=smaller.disabled=larger.disabled=selectedKey==='none'||!selectedKey;
    }
    search.addEventListener('input',draw);search.addEventListener('keydown',function(e){if(e.key==='Enter'&&shown.length){e.preventDefault();select(shown[0].key);}});
    var actions=el('div','looks-actions');actions.appendChild(button('Cancel',closeDialog));actions.appendChild(button('Save SOS settings',function(){
      var value=Number(size.value);if(!all.some(function(c){return c.key===selectedKey;})){error.textContent='Choose a compatible add-on or No SOS add-on.';return;}
      if(selectedKey!=='none'&&options.sizeSource==='sos'&&(!Number.isInteger(value)||value<1||value>20)){error.textContent='Choose a whole-number size from 1 to 20.';size.focus();return;}
      execute(lookRequest('sos-save',r,{addonKey:selectedKey,size:value}));
    },'looks-primary'));panel.appendChild(actions);draw();focusDialog();
  }
  function helpDialog() {
    var panel=dialogBase('What travels with a look','Race, sex, face, hair, weight, RaceMenu body morphs, node adjustments, skin overrides, and saved SOS type and size. Your equipment stays equipped.');
    panel.appendChild(el('p','','Each switch protects the progress you have right now: skills and their XP, legendary counts, level XP, learned perks, perk points and base health, magicka and stamina. Returning to an old look never loads an old level.'));
    panel.appendChild(el('p','','SOS settings are captured when you save or replace a look, then restored automatically when you switch or Undo. Set them once in SOS before saving. If RaceMenu controls size, its saved sliders supply the shape. Older cards say “SOS not recorded”; replace each while wearing its intended appearance to add SOS settings.'));
    panel.appendChild(el('p','','HIMBO shapes require morph-enabled meshes. Armor still needs to support the chosen race and body; a preset cannot make every helmet fit horns. Other mods may manage separate settings.'));
    panel.appendChild(el('p','','Race abilities follow the race and its mods. A previous look is kept for Undo during this game session. Keep a normal save for your first cross-race test.'));
    panel.appendChild(el('p','','Pin your original look as Normal form and another as Quick form in Manage. Bind “Appearance: Quick switch” or “Appearance: Return to normal” in Hotkeys. Use an unused key: Skyrim still receives its normal game binding. Same-race forms use the last selected look; Return to normal always chooses your pinned original.'));
    var actions=el('div','looks-actions');actions.appendChild(button('Got it',closeDialog,'looks-primary'));panel.appendChild(actions);focusDialog();
  }
  function onKey(e) {
    if(!root)return false;
    if(e.key==='Escape' || e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(dialog)closeDialog();else close();return true;}
    if(e.key==='Tab') {
      var scope=dialog||shell;var buttons=Array.prototype.filter.call(scope.querySelectorAll('button,input,a[href]'),function(n){return !n.disabled&&!n.hidden&&n.offsetParent!==null;});
      if(buttons.length){var at=buttons.indexOf(document.activeElement),next=(at+(e.shiftKey?-1:1)+buttons.length)%buttons.length;e.preventDefault();buttons[next].focus();}e.stopImmediatePropagation();return true;
    }
    if(!dialog&&(e.key==='Enter'||e.code==='Enter')&&document.activeElement===root.querySelector('.looks-search')){e.preventDefault();var r=matching()[0];if(r&&online()&&!blocked()&&r.available!==false)execute({op:'switch',id:r.id,expected:r.slot});}
    // Host's capture handler explicitly yields while this modal is open. Keep
    // digits and letters available to the focused input, never deck hotkeys.
    return true;
  }
  function open(options) {
    if(root){root.querySelector('.looks-search').focus();return;}
    if(options)config=Object.assign({},config,options);previousFocus=document.activeElement;cardsKey='';quickKey='';
    root=el('div','looks-backdrop'+(config.portal?'':' looks-native'));root.id='appearance-gallery';
    shell=el('section','looks-shell');shell.setAttribute('role','dialog');shell.setAttribute('aria-modal','true');shell.setAttribute('aria-labelledby','looks-title');root.appendChild(shell);
    var header=el('header','looks-header'),heading=el('div','looks-heading');heading.appendChild(el('p','looks-eyebrow','Character / Collection'));var title=el('h1','looks-title','Appearances');title.id='looks-title';heading.appendChild(title);heading.appendChild(el('p','looks-subtitle','Your saved faces and forms.'));header.appendChild(heading);
    var actions=el('div','looks-actions');actions.appendChild(button('Customize current',customizeDialog,'looks-customize'));actions.appendChild(button('Save current look',saveDialog,'looks-primary looks-save'));header.appendChild(actions);header.appendChild(button('Close',close,'looks-close'));shell.appendChild(header);
    shell.appendChild(el('div','looks-quickbar'));
    var toolbar=el('div','looks-toolbar'),wrap=el('div','looks-search-wrap');var label=el('label','looks-sr','Search saved looks');label.htmlFor='looks-search';var search=el('input','looks-input looks-search');search.id='looks-search';search.name='appearanceSearch';search.type='search';search.autocomplete='off';search.spellcheck=false;search.placeholder='Search by name, race or SOS…';search.value=query;wrap.appendChild(label);wrap.appendChild(search);toolbar.appendChild(wrap);toolbar.appendChild(el('span','looks-count',''));shell.appendChild(toolbar);
    search.addEventListener('input',function(){query=search.value;limit=24;renderCards();});
    var scroll=el('div','looks-scroll');shell.appendChild(scroll);
    var footer=el('footer','looks-footer'),text=el('div');text.appendChild(el('p','looks-live'));var status=el('p','looks-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');text.appendChild(status);footer.appendChild(text);var links=el('div','looks-actions');links.appendChild(button('Undo last switch',function(){execute({op:'undo'});},'looks-undo'));links.appendChild(button('About saved looks',helpDialog));footer.appendChild(links);shell.appendChild(footer);
    document.body.appendChild(root);capture(true);document.addEventListener('keydown',onKey,true);render();
    // Do not summon the phone keyboard over the portraits just by opening.
    if(config.portal && global.innerWidth<=560){shell.tabIndex=-1;shell.focus();}else search.focus();refresh();
    watchState();
  }
  function close() {if(!root)return;closeDialog();root.remove();root=null;shell=null;stopTimer();document.removeEventListener('keydown',onKey,true);capture(false);if(previousFocus&&document.contains(previousFocus))previousFocus.focus();previousFocus=null;}
  global.AppearanceGallery={open:open,close:close,isOpen:function(){return !!root;},onKey:onKey,configure:function(o){config=Object.assign({},config,o);},refresh:refresh,
    _test:{accept:accept,matching:matching,execute:execute,blocked:blocked}};
})(window);
