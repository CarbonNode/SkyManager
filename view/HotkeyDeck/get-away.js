/* Get away from me. Session-only selections, authoritative nearby polling,
   one-shot movement through the same validated native roster. */
window.GetAway = (function () {
  'use strict';
  let modal=null, list=null, count=null, status=null, apply=null, clearBtn=null, heldBox=null, search=null, lastBox=null;
  let held=[];   // who is parked out of the room right now (from the roster reply)
  let rows=[], chosen=new Set(), token='', serial=0, timer=0, waiting=0, feet=25, focusBefore=null;
  let initial=0, loaded=false, faceIds='';
  const LIMIT=24;
  function el(tag,cls,text){const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;}
  function send(fn,obj){if(typeof window[fn]==='function')window[fn](JSON.stringify(obj));}
  function button(label,run,cls){const n=el('button',cls||'gaw-button',label);n.type='button';n.addEventListener('click',run);return n;}
  function close(){
    clearTimeout(timer);clearTimeout(waiting);timer=waiting=0;
    if(modal){modal.remove();if(typeof window.hdCapture==='function')window.hdCapture('0');}modal=null;rows=[];held=[];chosen.clear();loaded=false;faceIds='';clearBtn=null;heldBox=null;
    if(focusBefore&&document.body.contains(focusBefore))focusBefore.focus();focusBefore=null;
  }
  function request(){
    clearTimeout(timer);timer=0;if(!modal)return;
    if(!document.body.classList.contains('open')){close();return;}
    if(typeof window.hdCapture==='function')window.hdCapture('1');
    send('gaNearby',{token:token});
    clearTimeout(waiting);waiting=setTimeout(function(){
      if(!modal)return;loaded=false;status.textContent='Nearby scan did not respond. Refresh to try again.';update();
    },6000);
  }
  function visible(){const q=search?search.value.trim().toLowerCase():'';return rows.filter(r=>!q||(r.name+' '+(r.follower?'follower':'')).toLowerCase().indexOf(q)!==-1);}
  function available(r){return !r.reason&&Number(r.feet)<feet;}
  function update(){
    const active=rows.filter(r=>chosen.has(r.formId)&&available(r));
    count.textContent=active.length+' selected · '+rows.length+' nearby';
    apply.disabled=!loaded||!active.length||active.length>LIMIT;
    apply.textContent='Move '+active.length+' away';
    /* Clear the room (Rober, 2026-09-21): out of the cell + paused, until the
       same hotkey (or the banner button) brings them back */
    if(clearBtn){clearBtn.disabled=apply.disabled;clearBtn.textContent='Clear the room ('+active.length+')';}
    if(heldBox){
      heldBox.hidden=!held.length;
      if(held.length){
        while(heldBox.firstChild)heldBox.removeChild(heldBox.firstChild);
        heldBox.appendChild(el('strong','',held.length+' held out of the room: '));
        heldBox.appendChild(el('span','',held.map(h=>h.name).join(', ')));
        heldBox.appendChild(button('Bring them back',()=>{close();send('gaRestore',{});},'gaw-button gaw-primary gaw-restore'));
      }
    }
  }
  function clearRoom(){
    if(!modal||!clearBtn||clearBtn.disabled)return;
    const ids=rows.filter(r=>chosen.has(r.formId)&&available(r)).map(r=>r.formId);
    close();send('gaClear',{token:token,ids:ids});
  }
  function toggle(r){
    if(!available(r))return;
    if(chosen.has(r.formId))chosen.delete(r.formId);
    else if(chosen.size<LIMIT)chosen.add(r.formId);
    else status.textContent='Move up to '+LIMIT+' NPCs at a time.';
    renderRows();
  }
  function portrait(r){
    const frame=el('span','gaw-face');frame.setAttribute('aria-hidden','true');
    const initials=r.name.trim().split(/\s+/).slice(0,2).map(n=>n.charAt(0)).join('').toUpperCase();
    frame.textContent=initials;
    const p=window.FolPane&&FolPane.portraitInfoFor({formId:'0x'+r.formId.toString(16),name:r.name});
    if(!p)return frame;
    const plain=p.abs?p.file:'portraits/'+p.file;
    const img=el('img','');img.alt='';img.draggable=false;
    img.src=plain+(p.abs?'':'?v='+(p.mtime||0));img.dataset.portrait=plain;
    let retried=false;
    img.addEventListener('error',function(){
      if(!retried){retried=true;img.src=plain;return;}
      frame.textContent=initials;
    });
    frame.textContent='';frame.appendChild(img);
    return frame;
  }
  function renderRows(){
    if(!modal)return;const y=list.scrollTop;const active=document.activeElement;
    const focusedId=active&&active.dataset?active.dataset.actor:null;
    list.textContent='';
    const filtered=visible();
    if(!filtered.length)list.appendChild(el('p','gaw-empty',loaded?(rows.length?'No NPC matches your search.':'Nobody nearby to move.'):'Reading nearby NPCs…'));
    filtered.forEach(function(r){
      const item=el('label','gaw-row'+(available(r)?'':' gaw-unavailable'));
      const check=el('input','gaw-check');check.type='checkbox';check.dataset.actor=String(r.formId);
      check.checked=chosen.has(r.formId)&&available(r);check.disabled=!available(r);
      check.setAttribute('aria-label','Move '+r.name+' away');check.addEventListener('change',()=>toggle(r));
      const text=el('span','gaw-person');text.append(el('strong','',r.name),el('span','gaw-detail',r.reason||(r.feet>=feet?'Already far enough away':r.follower?'Follower · may walk back':'Ready to move')));
      item.append(check,portrait(r),text,el('span','gaw-distance','~'+r.feet+' ft'));list.appendChild(item);
    });
    if(window.HDFaceFit)list.querySelectorAll('.gaw-face img').forEach(function(img){
      const src=img.dataset.portrait;
      if(src.indexOf('icons/mounts/')!==-1)img.style.objectFit='contain';
      else if(src.indexOf('icons/npcs/')!==-1)HDFaceFit.ensure(img,src);
      else HDFaceFit.paintPortrait(img,src);
    });
    list.scrollTop=y;
    if(focusedId){const n=list.querySelector('[data-actor="'+focusedId+'"]');if(n)n.focus();}
    update();
  }
  function move(){
    if(!modal||apply.disabled)return;
    const ids=rows.filter(r=>chosen.has(r.formId)&&available(r)).map(r=>r.formId);
    const request={token:token,feet:feet,ids:ids};
    close();send('gaMove',request);
  }
  function open(preselect){
    close();focusBefore=document.activeElement;token='get-away-'+Date.now()+'-'+(++serial);
    initial=Number(preselect)||0;feet=25;chosen=new Set();rows=[];loaded=false;
    modal=el('div','gaw-back');modal.id='get-away-modal';
    const card=el('section','gaw-card');card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');card.setAttribute('aria-labelledby','gaw-title');
    const head=el('header','gaw-head');const heading=el('div','gaw-heading');
    const icon=el('img','gaw-icon');icon.src='icons/custom/hk-release-all.png';icon.alt='';
    const title=el('h2','','Get away from me');title.id='gaw-title';heading.append(icon,title);
    head.append(heading,button('Close',close));
    const intro=el('p','gaw-intro','Choose who moves. Nearby NPCs refresh every 2 seconds; new arrivals stay unselected.');
    const tools=el('div','gaw-tools');search=el('input','gaw-search');search.type='search';search.placeholder='Search nearby NPCs…';search.setAttribute('aria-label','Search nearby NPCs');
    search.addEventListener('input',renderRows);
    const select=button('Select visible',()=>{visible().forEach(r=>{if(available(r)&&chosen.size<LIMIT)chosen.add(r.formId);});renderRows();});
    const clear=button('Clear selection',()=>{chosen.clear();renderRows();});
    tools.append(search,select,clear,button('Refresh',request));
    const distance=el('div','gaw-range');distance.appendChild(el('span','','Distance from you'));
    [20,25,30].forEach(n=>{const b=button(n+' ft',()=>{feet=n;distance.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));rows.forEach(r=>{if(!available(r))chosen.delete(r.formId);});renderRows();},'gaw-button gaw-range-choice');b.dataset.feet=n;b.setAttribute('aria-pressed',String(n===feet));distance.appendChild(b);});
    count=el('span','gaw-count');distance.appendChild(count);
    list=el('div','gaw-list');list.setAttribute('aria-label','Nearby NPC selection');
    status=el('p','gaw-status','Reading nearby NPCs…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    lastBox=el('details','gaw-last');lastBox.appendChild(el('summary','','Last move results'));lastBox.hidden=true;
    heldBox=el('p','gaw-held');heldBox.hidden=true;
    const foot=el('footer','gaw-foot');apply=button('Move selected away',move,'gaw-button');apply.disabled=true;
    clearBtn=button('Clear the room',clearRoom,'gaw-button gaw-primary');clearBtn.disabled=true;
    clearBtn.title='Send the selected NPCs out of this cell — through its door, to where the door leads — and pause them there. Press the Get away hotkey again (or Bring them back) after the scene and they return to exactly where they stood.';
    apply.title='The old one-shot push: 20–30 ft away inside this room. They can walk back.';
    foot.append(el('p','','Clear the room sends them OUT and pauses them until you bring them back. Move away is the small push.'),apply,clearBtn);
    card.append(head,intro,tools,distance,list,status,heldBox,lastBox,foot);modal.appendChild(card);
    modal.addEventListener('click',e=>{if(e.target===modal)close();});document.body.appendChild(modal);
    if(window.HDCss)HDCss.need('get-away');
    renderRows();search.focus();request();
  }
  function receive(payload){
    let data=payload;try{if(typeof data==='string')data=JSON.parse(data);}catch(e){return;}
    if(!modal||!data||data.token!==token)return;
    clearTimeout(waiting);waiting=0;loaded=!!data.ok;
    const seen=new Set();rows=(Array.isArray(data.rows)?data.rows:[]).filter(r=>{
      if(!r||!Number.isInteger(r.formId)||r.formId<=0||r.formId>0xffffffff||seen.has(r.formId))return false;
      seen.add(r.formId);return true;
    });
    rows=rows.map(r=>({formId:r.formId,name:String(r.name||'NPC'),feet:Math.max(0,Number(r.feet)||0),reason:String(r.reason||''),follower:!!r.follower}));
    held=(Array.isArray(data.held)?data.held:[]).filter(h=>h&&Number.isInteger(h.formId)).map(h=>({formId:h.formId,name:String(h.name||'NPC')}));
    chosen.forEach(id=>{const r=rows.find(x=>x.formId===id);if(!r||!available(r))chosen.delete(id);});
    if(initial){const r=rows.find(x=>x.formId===initial);if(r&&available(r))chosen.add(initial);initial=0;}
    status.textContent=loaded?'Nearby list refreshed · within about 35 ft':'Nearby NPCs are unavailable right now.';
    if(data.last&&data.last.msg){
      lastBox.hidden=false;while(lastBox.children.length>1)lastBox.lastChild.remove();
      lastBox.appendChild(el('p','',data.last.msg));
      (data.last.results||[]).forEach(r=>lastBox.appendChild(el('p','gaw-result',r.name+' — '+r.msg)));
    }
    renderRows();
    const nextIds=rows.map(r=>'0x'+r.formId.toString(16)).sort().join(',');
    if(nextIds!==faceIds){faceIds=nextIds;if(window.FolPane&&FolPane.requestPortraitFaces)FolPane.requestPortraitFaces();}
    clearTimeout(timer);timer=setTimeout(request,2000);
  }
  function onKey(e){
    if(!modal)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();return;}
    if(e.key==='Enter'&&e.target===search){e.preventDefault();e.stopImmediatePropagation();const r=visible().find(available);if(r)toggle(r);return;}
    if(e.key==='Tab'){
      const buttons=Array.from(modal.querySelectorAll('button,input,summary')).filter(n=>!n.disabled&&!n.hidden&&!(n.parentNode===lastBox&&lastBox.hidden));
      let i=buttons.indexOf(document.activeElement);i=(i+(e.shiftKey?buttons.length-1:1))%buttons.length;
      e.preventDefault();e.stopImmediatePropagation();if(buttons[i])buttons[i].focus();return;
    }
    // Keep deck shortcuts and behind-modal type-to-search away from this input.
    e.stopPropagation();
    // Window capture means native target listeners do not see Enter/Space.
    if((e.key==='Enter'||e.key===' ')&&e.target&&e.target.tagName==='BUTTON'){e.preventDefault();e.target.click();}
    else if(e.key===' '&&e.target&&e.target.type==='checkbox'){e.preventDefault();const r=rows.find(x=>String(x.formId)===e.target.dataset.actor);if(r)toggle(r);}
  }
  window.addEventListener('keydown',onKey,true);
  if(typeof MutationObserver==='function')new MutationObserver(function(){if(modal&&!document.body.classList.contains('open'))close();}).observe(document.body,{attributes:true,attributeFilter:['class']});
  window.addEventListener('hd-portrait-crops-changed',renderRows);
  window.gaRoster=receive;
  window.gaShow=function(){open();};
  if(window.HDOmni)HDOmni.register({id:'get-away',label:'Get away from me',index:()=>[{label:'Get away from me',detail:'Clear the room: send nearby NPCs out of the cell and pause them until you bring them back — or the small 20–30 ft push',keywords:'get away give me space move NPCs clear crowd push away nearby personal space back off clear the room ostim scene gawking' ,kind:'action',icon:'icons/custom/hk-release-all.png',jump:()=>open()}]});
  return {open:open,close:close,isOpen:()=>!!modal,portraitIds:()=>rows.map(r=>'0x'+r.formId.toString(16)),portraitsChanged:renderRows};
})();
