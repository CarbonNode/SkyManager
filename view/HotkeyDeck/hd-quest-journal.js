/* quest-journal-home: current objectives first; native quest tools own every action.
   Each row says what KIND of step it is (Talk / Travel / Menu …) and, when there is no
   map marker, why — in words, not the engine's reason code. "What now?" opens a
   body-anchored guide popout: the step, a known hint for it, the quest's whole step list
   (fetched with hdQuestGet only when the guide opens) and, last, a guarded debug skip. */
(function () {
  'use strict';
  var root, host, data=[], query='', filter='all', loading=false, busy=false, message='', serial=0, request='', actionRequest='', readTimer=0;
  var guide=null; // {q, steps, pending, armed, timer, back, prevFocus}

  /* Hand-checked hints for steps the journal does not explain. Key: quest EditorID +
     the start of the objective text (stage numbers move between mod versions, the
     words rarely do). Only lines read out of the mod itself or proven in a play log. */
  var HINTS=[
    {quest:'ST_Tut02',objective:'find the house its first guest',
     how:'Talk to an ordinary Whiterun townsperson (not a follower, not one of your workers) and choose this line:',
     say:'Modest coin gets you private company on your terms. This stays between us.',
     note:'A "no" only means that person said no, so try someone else. Not every NPC offers the line.',
     source:'Sanguine’s Trade dialogue (ST_Prospect_PlayerPitch)'},
    {quest:'ST_Tut02',objective:'schedule the appointment',
     how:'Open the Ledger (F6) and schedule the guest who just accepted your offer.',
     source:'Sanguine’s Trade objectives'},
    {quest:'ST_Tut01',objective:'leave the inn and let her work',
     how:'Step outside and let a few in-game hours pass before you go back in. Waiting inside the inn does not count.',
     source:'Papyrus log, 2026-10-14'},
    {quest:'ST_Tut01',objective:'collect your earnings',
     how:'Earnings are counted when you come back in. After a few in-game hours outside, enter the inn and ask the innkeeper:',
     say:'I am here for my share. No trouble, I hope.',
     note:'"Nothing has come in yet" means not enough time has passed outside.',
     source:'Sanguine’s Trade dialogue + Papyrus log, 2026-10-14'},
    {quest:'ST_Tut01',objective:'assign brenna',
     how:'Open the Ledger (F6) and assign Brenna to the Sleeping Giant there.',
     source:'Sanguine’s Trade objectives'}
  ];
  var ACTIONS=[
    ['Menu',/\b(ledger|mcm|from your menu)\b|^(register|schedule|set a rest venue)\b/i],
    ['Talk',/^(\(optional\)\s*)?(speak|talk|ask|tell|convince|persuade|report|meet|greet|negotiate|recruit|hire|confront|question|bribe|intimidate|satisfy)\b|make the offer|speak (with|to)|talk (with|to)/i],
    ['Wait',/^(wait|rest|sleep)\b|let (her|him|them|it) work|pass (some )?time/i],
    ['Fight',/^(kill|defeat|slay|destroy|clear|fight|survive|defend|banish)\b/i],
    ['Craft',/^(craft|forge|brew|cook|build|enchant|smith|temper)\b/i],
    ['Item',/^(collect|retrieve|obtain|bring|take|buy|purchase|steal|deliver|give|acquire|get|loot|gather|recover|read)\b/i],
    ['Travel',/^(go|travel|enter|leave|reach|return|head|visit|investigate|explore|escape|follow|search|find|locate|climb|exit|meet)\b/i]
  ];
  var NO_MARKER={
    Talk:'No map marker: this step is done by talking to someone, not by travelling.',
    Menu:'No map marker: this step is done in a menu, not in the world.',
    Wait:'No map marker: this step needs in-game time to pass.',
    Item:'No map marker: the item or person is not pinned, so look where the objective says.',
    Craft:'No map marker: this step is done at a crafting station.'
  };

  function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;}
  function button(text,fn,cls){var n=el('button',cls,text);n.type='button';n.addEventListener('click',fn);return n;}
  function parse(raw){try{return typeof raw==='string'?JSON.parse(raw):raw;}catch(_){return null;}}
  function norm(s){return String(s||'').toLowerCase().replace(/[‐-―-]/g,' ').replace(/\s+/g,' ').trim();}
  function objectivesOf(q){return q.currentObjectives&&q.currentObjectives.length?q.currentObjectives:[q.objective||'No objective text supplied'];}
  function actionOf(text){var t=String(text||'').trim();for(var i=0;i<ACTIONS.length;i++)if(ACTIONS[i][1].test(t))return ACTIONS[i][0];return '';}
  function hintFor(q){
    var ed=norm(q.editorId),objs=objectivesOf(q).map(norm);
    for(var i=0;i<HINTS.length;i++){var h=HINTS[i];if(norm(h.quest)!==ed)continue;
      for(var j=0;j<objs.length;j++)if(objs[j].indexOf(h.objective)===0)return h;}
    return null;
  }
  function reasonFor(q,act){
    if(q.hasTarget)return '';
    var r=String(q.targetReason||'');
    if(/no displayed objective/i.test(r))return 'The journal shows no current step for this quest.';
    if(/not available/i.test(r))return 'The marker points at someone or something that is not loaded or not set yet. Details shows what is missing.';
    if(/editor id/i.test(r))return 'Travel is not possible: this quest has no editor ID.';
    return NO_MARKER[act]||'No map marker for this step. Read the objective; What now? lists the steps around it.';
  }
  function current(){return data.filter(function(q){return q.journal!==false && q.status==='running';});}
  function matching(){
    var needle=query.trim().toLowerCase();
    return current().filter(function(q){
      var h=hintFor(q);
      return (filter!=='targets'||q.hasTarget) && (filter!=='main'||q.type==='Main') && (filter!=='misc'||q.type==='Misc') &&
        [q.name,q.editorId,q.plugin,q.formId,q.type,q.objective,h?h.how+' '+(h.say||''):''].concat(q.currentObjectives||[]).join(' ').toLowerCase().indexOf(needle)>=0;
    });
  }
  function sendAction(q,verb){
    if(busy)return;
    busy=true;message='';actionRequest='journal-action-'+(++serial);
    var p={formId:q.formId,requestId:actionRequest};
    if(verb==='advance'){p.stage=q.nextStage;p.expectedStage=q.currentStage;host.send('hdQuestSetStage',JSON.stringify(p));}
    else{p.verb='movetoqt';host.send('hdQuestAction',JSON.stringify(p));}
    closeGuide();renderRows();
  }

  /* One "how" block, shared by the row (short) and the guide (full). */
  function howBlock(h,full){
    var box=el('div','qj-how');box.appendChild(el('span','qj-how-h','How'));
    var body=el('div','qj-how-b');body.appendChild(el('p','qj-how-t',h.how));
    if(h.say)body.appendChild(el('p','qj-say','“'+h.say+'”'));
    if(full&&h.note)body.appendChild(el('p','qj-how-note',h.note));
    if(full&&h.source)body.appendChild(el('p','qj-how-src','Source: '+h.source));
    box.appendChild(body);return box;
  }
  function stepLine(q,act){
    var line=el('div','qj-step');
    if(act)line.appendChild(el('span','qj-chip',act));
    var why=reasonFor(q,act);if(why)line.appendChild(el('span','qj-why',why));
    return line.childNodes.length?line:null;
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
      var objs=objectivesOf(q);
      objs.forEach(function(o){body.appendChild(el('p','qj-objective',o));});
      var line=stepLine(q,actionOf(objs[0]));if(line)body.appendChild(line);
      var h=hintFor(q);if(h)body.appendChild(howBlock(h,false));
      body.appendChild(el('div','qj-meta',(q.plugin||'')+' · Stage '+q.currentStage+(q.unfilledAliases>0?' · '+q.unfilledAliases+' quest '+(q.unfilledAliases===1?'person or thing':'people or things')+' missing':'')));
      var actions=el('div','qj-actions');
      if(q.hasTarget){var travel=button('Go to target',function(){sendAction(q,'travel');},'qj-travel');travel.disabled=busy;travel.title='Close SkyManager and teleport to the quest’s current target.';actions.appendChild(travel);}
      var now=button('What now?',function(){if(!busy)openGuide(q);},q.hasTarget?'qj-now':'qj-now qj-primary');now.disabled=busy;now.title='The step, any known hint, and the quest’s whole step list';actions.appendChild(now);
      var details=button('Details',function(){host.detail(q.formId);},'qj-details');details.disabled=busy;actions.appendChild(details);
      row.appendChild(body);row.appendChild(actions);
      list.appendChild(row);
    });
  }

  /* ---------- the guide popout (body-anchored, owns the keyboard while up) ---------- */
  function stepsOf(d){
    var objs=(d&&d.objectives||[]).filter(function(o){return o&&o.text;}).slice().sort(function(a,b){return a.index-b.index;});
    var reached=-1;objs.forEach(function(o){if(o.state>0&&o.index>reached)reached=o.index;});
    var out=[],unused=0;
    objs.forEach(function(o){
      var s=o.state===1?'now':(o.state===2||o.state===3)?'done':(o.state===4||o.state===5)?'failed':'';
      if(!s){if(o.index>reached)s='later';else{unused++;return;}}
      out.push({text:o.text,state:s});
    });
    return {rows:out,unused:unused};
  }
  var STEP_LABEL={done:'Done',now:'Now',later:'Later',failed:'Failed'};
  function renderGuide(){
    if(!guide)return;
    var q=guide.q,card=guide.back.querySelector('.qj-guide');card.innerHTML='';
    var head=el('header','qj-g-head');var titles=el('div','qj-g-titles');
    titles.appendChild(el('div','qj-type',(q.type||'Quest')+' · '+(q.plugin||'')+' · Stage '+q.currentStage));
    var h2=el('h2','qj-g-title',q.name);h2.id='qj-g-title';titles.appendChild(h2);head.appendChild(titles);
    head.appendChild(button('Close',closeGuide,'qj-g-close'));card.appendChild(head);

    var body=el('div','qj-g-body');
    var now=el('section','qj-g-sec');now.appendChild(el('h3','qj-g-h','What to do now'));
    var objs=objectivesOf(q);objs.forEach(function(o){now.appendChild(el('p','qj-objective',o));});
    var line=stepLine(q,actionOf(objs[0]));if(line)now.appendChild(line);
    var h=hintFor(q);
    if(h)now.appendChild(howBlock(h,true));
    else now.appendChild(el('p','qj-g-dim','No hint is on file for this step yet. The step list below shows what comes before and after it.'));
    body.appendChild(now);

    var steps=el('section','qj-g-sec');steps.appendChild(el('h3','qj-g-h','The quest’s steps'));
    if(guide.pending)steps.appendChild(el('p','qj-g-dim','Reading the steps from Skyrim…'));
    else if(guide.failed)steps.appendChild(el('p','qj-g-dim',guide.failed));
    else{
      var st=stepsOf(guide.steps);
      if(!st.rows.length)steps.appendChild(el('p','qj-g-dim','This quest lists no steps with text.'));
      else{var ol=el('ol','qj-g-steps');st.rows.forEach(function(r){var li=el('li','qj-g-step is-'+r.state);li.appendChild(el('span','qj-g-state',STEP_LABEL[r.state]));li.appendChild(el('span','qj-g-text',r.text));ol.appendChild(li);});steps.appendChild(ol);
        steps.appendChild(el('p','qj-g-dim','Later steps come from the quest’s own list in order. Mods can branch, so treat them as a guide.'+(st.unused?' '+st.unused+' optional or unused '+(st.unused===1?'step is':'steps are')+' not shown.':'')));}
    }
    body.appendChild(steps);

    if(guide.armed){
      var warn=el('section','qj-g-sec qj-g-warn');warn.appendChild(el('h3','qj-g-h','Skip to stage '+q.nextStage+'?'));
      warn.appendChild(el('p','','This forces the quest from stage '+q.currentStage+' to '+q.nextStage+'. It skips whatever the mod does in between and can break the quest. Use it only to repair a stuck quest, after a save.'));
      var row=el('div','qj-g-actions');
      row.appendChild(button('Run stage '+q.nextStage,function(){sendAction(q,'advance');},'qj-confirm'));
      row.appendChild(button('Cancel',function(){guide.armed=false;renderGuide();},''));
      warn.appendChild(row);body.appendChild(warn);
    }
    card.appendChild(body);

    var foot=el('footer','qj-g-foot');
    if(q.hasTarget)foot.appendChild(button('Go to target',function(){sendAction(q,'travel');},'qj-travel'));
    foot.appendChild(button('Open details',function(){var id=q.formId;closeGuide();host.detail(id);},'qj-details'));
    var skip=button('Skip step (debug)…',function(){guide.armed=!guide.armed;renderGuide();},'qj-skip');
    skip.disabled=busy||!q.nextStage;skip.title=q.nextStage?'Repair tool: force stage '+q.nextStage+'. Asks first.':'No later defined stage.';
    foot.appendChild(skip);card.appendChild(foot);
    if(guide.armed){var c=card.querySelector('.qj-confirm');if(c)c.focus();}
  }
  function onGuideKey(e){
    if(!guide)return;
    e.stopPropagation(); // no hotkey, tab switch or palette close underneath the guide
    var esc=e.key==='Escape'||e.keyCode===27;
    if(esc){e.preventDefault();if(guide.armed){guide.armed=false;renderGuide();}else closeGuide();}
  }
  function openGuide(q){
    closeGuide();
    var back=el('div','qj-guide-back');back.setAttribute('role','dialog');back.setAttribute('aria-modal','true');back.setAttribute('aria-labelledby','qj-g-title');
    back.addEventListener('mousedown',function(e){if(e.target===back)closeGuide();});
    back.appendChild(el('div','qj-guide'));
    guide={q:q,steps:null,pending:true,failed:'',armed:false,back:back,prevFocus:document.activeElement};
    document.body.appendChild(back);
    window.addEventListener('keydown',onGuideKey,true);
    guide.timer=setTimeout(function(){if(guide&&guide.pending){guide.pending=false;guide.failed='Skyrim did not answer. Close and open What now? to try again.';renderGuide();}},6000);
    renderGuide();
    var close=back.querySelector('.qj-g-close');if(close)close.focus();
    host.send('hdQuestGet',q.formId);
  }
  function closeGuide(){
    if(!guide)return;
    var g=guide;guide=null;clearTimeout(g.timer);
    window.removeEventListener('keydown',onGuideKey,true);
    if(g.back.parentNode)g.back.parentNode.removeChild(g.back);
    if(g.prevFocus&&g.prevFocus.focus&&root&&root.contains(g.prevFocus))g.prevFocus.focus();
  }
  /* app.js's hdQuestInfo hands every detail payload here first; the guide takes only
     the one it asked for, so the Details view never opens behind the popout. */
  function takeDetail(raw){
    if(!guide||!guide.pending)return false;
    var p=parse(raw);if(!p||p.formId!==guide.q.formId)return false;
    clearTimeout(guide.timer);guide.pending=false;
    if(p.ok===false)guide.failed=p.message||'Skyrim could not read this quest.';else guide.steps=p;
    renderGuide();return true;
  }

  function mount(node,adapter){
    if(root===node)return;root=node;host=adapter;root.classList.add('qj-journal');
    root.addEventListener('keydown',function(e){if(e.key==='Tab')e.stopPropagation();});
    var head=el('div','qj-head');var title=el('div','');title.appendChild(el('h1','','Your journal'));title.appendChild(el('p','qj-count','Reading quests…'));head.appendChild(title);head.appendChild(button('Refresh',refresh,'qj-refresh'));root.appendChild(head);
    var search=el('input','qj-search');search.type='search';search.placeholder='Search quests, objectives, hints or plugins…';search.setAttribute('aria-label','Search current quests');search.value=query;
    search.addEventListener('input',function(){query=search.value;renderRows();});
    search.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Enter'){var q=matching()[0];if(q)openGuide(q);}});root.appendChild(search);
    var filters=el('div','qj-filters');filters.setAttribute('aria-label','Filter current quests');
    [['all','All quests'],['targets','Travel available'],['main','Main story'],['misc','Miscellaneous']].forEach(function(f){var b=button(f[1],function(){filter=f[0];filters.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});renderRows();},'');b.setAttribute('aria-pressed',String(filter===f[0]));filters.appendChild(b);});root.appendChild(filters);
    root.appendChild(el('div','qj-summary',''));var notice=el('div','qj-notice','');notice.setAttribute('role','status');root.appendChild(notice);
    var list=el('div','qj-list');list.setAttribute('aria-label','Current quests');root.appendChild(list);renderRows();
  }
  function refresh(){if(!host)return;closeGuide();loading=true;busy=false;actionRequest='';message='';clearTimeout(readTimer);request='journal-list-'+(++serial);renderRows();var pending=request;readTimer=setTimeout(function(){if(loading&&request===pending){loading=false;request='';message='Skyrim did not answer. Refresh to try again.';renderRows();}},8000);host.send('hdQuestActive',JSON.stringify({requestId:request}));}
  window.hdQuestJournalData=function(raw){var p=parse(raw);if(!p||p.requestId!==request)return;clearTimeout(readTimer);loading=false;data=Array.isArray(p.quests)?p.quests:[];message=p.message||'';renderRows();};
  window.hdQuestJournalResult=function(raw){var p=parse(raw);if(!p||p.requestId!==actionRequest)return;busy=false;message=p.message||(p.ok?'Requested. Returning to Skyrim…':'Quest action failed.');renderRows();};
  window.HDQuestJournal={mount:mount,refresh:refresh,matching:matching,close:closeGuide,takeDetail:takeDetail,isOpen:function(){return !!guide;},hintFor:hintFor,actionOf:actionOf};
})();
