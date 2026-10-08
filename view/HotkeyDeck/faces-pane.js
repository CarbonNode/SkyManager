'use strict';

/* ====================================================================== *
 *  Faces — the RaceMenu-preset tab inside the Hotkey Deck view.
 *
 *  The ask (Rober, 2026-08-04): its OWN tab to browse presets, SEE what they
 *  look like (images you set yourself — try a preset on your character, take a
 *  picture, revert, assign it), and apply to whoever you're looking at, a
 *  follower you search for, or your own character.
 *
 *  This pane OWNS the preset feature end to end — the gallery, the
 *  fdPreset bridge, and the fdPresetData / fdPresetResult receivers. The
 *  Followers card's 🎭 button is a DEEP-LINK into here (one system, not two
 *  copies), aimed at whoever the card was showing.
 *
 *  Bridge — C++ registers `fdPreset` (JS→C++) and pushes `fdPresetData` /
 *  `fdPresetResult` back; both already exist for the old inline block.
 *    fdPreset {op:'index'}                         → fdPresetData(index)
 *    fdPreset {op:'img', preset, icon}             → fdPresetData(index)
 *    fdPreset {op:'apply', formId, preset, flags}  → fdPresetResult(...)
 *    fdPreset {op:'spawn', base?, name, preset, flags} → fdPresetResult(...)
 *    fdPreset {op:'saveplayer', name}              → fdPresetResult(saved)
 *    fdPreset {op:'render-one', preset, race?, sex?} → one face, re-rendered
 *
 *  ---- the 2026-08-16 play-test pass -------------------------------------
 *  Five things Rober hit, and what this file does about each:
 *   1. "re-render individual needs to be a button on a face" → every tile has
 *      a ⟳ corner that fires {op:'render-one'}, with the spinner ON that tile
 *      so a press is never a mystery.
 *   2. "render missing (6) seems to do nothing" → those six fail the shape
 *      pass every single run. The index now carries `fails{preset: reason}`;
 *      the count EXCLUDES them and a sibling "⚠ N can't be rendered — why?"
 *      card lists them with the reason and lets you name the race/sex to
 *      render as (render-one carries the override).
 *   3. "set image button seems to do nothing" → it is a MODE chip that armed
 *      silently, and its picker strip opened BELOW the fold. Armed modes now
 *      get a banner that says what a tile click will do, and the strip is
 *      scrolled into view, filterable, and honest when there are no files.
 *   4. "wait why is re-render all saying redo 1?" → counts were computed from
 *      assign.json alone, which had lost ~104 rows while 234 rendered PNGs sat
 *      on disk. pdIconFor() now also ADOPTS an orphan `auto-<preset>.png`, so
 *      every number is truth-based and survives the assignment loss.
 *   5. "the face generation stuff causes some pretty bad lag" → the batch's
 *      cost (faces × ~4 s, what happens to the game) is stated on screen
 *      BEFORE the press, and the Stop chip is verified to show while it runs.
 *
 *  Host contract (mirrors LootPane/RoomsPane): FacesPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome — the shared size card covers it) ·
 *  wantsPause() -> true · aimAt(formId, name) for the Followers deep-link.
 * ====================================================================== */

window.FacesPane = (function () {

  const PLAYER_FORMID = 0x14;      // the player's ref, for "try it on me"
  const BACKUP_PRESET = 'PD_MyFaceBackup';

  /* toGame / toast come from app.js globals; h() is the followers/loot DOM
     builder — reuse the one app.js exposes so a tag helper isn't duplicated. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ---- state ---- */
  let host = null;
  let pdState = null;           // last index push
  let pdBusy = false;
  let backedUp = false;         // did we snapshot the player's face this session?
  let fqStatus = null;          // {msg, ok, pending}

  /* Target: who gets the face. kind = 'crosshair' | 'me' | 'pick'.
     For 'crosshair' we read the live crosshair snapshot the Followers pane
     already holds (it is the roster/target authority); 'pick' names a follower
     by form id; 'me' is the player. */
  const target = { kind: 'crosshair', formId: 0, name: '' };

  /* ui bag persists mode / filter / selection across repaints.
     2026-08-16 additions: rr = per-preset re-renders in flight, showBlocked /
     failFor / raceQ / raceSex = the "couldn't render this one" card and its
     race override, imgQ = the Set-image strip's filter, batchStarting = the
     optimistic state of the ✨ button between the press and the confirming
     index push (without it, pressing it looked like nothing happened). */
  const ui = { mode: '', full: false, filter: '', sel: 0, summonName: '', assignFor: null,
    catFilter: '', catFor: null, renameCat: null,
    rr: {}, showBlocked: false, failFor: null, raceQ: '', raceSex: '', imgQ: '', batchStarting: false,
    /* the debug stand-in's ref, so "⛔ Send her away" only exists once there is
       actually someone to send away (2026-08-16 in-game experiment) */
    standIn: '' };

  const DEV = location.search.indexOf('dev=1') !== -1;

  function isActive() { return window.__hdActiveTab === 'faces'; }

  /* ---- target resolution ---- */

  function crosshairTarget() {
    // FolPane owns the crosshair snapshot pushed at open (fdTarget). Read it
    // rather than duplicating a second receiver for the same push.
    try {
      const fp = window.FolPane;
      const t = fp && fp._state && fp._state.target;
      if (t && t.formId) return { formId: Number(t.formId) || 0, name: t.name || '' };
    } catch (e) { /* FolPane not up yet */ }
    return { formId: 0, name: '' };
  }

  function resolvedTarget() {
    if (target.kind === 'me') return { formId: PLAYER_FORMID, name: 'you' };
    if (target.kind === 'pick') return { formId: target.formId, name: target.name || 'her' };
    const c = crosshairTarget();
    return { formId: c.formId, name: c.name || 'the NPC you’re looking at' };
  }

  /* Bring the tab to the front. Every deep-link into this pane goes through
     here — including the Omni rows below, because a mode armed or a category
     picked while the pane is off screen is a setting nobody can see. The bare
     render() is the standalone-harness path, where nothing owns the tab bar. */
  function showTab() {
    if (window.__omniSetTab) window.__omniSetTab('faces');
    else render();
  }

  /* Followers deep-link: aim at a specific person and show the tab. */
  function aimAt(formId, name) {
    target.kind = 'pick';
    target.formId = Number(formId) || 0;
    target.name = name || '';
    showTab();
  }

  /* ---- preset list + images (ported from the proven inline block) ---- */

  function pdNames() {
    if (!pdState || !pdState.presets) return [];
    const seen = {}, out = [];
    const take = (arr) => (arr || []).forEach((n) => {
      const k = String(n).toLowerCase();
      if (!seen[k]) { seen[k] = true; out.push(String(n)); }
    });
    take(pdState.presets.exported);
    take(pdState.presets.presets);
    out.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
    return out;
  }
  /* ---- what counts as "this preset HAS an image" -------------------------
     Rober, 2026-08-16: "wait why is re-render all saying redo 1?" — there were
     234 rendered PNGs in preset-icons/ and 10 rows in assign.json, so every
     number this pane printed (missing / auto-rendered / with images) was read
     off a broken source and came out nonsense. Truth is three-legged now,
     cheapest first:
       1. an explicit assignment      — assign.json, the batch's or his choice
       2. a file named for the preset  — a picture he dropped in himself
       3. an ORPHAN auto-render        — auto-<preset>.png / .rN.png on disk
     Leg 3 is the new one, and it is deliberately defensive: the renderer's
     filenames are deterministic (PresetAutoStem() in main.cpp), so the pane can
     recognise its OWN output even when the assignment for it went missing. The
     backend self-heal re-adopts those files; until it runs — and if it ever
     misses one — the tab still refuses to offer re-rendering work already done.
     ⚠ Never let this HIDE the loss: the count line names the adopted ones. */
  let orphanMap = null;   // lowercased auto-stem -> {v, file}; rebuilt per index push
  /* Lowercased filename stem -> file, same lifetime as orphanMap. pdIconFor is
     asked of every preset by each gallery paint AND by the Omni provider's
     index(), which runs on every keystroke — scanning the whole picture list
     per preset made that quadratic on a rig with 234 presets and 234 pictures.
     A null-prototype map so a picture actually named constructor.png cannot
     collide with something inherited from Object. */
  let stemMap = null;

  function pdAutoStem(name) {
    // Mirrors PresetAutoStem() in main.cpp — keep the two in step.
    return ('auto-' + String(name)).replace(/[<>:"/\\|?*]/g, '-').replace(/[ .]+$/, '');
  }
  function buildOrphanMap() {
    const map = {};
    ((pdState && pdState.icons) || []).forEach((f) => {
      const m = /^(auto-.+?)(?:\.r(\d+))?\.(?:png|jpe?g|webp)$/i.exec(String(f));
      if (!m) return;
      const k = m[1].toLowerCase(), v = m[2] ? parseInt(m[2], 10) : 1;
      // A re-render writes .r2/.r3… BESIDE the original (Ultralight caches the
      // old bytes under the old name), so the highest suffix is the newest face
      // — exactly what the lost assignment would have pointed at.
      if (!map[k] || map[k].v < v) map[k] = { v, file: String(f) };
    });
    orphanMap = map;
  }
  function pdOrphanFor(name) {
    if (!orphanMap) buildOrphanMap();
    const hit = orphanMap[pdAutoStem(name).toLowerCase()];
    return hit ? hit.file : '';
  }
  function buildStemMap() {
    const map = Object.create(null);
    ((pdState && pdState.icons) || []).forEach((f) => {
      const k = String(f).replace(/\.[^.]+$/, '').toLowerCase();
      if (map[k] === undefined) map[k] = String(f);   // first wins, as the old scan did
    });
    stemMap = map;
  }
  function pdIconFor(name) {
    if (!pdState) return '';
    const a = pdState.assign && pdState.assign[name];
    if (a) return a;
    if (!stemMap) buildStemMap();
    const own = stemMap[String(name).toLowerCase()];
    if (own) return own;
    return pdOrphanFor(name);
  }
  /* True when the ONLY thing showing this face is an unlinked file on disk —
     i.e. the assignment for it is missing. Surfaced in the count line so the
     loss stays visible rather than being papered over. */
  function pdIconIsOrphan(name) {
    if (!pdState || (pdState.assign && pdState.assign[name])) return false;
    const orphan = pdOrphanFor(name);
    return !!orphan && pdIconFor(name) === orphan;
  }

  /* ---- fails{} — why a preset never renders ------------------------------
     The index carries the LAST failure reason per preset, cleared the moment it
     renders. Six presets on Rober's rig fail the shape pass every single batch
     ("can't tell its race"), and before this the only evidence was the log. */
  function failsMap() {
    const f = pdState && pdState.fails;
    return (f && typeof f === 'object' && !Array.isArray(f)) ? f : {};
  }
  function failReason(name) {
    const f = failsMap()[name];
    if (typeof f === 'string') return f;
    if (f && typeof f === 'object') return String(f.reason || f.error || f.msg || '');
    return '';
  }
  function isRaceFail(reason) { return /race|sex|gender/i.test(String(reason || '')); }

  /* What the shape pass THINKS a preset is, even when it wasn't confident —
     used to pre-fill the race/sex override. The backend may hand this over in
     more than one shape, so probe rather than assume: a wrong guess about the
     envelope must not cost the whole override control. */
  function presetShape(name) {
    const out = { race: '', sex: '' };
    if (!pdState || !name) return out;
    const take = (v, allowString) => {
      if (typeof v === 'string') { if (allowString && !out.race) out.race = v; return; }
      if (v && typeof v === 'object') {
        if (!out.race) out.race = String(v.race || v.raceEdid || v.edid || '');
        if (!out.sex) out.sex = String(v.sex || (v.female === true ? 'female' : v.female === false ? 'male' : ''));
      }
    };
    [pdState.shape, pdState.shapes, pdState.info, pdState.race].forEach((src) => {
      if (src && typeof src === 'object') take(src[name], true);
    });
    /* fails{} is reason TEXT keyed by preset — never a race. Reading it as one
       put "no head part in the preset" into the race box in the 2026-08-16
       overlap pass; only an object form {race,sex} may contribute here. */
    take(failsMap()[name], false);
    if (!out.sex && pdState.sex && typeof pdState.sex === 'object' && typeof pdState.sex[name] === 'string')
      out.sex = pdState.sex[name];
    return out;
  }

  /* The race choices for the override. The backend may ship the load order's
     real race list (`races`); the vanilla ten are the fallback, and a typed
     EditorID always wins over both so modded races are never locked out. */
  const VANILLA_RACES = [
    ['NordRace', 'Nord'], ['ImperialRace', 'Imperial'], ['BretonRace', 'Breton'],
    ['RedguardRace', 'Redguard'], ['HighElfRace', 'High Elf (Altmer)'],
    ['DarkElfRace', 'Dark Elf (Dunmer)'], ['WoodElfRace', 'Wood Elf (Bosmer)'],
    ['OrcRace', 'Orc'], ['KhajiitRace', 'Khajiit'], ['ArgonianRace', 'Argonian'],
  ];
  function raceList() {
    const src = pdState && pdState.races;
    if (Array.isArray(src) && src.length) {
      const out = [];
      src.forEach((r) => {
        if (typeof r === 'string') out.push({ edid: r, label: r });
        else if (r && typeof r === 'object' && (r.edid || r.name))
          out.push({ edid: String(r.edid || r.name), label: String(r.name || r.edid) });
      });
      if (out.length) return out;
    }
    return VANILLA_RACES.map((r) => ({ edid: r[0], label: r[1] }));
  }

  /* ---- curation, read straight off the last index push -------------------
     Favourites and hidden presets are asked about per preset per keystroke —
     by the gallery paint and by the Omni provider — so membership is a Set the
     caller builds ONCE and then queries, never an indexOf per question. These
     live at module level because both callers need the same answer. */
  function favSet() { return new Set((pdState && pdState.fav) || []); }
  function hiddenSet() { return new Set((pdState && pdState.hidden) || []); }
  function presetCat(n) { return (pdState && pdState.catOf && pdState.catOf[n]) || ''; }
  function catNames() { return ((pdState && pdState.cats) || []).slice(); }

  /* One pass over the roster, so every number on screen comes from the same
     truth. Hidden presets are out of the tab (and out of the batch, which is
     what C++ does too); PD_ face backups are ours, not gallery presets. */
  function computeCounts() {
    const hidden = {};
    ((pdState && pdState.hidden) || []).forEach((n) => { hidden[n] = true; });
    const c = { total: 0, withImg: 0, auto: 0, orphan: 0, missing: [], blocked: [] };
    pdNames().forEach((n) => {
      if (hidden[n]) return;
      c.total++;
      const icon = pdIconFor(n);
      if (icon) {
        c.withImg++;
        if (icon.slice(0, 5) === 'auto-') c.auto++;
        if (pdIconIsOrphan(n)) c.orphan++;
        return;
      }
      if (n.slice(0, 3) === 'PD_') return;
      (failReason(n) ? c.blocked : c.missing).push(n);
    });
    return c;
  }
  function estText(faces) {
    // ~4 s of in-world work per face (spawn, apply, render, despawn) — the
    // number Rober needs BEFORE he presses, not after 114 of them.
    const s = Math.max(1, Math.round(faces * 4));
    return s < 90 ? '≈ ' + s + 's' : '≈ ' + Math.max(1, Math.round(s / 60)) + ' min';
  }

  /* ---- per-tile re-renders in flight -------------------------------------
     Keyed preset -> {icon, fail, at}: what the tile was showing when we fired,
     so the landing index push (a new auto-…rN.png, or a fresh fail reason)
     clears the spinner by itself. RR_TIMEOUT is the backstop — a render that
     never lands must not spin for ever. */
  const RR_TIMEOUT = 120000;
  function rrPending(name) { return !!(ui.rr && ui.rr[name]); }
  function rrFire(name, over) {
    if (!name || rrPending(name)) return;
    const ar = (pdState && pdState.autorender) || null;
    if (ar && ar.running) {
      fqStatus = { msg: 'A batch is already rendering — Stop it first, or wait for it to finish.', ok: false, pending: false };
      render(); return;
    }
    ui.rr[name] = { icon: pdIconFor(name), fail: failReason(name), at: Date.now() };
    const payload = { op: 'render-one', preset: name };
    if (over && over.race) payload.race = String(over.race);
    if (over && over.sex) payload.sex = String(over.sex);
    fqStatus = {
      msg: 'Rendering “' + name + '”' + (payload.race ? ' as ' + payload.race : '') +
        ' — takes a few seconds, and a stand-in appears beside you while it works.',
      ok: true, pending: true,
    };
    toGame('fdPreset', JSON.stringify(payload));
    render();
    // Backstop for a render that never reports back: reconcile on the timeout
    // so the tile stops spinning even if no index push ever lands.
    setTimeout(() => {
      if (!rrPending(name)) return;
      if ((Date.now() - ui.rr[name].at) < RR_TIMEOUT) return;
      delete ui.rr[name];
      if (isActive()) render();
    }, RR_TIMEOUT + 500);
  }
  function rrReconcile() {
    const now = Date.now();
    Object.keys(ui.rr || {}).forEach((n) => {
      const e = ui.rr[n];
      if (!e) { delete ui.rr[n]; return; }
      if (pdIconFor(n) !== e.icon || failReason(n) !== e.fail || (now - e.at) > RR_TIMEOUT) delete ui.rr[n];
    });
  }
  /* Opening the race override pre-fills whatever the shape pass guessed, so
     Enter is "render it as what you think it is" and not a blank form. */
  function seedRaceEditor(name) {
    const sh = presetShape(name);
    ui.raceQ = sh.race || '';
    ui.raceSex = sh.sex || 'female';
  }
  /* ---- body-aware head crop for auto-rendered stand-in figures ----
     The head hangs from the TOP of the figure's opaque bbox, and scales with
     bbox HEIGHT (width is unstable — arms/coats). Window: side = 0.20*bboxH
     centered at (bbox cx, top + 0.095*bboxH) — tuned on the real 512px
     Geralt render against three candidate crops; this is the "hone in on the
     face, hair cuts at the edges" framing Rober picked for face-fit v2.
     Layout-crop, never transform: Ultralight rasterises an <img> at LAYOUT
     size (the face-fit v4 lesson). */
  const bodyFits = {};   // url -> {w, h, win:{x,y,side}} | 'fail' | 'framed' (session cache)
  /* A live-head portrait (Preset Director's default engine since 2026-10-06)
     is already a framed, square, OPAQUE head shot — the renderer paints its
     own background. The MRF fallback is a transparent full-body figure. So
     opaque corners mean "show it whole": the stylesheet's cover fill is the
     right paint, and bodyFit's figure-height crop would zoom into a forehead. */
  function isFramedPortrait(px, cw, ch) {
    const a = (x, y) => px[(y * cw + x) * 4 + 3];
    return a(0, 0) > 250 && a(cw - 1, 0) > 250 && a(0, ch - 1) > 250 && a(cw - 1, ch - 1) > 250;
  }
  function bodyFitWindow(w, hgt, bbox) {
    const bh = bbox.y1 - bbox.y0, bw = bbox.x1 - bbox.x0;
    if (bh < 8 || bw < 4) return null;
    let side = 0.20 * bh;
    const cx = bbox.x0 + bw / 2, cy = bbox.y0 + 0.095 * bh;
    let x = cx - side / 2, y = cy - side / 2;
    // Clamp the window inside the image (short figures / tight renders).
    if (side > w) side = w;
    if (side > hgt) side = hgt;
    x = Math.max(0, Math.min(x, w - side));
    y = Math.max(0, Math.min(y, hgt - side));
    return { x, y, side };
  }
  function bodyFitPaint(im, frame, fit) {
    const fw = frame.clientWidth || 84, fh = frame.clientHeight || 84;
    const k = Math.min(fw, fh) / fit.win.side;
    im.style.position = 'absolute';
    im.style.width = (fit.w * k) + 'px';
    im.style.height = (fit.h * k) + 'px';
    im.style.maxWidth = 'none';
    // right/bottom auto FIRST: the stylesheet's inset:0 would otherwise fight
    // the explicit box (and a late inset shorthand would clobber left/top).
    im.style.right = 'auto';
    im.style.bottom = 'auto';
    im.style.left = (-fit.win.x * k) + 'px';
    im.style.top = (-fit.win.y * k) + 'px';
    im.style.objectFit = 'fill';
  }
  function bodyFitEnsure(im, url, frame) {
    const hit = bodyFits[url];
    if (hit === 'fail' || hit === 'framed') return;   // cover fill stands
    if (hit) { bodyFitPaint(im, frame, hit); return; }
    const probe = new Image();
    probe.onload = () => {
      try {
        const w = probe.naturalWidth, hgt = probe.naturalHeight;
        const scale = Math.min(1, 128 / Math.max(w, hgt));
        const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(hgt * scale));
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        const ctx = cv.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(probe, 0, 0, cw, ch);
        const px = ctx.getImageData(0, 0, cw, ch).data;
        if (isFramedPortrait(px, cw, ch)) { bodyFits[url] = 'framed'; return; }
        let x0 = cw, y0 = ch, x1 = 0, y1 = 0, any = false;
        for (let yy = 0; yy < ch; yy++)
          for (let xx = 0; xx < cw; xx++)
            if (px[(yy * cw + xx) * 4 + 3] > 16) {
              any = true;
              if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
              if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
            }
        if (!any) throw new Error('empty image');
        const inv = 1 / scale;
        const win = bodyFitWindow(w, hgt, { x0: x0 * inv, y0: y0 * inv, x1: (x1 + 1) * inv, y1: (y1 + 1) * inv });
        if (!win) throw new Error('degenerate bbox');
        bodyFits[url] = { w, h: hgt, win };
        if (im.isConnected) bodyFitPaint(im, frame, bodyFits[url]);
      } catch (e) {
        bodyFits[url] = 'fail';                       // cover fallback stands
      }
    };
    probe.onerror = () => { bodyFits[url] = 'fail'; };
    probe.src = url;
  }

  function pdHex8(id) { let s = (Number(id) >>> 0).toString(16).toUpperCase(); while (s.length < 8) s = '0' + s; return s; }
  function pdWearing(formId) {
    if (!formId || !pdState || !pdState.registry || !pdState.registry.entries) return null;
    const hx = pdHex8(formId);
    return pdState.registry.entries.filter((e) => e.ref === hx)[0] || null;
  }

  /* ---- bridge ---- */
  function requestIndex() { toGame('fdPreset', '{"op":"index"}'); }

  function pdSend(payload, pendingMsg) {
    pdBusy = true;
    fqStatus = { msg: pendingMsg, ok: true, pending: true };
    toGame('fdPreset', JSON.stringify(payload));
    render();
  }

  /* Put a preset on whoever the target chips currently name. Shared by a tile
     press and by an Omni row, so "Enter applies the top hit" in search means
     exactly what a click in the gallery means — and a refusal is the same
     sentence in both places. Returns false when there was nobody to apply to;
     the caller decides where that leaves the user. */
  function applyToTarget(name) {
    const t = resolvedTarget();
    if (!t.formId) {
      fqStatus = { msg: target.kind === 'crosshair' ? 'Look at someone in-game first' : 'No target', ok: false, pending: false };
      render();
      return false;
    }
    // First try-on of the session snapshots your own face, so ⟲ Restore has
    // something to put back.
    if (target.kind === 'me' && !backedUp) {
      backedUp = true;
      toGame('fdPreset', JSON.stringify({ op: 'saveplayer', name: BACKUP_PRESET }));
    }
    pdSend({ op: 'apply', formId: t.formId, preset: name, flags: ui.full ? 15 : 3 },
      'Applying “' + name + '” to ' + t.name + '…');
    return true;
  }

  /* ================================================================= UI == */

  /* Gallery tile cache: preset name -> the built node, kept across paints AND
     across full renders (a render detaches the grid, it does not invalidate a
     tile). Every node carries __fcSig, the signature paintGrid compares against
     — so a tile is rebuilt exactly when its appearance genuinely changed. */
  const tileCache = new Map();
  /* The CURRENT body's fire(), so a cached tile built in an earlier body never
     calls a dead closure over a detached grid/strip. */
  let curFire = null;

  function render() {
    if (!host || !host.isConnected) return;
    // Live batch pushes repaint the pane while the user may be scrolled deep
    // in the gallery — keep every scroll position (host + the grid) across the
    // rebuild so a landing face never yanks the view back to the top.
    const scrolled = [];
    if (host.scrollTop) scrolled.push([host, host.scrollTop]);
    host.querySelectorAll('*').forEach((el) => { if (el.scrollTop) scrolled.push([el.className, el.scrollTop]); });
    host.textContent = '';
    host.append(buildHeader());
    host.append(buildBody());
    scrolled.forEach(([key, top]) => {
      if (typeof key !== 'string') { key.scrollTop = top; return; }
      const el = host.querySelector('.' + String(key).trim().split(/\s+/).join('.'));
      if (el) el.scrollTop = top;
    });
  }

  function buildHeader() {
    const rt = resolvedTarget();
    const bar = h('div', { class: 'fc-head' });

    bar.append(h('div', { class: 'fc-title' }, 'Faces',
      h('span', { class: 'fc-sub' }, 'RaceMenu presets')));

    // Target chips: Looking-at · Me · (a picked follower shows as its own chip)
    const chips = h('div', { class: 'fc-targets' });
    const chip = (kind, label, tip) => h('button', {
      class: 'fc-chip' + (target.kind === kind ? ' on' : ''), type: 'button',
      'aria-pressed': String(target.kind === kind), title: tip,
      onClick: () => {
        target.kind = kind;
        if (kind !== 'pick') { target.formId = 0; target.name = ''; }
        render();
      },
    }, label);
    const c = crosshairTarget();
    chips.append(chip('crosshair', c.name ? '⌖ ' + c.name : '⌖ Looking at…',
      c.name ? 'Apply to ' + c.name + ', who you’re looking at' : 'Look at someone in-game, then apply to them'));
    chips.append(chip('me', '☺ Me', 'Try a preset on your own character (backed up so you can revert)'));
    if (target.kind === 'pick' && target.name)
      chips.append(h('span', { class: 'fc-chip on fc-chip-pick', title: 'From the Followers tab' }, '★ ' + target.name));
    bar.append(chips);

    // Status line — a refusal is the useful sentence, keep it on screen.
    if (fqStatus) {
      bar.append(h('div', {
        class: 'fc-status' + (fqStatus.pending ? ' pending' : (fqStatus.ok ? ' ok' : ' bad')),
      }, (fqStatus.pending ? '… ' : (fqStatus.ok ? '✓ ' : '✕ ')) + fqStatus.msg));
    }

    // Me-mode revert affordance: restoring the pre-try-on face.
    if (target.kind === 'me' && backedUp) {
      bar.append(h('button', {
        class: 'fc-restore', type: 'button',
        title: 'Put your own face back — the one saved before you started trying presets',
        onClick: () => {
          if (pdBusy) return;
          pdSend({ op: 'apply', formId: PLAYER_FORMID, preset: BACKUP_PRESET, flags: 15 },
            'Restoring your face…');
        },
      }, '⟲ Restore my face'));
    }
    return bar;
  }

  function buildBody() {
    const body = h('div', { class: 'fc-body' });

    if (!pdState) { body.append(h('div', { class: 'pd-empty' }, 'Reading the preset list…')); return body; }
    if (!pdState.available) {
      body.append(h('div', { class: 'pd-empty' },
        'Preset Director isn’t loaded — tick the mod in MO2 and restart the game.'));
      return body;
    }
    const names = pdNames();
    if (!names.length) {
      body.append(h('div', { class: 'pd-empty' },
        'No .jslot presets found in CharGen/Exported or CharGen/Presets.'));
      return body;
    }

    const rt = resolvedTarget();
    const worn = pdWearing(rt.formId);
    if (worn) body.append(h('div', { class: 'pd-worn' }, rt.name + ' is wearing “' + worn.preset + '”'));

    // ---- favorites + categories (from pdState.fav / cats / catOf) ----
    /* Built once per paint and then queried — see favSet() above for why. */
    const _favS = favSet();
    const _hidS = hiddenSet();
    const isFav = (n) => _favS.has(n);
    const catOf = presetCat;
    const catList = catNames;
    const toggleFav = (n) => toGame('fdPreset', JSON.stringify({ op: 'fav', preset: n, on: !isFav(n) }));
    /* Hidden presets (Rober, 2026-08-15: "ability to remove individual wigs or
       faces?"). Curation, never a file operation — the .jslot stays where it
       is, so anything hidden comes straight back from the Hidden pill. Hiding
       also takes it out of the auto-render batch, which is how the presets
       whose race can't be told stop failing on every run. */
    const isHidden = (n) => _hidS.has(n);
    const setHidden = (n, on) => toGame('fdPreset', JSON.stringify({ op: 'hide', preset: n, on: !!on }));
    const hiddenCount = () => (pdState.hidden || []).length;
    const setCat = (n, c) => toGame('fdPreset', JSON.stringify({ op: 'cat-set', preset: n, cat: c }));

    // Mode chips
    const modeRow = h('div', { class: 'pd-modes' });
    const chip = (label, key, tip) => {
      const on = ui.mode === key;
      return h('button', { class: 'fc-set pd-chip' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': String(on), title: tip,
        onClick: () => { ui.mode = on ? '' : key; ui.assignFor = null; ui.catFor = null; render(); } }, label);
    };
    modeRow.append(chip('＋ Summon', 'summon', 'A tile click SPAWNS a new person wearing that preset. Name her below.'));
    modeRow.append(chip('🖼 Set image', 'assign',
      'A tile click sets which image represents that preset. Take a photo of your character wearing it, then pick the file here.'));
    modeRow.append(chip('🗂 Categorize', 'cat',
      'A tile click files that preset into a category. Make new categories below. ☆ on any tile favourites it.'));
    /* 🧪 Debug render — the in-game experiment (Rober, 2026-08-16: "we need to
       figure this out in game for sure, no guessing"). It renders one preset to
       its OWN throwaway file and LEAVES the stand-in standing next to you, so
       you can walk up and look at the actual actor. That settles in one look
       what no log could: an actor wearing a dress with white patches on her
       face means the fault is in how we build her; an actor who looks perfect
       beside a broken picture means the fault is in the render path. */
    modeRow.append(chip('🧪 Debug render', 'probe',
      'A tile click renders that preset and LEAVES the stand-in standing next to you to inspect. ' +
      'Writes a throwaway file — your real tile is never touched.'));
    if (ui.standIn) {
      modeRow.append(h('button', { class: 'fc-set pd-chip pd-standin', type: 'button',
        title: 'Send the debug stand-in away (she stays put until you do, even across another render).',
        onClick: () => { pdSend({ op: 'standin-clear' }, 'Sending her away…'); } },
        '⛔ Send her away'));
    }
    const fullOn = !!ui.full;
    modeRow.append(h('button', { class: 'fc-set pd-chip' + (fullOn ? ' on' : ''), type: 'button',
      'aria-pressed': String(fullOn),
      title: fullOn ? 'Applying the FULL preset incl. skin overrides — can tint skin. Click for face-only.'
                    : 'Face shape + morphs only (safe). Click to also apply the preset’s skin overrides.',
      onClick: () => { ui.full = !fullOn; render(); } }, fullOn ? '⚠ Full look' : '◇ Face only'));
    // ✨ Auto-render: every preset with no image gets a face thumbnail — PD
    // spawns a stand-in, applies the preset, MRF renders it. The batch needs
    // Papyrus running (LoadCharacterEx), so the palette closes; HUD messages
    // narrate progress, and while it runs a reopened deck shows live k/N with
    // a Stop chip (the index push per finished face repaints the gallery).
    const ar = (pdState && pdState.autorender) || null;
    /* Every batch number comes from computeCounts() now — assignments PLUS the
       orphan renders on disk, minus hidden presets, minus the ones that fail
       the shape pass every run. Rober's "redo 1" (2026-08-16) was this count
       reading assign.json alone while 234 renders sat unlinked. */
    const cnt = computeCounts();
    const missingN = cnt.missing.length;
    const blockedN = cnt.blocked.length;
    const autoN = cnt.auto;
    const batchRunning = !!(ar && ar.running);
    if (batchRunning && ar.cancelling) {
      modeRow.append(h('span', { class: 'pd-chip pd-autorender is-running is-stopping',
        title: 'Finishing the face in progress, then stopping. Finished thumbnails are kept.' },
        '⏹ Stopping after this face…'));
    } else if (batchRunning) {
      modeRow.append(h('span', { class: 'pd-chip pd-autorender is-running',
        title: 'Faces are rendering in the background — close the deck to let it work.' },
        '⏳ Rendering ' + ((ar.done || 0) + (ar.failed || 0)) + '/' + (ar.total || '?') + '…'));
      modeRow.append(h('button', { class: 'fc-set pd-chip pd-autorender-stop', type: 'button',
        title: 'Stop after the current face — finished thumbnails are kept, and the button resumes where it left off.',
        onClick: (e) => {
          // Optimistic flip: the confirming index push takes a moment. Find the
          // chip by CLASS, not previousSibling — a sibling control added later
          // would silently retarget this and the Stop would look dead.
          const chip = modeRow.querySelector('.pd-autorender.is-running');
          if (chip) { chip.textContent = '⏹ Stopping after this face…'; chip.classList.add('is-stopping'); }
          e.currentTarget.remove();
          toGame('fdPreset', JSON.stringify({ op: 'autorender-cancel' }));
        } },
        '⏹ Stop'));
    } else if (pdState && pdState.available && missingN > 0) {
      /* ✨ press → the deck closes and the game does ~4 s of work per face, so
         nothing here confirms it for a moment. Rober read that silence as "it
         does nothing" once already (the six blocked presets, 2026-08-16), so
         the button flips to a starting state and the status line speaks. */
      const starting = !!ui.batchStarting;
      modeRow.append(h('button', {
        class: 'fc-set pd-chip pd-autorender' + (starting ? ' is-starting' : ''), type: 'button',
        title: starting ? 'Asking the game to start the batch…'
          : 'Render a face for every preset that has none — ' + missingN + ' of them, ' + estText(missingN) +
            '. The deck closes, a lone stand-in appears beside you, and corner messages narrate it. Stop any time.',
        onClick: () => {
          if (ui.batchStarting) return;
          ui.batchStarting = true;
          fqStatus = { msg: 'Starting ' + missingN + ' faces (' + estText(missingN) +
            ') — the deck closes while it works. Reopen it any time to Stop.', ok: true, pending: true };
          toGame('fdPreset', JSON.stringify({ op: 'autorender' }));
          render();
          // Backstop: if no index push confirms a running batch, stop lying
          // about it rather than leaving a permanently "starting" button.
          setTimeout(() => {
            if (!ui.batchStarting) return;
            ui.batchStarting = false;
            if (isActive()) render();
          }, 8000);
        } },
        starting ? '⏳ Starting…' : '✨ Render missing (' + missingN + ')'));
    }
    /* The sibling that answers "render missing (6) seems to do nothing": those
       six are NOT in the count above, and this says so out loud. */
    if (pdState && pdState.available && blockedN > 0) {
      modeRow.append(h('button', {
        class: 'fc-set pd-chip pd-blocked-chip' + (ui.showBlocked ? ' on' : ''), type: 'button',
        'aria-pressed': String(!!ui.showBlocked),
        title: 'These presets fail before the render even starts, so ✨ Render missing skips them. ' +
               'Open this to see why — and to render one as a race you choose.',
        onClick: () => { ui.showBlocked = !ui.showBlocked; if (!ui.showBlocked) ui.failFor = null; render(); } },
        '⚠ ' + blockedN + ' can’t be rendered — why?'));
    }
    // ↻ Re-render all: the escape hatch for a batch that rendered glitched
    // (armed two-press, the deck's destructive-action idiom).
    if (pdState && pdState.available && autoN > 0 && !batchRunning) {
      const armed = ui.redoArmed;
      modeRow.append(h('button', { class: 'fc-set pd-chip pd-redo' + (armed ? ' is-armed' : ''), type: 'button',
        title: armed ? 'Click again to delete all ' + autoN + ' auto-rendered images and re-render them fresh.'
                     : 'Throw away every auto-rendered thumbnail and render them again (e.g. after a glitched batch).',
        onClick: () => {
          if (!armed) { ui.redoArmed = true; render(); setTimeout(() => { if (ui.redoArmed) { ui.redoArmed = false; if (isActive()) render(); } }, 4000); return; }
          ui.redoArmed = false;
          toGame('fdPreset', JSON.stringify({ op: 'autorender-redo' }));
        } },
        armed ? '↻ Sure? Redo ' + autoN : '↻ Re-render all'));
    }
    body.append(modeRow);

    /* ---- what a batch actually COSTS, said before the press ---------------
       Rober, 2026-08-16: "the face generation stuff causes some pretty bad lag
       in general". 114 faces is ~8 minutes of the game spawning, dressing and
       rendering a stand-in — that has to be on screen next to the button, not
       hidden in a tooltip he'd have to hover to find. */
    {
      const cost = h('div', { class: 'pd-cost' });
      if (batchRunning) {
        const doneAll = (ar.done || 0) + (ar.failed || 0);
        const left = Math.max(0, (ar.total || 0) - doneAll);
        cost.textContent = (ar.cancelling ? 'Stopping after this face. ' : '') +
          (left ? estText(left) + ' left · ' : '') +
          'The game is busy while this runs — finished faces are kept if you Stop.';
      } else if (pdState.available && missingN > 0) {
        cost.textContent = missingN + ' face' + (missingN === 1 ? '' : 's') + ' to render · ' + estText(missingN) +
          ' · the deck closes, a stand-in appears beside you, and the game will be busy · Stop any time';
      }
      if (cost.textContent) body.append(cost);
    }

    /* ---- armed-mode banner ------------------------------------------------
       "set image button seems to do nothing" (2026-08-16) — it is a MODE chip:
       it silently changed what the NEXT tile click means. Nothing said so. Now
       an armed mode states it, in a bar you cannot miss, with the way out. */
    if (ui.mode) {
      const say = {
        assign: ['🖼 Set image is ON',
          'Click a face below — the picture picker opens under the grid, and your choice becomes that preset’s tile.'],
        summon: ['＋ Summon is ON',
          'Click a face below to spawn a new person wearing it. Name her in the box under this bar first.'],
        cat: ['🗂 Categorize is ON',
          'Click a face below to file it into a category. ☆ on any tile favourites it instead.'],
        probe: ['🧪 Debug render is ON',
          'Click a face below. The deck closes, that preset renders to a throwaway file, and the ' +
          'stand-in STAYS next to you — walk up and look at her face and her clothes, then press ' +
          '⛔ Send her away. Your real tile is never touched.'],
      }[ui.mode];
      if (say) {
        body.classList.add('fc-armed');
        const bar = h('div', { class: 'fc-armbar fc-armbar-' + ui.mode });
        bar.append(h('span', { class: 'fc-armbar-t' }, say[0]));
        // The honest empty case: an armed picker with no files to pick beats a
        // blank popup only if it says where the files go.
        const noFiles = ui.mode === 'assign' && !((pdState.icons || []).length);
        bar.append(h('span', { class: 'fc-armbar-s' }, noFiles
          ? 'There are no image files yet. Press ✨ Render missing above, or drop PNGs into ' +
            'PrismaUI/views/HotkeyDeck/preset-icons/ and reopen the deck.'
          : say[1]));
        bar.append(h('button', { class: 'fc-set fc-armbar-x', type: 'button',
          title: 'Leave this mode — a tile click goes back to applying the preset (Esc does the same)',
          onClick: () => { ui.mode = ''; ui.assignFor = null; ui.catFor = null; render(); } }, '✓ Done'));
        body.append(bar);
      }
    }

    /* ---- "⚠ N can't be rendered" ------------------------------------------
       One card, one row per preset: the reason, retry, a race/sex override, and
       the honest last resort (hide it, which also drops it from the batch).
       A tile that just sits there with no image and no explanation is the bug
       being fixed here — every blocked preset now has somewhere to go. */
    function buildRaceEditor(name) {
      const wrap = h('div', { class: 'pd-raceed' });
      const sh = presetShape(name);
      wrap.append(h('div', { class: 'pd-raceed-head' },
        'Render “' + name + '” as' + (sh.race ? ' — the shape pass guessed ' + sh.race + ', pre-filled below' : '') + ':'));
      const sexRow = h('div', { class: 'pd-raceed-sex' });
      [['female', '♀ Female'], ['male', '♂ Male']].forEach((s) => {
        sexRow.append(h('button', {
          class: 'fc-set fc-catchip' + (ui.raceSex === s[0] ? ' on' : ''), type: 'button',
          'aria-pressed': String(ui.raceSex === s[0]),
          title: 'Build the face on the ' + s[0] + ' head',
          onClick: () => { ui.raceSex = s[0]; render(); } }, s[1]));
      });
      wrap.append(sexRow);
      const chips = h('div', { class: 'fc-catfilter pd-racelist' });
      const hitsFor = () => {
        const q = String(ui.raceQ || '').toLowerCase().trim();
        const all = raceList();
        if (!q) return all;
        return all.filter((r) => r.label.toLowerCase().indexOf(q) !== -1 || r.edid.toLowerCase().indexOf(q) !== -1);
      };
      const go = (edid) => {
        if (!edid) return;
        ui.failFor = null;
        rrFire(name, { race: edid, sex: ui.raceSex || 'female' });
      };
      const paintRaces = () => {
        chips.textContent = '';
        const q = String(ui.raceQ || '').trim();
        const hits = hitsFor();
        if (!hits.length) {
          // A modded race the list never heard of is still legal — the typed
          // EditorID goes through verbatim, which is why this is not a dead end.
          chips.append(h('div', { class: 'pd-empty' },
            'No race here matches “' + q + '” — press Enter to send it as an EditorID anyway (e.g. a modded race).'));
          return;
        }
        hits.slice(0, 40).forEach((r, i) => {
          const top = !!q && i === 0;
          chips.append(h('button', {
            class: 'fc-set fc-catchip' + (top ? ' on' : '') + (sh.race && sh.race === r.edid ? ' is-guess' : ''),
            type: 'button',
            title: r.edid + (sh.race === r.edid ? ' — what the shape pass guessed' : '') +
              ' · renders one face, a few seconds, stand-in beside you',
            onClick: () => go(r.edid) }, r.label));
        });
      };
      const inp = h('input', { class: 'fc-newcat pd-raceq', type: 'text',
        placeholder: 'Type a race… Enter renders with the top match', value: ui.raceQ || '' });
      inp.addEventListener('input', () => { ui.raceQ = inp.value; paintRaces(); });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = String(ui.raceQ || '').trim();
          if (!q) return;                       // an empty box must not fire the first race in the list
          const hits = hitsFor();
          go(hits.length ? hits[0].edid : q);
        } else if (e.key === 'Escape') { e.preventDefault(); ui.failFor = null; render(); }
        e.stopPropagation();
      });
      inp.addEventListener('click', (e) => e.stopPropagation());
      wrap.append(inp);
      wrap.append(chips);
      paintRaces();
      return wrap;
    }

    if (pdState.available && blockedN > 0 && (ui.showBlocked || ui.failFor)) {
      const card = h('div', { class: 'pd-blocked' });
      card.append(h('div', { class: 'pd-blocked-head' },
        '⚠ ' + blockedN + ' preset' + (blockedN === 1 ? '' : 's') + ' the renderer refuses',
        h('span', { class: 'pd-blocked-sub' },
          'These are skipped by ✨ Render missing — otherwise every batch would fail on them again. ' +
          'Tell one which race to build on and it renders like any other.')));
      cnt.blocked.forEach((n) => {
        const why = failReason(n) || 'the renderer gave no reason';
        const open = ui.failFor === n;
        const row = h('div', { class: 'pd-blocked-row' + (open ? ' is-open' : '') });
        row.append(h('span', { class: 'pd-blocked-name', title: n }, n));
        row.append(h('span', { class: 'pd-blocked-why', title: why }, why));
        const acts = h('span', { class: 'pd-blocked-acts' });
        acts.append(h('button', { class: 'fc-set pd-blocked-b' + (rrPending(n) ? ' is-busy' : ''), type: 'button',
          title: rrPending(n) ? 'Already rendering this one…'
            : 'Try this one again exactly as it is — a few seconds, stand-in beside you.',
          onClick: () => rrFire(n) }, rrPending(n) ? '⟳ Rendering…' : '⟳ Try again'));
        acts.append(h('button', { class: 'fc-set pd-blocked-b' + (open ? ' on' : ''), type: 'button',
          title: isRaceFail(why) ? 'Say which race and sex to build this face on — this is the fix for "can’t tell its race".'
                                 : 'Force a race and sex for this face and render it anyway.',
          onClick: () => {
            if (open) { ui.failFor = null; render(); return; }
            ui.failFor = n; seedRaceEditor(n); render();
          } }, '🎭 Render as…'));
        acts.append(h('button', { class: 'fc-set pd-blocked-b', type: 'button',
          title: 'Take “' + n + '” out of the tab. The .jslot file is kept — the ⊘ Hidden pill brings it back.',
          onClick: () => setHidden(n, true) }, '✕ Hide it'));
        row.append(acts);
        card.append(row);
        if (open) card.append(buildRaceEditor(n));
      });
      body.append(card);
    }

    // Category filter row: All · ★ Favorites · <each category> · Uncategorized.
    // In Categorize mode each category chip grows rename/delete, plus ＋ New.
    const catRow = h('div', { class: 'fc-catfilter' });
    const fchip = (key, label, tip) => {
      const on = (ui.catFilter || '') === key;
      return h('button', { class: 'fc-set fc-catchip' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': String(on), title: tip || label,
        onClick: () => { ui.catFilter = on ? '' : key; ui.sel = 0; render(); } }, label);
    };
    catRow.append(fchip('', 'All'));
    catRow.append(fchip('__fav__', '★ Favorites', 'Only presets you starred'));
    /* Only worth a chip once something is IN it — an always-on "Hidden 0" is
       clutter, and its absence says the tab is showing you everything. */
    if (hiddenCount())
      catRow.append(fchip('__hidden__', '⊘ Hidden ' + hiddenCount(),
        'Presets you removed from the tab — they are still on disk; bring one back with ⟲'));
    catList().forEach((c) => {
      if (ui.mode === 'cat' && ui.renameCat === c) {
        // Inline rename (PrismaUI has no window.prompt): the chip becomes a field.
        const ri = h('input', { class: 'fc-newcat fc-rename-input', type: 'text', value: c });
        ri.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const to = ri.value.trim();
            if (to && to !== c) toGame('fdPreset', JSON.stringify({ op: 'cat-rename', from: c, to }));
            ui.renameCat = null;
            if (!to || to === c) render();
          } else if (e.key === 'Escape') { ui.renameCat = null; render(); }
          e.stopPropagation();
        });
        ri.addEventListener('click', (e) => e.stopPropagation());
        catRow.append(ri);
      } else if (ui.mode === 'cat') {
        const wrap = h('span', { class: 'fc-catedit' });
        wrap.append(fchip(c, c));
        wrap.append(h('button', { class: 'fc-catx', type: 'button', title: 'Rename “' + c + '”',
          onClick: (e) => { e.stopPropagation(); ui.renameCat = c; render(); } }, '✎'));
        wrap.append(h('button', { class: 'fc-catx', type: 'button', title: 'Delete “' + c + '” (presets are kept, just un-filed)',
          onClick: (e) => { e.stopPropagation(); toGame('fdPreset', JSON.stringify({ op: 'cat-del', name: c })); } }, '✕'));
        catRow.append(wrap);
      } else {
        catRow.append(fchip(c, c));
      }
    });
    catRow.append(fchip('__none__', 'Uncategorized'));
    if (ui.mode === 'cat') {
      const nc = h('input', { class: 'fc-newcat', type: 'text', placeholder: '＋ New category…', value: '' });
      nc.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const v = nc.value.trim();
          if (v) toGame('fdPreset', JSON.stringify({ op: 'cat-new', name: v }));
        }
        e.stopPropagation();
      });
      nc.addEventListener('click', (e) => e.stopPropagation());
      catRow.append(nc);
    }
    body.append(catRow);

    if (ui.mode === 'summon') {
      const nameIn = h('input', { class: 'pd-name', type: 'text',
        placeholder: 'Her name (e.g. Testa) — Enter jumps to search', value: ui.summonName || '' });
      nameIn.addEventListener('input', () => { ui.summonName = nameIn.value; });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const s = body.querySelector('.pd-search'); if (s) s.focus(); }
        e.stopPropagation();
      });
      body.append(h('div', { class: 'pd-summon-row' }, nameIn));
    }

    // Search + count + grid + assign strip
    const search = h('input', { class: 'pd-search', type: 'text',
      placeholder: 'Type a preset or a category… ↑↓ pick, Enter applies', value: ui.filter || '' });
    body.append(search);
    const count = h('div', { class: 'pd-count' });
    body.append(count);
    const grid = h('div', { class: 'pd-grid fc-grid' });
    body.append(grid);
    const strip = h('div', { class: 'pd-iconstrip' });
    body.append(strip);

    // Ordered render model: a list of {head} and {name} items, plus a flat
    // name list for keyboard nav. Grouping only when unfiltered + "All".
    const buildItems = () => {
      const q = String(ui.filter || '').toLowerCase().trim();
      const items = [], flat = [];
      const push = (n) => { items.push({ name: n }); flat.push(n); };
      const head = (t) => items.push({ head: t });

      const filt = ui.catFilter || '';
      if (filt === '__hidden__') {
        const hid = names.filter(isHidden);
        if (hid.length) head('Hidden — click ⟲ on a tile to bring it back');
        hid.forEach(push);
        return { items, flat };
      }
      /* everywhere else, a hidden preset is simply not there */
      const shown = names.filter((n) => !isHidden(n));
      if (q) {
        /* The category NAME is part of the haystack: categories are unbounded
           (＋ New makes as many as you like) and their chip row has no filter
           of its own, so typing "court" has to reach the presets filed under
           Court as well as the ones called it. */
        shown.filter((n) => n.toLowerCase().indexOf(q) !== -1 ||
                            catOf(n).toLowerCase().indexOf(q) !== -1).forEach(push);
        return { items, flat };
      }
      if (filt === '__fav__') { shown.filter(isFav).forEach(push); return { items, flat }; }
      if (filt === '__none__') { shown.filter((n) => !catOf(n)).forEach(push); return { items, flat }; }
      if (filt) { shown.filter((n) => catOf(n) === filt).forEach(push); return { items, flat }; }

      // "All": Favorites, then each category, then Uncategorized.
      const favs = shown.filter(isFav);
      if (favs.length) { head('★ Favorites'); favs.forEach(push); }
      catList().forEach((c) => {
        const inC = shown.filter((n) => catOf(n) === c);
        if (inC.length) { head(c); inC.forEach(push); }
      });
      const none = shown.filter((n) => !catOf(n));
      if (none.length) { if (catList().length || favs.length) head('Uncategorized'); none.forEach(push); }
      return { items, flat };
    };
    /* buildItems walks every preset and was called three times per paint (once
       by paintGrid, twice more through selIdx -> flatList). Memoised on what it
       actually depends on — the two filters — and dropped whenever a paint
       starts, so nothing can read a stale list. */
    let itemsMemo = null, itemsMemoKey = '';
    const itemsNow = () => {
      const key = String(ui.filter || '') + '\u0000' + String(ui.catFilter || '');
      if (!itemsMemo || itemsMemoKey !== key) { itemsMemo = buildItems(); itemsMemoKey = key; }
      return itemsMemo;
    };
    const dropItemsMemo = () => { itemsMemo = null; };
    const flatList = () => itemsNow().flat;
    const selIdx = () => Math.min(Math.max(0, ui.sel | 0), Math.max(0, flatList().length - 1));

    const fire = (name) => {
      if (pdBusy) return;
      if (ui.mode === 'assign') { ui.assignFor = (ui.assignFor === name) ? null : name; paintStrip(); paintGrid(); return; }
      if (ui.mode === 'cat') { ui.catFor = (ui.catFor === name) ? null : name; paintStrip(); paintGrid(); return; }
      if (ui.mode === 'probe') {
        pdSend({ op: 'render-probe', preset: name },
          'Rendering “' + name + '” — she will be left standing next to you.');
        return;
      }
      if (ui.mode === 'summon') {
        const nm = String(ui.summonName || '').trim() || ('New ' + name);
        pdSend({ op: 'spawn', name: nm, preset: name, flags: ui.full ? 15 : 3 },
          'Summoning ' + nm + ' as “' + name + '”…');
        return;
      }
      applyToTarget(name);
    };

    /* One tile's whole appearance, as a string. If this is unchanged the node
       in the cache is still correct and is reused verbatim — which is the point:
       a tile owns an <img>, and an <img> recreated is an <img> re-decoded. The
       SELECTION is deliberately not in here; it is a class toggled in place, so
       moving the cursor never rebuilds a tile. */
    const tileSig = (name) => [
      pdIconFor(name), isFav(name) ? 1 : 0, isHidden(name) ? 1 : 0, catOf(name),
      failReason(name) || '', rrPending(name) ? 1 : 0,
      ui.assignFor === name ? 1 : 0, ui.catFor === name ? 1 : 0,
      (worn && worn.preset === name) ? 1 : 0, ui.mode || '',
      (ar && ar.running) ? 1 : 0, rt.name || '',
    ].join('');

    const buildTile = (name) => {
      const icon = pdIconFor(name), fav = isFav(name), mine = catOf(name);
      const why = icon ? '' : failReason(name);     // a rendered preset is not a failure any more
      const rendering = rrPending(name);
      const cls = 'pd-tile'
        + (ui.assignFor === name ? ' is-assigning' : '')
        + (ui.catFor === name ? ' is-assigning' : '')
        + (why ? ' is-failed' : '')
        + (rendering ? ' is-rendering' : '')
        + (worn && worn.preset === name ? ' is-worn' : '');
      const tile = h('button', { class: cls, type: 'button',
        title: (ui.mode === 'summon' ? 'Summon a new person wearing “' + name + '”'
          : ui.mode === 'assign' ? 'Set the image for “' + name + '”'
          : ui.mode === 'cat' ? 'File “' + name + '” into a category (below)'
          : 'Apply “' + name + '” to ' + rt.name),
        /* The tile's position is read off the node, not captured — a cached
           tile outlives the paint that made it, so a captured index would go
           stale the moment the filter moved it. Same reason fire() is reached
           through curFire: a reused tile must always talk to the CURRENT body,
           never the one it happened to be built in. */
        onClick: () => { ui.sel = Number(tile.getAttribute('data-idx')) || 0; if (curFire) curFire(name); } });
      // ☆ favourite corner — always available, one click, never fires the tile.
      tile.append(h('button', { class: 'pd-fav' + (fav ? ' on' : ''), type: 'button',
        title: fav ? 'Un-favourite' : 'Favourite this preset',
        onClick: (e) => { e.stopPropagation(); toggleFav(name); } }, fav ? '★' : '☆'));
      // ✕ / ⟲ — take this preset out of the tab, or put it back. The file is
      // never touched; hiding also drops it from the auto-render batch.
      {
        const hid = isHidden(name);
        tile.append(h('button', { class: 'pd-hide' + (hid ? ' on' : ''), type: 'button',
          title: hid ? 'Bring “' + name + '” back into the tab'
                     : 'Remove “' + name + '” from the tab (the preset file is kept)',
          onClick: (e) => { e.stopPropagation(); setHidden(name, !hid); } }, hid ? '⟲' : '✕'));
      }
      /* ⟳ re-render THIS one (Rober, 2026-08-16: "re-render individual needs
         to be a button on a face"). Left column, under 🔍 — mirroring ☆/✕ on
         the right, so no two corner controls can ever land on each other.
         PD_ face backups are our own snapshots, not gallery faces, so they
         get no button: rendering one would spend 4 s on a tile nobody uses. */
      if (name.slice(0, 3) !== 'PD_') {
        const batch = !!(ar && ar.running);
        tile.append(h('button', {
          class: 'pd-rr' + (rendering ? ' is-busy' : '') + (batch ? ' is-blocked' : ''), type: 'button',
          title: rendering ? 'Rendering “' + name + '” now — the stand-in beside you is her.'
            : batch ? 'A batch is rendering — Stop it (chip above) before re-rendering one face.'
            : (icon ? 'Re-render this face' : 'Render this face') +
              ' — a few seconds, and a stand-in appears beside you while it works.',
          onClick: (e) => { e.stopPropagation(); if (rendering) return; rrFire(name); },
        }, '⟳'));
      }
      // 🔍 lightbox corner — big popout of the preset image (tile CLICK
      // applies the preset, so the zoom needs its own control).
      if (icon)
        tile.append(h('button', { class: 'pd-zoom', type: 'button', title: 'View large',
          onClick: (e) => {
            e.stopPropagation();
            if (window.HDLightbox && host)
              window.HDLightbox.open({ host: host, src: 'preset-icons/' + encodeURIComponent(icon),
                glyph: '🎭', title: name, sub: 'RaceMenu preset' });
          } }, '🔍'));
      const face = h('div', { class: 'pd-face' });
      if (icon && icon.slice(0, 5) === 'auto-') {
        // Auto-rendered stand-in PNG: a framed opaque head (live engine,
        // shown whole) or a whole transparent-bg figure (MRF fallback). NOT
        // hd-facefit: its formula is calibrated for HEAD renders (face =
        // top + K*bboxWidth) and frames the torso on a full body. bodyFit
        // below derives the head window from figure HEIGHT instead.
        const u = 'preset-icons/' + encodeURIComponent(icon);
        const im = h('img', { class: 'pd-face-img', src: u, alt: '',
          onError: () => { im.remove(); } });
        face.append(im);
        bodyFitEnsure(im, u, face);
      } else if (icon) {
        face.style.backgroundImage = 'url("preset-icons/' + cssEsc(encodeURIComponent(icon)) + '")';
      } else {
        face.append(h('span', { class: 'pd-initial' }, name.slice(0, 1).toUpperCase()));
      }
      /* In-flight state ON the tile you pressed — a ⟳ click that produced no
         visible change was the whole complaint. One rotating glyph inside the
         frame: transform-rotate on a small element is the animation Ultralight
         is PROVEN to draw cleanly (an animated background-position smears). */
      if (rendering)
        face.append(h('span', { class: 'pd-rendering', title: 'Rendering — a stand-in is posing for this face beside you' },
          h('span', { class: 'pd-rendering-g' }, '⟳')));
      /* A preset the renderer refuses says so on its own tile, with the reason
         on hover and somewhere to go on click — never a tile that just sits
         there (Rober, 2026-08-16: "render missing (6) seems to do nothing"). */
      if (why)
        face.append(h('button', { class: 'pd-failbar', type: 'button',
          title: 'Couldn’t render this face: ' + why + '. Click to fix it — pick the race to render as.',
          onClick: (e) => {
            e.stopPropagation();
            ui.showBlocked = true; ui.failFor = name; seedRaceEditor(name); render();
          } }, '⚠ why?'));
      tile.append(face, h('span', { class: 'pd-tile-name', title: name }, name));
      if (ui.mode === 'cat' && mine) tile.append(h('span', { class: 'pd-tile-cat' }, mine));
      return tile;
    };

    function paintGrid() {
      curFire = fire;
      dropItemsMemo();
      grid.classList.toggle('pd-busy', pdBusy);
      const { items, flat } = itemsNow();
      const favN = (pdState.fav || []).length;
      /* Every number here is computeCounts()' — one truth, printed once. The
         2026-08-16 play-test read "redo 1" off a count that only knew about
         assign.json; "adopted from disk" is deliberately visible so a lost
         assignment shows up as a fact rather than as a wrong total. */
      const parts = [];
      parts.push(String(ui.filter || '').trim() ? flat.length + ' of ' + cnt.total + ' presets' : cnt.total + ' presets');
      if (favN) parts.push(favN + ' ★');
      parts.push(cnt.withImg + ' with images');
      if (missingN) parts.push(missingN + ' still to render');
      if (blockedN) parts.push(blockedN + ' can’t be rendered');
      if (cnt.orphan) parts.push(cnt.orphan + ' adopted from disk');
      count.textContent = parts.join(' · ');
      count.setAttribute('title', cnt.orphan
        ? cnt.orphan + ' rendered image' + (cnt.orphan === 1 ? ' is' : 's are') + ' sitting in preset-icons/ with no row in ' +
          'assign.json — the tab shows them rather than offering to render the same faces twice.'
        : 'Counts every preset the tab is showing (hidden ones are excluded).');

      /* ---- the reconcile ---------------------------------------------------
         The gallery used to be emptied and rebuilt on every keystroke: on
         Rober's 234-preset rig that is 234 tiles, 234 <img> decodes and ~900
         elements, thrown away one letter later. Now every tile is cached by
         name and kept as long as its appearance signature holds, so typing
         only MOVES nodes — no element creation, no image decode. */
      const sel = selIdx();
      const want = [];
      /* A favourite that also sits in a category is DRAWN TWICE under "All" —
         once under ★ Favorites, once under its group — so the cache key carries
         the occurrence. Keying on the bare name would silently collapse the two
         into one tile and shift every index after it. */
      const seen = new Map();
      const keyOf = (base) => {
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return base + '#' + n;
      };
      if (!flat.length) {
        want.push({ k: 'E:' + String(ui.filter || ''), build: () =>
          h('div', { class: 'pd-empty' }, 'Nothing here' + (ui.filter ? ' matches “' + ui.filter + '”' : '')) });
      } else {
        let tileIdx = -1;
        for (let n = 0; n < items.length; n++) {
          const it = items[n];
          if (it.head != null) {
            want.push({ k: keyOf('H:' + it.head), build: () => h('div', { class: 'pd-group-head' }, it.head) });
            continue;
          }
          tileIdx++;
          want.push({ k: keyOf('T:' + it.name), name: it.name, idx: tileIdx, sig: tileSig(it.name),
                      build: () => buildTile(it.name) });
        }
      }

      let cur = grid.firstChild;
      for (let n = 0; n < want.length; n++) {
        const w = want[n];
        let node = tileCache.get(w.k);
        if (!node || node.__fcSig !== (w.sig || '')) {
          node = w.build();
          node.__fcSig = w.sig || '';
          tileCache.set(w.k, node);
        }
        if (w.name != null) {
          // volatile, written in place so a moving cursor never rebuilds a tile
          node.setAttribute('data-idx', String(w.idx));
          node.classList.toggle('is-sel', w.idx === sel);
        }
        if (cur === node) { cur = cur.nextSibling; continue; }
        grid.insertBefore(node, cur);     // insertBefore MOVES an attached node
      }
      while (cur) { const nx = cur.nextSibling; grid.removeChild(cur); cur = nx; }

      const selEl = grid.querySelector('.pd-tile.is-sel');
      // Follow the selection only when it MOVED — a live-batch repaint with a
      // parked selection must not scroll the gallery out from under the user.
      if (selEl && selEl.scrollIntoView && paintGrid._lastSel !== sel) selEl.scrollIntoView({ block: 'nearest' });
      paintGrid._lastSel = sel;
    }

    /* The picker opens BELOW a gallery that can be hundreds of tiles long — on
       Rober's rig the strip landed far off screen, which is a large part of why
       "set image button seems to do nothing" (2026-08-16). Bring it to him.
       Guarded: jsdom (and old WebKit) have no scrollIntoView. */
    function stripIntoView() {
      if (!strip || typeof strip.scrollIntoView !== 'function') return;
      try { strip.scrollIntoView({ block: 'nearest' }); } catch (e) { /* not fatal */ }
    }

    function paintStrip() {
      strip.textContent = '';
      // Image picker (Set-image mode)
      if (ui.mode === 'assign' && ui.assignFor) {
        const current = pdState.assign && pdState.assign[ui.assignFor];
        const files = (pdState.icons || []).slice();
        /* The honest empty case FIRST. An armed mode whose picker is an empty
           box is exactly the "seems to do nothing" Rober reported — say where
           the files go instead (2026-08-16). */
        if (!files.length) {
          strip.append(h('div', { class: 'pd-strip-head' }, 'No pictures to choose from for “' + ui.assignFor + '”'));
          strip.append(h('div', { class: 'pd-empty' },
            'preset-icons/ is empty. Press “✨ Render missing” above to auto-render every preset’s face, or take a ' +
            'picture of your character wearing a preset (F12, or the Followers ◉ Portrait on yourself) and drop the ' +
            'PNG into PrismaUI/views/HotkeyDeck/preset-icons/ — it shows up here after the next deck open.'));
          stripIntoView();
          return;
        }
        strip.append(h('div', { class: 'pd-strip-head' },
          'Image for “' + ui.assignFor + '” — ' + files.length + ' file' + (files.length === 1 ? '' : 's') +
          ' in preset-icons/:'));
        const row = h('div', { class: 'pd-strip-row' });
        const pick = (f) => {
          toGame('fdPreset', JSON.stringify({ op: 'img', preset: ui.assignFor, icon: f }));
          fqStatus = { msg: f ? 'Picture set for “' + ui.assignFor + '”' : 'Picture cleared for “' + ui.assignFor + '”',
            ok: true, pending: false };
          ui.assignFor = null; ui.imgQ = '';
          render();     // answer the click NOW; the index push repaints again when it lands
        };
        const hitsFor = () => {
          const q = String(ui.imgQ || '').toLowerCase().trim();
          return q ? files.filter((f) => f.toLowerCase().indexOf(q) !== -1) : files;
        };
        const paintRow = () => {
          row.textContent = '';
          const hits = hitsFor();
          if (!hits.length) {
            row.append(h('div', { class: 'pd-empty' }, 'No file matches “' + ui.imgQ + '”'));
          } else {
            hits.slice(0, 400).forEach((f) => {
              const b = h('button', { class: 'pd-icon' + (current === f ? ' on' : ''), type: 'button',
                title: f + (current === f ? ' — current' : ''), onClick: () => pick(f) });
              b.style.backgroundImage = 'url("preset-icons/' + cssEsc(encodeURIComponent(f)) + '")';
              row.append(b);
            });
          }
          row.append(h('button', { class: 'pd-icon is-none', type: 'button', title: 'No image — back to the letter tile',
            onClick: () => pick('') }, '✕'));
        };
        /* The standing rule: past ~10 things to choose from, you type. His rig
           has 234 of these files, and the old strip was an unfiltered 120px
           scroller — findable only by luck. */
        if (files.length > 10) {
          const q = h('input', { class: 'pd-search pd-imgq', type: 'text',
            placeholder: 'Filter the pictures… Enter takes the top one', value: ui.imgQ || '' });
          q.addEventListener('input', () => { ui.imgQ = q.value; paintRow(); });
          q.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); const hits = hitsFor(); if (hits.length) pick(hits[0]); }
            else if (e.key === 'Escape') { e.preventDefault(); ui.assignFor = null; ui.imgQ = ''; render(); }
            e.stopPropagation();
          });
          strip.append(q);
        }
        paintRow();
        strip.append(row);
        stripIntoView();
        return;
      }
      // Category picker (Categorize mode) — file the picked preset.
      if (ui.mode === 'cat' && ui.catFor) {
        const cur = catOf(ui.catFor);
        strip.append(h('div', { class: 'pd-strip-head' }, 'File “' + ui.catFor + '” into:'));
        const row = h('div', { class: 'fc-catfilter' });
        catList().forEach((c) => {
          row.append(h('button', { class: 'fc-set fc-catchip' + (cur === c ? ' on' : ''), type: 'button',
            onClick: () => { setCat(ui.catFor, c); ui.catFor = null; } }, c));
        });
        row.append(h('button', { class: 'fc-set fc-catchip' + (!cur ? ' on' : ''), type: 'button',
          title: 'Remove from any category',
          onClick: () => { setCat(ui.catFor, ''); ui.catFor = null; } }, 'Uncategorized'));
        strip.append(row);
        if (!catList().length)
          strip.append(h('div', { class: 'pd-empty' }, 'No categories yet — make one with ＋ New category above.'));
        stripIntoView();
        return;
      }
    }

    search.addEventListener('input', () => { ui.filter = search.value; ui.sel = 0; paintGrid(); });
    search.addEventListener('keydown', (e) => {
      const flat = flatList();
      const cols = Math.max(1, Math.floor(grid.clientWidth / 98) || 1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        ui.sel = Math.min(Math.max(0, selIdx() + (e.key === 'ArrowDown' ? cols : -cols)), Math.max(0, flat.length - 1));
        paintGrid();
      } else if (e.key === 'Enter') { if (flat.length) fire(flat[selIdx()]); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (ui.assignFor) { ui.assignFor = null; ui.imgQ = ''; paintStrip(); paintGrid(); }
        else if (ui.catFor) { ui.catFor = null; paintStrip(); paintGrid(); }
        else if (ui.failFor) { ui.failFor = null; render(); }
        else if (ui.showBlocked) { ui.showBlocked = false; render(); }
        else if (ui.mode) { ui.mode = ''; render(); }
      }
      e.stopPropagation();
    });

    paintGrid();
    paintStrip();
    return body;
  }

  /* ---- bridge receivers (this pane OWNS them) ---- */

  window.fdPresetData = function (env) {
    pdState = (env && typeof env === 'object') ? env : null;
    orphanMap = null;                       // the file list may have grown — rebuild lazily
    stemMap = null;                         // same list, same lifetime
    rrReconcile();                          // a landed face clears its own tile spinner
    // The optimistic "⏳ Starting…" ends the moment the batch is really running;
    // otherwise the 8 s backstop in the button drops it, so the chip can never
    // sit there claiming to be starting something that never started.
    const ar = (pdState && pdState.autorender) || null;
    if (ar && ar.running) ui.batchStarting = false;
    if (isActive()) render();
  };

  window.fdPresetResult = function (env) {
    pdBusy = false;
    let ok = !!(env && env.ok !== false && !env.error);
    let msg;
    /* render-one answers here when it REFUSES (a batch is running) or finishes
       early — either way the tile must stop spinning, or the pane would keep
       promising a render that is not happening. */
    const rrName = env && (env.preset || env.name);
    if (env && (env.op === 'render-one' || (rrName && rrPending(rrName)))) {
      if (rrName) delete ui.rr[rrName];
      else ui.rr = {};
    }
    /* The debug probe and its cleanup answer here and NOWHERE else — a probe
       deliberately pushes no index (it changes nothing the tab draws), so this
       reply is the only thing that can tell you she is standing there. */
    if (env && env.op === 'render-probe') {
      ui.standIn = env.standIn || '';
      fqStatus = {
        msg: ok
          ? (env.kept
            ? 'Rendered — she is standing next to you. Close the deck, walk up and look at her, then press ⛔ Send her away.'
            : 'Rendered, but the stand-in was not kept — nothing to walk up to.')
          : ('Debug render failed: ' + (env.error || 'refused')),
        ok, pending: false,
      };
      if (isActive()) render();
      return;
    }
    if (env && env.op === 'standin-clear') {
      if (ok && !env.kept) ui.standIn = '';
      fqStatus = {
        msg: ok
          ? (env.kept ? 'She would not go — one is still standing. Try again in a moment.' : 'Sent away.')
          : ('Could not send her away: ' + (env.error || 'refused')),
        ok: ok && !env.kept, pending: false,
      };
      if (isActive()) render();
      return;
    }
    if (!env) { ok = false; msg = 'Preset Director gave no answer'; }
    else if (env.error) msg = env.error;
    else if (env.apply) {
      msg = 'Summoned ' + (env.name || 'her');
      if (env.apply.ok) msg += ' wearing “' + (env.apply.preset || '') + '”';
      else { ok = false; msg += ' — but the preset failed: ' + (env.apply.error || 'refused'); }
    } else if (env.saved || env.preset === BACKUP_PRESET) { msg = 'Your face is backed up — try presets freely'; }
    else if (env.ok) msg = 'Preset “' + (env.preset || '') + '” applied' + (env.name ? ' to ' + env.name : '');
    else msg = 'Refused';
    fqStatus = { msg, ok, pending: false };
    requestIndex();   // registry changed
    if (isActive()) render();
  };

  /* ================================================== Omni provider ===== *
   *  Until this landed, the deck's search reached Faces only through
   *  hd-omni's nav-label fallback: it jumped to the tab and stopped there. So
   *  the hundreds of presets the tab exists for, and every named tool on it,
   *  could be found only by opening the tab first and typing again.
   *
   *  index() reads the LIVE index push on every keystroke, per the provider
   *  contract — a preset renamed, filed, hidden or freshly rendered is
   *  searchable the moment it is, with no edit here.
   * ====================================================================== */

  /* Arm one of the tab's modes and land on it. A mode only changes what the
     NEXT tile click does, so going to the tab IS the action — the armed-mode
     banner over the gallery is what makes it legible. */
  function omniMode(key) {
    ui.mode = key;
    ui.assignFor = null;
    ui.catFor = null;
    showTab();
  }
  /* Same reasoning for a category: what it does is change what the gallery is
     showing, which is only worth anything with the gallery in front of you.
     The text filter is cleared so the chosen category is what you land on. */
  function omniCat(key) {
    ui.catFilter = key;
    ui.filter = '';
    ui.sel = 0;
    showTab();
  }
  /* Apply straight from a search row. The refusal ("look at someone in-game
     first") is a sentence the pane already writes, but nobody would read it
     from the overlay — so a refused apply lands ON the tab with that preset
     filtered and the target chips right there to choose from. */
  function omniApply(name) {
    if (pdBusy) { toast('Faces is busy — the last preset is still going on'); return; }
    if (applyToTarget(name)) { toast('🎭 ' + name + ' → ' + resolvedTarget().name); return; }
    ui.filter = name;
    ui.sel = 0;
    showTab();
  }

  const omniProvider = {
    id: 'faces', label: 'Faces', tab: 'faces',
    setFilter(q) {
      ui.filter = String(q || '');
      ui.sel = 0;
      if (isActive()) render();
    },
    /* The tab may never have been opened this session, and its gallery is the
       whole point of the provider — so ask for the index once, the first time
       omni opens. A rig without Preset Director simply never answers, and the
       standing row below still says the tab is there. */
    warm() { if (!pdState) requestIndex(); },
    index() {
      const out = [{
        label: 'Faces',
        detail: 'RaceMenu presets — browse them, apply one, summon someone wearing it',
        kind: 'faces',
        keywords: 'face faces preset presets racemenu jslot appearance looks head chargen preset director',
      }];
      if (!pdState) return out;              // warm() has asked; nothing indexed yet
      if (!pdState.available) {
        out[0].detail = 'Preset Director isn’t loaded — tick the mod in MO2 and restart the game';
        return out;
      }
      const names = pdNames();
      const cnt = computeCounts();
      const ar = pdState.autorender || null;
      const favS = favSet();
      const hidS = hiddenSet();

      // ---- the named tools, in the order the tab lays them out ----
      const MODES = [
        ['summon', '＋ Summon someone wearing a preset', 'spawn a new person from a face',
          'summon spawn create new person npc actor someone make place'],
        ['assign', '🖼 Set a preset’s image', 'choose which picture stands for a preset',
          'set image picture photo thumbnail icon tile art assign portrait'],
        ['cat', '🗂 Categorize presets', 'file presets into categories, or make one',
          'categorize categorise category categories organise organize group folder tag sort file'],
        ['probe', '🧪 Debug render a preset', 'render one and leave the stand-in beside you to inspect',
          'debug render probe test standin stand-in inspect broken glitched wrong'],
      ];
      MODES.forEach((m) => out.push({
        label: m[1],
        detail: 'Faces · ' + m[2] + (ui.mode === m[0] ? ' · armed now' : ''),
        kind: 'faces',
        keywords: m[3],
        run: () => omniMode(m[0]),
      }));

      // The two ways a preset can be applied, each row doing the one thing it
      // names — so "full look" is findable by the word a player would type.
      out.push({
        label: '◇ Apply presets face-only',
        detail: 'Faces · face shape and morphs, never the skin' + (ui.full ? '' : ' · already the setting'),
        kind: 'setting',
        keywords: 'face only safe shape morphs skip skin tint setting',
        run: () => { ui.full = false; toast('◇ Presets will apply face shape only'); if (isActive()) render(); },
      });
      out.push({
        label: '⚠ Apply presets with the full look',
        detail: 'Faces · the preset’s skin overrides too — can tint skin' + (ui.full ? ' · already the setting' : ''),
        kind: 'setting',
        keywords: 'full look skin overrides tint complexion warpaint everything setting',
        run: () => { ui.full = true; toast('⚠ Presets will apply the FULL look, skin included'); if (isActive()) render(); },
      });

      /* Only offered once there is something to restore: the backup exists
         after the first try-on of the session, or as a PD_ preset left by an
         earlier one. Promising to put back a face that was never saved would
         be the worst row in the deck. */
      if (backedUp || names.indexOf(BACKUP_PRESET) !== -1) out.push({
        label: '⟲ Restore my own face',
        detail: 'Faces · put back the face saved before you started trying presets on yourself',
        kind: 'faces',
        keywords: 'restore revert undo put back my own face original backup player me',
        run: () => {
          if (pdBusy) { toast('Faces is busy — the last preset is still going on'); return; }
          target.kind = 'me'; target.formId = 0; target.name = '';
          pdSend({ op: 'apply', formId: PLAYER_FORMID, preset: BACKUP_PRESET, flags: 15 },
            'Restoring your face…');
          showTab();
        },
      });

      if (ar && ar.running) {
        out.push({
          label: '⏹ Stop the face rendering',
          detail: 'Faces · ' + ((ar.done || 0) + (ar.failed || 0)) + '/' + (ar.total || '?') +
            ' done — finished faces are kept',
          kind: 'faces',
          keywords: 'stop cancel halt abort end rendering render batch lag busy',
          run: () => {
            toGame('fdPreset', JSON.stringify({ op: 'autorender-cancel' }));
            toast('⏹ Stopping after this face');
            showTab();
          },
        });
      } else if (cnt.missing.length) {
        /* Deliberately no run(): the batch closes the deck and spends about
           four seconds of in-world work per face, and the tab states that cost
           right beside the button. A search row that fired it would be the one
           press that skips the warning, so this one lands on the button. */
        out.push({
          label: '✨ Render the missing faces (' + cnt.missing.length + ')',
          detail: 'Faces · ' + estText(cnt.missing.length) +
            ' of in-world work — opens the tab so you see the cost before you press',
          kind: 'faces',
          keywords: 'render missing generate make faces thumbnails images pictures batch auto',
        });
      }
      if (cnt.blocked.length) out.push({
        label: '⚠ ' + cnt.blocked.length + ' preset' + (cnt.blocked.length === 1 ? '' : 's') + ' can’t be rendered — why?',
        detail: 'Faces · the renderer refuses these — read the reason, force a race, or hide them',
        kind: 'faces',
        keywords: 'blocked failed fails cannot render error reason race sex why skipped broken',
        run: () => { ui.showBlocked = true; ui.failFor = null; showTab(); },
      });
      // Same restraint as ✨ above, and more of it: this one deletes work.
      if (cnt.auto && !(ar && ar.running)) out.push({
        label: '↻ Re-render all the auto-rendered faces',
        detail: 'Faces · throws away ' + cnt.auto + ' rendered image' + (cnt.auto === 1 ? '' : 's') +
          ' and does them again — the tab asks twice before it does',
        kind: 'faces',
        keywords: 'rerender re-render redo again all glitched broken regenerate refresh batch',
      });

      /* ---- the category pills, by name -----------------------------------
         Categories are user-made and unbounded, and outside the tab nothing
         could name one. Counts come from the same walk, so a pill never
         promises presets it hasn't got. */
      const tally = Object.create(null);
      let favN = 0, noneN = 0;
      names.forEach((n) => {
        if (hidS.has(n)) return;
        if (favS.has(n)) favN++;
        const c = presetCat(n);
        if (!c) { noneN++; return; }
        tally[c] = (tally[c] || 0) + 1;
      });
      const pill = (key, label, count, words) => out.push({
        label,
        detail: 'Faces · ' + count + ' preset' + (count === 1 ? '' : 's'),
        kind: 'category',
        keywords: words,
        run: () => omniCat(key),
      });
      pill('__fav__', '★ Favorite presets', favN, 'favorite favourite favorites starred star best');
      if (hidS.size) pill('__hidden__', '⊘ Hidden presets', hidS.size,
        'hidden removed excluded restore bring back unhide');
      catNames().forEach((c) => pill(c, c, tally[c] || 0, 'category preset faces ' + c));
      pill('__none__', 'Uncategorized presets', noneN,
        'uncategorized uncategorised unfiled none no category');

      /* ---- the gallery itself ---------------------------------------------
         Hidden presets are IN here on purpose: hiding is curation, not
         deletion, and someone who types the name is asking for that face by
         name. The row says it is hidden rather than pretending it is gone. */
      const rt = resolvedTarget();
      const worn = pdWearing(rt.formId);
      names.forEach((n) => {
        const icon = pdIconFor(n);
        const cat = presetCat(n);
        const why = icon ? '' : failReason(n);
        const bits = ['RaceMenu preset'];
        if (cat) bits.push(cat);
        if (favS.has(n)) bits.push('★');
        if (hidS.has(n)) bits.push('⊘ hidden from the tab');
        if (worn && worn.preset === n) bits.push('worn by ' + rt.name);
        if (why) bits.push('can’t be rendered: ' + why);
        else if (!icon) bits.push('no picture yet');
        out.push({
          label: n,
          detail: bits.join(' · '),
          kind: 'face preset',
          keywords: 'preset face racemenu jslot look appearance ' + cat,
          icon: icon ? 'preset-icons/' + encodeURIComponent(icon) : '',
          run: () => omniApply(n),
          /* The preset NAME is the durable identity — it is what the .jslot on
             disk is called and what every fdPreset op is keyed by. */
          pin: 'face:' + n,
          snap: { preset: n },
        });
      });
      return out;
    },
    /* A pin fired for a preset the index no longer holds (the .jslot moved, or
       the tab has not been opened this session): apply it by name anyway and
       let the game answer honestly. */
    pinRun(snap) { if (snap && snap.preset) omniApply(snap.preset); },
  };
  if (window.HDOmni) HDOmni.register(omniProvider);

  /* ---- host contract ---- */
  return {
    aimAt,
    init() { /* nothing to bind until shown */ },
    onShow() {
      host = document.getElementById('faces-host');
      if (!pdState) requestIndex();
      render();
    },
    onHide() { /* keep state; nothing live to stop */ },
    toggleEdit() { /* the shared size card is the only edit chrome */ },
    wantsPause() { return true; },
    // test seams
    _state: () => ({ pdState, target, ui, pdBusy, backedUp }),
    _render: render,
    _setHost: (el) => { host = el; },
    _aimAt: aimAt,
    _bodyFitWindow: bodyFitWindow,
    _isFramedPortrait: isFramedPortrait,
    // 2026-08-16 seams: the counting truth, the filename adoption and the
    // in-flight map, so the harness can assert them without a live game.
    _counts: computeCounts,
    _iconFor: pdIconFor,
    _autoStem: pdAutoStem,
    _isOrphan: pdIconIsOrphan,
    _rr: () => ui.rr,
    // The Omni provider, reachable with no omni loaded so the harness can drive
    // index() and the rows' run() the way search and the shelf do.
    _omni: () => omniProvider,
  };
})();
