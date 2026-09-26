(function () {
  'use strict';
  const W=window.WardrobePane,M=window.WardrobeFlairModel,U=window.WardrobeFlairUI;
  if(!W||!M||!U)return;
  const ui={flair:{},dock:{}};let active=null;
  function send(fn,arg){if(typeof window[fn]==='function')window[fn](arg===undefined?'':JSON.stringify(arg));}
  function register(id,label,page){W.registerSub({id,label,ownsSearch:true,init(){},onEnter(){send('hdIconList');},setFilter(q){ui[page].q=q;},count(){return page==='flair'?M.flair(W._state).sets.length:M.rows(W._state,true).length;},render(ctx){
    const host=document.createElement('div');ctx.list.appendChild(host);
    active=U.mount(host,{page,data:()=>W._state,image:p=>p,itemImage:p=>W.itemIconFor(p)||'',items:()=>W._state.inventory||[],icons:()=>window.hdWardrobeIconChoices?window.hdWardrobeIconChoices():[],
      edit:async e=>{M.apply(W._state,e);send('wfEdit',e);},
      equip:r=>send('odEquip',r),openDock:()=>send('odOpen'),placeDock:()=>send('odOpen',{placement:true}),
      pickItem:add=>{if(!window.HDItemPick)return;HDItemPick.open({title:'Choose Flair accessories',hint:'Rings, necklaces, hoods, cloaks and other armor pieces.',multi:true,chosen:()=>((ui.flair.draft||{}).items||[]).map(p=>({plugin:p.plugin,localId:parseInt(p.formId,16)})),onPick:p=>{if(p.type!=='armo'){active.say('Choose an armor or accessory item.',true);return;}add({formId:'0x'+Number(p.localId).toString(16).toUpperCase(),plugin:p.plugin,name:p.name});}});},
    },ui[page]);return page==='flair'?M.flair(W._state).sets.length:M.rows(W._state,true).length;
  }});}
  register('flair','Flair','flair');register('dock','Favorites dock','dock');
  window.wfState=j=>{try{if(typeof j==='string')j=JSON.parse(j);['flair','categories','outfitMeta','wardrobes'].forEach(k=>{if(j[k])W._state[k]=j[k];});if(active)active.render();}catch(e){console.log('flair state',e);}};
  window.wfResult=j=>{try{if(typeof j==='string')j=JSON.parse(j);if(active)active.say(j.msg||'',!j.ok);}catch(_){}};
})();
