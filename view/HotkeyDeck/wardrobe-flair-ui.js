/* Shared accessory composer and dock organizer: identical on the couch and phone. */
(function () {
  'use strict';
  const M=window.WardrobeFlairModel;
  function node(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function button(label,fn,cls){const b=node('button',cls||'',label);b.type='button';b.addEventListener('click',fn);return b;}
  function input(label,value,fn){const wrap=node('label','wf-field'), title=node('span','',label),i=node('input');i.type='text';i.autocomplete='off';i.value=value||'';i.addEventListener('input',()=>fn(i.value));wrap.append(title,i);return wrap;}
  function itemKey(p){return (p.formId+'|'+p.plugin).toLowerCase();}
  function uid(prefix){return prefix+Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
  function mount(host,a,s){
    s=s||{};host.textContent='';host.classList.add('wf-root');
    const root=node('div','wf-content'), status=node('p','wf-status');status.setAttribute('role','status');host.append(root,status);
    const doc=()=>a.data(), f=()=>M.flair(doc());
    function say(t,bad){status.textContent=t;status.classList.toggle('is-error',!!bad);}
    function image(file,name,cls){const img=node('img',cls||'wf-thumb');img.width=80;img.height=80;img.alt=name||'';img.loading='lazy';img.src=a.image(file||'icons/custom/hm-wardrobe.png');img.onerror=function(){this.onerror=null;this.src=a.image('icons/custom/hm-wardrobe.png');};return img;}
    async function edit(e,after){if(s.saving)return;s.saving=true;host.setAttribute('aria-busy','true');say('Saving…');try{await a.edit(M.validate(e));if(after)after();render();say(a.queued?'Queued for Skyrim. Open Wardrobe in game to apply.':'Sent to Skyrim.');}catch(err){say(err.message,true);}finally{s.saving=false;host.setAttribute('aria-busy','false');}}
    function check(label,on,fn){const l=node('label','wf-check'),i=node('input');i.type='checkbox';i.checked=on;i.addEventListener('change',()=>fn(i.checked));l.append(i,node('span','',label));return l;}
    function search(label,q,on){const i=node('input','wf-search');i.type='search';i.autocomplete='off';i.setAttribute('aria-label',label);i.placeholder=label;i.value=q||'';i.addEventListener('input',()=>on(i.value));return i;}
    function picker(title,choices,value,pick){
      const wrap=node('details','wf-picker'),summary=node('summary','',title);wrap.append(summary);
      const results=node('div','wf-pick-results');let hits=[];
      const q=search('Search '+title.toLowerCase(),'',v=>paint(v));q.addEventListener('keydown',e=>{if(e.key==='Enter'&&hits.length){e.preventDefault();pick(hits[0].id);wrap.open=false;}});
      function paint(q){results.textContent='';hits=choices.filter(x=>x.name.toLowerCase().includes(q.toLowerCase()));hits.slice(0,80).forEach(x=>{const b=button(x.name,()=>{pick(x.id);wrap.open=false;},'wf-choice'+(value===x.id?' is-on':''));if(x.icon)b.prepend(image(x.icon,'','wf-mini'));results.append(b);});if(!hits.length)results.append(node('p','wf-hint','No matches.'));}
      wrap.append(q,results);paint('');return wrap;
    }
    function iconPicker(current,changed){
      const wrap=node('div','wf-icon-choice');wrap.append(image(current,'Selected icon'));
      wrap.append(picker('Choose icon',(a.icons()||[]).map(i=>({id:i.file,name:i.name||i.label||i.file,icon:i.file})),current,changed));
      wrap.append(button('Default',()=>changed('')));
      if(a.upload){const file=node('input','wf-upload');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.setAttribute('aria-label','Upload icon');file.addEventListener('change',async()=>{if(!file.files[0])return;try{say('Uploading image…');changed(await a.upload(file.files[0]));}catch(e){say(e.message,true);}});wrap.append(file);}
      return wrap;
    }
    function renderFlair(){
      const tools=node('div','wf-tools');tools.append(button('New Flair set',()=>{s.draft={id:uid('f'),name:'',icon:'',items:[]};render();},'wf-primary'));
      if(a.equip)tools.append(button('Remove active Flair',()=>a.equip({kind:'clear'})));
      root.append(tools);
      if(s.draft){renderSetEditor();return;}
      const list=node('div','wf-grid'),filter=search('Search Flair sets…',s.q||'',q=>{s.q=q;paintSets();});root.append(filter,list);
      filter.addEventListener('keydown',e=>{if(e.key==='Enter'){const first=list.querySelector('button');if(first){e.preventDefault();first.click();}}});
      function paintSets(){list.textContent='';const sets=f().sets.filter(x=>!s.q||x.name.toLowerCase().includes(s.q.toLowerCase()));sets.forEach(set=>{const card=node('article','wf-set');card.append(image(set.icon,set.name),node('h3','',set.name),node('p','wf-hint',set.items.length+' accessories'));const actions=node('div','wf-tools');actions.append(button('Edit set',()=>{s.draft=JSON.parse(JSON.stringify(set));render();}));if(a.equip)actions.append(button('Equip layer',()=>a.equip({kind:'flair',id:set.id}),'wf-primary'));card.append(actions);list.append(card);});if(!sets.length)list.append(node('p','wf-empty',s.q?'No matching Flair sets. Try another name.':'Create a Flair set for the finishing touches — rings, a necklace, a hood or a cloak.'));}
      paintSets();
      const policy=node('details','wf-settings');policy.append(node('summary','','When outfits change'),check('Keep my Flair when changing outfits',f().keep,e=>edit({type:'keep',value:e})),node('p','wf-hint','Flair replaces pieces using the same equipment slots. Saved outfits stay intact.'));root.append(policy);
    }
    function renderSetEditor(){
      const d=s.draft, panel=node('div','wf-editor');root.append(panel);
      panel.append(node('h3','',d.name||'New Flair set'),node('p','wf-hint','Name the combination, choose its picture, then add the accessories.'));
      panel.append(input('Set name',d.name,v=>d.name=v),iconPicker(d.icon,v=>{d.icon=v;render();}));
      const picked=node('div','wf-selected');panel.append(node('h3','','Accessories in this set'),picked);
      function paintPicked(){picked.textContent='';d.items.forEach(p=>{const r=node('div','wf-piece');r.append(image(a.itemImage(p),p.name,'wf-mini'),node('span','',p.name||p.formId),node('small','',p.slot||p.plugin),button('Remove',()=>{d.items=d.items.filter(x=>itemKey(x)!==itemKey(p));paintPicked();paintItems(s.itemQ||'');}));picked.append(r);});if(!d.items.length)picked.append(node('p','wf-hint','Choose the accessories below.'));}
      const list=node('div','wf-item-list');let matches=[];
      const filter=search('Search equipment by name or mod',s.itemQ||'',q=>{s.itemQ=q;paintItems(q);});
      filter.addEventListener('keydown',e=>{if(e.key==='Enter'&&matches.length){e.preventDefault();add(matches[0]);}});
      const seen=new Set(), all=(a.items()||[]).filter(p=>{const k=itemKey(p);if(seen.has(k))return false;seen.add(k);return true;});
      function add(p){if(d.items.length>=32){say('A Flair set can contain up to 32 accessories.',true);return;}if(d.items.some(x=>itemKey(x)===itemKey(p)))return;d.items.push({formId:p.formId,plugin:p.plugin,name:p.name||'',slot:p.slot||''});paintPicked();paintItems(s.itemQ||'');}
      function paintItems(q){list.textContent='';matches=all.filter(p=>!d.items.some(x=>itemKey(x)===itemKey(p))&&(!q||(p.name+' '+p.plugin+' '+p.slot).toLowerCase().includes(q.toLowerCase())));matches.slice(0,60).forEach(p=>{const b=button('',()=>add(p),'wf-item');b.append(image(a.itemImage(p),p.name,'wf-mini'),node('span','',p.name||p.formId),node('small','',p.slot||p.plugin),node('b','','Add'));list.append(b);});if(!matches.length)list.append(node('p','wf-hint',all.length?'No matching equipment.':'No exported equipment yet. Open Wardrobe → Inventory in Skyrim, then refresh this page.'));}
      panel.append(filter);if(a.pickItem)panel.append(button('Find in the whole load order…',()=>a.pickItem(add)));panel.append(list);paintPicked();paintItems(s.itemQ||'');
      const actions=node('div','wf-tools');actions.append(button('Save Flair set',()=>edit(Object.assign({type:'set'},d),()=>{s.draft=null;}),'wf-primary'),button('Cancel',()=>{s.draft=null;render();}));
      if(f().sets.some(x=>x.id===d.id))actions.append(button(s.deleteArmed===d.id?'Confirm delete':'Delete set',()=>{if(s.deleteArmed!==d.id){s.deleteArmed=d.id;render();return;}edit({type:'delete',id:d.id},()=>{s.draft=null;s.deleteArmed='';});},'wf-danger'));
      panel.append(actions);
    }
    function renderDock(){
      const enabled=f().dock.enabled!==false;
      const controls=node('div','wf-dock-controls');
      controls.append(check('Enable Favorites dock',enabled,on=>edit({type:'dock-enabled',value:on})));
      const tools=node('div','wf-tools');
      if(a.openDock){const open=button('Open dock',a.openDock,'wf-primary');open.disabled=!enabled;tools.append(open);}
      if(a.placeDock)tools.append(button('Place on screen',a.placeDock));
      function panelButton(label,id){const b=button(label,()=>{s.panel=s.panel===id?'':id;render();});b.setAttribute('aria-expanded',String(s.panel===id));if(s.panel===id)b.classList.add('wf-primary');return b;}
      tools.append(panelButton('Appearance','appearance'),panelButton('Categories & icons','categories'));
      controls.append(tools);root.append(controls);
      const keys=node('details','wf-help');keys.append(node('summary','','How to use the dock'),node('p','wf-hint','Bind “Favorites Outfit Dock” in Hotkeys. W/S chooses a look, A/D changes categories and E equips. Attached Flair gives you a With Flair / No Flair choice. Use Place on screen in game to move and resize the dock.'));root.append(keys);
      const c=Object.assign({x:88,y:50,scale:1,motion:'full',orientation:'vertical',edgeX:'',edgeY:''},f().dock);
      if(s.panel==='appearance'){
        const prefs=node('section','wf-config');prefs.setAttribute('aria-label','Dock appearance');
        prefs.append(node('h3','','Dock appearance'));
        const layouts=node('div','wf-tools');layouts.append(node('span','','Layout'));
        ['vertical','horizontal'].forEach(value=>{const b=button(value==='vertical'?'Vertical':'Horizontal',()=>{c.orientation=value;edit(Object.assign({type:'dock'},c));});b.setAttribute('aria-pressed',String(c.orientation===value));if(c.orientation===value)b.classList.add('wf-primary');layouts.append(b);});prefs.append(layouts);
        [['Size','scale',.65,1.4,.05],['Horizontal position','x',0,100,1],['Vertical position','y',0,100,1]].forEach(([label,k,min,max,step])=>{const l=node('label','wf-slider'),r=node('input'),v=node('span','',k==='scale'?Math.round(c[k]*100)+'%':c[k]+'%');r.type='range';r.min=min;r.max=max;r.step=step;r.value=c[k];r.setAttribute('aria-label',label);r.addEventListener('input',()=>{c[k]=Number(r.value);v.textContent=k==='scale'?Math.round(c[k]*100)+'%':c[k]+'%';if(k==='x')c.edgeX=c.x===0?'left':c.x===100?'right':'';if(k==='y')c.edgeY=c.y===0?'top':c.y===100?'bottom':'';});r.addEventListener('change',()=>edit(Object.assign({type:'dock'},c)));l.append(node('span','',label),r,v);prefs.append(l);});
        prefs.append(check('Reduced motion',c.motion==='reduced',yes=>{c.motion=yes?'reduced':'full';edit(Object.assign({type:'dock'},c));}),node('p','wf-hint','Drag the dock header near an edge to snap it into place. It stays inside the screen as you change the layout or size.'),button('Done',()=>{s.panel='';render();}));root.append(prefs);
      }
      if(s.panel==='categories'){
        const cats=node('section','wf-config');cats.setAttribute('aria-label','Dock categories');cats.append(node('h3','','Categories & icons'),node('p','wf-hint','Use categories such as Travel gear or Court attire. The dock cycles through categories that contain favorites.'));
        const maker=node('div','wf-tools');maker.append(input('New category',s.catName||'',v=>{s.catName=v;}),button('Add category',()=>edit({type:'category',id:uid('c'),name:s.catName||''},()=>s.catName='')));cats.append(maker);
        const catlist=node('div');cats.append(search('Search categories…',s.catQ||'',q=>{s.catQ=q;paintCats();}),catlist);
        function paintCats(){catlist.textContent='';const categories=(doc().categories||[]).filter(c=>!s.catQ||c.name.toLowerCase().includes(s.catQ.toLowerCase()));categories.forEach(c=>{const row=node('details','wf-category-edit');row.append(node('summary','',c.name),input('Category name',c.name,v=>c._draftName=v),button('Save name',()=>edit({type:'category',id:c.id,name:c._draftName||c.name})),iconPicker(f().categoryIcons[c.id]||'',v=>edit({type:'category-icon',id:c.id,icon:v})),button(s.catDelete===c.id?'Confirm delete category':'Delete category',()=>{if(s.catDelete!==c.id){s.catDelete=c.id;paintCats();return;}edit({type:'category-delete',id:c.id},()=>s.catDelete='');},'wf-danger'));catlist.append(row);});if(!categories.length)catlist.append(node('p','wf-hint',s.catQ?'No matching categories.':'Add your first category above.'));}
        paintCats();cats.append(button('Done',()=>{s.panel='';render();}));root.append(cats);
      }
      const heading=node('div','wf-library-head');heading.append(node('h3','','Choose your favorites'));
      heading.append(check('Favorites only',!!s.onlyFav,on=>{s.onlyFav=on;paintRows();}));root.append(heading);
      const list=node('div','wf-organizer');const filter=search('Search outfits and wardrobe pools…',s.q||'',q=>{s.q=q;paintRows();});root.append(filter,list);
      filter.addEventListener('keydown',e=>{if(e.key==='Enter'){const first=list.querySelector('summary');if(first){e.preventDefault();first.parentNode.open=true;first.focus();}}});
      function paintRows(){
        list.textContent='';
        const rows=M.rows(doc(),false).filter(r=>(!s.onlyFav||r.fav)&&(!s.q||(r.name+' '+r.kind+' '+(r.categoryIds||[]).map(id=>((doc().categories||[]).find(c=>c.id===id)||{}).name||'').join(' ')).toLowerCase().includes(s.q.toLowerCase())));
        rows.slice(0,s.limit||60).forEach(r=>{
          const row=node('article','wf-outfit'),heading=node('div','wf-row-head'),title=node('div','wf-row-title');
          const set=f().sets.find(s=>s.id===r.flairId);
          title.append(node('h3','',r.name),node('span','wf-row-meta',(r.kind==='wardrobe'?'Wardrobe pool':'Outfit')+(set?' · '+set.name:'')));
          heading.append(image(r.image,r.name),title);
          const favorite=button(r.fav?'Favorited':'Favorite',()=>edit(r.kind==='outfit'?{type:'favorite',name:r.id,value:!r.fav}:{type:'pool',id:r.id,fav:!r.fav}),r.fav?'wf-primary':'');favorite.setAttribute('aria-pressed',String(r.fav));favorite.setAttribute('aria-label',(r.fav?'Unfavorite ':'Favorite ')+r.name);heading.append(favorite);row.append(heading);
          const rowKey=M.key(r.kind,r.id), options=node('details','wf-outfit-options');options.open=s.expanded===rowKey;
          const summary=node('summary','','Flair & categories');options.append(summary);options.addEventListener('toggle',()=>{if(!options.isConnected)return;if(options.open)s.expanded=rowKey;else if(s.expanded===rowKey)s.expanded='';});
          options.append(picker(set?'Flair: '+set.name:'Attach Flair',[{id:'',name:'No attached Flair'}].concat(f().sets.map(s=>({id:s.id,name:s.name,icon:s.icon}))),r.flairId,id=>edit({type:'link',kind:r.kind,id:r.id,flairId:id})));
          const categories=node('details','wf-picker');categories.append(node('summary','',r.categoryIds.length?'Categories: '+r.categoryIds.map(id=>((doc().categories||[]).find(c=>c.id===id)||{}).name||id).join(', '):'Choose categories'));
          const choices=node('div','wf-pick-results');const paint=q=>{choices.textContent='';const hits=(doc().categories||[]).filter(c=>!q||c.name.toLowerCase().includes(q.toLowerCase()));hits.forEach(c=>choices.append(check(c.name,r.categoryIds.includes(c.id),yes=>{const ids=r.categoryIds.filter(id=>id!==c.id);if(yes)ids.push(c.id);edit({type:'categories',kind:r.kind,id:r.id,ids});})));if(!hits.length)choices.append(node('p','wf-hint',q?'No matching categories.':'Create a category with Categories & icons above.'));};categories.append(search('Search categories…','',paint),choices);paint('');options.append(categories);
          if(r.kind==='wardrobe'){const art=node('details','wf-picker');art.append(node('summary','','Pool picture'),iconPicker(r.image,v=>edit({type:'pool',id:r.id,image:v})));options.append(art);}row.append(options);list.append(row);
        });
        if(rows.length>(s.limit||60))list.append(button('Show more',()=>{s.limit=(s.limit||60)+60;paintRows();}));
        if(!rows.length)list.append(node('p','wf-empty',s.q?'No matching looks. Try a name or category.':s.onlyFav?'No favorites yet. Turn off Favorites only, then favorite a look.':'Create your first look under Collection → Outfits, then favorite it here.'));
      }
      paintRows();
    }
    function render(){root.textContent='';if(a.page==='dock')renderDock();else renderFlair();}
    render();return {render,say,state:s};
  }
  window.WardrobeFlairUI={mount};
})();
