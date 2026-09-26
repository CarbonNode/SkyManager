/* ===================================================================== *
 *  OStim segment of the Animations tab — scene search / change / control.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: every selector
 *  is os- prefixed (plus the #an-seg / #an-row / #an-pane.mode-ostim rules that
 *  turn the Animations tab into a two-segment column). Deck literals only
 *  (#c9a24b gold / #e8e4da text / #2e2e36 lines / 140ms / 12px type floor).
 *
 *  NOTE (see [[deck-view-css-frag-merge]]): the game loads the ASSEMBLED
 *  app.css. Deploying this .frag alone changes nothing — merge it into app.css
 *  between the previous banner and the next one.
 * ===================================================================== */

/* ---- Animations tab becomes a column: [segmented toggle][content] ---- */
/* #an-pane was `display:flex` (row). It is now a column; the old row lives
   inside #an-row so the Poses layout is byte-for-byte unchanged. */
#an-pane { flex-direction: column; }
#an-row  { flex: 1; min-height: 0; display: flex; overflow: hidden; }

#an-seg {
  /* wraps: with the pane's own MAX_TABS=12 custom tabs the single nowrap line
     flex-shrank every button to a 44-64px stub ("B…", "T…") at both 1280x720
     and 2560x1440. A second row of full-width tabs beats a row of initials. */
  flex: none; display: flex; flex-wrap: wrap; gap: 6px;
  padding: 10px 12px 0;
}
.an-seg-btn {
  flex: none;                      /* never shrink a label to initials */
  padding: 9px 20px;
  font: 600 14px/1 inherit; color: #b8b3a7;
  background: rgba(255,255,255,.03);
  border: 1px solid #2e2e36; border-radius: 9px 9px 0 0; border-bottom: none;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.an-seg-btn:hover { background: rgba(201,162,75,.10); color: #e8e4da; }
.an-seg-btn.active { color: #14120e; background: #c9a24b; border-color: #e0bc6a; }

/* mode switch: show one body, hide the other */
#os-body { display: none; }
#an-pane.mode-ostim #an-row { display: none; }
#an-pane.mode-ostim #os-body { display: flex; }

/* ---------------------------------------------------- OStim body ---- */
#os-body {
  flex: 1; min-height: 0;
  flex-direction: column; gap: 12px;
  padding: 14px 16px;
}

/* status header */
#os-status {
  flex: none;
  display: flex; flex-direction: column; gap: 10px;
  padding: 13px 15px;
  border: 1px solid #2e2e36; border-radius: 11px;
  background: rgba(255,255,255,.02);
}
#os-status-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
#os-scene { font-size: 18px; font-weight: 700; color: #e8e4da; }
#os-scene-hint { font-size: 13px; color: #9d988c; }
#os-body.os-outscene #os-scene { color: #b8b3a7; }

#os-actors { display: flex; gap: 7px; flex-wrap: wrap; }
.os-actor {
  font-size: 13px; font-weight: 600; color: #e8e4da;
  padding: 4px 11px; border-radius: 999px;
  border: 1px solid #2e2e36; background: rgba(255,255,255,.04);
}
.os-actor.f { border-color: rgba(255,105,180,.4); color: #ffc8e2; background: rgba(255,105,180,.08); }
.os-actor.m { border-color: rgba(30,144,255,.4); color: #bfe0ff; background: rgba(30,144,255,.08); }

/* live control row */
#os-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.os-ctl {
  padding: 8px 13px;
  font: 600 13px/1 inherit; color: #e8e4da;
  background: rgba(255,255,255,.04);
  border: 1px solid #2e2e36; border-radius: 8px; cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, color 140ms ease, box-shadow 140ms ease;
}
.os-ctl:hover:not(:disabled) { border-color: #c9a24b; background: rgba(201,162,75,.10); }
.os-ctl:disabled { opacity: .45; cursor: not-allowed; }
.os-ctl.on { color: #14120e; background: #c9a24b; border-color: #e0bc6a; }
.os-ctl.warn:hover:not(:disabled) { border-color: #c85046; background: rgba(200,80,70,.12); }
.os-speed { display: inline-flex; align-items: center; gap: 8px; }
#os-speed-val {
  min-width: 52px; text-align: center;
  font: 700 14px/1 Consolas, "Courier New", monospace; color: #ecd9a0;
}
.os-ctl-sep { width: 1px; align-self: stretch; background: #2e2e36; margin: 2px 4px; }
.os-ctl-label { font-size: 12px; color: #8a8478; letter-spacing: .5px; text-transform: uppercase; }

/* search + list */
#os-searchbar { display: flex; align-items: center; gap: 12px; flex: none; }
#os-search {
  flex: 1; min-width: 0;
  padding: 11px 13px;
  font-size: 15px; font-family: inherit; color: #e8e4da;
  background: rgba(0,0,0,.25); border: 1px solid #2e2e36; border-radius: 9px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
#os-search::placeholder { color: #7f7a6e; }
#os-search:focus { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 3px rgba(201,162,75,.18); }
.os-count { flex: none; font-size: 13px; color: #9d988c; font-family: Consolas, "Courier New", monospace; }

#os-list {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  padding-right: 2px;
}
.os-row {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px;
  border: 1px solid #2e2e36; border-radius: 9px;
  background: rgba(255,255,255,.02);
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease;
}
.os-row:hover { border-color: #3a3a44; background: rgba(255,255,255,.045); }

/* Position pictogram on a browse row (2026-09-21). Matched by keyword from
   OstimTools.positionIcon — ONE table, not a second copy here. Unmatched
   scenes reserve the same slot (.os-pos-none) so the names stay in a column
   instead of stepping left and right down the list. */
.os-pos { width: 54px; height: 36px; flex: 0 0 54px; object-fit: contain; }
.os-pos-none { display: block; }
.os-row.incompat .os-pos { opacity: .7; }

.os-row.top { border-color: rgba(201,162,75,.4); }
.os-row.incompat { opacity: .5; cursor: default; }
.os-row.incompat:hover { border-color: #2e2e36; background: rgba(255,255,255,.02); }

.os-row-main { flex: 1; min-width: 0; }
.os-row-name {
  font-size: 15px; font-weight: 600; color: #e8e4da;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.os-row-meta { margin-top: 2px; font-size: 12px; color: #9d988c; }

.os-go {
  flex: none; min-width: 78px;
  padding: 8px 16px;
  font: 700 13px/1 inherit; color: #14120e; background: #c9a24b;
  border: 1px solid #e0bc6a; border-radius: 8px; cursor: pointer;
  transition: box-shadow 140ms ease, background 140ms ease;
}
.os-go:hover:not(:disabled) { box-shadow: 0 0 0 3px rgba(201,162,75,.25); }
.os-go:disabled {
  color: #8a8478; background: rgba(255,255,255,.04); border-color: #2e2e36;
  cursor: not-allowed; box-shadow: none;
}

.os-empty, .os-more { padding: 18px 12px; text-align: center; color: #9d988c; font-size: 13px; }
.os-more { color: #7f7a6e; font-size: 12.5px; }

/* toast (shares the an-toast placement idiom) */
.os-toast {
  position: absolute; left: 50%; bottom: 14px; transform: translate(-50%, 12px);
  padding: 9px 16px;
  font-size: 13.5px; color: #14120e; background: #c9a24b;
  border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
  opacity: 0; pointer-events: none;
  transition: opacity 160ms ease, transform 160ms ease;
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.os-toast.show { opacity: 1; transform: translate(-50%, 0); }
.os-toast.bad { background: #c85046; color: #fff; }

/* Row portraits (2026-09-22). The hero cast strip had faces from the start,
   but Add & remove and The room listed people as bare text — Rober, looking
   at both: "isnt showing profile pics". Same picture() helper, smaller, and
   the ids are reported through portraitIds() so the renders are COLLECTED
   as well as asked for (the faceConsumerActive law). */
.ost-row .ost-face{width:56px;height:56px;flex:0 0 56px;}
.ost-cast-chip .ost-face{width:46px;height:46px;flex:0 0 46px;}
.ost-cast-chip>span:not(.ost-face){flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}
@media (max-width:900px){
  .ost-row .ost-face{width:48px;height:48px;flex:0 0 48px;}
  .ost-cast-chip .ost-face{width:40px;height:40px;flex:0 0 40px;}
}

/* Hold & resume here (2026-09-22) — the SexLab-style relocate. A section,
   not another card in the furniture list: it is a different kind of move,
   and it reads as one. */
.ost-hold{margin-top:22px;padding:20px;border:1px solid #6d6047;border-left:4px solid #d0ad53;border-radius:12px;background:rgba(255,255,255,.02);}
.ost-hold h3{margin:0 0 12px;font-size:22px;color:#f0dda6;}
.ost-hold .ost-status{margin:0 0 14px;}
.ost-hold .ost-toolbar{margin-top:16px;}

/* The hero's two bands (2026-09-22). Rober: "Free camera and manual buttons
   kinda ugly ... just visually the UI is bad". The controls used to hang off
   the bottom of the middle column, leaving dead space beside them and making
   each one a differently-sized orphan pill. */
.ost-hero-top{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr) minmax(0,auto);gap:28px;align-items:center;}
/* Equal cells, flush edge to edge, one row — no ragged wrapping and no
   dangling odd item, whatever the labels say. */
.ost-hero-dock{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:14px;}
.ost-dock-cell{display:flex;align-items:center;justify-content:center;gap:16px;min-height:84px;
  padding:14px 18px;border:1px solid #514735;border-radius:12px;background:rgba(255,255,255,.025);}
.ost-hero-dock .ost-button,.ost-hero-dock .ost-mode{width:100%;justify-content:center;min-height:56px;}
.ost-hero-dock .ost-speed-ctl .ost-button{width:auto;min-width:64px;}
.ost-hero[data-live="false"] .ost-dock-cell{opacity:.55;}
@media (max-width:1100px){
  .ost-hero-dock{grid-auto-flow:row;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));grid-auto-columns:auto;}
}

/* The page's own two search bars (2026-09-22). An equal pair, flush — one
   searches this page's controls (Ctrl K), one searches OStim's animations. */
.ost-find{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:4px 0 8px;}
.ost-find-one{position:relative;min-width:0;}
.ost-find-input{width:100%;box-sizing:border-box;font-size:20px;padding:15px;min-width:0;
  background:#101014;color:#eee7db;border:1px solid #75613c;border-radius:8px;}
.ost-find-input:focus{outline:2px solid #d0ad53;outline-offset:2px;}
.ost-find-drop{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:12;
  max-height:420px;overflow:auto;padding:10px;border:1px solid #75613c;border-radius:12px;background:#15151b;}
.ost-find-drop[hidden]{display:none;}
.ost-find-row{display:flex;align-items:center;gap:14px;width:100%;text-align:left;
  padding:12px 14px;border:1px solid transparent;border-radius:9px;background:none;color:#eee7db;
  font:inherit;cursor:pointer;}
.ost-find-row:hover,.ost-find-row[data-on="true"]{background:#514326;border-color:#d0ad53;}
.ost-find-text{display:flex;flex-direction:column;gap:4px;min-width:0;}
.ost-find-text strong{font-size:20px;overflow-wrap:anywhere;}
.ost-find-text small{font-size:17px;color:#bdb5a6;}
@media (max-width:900px){ .ost-find{grid-template-columns:1fr;} }

/* =====================================================================
   SCENE PAGE — the design pass (2026-09-22)

   Rober, after three rounds of structural fixes: "spruced up the UI so
   everything looks thoguht through and not just thrown around ugly
   buttons?"

   The structure was the part I kept fixing. The LOOK was the actual
   complaint, and the cause is one thing: every control on the page was
   the identical grey slab. Twelve launcher tiles, the row actions, the
   dock, the popout buttons — same fill, same border, same weight. With
   nothing louder than anything else the eye has nowhere to land, and a
   page like that reads as thrown together however tidily it is arranged.

   DIRECTION — "lamplit ledger". The deck's existing charcoal and gold,
   used with a hierarchy instead of uniformly:

     · ONE gold-filled control per surface — the thing you came to press.
       Everything else is an outline on the page's own charcoal.
     · Weight comes from a hairline top highlight (inset), not from drop
       shadows: this engine paints big shadows as slabs, and the repo has
       a pre-commit check that refuses them.
     · Icons sit in a tinted well rather than floating loose above a
       label, which is what makes a tile read as an object.
     · Section headings are a lettered rule, so a popout has a spine.

   Ultralight rules observed throughout: explicit rgba (never
   color-mix), no conic-gradient, grid-auto-rows on definite-height
   grids, and min-height on overflow:hidden grid items.
   ===================================================================== */

/* ---- 1. the type scale, so headings stop competing with controls ---- */
.ost-card .ost-head h2{font-size:34px;letter-spacing:.01em;}
.ost-card h3{
  font-size:15px;letter-spacing:.14em;text-transform:uppercase;
  color:#b6a887;margin:26px 0 14px;padding-bottom:10px;
  border-bottom:1px solid rgba(109,96,71,.55);
}
.ost-card h3:first-child{margin-top:0;}

/* ---- 2. button ROLES — the whole point of the pass ------------------ */
/* Default: quiet. It is an outline on the page, not a filled slab. */
.ost-button,.ost-person,.ost-option{
  background:rgba(255,255,255,.028);
  border-color:rgba(122,107,78,.85);
  transition:none;                      /* Ultralight: no compositor */
}
.ost-button:hover,.ost-person:hover,.ost-option:hover{
  background:rgba(208,173,83,.14);border-color:#c2a259;
}
/* THE action. One per surface — gold fill, dark ink, so it reads first. */
.ost-button[data-primary="1"]{
  background:#d0ad53;border-color:#e4c570;color:#17161b;font-weight:600;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28);
}
.ost-button[data-primary="1"]:hover{background:#e0bd63;border-color:#f0dda6;}
.ost-button[data-primary="1"]:disabled{
  background:rgba(208,173,83,.22);color:#cbbd9a;box-shadow:none;
}
/* Destructive: never filled until it is armed. */
.ost-button.ost-danger{
  background:rgba(140,74,66,.14);border-color:rgba(160,88,78,.9);color:#e6b5ab;
}
.ost-button.ost-danger:hover{background:rgba(160,88,78,.3);border-color:#c06a5c;}

/* ---- 3. the launcher tiles — objects, not boxes with a glyph -------- */
.ost-tabs{grid-template-columns:repeat(auto-fit,minmax(164px,1fr));gap:14px;}
.ost-tabs .ost-button{
  min-height:126px;padding:20px 12px 18px;gap:14px;font-size:18px;
  background:rgba(255,255,255,.022);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
}
/* The well is what makes it read as a thing rather than a label. */
.ost-tabs .ost-icon{
  width:34px;height:34px;flex:0 0 34px;
  box-sizing:content-box;padding:13px;border-radius:50%;
  background:rgba(208,173,83,.1);border:1px solid rgba(146,129,92,.55);
}
.ost-tabs .ost-button:hover .ost-icon{
  background:rgba(208,173,83,.22);border-color:#c2a259;
}
.ost-tabs .ost-button[aria-pressed="true"]{
  background:rgba(81,67,38,.72);border-color:#d0ad53;
}
.ost-tabs .ost-button[aria-pressed="true"] .ost-icon{
  background:rgba(208,173,83,.3);border-color:#e4c570;
}

/* ---- 4. surfaces: raised by a light edge, not by a shadow ----------- */
.ost-hero,.ost-dock-cell,.ost-hold,.ost-find-drop{
  box-shadow:inset 0 1px 0 rgba(255,255,255,.055);
}
.ost-hero-title{letter-spacing:.005em;}
.ost-chip{
  background:rgba(208,173,83,.1);border:1px solid rgba(146,129,92,.6);
  border-radius:999px;padding:9px 16px;font-size:18px;color:#e6dcc4;
}
.ost-chip[data-kind="furn"]{background:rgba(255,255,255,.03);color:#cfc6b4;}

/* ---- 5. rows: the action carries the weight, the row does not ------- */
.ost-row{
  border-color:rgba(69,64,75,.9);
  background:rgba(255,255,255,.015);
}
.ost-row[data-state="refused"]{border-left:3px solid rgba(160,88,78,.85);}
.ost-row[data-state="ok"]{border-left:3px solid rgba(122,150,96,.7);}

/* ---- 6. the dock reads as one instrument, not four buttons ---------- */
.ost-hero-dock{gap:12px;}
.ost-dock-cell{background:rgba(255,255,255,.022);border-color:rgba(81,71,53,.95);}
.ost-speed-bar[data-on="true"]{background:#e4c570;}

@media (max-width:1100px){
  .ost-tabs{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));}
  .ost-tabs .ost-button{min-height:112px;font-size:17px;}
  .ost-card .ost-head h2{font-size:28px;}
}

/* =====================================================================
   SCENE PAGE — the composition (2026-09-22, "the best fable can do")

   Rober: "make the UI really nice and fun and better UX please. try to
   remove blank space, or fill areas with containers or docks, try not to
   overuse cards, just really spend some time on it for this page."

   What was wrong with the resting page, in order of how much it hurt:
     1. eleven identical tiles in an auto-fit grid — nine on one row, two
        dangling on the next, then nothing but blank page underneath;
     2. two search bars across the top before you had seen the scene;
     3. a status sentence and a note sentence repeating what the hero shows,
        each reserving a line whether or not it had anything to say.

   The composition now: the hero (the scene, seen), then FOUR docks in
   equal columns — People / Place / Look / Library — each a titled
   container of full-width rows that say what is inside them, then a Quick
   strip of five direct actions. Nothing dangles, nothing is blank, and the
   only "card" left is the hero. Everything else is a dock: a bordered
   region with a title rule, holding rows, not a stack of boxed buttons.
   ===================================================================== */

/* ---- header: the title, and the control search beside it ------------ */
.ost-head{display:flex;align-items:center;justify-content:space-between;gap:24px;margin:0 0 16px;}
.ost-head h2{margin:0;flex:0 1 auto;}
.ost-head .ost-find{flex:0 1 460px;min-width:260px;margin:0;}
.ost-head .ost-find-input{font-size:18px;padding:13px 16px;}

/* ---- status + note: captions, and GONE when empty ------------------- */
.ost-card>.ost-status{font-size:17px;color:#9c948a;margin:10px 4px 0;}
.ost-card>.ost-note{min-height:0;margin:6px 4px 0;font-size:17px;color:#bdb5a6;}
.ost-card>.ost-status:empty,.ost-card>.ost-note:empty{display:none;}

/* ---- the hero art gets the room it was leaving empty ------------------ */
.ost-hero-art .ost-pos-hero{width:216px;height:144px;}

/* ---- the four docks --------------------------------------------------- */
.ost-tabs.ost-docks{
  display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:auto;
  gap:16px;margin:20px 0 0;padding:0;border:0;
}
.ost-dock{
  display:flex;flex-direction:column;gap:10px;min-width:0;
  padding:16px 16px 18px;border:1px solid rgba(81,71,53,.95);border-radius:14px;
  background:rgba(255,255,255,.018);box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
}
.ost-dock-title{
  display:flex;flex-direction:column;gap:3px;padding:2px 4px 10px;margin-bottom:4px;
  border-bottom:1px solid rgba(109,96,71,.55);
}
.ost-dock-title strong{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#d6c08a;}
.ost-dock-title small{font-size:17px;color:#9c948a;}

/* rows — these override the free-standing tile rules from the earlier pass */
.ost-tabs.ost-docks .ost-button{
  flex-direction:row;justify-content:flex-start;align-items:center;text-align:left;
  width:100%;box-sizing:border-box;min-height:0;height:auto;padding:11px 14px;gap:14px;
  font-size:19px;background:rgba(255,255,255,.02);box-shadow:none;
}
.ost-tabs.ost-docks .ost-button:hover{background:rgba(208,173,83,.12);}
.ost-tabs.ost-docks .ost-button[aria-pressed="true"]{background:rgba(81,67,38,.72);border-color:#d0ad53;}
.ost-seg-well{
  display:flex;align-items:center;justify-content:center;
  width:52px;height:52px;flex:0 0 52px;border-radius:50%;
  background:rgba(208,173,83,.1);border:1px solid rgba(146,129,92,.55);
}
.ost-tabs.ost-docks .ost-icon{
  width:26px;height:26px;flex:0 0 26px;padding:0;border:0;border-radius:0;background:none;box-sizing:border-box;
}
.ost-tabs.ost-docks .ost-button:hover .ost-seg-well,
.ost-tabs.ost-docks .ost-button[aria-pressed="true"] .ost-seg-well{
  background:rgba(208,173,83,.28);border-color:#d0ad53;
}
.ost-seg-text{display:flex;flex-direction:column;gap:3px;min-width:0;}
.ost-seg-label{font-size:19px;color:#eee7db;line-height:1.2;}
.ost-seg-text small{font-size:17px;color:#a59d8f;line-height:1.3;overflow-wrap:anywhere;}

/* the Library dock's third row is the animation search, pinned to the bottom */
.ost-dock-search{margin-top:auto;padding-top:4px;}
.ost-dock-search .ost-find-input{font-size:18px;padding:13px 14px;}

/* ---- the Quick strip: five direct actions, equal cells --------------- */
.ost-quick{
  margin:16px 0 0;padding:16px 16px 18px;border:1px solid rgba(81,71,53,.95);border-radius:14px;
  background:rgba(255,255,255,.018);box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
}
.ost-quick .ost-dock-title{flex-direction:row;align-items:baseline;gap:14px;}
.ost-quick-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-top:12px;}
.ost-quick-strip .ost-button{justify-content:center;min-height:62px;width:100%;box-sizing:border-box;}

@media (max-width:1400px){
  .ost-tabs.ost-docks{grid-template-columns:repeat(2,minmax(0,1fr));}
  .ost-quick-strip{grid-template-columns:repeat(3,minmax(0,1fr));}
  .ost-head .ost-find{flex-basis:380px;}
}
@media (max-width:900px){
  .ost-tabs.ost-docks{grid-template-columns:1fr;}
  .ost-quick-strip{grid-template-columns:1fr 1fr;}
  .ost-head{flex-direction:column;align-items:stretch;}
  .ost-head .ost-find{min-width:0;flex-basis:auto;}
}

/* The status sentence is what a screen reader announces; on screen the hero
   already says every word of it, so it takes no room. */
.ost-card>.ost-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);margin:0;padding:0;}

/* =====================================================================
   SCENE PAGE — best use of the width (2026-09-22)
   "try to make best use of space, not too much scrolling"
   The resting page stacked hero / docks / quick and scrolled at 1440p
   under --ui-scale. It is two columns now: LIVE (hero + Quick) at 5/12,
   the four docks in a 2x2 at 7/12. Heights match, nothing scrolls.
   ===================================================================== */
.ost-page{display:grid;grid-template-columns:minmax(500px,5fr) minmax(0,7fr);gap:16px;align-items:stretch;margin-top:4px;}
.ost-page-live{display:flex;flex-direction:column;gap:16px;min-width:0;}
.ost-page-live .ost-hero{margin:0;}
.ost-page .ost-tabs.ost-docks{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:1fr;margin:0;}

/* the hero, compacted for a column */
.ost-page-live .ost-hero{padding:18px 20px;gap:16px;}
.ost-page-live .ost-hero-top{gap:18px;}
.ost-page-live .ost-hero .ost-face{width:72px;height:72px;flex:0 0 72px;}
.ost-page-live .ost-hero-title{font-size:26px;}
.ost-page-live .ost-hero-art .ost-pos-hero{width:168px;height:112px;}
/* the live dock is 2x2 in a column: speed | pacing / free camera | stop */
.ost-page-live .ost-hero-dock{grid-auto-flow:row;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-columns:auto;gap:10px;}
.ost-page-live .ost-dock-cell{min-height:64px;padding:10px 12px;}
.ost-page-live .ost-hero-dock .ost-button,.ost-page-live .ost-hero-dock .ost-mode{min-height:46px;}
.ost-speed-bars{gap:4px;}

/* Quick is a dock of rows, the same anatomy as the other four */
.ost-quick{margin:0;flex:1 1 auto;display:flex;flex-direction:column;}
.ost-quick .ost-dock-title{flex-direction:column;align-items:stretch;gap:3px;}
.ost-quick-strip{display:flex;flex-direction:column;gap:8px;margin-top:8px;}
.ost-quick-row{
  display:flex;flex-direction:row;justify-content:flex-start;align-items:center;text-align:left;
  width:100%;box-sizing:border-box;min-height:0;padding:9px 12px;gap:12px;font-size:19px;
  background:rgba(255,255,255,.02);
}
.ost-quick-row .ost-seg-well{width:44px;height:44px;flex:0 0 44px;}
.ost-quick-row .ost-icon{width:22px;height:22px;flex:0 0 22px;padding:0;border:0;background:none;border-radius:0;}
.ost-quick-row:hover .ost-seg-well{background:rgba(208,173,83,.28);border-color:#d0ad53;}

/* dock rows a touch tighter so 3 rows + title match half the live column */
.ost-tabs.ost-docks .ost-button{padding:9px 12px;gap:12px;}
.ost-tabs.ost-docks .ost-seg-well{width:46px;height:46px;flex:0 0 46px;}
.ost-tabs.ost-docks .ost-icon{width:23px;height:23px;flex:0 0 23px;}
.ost-dock{padding:14px 14px 16px;gap:8px;}

@media (max-width:1500px){
  .ost-page{grid-template-columns:1fr;}
  .ost-page .ost-tabs.ost-docks{grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:auto;}
  .ost-page-live .ost-hero-dock{grid-template-columns:repeat(4,minmax(0,1fr));}
  .ost-quick-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));}
}
@media (max-width:1100px){
  .ost-page .ost-tabs.ost-docks{grid-template-columns:repeat(2,minmax(0,1fr));}
  .ost-page-live .ost-hero-dock{grid-template-columns:repeat(2,minmax(0,1fr));}
  .ost-quick-strip{grid-template-columns:repeat(2,minmax(0,1fr));}
}

/* ---- polish pass 3 (2026-09-22): popout chrome, segmented choosers ------ */
.ost-pop-card{border:1px solid #b69b56;border-top:3px solid #d0ad53;border-radius:18px;background:#19191f;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
.ost-pop-titles{display:flex;align-items:center;gap:16px;min-width:0;}
.ost-pop-well{width:54px;height:54px;flex:0 0 54px;background:rgba(208,173,83,.16);border-color:#c2a259;}
.ost-pop-well .ost-icon{width:26px;height:26px;flex:0 0 26px;}
.ost-pop-sub{margin:10px 0 0 70px;color:#a59d8f;}
.ost-pop-head{padding-bottom:14px;border-bottom:1px solid rgba(109,96,71,.5);}
.ost-pop-body{margin-top:18px;}

/* a segmented chooser: one control, several positions — not N loose pills */
.ost-segmented{display:inline-flex;align-items:stretch;border:1px solid rgba(122,107,78,.9);border-radius:10px;overflow:hidden;background:rgba(255,255,255,.02);}
.ost-segmented .ost-button{border:0;border-radius:0;background:transparent;min-height:50px;padding:12px 18px;}
.ost-segmented .ost-button+.ost-button{border-left:1px solid rgba(122,107,78,.7);}
.ost-segmented .ost-button:hover{background:rgba(208,173,83,.12);}
.ost-segmented .ost-button[aria-pressed="true"]{background:#514326;color:#f0dda6;box-shadow:inset 0 1px 0 rgba(255,255,255,.08);}
.ost-toolbar{gap:12px;align-items:center;}

/* the furniture chip carries its glyph */
.ost-chip{display:inline-flex;align-items:center;gap:8px;}
.ost-chip-icon{width:18px;height:18px;flex:0 0 18px;opacity:.85;}

/* pressed / disabled states everywhere read the same */
.ost-button:disabled{opacity:.42;}
.ost-button:focus-visible,.ost-find-input:focus-visible,.ost-tab:focus-visible{outline:2px solid #d0ad53;outline-offset:2px;}

/* =====================================================================
   SCENE PAGE — the component vocabulary (2026-09-22)
   Rober: "spend some real time on this, all the buttons, modal popouts,
   UX improvements". Four instruments every popout is now built from.
   ===================================================================== */

/* ---- sub-tabs inside a popout: equal cells, full width ---------------- */
.ost-subtabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:0;margin:16px 0 18px;
  border:1px solid rgba(122,107,78,.9);border-radius:12px;overflow:hidden;background:rgba(255,255,255,.02);}
.ost-subtab{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;padding:10px 12px;
  font:inherit;font-size:19px;color:#cfc6b4;background:transparent;border:0;cursor:pointer;}
.ost-subtab+.ost-subtab{border-left:1px solid rgba(122,107,78,.7);}
.ost-subtab .ost-icon{width:22px;height:22px;flex:0 0 22px;opacity:.85;}
.ost-subtab:hover{background:rgba(208,173,83,.12);color:#eee7db;}
.ost-subtab[aria-selected="true"]{background:#514326;color:#f0dda6;box-shadow:inset 0 -3px 0 #d0ad53;}
.ost-subtab:focus-visible{outline:2px solid #d0ad53;outline-offset:-2px;}

/* one panel at a time */
.ost-subject{display:block;margin-top:0;}
.ost-subject>[data-panel][data-on="false"]{display:none;}
.ost-subject>[data-panel]{margin:0;}
.ost-panel-body{display:flex;flex-direction:column;gap:16px;}

/* ---- person tabs: the cast, switchable, inside a popout --------------- */
.ost-persons{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px;margin:0 0 14px;}
.ost-person-tab{display:flex;align-items:center;justify-content:flex-start;gap:12px;min-width:0;
  padding:8px 12px;min-height:60px;text-align:left;}
.ost-person-tab .ost-face{width:44px;height:44px;flex:0 0 44px;}
.ost-person-tab .ost-person-name{font-size:19px;overflow-wrap:anywhere;}
.ost-person-tab[aria-pressed="true"]{background:rgba(81,67,38,.72);border-color:#d0ad53;}

/* ---- the status strip: readout + the four direct actions --------------- */
.ost-strip{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 6px;
  padding:12px 14px;border:1px solid rgba(81,71,53,.95);border-radius:12px;background:rgba(255,255,255,.018);}
.ost-strip-readout{margin:0 6px 0 2px;font-size:19px;color:#dbc17a;flex:0 0 auto;}
.ost-strip .ost-button{min-height:48px;padding:10px 16px;}

/* ---- setting rows: label + line left, instrument right ----------------- */
.ost-settings{display:flex;flex-direction:column;gap:10px;margin:8px 0 12px;}
.ost-setting{display:flex;align-items:center;justify-content:space-between;gap:18px;
  padding:12px 14px;border:1px solid rgba(69,64,75,.9);border-radius:12px;background:rgba(255,255,255,.015);}
.ost-setting-text{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto;}
.ost-setting-text strong{font-size:20px;color:#eee7db;}
.ost-setting-text small{font-size:17px;color:#a59d8f;}
.ost-adjust.ost-setting strong{flex:0 1 auto;}

/* ---- the stepper: − value + as one instrument -------------------------- */
.ost-stepper{display:inline-flex;align-items:stretch;flex:0 0 auto;
  border:1px solid rgba(122,107,78,.9);border-radius:10px;overflow:hidden;background:rgba(255,255,255,.02);}
.ost-stepper .ost-button{border:0;border-radius:0;background:transparent;min-height:50px;min-width:54px;padding:10px 16px;font-size:22px;line-height:1;}
.ost-stepper .ost-button:hover{background:rgba(208,173,83,.14);}
.ost-stepper-value{display:flex;align-items:center;justify-content:center;min-width:92px;padding:0 12px;margin:0;
  font-size:22px;color:#f0dda6;font-variant-numeric:tabular-nums;border-left:1px solid rgba(122,107,78,.7);border-right:1px solid rgba(122,107,78,.7);}
.ost-stepper .ost-stepper-reset{font-size:17px;border-left:1px solid rgba(122,107,78,.7);min-width:0;padding:10px 14px;}
.ost-value.ost-stepper-value{display:flex;margin-top:0;}

/* ---- clothing slots: one segmented strip of four ----------------------- */
.ost-slot-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin:14px 0 6px;
  border:1px solid rgba(122,107,78,.9);border-radius:12px;overflow:hidden;background:rgba(255,255,255,.02);}
.ost-slot{border:0;border-radius:0;background:transparent;padding:12px 14px;min-height:0;gap:4px;}
.ost-slot+.ost-slot{border-left:1px solid rgba(122,107,78,.7);}
.ost-slot:hover{background:rgba(208,173,83,.12);}
.ost-slot[aria-pressed="true"]{background:rgba(81,67,38,.55);}
.ost-slot-name{font-size:17px;letter-spacing:.06em;text-transform:uppercase;color:#b6a887;}
.ost-slot-state{font-size:18px;color:#eee7db;overflow-wrap:anywhere;}

/* ---- the segmented chooser sits inside toolbars and rows ------------- */
.ost-toolbar .ost-segmented,.ost-fov-presets,.ost-size-presets{margin:0;}
.ost-size-presets .ost-button{min-width:56px;}
.ost-fov-presets{display:inline-flex;margin:12px 0 6px;}

/* ---- MCM quick toggles: a setting row with a switch pill --------------- */
.ost-mcm-grid{grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:10px;}
.ost-mcm{padding:12px 14px;border-color:rgba(69,64,75,.9);background:rgba(255,255,255,.015);border-radius:12px;}
.ost-mcm:hover{background:rgba(208,173,83,.1);}
.ost-mcm-label{font-size:19px;}
.ost-mcm-state{flex:0 0 auto;min-width:64px;text-align:center;padding:6px 12px;border-radius:999px;font-size:17px;
  color:#a59d8f;background:rgba(255,255,255,.04);border:1px solid rgba(122,107,78,.7);}
.ost-mcm[data-on="true"] .ost-mcm-state{color:#17161b;background:#d0ad53;border-color:#e4c570;font-weight:600;}
.ost-mcm[data-on="true"]{border-color:rgba(208,173,83,.55);}

/* ---- lighting rows and sections share the row language ---------------- */
.ost-light-row,.ost-light-section{padding:14px 16px;background:rgba(255,255,255,.015);border-color:rgba(69,64,75,.9);}
.ost-light-list{display:flex;flex-direction:column;gap:10px;}
.ost-light-row{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;}
.ost-light-row .ost-toolbar{margin:0;}

/* the Body panel's two sections, and the appearance tiles */
.ost-undress,.ost-voice,.ost-sos,.ost-size,.ost-appearance{padding:16px;border:1px solid rgba(69,64,75,.9);border-radius:12px;background:rgba(255,255,255,.012);}
.ost-appearance-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));grid-auto-rows:max-content;gap:12px;}
.ost-appearance-tile{display:flex;align-items:center;gap:14px;padding:12px 14px;text-align:left;min-height:min-content;
  color:#eee7db;background:rgba(255,255,255,.02);border:1px solid rgba(122,107,78,.85);border-radius:12px;cursor:pointer;font:inherit;}
.ost-appearance-tile:hover{background:rgba(208,173,83,.12);border-color:#c2a259;}
.ost-appearance-tile .ost-icon{width:28px;height:28px;flex:0 0 28px;}
.ost-appearance-text{display:flex;flex-direction:column;gap:3px;min-width:0;}
.ost-appearance-text strong{font-size:19px;}
.ost-appearance-text small{font-size:17px;color:#a59d8f;}

/* ---- boring-elements pass (2026-09-22) ---------------------------------- */
/* the hero dock reads as an instrument panel: each cell is captioned */
.ost-dock-cell{flex-direction:column;align-items:stretch;justify-content:center;gap:8px;}
.ost-dock-cap{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#b6a887;text-align:center;}
.ost-hero-speed .ost-speed-ctl{display:flex;align-items:center;justify-content:center;gap:10px;}
.ost-hero-speed .ost-speed-bars{margin:0 4px;}
.ost-hero-dock .ost-button,.ost-hero-dock .ost-mode{width:100%;}

/* empty states: a face, not a grey sentence */
.ost-empty{display:flex;align-items:center;gap:16px;padding:18px 16px;margin:6px 0;
  border:1px dashed rgba(122,107,78,.7);border-radius:12px;background:rgba(255,255,255,.012);}
.ost-empty-well{width:56px;height:56px;flex:0 0 56px;background:rgba(255,255,255,.03);border-color:rgba(122,107,78,.6);}
.ost-empty-well .ost-icon{width:26px;height:26px;flex:0 0 26px;opacity:.7;}
.ost-empty-text{display:flex;flex-direction:column;gap:4px;min-width:0;}
.ost-empty-text strong{font-size:20px;color:#e6dcc4;}
.ost-empty-text .ost-help{margin:0;}
.ost-empty[data-busy="1"]{border-style:solid;border-color:rgba(208,173,83,.45);}
.ost-empty[data-busy="1"] .ost-empty-well{background:rgba(208,173,83,.12);border-color:#c2a259;}

/* list rows carry a well where there is a natural glyph */
.ost-row-well{width:48px;height:48px;flex:0 0 48px;}
.ost-row-well .ost-icon{width:24px;height:24px;flex:0 0 24px;}

/* "you are on": a banner, not a row */
.ost-here{display:flex;align-items:center;gap:16px;padding:14px 16px;margin:12px 0 14px;
  border:1px solid rgba(208,173,83,.55);border-left:4px solid #d0ad53;border-radius:12px;background:rgba(81,67,38,.28);}
.ost-here .ost-row-well{background:rgba(208,173,83,.22);border-color:#c2a259;}
.ost-here-cap{display:block;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#d6c08a;margin-bottom:2px;}
.ost-here .ost-row-text{gap:2px;}

/* the message line is a banner when it has something to say */
.ost-card>.ost-note:not(:empty){display:flex;align-items:center;gap:12px;padding:10px 14px;margin:10px 0 0;
  border:1px solid rgba(208,173,83,.45);border-left:4px solid #d0ad53;border-radius:10px;background:rgba(81,67,38,.22);color:#eee7db;}

/* sliders: a gold rail with a ringed knob */
.ost-size-rail,.ost-fov-rail{background:#3a3742;border:1px solid #4c4650;box-sizing:border-box;}
.ost-size-fill,.ost-fov-fill{background:#c8a44d;}
.ost-size-knob{border-radius:50%;width:38px;height:38px;top:13px;margin-left:-19px;background:#e4c570;border:2px solid #eee1b6;box-shadow:0 0 0 4px rgba(208,173,83,.22);}
.ost-fov-knob{box-shadow:0 0 0 4px rgba(208,173,83,.22);}

/* native OStim options read as "opens something" */
.ost-option{position:relative;padding-right:52px;}
.ost-chevron{position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:28px;color:#b6a887;line-height:1;}

/* ---- the page's own icon set (2026-09-22): sn-*.png, one weight (sc-* is SpellCraft's prefix) ------- */
.ost-find,.ost-dock-search{position:relative;}
.ost-find-mag{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:22px;height:22px;pointer-events:none;opacity:.7;}
.ost-find-mag .ost-icon{width:22px;height:22px;}
.ost-find .ost-find-input,.ost-dock-search .ost-find-input{padding-left:46px;}
.ost-find-drop{top:calc(100% + 8px);}
.ost-hero-dock .ost-button .ost-icon{width:22px;height:22px;flex:0 0 22px;}

/* ---- the last pass (2026-09-22): nothing left to complain about ------- */
/* popouts breathe: the old 960 made every list and stepper row elbow each other */
.ost-pop-card{width:1240px;max-width:min(100%,1240px);}
/* feedback you can see: the popout's own message line */
.ost-pop-note{margin:0;font-size:17px;color:#eee7db;}
.ost-pop-note:empty{display:none;}
.ost-pop-note:not(:empty){display:flex;align-items:center;gap:12px;padding:10px 14px;margin:14px 0 0;
  border:1px solid rgba(208,173,83,.45);border-left:4px solid #d0ad53;border-radius:10px;background:rgba(81,67,38,.22);}
/* help text is a caption, after the control it explains — not a preamble */
.ost-help{font-size:17px;color:#9c948a;line-height:1.5;}
.ost-pop-sub{color:#a59d8f;}
/* grid buttons match the rows around them */
.ost-grid>.ost-button{min-height:60px;justify-content:center;}
/* the star as an icon button */
.ost-star{min-width:52px;padding:10px 14px;font-size:22px;line-height:1;color:#b6a887;}
.ost-star[aria-pressed="true"]{color:#f0dda6;background:rgba(81,67,38,.6);border-color:#d0ad53;}
/* a setting row that holds an input + action */
.ost-setting-control{display:flex;align-items:center;gap:10px;flex:0 1 520px;min-width:280px;}
.ost-setting-control .ost-search{flex:1 1 auto;min-width:0;}
/* quiet Close, everywhere it appears */
.ost-pop-head>.ost-button,.ost-head>.ost-button{background:transparent;border-color:rgba(122,107,78,.7);color:#cfc6b4;min-height:46px;padding:10px 18px;}
.ost-pop-head>.ost-button:hover,.ost-head>.ost-button:hover{background:rgba(208,173,83,.12);color:#eee7db;}
/* the hero's hint when nothing is running */
.ost-chip-hint{background:rgba(255,255,255,.03);color:#bdb5a6;border-style:dashed;}
/* voice cards read as the person tabs do */
.ost-voice-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));grid-auto-rows:max-content;gap:10px;margin:10px 0 12px;}
.ost-voice-card{background:rgba(255,255,255,.02);border-color:rgba(122,107,78,.85);border-radius:12px;padding:12px 14px;}
.ost-voice-card[aria-pressed="true"]{background:rgba(81,67,38,.72);border-color:#d0ad53;}
.ost-voice-who{font-size:19px;color:#eee7db;}.ost-voice-set{font-size:17px;color:#a59d8f;}
/* the cast chips in Add & remove: equal cells, a face, a quiet Remove */
.ost-cast-now{grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;}
.ost-cast-chip{padding:10px 12px 10px 10px;font-size:19px;background:rgba(255,255,255,.02);border-color:rgba(122,107,78,.85);}

/* =====================================================================
   SCENE PAGE — the in-game correction (2026-09-22, from a real screenshot)
   What the engine showed: the hero title in letter-spaced caps wrapping
   one letter per line (my section-heading rule had caught the hero's h3),
   a hero starved to a third of the width, a card that did not scroll,
   and the message banner squatting at the top. Every rule below is a
   FINAL say on those; it is appended last so it wins.
   ===================================================================== */
/* the page scrolls, as a page */
#sn-pane{padding:18px 26px 22px;overflow:hidden;}
#sn-pane .ost-card{overflow:auto;padding-right:6px;}

/* headings: section labels are for POPOUT sections only — never the hero */
.ost-card h3{font-size:inherit;letter-spacing:0;text-transform:none;color:inherit;margin:0;padding:0;border:0;}
.ost-pop-body h3,.ost-body h3,.ost-hold h3{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#b6a887;margin:24px 0 12px;padding-bottom:10px;border-bottom:1px solid rgba(109,96,71,.55);}
.ost-pop-body h3:first-child,.ost-body h3:first-child{margin-top:0;}
.ost-hero-title,h3.ost-hero-title{font-size:32px;line-height:1.15;letter-spacing:0;text-transform:none;color:#f0dda6;margin:0;padding:0;border:0;overflow-wrap:anywhere;}
.ost-hero[data-live="false"] .ost-hero-title{color:#9c948a;}
.ost-dock-title strong{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#d6c08a;}

/* header: title left, a proper search on the right, same row */
.ost-head{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,560px);align-items:center;gap:28px;margin:0 0 18px;}
.ost-head h2{margin:0;font-size:34px;}
.ost-head .ost-find{width:auto;flex:none;margin:0;}
.ost-head .ost-find-input{font-size:19px;padding:14px 16px 14px 48px;}

/* one column */
.ost-page{display:flex;flex-direction:column;gap:18px;}
.ost-page > *{min-width:0;}

/* the hero: one band across, then the dock across */
.ost-page .ost-hero{margin:0;padding:22px 26px;gap:18px;}
.ost-hero-top{display:grid;grid-template-columns:auto minmax(320px,1fr) auto;gap:32px;align-items:center;}
.ost-hero .ost-face{width:88px;height:88px;flex:0 0 88px;}
.ost-hero-art .ost-pos-hero{width:216px;height:144px;}
.ost-hero-meta{gap:14px;}
.ost-hero-chips{gap:10px;}
.ost-chip{white-space:nowrap;padding:8px 14px;font-size:18px;}
.ost-hero-dock{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;grid-template-columns:none;gap:14px;}
.ost-dock-cell{min-height:96px;padding:12px 16px;gap:8px;flex-direction:column;align-items:stretch;justify-content:center;}
.ost-hero-speed .ost-speed-ctl{display:flex;align-items:center;justify-content:center;gap:10px;}
.ost-hero-speed .ost-speed-bars{display:flex;gap:4px;flex:1 1 auto;min-width:0;}
.ost-hero-dock .ost-button,.ost-hero-dock .ost-mode{width:100%;min-height:52px;justify-content:center;}
.ost-hero-dock .ost-speed-ctl .ost-button{width:auto;min-width:64px;}

/* four docks across; quick as five cells across */
.ost-page .ost-tabs.ost-docks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:auto;gap:16px;margin:0;padding:0;border:0;}
.ost-quick{margin:0;display:block;}
.ost-quick-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-top:10px;}
.ost-quick-row{min-height:64px;}

/* the message line lives at the bottom, and is quiet */
.ost-card>.ost-note:not(:empty){margin:14px 0 0;padding:8px 12px;border:0;border-left:3px solid #d0ad53;border-radius:0;background:transparent;color:#cfc6b4;font-size:17px;}

@media (max-width:1500px){
  .ost-page .ost-tabs.ost-docks{grid-template-columns:repeat(2,minmax(0,1fr));}
  .ost-quick-strip{grid-template-columns:repeat(3,minmax(0,1fr));}
  .ost-head{grid-template-columns:minmax(0,1fr) minmax(280px,420px);}
}
@media (max-width:1000px){
  .ost-page .ost-tabs.ost-docks{grid-template-columns:1fr;}
  .ost-quick-strip{grid-template-columns:1fr 1fr;}
  .ost-hero-dock{grid-auto-flow:row;grid-template-columns:repeat(2,minmax(0,1fr));}
  .ost-hero-top{grid-template-columns:1fr;}
  .ost-head{grid-template-columns:1fr;}
}

/* =====================================================================
   FIT TO SCREEN (2026-09-22): the density ladder. JS sets data-density on
   the hosted card after every render; each step removes what costs height.
   ===================================================================== */
/* compact: descriptions go, wells and paddings shrink */
.ost-card[data-density="compact"] .ost-seg-text small,
.ost-card[data-density="compact"] .ost-quick-row .ost-seg-text small{display:none;}
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-button{padding:7px 12px;gap:10px;}
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-seg-well{width:40px;height:40px;flex:0 0 40px;}
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-icon{width:20px;height:20px;flex:0 0 20px;}
.ost-card[data-density="compact"] .ost-dock{padding:12px 12px 12px;gap:6px;}
.ost-card[data-density="compact"] .ost-dock-title{padding-bottom:8px;margin-bottom:2px;}
.ost-card[data-density="compact"] .ost-page{gap:14px;}
.ost-card[data-density="compact"] .ost-page .ost-hero{padding:16px 20px;gap:14px;}
.ost-card[data-density="compact"] .ost-hero .ost-face{width:72px;height:72px;flex:0 0 72px;}
.ost-card[data-density="compact"] .ost-hero-art .ost-pos-hero{width:168px;height:112px;}
.ost-card[data-density="compact"] .ost-dock-cell{min-height:80px;padding:10px 14px;gap:6px;}
.ost-card[data-density="compact"] .ost-quick{padding:12px 12px 12px;}
.ost-card[data-density="compact"] .ost-quick-row{min-height:52px;padding:7px 10px;}
.ost-card[data-density="compact"] .ost-quick-row .ost-seg-well{width:38px;height:38px;flex:0 0 38px;}
.ost-card[data-density="compact"] .ost-head{margin-bottom:12px;}

/* dense: dock subtitles go, the hero folds, quick rows are a single line */
.ost-card[data-density="dense"] .ost-seg-text small,
.ost-card[data-density="dense"] .ost-quick-row .ost-seg-text small,
.ost-card[data-density="dense"] .ost-dock-title small,
.ost-card[data-density="dense"] .ost-quick .ost-dock-title{display:none;}
.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-button{padding:5px 10px;gap:10px;min-height:0;}
.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-seg-well{width:34px;height:34px;flex:0 0 34px;}
.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-icon{width:18px;height:18px;flex:0 0 18px;}
.ost-card[data-density="dense"] .ost-seg-label{font-size:18px;}
.ost-card[data-density="dense"] .ost-dock{padding:10px;gap:5px;}
.ost-card[data-density="dense"] .ost-dock-title{padding:0 2px 6px;margin-bottom:2px;}
.ost-card[data-density="dense"] .ost-page{gap:10px;}
.ost-card[data-density="dense"] .ost-page .ost-hero{padding:12px 16px;gap:10px;}
.ost-card[data-density="dense"] .ost-hero .ost-face{width:56px;height:56px;flex:0 0 56px;}
.ost-card[data-density="dense"] .ost-hero-art .ost-pos-hero{width:126px;height:84px;}
.ost-card[data-density="dense"] .ost-hero-title{font-size:26px;}
.ost-card[data-density="dense"] .ost-dock-cell{min-height:64px;padding:8px 12px;gap:4px;}
.ost-card[data-density="dense"] .ost-dock-cap{font-size:13px;}
.ost-card[data-density="dense"] .ost-hero-dock .ost-button,.ost-card[data-density="dense"] .ost-hero-dock .ost-mode{min-height:44px;}
.ost-card[data-density="dense"] .ost-quick{padding:8px 10px;}
.ost-card[data-density="dense"] .ost-quick-strip{margin-top:0;gap:8px;}
.ost-card[data-density="dense"] .ost-quick-row{min-height:44px;padding:5px 10px;}
.ost-card[data-density="dense"] .ost-quick-row .ost-seg-well{width:32px;height:32px;flex:0 0 32px;}
.ost-card[data-density="dense"] .ost-quick-row .ost-icon{width:18px;height:18px;flex:0 0 18px;}
.ost-card[data-density="dense"] .ost-head{margin-bottom:8px;}
.ost-card[data-density="dense"] .ost-head h2{font-size:28px;}
.ost-card[data-density="dense"] .ost-card>.ost-note:not(:empty){margin-top:6px;}

/* =====================================================================
   ICON WELLS, FIXED FROM THE IN-GAME RENDER (2026-09-22)
   The engine drew every glyph top-left in its well: flex-centring a
   replaced <img> inside a <span> did not take. So the well no longer
   centres anything -- it is a bordered box whose PADDING is the margin,
   and the image fills the content box. Nothing to align, nothing to fail.
   Glyphs are also bigger: 20px of a 96px master lost the detail.
   ===================================================================== */
.ost-seg-well,.ost-row-well,.ost-empty-well,.ost-pop-well{
  display:block;box-sizing:border-box;position:relative;flex:0 0 auto;
  width:50px;height:50px;padding:11px;border-radius:50%;
  background:rgba(208,173,83,.1);border:1px solid rgba(146,129,92,.55);line-height:0;
}
.ost-seg-well>.ost-icon,.ost-row-well>.ost-icon,.ost-empty-well>.ost-icon,.ost-pop-well>.ost-icon{
  display:block;width:100%;height:100%;margin:0;padding:0;border:0;float:none;position:static;object-fit:contain;
}
/* per-place sizes: the padding sets the glyph, the box sets the well */
.ost-tabs.ost-docks .ost-seg-well{width:50px;height:50px;padding:11px;}
.ost-quick-row .ost-seg-well{width:46px;height:46px;padding:10px;}
.ost-row-well{width:48px;height:48px;padding:11px;}
.ost-empty-well{width:56px;height:56px;padding:13px;background:rgba(255,255,255,.03);}
.ost-pop-well{width:54px;height:54px;padding:12px;background:rgba(208,173,83,.16);border-color:#c2a259;}
.ost-tabs.ost-docks .ost-icon,.ost-quick-row .ost-icon,.ost-row-well .ost-icon,.ost-pop-well .ost-icon{width:100%;height:100%;flex:none;}
/* the ladder shrinks the well, and the glyph follows through the padding */
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-seg-well{width:44px;height:44px;padding:9px;}
.ost-card[data-density="compact"] .ost-quick-row .ost-seg-well{width:40px;height:40px;padding:8px;}
.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-seg-well{width:38px;height:38px;padding:8px;}
.ost-card[data-density="dense"] .ost-quick-row .ost-seg-well{width:34px;height:34px;padding:7px;}
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-icon,.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-icon,
.ost-card[data-density="compact"] .ost-quick-row .ost-icon,.ost-card[data-density="dense"] .ost-quick-row .ost-icon{width:100%;height:100%;flex:none;}
/* the sub-tab and chip glyphs are inline and fine as they are; the dock's
   free camera / stop glyphs sit beside their label, not in a well */
.ost-hero-dock .ost-button .ost-icon{width:22px;height:22px;}

/* ---- header: title | two stretched bars | End (2026-09-22) ------------- */
.ost-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:22px;margin:0 0 18px;}
.ost-head h2{margin:0;font-size:34px;white-space:nowrap;}
.ost-find-pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;min-width:0;}
.ost-find,.ost-dock-search{display:block;position:relative;width:auto;min-width:0;margin:0;flex:none;}
.ost-find-pair .ost-find-input{width:100%;box-sizing:border-box;min-height:58px;font-size:20px;padding:14px 16px 14px 50px;}
.ost-find-mag{left:16px;}
.ost-head-end{display:flex;align-items:center;}
.ost-head-end .ost-button{min-height:58px;padding:12px 22px;font-size:19px;white-space:nowrap;}
/* build() omits Close in the hosted card; the floating modal keeps its button. */
.ost-pop-head>.ost-button{display:inline-flex;}
@media (max-width:1300px){.ost-head{grid-template-columns:1fr auto;} .ost-head .ost-find-pair{grid-column:1 / -1;}}
@media (max-width:900px){.ost-find-pair{grid-template-columns:1fr;}}
/* the dock's Hold cell reads like the others */
.ost-hero-hold .ost-button{width:100%;}
/* the player's portrait: the Character tab's crop is a transform — give it room, and keep the ring */
.ost-face img[data-self="1"]{transform-origin:0 0;}

/* a dock row that is not a segment chip (Browse all scenes) wears the same row */
.ost-tabs.ost-docks .ost-seg-extra{
  display:flex;flex-direction:row;justify-content:flex-start;align-items:center;text-align:left;
  width:100%;box-sizing:border-box;min-height:0;padding:9px 12px;gap:12px;font:inherit;font-size:19px;
  color:#eee7db;background:rgba(255,255,255,.02);border:1px solid rgba(122,107,78,.85);border-radius:9px;cursor:pointer;
}
.ost-tabs.ost-docks .ost-seg-extra:hover{background:rgba(208,173,83,.12);border-color:#c2a259;}
.ost-tabs.ost-docks .ost-seg-extra:hover .ost-seg-well{background:rgba(208,173,83,.28);border-color:#d0ad53;}
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-seg-extra{padding:7px 12px;gap:10px;}
.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-seg-extra{padding:5px 10px;gap:10px;}
.ost-card[data-density="compact"] .ost-tabs.ost-docks .ost-seg-extra .ost-seg-well{width:44px;height:44px;padding:9px;}
.ost-card[data-density="dense"] .ost-tabs.ost-docks .ost-seg-extra .ost-seg-well{width:38px;height:38px;padding:8px;}

/* the scene bar's results: pictogram rows, on the page */
.ost-find-scene-drop{max-height:520px;}
.ost-find-scene-drop .ost-pos-find{width:72px;height:48px;flex:0 0 72px;object-fit:contain;}
.ost-find-scene-drop .ost-pos-none{display:inline-block;background:rgba(255,255,255,.03);border:1px dashed rgba(122,107,78,.5);border-radius:6px;}

/* scene-privacy: couch-readable controls and linked portrait rows */
.ost-privacy h3{font-size:22px;letter-spacing:.04em;}
.ost-privacy .ost-help,.ost-privacy .ost-button{font-size:20px;}
.ost-privacy .ost-toolbar{margin:20px 0;}
.ost-held-chip{gap:12px;}
/* NPC scene setup; all choices remain a draft until Start. */
.ost-start{width:1080px;max-width:94vw;max-height:90vh;display:flex;flex-direction:column;background:#202626;color:#e5dfd1;border:2px solid #a68b50;border-radius:12px;font:20px/1.45 sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.35)}
.ost-start-head{display:flex;justify-content:space-between;align-items:center;padding:20px 28px;border-bottom:1px solid #44473d}
.ost-start h2{margin:0;font:32px/1.2 Georgia,serif}.ost-start h3{font:25px/1.3 Georgia,serif;margin:0 0 18px}
.ost-start-body{overflow:auto;min-height:0;padding:24px 28px}.ost-start-body section{padding:22px 0;border-bottom:1px solid #41463d}
.ost-start-person{display:flex;align-items:center;gap:12px;margin-bottom:10px}.ost-start-person strong{flex:1}
.ost-start button{min-height:44px;font-size:18px}.ost-start button[aria-pressed=true]{color:#e3cb86;border-color:#bd9f59;background:#39382e}
.ost-start .ost-toolbar{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}.ost-start .ost-list{max-height:220px;overflow:auto;display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.ost-start input{box-sizing:border-box;width:100%;min-height:44px;font-size:18px}.ost-start-note{min-height:28px;padding:12px 28px;margin:0;border-top:1px solid #44473d}
@media(max-width:600px){.ost-start-person{flex-wrap:wrap}.ost-start-person strong{flex-basis:100%}.ost-start-body{padding:16px}}
/* the scene bar's grouped results: one animation per row, its phases behind a chevron */
.ost-find-scene-drop{max-height:600px;}
.ost-find-group{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;}
.ost-find-group .ost-find-row{min-width:0;}
.ost-find-chev{appearance:none;width:66px;margin:0;padding:0;border:0;border-left:1px solid rgba(122,107,78,.35);background:transparent;color:#dbc17a;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.ost-find-chev:hover{background:rgba(255,255,255,.05);}
.ost-find-chev-glyph{display:block;font-size:36px;line-height:1;transition:transform 120ms ease;}
.ost-find-group[data-open="true"]{background:rgba(255,255,255,.03);}
.ost-find-group[data-open="true"] .ost-find-chev-glyph{transform:rotate(90deg);}
.ost-find-phases{padding:0 0 8px 58px;border-bottom:1px solid rgba(122,107,78,.35);}
.ost-find-phase{padding-top:10px;padding-bottom:10px;}
.ost-find-phase .ost-pos-find{width:54px;height:36px;flex:0 0 54px;}
.ost-find-foot{margin:0;padding:12px 18px;font-size:17px;color:#a49b8b;border-top:1px solid rgba(122,107,78,.35);}

/* the cast strip: equal cells, outlined, numbered, room for a crowd */
.ost-hero .ost-hero-cast .ost-people{display:grid;grid-template-columns:repeat(4,minmax(124px,1fr));gap:12px;margin:0;align-items:stretch;}
.ost-hero .ost-hero-cast .ost-people[data-count="1"]{grid-template-columns:minmax(132px,1fr);}
.ost-hero .ost-hero-cast .ost-people[data-count="2"]{grid-template-columns:repeat(2,minmax(132px,1fr));}
.ost-hero .ost-hero-cast .ost-people[data-count="3"]{grid-template-columns:repeat(3,minmax(124px,1fr));}
.ost-hero .ost-hero-cast .ost-people[data-count="5"]{grid-template-columns:repeat(5,minmax(116px,1fr));}
.ost-hero .ost-hero-cast .ost-people[data-count="6"]{grid-template-columns:repeat(6,minmax(112px,1fr));}
.ost-hero .ost-people .ost-person{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:10px;min-width:0;min-height:0;padding:14px 10px 12px;background:rgba(255,255,255,.025);border:1px solid #4d4636;border-radius:12px;}
.ost-hero .ost-people .ost-person:hover{background:#2b2a33;border-color:#7c6c4b;}
.ost-hero .ost-people .ost-person[aria-pressed="true"]{background:#2f2a20;border-color:#d0ad53;box-shadow:inset 0 0 0 1px rgba(208,173,83,.35);}
.ost-person-pic{position:relative;display:block;width:88px;height:88px;flex:0 0 88px;}
.ost-hero .ost-person-pic .ost-face{width:88px;height:88px;flex:0 0 88px;border:2px solid #5b5243;}
.ost-hero .ost-person[aria-pressed="true"] .ost-person-pic .ost-face{border-color:#e4c570;}
.ost-person-idx{position:absolute;right:-6px;bottom:-4px;min-width:28px;height:28px;padding:0 7px;box-sizing:border-box;border-radius:14px;background:#1b1a20;border:1px solid #8a7648;color:#dbc17a;font-size:17px;line-height:26px;text-align:center;}
.ost-hero .ost-people .ost-person-name{font-size:18px;line-height:1.3;max-width:100%;max-height:2.6em;overflow:hidden;white-space:normal;overflow-wrap:anywhere;text-align:center;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
.ost-card[data-density="compact"] .ost-person-pic,.ost-card[data-density="compact"] .ost-hero .ost-person-pic .ost-face{width:72px;height:72px;flex:0 0 72px;}
.ost-card[data-density="dense"] .ost-person-pic,.ost-card[data-density="dense"] .ost-hero .ost-person-pic .ost-face{width:56px;height:56px;flex:0 0 56px;}
.ost-card[data-density="dense"] .ost-person-idx{min-width:24px;height:24px;line-height:22px;font-size:17px;right:-5px;}
.ost-card[data-density="dense"] .ost-hero .ost-people .ost-person{padding:10px 8px 8px;gap:8px;}

/* Position reference: shared, inspected glyphs; spacious label-first cards. */
.ost-position-count{font-size:18px;color:#bcb19b;margin:16px 0;}
.ost-position-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:max-content;gap:14px;}
.ost-position-card{display:flex;flex-direction:column;align-items:stretch;min-width:0;min-height:244px;padding:20px;text-align:left;
 border:1px solid #66583b;border-radius:12px;background:#24232a;color:#eee7db;cursor:pointer;font:inherit;}
.ost-position-card:hover,.ost-position-card:focus{background:#302d2d;border-color:#dbc17a;outline:2px solid rgba(219,193,122,.3);outline-offset:2px;}
.ost-position-art{display:flex;align-items:center;justify-content:center;min-height:100px;margin-bottom:16px;border-bottom:1px solid rgba(219,193,122,.18);padding-bottom:12px;}
.ost-position-image{width:144px;height:96px;object-fit:contain;}
.ost-position-words{display:flex;flex-direction:column;gap:8px;overflow-wrap:anywhere;}
.ost-position-words strong{font-size:23px;line-height:1.25;}
.ost-position-kind{font-size:16px;color:#dbc17a;}
.ost-position-aliases{font-size:17px;line-height:1.5;color:#bbb3a3;}
@media(max-width:800px){.ost-position-grid{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media(max-width:520px){
 .ost-pop[data-kind="position-reference"]{padding:12px;}
 .ost-pop[data-kind="position-reference"] .ost-pop-card{padding:18px;max-height:94vh;}
 .ost-pop[data-kind="position-reference"] .ost-pop-sub{margin-left:0;font-size:18px;}
 .ost-pop[data-kind="position-reference"] .ost-pop-head h2{font-size:23px;}
 .ost-pop[data-kind="position-reference"] .ost-pop-well{display:none;}
 .ost-position-grid{grid-template-columns:minmax(0,1fr);}
 .ost-position-card{flex-direction:row;align-items:center;gap:16px;min-height:148px;padding:16px;}
 .ost-position-art{flex:0 0 96px;min-height:0;margin:0;padding:0;border:0;}
 .ost-position-image{width:96px;height:64px;}
 .ost-position-words strong{font-size:21px;}
}

/* All supplied packs share the deck's brass-and-charcoal reference library. */
.ost-position-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:18px;}
.ost-position-filter{display:flex;flex-direction:column;gap:8px;min-width:0;font-size:18px;color:#dbc17a;}
.ost-position-filter .ost-search{width:100%;min-width:0;box-sizing:border-box;font-size:20px;min-height:52px;color:#eee7db;background:#24232a;}
.ost-position-target{font-size:20px;line-height:1.5;overflow-wrap:anywhere;color:#eee7db;margin:18px 0;}
.ost-position-preview{display:flex;align-items:center;justify-content:center;min-height:160px;margin:18px 0;border:1px solid #66583b;background:#24232a;border-radius:12px;}
.ost-position-preview .ost-position-image{width:216px;height:144px;}
.ost-position-status{font-size:20px;line-height:1.5;min-height:30px;color:#dbc17a;overflow-wrap:anywhere;}
.ost-position-actions{display:flex;flex-wrap:wrap;gap:14px;margin-top:20px;}
.ost-position-actions .ost-button,.ost-pop[data-kind="position-categories"] .ost-button{font-size:20px;min-height:52px;padding:12px 18px;}
.ost-position-actions .ost-button[hidden]{display:none;}
.ost-position-actions .ost-button:disabled,.ost-pop[data-kind="position-categories"] .ost-button:disabled{opacity:.55;cursor:default;}
.ost-position-actions .ost-button:focus,.ost-position-filter .ost-search:focus,.os-pos-picker:focus{outline:2px solid #dbc17a;outline-offset:3px;}
.ost-position-card:active,.ost-position-actions .ost-button:active{background:#3b352b;}
.ost-pop[data-kind^="position-"] .ost-pop-body{overscroll-behavior:contain;}
.os-pos-picker{display:flex;align-items:center;justify-content:center;flex:0 0 62px;min-height:48px;padding:4px;box-sizing:border-box;border:1px solid transparent;border-radius:8px;background:transparent;color:#dbc17a;cursor:pointer;font:24px/1 sans-serif;}
.os-pos-picker:hover{background:#302d2d;border-color:#dbc17a;}
.os-pos-picker .os-pos-none{line-height:36px;}
@media(max-width:520px){
 .ost-pop[data-kind^="position-"]{padding:12px;}
 .ost-pop[data-kind^="position-"] .ost-pop-card{padding:18px;max-height:94vh;}
 .ost-pop[data-kind^="position-"] .ost-pop-sub{margin-left:0;font-size:18px;overflow-wrap:anywhere;}
 .ost-pop[data-kind^="position-"] .ost-pop-head h2{font-size:23px;overflow-wrap:anywhere;}
 .ost-pop[data-kind^="position-"] .ost-pop-well{display:none;}
 .ost-position-filters{gap:12px;}
 .ost-position-actions{flex-direction:column;}
 .ost-position-actions .ost-button{width:100%;white-space:normal;text-align:left;}
}
