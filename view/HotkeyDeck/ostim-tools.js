/* ===================================================================== *
 *  The unified OStim scene workspace. OStim owns mechanics; AnimPane owns
 *  persistence.
 *
 *  TWO HOSTS, ONE BUILD (2026-09-21). Rober: "if im in an ostim scene it
 *  should open a dedicated ostim scene page on f7 of skymanager" and "we
 *  should have a lot of ostim options". This file already WAS the unified
 *  menu; what it lacked was a front door. So it grew a second mount rather
 *  than a second copy:
 *
 *    mount(host, seg)  the Scene TAB (scene-pane.js) — where F7 lands when
 *                      a scene is running. No backdrop, no Close button,
 *                      no key trapping: the deck owns all three.
 *    open(seg, formId) the free-floating modal — still how an NPC card and
 *                      the omni providers reach it with the palette on
 *                      another tab.
 *
 *  Both build the SAME card through the same render(), because two copies
 *  of a control is the failure mode this deck has paid for before. `modal`
 *  is the mounted ROOT in either case, so every modal.querySelector scope
 *  below is unchanged.
 * ===================================================================== */
window.OstimTools=(function(){
 'use strict';
 let modal=null,body=null,note=null,tab='',snapshot={},rows=[],options=[],token='',optionToken='',selected=0,coarse=false;
 const RENDER_CAP=200;                   // rows painted at once — keep typing to narrow
 let hosted=false;                       // mounted in the Scene tab, not floating
 let pageBody=null;                      // the in-page .ost-body; `body` points at
                                         // the POPOUT while a segment is open
 let here=null,herePending=false;        // the piece the scene is actually ON
 let castRows=[],castCast=[],castToken='',castBusy=false,castRadius=60;
 let allFloors=false;                    // search other storeys too, not just this one
 let wornInfo={},wornPending=false,wornQuery=0;
 let voiceRows=[],voiceToken='',voiceActors=[],voicePending=false;
 let sosInfo={},sosPending=false;
 let ppa={},ppaPending=false;
 let held=[],heldPending=false;
 let privacy={},privacyBusy=false,privacySearch="",privacySerial=0;
 let charSheetAsked=false;
 let holdState=null,holdPending=false;    // the SexLab-style relocate
 /* ⚠ NOT getHeld/held/heldPending — those are The room's roster. */
 let mcmPages=[],mcmPending=false,mcmWhy='',mcmQuery='';
 let rl={},rlPending=false,rlQuery='';
 let sizeInfo={},sizeDraft=null,sizeDrag=null,sizePending=false,sizeQuery=0;
 let lighting={},lightPending=false,lightQuery=0;
 let photoDegrees=75,cameraCurrent=null,photoDrag=null,photoRepaint=false,photoDragReleased=false;
 let pendingFavorite=false,expressionRows=[],expressionsReady=false,expressionOnlyFav=false,actorInfo={},actorPending=false,actorQuery=0,lastExpression={},photos=[],photoFov='keep',photoFreeze=false,photoView='';
 let serial=0,session=0,timer=0,search='',radius=60,collection='',pending=new Map(),previousFocus=null,faceKey='',busy=false;
 const el=(t,c,s)=>{const n=document.createElement(t);n.className=c||'';if(s!==undefined)n.textContent=s;return n;};
 const btn=(label,fn,cls)=>{const b=el('button',cls||'ost-button');b.type='button';const icons={'Slower':'hm-time','Faster':'hm-time','Stop scene':'sn-stop','End scene':'sn-stop','Free camera':'sn-camera','Adjust live, over the scene…':'sn-align','Hold this scene':'sn-hold','Resume here':'sn-hold','Start photo mode':'sn-camera','Back to previous scene':'hm-anim','Browse scenes':'hm-anim','Position reference':'hm-anim','Rescan scene icons':'sn-search','Move scene…':'hk-bed','Rescan furniture':'hk-bed','Expressions':'hm-faces','Camera & photos':'hk-portrait','Lighting':'hk-quick-light','Open ReLight editor':'hk-quick-light','Participants':'hm-followers','Start photo mode':'hk-portrait','Return to OStim':'seg-ostim','Restore scene clothing':'hm-wardrobe','Move to floor':'hm-domains','Refresh / root settings':'sv-camp-options'};if(icons[label]){const i=el('img','ost-icon');i.src='icons/custom/'+icons[label]+'.png';i.alt='';b.append(i);}b.append(el('span','',label));b.addEventListener('click',fn);return b;};
 function request(act,extra,cb,detached){
  if(typeof window.osTools!=='function'){message('Scene bridge unavailable.');return;}
  const id=session+':'+(++serial), stamp=session;
  const t=setTimeout(()=>{pending.delete(id);
  if(act==='sceneIconChoices'||act==='sceneIconSet'){positionChoicesPending=false;positionChoiceSaving=false;positionChoicesError='Icon choices did not respond. Retry to check what was saved.';positionChoicesReady=false;paintPositionChoiceState();}
  if(modal&&session===stamp){if(act==='scan'){busy=false;if(tab==='move')render();}if(act==='size'||act==='sizeRestore'){sizePending=false;sizeQuery++;paintSize();}if(act==='lighting'){lightPending=false;lightQuery++;if(tab==='lighting')paintLighting();}if(['actorState','expression','expressionClear','mute','redress'].includes(act)){actorPending=false;if(tab==='expr'||tab==='people')render();}
  // Every pending flag the Scene page added. A flag left true after a
  // timeout disables its whole panel for good — the controls simply stop
  // responding, with nothing on screen to say why.
  if(act==='sceneIcons'){sceneIconsPending=false;}
  if(act==='here'){herePending=false;if(tab==='move')render();}
  if(act==='held'){holdPending=false;if(tab==='move')render();}
  if(act==='roster'||act==='join'||act==='part'){castBusy=false;if(tab==='cast')render();}
  if(act==='undressState'||act==='undress'){wornPending=false;wornQuery++;if(tab==='people')render();}
  if(act==='voiceState'||act==='voices'||act==='setVoice'){voicePending=false;if(tab==='people')render();}
  if(act==='sosState'||act==='sos'){sosPending=false;if(tab==='people')render();}
  if(act==='ppa'){ppaPending=false;if(tab==='ppa')render();}
  if(act==='mcm'){mcmPending=false;mcmWhy='OStim’s MCM did not answer in time.';if(tab==='options')render();}
  if(act==='room'){heldPending=false;if(tab==='room')render();}
  if(act==='privacy'){privacyBusy=false;privacySerial++;if(tab==='room')render();}
  const setup=modal.querySelector('.ost-start');if(setup&&setup._setupTimeout)setup._setupTimeout(act);
  message(act==='setupStart'?'Start not confirmed. Close this setup and check the game before trying again.':'OStim did not respond. Refresh to try again.');}},12000);
  pending.set(id,{cb:cb,timer:t,detached:!!detached});
  osTools(JSON.stringify(Object.assign({act:act,request:id,signature:snapshot.signature||''},extra||{})));
 }
 let noteTimer=0;
 function message(s){
  if(note)note.textContent=s||'';
  clearTimeout(noteTimer);
  if(s&&note)noteTimer=setTimeout(()=>{if(note&&note.textContent===s)note.textContent='';},9000);
  /* A popout covers the page's own banner, so anything said while one is
     open was invisible. The popout carries a mirror. */
  const pn=pop&&pop.querySelector('.ost-pop-note');if(pn)pn.textContent=s||'';
 }

 /* ---- WHERE things are ------------------------------------------------
    A segment's controls used to render into the page below the nav; since
    2026-09-21 they render into a POPOUT instead (Rober: "every button
    should be a popout modal, not below"). The hero and the nav stay in the
    page. So a paint function can no longer assume one root: q/q1 look in
    BOTH, which keeps every existing painter correct wherever its markup
    happens to be. */
 function q(sel){
  const out=[];
  if(modal)out.push.apply(out,Array.prototype.slice.call(modal.querySelectorAll(sel)));
  if(pop)out.push.apply(out,Array.prototype.slice.call(pop.querySelectorAll(sel)));
  return out;
 }
 function q1(sel){return q(sel)[0]||null;}

 /* ---- position icons --------------------------------------------------
    Rober, 2026-09-21: "i think we should try to match keywords of
    animations and show specific icons for them", with a 13-glyph
    pictogram set. Matched against the scene's NAME and its ID together,
    because OStim carries the useful word in one or the other: ids look
    like "doggy-bed-01" while names read "Standing Embrace".

    ORDER IS THE WHOLE ALGORITHM — first hit wins, so the list runs most
    specific first. "Reverse cowgirl" must be tested before "cowgirl";
    "standing blowjob" is an ORAL scene, not a standing one, so oral
    outranks standing; and "standing from behind" is a STANDING scene, not
    doggy, so standing outranks doggy.

    ⚠ No match returns '' and the row draws no icon. A wrong position icon
    is worse than none — it is a confident lie about what is on screen. */
 /* Matched against the scene's NAME and ID together, most specific first.
    REBUILT 2026-09-21 from a survey of the 8,091 scene files actually
    installed on this rig, which found the old substring matcher was not
    just incomplete but WRONG on ~670 scenes:

      · "Anubs Adult Standing Quicky" is a bend-over-from-behind scene —
        166 scenes say "standing" in the name and are doggy. doggy must
        therefore be tested BEFORE standing.
      · bare "reverse" is not reverse cowgirl (Reverse Bull, Reverse
        Lotus, Bed Reverse) — 179 scenes. Only the PHRASE is safe.
      · "laying" is not a position — 328 names (Laying Blowjob Doggy,
        Laying 69, Laying Anal). It is a weak last-resort only.
      · substring "sit" hit 571 names including transitions; it needs a
        word boundary and must come last.

    Every entry is a regex with word boundaries for exactly that reason.
    Scene metadata takes precedence over this name fallback. The old
    8,091-file survey measured assignment coverage, not visual accuracy.
    Unnamed or conflicting scenes must remain unlabelled. */
 /* BEGIN POSITION_CATALOG — generated by tools/position-icon-catalog.py */
 const POSITION_CATALOG=[
  {"id":"sixtynine","label":"69","aliases":["69","sixty nine","mutual oral"],"kind":"Position"},
  {"id":"bent-over-table","label":"Bent over table","aliases":["bent over table","bend over table","bent over a table","table bent over","table bendover"],"kind":"Position"},
  {"id":"carry","label":"Carried","aliases":["carried","carry","piledriver","suspended"],"kind":"Position"},
  {"id":"cowgirl","label":"Cowgirl","aliases":["cowgirl","riding","straddling"],"kind":"Position"},
  {"id":"doggy","label":"Doggy","aliases":["doggy","doggystyle","from behind","all fours","bendover"],"kind":"Position"},
  {"id":"embrace","label":"Embrace","aliases":["embrace","cuddle","foreplay"],"kind":"Activity"},
  {"id":"face-sitting","label":"Face sitting","aliases":["facesitting","face sitting","face sit"],"kind":"Position"},
  {"id":"footjob","label":"Footjob","aliases":["footjob","foot fetish"],"kind":"Activity"},
  {"id":"group","label":"Group","aliases":["threesome","foursome","group sex","orgy"],"kind":"Activity"},
  {"id":"handjob","label":"Handjob","aliases":["handjob","stroking"],"kind":"Activity"},
  {"id":"kneel","label":"Kneeling or seated","aliases":["kneeling","squatting","sitting","chair","bench"],"kind":"Position"},
  {"id":"legsup","label":"Legs up","aliases":["legs up","mating press","legup"],"kind":"Position"},
  {"id":"lotus","label":"Lotus","aliases":["lotus"],"kind":"Position"},
  {"id":"missionary","label":"Missionary","aliases":["missionary"],"kind":"Position"},
  {"id":"oral","label":"Oral","aliases":["oral","blowjob","cunnilingus","deep throat"],"kind":"Activity"},
  {"id":"prone","label":"Prone","aliases":["prone"],"kind":"Position"},
  {"id":"cowgirl-lean","label":"Reverse cowgirl","aliases":["reverse cowgirl","revcowgirl"],"kind":"Position"},
  {"id":"solo","label":"Solo","aliases":["solo","masturbation"],"kind":"Activity"},
  {"id":"spooning","label":"Spooning","aliases":["spooning","spoon"],"kind":"Position"},
  {"id":"standing","label":"Standing","aliases":["standing","upright"],"kind":"Position"},
  {"id":"titjob","label":"Titjob","aliases":["titjob","boobjob","paizuri"],"kind":"Activity"},
  {"id":"transition","label":"Transition","aliases":["transition"],"kind":"Transition"},
  {"id":"wall-behind","label":"Wall from behind","aliases":["wall behind","wall from behind","against wall from behind","from behind against wall"],"kind":"Position"},
  {"id":"wheelbarrow","label":"Wheelbarrow","aliases":["wheelbarrow","wheel barrow"],"kind":"Position"}
 ];
 /* END POSITION_CATALOG */
 /* BEGIN POSITION_VARIANTS — generated by tools/position-icon-catalog.py */
 const POSITION_VARIANTS=[
  {"id":"pack-x0004-01","label":"Prone pair","aliases":["prone pair","x0004-sex 1","prone"],"kind":"Position","category":"prone","asset":"icons/custom/pos-pack-x0004-01.png","pack":"x0004-sex","number":1},
  {"id":"pack-x0004-02","label":"Opposed lying pair","aliases":["opposed lying pair","x0004-sex 2","69"],"kind":"Position","category":"sixtynine","asset":"icons/custom/pos-pack-x0004-02.png","pack":"x0004-sex","number":2},
  {"id":"pack-x0004-03","label":"Raised-leg pair","aliases":["raised-leg pair","x0004-sex 3","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-x0004-03.png","pack":"x0004-sex","number":3},
  {"id":"pack-x0004-04","label":"Seated facing pair","aliases":["seated facing pair","x0004-sex 4","lotus"],"kind":"Position","category":"lotus","asset":"icons/custom/pos-pack-x0004-04.png","pack":"x0004-sex","number":4},
  {"id":"pack-x0004-05","label":"Standing carry","aliases":["standing carry","x0004-sex 5","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-x0004-05.png","pack":"x0004-sex","number":5},
  {"id":"pack-x0004-06","label":"Inverted supported pair","aliases":["inverted supported pair","x0004-sex 6","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-x0004-06.png","pack":"x0004-sex","number":6},
  {"id":"pack-x0004-07","label":"Standing rear pair","aliases":["standing rear pair","x0004-sex 7","standing"],"kind":"Position","category":"standing","asset":"icons/custom/pos-pack-x0004-07.png","pack":"x0004-sex","number":7},
  {"id":"pack-x0004-08","label":"Face-to-face floor pair","aliases":["face-to-face floor pair","x0004-sex 8","missionary"],"kind":"Position","category":"missionary","asset":"icons/custom/pos-pack-x0004-08.png","pack":"x0004-sex","number":8},
  {"id":"pack-x0004-09","label":"Side-lying pair","aliases":["side-lying pair","x0004-sex 9","spooning"],"kind":"Position","category":"spooning","asset":"icons/custom/pos-pack-x0004-09.png","pack":"x0004-sex","number":9},
  {"id":"pack-x0004-10","label":"Leaning-back rider","aliases":["leaning-back rider","x0004-sex 10","reverse cowgirl"],"kind":"Position","category":"cowgirl-lean","asset":"icons/custom/pos-pack-x0004-10.png","pack":"x0004-sex","number":10},
  {"id":"pack-x0004-11","label":"Upright rider","aliases":["upright rider","x0004-sex 11","cowgirl"],"kind":"Position","category":"cowgirl","asset":"icons/custom/pos-pack-x0004-11.png","pack":"x0004-sex","number":11},
  {"id":"pack-x0004-12","label":"Kneeling rear pair","aliases":["kneeling rear pair","x0004-sex 12","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-x0004-12.png","pack":"x0004-sex","number":12},
  {"id":"pack-x0004-13","label":"Standing and kneeling oral","aliases":["standing and kneeling oral","x0004-sex 13","oral"],"kind":"Activity","category":"oral","asset":"icons/custom/pos-pack-x0004-13.png","pack":"x0004-sex","number":13},
  {"id":"pack-positions-01","label":"Supported face-to-face pair","aliases":["supported face-to-face pair","sexpositions 1","missionary"],"kind":"Position","category":"missionary","asset":"icons/custom/pos-pack-positions-01.png","pack":"SexPositions","number":1},
  {"id":"pack-positions-02","label":"Low kneeling rear pair","aliases":["low kneeling rear pair","sexpositions 2","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-positions-02.png","pack":"SexPositions","number":2},
  {"id":"pack-positions-03","label":"Reclining face-to-face pair","aliases":["reclining face-to-face pair","sexpositions 3","missionary"],"kind":"Position","category":"missionary","asset":"icons/custom/pos-pack-positions-03.png","pack":"SexPositions","number":3},
  {"id":"pack-positions-04","label":"Seated back-to-front pair","aliases":["seated back-to-front pair","sexpositions 4","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-positions-04.png","pack":"SexPositions","number":4},
  {"id":"pack-positions-05","label":"All-fours rear pair","aliases":["all-fours rear pair","sexpositions 5","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-positions-05.png","pack":"SexPositions","number":5},
  {"id":"pack-positions-06","label":"Upright over prone pair","aliases":["upright over prone pair","sexpositions 6"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-positions-06.png","pack":"SexPositions","number":6},
  {"id":"pack-positions-07","label":"Standing supported carry","aliases":["standing supported carry","sexpositions 7","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-positions-07.png","pack":"SexPositions","number":7},
  {"id":"pack-positions-08","label":"Reclining reverse rider","aliases":["reclining reverse rider","sexpositions 8","reverse cowgirl"],"kind":"Position","category":"cowgirl-lean","asset":"icons/custom/pos-pack-positions-08.png","pack":"SexPositions","number":8},
  {"id":"pack-positions-09","label":"Seated facing floor pair","aliases":["seated facing floor pair","sexpositions 9","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-positions-09.png","pack":"SexPositions","number":9},
  {"id":"pack-positions-10","label":"Reclined rider","aliases":["reclined rider","sexpositions 10","cowgirl"],"kind":"Position","category":"cowgirl","asset":"icons/custom/pos-pack-positions-10.png","pack":"SexPositions","number":10},
  {"id":"pack-positions-11","label":"Supported seated pair","aliases":["supported seated pair","sexpositions 11","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-positions-11.png","pack":"SexPositions","number":11},
  {"id":"pack-positions-12","label":"Prone rear pair","aliases":["prone rear pair","sexpositions 12","prone"],"kind":"Position","category":"prone","asset":"icons/custom/pos-pack-positions-12.png","pack":"SexPositions","number":12},
  {"id":"pack-positions-13","label":"Forward-leaning rear pair","aliases":["forward-leaning rear pair","sexpositions 13","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-positions-13.png","pack":"SexPositions","number":13},
  {"id":"pack-positions-14","label":"Raised all-fours pair","aliases":["raised all-fours pair","sexpositions 14","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-positions-14.png","pack":"SexPositions","number":14},
  {"id":"pack-positions-15","label":"Supported raised-leg pair","aliases":["supported raised-leg pair","sexpositions 15","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-positions-15.png","pack":"SexPositions","number":15},
  {"id":"pack-positions-16","label":"Folded raised-leg pair","aliases":["folded raised-leg pair","sexpositions 16","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-positions-16.png","pack":"SexPositions","number":16},
  {"id":"pack-positions-17","label":"Upright raised-leg pair","aliases":["upright raised-leg pair","sexpositions 17","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-positions-17.png","pack":"SexPositions","number":17},
  {"id":"pack-positions-18","label":"Standing supported wheelbarrow","aliases":["standing supported wheelbarrow","sexpositions 18","wheelbarrow"],"kind":"Position","category":"wheelbarrow","asset":"icons/custom/pos-pack-positions-18.png","pack":"SexPositions","number":18},
  {"id":"pack-positions-19","label":"Reverse rider with raised torso","aliases":["reverse rider with raised torso","sexpositions 19","reverse cowgirl"],"kind":"Position","category":"cowgirl-lean","asset":"icons/custom/pos-pack-positions-19.png","pack":"SexPositions","number":19},
  {"id":"pack-positions-20","label":"Split-leg supported pair","aliases":["split-leg supported pair","sexpositions 20","wheelbarrow"],"kind":"Position","category":"wheelbarrow","asset":"icons/custom/pos-pack-positions-20.png","pack":"SexPositions","number":20},
  {"id":"pack-positions-21","label":"Standing wheelbarrow","aliases":["standing wheelbarrow","sexpositions 21","wheelbarrow"],"kind":"Position","category":"wheelbarrow","asset":"icons/custom/pos-pack-positions-21.png","pack":"SexPositions","number":21},
  {"id":"pack-etsy-01","label":"Shower figure","aliases":["shower figure","sex-etsy 1"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-01.png","pack":"sex-etsy","number":1},
  {"id":"pack-etsy-02","label":"Reclining solo figure","aliases":["reclining solo figure","sex-etsy 2","solo"],"kind":"Activity","category":"solo","asset":"icons/custom/pos-pack-etsy-02.png","pack":"sex-etsy","number":2},
  {"id":"pack-etsy-03","label":"Blindfold chair encounter","aliases":["blindfold chair encounter","sex-etsy 3"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-03.png","pack":"sex-etsy","number":3},
  {"id":"pack-etsy-04","label":"Figure at computer","aliases":["figure at computer","sex-etsy 4"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-04.png","pack":"sex-etsy","number":4},
  {"id":"pack-etsy-05","label":"Costume and crop figure","aliases":["costume and crop figure","sex-etsy 5"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-05.png","pack":"sex-etsy","number":5},
  {"id":"pack-etsy-06","label":"Table restraint illustration","aliases":["table restraint illustration","sex-etsy 6"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-06.png","pack":"sex-etsy","number":6},
  {"id":"pack-etsy-07","label":"Hat and crop figure","aliases":["hat and crop figure","sex-etsy 7"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-07.png","pack":"sex-etsy","number":7},
  {"id":"pack-etsy-08","label":"Table discipline illustration","aliases":["table discipline illustration","sex-etsy 8"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-08.png","pack":"sex-etsy","number":8},
  {"id":"pack-etsy-09","label":"Side-lying raised-leg pair","aliases":["side-lying raised-leg pair","sex-etsy 9","spooning"],"kind":"Position","category":"spooning","asset":"icons/custom/pos-pack-etsy-09.png","pack":"sex-etsy","number":9},
  {"id":"pack-etsy-10","label":"Standing supported-leg pair","aliases":["standing supported-leg pair","sex-etsy 10","standing"],"kind":"Position","category":"standing","asset":"icons/custom/pos-pack-etsy-10.png","pack":"sex-etsy","number":10},
  {"id":"pack-etsy-11","label":"Kneeling embrace","aliases":["kneeling embrace","sex-etsy 11","embrace"],"kind":"Activity","category":"embrace","asset":"icons/custom/pos-pack-etsy-11.png","pack":"sex-etsy","number":11},
  {"id":"pack-etsy-12","label":"Face-sitting pair","aliases":["face-sitting pair","sex-etsy 12","face sitting"],"kind":"Position","category":"face-sitting","asset":"icons/custom/pos-pack-etsy-12.png","pack":"sex-etsy","number":12},
  {"id":"pack-etsy-13","label":"Upright front carry","aliases":["upright front carry","sex-etsy 13","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-13.png","pack":"sex-etsy","number":13},
  {"id":"pack-etsy-14","label":"Reclined raised-leg pair","aliases":["reclined raised-leg pair","sex-etsy 14","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-etsy-14.png","pack":"sex-etsy","number":14},
  {"id":"pack-etsy-15","label":"Seated and kneeling oral","aliases":["seated and kneeling oral","sex-etsy 15","oral"],"kind":"Activity","category":"oral","asset":"icons/custom/pos-pack-etsy-15.png","pack":"sex-etsy","number":15},
  {"id":"pack-etsy-16","label":"Inverted supported pair","aliases":["inverted supported pair","sex-etsy 16","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-16.png","pack":"sex-etsy","number":16},
  {"id":"pack-etsy-17","label":"Standing wheelbarrow pair","aliases":["standing wheelbarrow pair","sex-etsy 17","wheelbarrow"],"kind":"Position","category":"wheelbarrow","asset":"icons/custom/pos-pack-etsy-17.png","pack":"sex-etsy","number":17},
  {"id":"pack-etsy-18","label":"Chair and kneeling oral","aliases":["chair and kneeling oral","sex-etsy 18","oral"],"kind":"Activity","category":"oral","asset":"icons/custom/pos-pack-etsy-18.png","pack":"sex-etsy","number":18},
  {"id":"pack-etsy-19","label":"Unsteady lift cartoon","aliases":["unsteady lift cartoon","sex-etsy 19"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-19.png","pack":"sex-etsy","number":19},
  {"id":"pack-etsy-20","label":"Low all-fours rear pair","aliases":["low all-fours rear pair","sex-etsy 20","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-etsy-20.png","pack":"sex-etsy","number":20},
  {"id":"pack-etsy-21","label":"Toppling chair cartoon","aliases":["toppling chair cartoon","sex-etsy 21"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-21.png","pack":"sex-etsy","number":21},
  {"id":"pack-etsy-22","label":"Reverse rider on raised torso","aliases":["reverse rider on raised torso","sex-etsy 22","reverse cowgirl"],"kind":"Position","category":"cowgirl-lean","asset":"icons/custom/pos-pack-etsy-22.png","pack":"sex-etsy","number":22},
  {"id":"pack-etsy-23","label":"Supported rear wheelbarrow","aliases":["supported rear wheelbarrow","sex-etsy 23","wheelbarrow"],"kind":"Position","category":"wheelbarrow","asset":"icons/custom/pos-pack-etsy-23.png","pack":"sex-etsy","number":23},
  {"id":"pack-etsy-24","label":"Inverted front carry","aliases":["inverted front carry","sex-etsy 24","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-24.png","pack":"sex-etsy","number":24},
  {"id":"pack-etsy-25","label":"Standing wrapped carry","aliases":["standing wrapped carry","sex-etsy 25","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-25.png","pack":"sex-etsy","number":25},
  {"id":"pack-etsy-26","label":"Standing embrace","aliases":["standing embrace","sex-etsy 26","embrace"],"kind":"Activity","category":"embrace","asset":"icons/custom/pos-pack-etsy-26.png","pack":"sex-etsy","number":26},
  {"id":"pack-etsy-27","label":"Sideways supported carry","aliases":["sideways supported carry","sex-etsy 27","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-27.png","pack":"sex-etsy","number":27},
  {"id":"pack-etsy-28","label":"Folded raised-leg pair","aliases":["folded raised-leg pair","sex-etsy 28","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-etsy-28.png","pack":"sex-etsy","number":28},
  {"id":"pack-etsy-29","label":"Seated facing floor pair","aliases":["seated facing floor pair","sex-etsy 29","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-etsy-29.png","pack":"sex-etsy","number":29},
  {"id":"pack-etsy-30","label":"Low face-to-face pair","aliases":["low face-to-face pair","sex-etsy 30","missionary"],"kind":"Position","category":"missionary","asset":"icons/custom/pos-pack-etsy-30.png","pack":"sex-etsy","number":30},
  {"id":"pack-etsy-31","label":"Standing and kneeling pair","aliases":["standing and kneeling pair","sex-etsy 31","oral"],"kind":"Activity","category":"oral","asset":"icons/custom/pos-pack-etsy-31.png","pack":"sex-etsy","number":31},
  {"id":"pack-etsy-32","label":"High raised-leg pair","aliases":["high raised-leg pair","sex-etsy 32","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-etsy-32.png","pack":"sex-etsy","number":32},
  {"id":"pack-etsy-33","label":"Chair back-to-front pair","aliases":["chair back-to-front pair","sex-etsy 33","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-etsy-33.png","pack":"sex-etsy","number":33},
  {"id":"pack-etsy-34","label":"Hand-holding pair","aliases":["hand-holding pair","sex-etsy 34","embrace"],"kind":"Activity","category":"embrace","asset":"icons/custom/pos-pack-etsy-34.png","pack":"sex-etsy","number":34},
  {"id":"pack-etsy-35","label":"Kneeling oral pair","aliases":["kneeling oral pair","sex-etsy 35","oral"],"kind":"Activity","category":"oral","asset":"icons/custom/pos-pack-etsy-35.png","pack":"sex-etsy","number":35},
  {"id":"pack-etsy-36","label":"Standing bent-forward oral","aliases":["standing bent-forward oral","sex-etsy 36","oral"],"kind":"Activity","category":"oral","asset":"icons/custom/pos-pack-etsy-36.png","pack":"sex-etsy","number":36},
  {"id":"pack-etsy-37","label":"Seated chair rear pair","aliases":["seated chair rear pair","sex-etsy 37","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-etsy-37.png","pack":"sex-etsy","number":37},
  {"id":"pack-etsy-38","label":"Table-edge facing pair","aliases":["table-edge facing pair","sex-etsy 38"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-etsy-38.png","pack":"sex-etsy","number":38},
  {"id":"pack-etsy-39","label":"Supported over reclined pair","aliases":["supported over reclined pair","sex-etsy 39"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-etsy-39.png","pack":"sex-etsy","number":39},
  {"id":"pack-etsy-40","label":"Low folded pair","aliases":["low folded pair","sex-etsy 40"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-etsy-40.png","pack":"sex-etsy","number":40},
  {"id":"pack-etsy-41","label":"Bent-over table pair","aliases":["bent-over table pair","sex-etsy 41","bent over table"],"kind":"Position","category":"bent-over-table","asset":"icons/custom/pos-pack-etsy-41.png","pack":"sex-etsy","number":41},
  {"id":"pack-etsy-42","label":"Standing rear pair","aliases":["standing rear pair","sex-etsy 42","standing"],"kind":"Position","category":"standing","asset":"icons/custom/pos-pack-etsy-42.png","pack":"sex-etsy","number":42},
  {"id":"pack-etsy-43","label":"Chair with raised legs","aliases":["chair with raised legs","sex-etsy 43","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-etsy-43.png","pack":"sex-etsy","number":43},
  {"id":"pack-etsy-44","label":"Standing face-to-face pair","aliases":["standing face-to-face pair","sex-etsy 44","standing"],"kind":"Position","category":"standing","asset":"icons/custom/pos-pack-etsy-44.png","pack":"sex-etsy","number":44},
  {"id":"pack-etsy-45","label":"Pillow-fight cartoon","aliases":["pillow-fight cartoon","sex-etsy 45"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-45.png","pack":"sex-etsy","number":45},
  {"id":"pack-etsy-46","label":"Upright reverse rider","aliases":["upright reverse rider","sex-etsy 46","reverse cowgirl"],"kind":"Position","category":"cowgirl-lean","asset":"icons/custom/pos-pack-etsy-46.png","pack":"sex-etsy","number":46},
  {"id":"pack-etsy-47","label":"All-fours rear pair","aliases":["all-fours rear pair","sex-etsy 47","doggy"],"kind":"Position","category":"doggy","asset":"icons/custom/pos-pack-etsy-47.png","pack":"sex-etsy","number":47},
  {"id":"pack-etsy-48","label":"Standing pair at a chair","aliases":["standing pair at a chair","sex-etsy 48","standing"],"kind":"Position","category":"standing","asset":"icons/custom/pos-pack-etsy-48.png","pack":"sex-etsy","number":48},
  {"id":"pack-etsy-49","label":"Kneeling raised-leg pair","aliases":["kneeling raised-leg pair","sex-etsy 49","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-etsy-49.png","pack":"sex-etsy","number":49},
  {"id":"pack-etsy-50","label":"Back-to-back kneeling pair","aliases":["back-to-back kneeling pair","sex-etsy 50"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-etsy-50.png","pack":"sex-etsy","number":50},
  {"id":"pack-etsy-51","label":"Chair-facing pair","aliases":["chair-facing pair","sex-etsy 51","kneeling or seated"],"kind":"Position","category":"kneel","asset":"icons/custom/pos-pack-etsy-51.png","pack":"sex-etsy","number":51},
  {"id":"pack-etsy-52","label":"Forward-leaning rider","aliases":["forward-leaning rider","sex-etsy 52","cowgirl"],"kind":"Position","category":"cowgirl","asset":"icons/custom/pos-pack-etsy-52.png","pack":"sex-etsy","number":52},
  {"id":"pack-etsy-53","label":"Rear rider over kneeling pair","aliases":["rear rider over kneeling pair","sex-etsy 53"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-etsy-53.png","pack":"sex-etsy","number":53},
  {"id":"pack-etsy-54","label":"Lingerie figure","aliases":["lingerie figure","sex-etsy 54"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-54.png","pack":"sex-etsy","number":54},
  {"id":"pack-etsy-55","label":"Standing figure with accessory","aliases":["standing figure with accessory","sex-etsy 55"],"kind":"Reference","category":"","asset":"icons/custom/pos-pack-etsy-55.png","pack":"sex-etsy","number":55},
  {"id":"pack-etsy-56","label":"Front-facing supported carry","aliases":["front-facing supported carry","sex-etsy 56","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-56.png","pack":"sex-etsy","number":56},
  {"id":"pack-etsy-57","label":"Chair-supported carry","aliases":["chair-supported carry","sex-etsy 57","carried"],"kind":"Position","category":"carry","asset":"icons/custom/pos-pack-etsy-57.png","pack":"sex-etsy","number":57},
  {"id":"pack-etsy-58","label":"Back-to-back floor pair","aliases":["back-to-back floor pair","sex-etsy 58"],"kind":"Position","category":"","asset":"icons/custom/pos-pack-etsy-58.png","pack":"sex-etsy","number":58},
  {"id":"pack-etsy-59","label":"Close raised-leg pair","aliases":["close raised-leg pair","sex-etsy 59","legs up"],"kind":"Position","category":"legsup","asset":"icons/custom/pos-pack-etsy-59.png","pack":"sex-etsy","number":59},
  {"id":"pack-etsy-60","label":"Close side-lying pair","aliases":["close side-lying pair","sex-etsy 60","spooning"],"kind":"Position","category":"spooning","asset":"icons/custom/pos-pack-etsy-60.png","pack":"sex-etsy","number":60},
  {"id":"pack-etsy-61","label":"Leaning reverse rider","aliases":["leaning reverse rider","sex-etsy 61","reverse cowgirl"],"kind":"Position","category":"cowgirl-lean","asset":"icons/custom/pos-pack-etsy-61.png","pack":"sex-etsy","number":61},
  {"id":"pack-etsy-62","label":"Cross-legged facing pair","aliases":["cross-legged facing pair","sex-etsy 62","lotus"],"kind":"Position","category":"lotus","asset":"icons/custom/pos-pack-etsy-62.png","pack":"sex-etsy","number":62}
 ];
 /* END POSITION_VARIANTS */
 const POSITION_KEYS=new Set(POSITION_CATALOG.map(p=>p.id));
 const POSITION_ART=POSITION_CATALOG.map(p=>Object.assign({category:p.id,pack:'SkyManager',asset:'icons/custom/pos-'+p.id+'.png'},p)).concat(POSITION_VARIANTS);
 const POSITION_ART_BY_ID=new Map(POSITION_ART.map(p=>[p.id,p]));
 const POSITIONS=[
  // A transition is not a position — it is the move between two of them.
  ['transition',   /\btransition\b/],
  ['sixtynine',    /\b(69|sixtynine|sixty ?nine|mutual oral)\b/],
  ['cowgirl-lean', /\b(reverse ?cowgirl|revcowgirl)\b/],
  ['lotus',        /\blotus\b/],
  ['cowgirl',      /\b(cowgirl|riding|straddl\w*|mounted)\b/],
  ['spooning',     /\bspoon(ing)?\b/],
  ['prone',        /\bprone\b/],
  ['carry',        /\b(carry|carrying|carried|piledriver|suspended)\b/],
  ['legsup',       /\b(legs? ?up|legup|mating ?press|stretch ?legs?|legs? held|held legs?|legs? on shoulders?)\b/],
  // Specific, inspected variants. A bare furniture tag does not select these.
  ['face-sitting', /\b(facesitting|face sitting|face sit)\b/],
  ['bent-over-table', /\b(bent over table|bend over table|bent over a table|table bent over|table bendover)\b/],
  ['wall-behind', /\b(wall behind|wall from behind|against wall from behind|from behind against wall)\b/],
  ['wheelbarrow', /\b(wheelbarrow|wheel barrow)\b/],
  ['oral',         /\b(blowjob|blow job|oral|fellatio|cunnilingus|facefuck|face ?sit\w*|deepthroat|deep throat|rimjob|irrumatio)\b/],
  ['missionary',   /\bmissionary\b/],
  ['doggy',        /\b(doggy|doggystyle|from behind|rear entry|bend ?over|bent ?over|all ?fours|rear)\b/],
  // Acts that are their own position. After the named positions, so
  // "Threesome Doggy" still shows doggy.
  ['titjob',       /\b(tit ?job|boob ?job|tit ?fuck|breast ?job|paizuri)\b/],
  ['footjob',      /\b(foot ?job|foot ?fetish)\b/],
  ['handjob',      /\b(hand ?job|stroking)\b/],
  ['solo',         /\b(solo|masturbat\w*)\b/],
  ['group',        /\b(threesome|foursome|fivesome|gangbang|orgy|group ?sex)\b/],
  ['embrace',      /\b(embrace|cuddl\w*|foreplay)\b/],
  ['standing',     /\b(standing|upright|wall)\b/],
  ['kneel',        /\b(kneel\w*|squat\w*)\b/],
  // Last, and weak on purpose: see the "laying"/"sit" notes above.
  ['kneel',        /\b(sit|sitting|chair|bench|stool)\b/]
 ];
 /* The native index sees tags in scene files. Its conflict list takes
    precedence even over fallback names, so duplicate IDs cannot hide an
    ambiguous result behind a plausible label. */
 let sceneIcons=null,sceneIconsPending=false,sceneIconConflicts=new Set();
 function getSceneIcons(rescan){
  if(sceneIconsPending)return;
  if(typeof window.osTools!=='function'){message('Scene bridge unavailable.');return;}
  sceneIconsPending=true;
  request('sceneIcons',{rescan:!!rescan},j=>{
   sceneIconsPending=false;
   if(!j||!j.ok||!j.icons||typeof j.icons!=='object'||Array.isArray(j.icons)){
    message((j&&j.msg)||'Scene icons could not be read. Use Rescan scene icons to retry.');return;
   }
   const next=Object.create(null);
   Object.keys(j.icons).forEach(id=>{if(typeof j.icons[id]==='string'&&POSITION_KEYS.has(j.icons[id]))next[id]=j.icons[id];});
   sceneIcons=next;
   sceneIconConflicts=new Set(Array.isArray(j.conflictedIds)?j.conflictedIds.filter(id=>typeof id==='string'):[]);
   sceneIconConflicts.forEach(id=>{delete sceneIcons[id];});
   const count=Object.keys(sceneIcons).length, total=Number(Number.isInteger(j.uniqueScenes)?j.uniqueScenes:(j.scanned||0));
   if(!pop||pop.dataset.kind!=='position-reference')render();
   message('Scene icons: '+count+(total?' of '+total:'')+' scenes matched.'+
    (sceneIconConflicts.size?' '+sceneIconConflicts.size+' conflicting scene IDs left unlabelled.':''));
  });
 }
 function positionCategory(name,sceneId){
  if(sceneId&&sceneIconConflicts.has(sceneId))return '';
  if(sceneIcons&&sceneId&&Object.prototype.hasOwnProperty.call(sceneIcons,sceneId))
   return sceneIcons[sceneId];
  const hay=' '+((name||'')+' '+(sceneId||'')).toLowerCase().replace(/[_\-]+/g,' ')+' ';
  for(let i=0;i<POSITIONS.length;i++)
   if(POSITIONS[i][1].test(hay))return POSITIONS[i][0];
  return '';
 }
 /* Explicit choices are independent of the automatic index. A rescan must
    never erase them. Only IDs in the supplied catalog can become paths. */
 let positionChoices={v:1,categories:Object.create(null),scenes:Object.create(null)};
 let positionChoicesReady=false,positionChoicesPending=false,positionChoiceSaving=false,positionChoicesError='';
 function readPositionChoices(j){
  const c=j&&j.choices;
  if(!j||!j.ok||!c||c.v!==1)return null;
  const next={v:1,categories:Object.create(null),scenes:Object.create(null)};
  for(const scope of ['categories','scenes']){
   if(!c[scope]||typeof c[scope]!=='object'||Array.isArray(c[scope]))return null;
   const keys=Object.keys(c[scope]);if(keys.length>(scope==='scenes'?4096:24))return null;
   for(const key of keys){
    if(scope==='categories'?!POSITION_KEYS.has(key):(!key||key.length>256||/[\x00-\x1f\x7f]/.test(key)))return null;
    if(typeof c[scope][key]!=='string'||!POSITION_ART_BY_ID.has(c[scope][key]))return null;
    next[scope][key]=c[scope][key];
   }
  }
  return next;
 }
 function paintPositionChoiceState(){
  if(pop&&pop._positionState)pop._positionState();
 }
 function positionChoicesChanged(){
  paintPositionChoiceState();
  document.querySelectorAll('img[data-position-scene]').forEach(i=>{
   const src=positionIcon(i.dataset.positionName,i.dataset.positionScene);
   if(src&&i.getAttribute('src')!==src){i.style.visibility='';i.removeAttribute('aria-hidden');i.src=src;i.dataset.pos=src.replace('icons/custom/pos-','').replace('.png','');}
   else if(!src)i.style.visibility='hidden';
  });
  if(modal)paintStatus();
  window.dispatchEvent(new CustomEvent('hd-position-art-changed'));
 }
 function getPositionChoices(retry){
  if(positionChoicesPending||positionChoiceSaving||(!retry&&(positionChoicesReady||positionChoicesError)))return;
  if(typeof window.osTools!=='function'){positionChoicesError='Saving icon choices needs the game bridge.';paintPositionChoiceState();return;}
  positionChoicesPending=true;positionChoicesError='';paintPositionChoiceState();
  request('sceneIconChoices',{},j=>{
   positionChoicesPending=false;
   const next=readPositionChoices(j);
   if(!next){positionChoicesReady=false;positionChoicesError=(j&&j.msg)||'Saved icon choices could not be read.';paintPositionChoiceState();return;}
   positionChoices=next;positionChoicesReady=true;positionChoicesError='';positionChoicesChanged();
  },true);
 }
 function savePositionChoice(scope,key,icon){
  if(!positionChoicesReady||positionChoicesPending||positionChoiceSaving)return;
  if(icon&&!POSITION_ART_BY_ID.has(icon))return;
  if(typeof window.osTools!=='function'){positionChoicesReady=false;positionChoicesError='Saving icon choices needs the game bridge.';paintPositionChoiceState();return;}
  positionChoiceSaving=true;positionChoicesError='';paintPositionChoiceState();
  request('sceneIconSet',{scope:scope,key:key,icon:icon},j=>{
   positionChoiceSaving=false;const next=readPositionChoices(j);
   if(!next){positionChoicesError=(j&&j.msg)||'The icon choice was not saved.';paintPositionChoiceState();return;}
   positionChoices=next;positionChoicesReady=true;positionChoicesError='';positionChoicesChanged();
   message(icon?'Icon choice saved.':'Automatic icon restored.');
  },true);
 }
 function positionIcon(name,sceneId){
  const manual=sceneId&&positionChoices.scenes[sceneId];
  if(manual&&POSITION_ART_BY_ID.has(manual))return POSITION_ART_BY_ID.get(manual).asset;
  const category=positionCategory(name,sceneId);if(!category)return '';
  const choice=positionChoices.categories[category]||category;
  return POSITION_ART_BY_ID.has(choice)?POSITION_ART_BY_ID.get(choice).asset:'';
 }
 function positionImage(src,cls){
  const i=el('img',cls||'ost-pos');i.alt='';i.width=144;i.height=96;
  i.dataset.pos=src.replace('icons/custom/pos-','').replace('.png','');
  // Public builds deliberately omit some privately sourced art. Preserve the
  // slot without a broken-image symbol, on every consumer of this helper.
  i.addEventListener('error',()=>{i.style.visibility='hidden';i.setAttribute('aria-hidden','true');});
  i.src=src;return i;
 }
 /* An <img> for a scene, or null when nothing matched. */
 function positionArt(name,sceneId,cls){
  getPositionChoices(false);
  const src=positionIcon(name,sceneId);
  if(!src)return null;
  const i=positionImage(src,cls);i.dataset.positionScene=sceneId||'';i.dataset.positionName=name||'';return i;
 }
 const positionReferenceFilter={query:'',pack:'',kind:''};
 function positionReference(scene){
  const target=scene&&typeof scene.sceneId==='string'?{sceneId:scene.sceneId,name:scene.name||scene.sceneId}:
   (snapshot.inScene&&snapshot.scene?{sceneId:snapshot.scene,name:snapshot.sceneName||snapshot.scene}:null);
  getPositionChoices(false);
  popout('Position reference','Choose artwork for a scene or a position category.',host=>{
   const input=el('input','ost-search');input.type='search';input.placeholder='Search positions, activities, or icon numbers…';input.setAttribute('aria-label','Search position reference');input.value=positionReferenceFilter.query;
   const filters=el('div','ost-position-filters');
   function filter(label,key,values){
    const wrap=el('label','ost-position-filter'),select=el('select','ost-search');wrap.append(el('span','',label),select);select.setAttribute('aria-label',label);
    values.forEach(v=>{const o=el('option','',v[1]);o.value=v[0];select.append(o);});select.value=positionReferenceFilter[key];
    select.addEventListener('change',()=>{positionReferenceFilter[key]=select.value;paint();});return wrap;
   }
   filters.append(filter('Icon pack','pack',[['','All packs'],['x0004-sex','x0004-sex · 13'],['SexPositions','SexPositions · 21'],['sex-etsy','sex-etsy · 62'],['SkyManager','SkyManager · 24']]),
    filter('Type','kind',[['','All types'],['Position','Positions'],['Activity','Activities'],['Transition','Transitions'],['Reference','Reference art']]));
   const count=el('p','ost-position-count');count.setAttribute('role','status');
   const list=el('div','ost-position-grid');
   const paint=()=>{
    const q=String(input.value||'').trim().toLowerCase();
    positionReferenceFilter.query=input.value||'';
    const shown=POSITION_ART.filter(p=>(!positionReferenceFilter.pack||p.pack===positionReferenceFilter.pack)&&(!positionReferenceFilter.kind||p.kind===positionReferenceFilter.kind)&&
     (p.label+' '+p.kind+' '+p.pack+' '+p.id+' '+(p.number||'')+' '+p.aliases.join(' ')).toLowerCase().includes(q));
    count.textContent=shown.length+' of '+POSITION_ART.length+' icons';list.textContent='';
    shown.forEach(p=>{
     const card=btn('',()=>positionDetail(p,target),'ost-position-card');
     card.dataset.position=p.id;card.setAttribute('aria-label','Choose icon: '+p.label+' · '+p.pack+(p.number?' '+p.number:''));
     const well=el('span','ost-position-art'),img=positionImage(p.asset,'ost-position-image');img.loading='lazy';well.append(img);
     const words=el('span','ost-position-words');words.append(el('small','ost-position-kind',p.pack+(p.number?' · #'+p.number:'')+' / '+p.kind),el('strong','',p.label),el('span','ost-position-aliases',p.aliases.join(' · ')||'Choose a scene or category'));
     card.append(well,words);list.append(card);
    });
    if(!shown.length)list.append(el('p','ost-help','No matching icons. Try another name.'));
   };
   input.addEventListener('input',paint);input._ostEnter=()=>{const first=list.querySelector('button');if(first)first.click();};
   host.append(input,filters);
   if(target)host.append(el('p','ost-position-target','Scene: '+target.name));
   host.append(count,list);paint();
  },modal?'library':'','hm-anim');
  if(pop)pop.dataset.kind='position-reference';
 }
 function positionDetail(p,target){
  popout(p.label,p.pack+(p.number?' · Icon '+p.number:'')+' / '+p.kind,host=>{
   const preview=el('div','ost-position-preview');preview.append(positionImage(p.asset,'ost-position-image'));
   const actions=el('div','ost-position-actions'),status=el('p','ost-position-status');status.setAttribute('role','status');
   const controls=[];
   const action=(label,fn)=>{const b=btn(label,fn);controls.push(b);actions.append(b);return b;};
   if(target){
    host.append(el('p','ost-position-target','Scene: '+target.name));
    action('Use for this scene',()=>savePositionChoice('scene',target.sceneId,p.id));
   }
   if(p.category){const category=POSITION_CATALOG.find(c=>c.id===p.category);action('Use for '+category.label+' scenes',()=>savePositionChoice('category',p.category,p.id));}
   const choose=btn('Choose a category…',()=>positionCategoryPicker(p,target));actions.append(choose);
   const resetScene=target?action('Restore automatic scene icon',()=>savePositionChoice('scene',target.sceneId,'')):null;
   const resetCategory=p.category?action('Restore category default',()=>savePositionChoice('category',p.category,'')):null;
   const retry=btn('Retry saved choices',()=>getPositionChoices(true));actions.append(retry);
   const search=btn('Find related scenes',()=>{
    if(!window.OStimPane||!OStimPane.searchFor){message('Scene browser unavailable.');return;}
    popBack='';closePop();OStimPane.searchFor(p.aliases[0]||p.label);
   });actions.append(search);
   host.append(preview,el('p','ost-help',p.category?'This changes the artwork shown beside matching scenes.':'Reference artwork: choose where to use it. It is not assigned automatically.'),status,actions);
   pop._positionState=()=>{
    const waiting=positionChoicesPending||positionChoiceSaving;
    status.textContent=positionChoicesError||(waiting?(positionChoiceSaving?'Saving icon choice…':'Reading saved choices…'):
     (target&&positionChoices.scenes[target.sceneId]===p.id?'This icon is saved for this scene.':
      p.category&&positionChoices.categories[p.category]===p.id?'This icon is saved for '+POSITION_CATALOG.find(c=>c.id===p.category).label+' scenes.':'Choose where this icon appears.'));
    controls.forEach(b=>{b.disabled=!positionChoicesReady||waiting;});
    if(resetScene)resetScene.hidden=!positionChoices.scenes[target.sceneId];
    if(resetCategory)resetCategory.hidden=!positionChoices.categories[p.category];
    retry.hidden=!positionChoicesError;retry.disabled=waiting;choose.disabled=waiting;
   };
   paintPositionChoiceState();
  },()=>positionReference(target),'hm-anim');
  if(pop)pop.dataset.kind='position-detail';
 }
 function positionCategoryPicker(p,target){
  popout('Choose a category','Use '+p.label+' wherever this position category is matched.',host=>{
   const status=el('p','ost-position-status');status.setAttribute('role','status');host.append(status);
   const buttons=[];
   popList(host,'Search position categories…',()=>POSITION_CATALOG.map(c=>({label:c.label,search:c.label+' '+c.aliases.join(' '),category:c})),r=>{
    const b=btn('Use for '+r.label+' scenes',()=>savePositionChoice('category',r.category.id,p.id));b.dataset.category=r.category.id;buttons.push(b);
    b.disabled=!positionChoicesReady||positionChoiceSaving||positionChoicesPending;return b;
   });
   const retry=btn('Retry saved choices',()=>getPositionChoices(true));host.append(retry);
   pop._positionState=()=>{
    status.textContent=positionChoicesError||(positionChoiceSaving?'Saving icon choice…':positionChoicesPending?'Reading saved choices…':'Choose the category to use this icon for.');
    buttons.forEach(b=>{b.disabled=!positionChoicesReady||positionChoiceSaving||positionChoicesPending;b.setAttribute('aria-pressed',String(positionChoices.categories[b.dataset.category]===p.id));});
    retry.hidden=!positionChoicesError;retry.disabled=positionChoicesPending||positionChoiceSaving;
   };paintPositionChoiceState();
  },()=>positionDetail(p,target),'hm-anim');
  if(pop)pop.dataset.kind='position-categories';
 }

 /* ---- popouts ---------------------------------------------------------
    Rober, 2026-09-21: "anything that pops out should be its own spacious
    popout modal so nothing moves or gets weird and we have plenty of room
    to read / font / text / UI."

    Everything that used to expand IN PLACE (a <details> for collections, a
    long voice list crammed under the SOS panel, the expressions help) now
    opens here instead. The point is not decoration: the popout is
    position:fixed and body-anchored, so opening it cannot reflow a single
    pixel of the page behind it — which is exactly the "nothing moves or
    gets weird" he asked for.

    ⚠ Body-anchored, like .ost-back and .gaw-back: it fills the viewport, so
    its bare vh/vw is CORRECT and it must NOT wear scale(var(--ui-scale))
    (the 2026-08-14 popup audit — do not "fix" this).                   */
 let pop=null,popReturn=null,popBack='';
 /* A popout opened FROM a segment (a voice picker, a photo, a collection
    list) replaces it, because there is only ever one popout. Closing that
    child would otherwise dump you on the bare launcher having lost the panel
    you were working in — "nothing moves or gets weird" cuts both ways. So a
    child records which segment to come back to, and closing it reopens that
    segment exactly as it was. */
 function closePop(){
  const back=popBack;popBack='';
  if(pop)pop.remove();
  pop=null;
  // Hand the render target back, or the next render writes into a detached node.
  if(pageBody){body=pageBody;pageBody.textContent='';}
  paintNav();
  if(typeof back==='function'){back();return;}
  if(back&&modal){openSegment(back);return;}
  if(popReturn&&popReturn.isConnected){try{popReturn.focus();}catch(e){}}
  popReturn=null;
 }
 function popout(title,subtitle,build,back,icon){
  popBack='';closePop();
  popBack=back||'';
  popReturn=document.activeElement;
  pop=el('div','ost-pop');
  const card=el('section','ost-pop-card');
  card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');card.setAttribute('aria-label',title);
  const head=el('header','ost-pop-head');
  /* The popout wears the same icon well its dock row does, so opening one
     reads as the row lifting off the page rather than a fresh window. */
  const titles=el('div','ost-pop-titles');
  if(icon){const well=el('span','ost-seg-well ost-pop-well');const i=el('img','ost-icon');i.src='icons/custom/'+icon+'.png';i.alt='';well.append(i);titles.append(well);}
  titles.append(el('h2','',title));
  head.append(titles,btn('Close',closePop));
  const host=el('div','ost-pop-body');
  card.append(head);
  if(subtitle)card.append(el('p','ost-help ost-pop-sub',subtitle));
  const pn=el('p','ost-pop-note');pn.setAttribute('role','status');card.append(pn,host);
  pop.append(card);document.body.append(pop);
  pop.addEventListener('click',e=>{if(e.target===pop)closePop();});
  build(host);
  const first=host.querySelector('input')||head.querySelector('button');
  if(first&&first.focus)try{first.focus();}catch(e){}
  return host;
 }
 /* A searchable list inside a popout — the shape four of the five callers
    want, so none of them hand-rolls it. */
 function popList(host,placeholder,rows,paintRow){
  const list=el('div','ost-list');
  let q='';
  const input=el('input','ost-search');input.type='search';input.placeholder=placeholder;
  input.setAttribute('aria-label',placeholder);
  const paint=()=>{
   list.textContent='';
   const shown=rows().filter(r=>String(r.search||r.label||'').toLowerCase().includes(q.toLowerCase()));
   shown.slice(0,RENDER_CAP).forEach(r=>list.append(paintRow(r,paint)));
   if(!shown.length)list.append(el('p','ost-help','Nothing matches that.'));
  };
  input.addEventListener('input',()=>{q=input.value;paint();});
  input._ostEnter=()=>{const b=list.querySelector('button');if(b&&!b.disabled)b.click();};
  host.append(input,list);paint();
  return paint;
 }
 window.addEventListener('keydown',function(e){
  if(!pop)return;
  if(e.key==='Escape'){
   e.preventDefault();e.stopImmediatePropagation();
   // Belt AND braces: stopImmediatePropagation should be enough, but this
   // Escape must NEVER reach the card's own handler — there it would close
   // the whole workspace instead of the popout the user was looking at.
   e.__ostHandled=true;
   closePop();return;
  }
  // While a popout is up it owns the keyboard: neither the card beneath nor
  // the deck should act on a key aimed at this list.
  e.stopPropagation();
  /* Sliders (SOS size, photo FOV) carry their own arrow/Home/End handling on
     _ostKey. The card's listener stands down while a popout is open, so this
     one has to do it or every slider inside a popout is keyboard-dead — and
     since 2026-09-21 EVERY slider is inside one. */
  const handled=()=>{e.preventDefault();e.stopImmediatePropagation();e.__ostHandled=true;};
  if(e.key==='Tab'){
   const nodes=Array.from(pop.querySelectorAll('button,input,select,textarea,[tabindex]')).filter(n=>!n.disabled&&!n.hidden&&n.getAttribute('tabindex')!=='-1');
   const index=nodes.indexOf(document.activeElement);handled();
   if(nodes.length)nodes[(index+(e.shiftKey?nodes.length-1:1))%nodes.length].focus();
   return;
  }
  if(e.target&&e.target._ostKey&&e.target._ostKey(e)){handled();return;}
  if(e.key==='Enter'&&e.target&&e.target._ostEnter){handled();e.target._ostEnter();return;}
  if((e.key==='Enter'||e.key===' ')&&e.target&&e.target.tagName==='BUTTON'){handled();e.target.click();}
 },true);
 function canAct(){return !!snapshot.inScene;}
 function act(name,extra){if(!canAct())return;request(name,extra,j=>{message(j.msg);refresh();});}
 function refresh(after){request('state',{},j=>{
  /* canSwap joined this set 2026-09-21: the Live segment draws Swap roles from
   it, so without it the button stays stale when a participant joins or leaves
   and the scene gains (or loses) a second role. */
  const old=snapshot.signature, liveChanged=old!==j.signature||snapshot.auto!==j.auto||snapshot.speed!==j.speed||snapshot.canSwap!==j.canSwap;snapshot=j;
  if(old&&old!==j.signature){rows=[];token='';options=[];optionToken='';actorInfo={};actorPending=false;actorQuery++;lastExpression={};resetSize();lighting={};lightPending=false;lightQuery++;}
  if(window.AnimPane&&j.inScene)AnimPane.recordScene({sceneId:j.scene,name:j.sceneName,actorCount:j.actorCount});
  if(!(j.actors||[]).some(a=>a.formId===selected))selected=(j.actors&&j.actors[0]&&j.actors[0].formId)||0;
  const fk=(j.actors||[]).map(a=>a.formId).join(',');
  if(fk!==faceKey){faceKey=fk;if(window.FolPane&&FolPane.requestPortraitFaces)FolPane.requestPortraitFaces();}
  // Poll status without replacing a focused control or an input being edited.
  paintStatus();if(hosted&&!pop)scheduleFit();if(old!==j.signature||(!tab&&liveChanged))render();else if(tab==='align')paintAlignment();if(after)after();else if(tab==='room')getPrivacy(true);else if(tab==='lighting')getLighting();else if(tab==='expr'||tab==='people'){getActor();if(tab==='expr'&&!expressionsReady)getExpressions();}
 });}
 function poll(){clearTimeout(timer);if(!modal)return;if(!document.body.classList.contains('open')){close();return;}if(window.hdCapture)hdCapture('1');refresh();timer=setTimeout(poll,1800);}
 function close(){popBack='';closePop();sizeDrag=null;photoDrag=null;photoRepaint=false;clearTimeout(timer);for(const [id,p] of pending){if(!p.detached){clearTimeout(p.timer);pending.delete(id);}}pendingFavorite=false;
  // ⚠ Hosted, `modal` IS the tab's own <section> — removing it would delete
  // the host out of index.html and leave the Scene tab permanently blank
  // after the first time it was hidden. Empty it; never remove it.
  if(modal){
   if(hosted)modal.textContent='';
   else{modal.remove();if(window.hdCapture)hdCapture('0');}
  }
  modal=null;hosted=false;session++;if(previousFocus&&previousFocus.isConnected)previousFocus.focus();previousFocus=null;}
 /* SEGMENTS. One ordered list, used by both hosts, so the tab and the modal
    can never drift apart. Twelve divides by 2/3/4/6 — the grid stays flush at
    every width instead of leaving one chip dangling on its own row. */
 /* [id, label, icon]. The icon is EXPLICIT per segment — it used to come
    from btn()'s label->icon map, which only matched four of the twelve, so
    eight chips had no art and the ones that did were taller than the ones
    that didn't (Rober, 2026-09-21, with a screenshot: "all should have
    icons"). Every name below is an existing icon in the deck's own set;
    nothing new was drawn. */
 const SEGMENTS=[
  // [id, label, icon, what you find inside — one line, no marketing]
  ['people',  'Participants',       'sn-people',     'Undress, voices, SOS, mute'],
  ['cast',    'Add & remove',       'sn-cast',       'Bring someone in, or send them out'],
  ['align',   'Alignment',          'sn-align',          'Nudge positions — live, or paused'],
  ['move',    'Move scene',         'sn-move',           'Beds, chairs, the floor — and Hold & resume'],
  ['room',    'The room',           'sn-room',       'Clear everyone out, bring them back'],
  ['lighting','Lighting',           'sn-lighting',   'FaceLight, Quick Light, ReLight'],
  ['expr',    'Expressions',        'sn-expr',         'Expression events and previews'],
  ['camera',  'Camera & photos',    'sn-camera',      'Photo mode, FOV, captures'],
  ['ppa',     'PPA physics',        'sn-ppa',      'Procedural animation settings'],
  ['library', 'Favorites & recent', 'sn-library',         'Starred scenes, history, collections'],
  ['options', 'OStim settings',     'sn-options',  'Quick toggles and the live menu']
 ];
 /* The launcher is FOUR docks, not one ragged grid of eleven tiles (Rober,
    2026-09-22: "fill areas with containers or docks, try not to overuse
    cards"). Four equal columns; each dock is a titled container of full-width
    rows. Eleven does not divide by four, so the Library dock carries the
    animation search box as its third row — which is also where a scene
    search belongs, next to favourites and history, rather than in the header. */
 const DOCKS=[
  ['People',  'Who is in it, and how they stand', ['people','cast','align']],
  ['Place',   'Where it happens',                 ['move','room','lighting']],
  ['Look',    'Faces, camera, physics',           ['expr','camera','ppa']],
  ['Library', 'Scenes to pick from',              ['library','options']]
 ]; function reset(which,formId){
  privacy={};privacyBusy=false;privacySearch='';privacySerial++;
  session++;tab=which||'';snapshot={};rows=[];options=[];token='';search='';faceKey='';busy=false;
  actorInfo={};actorPending=false;actorQuery++;selected=Number(formId)||0;resetSize();
  lighting={};lightPending=false;lightQuery++;photoView='';cameraCurrent=null;
  here=null;herePending=false;castRows=[];castCast=[];castToken='';castBusy=false;
  wornInfo={};wornPending=false;wornQuery++;voiceActors=[];voicePending=false;
  sosInfo={};sosPending=false;ppa={};ppaPending=false;held=[];heldPending=false;holdState=null;holdPending=false;
  // ⚠ mcmPending too: a stale `true` here survives a remount and makes
  // getMcm() return early forever, so the switches never load again.
  mcmPending=false;mcmWhy='';mcmQuery='';
  /* close() clears the pending map, so an index request in flight loses its
     callback. Clear the FLAG too or it stays true forever and the index never
     loads again. `sceneIcons` itself is deliberately NOT reset: it is a
     once-per-session scan of ~8,000 files. */
  sceneIconsPending=false;
 }
 /* Build the card. `root` is the element the card is appended to and becomes
    the query scope; `backdrop` is true only for the floating modal. */
 function build(root,backdrop){
  const card=el('section','ost-card');
  if(backdrop){card.setAttribute('role','dialog');card.setAttribute('aria-modal','true');}
  card.setAttribute('aria-label','OStim scene workspace');
  const head=el('header','ost-head');const title=el('h2','',backdrop?'Scene controls':'OStim scene');
  head.append(title);
  // Hosted, the deck's own tab bar and Esc are the way out; a second Close
  // button inside the page would close the wrong thing.
  if(backdrop)head.append(btn('Close',close));
  /* Rober, 2026-09-22: "expand the search bar in top right to 2 bars, one
     for quick scene search and change, the other for the main command k
     searching and make them stretch in their area its so compact" — and
     "missing an end scene button as well, or just end in search top right".
     So: title, then the two bars filling everything between, then End. */
  const pair=el('div','ost-find-pair');pair.append(findBar(),sceneSearch());
  const endWrap=el('div','ost-head-end');
  let endArmed=false;
  const endBtn=btn('End scene',()=>{
   if(!canAct())return;
   if(!endArmed){endArmed=true;const t=endBtn.querySelector('span');if(t)t.textContent='Confirm end';setTimeout(()=>{endArmed=false;const u=endBtn.querySelector('span');if(u)u.textContent='End scene';},4000);return;}
   endArmed=false;act('stop');
  });
  endBtn.classList.add('ost-danger');endBtn.dataset.end='1';endWrap.append(endBtn);
  head.append(pair,endWrap);
  card.append(head);
  const tabs=el('nav','ost-tabs ost-docks');
  DOCKS.forEach(d=>{
   const dock=el('section','ost-dock');
   const dt=el('div','ost-dock-title');dt.append(el('strong','',d[0]),el('small','',d[1]));
   dock.append(dt);
   d[2].forEach(id=>{
    const a=SEGMENTS.find(sg=>sg[0]===id);if(!a)return;
    const b=el('button','ost-button ost-seg');b.type='button';
    const well=el('span','ost-seg-well');const i=el('img','ost-icon');i.src='icons/custom/'+a[2]+'.png';i.alt='';well.append(i);
    const t=el('span','ost-seg-text');t.append(el('span','ost-seg-label',a[1]),el('small','',a[3]||''));
    b.append(well,t);
    b.addEventListener('click',()=>switchTab(a[0]));
    b.dataset.tab=a[0];dock.append(b);
   });
   if(d[0]==='Library'){
    const b=el('button','ost-seg-extra');b.type='button';b.dataset.browse='1';
    const well=el('span','ost-seg-well');const i=el('img','ost-icon');i.src='icons/custom/sn-search.png';i.alt='';well.append(i);
    const t=el('span','ost-seg-text');t.append(el('span','ost-seg-label','Browse all scenes'),el('small','','OStim’s full animation browser'));
    b.append(well,t);b.addEventListener('click',()=>{closePop();if(window.OStimPane)OStimPane.smartLand();});dock.append(b);
   }
   tabs.append(dock);
  });
  /* ---- the quick strip: direct actions, and NOT ONE re-opener -----------
     The old Live scene grab-bag was mostly buttons that opened other
     segments; that is gone. These five each DO something on press. */
  const quick=el('div','ost-quick');
  quick.append(el('div','ost-dock-title ost-quick-title'));
  quick.querySelector('.ost-dock-title').append(el('strong','','Quick'),el('small','','One press, no popout'));
  const strip=el('div','ost-quick-strip');
  /* Same row anatomy as the docks — icon well, label, one line — so the
     page speaks one language rather than two. */
  const quickRow=(key,icon,label,detail,fn)=>{
   const b=el('button','ost-button ost-quick-row');b.type='button';b.dataset.quick=key;
   const well=el('span','ost-seg-well');const i=el('img','ost-icon');i.src='icons/custom/'+icon+'.png';i.alt='';well.append(i);
   const t=el('span','ost-seg-text');t.append(el('span','ost-seg-label',label),el('small','',detail));
   b.append(well,t);b.addEventListener('click',fn);return b;
  };
  strip.append(
   quickRow('swap','sn-swap','Swap roles','OStim’s own DOM / SUB switch',()=>{
    if(!canAct())return;
    if(typeof window.osSwap==='function'){osSwap('');message('Asked OStim to swap the roles.');refresh();}
    else message('Role swap needs the OStim panel.');
   }),
   quickRow('previous','sn-previous','Back to previous scene','The one before this',previous),
   quickRow('favorite','sn-favorite','Favorite current scene','Star it for the library',favoriteCurrent),
   quickRow('floor','sn-floor','Move to floor','Off the furniture, where you stand',()=>act('floor'))
  );
  quick.append(strip);
  /* ---- the hero -------------------------------------------------------
     This page is about a scene that is RUNNING, and until now it said so
     in one grey sentence while twelve identical lists did the talking
     (Rober, 2026-09-21: "its kinda boring ... visually its all just
     cards"). The hero is where the scene actually lives: who is in it, at
     what speed, on what. The cast strip lives HERE and nowhere else — the
     segments used to each paint their own copy, which is both duplication
     and the reason every segment looked the same. */
  /* The hero is TWO bands, not one three-column row (Rober, 2026-09-22:
     "Free camera and manual buttons kinda ugly ... just visually the UI is
     bad"). The old layout hung the live controls off the bottom of the
     middle column, which left a lake of dead space beside them and made
     each one a differently-sized orphan pill. Now: a top band that is
     cast / scene / picture, and a DOCK underneath whose cells are equal
     width and flush edge to edge — his standing order-and-symmetry rule. */
  const hero=el('section','ost-hero');
  const top=el('div','ost-hero-top');
  const cast=el('div','ost-hero-cast');
  const meta=el('div','ost-hero-meta');
  const heroArt=el('div','ost-hero-art');
  const heroTitle=el('h3','ost-hero-title');
  const chips=el('div','ost-hero-chips');
  meta.append(heroTitle,chips);
  top.append(cast,meta,heroArt);
  const cap=t=>el('span','ost-dock-cap',t);
  const speed=el('div','ost-hero-speed ost-dock-cell');speed.append(cap('Speed'));
  const bars=el('div','ost-speed-bars');
  const speedCtl=el('div','ost-speed-ctl');
  speedCtl.append(control('−','speed',{delta:'-'}),el('span','ost-speed-read'),control('+','speed',{delta:'+'}));
  speed.append(bars,speedCtl);
  const mode=el('div','ost-hero-mode ost-dock-cell');
  /* Rober, 2026-09-22: "needs a quick TFC button as well". Free camera is
     the one thing you reach for constantly mid-scene, so it is a dock cell
     rather than a popout. It runs the deck's own play-proven console verb
     and closes the deck first — free camera behind a paused menu is useless. */
  const cam=el('div','ost-hero-cam ost-dock-cell');
  cam.append(cap('Camera'),btn('Free camera',freeCamera));
  /* Stop belongs with the other LIVE controls, not buried inside a grab-bag
     segment. It keeps its two-press arm so the resting page cannot fire it
     by accident. */
  const holdCell=el('div','ost-hero-hold ost-dock-cell');
  holdCell.append(cap('Scene'),btn('Hold this scene',()=>holdAct('hold')));
  const dock=el('div','ost-hero-dock');
  dock.append(speed,mode,cam,holdCell);
  hero.append(top,dock);
  const status=el('p','ost-status');status.id='ost-scene-status';
  note=el('p','ost-note',backdrop?'The scene continues while these controls are open.':'The scene keeps running while you use this page.');
  note.setAttribute('role','status');
  /* The page keeps the hero and the launcher grid, and nothing else: every
     segment opens as a popout instead of rendering here (Rober, 2026-09-21:
     "every button should be a popout modal, not below"). pageBody stays in
     the DOM as the resting render target so `body` is never null. */
  pageBody=el('div','ost-body ost-body-idle');body=pageBody;
  /* Two columns, not a tall stack (Rober, 2026-09-22: "try to make best use
     of space, not too much scrolling"). The LIVE column — hero, then the
     Quick dock — and beside it the four docks in a 2x2. The deck is wide and
     the page was using none of that width; now it fits one screen. */
  /* ONE column, full width, top to bottom: hero, docks, quick. The
     two-column version starved the hero (in-game its title wrapped one
     letter per line) and the card did not scroll. The page scrolls now. */
  const page=el('div','ost-page');
  page.append(hero,tabs,quick);
  card.append(status,page,note,pageBody);root.append(card);
  return head;
 }
 function start(){
  if(window.AnimPane)AnimPane.ensureSceneFavorites();
  getPositionChoices(false);
  if(sceneIcons===null)getSceneIcons(false);   // once per session
  render();
  refresh(()=>{ if(tab)switchTab(tab); });   // '' = just land on the launcher
  timer=setTimeout(poll,1800);
 }
 // Start a scene from a named NPC. Everything is a draft until Start.
 function startFor(subject){
  close();session++;tab='setup';previousFocus=document.activeElement;
  modal=el('div','ost-back');modal.id='ostim-tools-modal';
  const shell=el('section','ost-start');shell.setAttribute('role','dialog');shell.setAttribute('aria-modal','true');
  shell.setAttribute('aria-labelledby','ost-start-title');
  const head=el('header','ost-start-head'),title=el('h2','','Start a scene');title.id='ost-start-title';
  head.append(title,btn('Close ×',close));body=el('div','ost-start-body');note=el('p','ost-start-note');note.setAttribute('role','status');
  shell.append(head,body,note);modal.append(shell);document.body.append(modal);if(window.hdCapture)hdCapture('1');
  const draft={token:'',rows:[],actors:[],dominants:[],place:'floor',clothing:'settings',manual:false,furniture:0,furnitureToken:'',furnitureRows:[],loading:false,scanning:false,starting:false};
  const subjectId=Number(subject.formId),stamp=session;
  function choice(label,value,selected,fn){const b=btn(label,fn);b.setAttribute('aria-pressed',String(selected===value));return b;}
  function paint(){
   if(session!==stamp||!modal)return;body.textContent='';
   body.append(el('p','ost-help','Choose participants and a place. OStim selects a compatible starting animation; use the Scene page to change it afterwards.'));
   const people=el('section','ost-start-people');people.append(el('h3','','1 · Participants'));
   const selected=el('div','ost-start-selected');
   draft.actors.forEach(id=>{
    const actor=draft.rows.find(r=>r.formId===id);if(!actor)return;
    const row=el('div','ost-start-person');row.append(el('strong','',actor.name));
    row.append(choice('Dominant',true,draft.dominants.includes(id),()=>{draft.dominants=draft.dominants.includes(id)?draft.dominants.filter(x=>x!==id):draft.dominants.concat(id);paint();}));
    const remove=btn('Remove',()=>{draft.actors=draft.actors.filter(x=>x!==id);draft.dominants=draft.dominants.filter(x=>x!==id);resetFurniture();paint();});remove.disabled=id===subjectId;row.append(remove);selected.append(row);
   });people.append(selected,el('p','ost-help','Leave all roles unset for OStim defaults. With a dominant selected, the remaining participants are submissive. Up to eight participants; installed animations determine compatibility.'));
   const list=el('div','ost-start-candidates');
   popList(list,'Search nearby participants…',()=>draft.rows.filter(r=>!draft.actors.includes(r.formId)).map(r=>({label:r.name,actor:r})),r=>{const b=btn('Add '+r.label,()=>{draft.actors.push(r.actor.formId);resetFurniture();paint();});b.disabled=draft.actors.length>=8;return b;});
   people.append(list,btn(draft.loading?'Reading nearby…':'Refresh nearby participants',load));body.append(people);
   const place=el('section','ost-start-place');place.append(el('h3','','2 · Place'));
   const choices=el('div','ost-toolbar');[['floor','Floor · no furniture'],['auto','Let OStim choose'],['furniture','Choose furniture']].forEach(([v,l])=>choices.append(choice(l,v,draft.place,()=>{draft.place=v;paint();})));place.append(choices);
   if(draft.place==='furniture'){
    const scan=btn(draft.scanning?'Finding compatible furniture…':'Find compatible furniture',()=>{
     draft.scanning=true;paint();request('setupFurniture',{token:draft.token,actors:draft.actors,radius:60,floors:true},j=>{
      draft.scanning=false;draft.furnitureRows=j.ok?j.rows:[];draft.furnitureToken=j.token||'';draft.furniture=0;message(j.msg);paint();
     });
    });scan.disabled=draft.scanning||!draft.token||!draft.actors.length;place.append(scan);
    popList(place,'Search compatible furniture…',()=>draft.furnitureRows.map(r=>({label:r.name+' · '+r.type+' · '+r.feet+' ft',item:r})),r=>choice(r.label,r.item.formId,draft.furniture,()=>{draft.furniture=r.item.formId;paint();}));
    place.append(el('p','ost-help','OStim returns the nearest available object of each compatible furniture type, within 60 ft.'));
   }
   body.append(place);
   const settings=el('section','ost-start-settings');settings.append(el('h3','','3 · Clothing & control'));
   const clothes=el('div','ost-toolbar');[['settings','Use OStim settings'],['keep','Keep clothing'],['remove','Undress at start']].forEach(([v,l])=>clothes.append(choice(l,v,draft.clothing,()=>{draft.clothing=v;paint();})));settings.append(clothes,choice('Manual scene navigation',true,draft.manual,()=>{draft.manual=!draft.manual;paint();}));body.append(settings);
   const review=el('section','ost-start-review');review.append(el('h3','','Ready when you are'),el('p','',draft.actors.map(id=>(draft.rows.find(r=>r.formId===id)||{}).name).join(' + ')+' · '+(draft.place==='floor'?'Floor':draft.place==='auto'?'OStim chooses furniture':(draft.furnitureRows.find(r=>r.formId===draft.furniture)||{}).name||'Choose furniture')));
   const go=btn(draft.starting?'Starting…':'Start scene',()=>{
    draft.starting=true;paint();request('setupStart',{token:draft.token,actors:draft.actors,dominants:draft.dominants,place:draft.place,clothing:draft.clothing,manual:draft.manual,furniture:draft.furniture,furnitureToken:draft.furnitureToken},j=>{
     draft.starting=false;message(j.msg);if(j.ok&&j.started)close();else paint();
    });
   });go.disabled=draft.starting||draft.loading||!draft.token||!draft.actors.includes(subjectId)||(draft.place==='furniture'&&!draft.furniture);review.append(go);body.append(review);
   if(draft.starting)body.querySelectorAll('button,input').forEach(b=>b.disabled=true);
  }
  function resetFurniture(){draft.furniture=0;draft.furnitureToken='';draft.furnitureRows=[];}
  function load(){
   if(draft.loading||draft.starting)return;draft.loading=true;paint();
   request('setupRoster',{},j=>{
    draft.loading=false;draft.token=j.ok?j.token:'';draft.rows=j.ok?j.rows:[];
    draft.actors=draft.rows.filter(r=>r.player||r.formId===subjectId).map(r=>r.formId);draft.dominants=[];resetFurniture();
    message(j.ok&&!draft.actors.includes(subjectId)?subject.name+' must be nearby, alive and outside another scene. Bring them here, then refresh.':j.msg||'');paint();
   });
  }
  // Timeout is reported without allowing an uncertain start to be sent twice.
  shell._setupTimeout=function(act){if(act==='setupRoster')draft.loading=false;if(act==='setupFurniture')draft.scanning=false;paint();};
  paint();load();head.querySelector('button').focus();
 }
 function open(which,formId){
  if(window.NpcScene)NpcScene.close();close();reset(which,formId);previousFocus=document.activeElement;
  modal=el('div','ost-back');modal.id='ostim-tools-modal';
  const head=build(modal,true);document.body.append(modal);
  modal.addEventListener('click',e=>{if(e.target===modal&&!photoDragReleased)close();});
  if(window.hdCapture)hdCapture('1');
  start();
  head.querySelector('button').focus();
 }
 /* Land on the Scene TAB, with a participant already selected. This is what
    the NPC card's old "Scene controls" popout now does — its contents live
    on the page (Rober, 2026-09-21: "integrate this popout into the main
    page"), so the card hands over instead of opening a rival surface. */
 function showOnTab(segment,formId){
  if(formId)selected=Number(formId)>>>0;
  if(window.ScenePane&&typeof window.hdShowTab==='function'&&
     !(window.__hdFlagAbsent&&window.__hdFlagAbsent('ostim'))){
   ScenePane.show(segment||'');hdShowTab('scene');return true;
  }
  open(segment,formId);   // no Scene tab (OStim absent): the floating card
  return false;
 }
 /* The Scene TAB's mount. The pane owns show/hide, so this never touches
    hdCapture (the palette already holds it) and never steals focus. */
 function mount(host,which,formId){
  if(!host)return;
  if(window.NpcScene)NpcScene.close();
  close();reset(which,formId);hosted=true;previousFocus=null;
  host.textContent='';modal=host;build(host,false);
  start();
 }
 /* Open a segment. It is a POPOUT, so the page behind it never reflows and
    the segment gets far more room than the panel could give it. */
 function openSegment(t){
  const seg=SEGMENTS.filter(a=>a[0]===t)[0];
  popout(seg?seg[1]:'Scene',seg?(seg[3]||''):'',host=>{
   body=host;            // render() writes here until the popout closes
   render();
  },'',seg?seg[2]:'');
 }
 function switchTab(t){tab=t;search='';
  if(pop&&body&&body.className==='ost-pop-body'){
   // Already in a popout: swap its contents rather than stacking a second one.
   const head=pop.querySelector('.ost-pop-head h2');
   const seg=SEGMENTS.filter(a=>a[0]===t)[0];
   if(head&&seg)head.textContent=seg[1];
   render();
  }else openSegment(t);
  paintNav();
  if(t==='move'){getHere();scan();getHoldState(true);}
  if(t==='options'){getOptions();if(!mcmPages.length)getMcm();}
  if(t==='expr'){getExpressions();getActor();}
  if(t==='people'){getActor();getWorn();getVoices();getSos();}
  if(t==='lighting')getLighting();
  if(t==='camera'){getCamera();getPhotos();}
  if(t==='cast')getRoster();
  if(t==='room'){getHeld();getPrivacy();}
  if(t==='ppa')getPpa();
 }
 /* Which chip reads as current. The nav is in the PAGE and a popout floats
    over it, so this has to keep working while `body` points elsewhere. */
 function paintNav(){
  if(!modal)return;
  modal.querySelectorAll('[data-tab]').forEach(b=>
   b.setAttribute('aria-pressed',String(!!pop&&b.dataset.tab===tab)));
 }
 function paintStatus(){
  if(!modal)return;
  // The one-line status stays: it is what a screen reader announces, and it
  // is what the harness reads. The hero below is the same facts, seen.
  modal.querySelector('#ost-scene-status').textContent=snapshot.inScene?(snapshot.sceneName||snapshot.scene)+' · Speed '+snapshot.speed+' / '+snapshot.maxSpeed+' · '+(snapshot.auto?'Auto':'Manual'):'No player scene running';
  paintHero();
 }
 let castKey='';
 /* A face render that lands AFTER the cast strip was built must replace the
    initial it is standing in for. The strip is deliberately only rebuilt when
    the cast CHANGES (so a 1.8s poll cannot steal focus from a portrait), which
    means a new portrait would otherwise never appear — the Household-tab bug
    exactly: "asking is not collecting", and collecting is not painting either.
    Clearing castKey forces the rebuild; it is cheap and only happens when a
    render actually arrived. The Scene tab is already a registered consumer in
    followers-pane's faceConsumerActive(), via OstimTools.isOpen(). */
 function repaintPortraits(){
  if(!modal)return;
  castKey='';
  paintHero();
  if(tab==='align'||tab==='expr'||tab==='people'||tab==='lighting'||tab==='room')render();
  paintFaces();
 }
 function paintHero(){
  const hero=modal&&modal.querySelector('.ost-hero');if(!hero)return;
  const live=!!snapshot.inScene;
  hero.dataset.live=String(live);
  hero.querySelector('.ost-hero-title').textContent=live?(snapshot.sceneName||snapshot.scene||'Scene'):'No player scene running';
  // What the scene actually IS, as a picture. Nothing when no keyword
  // matched — the hero simply loses the column rather than guessing.
  const art=hero.querySelector('.ost-hero-art');art.textContent='';
  const glyph=live?positionArt(snapshot.sceneName,snapshot.scene,'ost-pos ost-pos-hero'):null;
  art.dataset.has=String(!!glyph);
  if(glyph){glyph.alt=(snapshot.sceneName||'Current scene');art.append(glyph);}
  // Chips: facts about THIS scene, and nothing invented. A scene with no
  // furniture type says nothing rather than guessing "floor".
  const chips=hero.querySelector('.ost-hero-chips');chips.textContent='';
  if(!live){
   const hint=el('span','ost-chip ost-chip-hint');hint.append(el('span','','Start a scene through OStim, or pick one under Favorites & recent'));chips.append(hint);
  }
  if(live){
   const add=(t,kind)=>{const c=el('span','ost-chip');if(kind==='furn'){const i=el('img','ost-icon ost-chip-icon');i.src='icons/custom/sn-move.png';i.alt='';c.append(i);}c.append(el('span','',t));if(kind)c.dataset.kind=kind;chips.append(c);};
   add((snapshot.actorCount||(snapshot.actors||[]).length)+' in the scene');
   if(snapshot.furnitureType&&snapshot.furnitureType!=='none')add(snapshot.furnitureType,'furn');
   if(here&&here.name)add(here.name,'furn');
  }
  // Speed meter — one bar per step OStim actually offers.
  const bars=hero.querySelector('.ost-speed-bars');
  const max=Math.max(0,Math.min(12,Number(snapshot.maxSpeed)||0));
  if(bars.children.length!==max){bars.textContent='';for(let i=0;i<max;i++)bars.append(el('span','ost-speed-bar'));}
  const cur=Number(snapshot.speed)||0;
  Array.from(bars.children).forEach((b,i)=>b.dataset.on=String(live&&i<cur));
  const read=hero.querySelector('.ost-speed-read');
  if(read)read.textContent=live&&max?cur+' / '+max:'—';
  hero.querySelectorAll('.ost-speed-ctl button').forEach(b=>{b.disabled=!live;});
  const holdHost=hero.querySelector('.ost-hero-hold');
  if(holdHost)holdHost.querySelectorAll('button').forEach(b=>{b.disabled=!live||holdPending;});
  const endB=modal.querySelector('[data-end="1"]');if(endB)endB.disabled=!live;
  // Auto / Manual as a two-state control, not a word in a sentence.
  const mode=hero.querySelector('.ost-hero-mode');mode.textContent='';mode.append(el('span','ost-dock-cap','Pacing'));
  if(live){
   const t=btn(snapshot.auto?'Auto':'Manual',()=>act('auto'),'ost-mode');
   t.dataset.on=String(!!snapshot.auto);
   t.setAttribute('aria-label','Scene pacing: '+(snapshot.auto?'automatic':'manual')+' — click to switch');
   mode.append(t);
  }
  // The cast. Rebuilt only when it CHANGES, so a 1.8s poll cannot steal
  // focus from a portrait you just tabbed to.
  const castHost=hero.querySelector('.ost-hero-cast');
  const key=(snapshot.actors||[]).map(a=>a.formId).join(',');
  if(key!==castKey){castKey=key;castHost.textContent='';castHost.append(participants());paintFaces();}
  castHost.querySelectorAll('.ost-person').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.ref)===selected)));
 }
 function primary(label,fn){const b=btn(label,fn);b.dataset.primary='1';return b;}
 /* ---- the component vocabulary (2026-09-22) -----------------------------
    Rober: "spend some real time on this, all the buttons, modal popouts, UX
    improvements". Every popout used to be a toolbar of loose pills over a
    list of slabs. These four are the instruments the popouts are built from
    now, so a chooser looks like a chooser everywhere, a stepper like a
    stepper, and a person switcher like the one in the hero. */
 // N positions, one instrument.  items: [label, isOn, onPick, extraAttrs?]
 function segmented(items,label){
  const g=el('div','ost-segmented');g.setAttribute('role','group');if(label)g.setAttribute('aria-label',label);
  items.forEach(it=>{const b=btn(it[0],it[2]);b.setAttribute('aria-pressed',String(!!it[1]));if(it[3])Object.keys(it[3]).forEach(k=>{b.dataset[k]=it[3][k];});g.append(b);});
  return g;
 }
 // Sub-navigation inside a popout: equal cells across the full width.
 function subTabs(items,active,fn){
  const g=el('div','ost-subtabs');g.setAttribute('role','tablist');
  items.forEach(it=>{const b=el('button','ost-subtab');b.type='button';b.setAttribute('role','tab');b.setAttribute('aria-selected',String(it[0]===active));b.dataset.sub=it[0];
   if(it[2]){const i=el('img','ost-icon');i.src='icons/custom/'+it[2]+'.png';i.alt='';b.append(i);}
   b.append(el('span','',it[1]));b.addEventListener('click',()=>fn(it[0]));g.append(b);});
  return g;
 }
 // − value + as ONE instrument, with an optional reset beside it.
 function stepper(valueEl,dec,inc,reset){
  const w=el('div','ost-stepper');const d=btn('−',dec);d.setAttribute('aria-label','Less');const i=btn('+',inc);i.setAttribute('aria-label','More');
  w.append(d,valueEl,i);if(reset){const r=btn('Reset',reset);r.classList.add('ost-stepper-reset');w.append(r);}return w;
 }
 // A setting row: label + one line on the left, the control on the right.
 function settingRow(label,detail,control){
  const r=el('div','ost-setting');const t=el('div','ost-setting-text');t.append(el('strong','',label));if(detail)t.append(el('small','',detail));r.append(t,control);return r;
 }
 // The cast, as switchable tabs inside a popout — who am I editing?
 function personTabs(){
  const p=el('div','ost-persons');
  (snapshot.actors||[]).forEach(a=>{
   const b=btn('',()=>{selected=a.formId;resetSize();actorInfo={};actorPending=false;actorQuery++;wornInfo={};wornQuery++;sosInfo={};render();getActor();getWorn();getSos();},'ost-person ost-person-tab');
   b.dataset.ref=String(a.formId);b.append(picture(a),el('span','ost-person-name',a.name));b.setAttribute('aria-pressed',String(a.formId===selected));p.append(b);
  });
  return p;
 }
 let peopleTab='clothing';
 /* ---- fit the resting page to the screen, automatically -----------------
    Rober, 2026-09-22: "I DONT WANT TO HAVE TO SCROLL A TON, PLEASE JUST
    MAKE SURE THIS IS AUTOMIZED". The available height depends on
    --ui-scale, which no media query can see, so the page measures ITSELF
    after every render and tightens one step at a time until it fits:
      roomy   -> everything, as designed
      compact -> row descriptions gone, wells and paddings smaller
      dense   -> dock subtitles gone, quick rows to a line, hero art smaller
    Only the hosted page does this; popouts scroll inside themselves. */
 const DENSITY=['roomy','compact','dense'];
 function pickDensity(avail,needAt){
  /* pure: needAt(density) -> content height; returns the first that fits,
     else the densest. Split out so the harness can drive it with numbers. */
  for(let i=0;i<DENSITY.length;i++){if(needAt(DENSITY[i])<=avail)return DENSITY[i];}
  return DENSITY[DENSITY.length-1];
 }
 let fitTimer=0;
 function fitToViewport(){
  if(!modal||!hosted)return;
  const card=modal.querySelector('.ost-card');if(!card)return;
  const avail=card.clientHeight;
  if(!avail)return;                                     // not laid out yet
  const need=d=>{card.dataset.density=d;return card.scrollHeight;};
  card.dataset.density=pickDensity(avail,need);
 }
 function scheduleFit(){clearTimeout(fitTimer);fitTimer=setTimeout(fitToViewport,0);}
 window.addEventListener('resize',()=>{if(modal&&hosted)scheduleFit();});
 /* An empty list says so with a face, not a grey sentence: icon well, a
    short title, one line of what to do about it. busy=true is the loading
    face of the same thing. */
 function emptyState(icon,title,detail,busy){
  const e=el('div','ost-empty');if(busy)e.dataset.busy='1';
  const well=el('span','ost-seg-well ost-empty-well');const i=el('img','ost-icon');i.src='icons/custom/'+icon+'.png';i.alt='';well.append(i);
  const t=el('div','ost-empty-text');t.append(el('strong','',title));if(detail)t.append(el('p','ost-help',detail));
  e.append(well,t);return e;
 }
 const FURN_ICON=t=>{t=String(t||'').toLowerCase();return t.indexOf('bed')>=0?'sn-move':t.indexOf('chair')>=0||t.indexOf('bench')>=0||t.indexOf('stool')>=0||t.indexOf('throne')>=0?'sn-people':'sn-floor';};
 function control(label,name,extra){const b=btn(label,()=>act(name,extra));b.disabled=!canAct();return b;}
 const PLAYER_REF=0x14;   // PlayerRef; Follower Organizer has no row for him
 function picture(a){
  const f=el('span','ost-face',(a.name||'?').charAt(0));
  /* The player is not in the follower roster, so FolPane has no portrait for
     him and he used to sit on an initial while everyone else had a face.
     His photo lives on the Character tab (Rober, 2026-09-21). */
  if(a.formId===PLAYER_REF&&window.CharSheetPane&&CharSheetPane.playerPortrait){
   const me=CharSheetPane.playerPortrait();
   /* ⚠ It answers null until the CHARACTER tab has loaded its snapshot, and
      opening the Scene page never loaded it — so the player sat on an
      initial while everyone else had a face. Ask for the snapshot once;
      psData fires hd-charsheet-data and the cast strip repaints. */
   if((!me||!me.file)&&typeof window.psGet==='function'&&!charSheetAsked){
    charSheetAsked=true;try{psGet();}catch(e){}
   }
   if(me&&me.file){
    f.textContent='';
    const i=el('img');i.src=me.file;i.alt='';i.dataset.portrait=me.file;i.dataset.self='1';
    // The Character tab's own display crop, so he is framed as he is there.
    /* Route the crop through the ONE shared mapping (hd-facefit), exactly as
       the Character tab and the follower medallions do — a hand-rolled
       objectPosition here would frame him differently from every other
       surface that draws the same photo. */
    if(window.HDFaceFit&&HDFaceFit.applyCrop)HDFaceFit.applyCrop(i,me.crop,'');
    i.addEventListener('error',()=>{f.textContent=(a.name||'?').charAt(0);});
    f.append(i);return f;
   }
  }
  const p=window.FolPane&&FolPane.portraitInfoFor({name:a.name,formId:'0x'+a.formId.toString(16)});
  if(p){f.textContent='';const i=el('img');const src=p.abs?p.file:'portraits/'+p.file;i.src=src;i.alt='';i.dataset.portrait=src;i.addEventListener('error',()=>{f.textContent=(a.name||'?').charAt(0);});f.append(i);}return f;
 }
 function paintAlignment(){if(!modal)return;const a=(snapshot.actors||[]).find(x=>x.formId===selected);q('[data-axis]').forEach(n=>{const v=a&&a.alignment&&a.alignment[n.dataset.axis];n.textContent=Number.isFinite(v)?v.toFixed(1)+(n.dataset.axis==='rotation'?'°':''):'—';});}
 function paintFaces(){if(!window.HDFaceFit||!modal)return;q('.ost-face img').forEach(i=>{const s=i.dataset.portrait;
  /* The player's photo carries the CHARACTER TAB's own display crop. It
     was being re-cropped by paintPortrait() as if it were a follower
     portrait, which threw that crop away. Re-apply the player's saved crop. */
  if(i.dataset.self==='1'){const me=window.CharSheetPane&&CharSheetPane.playerPortrait&&CharSheetPane.playerPortrait();if(me&&HDFaceFit.applyCrop)HDFaceFit.applyCrop(i,me.crop,'');return;}
  if(s.indexOf('icons/npcs/')!==-1)HDFaceFit.ensure(i,s);else if(s.indexOf('icons/mounts/')!==-1)i.style.objectFit='contain';else HDFaceFit.paintPortrait(i,s);});}
 /* The cast strip. ONE instance, in the hero — every segment used to paint
    its own copy, which is why they all looked alike. Clicking a portrait
    now SELECTS and stays put; it used to throw you from Live into
    Alignment, which is not what picking someone means. */
 function participants(){
  /* Rober, 2026-09-22 (screenshot): "these icons could be ordered better
     with nice spacing, outlining and room for more npcs if scene has
     multiples". A grid of EQUAL cells — one column per participant up to
     six, then rows of four — every cell outlined, the selected one gold,
     each portrait badged with its position in the scene (1 = OStim's lead;
     it is what "Swap roles" reverses). Names get two lines, not an ellipsis. */
  const p=el('div','ost-people');
  const list=snapshot.actors||[];
  p.dataset.count=String(list.length);
  list.forEach((a,i)=>{
   const b=btn('',()=>{
    selected=a.formId;resetSize();actorInfo={};actorPending=false;actorQuery++;
    wornInfo={};wornQuery++;sosInfo={};
    // Only move if the segment you are on has nothing to do with a person.
    if(!tab||['move','room','ppa','library','options','lighting','camera'].indexOf(tab)>=0)tab='people';
    render();
    if(tab==='expr'||tab==='people'){getActor();getWorn();getSos();}
   },'ost-person');
   b.dataset.ref=String(a.formId);b.dataset.pos=String(i+1);
   const pic=el('span','ost-person-pic');pic.append(picture(a),el('span','ost-person-idx',String(i+1)));
   b.append(pic,el('span','ost-person-name',a.name));
   b.title=(i===0?'Lead · ':'')+(a.name||'');
   b.setAttribute('aria-pressed',String(a.formId===selected));
   p.append(b);
  });
  return p;
 }
 function favoriteCurrent(){
  if(!canAct()||!window.AnimPane)return;const ok=AnimPane.toggleSceneFavorite({sceneId:snapshot.scene,name:snapshot.sceneName,actorCount:snapshot.actorCount});
  if(!ok){pendingFavorite=true;message('Favorites are still loading.');}else{message('Favorites updated.');render();}
 }
 /* Anything that STARTS or CHANGES a scene drops the whole deck, not just
    this card — Rober, 2026-09-21: "selecting an animation should close the
    screen". Hosted, close() only empties the tab; the palette itself has to
    be asked to go, or you pick a scene and then stare at a menu. */
 /* ---- the two search bars ---------------------------------------------
    Rober, 2026-09-22, twice: "its also missing a command k dedeicated
    seazrch bar on the page", and "add a quick scene bar as well that you
    type into and popups up your search for animations".

    They are two different searches and deliberately two fields, side by
    side as an equal pair:

      CONTROLS  every function on this page (the ACTIONS catalogue that
                Command-F already uses), landing you on the segment.
      SCENES    OStim's own animation search, which lives in OStimPane —
                this page owns no scene index of its own and must not grow
                one. Enter hands the query straight to that browser.  */
 let findRows=[],findSel=0;
 function findBar(){
  const one=el('div','ost-find');
  const ctl=el('input','ost-find-input');
  ctl.type='search';ctl.placeholder='Find a control…  Ctrl K';
  ctl.setAttribute('aria-label','Search the controls on this page');
  const drop=el('div','ost-find-drop');drop.hidden=true;
  ctl.addEventListener('input',()=>paintFind(ctl,drop));
  /* _ostKey / _ostEnter are the deck's own idiom for "this field handles its
     own keys" — both key paths already route through them, which an element
     listener does not. */
  ctl._ostKey=e=>{
   if(e.key==='Escape'){ctl.value='';paintFind(ctl,drop);e.__ostHandled=true;return true;}
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    if(!findRows.length)return false;
    findSel=(findSel+(e.key==='ArrowDown'?1:findRows.length-1))%findRows.length;
    paintFindSel(drop);return true;
   }
   return false;
  };
  ctl._ostEnter=()=>{
   if(!findRows[findSel])return;
   switchTab(findRows[findSel][1]);ctl.value='';paintFind(ctl,drop);
  };
  const mag=el('span','ost-find-mag');const mi=el('img','ost-icon');mi.src='icons/custom/sn-search.png';mi.alt='';mag.append(mi);
  one.append(mag,ctl,drop);
  return one;
 }
 /* The animation search lives in the Library dock, with favourites and
    history — where you are when you are choosing a scene. Enter hands the
    query to OStimPane's browser; this page owns no scene index of its own. */
 let sceneFindGroups=[],sceneFindFlat=[],sceneFindSel=-1,sceneFindTimer=0,sceneFindOpen={},sceneFindQuery='';
 function sceneSearch(){
  /* Rober, 2026-09-22: "the current animation search doesnt even owrk ...
     i hit enter and the entire thing closes." Then, once it searched: "if i
     hit enter should take me to full animation ostim picker page. Also the
     dropdown should condense similar animations into chevron that is
     clickable so not to have so many options in dropdown for phases of same
     aniamtion" and "on click of dropdown its also not changing animation at
     all". So: type → grouped results drop down ON the page (one row per
     animation, its phases behind a chevron); click a row → that scene plays
     and the deck closes so you watch it; Enter → the full Animations picker
     with this query typed in; arrows highlight, Enter on a highlight plays
     it. OStimPane does the searching and the navigating; this page paints. */
  const two=el('div','ost-dock-search');
  const mag=el('span','ost-find-mag');const mi=el('img','ost-icon');mi.src='icons/custom/sn-search.png';mi.alt='';mag.append(mi);
  const sc=el('input','ost-find-input ost-find-scene');
  sc.type='search';sc.placeholder='Change scene…  Enter opens the full picker';
  sc.setAttribute('aria-label','Search and change the animation');
  const drop=el('div','ost-find-drop ost-find-scene-drop');drop.hidden=true;
  const clear=()=>{sceneFindGroups=[];sceneFindFlat=[];sceneFindSel=-1;sceneFindOpen={};sceneFindQuery='';drop.hidden=true;drop.textContent='';};
  sc.addEventListener('input',()=>{
   clearTimeout(sceneFindTimer);
   const q=sc.value.trim();
   if(q.length<2){clear();return;}
   sceneFindTimer=setTimeout(()=>{
    if(!(window.OStimPane&&OStimPane.search)){paintSceneFind(sc,drop,null);return;}
    OStimPane.search(q,rows=>{if(sc.value.trim()!==q)return;sceneFindQuery=q;sceneFindOpen={};paintSceneFind(sc,drop,rows||[]);});
   },220);
  });
  sc._ostKey=e=>{
   if(e.key==='Escape'){sc.value='';clear();e.__ostHandled=true;return true;}
   if(!sceneFindFlat.length)return false;
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    const n=sceneFindFlat.length;
    sceneFindSel=sceneFindSel<0?(e.key==='ArrowDown'?0:n-1):(sceneFindSel+(e.key==='ArrowDown'?1:n-1))%n;
    paintSceneSel(drop);return true;
   }
   if(e.key==='ArrowRight'||e.key==='ArrowLeft'){
    const r=sceneFindFlat[sceneFindSel];if(!r||r.kind!=='group'||r.group.phases.length<2)return false;
    const open=!!sceneFindOpen[r.group.key];
    if(e.key==='ArrowRight'&&!open){sceneFindOpen[r.group.key]=true;paintSceneFind(sc,drop,null,true);return true;}
    if(e.key==='ArrowLeft'&&open){delete sceneFindOpen[r.group.key];paintSceneFind(sc,drop,null,true);return true;}
    return false;
   }
   return false;
  };
  sc._ostEnter=()=>{
   const q=String(sc.value||'').trim();
   const hi=sceneFindSel>=0?sceneFindFlat[sceneFindSel]:null;
   if(hi){playScene(hi.scene,sc,drop);return;}
   if(!q)return;
   /* Enter with nothing highlighted: the full picker, with this query typed in. */
   closePop();sc.value='';clear();
   if(window.OStimPane&&OStimPane.searchFor)OStimPane.searchFor(q);
   else if(window.OStimPane&&OStimPane.smartLand)OStimPane.smartLand();
  };
  two.append(mag,sc,drop);
  return two;
 }
 /* One row per animation: OStim ships "Anubs Adult Doggystyle 2" as
    AnubsAdultDoggy2-1 … -5, one scene per phase. Same name + same id stem
    (the trailing -N stripped) = one group, phases in numeric order. */
 function sceneStem(id){return String(id||'').toLowerCase().replace(/[-_ ]?\d+$/,'');}
 function scenePhase(id){const m=/(\d+)$/.exec(String(id||''));return m?Number(m[1]):0;}
 function groupScenes(rows){
  const groups=[],byKey={};
  (rows||[]).forEach(r=>{
   if(!r||!r.sceneId)return;
   const key=String(r.name||'').trim().toLowerCase()+' '+sceneStem(r.sceneId);
   let g=byKey[key];
   if(!g){g=byKey[key]={key:key,name:r.name||r.sceneId,stem:sceneStem(r.sceneId),phases:[]};groups.push(g);}
   g.phases.push(r);
  });
  groups.forEach(g=>{g.phases.sort((a,b)=>(scenePhase(a.sceneId)-scenePhase(b.sceneId))||String(a.sceneId).localeCompare(String(b.sceneId)));g.first=g.phases[0];});
  return groups;
 }
 let scenePlayTimer=0;
 function playScene(s,input,drop){
  if(!(window.OStimPane&&OStimPane.play)||!s)return;
  clearTimeout(scenePlayTimer);
  let settled=false;
  const done=j=>{
   if(settled)return;settled=true;clearTimeout(scenePlayTimer);
   if(j&&j.ok===false){message(j.msg||'OStim would not change to that scene');return;}
   message('▸ '+(s.name||s.sceneId));
   if(input)input.value='';
   if(drop){drop.hidden=true;drop.textContent='';}
   sceneFindGroups=[];sceneFindFlat=[];sceneFindSel=-1;sceneFindOpen={};
   /* Rober, 2026-09-21: "selecting an animation should close the screen" —
      you picked a scene to WATCH it. Same as Find / play in Favourites. */
   leaveDeck();
  };
  OStimPane.play(s,done);
  /* OStim answers on its own channel; if nothing comes back, assume it took. */
  scenePlayTimer=setTimeout(()=>done({ok:true}),1500);
 }
 function paintSceneSel(drop){
  Array.from(drop.querySelectorAll('[data-flat]')).forEach(b=>{b.dataset.on=String(Number(b.dataset.flat)===sceneFindSel);});
 }
 function paintSceneFind(input,drop,rows,keep){
  if(rows!==null&&!keep)sceneFindGroups=groupScenes(rows);
  drop.textContent='';sceneFindFlat=[];if(!keep)sceneFindSel=-1;
  if(rows===null&&!keep){sceneFindGroups=[];drop.append(el('p','ost-help','Scene search needs the OStim panel.'));drop.hidden=false;return;}
  const groups=sceneFindGroups.slice(0,8);
  if(!groups.length){drop.append(el('p','ost-help','No scene called “'+(sceneFindQuery||input.value.trim())+'” fits the current actors and furniture.'));drop.hidden=false;return;}
  groups.forEach(g=>{
   const multi=g.phases.length>1;
   const open=multi&&!!sceneFindOpen[g.key];
   const row=el('div','ost-find-group');row.dataset.open=String(open);
   const b=el('button','ost-find-row');b.type='button';b.dataset.scene=g.first.sceneId;b.dataset.flat=String(sceneFindFlat.length);
   sceneFindFlat.push({kind:'group',group:g,scene:g.first});
   const art=positionArt(g.name,g.first.sceneId,'ost-pos ost-pos-find');
   const t=el('span','ost-find-text');
   t.append(el('strong','',g.name),el('small','',multi?(g.phases.length+' phases · '+g.first.sceneId):g.first.sceneId));
   b.append(art||el('span','ost-pos ost-pos-find ost-pos-none'),t);
   b.addEventListener('click',()=>playScene(g.first,input,drop));
   row.append(b);
   if(multi){
    const chev=el('button','ost-find-chev');chev.type='button';
    chev.setAttribute('aria-label',(open?'Hide':'Show')+' the '+g.phases.length+' phases of '+g.name);chev.setAttribute('aria-expanded',String(open));
    chev.append(el('span','ost-find-chev-glyph','›'));
    chev.addEventListener('click',e=>{e.stopPropagation();if(open)delete sceneFindOpen[g.key];else sceneFindOpen[g.key]=true;paintSceneFind(input,drop,null,true);});
    row.append(chev);
   }
   drop.append(row);
   if(open){
    const list=el('div','ost-find-phases');
    g.phases.forEach((ph,i)=>{
     const pb=el('button','ost-find-row ost-find-phase');pb.type='button';pb.dataset.scene=ph.sceneId;pb.dataset.flat=String(sceneFindFlat.length);
     sceneFindFlat.push({kind:'phase',group:g,scene:ph});
     const pa=positionArt(ph.name,ph.sceneId,'ost-pos ost-pos-find');
     const pt=el('span','ost-find-text');pt.append(el('strong','','Phase '+(scenePhase(ph.sceneId)||(i+1))),el('small','',ph.sceneId));
     pb.append(pa||el('span','ost-pos ost-pos-find ost-pos-none'),pt);
     pb.addEventListener('click',()=>playScene(ph,input,drop));
     list.append(pb);
    });
    drop.append(list);
   }
  });
  drop.append(el('p','ost-find-foot','Click a scene to play it  ·  Enter opens the full picker  ·  › shows the phases'));
  paintSceneSel(drop);
  drop.hidden=false;
 }


 function scoreAction(a,q){
  const hay=(a[0]+' '+a[2]).toLowerCase();
  if(hay.indexOf(q)===-1)return -1;
  return a[0].toLowerCase().indexOf(q)===0?0:a[0].toLowerCase().indexOf(q)!==-1?1:2;
 }
 function paintFind(input,drop){
  const q=String(input.value||'').trim().toLowerCase();
  findSel=0;
  if(!q){findRows=[];drop.hidden=true;drop.textContent='';return;}
  findRows=ACTIONS.map(a=>[a,scoreAction(a,q)]).filter(r=>r[1]>=0)
   .sort((x,y)=>x[1]-y[1]).slice(0,8).map(r=>r[0]);
  drop.textContent='';
  if(!findRows.length){drop.append(el('p','ost-help','Nothing on this page matches “'+input.value+'”.'));drop.hidden=false;return;}
  findRows.forEach((a,i)=>{
   const seg=SEGMENTS.find(sgm=>sgm[0]===a[1]);
   const b=el('button','ost-find-row');b.type='button';
   const ic=el('img','ost-icon');ic.src='icons/custom/'+(seg?seg[2]:'seg-ostim')+'.png';ic.alt='';
   const t=el('span','ost-find-text');
   t.append(el('strong','',a[0]),el('small','',seg?seg[1]:a[1]));
   b.append(ic,t);b.dataset.on=String(i===findSel);
   b.addEventListener('click',()=>{switchTab(a[1]);input.value='';paintFind(input,drop);});
   drop.append(b);
  });
  drop.hidden=false;
 }
 function paintFindSel(drop){
  Array.from(drop.querySelectorAll('.ost-find-row')).forEach((b,i)=>{b.dataset.on=String(i===findSel);});
 }
 /* Ctrl-K from anywhere on the page puts the cursor in the control search. */
 function focusFind(){
  const i=(modal||document).querySelector('.ost-find-input');
  if(i){i.focus();if(i.select)i.select();return true;}
  return false;
 }
 function leaveDeck(){
  closePop();close();
  if(typeof window.requestClose==='function'){try{requestClose();}catch(e){}}
 }
 function previous(){const current=snapshot.scene;leaveDeck();if(window.OStimPane)OStimPane.previousScene(current);}
 /* `tfc` toggles Skyrim's free camera. One console line, through the same
    bridge the Omni's "run in the console" row uses — the deck implements no
    camera of its own. Press it again in-game (or use this button again) to
    come back. */
 function freeCamera(){
  leaveDeck();
  if(typeof window.hdConsoleTest==='function'){
   try{hdConsoleTest(JSON.stringify({command:'tfc',crosshair:false,name:'Free camera'}));}catch(e){}
  }
 }
 function searchBox(placeholder,fn){const input=el('input','ost-search');input.type='search';input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);input.value=search;input.addEventListener('input',()=>{search=input.value;fn();});input._ostEnter=()=>{const list=input.nextElementSibling;if(list){const top=list.querySelector('[data-primary]')||list.querySelector('button');if(top&&!top.disabled)top.click();}};return input;}
 function render(){
  if(!modal)return;
  if(!pop){paintStatus();paintNav();return;}   // launcher at rest: hero + chips
  if(!body)return;
  sizeDrag=null;photoDrag=null;photoRepaint=false;const y=body.scrollTop;body.textContent='';paintStatus();paintNav();
  if(tab==='move'){
   const tools=el('div','ost-toolbar');const scanButton=btn('Rescan furniture',scan);scanButton.disabled=busy;tools.append(scanButton);
   const reach=el('div','ost-segmented');reach.setAttribute('role','group');reach.setAttribute('aria-label','Search radius');
   [30,60,120,200].forEach(n=>{const b=btn(n+' ft',()=>{radius=n;scan();});b.setAttribute('aria-pressed',String(radius===n));reach.append(b);});
   const floors=el('div','ost-segmented');floors.setAttribute('role','group');floors.setAttribute('aria-label','Floors');
   [[false,'This floor'],[true,'Whole building']].forEach(v=>{const b=btn(v[1],()=>{allFloors=v[0];scan();});b.setAttribute('aria-pressed',String(allFloors===v[0]));floors.append(b);});
   tools.append(reach,floors);
   tools.append(control('Move to floor','floor'));body.append(tools,hereRow(),el('p','ost-help','OStim’s closest available choice per furniture TYPE — so one bed, one chair, and never the piece you are already on (your own scene has it reserved). That one is named above instead. Search by name or type.'));
   const list=el('div','ost-list');body.append(searchBox('Search furniture…',()=>paintFurniture(list)),list);paintFurniture(list);
   body.append(holdPanel());
  }else if(tab==='align'){
   const a=(snapshot.actors||[]).find(x=>x.formId===selected);
   body.append(personTabs());
   /* The live overlay is the thing you actually want; it goes first. */
   const live=primary('Adjust live, over the scene…',()=>request('alignOverlay',{},j=>{message(j.msg);}));
   live.disabled=!canAct();
   const lead=el('div','ost-strip');lead.append(live,segmented([[ 'Fine · 1',!coarse,()=>{coarse=false;render();}],['Coarse · 10',coarse,()=>{coarse=true;render();}]],'Step size'));
   body.append(lead);
   const grid=el('div','ost-settings');[['x','Left / right','Across the partner'],['y','Forward / back','Toward or away'],['z','Height','Up or down'],['rotation','Rotation','Degrees']].forEach(pair=>{
    const value=el('span','ost-value ost-stepper-value');value.dataset.axis=pair[0];
    const row=settingRow(pair[1],pair[2],stepper(value,()=>act('align',{formId:selected,axis:pair[0],delta:coarse?-10:-1}),()=>act('align',{formId:selected,axis:pair[0],delta:coarse?10:1})));
    row.classList.add('ost-adjust');row.querySelectorAll('.ost-stepper button').forEach(b=>{b.disabled=!canAct();});grid.append(row);});
   body.append(grid,control('Reset position & rotation','align',{formId:selected,axis:'reset'}));
   /* The live overlay (2026-09-21). THIS segment adjusts alignment with the
      game paused behind the palette — fine for a considered nudge, useless
      for judging how it looks. The overlay is the other half: it layers over
      the running scene and never pauses it. */
   body.append(el('p','ost-help','Uses OStim’s actor alignment. Reset leaves scale and other actor settings unchanged. “Adjust live” closes the deck and puts the overlay on top of the running scene. Every control there is clickable; the keys are W/S to pick an axis, A/D to nudge it, Q/E for the next person, F for fine steps, Esc to close. Not the arrows — those are OStim’s own scene navigation.'));
  }else if(tab==='options'){
   body.append(el('h3','','Quick toggles'),
     el('p','ost-help','OStim’s own MCM switches. Changes apply straight away and persist — this is the same setting you would flip in its menu.'));
   renderMcm(body);
   body.append(el('h3','','The live in-scene menu'),btn('Refresh / root settings',getOptions));
   const list=el('div','ost-list');
   body.append(searchBox('Search OStim settings…',()=>paintOptions(list)),list);
   paintOptions(list);
  }else if(tab==='expr')renderExpressions();else if(tab==='people')renderPeople();else if(tab==='camera')renderCamera();else if(tab==='lighting')renderLighting();else if(tab==='cast')renderCast();else if(tab==='room')renderRoom();else if(tab==='ppa')renderPpa();else if(tab==='library')renderLibrary();
  body.scrollTop=y;paintFaces();paintAlignment();
  if(hosted&&!pop)scheduleFit();
 }
 function scan(){if(!canAct()){message('Start a player scene to find compatible furniture.');return;}busy=true;rows=[];token='';render();message('Scanning OStim-compatible furniture…');request('scan',{radius:radius,floors:allFloors},j=>{busy=false;rows=j.rows||[];token=j.token||'';message(j.msg);if(tab==='move')render();});}
 function paintFurniture(list){list.textContent='';const q=search.toLowerCase();const shown=rows.filter(r=>(r.name+' '+r.type).toLowerCase().includes(q));shown.forEach(r=>{
  const row=el('div','ost-row');row.dataset.state='ok';
  const text=el('div','ost-row-text');
  text.append(el('strong','',r.name),el('small','',r.type));
  const well=el('span','ost-seg-well ost-row-well');const ic=el('img','ost-icon');ic.src='icons/custom/'+FURN_ICON(r.type)+'.png';ic.alt='';well.append(ic);
  row.append(well,text,el('span','ost-far',r.feet+' ft'),
             btn('Highlight',()=>act('highlight',{formId:r.formId,token:token})),
             primary('Move here',()=>act('move',{formId:r.formId,token:token})));
  list.append(row);});if(!shown.length)list.append(busy?emptyState('sn-move','Scanning for furniture…','OStim is checking what nearby pieces this scene can use.',true):emptyState('sn-move','Nothing usable in range','Try Rescan, a larger radius, or Whole building for the floor above.'));}
 /* ---- OStim's own MCM switches, as toggles -----------------------------
    Rober, 2026-09-21: "need toggles for quick (end seen after climax, yes,
    no, etc, male, female, etc)". Those live in OSexIntegrationMCM —
    EndOnPlayerOrgasm / EndOnMaleOrgasm / EndOnFemaleOrgasm / EndOnAllOrgasm
    and the role switches — and the deck already drives any SkyUI MCM, so
    this borrows that rather than inventing a second path.

    MOST USED floats to the top; everything else is below it, searchable.
    The groups are matched on the LABEL, so if OStim renames an option it
    simply falls out of the curated group instead of breaking. */
 const MCM_GROUPS=[
  ['When a scene ends',   ['orgasm','climax','end ']],
  ['Who leads',           ['dom','sub','role','aggress']],
  ['Undressing',          ['undress','redress','weapon','wig','strap']],
  ['Furniture & camera',  ['furniture','clutter','cam','first person','fade']],
  ['Auto mode',           ['auto mode','auto-mode','ai ','speed control']]
 ];
 function mcmRows(){
  const out=[];
  (mcmPages||[]).forEach(pg=>(pg.rows||[]).forEach(r=>{
   if(r&&r.type==='toggle')out.push(Object.assign({page:pg.name||''},r));
  }));
  return out;
 }
 function mcmGroupOf(r){
  const l=String(r.label||'').toLowerCase();
  for(let i=0;i<MCM_GROUPS.length;i++)
   if(MCM_GROUPS[i][1].some(w=>l.indexOf(w)!==-1))return MCM_GROUPS[i][0];
  return '';
 }
 function getMcm(){
  if(mcmPending)return;
  mcmPending=true;mcmWhy='';if(tab==='options')render();
  request('mcm',{op:'scan'},j=>{
   mcmPending=false;
   mcmPages=j.ok?(j.pages||[]):[];
   mcmWhy=j.ok?'':(j.why||'OStim’s MCM could not be read');
   if(tab==='options')render();
  });
 }
 function mcmToggle(r){
  if(mcmPending||!r.writable)return;
  mcmPending=true;render();
  request('mcm',{op:'set',what:'toggle',p:r.p,i:r.i},j=>{
   mcmPending=false;
   // The mod is free to clamp, refuse, or flip three other rows, so re-read
   // rather than assuming the write did what we asked.
   if(j.msg)message(j.msg);
   getMcm();
  });
 }
 function renderMcm(host){
  const rows=mcmRows();
  if(!rows.length){
   host.append(el('p','ost-help',mcmPending?'Reading OStim’s settings…'
     :(mcmWhy||'No switches found in OStim’s MCM.')),btn('Retry',getMcm));
   return;
  }
  const list=el('div','ost-list');
  const paint=()=>{
   list.textContent='';
   const qy=mcmQuery.toLowerCase();
   const shown=rows.filter(r=>String(r.label||'').toLowerCase().includes(qy));
   const order=MCM_GROUPS.map(g=>g[0]).concat(['']);
   order.forEach(g=>{
    const mine=shown.filter(r=>mcmGroupOf(r)===g);
    if(!mine.length)return;
    list.append(el('h3','ost-mcm-group',g||'Everything else'));
    const grid=el('div','ost-mcm-grid');
    mine.forEach(r=>{
     const b=el('button','ost-mcm');b.type='button';
     b.setAttribute('aria-pressed',String(!!r.value));
     b.dataset.on=String(!!r.value);
     b.append(el('span','ost-mcm-label',r.label||'Setting'),
              el('span','ost-mcm-state',r.value?'On':'Off'));
     b.disabled=mcmPending||!r.writable;
     if(!r.writable&&r.why)b.title=r.why;
     b.addEventListener('click',()=>mcmToggle(r));
     grid.append(b);
    });
    list.append(grid);
   });
   if(!list.children.length)list.append(el('p','ost-help','No switch matches that.'));
  };
  const input=el('input','ost-search');input.type='search';
  input.placeholder='Search OStim’s switches…';
  input.setAttribute('aria-label','Search OStim’s switches');
  input.value=mcmQuery;
  input.addEventListener('input',()=>{mcmQuery=input.value;paint();});
  input._ostEnter=()=>{const b=list.querySelector('button:not([disabled])');if(b)b.click();};
  host.append(input,list);paint();
 }
 /* ---- ReLight, natively ------------------------------------------------
    Rober, 2026-09-21: "open relight doesnt work, its doing a hotkey or
    something, lets build relight into a SkyManager menu."

    He was right about the cause: the old button fired the SKSE Menu
    Framework HOTKEY and hoped, because ReLight's UI is an SMF page.

    ⚠ And it was in the wrong place. ReLight is a WORLD lighting overhaul —
    it merges and repairs the game's own candles, sconces and lanterns. It
    does nothing for the lighting of a scene; that is Better FaceLight and
    Quick Light, which this segment already drives. The panel says so
    rather than leaving the old promise standing. */
 function getRelight(){
  if(rlPending)return;
  rlPending=true;
  request('relight',{op:'state'},j=>{rlPending=false;rl=j||{};repaintRelight();});
 }
 function rlApply(extra){
  if(rlPending)return;
  rlPending=true;repaintRelight();
  request('relight',extra,j=>{rlPending=false;rl=j||{};message(j&&j.msg);repaintRelight();});
 }
 function repaintRelight(){ if(pop&&pop.dataset.kind==='relight')openRelight(true); }
 function openRelight(reuse){
  const build=host=>{
   if(!rl.ok){
    host.append(el('p','ost-help',rlPending?'Reading ReLight’s configuration…'
      :(rl.msg||'ReLight is not in this load order.')),btn('Retry',getRelight));
    return;
   }
   host.append(el('p','ost-pop-prose','ReLight is a WORLD lighting overhaul — it merges and repairs the game’s own candles, sconces and lanterns. It does nothing to the lighting of a scene; that is Better FaceLight and Quick Light, above.'),
               el('p','ost-pop-prose','⚠ ReLight reads this file when the game starts and ships no reload key, so everything here applies on your NEXT LAUNCH.'));
   const list=el('div','ost-list');
   const paint=()=>{
    list.textContent='';
    const qy=rlQuery.toLowerCase();
    (rl.rows||[]).filter(r=>(r.label+' '+(r.detail||'')).toLowerCase().includes(qy)).forEach(r=>{
     const row=el('div','ost-row'),text=el('div','ost-row-text');
     text.append(el('strong','',r.label),el('small','',r.detail||r.key));
     row.append(text);
     if(r.type==='bool'){
      const b=btn(r.value?'On':'Off',()=>rlApply({op:'set',key:r.key,value:r.value?'false':'true'}));
      b.setAttribute('aria-pressed',String(!!r.value));b.dataset.primary='1';b.disabled=rlPending;
      row.append(b);
     }else{
      const st=Number(r.step)||1;
      row.append(el('span','ost-ppa-value',String(r.value)),
        Object.assign(btn('−',()=>rlApply({op:'set',key:r.key,value:String(Number(r.value)-st)})),{disabled:rlPending}),
        Object.assign(btn('+',()=>rlApply({op:'set',key:r.key,value:String(Number(r.value)+st)})),{disabled:rlPending}));
     }
     list.append(row);
    });
    if(!list.children.length)list.append(el('p','ost-help','No ReLight setting matches that.'));
   };
   const input=el('input','ost-search');input.type='search';
   input.placeholder='Search ReLight’s settings…';input.value=rlQuery;
   input.setAttribute('aria-label','Search ReLight’s settings');
   input.addEventListener('input',()=>{rlQuery=input.value;paint();});
   host.append(input,list);paint();

   /* The exclusion list is what ReLight's own in-game menu exists for — the
      section is literally named "[Refs Excluded Using in Game Menu]". */
   host.append(el('h3','','Lights ReLight leaves alone'));
   const add=primary('Exclude the light I’m looking at',()=>rlApply({op:'exclude'}));
   add.disabled=rlPending;
   host.append(add,el('p','ost-help','Put your crosshair on the light first. This writes the same list ReLight’s own menu writes.'));
   const ex=el('div','ost-list');
   (rl.excluded||[]).forEach(r=>{
    const row=el('div','ost-row');row.dataset.state='refused';
    const text=el('div','ost-row-text');
    text.append(el('strong','',r.label||r.id),el('small','',r.plugin||''));
    const back=btn('Let ReLight have it',()=>rlApply({op:'include',line:r.line}));
    back.disabled=rlPending;
    row.append(text,back);ex.append(row);
   });
   if(!(rl.excluded||[]).length)ex.append(el('p','ost-help','Nothing is excluded yet.'));
   host.append(ex);
  };
  if(reuse&&pop&&pop.dataset.kind==='relight'){
   const b=pop.querySelector('.ost-pop-body');
   if(b){b.textContent='';build(b);return;}
  }
  popout('ReLight','World lighting — candles, sconces, lanterns',build,'lighting');
  if(pop)pop.dataset.kind='relight';
  if(!rl.ok&&!rlPending)getRelight();
 }
 function getOptions(){if(!canAct()){message('Start a player scene to read live OStim settings.');return;}request('options',{},j=>{options=j.options||[];optionToken=j.token||'';message(j.ok?'OStim settings — changes apply to the running scene.':j.msg);if(tab==='options')render();});}
 function paintOptions(list){list.textContent='';const q=search.toLowerCase();options.filter(o=>(o.title+' '+o.detail).toLowerCase().includes(q)).forEach(o=>{const b=btn('',()=>request('option',{index:o.index,token:optionToken},j=>{if(j.exit){closePop();}else if(j.options){options=j.options;optionToken=j.token;render();}message(j.msg||'OStim option selected.');refresh();}),'ost-option');b.append(el('strong','',o.title),el('span','ost-help',o.detail),el('span','ost-chevron','›'));list.append(b);});if(!list.children.length)list.append(emptyState('sn-search','No settings match','Use Refresh / root settings to read the live menu again.'));}
 function renderLibrary(){
  const A=window.AnimPane;const data=A?A.sceneLibrary():{recent:[],collections:[]};const favs=A?Object.values(A.sceneFavorites()):[];
  /* Rober, 2026-09-22: "what is the point of the live scene button? I feel
     like other buttons do similar things, move them to correct areas". These
     three were in it and are about CHOOSING a scene, which is what this page
     is — so they live here now. The three that merely re-opened the Move
     segment are gone outright, and Stop/speed/pacing are in the hero dock. */
  const pick=el('div','ost-grid ost-grid-3');
  const star=btn((window.AnimPane&&AnimPane.sceneFavorites()[snapshot.scene]?'★ Saved':'☆ Favorite current scene'),favoriteCurrent);
  star.disabled=!canAct()||!window.AnimPane||!AnimPane.sceneFavoritesReady();
  pick.append(star,btn('Back to previous scene',previous),
    btn('Browse scenes',()=>{closePop();if(window.OStimPane)OStimPane.smartLand();}));
  body.append(pick);
  const tools=el('div','ost-toolbar');const which=el('div','ost-segmented');which.setAttribute('role','group');which.setAttribute('aria-label','Which list');
  ['Favorites','Recent'].forEach(name=>{const b=btn(name,()=>{collection=name;render();});b.setAttribute('aria-pressed',String((collection||'Favorites')===name));which.append(b);});tools.append(which);
  const picked=collection&&collection!=='Favorites'&&collection!=='Recent'?collection:'';
  const folders=btn('Collections'+(picked?' · '+picked:''),()=>popout('Collections',
    'Pick a collection to filter by, or go back to everything.',host=>{
     popList(host,'Search collections…',
      ()=>[{id:'',label:'All favorites'}].concat((data.collections||[]).map(n=>({id:n,label:n}))),
      r=>{const b=btn(r.label,()=>{collection=r.id;closePop();render();},'ost-option');
          if((collection||'')===r.id)b.dataset.primary='1';return b;});
    },'library'));
  tools.append(folders,btn('Position reference',positionReference),btn('Rescan scene icons',()=>getSceneIcons(true)));body.append(tools);
  const input=el('input','ost-search');input.placeholder='New collection name…';input.maxLength=60;input.setAttribute('aria-label','New collection name');
  const add=()=>{const name=input.value.trim();if(name&&A&&A.addSceneCollection(name)){collection=name;render();}};input._ostEnter=add;
  const mk=el('div','ost-setting ost-setting-input');const mt=el('div','ost-setting-text');mt.append(el('strong','','New collection'),el('small','','Group starred scenes by mood, place, or partner'));
  const mc=el('div','ost-setting-control');mc.append(input,btn('Create',add));mk.append(mt,mc);body.append(mk);
  const list=el('div','ost-list');const paint=()=>{
   list.textContent='';let source=collection==='Recent'?(data.recent||[]):favs;
   if(collection&&collection!=='Favorites'&&collection!=='Recent')source=source.filter(s=>(s.collections||[]).includes(collection));
   source.filter(s=>(s.name+' '+s.sceneId+' '+(s.pack||'')).toLowerCase().includes(search.toLowerCase())).forEach(s=>{
    const row=el('div','ost-row');const text=el('div','ost-row-text');text.append(el('strong','',s.name||s.sceneId),el('small','',[(s.actorCount||'?')+' participants',s.pack||'',s.furniture||''].filter(Boolean).join(' · ')));
    const art=positionArt(s.name,s.sceneId);
    row.append(art||el('span','ost-pos ost-pos-none'),btn(A.sceneFavorites()[s.sceneId]?'★':'☆',()=>{A.toggleSceneFavorite(s);render();}),primary('Find / play',()=>{leaveDeck();if(window.OStimPane)OStimPane.findScene(s);}));
    if(A.sceneFavorites()[s.sceneId])row.append(btn('Collections…',()=>popout('Collections · '+(s.name||s.sceneId),
      'Tick the collections this scene belongs to. It can be in several.',host=>{
       const repaint=popList(host,'Search collections…',
        ()=>(data.collections||[]).map(n=>({id:n,label:n})),
        (r,paint)=>{const on=(A.sceneFavorites()[s.sceneId].collections||[]).includes(r.id);
          const b=btn((on?'✓ ':'')+r.label,()=>{A.assignSceneCollection(s.sceneId,r.id);paint();render();},'ost-option');
          if(on)b.dataset.primary='1';return b;});
       if(!(data.collections||[]).length)host.append(el('p','ost-help','No collections yet — create one on the Favorites & recent page.'));
       return repaint;
      },'library')));
    list.append(row);
   });if(!list.children.length)list.append(emptyState('sn-library',collection==='Recent'?'Nothing recent yet':'No favorites yet','Star a scene while browsing, or use Favorite current scene above.'));
  };body.append(searchBox('Search favorites or recent scenes…',paint),list);paint();
 }
 function getLighting(){
  if(lightPending)return;const q=++lightQuery,sig=snapshot.signature;
  request('lightingState',{},j=>{if(q!==lightQuery||sig!==snapshot.signature||lightPending)return;lighting=j.ok?j:{};paintLighting();if(!j.ok)message(j.msg);});
 }
 function lightAction(op,extra){
  if(!canAct()||lightPending)return;lightPending=true;lightQuery++;const sig=snapshot.signature;paintLighting();
  request('lighting',Object.assign({op},extra||{}),j=>{if(sig!==snapshot.signature)return;lightPending=false;message(j.msg);if(j.faces)lighting=j;paintLighting();getLighting();});
 }
 function lightButton(label,op,extra){const b=btn(label,()=>lightAction(op,extra));b.dataset.lightOp=op;if(extra&&extra.formId)b.dataset.lightActor=String(extra.formId);return b;}
 function paintLighting(){
  if(!modal||tab!=='lighting')return;
  const face=fid=>(lighting.faces||[]).find(f=>f.formId===Number(fid));
  q('[data-light-status]').forEach(n=>{const f=face(n.dataset.lightStatus);n.textContent=!f?'Reading face light…':!f.present?'Better FaceLight unavailable':!f.ok?'Actor unavailable':f.lit?'Face light on':'Face light off';});
  const quick=lighting.quick;
  const status=q1('.ost-light-quick-status');if(status)status.textContent=!quick?'Reading Quick Light…':!quick.installed?'Quick Light unavailable':!quick.running?'Enable Quick Light in its MCM':quick.on?'Quick Light is on':'Quick Light is off';
  q('[data-light-op]').forEach(b=>{
   const op=b.dataset.lightOp,f=face(b.dataset.lightActor);
   const available=op==='restore'?lighting.undoCount>0:op.indexOf('quick')===0?quick&&quick.ok&&quick.installed&&quick.running&&!quick.pending:b.dataset.lightActor?f&&f.present&&f.ok:(lighting.faces||[]).some(f=>f.present&&f.ok);
   b.disabled=!canAct()||lightPending||!available;
  });
  const restore=q1('[data-light-op="restore"]');if(restore)restore.textContent='Restore faces'+(lighting.undoCount?' · '+lighting.undoCount:'');
  const editor=q1('.ost-light-editor');if(editor)editor.disabled=!canAct()||!lighting.relight||!lighting.editor;
  const reason=q1('.ost-light-editor-status');if(reason)reason.textContent=lighting.relight&&lighting.editor?'Opens the SKSE menu; choose ReLight to adjust lights.':'ReLight and SKSE Menu Framework must both be loaded to open the editor.';
 }
 function renderLighting(){
  body.append(el('h3','','Light the scene'),el('p','ost-help','Face-light changes restore when this scene ends. Restore faces undoes them sooner; use it before saving, because undo resets when loading a save.'));
  const presets=el('div','ost-grid ost-grid-4');presets.append(lightButton('Light all faces','on',{all:true}),lightButton('Darken all faces','off',{all:true}),lightButton('Refresh all faces','relight',{all:true}),lightButton('Restore faces','restore'));presets.querySelector('button').dataset.primary='1';body.append(presets);
  const list=el('div','ost-light-list');const paint=()=>{
   list.textContent='';const actors=(snapshot.actors||[]).filter(a=>(a.name||'').toLowerCase().includes(search.toLowerCase()));
   actors.forEach(a=>{const row=el('section','ost-light-row');const head=el('div','ost-light-person'),text=el('div');const status=el('p','ost-help');status.dataset.lightStatus=String(a.formId);text.append(el('strong','',a.name),status);head.append(picture(a),text);
    const actions=el('div','ost-toolbar');const pair=el('div','ost-segmented');pair.setAttribute('role','group');pair.setAttribute('aria-label','Face light');const on=lightButton('On','on',{formId:a.formId});on.dataset.primary='1';pair.append(on,lightButton('Off','off',{formId:a.formId}));actions.append(pair,lightButton('Refresh light','relight',{formId:a.formId}));row.append(head,actions);list.append(row);});
   if(!actors.length)list.append(el('p','ost-help',canAct()?'No participants match your search.':'Start a player scene to control its lighting.'));paintLighting();paintFaces();
  };body.append(searchBox('Search participants’ lights…',paint),list);
  const quick=el('section','ost-light-section');quick.append(el('h3','','Your carried light'),el('p','ost-help ost-light-quick-status'),el('p','ost-help','Quick Light uses your MCM brightness and source. This toggle stays as you set it after the scene.'));
  const buttons=el('div','ost-toolbar');const ql=el('div','ost-segmented');ql.setAttribute('role','group');ql.setAttribute('aria-label','Quick Light');ql.append(lightButton('Quick Light on','quickOn'),lightButton('Quick Light off','quickOff'));buttons.append(ql);quick.append(buttons);body.append(quick);
  /* WAS "Open ReLight editor", which fired the SKSE Menu Framework hotkey and
     promised a scene light editor ReLight has never been. It opens our own
     panel now, and says what ReLight actually does. */
  const advanced=el('section','ost-light-section');
  const editor=btn('ReLight — world lighting…',()=>openRelight(false));
  advanced.append(el('h3','','The world’s own lights'),
    el('p','ost-help','Separate from the scene: ReLight merges and repairs the game’s candles, sconces and lanterns. Nothing here changes how this scene is lit.'),
    editor);
  body.append(advanced);paint();
 }
 function getActor(){
  if(tab==='people')getSize();
  if(!canAct()||!selected||actorPending)return;const fid=selected,sig=snapshot.signature,q=++actorQuery;
  request('actorState',{formId:fid},j=>{if(selected!==fid||snapshot.signature!==sig||actorQuery!==q||actorPending)return;actorInfo=j.ok?j:{};paintActorStatus();if(!j.ok)message(j.msg);});
 }
 function actorAction(name,extra){
  if(!canAct()||!selected||actorPending)return;const fid=selected,sig=snapshot.signature;actorPending=true;actorQuery++;render();
  request(name,Object.assign({formId:fid},extra||{}),j=>{
   if(selected!==fid||snapshot.signature!==sig)return;actorPending=false;
   if(j.ok&&name==='expression'){lastExpression[fid]={event:j.event,until:j.preview?Date.now()+5000:0};}
   if(j.ok&&name==='expressionClear')delete lastExpression[fid];
   if(j.ok&&name==='mute')actorInfo=j;
   message(j.msg);render();getActor();
  });
 }
 function actorButton(label,name,extra){const b=btn(label,()=>actorAction(name,extra));b.disabled=!canAct()||!selected||actorPending;return b;}
 function paintActorStatus(){
  if(!modal)return;const audio=q1('[data-audio]'),override=q1('[data-expression-override]'),last=q1('[data-expression-last]');
  if(audio)audio.textContent=actorInfo.muted===true?'Muted':actorInfo.muted===false?'Voice enabled':'Audio status unavailable';
  if(override)override.textContent=actorInfo.expressionOverride===true?'An animation expression override is active.':actorInfo.expressionOverride===false?'No animation expression override reported.':'Expression override status unavailable.';
  if(last){const v=lastExpression[selected];last.textContent=v?(v.until&&Date.now()>=v.until?'Preview timer elapsed. Use Return to OStim if an expression remains.':'Last requested: '+v.event+(v.until?' · 5-second preview':'')):'OStim chooses expressions automatically.';}
 }
 function actorHeader(){const a=(snapshot.actors||[]).find(x=>x.formId===selected);body.append(el('h3','',a?'Selected: '+a.name:'Pick someone in the strip above.'));}
 function getExpressions(){request('expressions',{},j=>{expressionRows=j.expressions||[];expressionsReady=!!j.ready;if(tab==='expr')render();});}
 function renderExpressions(){
  const status=el('span','ost-help');status.dataset.expressionOverride='1';const last=el('span','ost-help');last.dataset.expressionLast='1';const readout=el('div','ost-expression-status');readout.append(status,last);body.append(readout);
  body.append(personTabs());
  const tools=el('div','ost-toolbar');tools.append(segmented([['All expressions',!expressionOnlyFav,()=>{expressionOnlyFav=false;render();}],['Favorite expressions',expressionOnlyFav,()=>{expressionOnlyFav=true;render();}]],'Which expressions'),actorButton('Return to OStim','expressionClear'));body.append(tools);
  const help=btn('How expressions work',()=>popout('How expressions work','',host=>{
   host.append(el('p','ost-pop-prose','These are the expression events installed in your load order. OStim picks a matching variant for each one — it is not a fixed face.'),
               el('p','ost-pop-prose','A scene event, or your expression settings, can take priority over anything you set here. That is OStim deciding, not the deck failing.'),
               el('p','ost-pop-prose','Preview plays the event and clears it again after five seconds. Apply event leaves it in place until OStim replaces it, or until you press Return to OStim.'));
  },'expr'));
  const list=el('div','ost-list');const paint=()=>{
   list.textContent='';const favorites=window.AnimPane?AnimPane.expressionFavorites():[];
   const shown=expressionRows.filter(r=>(!expressionOnlyFav||favorites.includes(r.event))&&r.event.toLowerCase().includes(search.toLowerCase()));
   shown.forEach(r=>{const row=el('div','ost-row'),text=el('div','ost-row-text');text.append(el('strong','',r.event),el('small','',r.variants+' installed definition'+(r.variants===1?'':'s')));
    const star=btn(favorites.includes(r.event)?'★':'☆',()=>{if(window.AnimPane)AnimPane.toggleExpressionFavorite(r.event);},'ost-button ost-star');star.setAttribute('aria-pressed',String(favorites.includes(r.event)));star.setAttribute('aria-label',(favorites.includes(r.event)?'Unfavorite ':'Favorite ')+r.event);star.disabled=!window.AnimPane||!AnimPane.sceneFavoritesReady();
    const preview=actorButton('Preview · 5 sec','expression',{event:r.event,preview:true});preview.dataset.primary='1';row.append(text,star,preview,actorButton('Apply event','expression',{event:r.event,preview:false}));list.append(row);
   });
   if(!shown.length)list.append(!expressionsReady?emptyState('sn-expr','Loading expressions…','Reading the events installed in your load order.',true):expressionOnlyFav?emptyState('sn-favorite','No favorite expressions match','Star an event under All expressions and it appears here.'):emptyState('sn-search','No expression events match','Try a shorter search.'));
  };body.append(searchBox('Search expression events…',paint),list,help);paint();paintActorStatus();
 }
 function renderPeople(){
  /* WHO first. The hero's cast strip is behind the popout, so it is here
     too — you should never have to guess who a control applies to. */
  body.append(personTabs());
  const a=(snapshot.actors||[]).find(x=>x.formId===selected);
  /* The status strip: the four things you do to a participant without
     going anywhere. Mute/Enable is ONE two-position control; Swap roles
     came here from the retired Live scene grab-bag. */
  const strip=el('div','ost-strip');
  const audio=el('p','ost-readout ost-strip-readout');audio.dataset.audio='1';
  const voice=el('div','ost-segmented');voice.setAttribute('role','group');voice.setAttribute('aria-label','Voice');
  const mute=actorButton('Mute voice','mute',{muted:true}),unmute=actorButton('Enable voice','mute',{muted:false});
  mute.setAttribute('aria-pressed',String(actorInfo.muted===true));unmute.setAttribute('aria-pressed',String(actorInfo.muted===false));
  voice.append(mute,unmute);
  const swap=btn('Swap roles',()=>{
   if(!canAct())return;
   if(typeof window.osSwap==='function'){osSwap('');message('Asked OStim to swap the roles.');refresh();}
   else message('Role swap needs the OStim panel.');
  });
  swap.disabled=!canAct()||!snapshot.canSwap;
  if(!snapshot.canSwap)swap.title='This scene has no second role to swap with.';
  strip.append(audio,voice,actorButton('Restore scene clothing','redress'),swap,btn('Refresh participant status',getActor));
  body.append(strip);
  /* One panel at a time. All four are in the DOM (their painters look them
     up by class); only the chosen one is shown. */
  body.append(subTabs([['clothing','Clothing','hm-wardrobe'],['voice','Voice','sn-people'],['body','Body','sn-ppa'],['look','Look','sn-expr']],peopleTab,t=>{peopleTab=t;render();}));
  const panels=el('div','ost-subject');
  const show=(node,key)=>{node.dataset.on=String(peopleTab===key);node.dataset.panel=key;return node;};
  panels.append(show(undressControl(),'clothing'),show(voiceControl(),'voice'));
  const bodyPanel=el('div','ost-panel-body');bodyPanel.append(sosControl(),sizeControl());panels.append(show(bodyPanel,'body'));
  panels.append(show(appearanceControl(),'look'));
  body.append(panels);
  paintActorStatus();paintSize();paintWorn();paintSos();
 }

 function resetSize(){sizeInfo={};sizeDraft=null;sizeDrag=null;sizePending=false;sizeQuery++;}
 function getSize(){
  if(!canAct()||!selected||sizePending)return;const fid=selected,sig=snapshot.signature,q=++sizeQuery;
  request('sizeState',{formId:fid},j=>{if(q!==sizeQuery||fid!==selected||sig!==snapshot.signature||sizePending)return;sizeInfo=j;if(!sizeDrag)sizeDraft=null;paintSize();});
 }
 function sizeAvailable(){return canAct()&&!!selected&&sizeInfo.available&&sizeInfo.formId===selected;}
 function sizeValue(){return sizeDraft===null?(Number.isFinite(sizeInfo.size)?sizeInfo.size:1):sizeDraft;}
 function setSizeDraft(n){if(!sizeAvailable()||sizePending||!Number.isFinite(n))return;sizeDraft=Math.max(1,Math.min(20,Math.round(n)));paintSize();}
 function sizeAction(restore){
  if(!sizeAvailable()||sizePending)return;
  const fid=selected,sig=snapshot.signature,n=sizeValue();sizePending=true;sizeQuery++;paintSize();
  request(restore?'sizeRestore':'size',restore?{formId:fid}:{formId:fid,size:n},j=>{
   if(fid!==selected||sig!==snapshot.signature)return;sizePending=false;
   if(j.formId===fid){sizeInfo=j;if(j.available)sizeDraft=null;}
   message(j.msg);paintSize();getSize();
  });
 }
 function paintSize(){
  if(!modal||tab!=='people')return;const box=q1('.ost-size');if(!box)return;
  const available=sizeAvailable(),n=sizeValue(),track=box.querySelector('.ost-size-track');
  box.querySelector('.ost-size-value').textContent=available?'Size '+n+' / 20':'SOS size';
  box.querySelector('.ost-size-status').textContent=sizePending?'Applying to the selected participant…':available?'Current SOS size: '+sizeInfo.size+(Number.isFinite(sizeInfo.original)?' · Starting size: '+sizeInfo.original:''):sizeInfo.msg||(!canAct()?'Start a player scene first.':'Reading this participant’s SOS size…');
  if(track){track.setAttribute('aria-valuenow',String(n));track.setAttribute('aria-valuetext',available?'Size '+n+' of 20':'Unavailable');track.setAttribute('aria-disabled',String(!available||sizePending));track.querySelector('.ost-size-fill').style.width=((n-1)/19*100)+'%';track.querySelector('.ost-size-knob').style.left=((n-1)/19*100)+'%';}
  box.querySelectorAll('button').forEach(b=>{b.disabled=!available||sizePending||(b.dataset.sizeStep==='-1'&&n<=1)||(b.dataset.sizeStep==='1'&&n>=20)||(b.dataset.sizeRestore==='1'&&!Number.isFinite(sizeInfo.original));});
  box.querySelectorAll('[data-size-preset]').forEach(b=>b.setAttribute('aria-pressed',String(n===Number(b.dataset.sizePreset))));
 }
 function moveSize(e){
  if(!sizeDrag||!sizeDrag.isConnected||!sizeAvailable()||sizePending){sizeDrag=null;return;}
  const r=sizeDrag.getBoundingClientRect();if(r.width>0)setSizeDraft(1+19*(e.clientX-r.left)/r.width);e.preventDefault();
 }
 window.addEventListener('mousemove',moveSize,true);
 window.addEventListener('mouseup',e=>{if(!sizeDrag)return;moveSize(e);sizeDrag=null;photoDragReleased=true;sizeAction(false);},true);
 window.addEventListener('blur',()=>{if(sizeDrag){sizeDrag=null;sizeDraft=null;paintSize();}});
 function sizeControl(){
  const box=el('section','ost-size'),head=el('div','ost-size-head'),actor=(snapshot.actors||[]).find(a=>a.formId===selected);head.append(el('h3','','SOS size'+(actor?' · '+actor.name:'')),el('strong','ost-size-value'));box.append(head,el('p','ost-help ost-size-status'));
  const track=el('div','ost-size-track');track.setAttribute('role','slider');track.setAttribute('tabindex','0');track.setAttribute('aria-label','Selected participant SOS size');track.setAttribute('aria-valuemin','1');track.setAttribute('aria-valuemax','20');track.setAttribute('aria-orientation','horizontal');
  track.append(el('span','ost-size-rail'),el('span','ost-size-fill'),el('span','ost-size-knob'));
  track.addEventListener('mousedown',e=>{if(e.button!==0||!sizeAvailable()||sizePending)return;sizeDrag=track;track.focus();moveSize(e);e.stopPropagation();});
  track._ostKey=e=>{if(!sizeAvailable()||sizePending)return false;const steps={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-5,PageUp:5};if(e.key==='Home')setSizeDraft(1);else if(e.key==='End')setSizeDraft(20);else if(Object.prototype.hasOwnProperty.call(steps,e.key))setSizeDraft(sizeValue()+steps[e.key]);else return false;sizeAction(false);return true;};
  box.append(track);const presets=segmented([1,5,10,15,20].map(n=>[String(n),false,()=>{setSizeDraft(n);sizeAction(false);},{sizePreset:String(n)}]),'Size presets');presets.classList.add('ost-size-presets');box.append(presets);
  const controls=el('div','ost-toolbar');[-1,1].forEach(d=>{const b=btn(d<0?'Smaller':'Larger',()=>{setSizeDraft(sizeValue()+d);sizeAction(false);});b.dataset.sizeStep=String(d);controls.append(b);});const restore=btn('Restore starting size',()=>sizeAction(true));restore.dataset.sizeRestore='1';controls.append(restore);box.append(controls,el('p','ost-help','Click or drag, then release to apply. Arrow keys change one step. Only the selected participant changes. SOS keeps the size after the scene; Restore starting size is available during this scene.'));return box;
 }
 function getPhotos(){request('photos',{},j=>{photos=Array.isArray(j.images)?j.images.filter(p=>p&&typeof p.f==='string'&&/^ostim-[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/i.test(p.f)):[];if(tab==='camera'){if(photoDrag)photoRepaint=true;else render();}if(!j.ok)message(j.msg);});}
 function getCamera(){request('cameraState',{},j=>{cameraCurrent=j.ok&&Number.isFinite(j.fov)?j.fov:null;paintFov();if(!j.ok)message(j.msg);});}
 function selectedFov(){return photoFov==='exact'?photoDegrees:cameraCurrent===null?null:Math.max(1,Math.min(179,cameraCurrent+(photoFov==='out'?15:photoFov==='in'?-15:0)));}
 function setFov(value){if(!Number.isFinite(value))return;photoDegrees=Math.max(20,Math.min(120,Math.round(value)));photoFov='exact';paintFov();}
 function paintFov(){
  if(!modal)return;const value=selectedFov(),slider=q1('.ost-fov-track'),readout=q1('.ost-fov-value'),current=q1('.ost-fov-current');
  if(readout)readout.textContent=value===null?(photoFov==='keep'?'Keep current FOV':'Relative FOV choice'):Math.round(value)+'°'+(photoFov==='keep'?' · keep current':' · photo FOV');
  if(current)current.textContent=cameraCurrent===null?'Current game FOV unavailable — choose an exact angle or retry the read.':'Current game FOV: '+cameraCurrent.toFixed(1)+'°';
  if(slider){const n=Math.max(20,Math.min(120,value===null?photoDegrees:value)),percent=(n-20)+'%';slider.setAttribute('aria-valuenow',String(Math.round(n)));slider.setAttribute('aria-valuetext',value===null?'Choose photo FOV':Math.round(value)+' degrees'+(photoFov==='keep'?' (keep current)':''));slider.querySelector('.ost-fov-fill').style.width=percent;slider.querySelector('.ost-fov-knob').style.left=percent;}
  q('[data-fov-mode]').forEach(b=>b.setAttribute('aria-pressed',String(photoFov===b.dataset.fovMode)));
  q('[data-fov-preset]').forEach(b=>b.setAttribute('aria-pressed',String(photoFov==='exact'&&photoDegrees===Number(b.dataset.fovPreset))));
 }
 function moveFov(e){
  if(!photoDrag||!modal||!photoDrag.isConnected){photoDrag=null;return;}
  const rect=photoDrag.getBoundingClientRect();if(rect.width>0)setFov(20+100*(e.clientX-rect.left)/rect.width);e.preventDefault();
 }
 function endFov(e){if(photoDrag){if(e&&Number.isFinite(e.clientX))moveFov(e);photoDragReleased=true;}photoDrag=null;if(photoRepaint&&modal&&tab==='camera')render();}
 window.addEventListener('mousedown',()=>{photoDragReleased=false;},true);
 // Ultralight emits buttons=0 even during a held mouse gesture. Own the
 // gesture from down through up/blur; never infer release from that field.
 window.addEventListener('mousemove',moveFov,true);
 window.addEventListener('mouseup',endFov,true);
 window.addEventListener('blur',endFov);
 function fovControl(){
  const box=el('section','ost-fov'),head=el('div','ost-fov-head');head.append(el('strong','ost-fov-value','Photo FOV'),btn('Read current FOV',getCamera));
  const slider=el('div','ost-fov-track');slider.setAttribute('role','slider');slider.setAttribute('tabindex','0');slider.setAttribute('aria-label','Photo field of view');slider.setAttribute('aria-valuemin','20');slider.setAttribute('aria-valuemax','120');slider.setAttribute('aria-orientation','horizontal');
  slider.append(el('span','ost-fov-rail'),el('span','ost-fov-fill'),el('span','ost-fov-knob'));
  slider.addEventListener('mousedown',e=>{if(e.button!==0)return;photoDrag=slider;slider.focus();moveFov(e);e.stopPropagation();});
  slider._ostKey=e=>{const values={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10};const n=selectedFov()===null?photoDegrees:selectedFov();if(e.key==='Home')setFov(20);else if(e.key==='End')setFov(120);else if(Object.prototype.hasOwnProperty.call(values,e.key))setFov(n+values[e.key]*(e.shiftKey?5:1));else return false;return true;};
  const presets=segmented([20,35,50,65,80,100,120].map(n=>[n+'°',false,()=>setFov(n),{fovPreset:String(n)}]),'FOV presets');presets.classList.add('ost-fov-presets');
  box.append(head,slider,presets,el('p','ost-help ost-fov-current'),el('p','ost-help','Click anywhere on the track, hold and drag, or choose a mark. Arrow keys fine-tune by 1°. Applied when photo mode starts; your original FOV returns on exit.'));return box;
 }
 /* A saved photo used to REPLACE the camera page, so opening one and coming
    back threw away your FOV framing and your scroll position. It is a popout
    now: the controls stay exactly where you left them underneath. */
 function viewPhoto(file){
  photoView=file;
  popout('Scene photo',file,host=>{
   const img=el('img','ost-photo-full');
   img.src='journal-images/'+encodeURIComponent(file);
   img.alt='Saved scene photo';
   host.append(img);
  },'camera');
 }
 function renderCamera(){
  body.append(el('h3','','Frame the scene'),el('p','ost-help','Choose the field of view before entering free camera. Enter takes the photo; Esc or F7 cancels. Camera and FOV are restored when you finish.'));
  const fovs=el('div','ost-toolbar');fovs.append(segmented([['keep','Keep FOV'],['out','Zoom out · +15°'],['in','Zoom in · −15°']].map(v=>[v[1],photoFov===v[0],()=>{photoFov=v[0];paintFov();},{fovMode:v[0]}]),'Field of view'));body.append(fovs,fovControl());
  const modes=el('div','ost-toolbar');modes.append(segmented([['Live framing',!photoFreeze,()=>{photoFreeze=false;render();}],['Freeze for photo',photoFreeze,()=>{photoFreeze=true;render();}]],'Framing'));
  const start=primary('Start photo mode',()=>request('photo',{fov:photoFov,degrees:photoFov==='exact'?photoDegrees:0,freeze:photoFreeze},j=>{if(j.ok&&j.camera)close();else message(j.msg);}));start.disabled=!canAct();modes.append(start);body.append(modes,el('p','ost-help','The interface hides only for the shot, so exit instructions stay visible while framing. Exit any existing free camera first.'),el('h3','','Recent scene photos'),btn('Refresh photos',getPhotos));
  const list=el('div','ost-photo-grid');const paint=()=>{list.textContent='';photos.filter(p=>p.f.toLowerCase().includes(search.toLowerCase())).forEach(p=>{const b=btn('',()=>viewPhoto(p.f),'ost-photo');const img=el('img');img.src='journal-images/'+encodeURIComponent(p.f);img.alt='Saved scene photo';b.append(img,el('span','',p.f));list.append(b);});if(!list.children.length)list.append(el('p','ost-help','Your scene photos will appear here after capture. The latest 50 are also available in the Journal image pool.'));};body.append(searchBox('Search saved photo names…',paint),list);paint();paintFov();
 }

 /* ==================================================================== *
  *  The segments the dedicated Scene page added (2026-09-21).
  * ==================================================================== */

 /* ---- "you are here" (ask 5) ---------------------------------------
    Rober: "i know there are more beds in the house im in … it doesnt seem
    to be showing the bed were actively on as well."

    The second half is NOT a radius bug and no radius setting fixes it:
    OFurniture.FindFurniture returns the closest UNOCCUPIED object of each
    furniture type, and the bed you are on is reserved by your own thread,
    so it is excluded BY DESIGN. The honest fix is a different question —
    ask the thread what it is using — which is what `here` does. The first
    half IS reachable: the radius chips now go to 200 ft. */
 function getHere(){if(herePending)return;herePending=true;request('here',{},j=>{herePending=false;here=j.ok?(j.here||null):null;if(tab==='move')render();});}
 /* ---- Hold & resume here (ask: the SexLab relocate) ------------------
    Rober, 2026-09-22: "sexlab has a feature where it temp pauses the scene
    you run around then after a few seconds it replays scene right there."
    It is a STOP and a RESTART, not a pause — OStim has no pause — and the
    panel says so rather than letting the restart come as a surprise. */
 function getHoldState(force){
  if(holdPending&&!force)return;
  holdPending=true;
  request('held',{op:'state'},j=>{holdPending=false;holdState=j&&j.ok?j:null;if(tab==='move')render();});
 }
 function holdAct(op){
  if(holdPending)return;
  holdPending=true;
  request('held',{op:op},j=>{
   holdPending=false;
   holdState=j&&j.has?j:null;
   if(j&&j.msg)message(j.msg);
   if(tab==='move')render();
  });
 }
 function holdPanel(){
  const box=el('section','ost-hold');
  box.append(el('h3','','Take the scene with you'));
  if(!holdState||!holdState.has){
   box.append(el('p','ost-help','Hold stops the scene and remembers it — the animation, who was in it, the speed and every alignment offset. Walk wherever you want it, then Resume here restarts it on the spot. It is a restart, not a pause: the animation begins again from the top, and OStim owns arousal so that resets with it.'));
   const b=primary('Hold this scene',()=>holdAct('hold'));
   b.disabled=!canAct()||holdPending;
   box.append(b);
   return box;
  }
  box.append(el('p','ost-status','Holding: '+(holdState.sceneName||holdState.scene||'a scene')));
  const list=el('div','ost-list');
  (holdState.people||[]).forEach(r=>{
   const row=el('div','ost-row'),text=el('div','ost-row-text');
   row.dataset.state=r.ok?'ok':'refused';
   text.append(el('strong','',r.name),el('small','',r.ok?'Here and ready':(r.reason||'Not available')));
   row.append(picture(r),text);
   if(r.feet>=0)row.append(el('span','ost-far',r.feet+' ft'));
   list.append(row);
  });
  box.append(list);
  const tools=el('div','ost-toolbar');
  const go=primary('Resume here',()=>holdAct('resume'));
  go.disabled=holdPending||!holdState.canResume;
  tools.append(go,btn('Forget it',()=>holdAct('discard')));
  box.append(tools);
  if(!holdState.canResume)box.append(el('p','ost-help','Everyone in the held scene has to be in this room with you. Bring them here — the Participants and Add & remove pages can move people — and this refreshes on its own.'));
  paintFaces();
  return box;
 }
 function hereRow(){
  const box=el('section','ost-here');
  const text=el('div','ost-row-text');
  const well=el('span','ost-seg-well ost-row-well');const ic=el('img','ost-icon');ic.src='icons/custom/'+FURN_ICON(here&&here.type)+'.png';ic.alt='';well.append(ic);
  box.append(well);
  if(here){
   text.append(el('span','ost-here-cap','You are on'),el('strong','',here.name),el('small','',here.type));
   box.append(text);
   if(here.formId)box.append(btn('Highlight',()=>act('highlight',{formId:here.formId,token:token})));
  }else{
   text.append(el('strong','',herePending?'Reading the scene’s furniture…':'Not on furniture'),
               el('small','',herePending?'':'OStim reports no furniture for this scene.'));
   box.append(text);
  }
  return box;
 }

 /* ---- Add & remove participants (ask 3) -----------------------------
    MigrateThread is the same primitive Swap roles uses. Two costs are
    stated on the page rather than discovered in play: the scene restarts
    (a new thread id), and the actor-count change makes OStim re-pick
    furniture with 'none' — so a third person usually lands you off the
    bed. HasCompatibleNode is a precondition, never a promise. */
 function getRoster(){
  if(!canAct()){message('Start a player scene to change who is in it.');return;}
  castBusy=true;if(tab==='cast')render();
  request('roster',{radius:castRadius},j=>{
   castBusy=false;castRows=j.rows||[];castCast=j.cast||[];castToken=j.token||'';
   if(j.msg)message(j.msg);if(tab==='cast')render();
  });
 }
 function castAction(name,formId){
  if(!canAct()||castBusy)return;castBusy=true;render();
  request(name,{formId:formId,token:castToken},j=>{
   castBusy=false;message(j.msg);
   // A migration restarts the scene: everything cached is about the old one.
   if(j.ok){rows=[];token='';here=null;castRows=[];castToken='';}
   refresh(()=>{if(tab==='cast')getRoster();});
  });
 }
 function renderCast(){
  body.append(el('h3','','Who is in this scene'));
  const cast=el('div','ost-cast-now');
  (castCast.length?castCast:(snapshot.actors||[])).forEach(a=>{
   const row=el('div','ost-cast-chip');
   row.append(picture(a),el('span','',a.name||'Participant'));
   const drop=btn('Remove',()=>castAction('part',a.formId));
   drop.disabled=!canAct()||castBusy||(castCast.length||(snapshot.actors||[]).length)<3;
   row.append(drop);cast.append(row);
  });
  body.append(cast);
  body.append(el('p','ost-help','Adding or removing someone RESTARTS the scene through OStim — it picks a new animation for the new group, and because the actor count changed it searches with no furniture type, so a third participant usually puts you on the floor rather than the bed.'));
  const tools=el('div','ost-toolbar');
  const rescan=btn('Rescan nearby',getRoster);rescan.disabled=castBusy;tools.append(rescan);
  const reach=el('div','ost-segmented');reach.setAttribute('role','group');reach.setAttribute('aria-label','Search radius');
  [30,60,120].forEach(n=>{const b=btn(n+' ft',()=>{castRadius=n;getRoster();});b.setAttribute('aria-pressed',String(castRadius===n));reach.append(b);});
  tools.append(reach);
  body.append(tools);
  const list=el('div','ost-list');
  const paint=()=>{
   list.textContent='';
   const q=search.toLowerCase();
   const shown=castRows.filter(r=>(r.name||'').toLowerCase().includes(q));
   shown.forEach(r=>{
    const row=el('div','ost-row'),text=el('div','ost-row-text');
    row.dataset.state=r.compatible?'ok':'refused';
    text.append(el('strong','',r.name),
                el('small','',r.compatible?'OStim has a scene for this group':'No scene for this group yet'));
    row.append(picture(r),el('span','ost-far',r.feet+' ft'));
    const add=primary('Bring into the scene',()=>castAction('join',r.formId));
    add.disabled=!canAct()||castBusy||!r.compatible;
    row.append(text,add);list.append(row);
   });
   /* Whoever paints icons/npcs must also COLLECT — see portraitIds below. */
   paintFaces();
   if(!shown.length)list.append(castBusy?emptyState('sn-cast','Looking around…','Checking who nearby is free to join.',true):castRows.length?emptyState('sn-search','Nobody matches that','Clear the search, or widen the radius.'):emptyState('sn-cast','Nobody free to join','Everyone nearby is busy, in a scene, or out of range. Widen the radius.'));
  };
  body.append(searchBox('Search people nearby…',paint),list);paint();
 }

 /* ---- The room (ask 9) ----------------------------------------------
    A proxy onto npc_clearance.cpp — the deck implements no clearing of
    its own. The page route exists because the get-away modal closes the
    palette on every mutation, which mid-scene would close the page. */
 function getHeld(){
  heldPending=true;if(tab==='room')render();
  request('room',{op:'nearby'},j=>{
   heldPending=false;rows=j.rows||[];held=j.held||[];if(j.msg)message(j.msg);if(tab==='room')render();
  });
 }
 function roomAction(extra,label){
  if(heldPending)return;heldPending=true;render();
  request('room',extra,j=>{heldPending=false;held=j.held||[];message(j.msg||label);getHeld();});
 }
 // scene-privacy-portraits: all guest, candidate and held faces share FolPane.
 function getPrivacy(quiet){
  if(privacyBusy)return;
  const query=++privacySerial;
  request('privacy',{op:'state'},j=>{
   if(query!==privacySerial)return;
   const old=JSON.stringify(privacy);privacy=j;
   if(window.FolPane&&FolPane.requestPortraitFaces)FolPane.requestPortraitFaces();
   if(tab!=='room')return;
   const status=q1('[data-privacy-status]');if(status)status.textContent=privacyStatus();
   // A poll must not replace an input or the button the player is using.
   const focused=document.activeElement,editing=focused&&focused.closest&&focused.closest('.ost-privacy');
   if(!quiet||(!editing&&old!==JSON.stringify(j)))render();
  });
 }
 function privacyAction(op,extra){
  if(privacyBusy)return;privacyBusy=true;const query=++privacySerial;render();
  request('privacy',Object.assign({op},extra||{}),j=>{
   if(query!==privacySerial)return;privacyBusy=false;privacy=j;message(j.msg||'Privacy updated');
   if(window.FolPane&&FolPane.requestPortraitFaces)FolPane.requestPortraitFaces();
   if(tab==='room')render();
  });
 }
 function privacyStatus(){
  if(!Object.prototype.hasOwnProperty.call(privacy,'automatic'))return 'Reading privacy…';
  return (privacy.active?(!privacy.canMove?'Privacy needs an exit':privacy.blocked?privacy.blocked+' NPCs could not be moved':'Room exclusion active'):privacy.automatic?'Automatic exclusion armed':'Automatic exclusion off')+
   (privacy.scopeName?' · '+privacy.scopeName:'')+' · '+(privacy.bridge||'CHIM bridge not confirmed');
 }
 function renderPrivacy(){
  const section=el('section','ost-privacy');section.append(el('h3','','Privacy & invited guests'));
  const status=el('p','ost-help',privacyStatus());status.dataset.privacyStatus='1';status.setAttribute('aria-live','polite');section.append(status);
  section.append(el('p','ost-help','Automatic privacy keeps uninvited NPCs out during your OStim scenes and returns them afterward. CHIM stays private whenever you are inside this boundary with automatic privacy armed, including conversations before and after a scene. An invitation permits entry; only guests actually inside can hear.'));
  const tools=el('div','ost-grid ost-grid-4');
  const automatic=btn(privacy.automatic?'Automatic privacy: on':'Automatic privacy: off',()=>privacyAction('automatic',{value:!privacy.automatic}));
  automatic.setAttribute('aria-pressed',String(!!privacy.automatic));automatic.dataset.privacyAuto='1';
  const now=btn(privacy.manual?'End private conversation':'Private conversation now',()=>privacyAction('manual',{value:!privacy.manual}));now.setAttribute('aria-pressed',String(!!privacy.manual));now.disabled=privacyBusy||!privacy.scopeValid;
  const release=btn('Release for this scene',()=>privacyAction('release'));release.disabled=privacyBusy||(!privacy.active&&!(privacy.held||[]).length);
  automatic.disabled=privacyBusy||!Object.prototype.hasOwnProperty.call(privacy,'automatic');
  tools.append(automatic,now,release,btn('Refresh privacy',()=>getPrivacy()));section.append(tools);
  const scope=el('div','ost-toolbar');
  ['claimed','cell'].forEach(value=>{const b=btn(value==='claimed'?'Claimed room':'Whole interior',()=>privacyAction('scope',{value}));b.setAttribute('aria-pressed',String(privacy.scope===value));b.disabled=privacyBusy;scope.append(b);});section.append(scope);
  section.append(el('p','ost-help',privacy.scope==='cell'?'Whole interior means the entire loaded interior cell, including other rooms in the same inn or house.':'Uses the room boundary and outside anchor you set in Rooms. It does not guess the shape of walls.'));
  if(privacy.msg)section.append(el('p','ost-help',privacy.msg));
  const list=el('div','ost-list');
  const paint=()=>{
   list.textContent='';const seen=new Set(),all=[];
   const add=(a,kind)=>{const key=a.formId?'id:'+a.formId:'key:'+a.key;if(seen.has(key))return;seen.add(key);all.push(Object.assign({},a,{kind}));};
   (privacy.held||[]).forEach(a=>add(a,'outside'));
   (privacy.rows||[]).forEach(a=>add(a,a.participant?'participant':a.invited?'invited':'candidate'));
   (privacy.invited||[]).forEach(a=>add(a,'invited'));
   const visible=all.filter(a=>(a.name||'').toLowerCase().includes(privacySearch.toLowerCase()));
   visible.forEach(a=>{
    const row=el('div','ost-row'),text=el('div','ost-row-text');row.dataset.privacyPerson=String(a.formId||a.key||'');
    text.append(el('strong','',a.name||'NPC'),el('small','',a.kind==='outside'?'Temporarily outside':a.kind==='participant'?'Scene participant · stays inside':a.kind==='invited'?'Invited guest':a.status||'Not invited'));
    row.append(picture(Object.assign({formId:0},a)),text);
    if(a.kind!=='participant'){
     const isGuest=a.kind==='invited',b=btn(isGuest?'Remove invitation':'Invite inside',()=>privacyAction(isGuest?(a.key?'removeInvitation':'uninvite'):'invite',isGuest&&a.key?{key:a.key}:{formId:a.formId}));
     b.dataset.primary='1';b.disabled=privacyBusy||(!a.formId&&!isGuest);row.append(b);
    }list.append(row);
   });
   if(!visible.length)list.append(el('p','ost-help',privacySearch?'No matching guests.':'No guests to show. Refresh when NPCs are nearby.'));
   paintFaces();
  };
  const input=el('input','ost-search');input.type='search';input.value=privacySearch;input.placeholder='Search invited guests and nearby NPCs…';input.setAttribute('aria-label','Search privacy guests');input.autocomplete='off';input.spellcheck=false;
  input.addEventListener('input',()=>{privacySearch=input.value;paint();});input._ostEnter=()=>{const b=Array.from(list.querySelectorAll('button')).find(n=>!n.disabled);if(b)b.click();};
  section.append(input,list);body.append(section);paint();
 }
 function renderRoom(){
  renderPrivacy();
  body.append(el('h3','','Clear the room'),
    el('p','ost-help','Moves everyone else out through this cell’s own door and switches their AI off so they stay there. Anyone in a scene — including yours — is left exactly where they are. Bring them back when you are done.'));
  const tools=el('div','ost-toolbar');
  const all=primary('Clear the room',()=>roomAction({op:'clear'},'Room cleared.'));
  all.disabled=heldPending||!rows.some(r=>!r.reason);
  const keep=btn('Clear, keep followers',()=>roomAction({op:'clear',keepFollowers:true},'Room cleared.'));
  keep.disabled=heldPending||!rows.some(r=>!r.reason&&!r.follower);
  const back=btn('Bring them back',()=>roomAction({op:'restore'},'Everyone put back.'));
  back.disabled=heldPending||!held.length;
  tools.className='ost-grid ost-grid-4';all.dataset.primary='1';tools.append(all,keep,back,btn('Refresh',getHeld));body.append(tools);
  if(held.length){
   const box=el('section','ost-held');
   box.append(el('h3','','Being held away · '+held.length));
   const grid=el('div','ost-held-grid');
   held.forEach(h=>{const chip=el('span','ost-held-chip');chip.append(picture(h),el('span','',h.name||'NPC'));grid.append(chip);});
   box.append(grid);body.append(box);
  }
  const list=el('div','ost-list');
  const paint=()=>{
   list.textContent='';
   const q=search.toLowerCase();
   const shown=rows.filter(r=>(r.name||'').toLowerCase().includes(q));
   shown.forEach(r=>{
    const row=el('div','ost-row'),text=el('div','ost-row-text');
    row.dataset.state=r.reason?'refused':'ok';
    text.append(el('strong','',r.name),
                el('small','','~'+r.feet+' ft'+(r.follower?' · follower':'')+(r.reason?' · '+r.reason:'')));
    row.append(picture(r),text,el('span','ost-far',r.feet+' ft'));
    const one=btn('Move them out',()=>roomAction({op:'clear',ids:[r.formId]},'Moved out.'));
    one.disabled=heldPending||!!r.reason;row.append(one);
    list.append(row);
   });
   if(!shown.length)list.append(heldPending?emptyState('sn-room','Looking around the room…','',true):emptyState('sn-room','Nobody else is here','The room is yours.'));
   paintFaces();
  };
  body.append(searchBox('Search everyone in the room…',paint),list);paint();
 }

 /* ---- PPA physics (ask 7) -------------------------------------------
    PPA (Procedural Penis Animations) is a pure C++ SKSE plugin: no ESP,
    no Papyrus, no MCM. Every setting lives in accurate-penetration.toml,
    and the mod ships its own Reload hotkey — so the deck rewrites the
    file in place (comments and decimal spelling preserved, because PPA
    warns that a value written without its decimal point reads wrong) and
    then taps PPA's OWN key, read live from that same file. */
 function getPpa(){
  if(ppaPending)return;ppaPending=true;if(tab==='ppa')render();
  request('ppa',{op:'state'},j=>{ppaPending=false;ppa=j.ok?j:{ok:false,msg:j.msg};if(j.msg)message(j.msg);if(tab==='ppa')render();});
 }
 function ppaSet(key,value){
  if(ppaPending||!ppa.ok)return;ppaPending=true;render();
  request('ppa',{op:'set',key:key,value:value},j=>{ppaPending=false;message(j.msg);if(j.ok&&j.rows)ppa=j;render();});
 }
 function renderPpa(){
  body.append(el('h3','','PPA — Procedural Penis Animations'));
  if(!ppa.ok){
   body.append(el('p','ost-help',ppaPending?'Reading PPA’s configuration…':(ppa.msg||'PPA is not installed, or its accurate-penetration.toml could not be read.')),
               btn('Retry',getPpa));
   return;
  }
  const note=el('p','ost-help');
  note.textContent=ppa.active===false
   ? 'PPA is loaded but reports no tags or context for the running scene, so it is doing nothing to it right now.'
   : 'Changes are written to accurate-penetration.toml and applied by tapping PPA’s own Reload key ('+(ppa.reloadKey||'unbound')+').';
  body.append(note);
  const list=el('div','ost-list');
  const paint=()=>{
   list.textContent='';
   const q=search.toLowerCase();
   const shown=(ppa.rows||[]).filter(r=>(r.key+' '+(r.section||'')+' '+(r.detail||'')).toLowerCase().includes(q));
   shown.forEach(r=>{
    const row=el('div','ost-row'),text=el('div','ost-row-text');
    text.append(el('strong','',r.label||r.key),el('small','',(r.section||'')+(r.detail?' · '+r.detail:'')));
    row.append(text);
    if(r.type==='bool'){
     const on=btn(r.value?'On':'Off',()=>ppaSet(r.key,r.value?'false':'true'));
     on.setAttribute('aria-pressed',String(!!r.value));on.dataset.primary='1';on.disabled=ppaPending;row.append(on);
    }else{
     const value=el('span','ost-ppa-value ost-stepper-value',String(r.value));
     const st=stepper(value,()=>ppaSet(r.key,String(r.value-(r.step||1))),()=>ppaSet(r.key,String(r.value+(r.step||1))));
     st.querySelectorAll('button').forEach(b=>{b.disabled=ppaPending;});row.append(st);
    }
    list.append(row);
   });
   if(!shown.length)list.append(emptyState('sn-search','No PPA setting matches','Try a shorter search.'));
  };
  body.append(searchBox('Search PPA settings…',paint),list);paint();
 }

 /* ---- per-participant undress (ask 6) + voice (ask 8) ---------------- */
 function getWorn(){
  if(!canAct()||!selected||wornPending)return;
  const fid=selected,sig=snapshot.signature,q=++wornQuery;
  request('undressState',{formId:fid},j=>{if(q!==wornQuery||fid!==selected||sig!==snapshot.signature)return;wornInfo=j.ok?j:{};paintWorn();});
 }
 function wornAction(op,slot){
  if(!canAct()||!selected||wornPending)return;
  const fid=selected,sig=snapshot.signature;wornPending=true;wornQuery++;render();
  request('undress',{formId:fid,op:op,slot:slot||''},j=>{
   if(fid!==selected||sig!==snapshot.signature)return;
   wornPending=false;if(j.ok)wornInfo=j;message(j.msg);render();getWorn();
  });
 }
 function paintWorn(){
  if(!modal||tab!=='people')return;
  const box=q1('.ost-undress');if(!box)return;
  const status=box.querySelector('.ost-undress-status');
  // OStim exposes NO undress-state query, so this reads what the actor is
  // WEARING. "Bare" is a fact; "undressed by OStim" would be a guess.
  if(status)status.textContent=wornPending?'Asking OStim…'
   :!canAct()?'Start a player scene first.'
   :!wornInfo.slots?'Reading what they are wearing…'
   :wornInfo.pieces?'Wearing '+wornInfo.pieces+' piece'+(wornInfo.pieces===1?'':'s'):'Bare';
  box.querySelectorAll('[data-slot]').forEach(b=>{
   const row=(wornInfo.slots||[]).filter(x=>x.key===b.dataset.slot)[0];
   b.disabled=!canAct()||wornPending;
   b.setAttribute('aria-pressed',String(!!(row&&row.worn)));
   const label=b.querySelector('.ost-slot-state');
   if(label)label.textContent=!row?'—':row.worn?(row.item||'worn'):'bare';
  });
  box.querySelectorAll('[data-undress]').forEach(b=>{b.disabled=!canAct()||wornPending;});
 }
 function undressControl(){
  const box=el('section','ost-undress');
  const actor=(snapshot.actors||[]).filter(a=>a.formId===selected)[0];
  box.append(el('h3','','Clothing'+(actor?' · '+actor.name:'')),el('p','ost-help ost-undress-status'));
  const grid=el('div','ost-grid');
  const off=btn('Undress fully',()=>wornAction('off'));off.dataset.primary='1';off.dataset.undress='1';
  const on=btn('Put it back',()=>wornAction('on'));on.dataset.undress='1';
  const wOff=btn('Take weapons',()=>wornAction('weaponsOff'));wOff.dataset.undress='1';
  const wOn=btn('Return weapons',()=>wornAction('weaponsOn'));wOn.dataset.undress='1';
  grid.append(off,on,wOff,wOn);box.append(grid);
  const slots=el('div','ost-slot-grid');
  [['head','Head'],['body','Body'],['hands','Hands'],['feet','Feet']].forEach(pair=>{
   const b=el('button','ost-slot');b.type='button';b.dataset.slot=pair[0];
   b.append(el('span','ost-slot-name',pair[1]),el('span','ost-slot-state','—'));
   // One button per slot: it strips what is worn and restores what is not,
   // so the control reads the same way whichever state it is in.
   b.addEventListener('click',()=>{
    const row=(wornInfo.slots||[]).filter(x=>x.key===pair[0])[0];
    wornAction(row&&row.worn?'slotOff':'slotOn',pair[0]);
   });
   slots.append(b);
  });
  box.append(slots,el('p','ost-help','OStim’s own undress, so Put it back restores exactly what it removed. OStim reports no undress state of its own — the labels above are what this participant is wearing right now.'));
  return box;
 }
 /* ---- Appearance ------------------------------------------------------
    The six controls the NPC card's "Scene controls" popout owned, folded
    into the page (Rober, 2026-09-21: "integrate this popout into the main
    page ... Makle sure nothing is missed from the popout").

    They are PER-PARTICIPANT, which is why they live under Participants
    rather than becoming a thirteenth chip: skin, restraints, liquids, oil,
    applied effects and body physics all describe one actor.

    Every one dispatches FolPane.openEffectsFor — the same verb the popout
    called. The deck implements no appearance mechanics of its own. */
 const APPEARANCE=[
  ['Change skin',                 'skins','',      'hm-faces',      'Browse skin packs and restore their own'],
  ['Equip bondage',               'zaz',  '',      'hm-wardrobe',   'Choose restraints or remove worn pieces'],
  ['Equip liquids',               'fx',   'liquid','sv-drink',      'Apply and remove liquid effects'],
  ['Oil skin',                    'fx',   'oil',   'hk-potion-cure','Adjust the oiled-skin effect'],
  ['All effects / remove effects','fx',   '',      'hm-spells',     'Review and remove applied effects'],
  ['Body physics',                'body', '',      'hk-anim-fix',   'Open the body physics controls']
 ];
 function appearanceControl(){
  const box=el('section','ost-appearance');
  const actor=(snapshot.actors||[]).filter(a=>a.formId===selected)[0];
  box.append(el('h3','','Appearance'+(actor?' · '+actor.name:'')));
  const grid=el('div','ost-appearance-grid');
  APPEARANCE.forEach(a=>{
   const b=el('button','ost-appearance-tile');b.type='button';
   const i=el('img','ost-icon');i.src='icons/custom/'+a[3]+'.png';i.alt='';
   const text=el('span','ost-appearance-text');
   text.append(el('strong','',a[0]),el('small','',a[4]));
   b.append(i,text);
   b.disabled=!selected;
   b.addEventListener('click',()=>{
    if(!selected)return;
    const who={formId:'0x'+selected.toString(16),name:actor?actor.name:'NPC'};
    // The appearance modals are full-screen surfaces of their own, so the
    // deck hands over rather than stacking them behind this popout.
    closePop();
    if(window.FolPane&&FolPane.openEffectsFor)FolPane.openEffectsFor(who,a[1],a[2]);
    else message('Appearance controls need the Followers pane.');
   });
   grid.append(b);
  });
  box.append(grid,el('p','ost-help','These open the same skin, restraint, effect and physics controls the NPC card uses — applied to the participant selected above.'));
  return box;
 }
 function getVoices(){
  if(!canAct()||voicePending)return;
  voicePending=true;
  request('voiceState',{},j=>{
   voicePending=false;voiceActors=j.ok?(j.actors||[]):[];
   if(!voiceRows.length)request('voices',{},v=>{voiceRows=v.voices||[];voiceToken=v.token||'';if(tab==='people')render();});
   else if(tab==='people')render();
  });
 }
 function setVoice(index,reset){
  if(!canAct()||!selected||voicePending)return;
  voicePending=true;render();
  request('setVoice',{formId:selected,index:index,reset:!!reset,token:voiceToken},j=>{
   voicePending=false;message(j.msg);getVoices();
  });
 }
 function voiceControl(){
  const box=el('section','ost-voice');
  const actor=voiceActors.filter(a=>a.formId===selected)[0];
  box.append(el('h3','','Voice'+(actor?' · '+actor.name:'')));
  const status=el('p','ost-help');
  status.textContent=voicePending?'Reading voices from OStim…'
   :!canAct()?'Start a player scene first.'
   :!actor?'Select a participant above.'
   :'Currently: '+(actor.voiceName||'OStim’s default for this actor');
  box.append(status);
  // The whole cast at a glance — Rober asked to "see which actor in the
  // scene has which voice", which is the one thing OStim's own ACTORS page
  // makes you click through one by one.
  if(voiceActors.length){
   const grid=el('div','ost-voice-grid');
   voiceActors.forEach(a=>{
    const b=el('button','ost-voice-card');b.type='button';
    b.setAttribute('aria-pressed',String(a.formId===selected));
    b.append(el('span','ost-voice-who',a.name),el('span','ost-voice-set',a.voiceName||'default'));
    b.addEventListener('click',()=>{selected=a.formId;resetSize();actorInfo={};actorQuery++;wornInfo={};wornQuery++;render();getActor();getWorn();getSos();});
    grid.append(b);
   });
   box.append(grid);
  }
  if(actor&&!actor.unique)
   box.append(el('p','ost-help','⚠ This is a generic NPC. OStim keys voices on the actor BASE, so changing it changes every NPC that shares this base, not only this one.'));
  /* The picker is a POPOUT, not a list squeezed under three other panels:
     it is the one control here with a hundred rows, and opening it must not
     push the SOS dials down the page while you are looking at them. */
  const choose=btn('Change voice…',()=>popout('Voice'+(actor?' · '+actor.name:''),
   actor&&!actor.unique
    ? 'This is a generic NPC. OStim keys voices on the actor BASE, so this changes every NPC sharing it.'
    : 'Installed OStim voice sets. The one in use is marked.',
   host=>{
    popList(host,'Search voice sets…',()=>voiceRows.map(r=>({id:r.index,label:r.name||r.id,search:r.name+' '+r.id})),
     r=>{const b=btn(r.label,()=>{setVoice(r.id,false);closePop();},'ost-option');
         b.disabled=!canAct()||!selected||voicePending;
         if(actor&&actor.voiceName===r.label)b.dataset.primary='1';
         return b;});
    if(!voiceRows.length)host.append(el('p','ost-help','OStim reports no installed voice sets.'));
   },'people'));
  choose.dataset.primary='1';
  choose.disabled=!canAct()||!selected;
  const reset=btn('Back to OStim’s default',()=>setVoice(-1,true));
  reset.disabled=!canAct()||!selected||voicePending;
  const acts=el('div','ost-toolbar');acts.append(choose,reset);
  box.append(acts);
  return box;
 }

 /* ---- the scene's own SOS dials (ask 4) ------------------------------
    Scene-scoped, and nothing to do with SOS's global bend keys: OStim
    carries sosBend and scale per actor in its own alignment data, so
    these are a read-modify-write of data OStim already owns.
    ⚠ scale's neutral value is 1, not 0 — C++ reads before every write. */
 function getSos(){
  if(!canAct()||!selected||sosPending)return;
  const fid=selected,sig=snapshot.signature;
  request('sosState',{formId:fid},j=>{if(fid!==selected||sig!==snapshot.signature)return;sosInfo=j.ok?j:{};paintSos();});
 }
 function sosAction(field,delta,reset){
  if(!canAct()||!selected||sosPending)return;
  const fid=selected,sig=snapshot.signature;sosPending=true;paintSos();
  request('sos',{formId:fid,field:field,delta:delta,reset:!!reset},j=>{
   if(fid!==selected||sig!==snapshot.signature)return;
   sosPending=false;if(j.ok)sosInfo=j;message(j.msg);paintSos();
  });
 }
 function paintSos(){
  if(!modal||tab!=='people')return;
  const box=q1('.ost-sos');if(!box)return;
  const bend=Number.isFinite(sosInfo.bend)?sosInfo.bend:null;
  const scale=Number.isFinite(sosInfo.scale)?sosInfo.scale:null;
  box.querySelector('[data-sos="bend"]').textContent=bend===null?'—':bend.toFixed(0);
  box.querySelector('[data-sos="scale"]').textContent=scale===null?'—':scale.toFixed(2)+'×';
  box.querySelectorAll('button').forEach(b=>{b.disabled=!canAct()||!selected||sosPending||sosInfo.formId!==selected;});
 }
 function sosControl(){
  const box=el('section','ost-sos');
  const actor=(snapshot.actors||[]).filter(a=>a.formId===selected)[0];
  box.append(el('h3','','SOS in this scene'+(actor?' · '+actor.name:'')));
  const grid=el('div','ost-settings');
  [['bend','Bend','−10 to 9, this scene only',1],['scale','Scale','0.5× to 2×, this scene only',1]].forEach(row=>{
   const value=el('span','ost-value ost-stepper-value');value.dataset.sos=row[0];
   const r=settingRow(row[1],row[2],stepper(value,()=>sosAction(row[0],-row[3]),()=>sosAction(row[0],row[3]),()=>sosAction(row[0],0,true)));
   r.classList.add('ost-adjust');grid.append(r);
  });
  box.append(grid,el('p','ost-help','OStim’s own per-actor bend and scale for THIS scene — separate from the SOS size slider below, which SOS keeps afterwards. Bend runs −10 to 9; scale is clamped to 0.5× – 2×.'));
  return box;
 }

 window.osToolsResult=function(raw){let j;try{j=typeof raw==='string'?JSON.parse(raw):raw;}catch(e){return;}const p=j&&pending.get(j.request);if(!p||(!modal&&!p.detached))return;clearTimeout(p.timer);pending.delete(j.request);p.cb(j);};
 /* Key handling. Floating, the modal owns Escape and traps Tab. HOSTED it
    owns NEITHER: Escape must close the palette and Tab must walk the deck's
    own focus ring, so the window listener stands down entirely and app.js
    calls onKey() instead — the Household/Followers pane contract. */
 function paneKey(e){
  if(!modal||!hosted)return false;
  /* Ctrl-K before the popout check: it is the way OUT of wherever you are. */
  if((e.ctrlKey||e.metaKey)&&(e.key==='k'||e.key==='K')){if(pop)closePop();return focusFind();}
  if(pop)return true;   // the popout's own capture listener has it
  if(e.target&&e.target._ostKey&&e.target._ostKey(e))return true;
  if(e.key==='Enter'&&e.target&&e.target._ostEnter){e.target._ostEnter();return true;}
  return false;
 }
 window.addEventListener('keydown',function(e){if(!modal||hosted||e.__ostHandled)return;if((e.ctrlKey||e.metaKey)&&(e.key==='k'||e.key==='K')){if(pop)closePop();if(focusFind()){e.preventDefault();e.stopImmediatePropagation();}return;}if(pop)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();return;}if(e.key==='Tab'){const nodes=Array.from(q('button,input,summary,[role=slider]')).filter(n=>!n.disabled&&!n.hidden&&(!n.closest('details')||n.tagName==='SUMMARY'||n.closest('details').open));const i=nodes.indexOf(document.activeElement);e.preventDefault();e.stopImmediatePropagation();if(nodes.length)nodes[(i+(e.shiftKey?nodes.length-1:1))%nodes.length].focus();return;}e.stopPropagation();if(e.target._ostKey&&e.target._ostKey(e)){e.preventDefault();return;}if(e.key==='Enter'&&e.target._ostEnter){e.preventDefault();e.target._ostEnter();return;}if((e.key==='Enter'||e.key===' ')&&e.target.tagName==='BUTTON'){e.preventDefault();e.target.click();}},true);
 window.addEventListener('hd-animation-user-changed',()=>{if(modal){if(pendingFavorite){pendingFavorite=false;favoriteCurrent();}else if(!tab||tab==='library'||tab==='expr')render();}});
 /* The Character tab's snapshot landed — the player's face is available now. */
 window.addEventListener('hd-charsheet-data',()=>{if(modal)repaintPortraits();});
 window.addEventListener('hd-portrait-crops-changed',()=>{if(modal&&(!tab||tab==='align'||tab==='expr'||tab==='people'||tab==='lighting'))render();});
 /* ONE catalogue, TWO surfaces: the deck-wide Command-F (HDOmni) and this
    page's own Ctrl-K bar (Rober, 2026-09-22: "its also missing a command
    k dedeicated seazrch bar on the page"). It used to be inline in the
    register() call, so the on-page search could not see it without
    duplicating every row -- and a duplicated list is a list that drifts.
    [label, segment, keywords] */
 const ACTIONS=[
  /* EVERY function on this page, reachable from Command-F (Rober,
     2026-09-21: "needs to be fully command f searchable all functions").
     One row per thing you can DO, not one per segment — a player looking
     for "undress" should not have to know it lives under Participants.
     [label, segment, keywords] */
  ['Stop the scene','','end stop finish quit scene — in the hero dock'],
  ['Scene speed','','faster slower speed pace tempo step — in the hero dock'],
  ['Auto or manual pacing','','auto manual ai pacing automatic — in the hero dock'],
  ['Free camera','','tfc camera fly photo look around — in the hero dock'],
  ['Favorite current scene','library','star save bookmark current'],
  ['Back to previous scene','library','undo previous last revert scene'],
  ['Browse scenes','library','search find animation library all scenes'],

  ['Participants','people','actors who is in the scene people cast'],
  ['Undress a participant','people','undress redress strip naked bare clothes slot armour armor'],
  ['Undress fully','people','strip naked bare remove all clothes'],
  ['Put clothing back','people','redress dress restore clothes put back'],
  ['Take or return weapons','people','weapons sword remove return disarm'],
  ['Scene voices','people','voice voiceset moan sound audio which actor has which'],
  ['Mute or unmute a participant','people','mute unmute silence voice audio'],
  ['Restore scene clothing','people','redress restore clothes OStim removed'],
  ['SOS size','people','schlong size sos scale grow shrink participant'],
  ['SOS bend and scale','people','sos bend scale schlong angle per scene'],

  ['Add someone to the scene','cast','join add third participant threesome bring invite migrate'],
  ['Remove someone from the scene','cast','part leave drop participant migrate'],

  ['Move scene to other furniture','move','furniture relocate bed chair bench table move'],
  ['The furniture you are on','move','here current bed which furniture am i on'],
  ['Move the scene to the floor','move','floor ground off the bed'],
  ['Search furniture further away','move','radius range far whole building upstairs floor'],
  ['Highlight a piece of furniture','move','glow show where find highlight'],

  ['Room privacy and invitations','room','privacy private automatic invited guests CHIM witnesses'],
  ['Clear the room','room','get away from me empty privacy move them out alone bystanders kick'],
  ['Bring everyone back','room','restore return undo cleared room bring back'],

  ['Scene expressions','expr','face expression preview favorites automatic emotion'],
  ['Give OStim back the expressions','expr','clear reset return expression automatic'],

  ['Scene lighting','lighting','light lights facelight quick light relight brightness colour color studio'],
  ['Light or darken faces','lighting','face light bright dark facelight'],
  ['Your carried light','lighting','quick light lantern torch carried'],
  ['ReLight — world lighting','lighting','relight world lights candles sconces lanterns merge flicker glow orbs exclude'],
  ['Exclude a light from ReLight','lighting','relight exclude ignore skip this light candle crosshair'],

  ['Scene camera and photos','camera','photo fov zoom screenshot free camera picture'],
  ['Take a scene photo','camera','photo picture capture screenshot camera'],
  ['Saved scene photos','camera','gallery photos pictures saved browse'],

  ['Scene alignment','align','position rotation offset nudge reset align'],
  ['Adjust alignment live over the scene','align','overlay live non pausing arrows nudge align unpaused'],

  ['PPA physics settings','ppa','procedural penis animations accurate penetration collision toml physics'],

  ['Scene favorites and recent','library','collection history saved starred recent'],
  ['Swap roles','people','dom sub swap switch roles reverse participants'],
  ['Change skin','people','skin skins pack texture appearance body'],
  ['Equip bondage','people','zaz bondage restraints rope cuffs gag appearance'],
  ['Equip liquids','people','liquid liquids cum fluids wet appearance effects'],
  ['Oil skin','people','oil oiled shiny skin appearance'],
  ['Applied effects','people','effects remove clear applied appearance spells'],
  ['Body physics','people','body physics cbpc smp jiggle appearance'],
  ['Scene collections','library','collection folder group organise organize tag'],

  ['OStim quick toggles','options','end after climax orgasm male female undress furniture auto mode dom sub role switches mcm'],
  ['End the scene after climax','options','orgasm climax end finish after male female all player'],
  ['Who leads the scene','options','dom sub dominant submissive role aggressor straight gay'],
  ['Undressing rules','options','undress start mid scene partial weapons wigs strap'],
  ['OStim settings','options','ostim auto manual options settings menu mcm']
 
 ];
 if(window.HDOmni)HDOmni.register({id:'ostim-tools',label:'OStim controls',index:()=>ACTIONS.map(a=>({label:a[0],detail:'OStim · '+a[2],keywords:'ostim scene '+a[2],kind:'action',icon:'icons/custom/seg-ostim.png',jump:()=>{
   // Prefer the dedicated tab when the deck has it (OStim present); fall
   // back to the floating modal so this still works with the tab gated off.
   // __hdFlagAbsent is the cross-file gate accessor (app.js's `state` is not
   // visible from this IIFE); unknown/missing reads as "not absent", so an
   // older DLL still routes to the tab rather than silently falling back.
   if(window.ScenePane&&typeof window.hdShowTab==='function'&&
      !(window.__hdFlagAbsent&&window.__hdFlagAbsent('ostim'))){ScenePane.show(a[1]);hdShowTab('scene');}
   else open(a[1]);if(a[0]==='Favorite current scene')request('state',{},j=>{snapshot=j;favoriteCurrent();});}}))});
 return {startFor,open,close,mount,showOnTab,onKey:paneKey,positionIcon,positionArt,positionReference,isOpen:()=>!!modal,isHosted:()=>hosted,segments:()=>SEGMENTS.slice(),showSegment:switchTab,portraitIds:()=>{
  if(!modal)return[];
  const ids=[],seen={};
  const add=f=>{if(typeof f!=='number')return;const h='0x'+f.toString(16);if(!seen[h]){seen[h]=1;ids.push(h);}};
  (snapshot.actors||[]).forEach(a=>add(a.formId));
  /* Everyone the OPEN popout is drawing a face for, not just the cast:
     whoever paints icons/npcs must collect, or those rows sit on initials
     for ever (the Household-tab bug, faceConsumerActive law). */
  if(tab==='cast')castRows.forEach(r=>add(r.formId));
  if(tab==='room'){held.concat(rows,privacy.rows||[],privacy.held||[],privacy.invited||[]).forEach(r=>add(r.formId));}
  return ids;
 },portraitsChanged:repaintPortraits,_pickDensity:pickDensity,_fit:fitToViewport,_state:()=>({snapshot,rows,tab})};
})();
