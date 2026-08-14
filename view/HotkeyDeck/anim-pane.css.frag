/* ===================================================================== *
 *  Animations tab — ZAP animation player pane for the Hotkey Deck view.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every selector
 *  is an- prefixed, no existing rule is touched. Colours/radii/easing are the
 *  deck's own literals (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms).
 *  Type floor 12px (Rober's no-small-text rule).
 *
 *  NOTE (see [[deck-view-css-frag-merge]]): the game loads the ASSEMBLED
 *  app.css. Deploying this .frag alone changes nothing — merge it into app.css
 *  between the previous banner and the next one.
 * ===================================================================== */

#an-pane { display: flex; min-height: 0; flex: 1; overflow: hidden; position: relative; }

/* ---------- left rail: target + categories ---------- */

#an-side {
  width: clamp(190px, 30%, 288px); flex: none;
  display: flex; flex-direction: column; gap: 12px;
  padding: 14px 12px;
  border-right: 1px solid #2e2e36;
  background: rgba(0,0,0,.16);
  overflow: hidden;
}

.an-card {
  border: 1px solid #2e2e36; border-radius: 10px;
  padding: 12px 13px;
  background: rgba(255,255,255,.02);
  flex: none;
}
.an-card-title {
  font-size: 12px; letter-spacing: .8px; text-transform: uppercase;
  color: #8a8478; margin-bottom: 7px;
}
.an-tgt { font-size: 15px; color: #cfcabe; line-height: 1.4; }
.an-tgt-name { color: #e8e4da; font-weight: 700; }
.an-tgt-dot {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%;
  margin-right: 7px; vertical-align: middle;
  background: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.18);
}
.an-tgt-dot.me { background: #8fd8ff; box-shadow: 0 0 0 3px rgba(143,216,255,.18); }
.an-tgt-hint { margin-top: 6px; font-size: 12px; color: #9d988c; line-height: 1.4; }

.an-tgt-actions { display: flex; gap: 8px; margin-top: 11px; flex-wrap: wrap; }
.an-btn {
  flex: 1 1 auto; min-width: 96px;
  padding: 9px 10px;
  font-size: 13px; font-weight: 600; font-family: inherit;
  color: #e8e4da; background: rgba(255,255,255,.04);
  border: 1px solid #2e2e36; border-radius: 8px; cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.an-btn:hover { border-color: #c9a24b; background: rgba(201,162,75,.10); }
.an-crawl.on {
  color: #14120e; background: #c9a24b; border-color: #e0bc6a;
}
.an-crawl.on:hover { box-shadow: 0 0 0 3px rgba(201,162,75,.25); }
.an-crawl.disabled { opacity: .5; cursor: not-allowed; }
.an-crawl.disabled:hover { border-color: #2e2e36; background: rgba(255,255,255,.04); box-shadow: none; }

.an-cats {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px;
  padding-right: 2px;
}
.an-cat {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; text-align: left;
  padding: 9px 11px;
  font-family: inherit; font-size: 13.5px; color: #cfcabe;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.an-cat:hover { background: rgba(255,255,255,.04); border-color: #2e2e36; }
.an-cat.active { background: rgba(201,162,75,.12); border-color: rgba(201,162,75,.45); color: #ecd9a0; }
.an-cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.an-cat-count {
  flex: none;
  font: 700 12px/1 Consolas, "Courier New", monospace; color: #9d988c;
  background: rgba(255,255,255,.05); border-radius: 999px; padding: 3px 7px;
}
.an-cat.active .an-cat-count { color: #ecd9a0; background: rgba(201,162,75,.16); }

.an-source { flex: none; font-size: 12px; color: #7f7a6e; padding: 2px 2px 0; }

/* ---------- load-order packs card (in-game FNIS scan) ---------- */

#an-packs-card { display: flex; flex-direction: column; min-height: 0; max-height: 44%; }
#an-packs-card .an-card-title {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.an-pk-rescan {
  font-family: inherit; font-size: 12px; font-weight: 700; letter-spacing: .4px;
  text-transform: none;
  color: #cfcabe; background: rgba(255,255,255,.04);
  border: 1px solid #2e2e36; border-radius: 999px; padding: 4px 11px; cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease;
}
.an-pk-rescan:hover { border-color: #c9a24b; background: rgba(201,162,75,.10); }
.an-pk-rescan.hidden { display: none; }
#an-pk-body { display: flex; flex-direction: column; gap: 7px; min-height: 0; }
.an-pk-pitch { font-size: 12.5px; color: #9d988c; line-height: 1.45; }
.an-pk-scan { margin-top: 2px; }
.an-pk-filter {
  width: 100%; box-sizing: border-box;
  padding: 8px 10px;
  font-size: 13px; font-family: inherit; color: #e8e4da;
  background: rgba(0,0,0,.25); border: 1px solid #2e2e36; border-radius: 8px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.an-pk-filter::placeholder { color: #7f7a6e; }
.an-pk-filter:focus { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.18); }
#an-pk-rows {
  min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px;
  padding-right: 2px;
}
.an-pk-row {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 9px;
  border: 1px solid transparent; border-radius: 8px; cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.an-pk-row:hover { background: rgba(255,255,255,.04); border-color: #2e2e36; }
.an-pk-row input {
  accent-color: #c9a24b; width: 15px; height: 15px; flex: none; cursor: pointer;
}
.an-pk-name {
  flex: 1; min-width: 0;
  font-size: 13px; color: #cfcabe;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: color 140ms ease;
}
.an-pk-row.off .an-pk-name { color: #7f7a6e; }
.an-pk-count {
  flex: none;
  font: 700 12px/1 Consolas, "Courier New", monospace; color: #9d988c;
  background: rgba(255,255,255,.05); border-radius: 999px; padding: 3px 7px;
}
.an-pk-hint { font-size: 12px; color: #7f7a6e; line-height: 1.45; }
.an-pk-busy { font-size: 12.5px; color: #9d988c; padding: 4px 2px; }
.an-pk-busy::after {
  content: '…';
  display: inline-block;
  animation: an-pk-ellipsis 1.1s steps(4, end) infinite;
  overflow: hidden; vertical-align: bottom; width: 1.2em;
}
@keyframes an-pk-ellipsis { from { width: 0; } to { width: 1.2em; } }

/* ---------- right: search + list ---------- */

#an-main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 14px 16px; gap: 12px; }

#an-searchbar { display: flex; align-items: center; gap: 12px; flex: none; }
#an-search {
  flex: 1; min-width: 0;
  padding: 11px 13px;
  font-size: 15px; font-family: inherit; color: #e8e4da;
  background: rgba(0,0,0,.25); border: 1px solid #2e2e36; border-radius: 9px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#an-search::placeholder { color: #7f7a6e; }
#an-search:focus { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.18); }
.an-count { flex: none; font-size: 13px; color: #9d988c; font-family: Consolas, "Courier New", monospace; }

#an-list {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  padding-right: 2px;
}
.an-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 13px;
  border: 1px solid #2e2e36; border-radius: 9px;
  background: rgba(255,255,255,.02);
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease;
}
.an-row:hover { border-color: #3a3a44; background: rgba(255,255,255,.045); }
.an-row.top { border-color: rgba(201,162,75,.4); }
.an-row.disabled { opacity: .5; cursor: default; }
.an-row.disabled:hover { border-color: #2e2e36; background: rgba(255,255,255,.02); }

.an-row-main { flex: 1; min-width: 0; }
.an-row-name {
  font-size: 15px; font-weight: 600; color: #e8e4da;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.an-row-meta { margin-top: 2px; font-size: 12px; color: #9d988c; }

.an-apply {
  flex: none;
  padding: 8px 16px;
  font-size: 13px; font-weight: 700; font-family: inherit;
  color: #14120e; background: #c9a24b;
  border: 1px solid #e0bc6a; border-radius: 8px; cursor: pointer;
  transition: box-shadow 140ms ease, background 140ms ease;
}
.an-apply:hover { box-shadow: 0 0 0 3px rgba(201,162,75,.25); }
.an-apply:disabled {
  color: #8a8478; background: rgba(255,255,255,.04); border-color: #2e2e36;
  cursor: not-allowed; box-shadow: none;
}

.an-empty, .an-more { padding: 18px 12px; text-align: center; color: #9d988c; font-size: 13px; }
.an-more { color: #7f7a6e; font-size: 12.5px; }

/* ---------- toast ---------- */

.an-toast {
  position: absolute; left: 50%; bottom: 14px; transform: translate(-50%, 12px);
  padding: 9px 16px;
  font-size: 13.5px; color: #14120e; background: #c9a24b;
  border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
  opacity: 0; pointer-events: none;
  transition: opacity 160ms ease, transform 160ms ease;
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.an-toast.show { opacity: 1; transform: translate(-50%, 0); }
.an-toast.bad { background: #c85046; color: #fff; }

/* ===================================================================== *
 *  Animations tab v2 — dynamic tabs, favorites, pack search (2026-08-14).
 *  Additions only, an- prefixed; deck literals (#c9a24b gold / #2e2e36
 *  lines / 140ms ease); type floor 12px.
 * ===================================================================== */

/* dynamic seg buttons: ★ Favorites, custom tabs, the ＋ */
.an-seg-fav, .an-seg-user { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.an-seg-user.dragging { opacity: .55; outline: 1px dashed #c9a24b; }
.an-seg-add {
  min-width: 40px; font-size: 16px; line-height: 1;
  color: #9d988c; border-style: dashed;
}
.an-seg-add:hover { color: #e8e4da; border-color: #c9a24b; }

/* row star */
.an-star {
  flex: none; width: 34px; height: 34px; margin-right: 8px;
  font-size: 17px; line-height: 1; color: #7f7a6e;
  background: transparent; border: 1px solid transparent; border-radius: 8px;
  cursor: pointer; opacity: 0; transition: opacity 140ms ease, color 140ms ease;
}
.an-row:hover .an-star { opacity: 1; }
.an-star.on { opacity: 1; color: #c9a24b; }
.an-star:hover { color: #e0bc6a; border-color: rgba(201,162,75,.35); }
.an-row.missing { opacity: .62; }
.an-row.missing .an-row-meta { color: #a08c5a; }

/* pack chips above the rows while typing */
.an-pk-chiprow { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 2px 10px; }
.an-pk-chip {
  padding: 7px 14px; font-size: 13px; color: #e8e4da;
  background: rgba(201,162,75,.10); border: 1px solid rgba(201,162,75,.45);
  border-radius: 999px; cursor: pointer; transition: background 140ms ease;
  max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.an-pk-chip:hover { background: rgba(201,162,75,.22); }

/* the searchbar scope chip (📦 pack ✕) */
#an-scope { flex: none; display: flex; align-items: center; }
.an-scope-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 8px 6px 12px; font-size: 13px; color: #14120e;
  background: #c9a24b; border-radius: 999px; white-space: nowrap;
  max-width: 260px; overflow: hidden;
}
.an-scope-x {
  border: 0; background: rgba(0,0,0,.18); color: #14120e;
  width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
  font-size: 12px; line-height: 1;
}
.an-scope-x:hover { background: rgba(0,0,0,.32); }

/* category rail: collapsible pack groups */
.an-pack-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 10px; font-size: 13px; color: #cfc9ba; text-align: left;
  background: rgba(255,255,255,.03); border: 1px solid transparent; border-radius: 8px;
  cursor: pointer; transition: background 140ms ease;
}
.an-pack-head:hover { background: rgba(201,162,75,.10); color: #e8e4da; }
.an-pack-head.active { border-color: rgba(201,162,75,.55); color: #e8e4da; }
.an-pack-tw { flex: none; width: 14px; color: #9d988c; font-size: 12px; }
.an-pack-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.an-cat.an-cat-sub { padding-left: 28px; }

/* context menu + tab namer (pane-anchored; the pane inherits --ui-scale, so
   no vh/vw and no self-scale needed — the popup-audit rule) */
.an-ctx {
  position: absolute; z-index: 60; min-width: 210px; max-width: 320px;
  padding: 6px; background: #191720; border: 1px solid #3a3830; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.55); display: flex; flex-direction: column; gap: 2px;
}
.an-ctx-item {
  padding: 9px 12px; font-size: 13px; color: #d9d2bd; text-align: left;
  background: transparent; border: 0; border-radius: 7px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.an-ctx-item:hover { background: rgba(201,162,75,.14); color: #f0ecdf; }
.an-ctx-item.danger { color: #d98a83; }
.an-ctx-item.danger:hover { background: rgba(200,80,70,.14); color: #eba49d; }
.an-ctx-sep { height: 1px; margin: 4px 6px; background: #2e2e36; }
.an-namer {
  position: absolute; z-index: 60; display: flex; gap: 8px; padding: 10px;
  background: #191720; border: 1px solid #3a3830; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.55);
}
.an-namer input {
  width: 200px; padding: 8px 10px; font-size: 13.5px; color: #e8e4da;
  background: #100f14; border: 1px solid #2e2e36; border-radius: 8px; outline: none;
}
.an-namer input:focus { border-color: #c9a24b; }
.an-namer button {
  padding: 8px 14px; font-size: 13px; color: #14120e; font-weight: 600;
  background: #c9a24b; border: 1px solid #e0bc6a; border-radius: 8px; cursor: pointer;
}
.an-namer button:hover { box-shadow: 0 0 0 3px rgba(201,162,75,.25); }

/* packs card: zero-pose packs stay visible, greyed, with the reason */
.an-pk-row.zero { opacity: .6; cursor: default; }
.an-pk-zerodot { flex: none; width: 16px; text-align: center; color: #7f7a6e; }
.an-pk-why {
  flex: none; font-size: 12px; color: #a08c5a; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 46%;
}
