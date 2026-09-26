/* Portrait favorites dock. Owns keys ONLY while its HUD view owns focus. */
(function () {
  'use strict';
  const M=window.WardrobeFlairModel;
  if(!M) return;
  let doc={}, open=false, closing=false, positioning=false, category='', selection=0, query='', prompt=null, choosing=true, drag=null, timer=0, categoryTimer=0, placement=null;
  const cards=new Map();
  const root=document.createElement('section');root.id='outfit-dock';root.hidden=true;root.setAttribute('aria-label','Favorite outfits');
  root.innerHTML='<div class="od-surface"><header class="od-head"><button type="button" class="od-grip" aria-label="Drag outfit dock" title="Drag to move; position is saved"><span>WARDROBE</span><b>Favorites</b></button><button type="button" class="od-close" aria-label="Close outfit dock">×</button></header><div class="od-category"><button type="button" data-step="-1" aria-label="Previous category">‹</button><div class="od-category-title"><img width="44" height="44" alt=""><span></span></div><button type="button" data-step="1" aria-label="Next category">›</button></div><input class="od-search" type="search" placeholder="Search favorite outfits…" aria-label="Search favorite outfits"><div class="od-stage" role="listbox" aria-label="Favorite outfits"><div class="od-empty"></div></div><div class="od-confirm" role="dialog" aria-modal="true" aria-label="Include attached Flair?" hidden><h2>Equip attached Flair?</h2><p></p><div><button type="button" data-choice="yes">With Flair</button><button type="button" data-choice="no">No Flair</button></div><small>A / D choose · E confirm · Esc back</small></div><footer class="od-foot"><div><kbd>W</kbd><kbd>S</kbd> Outfit <kbd>A</kbd><kbd>D</kbd> Category</div><div><kbd>E</kbd> Equip <kbd>Esc</kbd> Close <span class="od-count"></span></div></footer><div class="od-live" aria-live="polite"></div></div>';
  document.body.appendChild(root);
  const el=s=>root.querySelector(s), stage=el('.od-stage'), search=el('.od-search'), modal=el('.od-confirm');
  const layoutButton=document.createElement('button');layoutButton.type='button';layoutButton.className='od-layout';
  el('.od-head').insertBefore(layoutButton,el('.od-close'));
  const positionTools=document.createElement('div');positionTools.className='od-placement';positionTools.hidden=true;
  positionTools.innerHTML='<p>Drag the gold header to move. Arrow keys nudge; edges snap.</p><div class="od-size-tools"><button type="button" data-size="-1" aria-label="Make dock smaller">−</button><output class="od-size" aria-label="Dock size"></output><button type="button" data-size="1" aria-label="Make dock larger">+</button><button type="button" class="od-center">Center</button></div>';
  el('.od-surface').insertBefore(positionTools,el('.od-foot'));
  const positionButton=document.createElement('button');positionButton.type='button';positionButton.className='od-position';positionButton.textContent='Move / resize';
  el('.od-surface').insertBefore(positionButton,el('.od-live'));
  function send(fn,arg){if(typeof window[fn]==='function')window[fn](typeof arg==='string'?arg:JSON.stringify(arg));}
  function parse(j){try{return typeof j==='string'?JSON.parse(j):j;}catch(_){return null;}}
  function reduced(){return M.flair(doc).dock.motion==='reduced'||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}
  function rows(){return M.visible(doc,category,query);}
  function place(snap){
    const c=Object.assign({x:88,y:50,scale:1},M.flair(doc).dock), horizontal=c.orientation==='horizontal';
    root.classList.toggle('od-horizontal',horizontal);root.classList.toggle('od-reduced',reduced());
    layoutButton.textContent=horizontal?'Vertical':'Horizontal';layoutButton.title='Switch to a '+(horizontal?'vertical':'horizontal')+' dock';layoutButton.setAttribute('aria-label',layoutButton.title);
    stage.setAttribute('aria-orientation',horizontal?'horizontal':'vertical');
    placement=M.fitDock(c,window.innerWidth,window.innerHeight,root.offsetWidth||(horizontal?880:430),root.offsetHeight||(horizontal?540:807),snap);
    root.style.setProperty('--od-scale',String(placement.scale));
    // Entrance motion comes from INSIDE the available screen space, including
    // a bottom/right anchored dock. The selected portrait has reserved room.
    root.style.setProperty('--od-enter-x',horizontal?'0px':(placement.x>window.innerWidth/2?'-18px':'18px'));
    root.style.setProperty('--od-enter-y',horizontal?(placement.y>window.innerHeight/2?'-18px':'18px'):'0px');
    root.style.left=placement.x+'px';root.style.top=placement.y+'px';
    const size=Number(c.scale)||1;
    el('.od-size').textContent=Math.round(size*100)+'%';
    el('[data-size="-1"]').disabled=size<=.65;
    el('[data-size="1"]').disabled=size>=1.4;
  }
  function savePlacement(){
    if(!placement)return;
    const c=Object.assign({scale:1,motion:'full',orientation:'vertical'},M.flair(doc).dock);
    const edit={type:'dock',x:100*placement.x/window.innerWidth,y:100*placement.y/window.innerHeight,scale:c.scale,motion:c.motion,orientation:c.orientation,edgeX:placement.edgeX,edgeY:placement.edgeY};
    M.apply(doc,edit);send('wfEdit',edit);
  }
  function flipLayout(){
    if(!open||prompt||closing)return;
    const f=M.flair(doc);f.dock=Object.assign({},f.dock,{orientation:f.dock.orientation==='horizontal'?'vertical':'horizontal'});doc.flair=f;
    paint();savePlacement();
  }
  function setPositioning(on){
    positioning=!!on;root.classList.toggle('od-positioning',positioning);
    positionTools.hidden=!positioning;el('.od-foot').hidden=positioning;
    positionButton.textContent=positioning?'Done — save position':'Move / resize';
    positionButton.setAttribute('aria-pressed',String(positioning));
    el('.od-grip b').textContent=positioning?'Drag to move':'Favorites';
    search.disabled=positioning;
    if(positioning&&prompt)dismissPrompt();
    place();
  }
  function resizeDock(step){
    if(!open||!positioning||closing)return;
    const f=M.flair(doc);f.dock=Object.assign({},f.dock,{scale:Math.max(.65,Math.min(1.4,Math.round(((Number(f.dock.scale)||1)+step*.05)*100)/100))});doc.flair=f;
    place();savePlacement();
  }
  function moveTo(x,y){
    const f=M.flair(doc);f.dock=Object.assign({},f.dock,{x,y,edgeX:'',edgeY:''});doc.flair=f;place();savePlacement();
  }
  function finishPositioning(){endDrag();savePlacement();close();}
  function portrait(r){return typeof r.image==='string'&&M.imageOK(r.image.split('?')[0])&&r.image?r.image.split('?')[0]:'icons/custom/hm-wardrobe.png';}
  function framePortrait(img,r){
    const file=portrait(r), crop=(doc.imageCrops||{})[file.split('?')[0].split('/').pop()]||{}, z=Math.max(1,Math.min(8,Number(crop.z)||1));
    img.src=file;img.style.width=(112*z)+'px';img.style.height=(140*z)+'px';
    img.style.left=((112-112*z)/2+(Number(crop.x)||0)*112)+'px';
    img.style.top=((140-140*z)/2+(Number(crop.y)||0)*140)+'px';
    img.onerror=function(){this.onerror=null;this.src='icons/custom/hm-wardrobe.png';this.style.width='112px';this.style.height='140px';this.style.left='0';this.style.top='0';};
  }
  function paint(direction){
    const cats=M.categories(doc);if(!cats.some(c=>c.id===category))category='';
    const cat=cats.find(c=>c.id===category)||cats[0], list=rows();selection=Math.max(0,Math.min(selection,list.length-1));
    el('.od-category-title span').textContent=cat.name;
    el('.od-category-title img').src=cat.icon||'icons/custom/hm-wardrobe.png';
    const live=new Set();
    list.forEach((r,i)=>{
      let offset=i-selection;
      if(offset>list.length/2)offset-=list.length;
      if(offset< -list.length/2)offset+=list.length;
      if(Math.abs(offset)>3)return;
      const k=M.key(r.kind,r.id);live.add(k);let b=cards.get(k);
      if(!b){
        b=document.createElement('button');b.type='button';b.className='od-card';b.setAttribute('role','option');
        const frame=document.createElement('span');frame.className='od-picture';const img=document.createElement('img');img.width=128;img.height=154;img.alt='';img.draggable=false;frame.appendChild(img);
        const caption=document.createElement('span');caption.className='od-caption';const kind=document.createElement('small'),name=document.createElement('strong'),flair=document.createElement('span');flair.className='od-flair-tag';caption.append(kind,name,flair);b.append(frame,caption);stage.appendChild(b);cards.set(k,b);
        b.addEventListener('click',()=>{const idx=rows().findIndex(x=>M.key(x.kind,x.id)===k);if(idx>=0){if(selection===idx)choose();else{selection=idx;paint();}}});
      }
      framePortrait(b.querySelector('img'),r);
      b.querySelector('small').textContent=r.kind==='wardrobe'?'WARDROBE · '+r.count+' looks':'OUTFIT';b.querySelector('strong').textContent=r.name;
      const set=M.flair(doc).sets.find(s=>s.id===r.flairId);b.querySelector('.od-flair-tag').textContent=set?'With optional '+set.name:'';
      b.style.setProperty('--od-offset',String(offset));b.style.setProperty('--od-depth',String(Math.abs(offset)));
      b.classList.toggle('is-selected',offset===0);b.setAttribute('aria-selected',String(offset===0));b.tabIndex=offset===0?0:-1;
      b.style.zIndex=String(10-Math.abs(offset));b.style.opacity=Math.abs(offset)>2?'0':String(1-Math.abs(offset)*.25);
    });
    cards.forEach((b,k)=>{if(!live.has(k)){b.remove();cards.delete(k);}});
    el('.od-empty').textContent=list.length?'':query?'No favorite outfits match that search.':'No favorites in this category. Star outfits in Wardrobe → Favorites dock.';
    el('.od-count').textContent=list.length?(selection+1)+' / '+list.length:'';
    if(direction){clearTimeout(categoryTimer);const targets=[stage,el('.od-category-title')];targets.forEach(t=>t.classList.remove('od-category-left','od-category-right'));void stage.offsetWidth;targets.forEach(t=>t.classList.add(direction>0?'od-category-right':'od-category-left'));categoryTimer=setTimeout(()=>targets.forEach(t=>t.classList.remove('od-category-left','od-category-right')),280);}
    el('.od-live').textContent=cat.name+(list[selection]?': '+list[selection].name:'');place();
  }
  function focusSelected(){const b=el('.od-card.is-selected');if(b)b.focus();}
  function categoryStep(d){if(prompt||positioning)return;const cats=M.categories(doc),i=cats.findIndex(c=>c.id===category);category=cats[(i+d+cats.length)%cats.length].id;selection=0;paint(d);focusSelected();}
  function scroll(d){if(prompt||positioning)return;const list=rows();selection=list.length?(selection+d+list.length)%list.length:0;paint();focusSelected();}
  function choose(){const row=rows()[selection];if(!row||closing||positioning)return;if(row.flairId){prompt=Object.assign({},row);root.classList.add('od-prompt');choosing=true;modal.hidden=false;modal.querySelector('p').textContent=(M.flair(doc).sets.find(s=>s.id===row.flairId)||{}).name||'Attached Flair';paintChoice();}else equip(row,false);}
  function paintChoice(){modal.querySelectorAll('[data-choice]').forEach(b=>b.classList.toggle('is-chosen',(b.dataset.choice==='yes')===choosing));modal.querySelector('[data-choice="'+(choosing?'yes':'no')+'"]').focus();}
  function dismissPrompt(){prompt=null;modal.hidden=true;root.classList.remove('od-prompt');paint();const b=el('.od-card.is-selected');if(b&&open)b.focus();}
  function equip(row,withFlair){
    closing=true;root.classList.add('od-equipped');
    const request={kind:row.kind,id:row.id,includeFlair:withFlair,expectedFlairId:row.flairId||''};
    timer=setTimeout(()=>{root.classList.remove('is-open');timer=setTimeout(()=>{root.hidden=true;open=false;closing=false;prompt=null;modal.hidden=true;root.classList.remove('od-prompt');root.classList.remove('od-equipped');send('odEquip',request);},reduced()?0:170);},reduced()?0:190);
  }
  function close(){if(!open||closing)return;closing=true;root.classList.remove('is-open');timer=setTimeout(()=>{root.hidden=true;open=false;closing=false;dismissPrompt();send('odClose','');},reduced()?0:190);}
  function show(on,edit){
    clearTimeout(timer);closing=false;open=!!on;
    setPositioning(open&&edit);
    if(!open){root.hidden=true;root.classList.remove('is-open','od-equipped');prompt=null;modal.hidden=true;root.classList.remove('od-prompt');drag=null;root.classList.remove('od-dragging');return;}
    query='';search.value='';root.hidden=false;prompt=null;modal.hidden=true;root.classList.remove('od-prompt');paint();
    requestAnimationFrame(()=>{if(open){root.classList.add('is-open');const b=el('.od-card.is-selected');if(positioning)positionButton.focus();else if(b)b.focus();else el('.od-close').focus();}});
  }
  function keydown(e){
    if(!open||closing)return;
    const key=String(e.key||'').toLowerCase(), typing=e.target===search;
    if(positioning){
      let handled=true;const step=e.shiftKey?48:12;
      if(key==='escape'||key==='enter')finishPositioning();
      else if(['arrowleft','a','arrowright','d','arrowup','w','arrowdown','s'].includes(key)){
        const dx=['arrowleft','a'].includes(key)?-step:['arrowright','d'].includes(key)?step:0;
        const dy=['arrowup','w'].includes(key)?-step:['arrowdown','s'].includes(key)?step:0;
        moveTo(100*(placement.x+dx)/window.innerWidth,100*(placement.y+dy)/window.innerHeight);
      }else if(key==='+'||key==='=')resizeDock(1);
      else if(key==='-'||key==='−')resizeDock(-1);
      else if(key!=='e')handled=false;
      if(handled){e.preventDefault();e.stopImmediatePropagation();}return;
    }
    if(typing&&key!=='escape'&&key!=='enter'&&key!=='arrowdown'&&key!=='arrowup')return;
    let handled=true;
    if(key==='tab'&&prompt){e.preventDefault();choosing=!choosing;paintChoice();e.stopImmediatePropagation();return;}
    if(key==='escape'){if(prompt)dismissPrompt();else if(typing&&query){query='';search.value='';paint();}else close();}
    else if(prompt){if(['a','arrowleft','d','arrowright'].includes(key)){choosing=!choosing;paintChoice();}else if(['e','enter'].includes(key))equip(prompt,choosing);else handled=false;}
    else if(['w','arrowup'].includes(key))scroll(-1);
    else if(['s','arrowdown'].includes(key))scroll(1);
    else if(['a','arrowleft'].includes(key))categoryStep(-1);
    else if(['d','arrowright'].includes(key))categoryStep(1);
    else if(['e','enter'].includes(key))choose();
    else if(key==='/'){search.focus();}else handled=false;
    if(handled){e.preventDefault();e.stopImmediatePropagation();}
  }
  document.addEventListener('keydown',keydown,true);
  el('.od-close').addEventListener('click',close);
  root.querySelectorAll('[data-step]').forEach(b=>b.addEventListener('click',()=>categoryStep(Number(b.dataset.step))));
  modal.querySelectorAll('[data-choice]').forEach(b=>b.addEventListener('click',()=>{if(prompt)equip(prompt,b.dataset.choice==='yes');}));
  search.addEventListener('input',()=>{query=search.value;selection=0;paint();});
  stage.addEventListener('wheel',e=>{if(open&&!prompt&&!closing){e.preventDefault();const delta=Math.abs(e.deltaX||0)>Math.abs(e.deltaY||0)?e.deltaX:e.deltaY;if(delta)scroll(delta>0?1:-1);}}, {passive:false});
  layoutButton.addEventListener('click',flipLayout);
  positionButton.addEventListener('click',()=>{if(positioning)finishPositioning();else if(open&&!closing){setPositioning(true);positionButton.focus();}});
  positionTools.querySelectorAll('[data-size]').forEach(b=>b.addEventListener('click',()=>resizeDock(Number(b.dataset.size))));
  el('.od-center').addEventListener('click',()=>{if(open&&positioning&&!closing)moveTo(50,50);});
  function startDrag(x,y){if(!open||prompt||closing)return;drag={x,y,left:parseFloat(root.style.left),top:parseFloat(root.style.top)};root.classList.add('od-dragging');}
  function moveDrag(x,y){if(!drag||!open)return;const f=M.flair(doc);f.dock=Object.assign({},f.dock,{x:100*(drag.left+x-drag.x)/window.innerWidth,y:100*(drag.top+y-drag.y)/window.innerHeight,edgeX:'',edgeY:''});doc.flair=f;place(true);}
  function endDrag(){if(!drag)return;drag=null;root.classList.remove('od-dragging');savePlacement();}
  el('.od-grip').addEventListener('mousedown',e=>{if(e.button!==0)return;startDrag(e.clientX,e.clientY);e.preventDefault();});
  document.addEventListener('mousemove',e=>moveDrag(e.clientX,e.clientY));
  document.addEventListener('mouseup',endDrag);
  el('.od-grip').addEventListener('touchstart',e=>{const t=e.touches[0];if(t){startDrag(t.clientX,t.clientY);e.preventDefault();}},{passive:false});
  document.addEventListener('touchmove',e=>{if(drag&&e.touches[0]){moveDrag(e.touches[0].clientX,e.touches[0].clientY);e.preventDefault();}},{passive:false});
  document.addEventListener('touchend',endDrag);
  document.addEventListener('touchcancel',endDrag);
  window.addEventListener('resize',()=>{if(open)place();});
  window.odData=j=>{const next=parse(j);if(!next)return;const prior=rows()[selection];doc=next;const list=rows();if(prior){const i=list.findIndex(r=>r.kind===prior.kind&&r.id===prior.id);if(i>=0)selection=i;}if(open)paint();};
  window.odShow=j=>{const v=parse(j);if(v&&typeof v==='object')show(v.open===true,v.placement===true);else show(j===true||j==='1'||j==='true');};
  window.OutfitDock={show,close,paint,key:keydown,scroll,categoryStep,choose,_state:()=>({open,closing,positioning,category,selection,prompt,doc,placement}),_root:root};
})();
