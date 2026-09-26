/* One metadata / selection model for the deck, HUD, portal and its queue. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WardrobeFlairModel = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const text = (v, max) => typeof v === 'string' && v.length <= max ? v.trim() : '';
  const idOK = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v) && !['__proto__','constructor','prototype'].includes(v);
  const imageOK = v => v === '' || (typeof v === 'string' && v.length < 260 && /^icons\/(custom|items)\/[a-zA-Z0-9 _~().@+-]+\.(png|jpg|jpeg|webp)$/i.test(v));
  function flair(doc) {
    const f = doc.flair || {};
    return Object.assign({ sets: [], links: {}, categoryIcons: {}, pools: {}, keep: true, dock: {} }, f);
  }
  const key = (kind,id) => kind + ':' + id;
  function need(ok, msg) { if (!ok) throw new Error(msg); }
  function validate(edit) {
    need(edit && typeof edit === 'object', 'Missing edit');
    const e = clone(edit), k = e.type;
    if (['set','delete','category','category-delete','category-icon','pool'].includes(k)) need(idOK(e.id), 'Invalid identifier');
    if (k === 'set') {
      e.name = text(e.name, 100); need(e.name, 'Give the Flair set a name');
      e.icon = e.icon || ''; need(imageOK(e.icon), 'Choose an image from the icon library');
      need(Array.isArray(e.items) && e.items.length > 0 && e.items.length <= 32, 'Choose 1 to 32 accessories');
      const seen = new Set();
      e.items = e.items.map(p => {
        need(p && typeof p === 'object' && /^0x[0-9a-f]{1,6}$/i.test(p.formId) && parseInt(p.formId,16)>0 && /^.{1,120}\.(esm|esp|esl)$/i.test(p.plugin) && !/[\\/|]/.test(p.plugin), 'An accessory needs its plugin and local FormID');
        const q = {formId:'0x'+parseInt(p.formId,16).toString(16).toUpperCase(),plugin:p.plugin,name:text(p.name,160),slot:text(p.slot,40)};
        const token = (q.formId+'|'+q.plugin).toLowerCase(); need(!seen.has(token),'The same accessory was selected twice'); seen.add(token); return q;
      });
    } else if (k === 'link') {
      need(['outfit','wardrobe'].includes(e.kind) && text(e.id,160), 'Choose an outfit or wardrobe');
      need(e.flairId === '' || idOK(e.flairId), 'Choose a Flair set');
    } else if (k === 'favorite') {
      need(text(e.name,160) && typeof e.value === 'boolean','Choose an outfit and favorite state');
    } else if (k === 'categories') {
      need(['outfit','wardrobe'].includes(e.kind) && text(e.id,160), 'Choose an outfit or wardrobe');
      need(Array.isArray(e.ids) && e.ids.length <= 50 && e.ids.every(idOK),'Choose valid categories');
      e.ids = [...new Set(e.ids)];
    } else if (k === 'category') {
      e.name = text(e.name,64); need(e.name, 'Name the category');
    } else if (k === 'category-icon') need(imageOK(e.icon), 'Choose an image from the icon library');
    else if (k === 'pool') { if ('fav' in e) need(typeof e.fav === 'boolean','Invalid favorite'); if ('image' in e) need(imageOK(e.image),'Invalid image'); }
    else if (k === 'keep') need(typeof e.value === 'boolean','Invalid keep setting');
    else if (k === 'dock-enabled') need(typeof e.value === 'boolean','Invalid dock enabled setting');
    else if (k === 'dock') {
      need(['x','y','scale'].every(p => typeof e[p] === 'number' && isFinite(e[p])),'Invalid dock position');
      e.x = Math.max(0,Math.min(100,e.x)); e.y = Math.max(0,Math.min(100,e.y)); e.scale = Math.max(.65,Math.min(1.4,e.scale));
      if ('orientation' in e) need(['vertical','horizontal'].includes(e.orientation),'Invalid dock layout');
      if ('edgeX' in e) need(['','left','right'].includes(e.edgeX),'Invalid horizontal edge');
      if ('edgeY' in e) need(['','top','bottom'].includes(e.edgeY),'Invalid vertical edge');
    } else need(['delete','category-delete'].includes(k),'Unknown Flair edit');
    return e;
  }
  function apply(doc, raw) {
    const e = validate(raw), f = clone(flair(doc));
    doc.categories = doc.categories || []; doc.outfitMeta = doc.outfitMeta || []; doc.wardrobes = doc.wardrobes || [];
    const meta = name => { let m = doc.outfitMeta.find(m=>m.name===name); if(!m){m={name:name};doc.outfitMeta.push(m);} return m; };
    const pool = id => { need(doc.wardrobes.some(p=>p.id===id),'That wardrobe no longer exists'); return f.pools[id] || (f.pools[id]={}); };
    if(e.type === 'set') { const i=f.sets.findIndex(s=>s.id===e.id); const v={id:e.id,name:e.name,icon:e.icon,items:e.items}; if(i<0){need(f.sets.length<100,'Maximum 100 Flair sets');f.sets.push(v);}else f.sets[i]=v; }
    if(e.type === 'delete') {f.sets=f.sets.filter(s=>s.id!==e.id);Object.keys(f.links).forEach(k=>{if(f.links[k]===e.id)delete f.links[k];});}
    if(e.type === 'link') {need(!e.flairId||f.sets.some(s=>s.id===e.flairId),'That Flair set no longer exists');if(e.kind==='wardrobe')pool(e.id);if(e.flairId)f.links[key(e.kind,e.id)]=e.flairId;else delete f.links[key(e.kind,e.id)];}
    if(e.type === 'favorite') meta(e.name).fav=e.value;
    if(e.type === 'categories') {need(e.ids.every(id=>doc.categories.some(c=>c.id===id)),'A category no longer exists');(e.kind==='outfit'?meta(e.id):pool(e.id)).categoryIds=e.ids;}
    if(e.type === 'category') {let c=doc.categories.find(c=>c.id===e.id);if(c)c.name=e.name;else{need(doc.categories.length<100,'Maximum 100 categories');doc.categories.push({id:e.id,name:e.name,hue:38});}}
    if(e.type === 'category-delete') {doc.categories=doc.categories.filter(c=>c.id!==e.id);delete f.categoryIcons[e.id];doc.outfitMeta.concat(Object.values(f.pools)).forEach(m=>{if(Array.isArray(m.categoryIds))m.categoryIds=m.categoryIds.filter(id=>id!==e.id);});}
    if(e.type === 'category-icon') {need(doc.categories.some(c=>c.id===e.id),'That category no longer exists');f.categoryIcons[e.id]=e.icon;}
    if(e.type === 'pool') {const p=pool(e.id);if('fav'in e)p.fav=e.fav;if('image'in e)p.image=e.image;}
    if(e.type === 'keep') f.keep=e.value;
    if(e.type === 'dock-enabled') f.dock=Object.assign({},f.dock,{enabled:e.value});
    if(e.type === 'dock') {f.dock=Object.assign({},f.dock,{x:e.x,y:e.y,scale:e.scale,motion:e.motion==='reduced'?'reduced':'full'});['orientation','edgeX','edgeY'].forEach(k=>{if(k in e)f.dock[k]=e[k];});}
    doc.flair=f; return doc;
  }
  function rows(doc, onlyFavorites) {
    const f=flair(doc), result=[], names=new Set();
    ((doc.soes && doc.soes.outfits)||doc.outfitMeta||[]).forEach(o=>names.add(o.name));
    names.forEach(name=>{if(!name||name.indexOf('~SkyManager Flair')===0)return;const m=(doc.outfitMeta||[]).find(x=>x.name===name)||{name};if(onlyFavorites&&!m.fav)return;result.push({kind:'outfit',id:name,name,image:m.image||'',categoryIds:m.categoryIds||[],fav:!!m.fav,flairId:f.links[key('outfit',name)]||''});});
    (doc.wardrobes||[]).forEach(p=>{const m=f.pools[p.id]||{};if(onlyFavorites&&!m.fav)return;const lead=(p.outfits||[]).map(n=>(doc.outfitMeta||[]).find(o=>o.name===n)).find(o=>o&&o.image);result.push({kind:'wardrobe',id:p.id,name:p.name,image:m.image||(lead&&lead.image)||'',categoryIds:m.categoryIds||[],fav:!!m.fav,flairId:f.links[key('wardrobe',p.id)]||'',count:(p.outfits||[]).length});});
    return result.sort((a,b)=>a.name.localeCompare(b.name));
  }
  function categories(doc) {const f=flair(doc);return [{id:'',name:'Favorites',icon:''}].concat((doc.categories||[]).map(c=>({id:c.id,name:c.name,icon:f.categoryIcons[c.id]||''})));}
  function visible(doc, category, query) {const q=String(query||'').toLowerCase().trim();return rows(doc,true).filter(r=>(!category||r.categoryIds.includes(category))&&(!q||r.name.toLowerCase().includes(q)));}
  // Fit the WHOLE measured surface, including the selected portrait's reserved
  // space. Never resize just because a card is highlighted. Edge anchors survive
  // changing layout, scale or resolution; dragging has a small magnetic zone.
  function fitDock(c,vw,vh,width,height,snap) {
    const margin=16, clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    vw=Math.max(64,vw);vh=Math.max(64,vh);width=Math.max(1,width);height=Math.max(1,height);
    const scale=Math.min(clamp(Number(c.scale)||1,.65,1.4),(vw-margin*2)/width,(vh-margin*2)/height);
    const halfW=width*scale/2,halfH=height*scale/2,minX=margin+halfW,maxX=vw-margin-halfW,minY=margin+halfH,maxY=vh-margin-halfH;
    let edgeX=c.edgeX||'',edgeY=c.edgeY||'';
    let x=edgeX==='left'?minX:edgeX==='right'?maxX:clamp(vw*(c.x==null?88:c.x)/100,minX,maxX);
    let y=edgeY==='top'?minY:edgeY==='bottom'?maxY:clamp(vh*(c.y==null?50:c.y)/100,minY,maxY);
    if(snap){edgeX=x-minX<=24?'left':maxX-x<=24?'right':'';edgeY=y-minY<=24?'top':maxY-y<=24?'bottom':'';if(edgeX)x=edgeX==='left'?minX:maxX;if(edgeY)y=edgeY==='top'?minY:maxY;}
    return {x,y,scale,edgeX,edgeY,left:x-halfW,right:x+halfW,top:y-halfH,bottom:y+halfH};
  }
  return {flair,key,validate,apply,rows,categories,visible,imageOK,fitDock};
});
