/* ===================================================================== *
 * Time pane (tm-)  — MERGE this whole file into app.css (banner to next
 * banner), same law as the other panes: the game loads the ASSEMBLED
 * app.css, a deployed .frag alone does nothing.
 * Tokens: --panel-a #1a1a21 · --gold #c9a24b · --gold-line #c9a24b77 ·
 * --sunk #0c0c10 · --raised #16161d · --line #2e2e36 (substituted inline,
 * matching the other panes).
 * ===================================================================== */

#tm-pane { flex: 1; min-height: 0; display: flex; overflow: hidden; }
#tm-pane.hidden { display: none; }
#tm-body {
  flex: 1; min-width: 0; max-width: 720px; margin: 0 auto;
  padding: 22px 26px 16px; display: flex; flex-direction: column; gap: 16px;
  overflow-y: auto;
}

/* ---------- clock card ---------- */
#tm-clock-card {
  position: relative; display: flex; align-items: center; gap: 20px;
  background: linear-gradient(180deg, #16161d 0%, #101015 100%);
  border: 1px solid #3a3a44; border-radius: 14px; padding: 18px 22px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 0 0 1px rgba(201,162,75,.08);
  overflow: hidden;
}
#tm-clock-time {
  font-size: 44px; font-weight: 650; letter-spacing: .5px; color: #f0e6cf;
  font-variant-numeric: tabular-nums; line-height: 1.05;
  transition: color 160ms ease;
}
#tm-clock-date { margin-top: 4px; font-size: 14px; color: #9a917d; }
#tm-clock-card.tm-jumped #tm-clock-time { color: #c9a24b; }

/* day arc: a ring whose dot rides the current hour. Pure decoration, but it
   makes "when am I" legible at a glance — night = dot on the dark half. */
#tm-dial {
  width: 74px; height: 74px; border-radius: 50%; flex: none; position: relative;
  background:
    conic-gradient(from 180deg,
      #14141c 0deg,  #2a3550 60deg,  #c9a24b55 120deg, #d8c07a66 180deg,
      #c9a24b55 240deg, #2a3550 300deg, #14141c 360deg);
  border: 1px solid #3a3a44;
  box-shadow: inset 0 0 18px rgba(0,0,0,.55);
}
#tm-dial::after {
  content: ''; position: absolute; inset: 8px; border-radius: 50%;
  background: #101015; border: 1px solid #26262d;
}
#tm-dial-dot {
  position: absolute; top: 50%; left: 50%; width: 8px; height: 8px; margin: -4px;
  border-radius: 50%; background: #e8d9ab; box-shadow: 0 0 8px #c9a24b;
  transform: rotate(0deg) translateY(-33px);
  transition: transform 420ms cubic-bezier(.3,.7,.3,1); z-index: 1;
}

/* the "+6 h" flash that rides a successful jump */
#tm-jump-flash {
  position: absolute; right: 18px; top: 50%; transform: translateY(-50%);
  font-size: 26px; font-weight: 650; color: #c9a24b; pointer-events: none;
  opacity: 0; transition: opacity 180ms ease;
}
#tm-jump-flash.tm-show { opacity: 1; animation: tmDrift 900ms ease forwards; }
@keyframes tmDrift {
  0%   { opacity: 0; transform: translateY(-30%); }
  25%  { opacity: 1; transform: translateY(-50%); }
  70%  { opacity: 1; transform: translateY(-60%); }
  100% { opacity: 0; transform: translateY(-85%); }
}

/* ---------- groups & chips ---------- */
.tm-group { display: flex; flex-direction: column; gap: 8px; }
.tm-group-label {
  font-size: 11px; letter-spacing: 2.2px; text-transform: uppercase;
  color: #8a8471;
}
.tm-chips { display: flex; flex-wrap: wrap; gap: 10px; }
.tm-chip {
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  min-width: 92px; padding: 10px 14px;
  background: #16161d; color: #d9d2bd;
  border: 1px solid #2e2e36; border-radius: 10px;
  font: inherit; font-size: 15px; cursor: pointer;
  transition: border-color 130ms ease, background 130ms ease, transform 90ms ease;
}
.tm-chip:hover  { border-color: #c9a24b77; background: #1c1c24; }
.tm-chip:focus-visible { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 2px rgba(201,162,75,.25); }
.tm-chip:active { transform: scale(.96); }
.tm-chip[disabled] { opacity: .45; cursor: default; transform: none; }
.tm-chip-sub { font-size: 11px; color: #8a8471; }

/* ---------- custom slider ---------- */
#tm-slider-row { display: flex; align-items: center; gap: 14px; }
#tm-slider { flex: 1; accent-color: #c9a24b; height: 4px; }
#tm-slider-read {
  min-width: 64px; text-align: right; font-size: 20px; font-weight: 600;
  color: #e8d9ab; font-variant-numeric: tabular-nums;
}
#tm-forecast { font-size: 13px; color: #9a917d; min-height: 18px; }
.tm-primary {
  align-self: flex-start; margin-top: 2px; padding: 10px 26px;
  background: linear-gradient(180deg, #c9a24b 0%, #a9853a 100%); color: #17130a;
  border: 0; border-radius: 10px; font: inherit; font-size: 16px; font-weight: 650;
  cursor: pointer; transition: filter 130ms ease, transform 90ms ease;
}
.tm-primary:hover { filter: brightness(1.08); }
.tm-primary:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(201,162,75,.45); }
.tm-primary:active { transform: scale(.97); }
.tm-primary[disabled] { filter: grayscale(.6) brightness(.7); cursor: default; transform: none; }

/* ---------- status + footer ---------- */
#tm-note {
  font-size: 13px; border-radius: 8px; padding: 8px 12px;
  transition: opacity 160ms ease;
}
#tm-note.tm-err { background: rgba(178,58,58,.12); border: 1px solid #b23a3a66; color: #e0a1a1; }
#tm-note.tm-ok  { background: rgba(201,162,75,.10); border: 1px solid #c9a24b44; color: #d8c07a; }
.tm-hiddenish { opacity: 0; pointer-events: none; }
#tm-note:not(.tm-hiddenish) { opacity: 1; }
#tm-foot {
  margin-top: auto; padding-top: 10px; border-top: 1px solid #26262d;
  font-size: 12px; color: #6e6a5d; line-height: 1.5;
}

/* narrow palette: clock stacks, chips stay tappable */
@media (max-width: 700px) {
  #tm-body { padding: 14px 14px 10px; }
  #tm-clock-card { flex-direction: column; text-align: center; gap: 10px; }
  #tm-clock-time { font-size: 34px; }
  #tm-jump-flash { right: 10px; top: 14px; transform: none; }
  .tm-chip { flex: 1 1 40%; }
}
