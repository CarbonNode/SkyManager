/* ===================================================================== *
 *  Domains tab — Mark & Recall pane for the Hotkey Deck view.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is dm- prefixed, no existing rule is touched and no token is
 *  redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease), and the
 *  shared @keyframes fadeIn · toastIn · capturePulse · flashFire and the
 *  shared .ghost-btn / .keychip / .empty-* classes are reused as-is.
 * ===================================================================== */

#dm-pane { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
#dm-body { flex: 1; display: flex; min-height: 0; }

/* ---------- category rail ---------- */

#dm-rail {
  width: 158px; flex: none;
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 7px;
  border-right: 1px solid #2e2e36;
  background: rgba(0,0,0,.16);
  overflow-y: auto;
}
#dm-rail-list { display: flex; flex-direction: column; gap: 3px; }

.dm-rail-item {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 9px;
  border: 1px solid transparent; border-radius: 6px;
  color: #b9b4a8; font-size: 12.5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.dm-rail-item:hover { background: rgba(201,162,75,.06); color: #ece7db; }
.dm-rail-item.sel {
  background: linear-gradient(90deg, rgba(201,162,75,.10), transparent);
  border-color: #c9a24b77; color: #ecd9a0;
}
.dm-rail-item:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }
.dm-rail-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-rail-count {
  flex: none;
  font-family: Consolas, "Courier New", monospace; font-size: 10.5px;
  color: #6f6a5e; background: rgba(255,255,255,.04);
  border-radius: 9px; padding: 2px 6px;
}
.dm-rail-item.sel .dm-rail-count { color: #d9c48a; background: rgba(201,162,75,.10); }
.dm-rail-item.all { border-bottom: 1px solid #26262d; border-radius: 6px; margin-bottom: 2px; }
.dm-rail-item.all .dm-rail-name { font-weight: 600; letter-spacing: .3px; }
/* a dragged domain hovering a category */
.dm-rail-item.drop-into {
  border-color: #c9a24b; background: rgba(201,162,75,.10);
  box-shadow: 0 0 0 2px rgba(201,162,75,.10); color: #ecd9a0;
}
/* category reorder targets (edit mode) */
.dm-rail-item.drop-before { box-shadow: 0 -2px 0 #c9a24b; }
.dm-rail-item.drop-after  { box-shadow: 0 2px 0 #c9a24b; }

.dm-rail-item.edit { cursor: default; padding: 5px 6px; gap: 4px; }
.dm-drag-h { flex: none; color: #4d4a44; font-size: 10px; letter-spacing: 0; cursor: grab; }
.dm-rail-rename {
  flex: 1; min-width: 0;
  font-family: inherit; font-size: 12px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 5px 6px;
}
.dm-rail-rename:focus { outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 3px rgba(201,162,75,.08); }
.dm-icon-btn {
  flex: none; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1;
  color: #6f6a5e; background: transparent;
  border: 1px solid transparent; border-radius: 5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.dm-icon-btn:hover { background: rgba(255,255,255,.05); color: #e0b0b0; border-color: #a5556588; }
.dm-icon-btn.confirm { color: #e0b0b0; background: #1a1216; border-color: #a55565; }

.dm-railadd {
  font-family: inherit; font-size: 11.5px; color: #6f6a5e;
  background: transparent; border: 1px dashed #33333d; border-radius: 6px;
  padding: 7px 6px; cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease;
}
.dm-railadd:hover { border-color: #c9a24b88; color: #c9a24b; }
.dm-railadd:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }

/* ---------- main column ---------- */

#dm-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 10px 14px 12px; }

#dm-toolbar { display: flex; align-items: center; gap: 9px; margin-bottom: 9px; flex: none; }
#dm-search-wrap { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }
.dm-search-ic { position: absolute; left: 9px; color: #8b8678; font-size: 17px; line-height: 1; pointer-events: none; }
#dm-search {
  width: 100%;
  font-family: inherit; font-size: 13px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 8px 10px 8px 29px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#dm-search::placeholder { color: #6b675e; }
#dm-search:focus { outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 3px rgba(201,162,75,.08); }
#dm-count {
  flex: none;
  font-family: Consolas, "Courier New", monospace; font-size: 11px;
  color: #d9c48a; background: rgba(201,162,75,.06);
  border: 1px solid #c9a24b77; border-radius: 20px;
  padding: 4px 9px; min-width: 24px; text-align: center;
}

#dm-openkey {
  flex: none;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 9px 11px; margin-bottom: 9px;
  animation: fadeIn 140ms ease;
}
.dm-ok-label { font-size: 12px; color: #b9b4a8; letter-spacing: .3px; }
.dm-ok-hint { flex: 1; min-width: 140px; font-size: 11px; color: #6f6a5e; line-height: 1.45; }
#dm-openkey-btn.capturing { animation: capturePulse 1s ease-in-out infinite; }

/* ---------- list: big-image card grid (teleport-menu style) ----------
   Top-level domains are CARDS — a 16:9 hero (the place photo, or the initials
   banner) over name + note + chips — flowing in an auto-fill grid, so the
   column count follows the menu width. Sub-areas keep the old compact
   horizontal row, spanning the full grid width under their parent. The
   "Card size" slider (--dm-thumb) drives the grid's minimum column width. */

#dm-list {
  flex: 1; min-height: 74px;
  overflow-y: auto; overflow-x: hidden;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(calc(212px * var(--dm-thumb, 1)), 100%), 1fr));
  /* the list is a fixed-height scroller (flex:1): without max-content rows the
     grid SQUEEZES its auto tracks into the visible height and every card clips */
  grid-auto-rows: max-content;
  gap: 12px;
  align-content: start;
  padding-right: 2px;
}
#dm-list::-webkit-scrollbar, #dm-rail::-webkit-scrollbar, .dm-ctx-scroll::-webkit-scrollbar { width: 10px; }
#dm-list::-webkit-scrollbar-track, #dm-rail::-webkit-scrollbar-track, .dm-ctx-scroll::-webkit-scrollbar-track { background: transparent; }
#dm-list::-webkit-scrollbar-thumb, #dm-rail::-webkit-scrollbar-thumb, .dm-ctx-scroll::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
#dm-list::-webkit-scrollbar-thumb:hover, #dm-rail::-webkit-scrollbar-thumb:hover, .dm-ctx-scroll::-webkit-scrollbar-thumb:hover { background: #3d3d47; }

.dm-row {
  position: relative;
  display: flex; flex-direction: column; align-items: stretch; gap: 0;
  padding: 0;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 11px;
  overflow: hidden;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 120ms ease, box-shadow 140ms ease;
}
.dm-row:hover {
  background: #1b1b23; border-color: rgba(201,162,75,.34);
  transform: translateY(-2px);
  box-shadow: 0 8px 22px rgba(0,0,0,.38);
}
.dm-row:active { transform: none; }
.dm-row.sel { border-color: #c9a24b99; box-shadow: 0 0 0 2px rgba(201,162,75,.14); }
.dm-row.flash { animation: flashFire 400ms ease; }
/* the grid flows left→right, so reorder targets mark a SIDE edge and the
   middle third (nest-under) glows as a whole */
.dm-row.drop-before { box-shadow: -3px 0 0 #c9a24b, 0 0 0 1px rgba(201,162,75,.25); }
.dm-row.drop-after  { box-shadow: 3px 0 0 #c9a24b, 0 0 0 1px rgba(201,162,75,.25); }
.dm-row.drop-into   { border-color: #c9a24b; box-shadow: inset 0 0 0 2px rgba(201,162,75,.45); }

/* base medal = the small round avatar (sub-area rows keep it); the card hero
   override below turns a top-level medal into a full-width initials banner */
.dm-medal {
  flex: none; width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; letter-spacing: .5px;
  color: hsl(var(--dm-hue, 45), 45%, 72%);
  background:
    radial-gradient(120% 120% at 30% 25%, hsla(var(--dm-hue, 45), 45%, 60%, .16), transparent 70%),
    #0c0c10;
  border: 1px solid hsla(var(--dm-hue, 45), 35%, 55%, .45);
  border-radius: 50%;
}
.dm-medal.exterior { border-style: dashed; }

/* ---------- card hero: photo box / initials banner ---------- */
.dm-row:not(.dm-child) > .dm-thumb-box,
.dm-row:not(.dm-child) > .dm-medal {
  flex: none; width: 100%; height: auto;
  aspect-ratio: 16 / 9;
  border-radius: 0; border: 0;
  border-bottom: 2px solid hsla(var(--dm-hue, 45), 40%, 55%, .5);
  background: #0c0c10;
}
.dm-row:not(.dm-child) > .dm-medal {
  display: flex; align-items: center; justify-content: center;
  font-size: 30px; letter-spacing: 3px;
  background:
    radial-gradient(130% 130% at 30% 18%, hsla(var(--dm-hue, 45), 45%, 60%, .22), transparent 72%),
    linear-gradient(180deg, #15151d, #0c0c10);
}
.dm-row:not(.dm-child) > .dm-medal.exterior,
.dm-row:not(.dm-child) > .dm-thumb-box.exterior { border-bottom-style: dashed; }
/* the hero is part of the card's one big travel target — never a zoom cursor;
   the ⛶ button in its corner is the enlarge affordance */
.dm-row:not(.dm-child) > .dm-thumb-box.zoom { cursor: pointer; }
.dm-row:not(.dm-child) > .dm-thumb-box.zoom:hover { box-shadow: none; filter: none; }
.dm-row:not(.dm-child) > .dm-thumb-box.zoom:active { transform: none; }

/* ⛶ view-photo button, bottom-right corner of a hero that really drew */
.dm-zoomer {
  position: absolute; right: 8px; bottom: 8px; z-index: 4;
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; line-height: 1; color: #e8e4da;
  background: rgba(10, 10, 14, .72);
  border: 1px solid rgba(255, 255, 255, .16); border-radius: 7px;
  cursor: pointer; cursor: zoom-in;
  opacity: 0; transition: opacity 140ms ease, background 140ms ease, border-color 140ms ease;
}
.dm-row:hover .dm-zoomer, .dm-row.sel .dm-zoomer { opacity: .92; }
.dm-zoomer:hover { background: rgba(201, 162, 75, .30); border-color: #c9a24b88; }
.dm-zoomer:active { transform: scale(.92); }

/* ---------- sub-area tree (chevron + child rows) ---------- */

/* chevron rides the hero's top-left corner as a glassy chip */
.dm-chev {
  position: absolute; top: 8px; left: 8px; z-index: 4;
  width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 1;
  color: #e8e4da; background: rgba(10, 10, 14, .72);
  border: 1px solid rgba(255, 255, 255, .14); border-radius: 7px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, transform 140ms ease;
}
.dm-chev:hover { background: rgba(201,162,75,.25); color: #ecd9a0; }
.dm-chev.open { color: #c9a24b; }
.dm-chev.spacer { display: none; }   /* cards need no alignment spacer */

/* a sub-area: the old compact horizontal row, spanning the whole grid width
   directly under its parent's card row, with the connector kept */
.dm-row.dm-child {
  position: relative;
  grid-column: 1 / -1;
  flex-direction: row; align-items: center; gap: 10px;
  padding: 7px 11px;
  margin-left: 26px;
  border-radius: 7px; overflow: visible;
  background: #131319; border-color: #26262d;
}
.dm-row.dm-child::before {
  content: ''; position: absolute; left: -15px; top: 50%;
  width: 13px; height: 1px; background: #2e2e36;
}
.dm-row.dm-child:hover { background: #191921; transform: none; box-shadow: none; }
.dm-child .dm-medal { width: 23px; height: 23px; font-size: 9.5px; }
.dm-child .dm-name { font-size: 12.5px; font-weight: 400; }
.dm-child .dm-chev { position: static; width: 18px; height: 18px; font-size: 10px; color: #8b8678; background: transparent; border-color: transparent; }

.dm-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px 11px; }
.dm-child .dm-body { padding: 0; gap: 2px; }
.dm-name {
  font-size: 15px; font-weight: 600; color: #ece7db;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dm-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.dm-sub {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 7px; min-width: 0;
  font-size: 11px; color: #6f6a5e;
}
.dm-child .dm-sub { flex-wrap: nowrap; align-items: baseline; }
.dm-note {
  flex: 1 1 100%; min-width: 0;              /* the note is the card's own description line */
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #d9c48a; opacity: .8; font-style: italic;
  font-size: 11.5px;
}
.dm-child .dm-note { flex: 0 1 auto; font-size: 11px; }
.dm-note mark { background: transparent; color: #ecd9a0; font-weight: 600; }
.dm-note.empty { color: #6f6a5e; opacity: .85; font-style: normal; }
.dm-child .dm-note.empty { flex: none; }
.dm-row:not(:hover) .dm-note.empty { visibility: hidden; }
.dm-chip {
  flex: none;
  color: #8b8678; background: rgba(255,255,255,.03);
  border: 1px solid #26262d; border-radius: 9px;
  padding: 1px 7px; font-size: 10px; font-style: normal;
  white-space: nowrap; max-width: 190px; overflow: hidden; text-overflow: ellipsis;
}
.dm-chip mark { background: transparent; color: #c9a24b; font-weight: 600; }
.dm-chip.cat { border-style: dashed; }
.dm-chip.exterior { color: #9aa88b; }

/* ➤ travel badge — rides the hero's top-right corner on hover/selection */
.dm-go {
  position: absolute; top: 8px; right: 8px; z-index: 4;
  width: 26px; height: 26px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 1;
  color: #14110a; background: #c9a24b;
  border-radius: 7px;
  opacity: 0; transform: translateX(-3px);
  transition: opacity 140ms ease, transform 140ms ease;
  pointer-events: none;
}
.dm-row:hover .dm-go, .dm-row.sel .dm-go { opacity: .95; transform: none; }
.dm-child .dm-go {
  position: static; width: auto; height: auto;
  color: #c9a24b; background: transparent; border-radius: 0;
}

/* ---------- follower faces (Followers-tab Home field → domain) ----------
   A little cluster of overlapping round portraits for the followers assigned
   to this place. flex:none so it never steals width from the ellipsizing name;
   it sits between .dm-body and the ➤ go-arrow. */

.dm-faces { flex: none; display: flex; align-items: center; margin-left: 2px; }
/* on a card the cluster is a footer strip under the body text */
.dm-row:not(.dm-child) > .dm-faces { padding: 0 12px 10px; margin: -3px 0 0; }
.dm-face, .dm-face-more {
  position: relative; flex: none;
  width: 24px; height: 24px; margin-left: -6px;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px #16161d;   /* ring in the row bg so overlaps read cleanly */
  transition: transform 140ms ease, box-shadow 140ms ease;
}
.dm-faces > :first-child { margin-left: 0; }
.dm-child .dm-faces { display: none; }   /* sub-area rows never carry a cluster */
.dm-face:hover { transform: translateY(-2px); box-shadow: 0 0 0 1.5px #c9a24b; z-index: 4; }

.dm-face-img, .dm-face-medal {
  width: 100%; height: 100%; border-radius: 50%; display: block;
}
.dm-face-img { object-fit: cover; }
.dm-face-medal {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 8.5px; font-weight: 700; letter-spacing: .3px;
  color: hsl(var(--dm-hue, 45), 45%, 74%);
  background:
    radial-gradient(120% 120% at 30% 25%, hsla(var(--dm-hue, 45), 45%, 60%, .18), transparent 70%),
    #0c0c10;
  border: 1px solid hsla(var(--dm-hue, 45), 35%, 55%, .5);
}
.dm-face-more {
  display: inline-flex; align-items: center; justify-content: center;
  font-family: Consolas, "Courier New", monospace; font-size: 9.5px; font-weight: 700;
  color: #d9c48a; background: #12121a; border: 1px solid #c9a24b55;
}

/* Face hover text is the title attribute, drawn by app.js's deck-wide
   #hd-tip bubble (screen-clamped). The hand-built .dm-face-tip that used to
   live here predated #hd-tip and rendered as a clipped fragment once the
   card layout gave rows overflow:hidden — removed. */

/* ---------- empty state ---------- */

#dm-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 26px 18px; }
#dm-empty .empty-sub { max-width: 380px; margin-left: auto; margin-right: auto; line-height: 1.5; }

/* ---------- footer: mark this spot ---------- */

#dm-foot { flex: none; margin-top: 9px; }
#dm-mark-btn {
  width: 100%;
  font-family: inherit; font-size: 12.5px; letter-spacing: .3px;
  color: #d9c48a; background: rgba(201,162,75,.06);
  border: 1px dashed #c9a24b77; border-radius: 7px;
  padding: 11px 12px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
#dm-mark-btn:hover:not(:disabled) { background: rgba(201,162,75,.12); color: #ecd9a0; border-color: #c9a24b; }
#dm-mark-btn:active:not(:disabled) { transform: translateY(1px); }
#dm-mark-btn:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }
#dm-mark-btn:disabled { color: #6f6a5e; border-color: #33333d; background: transparent; cursor: not-allowed; }
#dm-here { margin-top: 6px; font-size: 11px; color: #6f6a5e; line-height: 1.45; text-align: center; }

/* ---------- context menu (appended to #overlay, so it sits outside the
     panel's transform: scale and lands on the real cursor position) ---- */

#dm-ctx {
  position: absolute; z-index: 60; min-width: 244px; max-width: 320px;
  padding: 5px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 8px;
  box-shadow: 0 16px 44px rgba(0,0,0,.62), 0 0 0 1px rgba(0,0,0,.35);
  animation: fadeIn 110ms ease;
}
.dm-ctx-head {
  font-size: 12px; line-height: 1.3; letter-spacing: .2px; color: #d9c48a;
  padding: 7px 9px 6px; margin-bottom: 4px;
  border-bottom: 1px solid #2e2e36;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dm-ctx-where { display: block; font-size: 10.5px; color: #6f6a5e; margin-top: 3px; }
.dm-ctx-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 12.5px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 8px 9px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.dm-ctx-item:hover:not(:disabled) { background: rgba(201,162,75,.06); color: #ece7db; }
.dm-ctx-item:focus-visible { outline: none; border-color: #c9a24b77; background: rgba(201,162,75,.06); }
.dm-ctx-item:disabled { opacity: .38; cursor: not-allowed; }
.dm-ctx-item.danger { color: #e0b0b0; }
.dm-ctx-item.danger:hover:not(:disabled) { background: #1a1216; color: #e0b0b0; }
.dm-ctx-item.danger.confirm { background: #1a1216; border-color: #a55565; box-shadow: inset 0 0 0 1px #a55565; }
.dm-ctx-check { flex: none; width: 15px; text-align: center; font-size: 12px; color: #c9a24b; }
.dm-ctx-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-ctx-count {
  flex: none; font-family: Consolas, "Courier New", monospace; font-size: 10px;
  color: #6f6a5e; background: rgba(255,255,255,.04); border-radius: 9px; padding: 2px 6px;
}
.dm-ctx-sep { height: 1px; background: #2e2e36; margin: 4px 6px; }
.dm-ctx-scroll { max-height: 260px; overflow-y: auto; }
.dm-ctx-field { display: flex; align-items: center; gap: 8px; padding: 4px 6px; }
.dm-ctx-field label {
  flex: none; width: 54px;
  font-size: 10.5px; letter-spacing: .3px; text-transform: uppercase; color: #6f6a5e;
}
.dm-ctx-input, .dm-ctx-select {
  flex: 1; min-width: 0;
  font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 7px 8px; outline: none;
}
.dm-ctx-input:focus, .dm-ctx-select:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.dm-ctx-input::placeholder { color: #6b675e; }
.dm-ctx-input.note { color: #d9c48a; font-style: italic; }
.dm-ctx-select { cursor: pointer; color: #b9b4a8; }

/* ---------- the domain menu is a FORM: centred, wide, and typable --------
   Rober, 2026-08-03: "domains right click needs to be centered, wider
   horizontally, category and nest under should be typable". The width and
   the type sizes here override the compact popup defaults above; the small
   anchored menus (the ★ Mark chooser) keep theirs by not carrying `.wide`. */
#dm-ctx { max-height: calc(100vh - 20px); overflow-y: auto; }
/* Fixed width, but never wider than the screen. `min-width: 0` matters:
   the base rule's min-width would otherwise beat max-width on a narrow
   viewport and push the menu off the edge. */
#dm-ctx.wide { width: 520px; min-width: 0; max-width: calc(100vw - 24px); padding: 8px; }
#dm-ctx .dm-ctx-head { font-size: 13.5px; }
#dm-ctx .dm-ctx-where { font-size: 11.5px; }
#dm-ctx .dm-ctx-item { font-size: 13.5px; padding: 9px 10px; }
#dm-ctx .dm-ctx-field { padding: 5px 6px; }
#dm-ctx .dm-ctx-field label { font-size: 11.5px; }
#dm-ctx.wide .dm-ctx-field label { width: 84px; }
#dm-ctx .dm-ctx-input, #dm-ctx .dm-ctx-select { font-size: 13.5px; padding: 8px 9px; }
#dm-ctx .dm-ctx-hint { font-size: 11.5px; }

/* The combobox that replaced the dead <select>s. The list is absolute so
   opening it lays OVER the rows below rather than resizing a centred menu. */
.dm-pick { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.dm-pick .dm-pick-input { width: 100%; padding-right: 26px; cursor: text; }
.dm-pick-caret {
  position: absolute; right: 9px; font-size: 11px; color: #6f6a5e;
  pointer-events: none;   /* the caret is decoration; the input owns the click */
}
.dm-pick-list {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 4;
  max-height: 210px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px; padding: 4px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 7px;
  box-shadow: 0 14px 34px rgba(0,0,0,.6);
}
/* Low in the menu: open upward, or #dm-ctx's own scroll box would clip it. */
.dm-pick.up .dm-pick-list { top: auto; bottom: calc(100% + 4px); }
.dm-pick-list.hidden { display: none; }
.dm-pick-list::-webkit-scrollbar { width: 10px; }
.dm-pick-list::-webkit-scrollbar-track { background: transparent; }
.dm-pick-list::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
.dm-pick-list::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
.dm-pick-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 13.5px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 8px 9px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
/* Hover and keyboard highlight are the SAME state — the mouse moves `hi`. */
.dm-pick-row:hover, .dm-pick-row.hi {
  background: rgba(201,162,75,.10); color: #ece7db; border-color: #c9a24b44;
}
.dm-pick-row:active { background: rgba(201,162,75,.16); }
.dm-pick-row.cur { color: #d9c48a; }
.dm-pick-tick { flex: none; width: 14px; text-align: center; font-size: 12px; color: #c9a24b; }
.dm-pick-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-pick-lbl mark { background: transparent; color: #c9a24b; font-weight: 600; }
.dm-pick-hint {
  flex: none; max-width: 140px;
  font-size: 10.5px; color: #6f6a5e;
  background: rgba(255,255,255,.04); border: 1px solid #26262d; border-radius: 9px;
  padding: 1px 7px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dm-pick-empty { padding: 10px; font-size: 12.5px; color: #6f6a5e; text-align: center; }

/* ---------- scene staging: set the light before you take the picture -----
   Rober, 2026-08-03: "domain picture taking settings end up kinda dark or
   weather issues etc." Lives inside the (now wide) domain menu, directly
   under Photograph, because it is what you set before pressing it. */
.dm-scene {
  margin: 6px 6px 2px; padding: 8px 9px 9px;
  background: rgba(255,255,255,.02);
  border: 1px solid #26262d; border-radius: 8px;
}
.dm-scene-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-bottom: 7px;
}
.dm-scene-title { font-size: 12px; letter-spacing: .3px; color: #c9a24b; }
.dm-scene-now {
  font-size: 11.5px; color: #6f6a5e; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dm-scene-row {
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  margin-top: 5px;
}
.dm-scene-lbl {
  flex: none; width: 46px;
  font-size: 11px; letter-spacing: .3px; text-transform: uppercase; color: #6f6a5e;
}
.dm-scene-chip {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-family: inherit; font-size: 12.5px; color: #b9b4a8;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 999px;
  padding: 5px 11px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.dm-scene-chip:hover:not(:disabled) { background: rgba(201,162,75,.08); color: #ece7db; border-color: #c9a24b55; }
.dm-scene-chip:active:not(:disabled) { transform: translateY(1px); }
.dm-scene-chip.on {
  color: #1a1a20; background: #c9a24b; border-color: #c9a24b; font-weight: 600;
}
/* A kind this load order has no weather for: shown, disabled, and it says why
   on hover — hiding it would make the row's shape depend on the load order. */
.dm-scene-chip:disabled, .dm-scene-chip.off { opacity: .34; cursor: not-allowed; }
.dm-scene-glyph { font-size: 12px; opacity: .9; }
.dm-scene-step {
  flex: none; width: 30px; height: 28px;
  font-family: inherit; font-size: 15px; line-height: 1; color: #d9c48a;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dm-scene-step:hover { background: rgba(201,162,75,.10); border-color: #c9a24b55; }
.dm-scene-step:active { transform: translateY(1px); }
.dm-scene-val {
  flex: none; min-width: 96px; text-align: center;
  font-size: 12.5px; color: #6f6a5e;
}
.dm-scene-val.on { color: #d9c48a; }

/* ---------- summon-npc picker (own #dm-npc popup, sibling of #dm-ctx) ---- */

#dm-npc {
  position: absolute; z-index: 62; width: 288px; max-width: 340px;
  display: flex; flex-direction: column;
  padding: 5px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 8px;
  box-shadow: 0 16px 44px rgba(0,0,0,.62), 0 0 0 1px rgba(0,0,0,.35);
  animation: fadeIn 110ms ease;
}
.dm-npc-searchwrap { position: relative; display: flex; align-items: center; margin: 3px 3px 5px; }
.dm-npc-searchwrap .dm-search-ic { left: 8px; font-size: 15px; }
.dm-npc-search {
  width: 100%;
  font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px;
  padding: 7px 9px 7px 27px; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.dm-npc-search::placeholder { color: #6b675e; }
.dm-npc-search:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.dm-npc-list { max-height: 264px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.dm-npc-list::-webkit-scrollbar { width: 10px; }
.dm-npc-list::-webkit-scrollbar-track { background: transparent; }
.dm-npc-list::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
.dm-npc-list::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
.dm-npc-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 12.5px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 7px 9px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.dm-npc-item:hover { background: rgba(201,162,75,.06); color: #ece7db; }
.dm-npc-item:focus-visible { outline: none; border-color: #c9a24b77; background: rgba(201,162,75,.06); }
.dm-npc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-npc-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.dm-npc-tag {
  flex: none; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase;
  color: #8b8678; background: rgba(255,255,255,.04);
  border: 1px solid #26262d; border-radius: 9px; padding: 1px 6px;
}
.dm-npc-tag.follower { color: #d9c48a; background: rgba(201,162,75,.08); border-color: #c9a24b55; }
.dm-npc-dist {
  flex: none; font-family: Consolas, "Courier New", monospace; font-size: 10px;
  color: #6f6a5e; min-width: 30px; text-align: right;
}
.dm-npc-empty { padding: 16px 10px; text-align: center; font-size: 11.5px; color: #6f6a5e; }

/* ---------- open-key capture (own modal: the deck's #capture-modal
     belongs to app.js's own rebind flow and must not be borrowed) ------ */

#dm-capture {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55);
  animation: fadeIn 120ms ease;
}
.dm-capture-box {
  width: min(430px, 86%); text-align: center;
  background: linear-gradient(180deg, #1a1a21, #101015);
  border: 1px solid #c9a24b77; border-radius: 12px;
  padding: 24px 22px 18px;
  box-shadow: 0 20px 60px rgba(0,0,0,.6);
  animation: capturePulse 1.4s ease-in-out infinite;
}
.dm-capture-title { font-size: 15.5px; color: #ecd9a0; margin-bottom: 8px; }
.dm-capture-sub { font-size: 12px; color: #8b8678; line-height: 1.5; margin-bottom: 15px; }

/* ---------- fallback toast (only used when the host page has no #toast) */

#dm-toast {
  position: fixed; left: 50%; bottom: 6%; transform: translateX(-50%); z-index: 80;
  background: #16161c; border: 1px solid #c9a24b55; border-radius: 8px;
  color: #e8e4da; font-size: 13px; padding: 9px 18px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  animation: toastIn 160ms ease;
}

/* ---------- v0.14.x: larger, more readable right-click menu + summon picker.
     The 12px menus were too small to read at laid-back distance; re-declare only
     the size-driving properties larger (later rule wins), layout unchanged. ---- */
#dm-ctx { min-width: 322px; max-width: 470px; padding: 7px; }
.dm-ctx-head { font-size: 16px; padding: 9px 12px 8px; }
.dm-ctx-where { font-size: 13px; margin-top: 4px; }
.dm-ctx-item { font-size: 16px; gap: 10px; padding: 11px 12px; }
.dm-ctx-check { width: 20px; font-size: 16px; }
.dm-ctx-count { font-size: 12.5px; padding: 3px 8px; }
.dm-ctx-field { gap: 10px; padding: 5px 8px; }
.dm-ctx-field label { width: 66px; font-size: 12.5px; }
.dm-ctx-input, .dm-ctx-select { font-size: 15.5px; padding: 9px 11px; }
.dm-ctx-scroll { max-height: 340px; }
#dm-npc { width: 372px; max-width: 480px; padding: 7px; }
.dm-npc-search { font-size: 15.5px; padding: 10px 11px 10px 32px; }
.dm-npc-searchwrap .dm-search-ic { left: 10px; font-size: 18px; }
.dm-npc-list { max-height: 344px; }
.dm-npc-item { font-size: 15.5px; gap: 10px; padding: 10px 11px; }
.dm-npc-tag { font-size: 11.5px; padding: 2px 8px; }
.dm-npc-dist { font-size: 12.5px; min-width: 40px; }
.dm-npc-empty { font-size: 14px; padding: 20px 12px; }

/* ---------- edit-mode size sliders (UI size + image size) --------------
   Built by domains-pane.js and inserted after #dm-openkey; shown only in F2
   edit mode. View-only: each slider drives a CSS var (--dm-ui-scale /
   --dm-thumb) and persists through the config round-trip. */

#dm-scale {
  flex: none;
  display: flex; flex-direction: column; gap: 8px;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 9px 11px; margin-bottom: 9px;
  animation: fadeIn 140ms ease;
}
.dm-scale-row { display: flex; align-items: center; gap: 10px; }
.dm-scale-lbl {
  flex: none; width: 74px;
  font-size: 12px; color: #b9b4a8; letter-spacing: .3px;
}
.dm-range {
  flex: 1 1 56px; min-width: 56px; height: 4px; margin: 0;
  -webkit-appearance: none; appearance: none;
  background: #2e2e36; border-radius: 3px; outline: none; cursor: pointer;
  accent-color: #c9a24b;
  transition: box-shadow 140ms ease;
}
.dm-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 15px; height: 15px; border-radius: 50%;
  background: #c9a24b; border: 1px solid #0c0c10; cursor: pointer;
  box-shadow: 0 1px 3px rgba(0,0,0,.5);
  transition: transform 100ms ease, background 140ms ease;
}
.dm-range::-webkit-slider-thumb:hover { transform: scale(1.15); background: #ecd9a0; }
.dm-range::-webkit-slider-thumb:active { transform: scale(1.05); }
.dm-range:focus-visible { box-shadow: 0 0 0 3px rgba(201,162,75,.12); }
.dm-scale-val {
  flex: none; min-width: 46px; text-align: right;
  font-family: Consolas, "Courier New", monospace; font-size: 12px; color: #d9c48a;
}
.dm-scale-reset {
  flex: none;
  font-family: inherit; font-size: 11px; color: #6f6a5e; letter-spacing: .3px;
  background: transparent; border: 1px solid transparent; border-radius: 5px;
  padding: 4px 7px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.dm-scale-reset:hover { color: #c9a24b; border-color: #c9a24b55; background: rgba(201,162,75,.06); }
.dm-scale-reset:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }

/* ---------- whole-pane UI scale (--dm-ui-scale, "UI size" slider) --------
   Like the Followers tab's --fd-ui-scale, transform: scale() does not reflow,
   so the layout box is divided by the scale and the scaled result lands back at
   the parent's real size — done here on the CROSS axis (width) only.

   Deliberate deviation from #fol-pane, which also sets height: 100%/scale: the
   Domains pane keeps its original flex:1 height. #fol-pane's height:100% makes
   the pane full-PANEL-height, which — measured in the harness — pushes this
   tab's ★ Mark button below the panel and clips it, even at scale 1. The
   Followers list scrolls so its clipped bottom is harmless; our Mark button is
   pinned to the pane's foot, so it must stay in view. Keeping flex:1 makes scale
   1 pixel-identical to before, and transform-origin: top left pins a scaled-down
   pane to the tab bar (the useful "more room" direction never clips). */
#dm-pane {
  width: calc(100% / var(--dm-ui-scale, 1));
  transform: scale(var(--dm-ui-scale, 1));
  transform-origin: top left;
  transition: transform 130ms ease;
}

/* ---------- card / avatar size (--dm-thumb, "Card size" slider) -------
   On the card grid the slider drives the grid's minimum column width (see
   #dm-list), so it scales whole cards. Sub-area rows keep their small round
   avatar and scale it exactly as before. */
.dm-child .dm-medal { width: calc(23px * var(--dm-thumb, 1)); height: calc(23px * var(--dm-thumb, 1)); }

/* ---------- narrow viewport (low menu scale / small render target) ---- */

@media (max-width: 620px) {
  #dm-rail { width: 124px; }
  #dm-list {
    grid-template-columns: repeat(auto-fill, minmax(min(calc(168px * var(--dm-thumb, 1)), 100%), 1fr));
    gap: 9px;
  }
  .dm-name { font-size: 13.5px; }
  .dm-body { padding: 8px 10px 9px; }
  .dm-row:not(.dm-child) > .dm-faces { padding: 0 10px 8px; }
  .dm-chip { max-width: 108px; }
  .dm-face, .dm-face-more { width: 20px; height: 20px; margin-left: -5px; }
  .dm-face-medal { font-size: 7.5px; }
  .dm-ok-hint { display: none; }
  .dm-row.dm-child { margin-left: 18px; }
  .dm-row.dm-child::before { left: -11px; width: 9px; }
  #dm-ctx { min-width: 260px; }
  #dm-npc { width: min(330px, 90vw); }
  .dm-scale-row { gap: 7px; }
  .dm-scale-lbl { width: 58px; font-size: 11.5px; }
  .dm-scale-val { min-width: 34px; font-size: 11px; }
  .dm-scale-reset { padding: 4px 5px; }
}

/* Same rules, driven by the DECK WINDOW's own width: in-game the viewport is
   the whole screen, so the media query above never fires there — app.js
   toggles body.panel-narrow from the panel's layout width (≤720px, just above
   the 640px grip floor) on every resize/open. Keep the two blocks in sync. */
body.panel-narrow #dm-rail { width: 124px; }
body.panel-narrow #dm-list {
  grid-template-columns: repeat(auto-fill, minmax(min(calc(168px * var(--dm-thumb, 1)), 100%), 1fr));
  gap: 9px;
}
body.panel-narrow .dm-name { font-size: 13.5px; }
body.panel-narrow .dm-body { padding: 8px 10px 9px; }
body.panel-narrow .dm-row:not(.dm-child) > .dm-faces { padding: 0 10px 8px; }
body.panel-narrow .dm-chip { max-width: 108px; }
body.panel-narrow .dm-face, body.panel-narrow .dm-face-more { width: 20px; height: 20px; margin-left: -5px; }
body.panel-narrow .dm-face-medal { font-size: 7.5px; }
body.panel-narrow .dm-ok-hint { display: none; }
body.panel-narrow .dm-row.dm-child { margin-left: 18px; }
body.panel-narrow .dm-row.dm-child::before { left: -11px; width: 9px; }
body.panel-narrow #dm-ctx { min-width: 260px; }
body.panel-narrow #dm-npc { width: min(330px, 90vw); }
body.panel-narrow .dm-scale-row { gap: 7px; }
body.panel-narrow .dm-scale-lbl { width: 58px; font-size: 11.5px; }
body.panel-narrow .dm-scale-val { min-width: 34px; font-size: 11px; }
body.panel-narrow .dm-scale-reset { padding: 4px 5px; }


/* ---------- place photos: crop layer, tags, and the big view ------------
   Three additions, all dm- prefixed and all APPEND-ONLY.

   1. The row avatar is now a BOX plus an inner `.dm-art` layer. The box keeps
      the size, the round mask and the hue border it always had (so the row
      never shifts and --dm-thumb still scales it); the layer owns the picture
      and the crop transform. Transforming the image itself would scale its own
      clip and border with it and shoulder the row apart — the portrait and
      wardrobe crops both hit exactly that.
   2. `.dm-probe` is the 1px loader that tells us whether a candidate file
      exists; a background-image cannot report a 404. Opacity 0, never
      display:none — a display:none image is not guaranteed to be fetched.
   3. `.dm-art-lb` is the big view + crop editor, hung off document.body (the
      pane carries a scale transform, and the drag maths must not inherit it). */
.dm-thumb-box {
  flex: none; position: relative; overflow: hidden;
  width: calc(30px * var(--dm-thumb, 1)); height: calc(30px * var(--dm-thumb, 1));
  border-radius: 50%; background: #0c0c10;
  border: 1px solid hsla(var(--dm-hue, 45), 35%, 55%, .45);
}
.dm-thumb-box.exterior { border-style: dashed; }
.dm-child .dm-thumb-box { width: calc(23px * var(--dm-thumb, 1)); height: calc(23px * var(--dm-thumb, 1)); }

/* ---------- click a picture to enlarge it --------------------------------
   Every image on this tab is a click target: the row's own photo opens the
   place lightbox, a follower face opens the Followers pane's portrait
   lightbox. `.zoom` is added ONLY when there is really a picture behind the
   element — an initials medal has nothing to enlarge, so it keeps the row's
   cursor and the row's click (travel). `cursor: pointer` first so a renderer
   that doesn't know `zoom-in` still shows a hand rather than an arrow. */
.dm-thumb-box.zoom, .dm-face.zoom, .dm-who-face.zoom {
  cursor: pointer;
  cursor: zoom-in;
  transition: box-shadow 140ms ease, transform 140ms ease, filter 140ms ease;
}
.dm-thumb-box.zoom:hover, .dm-who-face.zoom:hover {
  box-shadow: 0 0 0 1.5px #c9a24b;
  filter: brightness(1.08);
  z-index: 6;
}
.dm-face.zoom:hover { filter: brightness(1.08); }   /* .dm-face:hover already lifts + rings */
/* Pressed: the picture dips a little, so a click that opens a full-screen
   overlay still acknowledges itself on the row you clicked. */
.dm-thumb-box.zoom:active, .dm-who-face.zoom:active { transform: scale(.94); }
.dm-face.zoom:active { transform: translateY(-2px) scale(.94); }
.dm-art {
  position: absolute; inset: 0;
  background-position: 50% 50%; background-size: cover; background-repeat: no-repeat;
  transform-origin: 50% 50%;
  transition: transform 120ms ease;
}
.dm-probe { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* tag chips on a row — a single non-wrapping line that truncates rather than
   shoving the note and place chips out of the row (the pane caps the count and
   summarises the rest as +N, so nothing is ever unreachable) */
.dm-tags { display: flex; align-items: baseline; gap: 4px; min-width: 0; overflow: hidden; }
/* cards have room to breathe: the chip row wraps instead of clipping mid-chip */
.dm-row:not(.dm-child) .dm-tags { flex-wrap: wrap; overflow: visible; }
.dm-tag {
  flex: none; display: inline-flex; align-items: center; gap: 3px;
  color: #b9a06a; background: rgba(201,162,75,.09);
  border: 1px solid rgba(201,162,75,.28); border-radius: 9px;
  padding: 1px 7px; font-size: 10px; font-style: normal; line-height: 1.5;
  white-space: nowrap; max-width: 128px; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dm-tag:hover { background: rgba(201,162,75,.18); border-color: rgba(201,162,75,.5); color: #ecd9a0; }
.dm-tag:focus-visible { outline: 1px solid #c9a24b; outline-offset: 1px; }
.dm-tag.on { background: rgba(201,162,75,.26); border-color: #c9a24b; color: #f2e2b4; }
.dm-tag.more { cursor: default; color: #8b8678; background: rgba(255,255,255,.03); border-color: #26262d; }
.dm-tag.more:hover { background: rgba(255,255,255,.03); border-color: #26262d; color: #8b8678; }
.dm-tag mark { background: transparent; color: #ecd9a0; font-weight: 600; }
.dm-tag.edit { cursor: default; max-width: 160px; }
.dm-tag-x {
  border: 0; background: transparent; color: inherit; opacity: .65;
  font-size: 10px; line-height: 1; padding: 0 0 0 1px; cursor: pointer;
}
.dm-tag-x:hover { opacity: 1; color: #e0b0b0; }

/* the "showing only tagged X" bar above the list */
#dm-tagbar { display: flex; align-items: center; gap: 8px; padding: 4px 10px 0; }
#dm-tagbar.hidden { display: none; }
.dm-tagbar-lbl { font-size: 10.5px; color: #6f6a5e; letter-spacing: .06em; text-transform: uppercase; }

/* the tag editor inside the right-click menu */
.dm-ctx-field.tags { flex-direction: column; align-items: stretch; gap: 5px; }
.dm-ctx-tags { display: flex; flex-wrap: wrap; gap: 4px; max-height: 66px; overflow-y: auto; }
.dm-ctx-hint { font-size: 10.5px; color: #6f6a5e; font-style: italic; }

/* ---- the big view + crop editor ---- */
.dm-art-lb {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(6,6,9,.82);
}
.dm-art-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 92vw; }
.dm-art-frame {
  position: relative; overflow: hidden; flex: none;
  border-radius: 10px; background: #0c0c10;
  border: 1px solid #3a3a44; box-shadow: 0 18px 44px rgba(0,0,0,.6);
}
/* the row draws this square as a circle — show the mask so the framing is
   honest rather than a surprise once the overlay closes */
.dm-art-frame::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  border-radius: 50%; box-shadow: 0 0 0 9999px rgba(6,6,9,.34);
  opacity: 0; transition: opacity 140ms ease;
}
.dm-art-frame.editing::after { opacity: 1; }
.dm-art-frame.editing { border-color: #c9a24b; cursor: grab; }
.dm-art-frame.dragging { cursor: grabbing; }
.dm-art-frame.editing .dm-art { transition: none; }   /* a drag must not lag the pointer */
.dm-art-cap { font-size: 13px; color: #ecd9a0; max-width: 90vw; text-align: center; }
.dm-art-foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px;
  max-width: min(560px, 90vw);
}
.dm-art-btn {
  border: 1px solid #3a3a44; border-radius: 7px; background: rgba(255,255,255,.04);
  color: #cdc7b8; font-size: 11.5px; padding: 4px 9px; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dm-art-btn:hover { background: rgba(255,255,255,.09); border-color: #55525d; color: #ecd9a0; }
.dm-art-btn:focus-visible { outline: 1px solid #c9a24b; outline-offset: 1px; }
.dm-art-btn:disabled { opacity: .4; cursor: default; }
.dm-art-btn.ok { border-color: #c9a24b; color: #f2e2b4; }
.dm-art-pad { display: flex; gap: 4px; }
.dm-art-pad .dm-art-btn { min-width: 28px; padding: 4px 6px; }
.dm-art-val { font-size: 11px; color: #8b8678; min-width: 92px; }
.dm-art-hint { flex-basis: 100%; text-align: center; font-size: 10.5px; color: #6f6a5e; }

@media (max-width: 620px) {
  .dm-tag { max-width: 84px; }
  .dm-art-hint { display: none; }
  .dm-art-val { min-width: 0; }
}
