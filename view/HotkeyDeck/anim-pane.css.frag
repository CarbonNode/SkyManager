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
