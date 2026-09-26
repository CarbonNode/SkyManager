/* quest-journal-home: current objectives first; native quest tools own every action. */
(function () {
  'use strict';
  var root, host, data=[], query='', filter='all', loading=false, busy=false, arm='', message='', serial=0, request='', actionRequest='', readTimer=0;
  function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
  function button(text,fn,cls){var n=el('button',cls,text);n.type='button';n.addEventListener('click',fn);return n;}
  function parse(raw){try{return typeof raw==='string'?JSON.parse(raw):raw;}catch(_){return null;}}
  function current(){return data.filter(function(q){return q.journal!==false && q.status==='running';});}
  function matching(){return current().filter(function(q){return (filter!=='targets'||q.hasTarget) && (filter!=='main'||q.type==='Main') && (filter!=='misc'||q.type==='Misc') && [q.name,q.editorId,q.plugin,q.formId,q.type,q.objective].concat(q.currentObjectives||[]).join(' ').toLowerCase().indexOf(query.trim().toLowerCase())>=0;});}
  function sendAction(q,verb){
    if(busy)return;
    busy=true;arm='';message='';actionRequest='journal-action-'+(++serial);
    var p={formId:q.formId,requestId:actionRequest};
    if(verb==='advance'){p.stage=q.nextStage;p.expectedStage=q.currentStage;host.send('hdQuestSetStage',JSON.stringify(p));}
    else{p.verb='movetoqt';host.send('hdQuestAction',JSON.stringify(p));}
    renderRows();
  }
  function renderRows(){
    if(!root)return;
    var list=root.querySelector('.qj-list');list.innerHTML='';
    var rows=matching();root.querySelector('.qj-count').textContent=current().length+' current quests';
    root.querySelector('.qj-summary').textContent=loading?'Reading your journal…':rows.length+' shown · '+current().filter(function(q){return q.hasTarget;}).length+' with a travel target';
    root.querySelector('.qj-notice').textContent=message;
    root.querySelector('.qj-refresh').disabled=loading||busy;
    if(loading){list.appendChild(el('p','qj-empty','Reading current objectives from Skyrim…'));return;}
    if(!rows.length){list.appendChild(el('h2','qj-empty',current().length?'No matching quests':'No current objectives'));list.appendChild(el('p','qj-empty',current().length?'Try another name, objective or quest type.':'Your journal has no displayed unfinished objectives. Use Search all quests to inspect other quests.'));return;}
    rows.forEach(function(q){
      var row=el('article','qj-row');row.setAttribute('data-quest',q.formId);
      var body=el('div','qj-content');body.appendChild(el('div','qj-type',q.type||'Quest'));
      var name=button(q.name,function(){if(!busy)host.detail(q.formId);},'qj-title');name.disabled=busy;body.appendChild(name);
      var objectives=q.currentObjectives&&q.currentObjectives.length?q.currentObjectives:[q.objective||'No objective text supplied'];
      objectives.forEach(function(o){body.appendChild(el('p','qj-objective',o));});
      body.appendChild(el('div','qj-meta',(q.targetName?'Target: '+q.targetName+' · ':'')+(q.plugin||'')+' · Stage '+q.currentStage));
      var actions=el('div','qj-actions');
      var travel=button('Go to target',function(){sendAction(q,'travel');},'qj-travel');travel.disabled=busy||!q.hasTarget;
      travel.title=q.hasTarget?'Close SkyManager and teleport to the quest’s current target.':q.targetReason||'No live quest target.';actions.appendChild(travel);
      var advance=button('Advance…',function(){if(busy)return;arm=arm===q.formId?'':q.formId;renderRows();},'qj-advance');advance.disabled=busy||!q.nextStage;advance.title=q.nextStage?'Review stage '+q.currentStage+' → '+q.nextStage:'No later defined stage.';actions.appendChild(advance);
      var details=button('Details',function(){host.detail(q.formId);},'qj-details');details.disabled=busy;actions.appendChild(details);
      if(!q.hasTarget)actions.appendChild(el('small','qj-target-reason',q.targetReason||'No live quest target.'));
      row.appendChild(body);row.appendChild(actions);
      if(arm===q.formId){
        var review=el('div','qj-review');review.appendChild(el('strong','',q.name+' · Stage '+q.currentStage+' → '+q.nextStage));
        review.appendChild(el('p','','This runs the next defined stage and may skip objectives or story events. It is not a guaranteed quest repair.'));
        review.appendChild(button('Run stage '+q.nextStage,function(){sendAction(q,'advance');},'qj-confirm'));
        review.appendChild(button('Cancel',function(){arm='';renderRows();},''));row.appendChild(review);
      }
      list.appendChild(row);
    });
  }
  function mount(node,adapter){
    if(root===node)return;root=node;host=adapter;root.classList.add('qj-journal');
    root.addEventListener('keydown',function(e){if(e.key==='Tab')e.stopPropagation();if(e.key==='Escape'&&arm){e.stopPropagation();arm='';renderRows();}});
    var head=el('div','qj-head');var title=el('div','');title.appendChild(el('h1','','Your journal'));title.appendChild(el('p','qj-count','Reading quests…'));head.appendChild(title);head.appendChild(button('Refresh',refresh,'qj-refresh'));root.appendChild(head);
    var search=el('input','qj-search');search.type='search';search.placeholder='Search quests, objectives, names or plugins…';search.setAttribute('aria-label','Search current quests');search.value=query;
    search.addEventListener('input',function(){query=search.value;arm='';renderRows();});
    search.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Enter'){var q=matching()[0];if(q)host.detail(q.formId);}});root.appendChild(search);
    var filters=el('div','qj-filters');filters.setAttribute('aria-label','Filter current quests');
    [['all','All quests'],['targets','Travel available'],['main','Main story'],['misc','Miscellaneous']].forEach(function(f){var b=button(f[1],function(){filter=f[0];arm='';filters.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderRows();},'');b.setAttribute('aria-pressed',String(filter===f[0]));filters.appendChild(b);});root.appendChild(filters);
    root.appendChild(el('div','qj-summary',''));var notice=el('div','qj-notice','');notice.setAttribute('role','status');root.appendChild(notice);
    var list=el('div','qj-list');list.setAttribute('aria-label','Current quests');root.appendChild(list);renderRows();
  }
  function refresh(){if(!host)return;loading=true;busy=false;actionRequest='';arm='';message='';clearTimeout(readTimer);request='journal-list-'+(++serial);renderRows();var pending=request;readTimer=setTimeout(function(){if(loading&&request===pending){loading=false;request='';message='Skyrim did not answer. Refresh to try again.';renderRows();}},8000);host.send('hdQuestActive',JSON.stringify({requestId:request}));}
  window.hdQuestJournalData=function(raw){var p=parse(raw);if(!p||p.requestId!==request)return;clearTimeout(readTimer);loading=false;data=Array.isArray(p.quests)?p.quests:[];message=p.message||'';renderRows();};
  window.hdQuestJournalResult=function(raw){var p=parse(raw);if(!p||p.requestId!==actionRequest)return;busy=false;message=p.message||(p.ok?'Requested. Returning to Skyrim…':'Quest action failed.');renderRows();};
  window.HDQuestJournal={mount:mount,refresh:refresh,matching:matching};
})();
