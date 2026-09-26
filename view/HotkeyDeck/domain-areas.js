/* domain-area-photos: shared sub-area photo strip and body-anchored browser. */
(function () {
  'use strict';
  let popup = null, tip = null;
  const strips = new Set();
  const sizes = window.ResizeObserver ? new ResizeObserver(entries => entries.forEach(e => e.target.fit())) : null;
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function button(cls, text, run) { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', run); return b; }
  /* domain-full-cards: presentation preferences never change saved mark identities. */
  function normalizeView(raw) {
    raw = raw || {};
    return {view:['domains','subdomains','all'].includes(raw.view) ? raw.view : 'domains',
      sort:['order','name','parent'].includes(raw.sort) ? raw.sort : 'order'};
  }
  function readView(key) { try { return normalizeView(JSON.parse(localStorage.getItem(key))); } catch (_) { return normalizeView(); } }
  function saveView(key, value) { try { localStorage.setItem(key, JSON.stringify(normalizeView(value))); } catch (_) {} }
  function cardRows(marks, options) {
    options = options || {};
    const prefs = normalizeView(options), byId = new Map(marks.map(m => [m.id,m]));
    const rows = marks.map((m,index) => {
      const p = byId.get(m.parentId), parent = p && p !== m && !p.parentId ? p : null;
      return {m,parent,child:!!parent,fullCard:!!parent,hasKids:false,expanded:false,index};
    }).filter(r => (prefs.view === 'all' || (prefs.view === 'subdomains' ? r.child : !r.child)) &&
      (!options.category || (r.parent || r.m).category === options.category) &&
      (!options.matches || options.matches(r.m,r.parent)));
    if (prefs.sort !== 'order') rows.sort((a,b) => {
      if (prefs.sort === 'parent') {
        const family = String((a.parent || a.m).name || '').localeCompare(String((b.parent || b.m).name || ''));
        if (family) return family;
        if (a.child !== b.child) return a.child ? 1 : -1;
      }
      return String(a.m.name || '').localeCompare(String(b.m.name || '')) || a.index-b.index;
    });
    return rows;
  }
  function viewControls(value, changed) {
    const prefs = normalizeView(value), group = el('div','dsa-view-controls');
    group.setAttribute('role','group'); group.setAttribute('aria-label','Domain display');
    [['view','View',[['domains','Domains'],['subdomains','Subdomains'],['all','All places']]],
      ['sort','Sort',[['order','My order'],['name','Name A–Z'],['parent','Parent domain']]]].forEach(([key,title,choices]) => {
      const label = el('label','',title), select = el('select','dsa-view-select');
      select.dataset.domainView = key; select.setAttribute('aria-label',title === 'View' ? 'Domain view' : 'Sort domains');
      choices.forEach(([id,name]) => {const option=el('option','',name); option.value=id; select.append(option);});
      select.value=prefs[key]; select.addEventListener('change',()=>{prefs[key]=select.value; changed(normalizeView(prefs),key);});
      label.append(select); group.append(label);
    });
    return group;
  }
  function hideTip() { if (tip) tip.remove(); tip = null; }
  function showTip(anchor, name) {
    hideTip(); tip = el('div', 'dsa-tip', name); tip.setAttribute('role', 'tooltip'); document.body.append(tip);
    const a = anchor.getBoundingClientRect(), r = tip.getBoundingClientRect();
    tip.style.left = Math.max(12, Math.min(a.left + (a.width - r.width) / 2, window.innerWidth - r.width - 12)) + 'px';
    tip.style.top = Math.max(12, a.top - r.height - 8) + 'px';
  }
  function photo(area, options, onLoad) {
    const frame = el('span', 'dsa-photo'), fallback = el('span', 'dsa-fallback');
    fallback.setAttribute('aria-hidden', 'true'); frame.append(fallback);
    const initials = () => { fallback.textContent = String(area.name || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0]).join(''); };
    if (options.fallback) {
      const icon = el('img'); icon.src = options.fallback; icon.alt = ''; icon.width = 28; icon.height = 28; icon.addEventListener('error', initials); fallback.append(icon);
    } else initials();
    const sources = options.images ? options.images(area).filter(Boolean) : [];
    if (sources.length) {
      const img = el('img', 'dsa-image'); img.alt = ''; img.width = 96; img.height = 96; img.draggable = false;
      let index = 0;
      img.addEventListener('error', () => { if (++index < sources.length) img.src = sources[index]; else img.remove(); });
      // Only a picture that really drew may promise anything (same law as the card's ⛶).
      img.addEventListener('load', () => { frame.classList.add('has-photo'); if (onLoad) onLoad(img.src); });
      img.src = sources[0]; frame.append(img);
    }
    return frame;
  }
  /* ---- lightbox: the row photo, big, above the browser (Rober, 2026-09-26:
     "larger image and or click to lightbox would be nice too"). It is the
     module's own so the deck and the Portal get the same one, and so it can
     sit ABOVE .dsa-overlay — the deck's place lightbox is z-index 60 and
     would open behind the browser. Escape closes the lightbox only; the
     browser stays where it was. Arrows step through the sub-area's album
     when the host supplies one (options.photos), else it shows the one shot. */
  let lb = null;
  function album(area, options, current) {
    const list = (options.photos ? options.photos(area) || [] : []).filter(p => p && p.src).map(p => ({src:String(p.src), label:String(p.label || '')}));
    if (!list.length && current) list.push({src:current, label:''});
    let at = list.findIndex(p => p.src === current); if (at < 0) at = 0;
    return {list, at};
  }
  function closeLightbox(focus) {
    if (!lb) return;
    const old = lb; lb = null; old.root.remove();
    if (focus && old.opener && document.body.contains(old.opener)) old.opener.focus();
  }
  function lightbox(area, options, current, opener) {
    closeLightbox(false);
    const state = album(area, options, current); if (!state.list.length) return null;
    const root = el('div', 'dsa-lightbox'), fig = el('figure', 'dsa-lb-fig'), img = el('img', 'dsa-lb-img');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Photo of ' + area.name);
    img.draggable = false; fig.append(img);
    const bar = el('div', 'dsa-lb-bar'), cap = el('figcaption', 'dsa-lb-cap'); cap.setAttribute('aria-live', 'polite');
    const prev = button('dsa-action dsa-lb-nav', '‹', () => step(-1)), next = button('dsa-action dsa-lb-nav', '›', () => step(1));
    prev.setAttribute('aria-label', 'Previous photo'); next.setAttribute('aria-label', 'Next photo');
    const done = button('dsa-close', 'Close', () => closeLightbox(true));
    const many = state.list.length > 1;
    if (many) bar.append(prev); bar.append(cap); if (many) bar.append(next); bar.append(done);
    root.append(fig, bar); document.body.append(root);
    lb = {root, opener: opener || document.activeElement, step};
    function show() {
      const p = state.list[state.at];
      img.src = p.src; img.alt = p.label || area.name;
      cap.textContent = area.name + (p.label ? ' · ' + p.label : '') + (many ? ' · ' + (state.at + 1) + ' of ' + state.list.length : '');
    }
    function step(d) { if (!many) return; state.at = (state.at + d + state.list.length) % state.list.length; show(); }
    root.addEventListener('mousedown', e => { if (e.target === root || e.target === fig) closeLightbox(true); });
    show(); done.focus(); return root;
  }
  function close(focus) {
    closeLightbox(false);
    if (!popup) return;
    const old = popup; popup = null; old.root.remove(); hideTip();
    if (focus && old.opener && document.body.contains(old.opener)) old.opener.focus();
  }
  function open(options, selected, opener) {
    close(false); hideTip();
    const root = el('div', 'dsa-overlay'), card = el('section', 'dsa-dialog');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'dsa-title');
    const head = el('header', 'dsa-head'), titles = el('div', 'dsa-titles');
    const title = el('h2', '', options.parent.name); title.id = 'dsa-title';
    const count = el('p', '', 'Sub-areas · ' + options.items().length);
    titles.append(title, count);
    const done = button('dsa-close', 'Close', () => close(true)); head.append(titles, done);
    const search = el('input', 'dsa-search'); search.type = 'search'; search.placeholder = 'Find a sub-area…'; search.setAttribute('aria-label', 'Find a sub-area'); search.autocomplete = 'off';
    const list = el('div', 'dsa-list');
    card.append(head, search, list); root.append(card); document.body.append(root);
    popup = {root, card, search, opener: opener || document.activeElement, owner: options.owner};
    function paint() {
      list.textContent = '';
      const q = search.value.trim().toLowerCase();
      const matches = options.items().filter(a => [a.name,a.note,a.place,a.cellName].join(' ').toLowerCase().includes(q));
      matches.forEach(a => {
        const row = el('article', 'dsa-area' + (a.id === selected ? ' is-selected' : '')); row.dataset.id = a.id;
        const text = el('div', 'dsa-area-text'); text.append(el('h3', '', a.name));
        if (a.note || a.place || a.cellName) text.append(el('p', '', a.note || a.place || a.cellName));
        const acts = el('div', 'dsa-actions');
        (options.actions(a) || []).forEach((action, i) => {
          const b = button('dsa-action' + (i ? '' : ' dsa-primary'), action.label, () => {
            // Re-resolve against the live child list: a stale row cannot act on a reparented/deleted place.
            const current = options.items().find(x => x.id === a.id); if (!current) { paint(); return; }
            const rect = b.getBoundingClientRect(); close(false); action.run(current, rect);
          }); b.setAttribute('aria-label', action.label + ': ' + a.name); acts.append(b);
        });
        /* The row photo is a big landscape tile and, once it has drawn, a
           button that opens it in the lightbox. Disabled until then — a
           fallback tile has nothing bigger to show. */
        let loaded = '';
        const shot = button('dsa-shot', null, () => { if (loaded) lightbox(a, options, loaded, shot); });
        shot.disabled = true; shot.setAttribute('aria-label', 'View photo: ' + a.name);
        const pic = photo(a, options, src => {
          loaded = src; shot.disabled = false; shot.title = 'View photo — click to enlarge';
          const badge = el('span', 'dsa-shot-zoom', '⛶'); badge.setAttribute('aria-hidden', 'true'); shot.append(badge);
        });
        shot.append(pic);
        row.append(shot, text, acts); list.append(row);
      });
      if (!matches.length) list.append(el('p', 'dsa-empty', 'No matching sub-areas. Try another name.'));
    }
    search.addEventListener('input', paint);
    root.addEventListener('mousedown', e => { if (e.target === root) close(true); });
    paint(); search.focus();
    const selectedRow = Array.from(list.children).find(n => n.dataset.id === selected);
    if (selectedRow && selectedRow.scrollIntoView) selectedRow.scrollIntoView({block:'nearest'});
  }
  function strip(options) {
    const items = options.items(), host = el('div', 'dsa-strip'), previews = el('div', 'dsa-previews');
    host.setAttribute('role', 'group'); host.setAttribute('aria-label', 'Sub-areas of ' + options.parent.name);
    host.addEventListener('mousedown', e => e.stopPropagation());
    host.addEventListener('click', e => e.stopPropagation());
    host.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    items.slice(0, 4).forEach(a => {
      const tile = button('dsa-tile', null, () => open(options, a.id, tile));
      tile.setAttribute('aria-label', 'Browse sub-area: ' + a.name); tile.title = ''; tile.dataset.area = a.id;
      tile.append(photo(a, options));
      tile.addEventListener('mouseenter', () => showTip(tile, a.name)); tile.addEventListener('focus', () => showTip(tile, a.name));
      tile.addEventListener('mouseleave', hideTip); tile.addEventListener('blur', hideTip); previews.append(tile);
    });
    const all = button('dsa-all', null, () => open(options, '', all));
    all.setAttribute('aria-label', 'Browse all ' + items.length + ' sub-areas of ' + options.parent.name); all.title = '';
    all.append(el('span', '', 'Areas ' + items.length), el('span', 'dsa-arrow', '›'));
    host.append(previews, all);
    host.fit = () => {
      const width = previews.clientWidth;
      const count = Math.max(0, Math.floor((width + 8) / 56));
      Array.from(previews.children).forEach((b, i) => { b.hidden = i >= count; });
    };
    strips.add(host); if (sizes) sizes.observe(host); setTimeout(fit, 0); return host;
  }
  function fit() {
    strips.forEach(s => { if (!document.body.contains(s)) { if (sizes) sizes.unobserve(s); strips.delete(s); } else s.fit(); });
  }
  function key(e) {
    if (lb) {
      // The lightbox owns the keyboard while up: Escape closes IT, not the browser under it.
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); lb.step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); lb.step(1); }
      else if (e.key === 'Tab') {
        const b = Array.from(lb.root.querySelectorAll('button:not(:disabled)')), i = b.indexOf(document.activeElement);
        if (b.length) { e.preventDefault(); b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length].focus(); }
      }
      e.stopImmediatePropagation(); return true;
    }
    if (!popup) {
      const focused = document.activeElement;
      if (focused && focused.closest('.dsa-view-controls')) {
        if (e.key === 'Escape') { e.preventDefault(); focused.blur(); }
        e.stopImmediatePropagation(); return true;
      }
      if ((e.key === 'Enter' || e.key === ' ') && focused && focused.closest('.dsa-strip')) { e.stopImmediatePropagation(); return true; }
      return false;
    }
    const p = popup, buttons = Array.from(p.card.querySelectorAll('button:not(:disabled)'));
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') {
      const fields = [buttons[0], p.search].concat(buttons.slice(1)), i = fields.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); fields[fields.length - 1].focus(); }
      else if (!e.shiftKey && (i < 0 || i === fields.length - 1)) { e.preventDefault(); fields[0].focus(); }
    } else if ((e.key === 'Enter' || e.key === 'ArrowDown') && document.activeElement === p.search) {
      e.preventDefault(); const first = p.card.querySelector('.dsa-primary'); if (first) first.focus();
    }
    // Keep every key out of the palette's hotkeys/search; normal field input still works.
    e.stopImmediatePropagation(); return true;
  }
  window.addEventListener('keydown', key, true);
  window.addEventListener('resize', () => { fit(); hideTip(); });
  window.addEventListener('scroll', hideTip, true);
  window.DomainAreas = {strip, open, close, fit, key, lightbox, closeLightbox, normalizeView, readView, saveView, cardRows, viewControls,
    isOpen: () => !!popup, isLightboxOpen: () => !!lb,
    closeOwner: owner => { if (popup && popup.owner === owner) close(false); hideTip(); }};
})();
