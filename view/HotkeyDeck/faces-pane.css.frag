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
/* ✕ / ⟲ — remove one preset from the tab, or bring it back (2026-08-15). Sits
   under the ☆ so neither corner control ever covers the other, and stays quiet
   until the tile is hovered: curation should be available, not shouted. */
.pd-hide {
  position: absolute; top: 32px; right: 4px; z-index: 2;
  width: 24px; height: 24px; padding: 0; line-height: 22px; text-align: center;
  font-size: 13px; cursor: pointer; border-radius: 6px;
  background: rgba(10,12,16,.55); color: #b8b1a0;
  border: 1px solid rgba(255,255,255,.14);
  opacity: 0; transition: opacity 120ms ease, color 120ms ease, border-color 120ms ease;
}
.pd-tile:hover .pd-hide, .pd-tile:focus-within .pd-hide, .pd-hide.on { opacity: 1; }
.pd-hide:hover { background: rgba(10,12,16,.85); color: #e08a8a; border-color: rgba(224,138,138,.6); }
.pd-hide.on { color: #8fd18f; border-color: rgba(143,209,143,.5); }

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
/* The debug stand-in's dismissal — deliberately unlike the mode chips beside
   it: it is not a mode, it is an action on something standing in the world
   right now, and it only exists while she does (2026-08-16 in-game test). */
.pd-standin {
  border-color: rgba(214,120,110,.55);
  background: rgba(214,120,110,.12);
  color: #e9c9c3;
}
.pd-standin:hover { border-color: rgba(214,120,110,.85); background: rgba(214,120,110,.2); }
.pd-standin:active { transform: translateY(1px); }
.fc-armbar-probe { border-left-color: #8fb8d6; }


/* ===================== the 2026-08-16 play-test pass ====================
   Five fixes, one stylesheet block: the per-tile ⟳, the failure badge, the
   "can't be rendered" card with its race override, the armed-mode banner, and
   the batch's cost stated before the press.
   ⚠ Ultralight rules that shaped these: no HTML5 drag, no <input type=range>,
   and an animated background-position on a big gradient SMEARS ("watercolors
   bleeding", proven on this rig the same day) — so the ONLY animation here is
   a transform-rotate on one 26px glyph, which is proven safe. */

/* Batch cost — the sentence that has to be on screen BEFORE he presses ✨:
   114 faces is ~8 minutes of the game spawning and rendering a stand-in. */
.pd-cost { font-size: 13px; line-height: 1.45; color: #d9cfa4; opacity: .9; padding: 0 2px; }
.pd-autorender.is-starting { cursor: default; opacity: .85; }
.pd-blocked-chip { border-color: rgba(224, 138, 138, .45); color: #f0cfc6; }
.pd-blocked-chip:hover { background: rgba(224, 138, 138, .14); border-color: rgba(224, 138, 138, .7); }
.pd-blocked-chip.on { background: rgba(224, 138, 138, .18); border-color: rgba(224, 138, 138, .75); color: #f6ddd6; }

/* Armed-mode banner. "🖼 Set image seems to do nothing" was a MODE chip arming
   silently — this is the sentence that says what the next tile click will do. */
.fc-armbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  padding: 12px 14px; border-radius: 11px;
  background: rgba(140, 190, 250, .10); border: 1px solid rgba(140, 190, 250, .38);
  border-left-width: 4px;
}
.fc-armbar-t { font-size: 15px; font-weight: 700; color: #dce9ff; }
.fc-armbar-s { font-size: 13.5px; line-height: 1.5; color: #e7e2d4; opacity: .9; flex: 1 1 240px; }
.fc-armbar-x {
  font-size: 13px; padding: 8px 13px; border-radius: 9px; cursor: pointer; margin-left: auto;
  color: #e9e2cf; background: rgba(255, 255, 255, .06); border: 1px solid rgba(255, 255, 255, .2);
  transition: background .12s ease, border-color .12s ease;
}
.fc-armbar-x:hover { background: rgba(255, 255, 255, .14); border-color: rgba(240, 214, 140, .55); }
.fc-armbar-x:active { transform: translateY(1px); }
/* While a mode is armed the tiles hover BLUE — the same colour the picked tile
   already wears — so the grid agrees with the banner about what a click means. */
.fc-armed .pd-tile:hover { border-color: rgba(140, 190, 250, .7); background: rgba(140, 190, 250, .12); }

/* "⚠ N can't be rendered — why?" — the six presets that failed every batch and
   whose only evidence was the log. Reason on the row, a way out on every one. */
.pd-blocked {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 14px; border-radius: 12px;
  background: rgba(224, 138, 138, .07); border: 1px solid rgba(224, 138, 138, .3);
}
.pd-blocked-head { font-size: 15px; font-weight: 700; color: #f2d5cd; }
.pd-blocked-sub { display: block; margin-top: 4px; font-size: 13px; font-weight: 400; line-height: 1.5; opacity: .82; }
.pd-blocked-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 9px 11px; border-radius: 10px;
  background: rgba(255, 255, 255, .045); border: 1px solid transparent;
  transition: background .12s ease, border-color .12s ease;
}
.pd-blocked-row:hover { background: rgba(255, 255, 255, .08); }
.pd-blocked-row.is-open { border-color: rgba(240, 214, 140, .55); background: rgba(240, 214, 140, .08); }
.pd-blocked-name { font-size: 14px; font-weight: 600; color: #f2ecdc; flex: 0 1 auto; }
/* Wrap, never clip — a truncated reason is exactly the useless half-sentence
   this card exists to replace. */
.pd-blocked-why { font-size: 13px; line-height: 1.45; color: #e6b9b3; flex: 1 1 220px; min-width: 0; word-break: break-word; }
.pd-blocked-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.pd-blocked-b {
  font-size: 13px; line-height: 1.2; padding: 8px 12px; border-radius: 9px; cursor: pointer;
  color: #e9e2cf; background: rgba(255, 255, 255, .05); border: 1px solid rgba(255, 255, 255, .16);
  transition: background .12s ease, border-color .12s ease, color .12s ease, transform .1s ease;
}
.pd-blocked-b:hover { background: rgba(240, 214, 140, .14); border-color: rgba(240, 214, 140, .55); color: #f6ecc8; }
.pd-blocked-b:active { transform: translateY(1px); }
.pd-blocked-b.on { background: rgba(240, 214, 140, .18); border-color: rgba(240, 214, 140, .72); color: #f8efce; }
.pd-blocked-b.is-busy { opacity: .7; cursor: default; }

/* The race/sex override: a searchable race list, because past ~10 options a
   bare list is a defect here (standing UI rule) — and because a modded race
   must be typeable, the input's raw text is sent when nothing matches. */
.pd-raceed {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: 11px;
  background: rgba(240, 214, 140, .07); border: 1px solid rgba(240, 214, 140, .32);
}
.pd-raceed-head { font-size: 14px; line-height: 1.45; color: #f2ecdc; }
.pd-raceed-sex { display: flex; flex-wrap: wrap; gap: 8px; }
.pd-racelist { max-height: 210px; overflow-y: auto; margin: 0; }
.fc-catchip.is-guess { box-shadow: inset 0 0 0 1px rgba(140, 190, 250, .55); }
.pd-raceq { width: 100%; box-sizing: border-box; }

/* ⟳ on the face itself. Left column under 🔍, mirroring ☆/✕ on the right, so
   the four corner controls can never land on one another. Visible at rest (a
   control he could not find was the complaint) and full strength on hover. */
.pd-rr {
  position: absolute; top: 32px; left: 4px; z-index: 2;
  width: 24px; height: 24px; padding: 0; line-height: 22px; text-align: center;
  font-size: 14px; cursor: pointer; border-radius: 6px;
  background: rgba(10, 12, 16, .6); color: #d8d4c8;
  border: 1px solid rgba(255, 255, 255, .14);
  opacity: .55; transition: opacity .12s ease, background .12s ease, border-color .12s ease, color .12s ease;
}
.pd-tile:hover .pd-rr, .pd-tile:focus-within .pd-rr { opacity: 1; }
.pd-rr:hover { background: rgba(240, 214, 140, .2); border-color: rgba(240, 214, 140, .6); color: #f6ecc8; }
.pd-rr:active { transform: translateY(1px); }
.pd-rr.is-blocked { opacity: .3; cursor: default; }
.pd-rr.is-busy { opacity: 1; color: #f0d68c; border-color: rgba(240, 214, 140, .6); cursor: default; }

/* In-flight, ON the tile that was pressed. One rotating glyph — the animation
   shape Ultralight draws cleanly (see the smear warning at the top). */
.pd-rendering {
  position: absolute; inset: 0; z-index: 1; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8, 10, 14, .72);
}
.pd-rendering-g { font-size: 26px; color: #f0d68c; animation: pdRrSpin 1.1s linear infinite; }
@keyframes pdRrSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.pd-tile.is-rendering { border-color: rgba(240, 214, 140, .6); }

/* A preset the renderer refuses wears the reason, and clicking it opens the
   fix — never a tile that just sits there with no image and no explanation. */
.pd-failbar {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 1;
  padding: 3px 4px; font-size: 12px; line-height: 1.35; text-align: center; cursor: pointer;
  color: #ffe0da; background: rgba(150, 46, 46, .82);
  border: 0; border-top: 1px solid rgba(255, 190, 180, .35);
  transition: background .12s ease, color .12s ease;
}
.pd-failbar:hover { background: rgba(196, 62, 62, .92); color: #fff; }
.pd-tile.is-failed { border-color: rgba(224, 138, 138, .55); }

/* The Set-image strip: 234 files on his rig, so it gets a filter and room to
   breathe instead of an unfiltered 120px scroller nobody could search. */
.fc-body .pd-strip-row { max-height: 260px; }
.pd-imgq { margin-bottom: 2px; }
