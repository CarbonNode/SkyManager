/* ===================================================================== *
 *  Wardrobe tab — outfit / wardrobe / NPC manager pane.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is wd- prefixed, no existing rule is touched and no token is
 *  redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease), and the
 *  shared @keyframes fadeIn · toastIn and the shared .ghost-btn /
 *  .empty-* classes are reused as-is. Good reads green (#86c98a),
 *  warning/missing reads red (#d98a8a).
 * ===================================================================== */

/* The pane is now just the CLIP BOX for #wd-scale — it keeps its place in the
   panel's flex column and nothing more. All the padding and the flex column
   moved inside, because an absolutely-positioned child is laid out against the
   padding box and would have ignored padding here.

   Rober: "i have no way of upscaling or resizing font like other windows".
   --wd-ui-scale (set on :root by the pane, persisted in the wardrobe slice)
   turns into transform: scale() on #wd-scale. transform does NOT reflow, so
   the box is sized 1/scale and the painted result lands back at exactly the
   pane's real size — the same contract #panel and #fol-pane already use. Sized
   with left/top/width/height rather than inset:0 because the two cannot both
   be honoured, and the divisor has to live on the size. */
#wd-pane { display: block; position: relative; min-height: 0; flex: 1; overflow: hidden; }
#wd-scale {
  position: absolute; left: 0; top: 0;
  width:  calc(100% / var(--wd-ui-scale, 1));
  height: calc(100% / var(--wd-ui-scale, 1));
  transform: scale(var(--wd-ui-scale, 1));
  transform-origin: top left;
  transition: transform 130ms ease;
  display: flex; flex-direction: column; min-height: 0;
  padding: 10px 14px 12px;
}

/* ---------- edit-mode chrome (whole-tab scale) ----------
   Literally the Followers tab's #fd-openkey-row rules, wd- prefixed: same
   metrics, same wrap behaviour, same shrink-the-hint rule, so the two tabs
   read as one product. */

#wd-editrow {
  flex: none;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; row-gap: 8px;
  background: #16161d;
  border: 1px solid #3a3a44;
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 9px;
  animation: fadeIn .14s ease;
}
.wd-ok-grp { display: inline-flex; align-items: center; gap: 10px; flex: none; }
.wd-ok-label { font-size: 12px; color: #b9b4a8; font-weight: 600; white-space: nowrap; }
/* prose next to controls, so it is the designated shrinker: one ellipsized
   line rather than three wrapped ones that triple the row */
.wd-ok-hint {
  font-size: 11px; color: #6f6a5e;
  flex: 1 1 0; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wd-ui-v {
  font-family: Consolas, "Courier New", monospace; font-size: 12px;
  color: #d3c191; min-width: 42px; text-align: center;
}

/* ---------- sub-tab nav ---------- */

/* WRAPS. Five sub-tabs fit on one line at every panel width at 1x, but the tab
   scale (60-160%) lays the row out in 1/scale px: at 160% in a 640px panel the
   last two ran 230px past the pane's edge, and #wd-pane clips — so they were
   not merely ugly, they were unreachable. Wrapping costs one extra line
   exactly when the row is genuinely full, and loses nothing. */
#wd-nav {
  flex: none; display: flex; flex-wrap: wrap; gap: 4px;
  /* 3px, not 0: every .wd-subtab carries margin-bottom:-1px for the underline
     trick, so a wrapped second row would sit 1px INSIDE the first. */
  row-gap: 3px;
  margin-bottom: 9px; border-bottom: 1px solid #2e2e36;
}
.wd-subtab {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: inherit; font-size: 14.5px; letter-spacing: .3px; color: #8b8678;
  background: transparent; border: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  padding: 7px 12px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease;
}
.wd-subtab:hover { color: #d3c191; }
.wd-subtab:focus-visible { outline: 2px solid #c9a24b; outline-offset: -2px; border-radius: 4px; }
.wd-subtab.active { color: #ecd9a0; border-bottom-color: #c9a24b; }
.wd-subtab .wd-subtab-n {
  font-family: Consolas, "Courier New", monospace; font-size: 12px;
  color: #7c776a; background: #16161d; border: 1px solid #2e2e36;
  border-radius: 999px; padding: 0 6px; min-width: 20px; text-align: center;
}
.wd-subtab.active .wd-subtab-n { color: #d3c191; border-color: #3a3a44; }

/* ---------- toolbar ---------- */

#wd-toolbar { flex: none; display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
#wd-search-wrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.wd-search-ic { position: absolute; left: 10px; font-size: 13px; color: #6f6a5e; pointer-events: none; }
#wd-search {
  width: 100%; font-family: inherit; font-size: 14px; color: #e8e4da;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 8px;
  padding: 8px 30px 8px 30px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#wd-search::placeholder { color: #6b675e; }
#wd-search:focus { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.13); }
#wd-search-clear {
  position: absolute; right: 6px; width: 20px; height: 20px; line-height: 1;
  font-family: inherit; font-size: 11px; color: #8b8678;
  background: transparent; border: none; border-radius: 4px; cursor: pointer;
  transition: color 140ms ease, background 140ms ease;
}
#wd-search-clear:hover { color: #ece7db; background: #26262d; }
#wd-count {
  flex: none; font-family: Consolas, "Courier New", monospace; font-size: 13px;
  color: #7c776a; min-width: 26px; text-align: right;
}

/* ---------- banner ---------- */

#wd-banner {
  flex: none; margin-bottom: 9px; padding: 8px 12px; border-radius: 8px;
  font-size: 13px; line-height: 1.5;
  color: #e0b0b0; background: #1a1216; border: 1px solid #a55565;
}
#wd-banner.ok { color: #9fe0ac; background: #101a12; border-color: #3a5a3f; }

/* ---------- body ---------- */

#wd-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
#wd-list { display: flex; flex-direction: column; gap: 6px; padding-bottom: 4px; }

/* grid layout for the Outfits + Wardrobes sections */
#wd-list.grid {
  display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fill, minmax(178px, 1fr));
}

/* ---------- outfit / wardrobe card ---------- */

.wd-card {
  position: relative; display: flex; flex-direction: column;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 10px;
  overflow: hidden; cursor: pointer; text-align: left;
  font-family: inherit; color: inherit; padding: 0;
  transition: border-color 140ms ease, transform 100ms ease, box-shadow 140ms ease;
}
.wd-card:hover { border-color: #3a3a44; transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
.wd-card:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-card.sel { border-color: #c9a24b; }
.wd-card.missing { opacity: .55; border-style: dashed; border-color: #a55565; }

.wd-thumb {
  position: relative; width: 100%; aspect-ratio: 3 / 4; min-height: 96px;
  background: #0c0c10 center/cover no-repeat;
  display: flex; align-items: center; justify-content: center;
  border-bottom: 1px solid #2e2e36;
}
.wd-thumb-ph { font-size: 30px; color: #3a3a44; }
.wd-fav { position: absolute; top: 6px; right: 7px; font-size: 14px; color: #ecd9a0; text-shadow: 0 1px 3px #000; }
.wd-badge {
  position: absolute; bottom: 6px; left: 7px;
  font-family: Consolas, "Courier New", monospace; font-size: 12.5px;
  color: #d3c191; background: rgba(12,12,16,.85);
  border: 1px solid #3a3a44; border-radius: 999px; padding: 1px 7px;
}
/* A just-made outfit, before SOES's ~90 s export confirms it. Quieter than a
   real piece count and clearly provisional, so it does not read as a number. */
.wd-badge.is-pending {
  color: #8f8a7c; font-style: italic; border-color: #33333d;
  font-family: "Segoe UI", sans-serif; font-size: 12px;
}
.wd-card-body { padding: 7px 9px 9px; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.wd-card-name {
  font-size: 14px; color: #e8e4da; line-height: 1.25;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wd-card-name mark { background: rgba(201,162,75,.28); color: #ecd9a0; border-radius: 2px; padding: 0 1px; }
.wd-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.wd-chip {
  font-size: 11px; letter-spacing: .2px; color: #b9b4a8;
  background: #1f1f27; border: 1px solid #2e2e36; border-radius: 999px; padding: 1px 7px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wd-chip.gold { color: #ecd9a0; border-color: #3a3a44; }
.wd-chip.warn { color: #e0b0b0; border-color: #5a3a3a; }

/* colour swatch shared by wardrobe cards + builder header */
.wd-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }

/* thumbnail strip on a wardrobe card */
.wd-strip { display: flex; gap: 3px; padding: 0 9px 9px; }
.wd-strip-i {
  width: 26px; height: 34px; border-radius: 4px; flex: none;
  background: #0c0c10 center/cover no-repeat; border: 1px solid #2e2e36;
}
.wd-strip-more { font-family: Consolas, "Courier New", monospace; font-size: 11px; color: #6f6a5e; align-self: center; }

/* ---------- NPC row ---------- */

.wd-npc {
  display: flex; align-items: center; gap: 10px;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 9px;
  padding: 8px 10px; cursor: pointer; text-align: left;
  font-family: inherit; color: inherit; width: 100%;
  transition: border-color 140ms ease, background 140ms ease;
}
.wd-npc:hover { border-color: #3a3a44; background: #191921; }
.wd-npc:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-npc-face {
  width: 40px; height: 40px; border-radius: 50%; flex: none; object-fit: cover;
  background: #0c0c10; border: 1px solid #2e2e36;
}
.wd-npc-face.ph { display: flex; align-items: center; justify-content: center; font-size: 15px; color: #4a4a55; }
.wd-npc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.wd-npc-name { font-size: 14.5px; color: #e8e4da; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wd-npc-name mark { background: rgba(201,162,75,.28); color: #ecd9a0; border-radius: 2px; padding: 0 1px; }
.wd-npc-sub { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.wd-npc-right { flex: none; display: flex; align-items: center; gap: 6px; }

.wd-dress {
  font-family: inherit; font-size: 12.5px; letter-spacing: .2px;
  color: #101015; background: linear-gradient(180deg, #d9c48a, #c9a24b);
  border: 1px solid #c9a24b; border-radius: 7px; padding: 5px 10px; cursor: pointer;
  transition: filter 140ms ease, transform 100ms ease;
}
.wd-dress:hover:not(:disabled) { filter: brightness(1.08); }
.wd-dress:active:not(:disabled) { transform: translateY(1px); }
.wd-dress:focus-visible { outline: 2px solid #ecd9a0; outline-offset: 2px; }
.wd-dress:disabled { filter: grayscale(.6) brightness(.7); cursor: not-allowed; }

/* ---------- cadence slider ---------- */

.wd-cad { display: flex; align-items: center; gap: 9px; }
.wd-cad-label { font-size: 13px; color: #8b8678; flex: none; }
.wd-cad input[type=range] {
  flex: 1; min-width: 90px; accent-color: #c9a24b; cursor: pointer; height: 18px;
}
.wd-cad input[type=range]:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; border-radius: 4px; }
.wd-cad-v {
  font-family: Consolas, "Courier New", monospace; font-size: 13px; color: #ecd9a0;
  min-width: 54px; text-align: right; flex: none;
}
.wd-cad-v.off { color: #6f6a5e; }

/* ---------- builder + sheet overlays ---------- */

#wd-pieces, #wd-builder, #wd-sheet {
  position: absolute; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8,8,11,.72); padding: 18px;
  animation: fadeIn 140ms ease;
}
#wd-pieces-card, #wd-builder-card, #wd-sheet-card {
  display: flex; flex-direction: column; min-height: 0;
  width: 100%; max-width: 780px; max-height: 100%;
  background: #121218; border: 1px solid #3a3a44; border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.55); overflow: hidden;
}
#wd-pieces-head, #wd-builder-head, #wd-sheet-head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 11px 14px; border-bottom: 1px solid #2e2e36;
}
#wd-pieces-title, #wd-builder-title, #wd-sheet-name {
  margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .3px; color: #ecd9a0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#wd-pieces-sub, #wd-builder-sub, #wd-sheet-sub { font-size: 12.5px; color: #7c776a; min-width: 0; }
#wd-sheet-sub { flex: 1; }
#wd-builder-id { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 0 1 auto; }
#wd-builder-note { flex: 1; min-width: 80px; }
#wd-builder-swatch {
  width: 14px; height: 14px; border-radius: 4px; flex: none; padding: 0;
  border: 1px solid #3a3a44; cursor: pointer;
  transition: transform 100ms ease, box-shadow 140ms ease;
}
#wd-builder-swatch:hover { transform: scale(1.15); }
#wd-builder-swatch:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
#wd-sheet-face { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; border: 1px solid #2e2e36; flex: none; }
.wd-sheet-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }

#wd-builder-cols { flex: 1; min-height: 0; display: flex; gap: 0; }
.wd-col { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 11px 13px; min-height: 0; }
.wd-col + .wd-col { border-left: 1px solid #2e2e36; }
.wd-col-h {
  flex: none; margin: 0 0 8px; font-size: 13px; letter-spacing: .5px; text-transform: uppercase;
  color: #7c776a; display: flex; align-items: center; gap: 6px;
}
.wd-col-h span {
  font-family: Consolas, "Courier New", monospace; text-transform: none; letter-spacing: 0;
  color: #d3c191; background: #16161d; border: 1px solid #2e2e36; border-radius: 999px; padding: 0 6px;
}
.wd-col-empty { font-size: 13px; color: #6f6a5e; line-height: 1.55; padding: 6px 2px; }
#wd-members, #wd-catalogue { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
#wd-cat-search {
  flex: none; width: 100%; font-family: inherit; font-size: 15px; color: #e8e4da;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 7px;
  padding: 9px 10px; margin-bottom: 8px;
  transition: border-color 140ms ease;
}
#wd-cat-search::placeholder { color: #6b675e; }
#wd-cat-search:focus { outline: none; border-color: #c9a24b; }

.wd-pick {
  display: flex; align-items: center; gap: 10px; width: 100%;
  font-family: inherit; font-size: 15.5px; color: #e8e4da; text-align: left;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 7px;
  padding: 10px 9px; cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease;
}
.wd-pick:hover { border-color: #3a3a44; background: #191921; }
.wd-pick:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-pick.in { border-color: #3a5a3f; }
.wd-pick-t { width: 22px; height: 28px; border-radius: 4px; flex: none; background: #0c0c10 center/cover no-repeat; border: 1px solid #2e2e36; }
.wd-pick-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wd-pick-n mark { background: rgba(201,162,75,.28); color: #ecd9a0; border-radius: 2px; padding: 0 1px; }
.wd-pick-x { flex: none; font-size: 13px; color: #6f6a5e; }
.wd-pick.in .wd-pick-x { color: #86c98a; }

/* ---------- sheet body ---------- */

#wd-pieces-card { max-width: 560px; }
#wd-pieces-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 11px 13px 13px;
  display: flex; flex-direction: column; gap: 5px;
}
#wd-pieces-sub { flex: 1; }

#wd-sheet-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 13px; }
.wd-field { display: flex; flex-direction: column; gap: 6px; }
.wd-field-k { font-size: 13px; letter-spacing: .5px; text-transform: uppercase; color: #7c776a; }
.wd-seg { display: flex; gap: 4px; flex-wrap: wrap; }
.wd-seg button {
  font-family: inherit; font-size: 15.5px; color: #b9b4a8;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 7px;
  padding: 10px 12px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.wd-seg button:hover { color: #ece7db; border-color: #3a3a44; }
.wd-seg button:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-seg button.on { color: #101015; background: linear-gradient(180deg, #d9c48a, #c9a24b); border-color: #c9a24b; }
/* A disabled segment button read as an ordinary one — "✦ Dress now" with no
   outfit assigned looked clickable and did nothing. Same treatment .wd-dress
   already gets, so the two agree. */
.wd-seg button:disabled { filter: grayscale(.6) brightness(.7); cursor: not-allowed; }
.wd-seg button:disabled:hover { color: #b9b4a8; border-color: #2e2e36; }

/* ---------- inline combobox (the typeable pickers) ----------
   Closed it is a button that looks exactly like the <select> it replaced, so
   the sheet is unchanged at rest; open it is a search field with the list in
   FLOW beneath it. In flow, not floating: #wd-sheet-body scrolls, and an
   absolutely-positioned dropdown would be clipped by it at the bottom of the
   sheet — the one place a picker most needs to open. */

.wd-combo { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wd-combo-field { display: flex; align-items: stretch; gap: 6px; min-width: 0; }

.wd-combo-btn,
.wd-combo-input {
  flex: 1; min-width: 0; width: 100%;
  font-family: inherit; font-size: 15px; color: #e8e4da;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 7px;
  padding: 9px 9px;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}
.wd-combo-btn { display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer; }
.wd-combo-btn:hover { border-color: #3a3a44; background: #191921; }
.wd-combo-btn:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-combo-btn.empty .wd-combo-v { color: #6f6a5e; }
.wd-combo-v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wd-combo-caret { flex: none; font-size: 13px; color: #7c776a; }
.wd-combo-btn:hover .wd-combo-caret { color: #d3c191; }

.wd-combo-input::placeholder { color: #6f6a5e; }
.wd-combo-input:focus {
  outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 3px rgba(201,162,75,.10);
}
.wd-combo.open .wd-combo-input { border-color: #c9a24b; }

/* "missing in SOES" / "no longer exists" — visible with the list SHUT, exactly
   as the old option text was, so a broken assignment still announces itself. */
.wd-combo-warn { flex: none; font-size: 12px; color: #d98a8a; white-space: nowrap; }
.wd-combo-sub { flex: none; font-size: 12px; color: #6f6a5e; white-space: nowrap; }
.wd-combo.warn .wd-combo-btn { border-color: #5a3a3a; }

.wd-combo-clear {
  flex: none; font-family: inherit; font-size: 12px; color: #8b8678;
  background: transparent; border: 1px solid #2e2e36; border-radius: 6px;
  padding: 0 9px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.wd-combo-clear:hover { color: #e0b0b0; border-color: #5a3a3a; background: #1a1216; }
.wd-combo-clear:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }

.wd-combo-list {
  position: relative;            /* offsetTop of the ↑↓ row is read against this */
  max-height: 216px; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 3px;
  padding: 5px; border: 1px solid #3a3a44; border-radius: 8px;
  background: #101017;
  animation: fadeIn 120ms ease;
}
/* the keyboard cursor, same gold as everywhere else the deck marks "this one" */
.wd-combo-list .wd-pick.kb { border-color: #c9a24b; background: #1a1a22; }
.wd-combo-more { font-size: 12px; color: #6f6a5e; padding: 5px 4px 2px; }

/* location overrides */
.wd-loc-row { display: flex; align-items: center; gap: 6px; }
.wd-loc-row .wd-combo { flex: 1; }
/* With a list open the row is tall; centring the neighbours in all that space
   floats them away from their own fields, so the row tops-align instead. */
.wd-loc-row.open { align-items: flex-start; }
.wd-loc-row.open .wd-loc-del { margin-top: 8px; }
.wd-loc-del {
  flex: none; font-family: inherit; font-size: 12px; color: #d98a8a;
  background: transparent; border: 1px solid #5a3a3a; border-radius: 6px; padding: 5px 8px; cursor: pointer;
  transition: background 140ms ease;
}
.wd-loc-del:hover { background: #1a1216; }

/* ---------- context menu ---------- */

#wd-menu {
  position: fixed; z-index: 60; min-width: 300px;
  /* showMenu caps max-height to what the pane can actually show (the pane
     clips this menu), so a long menu scrolls instead of losing its last items */
  overflow-y: auto; overscroll-behavior: contain;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,.5); padding: 6px;
  animation: fadeIn 100ms ease;
}
.wd-menu-i {
  display: block; width: 100%; text-align: left;
  font-family: inherit; font-size: 15.5px; color: #d7d2c6;
  background: transparent; border: none; border-radius: 6px;
  padding: 10px 12px; cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.wd-menu-i:hover { background: #23232c; color: #ece7db; }
.wd-menu-i:focus-visible { outline: 2px solid #c9a24b; outline-offset: -2px; }
.wd-menu-i.danger { color: #d98a8a; }
.wd-menu-i.danger:hover { background: #1a1216; }
.wd-menu-sep { height: 1px; background: #2e2e36; margin: 4px 2px; }

/* ---------- inline rename input ----------
   PrismaUI has no window.prompt, so text is edited in place, exactly like the
   Domains rail's .dm-rail-rename. Looks like text until you touch it. */

.wd-inline {
  font-family: inherit; font-size: inherit; color: inherit; letter-spacing: inherit;
  background: transparent; border: 1px solid transparent; border-radius: 5px;
  padding: 1px 5px; margin: -1px -5px; min-width: 0; width: 100%;
  transition: background 140ms ease, border-color 140ms ease;
}
.wd-inline:hover { border-color: #2e2e36; background: #12121a; }
.wd-inline:focus { outline: none; border-color: #c9a24b; background: #0f0f16; }
.wd-inline::placeholder { color: #5a5650; }
.wd-inline.note { font-size: 12.5px; color: #b9b4a8; }

/* ---------- armed (two-click) delete ---------- */

.wd-danger {
  font-family: inherit; font-size: 12.5px; color: #d98a8a;
  background: transparent; border: 1px solid #5a3a3a; border-radius: 6px;
  padding: 5px 9px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.wd-danger:hover { background: #1a1216; }
.wd-danger:focus-visible { outline: 2px solid #d98a8a; outline-offset: 2px; }
.wd-danger.armed { color: #ffd9d9; background: #3a1c22; border-color: #a55565; }

/* ---------- categories strip (Outfits sub-tab) ---------- */

#wd-cats { flex: none; display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 9px; }
.wd-cat-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 13.5px; color: #b9b4a8;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 999px;
  padding: 5px 12px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.wd-cat-pill:hover { color: #ece7db; border-color: #3a3a44; }
.wd-cat-pill:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-cat-pill.on { color: #101015; background: linear-gradient(180deg, #d9c48a, #c9a24b); border-color: #c9a24b; }
.wd-cat-pill .wd-swatch { width: 8px; height: 8px; border-radius: 2px; }
/* The count inside a filter pill. It was an inline `font-size:11px` on each
   span - too small to read at couch distance, and unreachable from CSS to fix.
   A class, at a size that stays legible when the pill does. */
.wd-cat-pill .wd-pill-n {
  opacity: .6; font-size: 12px; font-variant-numeric: tabular-nums;
}
.wd-cat-pill.on .wd-pill-n { opacity: .75; }

.wd-cat-pill .wd-inline { width: auto; max-width: 130px; }
.wd-cat-x {
  font-family: inherit; font-size: 13px; color: #7c776a;
  background: transparent; border: none; cursor: pointer; padding: 0 0 0 2px;
  transition: color 140ms ease;
}
.wd-cat-x:hover { color: #d98a8a; }
.wd-cat-x.armed { color: #ffd9d9; }

/* ---------- show-more (large catalogues) ---------- */

.wd-more {
  grid-column: 1 / -1;
  font-family: inherit; font-size: 13.5px; color: #d3c191;
  background: #16161d; border: 1px dashed #3a3a44; border-radius: 9px;
  padding: 11px 14px; cursor: pointer; width: 100%;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}
.wd-more:hover { border-color: #c9a24b; color: #ecd9a0; background: #191921; }
.wd-more:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }

/* ---------- selection + the bulk-action bar ---------- */

#wd-selbar:empty { display: none; }
.wd-selbar {
  flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
  background: #16161d; border: 1px solid #c9a24b; border-radius: 9px;
  padding: 8px 11px; margin-bottom: 9px;
  animation: fadeIn 140ms ease;
}
.wd-sel-n {
  font-family: Consolas, "Courier New", monospace; font-size: 13px; color: #ecd9a0;
  margin-right: 2px;
}
.wd-selbar .ghost-btn, .wd-selbar .wd-danger { font-size: 13px; padding: 6px 12px; }
.wd-selbar .wd-dress { font-size: 13px; padding: 6px 13px; }

/* Inventory rows: the row itself picks pieces for the outfit you are
   building; the side button wears just that ONE piece, no outfit involved. */
.wd-invrow { display: flex; gap: 6px; align-items: stretch; }
.wd-invrow > .wd-npc { flex: 1 1 auto; min-width: 0; }
.wd-invrow .wd-equip { flex: none; align-self: center; font-size: 13px; padding: 8px 14px; }

/* Rendered armour in the item face (Mesh Rendering Framework): fill the
   circle; a picked row keeps its tick as an overlay so basket state reads. */
.wd-npc-face { position: relative; overflow: hidden; }
.wd-npc-face img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* mesh renders come out of the framework's offscreen pass DIM — lift them
   (item renders only; follower portraits keep their real exposure) */
.wd-npc-face img.wd-item-render { filter: brightness(1.5) saturate(1.08) contrast(1.04); }
.wd-npc-face .wd-face-tick,
.wd-face-tick {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(12,12,16,.55); color: #ecd9a0;
}

.wd-card.sel { border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.16); }
.wd-card.sel .wd-thumb { background-color: #1a1710; }

/* the always-there menu affordance — right-click is not dependable in PrismaUI */
.wd-dots {
  position: absolute; top: 4px; left: 6px;
  font-size: 15px; line-height: 1; letter-spacing: 1px;
  color: #8b8678; background: rgba(12,12,16,.8);
  border: 1px solid #2e2e36; border-radius: 6px; padding: 0 5px 3px;
  cursor: pointer; opacity: 0; transition: opacity 140ms ease, color 140ms ease;
}
.wd-card:hover .wd-dots, .wd-card:focus-within .wd-dots, .wd-card.sel .wd-dots { opacity: 1; }
.wd-dots:hover { color: #ecd9a0; border-color: #3a3a44; }

/* ---------- the searchable picker ---------- */

#wd-picker {
  position: absolute; inset: 0; z-index: 45;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8,8,11,.72); padding: 18px;
  animation: fadeIn 140ms ease;
}
#wd-picker-card {
  display: flex; flex-direction: column; min-height: 0;
  width: 100%; max-width: 440px; max-height: 100%;
  background: #121218; border: 1px solid #3a3a44; border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.55); overflow: hidden;
}
#wd-picker-head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 11px 13px; border-bottom: 1px solid #2e2e36;
}
#wd-picker-title { margin: 0; font-size: 16px; font-weight: 600; color: #ecd9a0; white-space: nowrap; }
#wd-picker-sub { flex: 1; font-size: 12.5px; color: #7c776a; }
#wd-picker-input {
  flex: none; margin: 11px 13px 8px; font-family: inherit; font-size: 15px; color: #e8e4da;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 8px; padding: 9px 11px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#wd-picker-input::placeholder { color: #6b675e; }
#wd-picker-input:focus { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.13); }
#wd-picker-list {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px; padding: 0 13px 13px;
}
.wd-pick.create { border-color: #c9a24b; color: #ecd9a0; }
.wd-pick.create .wd-pick-x { color: #ecd9a0; }

/* ---------- inventory: the build basket ----------
   Pinned above the list so a half-assembled outfit can't be scrolled away. */

.wd-basket {
  flex: none; display: flex; flex-direction: column; gap: 6px;
  background: #16161d; border: 1px solid #3a3a44; border-radius: 9px;
  padding: 9px 11px; margin-bottom: 8px;
}
.wd-basket-top { display: flex; align-items: center; gap: 8px; }
.wd-basket-top .wd-inline { flex: 1; min-width: 0; font-size: 14.5px; color: #e8e4da; }
.wd-basket-top .wd-dress { flex: none; }
.wd-basket-sub {
  font-size: 13.5px; color: #7c776a; line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}

/* "copy what X is wearing" row */
.wd-fromrow { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.wd-from-k { font-size: 13px; color: #7c776a; }
.wd-fromrow .ghost-btn { font-size: 13px; padding: 6px 12px; }

/* slot filter chips (reuse the category pill look) */
.wd-slotbar { flex: none; display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }

/* a picked inventory row */
.wd-npc.picked { border-color: #3a5a3f; background: #101a12; }
.wd-npc.picked .wd-npc-face { color: #86c98a; border-color: #3a5a3f; }

/* ---------- loading skeleton ----------
   Sized like a real card so the grid doesn't jump when the data lands. */

.wd-skel {
  border-radius: 10px; border: 1px solid #2e2e36; background: #14141b;
  overflow: hidden; position: relative;
}
/* Mirrors .wd-card's own box — a 3:4 thumb plus the body — rather than guessing
   one aspect ratio, so the grid does not shift when the real cards land. */
.wd-skel.card { display: flex; flex-direction: column; }
.wd-skel-thumb { width: 100%; aspect-ratio: 3 / 4; min-height: 96px; background: #101017; border-bottom: 1px solid #2e2e36; }
.wd-skel-body { height: 73px; }
/* Row skeletons, matched to what actually lands in their place — measured
   2026-08-03, not guessed. A .wd-npc list row is 83px and an .wd-invrow 80px
   (they grew again with this pass's padding), so a 59px skeleton meant five
   of them shifted the list ~110px the moment the data arrived: the exact jump
   the skeleton exists to prevent. The PIECES drawer draws much shorter
   .wd-pick lines, so it gets its own size rather than sharing this one. */
.wd-skel.row  { height: 82px; }
.wd-skel.line { height: 49px; }
.wd-skel::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, rgba(201,162,75,.07), transparent);
  transform: translateX(-100%);
  animation: wdShimmer 1200ms ease-in-out infinite;
}
@keyframes wdShimmer { to { transform: translateX(100%); } }

/* ---------- cadence ticks ---------- */

.wd-cad-wrap { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 90px; }
.wd-cad-ticks {
  display: flex; justify-content: space-between;
  font-family: Consolas, "Courier New", monospace; font-size: 10px; color: #5a5650;
  padding: 0 2px;
}
.wd-cad-next { font-size: 12.5px; color: #6f6a5e; }
.wd-cad-next b { color: #d3c191; font-weight: 600; }

/* ---------- keyboard roving focus ---------- */

.wd-card.kb, .wd-npc.kb, .wd-pick.kb { border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.13); }

/* ---------- empty state ---------- */

#wd-empty { padding: 30px 18px; text-align: center; color: #6f6a5e; font-size: 13.5px; line-height: 1.6; }
#wd-empty .wd-empty-h { display: block; font-size: 15px; color: #8b8678; margin-bottom: 6px; }

/* ---------- narrow (phone-width portal / small deck scale) ---------- */

@media (max-width: 620px) {
  #wd-list.grid { grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); }
  .wd-npc-right { flex-direction: column; align-items: flex-end; gap: 4px; }

  /* Stacked builder: ONE scroll region, not two.
     Side by side, each column owns its own overflow. Stacked, that split the
     card in half and clipped the last member mid-row — so hand the scrolling
     to the wrapper and let each list size to its content. */
  #wd-builder-cols { flex-direction: column; overflow-y: auto; overscroll-behavior: contain; }
  .wd-col { flex: none; min-height: 0; }
  .wd-col + .wd-col { border-left: none; border-top: 1px solid #2e2e36; }
  #wd-members, #wd-catalogue { flex: none; overflow: visible; }
  /* the catalogue filter stays reachable while the wrapper scrolls */
  #wd-cat-search { position: sticky; top: 0; z-index: 1; }
}

/* ---------- reduced motion ----------
   Honour the OS setting: keep every state change legible, drop the movement. */

@media (prefers-reduced-motion: reduce) {
  #wd-pane *, #wd-builder, #wd-sheet, #wd-menu {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
  .wd-card:hover { transform: none; }
  .wd-skel::after { animation: none; }
}

/* ===================================================================== *
 *  Outfit photo CROP (v0.14.4) — the WYSIWYG display crop for wardrobe art.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css, at the END of the Wardrobe
 *  block above. The game loads the ASSEMBLED app.css, never this fragment —
 *  a frag deployed on its own does nothing in-game.
 *
 *  WHY A LAYER, not the tile. The crop is a CSS transform, and a transform on
 *  the tile scales the tile's OWN border and rounded clip with it — a zoomed
 *  picture would grow its box and shoulder the grid apart (the follower
 *  portraits hit exactly this and had to grow a wrapper). So every tile keeps
 *  its box and gains a `.wd-art` child that owns the picture and the
 *  transform, clipped by the tile's overflow. The ★ / piece-count / ⋯ chrome
 *  is a sibling, so it never scales either.
 *
 *  The three tile rules below are RE-DECLARATIONS of rules earlier in this
 *  file, not edits: same selector, same specificity, later wins. They add
 *  only what a clipping host needs — a positioning context and an overflow —
 *  and drop the now-unused background shorthand's image slot.
 * ===================================================================== */

.wd-thumb { overflow: hidden; }
.wd-strip-i { position: relative; overflow: hidden; }
.wd-pick-t { position: relative; overflow: hidden; }

/* The picture itself. `center/cover` matches what the tiles used to do to
   their own background, so an uncropped photo is pixel-identical to before. */
.wd-art {
  position: absolute;
  top: 0; right: 0; bottom: 0; left: 0;
  background: center/cover no-repeat;
  /* Scenery: no drag payload, no hit test — the card is a select toggle and
     the picture must not compete for the gesture. */
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}

/* The way in to the big view. Bottom-RIGHT because that is the one corner the
   card does not already use (⋯ top-left, ★ top-right, piece count
   bottom-left). Hidden until hover/focus, exactly like .wd-dots, so a wall of
   cards stays a wall of pictures. */
.wd-crop {
  position: absolute; bottom: 5px; right: 6px;
  font-size: 13px; line-height: 1;
  color: #8b8678; background: rgba(12, 12, 16, .8);
  border: 1px solid #2e2e36; border-radius: 6px; padding: 3px 5px;
  cursor: pointer; opacity: 0;
  transition: opacity 140ms ease, color 140ms ease, border-color 140ms ease;
}
.wd-card:hover .wd-crop, .wd-card:focus-within .wd-crop, .wd-card.sel .wd-crop { opacity: 1; }
.wd-crop:hover { color: #ecd9a0; border-color: #3a3a44; }
.wd-crop:focus-visible { opacity: 1; outline: none; border-color: #c9a24b; box-shadow: 0 0 0 2px rgba(201, 162, 75, .25); }

/* ---- the large view / editor overlay ----
   Hung off document.body, OUTSIDE #wd-scale: the tab zoom is a transform, and
   a fixed element inside a transformed ancestor is positioned and clipped by
   that ancestor rather than by the viewport. */
.wd-art-lb {
  position: fixed;
  top: 0; right: 0; bottom: 0; left: 0;
  z-index: 9000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .74);
  cursor: zoom-out;
  animation: wdArtIn 120ms ease-out;
}
@keyframes wdArtIn { from { opacity: 0; } to { opacity: 1; } }

/* The cap matters: `.wd-art-hint` is `flex: 0 0 100%` inside the footer, and a
   shrink-to-fit column would resolve that against the hint's max-content width
   — the controls well then stretched the full width of the deck. Cap the
   column and the hint wraps instead. */
.wd-art-inner {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  max-width: min(560px, 92vw); max-height: 92vh;
  cursor: default;
}

/* 3:4, the same letterbox `.wd-thumb` gives the picture — the editor's whole
   promise is that what you frame here is what the card draws. Sized in px by
   JS (artFrameSize), because the drag divides pointer travel by this number
   and a size that came from a CSS function Ultralight computes its own way
   would make the pan gain wrong in game and right in the harness. */
.wd-art-frame {
  position: relative;
  overflow: hidden;
  flex: none;
  border-radius: 10px;
  border: 1px solid #3a3a44;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .6);
  background: #0c0c10;
}
.wd-art-frame.editing { cursor: grab; box-shadow: 0 0 0 2px #c9a24b, 0 18px 48px rgba(0, 0, 0, .6); }
.wd-art-frame.dragging { cursor: grabbing; }

/* Backed, unlike the Followers lightbox's caption: what sits behind THIS
   overlay is a dense grid of outfit cards with their own names, and a bare
   line of text lands on one and reads as part of it. */
.wd-art-cap {
  font-size: 15px; letter-spacing: .3px; color: #e8e8ef;
  padding: 3px 10px; border-radius: 999px;
  background: rgba(12, 12, 16, .82);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* The controls get their OWN well rather than sitting bare on the backdrop:
   the overlay is only 74% opaque, so an unbacked hint line lands legibly on
   top of whatever card grid is behind it and the two read as one sentence. */
.wd-art-foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
  gap: 6px; max-width: 100%;
  padding: 8px 10px;
  border: 1px solid #2e2e38; border-radius: 10px;
  background: rgba(12, 12, 16, .94);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .5);
}

.wd-art-btn {
  appearance: none;
  min-width: 30px; padding: 5px 10px;
  font: 600 12.5px/1 "Segoe UI", sans-serif;
  color: #d8d4c8; background: #1a1a22;
  border: 1px solid #3a3a44; border-radius: 6px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.wd-art-btn:hover:not(:disabled) { background: #23232e; border-color: #55555f; color: #f0ece0; }
.wd-art-btn:focus-visible { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 2px rgba(201, 162, 75, .25); }
.wd-art-btn:active:not(:disabled) { background: #2a2a36; }
.wd-art-btn:disabled { opacity: .38; cursor: default; }
.wd-art-btn.ok { color: #8fd19e; border-color: #3d6b4a; }
.wd-art-btn.ok:hover:not(:disabled) { background: #1c2a20; border-color: #4f8560; }

/* The six nudge keys as one block, so they read as a d-pad rather than as six
   more buttons in the row. */
.wd-art-pad {
  display: flex; gap: 4px; padding: 3px;
  border: 1px solid #2e2e38; border-radius: 8px;
  background: rgba(0, 0, 0, .35);
}
.wd-art-pad .wd-art-btn { min-width: 26px; padding: 5px 7px; }

.wd-art-val {
  font: 12px/1 Consolas, monospace; letter-spacing: .3px;
  color: #9d968a; padding: 0 4px; white-space: nowrap;
}

/* Full-width line under the controls; flex-basis rather than a block, so it
   wraps to its own row however many buttons precede it. */
.wd-art-hint {
  flex: 0 0 100%; text-align: center;
  font: 11.5px/1.5 "Segoe UI", sans-serif; color: #6f6a5e;
}

/* Narrow (phone-width portal / small deck scale): the d-pad and the verdict
   still fit, the hint wraps. Nothing here may shrink the FRAME — JS owns its
   px size and the drag gain reads it back. */
@media (max-width: 620px) {
  .wd-art-foot { gap: 5px; padding: 7px 8px; }
  .wd-art-btn { padding: 5px 8px; font-size: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .wd-art-lb { animation: none; }
}

/* ---- People redesign (2026-08-03) ------------------------------------- */
/* The NFF mode chip: its own colour, because "who dresses her" is the row's
   lead fact and gold already means a wardrobe pool. */
.wd-chip.nff { color: #a8c6e8; border-color: #3d5470; background: rgba(40,58,82,.35); }

/* Inventory + chevron pair: one visual unit, quieter than ✦ Dress. */
.wd-invpair { display: inline-flex; gap: 1px; }
.wd-dress.ghost {
  background: #16161c; color: #b9b4a8; border-color: #33333d;
  padding-left: 9px; padding-right: 9px;
}
.wd-dress.ghost:hover:not([disabled]) { color: #ecd9a0; border-color: #c9a24b; }
.wd-invpair .wd-dress.ghost { border-radius: 8px 0 0 8px; }
.wd-invpair .wd-dress.ghost.chev { border-radius: 0 8px 8px 0; border-left: none; padding-left: 7px; padding-right: 7px; }

/* The inject picker rides the deck's context-menu look; positioned inside the
   pane so it scrolls away with it rather than floating over another tab. */
#wd-inject-menu, #wd-catpick {
  position: fixed; z-index: 120; width: 290px; max-height: 340px;
  overflow-y: auto; overflow-x: hidden;
  background: #131318; border: 1px solid #3a3a44; border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0,0,0,.55); padding: 8px;
  display: flex; flex-direction: column; gap: 6px;
}

/* NFF controls embedded in the People sheet: breathing room without the row
   chrome they were designed against. */
.nf-embed { display: flex; flex-direction: column; gap: 9px; padding: 2px 0 4px; }

/* ---- People polish pass (2026-08-03, Rober's standing UI rules) --------- */
/* No small text, spacious rows, real touch targets. Scoped to the People
   surface + the sheet so the denser grids (outfits, inventory) keep their own
   rhythm until their own pass. */
.wd-npc { padding: 13px 14px; gap: 13px; border-radius: 11px; }
.wd-npc-name { font-size: 17px; line-height: 1.3; }
.wd-npc-sub { gap: 7px; margin-top: 4px; }
.wd-chip { font-size: 13px; padding: 3px 11px; }
.wd-dress { font-size: 14.5px; padding: 9px 15px; border-radius: 9px; }
.wd-dress.ghost { font-size: 15px; padding: 9px 13px; }
.wd-npc-right { display: flex; align-items: center; gap: 8px; }

/* Her card: generous keys, readable values, air between fields. */
#wd-sheet .wd-field { gap: 8px; margin-bottom: 6px; }
#wd-sheet .wd-field-k { font-size: 14px; letter-spacing: .6px; }
#wd-sheet .wd-seg button { font-size: 14.5px; padding: 9px 16px; }
.nf-embed { gap: 12px; padding: 6px 0 8px; }
.nf-embed .nf-chip { font-size: 13.5px; }
.nf-embed .nf-hint { font-size: 13px; }

/* The inject picker: bigger rows, a bigger filter — it is used mid-play. */
#wd-inject-menu, #wd-catpick { width: 340px; padding: 10px; max-height: none; }
#wd-inject-menu .fd-ctx-filter, #wd-catpick .fd-ctx-filter { font-size: 15px; padding: 9px 11px; }
#wd-inject-menu .fd-ctx-item, #wd-catpick .fd-ctx-item { font-size: 15px; padding: 9px 10px; }
#wd-inject-menu .fd-ctx-head, #wd-catpick .fd-ctx-head { font-size: 15.5px; }

/* The polish pass grew the card body (17px names, 13px chips), so the skeleton
   body grows with it — the whole point of the skeleton is that nothing jumps
   when the real cards land. */
.wd-skel-body { height: 84px; }

/* ---- inventory item lightbox --------------------------------------------- */
#wd-item-lightbox {
  position: absolute; inset: 0; z-index: 80;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; background: rgba(8,8,11,.88); cursor: zoom-out;
}
#wd-item-lightbox img {
  max-width: min(86%, 640px); max-height: 74%;
  border-radius: 12px; border: 1px solid #3a3a44;
  background: #101017; box-shadow: 0 18px 48px rgba(0,0,0,.6);
}
#wd-item-lightbox .wd-lb-name { font-size: 17px; color: #e8e4da; }
#wd-item-lightbox .wd-lb-x { position: absolute; top: 14px; right: 16px; font-size: 16px; padding: 8px 13px; }
.wd-npc-face.haslb { cursor: zoom-in; }

/* ---- the outfit importer (Outfit system settings) ------------------------ *
   Two stacked searchable lists inside the settings panel. Both scroll
   INTERNALLY rather than stretching the panel: a 4,780-mod load order has
   hundreds of outfit-bearing plugins, and one of them can carry dozens. */
.wd-imp-search {
  width: 100%; box-sizing: border-box;
  padding: 9px 11px; font: inherit; font-size: 14px;
  color: #e8e4da; background: #14141b;
  border: 1px solid #2e2e36; border-radius: 8px;
  transition: border-color .14s ease, background .14s ease;
}
.wd-imp-search::placeholder { color: #6f6a5e; }
.wd-imp-search:hover { border-color: #3a3a44; }
.wd-imp-search:focus { outline: none; border-color: #c9a24b; background: #17171f; }
.wd-imp-list {
  display: flex; flex-direction: column; gap: 3px;
  max-height: 208px; overflow-y: auto; overscroll-behavior: contain;
  padding: 3px; border: 1px solid #26262e; border-radius: 8px; background: #101015;
}
.wd-imp-row {
  display: flex; align-items: center; gap: 10px;
  width: 100%; box-sizing: border-box; text-align: left;
  padding: 8px 10px; font: inherit; font-size: 13.5px;
  color: #cfcabd; background: transparent;
  border: 1px solid transparent; border-radius: 6px; cursor: pointer;
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.wd-imp-row.static { cursor: default; }
.wd-imp-row:hover { background: #191921; color: #ece7db; }
.wd-imp-row.static:hover { background: #16161d; }
.wd-imp-row:focus-visible { outline: 2px solid #c9a24b; outline-offset: -2px; }
.wd-imp-row.on { background: #1d1c17; color: #e8dcb8; border-color: #c9a24b; }
/* Long plugin names ellipsize instead of pushing the count off the row. */
.wd-imp-n {
  flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.wd-imp-c { flex: none; font-size: 12px; color: #6f6a5e; font-variant-numeric: tabular-nums; }
.wd-imp-go {
  flex: none; min-width: 34px; padding: 5px 9px;
  font: inherit; font-size: 13px; color: #cfcabd;
  background: #17171f; border: 1px solid #2e2e36; border-radius: 6px; cursor: pointer;
  transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.wd-imp-go:hover { color: #101015; background: linear-gradient(180deg, #d9c48a, #c9a24b); border-color: #c9a24b; }
.wd-imp-go:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-imp-go:disabled { filter: grayscale(.6) brightness(.7); cursor: not-allowed; }
.wd-imp-go:disabled:hover { color: #cfcabd; background: #17171f; border-color: #2e2e36; }

/* Inject picker set-step: the NAME must never lose to the hint. Two-line rows —
   name full-size on top, hint beneath in the UI face (the mono pill crushed
   "Adventure" to "A…" in game, 2026-08-03). */
#wd-inject-menu .fd-ctx-item, #wd-catpick .fd-ctx-item { flex-wrap: wrap; row-gap: 2px; }
#wd-inject-menu .fd-ctx-item .fd-ctx-lbl, #wd-catpick .fd-ctx-item .fd-ctx-lbl {
  flex: 1 1 auto; overflow: visible; text-overflow: clip; white-space: normal;
  font-size: 15.5px;
}
#wd-inject-menu .fd-ctx-item .fd-ctx-count, #wd-catpick .fd-ctx-item .fd-ctx-count {
  flex: 1 1 100%; margin-left: 26px;
  font-family: "Segoe UI", sans-serif; font-size: 12.5px; font-style: italic;
  background: none; border: none; padding: 0; color: #8f8a7c;
  text-align: left; white-space: normal;
}

/* ---- the searchable picker's own parts (categories, variant pieces) -------
   Everything else it wears is #wd-inject-menu's, whose selectors were widened
   to cover #wd-picker rather than cloned — one set of rules, no drift. */
#wd-catpick .fd-ctx-item.on { background: rgba(201,162,75,.10); color: #f0e6cc; }
#wd-catpick .fd-ctx-item.on .fd-ctx-check { color: #c9a24b; }
#wd-catpick .fd-ctx-item.wd-pick-new { color: #cfe0b8; }
#wd-catpick .fd-ctx-item.wd-pick-new .fd-ctx-check { color: #8fbf6a; }
#wd-catpick .fd-ctx-item .fd-ctx-count {
  font-size: 12px; color: #8a8271; flex: 0 0 auto; margin-left: auto; padding-left: 10px;
}
.wd-pick-foot:empty { display: none; }
.wd-pick-foot {
  margin-top: 8px; padding-top: 9px; border-top: 1px solid rgba(201,162,75,.16);
}
.wd-pick-note { font-size: 13px; color: #9a927f; }
.wd-pick-foot-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.wd-pick-go {
  font: inherit; font-size: 14px; padding: 8px 14px; border-radius: 7px; cursor: pointer;
  background: rgba(201,162,75,.16); color: #f0e6cc;
  border: 1px solid rgba(201,162,75,.42);
  transition: background .14s ease, border-color .14s ease, color .14s ease;
}
.wd-pick-go:hover:not(:disabled) { background: rgba(201,162,75,.28); border-color: #c9a24b; }
.wd-pick-go:active:not(:disabled) { background: rgba(201,162,75,.36); }
.wd-pick-go:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.wd-pick-go:disabled { opacity: .40; cursor: not-allowed; }

/* Folded warning banner: the headline is a real button, the danger colour
   stays, and the detail indents under it when opened. */
.wd-warn-fold { color: #e0b0b0; border-color: #6b3a3a; font-size: 14px; text-align: left; }
.wd-warn-fold:hover { color: #f0c5c5; border-color: #a55565; }
.wd-warn-detail { margin: 6px 0 0 14px; font-size: 13.5px; color: #d8b8b8; line-height: 1.5; }
