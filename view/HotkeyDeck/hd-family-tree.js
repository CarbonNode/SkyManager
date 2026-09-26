/* Gilded lineage: a real connected graph. Layout edits are view-local only. */
(function(g){
  'use strict';
  var W=240,H=190,XGAP=56,YGAP=112,MIN=.35,MAX=1.8,LIMIT=100;
  function parent(k){return k==='parent'||k==='adoptive-parent';}
  function known(k){return parent(k)||k==='spouse'||k==='partner'||k==='ex-partner';}
  function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
  function build(people,relations,focusId){
    var by={},adj={},valid=[],seen={},queue=[],ids=[],total=0;
    (people||[]).forEach(function(p){if(p&&typeof p.id==='string'&&!by[p.id]){by[p.id]=p;adj[p.id]=[];}});
    (relations||[]).forEach(function(r){if(r&&by[r.from]&&by[r.to]&&r.from!==r.to&&known(r.kind)){valid.push(r);adj[r.from].push(r.to);adj[r.to].push(r.from);}});
    if(!by[focusId])focusId=Object.keys(by)[0]||'';
    if(focusId)queue.push(focusId);
    for(var at=0;at<queue.length;at++){var id=queue[at];if(seen[id])continue;seen[id]=true;total++;if(ids.length<LIMIT)ids.push(id);adj[id].forEach(function(x){if(!seen[x])queue.push(x);});}
    var chosen={},dsu={};ids.forEach(function(id){chosen[id]=true;dsu[id]=id;});
    function group(id){var r=id;while(dsu[r]!==r)r=dsu[r];while(dsu[id]!==id){var n=dsu[id];dsu[id]=r;id=n;}return r;}
    var edges=valid.filter(function(r){return chosen[r.from]&&chosen[r.to];});
    edges.forEach(function(r){if(!parent(r.kind)){var a=group(r.from),b=group(r.to);if(a!==b)dsu[b]=a;}});
    var groups={},ranks={},incoming={},outgoing={},conflicts=0;
    ids.forEach(function(id){var k=group(id);(groups[k]||(groups[k]=[])).push(id);ranks[k]=0;incoming[k]=0;outgoing[k]=[];});
    var arcs={};edges.forEach(function(r){if(!parent(r.kind))return;var a=group(r.from),b=group(r.to),key=a+'\n'+b;if(a===b){conflicts++;return;}if(arcs[key])return;arcs[key]=true;outgoing[a].push(b);incoming[b]++;});
    var roots=Object.keys(groups).filter(function(k){return incoming[k]===0;}),done={};
    for(var ri=0;ri<roots.length;ri++){var k=roots[ri];done[k]=true;outgoing[k].forEach(function(child){ranks[child]=Math.max(ranks[child],ranks[k]+1);if(--incoming[child]===0)roots.push(child);});}
    Object.keys(groups).forEach(function(k){if(!done[k])conflicts++;});
    var levels={},nodes=[],focusRank=focusId?ranks[group(focusId)]:0;
    Object.keys(groups).forEach(function(k){var level=ranks[k]-focusRank;(levels[level]||(levels[level]=[])).push(k);});
    Object.keys(levels).forEach(function(level){
      var row=[];levels[level].forEach(function(k){groups[k].sort(function(a,b){return String(by[a].name||'').localeCompare(String(by[b].name||''));}).forEach(function(id){row.push(id);});});
      row.forEach(function(id,i){nodes.push({id:id,person:by[id],x:(i-(row.length-1)/2)*(W+XGAP),y:Number(level)*(H+YGAP),level:Number(level),group:group(id)});});
    });
    // Keep the chosen person on the vertical origin; partners stay adjacent.
    var centre=nodes.find(function(n){return n.id===focusId;}),shift=centre?centre.x:0;
    nodes.forEach(function(n){n.x-=shift;});
    return {nodes:nodes,edges:edges,focusId:focusId,total:total,truncated:total>LIMIT,conflicts:conflicts};
  }
  function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
  function svg(tag){return document.createElementNS('http://www.w3.org/2000/svg',tag);}
  function button(label,action,cls){var n=el('button',cls||'hft-control',label);n.type='button';n.addEventListener('click',action);return n;}
  function mount(host,options){
    var o=options||{},graph=null,positions={},elements={},edges=[],dead=false,interacted=false,initialTimer=null,drag=null,pinch=null,suppressClick=false,filter='',z=1,tx=0,ty=0;
    host.classList.add('hft-host');
    var shell=el('section','hft-shell'),toolbar=el('div','hft-toolbar'),controls=el('div','hft-controls'),search=el('input','hft-search'),zoomRead=el('output','hft-zoom'),status=el('p','hft-status'),viewport=el('div','hft-viewport'),plane=el('div','hft-plane'),lines=svg('svg'),nodes=el('div','hft-nodes'),legend=el('div','hft-legend');
    shell.setAttribute('aria-label','Interactive family tree');viewport.setAttribute('tabindex','0');viewport.setAttribute('role','region');viewport.setAttribute('aria-label','Family tree canvas. Drag to pan. Arrow keys pan, plus and minus zoom, Home centres the selected person.');
    search.type='search';search.placeholder='Find someone in this tree…';search.setAttribute('aria-label','Find someone in this family tree');zoomRead.setAttribute('aria-label','Tree zoom');
    lines.setAttribute('class','hft-lines');lines.setAttribute('aria-hidden','true');lines.setAttribute('width','1');lines.setAttribute('height','1');
    plane.appendChild(lines);plane.appendChild(nodes);viewport.appendChild(plane);
    var minus=button('−',function(){zoom(z/1.2);}),plus=button('+',function(){zoom(z*1.2);});minus.setAttribute('aria-label','Zoom out');plus.setAttribute('aria-label','Zoom in');
    controls.appendChild(minus);controls.appendChild(zoomRead);controls.appendChild(plus);controls.appendChild(button('Fit tree',fit));controls.appendChild(button('Centre person',function(){centre(graph.focusId);}));controls.appendChild(button('Reset layout',function(){positions={};rebuild(false);fit();}));
    toolbar.appendChild(search);toolbar.appendChild(controls);shell.appendChild(toolbar);shell.appendChild(viewport);
    [['parent','Parent / child'],['adoptive-parent','Adopted'],['spouse','Spouse'],['partner','Partner'],['ex-partner','Former partner']].forEach(function(pair){var item=el('span','hft-legend-item'),swatch=el('span','hft-legend-line hft-kind-'+pair[0]);swatch.setAttribute('aria-hidden','true');item.appendChild(swatch);item.appendChild(el('span','',pair[1]));legend.appendChild(item);});
    shell.appendChild(legend);status.setAttribute('role','status');shell.appendChild(status);host.appendChild(shell);
    function size(){var r=viewport.getBoundingClientRect();return {w:viewport.clientWidth||r.width||800,h:viewport.clientHeight||r.height||600,rect:r};}
    function point(e){var s=size(),r=s.rect;return {x:(e.clientX-r.left)*(r.width?s.w/r.width:1),y:(e.clientY-r.top)*(r.height?s.h/r.height:1)};}
    function bounds(){var b={left:0,top:0,right:0,bottom:0};graph.nodes.forEach(function(n,i){var p=positions[n.id]||n;if(!i){b.left=p.x-W/2;b.right=p.x+W/2;b.top=p.y-H/2;b.bottom=p.y+H/2;}else{b.left=Math.min(b.left,p.x-W/2);b.right=Math.max(b.right,p.x+W/2);b.top=Math.min(b.top,p.y-H/2);b.bottom=Math.max(b.bottom,p.y+H/2);}});return b;}
    function constrain(){var s=size(),b=bounds(),margin=70;tx=clamp(tx,margin-b.right*z,s.w-margin-b.left*z);ty=clamp(ty,margin-b.bottom*z,s.h-margin-b.top*z);}
    function transform(){constrain();plane.style.transform='translate('+tx+'px,'+ty+'px) scale('+z+')';zoomRead.textContent=Math.round(z*100)+'%';minus.disabled=z<=MIN+.001;plus.disabled=z>=MAX-.001;}
    function zoom(next,anchor){if(!graph)return;interacted=true;var s=size(),p=anchor||{x:s.w/2,y:s.h/2},old=z;z=clamp(next,MIN,MAX);tx=p.x-(p.x-tx)*z/old;ty=p.y-(p.y-ty)*z/old;transform();}
    function centre(id){interacted=true;var n=graph.nodes.find(function(n){return n.id===id;});if(!n)return;var p=positions[id]||n,s=size();tx=s.w/2-p.x*z;ty=s.h/2-p.y*z;transform();}
    function fit(initial){if(!graph)return;if(initial!==true)interacted=true;var s=size(),b=bounds();z=clamp(Math.min((s.w-64)/Math.max(1,b.right-b.left),(s.h-64)/Math.max(1,b.bottom-b.top),1),initial===true?1:MIN,MAX);tx=s.w/2-(b.left+b.right)/2*z;ty=s.h/2-(b.top+b.bottom)/2*z;transform();}
    function edgePath(edge){var a=positions[edge.from],b=positions[edge.to];if(!a||!b)return '';if(parent(edge.kind)){var start={x:a.x,y:a.y+H/2},end={x:b.x,y:b.y-H/2},mid=(start.y+end.y)/2;return 'M '+start.x+' '+start.y+' C '+start.x+' '+mid+' '+end.x+' '+mid+' '+end.x+' '+end.y;}
      var direction=b.x>=a.x?1:-1,ax=a.x+direction*W/2,bx=b.x-direction*W/2;
      // Partners who are separated by other people get a shallow overhead arc.
      if(Math.abs(a.x-b.x)>W+XGAP+2||Math.abs(a.y-b.y)>2){var top=Math.min(a.y,b.y)-H/2-34;return 'M '+a.x+' '+(a.y-H/2)+' C '+a.x+' '+top+' '+b.x+' '+top+' '+b.x+' '+(b.y-H/2);}
      return 'M '+ax+' '+a.y+' L '+bx+' '+b.y;
    }
    function paintEdges(){edges.forEach(function(e){e.node.setAttribute('d',edgePath(e.data));});}
    function place(id){var p=positions[id],n=elements[id];if(p&&n){n.style.left=(p.x-W/2)+'px';n.style.top=(p.y-H/2)+'px';}}
    function filterNodes(){var q=filter.toLowerCase(),hits=0;graph.nodes.forEach(function(n){var match=!q||String(n.person.name||'').toLowerCase().indexOf(q)!==-1;elements[n.id].classList.toggle('hft-dim',!match);elements[n.id].classList.toggle('hft-match',!!q&&match);if(match)hits++;});status.textContent=(q?(hits+' matching people. '):'')+(graph.truncated?'Showing the nearest 100 of '+graph.total+' connected people. Choose a person to explore their branch. ':graph.nodes.length+' connected '+(graph.nodes.length===1?'person. ':'people. '))+(graph.conflicts?'Some recorded links cross generations; all links are retained. ':'')+'Drag empty space to move the tree. Drag a person to arrange them.';}
    function rebuild(initial){
      graph=build(o.people,o.relations,o.focusId);elements={};edges=[];nodes.textContent='';while(lines.firstChild)lines.removeChild(lines.firstChild);
      graph.edges.forEach(function(e){var p=svg('path');p.setAttribute('class','hft-edge hft-kind-'+e.kind);p.setAttribute('fill','none');p.setAttribute('data-relation-id',e.id||'');lines.appendChild(p);edges.push({data:e,node:p});});
      graph.nodes.forEach(function(n){
        if(!positions[n.id])positions[n.id]={x:n.x,y:n.y};
        var wrap=el('div','hft-person'+(n.id===graph.focusId?' hft-current':''));wrap.setAttribute('data-person-id',n.id);
        var b=button('',function(){if(suppressClick)return;if(typeof o.onSelect==='function')o.onSelect(n.person);},'hft-person-open');b.setAttribute('aria-label','Open '+(n.person.name||'Unnamed person'));b.title=n.person.name||'Unnamed person';
        var face=el('span','hft-face'),initials=el('span','hft-initial',(n.person.name||'?').slice(0,1));face.appendChild(initials);
        var src=typeof o.getPortrait==='function'?o.getPortrait(n.person):n.person.image||(n.person.portrait&&n.person.portrait.file)||'';
        if(src&&typeof src==='string'&&!/^(?:javascript|data|file):/i.test(src)){var im=el('img','hft-photo');im.src=src;im.alt='';im.width=192;im.height=192;im.draggable=false;im.addEventListener('error',function(){im.hidden=true;});face.appendChild(im);}
        b.appendChild(face);b.appendChild(el('strong','hft-name',n.person.name||'Unnamed person'));b.appendChild(el('span','hft-person-caption',n.id===graph.focusId?'Viewing this person':n.person.actor?'NPC':'Family record'));wrap.appendChild(b);
        if(typeof o.onEdit==='function'){var edit=button('Edit',function(e){e.stopPropagation();o.onEdit(n.person);},'hft-edit');edit.setAttribute('aria-label','Edit '+(n.person.name||'person'));wrap.appendChild(edit);}
        nodes.appendChild(wrap);elements[n.id]=wrap;place(n.id);
      });paintEdges();filterNodes();if(initial)fit(true);else transform();
    }
    function begin(e,touch){
      if(e.button!==undefined&&e.button!==0)return;
      var target=e.target;if(target&&target.closest&&target.closest('.hft-edit'))return;
      var item=target&&target.closest?target.closest('.hft-person'):null,p=point(e),id=item&&item.getAttribute('data-person-id');
      interacted=true;if(!id&&viewport.focus)viewport.focus();drag={id:id||'',start:p,last:p,x:id?positions[id].x:tx,y:id?positions[id].y:ty,moved:false,touch:!!touch};suppressClick=false;viewport.classList.add('hft-dragging');if(!touch&&e.preventDefault)e.preventDefault();
    }
    function move(e){if(!drag)return;var p=point(e),dx=p.x-drag.start.x,dy=p.y-drag.start.y;if(Math.abs(dx)+Math.abs(dy)>5)drag.moved=true;
      if(drag.moved){if(drag.id){positions[drag.id]={x:clamp(drag.x+dx/z,-20000,20000),y:clamp(drag.y+dy/z,-20000,20000)};place(drag.id);paintEdges();}else{tx=drag.x+dx;ty=drag.y+dy;transform();}if(e.preventDefault)e.preventDefault();}drag.last=p;
    }
    function finish(){if(drag&&drag.moved){suppressClick=true;setTimeout(function(){suppressClick=false;},0);}drag=null;pinch=null;viewport.classList.remove('hft-dragging');}
    function touches(e){return e.touches||[];}
    function touchStart(e){var t=touches(e);if(t.length===1){begin({target:e.target,clientX:t[0].clientX,clientY:t[0].clientY},true);}else if(t.length===2){drag=null;var a=point(t[0]),b=point(t[1]);pinch={distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),zoom:z};if(e.preventDefault)e.preventDefault();}}
    function touchMove(e){var t=touches(e);if(pinch&&t.length===2){var a=point(t[0]),b=point(t[1]);zoom(pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});e.preventDefault();}else if(t.length===1)move({clientX:t[0].clientX,clientY:t[0].clientY,preventDefault:function(){e.preventDefault();}});}
    function wheel(e){zoom(z*Math.exp(-clamp(e.deltaY||0,-200,200)*.002),point(e));e.preventDefault();e.stopPropagation();}
    function key(e){if(e.target===search)return;var used=true;if(e.key==='+'||e.key==='=')zoom(z*1.2);else if(e.key==='-')zoom(z/1.2);else if(e.key==='Home')centre(graph.focusId);else if(e.key==='ArrowLeft'){tx+=64;transform();}else if(e.key==='ArrowRight'){tx-=64;transform();}else if(e.key==='ArrowUp'){ty+=64;transform();}else if(e.key==='ArrowDown'){ty-=64;transform();}else used=false;if(used){e.preventDefault();e.stopPropagation();}}
    function resized(){if(!dead)transform();}
    search.addEventListener('input',function(){filter=search.value;filterNodes();});search.addEventListener('keydown',function(e){if(e.key==='Enter'){var found=graph.nodes.find(function(n){return String(n.person.name||'').toLowerCase().indexOf(filter.toLowerCase())!==-1;});if(found){centre(found.id);elements[found.id].querySelector('button').focus();}e.preventDefault();}});
    viewport.addEventListener('mousedown',begin);document.addEventListener('mousemove',move);document.addEventListener('mouseup',finish);viewport.addEventListener('wheel',wheel,{passive:false});viewport.addEventListener('keydown',key);viewport.addEventListener('touchstart',touchStart,{passive:false});viewport.addEventListener('touchmove',touchMove,{passive:false});viewport.addEventListener('touchend',finish);viewport.addEventListener('touchcancel',finish);
    if(g.addEventListener){g.addEventListener('blur',finish);g.addEventListener('resize',resized);}
    rebuild(true);
    // The host can be mounted just before its tab is revealed. Measure once
    // after that visibility change; never reset a view the user has moved.
    initialTimer=setTimeout(function(){if(!dead&&!interacted)fit(true);},0);
    return {update:function(next){o=Object.assign({},o,next||{});rebuild(false);},fit:fit,focus:function(id){if(!graph.nodes.some(function(n){return n.id===id;})){o.focusId=id;positions={};rebuild(false);}centre(id);},destroy:function(){dead=true;clearTimeout(initialTimer);finish();document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',finish);if(g.removeEventListener){g.removeEventListener('blur',finish);g.removeEventListener('resize',resized);}shell.remove();host.classList.remove('hft-host');},inspect:function(){return {zoom:z,x:tx,y:ty,graph:graph,positions:JSON.parse(JSON.stringify(positions))};}};
  }
  g.HDFamilyTree={mount:mount,layout:build};
})(window);
