/* ===================================================================== *
 *  Rooms tab — Room Guard pane for the Hotkey Deck view.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is rm- prefixed, no existing rule is touched and no token is
 *  redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease), and the
 *  shared .ghost-btn / .empty-* classes are reused as-is.
 *
 *  NOTE (see [[deck-view-css-frag-merge]]): the game loads the ASSEMBLED
 *  app.css. Deploying this .frag alone changes nothing in-game — it has to
 *  be merged into app.css between the previous banner and the next one.
 * ===================================================================== */

#rm-pane { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
#rm-body { flex: 1; display: flex; min-height: 0; }

/* ---------- left rail: where you are + claim ---------- */

/* 260px, not 232: the rail's type sits on the deck's 12px floor (see the
   type-scale note below) and at 232px the three "This place is" segments and
   the "Size 200u (5.7 m)" label had no room left to hold their words. */
#rm-side {
  width: 260px; flex: none;
  display: flex; flex-direction: column; gap: 10px;
  padding: 11px 10px;
  border-right: 1px solid #2e2e36;
  background: rgba(0,0,0,.16);
  overflow-y: auto;
}

#rm-here-card {
  border: 1px solid #2e2e36; border-radius: 8px;
  padding: 9px 10px;
  background: rgba(255,255,255,.02);
}
/* ---- type scale ----
   12px is the deck's floor (Rober plays at 2560x1440 from a couch and the
   panel is NOT sized by the viewport, so a 10px label is 10 real pixels on a
   27" screen two metres away). Nothing in this pane goes under it; the small
   end of the scale is 12px for the uppercase labels/chips and 12.5px for the
   lines you actually read. */
.rm-here-label {
  font-size: 12px; letter-spacing: .8px; text-transform: uppercase;
  color: #6f6a5e;
}
.rm-here-name {
  margin-top: 3px;
  font-size: 13.5px; color: #e8e4da; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rm-here-status { margin-top: 4px; font-size: 12.5px; color: #b9b4a8; }
.rm-here-status.claimed { color: #ecd9a0; }
.rm-here-status.home    { color: #8fbf8f; }

#rm-claim-box { display: flex; flex-direction: column; gap: 9px; }

.rm-field { display: flex; flex-direction: column; gap: 4px; }
.rm-field-inline { flex-direction: row; align-items: center; gap: 8px; }
.rm-field-label {
  font-size: 12px; letter-spacing: .8px; text-transform: uppercase; color: #6f6a5e;
}
.rm-size-val { color: #d9c48a; font-family: Consolas, "Courier New", monospace; font-size: 12px; }

#rm-claim-name, #rm-search {
  background: rgba(0,0,0,.30); color: #e8e4da;
  border: 1px solid #2e2e36; border-radius: 6px;
  padding: 6px 8px; font-size: 12.5px; font-family: inherit;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#rm-claim-name:focus, #rm-search:focus {
  outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.10);
}
#rm-claim-name::placeholder, #rm-search::placeholder { color: #5d594f; }

/* segmented Rented / Home */
.rm-seg { display: flex; gap: 4px; }
/* min-height 30px on every clickable in this pane: these are couch targets hit
   with a trackball, and the seg buttons / row actions / unseal buttons were
   23-28px tall. Padding alone can't hold the floor once the label wraps, so the
   floor is stated and the padding only sets the comfortable size above it. */
.rm-seg-btn {
  flex: 1; padding: 6px 4px; min-height: 30px;
  background: rgba(0,0,0,.25); color: #b9b4a8;
  border: 1px solid #2e2e36; border-radius: 6px;
  font-size: 12.5px; font-family: inherit; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.rm-seg-btn:hover { background: rgba(201,162,75,.06); color: #ece7db; }
.rm-seg-btn.active { border-color: #c9a24b77; color: #ecd9a0; background: rgba(201,162,75,.10); }
.rm-seg-btn:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }

#rm-radius, #rm-grace { accent-color: #c9a24b; width: 100%; }

#rm-claim-btn, #rm-evict-btn {
  padding: 8px 10px;
  background: linear-gradient(180deg, rgba(201,162,75,.16), rgba(201,162,75,.06));
  color: #ecd9a0; border: 1px solid #c9a24b77; border-radius: 7px;
  font-size: 12.5px; font-family: inherit; cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
}
#rm-claim-btn:hover, #rm-evict-btn:hover { background: rgba(201,162,75,.20); border-color: #c9a24b; }
#rm-claim-btn:active, #rm-evict-btn:active { transform: translateY(1px); }
#rm-claim-btn:disabled, #rm-evict-btn:disabled {
  opacity: .45; cursor: not-allowed; transform: none;
  background: rgba(255,255,255,.03); border-color: #2e2e36; color: #6f6a5e;
}
.rm-hint { font-size: 12px; color: #6f6a5e; line-height: 1.35; }

/* live occupancy readout */
#rm-occupants { display: flex; flex-direction: column; gap: 3px; }
.rm-occ-title {
  font-size: 12px; letter-spacing: .8px; text-transform: uppercase; color: #6f6a5e;
  margin-bottom: 2px;
}
.rm-occ {
  display: flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: #b9b4a8;
  padding: 3px 5px; border-radius: 5px; background: rgba(255,255,255,.02);
}
.rm-occ-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rm-occ-why {
  flex: none; font-size: 12px; color: #8fbf8f;
  background: rgba(143,191,143,.10); border-radius: 8px; padding: 1px 6px;
}
.rm-occ.going .rm-occ-why { color: #d99a6c; background: rgba(217,154,108,.10); }
/* occupant-row allow toggle (Private bedrooms: choose who may stay) */
.rm-occ-allow {
  flex: none; border: 1px solid #2e2e36; border-radius: 5px;
  background: rgba(255,255,255,.04); color: #b9b4a8;
  font-size: 12px; line-height: 1; padding: 4px 8px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.rm-occ-allow:hover { background: rgba(143,191,143,.14); color: #a9d4a9; border-color: #8fbf8f66; }
.rm-occ-allow.off:hover { background: rgba(200,80,70,.14); color: #e79b93; border-color: #c8504666; }

/* ---------- right: the room list ---------- */

#rm-main { flex: 1; display: flex; flex-direction: column; min-width: 0; padding: 11px 12px; gap: 9px; }

#rm-toolbar { display: flex; align-items: center; gap: 8px; }
#rm-search-wrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.rm-search-ic { position: absolute; left: 8px; color: #5d594f; font-size: 13px; pointer-events: none; }
#rm-search { flex: 1; padding-left: 24px; }
#rm-count {
  flex: none; font-family: Consolas, "Courier New", monospace; font-size: 12px;
  color: #6f6a5e; background: rgba(255,255,255,.04); border-radius: 9px; padding: 3px 8px;
}

#rm-settings {
  display: flex; flex-wrap: wrap; gap: 10px 16px;
  padding: 9px 10px;
  border: 1px solid #2e2e36; border-radius: 8px;
  background: rgba(0,0,0,.18);
}
.rm-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #b9b4a8; cursor: pointer; }
.rm-check input { accent-color: #c9a24b; }

#rm-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }

.rm-row {
  /* Wrap when the chips + action cluster can't fit on one line (a narrow deck
     with a whole-cell + followers-out room grows the chip row past the width):
     the name takes line 1, chips + actions flow onto line 2 rather than the
     buttons clipping off the right edge. On a wide deck nothing wraps. */
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid #2e2e36; border-radius: 7px;
  background: rgba(255,255,255,.02);
  cursor: default;
  transition: background 140ms ease, border-color 140ms ease;
}
.rm-row:hover { background: rgba(201,162,75,.05); border-color: #3a3a44; }
.rm-row.sel { border-color: #c9a24b77; background: rgba(201,162,75,.08); }
.rm-row.off { opacity: .55; }

.rm-medal {
  flex: none; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px;
  border: 1px solid #c9a24b55; background: rgba(201,162,75,.08);
}
.rm-row.home .rm-medal { border-color: #8fbf8f55; background: rgba(143,191,143,.08); }

/* min-width keeps the name legible on a narrow deck: instead of the name being
   crushed to one letter so every chip stays on line 1, the name holds ~140px
   and the chips wrap under it. Still ellipsizes within that floor. */
.rm-info { flex: 1; min-width: 140px; }
.rm-name {
  font-size: 12.5px; color: #e8e4da;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rm-sub {
  margin-top: 2px; font-size: 12px; color: #6f6a5e;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rm-chip {
  flex: none; font-size: 12px; border-radius: 9px; padding: 2px 7px;
  color: #d9c48a; background: rgba(201,162,75,.10);
}
.rm-chip.home { color: #8fbf8f; background: rgba(143,191,143,.10); }
.rm-chip.warn { color: #d99a6c; background: rgba(217,154,108,.12); }
.rm-chip.here { color: #ecd9a0; background: rgba(201,162,75,.18); }
.rm-chip.cell  { color: #b7a6e0; background: rgba(150,128,214,.14); }
.rm-chip.evict { color: #7fb6d9; background: rgba(110,168,214,.14); }

.rm-actions { flex: none; display: flex; gap: 4px; margin-left: auto; }
/* Six of these per row and each one is the ONLY way to reach what it does
   (resize, ban, seal, retype, drop point, pause) — so they hold the 30px
   floor in both axes, not just the width they happened to have. */
.rm-act {
  padding: 4px 8px; min-height: 30px; min-width: 32px;
  font-size: 12px; font-family: inherit;
  background: rgba(255,255,255,.04); color: #b9b4a8;
  border: 1px solid #2e2e36; border-radius: 5px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.rm-act:hover { background: rgba(201,162,75,.10); color: #ecd9a0; border-color: #c9a24b55; }
.rm-act:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }
.rm-act.danger:hover { background: rgba(200,80,70,.14); color: #e79b93; border-color: #c8504666; }
.rm-act.armed { background: rgba(200,80,70,.18); color: #e79b93; border-color: #c85046; }

#rm-foot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

#rm-ignore-list { display: flex; flex-wrap: wrap; gap: 4px; }
.rm-ig {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; color: #b9b4a8;
  background: rgba(255,255,255,.04); border: 1px solid #2e2e36;
  border-radius: 10px; padding: 2px 4px 2px 8px;
}
.rm-ig-x {
  border: none; background: transparent; color: #6f6a5e; cursor: pointer;
  font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 8px;
  transition: color 140ms ease, background 140ms ease;
}
.rm-ig-x:hover { color: #e79b93; background: rgba(200,80,70,.14); }

/* Never-move filter (appears past 8 protected people). It takes the whole
   row so the chips below it stay a clean wrap, and it deliberately reads
   larger than the 11px chips — a control you type into must not be the
   smallest text on the pane. */
.rm-ig-findwrap {
  display: flex; align-items: center; gap: 7px; width: 100%;
  background: #16161d; border: 1px solid #3d3a33; border-radius: 9px;
  padding: 5px 10px; margin: 2px 0 5px; max-width: 380px;
  box-sizing: border-box;
}
.rm-ig-findg { color: #9a917d; font-size: 13px; line-height: 1; }
.rm-ig-find {
  flex: 1; min-width: 0;
  background: transparent; border: none; outline: none;
  color: #efe9da; font-size: 13px;
}
.rm-ig-find::placeholder { color: #7d7566; }
.rm-ig-findn { color: #cbb27a; font-size: 12px; white-space: nowrap; }
.rm-ig-none { width: 100%; color: #6f6a5e; font-size: 12.5px; padding: 4px 2px; }

/* empty states — sized like real content so the list does not jump */
#rm-empty { padding: 22px 12px; text-align: center; color: #6f6a5e; font-size: 12.5px; line-height: 1.5; }
#rm-empty b { color: #b9b4a8; font-weight: 600; }

/* ---------- per-room size tuning panel (📐) ---------- */
/* Sits directly under its row so the thing you are resizing stays in view
   while you drag, with the left-rail occupant list as the readout. */
.rm-tune {
  margin: -2px 0 3px 0;
  padding: 9px 12px 10px;
  border: 1px solid #c9a24b44; border-top: none;
  border-radius: 0 0 7px 7px;
  background: rgba(201,162,75,.05);
  display: flex; flex-direction: column; gap: 8px;
}
.rm-tune-row { display: flex; align-items: center; gap: 9px; }
/* 92px holds the longest label ("Up / down" = 77px at the 12px floor) without
   clipping — the old 74px was sized for the 10px type. */
.rm-tune-row .rm-field-label { flex: none; width: 92px; }
.rm-tune-row input[type=range] { flex: 1; min-width: 0; accent-color: #c9a24b; }
.rm-tune-row .rm-size-val { flex: none; width: 108px; text-align: right; }
.rm-tune .rm-hint { color: #8a8478; }
.rm-tune-repel { margin-top: 2px; }
.rm-tune-repel span { line-height: 1.3; }
.rm-tune-evict, .rm-tune-whole { margin-top: 2px; }
.rm-tune-evict span, .rm-tune-whole span { line-height: 1.3; }
.rm-tune-evict input { accent-color: #6ea8d6; }
.rm-tune-whole input { accent-color: #9680d6; }

/* Keep-out block in the claim box, and the "waiting outside" readout. */
.rm-keepout { gap: 6px; }
.rm-keepout .rm-check { font-size: 12px; }
.rm-parked {
  font-size: 12px; color: #7fb6d9; line-height: 1.35;
  background: rgba(110,168,214,.10); border-radius: 6px; padding: 5px 8px;
}

/* ---------- per-room blacklist (🚫) + the searchable NPC picker ---------- */

.rm-chip.deny { color: #e79b93; background: rgba(200,80,70,.14); }
.rm-occ-why.denied { color: #e79b93; background: rgba(200,80,70,.12); }
.rm-ig.deny { border-color: #c8504655; }

.rm-deny-list { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.rm-deny-add {
  align-self: flex-start;
  padding: 6px 11px; font-size: 12px; font-family: inherit;
  background: rgba(200,80,70,.10); color: #e7a49d;
  border: 1px solid #c8504666; border-radius: 6px; cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.rm-deny-add:hover { background: rgba(200,80,70,.18); border-color: #c85046; }
.rm-deny-add:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }

/* The POPOUT both pickers share (NPC list from the Rooms tab, room list from
   the F7 card's Room ban). Since 2026-10-12 a centred, body-anchored popout
   like the CHIM and Fixes ones beside it, not a dropdown hung off the button
   (Rober: "pop outs need to be better … centered, horizontal and vertical").
   .rm-pick-back fills the viewport (bare vh/vw are right; NO --ui-scale — the
   2026-08-14 popup audit) and centres the card; z sits under #hd-tip (10050)
   so hover bubbles still win.

   Sized for a couch at 2560x1440 (Rober, 2026-08-11: "dropdown text too hard
   to read (too small) … searching is nice, but still too small"): this is
   where you READ names, so the type is the popout scale, not the deck body's,
   and --rp steps the whole card up on a big screen. */
.rm-pick-back { --rp: 1; }
@media (min-width: 1900px) and (min-height: 1000px) { .rm-pick-back { --rp: 1.3; } }
.rm-pick-back {
  position: fixed; inset: 0; z-index: 9700;
  display: flex; align-items: center; justify-content: center;
  padding: calc(24px * var(--rp, 1)); box-sizing: border-box;
  background: rgba(0,0,0,.72);
  animation: rmPickBackIn 140ms ease-out;
}
@keyframes rmPickBackIn { from { opacity: 0; } to { opacity: 1; } }
.rm-pick {
  position: relative;
  width: calc(720px * var(--rp, 1)); max-width: 100%; max-height: 88vh;
  box-sizing: border-box;
  background: linear-gradient(180deg, #1c1c23, #16161b);
  border: 1px solid #b69b56; border-radius: calc(18px * var(--rp, 1));
  box-shadow: 0 8px 22px rgba(0, 0, 0, .3);   /* light: the view is a transparent overlay (shadow-slab leash) */
  padding: calc(24px * var(--rp, 1)) calc(28px * var(--rp, 1));
  display: flex; flex-direction: column; gap: calc(14px * var(--rp, 1));
  color: #eee8dd;
  animation: rmPickIn 160ms ease-out;
}
@keyframes rmPickIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.rm-pick-top {
  display: flex; align-items: center; gap: calc(16px * var(--rp, 1));
  padding-bottom: calc(14px * var(--rp, 1));
  border-bottom: 1px solid #4d4540;
}
.rm-pick-head {
  /* Wraps rather than clips: the title carries the room you are banning
     FROM ("Ban someone from Proudspire Manor — the upstairs bedroom"), which is the
     one line you cannot afford to lose the end of. */
  flex: 1; min-width: 0;
  font-size: calc(26px * var(--rp, 1)); color: #e6c979; font-weight: 700;
  line-height: 1.25; overflow-wrap: anywhere;
}
.rm-pick-close {
  flex-shrink: 0; min-height: calc(46px * var(--rp, 1)); padding: 0 calc(20px * var(--rp, 1));
  font: inherit; font-size: calc(18px * var(--rp, 1)); color: #eee8dd;
  background: #2a2931; border: 1px solid #615b62; border-radius: 9px; cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.rm-pick-close:hover { background: #36313a; border-color: #8b7443; }
.rm-pick-close:focus-visible { outline: 2px solid #d5b65c; outline-offset: 2px; }
.rm-pick-in {
  flex-shrink: 0;
  background: rgba(0,0,0,.30); color: #e8e4da;
  border: 1px solid #3d3a44; border-radius: 10px;
  padding: calc(14px * var(--rp, 1)) calc(16px * var(--rp, 1));
  font-size: calc(19px * var(--rp, 1)); font-family: inherit;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.rm-pick-in:focus {
  outline: none; border-color: #c9a24b99; box-shadow: 0 0 0 3px rgba(201,162,75,.12);
}
.rm-pick-in::placeholder { color: #7a7468; }
.rm-pick-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: calc(8px * var(--rp, 1));
}
.rm-pick-item {
  /* Name on its own full-width line, chips beneath it: a right-hand chip
     stole enough room to clip BOTH ("Bannered Mare — rented ro…" beside
     "The Bannered M…"), and neither half was worth reading. */
  display: flex; align-items: center; flex-wrap: wrap; gap: calc(6px * var(--rp, 1)) calc(10px * var(--rp, 1));
  flex-shrink: 0;
  text-align: left; width: 100%; box-sizing: border-box;
  padding: calc(14px * var(--rp, 1)) calc(18px * var(--rp, 1));
  font-size: calc(19px * var(--rp, 1)); font-family: inherit;
  background: #22222a; color: #ded9cd;
  border: 1px solid #3d3a44; border-radius: 12px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.rm-pick-item:hover { background: #2e2b33; color: #ecd9a0; border-color: #8b7443; }
.rm-pick-item:focus-visible { outline: 2px solid #d5b65c; outline-offset: 2px; }
.rm-pick-item.on { border-color: #c8504699; background: rgba(200,80,70,.12); color: #e7a49d; }
.rm-pick-item.guard.on { border-color: #8fbf8f99; background: rgba(143,191,143,.12); color: #a9d4a9; }
/* The name is the thing you are here to read, so it WRAPS rather than
   ellipsizing — "Bannered Mare — rented ro…" is exactly the kind of clipped
   half-sentence the badge used to force. The cell/plugin chip beside it is
   secondary, keeps its ellipsis, and can shrink. */
.rm-pick-nm {
  flex: 1 1 100%; min-width: 0;
  white-space: normal; overflow-wrap: anywhere; line-height: 1.3;
}
.rm-pick-badge {
  flex: 0 1 auto; font-size: calc(15px * var(--rp, 1)); color: #a49d8f;
  background: rgba(255,255,255,.06); border-radius: 8px; padding: calc(4px * var(--rp, 1)) calc(10px * var(--rp, 1));
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rm-pick-badge.fol { color: #8cc0e0; background: rgba(110,168,214,.16); }
.rm-pick-empty { padding: calc(20px * var(--rp, 1)) 12px; text-align: center; color: #9a9285; font-size: calc(17px * var(--rp, 1)); }
.rm-pick-hint { flex-shrink: 0; font-size: calc(16px * var(--rp, 1)); color: #9a9285; line-height: 1.45; }
@media (max-width: 720px) {
  .rm-pick-back { padding: 12px; }
  .rm-pick { padding: 18px; max-height: 96vh; }
}


/* ---------- privacy lockdown (⛔ "nobody in this room right now") ----------
   Deliberately the loudest thing in the pane: a seal survives a save/load, so
   the cost of it being subtle is Room Guard quietly evicting your household
   weeks later and looking broken. Warm red is the pane's existing "kept out"
   colour (bans use the same pair), so nothing new enters the palette. */

.rm-lock-btn {
  margin-top: 9px; width: 100%;
  padding: 11px 12px; font-size: 14px; font-family: inherit; font-weight: 600;
  text-align: center; letter-spacing: .2px;
  background: rgba(255,255,255,.04); color: #d6d1c6;
  border: 1px solid #2e2e36; border-radius: 7px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease,
              box-shadow 140ms ease;
}
.rm-lock-btn:hover:not(:disabled) {
  background: rgba(200,80,70,.14); color: #e7a49d; border-color: #c8504666;
}
.rm-lock-btn:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }
.rm-lock-btn:disabled { opacity: .45; cursor: default; }
/* Sealed: the button is the OFF switch now, so it reads as the live state and
   its hover promises the opposite of the on-state, not more of it. */
.rm-lock-btn.on {
  background: rgba(200,80,70,.20); color: #f0b4ac; border-color: #c85046;
  box-shadow: inset 0 0 0 1px rgba(200,80,70,.25);
}
.rm-lock-btn.on:hover { background: rgba(200,80,70,.28); color: #ffd2cb; }

.rm-here-status.sealed { color: #e79b93; }

.rm-chip.sealed { color: #f0b4ac; background: rgba(200,80,70,.20); }
.rm-row.sealed { border-color: #c8504655; background: rgba(200,80,70,.07); }
.rm-row.sealed:hover { background: rgba(200,80,70,.11); border-color: #c8504688; }
.rm-act-lock.on { color: #f0b4ac; border-color: #c8504666; background: rgba(200,80,70,.16); }
.rm-act-lock.on:hover { background: rgba(200,80,70,.24); color: #ffd2cb; border-color: #c85046; }

/* Banner above the list — every sealed room, whatever the search box says. */
#rm-lock-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid #c8504655; border-radius: 7px;
  background: rgba(200,80,70,.10);
}
#rm-lock-banner.hidden { display: none; }
.rm-lock-ban-t { font-size: 12.5px; color: #f0b4ac; font-weight: 600; }
.rm-lock-ban-b {
  padding: 5px 10px; min-height: 30px; font-size: 12px; font-family: inherit;
  background: rgba(255,255,255,.05); color: #e7a49d;
  border: 1px solid #c8504644; border-radius: 6px; cursor: pointer;
  max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.rm-lock-ban-b:hover { background: rgba(200,80,70,.20); color: #ffd2cb; border-color: #c85046; }
.rm-lock-ban-b:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }

/* The "what the seal is doing to this list" line above the occupants. */
.rm-occ-sealed {
  font-size: 12px; line-height: 1.35; color: #e7a49d;
  background: rgba(200,80,70,.12); border-radius: 6px; padding: 6px 8px;
}
