/* hd-bindconflicts.js — "what already claims this press?"
 *
 * Rober, 2026-09-23, after the key box flatly refused F15 (his G3, the
 * Domains open key): "but then it should ask like clear out this other or
 * allow them to be conflicting". A collision is a question, never a refusal.
 *
 * Pure: hand it a snapshot of every binding the deck owns and the candidate,
 * get back the collisions, each with a clear() that unbinds the other side.
 * No DOM here — app.js builds the snapshot and paints the question.
 *
 * Snapshot shape:
 *   entries:  [{ id, name, device, code, mods, trigger:{device,code,mods,gesture,label} }]
 *   openKeys: [{ id, what, binding:{device,code,label}, clear }]   clear may be null
 *   modSlots: [{ id, what, binding:{device,code,label}, clear }]
 *   extMap:   { F16: <code it fires>, … }      + clearExt(name)
 * Candidate: { mode, ownerId, binding:{device,code,mods,keyLabel}, gesture }
 *   mode 'entry'/'add' = what the entry SENDS; anything else is an INPUT
 *   binding (trigger / open key / modifier slot) = what press fires it.
 */
window.HDBindConflicts = (function () {
  function modsKey(m) { return (Array.isArray(m) ? m : []).map(Number).filter(Boolean).sort(function (a, b) { return a - b; }).join('+'); }
  function sameKey(a, b) {
    if (!a || !b) return false;
    if ((a.device || 'keyboard') !== (b.device || 'keyboard')) return false;
    if (((a.code >>> 0) || 0) === 0 || ((b.code >>> 0) || 0) === 0) return false;
    if ((a.code >>> 0) !== (b.code >>> 0)) return false;
    return modsKey(a.mods) === modsKey(b.mods);
  }
  const GESTURE = { '': 'tap', double: 'double-tap', hold: 'hold' };
  function extName(binding) {
    if (!binding || (binding.device || 'keyboard') !== 'keyboard') return '';
    const l = String(binding.keyLabel || binding.label || '').toUpperCase();
    return /^F(1[3-9]|2[0-4])$/.test(l) ? l : '';
  }

  function find(snap, cand) {
    const out = [];
    if (!snap || !cand || !cand.binding) return out;
    const b = cand.binding;
    const label = b.keyLabel || b.label || 'that key';
    const sending = cand.mode === 'entry' || cand.mode === 'add';
    const gesture = cand.mode === 'trigger' ? (cand.gesture || '') : null;

    (snap.entries || []).forEach(function (e) {
      if (!e || e.id === cand.ownerId) return;
      const t = e.trigger;
      if (t && sameKey(t, b)) {
        /* one key, three actions: tap / double-tap / hold coexist on a trigger */
        if (gesture === null || (t.gesture || '') === gesture) {
          out.push({
            kind: 'trigger', id: e.id,
            text: '"' + (e.name || e.id) + '" already fires from ' + (t.label || label) +
                  (gesture === null && (t.gesture || '') ? ' (' + GESTURE[t.gesture] + ')' : ''),
            clear: function () { delete e.trigger; }
          });
        }
      }
      /* an INPUT binding on a key some entry SENDS: firing that entry presses
         the key, the sink sees the press, and this fires too */
      if (!sending && (e.device || 'keyboard') === 'keyboard' && sameKey({ device: 'keyboard', code: e.code, mods: e.mods }, b)) {
        out.push({
          kind: 'sent', id: e.id,
          text: '"' + (e.name || e.id) + '" sends ' + (e.label || label) + ' — firing it would fire this too',
          clear: function () { e.code = 0; e.label = ''; e.mods = []; }
        });
      }
    });

    (snap.openKeys || []).forEach(function (o) {
      if (!o || !o.binding || cand.mode === o.id) return;
      if (sameKey(o.binding, b)) out.push({
        kind: 'open', id: o.id,
        text: (o.binding.label || label) + ' already opens ' + (o.what || o.id),
        clear: typeof o.clear === 'function' ? o.clear : null,
        why: typeof o.clear === 'function' ? '' : ((o.what || 'that tab') + ' must keep an open key — change it there first')
      });
    });

    (snap.modSlots || []).forEach(function (s) {
      if (!s || !s.binding || cand.mode === s.id) return;
      if (sameKey(s.binding, b)) out.push({
        kind: 'mod', id: s.id,
        text: (s.binding.label || label) + ' is the ' + (s.what || s.id) + ' chord key',
        clear: typeof s.clear === 'function' ? s.clear : null
      });
    });

    const name = extName(b);
    if (name && snap.extMap && snap.extMap[name] !== undefined && cand.mode !== 'ext') {
      const fires = snap.extLabel ? snap.extLabel(name) : String(snap.extMap[name]);
      out.push({
        kind: 'ext', id: name,
        text: name + ' is remapped to fire ' + fires + (sending ? ' — this entry would send that instead' : ''),
        clear: typeof snap.clearExt === 'function' ? function () { snap.clearExt(name); } : null
      });
    }
    return out;
  }

  function allClearable(list) { return list.length > 0 && list.every(function (c) { return typeof c.clear === 'function'; }); }

  return { find: find, allClearable: allClearable, _sameKey: sameKey, _modsKey: modsKey };
})();
