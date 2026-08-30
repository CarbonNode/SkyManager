/* ===================================================================== *
 *  Containers tab — Mark & Recall pane for the Hotkey Deck view.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is ct- prefixed, no existing rule is touched and no token is
 *  redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease), and the
 *  shared @keyframes fadeIn · toastIn · capturePulse · flashFire and the
 *  shared .ghost-btn / .keychip / .empty-* classes are reused as-is.
 * ===================================================================== */

#ct-pane { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
#ct-body { flex: 1; display: flex; min-height: 0; }

/* ---------- category rail ---------- */

#ct-rail {
  width: 158px; flex: none;
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 7px;
  border-right: 1px solid #2e2e36;
  background: rgba(0,0,0,.16);
  overflow-y: auto;
}
#ct-rail-list { display: flex; flex-direction: column; gap: 3px; }

.ct-rail-item {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 9px;
  border: 1px solid transparent; border-radius: 6px;
  color: #b9b4a8; font-size: 12.5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.ct-rail-item:hover { background: rgba(201,162,75,.06); color: #ece7db; }
.ct-rail-item.sel {
  background: linear-gradient(90deg, rgba(201,162,75,.10), transparent);
  border-color: #c9a24b77; color: #ecd9a0;
}
.ct-rail-item:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }
.ct-rail-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-rail-count {
  flex: none;
  font-family: Consolas, "Courier New", monospace; font-size: 10.5px;
  color: #6f6a5e; background: rgba(255,255,255,.04);
  border-radius: 9px; padding: 2px 6px;
}
.ct-rail-item.sel .ct-rail-count { color: #d9c48a; background: rgba(201,162,75,.10); }
.ct-rail-item.all { border-bottom: 1px solid #26262d; border-radius: 6px; margin-bottom: 2px; }
.ct-rail-item.all .ct-rail-name { font-weight: 600; letter-spacing: .3px; }
/* a dragged container hovering a category */
.ct-rail-item.drop-into {
  border-color: #c9a24b; background: rgba(201,162,75,.10);
  box-shadow: 0 0 0 2px rgba(201,162,75,.10); color: #ecd9a0;
}
/* category reorder targets (edit mode) */
.ct-rail-item.drop-before { box-shadow: 0 -2px 0 #c9a24b; }
.ct-rail-item.drop-after  { box-shadow: 0 2px 0 #c9a24b; }

.ct-rail-item.edit { cursor: default; padding: 5px 6px; gap: 4px; }
.ct-drag-h { flex: none; color: #4d4a44; font-size: 10px; letter-spacing: 0; cursor: grab; }
.ct-rail-rename {
  flex: 1; min-width: 0;
  font-family: inherit; font-size: 12px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 5px 6px;
}
.ct-rail-rename:focus { outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 3px rgba(201,162,75,.08); }
.ct-icon-btn {
  flex: none; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1;
  color: #6f6a5e; background: transparent;
  border: 1px solid transparent; border-radius: 5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ct-icon-btn:hover { background: rgba(255,255,255,.05); color: #e0b0b0; border-color: #a5556588; }
.ct-icon-btn.confirm { color: #e0b0b0; background: #1a1216; border-color: #a55565; }

.ct-railadd {
  font-family: inherit; font-size: 11.5px; color: #6f6a5e;
  background: transparent; border: 1px dashed #33333d; border-radius: 6px;
  padding: 7px 6px; cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease;
}
.ct-railadd:hover { border-color: #c9a24b88; color: #c9a24b; }
.ct-railadd:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }

/* ---------- main column ---------- */

#ct-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 10px 14px 12px; }

#ct-toolbar { display: flex; align-items: center; gap: 9px; margin-bottom: 9px; flex: none; }
#ct-search-wrap { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }
.ct-search-ic { position: absolute; left: 9px; color: #8b8678; font-size: 17px; line-height: 1; pointer-events: none; }
#ct-search {
  width: 100%;
  font-family: inherit; font-size: 13px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 8px 10px 8px 29px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#ct-search::placeholder { color: #6b675e; }
#ct-search:focus { outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 3px rgba(201,162,75,.08); }
#ct-count {
  flex: none;
  font-family: Consolas, "Courier New", monospace; font-size: 11px;
  color: #d9c48a; background: rgba(201,162,75,.06);
  border: 1px solid #c9a24b77; border-radius: 20px;
  padding: 4px 9px; min-width: 24px; text-align: center;
}

#ct-openkey {
  flex: none;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 9px 11px; margin-bottom: 9px;
  animation: fadeIn 140ms ease;
}
.ct-ok-label { font-size: 12px; color: #b9b4a8; letter-spacing: .3px; }
.ct-ok-hint { flex: 1; min-width: 140px; font-size: 11px; color: #6f6a5e; line-height: 1.45; }
#ct-openkey-btn.capturing { animation: capturePulse 1s ease-in-out infinite; }

/* ---------- list ---------- */

#ct-list {
  /* 74px was less than ONE row — no floor at all. 180px keeps three rows on
     screen however tall the Drop-box card grows (see #cs-cards' cap below). */
  flex: 1; min-height: 180px;
  overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 4px;
  padding-right: 2px;
}
#ct-list::-webkit-scrollbar, #ct-rail::-webkit-scrollbar, .ct-ctx-scroll::-webkit-scrollbar { width: 10px; }
#ct-list::-webkit-scrollbar-track, #ct-rail::-webkit-scrollbar-track, .ct-ctx-scroll::-webkit-scrollbar-track { background: transparent; }
#ct-list::-webkit-scrollbar-thumb, #ct-rail::-webkit-scrollbar-thumb, .ct-ctx-scroll::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
#ct-list::-webkit-scrollbar-thumb:hover, #ct-rail::-webkit-scrollbar-thumb:hover, .ct-ctx-scroll::-webkit-scrollbar-thumb:hover { background: #3d3d47; }

.ct-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 11px;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 7px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
}
.ct-row:hover { background: #1d1d25; border-color: rgba(201,162,75,.22); }
.ct-row:active { transform: translateY(1px); }
.ct-row.sel { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.10); }
.ct-row.flash { animation: flashFire 400ms ease; }
.ct-row.drop-before { box-shadow: 0 -2px 0 #c9a24b; }
.ct-row.drop-after  { box-shadow: 0 2px 0 #c9a24b; }

.ct-medal {
  flex: none; width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; letter-spacing: .5px;
  color: hsl(var(--ct-hue, 45), 45%, 72%);
  background:
    radial-gradient(120% 120% at 30% 25%, hsla(var(--ct-hue, 45), 45%, 60%, .16), transparent 70%),
    #0c0c10;
  border: 1px solid hsla(var(--ct-hue, 45), 35%, 55%, .45);
  border-radius: 50%;
}
.ct-medal.exterior { border-style: dashed; }

/* ---------- sub-area tree (chevron + child rows) ---------- */

.ct-chev {
  flex: none; width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
  color: #8b8678; background: transparent;
  border: 1px solid transparent; border-radius: 5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, transform 140ms ease;
}
.ct-chev:hover { background: rgba(201,162,75,.10); color: #ecd9a0; }
.ct-chev.open { color: #c9a24b; }
.ct-chev.spacer { visibility: hidden; cursor: default; }

/* an indented sub-area row, with a short connector back to its parent column */
.ct-row.ct-child {
  position: relative;
  margin-left: 26px;
  background: #131319; border-color: #26262d;
}
.ct-row.ct-child::before {
  content: ''; position: absolute; left: -15px; top: 50%;
  width: 13px; height: 1px; background: #2e2e36;
}
.ct-row.ct-child:hover { background: #191921; }
.ct-child .ct-medal { width: 23px; height: 23px; font-size: 9.5px; }
.ct-child .ct-name { font-size: 12.5px; }

.ct-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ct-name {
  font-size: 13.5px; color: #ece7db;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ct-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.ct-sub {
  display: flex; align-items: baseline; gap: 7px; min-width: 0;
  font-size: 11px; color: #6f6a5e;
}
.ct-note {
  flex-shrink: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #d9c48a; opacity: .8; font-style: italic;
}
.ct-note mark { background: transparent; color: #ecd9a0; font-weight: 600; }
.ct-note.empty { flex: none; color: #6f6a5e; opacity: .85; font-style: normal; }
.ct-row:not(:hover) .ct-note.empty { visibility: hidden; }
.ct-chip {
  flex: none;
  color: #8b8678; background: rgba(255,255,255,.03);
  border: 1px solid #26262d; border-radius: 9px;
  padding: 1px 7px; font-size: 10px; font-style: normal;
  white-space: nowrap; max-width: 190px; overflow: hidden; text-overflow: ellipsis;
}
.ct-chip mark { background: transparent; color: #c9a24b; font-weight: 600; }
.ct-chip.cat { border-style: dashed; }
.ct-chip.exterior { color: #9aa88b; }

.ct-go {
  flex: none; font-size: 12px; color: #c9a24b;
  opacity: 0; transform: translateX(-3px);
  transition: opacity 140ms ease, transform 140ms ease;
}
.ct-row:hover .ct-go, .ct-row.sel .ct-go { opacity: .85; transform: none; }

/* ---------- follower faces (Followers-tab Home field → container) ----------
   A little cluster of overlapping round portraits for the followers assigned
   to this place. flex:none so it never steals width from the ellipsizing name;
   it sits between .ct-body and the ➤ go-arrow. */

.ct-faces { flex: none; display: flex; align-items: center; margin-left: 2px; }
.ct-face, .ct-face-more {
  position: relative; flex: none;
  width: 24px; height: 24px; margin-left: -6px;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px #16161d;   /* ring in the row bg so overlaps read cleanly */
  transition: transform 140ms ease, box-shadow 140ms ease;
}
.ct-faces > :first-child { margin-left: 0; }
.ct-child .ct-faces { display: none; }   /* sub-area rows never carry a cluster */
.ct-face:hover { transform: translateY(-2px); box-shadow: 0 0 0 1.5px #c9a24b; z-index: 4; }

.ct-face-img, .ct-face-medal {
  width: 100%; height: 100%; border-radius: 50%; display: block;
}
.ct-face-img { object-fit: cover; }
.ct-face-medal {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 8.5px; font-weight: 700; letter-spacing: .3px;
  color: hsl(var(--ct-hue, 45), 45%, 74%);
  background:
    radial-gradient(120% 120% at 30% 25%, hsla(var(--ct-hue, 45), 45%, 60%, .18), transparent 70%),
    #0c0c10;
  border: 1px solid hsla(var(--ct-hue, 45), 35%, 55%, .5);
}
.ct-face-more {
  display: inline-flex; align-items: center; justify-content: center;
  font-family: Consolas, "Courier New", monospace; font-size: 9.5px; font-weight: 700;
  color: #d9c48a; background: #12121a; border: 1px solid #c9a24b55;
}

/* hover name label — PrismaUI's native title tooltip is unreliable in-game.
   Anchored to the face's right edge so it grows leftward, staying inside the
   row (the cluster lives on the right, just before the go-arrow). */
.ct-face-tip {
  position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 6;
  pointer-events: none; white-space: nowrap;
  max-width: 260px; overflow: hidden; text-overflow: ellipsis;
  font-size: 12px; color: #ece7db;
  background: #0c0c10; border: 1px solid #c9a24b77; border-radius: 6px;
  padding: 4px 8px;
  box-shadow: 0 8px 22px rgba(0,0,0,.55);
  opacity: 0; transform: translateY(3px);
  transition: opacity 120ms ease, transform 120ms ease;
}
/* Second line of the tip: the home that put her on this row, and which mod
   (or your own typed field) says so. */
.ct-face-sub {
  display: block; margin-top: 2px;
  font-size: 12px; color: #c9bfa8;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ct-face:hover .ct-face-tip { opacity: 1; transform: none; }

/* ---------- empty state ---------- */

#ct-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 26px 18px; }
#ct-empty .empty-sub { max-width: 380px; margin-left: auto; margin-right: auto; line-height: 1.5; }

/* ---------- footer: mark this spot ---------- */

#ct-foot { flex: none; margin-top: 9px; }
#ct-mark-btn {
  width: 100%;
  font-family: inherit; font-size: 12.5px; letter-spacing: .3px;
  color: #d9c48a; background: rgba(201,162,75,.06);
  border: 1px dashed #c9a24b77; border-radius: 7px;
  padding: 11px 12px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
#ct-mark-btn:hover:not(:disabled) { background: rgba(201,162,75,.12); color: #ecd9a0; border-color: #c9a24b; }
#ct-mark-btn:active:not(:disabled) { transform: translateY(1px); }
#ct-mark-btn:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }
#ct-mark-btn:disabled { color: #6f6a5e; border-color: #33333d; background: transparent; cursor: not-allowed; }
#ct-here { margin-top: 6px; font-size: 11px; color: #6f6a5e; line-height: 1.45; text-align: center; }

/* ---------- context menu (appended to #overlay, so it sits outside the
     panel's transform: scale and lands on the real cursor position) ---- */

#ct-ctx {
  position: absolute; z-index: 60; min-width: 244px; max-width: 320px;
  padding: 5px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0,0,0, 0.45), 0 0 0 1px rgba(0,0,0,.35);
  animation: fadeIn 110ms ease;
}
.ct-ctx-head {
  font-size: 12px; line-height: 1.3; letter-spacing: .2px; color: #d9c48a;
  padding: 7px 9px 6px; margin-bottom: 4px;
  border-bottom: 1px solid #2e2e36;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ct-ctx-where { display: block; font-size: 10.5px; color: #6f6a5e; margin-top: 3px; }
.ct-ctx-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 12.5px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 8px 9px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.ct-ctx-item:hover:not(:disabled) { background: rgba(201,162,75,.06); color: #ece7db; }
.ct-ctx-item:focus-visible { outline: none; border-color: #c9a24b77; background: rgba(201,162,75,.06); }
.ct-ctx-item:disabled { opacity: .38; cursor: not-allowed; }
.ct-ctx-item.danger { color: #e0b0b0; }
.ct-ctx-item.danger:hover:not(:disabled) { background: #1a1216; color: #e0b0b0; }
.ct-ctx-item.danger.confirm { background: #1a1216; border-color: #a55565; box-shadow: inset 0 0 0 1px #a55565; }
.ct-ctx-check { flex: none; width: 15px; text-align: center; font-size: 12px; color: #c9a24b; }
.ct-ctx-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-ctx-count {
  flex: none; font-family: Consolas, "Courier New", monospace; font-size: 10px;
  color: #6f6a5e; background: rgba(255,255,255,.04); border-radius: 9px; padding: 2px 6px;
}
.ct-ctx-sep { height: 1px; background: #2e2e36; margin: 4px 6px; }
.ct-ctx-scroll { max-height: 260px; overflow-y: auto; }
.ct-ctx-field { display: flex; align-items: center; gap: 8px; padding: 4px 6px; }
.ct-ctx-field label {
  flex: none; width: 54px;
  font-size: 10.5px; letter-spacing: .3px; text-transform: uppercase; color: #6f6a5e;
}
.ct-ctx-input, .ct-ctx-select {
  flex: 1; min-width: 0;
  font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 7px 8px; outline: none;
}
.ct-ctx-input:focus, .ct-ctx-select:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.ct-ctx-input::placeholder { color: #6b675e; }
.ct-ctx-input.note { color: #d9c48a; font-style: italic; }
.ct-ctx-select { cursor: pointer; color: #b9b4a8; }

/* ---------- the container menu is a FORM: centred, wide, and typable --------
   Rober, 2026-08-03: "containers right click needs to be centered, wider
   horizontally, category and nest under should be typable". The width and
   the type sizes here override the compact popup defaults above; the small
   anchored menus (the ★ Mark chooser) keep theirs by not carrying `.wide`. */
#ct-ctx { max-height: calc((100vh - 20px) / var(--ui-scale, 1)); overflow-y: auto; }
/* Fixed width, but never wider than the screen. `min-width: 0` matters:
   the base rule's min-width would otherwise beat max-width on a narrow
   viewport and push the menu off the edge. */
#ct-ctx.wide { width: 520px; min-width: 0; max-width: calc((100vw - 24px) / var(--ui-scale, 1)); padding: 8px; }
#ct-ctx .ct-ctx-head { font-size: 13.5px; }
#ct-ctx .ct-ctx-where { font-size: 11.5px; }
#ct-ctx .ct-ctx-item { font-size: 13.5px; padding: 9px 10px; }
#ct-ctx .ct-ctx-field { padding: 5px 6px; }
#ct-ctx .ct-ctx-field label { font-size: 11.5px; }
#ct-ctx.wide .ct-ctx-field label { width: 84px; }
#ct-ctx .ct-ctx-input, #ct-ctx .ct-ctx-select { font-size: 13.5px; padding: 8px 9px; }
#ct-ctx .ct-ctx-hint { font-size: 11.5px; }

/* The combobox that replaced the dead <select>s. The list is absolute so
   opening it lays OVER the rows below rather than resizing a centred menu. */
.ct-pick { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.ct-pick .ct-pick-input { width: 100%; padding-right: 26px; cursor: text; }
.ct-pick-caret {
  position: absolute; right: 9px; font-size: 11px; color: #6f6a5e;
  pointer-events: none;   /* the caret is decoration; the input owns the click */
}
.ct-pick-list {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 4;
  max-height: 210px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px; padding: 4px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 7px;
  box-shadow: 0 14px 34px rgba(0,0,0,.6);
}
/* Low in the menu: open upward, or #ct-ctx's own scroll box would clip it. */
.ct-pick.up .ct-pick-list { top: auto; bottom: calc(100% + 4px); }
.ct-pick-list.hidden { display: none; }
.ct-pick-list::-webkit-scrollbar { width: 10px; }
.ct-pick-list::-webkit-scrollbar-track { background: transparent; }
.ct-pick-list::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
.ct-pick-list::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
.ct-pick-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 13.5px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 8px 9px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
/* Hover and keyboard highlight are the SAME state — the mouse moves `hi`. */
.ct-pick-row:hover, .ct-pick-row.hi {
  background: rgba(201,162,75,.10); color: #ece7db; border-color: #c9a24b44;
}
.ct-pick-row:active { background: rgba(201,162,75,.16); }
.ct-pick-row.cur { color: #d9c48a; }
.ct-pick-tick { flex: none; width: 14px; text-align: center; font-size: 12px; color: #c9a24b; }
.ct-pick-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-pick-lbl mark { background: transparent; color: #c9a24b; font-weight: 600; }
.ct-pick-hint {
  flex: none; max-width: 140px;
  font-size: 10.5px; color: #6f6a5e;
  background: rgba(255,255,255,.04); border: 1px solid #26262d; border-radius: 9px;
  padding: 1px 7px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ct-pick-empty { padding: 10px; font-size: 12.5px; color: #6f6a5e; text-align: center; }

/* ---------- scene staging: set the light before you take the picture -----
   Rober, 2026-08-03: "container picture taking settings end up kinda dark or
   weather issues etc." Lives inside the (now wide) container menu, directly
   under Photograph, because it is what you set before pressing it. */
.ct-scene {
  margin: 6px 6px 2px; padding: 8px 9px 9px;
  background: rgba(255,255,255,.02);
  border: 1px solid #26262d; border-radius: 8px;
}
.ct-scene-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-bottom: 7px;
}
.ct-scene-title { font-size: 12px; letter-spacing: .3px; color: #c9a24b; }
.ct-scene-now {
  font-size: 11.5px; color: #6f6a5e; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ct-scene-row {
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  margin-top: 5px;
}
.ct-scene-lbl {
  flex: none; width: 46px;
  font-size: 11px; letter-spacing: .3px; text-transform: uppercase; color: #6f6a5e;
}
.ct-scene-chip {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-family: inherit; font-size: 12.5px; color: #b9b4a8;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 999px;
  padding: 5px 11px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.ct-scene-chip:hover:not(:disabled) { background: rgba(201,162,75,.08); color: #ece7db; border-color: #c9a24b55; }
.ct-scene-chip:active:not(:disabled) { transform: translateY(1px); }
.ct-scene-chip.on {
  color: #1a1a20; background: #c9a24b; border-color: #c9a24b; font-weight: 600;
}
/* A kind this load order has no weather for: shown, disabled, and it says why
   on hover — hiding it would make the row's shape depend on the load order. */
.ct-scene-chip:disabled, .ct-scene-chip.off { opacity: .34; cursor: not-allowed; }
.ct-scene-glyph { font-size: 12px; opacity: .9; }
.ct-scene-step {
  flex: none; width: 30px; height: 28px;
  font-family: inherit; font-size: 15px; line-height: 1; color: #d9c48a;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.ct-scene-step:hover { background: rgba(201,162,75,.10); border-color: #c9a24b55; }
.ct-scene-step:active { transform: translateY(1px); }
.ct-scene-val {
  flex: none; min-width: 96px; text-align: center;
  font-size: 12.5px; color: #6f6a5e;
}
.ct-scene-val.on { color: #d9c48a; }

/* ---------- summon-npc picker (own #ct-npc popup, sibling of #ct-ctx) ---- */

#ct-npc {
  position: absolute; z-index: 62; width: 288px; max-width: 340px;
  display: flex; flex-direction: column;
  padding: 5px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0,0,0, 0.45), 0 0 0 1px rgba(0,0,0,.35);
  animation: fadeIn 110ms ease;
}
.ct-npc-searchwrap { position: relative; display: flex; align-items: center; margin: 3px 3px 5px; }
.ct-npc-searchwrap .ct-search-ic { left: 8px; font-size: 15px; }
.ct-npc-search {
  width: 100%;
  font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px;
  padding: 7px 9px 7px 27px; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ct-npc-search::placeholder { color: #6b675e; }
.ct-npc-search:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.ct-npc-list { max-height: 264px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.ct-npc-list::-webkit-scrollbar { width: 10px; }
.ct-npc-list::-webkit-scrollbar-track { background: transparent; }
.ct-npc-list::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
.ct-npc-list::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
.ct-npc-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 12.5px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 7px 9px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.ct-npc-item:hover { background: rgba(201,162,75,.06); color: #ece7db; }
.ct-npc-item:focus-visible { outline: none; border-color: #c9a24b77; background: rgba(201,162,75,.06); }
.ct-npc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-npc-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.ct-npc-tag {
  flex: none; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase;
  color: #8b8678; background: rgba(255,255,255,.04);
  border: 1px solid #26262d; border-radius: 9px; padding: 1px 6px;
}
.ct-npc-tag.follower { color: #d9c48a; background: rgba(201,162,75,.08); border-color: #c9a24b55; }
.ct-npc-dist {
  flex: none; font-family: Consolas, "Courier New", monospace; font-size: 10px;
  color: #6f6a5e; min-width: 30px; text-align: right;
}
.ct-npc-empty { padding: 16px 10px; text-align: center; font-size: 11.5px; color: #6f6a5e; }

/* ---------- open-key capture (own modal: the deck's #capture-modal
     belongs to app.js's own rebind flow and must not be borrowed) ------ */

#ct-capture {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.55);
  animation: fadeIn 120ms ease;
}
.ct-capture-box {
  width: min(430px, 86%); text-align: center;
  background: linear-gradient(180deg, #1a1a21, #101015);
  border: 1px solid #c9a24b77; border-radius: 12px;
  padding: 24px 22px 18px;
  box-shadow: 0 10px 28px rgba(0,0,0, 0.45);
  animation: capturePulse 1.4s ease-in-out infinite;
}
.ct-capture-title { font-size: 15.5px; color: #ecd9a0; margin-bottom: 8px; }
.ct-capture-sub { font-size: 12px; color: #8b8678; line-height: 1.5; margin-bottom: 15px; }

/* ---------- fallback toast (only used when the host page has no #toast) */

#ct-toast {
  position: fixed; left: 50%; bottom: 6%;
  transform: translateX(-50%) scale(var(--ui-scale, 1)); transform-origin: bottom center;
  z-index: 80;
  background: #16161c; border: 1px solid #c9a24b55; border-radius: 8px;
  color: #e8e4da; font-size: 13px; padding: 9px 18px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  animation: toastIn 160ms ease;
}

/* ---------- v0.14.x: larger, more readable right-click menu + summon picker.
     The 12px menus were too small to read at laid-back distance; re-declare only
     the size-driving properties larger (later rule wins), layout unchanged. ---- */
#ct-ctx { min-width: 322px; max-width: 470px; padding: 7px; }
.ct-ctx-head { font-size: 16px; padding: 9px 12px 8px; }
.ct-ctx-where { font-size: 13px; margin-top: 4px; }
.ct-ctx-item { font-size: 16px; gap: 10px; padding: 11px 12px; }
.ct-ctx-check { width: 20px; font-size: 16px; }
.ct-ctx-count { font-size: 12.5px; padding: 3px 8px; }
.ct-ctx-field { gap: 10px; padding: 5px 8px; }
.ct-ctx-field label { width: 66px; font-size: 12.5px; }
.ct-ctx-input, .ct-ctx-select { font-size: 15.5px; padding: 9px 11px; }
.ct-ctx-scroll { max-height: 340px; }
#ct-npc { width: 372px; max-width: 480px; padding: 7px; }
.ct-npc-search { font-size: 15.5px; padding: 10px 11px 10px 32px; }
.ct-npc-searchwrap .ct-search-ic { left: 10px; font-size: 18px; }
.ct-npc-list { max-height: 344px; }
.ct-npc-item { font-size: 15.5px; gap: 10px; padding: 10px 11px; }
.ct-npc-tag { font-size: 11.5px; padding: 2px 8px; }
.ct-npc-dist { font-size: 12.5px; min-width: 40px; }
.ct-npc-empty { font-size: 14px; padding: 20px 12px; }

/* ---------- edit-mode size sliders (UI size + image size) --------------
   Built by containers-pane.js and inserted after #ct-openkey; shown only in F2
   edit mode. View-only: each slider drives a CSS var (--ct-ui-scale /
   --ct-thumb) and persists through the config round-trip. */

#ct-scale {
  flex: none;
  display: flex; flex-direction: column; gap: 8px;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 9px 11px; margin-bottom: 9px;
  animation: fadeIn 140ms ease;
}
.ct-scale-row { display: flex; align-items: center; gap: 10px; }
.ct-scale-lbl {
  flex: none; width: 74px;
  font-size: 12px; color: #b9b4a8; letter-spacing: .3px;
}
.ct-range {
  flex: 1 1 56px; min-width: 56px; height: 4px; margin: 0;
  -webkit-appearance: none; appearance: none;
  background: #2e2e36; border-radius: 3px; outline: none; cursor: pointer;
  accent-color: #c9a24b;
  transition: box-shadow 140ms ease;
}
.ct-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 15px; height: 15px; border-radius: 50%;
  background: #c9a24b; border: 1px solid #0c0c10; cursor: pointer;
  box-shadow: 0 1px 3px rgba(0,0,0,.5);
  transition: transform 100ms ease, background 140ms ease;
}
.ct-range::-webkit-slider-thumb:hover { transform: scale(1.15); background: #ecd9a0; }
.ct-range::-webkit-slider-thumb:active { transform: scale(1.05); }
.ct-range:focus-visible { box-shadow: 0 0 0 3px rgba(201,162,75,.12); }
.ct-scale-val {
  flex: none; min-width: 46px; text-align: right;
  font-family: Consolas, "Courier New", monospace; font-size: 12px; color: #d9c48a;
}
.ct-scale-reset {
  flex: none;
  font-family: inherit; font-size: 11px; color: #6f6a5e; letter-spacing: .3px;
  background: transparent; border: 1px solid transparent; border-radius: 5px;
  padding: 4px 7px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.ct-scale-reset:hover { color: #c9a24b; border-color: #c9a24b55; background: rgba(201,162,75,.06); }
.ct-scale-reset:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }

/* ---------- whole-pane UI scale (--ct-ui-scale, "UI size" slider) --------
   Like the Followers tab's --fd-ui-scale, transform: scale() does not reflow,
   so the layout box is divided by the scale and the scaled result lands back at
   the parent's real size — done here on the CROSS axis (width) only.

   Deliberate deviation from #fol-pane, which also sets height: 100%/scale: the
   Containers pane keeps its original flex:1 height. #fol-pane's height:100% makes
   the pane full-PANEL-height, which — measured in the harness — pushes this
   tab's ★ Mark button below the panel and clips it, even at scale 1. The
   Followers list scrolls so its clipped bottom is harmless; our Mark button is
   pinned to the pane's foot, so it must stay in view. Keeping flex:1 makes scale
   1 pixel-identical to before, and transform-origin: top left pins a scaled-down
   pane to the tab bar (the useful "more room" direction never clips). */
#ct-pane {
  width: calc(100% / var(--ct-ui-scale, 1));
  transform: scale(var(--ct-ui-scale, 1));
  transform-origin: top left;
  transition: transform 130ms ease;
}

/* ---------- per-container row image (--ct-thumb, "Image size" slider) -------
   The uploaded image at container-images/<id>.<ext> replaces the initials medal
   as the row avatar; both share the same round footprint so the layout never
   shifts, and both scale with --ct-thumb. */
.ct-medal { width: calc(30px * var(--ct-thumb, 1)); height: calc(30px * var(--ct-thumb, 1)); }
.ct-child .ct-medal { width: calc(23px * var(--ct-thumb, 1)); height: calc(23px * var(--ct-thumb, 1)); }
.ct-thumb-img {
  flex: none;
  width: calc(30px * var(--ct-thumb, 1)); height: calc(30px * var(--ct-thumb, 1));
  border-radius: 50%; object-fit: cover; display: block;
  background: #0c0c10;
  border: 1px solid hsla(var(--ct-hue, 45), 35%, 55%, .45);
}
.ct-thumb-img.exterior { border-style: dashed; }
.ct-child .ct-thumb-img { width: calc(23px * var(--ct-thumb, 1)); height: calc(23px * var(--ct-thumb, 1)); }

/* ---------- narrow viewport (low menu scale / small render target) ---- */

@media (max-width: 620px) {
  #ct-rail { width: 124px; }
  .ct-chip { max-width: 108px; }
  .ct-face, .ct-face-more { width: 20px; height: 20px; margin-left: -5px; }
  .ct-face-medal { font-size: 7.5px; }
  .ct-ok-hint { display: none; }
  .ct-row.ct-child { margin-left: 18px; }
  .ct-row.ct-child::before { left: -11px; width: 9px; }
  #ct-ctx { min-width: 260px; }
  #ct-npc { width: min(330px, 90vw); }
  .ct-scale-row { gap: 7px; }
  .ct-scale-lbl { width: 58px; font-size: 11.5px; }
  .ct-scale-val { min-width: 34px; font-size: 11px; }
  .ct-scale-reset { padding: 4px 5px; }
}

/* ---------- place photos: crop layer, tags, and the big view ------------
   Three additions, all ct- prefixed and all APPEND-ONLY.

   1. The row avatar is now a BOX plus an inner `.ct-art` layer. The box keeps
      the size, the round mask and the hue border it always had (so the row
      never shifts and --ct-thumb still scales it); the layer owns the picture
      and the crop transform. Transforming the image itself would scale its own
      clip and border with it and shoulder the row apart — the portrait and
      wardrobe crops both hit exactly that.
   2. `.ct-probe` is the 1px loader that tells us whether a candidate file
      exists; a background-image cannot report a 404. Opacity 0, never
      display:none — a display:none image is not guaranteed to be fetched.
   3. `.ct-art-lb` is the big view + crop editor, hung off document.body (the
      pane carries a scale transform, and the drag maths must not inherit it). */
.ct-thumb-box {
  flex: none; position: relative; overflow: hidden;
  width: calc(30px * var(--ct-thumb, 1)); height: calc(30px * var(--ct-thumb, 1));
  border-radius: 50%; background: #0c0c10;
  border: 1px solid hsla(var(--ct-hue, 45), 35%, 55%, .45);
}
.ct-thumb-box.exterior { border-style: dashed; }
.ct-child .ct-thumb-box { width: calc(23px * var(--ct-thumb, 1)); height: calc(23px * var(--ct-thumb, 1)); }

/* ---------- click a picture to enlarge it --------------------------------
   Every image on this tab is a click target: the row's own photo opens the
   place lightbox, a follower face opens the Followers pane's portrait
   lightbox. `.zoom` is added ONLY when there is really a picture behind the
   element — an initials medal has nothing to enlarge, so it keeps the row's
   cursor and the row's click (travel). `cursor: pointer` first so a renderer
   that doesn't know `zoom-in` still shows a hand rather than an arrow. */
.ct-thumb-box.zoom, .ct-face.zoom, .ct-who-face.zoom {
  cursor: pointer;
  cursor: zoom-in;
  transition: box-shadow 140ms ease, transform 140ms ease, filter 140ms ease;
}
.ct-thumb-box.zoom:hover, .ct-who-face.zoom:hover {
  box-shadow: 0 0 0 1.5px #c9a24b;
  filter: brightness(1.08);
  z-index: 6;
}
.ct-face.zoom:hover { filter: brightness(1.08); }   /* .ct-face:hover already lifts + rings */
/* Pressed: the picture dips a little, so a click that opens a full-screen
   overlay still acknowledges itself on the row you clicked. */
.ct-thumb-box.zoom:active, .ct-who-face.zoom:active { transform: scale(.94); }
.ct-face.zoom:active { transform: translateY(-2px) scale(.94); }
.ct-art {
  position: absolute; inset: 0;
  background-position: 50% 50%; background-size: cover; background-repeat: no-repeat;
  transform-origin: 50% 50%;
  transition: transform 120ms ease;
}
.ct-probe { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* tag chips on a row — a single non-wrapping line that truncates rather than
   shoving the note and place chips out of the row (the pane caps the count and
   summarises the rest as +N, so nothing is ever unreachable) */
.ct-tags { display: flex; align-items: baseline; gap: 4px; min-width: 0; overflow: hidden; }
.ct-tag {
  flex: none; display: inline-flex; align-items: center; gap: 3px;
  color: #b9a06a; background: rgba(201,162,75,.09);
  border: 1px solid rgba(201,162,75,.28); border-radius: 9px;
  padding: 1px 7px; font-size: 10px; font-style: normal; line-height: 1.5;
  white-space: nowrap; max-width: 128px; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.ct-tag:hover { background: rgba(201,162,75,.18); border-color: rgba(201,162,75,.5); color: #ecd9a0; }
.ct-tag:focus-visible { outline: 1px solid #c9a24b; outline-offset: 1px; }
.ct-tag.on { background: rgba(201,162,75,.26); border-color: #c9a24b; color: #f2e2b4; }
.ct-tag.more { cursor: default; color: #8b8678; background: rgba(255,255,255,.03); border-color: #26262d; }
.ct-tag.more:hover { background: rgba(255,255,255,.03); border-color: #26262d; color: #8b8678; }
.ct-tag mark { background: transparent; color: #ecd9a0; font-weight: 600; }
.ct-tag.edit { cursor: default; max-width: 160px; }
.ct-tag-x {
  border: 0; background: transparent; color: inherit; opacity: .65;
  font-size: 10px; line-height: 1; padding: 0 0 0 1px; cursor: pointer;
}
.ct-tag-x:hover { opacity: 1; color: #e0b0b0; }

/* the "showing only tagged X" bar above the list */
#ct-tagbar { display: flex; align-items: center; gap: 8px; padding: 4px 10px 0; }
#ct-tagbar.hidden { display: none; }
.ct-tagbar-lbl { font-size: 10.5px; color: #6f6a5e; letter-spacing: .06em; text-transform: uppercase; }

/* the tag editor inside the right-click menu */
.ct-ctx-field.tags { flex-direction: column; align-items: stretch; gap: 5px; }
.ct-ctx-tags { display: flex; flex-wrap: wrap; gap: 4px; max-height: 66px; overflow-y: auto; }
.ct-ctx-hint { font-size: 10.5px; color: #6f6a5e; font-style: italic; }

/* ---- the big view + crop editor ---- */
.ct-art-lb {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(6,6,9,.82);
}
.ct-art-inner { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 92vw; }
.ct-art-frame {
  position: relative; overflow: hidden; flex: none;
  border-radius: 10px; background: #0c0c10;
  border: 1px solid #3a3a44; box-shadow: 0 10px 28px rgba(0,0,0, 0.45);
}
/* the row draws this square as a circle — show the mask so the framing is
   honest rather than a surprise once the overlay closes */
.ct-art-frame::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  border-radius: 50%; box-shadow: 0 0 0 9999px rgba(6,6,9,.34);
  opacity: 0; transition: opacity 140ms ease;
}
.ct-art-frame.editing::after { opacity: 1; }
.ct-art-frame.editing { border-color: #c9a24b; cursor: grab; }
.ct-art-frame.dragging { cursor: grabbing; }
.ct-art-frame.editing .ct-art { transition: none; }   /* a drag must not lag the pointer */
.ct-art-cap { font-size: 13px; color: #ecd9a0; max-width: 90vw; text-align: center; }
.ct-art-foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px;
  max-width: min(560px, 90vw);
}
.ct-art-btn {
  border: 1px solid #3a3a44; border-radius: 7px; background: rgba(255,255,255,.04);
  color: #cdc7b8; font-size: 11.5px; padding: 4px 9px; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.ct-art-btn:hover { background: rgba(255,255,255,.09); border-color: #55525d; color: #ecd9a0; }
.ct-art-btn:focus-visible { outline: 1px solid #c9a24b; outline-offset: 1px; }
.ct-art-btn:disabled { opacity: .4; cursor: default; }
.ct-art-btn.ok { border-color: #c9a24b; color: #f2e2b4; }
.ct-art-pad { display: flex; gap: 4px; }
.ct-art-pad .ct-art-btn { min-width: 28px; padding: 4px 6px; }
.ct-art-val { font-size: 11px; color: #8b8678; min-width: 92px; }
.ct-art-hint { flex-basis: 100%; text-align: center; font-size: 10.5px; color: #6f6a5e; }

@media (max-width: 620px) {
  .ct-tag { max-width: 84px; }
  .ct-art-hint { display: none; }
  .ct-art-val { min-width: 0; }
}

/* ===================================================================== *
 *  Container Auto-Sort (cs-) + Auto-Loot (al-) — a second feature living
 *  inside the Containers tab. All selectors cs-/al- prefixed; the deck's
 *  own literals (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease).
 *  No token under 12px; every control carries hover/active/disabled.
 * ===================================================================== */

/* ---------- shared card + chip + stepper primitives ---------- */
.cs-card, .al-inner {
  background: #16161d; border: 1px solid #2e2e36; border-radius: 9px;
  padding: 11px 13px; margin-bottom: 10px;
  animation: fadeIn 140ms ease;
}
#cs-cards { flex: none; }
#al-card { flex: none; padding: 0 14px 12px; }

.cs-card-head, .al-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 9px; }
.cs-card-title, .al-title { font-size: 14px; letter-spacing: .3px; color: #d9c48a; font-weight: 600; }
.cs-card-sub { font-size: 12px; color: #6f6a5e; }
.cs-field-lbl { display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: .3px; color: #b9b4a8; margin-bottom: 6px; }
.cs-lbl, .al-lbl { flex: none; font-size: 12.5px; color: #b9b4a8; letter-spacing: .3px; }
.cs-flex, .al-flex { flex: 1 1 auto; }
.cs-hint { font-size: 12px; color: #6f6a5e; font-style: italic; }
.cs-band, .al-readout { font-size: 12.5px; color: #d9c48a; margin-left: 4px; }

.cs-chip {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-family: inherit; font-size: 12.5px; color: #b9b4a8;
  background: #12121a; border: 1px solid #3a3a44; border-radius: 999px;
  padding: 6px 12px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 100ms ease;
}
.cs-chip:hover { background: rgba(201,162,75,.08); color: #ece7db; border-color: #c9a24b55; }
.cs-chip:active { transform: translateY(1px); }
.cs-chip.on { color: #1a1a20; background: #c9a24b; border-color: #c9a24b; font-weight: 600; }
.cs-chip:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }
.cs-chip.cs-enable { min-width: 88px; justify-content: center; }
.cs-chip.al-cat.on { background: #9bbf7c; border-color: #9bbf7c; color: #10160b; }

.cs-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cs-chip-grp { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.cs-grp-lbl {
  flex: none; font-size: 11.5px; letter-spacing: .3px; text-transform: uppercase; color: #6f6a5e;
  margin-right: 2px;
}

.cs-step { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.cs-step-btn {
  width: 28px; height: 28px; flex: none;
  font-family: inherit; font-size: 13px; line-height: 1; color: #d9c48a;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 6px; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.cs-step-btn:hover { background: rgba(201,162,75,.10); border-color: #c9a24b55; }
.cs-step-btn:active { transform: translateY(1px); }
.cs-step-val {
  width: 62px; text-align: center;
  font-family: Consolas, "Courier New", monospace; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px; padding: 6px 4px; outline: none;
}
.cs-step-val:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }

/* ---------- respawn-safety chip ---------- */
.cs-safe {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: 12px; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
}
.cs-safe.ok { color: #9bbf7c; background: rgba(120,170,90,.10); border: 1px solid rgba(120,170,90,.34); }
.cs-safe.warn { color: #e0b060; background: rgba(200,140,50,.10); border: 1px solid rgba(200,140,50,.4); }
.cs-safe.warn.ack { color: #c99a4b; opacity: .9; }
.cs-safe-why { color: inherit; opacity: .8; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.cs-tag-anyway {
  font-family: inherit; font-size: 11.5px; color: #1a1a20; background: #e0b060;
  border: 0; border-radius: 999px; padding: 3px 9px; cursor: pointer; margin-left: 2px;
  transition: background 120ms ease;
}
.cs-tag-anyway:hover { background: #f0c274; }

/* ---------- per-mark rule reveal ---------- */
.cs-rulebtn, .cs-dropbtn {
  flex: none; font-family: inherit; font-size: 12px; color: #8b8678;
  background: rgba(255,255,255,.03); border: 1px solid #33333d; border-radius: 6px;
  padding: 5px 9px; cursor: pointer; white-space: nowrap;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.cs-rulebtn:hover, .cs-dropbtn:hover { background: rgba(201,162,75,.08); color: #ecd9a0; border-color: #c9a24b55; }
.cs-rulebtn.on, .cs-dropbtn.on { color: #1a1a20; background: #c9a24b; border-color: #c9a24b; font-weight: 600; }
.cs-rulebtn.active:not(.on) { color: #d9c48a; border-color: #c9a24b55; }
.cs-rule-flag { color: #c9a24b; }
.cs-inbox-flag { color: #9bbf7c; }

.cs-rowgroup { display: flex; flex-direction: column; }
.cs-rule-wrap { animation: fadeIn 140ms ease; }
.cs-rule {
  margin: 3px 0 6px 8px;
  background: #131319; border: 1px solid #2e2e36; border-left: 2px solid #c9a24b77; border-radius: 8px;
  padding: 11px 12px; display: flex; flex-direction: column; gap: 10px;
}
.cs-rule-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.cs-field { display: flex; flex-direction: column; gap: 6px; }
.cs-field.cs-row-inline { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; }
.cs-typefilter, .cs-kw-add {
  width: 100%; font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px; padding: 7px 9px; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.cs-typefilter::placeholder, .cs-kw-add::placeholder { color: #6b675e; }
.cs-typefilter:focus, .cs-kw-add:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.cs-kw {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-size: 12px; color: #b9a06a; background: rgba(201,162,75,.09);
  border: 1px solid rgba(201,162,75,.28); border-radius: 999px; padding: 3px 9px;
}
.cs-kw-x { border: 0; background: transparent; color: inherit; opacity: .7; font-size: 11px; cursor: pointer; padding: 0 0 0 2px; }
.cs-kw-x:hover { opacity: 1; color: #e0b0b0; }

.cs-rule-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cs-preview { font-size: 12px; color: #d9c48a; }
.cs-preview.muted { color: #6f6a5e; font-style: italic; }
.cs-preview.hit { color: #9bbf7c; }
.cs-unload {
  flex: none; font-family: inherit; font-size: 12.5px; letter-spacing: .3px;
  color: #d9c48a; background: rgba(201,162,75,.08);
  border: 1px solid #c9a24b77; border-radius: 7px; padding: 7px 13px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.cs-unload:hover:not(:disabled) { background: rgba(201,162,75,.16); color: #ecd9a0; border-color: #c9a24b; }
.cs-unload:active:not(:disabled) { transform: translateY(1px); }
.cs-unload:disabled, .cs-unload.disabled { color: #6f6a5e; border-color: #33333d; background: transparent; cursor: not-allowed; }

/* ---------- Drop-box card ---------- */
.cs-inbox { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 9px; }
.cs-inbox-name { font-size: 13.5px; color: #ece7db; font-weight: 600; }
.cs-empty {
  font-size: 12.5px; color: #6f6a5e; line-height: 1.5;
  background: rgba(255,255,255,.02); border: 1px dashed #33333d; border-radius: 7px;
  padding: 10px 12px; margin-bottom: 9px;
}
.cs-mini {
  flex: none; font-family: inherit; font-size: 11.5px; color: #8b8678;
  background: transparent; border: 1px solid #33333d; border-radius: 5px; padding: 4px 9px; cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease; margin-left: 6px;
}
.cs-mini:hover { color: #ecd9a0; border-color: #c9a24b55; background: rgba(201,162,75,.06); }
.cs-sort-now {
  width: 100%; font-family: inherit; font-size: 13px; letter-spacing: .3px;
  color: #1a1a20; background: #c9a24b; border: 1px solid #c9a24b; border-radius: 8px;
  padding: 11px 12px; cursor: pointer; font-weight: 600;
  transition: background 120ms ease, transform 100ms ease;
}
.cs-sort-now:hover:not(:disabled) { background: #d9b45c; }
.cs-sort-now:active:not(:disabled) { transform: translateY(1px); }
.cs-sort-now:disabled, .cs-sort-now.disabled {
  color: #6f6a5e; background: transparent; border-color: #33333d; cursor: not-allowed; font-weight: 400;
}

/* pin routing */
.cs-pins { margin-top: 11px; padding-top: 10px; border-top: 1px solid #26262d; }
.cs-pin {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-size: 12px; color: #cdc7b8; background: #12121a;
  border: 1px solid #3a3a44; border-radius: 999px; padding: 4px 11px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cs-pin.broken { color: #e0b0b0; border-color: #a5556588; }
.cs-pinpick { margin-top: 8px; }
.cs-pinpick-row { display: flex; gap: 8px; align-items: center; }
.cs-select {
  flex: none; min-width: 130px; font-family: inherit; font-size: 12.5px; color: #b9b4a8;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px; padding: 7px 8px; cursor: pointer; outline: none;
}
.cs-select:focus { border-color: #c9a24b77; }

/* ---------- csPicker: the typable combobox that replaced every <select> ----
   ⛔ Ultralight RENDERS a native <select> but never OPENS it, so all four of
   this pane's selects were dead in game. The trigger looks like the old field;
   the body opens INLINE below it (never absolutely positioned) so it cannot
   hang outside the scrolling card it lives in. Reuses .cs-cand-list/.cs-cand
   for the rows, so the list already scrolls and has a scrollbar. */
.cs-pick { flex: 1 1 auto; min-width: 150px; display: flex; flex-direction: column; gap: 6px; }
.cs-pick.cs-pick-wide { min-width: 180px; }
.cs-pick-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px;
  font-family: inherit; font-size: 12.5px; text-align: left; color: #b9b4a8;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px;
  padding: 7px 10px; cursor: pointer; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease, color 140ms ease;
}
.cs-pick-btn:hover { color: #ece7db; border-color: #c9a24b55; }
.cs-pick-btn:focus-visible { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.cs-pick-btn.open { border-color: #c9a24b77; color: #ece7db; }
.cs-pick-cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-pick-cur.none { color: #6b675e; }
.cs-pick-caret { flex: none; font-size: 11px; color: #6f6a5e; }
.cs-pick-btn.open .cs-pick-caret { color: #c9a24b; }
.cs-pick-body { display: flex; flex-direction: column; gap: 0; }
.cs-pick-body.hidden { display: none; }
.cs-pick-in {
  width: 100%; font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #c9a24b77; border-radius: 6px; padding: 7px 9px; outline: none;
}
.cs-pick-in::placeholder { color: #6b675e; }
.cs-pick-list { max-height: 200px; }
.cs-cand.hi { background: rgba(201,162,75,.10); color: #ece7db; border-color: #c9a24b44; }
/* A picker grows downward, so its label must sit at the TOP of the row —
   centred, it slides to the middle of the open list and reads as unrelated. */
.ct-ctx-field.pick { align-items: flex-start; }
.ct-ctx-field.pick > .ct-ctx-lbl { padding-top: 10px; }
.cs-cand-list { margin-top: 6px; max-height: 210px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.cs-cand-list::-webkit-scrollbar { width: 10px; }
.cs-cand-list::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
.cs-cand {
  display: flex; align-items: center; gap: 8px; width: 100%;
  font-family: inherit; font-size: 12.5px; text-align: left; color: #b9b4a8;
  background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 7px 9px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.cs-cand:hover { background: rgba(201,162,75,.08); color: #ece7db; border-color: #c9a24b44; }
.cs-cand.cur { color: #d9c48a; }
.cs-cand-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-cand-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.cs-cand-plug { flex: none; font-size: 11px; color: #6f6a5e; }
.cs-cand-plug.warn { color: #e0b060; }
.cs-cand-empty { padding: 10px; font-size: 12px; color: #6f6a5e; text-align: center; }

/* distribution summary */
.cs-result {
  margin-top: 11px; padding: 10px 11px; border-radius: 7px;
  background: rgba(255,255,255,.02); border: 1px solid #26262d;
}
.cs-result-head { font-size: 12.5px; color: #d9c48a; margin-bottom: 6px; font-weight: 600; }
.cs-result-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; color: #cdc7b8; padding: 2px 0; }
.cs-result-to { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-result-n { flex: none; font-family: Consolas, "Courier New", monospace; color: #9bbf7c; }
.cs-result-residue { font-size: 12px; color: #b9a06a; margin-top: 4px; }
.cs-result-skip { font-size: 12px; color: #e0b0b0; margin-top: 3px; }

/* ---------- Auto-Loot card ---------- */
.al-master {
  flex: 1 1 auto; min-width: 200px;
  font-family: inherit; font-size: 13px; letter-spacing: .3px;
  color: #b9b4a8; background: #12121a; border: 1px solid #3a3a44; border-radius: 8px;
  padding: 10px 14px; cursor: pointer; text-align: center;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 100ms ease;
}
.al-master:hover { background: rgba(201,162,75,.08); color: #ece7db; border-color: #c9a24b55; }
.al-master:active { transform: translateY(1px); }
.al-master.on { color: #10160b; background: #9bbf7c; border-color: #9bbf7c; font-weight: 600; }
.al-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 9px; }
.al-cats-row { align-items: flex-start; }
.al-note { flex: none; font-size: 12px; color: #6f6a5e; letter-spacing: .3px; }
.al-warn {
  margin-top: 7px; font-size: 12px; color: #e0b060;
  background: rgba(200,140,50,.08); border: 1px solid rgba(200,140,50,.34); border-radius: 6px; padding: 7px 10px;
}
.al-seg { display: inline-flex; gap: 0; border: 1px solid #3a3a44; border-radius: 8px; overflow: hidden; }
.al-seg-btn {
  font-family: inherit; font-size: 12.5px; color: #b9b4a8; background: #12121a;
  border: 0; border-right: 1px solid #3a3a44; padding: 7px 14px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.al-seg-btn:last-child { border-right: 0; }
.al-seg-btn:hover { background: rgba(201,162,75,.08); color: #ece7db; }
.al-seg-btn.on { color: #1a1a20; background: #c9a24b; font-weight: 600; }
.al-cats { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; min-width: 0; }
.al-scan {
  flex: none; font-family: inherit; font-size: 12.5px; letter-spacing: .3px;
  color: #d9c48a; background: rgba(201,162,75,.08);
  border: 1px solid #c9a24b77; border-radius: 7px; padding: 8px 14px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.al-scan:hover { background: rgba(201,162,75,.16); color: #ecd9a0; border-color: #c9a24b; }
.al-scan:active { transform: translateY(1px); }
.al-live { margin-top: 9px; font-size: 12px; color: #6f6a5e; letter-spacing: .3px; }

/* ⚠ `.al-bind`, the whole option filter (`.al-find*`, `.al-nomatch`) and the
   places heading `.al-rule-t` are NOT here — they live in the own-sheet
   `containers-autoloot.css`, which the deck loads directly.

   This fragment is not a stylesheet the game reads: it has to be hand-merged
   into app.css, and that step was missed on 2026-08-17, so those rules shipped
   to nobody and the filter's <input>/<button> painted as bare white boxes in
   Ultralight (Rober, 2026-08-18). Put NEW Auto-Loot rules in that own sheet
   too, not here — it cannot be dropped by a missed merge. */

/* ---------- per-item rules (deny / allow), 2026-08-16 ---------- */
.al-rules { margin-top: 14px; padding-top: 13px; border-top: 1px solid #2a2620; }
.al-rules-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.al-rules-order {
  font-size: 12px; color: #6f6a5e; letter-spacing: .3px;
}
.al-rule-cols { display: flex; gap: 12px; margin-top: 10px; flex-wrap: wrap; }

.al-rule-side {
  flex: 1 1 300px; min-width: 0;
  padding: 12px 13px;
  border-radius: 9px;
  background: rgba(255,255,255,.02);
  border: 1px solid #2a2620;
}
/* the two sides read as opposites at a glance, not by label alone */
.al-rule-side.deny  { border-color: #6b3a3a77; }
.al-rule-side.allow { border-color: #c9a24b55; }

.al-rule-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.al-rule-title { font-size: 14px; letter-spacing: .3px; color: #d8d2c4; }
.al-rule-side.deny  .al-rule-title { color: #d99a9a; }
.al-rule-side.allow .al-rule-title { color: #e0c682; }
.al-rule-n { font-size: 12px; color: #6f6a5e; white-space: nowrap; }
.al-rule-sub { margin-top: 3px; font-size: 12px; color: #7d7768; line-height: 1.4; }

.al-rule-rows { margin-top: 9px; display: flex; flex-direction: column; gap: 5px; max-height: 210px; overflow-y: auto; }
.al-rule-empty { font-size: 12px; color: #6f6a5e; line-height: 1.45; padding: 4px 0; }

.al-rule-row {
  display: flex; align-items: center; gap: 9px;
  padding: 6px 9px; border-radius: 7px;
  background: rgba(0,0,0,.22); border: 1px solid #26221c;
}
.al-rule-row.word { border-style: dashed; }
.al-rule-name {
  flex: 1 1 auto; min-width: 0; font-size: 13px; color: #ded7c7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.al-rule-src {
  flex: 0 1 auto; max-width: 42%;
  font-size: 11.5px; color: #6f6a5e;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.al-rule-x {
  flex: none; font-family: inherit; font-size: 12px; line-height: 1;
  color: #8a8274; background: transparent; border: 0; cursor: pointer;
  padding: 3px 5px; border-radius: 5px;
  transition: color 120ms ease, background 120ms ease;
}
.al-rule-x:hover { color: #e6b3b3; background: rgba(180,80,80,.14); }

.al-rule-add { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.al-rule-find {
  flex: none; font-family: inherit; font-size: 12.5px;
  color: #d9c48a; background: rgba(201,162,75,.08);
  border: 1px solid #c9a24b77; border-radius: 7px; padding: 7px 12px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.al-rule-find:hover { background: rgba(201,162,75,.16); color: #ecd9a0; border-color: #c9a24b; }
.al-rule-find:active { transform: translateY(1px); }
.al-rule-word-in {
  flex: 1 1 130px; min-width: 0;
  font-family: inherit; font-size: 12.5px; color: #ded7c7;
  background: rgba(0,0,0,.3); border: 1px solid #2f2a22; border-radius: 7px;
  padding: 7px 10px; outline: none;
  transition: border-color 120ms ease;
}
.al-rule-word-in::placeholder { color: #635e54; }
.al-rule-word-in:focus { border-color: #c9a24b88; }

/* exclusive mode — loud when armed, because it silences the categories above */
.al-only-row { margin-top: 12px; align-items: center; gap: 10px; flex-wrap: wrap; }
.al-only-row.armed {
  padding: 8px 10px; border-radius: 8px;
  background: rgba(201,162,75,.07); border: 1px solid #c9a24b55;
}
.al-only-note { font-size: 12px; color: #7d7768; }
.al-only-row.armed .al-only-note { color: #d9c48a; }

.al-weight-row { margin-top: 10px; align-items: center; gap: 9px; flex-wrap: wrap; }
.al-weight-lbl { font-size: 12.5px; color: #7d7768; }
.al-weight-live { font-size: 12px; color: #e0a86a; letter-spacing: .3px; }

/* per-category gold floor popover (right-click a category chip) */
.al-floor-pop {
  margin-top: 10px; padding: 12px 13px;
  border-radius: 9px; background: #16130f; border: 1px solid #3a332a;
  box-shadow: 0 10px 26px rgba(0,0,0,.5);
  display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
}
.al-floor-t { font-size: 13.5px; color: #ded7c7; }
.al-floor-s { font-size: 12px; color: #7d7768; }
.al-floor-btns { display: flex; gap: 8px; }
.al-floor-ok, .al-floor-cancel {
  font-family: inherit; font-size: 12.5px; padding: 7px 14px;
  border-radius: 7px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.al-floor-ok {
  color: #d9c48a; background: rgba(201,162,75,.1); border: 1px solid #c9a24b77;
}
.al-floor-ok:hover { background: rgba(201,162,75,.2); color: #ecd9a0; }
.al-floor-cancel {
  color: #8a8274; background: transparent; border: 1px solid #2f2a22;
}
.al-floor-cancel:hover { color: #ded7c7; border-color: #4a4238; }

/* Finder-backed pin route row (auto-sort) */
.cs-pinroute { display: flex; align-items: center; gap: 9px; margin-top: 9px; flex-wrap: wrap; }

/* ---------- narrow (deck 640px floor) ---------- */
@media (max-width: 620px) {
  #al-card { padding: 0 10px 10px; }
  /* one column: side-by-side deny/allow squeezes both names to nothing */
  .al-rule-cols { flex-direction: column; }
  .al-rule-side { flex: 1 1 auto; }
  .al-rule-src { max-width: 34%; }
  .al-rules-order { width: 100%; }
  .cs-card, .al-inner { padding: 10px 11px; }
  .cs-step-val { width: 52px; }
  .cs-grp-lbl { width: 100%; }
  .al-master { min-width: 0; }
  .al-seg-btn { padding: 7px 10px; max-width: 150px; }
  .cs-safe-why { max-width: 120px; }
  .cs-rulebtn, .cs-dropbtn { padding: 5px 7px; }
}

/* ==================== Containers: two pages + Auto-Loot polish (v3, 2026-08-16) ====================
   THE OVERLAP BUG THIS FIXES. #ct-pane used to stack the container roster and
   the Auto-Loot card in one flex column. #ct-main has no overflow of its own and
   its children carry hard minimums (#cs-cards ~290px + #ct-toolbar 48px +
   #ct-list's `min-height:74px` floor + #ct-foot ~50px + padding ~= 484px), so
   once Auto-Loot grew past ~700px the roster no longer fit in what was left and
   its content OVERFLOWED #ct-body, painting on top of the card below — the
   containers search bar landing inside the Auto-Loot header.
   Fix is structural: two mutually exclusive full-height pages, so neither can
   squeeze the other. Plus `#ct-main { overflow: hidden }` below, which kills the
   whole CLASS of bug regardless of what lands in that column later. */

/* ---------- page switch ---------- */
#ct-modes {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 11px 14px 0;
}
.ct-mode {
  display: inline-flex; align-items: center; gap: 9px;
  font-family: inherit; font-size: 14px; letter-spacing: .3px;
  color: #b9b4a8; background: #14141b;
  border: 1px solid #2e2e36; border-radius: 9px;
  padding: 9px 15px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 100ms ease;
}
.ct-mode:hover { background: rgba(201,162,75,.08); color: #ece7db; border-color: #c9a24b55; }
.ct-mode:active { transform: translateY(1px); }
.ct-mode:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 2px; }
.ct-mode.on { color: #1a1a20; background: #c9a24b; border-color: #c9a24b; font-weight: 600; }
/* The switch glyphs are our own gold linework, not emoji (UI rule, 2026-08-16).
   Size is load-bearing, not taste: Ultralight rasterises an <img> at its LAYOUT
   size, so a 15px icon is ~15 real pixels of art and thin gold strokes collapse
   to grey mush — the same trap the Faith card paid for with 38px marks. 26px is
   where these two glyphs start reading (measured against the shipped set at
   16/20/26/40). The span keeps a font-size so the ◆ fallback, which replaces the
   <img> if the file is ever missing, is legible on its own. */
.ct-mode-ic { font-size: 15px; line-height: 1; flex: none; display: inline-flex;
              align-items: center; justify-content: center; width: 26px; height: 26px; }
.ct-mode-ic img { width: 26px; height: 26px; display: block; }
/* The ACTIVE page is a solid gold plate, and these glyphs are gold — so the icon
   would sit gold-on-gold and disappear. Fixed with a dark disc behind it, which
   is the same device .ct-mode.on .ct-mode-n already uses for its pill, and NOT
   with a CSS filter: filter support is unproven under Ultralight, and a filter
   that silently no-ops would leave the active tab's icon invisible. */
.ct-mode.on .ct-mode-ic { background: rgba(0,0,0,.26); border-radius: 999px; }
.ct-mode-lbl { white-space: nowrap; }
/* count / state pill riding the switch, so "is Auto-Loot running?" is answerable
   without opening the page at all */
.ct-mode-n, .ct-mode-state {
  flex: none; font-size: 12px; letter-spacing: .3px; font-weight: 600;
  padding: 2px 8px; border-radius: 999px;
  background: #0e0e14; color: #8d8778; border: 1px solid #2e2e36;
}
.ct-mode.on .ct-mode-n, .ct-mode.on .ct-mode-state { background: rgba(0,0,0,.22); color: #33291a; border-color: transparent; }
.ct-mode-state.live { background: #9bbf7c; color: #10160b; border-color: #9bbf7c; }
.ct-mode.on .ct-mode-state.live { background: #1f3312; color: #b6dd97; border-color: transparent; }

/* ---------- the two pages ---------- */
#ct-pane.al-page #ct-body { display: none; }
#ct-pane:not(.al-page) #al-card { display: none; }
/* HARDENING: the roster column may never spill out of #ct-body again. */
#ct-main { overflow: hidden; }

/* Auto-Loot is now a full-height page that scrolls itself. */
#al-card {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  padding: 12px 16px 18px;
}
#al-card::-webkit-scrollbar { width: 10px; }
#al-card::-webkit-scrollbar-track { background: transparent; }
#al-card::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
#al-card::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
/* the page owns the padding now — the inner wrapper stops being a bordered card */
#ct-pane.al-page .al-inner {
  background: transparent; border: 0; border-radius: 0;
  padding: 0; margin: 0;
}

/* ---------- hero: title · master · one-shot ---------- */
.al-hero {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 4px 0 14px;
}
.al-hero .al-title { font-size: 17px; letter-spacing: .4px; }
.al-hero-sub { flex: 1 1 220px; min-width: 0; font-size: 13px; color: #7d7768; letter-spacing: .3px; }
#ct-pane.al-page .al-master {
  font-size: 14px; padding: 11px 20px; border-radius: 9px; min-width: 250px;
}
#ct-pane.al-page .al-scan { font-size: 13.5px; padding: 11px 17px; }

/* ---------- sections ---------- */
.al-sec {
  background: #16161d; border: 1px solid #2e2e36; border-radius: 10px;
  padding: 13px 15px 15px; margin-bottom: 12px;
  animation: fadeIn 140ms ease;
}
.al-sec-h {
  display: flex; align-items: baseline; gap: 11px; flex-wrap: wrap;
  margin-bottom: 3px;
}
.al-sec-t {
  font-size: 12px; letter-spacing: 1.1px; text-transform: uppercase;
  color: #8d8778; font-weight: 600;
}
.al-sec-s { font-size: 12.5px; color: #6f6a5e; letter-spacing: .3px; }
/* two sections side by side once there is room — his "use the screen space" rule */
.al-grid { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.al-grid > .al-sec { flex: 1 1 380px; min-width: 0; margin-bottom: 0; }
.al-grid { margin-bottom: 12px; }

/* nothing under 13px on this page (the no-small-text rule) */
#ct-pane.al-page .al-lbl,
#ct-pane.al-page .cs-lbl { font-size: 13.5px; color: #c2bcae; }
#ct-pane.al-page .al-note,
#ct-pane.al-page .al-readout,
#ct-pane.al-page .al-weight-lbl { font-size: 13px; color: #8d8778; }
#ct-pane.al-page .cs-chip { font-size: 13px; padding: 8px 13px; }
#ct-pane.al-page .al-seg-btn { font-size: 13.5px; padding: 9px 17px; }
#ct-pane.al-page .al-live { font-size: 13px; }
#ct-pane.al-page .al-rules-order { font-size: 12.5px; }

/* the pick-up grid gets room to breathe rather than wrapping tight to a label */
.al-cats-row { align-items: flex-start; }
#ct-pane.al-page .al-cats { gap: 8px; }

/* colour law, stated so it stays consistent:
   GREEN  = loot is flowing (master on, a category will be taken)
   GOLD   = an option is enabled (safety guards, toasts, modes)
   Both already existed; this comment is what keeps them from drifting. */

/* ---------- narrow (deck 640px floor) ---------- */
@media (max-width: 620px) {
  #ct-modes { padding: 9px 10px 0; gap: 6px; }
  .ct-mode { padding: 8px 11px; font-size: 13.5px; gap: 7px; }
  .ct-mode-ic { font-size: 14px; width: 22px; height: 22px; }
  .ct-mode-ic img { width: 22px; height: 22px; }
  #al-card { padding: 10px 11px 14px; }
  .al-sec { padding: 11px 12px 13px; }
  .al-grid > .al-sec { flex: 1 1 100%; }
  #ct-pane.al-page .al-master { min-width: 0; width: 100%; }
  .al-hero { gap: 10px; }
}

/* .al-rules is now an .al-sec too (it was a bare block with its own top rule).
   Neutralise the old separator so the section doesn't draw a line inside its
   own border. */
.al-sec.al-rules { margin-top: 0; border-top: 0; padding-top: 13px; }
.al-rule-cols { margin-top: 10px; }
.al-only-row { margin-top: 12px; }

/* No token under 12px anywhere in the Containers tab (standing UI rule). */
.ct-rail-count { font-size: 12px; }
#ct-count { font-size: 12px; }
.cs-mini { font-size: 12px; }
.ct-scale-lbl, .ct-scale-val, .ct-scale-reset { font-size: 12px; }
@media (max-width: 620px) { .ct-scale-lbl { font-size: 12px; } }
.ct-medal, .ct-icon-btn, #ct-here, .ct-ok-hint, .ct-ok-label { font-size: 12px; }
.al-rule-src { font-size: 12px; }
/* Added 2026-08-17. These two are the only tokens the Ultralight probe still
   caught rendering under 12px (.ct-chev at 10, .ct-sub at 11) — the block above
   was written from the stylesheet and missed them, which is the difference
   between auditing the CSS and measuring what the engine drew. */
.ct-chev { font-size: 12px; }
.ct-sub { font-size: 12px; }

/* ---------- when it may run + reach shaping (adopted from SmartHarvestSE, 2026-08-17) ----
   The reach shapers are stacked rows under Range, so "how far" reads as one
   idea; the town guard is a segment because its four states are an ORDER
   (smallest place refused, and everything larger with it), not four switches. */
.al-reach-shape { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.al-reach-shape .al-only-note { flex: 1 1 200px; min-width: 0; }
.al-seg-towns { flex: none; }

/* ---------- museum rule (LOTD, Auto-Loot "What it picks up", 2026-08-17) ------
   Laid out like .al-only-row on purpose: same label + control + plain-English
   note shape, so the two exclusive modes in this card read as one idea. The
   `off` state greys the segment rather than hiding it, because "you do not have
   the museum installed" is a more useful answer than a control that vanished. */
.al-museum-row,
.al-harvest-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.al-harvest-row.armed { border-color: #c9a24b55; }
.al-harvest-row .al-only-note { flex: 1 1 260px; min-width: 0; }
.al-museum-row.armed { border-color: #c9a24b55; }
.al-museum-row .al-seg.off { opacity: .45; pointer-events: none; }
.al-museum-row .al-only-note { flex: 1 1 260px; min-width: 0; }

/* ---------- place rules (Auto-Loot "Where it won't run", 2026-08-16) ---------- */
.al-sec-foot { margin-top: 11px; font-size: 12px; color: #6f6a5e; letter-spacing: .3px; }
.al-places .al-rule-side.allow { border-color: #3a4a2e55; }

/* ---------- crafting loan + retrieve + child type chips (2026-08-17) ----------
   The taxonomy split gave the type picker parent/child tokens ("Two-handed"
   under "Weapons"); a child reads as a narrower choice, not a different kind of
   control, so it is the same chip one step quieter and inset. */
.cs-chip-child { margin-left: 14px; opacity: .92; }
.cs-chip-child::before {
  content: '·'; color: #6f6a5e; margin-right: 6px;
}
.cs-chip-child.on { opacity: 1; }

#cs-loan-card .cs-card-title { color: #d9c48a; }
.cs-loan-grid { gap: 8px; margin-top: 6px; }
.cs-loan-master { font-weight: 600; }
/* The master switch reads its state from a colour, like the auto-loot hero:
   amber-on-dark when it is doing something, plain when it is not. */
.cs-loan-master.on { background: #2b2416; border-color: #6b5a2e; color: #f0dda6; }
#cs-loan-card .cs-empty { margin-top: 10px; }
#cs-loan-card .cs-hint { margin-top: 10px; }

/* The Ultralight probe caught this one on 2026-08-17: the ✕ on a pin/keyword
   chip rasterised at 11px, under the standing 12px floor. Measured, not read
   off the stylesheet — which is why it survived the earlier sweep. */
.cs-kw-x { font-size: 12px; }

/* ---------- parity pass: gather presets + override editor (2026-08-17) ---------- */
.cs-gather { gap: 8px; margin-top: 6px; }
.cs-gather .cs-mini { padding: 7px 11px; }
.cs-ov-edit { margin-top: 10px; }
.cs-ov-edit .cs-card-title { font-size: 14px; }

/* ---------- the cards column has to scroll now (2026-08-17) ----------
   The parity pass (Put it all away + Gather presets + the override editor +
   the crafting-loan card) pushed #cs-cards past the height of the pane. The
   2026-08-16 hardening — #ct-main { overflow: hidden } — kept it from PAINTING
   over the roster, which is why nothing looked broken, but the Ultralight probe
   showed what it really cost: the toolbar, the whole roster and the "Save types"
   button were simply cut off the bottom, unreachable. So the column that grows
   gets its own scroll and a ceiling, exactly as #al-card does on the other page,
   and the roster keeps its half of the pane whatever lands in the cards later.

   ⚠ 52% did NOT leave the roster half the pane, because #ct-toolbar (33px),
   #ct-foot (64px) and their margins come out of the OTHER 48% — measured
   2026-08-19 at 6.2 rows of 220 at 2560x1440 and 2.3 rows at 1280x720. The cap
   is a percentage of #ct-main's CONTENT box, so it must be set below half for
   the roster to reach half. 40% + the #ct-list floor below gives 8.4 rows and
   3.3 rows respectively. The card is a scroller and was already scrolling; the
   roster was not, which is why the roster wins the argument. */
#cs-cards {
  flex: 0 1 auto; max-height: 40%; overflow-y: auto; overflow-x: hidden;
  padding-right: 4px;
}
#cs-cards::-webkit-scrollbar { width: 10px; }
#cs-cards::-webkit-scrollbar-track { background: transparent; }
#cs-cards::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 6px; }
#cs-cards::-webkit-scrollbar-thumb:hover { background: #3c3c46; }

/* Measured at 11.5px by the probe — under the standing 12px floor. */
.cs-grp-lbl { font-size: 12px; }

/* ==================== couch-distance pass (2026-08-19) ====================
   Rober plays at 2560x1440 from a sofa. Everything below fixes something that
   was MEASURED wrong on that screen, not something that looked wrong. */

/* ---- hit-target floor ----
   Nine visible button classes sat under ~30px, the smallest at 11x14 — and the
   two smallest are the DELETE affordances: .cs-kw-x removes a rule keyword, a
   pin route or a type override; .al-rule-x removes an auto-loot rule. The box
   is set on the BUTTON and the chip that hosts it gives back the padding the
   button now supplies, so a chip row does not grow taller than the button. */
.cs-kw-x, .al-rule-x, .ct-icon-btn, .ct-go {
  min-width: 30px; min-height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
}
.cs-kw { padding: 0 3px 0 11px; }
.cs-pin { padding: 0 3px 0 11px; }
.al-rule-x { padding: 0; }
.cs-step-btn { width: 32px; height: 32px; }
button.ct-rail-rename { min-width: 32px; min-height: 30px; padding: 5px 4px; }
.cs-mini, .cs-rulebtn, .cs-dropbtn, .cs-tag-anyway, .cs-chip, .cs-unload, .al-rule-find {
  min-height: 30px;
}
/* .cs-mini and .cs-tag-anyway are text buttons; centre the label now that the
   box is taller than the line. */
.cs-mini, .cs-tag-anyway { display: inline-flex; align-items: center; justify-content: center; }

/* ---- the only scroller in the pane with no scrollbar ----
   .al-rule-rows shows 5 of up to 26 rows and ended flush against the "＋ Find
   an item…" row with nothing saying more existed. Every sibling scroller here
   (#ct-list, #ct-rail, .ct-ctx-scroll, .ct-pick-list, .ct-npc-list,
   .cs-cand-list, #al-card, #cs-cards) already carries this block. */
.al-rule-rows::-webkit-scrollbar { width: 10px; }
.al-rule-rows::-webkit-scrollbar-track { background: transparent; }
.al-rule-rows::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
.al-rule-rows::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
/* Rows are taller now that the ✕ is a real target; keep ~5 of them visible. */
.al-rule-rows { max-height: 260px; }

/* ---- filter-as-you-type on the four auto-loot rule lists ----
   43 rules and 20 places in a fixed scroller with only an ADD field meant
   removing one entry was a blind scroll. Sized like .cs-typefilter so the two
   read as the same control. */
.al-rule-filter {
  width: 100%; margin-top: 9px; font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px; padding: 8px 10px;
  outline: none; min-height: 32px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.al-rule-filter::placeholder { color: #6b675e; }
.al-rule-filter:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.al-rule-name mark { background: transparent; color: #c9a24b; font-weight: 600; }

/* ---- rail filter (31 categories had none) ----
   The rail itself stops scrolling; #ct-rail-list does instead, so the filter
   box and ＋ Category stay pinned while the categories move under them. */
#ct-rail { overflow: hidden; }
#ct-rail-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 2px; }
#ct-rail-list::-webkit-scrollbar { width: 8px; }
#ct-rail-list::-webkit-scrollbar-track { background: transparent; }
#ct-rail-list::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 4px; }
#ct-rail-list::-webkit-scrollbar-thumb:hover { background: #3d3d47; }
.ct-rail-filter {
  flex: none; width: 100%; font-family: inherit; font-size: 12.5px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 6px;
  padding: 7px 9px; min-height: 32px; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ct-rail-filter::placeholder { color: #6b675e; }
.ct-rail-filter:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.ct-rail-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.ct-rail-none { font-size: 12px; color: #6f6a5e; padding: 8px 9px; line-height: 1.4; }

/* ---- the selected category had no style at all ----
   renderRail() marks the current category `.ct-rail-item.active`, but only
   `.sel` was ever styled — so which category you were in was invisible, and
   the rail filter's Enter (which selects the top hit) had no visible effect.
   Same paint as .sel; kept here rather than merged into the rule above so the
   pairing is documented where it was found. */
.ct-rail-item.active {
  background: linear-gradient(90deg, rgba(201,162,75,.10), transparent);
  border-color: #c9a24b77; color: #ecd9a0;
}
.ct-rail-item.active .ct-rail-count { color: #d9c48a; background: rgba(201,162,75,.10); }

/* ---- #cs-cards' bottom edge ----
   Two scrollers stack in this column, so the card's last visible row is often
   sliced mid-control. A hairline says "this panel ends here, scroll it" instead
   of the cut reading as a broken row. */
#cs-cards { border-bottom: 1px solid #26262d; padding-bottom: 6px; margin-bottom: 8px; }

/* ---- rows that now host a csPicker ----
   A picker grows downward when it opens, so a row that centres its children
   drags the label and the neighbouring button to the middle of the open list.
   Top-align them; the small padding keeps the label on the trigger's baseline
   while the picker is closed. */
.cs-pinroute, .cs-field.cs-row-inline { align-items: flex-start; }
.cs-pinroute > .cs-hint, .cs-field.cs-row-inline > .cs-hint,
.cs-field.cs-row-inline > .cs-field-lbl { padding-top: 9px; }
.cs-pinroute > .cs-mini { margin-top: 1px; }
