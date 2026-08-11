/* ===================================================================== *
 *  Loot tab — Loot Highlighter pane for the Hotkey Deck view.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every
 *  selector is lt- prefixed, no existing rule is touched and no token is
 *  redefined. Colours, radii and easing are the deck's own literals
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms ease).
 *  Type floor is 12px (Rober's no-small-text rule, 2026-08-03) — the couch
 *  and the phone both read this.
 *
 *  NOTE (see [[deck-view-css-frag-merge]]): the game loads the ASSEMBLED
 *  app.css. Deploying this .frag alone changes nothing in-game — it has to
 *  be merged into app.css between the previous banner and the next one.
 * ===================================================================== */

#lt-pane { display: flex; min-height: 0; flex: 1; overflow: hidden; }

/* ---------- left rail: master switch + status ---------- */

#lt-side {
  /* proportional, not fixed: the deck resizes down to a 640px floor and a
     media query cannot see the PANEL's width — only the viewport's */
  width: clamp(180px, 28%, 264px); flex: none;
  display: flex; flex-direction: column; gap: 12px;
  padding: 14px 12px;
  border-right: 1px solid #2e2e36;
  background: rgba(0,0,0,.16);
  overflow-y: auto;
}

.lt-card {
  border: 1px solid #2e2e36; border-radius: 10px;
  padding: 12px 13px;
  background: rgba(255,255,255,.02);
}
.lt-card-title {
  font-size: 12px; letter-spacing: .8px; text-transform: uppercase;
  color: #8a8478; margin-bottom: 7px;
}
.lt-hint { font-size: 12.5px; line-height: 1.45; color: #b9b4a8; }

#lt-master {
  width: 100%;
  padding: 14px 12px;
  font-size: 17px; font-weight: 700; font-family: inherit;
  color: #14120e; background: #c9a24b;
  border: 1px solid #e0bc6a; border-radius: 10px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease,
              box-shadow 140ms ease;
}
#lt-master:hover { box-shadow: 0 0 0 3px rgba(201,162,75,.25); }
#lt-master.off {
  color: #b9b4a8; background: rgba(255,255,255,.04); border-color: #2e2e36;
}
#lt-master.off:hover { border-color: #c9a24b; color: #e8e4da; box-shadow: none; }
#lt-master-state {
  margin-top: 8px; text-align: center;
  font-size: 13px; font-weight: 700; letter-spacing: 1.2px; color: #6f6a5e;
}
#lt-master-state.on { color: #ecd9a0; }
#lt-active { margin-top: 8px; text-align: center; }

#lt-lotd-status.ok   { color: #a9d3a9; }
#lt-lotd-status.miss { color: #c88a6a; }

/* ---------- right: category rows ---------- */

#lt-main {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 12px;
  padding: 14px 16px;
  overflow-y: auto;
}

.lt-cat {
  /* WRAPS on purpose: at the deck's 640px floor the swatch strip drops to a
     second line instead of crushing the name to one word per line (the
     Followers quick-card taught this — a non-wrapping row clipped nine
     labels to 0-4px) */
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  border: 1px solid #2e2e36; border-radius: 10px;
  padding: 12px 14px;
  background: rgba(255,255,255,.02);
  transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease;
}
.lt-cat:hover { border-color: #3a3a44; background: rgba(255,255,255,.035); }
.lt-cat.offrow { opacity: .55; }

.lt-cat input[type="checkbox"] { width: 18px; height: 18px; flex: none; cursor: pointer; }

.lt-cat-text { flex: 1 1 240px; min-width: 200px; }
.lt-cat-name {
  font-size: 15px; font-weight: 600; color: #e8e4da;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lt-cat-desc { margin-top: 2px; font-size: 12.5px; color: #9d988c; }

.lt-cat-count {
  flex: none; min-width: 34px; text-align: center;
  font: 700 13px/1 Consolas, "Courier New", monospace;
  color: #d9c48a; background: rgba(201,162,75,.10);
  border: 1px solid rgba(201,162,75,.35); border-radius: 999px;
  padding: 5px 8px;
}
.lt-cat-count.zero { color: #6f6a5e; background: transparent; border-color: #2e2e36; }

/* count + swatch strip travel together so a wrap keeps them one unit */
.lt-cat-side { display: flex; align-items: center; gap: 12px; flex: none; margin-left: auto; }

/* swatch strip: one button per palette colour */
.lt-swatches { display: flex; gap: 7px; flex: none; flex-wrap: wrap; max-width: 260px; }
.lt-sw {
  width: 26px; height: 26px; flex: none;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,.14);
  cursor: pointer; padding: 0;
  transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
.lt-sw:hover { transform: scale(1.18); border-color: rgba(255,255,255,.55); }
.lt-sw.sel {
  border-color: #e8e4da;
  box-shadow: 0 0 0 3px rgba(232,228,218,.22);
}
.lt-sw.dead { opacity: .28; cursor: not-allowed; }
.lt-sw.dead:hover { transform: none; border-color: rgba(255,255,255,.14); }

/* ---------- tuning ---------- */

#lt-settings {
  border: 1px solid #2e2e36; border-radius: 10px;
  padding: 13px 15px 15px;
  background: rgba(255,255,255,.02);
  display: flex; flex-direction: column; gap: 12px;
}
.lt-set-title {
  font-size: 12px; letter-spacing: .8px; text-transform: uppercase;
  color: #8a8478; margin-top: 2px;
}
.lt-field { display: flex; flex-direction: column; gap: 5px; }
.lt-field-label {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 13px; color: #cfcabe;
}
.lt-val { color: #d9c48a; font-family: Consolas, "Courier New", monospace; font-size: 13px; }
.lt-field input[type="range"] { width: 100%; }
.lt-field .lt-hint { font-size: 12px; }

.lt-check {
  display: flex; align-items: center; gap: 10px;
  font-size: 14px; color: #cfcabe; cursor: pointer;
}
.lt-check input { width: 17px; height: 17px; cursor: pointer; }

