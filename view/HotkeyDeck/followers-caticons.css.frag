/* ===================================================================== *
 *  Followers rail — PER-CATEGORY ICONS + the icon picker overlay.
 *
 *  ⚠ THE GAME LOADS THE ASSEMBLED app.css. Deploying this .frag on its own
 *  changes NOTHING in-game — the identical block must also live in
 *  view/HotkeyDeck/app.css between its own banner and the next one
 *  ([[deck-view-css-frag-merge]]). This file is the source of truth for the
 *  block; app.css is what ships.
 *
 *  Additions only: no existing rule is edited, no token is redefined. Colours
 *  are the deck's own literals (#c9a24b gold, #0c0c10 well, #2e2e36 hairline)
 *  and the sizes ride --fd-railic-px, which followers-pane.js ramps off the
 *  avatar slider alongside --fd-rail-fs.
 * ===================================================================== */

/* ---- the rail slot ----
   Fixed square so every name in the rail starts on the same vertical line
   whether or not its category has a glyph. followers-pane.js only emits the
   slot when it is needed (icon set, edit mode, or the rail is MIXED), so a
   rail nobody has decorated is byte-for-byte the pre-icons layout. */
.fd-rail-item .fd-rail-ic {
  flex-shrink: 0;
  width: var(--fd-railic-px, 20px);
  height: var(--fd-railic-px, 20px);
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px;
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease;
}
.fd-rail-item .fd-rail-ic-img {
  width: 100%; height: 100%;
  object-fit: contain;
  display: block;
  pointer-events: none;          /* the ROW owns the click; the glyph never competes */
  /* Gold, to match the rail's own accent and Rober's mock, without needing a
     second copy of every PNG. The library art is a light monochrome glyph, so
     a hue-rotate off a sepia base lands on the deck's #c9a24b family. */
  filter: sepia(1) saturate(2.2) hue-rotate(-12deg) brightness(.95);
  opacity: .82;
  transition: opacity .12s ease, filter .12s ease;
}
.fd-rail-item:hover .fd-rail-ic-img,
.fd-rail-item.sel  .fd-rail-ic-img { opacity: 1; filter: sepia(1) saturate(2.6) hue-rotate(-12deg) brightness(1.12); }

/* An empty slot is invisible in view mode — it exists only to hold the column
   so names stay aligned when SOME categories carry a glyph. */
.fd-rail-item .fd-rail-ic.empty { background: none; border: 0; }

/* The rail widens by exactly the column the icons added, and only while they
   are in use (followers-pane.js toggles .caticons). Without this the fixed
   168px rail truncates its own labels the moment a glyph is set — "All
   followers" became "All follo…". 8px = the .fd-rail-item gap. */
#fd-rail.caticons { width: calc(168px + var(--fd-railic-px, 20px) + 8px); }

/* ---- edit mode: the slot IS the affordance ----
   Same idiom as the hotkey list's icon box: a dashed well that grows a ＋, so
   "you can put something here" needs no label in a 168px rail. */
.fd-rail-item.edit .fd-rail-ic.pick { cursor: pointer; }
.fd-rail-item .fd-rail-ic.pick.empty {
  border: 1px dashed #3a3a44;
  background: rgba(255,255,255,.02);
}
.fd-rail-item .fd-rail-ic.pick.empty::after {
  content: '＋';
  font-size: calc(var(--fd-railic-px, 20px) * .62);
  line-height: 1;
  color: #55523f;
  transition: color .12s ease;
}
.fd-rail-item .fd-rail-ic.pick:hover {
  border-color: #c9a24b;
  background: rgba(201,162,75,.08);
  box-shadow: 0 0 0 2px rgba(201,162,75,.10);
}
.fd-rail-item .fd-rail-ic.pick.empty:hover::after { color: #d9c48a; }
.fd-rail-item .fd-rail-ic.pick:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }
.fd-rail-item .fd-rail-ic.pick:active { transform: translateY(1px); }

/* ---- the picker ----
   Rides #fd-ctx-menu (position, chrome, drag handle, clamping all inherited);
   this only supplies the grid and the tiles. Mounted on #overlay by JS —
   #fol-pane is overflow:hidden and would CLIP it. */
.fd-catic-top {
  display: flex; align-items: center; justify-content: flex-end;
  padding: 0 14px 6px;
}
.fd-catic-hint { font-size: 12px; color: #6f6a5e; }

/* auto-fill, so the column count follows the menu width instead of a constant
   that would be wrong at eleven of the twelve avatar sizes. */
.fd-catic-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
  gap: 8px;
  padding: 0 14px 14px;
}
.fd-catic-tile {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 9px 6px 7px;
  background: #14141b;
  border: 1px solid #2e2e36;
  border-radius: 8px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease, transform .08s ease;
}
.fd-catic-tile img {
  width: 46px; height: 46px; object-fit: contain; display: block; pointer-events: none;
}
.fd-catic-tile .fd-catic-lbl {
  max-width: 100%;
  font-size: 11px; line-height: 1.25;
  color: #6f6a5e;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fd-catic-tile:hover { background: #1c1c24; border-color: #c9a24b77; }
.fd-catic-tile:hover .fd-catic-lbl { color: #b9b4a8; }
.fd-catic-tile:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }
.fd-catic-tile:active { transform: translateY(1px); }
.fd-catic-tile.on { border-color: #c9a24b; box-shadow: 0 0 0 2px rgba(201,162,75,.10); }
.fd-catic-tile.none { border-style: dashed; }
.fd-catic-x { font-size: 30px; line-height: 46px; height: 46px; color: #55523f; }
.fd-catic-tile.none:hover .fd-catic-x { color: #d9c48a; }
.fd-catic-more {
  grid-column: 1 / -1;
  padding: 9px 10px;
  font-size: 12.5px;
  color: #8b8678;
  background: #14141b;
  border: 1px dashed #3a3a44;
  border-radius: 8px;
  cursor: pointer;
  transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.fd-catic-more:hover { color: #ecd9a0; border-color: #c9a24b77; background: #1c1c24; }

/* The ⟳ beside the filter. Square, so it reads as a companion to the input
   rather than a second field. */
.fd-ctx-mini {
  flex-shrink: 0;
  width: 34px; height: 34px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 15px; line-height: 1;
  color: #8b8678;
  background: #14141b;
  border: 1px solid #3a3a44;
  border-radius: 6px;
  cursor: pointer;
  transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.fd-ctx-mini:hover { color: #ecd9a0; border-color: #c9a24b77; background: #1c1c24; }
.fd-ctx-mini:focus-visible { outline: 2px solid #c9a24b66; outline-offset: 1px; }
.fd-ctx-mini:active { transform: translateY(1px); }
/* The filter field in THIS menu is an input + a button, so the input must stop
   claiming the whole row (the generic rule gives .fd-ctx-filter width:100%). */
.fd-catic-menu .fd-ctx-field { display: flex; align-items: center; gap: 8px; }
.fd-catic-menu .fd-ctx-field > .fd-ctx-filter { flex: 1; width: auto; min-width: 0; }
