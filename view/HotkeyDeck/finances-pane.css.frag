/* ===================================================================== *
 *  Finances tab — Financial Manager pane for the Hotkey Deck view.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is fin- prefixed, no existing rule is touched and no token is
 *  redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease), and the
 *  shared @keyframes fadeIn · toastIn · flashFire and the shared
 *  .ghost-btn / .empty-* classes are reused as-is. Income/sell reads green
 *  (#86c98a), expense/buy/debt reads red (#d98a8a).
 * ===================================================================== */

#fin-pane { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; padding: 10px 14px 12px; }

/* ---------- summary bar ---------- */

#fin-summary {
  flex: none;
  display: flex; align-items: stretch; gap: 10px; flex-wrap: wrap;
  margin-bottom: 10px;
}
.fin-stat {
  display: flex; flex-direction: column; gap: 3px; justify-content: center;
  min-width: 92px; padding: 8px 12px;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 8px;
}
.fin-stat-k { font-size: 11.5px; letter-spacing: .4px; text-transform: uppercase; color: #7c776a; }
.fin-stat-v {
  font-family: Consolas, "Courier New", monospace; font-size: 18px; color: #e8e4da; white-space: nowrap;
}
.fin-stat-v.gold { color: #ecd9a0; }
.fin-stat-v.pos { color: #86c98a; }
.fin-stat-v.neg { color: #d98a8a; }

#fin-settle {
  flex: 1; min-width: 150px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  font-family: inherit; letter-spacing: .3px;
  color: #101015; background: linear-gradient(180deg, #d9c48a, #c9a24b);
  border: 1px solid #c9a24b; border-radius: 8px;
  padding: 8px 14px; cursor: pointer;
  transition: filter 140ms ease, transform 100ms ease, box-shadow 140ms ease;
}
#fin-settle .fin-settle-main { font-size: 16px; font-weight: 700; }
#fin-settle .fin-settle-sub { font-family: Consolas, "Courier New", monospace; font-size: 16px; font-weight: 700; opacity: .95; margin-top: 1px; }
#fin-settle:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 4px 16px rgba(201,162,75,.25); }
#fin-settle:active:not(:disabled) { transform: translateY(1px); }
#fin-settle:focus-visible { outline: 2px solid #ecd9a0; outline-offset: 2px; }
#fin-settle:disabled { filter: grayscale(.6) brightness(.7); cursor: not-allowed; }
#fin-settle.flash { animation: flashFire 400ms ease; }

/* ---------- sub-tab nav ---------- */

#fin-nav { flex: none; display: flex; gap: 4px; margin-bottom: 9px; border-bottom: 1px solid #2e2e36; }
.fin-subtab {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: inherit; font-size: 14.5px; letter-spacing: .3px; color: #8b8678;
  background: transparent; border: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  padding: 7px 12px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease;
}
.fin-subtab:hover { color: #ece7db; }
.fin-subtab.active { color: #ecd9a0; border-bottom-color: #c9a24b; }
.fin-subtab:focus-visible { outline: 2px solid #c9a24b66; outline-offset: -2px; }
.fin-subcount {
  font-family: Consolas, "Courier New", monospace; font-size: 11.5px;
  color: #7c776a; background: rgba(255,255,255,.04); border-radius: 9px; padding: 1px 7px;
}
.fin-subtab.active .fin-subcount { color: #d9c48a; background: rgba(201,162,75,.10); }

/* ---------- toolbar ---------- */

#fin-toolbar { flex: none; display: flex; align-items: center; gap: 9px; margin-bottom: 9px; }
#fin-search-wrap { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }
.fin-search-ic { position: absolute; left: 9px; color: #8b8678; font-size: 17px; line-height: 1; pointer-events: none; }
#fin-search {
  width: 100%;
  font-family: inherit; font-size: 15px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 7px;
  padding: 8px 10px 8px 29px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#fin-search::placeholder { color: #6b675e; }
#fin-search:focus { outline: none; border-color: #c9a24b77; box-shadow: 0 0 0 3px rgba(201,162,75,.08); }
#fin-count {
  flex: none;
  font-family: Consolas, "Courier New", monospace; font-size: 12.5px;
  color: #d9c48a; background: rgba(201,162,75,.06);
  border: 1px solid #c9a24b77; border-radius: 20px;
  padding: 4px 9px; min-width: 24px; text-align: center;
}

/* ---------- list ---------- */

#fin-list {
  flex: 1; min-height: 74px;
  overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 4px;
  padding-right: 2px;
}
#fin-list::-webkit-scrollbar, .fin-ctx-grid::-webkit-scrollbar { width: 10px; }
#fin-list::-webkit-scrollbar-track, .fin-ctx-grid::-webkit-scrollbar-track { background: transparent; }
#fin-list::-webkit-scrollbar-thumb, .fin-ctx-grid::-webkit-scrollbar-thumb { background: #2e2e36; border-radius: 5px; }
#fin-list::-webkit-scrollbar-thumb:hover, .fin-ctx-grid::-webkit-scrollbar-thumb:hover { background: #3d3d47; }

/* income / category group headers inside the Recurring list — click to collapse */
.fin-group-head {
  display: flex; align-items: center; gap: 8px;
  margin: 11px 2px 3px; padding: 3px 5px 5px;
  border-bottom: 1px solid #2e2e36; cursor: pointer; user-select: none;
  border-radius: 5px 5px 0 0;
  transition: background 140ms ease, border-color 140ms ease;
}
.fin-group-head:first-child { margin-top: 1px; }
.fin-group-head:hover { background: rgba(201,162,75,.05); border-bottom-color: rgba(201,162,75,.4); }
.fin-group-chev { flex: none; width: 13px; text-align: center; font-size: 11px; color: #8b8678; transition: color 140ms ease; }
.fin-group-head:hover .fin-group-chev { color: #d3c191; }
.fin-group-label { font-size: 12.5px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #d3c191; }
.fin-group-head.inc .fin-group-label { color: #86c98a; }
.fin-group-count { flex: none; font-family: Consolas, "Courier New", monospace; font-size: 11px; color: #7c776a; background: rgba(255,255,255,.04); border-radius: 9px; padding: 1px 7px; }
.fin-group-sum { margin-left: auto; font-family: Consolas, "Courier New", monospace; font-size: 14px; font-weight: 600; }
.fin-group-sum.pos { color: #86c98a; }
.fin-group-sum.neg { color: #d98a8a; }
.fin-group-head.collapsed { opacity: .9; }

.fin-row {
  display: flex; align-items: center; gap: 11px;
  padding: 10px 13px;
  background: #16161d; border: 1px solid #2e2e36; border-radius: 7px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, transform 100ms ease;
}
.fin-row:hover { background: #1d1d25; border-color: rgba(201,162,75,.22); }
.fin-row:active { transform: translateY(1px); }
.fin-row.sel { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.10); }
.fin-row.flash { animation: flashFire 400ms ease; }
/* an owned property reads as "held" — a soft gold left edge */
.fin-row.owned { border-left: 3px solid #c9a24b; }

.fin-medal {
  flex: none; width: 35px; height: 35px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; letter-spacing: .5px;
  color: hsl(var(--fin-hue, 45), 45%, 72%);
  background:
    radial-gradient(120% 120% at 30% 25%, hsla(var(--fin-hue, 45), 45%, 60%, .16), transparent 70%),
    #0c0c10;
  border: 1px solid hsla(var(--fin-hue, 45), 35%, 55%, .45);
  border-radius: 50%;
  overflow: hidden;
}
.fin-medal.img { padding: 0; object-fit: cover; }

.fin-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.fin-name {
  font-size: 16px; color: #ece7db;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fin-name mark { background: transparent; color: #c9a24b; font-weight: 600; }
.fin-subline { display: flex; align-items: baseline; gap: 7px; min-width: 0; font-size: 12.5px; color: #7c776a; }
.fin-note {
  flex-shrink: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #d9c48a; opacity: .8; font-style: italic;
}
.fin-note mark { background: transparent; color: #ecd9a0; font-weight: 600; }
.fin-chip {
  flex: none;
  color: #9b968a; background: rgba(255,255,255,.03);
  border: 1px solid #26262d; border-radius: 9px;
  padding: 2px 9px; font-size: 12px; white-space: nowrap;
  max-width: 190px; overflow: hidden; text-overflow: ellipsis;
}
.fin-chip.cat { color: #d3c191; background: rgba(201,162,75,.09); border-color: #4a4433; font-weight: 600; }
.fin-chip.dom { color: #9aa88b; }
.fin-chip.buyc { color: #d98a8a; border-color: #5a3a3a; }
.fin-chip.sellc { color: #86c98a; border-color: #3a5a3f; }
/* Properties: owned/for-sale state + worth chip */
.fin-chip.owned { color: #e6cf86; background: rgba(201,162,75,.14); border-color: #6a5a2f; font-weight: 700; }
.fin-chip.unowned { color: #9b968a; }
.fin-chip.val { color: #9fb0c0; border-color: #3a4653; }

.fin-row-right { flex: none; display: flex; align-items: center; gap: 8px; }
.fin-amt { font-family: Consolas, "Courier New", monospace; font-size: 15px; font-weight: 600; white-space: nowrap; }
.fin-amt.pos { color: #86c98a; }
.fin-amt.neg { color: #d98a8a; }
.fin-price { font-family: Consolas, "Courier New", monospace; font-size: 14px; color: #b9b4a8; white-space: nowrap; }

.fin-act {
  font-family: inherit; font-size: 12px; letter-spacing: .3px;
  border-radius: 6px; padding: 6px 14px; cursor: pointer;
  border: 1px solid transparent;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 100ms ease;
}
.fin-act:active { transform: translateY(1px); }
.fin-act.buy { color: #e0b0b0; background: rgba(165,85,85,.12); border-color: #5a3a3a; }
.fin-act.buy:hover { background: rgba(165,85,85,.2); border-color: #a55565; }
.fin-act.sell { color: #9fe0ac; background: rgba(90,165,110,.12); border-color: #3a5a3f; }
.fin-act.sell:hover { background: rgba(90,165,110,.2); border-color: #55a56a; }

.fin-icon-btn {
  flex: none; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; color: #6f6a5e;
  background: transparent; border: 1px solid transparent; border-radius: 5px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.fin-icon-btn:hover { background: rgba(255,255,255,.05); color: #e0b0b0; border-color: #a5556588; }

/* ---------- ledger ---------- */

.fin-led-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 11px;
  background: #14141a; border: 1px solid #26262d; border-radius: 7px;
}
.fin-led-kind {
  flex: none; width: 58px; text-align: center;
  font-size: 11px; letter-spacing: .4px; text-transform: uppercase;
  border-radius: 5px; padding: 4px 0; color: #9b968a; background: rgba(255,255,255,.03);
}
.fin-led-kind.k-settle { color: #d9c48a; }
.fin-led-kind.k-buy { color: #d98a8a; }
.fin-led-kind.k-sell { color: #86c98a; }
.fin-led-body { flex: 1; min-width: 0; }
.fin-led-label { font-size: 14px; color: #d9d4c8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fin-led-stamp { font-size: 12px; color: #7c776a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fin-led-delta { flex: none; font-family: Consolas, "Courier New", monospace; font-size: 14.5px; font-weight: 600; }
.fin-led-delta.pos { color: #86c98a; }
.fin-led-delta.neg { color: #d98a8a; }

/* ---------- empty state (reuses .empty-icon/.empty-title/.empty-sub) ---- */

#fin-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 26px 18px; }
#fin-empty .empty-sub { max-width: 380px; margin: 0 auto; line-height: 1.5; }

/* ---------- context menu (edit a line / market item) ---------- */

#fin-ctx {
  position: absolute; z-index: 60; min-width: 320px; max-width: 440px;
  padding: 7px;
  background: linear-gradient(180deg, #1c1c24, #16161d);
  border: 1px solid #c9a24b77; border-radius: 8px;
  box-shadow: 0 16px 44px rgba(0,0,0,.62), 0 0 0 1px rgba(0,0,0,.35);
  animation: fadeIn 110ms ease;
}
.fin-ctx-head {
  font-size: 16px; line-height: 1.3; letter-spacing: .2px; color: #d9c48a;
  padding: 7px 9px 6px; margin-bottom: 4px;
  border-bottom: 1px solid #2e2e36;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fin-ctx-sep { height: 1px; background: #2e2e36; margin: 4px 6px; }
.fin-ctx-sub { font-size: 12px; color: #9b968a; padding: 0 9px 6px; }
.fin-ctx-sub.owned { color: #e6cf86; }
.fin-ctx-field { display: flex; align-items: center; gap: 8px; padding: 4px 6px; }
.fin-ctx-field.icon { flex-direction: column; align-items: stretch; gap: 5px; }
.fin-ctx-field > label {
  flex: none; width: 62px;
  font-size: 13px; letter-spacing: .3px; text-transform: uppercase; color: #6f6a5e;
}
.fin-ctx-input, .fin-ctx-select {
  flex: 1; min-width: 0;
  font-family: inherit; font-size: 15px; color: #e8e4da;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 9px 10px; outline: none;
}
.fin-ctx-input:focus, .fin-ctx-select:focus { border-color: #c9a24b77; box-shadow: 0 0 0 2px rgba(201,162,75,.08); }
.fin-ctx-input::placeholder { color: #6b675e; }
.fin-ctx-select { cursor: pointer; color: #b9b4a8; }

.fin-seg { flex: 1; display: flex; gap: 5px; }
.fin-seg-b {
  flex: 1; font-family: inherit; font-size: 14px; color: #b9b4a8;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 9px 6px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.fin-seg-b:hover { border-color: #c9a24b77; }
.fin-seg-b.on { color: #ecd9a0; background: rgba(201,162,75,.10); border-color: #c9a24b77; }
.fin-seg-b.on.pos { color: #9fe0ac; background: rgba(90,165,110,.12); border-color: #3a5a3f; }
.fin-seg-b.on.neg { color: #e0b0b0; background: rgba(165,85,85,.12); border-color: #5a3a3a; }

.fin-ctx-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  font-family: inherit; font-size: 16px; text-align: left;
  color: #b9b4a8; background: transparent;
  border: 1px solid transparent; border-radius: 6px;
  padding: 11px 10px; cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.fin-ctx-item.danger { color: #e0b0b0; }
.fin-ctx-item.danger:hover { background: #1a1216; }
.fin-ctx-item.danger.confirm { background: #1a1216; border-color: #a55565; box-shadow: inset 0 0 0 1px #a55565; }
.fin-ctx-check { flex: none; width: 17px; text-align: center; font-size: 15px; }
.fin-ctx-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* image field */
.fin-ctx-iconrow { display: flex; align-items: center; gap: 8px; }
.fin-ctx-thumb {
  flex: none; width: 42px; height: 42px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  object-fit: cover; background: #0c0c10; border: 1px solid #3a3a44;
  color: #8b8678; font-size: 13px; font-weight: 700;
}
.fin-ctx-mini {
  font-family: inherit; font-size: 14px; color: #b9b4a8;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px;
  padding: 8px 12px; cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease;
}
.fin-ctx-mini:hover { border-color: #c9a24b77; color: #ece7db; }
.fin-ctx-mini.danger { color: #d98a8a; }
.fin-ctx-mini.danger:hover { border-color: #a55565; }
.fin-ctx-iconhint { font-size: 12.5px; color: #6f6a5e; line-height: 1.4; }
.fin-ctx-grid {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
  max-height: 190px; overflow-y: auto; padding: 4px 2px;
}
.fin-ctx-tile {
  padding: 0; aspect-ratio: 1 / 1; cursor: pointer;
  background: #0c0c10; border: 1px solid #3a3a44; border-radius: 5px; overflow: hidden;
}
.fin-ctx-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fin-ctx-tile:hover { border-color: #c9a24b77; }
.fin-ctx-tile.sel { border-color: #c9a24b; box-shadow: 0 0 0 2px rgba(201,162,75,.15); }

/* ---------- fallback toast (only when the host has no #toast) ---------- */

#fin-toast {
  position: fixed; left: 50%; bottom: 6%; transform: translateX(-50%); z-index: 80;
  background: #16161c; border: 1px solid #c9a24b55; border-radius: 8px;
  color: #e8e4da; font-size: 13px; padding: 9px 18px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  animation: toastIn 160ms ease;
}

/* ---------- narrow viewport (low menu scale / small render target) ---- */

@media (max-width: 620px) {
  #fin-summary { gap: 6px; }
  .fin-stat { min-width: 74px; padding: 6px 9px; }
  .fin-stat-v { font-size: 15px; }
  #fin-settle { min-width: 120px; }
  .fin-chip { max-width: 120px; }
}
