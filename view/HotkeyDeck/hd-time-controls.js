/* time-calendar-waits: one calendar and confirmation flow for Home and Time. */
(function () {
  'use strict';
  var MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];
  var DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
  var LIMITS = {hours:168, days:365, weeks:52, months:12};
  var views = [], clock = null, busy = false, message = '';
  function wrap(h) { return ((Number(h) % 24) + 24) % 24; }
  function valid(d) { return d && Number.isFinite(d.hour) && d.hour >= 0 && d.hour <= 8784 && Number.isInteger(d.month) && d.month >= 0 && d.month < 12 && Number.isInteger(d.day) && d.day >= 1 && d.day <= DAYS[d.month] && Number.isInteger(d.year); }
  function advance(d,h) {
    var n = Object.assign({},d); n.hour += h;
    while (n.hour >= 24) { n.hour -= 24; if (++n.day > DAYS[n.month]) { n.day=1; if (++n.month===12) { n.month=0; ++n.year; } } }
    n.daysPassed = Number(d.daysPassed || 0) + h/24;
    return n;
  }
  function until(h,target) { var n=wrap(target-wrap(h)); return n<0.0001 ? 24 : n; }
  function hours(d, amount, unit) {
    if (!valid(d) || !Object.prototype.hasOwnProperty.call(LIMITS,unit) || !Number.isInteger(amount) || amount<1 || amount>LIMITS[unit]) return null;
    if (unit==='months') {
      var days=Math.min(d.day,DAYS[(d.month+amount)%12])-d.day;
      for(var i=0;i<amount;i++) days+=DAYS[(d.month+i)%12];
      return days*24;
    }
    return amount * ({hours:1,days:24,weeks:168}[unit]);
  }
  function fmtClock(h) { h=wrap(h); var whole=Math.floor(h), minute=Math.floor((h-whole)*60+0.00001); return (whole%12||12)+':'+(minute<10?'0':'')+minute+(whole<12?' AM':' PM'); }
  function fmtDate(d) { return d.day+' '+MONTHS[d.month]+' · 4E '+d.year; }
  function span(h) { return h>=24 && h%24===0 ? h/24+' day'+(h===24?'':'s') : Math.round(h*10)/10+' hours'; }
  function selection(v) {
    if (!clock || !valid(clock)) return null;
    var h=v.target==null ? hours(clock,Number(v.amount.value),v.unit.value) : until(clock.hour,v.target);
    return h==null ? null : {hours:h,end:advance(clock,h),label:v.target==null ? v.amount.value+' '+v.unit.value.replace(/s$/,Number(v.amount.value)===1?'':'s') : 'until '+fmtClock(v.target)};
  }
  function render(v) {
    var plan=selection(v), pending=clock && (clock.pending || clock.hour>=24);
    v.amount.max=LIMITS[v.unit.value];
    v.amount.disabled=busy; v.unit.disabled=busy;
    v.root.querySelectorAll('[data-hour],[data-preset]').forEach(function(b){
      b.disabled=busy;
      var target=b.getAttribute('data-hour');
      if(target!==null) { var sub=b.querySelector('small'); sub.textContent=clock ? 'in '+span(until(clock.hour,Number(target))) : 'Reading clock…'; b.setAttribute('aria-pressed',String(v.target===Number(target))); }
    });
    v.arrival.textContent=plan ? fmtClock(plan.end.hour)+' · '+fmtDate(plan.end) : 'Choose a valid duration';
    v.detail.textContent=plan ? (v.unit.value==='months' && v.target==null ? 'Calendar months; shorter months use their last day. ' : '')+span(plan.hours)+' will pass.' : 'Enter a whole number from 1 to '+LIMITS[v.unit.value]+'.';
    if (pending) { v.arrival.textContent='Previous wait is pending'; v.detail.textContent='No additional time will be added.'; }
    v.go.textContent=pending ? 'Finish previous wait' : busy ? 'Advancing time…' : plan ? 'Wait '+plan.label : 'Wait';
    v.go.disabled=busy || !clock || (!plan && !pending);
    v.status.textContent=message || (pending ? 'The previous wait is still pending. Resume the game to finish it.' : 'Confirming closes SkyManager and resumes the game. This advances time; it does not grant sleep benefits.');
  }
  function renderAll() { views.forEach(render); }
  function receive(raw) {
    var d; try { d=typeof raw==='string'?JSON.parse(raw):raw; } catch (_) { return; }
    clock=valid(d)?d:null;
    // An authoritative fresh snapshot after reopening releases the single-flight guard.
    busy=false; message=''; renderAll();
  }
  function result(raw) {
    var r; try { r=typeof raw==='string'?JSON.parse(raw):raw; } catch (_) { return; }
    if (!r) return;
    if (!r.ok) { busy=false; message=r.msg||'Could not wait here.'; }
    else { message='Time advance accepted. Returning to the game…'; }
    renderAll();
  }
  function mount(root,send) {
    if (!root) return null;
    if (root._timeControl) return root._timeControl;
    root.classList.add('tw-control');
    root.innerHTML='<div class="tw-label">Choose how long</div><div class="tw-duration"><label>Amount<input class="tw-amount" type="number" min="1" max="365" step="1" value="1" inputmode="numeric"></label><label>Unit<select class="tw-unit"><option value="hours">Hours</option><option value="days" selected>Days</option><option value="weeks">Weeks</option><option value="months">Calendar months</option></select></label></div><div class="tw-presets"><button data-preset="1:hours">1 hour</button><button data-preset="1:days">1 day</button><button data-preset="1:weeks">1 week</button><button data-preset="1:months">1 month</button></div><div class="tw-label">Or the next time of day</div><div class="tw-until">'+[[7,'Morning','wx-clear'],[12,'Noon','wx-clear'],[18,'Evening','wx-cloudy'],[22,'Night','wx-clear-night']].map(function(x){return '<button data-hour="'+x[0]+'" aria-pressed="false"><img src="icons/custom/'+x[2]+'.png" width="28" height="28" alt=""><span>'+x[1]+'<small>Reading clock…</small></span></button>';}).join('')+'</div><div class="tw-confirm"><div><div class="tw-label">Arrive at</div><strong class="tw-arrival"></strong><div class="tw-detail"></div></div><button class="tw-go" type="button">Wait</button></div><div class="tw-status" role="status"></div>';
    var v={root:root,amount:root.querySelector('.tw-amount'),unit:root.querySelector('.tw-unit'),arrival:root.querySelector('.tw-arrival'),detail:root.querySelector('.tw-detail'),go:root.querySelector('.tw-go'),status:root.querySelector('.tw-status'),target:null};
    v.amount.value='1'; v.unit.value='days';
    root._timeControl=v; views.push(v);
    function changed(){ v.target=null; message=''; render(v); }
    v.amount.addEventListener('input',changed); v.unit.addEventListener('change',changed);
    root.addEventListener('keydown',function(e){ if(e.target.matches('input,select')) e.stopPropagation(); });
    root.addEventListener('click',function(e){
      var b=e.target.closest('button'); if(!b || busy) return;
      if(b.hasAttribute('data-preset')) { var p=b.getAttribute('data-preset').split(':'); v.amount.value=p[0]; v.unit.value=p[1]; changed(); }
      else if(b.hasAttribute('data-hour')) { v.target=Number(b.getAttribute('data-hour')); message=''; render(v); }
      else if(b===v.go) {
        if (clock && (clock.pending || clock.hour>=24)) { busy=true; renderAll(); send('tmWait',JSON.stringify({resume:true})); return; }
        var p=selection(v); if(!p || !clock) return;
        busy=true; message='Sending wait…'; renderAll();
        // Native calculates again from its current clock, so an old preview cannot target the wrong day.
        send('tmWait',JSON.stringify(v.target==null ? {amount:Number(v.amount.value),unit:v.unit.value} : {until:v.target}));
      }
    });
    render(v); return v;
  }
  var oldInfo=window.tmInfo, oldResult=window.tmResult;
  window.tmInfo=function(p){receive(p);if(typeof oldInfo==='function') oldInfo(p);};
  window.tmResult=function(p){result(p);if(typeof oldResult==='function') oldResult(p);};
  window.HDTimeControls={mount:mount,receive:receive,result:result,advance:advance,hours:hours,until:until,fmtClock:fmtClock,fmtDate:fmtDate,valid:valid};
})();
