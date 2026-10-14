(function () {
  'use strict';
  const W=window.WardrobePane,M=window.WardrobeFlairModel,U=window.WardrobeFlairUI;
  if(!W||!M||!U)return;
  const ui={flair:{},dock:{},wheel:{}};let active=null;
  function send(fn,arg){if(typeof window[fn]==='function')window[fn](arg===undefined?'':JSON.stringify(arg));}
  function register(id,label,page){W.registerSub({id,label,ownsSearch:true,init(){},onEnter(){send('hdIconList');},setFilter(q){ui[page].q=q;},count(){return page==='flair'?M.flair(W._state).sets.length:page==='wheel'?M.wheel(W._state).slots.length:M.rows(W._state,true).length;},render(ctx){
    const host=document.createElement('div');ctx.list.appendChild(host);
    active=U.mount(host,{page,data:()=>W._state,image:p=>p,itemImage:p=>W.itemIconFor(p)||'',items:()=>W._state.inventory||[],icons:()=>window.hdWardrobeIconChoices?window.hdWardrobeIconChoices():[],
      edit:async e=>{M.apply(W._state,e);send('wfEdit',e);},
      equip:r=>send('odEquip',r),openDock:()=>send('odOpen'),placeDock:()=>send('odOpen',{placement:true}),
      pickItem:(add,opt)=>{if(!window.HDItemPick)return;opt=opt||{};HDItemPick.open({title:opt.title||'Choose Flair accessories',hint:'Rings, necklaces, hoods, cloaks and other armor pieces.',multi:opt.multi!==false,chosen:()=>((ui.flair.draft||{}).items||[]).map(p=>({plugin:p.plugin,localId:parseInt(p.formId,16)})),onPick:p=>{if(p.type!=='armo'){active.say('Choose an armor or accessory item.',true);return;}add({formId:'0x'+Number(p.localId).toString(16).toUpperCase(),plugin:p.plugin,name:p.name});}});},
      openWheel:()=>send('wwOpen'),keyHint:'Bind “Wardrobe Wheel” in Hotkeys (F2) to open it over live play — time slows while you choose.',
      goFlair:()=>{ui.flair.draft={id:'f'+Date.now().toString(36),name:'',icon:'',items:[]};if(W.openSection)W.openSection('flair');},
    },ui[page]);return page==='flair'?M.flair(W._state).sets.length:page==='wheel'?M.wheel(W._state).slots.length:M.rows(W._state,true).length;
  }});}
  register('flair','Flair','flair');register('wheel','Wardrobe wheel','wheel');register('dock','Favorites dock','dock');
  window.wfState=j=>{try{if(typeof j==='string')j=JSON.parse(j);['flair','categories','outfitMeta','wardrobes'].forEach(k=>{if(j[k])W._state[k]=j[k];});if(active)active.render();}catch(e){console.log('flair state',e);}};
  window.wfResult=j=>{try{if(typeof j==='string')j=JSON.parse(j);if(active)active.say(j.msg||'',!j.ok);}catch(_){}};
})();
