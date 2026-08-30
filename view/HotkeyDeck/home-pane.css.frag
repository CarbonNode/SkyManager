/* ===================================================================== *
 *  Home tab — the deck's landing page (card launcher + universal search).
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is hm- prefixed, no existing rule touched, no token redefined.
 *  Deck literals: #c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease.
 *  Type floor 12px (Rober's no-small-text rule).
 *
 *  NOTE (see [[deck-view-css-frag-merge]]): the game loads the ASSEMBLED
 *  app.css — deploying this .frag alone changes nothing; it is merged in.
 * ===================================================================== */

#hm-pane { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }
#hm-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px 22px; }

/* ---- universal search launcher ---- */
#hm-search {
  display: flex; align-items: center; gap: 14px;
  height: 58px; padding: 0 18px; margin: 2px 0 20px;
  background: rgba(0,0,0,.30); color: var(--muted, #a49d8c);
  border: 1.5px solid #3a3a44; border-radius: 13px;
  cursor: text; user-select: none;
  transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease;
}
#hm-search:hover { border-color: #4a4a56; }
#hm-search:focus, #hm-search.focus {
  outline: none; border-color: #c9a24b;
  box-shadow: 0 0 0 4px rgba(201,162,75,.16); background: rgba(0,0,0,.40);
}
#hm-search .hm-search-ic { font-size: 22px; color: #6f6a5e; flex: none; }
#hm-search-label { flex: 1; font-size: 19px; color: #8a8478; }
#hm-search .hm-search-kbd { display: flex; gap: 5px; flex: none; }
#hm-search .hm-search-kbd kbd {
  font: 600 12px/1 Consolas, monospace; color: #a49d8c;
  border: 1px solid #3a3a44; border-bottom-width: 2px; border-radius: 6px;
  padding: 4px 7px; background: rgba(255,255,255,.03);
}

/* ---- Open key card (home-open-key) ----
   The discoverable home for the open-key rebind. Same card surface as the
   grid cards, laid out as a row: plate · title+help · big current bind · Change.
   Gold-accented so it reads as the deck's own primary control. */
#hm-openkey {
  display: flex; align-items: center; gap: 15px;
  padding: 15px 17px; margin: 0 0 20px;
  background: linear-gradient(180deg, #1d1c22, #171620);
  border: 1px solid #c9a24b40; border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
}
#hm-openkey .hm-ok-plate {
  width: 46px; height: 46px; border-radius: 12px; flex: none;
  display: grid; place-items: center; font-size: 24px; color: #c9a24b;
  background: rgba(201,162,75,.14); border: 1px solid rgba(201,162,75,.34);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
}
#hm-openkey .hm-ok-body { flex: 1; min-width: 0; }
#hm-openkey .hm-ok-title {
  font-size: 17px; font-weight: 650; color: #e8e4da; letter-spacing: .2px;
}
#hm-openkey .hm-ok-help {
  font-size: 13px; color: #a49d8c; line-height: 1.4; margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis;
}
#hm-openkey .hm-ok-key {
  flex: none; font: 700 18px/1 Consolas, monospace; color: #e0bc6a;
  background: rgba(201,162,75,.12); border: 1px solid rgba(201,162,75,.4);
  border-radius: 12px; padding: 10px 16px; min-width: 56px; text-align: center;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;
}
#hm-openkey .hm-ok-btn {
  flex: none; font: 600 14px/1 inherit; color: #e8e4da; cursor: pointer;
  background: rgba(255,255,255,.03); border: 1px solid #3a3a44; border-radius: 10px;
  padding: 11px 16px;
  transition: border-color 140ms ease, background 140ms ease, transform 120ms ease;
}
#hm-openkey .hm-ok-btn:hover { border-color: #c9a24b; background: rgba(201,162,75,.14); }
#hm-openkey .hm-ok-btn:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
#hm-openkey .hm-ok-btn:active { transform: translateY(1px); }

/* ---- section head ---- */
.hm-sec-head { display: flex; align-items: baseline; gap: 10px; margin: 0 2px 14px; }
.hm-sec-head h2 {
  font-size: 13px; letter-spacing: 1.2px; text-transform: uppercase;
  color: #a49d8c; margin: 0; font-weight: 700;
}
.hm-sec-hint { color: #6f6a5e; font-size: 13px; }

/* ---- card grid ---- */
#hm-grid {
  display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
}
.hm-card {
  position: relative; text-align: left; cursor: pointer;
  background: linear-gradient(180deg, #1b1b22, #17171d);
  border: 1px solid #2e2e36; border-radius: 15px;
  padding: 16px 16px 15px; min-height: 122px;
  display: flex; flex-direction: column; gap: 3px;
  transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
}
.hm-card:hover { transform: translateY(-3px); border-color: #3a3a44;
                 box-shadow: 0 12px 26px rgba(0,0,0,.4); }
.hm-card:focus-visible { outline: 2px solid #c9a24b; outline-offset: 2px; }
.hm-card:active { transform: translateY(-1px); }
.hm-card .hm-plate {
  width: 50px; height: 50px; border-radius: 13px; margin-bottom: 9px; flex: none;
  display: grid; place-items: center; font-size: 26px; overflow: hidden;
  background: var(--hmc, rgba(201,162,75,.16));
  border: 1px solid var(--hmb, rgba(201,162,75,.32));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
}
.hm-card .hm-plate img { width: 100%; height: 100%; object-fit: contain; display: block; }
.hm-card h3 { font-size: 17.5px; font-weight: 650; margin: 0; color: #e8e4da; letter-spacing: .2px; }
.hm-card p { margin: 0; color: #a49d8c; font-size: 13px; line-height: 1.4; }
.hm-card .hm-count {
  position: absolute; top: 14px; right: 14px;
  font: 700 13px/1 Consolas, monospace; color: #e0bc6a;
  background: rgba(201,162,75,.12); border: 1px solid rgba(201,162,75,.3);
  border-radius: 999px; padding: 5px 9px; min-width: 28px; text-align: center;
}
.hm-card .hm-count.on  { color: #a9d3a9; background: rgba(120,200,120,.12); border-color: rgba(120,200,120,.32); }
.hm-card .hm-count.off { color: #6f6a5e; background: transparent; border-color: #2e2e36; }

/* ---- edit mode: pointer-drag reorder (home-card-reorder) ----
   Grid gains a dashed frame + a hint so it reads as "you're rearranging".
   Cards no longer lift on hover (that motion belongs to click-to-open); they
   grab-cursor, carry a ⋮⋮ grip, and the one being dragged floats with a
   heavier shadow. Drop position rides PDrag's shared drop-before/after classes
   (a gold rule down the entering edge), so no per-pane drag CSS is invented. */
#hm-grid.hm-editing {
  outline: 1.5px dashed rgba(201,162,75,.5); outline-offset: 8px; border-radius: 10px;
}
#hm-grid.hm-editing .hm-card { cursor: grab; }
#hm-grid.hm-editing .hm-card:hover { transform: none; border-color: #c9a24b;
  box-shadow: 0 0 0 1px rgba(201,162,75,.25); }
#hm-grid.hm-editing .hm-card:active { cursor: grabbing; transform: none; }
#hm-grid.hm-editing .hm-card.dragging {
  opacity: .92; cursor: grabbing; border-color: #c9a24b;
  box-shadow: 0 16px 34px rgba(0,0,0,.55), 0 0 0 1px rgba(201,162,75,.5);
  transform: scale(1.02);
}
.hm-card .hm-grip {
  position: absolute; bottom: 12px; right: 13px;
  font: 700 15px/1 Consolas, monospace; color: #8a8478; letter-spacing: -2px;
  pointer-events: none; user-select: none;
}
#hm-grid.hm-editing .hm-card:hover .hm-grip { color: #c9a24b; }
/* drop indicators (PDrag's classes) — a gold bar on the edge the card enters */
#hm-grid.hm-editing .hm-card.drop-before::before,
#hm-grid.hm-editing .hm-card.drop-after::after {
  content: ''; position: absolute; top: 8px; bottom: 8px; width: 3px;
  border-radius: 3px; background: #c9a24b; box-shadow: 0 0 8px rgba(201,162,75,.6);
}
#hm-grid.hm-editing .hm-card.drop-before::before { left: -9px; }
#hm-grid.hm-editing .hm-card.drop-after::after  { right: -9px; }

/* ---- UI Elements drawer: one row per on-screen element (home-ui-elements) ----
 *
 * ⚠ THE DRAWER'S SHARED CONTROL METRIC (2026-08-19 uniformity pass).
 * Rober, on the screenshot: "can we polish this to be more uniform? buttons all
 * in same places, Titles more separated, just better visually." Measured, the
 * drawer had THREE control heights (24 / 34.3 / 38.3 px), action rows landing at
 * three different Y inside one grid row (26 px spread) and icons riding anywhere
 * from 18.9 to 47.6 px down the card. Every pill, button and chip now takes the
 * SAME height from one token, so they read as one family; --hm-ctl-h is the only
 * place to change it. */
.hm-uie-row {
  --hm-ctl-h: 34px;
  --hm-ctl-rad: 9px;
  display: flex; align-items: center; gap: 12px; padding: 11px 10px; border-radius: 9px;
  transition: background 140ms ease;
}
.hm-uie-row:hover { background: rgba(201,162,75,.06); }
.hm-uie-row .hm-uie-ic {
  width: 36px; height: 36px; border-radius: 10px; flex: none;
  display: grid; place-items: center; font-size: 18px;
  background: rgba(255,255,255,.05); color: #cfcabe;
}
.hm-uie-row .hm-uie-t { flex: 1; min-width: 0; }
/* The title used to ellipsize on one line and sit flush against the grey
   sub-line, so the two read as one paragraph. It wraps now (a clipped name is
   never acceptable — Rober's no-truncation law) and owns a real gap under it. */
.hm-uie-row .hm-uie-t b {
  font-weight: 650; font-size: 15.5px; color: #e8e4da; display: block;
  line-height: 1.25; letter-spacing: .2px; margin: 0 0 5px;
  overflow-wrap: anywhere;
}
.hm-uie-row .hm-uie-t span {
  color: #8a8478; font-size: 13px; line-height: 1.45; display: block;
  overflow-wrap: anywhere;
}
.hm-uie-state {
  font: 700 12px/1 Consolas, monospace; flex: none;
  height: var(--hm-ctl-h, 34px); box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 999px; padding: 0 13px; min-width: 56px; text-align: center;
  color: #6f6a5e; background: transparent; border: 1px solid #2e2e36;
}
.hm-uie-state.on  { color: #a9d3a9; background: rgba(120,200,120,.12); border-color: rgba(120,200,120,.32); }
.hm-uie-state.off { color: #c9a2a2; background: rgba(200,120,120,.10); border-color: rgba(200,120,120,.28); }
/* ---- THE THIRD FACE (2026-08-19, round 3) ---------------------------------
   Enabled, but its own show/hide flag is down — nothing is on screen. Rober
   caught the Action Bar reading a flat "ON" in exactly that state
   (enabled=true, visible=false), which parses as "on but broken". Amber, so it
   reads as neither the healthy green nor the switched-off red: a state that
   wants a click, and clicking it shows the thing. Min-width grows because
   "HIDDEN" is six characters against ON's two.

   ⚠ THE CLASS IS `is-hidden`, NEVER `hidden` (2026-08-19). app.css line 10 owns
   the global utility `.hidden { display: none !important; }`, so the original
   `.hm-uie-state.hidden` matched it and the pill was NOT DRAWN AT ALL — measured
   0x0 in chromium. The one row that most needs a switch (enabled, but nothing on
   screen) was the one row with no switch. Never name a modifier `hidden`,
   `open`, `on` or `off` at the top level of this sheet for the same reason. */
.hm-uie-state.is-hidden {
  color: #e0c383; background: rgba(201,162,75,.14); border-color: rgba(201,162,75,.45);
  min-width: 72px;
}
.hm-uie-state.is-hidden.is-btn:hover { color: #f4e6c4; background: rgba(201,162,75,.24); border-color: #c9a24b; }
/* the honest "a RULE is holding it back" line — a condition, not a switch, so
   it is written under the name instead of being faked into the pill.
   It WRAPS: it used to be nowrap+ellipsis and the Super Searcher's real text
   ("No key yet — Config → “Bind a key”, and it opens mid-game") was clipped
   mid-word on screen. */
.hm-uie-row .hm-uie-t .hm-uie-why {
  display: block; margin-top: 6px;
  color: #d8bd85; font-size: 12.5px; line-height: 1.4;
  overflow-wrap: anywhere;
}
/* ---- the pill IS the switch (2026-08-19) ----------------------------------
   Rober: "just make the on or off pill clickable". It is a real <button> when
   the row has a toggle, so it needs the whole set of states a control owes the
   player — hover, active, focus-visible (it is now the ONLY switch on the row,
   so it has to be reachable from the keyboard) — plus a one-shot pop on the
   flip, because the truth arrives asynchronously from the game and a pill that
   sat still for 200ms read as a dead click. */
.hm-uie-state.is-btn { cursor: pointer; font: 700 12px/1 Consolas, monospace; }
.hm-uie-state.is-btn:hover { border-color: #c9a24b; color: #e8e4da; background: rgba(201,162,75,.14); }
.hm-uie-state.is-btn:focus-visible { outline: 2px solid rgba(201,162,75,.55); outline-offset: 2px; }
.hm-uie-state.is-btn:active { transform: scale(.94); }
/* the "we cannot read this one" pill (the Action Bar lives in another view) —
   pressable, but never dressed as a state it does not know */
.hm-uie-state.unk { color: #a79f8c; background: rgba(201,162,75,.07); border-color: rgba(201,162,75,.26); }
.hm-uie-state.is-flip { animation: hmUiePillPop 220ms ease-out; }
@keyframes hmUiePillPop {
  0%   { transform: scale(1); }
  45%  { transform: scale(1.16); }
  100% { transform: scale(1); }
}
/* One height, one radius, one minimum width for every button in the drawer, so
   "Open" (was 60.3px tall 38.3) and "Config →" (84.4 / 38.3) and the ON pill
   (36.4 / 24) stop being three different objects sitting on three baselines. */
.hm-uie-btn {
  font: 600 13px/1 inherit; color: #e8e4da; cursor: pointer; flex: none;
  height: var(--hm-ctl-h, 34px); box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,.03); border: 1px solid #3a3a44;
  border-radius: var(--hm-ctl-rad, 9px);
  padding: 0 14px; min-width: 88px;
  transition: border-color 140ms ease, background 140ms ease, transform 120ms ease;
}
.hm-uie-btn:hover { border-color: #c9a24b; background: rgba(201,162,75,.12); }
.hm-uie-btn:active { transform: translateY(1px); }
.hm-uie-btn.hm-uie-jump { color: #cfcabe; }
/* ⚠ The UI font, not Consolas (2026-08-19 design pass). This chip carries
   PROSE — "Bindable — Utilities tab", "Bindable — Combat tab", "Ctrl + your
   deck key" — not a literal keycap, and setting three sentences in monospace
   put a second typeface in a drawer whose every other word is Segoe UI. The
   state pill keeps its monospace on purpose: ON / OFF / HIDDEN is a status
   readout, and it is consistent across all three faces. */
/* …and it is INFORMATION, not a control: it keeps the family's height and radius
   so it sits on the same baseline as the buttons beside it, but wears a dashed
   hairline over nothing instead of a button's filled plate, and a default
   cursor. Rober's row read "Bindable — Utilities tab" as a third button. */
.hm-uie-chord {
  font: 600 12.5px/1 inherit; color: #8a8478; flex: none;
  height: var(--hm-ctl-h, 34px); box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px dashed #3a3a44; border-radius: var(--hm-ctl-rad, 9px);
  padding: 0 13px; background: transparent; cursor: default; user-select: none;
}
/* ---- UI Elements: the card's action group (2026-08-19 design pass) --------
   ONE home for every control on a card — the state pill, the chord chip and
   every button. They used to be loose children of the wrapping row, so a card
   with two actions put one top-RIGHT and the wrapped one bottom-LEFT under the
   icon: two buttons for one element in opposite corners of its own card, and a
   ragged right edge down the whole grid (measured at 2560 on six of the ten
   cards). `margin-left:auto` keeps the group against the right whether it
   rides line 1 or drops whole to line 2; its own wrap keeps the buttons
   together and right-aligned when the card is narrow.

   2026-08-19: inside the card grid (see #hm-uie-body below) it is no longer a
   flex sibling of the text — it OWNS the card's second grid row, spans both
   columns and is pushed to the card's bottom edge, which is what finally makes
   every action row in a grid row land on one Y. The `margin-left:auto` below
   only matters if a future mount puts this back in a flex row. */
.hm-uie-acts {
  display: flex; align-items: center; justify-content: flex-end;
  flex-wrap: wrap; gap: 8px;
  margin-left: auto; flex: 0 1 auto; min-width: 0;
}

/* The buttons owed the same keyboard state their neighbouring pill already
   had: `.hm-uie-state.is-btn` carries :focus-visible and these did not, so
   tabbing through a card lit the switch and left every Config/Open/Roster
   button with no ring at all. */
.hm-uie-btn:focus-visible { outline: 2px solid rgba(201,162,75,.55); outline-offset: 2px; }

.hm-uie-empty { color: #6f6a5e; font-size: 13.5px; padding: 10px; }

/* ---- Recent drawer ---- */
.hm-drawer { margin-top: 20px; border-top: 1px solid #2e2e36; padding-top: 14px; }
.hm-drawer-head {
  display: flex; align-items: center; gap: 11px; width: 100%;
  background: transparent; border: 0; cursor: pointer; padding: 6px 4px;
  color: #cfcabe; font-family: inherit; text-align: left;
  transition: color 140ms ease;
}
.hm-drawer-head:hover { color: #e8e4da; }
.hm-chev { color: #8a8478; font-size: 13px; transition: transform 160ms ease; flex: none; }
.hm-drawer.open .hm-chev { transform: rotate(90deg); }
.hm-drawer-title { font-size: 16px; font-weight: 650; }
.hm-drawer-count {
  font: 700 12px/1 Consolas, monospace; color: #e0bc6a;
  background: rgba(201,162,75,.12); border: 1px solid rgba(201,162,75,.3);
  border-radius: 999px; padding: 4px 8px;
}
.hm-drawer-count:empty { display: none; }
.hm-drawer-sub { color: #6f6a5e; font-size: 13px; margin-left: auto; }
.hm-drawer-body { padding: 8px 2px 2px; display: flex; flex-direction: column; gap: 2px; }
.hm-rc-row {
  display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 9px;
  cursor: pointer; transition: background 140ms ease;
}
.hm-rc-row:hover { background: rgba(201,162,75,.10); }
.hm-rc-row .hm-rc-ic { width: 26px; height: 26px; border-radius: 7px; flex: none;
  display: grid; place-items: center; font-size: 14px; background: rgba(255,255,255,.05); color: #cfcabe; }
.hm-rc-row .hm-rc-t { flex: 1; min-width: 0; }
.hm-rc-row .hm-rc-t b { font-weight: 600; font-size: 14.5px; color: #e8e4da; display: block;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-rc-row .hm-rc-t span { color: #8a8478; font-size: 12.5px; }
.hm-rc-row .hm-rc-when { color: #6f6a5e; font-size: 12.5px; flex: none; }
.hm-rc-empty { color: #6f6a5e; font-size: 13.5px; padding: 10px; }

/* ---- Notes drawer ---- */
.hm-notes-ta {
  width: 100%; min-height: 160px; resize: vertical; box-sizing: border-box;
  background: rgba(0,0,0,.30); color: #e8e4da;
  border: 1px solid #2e2e36; border-radius: 10px; padding: 12px 13px;
  font: 15px/1.5 inherit; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.hm-notes-ta:focus { border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.15); }
.hm-notes-ta::placeholder { color: #6f6a5e; }

/* ---- Time drawer ---- */
.hm-time-clock { font-size: 30px; font-weight: 700; color: #e8e4da; letter-spacing: .5px; }
.hm-time-date { font-size: 14px; color: #a49d8c; margin: 2px 0 12px; }
.hm-time-group-label {
  font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: #6f6a5e;
  margin: 12px 2px 8px;
}
.hm-time-chips { display: flex; flex-wrap: wrap; gap: 9px; }
.hm-time-chip {
  font: 600 15px/1 inherit; color: #e8e4da; cursor: pointer;
  background: rgba(255,255,255,.03); border: 1px solid #3a3a44; border-radius: 10px;
  padding: 11px 15px;
  transition: border-color 140ms ease, background 140ms ease, transform 120ms ease;
}
.hm-time-chip:hover { border-color: #c9a24b; background: rgba(201,162,75,.12); }
.hm-time-chip:active { transform: translateY(1px); }
.hm-time-chip .hm-time-sub { color: #8a8478; font-size: 12.5px; margin-left: 6px; }

@media (max-width: 760px) {
  #hm-search { height: 52px; } #hm-search-label { font-size: 17px; } #hm-search .hm-search-kbd { display: none; }
  #hm-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 11px; }
  .hm-card { min-height: 112px; padding: 14px; }
  .hm-card .hm-plate { width: 44px; height: 44px; font-size: 22px; }
  /* Open-key card: let the label + Change wrap under the title so nothing
     truncates or overflows at narrow width. */
  #hm-openkey { flex-wrap: wrap; }
  #hm-openkey .hm-ok-body { flex: 1 1 100%; order: 1; }
  #hm-openkey .hm-ok-plate { order: 0; }
  #hm-openkey .hm-ok-key { order: 2; margin-left: 61px; }
  #hm-openkey .hm-ok-btn { order: 3; margin-left: auto; }
}

/* ---- round 3 (2026-08-17): UI elements as a QUICK-CARD listing ---------- *
 * Rober: "home tab - ui elements should have a quick card ui customization
 * listing". The drawer's rows become a responsive card grid — one card per
 * on-screen element, live ON/OFF chip, toggle + place/set-up actions. */
#hm-uie-body {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
  align-items: stretch;   /* a card fills its grid row — heights agree by construction */
}
/* ---- ONE card shape for every element (2026-08-19 uniformity pass) ---------
 * The card was a flex ROW (icon · text · actions) that wrapped, so where the
 * actions fitted beside the text they sat halfway down the card and where they
 * did not they dropped to a second line — three different action-row Y values
 * inside one grid row, measured at 2560. It is a two-row GRID now:
 *
 *     ┌───────┬────────────────────────────┐
 *     │ plate │ Title                      │   row 1: auto  (top-aligned)
 *     │       │ description…               │
 *     ├───────┴────────────────────────────┤
 *     │              [pill] [btn] [btn]    │   row 2: 1fr, contents at its END
 *     └────────────────────────────────────┘
 *
 * Row 2 takes every leftover pixel and its content is `align-self: end`, so a
 * one-line and a three-line description put their buttons on exactly the same
 * baseline. The plate is `align-self: start`, so icons stop floating to the
 * vertical centre of whatever description happens to be beside them.
 * Placement is by grid-area, NOT by child order — the JS still appends
 * icon → text → actions and every selector still reaches them by descent. */
#hm-uie-body .hm-uie-row {
  border: 1px solid rgba(201,162,75,.16); border-radius: 12px;
  background: rgba(255,255,255,.025);
  padding: 15px 15px 14px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  column-gap: 13px; row-gap: 12px;
  align-items: start;
  min-height: 140px;   /* the drawer's uniform floor */
}
#hm-uie-body .hm-uie-row .hm-uie-ic  { grid-column: 1; grid-row: 1; align-self: start; }
#hm-uie-body .hm-uie-row .hm-uie-t   { grid-column: 2; grid-row: 1; }
#hm-uie-body .hm-uie-row .hm-uie-acts {
  grid-column: 1 / -1; grid-row: 2;
  align-self: end; justify-self: stretch;
  margin-left: 0; flex: initial; min-width: 0;
}
#hm-uie-body .hm-uie-row:hover { background: rgba(201,162,75,.07); border-color: rgba(201,162,75,.32); }

/* round 3.1: the UI-element cards feel alive — hover lift + settling chips.
   Transitions only (state-change driven); nothing loops. */
#hm-uie-body .hm-uie-row {
  transition: background 140ms ease, border-color 140ms ease,
              transform 140ms ease, box-shadow 140ms ease;
}
#hm-uie-body .hm-uie-row:hover { transform: translateY(-1px); box-shadow: 0 5px 16px rgba(0, 0, 0, .28); }
#hm-uie-body .hm-uie-row:active { transform: translateY(0); }
.hm-uie-state { transition: background 180ms ease, color 180ms ease, border-color 180ms ease, transform 90ms ease; }
.hm-uie-btn { transition: background 130ms ease, border-color 130ms ease, color 130ms ease, transform 90ms ease; }
.hm-uie-btn:active { transform: translateY(1px); }

/* UI Elements: the configure-in-place expander row (state-driven; home-pane
   renderUie mounts it under its element's row). Unstyled it painted as a bare
   div and contributed to "the settings button does nothing" reading.
   ⚠ RESTORED TO THE FRAG 2026-08-19: this pair had been merged into app.css
   but never written back here, so the frag — the SOURCE — was missing two
   rules the deck actually loads. Nothing rendered changes; the frag simply
   stops lying about what is deployed. */
.hm-uie-inline {
  /* The drawer is a GRID — without the full-row span this panel flowed into
     the NEXT CELL and painted over the neighbouring card ("css is broken
     should be a popout", Rober 2026-08-18). Full-span + popout dressing. */
  grid-column: 1 / -1;
  margin: -2px 0 6px;
  padding: 14px 16px;
  background: linear-gradient(180deg, rgba(16, 17, 22, .97), rgba(10, 11, 15, .97));
  border: 1px solid rgba(201, 162, 75, .45);
  border-radius: 12px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, .55);
}
.hm-uie-inline .fd-hud-row { margin: 0; }

/* ---- UI Elements: the Equipped widget's expander (2026-08-19) ------------
   Rober: the drawer must carry the merged widget's real configuration, not a
   redirect. It is a full-width panel under its row (the drawer is a card
   GRID, so it spans every column), built by home-pane.js buildEqInline.
   (This second block deliberately overrides the one above — same order as
   app.css, so the frag and the sheet resolve identically.) */
.hm-uie-inline {
  grid-column: 1 / -1;
  margin: -2px 0 6px;
  padding: 14px 16px 16px;
  border-radius: 12px;
  border: 1px solid rgba(201, 162, 75, .28);
  background: rgba(201, 162, 75, .05);
}
.hm-eq { display: flex; flex-direction: column; gap: 14px; }
.hm-eq-grp { display: flex; flex-direction: column; gap: 8px; }
.hm-eq-lab {
  font-size: 12.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  color: #8a8478;
}
.hm-eq-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.hm-eq-btn {
  display: inline-flex; align-items: center; gap: 9px;
  font: 600 14px/1 inherit; color: #e8e4da; cursor: pointer;
  background: rgba(255, 255, 255, .03); border: 1px solid #3a3a44;
  border-radius: 10px; padding: 10px 14px;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, transform 90ms ease;
}
.hm-eq-btn:hover { border-color: #c9a24b; background: rgba(201, 162, 75, .12); }
.hm-eq-btn:focus-visible { outline: 2px solid rgba(201, 162, 75, .55); outline-offset: 2px; }
.hm-eq-btn:active { transform: translateY(1px); }
.hm-eq-btn.on { color: #e5c877; border-color: #c9a24b; background: rgba(201, 162, 75, .16); }
.hm-eq-btn.hm-eq-sz { min-width: 46px; justify-content: center; font-size: 15px; }
/* ⚠ NOT `margin-left: auto` (2026-08-19 design pass). The push stranded
   "⚙ Configure on screen" against the far right of a full-deck-width panel —
   ~1,200px from the "⛓ One widget" button it belongs beside at 2560 — while
   every OTHER group in the same panel (Lines · Orientation · Size) is
   left-aligned. One row flinging its second button across the screen is the
   inconsistency, not the separation. It sits in the flow now, with the group's
   own gap; the note under the panel already says what it opens. */
.hm-eq-btn.hm-eq-wide { margin-left: 0; }
.hm-eq-ic {
  width: 22px; height: 22px; flex: none; display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: #c9a24b;
}
.hm-eq-ic img { width: 18px; height: 18px; object-fit: contain; display: block; }
.hm-eq-state {
  font: 700 12.5px/1 Consolas, monospace; border-radius: 999px; padding: 5px 9px;
  color: #6f6a5e; border: 1px solid #2e2e36;
}
.hm-eq-state.on  { color: #a9d3a9; background: rgba(120, 200, 120, .12); border-color: rgba(120, 200, 120, .32); }
.hm-eq-state.off { color: #c9a2a2; background: rgba(200, 120, 120, .10); border-color: rgba(200, 120, 120, .28); }
.hm-eq-state.unk { color: #6f6a5e; }
.hm-eq-val {
  min-width: 62px; text-align: center; font: 700 14px/1 Consolas, monospace; color: #cfcabe;
}
.hm-eq-note { margin: 0; font-size: 13px; line-height: 1.5; color: #8a8478; }
.hm-uie-row .hm-uie-ic img { width: 26px; height: 26px; object-fit: contain; display: block; }
.hm-uie-btn.hm-uie-jump.on { color: #e5c877; border-color: #c9a24b; background: rgba(201, 162, 75, .14); }

/* A row with four actions (the Equipped widget: master · Place · Configure)
   used to squeeze its NAME to "Equippe…" and stack the subtitle into a
   column, because the text block shrank before the buttons wrapped. It cannot
   happen at all now: the text owns its own grid row, the actions own theirs.
   The 2-line floor under the description is what keeps a one-line card and a
   two-line card the same height inside a grid row (2026-08-19). */
#hm-uie-body .hm-uie-row .hm-uie-t { min-width: 0; }
#hm-uie-body .hm-uie-row .hm-uie-t span { display: block; }
#hm-uie-body .hm-uie-row .hm-uie-t > span:first-of-type { min-height: calc(2 * 1.45 * 13px); }
