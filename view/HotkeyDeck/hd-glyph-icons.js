'use strict';
/* ============================ HDGlyphIcons — pictograph glyphs drawn as the deck's own icons ============================
 *
 *  WHY (Rober, 2026-10-10: "add custom icons and make sure they are good").  The view text
 *  carries ~120 pictographs (🔒 📦 🐴 🧲 ⚔ 🛡 …) used as icons in buttons, chips and labels.
 *  Measured in Ultralight (emoji-probe): none of them draw in colour; every one falls back to a
 *  flat Segoe UI Symbol glyph of its own weight and size, some only a speck. They read as a
 *  font, not as the deck's art.
 *
 *  WHAT.  icons/custom/gl-*.png is a matching set drawn for text size (one bold gold silhouette
 *  each, one palette; generated 2026-10-10, recoloured to a single gold ramp). This file swaps
 *  each mapped character in visible text for
 *
 *      <span class="hd-gi"><img src="icons/custom/gl-NAME.png"><span class="hd-gi-ch">🔒</span></span>
 *
 *  sized 1.2em on the text baseline. The ORIGINAL CHARACTER STAYS in the DOM (visually hidden),
 *  so code that reads textContent / innerText ("is this the 🔒 button?") is unaffected, and so
 *  are copy and search. hd-icon-mip.js then draws the img from the right mip tier.
 *
 *  Simple marks are NOT mapped and stay text: ✕ ✓ ★ ☆ ⚠ ✎ arrows, flags, ♥ ♀ ♂, ⏸ ⏹, ☰.
 *  Untouched: <textarea>/<input>/<select>/<option> (they cannot hold an image), <script>,
 *  <style>, contenteditable, anything inside [data-no-gi], and CSS content: / attributes.
 *
 *  Runs synchronously in its MutationObserver callback (no layout reads), i.e. before the next
 *  paint: a glyph is never seen and then swapped. Never throws (PrismaUI's renderer is shared).
 * ============================================================================================== */
(function () {
  if (window.hdGlyphIcons) return;
  var MAP = {'⚗':'alembic','📿':'amulet','🪓':'axe','🎒':'backpack','🦲':'bald','🛏':'bed','☣':'biohazard','⚡':'bolt','📕':'book','📓':'book','📖':'book-open','🥾':'boot','🏹':'bow','🧠':'brain','🧹':'broom','🫧':'bubbles','📷':'camera','🕯':'candle','🏰':'castle','⛓':'chains','🪑':'chair','☁':'cloud','🧥':'coat','🜚':'coins','🪙':'coins','☄':'comet','📦':'crate','⛃':'crate','👑':'crown','🗡':'dagger','🩰':'dance','🕺':'dance','📥':'deposit','🧬':'dna','🚪':'door','🕊':'dove','🐉':'dragon','👗':'dress','💧':'drop','🦅':'eagle','👁':'eye','🔥':'flame','👣':'footprints','⚙':'gear','💎':'gem','🌐':'globe','🧤':'gloves','💇':'hair','⚒':'hammers','✋':'hand','⚕':'healing','⛑':'helmet','🌿':'herb','🐴':'horse','⏳':'hourglass','⌛':'hourglass','🏠':'house','🧊':'ice','🗝':'key','💡':'lantern','🗂':'ledger','🗄':'ledger','🛟':'lifebuoy','🔒':'lock','🧲':'magnet','🔍':'magnifier','🔎':'magnifier','🗺':'map','🎭':'masks','🍖':'meat','🌙':'moon','🗒':'notepad','📋':'notepad','🔮':'orb','🎨':'palette','🐾':'paw','👥':'people','👤':'person','🖼':'picture','📍':'pin','📌':'pin','🧪':'potion','💰':'pouch','🧩':'puzzle','💍':'ring','⚖':'scales','🧣':'scarf','✂':'scissors','🖥':'screen','📜':'scroll','🛡':'shield','⛨':'shield','👕':'shirt','☠':'skull','❄':'snowflake','✨':'sparkle','💬':'speech','📐':'square','♨':'steam','🍲':'stew','🪨':'stone','⏱':'stopwatch','☀':'sun','⚔':'swords','🏷':'tag','🍺':'tankard','🎯':'target','⛺':'tent','🏕':'tent','🌡':'thermometer','🧰':'toolbox','🗑':'trash','🌲':'tree','☂':'umbrella','🔓':'unlock','🚶':'walker','🐺':'wolf','🔧':'wrench'};
  var keys = Object.keys(MAP).sort(function (a, b) { return b.length - a.length; });
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var RX = new RegExp('(' + keys.map(esc).join('|') + ')\\uFE0F?', 'g');
  var TEST = new RegExp(keys.map(esc).join('|'));
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, TITLE: 1, NOSCRIPT: 1, CANVAS: 1 };

  function skipped(node) {
    for (var e = node.parentNode; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP[e.tagName]) return true;
      var c = e.className;
      if (typeof c === 'string' && (c.indexOf('hd-gi') !== -1)) return true;
      if (e.isContentEditable || e.hasAttribute('data-no-gi')) return true;
      if (e.namespaceURI && e.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;   // svg text
    }
    return false;
  }

  function swapText(node) {
    var t = node.nodeValue;
    if (!t || !TEST.test(t) || skipped(node)) return;
    var frag = document.createDocumentFragment(), last = 0, m;
    RX.lastIndex = 0;
    while ((m = RX.exec(t))) {
      if (m.index > last) frag.appendChild(document.createTextNode(t.slice(last, m.index)));
      var wrap = document.createElement('span');
      wrap.className = 'hd-gi';
      var img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.setAttribute('src', 'icons/custom/gl-' + MAP[m[1]] + '.png');
      var ch = document.createElement('span');
      ch.className = 'hd-gi-ch';
      ch.textContent = m[0];
      wrap.appendChild(img);
      wrap.appendChild(ch);
      frag.appendChild(wrap);
      last = m.index + m[0].length;
    }
    if (last < t.length) frag.appendChild(document.createTextNode(t.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { swapText(root); return; }
    if (root.nodeType !== 1 || SKIP[root.tagName]) return;
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false), n, list = [];
    while ((n = tw.nextNode())) if (TEST.test(n.nodeValue)) list.push(n);
    for (var i = 0; i < list.length; i++) { try { swapText(list[i]); } catch (e) {} }
  }

  function onMutations(records) {
    try {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') { if (r.target.parentNode) swapText(r.target); continue; }
        for (var j = 0; j < r.addedNodes.length; j++) {
          var a = r.addedNodes[j];
          if (a.nodeType === 1 && typeof a.className === 'string' && a.className.indexOf('hd-gi') === 0) continue;
          if (a.parentNode) walk(a);
        }
      }
    } catch (e) {}
  }

  try {
    var css = document.createElement('style');
    css.id = 'hd-glyph-icons-css';
    css.textContent =
      '.hd-gi{display:inline-block;position:relative;width:1.2em;height:1.2em;vertical-align:-0.24em;line-height:1;flex:none;}' +
      '.hd-gi>img{display:block;width:100%;height:100%;pointer-events:none;}' +
      '.hd-gi-ch{position:absolute;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;font-size:1px;pointer-events:none;}';
    (document.head || document.documentElement).appendChild(css);
  } catch (e) {}

  function start() {
    try {
      walk(document.body);
      new MutationObserver(onMutations).observe(document.documentElement,
        { childList: true, subtree: true, characterData: true });
    } catch (e) {}
  }

  window.hdGlyphIcons = { map: MAP, walk: function (n) { try { walk(n); } catch (e) {} } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
