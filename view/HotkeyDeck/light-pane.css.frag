/* ===================================================================== *
 *  Quick Light card — a live On/Off control shown above the hotkey list
 *  while the Hotkeys "Utilities" category is selected. Built by
 *  light-pane.js into #ql-card.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is #ql-card / li- prefixed, no existing rule is touched and no
 *  token is redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease). Type floor
 *  12px (Rober's no-small-text rule) — the pill and state read large.
 * ===================================================================== */

#ql-card { margin: 0 0 12px; }
#ql-card.hidden { display: none; }

.ql-inner {
  display: flex;
  align-items: center;
  gap: clamp(14px, 3%, 28px);
  flex-wrap: wrap;
  background: #14141a;
  border: 1px solid #2e2e36;
  border-radius: 14px;
  padding: 18px 22px;
}

/* The master pill — the big live toggle */
#ql-card #li-master {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #e8e4da;
  padding: 14px 26px;
  border-radius: 999px;
  border: 2px solid #3a3a44;
  background: #1b1b22;
  cursor: pointer;
  flex: 0 0 auto;
  transition: background 140ms ease, border-color 140ms ease,
              box-shadow 140ms ease, transform 60ms ease;
}
#ql-card #li-glyph { font-size: 24px; filter: grayscale(1) opacity(0.6); transition: filter 140ms ease; }
#ql-card #li-master:hover:not(:disabled) { border-color: #c9a24b; background: #22222b; }
#ql-card #li-master:active:not(:disabled) { transform: scale(0.98); }
#ql-card #li-master:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(201,162,75,0.4); }
#ql-card #li-master:disabled { opacity: 0.5; cursor: default; }

/* ON state: warm gold glow, lit glyph */
#ql-card #li-master.on {
  color: #1a1509;
  background: linear-gradient(180deg, #f0cf70, #d3a63f);
  border-color: #f0cf70;
  box-shadow: 0 0 22px rgba(233,197,91,0.4), inset 0 0 0 1px rgba(255,255,255,0.25);
}
#ql-card #li-master.on #li-glyph { filter: none; }

#li-state-wrap { flex: 1 1 220px; min-width: 180px; display: flex; flex-direction: column; gap: 4px; }
#li-master-state {
  font-size: 15px; font-weight: 700; letter-spacing: 2.5px; color: #8b8676;
  transition: color 140ms ease;
}
#li-master-state.on { color: #e9c55b; }
#ql-card .li-hint { font-size: 13px; line-height: 1.45; color: #9a947f; }
#li-status { font-size: 14px; color: #c3bda6; }
#li-status.warn { color: #e0b36a; }
#li-status.bad { color: #e08a8a; }

/* Explicit On / Off */
#li-actions { display: flex; gap: 12px; flex: 0 0 auto; }
#ql-card .li-btn {
  font-size: 15px;
  font-weight: 700;
  color: #e8e4da;
  padding: 13px 18px;
  border-radius: 11px;
  border: 1px solid #3a3a44;
  background: #1b1b22;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease,
              color 140ms ease, transform 60ms ease;
}
#ql-card .li-btn:hover:not(:disabled) { border-color: #c9a24b; background: #23232c; }
#ql-card .li-btn:active:not(:disabled) { transform: scale(0.98); }
#ql-card .li-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(201,162,75,0.4); }
#ql-card #li-on:hover:not(:disabled) { color: #f0cf70; border-color: #e9c55b; }
#ql-card #li-off:hover:not(:disabled) { color: #e0b36a; }
#ql-card .li-btn:disabled { opacity: 0.4; cursor: default; }
