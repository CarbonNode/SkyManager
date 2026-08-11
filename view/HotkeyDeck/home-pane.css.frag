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
}
