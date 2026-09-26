/* wardrobe-studio-nav: shared task navigation for Skyrim and the phone Portal. */
(function () {
  'use strict';
  const GROUPS = [
    { id: 'collection', label: 'Collection', icon: 'hm-wardrobe.png' },
    { id: 'people', label: 'People', icon: 'hm-followers.png' },
    { id: 'dock', label: 'Favorites dock', icon: 'hm-loadouts.png' },
  ];
  const SECTIONS = {
    outfits: { group: 'collection', label: 'Outfits', hint: 'Your saved looks. Wear one, photograph it, or add it to a wardrobe pool.', search: 'Search outfits, categories and notes…', terms: 'clothes looks saved sets what to wear' },
    wardrobes: { group: 'collection', label: 'Wardrobe pools', hint: 'A pool holds several outfits for someone to rotate through.', search: 'Search wardrobe pools and their outfits…', terms: 'wardrobes pools collections groups rotation' },
    flair: { group: 'collection', label: 'Flair sets', hint: 'Accessory combinations to layer over an outfit.', search: 'Search Flair sets…', terms: 'flair accessories rings necklaces hoods cloaks layer' },
    inventory: { group: 'collection', label: 'Outfit builder', hint: 'Pick equipment from your inventory to create a saved outfit.', search: 'Search equipment by name, slot or mod…', terms: 'inventory armour armor pieces items build new outfit basket' },
    npcs: { group: 'people', label: 'Who wears what', hint: 'Choose a person to set their usual look, outfit rotation and bed outfit.', search: 'Search people and what they wear…', terms: 'people npcs followers dress assign sleeping bed' },
    spid: { group: 'people', label: 'Always-equipped gear', hint: 'Give someone pieces they should keep wearing. Managed by SPID.', search: 'Search people and enforced gear…', terms: 'spid distribution rules grants enforce permanent gear' },
    dock: { group: 'dock', label: 'Favorites dock', hint: 'Keep your favorite looks close at hand. The dock appears when you summon it.', search: 'Search outfits and wardrobe pools…', terms: 'favorites favourites quick equip widget hotkey categories placement' },
  };
  function canonical(id) { return id === 'people' ? 'npcs' : id; }
  function section(id, label) {
    return SECTIONS[canonical(id)] || { group: 'collection', label: label || id, hint: '', search: 'Search ' + (label || id) + '…', terms: '' };
  }
  function node(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  let active = null;
  function close(focus) { if (active) active.close(focus); }
  // wardrobe-quiet-menu: one searchable door; full-size controls only when needed.
  function picker(host, options) {
    const state = options.state || {}, hadFocus = host.contains(document.activeElement);
    if (active && active.host === host) { active = null; }
    host.textContent = ''; host.classList.add('ws-picker');
    const id = (host.id || 'wardrobe-picker') + '-menu';
    const trigger = node('button', 'ws-trigger'); trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', id);
    trigger.setAttribute('aria-label', options.label + ': ' + options.title);
    if (options.icon) {
      const img = node('img'); img.src = options.icon; img.alt = ''; img.width = 24; img.height = 24;
      img.onerror = () => { img.style.display = 'none'; }; trigger.append(img);
    }
    trigger.append(node('span', 'ws-current', options.title));
    if (options.count != null) trigger.append(node('span', 'ws-count', String(options.count)));
    const chevron = node('span', 'ws-chevron', '›'); chevron.setAttribute('aria-hidden', 'true'); trigger.append(chevron);
    const panel = node('div', 'ws-menu'); panel.id = id; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', options.label);
    const search = node('input', 'ws-filter'); search.type = 'search'; search.autocomplete = 'off'; search.spellcheck = false;
    search.name = id + '-search'; search.placeholder = options.search; search.setAttribute('aria-label', options.search); search.value = state.q || '';
    const list = node('div', 'ws-results');
    panel.append(search, list); host.append(trigger, panel);
    const controller = {host, trigger, panel, search, state, close(focus) {
      state.open = false; state.q = ''; search.value = ''; panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false'); if (active === controller) active = null;
      if (focus) trigger.focus();
    }};
    function paint() {
      list.textContent = '';
      list.scrollTop = 0;
      const q = search.value.trim().toLowerCase(); state.q = search.value;
      const rows = options.items.filter(item => !q || [item.label,item.hint,item.terms,item.group].join(' ').toLowerCase().includes(q));
      let group = '';
      rows.forEach(item => {
        const divider = group && item.group && item.group !== group;
        if (item.group) group = item.group;
        const b = node('button', 'ws-choice' + (item.id === options.current ? ' is-current' : '') + (divider ? ' ws-group-start' : ''));
        b.type = 'button'; b.dataset.section = item.id;
        b.setAttribute('aria-pressed', item.id === options.current ? 'true' : 'false');
        const text = node('span', 'ws-choice-text'); text.append(node('span', 'ws-choice-title', item.label));
        b.title = item.hint || item.label;
        b.append(text); if (item.count != null) b.append(node('span', 'ws-count', String(item.count)));
        if (options.decorate) options.decorate(b, item);
        b.addEventListener('click', e => {
          if (e.stopPropagation) e.stopPropagation();
          controller.close(false); options.select(item.id);
          const nextHost = (host.id && document.getElementById(host.id)) || host;
          const next = nextHost.querySelector('.ws-trigger'); if (next) next.focus();
        }); list.append(b);
      });
      if (!rows.length) list.append(node('p', 'ws-no-results', 'No matches. Try a different name.'));
    }
    if (options.manage) {
      const manage = node('button', 'ws-manage', options.manage.label); manage.type = 'button';
      manage.addEventListener('click', () => { controller.close(false); options.manage.run(); }); panel.append(manage);
    }
    function fit() {
      if (!panel.getBoundingClientRect) return;
      const bounds = host.closest('#wd-pane'), rect = panel.getBoundingClientRect();
      const box = bounds ? bounds.getBoundingClientRect() : {left:0,right:window.innerWidth,bottom:window.innerHeight};
      const bottom = box.bottom;
      const scale = panel.offsetWidth ? rect.width / panel.offsetWidth : 1;
      panel.style.maxHeight = Math.max(44, Math.min(430, (bottom - rect.top - 14) / (scale || 1))) + 'px';
      panel.style.minWidth = '0';
      panel.style.maxWidth = Math.max(44, (box.right - box.left - 28) / (scale || 1)) + 'px';
      const placed = panel.getBoundingClientRect(), anchor = host.getBoundingClientRect();
      if (placed.left < box.left + 14 || placed.right > box.right - 14) {
        panel.style.right = 'auto';
        panel.style.left = (Math.max(box.left + 14, Math.min(placed.left, box.right - 14 - placed.width)) - anchor.left) / (scale || 1) + 'px';
      }
    }
    function open(focus) {
      if (active && active !== controller) active.close(false);
      state.open = true; panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); active = controller;
      paint(); fit(); if (focus) search.focus();
    }
    trigger.addEventListener('click', () => state.open ? controller.close(false) : open(true));
    // Portal category rows remain drop targets even when their menu starts closed.
    if (options.decorate) {
      trigger.addEventListener('dragenter', () => { if (!state.open) open(false); });
      trigger.addEventListener('dragover', e => { e.preventDefault(); if (!state.open) open(false); });
    }
    search.addEventListener('input', paint);
    paint(); panel.hidden = !state.open; trigger.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    if (state.open) open(hadFocus);
    return controller;
  }
  function key(e) {
    if (!active) return false;
    if (!document.body.contains(active.host)) { active.close(false); return false; }
    const menu = active, focused = document.activeElement;
    const rows = Array.from(menu.panel.querySelectorAll('.ws-choice'));
    let handled = false;
    if (e.key === 'Escape') { menu.close(true); handled = true; }
    else if (menu.host.contains(focused)) {
      const index = rows.indexOf(focused);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = e.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : (index < 0 ? rows.length - 1 : index - 1);
        if (next < 0) menu.search.focus(); else if (rows[next]) rows[next].focus(); handled = true;
      } else if (e.key === 'Enter' && focused === menu.search) { if (rows[0]) rows[0].click(); handled = true; }
    }
    if (handled) { if (e.preventDefault) e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else if (e.stopPropagation) e.stopPropagation(); }
    return handled;
  }
  if (window.addEventListener) window.addEventListener('keydown', key, true);
  document.addEventListener('mousedown', e => { if (active && !active.host.contains(e.target)) active.close(false); }, true);
  document.addEventListener('touchstart', e => { if (active && !active.host.contains(e.target)) active.close(false); }, true);
  document.addEventListener('focusin', e => { if (active && !active.host.contains(e.target)) active.close(false); });
  function mount(host, options) {
    const order = Object.keys(SECTIONS), labels = options.labels || {}, counts = options.counts || {};
    const rank = id => order.indexOf(canonical(id)) < 0 ? order.length : order.indexOf(canonical(id));
    const ids = (options.available || []).slice().sort((a,b) => rank(a)-rank(b));
    const current = section(options.current, labels[options.current]);
    const group = GROUPS.find(g => g.id === current.group) || GROUPS[0];
    host.classList.add('ws-nav');
    const memory = options.memory || {};
    const menu = picker(host, {
      label: 'Wardrobe tools', title: current.label, current: options.current, count: counts[options.current],
      icon: (options.image || (p => p))('icons/custom/' + group.icon),
      search: 'Find a Wardrobe tool…', state: memory.menu || (memory.menu = {}), select: options.select,
      items: ids.map(id => { const item = section(id, labels[id]); return {
        id, label: item.label, hint: item.hint, terms: item.terms,
        count: counts[id], group: (GROUPS.find(g => g.id === item.group) || GROUPS[0]).label,
      }; }),
    });
    // wardrobe-toolbar-fold: the section menu stays reachable above hidden controls.
    if (options.toolbar) {
      const bar = options.toolbar, folded = !!bar.collapsed;
      const button = node('button', 'ws-fold' + (bar.filtered ? ' has-filter' : ''));
      button.type = 'button'; button.append(node('span', '', 'Controls'));
      const arrow = node('span', 'ws-chevron', '›'); arrow.setAttribute('aria-hidden', 'true'); button.append(arrow);
      button.setAttribute('aria-expanded', folded ? 'false' : 'true');
      button.setAttribute('aria-controls', bar.controls);
      button.title = (folded ? 'Show' : 'Hide') + ' Wardrobe controls' + (bar.filtered ? ' — filters active' : '');
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => {
        close(false); bar.toggle(!folded);
        const nextHost = (host.id && document.getElementById(host.id)) || host;
        const next = nextHost.querySelector('.ws-fold'); if (next) next.focus();
      });
      host.append(button);
    }
    return menu;
  }
  function filter(host, options) {
    const selected = options.categories.find(c => c.id === options.current);
    host.classList.add('ws-category-filter');
    return picker(host, {
      label: 'Filter categories', title: selected ? selected.name : 'All categories', current: options.current || '',
      search: 'Find a category…', state: options.state, select: options.select, decorate: options.decorate, manage: options.manage,
      items: [{id:'',label:'All categories',count:options.total}].concat(options.categories.map(c => ({id:c.id,label:c.name,count:c.count}))),
    });
  }
  window.WardrobeNav = { mount, filter, section, canonical, close, key };
})();
