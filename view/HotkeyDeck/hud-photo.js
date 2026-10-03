/* photo-light-controls: read-only view. Native input drives this without Focus,
   so WASD and mouse-look stay with the free camera, even when time is frozen. */
(function () {
  'use strict';
  // photo-hud-clarity: native controls, explicit editing target, no polling.
  var root, guide;
  function need() {
    if (root) return root;
    root = document.getElementById('hud-photo');
    if (!root) { root = document.createElement('aside'); root.id = 'hud-photo'; document.body.appendChild(root); }
    root.setAttribute('aria-label', 'Photo mode keyboard controls');
    guide = document.createElement('div'); guide.id = 'hp-frame';
    guide.setAttribute('aria-hidden', 'true');
    guide.innerHTML = '<i class="hp-shade" id="hp-shade-top"></i><i class="hp-shade" id="hp-shade-bottom"></i>' +
      '<i class="hp-shade" id="hp-shade-left"></i><i class="hp-shade" id="hp-shade-right"></i><div class="hp-frame-label"><strong id="hp-format"></strong><span id="hp-resolution"></span></div>' +
      '<i class="hp-grid hp-grid-v hp-grid-a"></i><i class="hp-grid hp-grid-v hp-grid-b"></i>' +
      '<i class="hp-grid hp-grid-h hp-grid-a"></i><i class="hp-grid hp-grid-h hp-grid-b"></i>';
    document.body.appendChild(guide);
    root.innerHTML = '<div class="hp-head"><span>PHOTO MODE</span><span id="hp-count"></span></div>' +
      '<div class="hp-framing"><div><span class="hp-label"><kbd>F6</kbd> Format</span><strong id="hp-format-value"></strong></div>' +
      '<div><span class="hp-label"><kbd>F10</kbd> Grid</span><strong id="hp-grid-value"></strong></div></div>' +
      '<div class="hp-title"><div><span class="hp-label">Editing light</span><strong id="hp-selected"></strong></div>' +
      '<span class="hp-next"><kbd>F1</kbd> Cycle target</span></div>' +
      '<p id="hp-target-note" role="status" aria-live="polite"></p>' +
      '<div class="hp-values"><div><span class="hp-label">Color</span><strong><i id="hp-swatch" aria-hidden="true"></i><span id="hp-color"></span></strong>' +
      '<span class="hp-value-keys"><kbd>F2</kbd><span>Cycle color</span></span></div>' +
      '<div><span class="hp-label">Brightness</span><strong id="hp-brightness"></strong>' +
      '<span class="hp-value-keys"><kbd>F3 / F4</kbd><span>Dim / brighten</span></span></div>' +
      '<div><span class="hp-label">Reach</span><strong id="hp-spread"></strong>' +
      '<span class="hp-value-keys"><kbd>[ / ]</kbd><span>Narrow / widen</span></span></div></div>' +
      '<div class="hp-meter" aria-hidden="true"><span id="hp-level"></span></div>' +
      '<div class="hp-controls"><span><kbd>E</kbd><span id="hp-place-label">Tap to place</span></span>' +
      '<span><kbd>Backspace</kbd><span id="hp-undo-label">Undo last</span></span></div>' +
      '<p id="hp-capacity-note" role="status" aria-live="polite"></p>' +
      '<div class="hp-foot"><span class="hp-shutter"><kbd>Enter</kbd> Take photo</span><span><kbd>Esc</kbd> Cancel</span></div>' +
      '<div class="hp-preview-note"><kbd>F8</kbd><span>Hide controls &amp; guide. Lights stay on.</span></div>';
    return root;
  }
  function text(id, value) {
    var el = document.getElementById(id);
    if (el && el.textContent !== value) el.textContent = value;
  }
  function toggle(el, cls, on) { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); }
  function style(el, key, value) {
    if (!el) return;
    var previous = el.__photoStyles || (el.__photoStyles = {});
    if (previous[key] !== value) { el.style[key] = value; previous[key] = value; }
  }
  function number(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
  function label(value, fallback) { return typeof value === 'string' && value.length ? value : fallback; }
  function shade(name, x, y, w, h) {
    var el = document.getElementById('hp-shade-' + name);
    style(el, 'left', x * 100 + '%'); style(el, 'top', y * 100 + '%');
    style(el, 'width', w * 100 + '%'); style(el, 'height', h * 100 + '%');
  }
  function validFrame(f) {
    return f && ['left','top','width','height','outputWidth','outputHeight'].every(function(k) {
      return typeof f[k] === 'number' && isFinite(f[k]);
    }) && f.left >= 0 && f.top >= 0 && f.width > 0 && f.height > 0 &&
      f.left + f.width <= 1.000001 && f.top + f.height <= 1.000001 && f.outputWidth > 0 && f.outputHeight > 0;
  }
  window.photoLights = function (payload) {
    var s;
    try { s = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (_) { return; }
    if (!s || typeof s !== 'object') return;
    var el = need(), active = s.active === true;
    toggle(document.body, 'hp-active', active);
    toggle(el, 'hp-visible', active && s.visible === true);
    var ariaHidden = active && s.visible === true ? 'false' : 'true';
    if (el.getAttribute('aria-hidden') !== ariaHidden) el.setAttribute('aria-hidden', ariaHidden);
    // Native sends normalized edges from the exact integer crop used by the
    // encoder. This view never guesses an aspect ratio or reads game pixels.
    var f = s.frame, framed = !!validFrame(f), showFrame = active && s.visible === true && framed;
    toggle(guide, 'hp-frame-visible', showFrame);
    if (showFrame) {
      style(guide, 'left', f.left * 100 + '%'); style(guide, 'top', f.top * 100 + '%');
      style(guide, 'width', f.width * 100 + '%'); style(guide, 'height', f.height * 100 + '%');
      toggle(guide, 'hp-thirds', f.thirds === true);
      shade('top', 0, 0, 1, f.top);
      shade('bottom', 0, f.top + f.height, 1, Math.max(0, 1 - f.top - f.height));
      shade('left', 0, f.top, f.left, f.height);
      shade('right', f.left + f.width, f.top, Math.max(0, 1 - f.left - f.width), f.height);
      text('hp-format', label(f.label, 'Photo frame'));
      text('hp-resolution', f.outputWidth + ' × ' + f.outputHeight + ' px output');
    }
    if (!active) return;
    var limit = Math.max(1, Math.floor(number(s.limit, 12)));
    var count = Math.max(0, Math.min(limit, Math.floor(number(s.count, 0))));
    var selected = number(s.selected, -1), placed = selected >= 0 && selected < count && selected % 1 === 0;
    var full = count === limit;
    text('hp-count', count + ' / ' + limit + ' placed');
    text('hp-format-value', framed ? label(f.label, 'Photo frame') : 'Waiting for frame');
    text('hp-grid-value', framed ? (f.thirds === true ? 'Thirds on' : 'Off') : 'Unavailable');
    text('hp-selected', selected === -2 ? 'Camera fill' : placed ? 'Light ' + (selected + 1) : 'Next light');
    text('hp-target-note', selected === -2 ? 'Moves with your camera.' : placed ?
      'Stays in the scene. These controls edit this light.' : 'These settings apply to the next light you place.');
    toggle(el, 'hp-at-limit', full);
    toggle(el, 'hp-no-lights', count === 0);
    text('hp-place-label', full ? 'Limit reached' : 'Tap to place');
    text('hp-undo-label', count ? 'Undo last' : 'No lights');
    text('hp-capacity-note', full ? 'Undo a placed light to make room for another.' : 'Tap E to place a light at the camera position.');
    text('hp-color', label(s.color, 'Warm'));
    var brightness = Math.round(Math.max(25, Math.min(300, number(s.brightness, 100))));
    text('hp-brightness', brightness + '%');
    text('hp-spread', label(s.spread, 'Medium'));
    style(document.getElementById('hp-level'), 'width', (brightness / 3) + '%');
    var rgb = Array.isArray(s.rgb) && s.rgb.length === 3 ? s.rgb : [1, .96, .9];
    style(document.getElementById('hp-swatch'), 'backgroundColor', 'rgb(' + rgb.map(function (v) {
      return Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
    }).join(', ') + ')');
  };
})();
