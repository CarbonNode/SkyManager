/* ===================================================================== *
 *  OStim segment of the Animations tab — scene search / change / control.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every selector
 *  is os- prefixed (plus the #an-seg / #an-row / #an-pane.mode-ostim rules that
 *  turn the Animations tab into a two-segment column). Deck literals only
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms / 12px type floor).
 *
 *  NOTE (see [[deck-view-css-frag-merge]]): the game loads the ASSEMBLED
 *  app.css. Deploying this .frag alone changes nothing — merge it into app.css
 *  between the previous banner and the next one.
 * ===================================================================== */

/* ---- Animations tab becomes a column: [segmented toggle][content] ---- */
/* #an-pane was `display:flex` (row). It is now a column; the old row lives
   inside #an-row so the Poses layout is byte-for-byte unchanged. */
#an-pane { flex-direction: column; }
#an-row  { flex: 1; min-height: 0; display: flex; overflow: hidden; }

#an-seg {
  flex: none; display: flex; gap: 6px;
  padding: 10px 12px 0;
}
.an-seg-btn {
  padding: 9px 20px;
  font: 600 14px/1 inherit; color: #b8b3a7;
  background: rgba(255,255,255,.03);
  border: 1px solid #2e2e36; border-radius: 9px 9px 0 0; border-bottom: none;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.an-seg-btn:hover { background: rgba(201,162,75,.10); color: #e8e4da; }
.an-seg-btn.active { color: #14120e; background: #c9a24b; border-color: #e0bc6a; }

/* mode switch: show one body, hide the other */
#os-body { display: none; }
#an-pane.mode-ostim #an-row { display: none; }
#an-pane.mode-ostim #os-body { display: flex; }

/* ---------------------------------------------------- OStim body ---- */
#os-body {
  flex: 1; min-height: 0;
  flex-direction: column; gap: 12px;
  padding: 14px 16px;
}

/* status header */
#os-status {
  flex: none;
  display: flex; flex-direction: column; gap: 10px;
  padding: 13px 15px;
  border: 1px solid #2e2e36; border-radius: 11px;
  background: rgba(255,255,255,.02);
}
#os-status-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
#os-scene { font-size: 18px; font-weight: 700; color: #e8e4da; }
#os-scene-hint { font-size: 13px; color: #9d988c; }
#os-body.os-outscene #os-scene { color: #b8b3a7; }

#os-actors { display: flex; gap: 7px; flex-wrap: wrap; }
.os-actor {
  font-size: 13px; font-weight: 600; color: #e8e4da;
  padding: 4px 11px; border-radius: 999px;
  border: 1px solid #2e2e36; background: rgba(255,255,255,.04);
}
.os-actor.f { border-color: rgba(255,105,180,.4); color: #ffc8e2; background: rgba(255,105,180,.08); }
.os-actor.m { border-color: rgba(30,144,255,.4); color: #bfe0ff; background: rgba(30,144,255,.08); }

/* live control row */
#os-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.os-ctl {
  padding: 8px 13px;
  font: 600 13px/1 inherit; color: #e8e4da;
  background: rgba(255,255,255,.04);
  border: 1px solid #2e2e36; border-radius: 8px; cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.os-ctl:hover:not(:disabled) { border-color: #c9a24b; background: rgba(201,162,75,.10); }
.os-ctl:disabled { opacity: .45; cursor: not-allowed; }
.os-ctl.on { color: #14120e; background: #c9a24b; border-color: #e0bc6a; }
.os-ctl.warn:hover:not(:disabled) { border-color: #c85046; background: rgba(200,80,70,.12); }
.os-speed { display: inline-flex; align-items: center; gap: 8px; }
#os-speed-val {
  min-width: 52px; text-align: center;
  font: 700 14px/1 Consolas, "Courier New", monospace; color: #ecd9a0;
}
.os-ctl-sep { width: 1px; align-self: stretch; background: #2e2e36; margin: 2px 4px; }
.os-ctl-label { font-size: 12px; color: #8a8478; letter-spacing: .5px; text-transform: uppercase; }

/* search + list */
#os-searchbar { display: flex; align-items: center; gap: 12px; flex: none; }
#os-search {
  flex: 1; min-width: 0;
  padding: 11px 13px;
  font-size: 15px; font-family: inherit; color: #e8e4da;
  background: rgba(0,0,0,.25); border: 1px solid #2e2e36; border-radius: 9px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#os-search::placeholder { color: #7f7a6e; }
#os-search:focus { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.18); }
.os-count { flex: none; font-size: 13px; color: #9d988c; font-family: Consolas, "Courier New", monospace; }

#os-list {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  padding-right: 2px;
}
.os-row {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px;
  border: 1px solid #2e2e36; border-radius: 9px;
  background: rgba(255,255,255,.02);
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease;
}
.os-row:hover { border-color: #3a3a44; background: rgba(255,255,255,.045); }
.os-row.top { border-color: rgba(201,162,75,.4); }
.os-row.incompat { opacity: .5; cursor: default; }
.os-row.incompat:hover { border-color: #2e2e36; background: rgba(255,255,255,.02); }

.os-row-main { flex: 1; min-width: 0; }
.os-row-name {
  font-size: 15px; font-weight: 600; color: #e8e4da;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.os-row-meta { margin-top: 2px; font-size: 12px; color: #9d988c; }

.os-go {
  flex: none; min-width: 78px;
  padding: 8px 16px;
  font: 700 13px/1 inherit; color: #14120e; background: #c9a24b;
  border: 1px solid #e0bc6a; border-radius: 8px; cursor: pointer;
  transition: box-shadow 140ms ease, background 140ms ease;
}
.os-go:hover:not(:disabled) { box-shadow: 0 0 0 3px rgba(201,162,75,.25); }
.os-go:disabled {
  color: #8a8478; background: rgba(255,255,255,.04); border-color: #2e2e36;
  cursor: not-allowed; box-shadow: none;
}

.os-empty, .os-more { padding: 18px 12px; text-align: center; color: #9d988c; font-size: 13px; }
.os-more { color: #7f7a6e; font-size: 12.5px; }

/* toast (shares the an-toast placement idiom) */
.os-toast {
  position: absolute; left: 50%; bottom: 14px; transform: translate(-50%, 12px);
  padding: 9px 16px;
  font-size: 13.5px; color: #14120e; background: #c9a24b;
  border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
  opacity: 0; pointer-events: none;
  transition: opacity 160ms ease, transform 160ms ease;
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.os-toast.show { opacity: 1; transform: translate(-50%, 0); }
.os-toast.bad { background: #c85046; color: #fff; }
