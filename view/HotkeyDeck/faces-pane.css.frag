/* ================================ Faces tab (RaceMenu presets) ==========
   Reuses the .pd-* gallery styles already in app.css (tiles, grid, search,
   count, group heads, assign strip). These are the tab-frame pieces on top. */
/* The pane needs the same height contract as its siblings (#rm-pane /
   #lt-pane): flex:1 + min-height:0 so it takes the panel's remaining space
   instead of growing to content height — without this .fc-body has no
   bounded height and its overflow-y:auto never produces a scrollbar. */
#faces-pane { padding: 0; display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
.fc-host { display: flex; flex-direction: column; flex: 1; height: 100%; min-height: 0; }
.fc-head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  padding: 14px 18px 12px; border-bottom: 1px solid rgba(255, 255, 255, .08);
}
.fc-title { font-size: 22px; font-weight: 700; letter-spacing: .01em; color: #f2ecdc; }
.fc-title .fc-sub { font-size: 14px; font-weight: 400; opacity: .55; margin-left: 10px; }
.fc-targets { display: flex; flex-wrap: wrap; gap: 8px; }
.fc-chip {
  font: inherit; font-size: 14px; padding: 8px 14px; border-radius: 10px; cursor: pointer;
  color: #e9e2cf; background: rgba(240, 214, 140, .06);
  border: 1px solid rgba(240, 214, 140, .24);
  transition: background .12s ease, border-color .12s ease, color .12s ease, transform .1s ease;
}
.fc-chip:hover { background: rgba(240, 214, 140, .13); border-color: rgba(240, 214, 140, .5); color: #f6ecc8; }
.fc-chip:active { transform: translateY(1px); }
.fc-chip.on {
  border-color: rgba(240, 214, 140, .72); background: rgba(240, 214, 140, .18); color: #f8efce;
  box-shadow: inset 0 0 0 1px rgba(240, 214, 140, .18);
}
.fc-chip-pick { cursor: default; }
.fc-restore {
  font: inherit; font-size: 13.5px; padding: 7px 13px; border-radius: 9px; cursor: pointer;
  color: #e8d9a0; background: rgba(240, 214, 140, .08);
  border: 1px solid rgba(240, 214, 140, .4); margin-left: auto;
}
.fc-restore:hover { background: rgba(240, 214, 140, .16); }
.fc-status { font-size: 14px; flex-basis: 100%; padding: 2px 2px 0; }
.fc-status.ok { color: #9edc96; }
.fc-status.bad { color: #e79a9a; }
.fc-status.pending { color: #d8cfa0; opacity: .8; }
.fc-body {
  display: flex; flex-direction: column; gap: 12px;
  padding: 14px 18px 20px; overflow-y: auto; min-height: 0; flex: 1;
}
.fc-set { font: inherit; }
/* The tab has the whole window, so the gallery breathes: bigger faces, more
   columns than the cramped quick-card reveal. */
.fc-grid { max-height: none; gap: 14px; }
.fc-grid .pd-tile { width: 104px; padding: 10px 8px 9px; }
.fc-grid .pd-face { width: 84px; height: 84px; }
.fc-grid .pd-tile-name { max-width: 92px; font-size: 13px; }
.fc-body .pd-search, .fc-body .pd-name { font-size: 15px; padding: 11px 14px; }

/* favorites + categories (added 2026-08-05) */
.pd-tile { position: relative; }
.pd-fav {
  position: absolute; top: 4px; right: 4px; z-index: 2;
  width: 24px; height: 24px; padding: 0; line-height: 22px; text-align: center;
  font-size: 15px; cursor: pointer; border-radius: 6px;
  background: rgba(10,12,16,.55); color: #cdb768;
  border: 1px solid rgba(255,255,255,.14);
}
.pd-fav:hover { background: rgba(10,12,16,.8); border-color: rgba(240,214,140,.6); }
.pd-fav.on { color: #f0d68c; border-color: rgba(240,214,140,.5); }
.pd-tile-cat {
  font-size: 11px; color: #a9c7e0; opacity: .85; margin-top: 2px;
  max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fc-catfilter { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 2px 0 4px; }
/* .fc-catchip gets its full pill look from the shared .pd-chip rule in app.css;
   only the size differs here. */
.fc-catchip {
  font: inherit; font-size: 13px; line-height: 1.2;
  padding: 8px 13px; border-radius: 9px; cursor: pointer;
  color: #e9e2cf; background: rgba(240, 214, 140, .06);
  border: 1px solid rgba(240, 214, 140, .24);
  transition: background .12s ease, border-color .12s ease, color .12s ease, transform .1s ease;
}
.fc-catchip:hover { background: rgba(240, 214, 140, .13); border-color: rgba(240, 214, 140, .5); color: #f6ecc8; }
.fc-catchip:active { transform: translateY(1px); }
.fc-catchip.on {
  background: rgba(240, 214, 140, .18); border-color: rgba(240, 214, 140, .72);
  color: #f8efce; box-shadow: inset 0 0 0 1px rgba(240, 214, 140, .18);
}
.fc-catedit { display: inline-flex; align-items: center; gap: 2px; }
.fc-catx {
  font: inherit; font-size: 12px; cursor: pointer; padding: 6px 7px; border-radius: 7px;
  color: #d7d0be; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12);
}
.fc-catx:hover { border-color: rgba(240,214,140,.5); }
.fc-newcat, .fc-rename-input {
  font: inherit; font-size: 13.5px; padding: 8px 11px; border-radius: 9px;
  color: #f2ecdc; background: rgba(10,12,16,.55); border: 1px solid rgba(255,255,255,.16); outline: none;
  min-width: 150px;
}
.fc-newcat:focus, .fc-rename-input:focus { border-color: rgba(240,214,140,.55); }

/* auto-rendered preset thumbnails (2026-08-14): the mannequin render is a
   whole transparent-bg figure; HDFaceFit lays the <img> out so the tile
   frames the HEAD, and .pd-face clips the rest (Finder-tile discipline). */
.pd-face { position: relative; overflow: hidden; }
.pd-face-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.pd-autorender { border-color: rgba(240, 214, 140, .5); }
.pd-autorender.is-running {
  cursor: default; border-color: rgba(240, 214, 140, .55);
  background: rgba(240, 214, 140, .08); animation: pdArPulse 1.6s ease-in-out infinite;
}
.pd-autorender-stop { border-color: rgba(214, 120, 110, .5); }
.pd-autorender-stop:hover { background: rgba(214, 120, 110, .14); }
@keyframes pdArPulse { 0%, 100% { opacity: 1; } 50% { opacity: .62; } }
.pd-zoom {
  position: absolute; top: 4px; left: 4px; z-index: 2;
  width: 24px; height: 24px; padding: 0; line-height: 22px; text-align: center;
  font-size: 13px; border-radius: 7px; border: 1px solid rgba(255,255,255,.14);
  background: rgba(10,12,16,.55); color: #d8d4c8; cursor: pointer; opacity: 0;
  transition: opacity .12s ease;
}
.pd-tile:hover .pd-zoom, .pd-zoom:focus-visible { opacity: 1; }
.pd-zoom:hover { background: rgba(240,214,140,.18); border-color: rgba(240,214,140,.5); }
.pd-autorender.is-stopping { animation: none; opacity: .85; border-color: rgba(214,120,110,.55); }
.pd-redo { border-color: rgba(255,255,255,.16); }
.pd-redo.is-armed { border-color: rgba(214,120,110,.6); background: rgba(214,120,110,.14); }
