/* photo-studio-controls: named compositions and movable GPU viewfinder.
   The transparent viewport is drawn natively BEFORE Prisma; it is never an
   image URL, per-frame JS payload, canvas readback, or PNG stream. */
(function () {
  'use strict';
  var state = { active:false, editing:false, presets:[], bounds:{x:.60,y:.08,w:.34,h:.65} };
  var frame, visible=false, root, preview, viewport, list, search, nameInput, status;
  var drag=null, lastBounds='', signature='', armed='';
  function el(tag, cls, text) {
    var e=document.createElement(tag); if(cls)e.className=cls;if(text)e.textContent=text;return e;
  }
  function send(op, extra) {
    if(!state.active)return;
    var req={op:op,session:state.session};Object.keys(extra||{}).forEach(function(k){req[k]=extra[k];});
    if(window.skyrim&&typeof window.skyrim.photoStudioRequest==='function')window.skyrim.photoStudioRequest(JSON.stringify(req));
  }
  function button(label, fn) {var b=el('button','pst-button',label);b.type='button';b.addEventListener('click',fn);return b;}
  function field(label, id, placeholder) {
    var wrap=el('label','pst-field',label),input=el('input');input.id=id;input.name=id;input.type='text';input.autocomplete='off';input.placeholder=placeholder;
    wrap.appendChild(input);return {wrap:wrap,input:input};
  }
  function need() {
    if(root)return;
    root=el('section','pst-panel');root.id='photo-studio';root.setAttribute('role','dialog');root.setAttribute('aria-label','Camera studio');
    var heading=el('div','pst-heading');heading.appendChild(el('h2','','Camera studio'));
    heading.appendChild(button('Return to framing',function(){send('close');}));root.appendChild(heading);
    root.appendChild(el('p','pst-intro','Save a camera composition. Recall it around your subject wherever they stand.'));
    var subjects=el('div','pst-actions');subjects.appendChild(button('Use player',function(){send('subject',{name:'player'});}));
    var target=button('Use targeted NPC',function(){send('subject',{name:'target'});});target.id='pst-target';subjects.appendChild(target);root.appendChild(subjects);
    root.appendChild(el('p','pst-subject'));root.lastChild.id='pst-subject';
    var sf=field('Find a composition','pst-search','Search by name…');search=sf.input;root.appendChild(sf.wrap);
    search.addEventListener('input',function(){armed='';signature='';renderList();});
    search.addEventListener('keydown',function(e){
      if(e.key==='Enter'){e.preventDefault();var hits=filtered();if(hits.length)send('apply',{name:hits[0].name});}
    });
    list=el('div','pst-list');list.setAttribute('aria-label','Saved camera compositions');root.appendChild(list);
    var nf=field('Name this composition','pst-name','For example, Full outfit…');nameInput=nf.input;nameInput.maxLength=96;root.appendChild(nf.wrap);
    var save=button('Save new composition',function(){send('save',{name:nameInput.value.trim()});});save.id='pst-save';root.appendChild(save);
    nameInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();send('save',{name:nameInput.value.trim()});}});
    var controls=el('div','pst-actions');
    var toggle=button('Enable live preview',function(){send('preview',{on:!state.preview});});toggle.id='pst-toggle';controls.appendChild(toggle);
    controls.appendChild(button('Reset camera',function(){send('resetCamera');}));root.appendChild(controls);
    var position=el('div','pst-position');position.appendChild(el('h3','','Viewfinder placement'));
    position.appendChild(el('p','','Drag its title to move or its corner to resize. These buttons do the same.'));
    var moves=el('div','pst-actions');[['Left',-.03,0],['Right',.03,0],['Up',0,-.03],['Down',0,.03]].forEach(function(v){moves.appendChild(button(v[0],function(){change(v[1],v[2],0);}));});
    position.appendChild(moves);var sizes=el('div','pst-actions');sizes.appendChild(button('Smaller',function(){change(0,0,-.04);}));sizes.appendChild(button('Larger',function(){change(0,0,.04);}));
    sizes.appendChild(button('Reset position',function(){send('resetPreview');}));position.appendChild(sizes);root.appendChild(position);
    status=el('p','pst-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.appendChild(status);
    root.appendChild(el('p','pst-help','F11 / Esc returns to framing. Camera movement resumes when this panel closes. Enter takes the photo while framing.'));
    document.body.appendChild(root);
    preview=el('section','pst-preview');preview.id='pst-preview';preview.setAttribute('aria-label','Live photo viewfinder');
    var bar=el('div','pst-preview-title','LIVE VIEWFINDER');bar.setAttribute('aria-hidden','true');preview.appendChild(bar);
    viewport=el('div','pst-viewport');viewport.setAttribute('role','img');viewport.setAttribute('aria-label','Live GPU image matching the saved photo crop');preview.appendChild(viewport);
    var grid=el('div','pst-grid');
    [1,2].forEach(function(n){var v=el('i','pst-grid-v'),h=el('i','pst-grid-h');v.style.left=(n*100/3)+'%';h.style.top=(n*100/3)+'%';grid.appendChild(v);grid.appendChild(h);});viewport.appendChild(grid);
    ['top','bottom','left','right'].forEach(function(k){var margin=el('i','pst-margin pst-margin-'+k);margin.setAttribute('aria-hidden','true');viewport.appendChild(margin);});
    var resize=button('Resize',function(){change(0,0,.03);});resize.className='pst-resize';resize.setAttribute('aria-label','Enlarge viewfinder; drag to resize');preview.appendChild(resize);
    function begin(e,kind){if(!state.editing||e.button!==0)return;e.preventDefault();drag={kind:kind,x:e.clientX,y:e.clientY,b:Object.assign({},state.bounds)};document.body.classList.add('pst-dragging');}
    bar.addEventListener('mousedown',function(e){begin(e,'move');});resize.addEventListener('mousedown',function(e){begin(e,'size');});
    window.addEventListener('mousemove',function(e){
      // Ultralight reports buttons===0 even during a held drag. Ownership is
      // from mousedown through mouseup/blur, never inferred from buttons.
      if(!drag)return;var dx=(e.clientX-drag.x)/window.innerWidth,dy=(e.clientY-drag.y)/window.innerHeight;
      var b=drag.b;state.bounds=clamp(drag.kind==='move'?{x:b.x+dx,y:b.y+dy,w:b.w,h:b.h}:{x:b.x,y:b.y,w:b.w+dx,h:b.h+dy});layout();publish(false);
    });
    function finish(){if(!drag)return;drag=null;document.body.classList.remove('pst-dragging');publish(true);}
    window.addEventListener('mouseup',finish);window.addEventListener('blur',finish);window.addEventListener('resize',function(){layout();publish(false);});
    document.body.appendChild(preview);
    window.addEventListener('keydown',function(e){
      if(!state.editing)return;
      if(e.key==='Escape'||e.code==='F11'){e.preventDefault();e.stopImmediatePropagation();send('close');}
      else if(e.key==='Tab'){
        var focusables=Array.prototype.slice.call(root.querySelectorAll('button,input')).filter(function(n){return !n.disabled;});
        var i=focusables.indexOf(document.activeElement),next=e.shiftKey?i-1:i+1;
        if(next<0||next>=focusables.length){e.preventDefault();focusables[e.shiftKey?focusables.length-1:0].focus();}
      }
    },true);
  }
  function filtered(){var q=(search?search.value:'').trim().toLowerCase();return (state.presets||[]).filter(function(p){return p&&typeof p.name==='string'&&p.name.toLowerCase().indexOf(q)!==-1;});}
  function renderList() {
    if(!list)return;var hits=filtered(),sig=JSON.stringify([hits,armed,state.loading,state.writable]);if(sig===signature)return;signature=sig;
    while(list.firstChild)list.removeChild(list.firstChild);
    if(!hits.length){list.appendChild(el('p','pst-empty',state.loading?'Loading compositions…':search.value?'No matching compositions.':'No saved compositions yet. Frame your shot, then save it here.'));return;}
    hits.forEach(function(p){var row=el('div','pst-row');
      var recall=button(p.name,function(){send('apply',{name:p.name});});recall.className+=' pst-recall';recall.title='Recall '+p.name;
      var detail=el('span','pst-detail',Math.round(p.fov)+'° · '+(p.format||'square'));recall.appendChild(detail);row.appendChild(recall);
      row.appendChild(button('Update',function(){send('save',{name:p.name,replace:true});}));
      row.appendChild(button(armed===p.name?'Confirm delete':'Delete',function(){if(armed!==p.name){armed=p.name;signature='';renderList();}else{send('delete',{name:p.name,confirm:true});armed='';}}));list.appendChild(row);
    });
  }
  function clamp(b){
    var sw=window.innerWidth,sh=window.innerHeight;
    var w=Math.min(.94,Math.max(Math.min(.9,180/sw),b.w)),h=Math.min(.85,Math.max(Math.min(.75,100/sh),b.h));
    return {x:Math.max(.01,Math.min(1-w-.01,b.x)),y:Math.max(Math.min(.15,50/sh),Math.min(1-h-.02,b.y)),w:w,h:h};
  }
  function layout(){
    if(!preview)return;var b=clamp(state.bounds);state.bounds=b;
    preview.style.left=(b.x*100)+'%';preview.style.top=(b.y*100)+'%';preview.style.width=(b.w*100)+'%';preview.style.height=(b.h*100)+'%';
    preview.classList.toggle('pst-editable',!!state.editing);
    var ratio=frame&&frame.outputWidth&&frame.outputHeight?frame.outputWidth/frame.outputHeight:1;
    var w=b.w*window.innerWidth,h=b.h*window.innerHeight;
    var sourceW=frame&&frame.pixelWidth||w,sourceH=frame&&frame.pixelHeight||h;
    var fit=Math.min(w/sourceW,h/sourceH,1),iw=sourceW*fit,ih=sourceH*fit;
    if(!frame||!frame.pixelWidth){ih=Math.min(h,w/ratio);iw=ih*ratio;}
    var mx=(w-iw)/2,my=(h-ih)/2;
    var grid=viewport.querySelector('.pst-grid');grid.style.left=mx+'px';grid.style.top=my+'px';grid.style.width=iw+'px';grid.style.height=ih+'px';grid.style.display=frame&&frame.thirds?'block':'none';
    ['top','bottom'].forEach(function(k){viewport.querySelector('.pst-margin-'+k).style.height=my+'px';});
    ['left','right'].forEach(function(k){var e=viewport.querySelector('.pst-margin-'+k);e.style.width=mx+'px';e.style.top=my+'px';e.style.bottom=my+'px';});
  }
  function publish(save){
    if(!state.preview||!state.active)return;
    var key=JSON.stringify(state.bounds);if(key===lastBounds&&!save)return;lastBounds=key;
    send('bounds',{bounds:state.bounds,save:!!save});
  }
  function change(dx,dy,size){state.bounds=clamp({x:state.bounds.x+dx,y:state.bounds.y+dy,w:state.bounds.w+size,h:state.bounds.h+size});layout();publish(true);}
  window.photoStudio=function(payload){
    var s;try{s=typeof payload==='string'?JSON.parse(payload):payload;}catch(_){return;}if(!s||typeof s!=='object')return;
    need();var opened=!state.editing&&s.editing;
    if(drag&&s.active){s.bounds=state.bounds;} // late replies cannot rewind a drag
    state=Object.assign({},state,s);if(!state.bounds)state.bounds={x:.60,y:.08,w:.34,h:.65};
    document.body.classList.toggle('pst-editing-active',!!(state.active&&state.editing));
    root.style.display=state.active&&state.editing?'block':'none';root.setAttribute('aria-hidden',state.active&&state.editing?'false':'true');
    preview.style.display=state.active&&state.preview&&!state.previewFailed&&visible?'block':'none';
    document.body.classList.toggle('pst-preview-active',!!(state.active&&state.preview&&!state.previewFailed&&visible));
    status.textContent=(state.message||'')+(state.preview?' '+(state.renderer||''):'');
    document.getElementById('pst-subject').textContent='Relative to: '+(state.subjectName||'Player');
    document.getElementById('pst-target').disabled=!state.targetAvailable||state.loading;
    document.getElementById('pst-save').disabled=!!state.loading||!state.writable;
    document.getElementById('pst-toggle').textContent=state.preview?'Disable live preview':'Enable live preview';
    document.getElementById('pst-toggle').disabled=!!state.loading||!state.writable;
    renderList();layout();publish(false);
    if(opened)search.focus();
    if(!state.active){drag=null;lastBounds='';armed='';document.body.classList.remove('pst-dragging');}
  };
  window.photoStudioFrame=function(s){
    frame=s&&s.frame;visible=!!(s&&s.visible);if(s&&s.studio)window.photoStudio(s.studio);
    else if(preview){preview.style.display=state.active&&state.preview&&!state.previewFailed&&visible?'block':'none';
    document.body.classList.toggle('pst-preview-active',!!(state.active&&state.preview&&!state.previewFailed&&visible));layout();}
  };
})();
