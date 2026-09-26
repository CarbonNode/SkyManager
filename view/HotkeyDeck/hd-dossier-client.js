/* Shared game-owned dossier records. Each request has its own reply, including
   failures; a late reply cannot resolve another NPC's operation. */
(function(){
  'use strict';
  var serial=0,pending={},snapshot={version:1,people:[],relations:[],history:[]},bindings={};
  function actorKey(actor){return String(actor.plugin||'').toLowerCase()+'|'+String(actor.formId||'').toLowerCase();}
  function request(req){
    return new Promise(function(resolve,reject){
      var id='ds-'+Date.now().toString(36)+'-'+(++serial), body=Object.assign({},req,{requestId:id});
      var timer=setTimeout(function(){delete pending[id];reject(new Error('The game did not answer. Reopen the page and try again.'));},15000);
      pending[id]={resolve:resolve,reject:reject,timer:timer,actor:req.actor};
      try {window.toGame('dsRequest',JSON.stringify(body));}catch(e){clearTimeout(timer);delete pending[id];reject(e);}
    });
  }
  window.dsResult=function(raw){
    var r;try{r=typeof raw==='string'?JSON.parse(raw):raw;}catch(_){return;}
    var p=r&&pending[r.requestId];if(!p)return;
    clearTimeout(p.timer);delete pending[r.requestId];
    if(r.ok&&r.data){snapshot=r.data;if(p.actor&&r.personId)bindings[actorKey(p.actor)]=r.personId;}
    p.resolve(r);
  };
  function session(actor){
    var id=bindings[actorKey(actor)]||'',ensurePromise=null;
    function person(){return (snapshot.people||[]).find(function(p){return p.id===id;})||null;}
    function consume(r){if(r.ok&&r.personId){id=r.personId;bindings[actorKey(actor)]=id;}return r;}
    function ensure(){
      if(id)return Promise.resolve({ok:true,personId:id,data:snapshot});
      if(!ensurePromise)ensurePromise=request({op:'ensure',actor:actor,name:actor.name}).then(consume).then(function(r){ensurePromise=null;return r;},function(e){ensurePromise=null;throw e;});
      return ensurePromise;
    }
    return {actor:actor,person:person,personId:function(){return id;},
      read:function(){return request({op:'read',actor:actor}).then(consume);},
      request:function(req){
        if(req.personId || ['list','read','ensure','gallery','addRelation','removeRelation','bindActor','resolveActor'].indexOf(req.op)!==-1){
          var ownActor=req.actor && actorKey(req.actor)===actorKey(actor) && (req.op==='read'||req.op==='ensure');
          return ownActor ? request(req).then(consume) : request(req);
        }
        return ensure().then(function(r){if(!r.ok)return r;return request(Object.assign({},req,{personId:id}));});
      },ensure:ensure};
  }
  window.HDDossierClient={request:request,session:session,snapshot:function(){return snapshot;}};
})();
