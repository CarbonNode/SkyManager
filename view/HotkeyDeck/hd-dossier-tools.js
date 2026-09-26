/* Dossier tools: stable action pins, existing Wardrobe outfit references and a
 * page-only portrait selection. The host owns persistence and game verbs.
 * All adapter calls carry the mounted actor ID; late results cannot repaint a
 * different NPC. No backend mechanics or global portrait assignment live here. */
(function () {
  'use strict';
  var active = null, sequence = 0;
  var SLOTS = [{id:'everyday',label:'Everyday'}, {id:'travel',label:'Travel'}, {id:'combat',label:'Combat'}];
  function el(tag, cls, text) { var n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=String(text); return n; }
  function append(n) { for(var i=1;i<arguments.length;i++)if(arguments[i])n.appendChild(arguments[i]); return n; }
  function clear(n) { while(n.firstChild)n.removeChild(n.firstChild); }
  function button(label, fn, cls) { var b=el('button','hddt-button'+(cls?' '+cls:'')); if(label)b.appendChild(el('span','hddt-label',label)); b.type='button'; b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();fn();}); return b; }
  function actionIcon(b,path) {if(typeof path!=='string'||!(/^(?:icons\/custom\/[a-z0-9_-]+\.png|\/api\/view-icon\?)/i.test(path)))return;var img=el('img','hddt-action-icon');img.src=path;img.alt='';img.width=28;img.height=28;img.setAttribute('aria-hidden','true');img.addEventListener('error',function(){img.hidden=true;});b.insertBefore(img,b.firstChild);}
  function msg(n,text,bad) { n.textContent=text||''; n.classList.toggle('hddt-error',!!bad); }
  function status() { var n=el('p','hddt-status');n.setAttribute('role','status');n.setAttribute('aria-live','polite');return n; }
  function read(o,key,fallback) { try {return typeof o[key]==='function'?o[key]():fallback;}catch(_){return fallback;} }
  function safeImage(path) { return typeof path==='string' && /^(portraits|icons\/npcs)\/[a-z0-9 _~().@+-]+\.(png|jpe?g|webp)$/i.test(path); }
  function portraitRows(o) { var seen={}; return (read(o,'getPortraits',[])||[]).filter(function(p){if(!p||!safeImage(p.file)||seen[p.file])return false;seen[p.file]=true;return true;}); }
  function outfitRows(o) { var seen={};return (read(o,'getOutfits',[])||[]).filter(function(p){var id=p&&(p.id||p.name);if(!id||seen[id])return false;seen[id]=true;return true;}); }
  function outfitId(p) {return String(p.id||p.name||'');}
  function cleanPins(pins) {return (Array.isArray(pins)?pins:[]).filter(function(x,i,a){return typeof x==='string'&&x&&a.indexOf(x)===i;}).slice(0,4);}
  function context(host,o) {
    var actor=String(read(o,'getActorId','')), dead=false, busy=false, revision=0;
    var own=el('div','hddt-tools'), notice=status();append(host,own);
    var c={host:host,root:own,o:o,actor:actor,notice:notice,paint:function(){},
      valid:function(){return !dead && !!actor && actor===String(read(o,'getActorId',''));},
      person:function(){return read(o,'getPerson',{})||{};},
      run:function(fn,args,success){
        if(!c.valid()||busy)return; if(typeof o[fn]!=='function'){msg(notice,'This control is unavailable. Reopen the page after the module loads.',true);return;}
        busy=true; var token=++revision; own.setAttribute('aria-busy','true');msg(notice,'Working…');
        Array.prototype.forEach.call(own.querySelectorAll('button'),function(b){b.disabled=true;});
        var result;try{result=o[fn].apply(null,(args||[]).concat(actor));}catch(e){result=Promise.reject(e);}
        Promise.resolve(result).then(function(r){
          if(!c.valid()||token!==revision)return;busy=false;own.removeAttribute('aria-busy');c.paint();
          if(r&&r.ok===false){msg(notice,r.msg||'The change was refused. Try again after refreshing.',true);return;}
          msg(notice,(r&&r.msg)||'Saved.');if(success)success(r);
        },function(e){if(!c.valid()||token!==revision)return;busy=false;own.removeAttribute('aria-busy');c.paint();msg(notice,e&&e.message||'Unable to complete this change. Try again.',true);});
      },
      refresh:function(){if(c.valid()&&!busy)c.paint();},
      destroy:function(){dead=true;revision++;if(active&&active.owner===c)closeOverlays();if(own.parentNode)own.parentNode.removeChild(own);}
    };return c;
  }
  function closeOverlays() { if(!active)return;var a=active;active=null;document.removeEventListener('keydown',key,true);if(a.back.parentNode)a.back.parentNode.removeChild(a.back);if(a.returnTo&&a.returnTo.isConnected!==false)a.returnTo.focus(); }
  function key(e) {
    if(!active)return false;
    if(e.key==='Escape'){closeOverlays();}
    else if(e.key==='Tab'){
      var nodes=Array.prototype.filter.call(active.box.querySelectorAll('button,input'),function(n){return !n.disabled&&!n.hidden;});
      var at=nodes.indexOf(document.activeElement), next=e.shiftKey?(at<=0?nodes.length-1:at-1):(at+1)%nodes.length;
      if(nodes[next])nodes[next].focus();
    }else {return true;}
    e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();e._fdDossierHandled=true;return true;
  }
  function dialog(c,title,hint) {
    closeOverlays(); var returnTo=document.activeElement, back=el('div','hddt-back'), box=el('section','hddt-dialog'), titleId='hddt-title-'+(++sequence);
    box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby',titleId);
    var heading=el('h2','',title);heading.id=titleId;
    var close=button('Close',closeOverlays), top=append(el('header','hddt-dialog-head'),heading,close), note=status();
    append(box,top,el('p','hddt-muted',hint));append(back,box);document.body.appendChild(back);
    active={owner:c,back:back,box:box,returnTo:returnTo,notice:note};document.addEventListener('keydown',key,true);
    back.addEventListener('mousedown',function(e){if(e.target===back)closeOverlays();});close.focus();
    return {box:box,notice:note,alive:function(){return c.valid()&&active&&active.box===box;}};
  }
  function searchBox(label,change) {var input=el('input','hddt-search');input.type='search';input.name='dossier-search';input.autocomplete='off';input.setAttribute('aria-label',label);input.placeholder=label+'…';input.addEventListener('input',function(){change(input.value.toLowerCase().trim());});return input;}
  function modalSave(c,d,fn,args) {
    if(!d.alive())return;
    if(typeof c.o[fn]!=='function'){msg(d.notice,'This control is unavailable. Refresh the page and try again.',true);return;}
    if(d.busy)return;d.busy=true;msg(d.notice,'Saving…');
    var controls=Array.prototype.map.call(d.box.querySelectorAll('button,input'),function(n){var pair=[n,!!n.disabled];n.disabled=true;return pair;});
    function restore(){controls.forEach(function(pair){pair[0].disabled=pair[1];});}
    var r;try{r=c.o[fn].apply(null,args.concat(c.actor));}catch(e){r=Promise.reject(e);}
    Promise.resolve(r).then(function(result){if(!d.alive())return;d.busy=false;
      if(result&&result.ok===false){msg(d.notice,result.msg||'The change was refused.',true);restore();return;}
      closeOverlays();c.refresh();msg(c.notice,result&&result.msg||'Saved.');
    },function(e){if(!d.alive())return;d.busy=false;msg(d.notice,e&&e.message||'Unable to save. Try again.',true);restore();});
  }
  function pinsPicker(c) {
    var draft=cleanPins(c.person().pins), d=dialog(c,'Pinned actions','Choose up to four actions for this NPC. Their current availability is checked each time you use them.'), list=el('div','hddt-list'), q='';
    function paint(){clear(list);var rows=(read(c.o,'getActions',[])||[]).filter(function(a){return a&&a.id&&String(a.label||a.id).toLowerCase().indexOf(q)!==-1;});
      rows.slice(0,80).forEach(function(a){var picked=draft.indexOf(a.id)!==-1,b=button(a.label||a.id,function(){var at=draft.indexOf(a.id);if(at!==-1)draft.splice(at,1);else if(draft.length<4)draft.push(a.id);else{msg(d.notice,'Four actions are pinned. Remove one before adding another.',true);return;}msg(d.notice,draft.length+' / 4 selected');paint();},'hddt-choice');b.setAttribute('aria-pressed',String(picked));b.title=a.reason||'';actionIcon(b,a.icon);append(b,el('span','hddt-choice-state',picked?'Pinned':'Pin'));append(list,b);});
      if(!rows.length)append(list,el('p','hddt-muted','No matching actions.'));if(rows.length>80)append(list,el('p','hddt-muted','Showing 80 matches. Refine your search.'));
    }
    var input=searchBox('Find an action',function(v){q=v;paint();});input.addEventListener('keydown',function(e){if(e.key==='Enter'){var b=list.querySelector('button');if(b)b.click();e.preventDefault();}});
    append(d.box,input,list,d.notice,button('Save pins',function(){modalSave(c,d,'savePins',[draft.slice()]);},'hddt-primary'));paint();
  }
  function mountPins(host,o) {
    var c=context(host,o);c.paint=function(){clear(c.root);var actions=read(o,'getActions',[])||[],line=el('div','hddt-pins');
      cleanPins(c.person().pins).forEach(function(id){var a=actions.filter(function(x){return x.id===id;})[0];var b=button(a?a.label:id,function(){var fresh=(read(o,'getActions',[])||[]).filter(function(x){return x.id===id;})[0];if(!fresh||fresh.disabled){msg(c.notice,fresh&&fresh.reason||'This action is unavailable for this NPC.',true);return;}c.run('runAction',[id]);});b.disabled=!a||!!a.disabled;b.title=a&&a.reason||(!a?'This action is no longer available. Edit pins to remove it.':'');if(a)actionIcon(b,a.icon);append(line,b);});
      append(line,button('Edit pins',function(){if(c.valid())pinsPicker(c);},'hddt-quiet'));append(c.root,line,c.notice);
    };c.paint();return c;
  }
  function mountGallery(host,o) {
    var c=context(host,o),q='';c.paint=function(){clear(c.root);var top=append(el('div','hddt-heading'),el('h3','','Portrait gallery'),button(o.captureLabel||'Capture portrait',function(){c.run('capturePortrait');}));
      var list=el('div','hddt-gallery');function paintRows(){clear(list);var selected=(c.person().portrait||{}).file||'',rows=portraitRows(o).filter(function(p){return String((p.label||'')+' '+p.file).toLowerCase().indexOf(q)!==-1;});
        rows.slice(0,48).forEach(function(p){var b=button('',function(){if(c.valid())c.run('selectPortrait',[p.file]);},'hddt-photo');b.setAttribute('aria-pressed',String(selected===p.file));var img=el('img');img.src=p.src||p.file;img.alt=p.label||p.file;img.width=320;img.height=240;img.loading='lazy';img.addEventListener('error',function(){img.hidden=true;b.classList.add('hddt-image-missing');b.title='Image unavailable. Refresh portraits or capture a new one.';});append(b,img,el('span','hddt-photo-name',p.label||p.file),el('span','hddt-photo-state',selected===p.file?'Page portrait':'Use on this page'));append(list,b);});
        if(!rows.length)append(list,el('p','hddt-muted',q?'No portraits match your search.':'No saved portraits yet. Capture a portrait while this NPC is visible.'));
        if(rows.length>48)append(list,el('p','hddt-muted','Showing 48 matches. Refine your search.'));
      }
      var input=searchBox('Find a portrait',function(v){q=v;paintRows();});input.value=q;input.addEventListener('keydown',function(e){if(e.key==='Enter'){var b=list.querySelector('button');if(b)b.click();e.preventDefault();}});
      var tools=append(el('div','hddt-pins'),button('Use default portrait',function(){c.run('selectPortrait',['']);}),button('Adjust selected framing',function(){c.run('framePortrait');}));
      append(c.root,top,el('p','hddt-muted','Choose a portrait for this page. Each image keeps its own framing.'),input,list,tools,c.notice);paintRows();
    };c.paint();return c;
  }
  function chooseOutfit(c,slot) {
    var d=dialog(c,slot.label+' outfit','Choose an existing Wardrobe outfit. This saves a shortcut; it does not dress the NPC yet.'),list=el('div','hddt-list'),q='';
    function paint(){clear(list);var rows=outfitRows(c.o).filter(function(p){return String((p.label||p.name||p.id)+' '+(p.note||'')).toLowerCase().indexOf(q)!==-1;});
      rows.slice(0,80).forEach(function(p){var b=button(p.label||p.name||p.id,function(){var slots=Object.assign({},c.person().equipment||{});slots[slot.id]=outfitId(p);modalSave(c,d,'saveEquipment',[slots]);},'hddt-choice');b.disabled=!!p.pending;b.title=p.pending?'Wardrobe has not resolved this outfit yet. Refresh Wardrobe first.':p.note||'';if(p.pending)append(b,el('span','hddt-muted','Not loaded'));append(list,b);});
      if(!rows.length)append(list,el('p','hddt-muted','No matching Wardrobe outfits. Create an outfit in Wardrobe first.'));if(rows.length>80)append(list,el('p','hddt-muted','Showing 80 matches. Refine your search.'));
    }
    var input=searchBox('Find an outfit',function(v){q=v;paint();});input.addEventListener('keydown',function(e){if(e.key==='Enter'){var b=Array.prototype.filter.call(list.querySelectorAll('button'),function(x){return !x.disabled;})[0];if(b)b.click();e.preventDefault();}});
    append(d.box,input,list,d.notice,button('Clear this shortcut',function(){var slots=Object.assign({},c.person().equipment||{});delete slots[slot.id];modalSave(c,d,'saveEquipment',[slots]);}));paint();
  }
  function applyReview(c,slot,id) {
    var found=outfitRows(c.o).filter(function(p){return outfitId(p)===id&&!p.pending;})[0];if(!found){msg(c.notice,'This outfit is no longer available. Choose a replacement.',true);return;}
    var warning=read(c.o,'getApplyWarning','Wardrobe will assign this outfit and dress this NPC now.');
    var d=dialog(c,'Wear '+slot.label.toLowerCase()+' outfit',warning||'Wardrobe will assign this outfit and dress this NPC now.');append(d.box,el('p','hddt-outfit-name',found.label||found.name||id),d.notice,button('Apply outfit',function(){
      var still=outfitRows(c.o).some(function(p){return outfitId(p)===id&&!p.pending;});if(!still){msg(d.notice,'This outfit is no longer available. Close and choose a replacement.',true);return;}modalSave(c,d,'applyOutfit',[id]);
    },'hddt-primary'));
  }
  function mountEquipment(host,o) {
    var c=context(host,o);c.paint=function(){clear(c.root);append(c.root,el('h3','','Saved outfits'),el('p','hddt-muted','Three shortcuts to your Wardrobe outfits. Applying one uses Wardrobe’s existing controls.'));
      SLOTS.forEach(function(slot){var id=String((c.person().equipment||{})[slot.id]||''),found=outfitRows(o).filter(function(p){return outfitId(p)===id&&!p.pending;})[0],line=el('div','hddt-slot'),name=append(el('div','hddt-slot-name'),el('strong','',slot.label),el('span','hddt-muted',id?(found?(found.label||found.name||id):id+' — unavailable'):'No outfit chosen'));
        var apply=button('Wear',function(){if(c.valid())applyReview(c,slot,id);},'hddt-primary');apply.disabled=!found;apply.setAttribute('aria-label','Wear '+slot.label.toLowerCase()+' outfit');append(line,name,button(id?'Change':'Choose',function(){if(c.valid())chooseOutfit(c,slot);}),apply);append(c.root,line);
      });append(c.root,c.notice);
    };c.paint();return c;
  }
  window.HDDossierTools={mountPins:mountPins,mountGallery:mountGallery,mountEquipment:mountEquipment,closeOverlays:closeOverlays,onKey:key,isOpen:function(){return !!active;}};
})();
