/* NPC scene quick access. Presence is per actor, read from OStim's API.
   Actions reuse the existing Effects and OStim bridges. */
window.NpcScene = (function () {
  'use strict';
  const ICON = 'icons/custom/seg-ostim.png';
  let subject = null, status = null, timer = 0, modal = null, opener = null;
  let buttons = [], controls = [];
  const send = (name, arg) => { if (typeof window[name] === 'function') window[name](String(arg || '')); };
  function el(tag, cls, text) {
    const n = document.createElement(tag); n.className = cls || '';
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function action(label, run, icon, detail) {
    const b = el('button', 'nsc-action' + (icon ? ' nsc-tile' : '')); b.type = 'button';
    b.dataset.label = label; b.setAttribute('aria-label', label);
    if (icon) {
      const image = el('img', 'nsc-tile-icon'); image.src = 'icons/custom/' + icon + '.png'; image.alt = '';
      const text = el('span', 'nsc-tile-text');
      text.append(el('span', 'nsc-label', label), el('span', 'nsc-detail', detail));
      b.append(image, text);
    } else b.textContent = label;
    b.addEventListener('click', run); return b;
  }
  function section(title, host) {
    const box = el('section', 'nsc-section');
    const grid = el('div', 'nsc-grid');
    box.append(el('h3', '', title), grid); host.append(box); return grid;
  }
  function poll() {
    clearTimeout(timer); timer = 0;
    buttons = buttons.filter((b) => b.isConnected);
    if (!subject || (!modal && !buttons.length) || !document.body.classList.contains('open')) return;
    send('osActor', JSON.stringify({ formId: subject.formId }));
    timer = setTimeout(poll, 1500);
  }
  function observe(s) {
    const fid = Number(s.formId) >>> 0;
    if (!subject || subject.formId !== fid) {
      close(); status = null; subject = { formId: fid, name: s.name, dead: !!s.dead };
      clearTimeout(timer);
      // Defer until the new card is attached.
      timer = setTimeout(poll, 0);
    } else if (!timer) timer = setTimeout(poll, 0);
  }
  function paint() {
    buttons = buttons.filter((b) => b.isConnected);
    buttons.forEach((b) => {
      const active = !!(status && status.active && Number(b.dataset.ref) === status.formId);
      b.classList.toggle('nsc-live', active);
      b.querySelector('.fq-btn-lbl').textContent = active ? 'Scene controls' : 'Animate';
      b.title = active ? 'Active OStim scene — open scene controls' : 'Animations and appearance controls';
    });
    if (!modal) return;
    const note = modal.querySelector('.nsc-status');
    note.textContent = !status ? 'Checking scene…' : status.inPlayerScene
      ? (status.sceneName || 'OStim scene active') + ' · Speed ' + status.speed + ' / ' + status.maxSpeed
      : status.active ? 'OStim scene active. Playback controls below apply only when this NPC is in your scene.'
      : 'No active OStim scene for this NPC. Appearance and animation shortcuts are available.';
    /* The position pictogram, when this card is looking at the player's own
       scene (2026-09-21). Borrowed from OstimTools so there is ONE keyword
       table; feature-detected, and silently absent when nothing matched. */
    if (status && status.inPlayerScene && window.OstimTools && OstimTools.positionArt) {
      const art = OstimTools.positionArt(status.sceneName, status.scene, 'nsc-pos');
      if (art) note.insertBefore(art, note.firstChild);
    }
    controls.forEach((c) => {
      c.button.disabled = !status || !status.inPlayerScene || (c.canSwap && !status.canSwap);
    });
  }
  function close() {
    if (modal) modal.remove(); modal = null; controls = [];
    document.removeEventListener('keydown', key, true);
    if (opener && opener.isConnected) opener.focus(); opener = null;
  }
  function key(e) {
    if (!modal) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Tab') {
      const focusable = Array.from(modal.querySelectorAll('button,input')).filter((n) => !n.disabled && n.offsetParent !== null);
      const i = focusable.indexOf(document.activeElement);
      if (focusable.length && (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === focusable.length - 1))) {
        e.preventDefault(); e.stopPropagation(); focusable[e.shiftKey ? focusable.length - 1 : 0].focus();
      }
    }
  }
  function open(s, button) {
    observe(s); close(); opener = button;
    modal = el('div', 'nsc-back'); modal.id = 'npc-scene-modal';
    const card = el('section', 'nsc-card'); card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'nsc-title');
    const head = el('div', 'nsc-head');
    const title = el('h2', '', 'Scene controls — ' + s.name); title.id = 'nsc-title';
    const brand = el('img', 'nsc-brand'); brand.src = ICON; brand.alt = '';
    const heading = el('div', 'nsc-heading'); heading.append(brand, title);
    head.append(heading, action('Close', close));
    const input = el('input', 'nsc-search'); input.type = 'search';
    input.placeholder = 'Find a scene control…'; input.setAttribute('aria-label', 'Find a scene control');
    const sections = el('div', 'nsc-sections');
    const animationGrid = section('Animations', sections);
    const appearanceGrid = section('Appearance', sections);
    const playbackGrid = section('Live scene controls', sections);
    const go = (fav) => {
      close();
      if (window.OStimPane) {
        if (fav && OStimPane.openFavorites) OStimPane.openFavorites();
        else OStimPane.smartLand();
      } else if (window.__omniSetTab) window.__omniSetTab('anim');
    };
    animationGrid.append(
      action('Animate — browse scenes', () => go(false), 'hm-anim', 'Search scenes and choose a variant'),
      action('Favorite scenes', () => go(true), 'hk-faith-favoured', 'Your starred scenes, ready to find again'));
    [['Change skin', 'skins', '', 'hm-faces', 'Browse skin packs and restore their own'],
     ['Equip bondage', 'zaz', '', 'hm-wardrobe', 'Choose restraints or remove worn pieces'],
     ['Equip liquids', 'fx', 'liquid', 'sv-drink', 'Apply and remove liquid effects'],
     ['Oil skin', 'fx', 'oil', 'hk-potion-cure', 'Adjust the oiled-skin effect'],
     ['All effects / remove effects', 'fx', '', 'hm-spells', 'Review and remove applied effects'],
     ['Body physics', 'body', '', 'hk-anim-fix', 'Open the body physics controls']].forEach((a) => {
      appearanceGrid.append(action(a[0], () => {
        close(); if (window.FolPane && FolPane.openEffectsFor) FolPane.openEffectsFor(s, a[1], a[2]);
      }, a[3], a[4]));
    });
    [['Move scene / rescan furniture','move','hk-bed'],['Live controls / favorite current','live','seg-ostim'],['Favorites / collections / recent','library','hk-faith-favoured'],['Actor alignment','align','hm-followers'],['OStim settings','options','sv-camp-options'],['Expressions / preview','expr','hm-faces'],['Camera / scene photos','camera','hk-portrait'],['Participant size / audio / clothing','people','hm-wardrobe']].forEach(a=>{
      /* These now hand over to the Scene TAB rather than opening a rival
         floating workspace (Rober, 2026-09-21). showOnTab falls back to the
         old modal when there is no Scene tab, i.e. OStim absent. */
      const b=action(a[0],()=>{close();if(window.OstimTools)OstimTools.showOnTab(a[1],s.formId);},a[2],'Open it on the Scene page');
      controls.push({button:b});playbackGrid.append(b);
    });
    [['Slower', 'osSpeed', '-', 'hm-time', 'Lower the current animation speed'],
     ['Faster', 'osSpeed', '+', 'hm-time', 'Raise the current animation speed'],
     ['Swap roles', 'osSwap', '', 'hm-followers', 'Switch the scene participants’ roles'],
     ['Use nearby furniture', 'osFurn', 'nearby', 'hk-bed', 'Move to suitable furniture nearby'],
     ['Move scene to floor', 'osFurn', 'floor', 'hm-domains', 'Switch to a scene without furniture']].forEach((a) => {
      const b = action(a[0], () => {
        if (!status || !status.inPlayerScene || status.formId !== (Number(s.formId) >>> 0)) return;
        if(a[1]==='osFurn'&&a[2]==='nearby'&&window.OstimTools){close();OstimTools.showOnTab('move',s.formId);return;}
        send(a[1], a[2]); clearTimeout(timer); timer = setTimeout(poll, 700);
      }, a[3], a[4]);
      controls.push({ button: b, canSwap: a[1] === 'osSwap' }); playbackGrid.append(b);
    });
    const empty = el('p', 'nsc-empty', 'No matching controls.'); empty.hidden = true;
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase(); let count = 0;
      Array.from(sections.querySelectorAll('.nsc-tile')).forEach((b) => { b.hidden = b.textContent.toLowerCase().indexOf(q) === -1; if (!b.hidden) count++; });
      sections.querySelectorAll('.nsc-section').forEach((box) => { box.hidden = !Array.from(box.querySelectorAll('.nsc-tile')).some((b) => !b.hidden); });
      empty.hidden = count > 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = Array.from(sections.querySelectorAll('.nsc-tile')).find((b) => !b.hidden && !b.disabled);
      if (first) { e.preventDefault(); first.click(); }
    });
    card.append(head, el('p', 'nsc-status'), el('p', 'nsc-result'), input, sections, empty); modal.append(card);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.body.append(modal); document.addEventListener('keydown', key, true);
    paint(); input.focus(); poll();
  }
  window.osActorState = function (raw) {
    let s; try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
    if (!s || !subject || Number(s.formId) !== subject.formId) return;
    status = s; paint();
  };
  function button(s) {
    observe(s);
    const b = el('button', 'fq-btn nsc-trigger'); b.type = 'button'; b.disabled = !!s.dead;
    b.title = 'Animations and appearance controls';
    b.dataset.ref = String(Number(s.formId) >>> 0);
    const ic = el('span', 'fq-btn-ic'); ic.setAttribute('aria-hidden', 'true');
    const img = el('img', 'nsc-icon'); img.src = ICON; img.alt = ''; ic.append(img);
    b.append(ic, el('span', 'fq-btn-lbl', 'Animate'));
    b.addEventListener('click', (e) => { e.stopPropagation(); open(s, b); });
    buttons.push(b);
    if (status && status.active && status.formId === (Number(s.formId) >>> 0)) {
      b.classList.add('nsc-live'); b.querySelector('.fq-btn-lbl').textContent = 'Scene controls';
    }
    return b;
  }
  window.addEventListener('hd-ostim-result', function (e) {
    if (!modal || !e.detail) return;
    const result = modal.querySelector('.nsc-result');
    result.textContent = e.detail.msg || '';
    result.classList.toggle('error', e.detail.ok === false);
    result.setAttribute('role', 'status');
  });
  window.addEventListener('hd-position-art-changed', function () { if (modal) paint(); });
  function reset() { close(); clearTimeout(timer); timer = 0; status = null; subject = null; buttons = []; }
  return { button, open, close, reset };
})();
