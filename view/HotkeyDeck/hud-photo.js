/* photo-light-controls: read-only view. Native input drives this without Focus,
   so WASD and mouse-look stay with the free camera, even when time is frozen. */
(function () {
  'use strict';
  var root;
  function need() {
    if (root) return root;
    root = document.getElementById('hud-photo');
    if (!root) { root = document.createElement('aside'); root.id = 'hud-photo'; document.body.appendChild(root); }
    root.setAttribute('aria-label', 'Photo lighting');
    root.innerHTML = '<div class="hp-head"><span>PHOTO LIGHTING</span><span id="hp-count"></span></div>' +
      '<div class="hp-title"><span id="hp-selected"></span><span class="hp-key">F1 select</span></div>' +
      '<div class="hp-values"><div><span class="hp-label">Color</span><strong><i id="hp-swatch"></i><span id="hp-color"></span></strong></div>' +
      '<div><span class="hp-label">Brightness</span><strong id="hp-brightness"></strong></div>' +
      '<div><span class="hp-label">Reach</span><strong id="hp-spread"></strong></div></div>' +
      '<div class="hp-meter"><span id="hp-level"></span></div>' +
      '<div class="hp-controls"><span><b>E</b> Place light</span><span><b>Backspace</b> Undo last</span>' +
      '<span><b>F2</b> Change color</span><span><b>F3 / F4</b> Dim / brighter</span>' +
      '<span><b>[ / ]</b> Narrow / wider</span><span><b>F8</b> Hide controls</span></div>' +
      '<div class="hp-foot"><span><b>Enter</b> Take photo</span><span>SkyManager key: cancel</span></div>';
    return root;
  }
  function text(id, value) { document.getElementById(id).textContent = value; }
  window.photoLights = function (payload) {
    var s;
    try { s = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (_) { return; }
    if (!s || typeof s !== 'object') return;
    var el = need(), active = s.active === true;
    document.body.classList.toggle('hp-active', active);
    el.classList.toggle('hp-visible', active && s.visible === true);
    el.setAttribute('aria-hidden', active && s.visible === true ? 'false' : 'true');
    if (!active) return;
    var count = Math.max(0, Number(s.count) || 0);
    var selected = Number(s.selected);
    text('hp-count', count + ' / ' + (Number(s.limit) || 12) + ' placed');
    text('hp-selected', selected === -2 ? 'Camera fill' : selected >= 0 ? 'Light ' + (selected + 1) : 'New light');
    text('hp-color', s.color || 'Warm');
    var brightness = Math.max(25, Math.min(300, Number(s.brightness) || 100));
    text('hp-brightness', brightness + '%');
    text('hp-spread', s.spread || 'Medium');
    document.getElementById('hp-level').style.width = (brightness / 3) + '%';
    var rgb = Array.isArray(s.rgb) && s.rgb.length === 3 ? s.rgb : [1, .96, .9];
    document.getElementById('hp-swatch').style.backgroundColor = 'rgb(' + rgb.map(function (v) {
      return Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
    }).join(',') + ')';
  };
})();
