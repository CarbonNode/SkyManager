/* domain-photo-gallery: shared in-game/Portal photo album. No file deletion. */
(function (global) {
  'use strict';
  var LIMIT = 128, active = null, previousFocus = null;
  function text(value, cap) { return typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap || 80) : ''; }
  function valid(image) { return typeof image === 'string' && image.length <= 240 && /^domain-images\/[^\\/:?#]+\.(png|jpe?g|webp)$/i.test(image) && image.indexOf('..') < 0; }
  function tags(values) {
    var out = [], seen = {};
    (Array.isArray(values) ? values : []).forEach(function (v) {
      v = text(v, 32); var k = v.toLowerCase();
      if (v && !seen[k] && out.length < 12) { seen[k] = true; out.push(v); }
    }); return out;
  }
  function normalize(values, cover) {
    var out = [], seen = {};
    (Array.isArray(values) ? values : []).forEach(function (p) {
      if (!p || !valid(p.image) || seen[p.image.toLowerCase()] || out.length >= LIMIT) return;
      seen[p.image.toLowerCase()] = true;
      out.push(Object.assign({}, p, {label:text(p.label), tags:tags(p.tags)}));
    });
    if (valid(cover) && !seen[cover.toLowerCase()]) {
      if (out.length >= LIMIT) out.pop();
      out.unshift({image:cover,label:'Original photo',tags:[]});
    } return out;
  }
  function el(tag, cls, content) { var e = document.createElement(tag); if (cls) e.className = cls; if (content !== undefined) e.textContent = content; return e; }
  function button(label, fn, cls) { var b = el('button', cls, label); b.type = 'button'; b.onclick = fn; return b; }
  function close() {
    if (!active) return;
    active.root.remove(); active = null;
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    previousFocus = null;
  }
  function onKey(e) {
    if (!active) return false;
    if (e.key === 'Escape') close();
    else if (e.key === 'Tab') {
      var nodes = Array.from(active.root.querySelectorAll('button:not(:disabled),input:not(:disabled)'));
      var i = nodes.indexOf(document.activeElement);
      if (nodes.length) nodes[(i + (e.shiftKey ? nodes.length - 1 : 1)) % nodes.length].focus();
      e.preventDefault();
    } else if (e.key === 'Enter' && document.activeElement === active.search) {
      var first = active.root.querySelector('.dgal-thumb'); if (first) first.click(); e.preventDefault();
    }
    return true;
  }
  // Capture above the host: typing in an album must never fire deck hotkeys.
  if (global.addEventListener) global.addEventListener('keydown', function(e) {
    if (!onKey(e)) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') e.preventDefault();
  }, true);
  function open(options) {
    close(); previousFocus = document.activeElement;
    var photos = normalize(options.photos, options.cover), cover = options.cover || '', query = '', filter = '', selected = cover;
    var root = el('div','dgal-back'), dialog = el('section','dgal-dialog');
    dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby','dgal-title');
    var header = el('header','dgal-header'), title = el('h2','',options.name + ' · Photos'); title.id = 'dgal-title';
    header.appendChild(title); header.appendChild(button('Close',close)); dialog.appendChild(header);
    var toolbar = el('div','dgal-tools'), search = el('input'); search.type = 'search'; search.placeholder = 'Search photos or tags…'; search.setAttribute('aria-label','Search photos or tags');
    search.oninput = function(){query=search.value.toLowerCase().trim();render();}; toolbar.appendChild(search);
    if (options.onAdd) toolbar.appendChild(button('Take another photo',function(){close();options.onAdd();},'dgal-primary'));
    dialog.appendChild(toolbar);
    var filters=el('div','dgal-filters'); filters.setAttribute('aria-label','Filter photo tags'); dialog.appendChild(filters);
    var body=el('div','dgal-body'), main=el('div','dgal-main'), frame=el('div','dgal-frame'), strip=el('div','dgal-strip'), detail=el('aside','dgal-detail');
    main.appendChild(frame);main.appendChild(strip);body.appendChild(main);body.appendChild(detail);dialog.appendChild(body);
    var status=el('p','dgal-status');status.setAttribute('role','status');dialog.appendChild(status);
    root.appendChild(dialog);root.onclick=function(e){if(e.target===root)close();};document.body.appendChild(root);
    active={root:root,search:search};
    function url(p) { return options.imageUrl ? options.imageUrl(p) : p.image; }
    function publish(op, message) {
      var response = options.onChange && options.onChange(photos.map(function(p){return Object.assign({},p,{tags:p.tags.slice()});}),cover,op);
      render();status.textContent=response || message || 'Saved';
    }
    function render() {
      var available=['Exterior','Interior'];
      photos.forEach(function(p){p.tags.forEach(function(t){if(!available.some(function(a){return a.toLowerCase()===t.toLowerCase();}))available.push(t);});});
      if (filter && !available.some(function(t){return t.toLowerCase()===filter;})) filter='';
      filters.textContent='';
      ['All photos'].concat(available).forEach(function(t,i){var key=i?t.toLowerCase():'';var b=button(t,function(){filter=key;render();},key===filter?'on':'');b.setAttribute('aria-pressed',String(key===filter));filters.appendChild(b);});
      var shown=photos.filter(function(p){return (!filter || p.tags.some(function(t){return t.toLowerCase()===filter;})) && (!query || (p.label+' '+p.tags.join(' ')).toLowerCase().indexOf(query)>=0);});
      if (!shown.some(function(p){return p.image===selected;})) selected=shown.length?shown[0].image:'';
      frame.textContent='';strip.textContent='';detail.textContent='';
      status.textContent=shown.length+' of '+photos.length+' photos';
      var photo=shown.find(function(p){return p.image===selected;});
      if (!photo) {frame.appendChild(el('p','dgal-empty',photos.length?'No photos match. Try another tag or search.':'No photos yet. Take your first shot.'));return;}
      var image=el('img');image.src=url(photo);image.alt=photo.label || options.name;image.onerror=function(){frame.textContent='';frame.appendChild(el('p','dgal-empty','Photo unavailable on this device.'));};frame.appendChild(image);
      shown.forEach(function(p,i){var b=button('',function(){selected=p.image;render();},'dgal-thumb'+(p.image===selected?' selected':''));b.setAttribute('aria-label',(p.label||'Photo '+(i+1))+(p.image===cover?' · Cover':''));b.setAttribute('aria-pressed',String(p.image===selected));var img=el('img');img.src=url(p);img.alt='';img.width=112;img.height=72;b.appendChild(img);b.appendChild(el('span','',p.image===cover?'Cover':p.label||'Photo '+(i+1)));strip.appendChild(b);});
      detail.appendChild(el('h3','',photo.image===cover?'Cover photo':'Photo details'));
      var label=el('input');label.value=photo.label;label.maxLength=80;label.id='dgal-label';
      var ll=el('label','', 'Name');ll.htmlFor=label.id;detail.appendChild(ll);detail.appendChild(label);
      var tagInput=el('input');tagInput.value=photo.tags.join(', ');tagInput.maxLength=420;tagInput.id='dgal-tags';tagInput.placeholder='Interior, Library, Night';
      var tl=el('label','', 'Tags');tl.htmlFor=tagInput.id;detail.appendChild(tl);detail.appendChild(tagInput);detail.appendChild(el('p','dgal-help','Separate tags with commas. A photo can have several.'));
      if (options.onChange) {
        var presets=el('div','dgal-presets');['Exterior','Interior'].forEach(function(t){presets.appendChild(button('+ '+t,function(){tagInput.value=tags(tagInput.value.split(',').concat([t])).join(', ');}));});detail.appendChild(presets);
        detail.appendChild(button('Save details',function(){photo.label=text(label.value);photo.tags=tags(tagInput.value.split(','));publish({op:'details',image:photo.image,label:photo.label,tags:photo.tags},'Photo details saved');},'dgal-primary'));
        var use=button(photo.image===cover?'Current cover':'Use as cover',function(){cover=photo.image;publish({op:'cover',image:photo.image},'Cover updated');});use.disabled=photo.image===cover;detail.appendChild(use);
        detail.appendChild(button('Remove from gallery',function(){photos=photos.filter(function(p){return p.image!==photo.image;});if(cover===photo.image)cover=photos.length?photos[0].image:'';publish({op:'remove',image:photo.image},'Removed from gallery; the original file is kept');},'dgal-remove'));
        detail.appendChild(el('p','dgal-help','Cover changes apply wherever this domain appears. Removing a photo keeps its original file.'));
      } else {label.readOnly=true;tagInput.readOnly=true;}
      if (photo.takenAt) detail.appendChild(el('p','dgal-help',new Date(photo.takenAt*1000).toLocaleDateString()));
    }
    render();search.focus();return root;
  }
  global.DomainGallery={normalize:normalize,tags:tags,valid:valid,limit:LIMIT,open:open,close:close,onKey:onKey,isOpen:function(){return !!active;}};
})(typeof window !== 'undefined' ? window : globalThis);
