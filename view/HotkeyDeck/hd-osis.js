/* OSIS controls shared by the Scene popout and phone portal. */
'use strict';
window.HDOsis = (function () {
 const groups=['Overview','General','Faces','Hands & feet','Living skin','Lip sync','Body response','All settings'];
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
 function mount(host,send,options){
  const heading=options&&options.heading===2?2:3;
  host.textContent='';host.classList.add('osis-panel');
  let snapshot=null,busy=false,dead=false,serial=0;
  const top=el('div','osis-top'),intro=el('div','osis-intro');
  intro.append(el('p','osis-eyebrow','OSIS · OSED Reborn'),el('h'+heading,'osis-title','Expressions & body response'),
   el('p','osis-prose','Switch modules and tune their behavior here. Changes apply to the running game and OSIS saves them.'));
  const refresh=el('button','osis-button','Refresh');refresh.type='button';top.append(intro,refresh);host.append(top);
  const status=el('p','osis-status','Reading OSIS…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');host.append(status);
  const filters=el('div','osis-filters'),search=el('input','osis-search');search.type='search';search.name='osis-search';search.autocomplete='off';search.placeholder='Search OSIS settings…';search.setAttribute('aria-label','Search OSIS settings');
  const group=el('select','osis-group');group.name='osis-group';group.setAttribute('aria-label','OSIS settings group');groups.forEach(g=>{const o=el('option','',g);o.value=g;group.append(o);});filters.append(search,group);host.append(filters);
  const count=el('p','osis-count');host.append(count);const list=el('div','osis-list');host.append(list);
  const footer=el('div','osis-footer'),save=el('button','osis-button','Save current settings');save.type='button';
  footer.append(el('p','osis-prose','Values reflect OSIS settings. Animation, voice files, meshes and other mods determine the visible result. Texture paths, morph tables and overlay allocation remain in OSIS’s own editor.'),save);host.append(footer);
  const shown=()=>{
   const query=search.value.trim().toLowerCase();
   return (snapshot&&snapshot.rows||[]).filter(r=>query?[r.label,r.id,r.id.replace(/([a-z])([A-Z])/g,'$1 $2'),r.group,r.detail].join(' ').toLowerCase().includes(query):group.value==='Overview'?r.module:group.value==='All settings'||r.group===group.value);
  };
  function controlsDisabled(){
   refresh.disabled=busy;save.disabled=busy||!snapshot||!snapshot.supported||!snapshot.revision;
   list.querySelectorAll('button,input').forEach(n=>n.disabled=busy||n.dataset.readonly==='1');
  }
  function paint(){
   const focused=document.activeElement,id=focused&&focused.dataset.osisControl;
   list.textContent='';const rows=shown();count.textContent=snapshot&&snapshot.rows?rows.length+' settings'+(search.value.trim()?' matching your search':''):'OSIS connection';
   rows.forEach(r=>{
    const row=el('section','osis-row');row.dataset.setting=r.id;
    const text=el('div','osis-row-text');const title=el('h'+(heading+1),'osis-row-title',r.label);text.append(title);
    text.append(el('p','osis-meta',r.group+(r.saved?' · Saved':' · Live, not saved')));
    if(r.detail)text.append(el('p','osis-detail',r.detail));
    const why=r.reason||((r.type==='bool'&&!r.value)?r.enableReason:'')||'';
    if(why)text.append(el('p','osis-reason',why));
    const control=el('div','osis-control');
    if(r.type==='bool'){
     const b=el('button','osis-switch',r.value?'On':'Off');b.type='button';b.setAttribute('role','switch');b.setAttribute('aria-checked',String(r.value));b.setAttribute('aria-label',r.label);b.dataset.osisControl=r.id;
     b.dataset.readonly=why?'1':'0';b.addEventListener('click',()=>change(r,!r.value));control.append(b);
    }else{
     const input=el('input','osis-number');input.type='number';input.name=r.id;input.autocomplete='off';input.inputMode=r.type==='int'?'numeric':'decimal';input.value=String(Math.round(Number(r.value)*10000)/10000);input.min=r.min;input.max=r.max;input.step=r.step;input.setAttribute('aria-label',r.label);input.dataset.osisControl=r.id;input.dataset.readonly=r.reason?'1':'0';
     const b=el('button','osis-button','Apply');b.type='button';b.setAttribute('aria-label','Apply '+r.label);b.dataset.readonly=r.reason?'1':'0';
     const apply=()=>{const value=Number(input.value);if(input.value.trim()===''||!Number.isFinite(value)||value<r.min||value>r.max||(r.type==='int'&&!Number.isInteger(value))){status.textContent='Enter '+(r.type==='int'?'a whole number':'a number')+' from '+r.min+' to '+r.max+' for '+r.label+'.';input.focus();return;}change(r,value);};
     b.addEventListener('click',apply);input._ostEnter=apply;input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.__ostHandled){e.preventDefault();e.stopPropagation();apply();}});
     control.append(input,b);text.append(el('p','osis-range','Supported range: '+r.min+'–'+r.max));
    }
    row.append(text,control);list.append(row);
   });
   if(!rows.length)list.append(el('p','osis-empty',snapshot&&snapshot.rows?'No settings match. Try another name or clear the search.':'Launch Skyrim with OSIS enabled, then refresh.'));
   controlsDisabled();if(id){const target=Array.from(list.querySelectorAll('[data-osis-control]')).find(n=>n.dataset.osisControl===id&&!n.disabled);if(target)target.focus();}
  }
  function request(payload){
   if(busy||dead)return Promise.resolve();busy=true;controlsDisabled();const token=++serial;
   status.textContent=payload.op==='state'?'Reading live OSIS settings…':'Waiting for OSIS to apply and save…';
   let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('OSIS has not confirmed the request. Refresh to check its current values before retrying.')),12000);});
   return Promise.race([Promise.resolve().then(()=>send(payload)),timeout]).then(reply=>{
    if(dead||token!==serial)return;busy=false;
    if(!reply||typeof reply!=='object')throw new Error('OSIS returned no settings. Refresh to reconnect.');
    snapshot=reply;status.textContent=reply.msg||'OSIS settings refreshed.';status.dataset.error=reply.ok===false?'1':'0';paint();
   }).catch(error=>{if(dead||token!==serial)return;busy=false;status.textContent=error.message;status.dataset.error='1';snapshot=null;paint();}).then(()=>clearTimeout(timer));
  }
  function change(row,value){return request({op:'set',id:row.id,value:value,revision:snapshot.revision});}
  refresh.addEventListener('click',()=>request({op:'state'}));save.addEventListener('click',()=>request({op:'save',revision:snapshot.revision}));
  search.addEventListener('input',paint);group.addEventListener('change',paint);
  const first=()=>{const n=Array.from(list.querySelectorAll('button,input')).find(n=>!n.disabled);if(n)n.focus();};search._ostEnter=first;
  search.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.__ostHandled){e.preventDefault();first();}if(e.key==='Escape'&&search.value){e.preventDefault();e.stopImmediatePropagation();e.__ostHandled=true;search.value='';paint();}});
  search._ostKey=e=>{if(e.key==='Escape'&&search.value){search.value='';paint();return true;}return false;};
  request({op:'state'});
  return {refresh:()=>request({op:'state'}),destroy:()=>{dead=true;serial++;},search:query=>{search.value=query;paint();search.focus();}};
 }
 return {mount:mount};
})();
