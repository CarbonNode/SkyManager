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
    /* wardrobe-wheel-editor: the looks on the Wardrobe Wheel and what fans out
       from each. Every change sends the WHOLE slot list ({type:'wheel'}), so
       the deck, the phone and the HUD can never disagree about order. */
    const SPEEDS=[{v:.1,name:'Crawl'},{v:.25,name:'Slow'},{v:.35,name:'Eased'},{v:.5,name:'Half'},{v:1,name:'Normal'}];
    const SIZES=[{v:48,name:'Small'},{v:56,name:'Medium'},{v:64,name:'Large'},{v:74,name:'Huge'}];
    function clock(i,n){const h=Math.round(i*12/Math.max(1,n))%12;return (h===0?12:h)+' o’clock';}
    function slotsNow(){return JSON.parse(JSON.stringify(M.wheel(doc()).slots||[]));}
    function saveSlots(slots,msg){edit({type:'wheel',slots},()=>{if(msg)setTimeout(()=>say(msg),0);});}
    function choiceArt(x){
      if(x.set){const set=f().sets.find(v=>v.id===x.set);if(!set)return '';if(set.icon)return set.icon;const p=(set.items||[])[0];return p?a.itemImage(p):'';}
      return x.item?a.itemImage(x.item):'';
    }
    function choiceName(x){if(x.set){const set=f().sets.find(v=>v.id===x.set);return set?set.name:'Missing Flair set';}return (x.item&&(x.item.name||x.item.formId))||'Piece';}
    function choiceSub(x){if(x.set){const set=f().sets.find(v=>v.id===x.set);const n=set?(set.items||[]).length:0;return 'Flair set · '+n+(n===1?' piece':' pieces');}return 'Single piece'+(x.item&&x.item.slot?' · '+x.item.slot:'');}
    function renderWheel(){
      const w=M.wheel(doc()), slots=M.wheelRows(doc()), raw=slotsNow();
      const intro=node('div','wf-wheel-intro');
      const text=node('div','wf-wheel-text');
      text.append(node('h3','','Wardrobe wheel'),node('p','wf-hint','Up to 8 looks on a slow-time wheel. Aim at a look to wear it on its own; aim past its edge to layer one of its choices over it — a Flair set or a single piece.'));
      const tools=node('div','wf-tools');
      const add=button('Add a look',()=>pickLook(),'wf-primary');add.disabled=raw.length>=8;if(add.disabled)add.title='The wheel holds 8 looks';
      tools.append(add);
      if(a.openWheel){const o=button('Open wheel',a.openWheel);o.disabled=!raw.length;tools.append(o);}
      intro.append(text,tools);root.append(intro);
      const prefs=node('div','wf-wheel-prefs');
      function seg(label,list,cur,on){const g=node('div','wf-seg');g.setAttribute('role','group');g.setAttribute('aria-label',label);g.append(node('span','wf-seg-label',label));list.forEach(o=>{const b=button(o.name,()=>on(o.v));const near=list.reduce((m,x)=>Math.abs(x.v-cur)<Math.abs(m.v-cur)?x:m,list[0]);b.setAttribute('aria-pressed',String(near===o));if(near===o)b.classList.add('wf-primary');g.append(b);});return g;}
      prefs.append(seg('World speed while it is up',SPEEDS,Number(w.slow)||.25,v=>edit({type:'wheel-options',slow:v,size:Number(w.size)||64})),
        seg('Wheel size',SIZES,Number(w.size)||64,v=>edit({type:'wheel-options',slow:Number(w.slow)||.25,size:v})));
      root.append(prefs);
      if(a.keyHint)root.append(node('p','wf-hint wf-wheel-key',a.keyHint));
      if(!slots.length){
        const empty=node('div','wf-wheel-empty');
        empty.append(node('h3','','No looks on the wheel yet'),node('p','wf-hint','Add your first look — a saved outfit or a wardrobe pool. Then give it a flyout of things to wear over it.'),button('Add a look',()=>pickLook(),'wf-primary'));
        root.append(empty);return;
      }
      const list=node('ol','wf-wheel-list');
      slots.forEach((r,i)=>{
        const card=node('li','wf-wheel-slot'), head=node('div','wf-wheel-head');
        const title=node('div','wf-row-title');
        title.append(node('span','wf-wheel-pos',clock(i,slots.length)),node('h3','',r.name),node('span','wf-row-meta',r.kind==='wardrobe'?'Wardrobe pool · '+(r.count||0)+' looks':'Outfit'));
        head.append(image(r.image,r.name),title);
        const moves=node('div','wf-tools wf-wheel-moves');
        const left=button('‹ Earlier',()=>{const s=slotsNow();const j=s.findIndex(x=>x.kind===r.kind&&x.id===r.id);if(j>0){s.splice(j-1,0,s.splice(j,1)[0]);saveSlots(s);}});left.disabled=i===0;left.setAttribute('aria-label','Move '+r.name+' earlier on the wheel');
        const right=button('Later ›',()=>{const s=slotsNow();const j=s.findIndex(x=>x.kind===r.kind&&x.id===r.id);if(j>=0&&j<s.length-1){s.splice(j+1,0,s.splice(j,1)[0]);saveSlots(s);}});right.disabled=i===slots.length-1;right.setAttribute('aria-label','Move '+r.name+' later on the wheel');
        const key=M.key(r.kind,r.id);
        const del=button(s.wheelDelete===key?'Confirm remove':'Remove',()=>{if(s.wheelDelete!==key){s.wheelDelete=key;render();return;}s.wheelDelete='';saveSlots(slotsNow().filter(x=>!(x.kind===r.kind&&x.id===r.id)));},'wf-danger');
        moves.append(left,right,del);head.append(moves);card.append(head);
        const fly=node('div','wf-wheel-fly');
        const rawSlot=raw.find(x=>x.kind===r.kind&&x.id===r.id)||{flyout:[]};
        fly.append(node('div','wf-wheel-fly-label','Layer over it'+(rawSlot.flyout.length?' · '+rawSlot.flyout.length+' of 8':'')));
        const chips=node('div','wf-wheel-chips');
        rawSlot.flyout.forEach((x,j)=>{
          const chip=node('div','wf-wheel-choice'+(x.item?' is-piece':''));
          chip.append(image(choiceArt(x),'','wf-mini'));
          const t=node('div','wf-wheel-choice-text');t.append(node('span','wf-wheel-choice-name',choiceName(x)),node('small','',choiceSub(x)));chip.title=choiceName(x)+' — '+choiceSub(x);chip.append(t);
          const ctl=node('div','wf-wheel-choice-ctl');
          const up=button('‹',()=>{const sl=slotsNow(),z=sl.find(v=>v.kind===r.kind&&v.id===r.id);if(z&&j>0){z.flyout.splice(j-1,0,z.flyout.splice(j,1)[0]);saveSlots(sl);}});up.disabled=j===0;up.setAttribute('aria-label','Move '+choiceName(x)+' earlier');
          const dn=button('›',()=>{const sl=slotsNow(),z=sl.find(v=>v.kind===r.kind&&v.id===r.id);if(z&&j<z.flyout.length-1){z.flyout.splice(j+1,0,z.flyout.splice(j,1)[0]);saveSlots(sl);}});dn.disabled=j===rawSlot.flyout.length-1;dn.setAttribute('aria-label','Move '+choiceName(x)+' later');
          const rm=button('×',()=>{const sl=slotsNow(),z=sl.find(v=>v.kind===r.kind&&v.id===r.id);if(z){z.flyout.splice(j,1);saveSlots(sl);}},'wf-wheel-x');rm.setAttribute('aria-label','Remove '+choiceName(x)+' from this flyout');rm.title='Remove';
          ctl.append(up,dn,rm);chip.append(ctl);chips.append(chip);
        });
        if(rawSlot.flyout.length<8){const plus=button('+ Add a Flair set or piece',()=>pickChoice(r),'wf-wheel-add');chips.append(plus);}
        if(!rawSlot.flyout.length)fly.append(node('p','wf-hint','Nothing fans out yet — this look is worn on its own.'));
        fly.append(chips);card.append(fly);list.append(card);
      });
      root.append(list);
    }
    function pickLook(){
      const taken=new Set(slotsNow().map(x=>M.key(x.kind,x.id)));
      const looks=M.rows(doc(),false).filter(r=>!taken.has(M.key(r.kind,r.id)));
      chooser({title:'Add a look to the wheel',hint:'A saved outfit, or a wardrobe pool that picks one of its looks each time.',
        groups:[{label:'Outfits',items:looks.filter(r=>r.kind==='outfit').map(r=>({id:M.key(r.kind,r.id),name:r.name,sub:r.fav?'Favorite':'Outfit',img:r.image,row:r}))},
                {label:'Wardrobe pools',items:looks.filter(r=>r.kind==='wardrobe').map(r=>({id:M.key(r.kind,r.id),name:r.name,sub:(r.count||0)+' looks',img:r.image,row:r}))}],
        empty:'Every look is already on the wheel, or none are saved yet. Create looks under Collection → Outfits.',
        pick:it=>{const sl=slotsNow();if(sl.length>=8){say('The wheel holds 8 looks.',true);return;}sl.push({kind:it.row.kind,id:it.row.id,flyout:[]});saveSlots(sl,'Added '+it.row.name+' — now give it a flyout.');}});
    }
    function pickChoice(r){
      const sl=slotsNow(), z=sl.find(v=>v.kind===r.kind&&v.id===r.id); if(!z)return;
      const has=new Set(z.flyout.map(x=>x.set?'set:'+x.set:('item:'+x.item.formId+'|'+x.item.plugin).toLowerCase()));
      const seen=new Set(), pieces=(a.items()||[]).filter(p=>{if(!p||!p.formId||!p.plugin)return false;const k=(p.formId+'|'+p.plugin).toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
      function addChoice(x){const sl2=slotsNow(),z2=sl2.find(v=>v.kind===r.kind&&v.id===r.id);if(!z2)return;if(z2.flyout.length>=8){say('A flyout holds 8 choices.',true);return;}z2.flyout.push(x);saveSlots(sl2,'Added to '+r.name+'’s flyout.');}
      const extra=[];
      if(a.pickItem)extra.push({label:'Find a piece in the whole load order…',run:()=>a.pickItem(p=>addChoice({item:{formId:p.formId,plugin:p.plugin,name:p.name||'',slot:p.slot||''}}),{title:'Choose a piece to layer over '+r.name,multi:false})});
      extra.push({label:'Make a new Flair set…',run:()=>{if(a.goFlair)a.goFlair();}});
      chooser({title:'Layer over '+r.name,hint:'A Flair set puts on its whole combination; a single piece puts on just that piece. Either replaces whatever the outfit wears in the same slot.',
        groups:[{label:'Flair sets',items:f().sets.filter(v=>!has.has('set:'+v.id)).map(v=>({id:'set:'+v.id,name:v.name,sub:(v.items||[]).length+((v.items||[]).length===1?' piece':' pieces'),img:v.icon||((v.items||[])[0]?a.itemImage(v.items[0]):''),choice:{set:v.id}}))},
                {label:'Single pieces',items:pieces.filter(p=>!has.has(('item:0x'+parseInt(p.formId,16).toString(16).toUpperCase()+'|'+p.plugin).toLowerCase())).map(p=>({id:(p.formId+'|'+p.plugin).toLowerCase(),name:p.name||p.formId,sub:p.slot||p.plugin,img:a.itemImage(p),choice:{item:{formId:p.formId,plugin:p.plugin,name:p.name||'',slot:p.slot||''}}}))}],
        empty:'No Flair sets or equipment to choose yet. Make a Flair set, or open Collection → Outfit builder so your equipment is listed.',
        extra,pick:it=>addChoice(it.choice)});
    }
    /* wardrobe-wheel-chooser: a body-anchored popout, never an inline expander
       (it grows with the load order). It OWNS the keyboard while up: a window
       capture listener runs before the deck's document-level handler, so a
       typed letter can never fire a real hotkey; Enter takes the top hit. */
    function chooser(o){
      if(window.__wfChooserClose)window.__wfChooserClose();
      const back=node('div','wf-pop-back'), pop=node('section','wf-pop');pop.setAttribute('role','dialog');pop.setAttribute('aria-modal','true');pop.setAttribute('aria-label',o.title);
      const head=node('header','wf-pop-head'), h=node('div');h.append(node('h2','',o.title),node('p','wf-hint',o.hint||''));
      const x=button('×',()=>close(),'wf-pop-x');x.setAttribute('aria-label','Close');head.append(h,x);
      const q=node('input','wf-search wf-pop-search');q.type='search';q.autocomplete='off';q.spellcheck=false;q.placeholder='Search by name, slot or mod…';q.setAttribute('aria-label','Search choices');
      const results=node('div','wf-pop-results');pop.append(head,q,results);
      if(o.extra&&o.extra.length){const foot=node('footer','wf-pop-foot');o.extra.forEach(e=>foot.append(button(e.label,()=>{close();e.run();})));pop.append(foot);}
      back.append(pop);document.body.append(back);
      let hits=[];
      function paint(){results.textContent='';hits=[];const t=q.value.trim().toLowerCase();
        o.groups.forEach(g=>{const m=g.items.filter(it=>!t||(it.name+' '+(it.sub||'')).toLowerCase().includes(t));if(!m.length)return;results.append(node('h3','wf-pop-group',g.label+' · '+m.length));const grid=node('div','wf-pop-grid');
          m.slice(0,120).forEach(it=>{hits.push(it);const b=button('',()=>{close();o.pick(it);},'wf-pop-choice');b.append(image(it.img,'','wf-pop-img'));const tx=node('span','wf-pop-text');tx.append(node('span','wf-pop-name',it.name),node('small','',it.sub||''));b.append(tx);grid.append(b);});
          if(m.length>120)grid.append(node('p','wf-hint','Showing 120 of '+m.length+'. Type to narrow it down.'));results.append(grid);});
        if(!hits.length)results.append(node('p','wf-empty',t?'No matches. Try another name, slot or mod.':o.empty));}
      function key(e){
        if(!back.isConnected){window.removeEventListener('keydown',key,true);return;}
        if(e.key==='Escape'){e.preventDefault();close();}
        else if(e.key==='Enter'&&e.target===q){e.preventDefault();if(hits[0]){close();o.pick(hits[0]);}}
        else if(e.key==='ArrowDown'&&e.target===q){e.preventDefault();const b=results.querySelector('.wf-pop-choice');if(b)b.focus();}
        else if(e.key==='Enter'&&e.target&&e.target.classList&&e.target.classList.contains('wf-pop-choice')){e.preventDefault();e.target.click();}
        e.stopImmediatePropagation();
      }
      function close(){window.removeEventListener('keydown',key,true);if(back.isConnected)back.remove();if(window.__wfChooserClose===close)window.__wfChooserClose=null;}
      window.__wfChooserClose=close;
      back.addEventListener('mousedown',e=>{if(e.target===back)close();});
      q.addEventListener('input',paint);window.addEventListener('keydown',key,true);paint();setTimeout(()=>q.focus(),0);
    }
    function render(){root.textContent='';if(a.page==='dock')renderDock();else if(a.page==='wheel')renderWheel();else renderFlair();}
    render();return {render,say,state:s};
  }
  window.WardrobeFlairUI={mount};
})();
