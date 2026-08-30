'use strict';

/* ====================================================================== *
 *  Journal — the book you write yourself (Rober, 2026-08-16: "the journal …
 *  ability to on web-server edit your journal, upload transparent background
 *  images, new text options (that look like fantasy pen writing) make it look
 *  like an actual medieval journal … and drag your images wherever you want in
 *  the pages, over text, wrap text etc").
 *
 *  C++ (journal.cpp) owns storage, the merge with the phone, and the picture
 *  pool. This pane owns the book: how a page looks, how text is marked up, and
 *  where the pictures sit.
 *
 *  THREE THINGS WORTH READING BEFORE CHANGING ANYTHING HERE
 *
 *  1. NO contenteditable. Rich in-place editing is unproven in Ultralight, and
 *     a journal that eats a paragraph is worse than no journal. So the page is
 *     always RENDERED and the writing happens in a plain <textarea> beside it,
 *     in a small markup this file both defines and renders (see renderMarkup).
 *     The same markup is understood by the Deck Portal, so a page written on
 *     the phone and a page written in-game are the same page. Toolbar buttons
 *     wrap the selection — nothing about the format is hand-typed unless you
 *     want it to be.
 *
 *  2. PICTURE COORDINATES ARE NORMALISED (0..1 of the page box), never pixels.
 *     The deck scales (--ui-scale), the page resizes with the window, and the
 *     phone's page is a different shape entirely — a pixel would mean a
 *     different place on each. Height is derived from the picture's own aspect
 *     ratio, cached on the image record as `ar` the first time it loads, so a
 *     layout is stable before the bytes arrive.
 *
 *  3. TEXT WRAP IS DONE WITH FLOATS, not shape-outside/exclusions (neither is
 *     safe here). For each wrapping picture the flow gets two invisible floats
 *     at its head: a zero-width shim of the picture's height-above, then a box
 *     the size of the picture stretched out to the NEARER page edge. Lines then
 *     flow around it exactly like a floated illustration in a printed book.
 *     Consequence, and it is a real one: a picture in the middle of the column
 *     carves to ONE side (whichever edge it is nearer), because carving both
 *     sides of a mid-column box is not something floats can express. That is
 *     why the picture inspector offers Left / Right / Auto — see layoutPage().
 *
 *  Bridge — requests: jrOpen() · jrSave(json) · jrImages(json) · jrDropImage(
 *  json) · jrPhoto(json)
 *  Replies (disjoint, per the deck law): jrData({ok,doc,images,swept,dir,inbox})
 *  · jrSaved({ok,doc,merged,msg}) · jrImagesData({ok,images,swept}) ·
 *  jrDropped({ok,msg,images})
 *
 *  Host contract (mirrors ItemsPane): init() · onShow() · onHide() ·
 *  toggleEdit() · wantsPause() -> true · setFilter(q)
 * ====================================================================== */

window.JournalPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  const SAVE_DEBOUNCE_MS = 900;    // after the last keystroke / drag
  const PREVIEW_DEBOUNCE_MS = 120; // textarea -> rendered page
  const IMG_POLL_MS = 4000;        // while a picture upload is expected
  const IMG_POLL_MAX = 30;         // ~2 min, then stop asking
  /* The narrowest a page of a two-page spread may end up before the spread is
     not worth having — the same 430px journal-pane.css already falls back to at
     its 1180px breakpoint. Below twice this the book shows ONE page instead of
     squeezing two into a stage the tools column has eaten. */
  const SPREAD_MIN_PAGE = 430;

  /* ============================================================ format == */

  /* The families the style picker offers. `css` is the var journal-pane.css
     declares; `samp` is drawn IN that face, which is how you can tell in-game
     whether the shipped webfont actually loaded (see the CSS header). */
  const FONTS = [
    { id: 'imfell',   name: 'Fell English', css: 'var(--jr-f-imfell)',   samp: 'The old press' },
    { id: 'cardo',    name: 'Cardo',        css: 'var(--jr-f-cardo)',    samp: 'A clear hand' },
    { id: 'goudy',    name: 'Goudy',        css: 'var(--jr-f-goudy)',    samp: 'Old style' },
    { id: 'hand',     name: 'Pen hand',     css: 'var(--jr-f-hand)',     samp: 'Written quickly' },
    { id: 'quill',    name: 'Quill script', css: 'var(--jr-f-quill)',    samp: 'Flowing quill' },
    { id: 'medieval', name: 'Medieval',     css: 'var(--jr-f-medieval)', samp: 'Of the age' },
    { id: 'pirata',   name: 'Blackletter',  css: 'var(--jr-f-pirata)',   samp: 'Gothic letters' },
    { id: 'fraktur',  name: 'Fraktur',      css: 'var(--jr-f-fraktur)',  samp: 'Heavy black' },
  ];
  const PAPERS = [
    { id: 'parchment', name: 'Parchment' },
    { id: 'vellum',    name: 'Vellum' },
    { id: 'old',       name: 'Old & tanned' },
    { id: 'linen',     name: 'Linen' },
    { id: 'ash',       name: 'Ash grey' },
  ];
  const INKS = [
    { id: 'sepia',   name: 'Sepia' },
    { id: 'black',   name: 'Iron gall' },
    { id: 'oxblood', name: 'Oxblood' },
    { id: 'indigo',  name: 'Indigo' },
  ];
  const FRAMES = [
    { id: 'none',   name: 'None' },
    { id: 'plate',  name: 'Plate' },
    { id: 'sketch', name: 'Sketch' },
    { id: 'tape',   name: 'Taped in' },
    { id: 'wax',    name: 'Wax seal' },
  ];
  const MODES = [
    { id: 'wrap',  name: 'Wrap text', hint: 'Text flows around it' },
    { id: 'over',  name: 'Over text', hint: 'Sits on top of the words' },
    { id: 'under', name: 'Behind text', hint: 'Words run over it' },
  ];

  const DEFAULT_STYLE = { paper: 'parchment', font: 'imfell', ink: 'sepia', size: 19, spread: true, ruled: false, justify: false };
  const DEFAULT_AR = 0.68;   // used until the real picture reports its own

  /* ============================================================= state == */

  const state = {
    doc: null,           // the whole journal, exactly as C++ holds it
    images: [],          // [{f, mt, sz}] the picture pool
    inbox: '',           // real-path drop folder, shown in the pictures card
    asked: false,
    dirty: false,
    saving: false,
    savedAt: 0,
    mergedNote: false,   // the phone contributed on the last save
    err: '',
    errKind: '',         // 'read' | 'save' — a read failure is NOT "not saved"
  };

  const ui = {
    visible: false,
    edit: false,
    page: 0,             // index of the LEFT page of the spread (or the page, single)
    sel: '',             // selected picture id (edit mode)
    q: '',               // page search
    poolQ: '',           // picture search
    bookQ: '',           // book search, inside the shelf popover
    want: null,          // {book, page} a jump from Omni — see goTo()
    saveT: null,
    prevT: null,
    pollT: null,
    pollN: 0,
    toastT: null,
    drag: null,          // {kind, id, ...} while a picture is being moved
    taSel: null,         // [start, end] caret, restored across a repaint
    dropArm: '',         // picture filename armed for deletion
    tearArm: '',         // page id armed for tearing out
    wired: false,        // the delegated listeners are bound ONCE, see wireOnce()
    fitting: false,      // inside fitSpread()'s re-render — see fitSpread()
    layouts: 0,          // how many times the wrap has been recomputed
  };

  /* The host contract, handed in by app.js (the HomePane.hookInto idiom): the
     pane reaches the deck only through this, never into app.js internals. */
  const host = {
    setTab: function (t) { if (typeof window.__omniSetTab === 'function') window.__omniSetTab(t); },
    getNotes: function () { return ''; },
  };
  function hookInto(h) {
    if (!h || typeof h !== 'object') return;
    if (typeof h.setTab === 'function') host.setTab = h.setTab;
    if (typeof h.getNotes === 'function') host.getNotes = h.getNotes;
  }

  function $(id) { return document.getElementById(id); }
  function pane() { return $('jr-pane'); }

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
      return;
    }
    console.log('[dev->game]', fn, arg);
    if (DEV && fn === 'jrOpen') setTimeout(devOpen, 20);
    if (DEV && fn === 'jrSave') setTimeout(function () { devSave(arg); }, 20);
    if (DEV && fn === 'jrImages') setTimeout(function () { window.jrImagesData({ ok: true, images: state.images, swept: 0 }); }, 20);
  }

  window.jrData = function (d) {
    if (!d || typeof d !== 'object') return;
    state.asked = true;
    state.err = d.ok === false ? (d.msg || 'The journal could not be read.') : '';
    state.errKind = d.ok === false ? 'read' : '';
    state.doc = normDoc(d.doc);
    state.images = Array.isArray(d.images) ? d.images : [];
    state.inbox = typeof d.inbox === 'string' ? d.inbox : '';
    migrateNotes();
    clampPage();
    /* A jump from Omni was applied to the copy we were holding; this reply is
       the re-read onShow asks for, and it carries the book that was active on
       DISK — so without re-applying it here the jump would bounce straight back
       to the book you came from. Consumed once, whichever reply arrives first. */
    if (ui.want) { applyWant(); ui.want = null; }
    if (ui.visible) render();
  };

  window.jrSaved = function (d) {
    state.saving = false;
    if (!d || typeof d !== 'object') return;
    if (d.ok === false) {
      state.err = d.msg || 'The journal could not be saved.';
      state.errKind = 'save';
      if (ui.visible) { render(); toast(state.err); }
      return;
    }
    state.err = '';
    state.errKind = '';
    state.savedAt = Date.now();
    /* Reconcile onto what actually LANDED. The DLL merged our save with
       whatever the phone had written, so trusting what we sent would show a
       page that is not the page on disk. The textarea is left alone while it
       has focus — replacing its value mid-sentence would eat the caret. */
    if (d.doc) {
      const keepPage = curPageId();
      state.doc = normDoc(d.doc);
      const idx = pageIndexById(keepPage);
      if (idx >= 0) ui.page = spreadStart(idx);
      clampPage();
    }
    state.dirty = false;
    state.mergedNote = !!d.merged;
    if (ui.visible) {
      renderAll();
      if (d.merged) toast('Saved — and edits made on your phone merged in.');
    }
  };

  window.jrImagesData = function (d) {
    if (!d || typeof d !== 'object' || d.ok === false) return;
    const before = state.images.length;
    state.images = Array.isArray(d.images) ? d.images : [];
    if (ui.visible) render();
    /* Stop polling once something new actually landed — a poll that can never
       finish (nobody is uploading) is worse than none, so it is bounded too. */
    if (state.images.length !== before) stopPoll();
  };

  window.jrDropped = function (d) {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.images)) state.images = d.images;
    if (d.msg) toast(d.msg);
    if (ui.visible) render();
  };

  /* ======================================================== the document = */

  function newId(p) {
    return (p || 'j') + '_' + Math.random().toString(36).slice(2, 9);
  }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  function normStyle(s) {
    const out = {};
    const src = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
    Object.keys(DEFAULT_STYLE).forEach(function (k) {
      out[k] = (src[k] === undefined || src[k] === null) ? DEFAULT_STYLE[k] : src[k];
    });
    if (!FONTS.some(function (f) { return f.id === out.font; })) out.font = DEFAULT_STYLE.font;
    if (!PAPERS.some(function (p) { return p.id === out.paper; })) out.paper = DEFAULT_STYLE.paper;
    if (!INKS.some(function (i) { return i.id === out.ink; })) out.ink = DEFAULT_STYLE.ink;
    out.size = Math.max(13, Math.min(34, Number(out.size) || DEFAULT_STYLE.size));
    out.spread = !!out.spread; out.ruled = !!out.ruled; out.justify = !!out.justify;
    return out;
  }

  function normImage(im) {
    if (!im || typeof im !== 'object') return null;
    const f = typeof im.src === 'string' ? im.src : '';
    if (!f) return null;
    const mode = MODES.some(function (m) { return m.id === im.mode; }) ? im.mode : 'wrap';
    const frame = FRAMES.some(function (fr) { return fr.id === im.frame; }) ? im.frame : 'none';
    const side = (im.side === 'left' || im.side === 'right') ? im.side : 'auto';
    return {
      id: typeof im.id === 'string' && im.id ? im.id : newId('i'),
      src: f,
      x: num(im.x, 0.08, -0.5, 1.5),
      y: num(im.y, 0.08, -0.5, 2.5),
      w: num(im.w, 0.36, 0.04, 1.6),
      ar: num(im.ar, DEFAULT_AR, 0.05, 12),
      rot: num(im.rot, 0, -180, 180),
      op: num(im.op, 1, 0.05, 1),
      pad: num(im.pad, 10, 0, 80),
      mode: mode, side: side, frame: frame,
      flip: !!im.flip,
    };
  }

  function num(v, dflt, lo, hi) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  function normPage(p) {
    const src = (p && typeof p === 'object') ? p : {};
    const out = {
      id: typeof src.id === 'string' && src.id ? src.id : newId('p'),
      title: typeof src.title === 'string' ? src.title : '',
      text: typeof src.text === 'string' ? src.text : '',
      images: [],
      bg: null,
      style: (src.style && typeof src.style === 'object' && !Array.isArray(src.style)) ? src.style : {},
      updatedAt: Number(src.updatedAt) || 0,
    };
    if (Array.isArray(src.images)) {
      src.images.forEach(function (im) { const n = normImage(im); if (n) out.images.push(n); });
    }
    if (src.bg && typeof src.bg === 'object' && typeof src.bg.src === 'string' && src.bg.src) {
      out.bg = {
        src: src.bg.src,
        fit: (src.bg.fit === 'contain' || src.bg.fit === 'tile') ? src.bg.fit : 'cover',
        op: num(src.bg.op, 0.55, 0.03, 1),
      };
    }
    return out;
  }

  function normBook(b) {
    const src = (b && typeof b === 'object') ? b : {};
    const out = {
      id: typeof src.id === 'string' && src.id ? src.id : newId('b'),
      title: typeof src.title === 'string' && src.title ? src.title : 'Journal',
      updatedAt: Number(src.updatedAt) || 0,
      pages: [],
    };
    if (Array.isArray(src.pages)) src.pages.forEach(function (p) { out.pages.push(normPage(p)); });
    if (!out.pages.length) out.pages.push(normPage({ title: '' }));
    return out;
  }

  function normDoc(d) {
    const src = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    const out = {
      version: 1,
      updatedAt: Number(src.updatedAt) || 0,
      activeBook: typeof src.activeBook === 'string' ? src.activeBook : '',
      style: normStyle(src.style),
      books: [],
      trash: Array.isArray(src.trash) ? src.trash : [],
    };
    if (Array.isArray(src.books)) src.books.forEach(function (b) { out.books.push(normBook(b)); });
    if (!out.books.length) out.books.push(normBook({ title: 'Journal' }));
    if (!out.books.some(function (b) { return b.id === out.activeBook; })) out.activeBook = out.books[0].id;
    return out;
  }

  /* The Notes tab this pane replaces. Its text is not thrown away and it is not
     moved either — it is COPIED onto the first page the very first time a blank
     journal opens, so nothing is lost and the old tab still holds what it held.
     A journal that already has writing in it is never touched. */
  function migrateNotes() {
    if (!state.doc) return;
    const notes = String(host.getNotes() || '');
    if (!notes.trim()) return;
    const b = book();
    if (!b || b.pages.length !== 1) return;
    const p = b.pages[0];
    if (p.text.trim() || p.title.trim() || p.images.length) return;
    p.title = 'From my old notes';
    p.text = notes;
    p.updatedAt = nowSec();
    state.dirty = true;
    saveSoon();
  }

  function book() {
    if (!state.doc) return null;
    const id = state.doc.activeBook;
    const found = state.doc.books.filter(function (b) { return b.id === id; })[0];
    return found || state.doc.books[0] || null;
  }
  function pages() { const b = book(); return b ? b.pages : []; }
  function spreadWide() { return !!(state.doc && state.doc.style.spread) && !narrow(); }
  function spreadStart(i) { return spreadWide() ? (i - (i % 2)) : i; }
  function curPage() { return pages()[ui.page] || null; }
  function curPageId() { const p = curPage(); return p ? p.id : ''; }
  function pageIndexById(id) {
    const ps = pages();
    for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return i;
    return -1;
  }
  function clampPage() {
    const n = pages().length;
    if (!n) { ui.page = 0; return; }
    ui.page = Math.max(0, Math.min(n - 1, ui.page | 0));
    ui.page = spreadStart(ui.page);
  }
  /* The room the BOOK has, which is not the room the pane has: the page list
     takes 269px off it and, the moment Write opens, the tools column another
     341px. Measuring the pane (as this used to) or the viewport (as the CSS
     breakpoints do) sees neither, which is how a two-page spread came to be
     drawn into a stage that fits one and a half. The scroller is the honest
     number; before the first paint there is none, so fall back to the pane and
     let fitSpread() correct the answer once the geometry exists. */
  function stageRoom() {
    const sc = $('jr-scroll');
    if (sc && sc.clientWidth > 0) return sc.clientWidth;
    const el = pane();
    return el ? el.clientWidth : 0;
  }
  function narrow() {
    const w = stageRoom();
    return w > 0 && w < SPREAD_MIN_PAGE * 2;
  }

  /* Re-decide spread-vs-single against the geometry that actually landed. The
     markup is built from the PREVIOUS paint's stage width, so the render that
     opens Write — which takes the tools column out of the stage in the same
     pass — would otherwise draw two pages into half a stage. Runs from
     layoutAll(), i.e. after every render and every resize; the re-render calls
     back in and the second pass agrees, so it settles in one extra pass. The
     re-entrancy guard is what makes that a promise rather than a hope. */
  function fitSpread() {
    if (ui.fitting) return false;
    const el = pane();
    if (!el || !$('jr-scroll')) return false;
    // No book on the stage (loading, or a read that failed) — nothing to fit.
    if (!el.querySelector('.jr-page.jr-left')) return false;
    const want = spreadWide();
    if (want === !!el.querySelector('.jr-page.jr-right')) return false;
    ui.fitting = true;
    try { clampPage(); renderStageOnly(); } finally { ui.fitting = false; }
    return true;
  }

  function touchPage(p) {
    if (!p) return;
    p.updatedAt = nowSec();
    const b = book();
    if (b) b.updatedAt = nowSec();
    if (state.doc) state.doc.updatedAt = nowSec();
    state.dirty = true;
  }

  /* ============================================================== save == */

  function saveSoon() {
    if (ui.saveT) clearTimeout(ui.saveT);
    ui.saveT = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
    renderSaveChip();
  }

  function saveNow() {
    if (ui.saveT) { clearTimeout(ui.saveT); ui.saveT = null; }
    if (!state.doc || !state.dirty) return;
    state.saving = true;
    renderSaveChip();
    toGame('jrSave', JSON.stringify({ doc: state.doc }));
  }

  /* ============================================================ markup == */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* The journal's markup. Deliberately tiny, deliberately line-based, and
     deliberately identical to the Deck Portal's copy of this function — a page
     must read the same in both. Everything is escaped FIRST, so no user text
     can ever become markup; the tags below are then re-introduced by us.

       # Heading        ## Sub-heading
       > a marginal note
       - bullet         1. numbered
       ---              a flourish
       **bold**  *italic*  __underline__  ~~struck~~
       {{script}}…{{/script}}  {{hand}}…{{/hand}}  {{black}}…{{/black}}
       {{caps}}…{{/caps}}      {{red}}…{{/red}}    {{faded}}…{{/faded}}
       {{big}}…{{/big}}
  */
  const INLINE_TAGS = ['script', 'hand', 'black', 'caps', 'red', 'faded', 'big'];

  function inlineMarkup(s) {
    let out = esc(s);
    // Inline style spans first: their bodies may contain the other marks.
    INLINE_TAGS.forEach(function (t) {
      const open = new RegExp('\\{\\{' + t + '\\}\\}', 'g');
      const close = new RegExp('\\{\\{\\/' + t + '\\}\\}', 'g');
      out = out.replace(open, '<span class="jr-t-' + t + '">').replace(close, '</span>');
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    return out;
  }

  /* `drop` puts the illuminated first letter on the first paragraph. It is a
     real floated ELEMENT emitted BEFORE that paragraph, not a ::first-letter
     float, and that is not cosmetic bikeshedding: CSS says a float may not sit
     higher than any float earlier in the source, so once layoutPage prepends
     the picture-carve floats at the head of the flow, a ::first-letter drop cap
     is shoved down to their top — measured in Chrome (2026-08-16): the cap
     landed 170px below its own paragraph, orphaned beside the blockquote.
     Emitting it first makes it the earliest float, and everything lines up. */
  function renderMarkup(text, opts) {
    const drop = !!(opts && opts.drop);
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];       // RAW lines; marked up at flush, so the drop cap can be
                         // split off the source character rather than the HTML
    let list = null;     // 'ul' | 'ol'
    let capDone = false;

    function flushPara() {
      if (!para.length) return;
      let cap = '';
      if (drop && !capDone) {
        capDone = true;
        /* Only a plain letter or digit becomes a cap — a paragraph that opens
           with a mark (**bold**, a quote) keeps its text intact. */
        const first = para[0];
        if (/^[A-Za-z0-9]/.test(first)) {
          cap = '<span class="jr-cap">' + esc(first.charAt(0)) + '</span>';
          para[0] = first.slice(1);
        }
      }
      out.push(cap + '<p>' + para.map(inlineMarkup).join('<br>') + '</p>');
      para = [];
    }
    function flushList() {
      if (!list) return;
      out.push('</' + list + '>');
      list = null;
    }
    function flush() { flushPara(); flushList(); }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }

      let m;
      if ((m = /^\s{0,3}(#{1,2})\s+(.*)$/.exec(line))) {
        flush();
        const tag = m[1].length === 1 ? 'h1' : 'h2';
        out.push('<' + tag + '>' + inlineMarkup(m[2]) + '</' + tag + '>');
        continue;
      }
      if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
      if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
        flush();
        out.push('<blockquote>' + inlineMarkup(m[1]) + '</blockquote>');
        continue;
      }
      if ((m = /^\s{0,3}[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inlineMarkup(m[1]) + '</li>');
        continue;
      }
      if ((m = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inlineMarkup(m[1]) + '</li>');
        continue;
      }
      flushList();
      para.push(line);
    }
    flush();
    return out.join('');
  }

  /* ============================================================ render == */

  function render() {
    const el = pane();
    if (!el || !ui.visible) return;
    if (!state.doc) { el.innerHTML = shellHtml(loadingHtml()); return; }
    renderAll();
  }

  function renderAll() {
    const el = pane();
    if (!el) return;
    const st = state.doc.style;
    el.className = 'jr-paper-' + st.paper + ' jr-ink-' + st.ink + (ui.edit ? ' jr-editing' : '');
    el.innerHTML = shellHtml(headHtml() + bodyHtml());
    wireAll();
    layoutAll();
  }

  function shellHtml(inner) { return inner; }

  function loadingHtml() {
    return '<div class="jr-head"><div class="jr-title">Journal</div></div>' +
      '<div class="jr-body"><div class="jr-stage"><div class="jr-empty"><b>Opening the book…</b>' +
      'Reading your journal from disk.</div></div></div>';
  }

  function headHtml() {
    const b = book();
    const ps = pages();
    const saveChip = saveChipHtml();
    // Nothing was read, so the count and the Write button would both be claims
    // about a book we do not have.
    const bad = state.errKind === 'read';
    return '' +
      '<div class="jr-head">' +
        '<div class="jr-title">Journal</div>' +
        '<button class="jr-bookpick" id="jr-bookpick" type="button" title="Choose or add a book">' +
          '<span class="jr-bp-name">' + esc(b ? b.title : 'Journal') + '</span>' +
          '<span class="jr-bp-caret">▾</span>' +
        '</button>' +
        '<span class="jr-chip">' + (bad ? '—' : ps.length + ' page' + (ps.length === 1 ? '' : 's')) + '</span>' +
        '<div class="jr-head-spacer"></div>' +
        saveChip +
        (bad ? '' :
          '<button class="jr-btn' + (ui.edit ? ' on' : '') + '" id="jr-mode" type="button" ' +
            'title="' + (ui.edit ? 'Put the quill down and just read' : 'Write on this page') + '">' +
            (ui.edit ? '✓ Done writing' : '✎ Write') + '</button>') +
      '</div>';
  }

  function saveChipHtml() {
    /* A failed READ is not a failed save — saying "not saved" sent the player
       hunting for a write problem he did not have. The reason itself goes on
       the page (see errStageHtml): title= is not a surface this engine shows. */
    if (state.errKind === 'read') return '<span class="jr-chip jr-bad" id="jr-savechip">⚠ not read</span>';
    if (state.err) return '<span class="jr-chip jr-bad" id="jr-savechip" title="' + esc(state.err) + '">⚠ not saved</span>';
    if (state.saving) return '<span class="jr-chip" id="jr-savechip">saving…</span>';
    if (state.dirty || ui.saveT) return '<span class="jr-chip jr-warn" id="jr-savechip">unsaved</span>';
    if (state.savedAt) return '<span class="jr-chip jr-ok" id="jr-savechip">saved</span>';
    return '<span class="jr-chip" id="jr-savechip">&nbsp;</span>';
  }

  function renderSaveChip() {
    const chip = $('jr-savechip');
    if (!chip || !chip.parentNode) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = saveChipHtml();
    chip.parentNode.replaceChild(tmp.firstChild, chip);
  }

  function bodyHtml() {
    // A read that failed has no pages to list and nothing to write on: the rails
    // would only offer the seeded stand-in as if it were his book.
    if (state.errKind === 'read') return '<div class="jr-body">' + errStageHtml() + '</div>';
    return '<div class="jr-body">' + sideHtml() + stageHtml() + toolsHtml() + '</div>';
  }

  /* ---- the page list ---- */

  function matchPage(p, q) {
    if (!q) return true;
    const hay = (p.title + ' ' + p.text).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function pageLabel(p, i) {
    if (p.title.trim()) return p.title.trim();
    const first = p.text.replace(/[#>*_~\-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (first) return first.slice(0, 44) + (first.length > 44 ? '…' : '');
    return 'Page ' + (i + 1);
  }

  function sideHtml() {
    const ps = pages();
    const q = ui.q.trim().toLowerCase();
    let rows = '';
    let shown = 0;
    for (let i = 0; i < ps.length; i++) {
      if (!matchPage(ps[i], q)) continue;
      shown++;
      const on = (i === ui.page) || (spreadWide() && i === ui.page + 1);
      rows += '<button class="jr-prow' + (on ? ' on' : '') + '" type="button" data-jr-page="' + i + '" ' +
        'title="' + esc(pageLabel(ps[i], i)) + '">' +
        '<span class="jr-prow-n">' + (i + 1) + '</span>' +
        '<span class="jr-prow-t">' + esc(pageLabel(ps[i], i)) + '</span>' +
        (ps[i].images.length ? '<span class="jr-prow-mark" title="' + ps[i].images.length + ' picture(s)">❖</span>' : '') +
        '</button>';
    }
    if (!shown) {
      rows = '<div class="jr-empty">' + (q
        ? '<b>Nothing on that</b>No page mentions “' + esc(ui.q.trim()) + '”.'
        : '<b>No pages yet</b>Start one below.') + '</div>';
    }
    return '' +
      '<div class="jr-side">' +
        '<div class="jr-side-head">' +
          '<div class="jr-side-title">Pages</div>' +
          '<div class="jr-searchbar"><span class="jr-sb-glyph">⌕</span>' +
            '<input id="jr-q" type="text" autocomplete="off" spellcheck="false" ' +
              'placeholder="Search this book…" value="' + esc(ui.q) + '"></div>' +
        '</div>' +
        '<div class="jr-pagelist" id="jr-pagelist">' + rows + '</div>' +
        '<div class="jr-side-foot">' +
          '<button class="jr-btn" id="jr-newpage" type="button" title="Add a page at the end">✚ New page</button>' +
        '</div>' +
      '</div>';
  }

  /* ---- the book ---- */

  function pageStyleVars(p) {
    const st = state.doc.style;
    const face = FONTS.filter(function (f) { return f.id === (p.style.font || st.font); })[0] ||
                 FONTS.filter(function (f) { return f.id === st.font; })[0] || FONTS[0];
    const size = Math.max(13, Math.min(34, Number(p.style.size || st.size)));
    const line = Math.round(size * 1.58);
    return '--jr-face:' + face.css + ';--jr-size:' + size + 'px;--jr-line:' + line + 'px;';
  }

  function imgHtml(im, selected) {
    const cls = ['jr-img', 'jr-m-' + im.mode, 'jr-fr-' + im.frame];
    if (im.flip) cls.push('jr-flip');
    if (selected) cls.push('jr-sel');
    const handles = (ui.edit && selected)
      ? '<button class="jr-h jr-h-rot" data-jr-h="rot" title="Turn it">↻</button>' +
        '<button class="jr-h jr-h-size" data-jr-h="size" title="Resize">⇲</button>'
      : '';
    return '<div class="' + cls.join(' ') + '" data-jr-img="' + esc(im.id) + '" ' +
      'style="left:0;top:0;width:0;opacity:' + im.op + '">' +
      '<img src="journal-images/' + encodeURIComponent(im.src) + '" alt="" data-jr-src="' + esc(im.src) + '">' +
      handles + '</div>';
  }

  function pageHtml(p, i, side) {
    if (!p) {
      return '<div class="jr-page jr-blank ' + side + '"><div class="jr-flow"></div></div>';
    }
    const st = state.doc.style;
    const drop = p.style.drop !== false && !!p.text.trim();
    const bg = p.bg
      ? '<div class="jr-pagebg jr-fit-' + p.bg.fit + '" style="background-image:url(\'journal-images/' +
        encodeURIComponent(p.bg.src) + '\');opacity:' + p.bg.op + '"></div>'
      : '';
    const imgs = p.images.map(function (im) { return imgHtml(im, ui.edit && ui.sel === im.id); }).join('');
    const body = p.text.trim()
      ? renderMarkup(p.text, { drop: drop })
      : (ui.edit ? '<p class="jr-t-faded"><em>This page is blank. Write it on the right — or drop a picture on it.</em></p>' : '');
    return '' +
      '<div class="jr-page ' + side + (st.ruled ? ' jr-ruled' : '') + '" data-jr-pageidx="' + i + '" ' +
        'style="' + pageStyleVars(p) + '">' +
        bg +
        (p.title.trim() ? '<div class="jr-runhead">' + esc(p.title.trim()) + '</div>' : '') +
        '<div class="jr-flow' + (st.justify ? ' jr-just' : '') + '">' + body + '</div>' +
        imgs +
        '<div class="jr-folio">' + (i + 1) + '</div>' +
      '</div>';
  }

  /* The book could not be READ. normDoc() seeds a starter page when the DLL
     sends no doc, so drawing the stage normally would show that seed as if it
     were his journal — a player whose file is unreadable would be told his book
     is empty and might write over the top of it. Say what went wrong instead,
     and offer the one action that can help. */
  function errStageHtml() {
    return '' +
      '<div class="jr-stage">' +
        '<div class="jr-scroll" id="jr-scroll">' +
          '<div class="jr-err">' +
            '<b>The journal could not be opened</b>' +
            '<p class="jr-err-msg">' + esc(state.err) + '</p>' +
            '<p>Nothing has been written over. Any page shown before this is still on disk.</p>' +
            '<button class="jr-btn" id="jr-reread" type="button" ' +
              'title="Ask the game to read the journal file again">↻ Try again</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function stageHtml() {
    if (state.errKind === 'read') return errStageHtml();
    const ps = pages();
    const wide = spreadWide();
    const left = ps[ui.page] || null;
    const right = wide ? (ps[ui.page + 1] || null) : null;
    const bookCls = 'jr-book' + (wide ? '' : ' jr-single');
    const last = wide ? (ui.page + 2 >= ps.length) : (ui.page + 1 >= ps.length);
    const label = wide && right
      ? 'Pages ' + (ui.page + 1) + '–' + (ui.page + 2) + ' of ' + ps.length
      : 'Page ' + (ui.page + 1) + ' of ' + ps.length;
    return '' +
      '<div class="jr-stage">' +
        '<div class="jr-scroll" id="jr-scroll">' +
          '<div class="' + bookCls + '" id="jr-bookel">' +
            pageHtml(left, ui.page, 'jr-left') +
            (wide ? pageHtml(right, ui.page + 1, 'jr-right') : '') +
          '</div>' +
        '</div>' +
        '<div class="jr-nav">' +
          '<button class="jr-turn" id="jr-prev" type="button" title="Turn back" ' +
            (ui.page <= 0 ? 'disabled' : '') + '>‹</button>' +
          '<span class="jr-nav-count">' + label + '</span>' +
          '<button class="jr-turn" id="jr-next" type="button" title="Turn on" ' +
            (last ? 'disabled' : '') + '>›</button>' +
        '</div>' +
      '</div>';
  }

  /* ---- the writing tools ---- */

  function segHtml(id, list, cur, attr) {
    return list.map(function (o) {
      return '<button class="jr-btn jr-btn-sm' + (o.id === cur ? ' on' : '') + '" type="button" ' +
        'data-' + attr + '="' + o.id + '" title="' + esc(o.hint || o.name) + '">' + esc(o.name) + '</button>';
    }).join('');
  }

  function stepper(id, label, value, unit) {
    return '<div class="jr-row"><span class="jr-label">' + esc(label) + '</span>' +
      '<button class="jr-btn jr-btn-sm" type="button" data-jr-step="' + id + ':-1" title="Less">−</button>' +
      '<span class="jr-chip">' + esc(value) + (unit || '') + '</span>' +
      '<button class="jr-btn jr-btn-sm" type="button" data-jr-step="' + id + ':1" title="More">＋</button></div>';
  }

  function toolsHtml() {
    if (!ui.edit) return '<div class="jr-tools hidden"></div>';
    const p = curPage();
    return '' +
      '<div class="jr-tools">' +
        '<div class="jr-tools-scroll">' +
          writeCardHtml(p) +
          pictureCardHtml(p) +
          selectedCardHtml(p) +
          pageCardHtml(p) +
          styleCardHtml() +
        '</div>' +
      '</div>';
  }

  function writeCardHtml(p) {
    if (!p) return '';
    return '' +
      '<div class="jr-card">' +
        '<div class="jr-card-h">Write <span class="jr-hint">— the page updates as you type</span></div>' +
        '<div class="jr-row"><input class="jr-input" id="jr-ptitle" type="text" ' +
          'placeholder="Page heading (optional)" value="' + esc(p.title) + '"></div>' +
        '<div class="jr-tb">' +
          '<button class="jr-btn jr-tb-b" type="button" data-jr-mark="**" title="Bold">B</button>' +
          '<button class="jr-btn jr-tb-i" type="button" data-jr-mark="*" title="Italic">I</button>' +
          '<button class="jr-btn" type="button" data-jr-mark="__" title="Underline">U</button>' +
          '<button class="jr-btn jr-tb-script" type="button" data-jr-mark="{{script}}" title="Quill script">S</button>' +
          '<button class="jr-btn jr-tb-hand" type="button" data-jr-mark="{{hand}}" title="Pen hand">h</button>' +
          '<button class="jr-btn jr-tb-black" type="button" data-jr-mark="{{black}}" title="Blackletter">B</button>' +
          '<button class="jr-btn" type="button" data-jr-mark="{{caps}}" title="Small caps">ᴀᴀ</button>' +
          '<button class="jr-btn" type="button" data-jr-mark="{{red}}" title="Rubric (red ink)">◆</button>' +
          '<button class="jr-btn" type="button" data-jr-mark="{{faded}}" title="Faded ink">◇</button>' +
          '<button class="jr-btn" type="button" data-jr-line="# " title="Heading">H1</button>' +
          '<button class="jr-btn" type="button" data-jr-line="## " title="Sub-heading">H2</button>' +
          '<button class="jr-btn" type="button" data-jr-line="> " title="Marginal note">❝</button>' +
          '<button class="jr-btn" type="button" data-jr-line="- " title="Bullet">•</button>' +
          '<button class="jr-btn" type="button" data-jr-ins="\n---\n" title="Flourish divider">❦</button>' +
        '</div>' +
        '<div class="jr-row" style="margin-top:10px">' +
          '<textarea class="jr-ta" id="jr-ta" spellcheck="false" ' +
            'placeholder="Write here. Blank line starts a new paragraph.">' + esc(p.text) + '</textarea>' +
        '</div>' +
        '<div class="jr-note">Marks: <code>**bold**</code> <code>*italic*</code> ' +
          '<code>__underline__</code> <code># heading</code> <code>&gt; note</code> ' +
          '<code>- bullet</code> <code>---</code></div>' +
      '</div>';
  }

  function pictureCardHtml(p) {
    const q = ui.poolQ.trim().toLowerCase();
    const list = state.images.filter(function (im) {
      return !q || im.f.toLowerCase().indexOf(q) !== -1;
    });
    let tiles = list.slice(0, 200).map(function (im) {
      /* PLAIN path, no ?v= cache-bust: Ultralight's view loader treats the query
         as part of the filename and the image simply never loads (hd-lightbox,
         home-pane, wardrobe-spid all carry the same note). Safe here because a
         picture is never replaced under its own name — the portal mints a fresh
         name rather than overwriting, and deleting removes the file outright. */
      return '<div class="jr-pool-t" data-jr-add="' + esc(im.f) + '" title="' + esc(im.f) + ' — click to place it on this page">' +
        '<img src="journal-images/' + encodeURIComponent(im.f) + '" alt="">' +
        '<button class="jr-pool-x" type="button" data-jr-drop="' + esc(im.f) + '" title="Delete this picture">✕</button>' +
        '<span class="jr-pool-name">' + esc(im.f) + '</span>' +
      '</div>';
    }).join('');
    if (!list.length) {
      tiles = '<div class="jr-empty">' + (q
        ? '<b>No picture called that</b>Try part of the file name.'
        : '<b>No pictures yet</b>Upload them from the Deck Portal on your phone, drop them in the folder below, or take one in-game.') + '</div>';
    }
    return '' +
      '<div class="jr-card" id="jr-piccard">' +
        '<div class="jr-card-h">Pictures <span class="jr-hint">— click one to place it</span></div>' +
        (state.images.length > 8
          ? '<div class="jr-searchbar" style="margin-bottom:10px"><span class="jr-sb-glyph">⌕</span>' +
            '<input id="jr-poolq" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search pictures…" value="' + esc(ui.poolQ) + '"></div>'
          : '') +
        '<div class="jr-pool">' + tiles + '</div>' +
        '<div class="jr-row" style="margin-top:10px">' +
          '<button class="jr-btn" id="jr-photo" type="button" ' +
            'title="Close the deck, line up a shot, and paste it into the journal">📷 Take a picture</button>' +
          '<button class="jr-btn" id="jr-refresh" type="button" title="Look for pictures added since">⟳ Refresh</button>' +
        '</div>' +
        (state.inbox ? '<div class="jr-note">Drop images into <code>' + esc(state.inbox) + '</code> ' +
          'and press ⟳ — or upload them from the Deck Portal on your phone.</div>' : '') +
      '</div>';
  }

  function selectedCardHtml(p) {
    if (!p) return '';
    const im = p.images.filter(function (x) { return x.id === ui.sel; })[0];
    if (!im) {
      return '<div class="jr-card"><div class="jr-card-h">The picture</div>' +
        '<div class="jr-note">Click a picture on the page to move it, resize it, turn it, ' +
        'and choose whether the words flow around it, run under it, or sit beneath it.</div></div>';
    }
    const sides = [{ id: 'auto', name: 'Auto' }, { id: 'left', name: 'Left' }, { id: 'right', name: 'Right' }];
    return '' +
      '<div class="jr-card">' +
        '<div class="jr-card-h">The picture <span class="jr-hint">— ' + esc(im.src) + '</span></div>' +
        '<div class="jr-row"><span class="jr-label">Text</span><div class="jr-seg jr-grow">' +
          segHtml('mode', MODES, im.mode, 'jr-mode') + '</div></div>' +
        (im.mode === 'wrap'
          ? '<div class="jr-row"><span class="jr-label">Wrap to</span><div class="jr-seg jr-grow">' +
            segHtml('side', sides, im.side, 'jr-side') + '</div></div>'
          : '') +
        '<div class="jr-row"><span class="jr-label">Frame</span><div class="jr-seg jr-grow">' +
          segHtml('frame', FRAMES, im.frame, 'jr-frame') + '</div></div>' +
        stepper('w', 'Size', Math.round(im.w * 100), '%') +
        stepper('rot', 'Turn', Math.round(im.rot), '°') +
        stepper('op', 'Fade', Math.round(im.op * 100), '%') +
        stepper('pad', 'Breathing', Math.round(im.pad), 'px') +
        '<div class="jr-row">' +
          '<button class="jr-btn jr-btn-sm" type="button" data-jr-imgact="flip" title="Mirror it">⇋ Flip</button>' +
          '<button class="jr-btn jr-btn-sm" type="button" data-jr-imgact="bg" title="Use it as this page\'s background">▤ As background</button>' +
          '<button class="jr-btn jr-btn-sm jr-danger" type="button" data-jr-imgact="remove" title="Take it off the page">✕ Remove</button>' +
        '</div>' +
        '<div class="jr-note">Drag it anywhere on the page — including off the edge. Arrow keys nudge it; hold Shift for bigger steps.</div>' +
      '</div>';
  }

  function pageCardHtml(p) {
    if (!p) return '';
    const bgNote = p.bg
      ? '<div class="jr-row"><span class="jr-label">Background</span>' +
        '<span class="jr-chip jr-grow">' + esc(p.bg.src) + '</span>' +
        '<button class="jr-btn jr-btn-sm" type="button" data-jr-bg="fit" title="Cover / fit / tile">' + esc(p.bg.fit) + '</button>' +
        '<button class="jr-btn jr-btn-sm" type="button" data-jr-bg="less" title="Fainter">−</button>' +
        '<button class="jr-btn jr-btn-sm" type="button" data-jr-bg="more" title="Stronger">＋</button>' +
        '<button class="jr-btn jr-btn-sm jr-danger" type="button" data-jr-bg="clear" title="No background picture">✕</button></div>'
      : '<div class="jr-note">No background picture on this page. Pick one above and press ▤ As background — a transparent PNG lies over the paper.</div>';
    return '' +
      '<div class="jr-card">' +
        '<div class="jr-card-h">This page</div>' +
        '<div class="jr-row"><span class="jr-label">Drop cap</span>' +
          '<button class="jr-btn jr-btn-sm' + (p.style.drop !== false ? ' on' : '') + '" type="button" ' +
            'data-jr-page-act="drop" title="The big illuminated first letter">' +
            (p.style.drop !== false ? 'On' : 'Off') + '</button></div>' +
        bgNote +
        '<div class="jr-row" style="margin-top:6px">' +
          '<button class="jr-btn jr-btn-sm" type="button" data-jr-page-act="before" title="Insert a page before this one">✚ Page before</button>' +
          '<button class="jr-btn jr-btn-sm" type="button" data-jr-page-act="after" title="Insert a page after this one">✚ Page after</button>' +
        '</div>' +
        '<div class="jr-row">' +
          '<button class="jr-btn jr-btn-sm" type="button" data-jr-page-act="up" title="Move this page earlier">▲ Earlier</button>' +
          '<button class="jr-btn jr-btn-sm" type="button" data-jr-page-act="down" title="Move this page later">▼ Later</button>' +
          '<button class="jr-btn jr-btn-sm jr-danger" type="button" data-jr-page-act="tear" ' +
            'title="Tear this page out — press twice">✂ Tear out</button>' +
        '</div>' +
      '</div>';
  }

  function styleCardHtml() {
    const st = state.doc.style;
    const fonts = FONTS.map(function (f) {
      return '<button class="jr-fontrow' + (f.id === st.font ? ' on' : '') + '" type="button" data-jr-font="' + f.id + '" ' +
        'title="Write the whole book in ' + esc(f.name) + '">' +
        '<span class="jr-fr-name">' + esc(f.name) + '</span>' +
        '<span class="jr-fr-samp" style="font-family:' + f.css + '">' + esc(f.samp) + '</span></button>';
    }).join('');
    return '' +
      '<div class="jr-card">' +
        '<div class="jr-card-h">The book <span class="jr-hint">— paper, ink and hand</span></div>' +
        '<div class="jr-row"><span class="jr-label">Paper</span><div class="jr-seg jr-grow">' +
          segHtml('paper', PAPERS, st.paper, 'jr-paper') + '</div></div>' +
        '<div class="jr-row"><span class="jr-label">Ink</span><div class="jr-seg jr-grow">' +
          segHtml('ink', INKS, st.ink, 'jr-ink') + '</div></div>' +
        stepper('size', 'Text size', st.size, 'px') +
        '<div class="jr-row">' +
          '<button class="jr-btn jr-btn-sm' + (st.spread ? ' on' : '') + '" type="button" data-jr-style="spread" ' +
            'title="Two pages side by side, like an open book">📖 Spread</button>' +
          '<button class="jr-btn jr-btn-sm' + (st.ruled ? ' on' : '') + '" type="button" data-jr-style="ruled" ' +
            'title="Faint ruled lines under the writing">▤ Ruled</button>' +
          '<button class="jr-btn jr-btn-sm' + (st.justify ? ' on' : '') + '" type="button" data-jr-style="justify" ' +
            'title="Straight edges on both sides, like a printed book">☰ Justify</button>' +
        '</div>' +
        '<div class="jr-card-h" style="margin-top:14px">Hand</div>' +
        fonts +
        '<div class="jr-note">If a hand looks like the plain one, its shipped font did not load — the others still work.</div>' +
      '</div>';
  }

  /* ====================================================== wrap + layout == */

  /* Place every picture, then rebuild the invisible floats that make the text
     flow around the wrapping ones. Runs after each paint and on resize; it is
     pure geometry, so it is cheap enough to do wholesale. */
  function layoutAll() {
    const el = pane();
    if (!el) return;
    // The stage may have just changed width (Write opened, window resized), so
    // settle spread-vs-single first; that re-render brings its own layout pass.
    if (fitSpread()) return;
    ui.layouts++;   // the harness asserts a picture's load triggers one
    const ps = pages();
    const nodes = el.querySelectorAll('.jr-page[data-jr-pageidx]');
    for (let i = 0; i < nodes.length; i++) {
      const idx = parseInt(nodes[i].getAttribute('data-jr-pageidx'), 10);
      if (ps[idx]) layoutPage(nodes[i], ps[idx]);
    }
  }

  function layoutPage(pageEl, page) {
    const flow = pageEl.querySelector('.jr-flow');
    if (!flow) return;
    const pw = pageEl.clientWidth;
    const ph = pageEl.clientHeight;

    // Drop any floats from the previous layout before measuring — leaving them
    // in would make each pass carve on top of the last one.
    const old = flow.querySelectorAll('.jr-shim, .jr-wrapbox');
    for (let i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    if (!pw || !ph) return;   // not laid out yet (or jsdom) — nothing to place

    const fx = flow.offsetLeft;
    const fy = flow.offsetTop;
    const fw = flow.clientWidth || pw;

    /* 1. every picture goes exactly where its normalised coordinates say.
       WRITE-THEN-READ, in two passes, on purpose: reading offsetWidth back off
       a node one line after writing its style forces a synchronous layout, and
       doing that INSIDE the loop cost one full layout PER PICTURE (times the
       page count, through layoutAll). All the writes go down first; the reads
       that follow pay for a single layout no matter how many pictures the page
       carries. */
    const wrappers = [];
    const toMeasure = [];
    for (let i = 0; i < page.images.length; i++) {
      const im = page.images[i];
      const node = pageEl.querySelector('.jr-img[data-jr-img="' + cssEsc(im.id) + '"]');
      if (!node) continue;
      const w = im.w * pw;
      const left = im.x * pw;
      const top = im.y * ph;
      node.style.left = left + 'px';
      node.style.top = top + 'px';
      node.style.width = w + 'px';
      node.style.opacity = String(im.op);
      node.style.transform = im.rot ? ('rotate(' + im.rot + 'deg)') : '';
      if (im.mode !== 'wrap') continue;
      toMeasure.push({ im: im, node: node, w: w, left: left, top: top });
    }
    for (let i = 0; i < toMeasure.length; i++) {
      const m = toMeasure[i], im = m.im;
      /* The carve follows the box the picture ACTUALLY occupies, read back off
         the laid-out node — not w × ar. A frame adds padding and a border (the
         plate frame is ~8px a side), and a turned picture covers its rotated
         bounding box, both of which text was measured running straight through
         when the carve used the raw numbers. */
      const ow = m.node.offsetWidth || m.w;
      const oh = m.node.offsetHeight || (m.w * im.ar);
      let bw = ow, bh = oh;
      if (im.rot) {
        const a = Math.abs(im.rot) * Math.PI / 180;
        const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
        bw = ow * c + oh * s;
        bh = ow * s + oh * c;
      }
      wrappers.push({
        im: im, w: bw, h: bh,
        left: m.left + ow / 2 - bw / 2,   // the rotation turns about the centre
        top: m.top + oh / 2 - bh / 2,
      });
    }
    if (!wrappers.length) return;

    // 2. the carve. Floats are consumed top-down per side, so each one's shim
    //    only has to make up the distance the PREVIOUS floats on that side did
    //    not already cover (hence usedLeft/usedRight).
    wrappers.sort(function (a, b) { return a.top - b.top; });

    /* AFTER the drop cap, before everything else. Float order is source order,
       and a float may not sit higher than an earlier one — so the cap has to
       come first or it gets pushed down the page (see renderMarkup). */
    const cap = flow.querySelector('.jr-cap');
    const before = cap ? cap.nextSibling : flow.firstChild;

    /* WHERE THE FLOAT CHAIN ACTUALLY STARTS. A float's top is its hypothetical
       position in normal flow — which is the INSERTION POINT, not the top of
       the column. A page that opens with a heading starts its floats a heading
       lower, and shims measured from the column top then carve every picture
       that far too low (measured in Chrome: a 53px heading put one text line
       straight through the picture). A zero-height block dropped in at the same
       place reports that origin exactly. */
    const probe = document.createElement('span');
    probe.className = 'jr-shim';
    probe.style.cssText = 'display:block;height:0;width:0;';
    if (before) flow.insertBefore(probe, before); else flow.appendChild(probe);
    const originY = probe.getBoundingClientRect().top - flow.getBoundingClientRect().top;
    flow.removeChild(probe);

    /* The drop cap is itself a left float on that first line, and `clear: left`
       clears THAT too — so the left chain's first shim must not re-count the
       space the cap already used, or every left-side picture is carved a cap's
       height too low (measured: one line ran through it). */
    let usedLeft = cap ? cap.offsetHeight : 0;
    let usedRight = 0;
    const frag = document.createDocumentFragment();

    for (let i = 0; i < wrappers.length; i++) {
      const it = wrappers[i];
      const im = it.im;
      const left = it.left;                   // picture box, page coordinates
      const top = it.top;
      const right = left + it.w;
      const centre = left + it.w / 2;
      const side = im.side === 'auto' ? (centre > pw / 2 ? 'right' : 'left') : im.side;

      // ...expressed in the FLOW's coordinates, because that is where the
      // floats live. A picture entirely out in the margin clamps to zero width
      // and simply does not carve, which is the honest result.
      const boxW = side === 'left'
        ? Math.max(0, Math.min(fw, (right - fx) + im.pad))
        : Math.max(0, Math.min(fw, (fx + fw - left) + im.pad));
      if (boxW <= 1) continue;

      const boxH = it.h + im.pad * 2;
      const topInFlow = top - fy - im.pad - originY;
      const used = side === 'left' ? usedLeft : usedRight;
      const shimH = Math.max(0, topInFlow - used);

      /* `clear` is what makes this work, and it is NOT optional: two floats on
         the same side sit SIDE BY SIDE whenever they both fit, so a 1px shim
         next to a 277px box left the box at the top of the column and the text
         ran straight through the picture (measured in Chrome, 2026-08-16 — four
         overlapping lines). Clearing each element past the previous one on its
         own side forces the strict top-down stack the arithmetic below assumes.
         Left and right chains stay independent because `clear` is per side. */
      if (shimH > 0) {
        const shim = document.createElement('span');
        shim.className = 'jr-shim';
        shim.style.cssText = 'display:block;float:' + side + ';clear:' + side +
          ';width:1px;height:' + shimH + 'px;margin-' +
          (side === 'left' ? 'right' : 'left') + ':-1px;';
        frag.appendChild(shim);
      }
      const box = document.createElement('span');
      box.className = 'jr-wrapbox';
      box.style.cssText = 'display:block;float:' + side + ';clear:' + side +
        ';width:' + boxW + 'px;height:' + boxH + 'px;';
      frag.appendChild(box);

      if (side === 'left') usedLeft += shimH + boxH; else usedRight += shimH + boxH;
    }
    if (before) flow.insertBefore(frag, before);
    else flow.appendChild(frag);
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* A picture's real proportions are only known once the bytes arrive. Cache it
     on the record (so the next open lays out correctly before the load) and
     re-layout when it actually changes. */
  function onImgLoad(e) {
    const img = e.target;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const holder = img.parentNode;
    const id = holder && holder.getAttribute ? holder.getAttribute('data-jr-img') : '';
    if (!id) return;
    const p = pageOfImage(id);
    if (!p) return;
    const im = p.images.filter(function (x) { return x.id === id; })[0];
    if (!im) return;
    const ar = img.naturalHeight / img.naturalWidth;
    if (Math.abs(ar - im.ar) >= 0.005) {
      im.ar = ar;
      touchPage(p);
      saveSoon();
    }
    /* ALWAYS re-layout, even when the ratio was already right. The carve is
       measured from the picture's RENDERED box, and until the bytes decode that
       box has no height — so the first layout after a paint cuts a hole 2×pad
       tall and the text runs straight through the picture. A browser hides this
       by having the image cached; Ultralight, loading from disk, does not.
       Measured in PrismaUI's own engine (2026-08-16): carve box 225x40 for a
       176x189 picture, 2 lines overlapping; after this re-layout 228x209 and
       zero. `ar` guards the SAVE, never the layout. */
    layoutAll();
  }

  function pageOfImage(id) {
    const ps = pages();
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].images.some(function (x) { return x.id === id; })) return ps[i];
    }
    return null;
  }

  /* ============================================================= wiring == */

  /* The four delegated listeners live on #jr-pane, which SURVIVES every repaint
     (only its children are replaced) — so they are bound exactly once. Binding
     them per render is how a click ends up firing four times. */
  function wireOnce() {
    const el = pane();
    if (!el || ui.wired) return;
    ui.wired = true;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('dblclick', onDblClick);
  }

  function wireAll() {
    const el = pane();
    if (!el) return;
    wireOnce();

    const imgs = el.querySelectorAll('.jr-img img');
    for (let i = 0; i < imgs.length; i++) {
      imgs[i].addEventListener('load', onImgLoad);
      /* A picture whose file went away must not leave a broken box on the page:
         it fades to a marked placeholder so the record can still be selected
         and removed. */
      imgs[i].addEventListener('error', function (ev) {
        const holder = ev.target.parentNode;
        if (holder) { holder.style.outline = '2px dashed rgba(140,47,29,.8)'; holder.style.minHeight = '60px'; }
      });
    }
    const ta = $('jr-ta');
    if (ta && ui.edit) {
      /* Re-focusing after a repaint would fight the deck's own focus handling,
         so the caret is only restored when this pane owns it already. */
      if (ui.taSel && document.activeElement !== ta) {
        try { ta.setSelectionRange(ui.taSel[0], ui.taSel[1]); } catch (e) { /* older engine */ }
      }
    }
  }

  function onDblClick(e) {
    if (!e.target.closest) return;
    if (e.target.closest('.jr-page') && !e.target.closest('.jr-img')) {
      if (!ui.edit) { ui.edit = true; renderAll(); }
      const ta = $('jr-ta');
      if (ta) ta.focus();
    }
  }

  function onInput(e) {
    const t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'jr-q') { ui.q = t.value; renderSide(); return; }
    if (t.id === 'jr-poolq') { ui.poolQ = t.value; renderPool(); return; }
    /* The shelf popover is appended INTO the pane, so it rides this same
       delegated listener — only its list is redrawn, never the popover, or the
       box would be taken out from under the caret. */
    if (t.id === 'jr-bookq') { ui.bookQ = t.value; renderBookList(); return; }
    if (t.id === 'jr-ptitle') {
      const p = curPage();
      if (!p) return;
      p.title = t.value;
      touchPage(p);
      previewSoon();
      saveSoon();
      return;
    }
    if (t.id === 'jr-ta') {
      const p = curPage();
      if (!p) return;
      p.text = t.value;
      ui.taSel = [t.selectionStart, t.selectionEnd];
      touchPage(p);
      previewSoon();
      saveSoon();
    }
  }

  /* Repaint only the book while typing — rebuilding the tools rail would take
     the textarea out from under the caret. */
  function previewSoon() {
    if (ui.prevT) clearTimeout(ui.prevT);
    ui.prevT = setTimeout(function () {
      ui.prevT = null;
      renderStageOnly();
    }, PREVIEW_DEBOUNCE_MS);
  }

  function renderStageOnly() {
    const el = pane();
    if (!el) return;
    const old = el.querySelector('.jr-stage');
    if (!old) { renderAll(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = stageHtml();
    const fresh = tmp.firstChild;
    old.parentNode.replaceChild(fresh, old);
    /* wireAll, not a hand-rolled load loop: the pictures also need their ERROR
       listener back, which is the only thing that leaves a missing file as a
       marked placeholder you can still select and remove instead of a hole in
       the page. Rebinding by hand here dropped it on every stage-only repaint
       (the typing preview, and now the spread/single fit). Pages are the only
       place .jr-img lives, so nothing gets a second listener. */
    wireAll();
    layoutAll();
    renderSaveChip();
  }

  function renderSide() {
    const el = pane();
    if (!el) return;
    const old = el.querySelector('.jr-side');
    if (!old) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = sideHtml();
    const fresh = tmp.firstChild;
    const input = old.querySelector('#jr-q');
    const hadFocus = document.activeElement === input;
    old.parentNode.replaceChild(fresh, old);
    if (hadFocus) {
      const q = fresh.querySelector('#jr-q');
      if (q) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) { /* older engine */ } }
    }
  }

  function renderPool() {
    const el = pane();
    if (!el) return;
    const card = $('jr-piccard');
    if (!card) { renderAll(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = pictureCardHtml(curPage());
    const fresh = tmp.firstChild;
    const input = card.querySelector('#jr-poolq');
    const hadFocus = document.activeElement === input;
    card.parentNode.replaceChild(fresh, card);
    if (hadFocus) {
      const q = fresh.querySelector('#jr-poolq');
      if (q) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) { /* older engine */ } }
    }
  }

  /* ------------------------------------------------------------- clicks -- */

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;

    const hit = function (attr) { const n = t.closest('[data-' + attr + ']'); return n ? n.getAttribute('data-' + attr) : null; };

    if (t.closest('#jr-mode')) { ui.edit = !ui.edit; ui.sel = ''; renderAll(); return; }
    if (t.closest('#jr-bookpick')) { openBookPop(t.closest('#jr-bookpick')); return; }
    if (t.closest('#jr-prev')) { turn(-1); return; }
    if (t.closest('#jr-next')) { turn(1); return; }
    if (t.closest('#jr-newpage')) { addPage(pages().length); return; }
    if (t.closest('#jr-photo')) { takePhoto(); return; }
    if (t.closest('#jr-refresh')) { toGame('jrImages', JSON.stringify({ sweep: true })); toast('Looking for new pictures…'); return; }
    if (t.closest('#jr-reread')) { toGame('jrOpen', ''); toast('Reading the journal again…'); return; }

    const pageIdx = hit('jr-page');
    if (pageIdx !== null) { ui.page = spreadStart(parseInt(pageIdx, 10) || 0); ui.sel = ''; renderAll(); return; }

    const drop = hit('jr-drop');
    if (drop !== null) { e.stopPropagation(); dropPicture(drop); return; }

    const add = hit('jr-add');
    if (add !== null) { placePicture(add); return; }

    const mark = hit('jr-mark');
    if (mark !== null) { wrapSelection(mark); return; }
    const line = hit('jr-line');
    if (line !== null) { prefixLine(line); return; }
    const ins = hit('jr-ins');
    if (ins !== null) { insertAtCaret(ins.replace(/\\n/g, '\n')); return; }

    const font = hit('jr-font');
    if (font !== null) { state.doc.style.font = font; docTouched(); renderAll(); return; }
    const paper = hit('jr-paper');
    if (paper !== null) { state.doc.style.paper = paper; docTouched(); renderAll(); return; }
    const ink = hit('jr-ink');
    if (ink !== null) { state.doc.style.ink = ink; docTouched(); renderAll(); return; }
    const sty = hit('jr-style');
    if (sty !== null) { state.doc.style[sty] = !state.doc.style[sty]; docTouched(); clampPage(); renderAll(); return; }

    const step = hit('jr-step');
    if (step !== null) { doStep(step); return; }

    const mode = hit('jr-mode');
    if (mode !== null && MODES.some(function (m) { return m.id === mode; })) { setImg('mode', mode); return; }
    const side = hit('jr-side');
    if (side !== null) { setImg('side', side); return; }
    const frame = hit('jr-frame');
    if (frame !== null) { setImg('frame', frame); return; }
    const act = hit('jr-imgact');
    if (act !== null) { imgAction(act); return; }
    const bg = hit('jr-bg');
    if (bg !== null) { bgAction(bg); return; }
    const pact = hit('jr-page-act');
    if (pact !== null) { pageAction(pact); return; }

    const bookId = hit('jr-book');
    if (bookId !== null) { pickBook(bookId); return; }
    if (t.closest('#jr-book-new')) { addBook(); return; }
    if (t.closest('#jr-book-rename')) { renameBook(); return; }

    // A click on a picture selects it (edit mode); a click on bare page clears.
    const imgNode = t.closest('.jr-img');
    if (imgNode && ui.edit) { ui.sel = imgNode.getAttribute('data-jr-img'); renderAll(); return; }
    if (t.closest('.jr-page') && ui.edit && ui.sel) { ui.sel = ''; renderAll(); return; }
  }

  function docTouched() {
    if (!state.doc) return;
    state.doc.updatedAt = nowSec();
    state.dirty = true;
    saveSoon();
  }

  function turn(dir) {
    const step = spreadWide() ? 2 : 1;
    const n = pages().length;
    const next = ui.page + dir * step;
    if (next < 0 || next >= n) return;
    ui.page = spreadStart(next);
    ui.sel = '';
    renderAll();
  }

  /* ---------------------------------------------------------- the text -- */

  function ta() { return $('jr-ta'); }

  function wrapSelection(mark) {
    const el = ta();
    if (!el) return;
    const open = mark;
    const close = mark.indexOf('{{') === 0 ? mark.replace('{{', '{{/') : mark;
    const s = el.selectionStart, e2 = el.selectionEnd;
    const sel = el.value.slice(s, e2) || 'text';
    el.value = el.value.slice(0, s) + open + sel + close + el.value.slice(e2);
    el.focus();
    const caret = s + open.length + sel.length;
    try { el.setSelectionRange(s + open.length, caret); } catch (err) { /* older engine */ }
    commitText(el);
  }

  function prefixLine(prefix) {
    const el = ta();
    if (!el) return;
    const v = el.value;
    const s = el.selectionStart;
    let lineStart = v.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
    el.value = v.slice(0, lineStart) + prefix + v.slice(lineStart);
    el.focus();
    try { el.setSelectionRange(s + prefix.length, s + prefix.length); } catch (err) { /* older engine */ }
    commitText(el);
  }

  function insertAtCaret(txt) {
    const el = ta();
    if (!el) return;
    const s = el.selectionStart, e2 = el.selectionEnd;
    el.value = el.value.slice(0, s) + txt + el.value.slice(e2);
    el.focus();
    try { el.setSelectionRange(s + txt.length, s + txt.length); } catch (err) { /* older engine */ }
    commitText(el);
  }

  function commitText(el) {
    const p = curPage();
    if (!p) return;
    p.text = el.value;
    ui.taSel = [el.selectionStart, el.selectionEnd];
    touchPage(p);
    renderStageOnly();
    saveSoon();
  }

  /* -------------------------------------------------------- the pictures */

  function selImg() {
    const p = curPage();
    if (!p) return null;
    return p.images.filter(function (x) { return x.id === ui.sel; })[0] || null;
  }

  function setImg(field, value) {
    const im = selImg();
    if (!im) return;
    im[field] = value;
    touchPage(curPage());
    saveSoon();
    renderAll();
  }

  function doStep(spec) {
    const parts = String(spec).split(':');
    const what = parts[0];
    const dir = parseInt(parts[1], 10) || 1;
    if (what === 'size') {
      state.doc.style.size = Math.max(13, Math.min(34, state.doc.style.size + dir));
      docTouched(); renderAll(); return;
    }
    const im = selImg();
    if (!im) return;
    if (what === 'w') im.w = num(im.w + dir * 0.03, im.w, 0.04, 1.6);
    if (what === 'rot') im.rot = num(im.rot + dir * 2, im.rot, -180, 180);
    if (what === 'op') im.op = num(im.op + dir * 0.05, im.op, 0.05, 1);
    if (what === 'pad') im.pad = num(im.pad + dir * 2, im.pad, 0, 80);
    touchPage(curPage());
    saveSoon();
    renderAll();
  }

  function imgAction(act) {
    const p = curPage();
    const im = selImg();
    if (!p || !im) return;
    if (act === 'flip') { im.flip = !im.flip; }
    if (act === 'bg') {
      p.bg = { src: im.src, fit: 'cover', op: 0.55 };
    }
    if (act === 'remove') {
      p.images = p.images.filter(function (x) { return x.id !== im.id; });
      ui.sel = '';
    }
    touchPage(p);
    saveSoon();
    renderAll();
  }

  function bgAction(act) {
    const p = curPage();
    if (!p || !p.bg) return;
    if (act === 'clear') p.bg = null;
    if (act === 'fit') p.bg.fit = p.bg.fit === 'cover' ? 'contain' : (p.bg.fit === 'contain' ? 'tile' : 'cover');
    if (act === 'more') p.bg.op = num(p.bg.op + 0.08, p.bg.op, 0.03, 1);
    if (act === 'less') p.bg.op = num(p.bg.op - 0.08, p.bg.op, 0.03, 1);
    touchPage(p);
    saveSoon();
    renderAll();
  }

  function placePicture(f) {
    const p = curPage();
    if (!p) { toast('Add a page first.'); return; }
    if (p.images.length >= 40) { toast('That page already holds 40 pictures.'); return; }
    const im = normImage({ src: f, x: 0.14, y: 0.14 + (p.images.length % 4) * 0.06, w: 0.36, mode: 'wrap' });
    p.images.push(im);
    ui.sel = im.id;
    touchPage(p);
    saveSoon();
    renderAll();
    toast('Placed — drag it where you want it.');
  }

  function dropPicture(f) {
    const used = [];
    state.doc.books.forEach(function (b) {
      b.pages.forEach(function (pg) {
        if (pg.images.some(function (x) { return x.src === f; }) || (pg.bg && pg.bg.src === f)) used.push(pg);
      });
    });
    if (used.length && ui.dropArm !== f) {
      ui.dropArm = f;
      toast('That picture is on ' + used.length + ' page' + (used.length === 1 ? '' : 's') + ' — press ✕ again to delete it anyway.');
      return;
    }
    ui.dropArm = '';
    toGame('jrDropImage', JSON.stringify({ f: f }));
  }

  function takePhoto() {
    /* The palette closes for the shot, so anything unsaved must go now — there
       is no "later" once the view is torn down. */
    saveNow();
    toGame('jrPhoto', JSON.stringify({ name: 'Journal picture' }));
    startPoll();
  }

  function startPoll() {
    stopPoll();
    ui.pollN = 0;
    ui.pollT = setInterval(function () {
      ui.pollN++;
      if (ui.pollN > IMG_POLL_MAX) { stopPoll(); return; }
      toGame('jrImages', JSON.stringify({ sweep: true }));
    }, IMG_POLL_MS);
  }
  function stopPoll() { if (ui.pollT) { clearInterval(ui.pollT); ui.pollT = null; } }

  /* ------------------------------------------------------------- pages -- */

  function addPage(at) {
    const b = book();
    if (!b) return;
    if (b.pages.length >= 400) { toast('This book is full at 400 pages — start another.'); return; }
    const p = normPage({});
    p.updatedAt = nowSec();
    b.pages.splice(Math.max(0, Math.min(b.pages.length, at)), 0, p);
    b.updatedAt = nowSec();
    state.doc.updatedAt = nowSec();
    state.dirty = true;
    ui.page = spreadStart(pageIndexById(p.id));
    ui.sel = '';
    saveSoon();
    renderAll();
  }

  function pageAction(act) {
    const b = book();
    const p = curPage();
    if (!b || !p) return;
    const i = pageIndexById(p.id);
    if (act === 'drop') { p.style.drop = p.style.drop === false; touchPage(p); saveSoon(); renderAll(); return; }
    if (act === 'before') { addPage(i); return; }
    if (act === 'after') { addPage(i + 1); return; }
    if (act === 'up' && i > 0) {
      b.pages.splice(i - 1, 0, b.pages.splice(i, 1)[0]);
      ui.page = spreadStart(i - 1); touchPage(p); saveSoon(); renderAll(); return;
    }
    if (act === 'down' && i < b.pages.length - 1) {
      b.pages.splice(i + 1, 0, b.pages.splice(i, 1)[0]);
      ui.page = spreadStart(i + 1); touchPage(p); saveSoon(); renderAll(); return;
    }
    if (act === 'tear') {
      if (ui.tearArm !== p.id) {
        ui.tearArm = p.id;
        toast('Press ✂ again to tear this page out — it cannot be undone.');
        return;
      }
      ui.tearArm = '';
      /* A tombstone, not just a splice: the phone may still hold this page, and
         without the stamp the next merge would put it straight back. */
      state.doc.trash.push({ id: p.id, at: nowSec() });
      b.pages = b.pages.filter(function (x) { return x.id !== p.id; });
      if (!b.pages.length) b.pages.push(normPage({}));
      b.updatedAt = nowSec();
      state.doc.updatedAt = nowSec();
      state.dirty = true;
      ui.page = spreadStart(Math.max(0, Math.min(b.pages.length - 1, i)));
      saveNow();
      renderAll();
    }
  }

  /* ------------------------------------------------------------- books -- */

  /* The books the shelf popover is currently offering — the whole shelf, or
     what the popover's own filter has narrowed it to. One list, so what Enter
     picks is always what is drawn at the top. */
  function shownBooks() {
    const q = ui.bookQ.trim().toLowerCase();
    if (!q) return state.doc.books;
    return state.doc.books.filter(function (b) {
      return b.title.toLowerCase().indexOf(q) !== -1;
    });
  }

  function bookRowsHtml() {
    const list = shownBooks();
    if (!list.length) {
      return '<div class="jr-empty"><b>No book called that</b>Try part of the title.</div>';
    }
    return list.map(function (b) {
      return '<button class="jr-pop-row' + (b.id === state.doc.activeBook ? ' on' : '') + '" type="button" data-jr-book="' + esc(b.id) + '">' +
        '<span>' + esc(b.title) + '</span><span class="jr-pr-sub">' + b.pages.length + ' pages</span></button>';
    }).join('');
  }

  function renderBookList() {
    const list = document.querySelector('#jr-pop .jr-pop-list');
    if (list) list.innerHTML = bookRowsHtml();
  }

  function openBookPop(anchor) {
    closePop();
    const el = pane();
    if (!el || !anchor) return;
    ui.bookQ = '';   // the popover always opens on the whole shelf
    /* The shelf holds up to forty books, so past a handful it gets the deck's
       standing search bar — filter as you type, Enter takes the top hit. The
       threshold matches the picture pool's, which is the same call. */
    const many = state.doc.books.length > 8;
    const pop = document.createElement('div');
    pop.className = 'jr-pop';
    pop.id = 'jr-pop';
    pop.innerHTML =
      (many
        ? '<div class="jr-searchbar"><span class="jr-sb-glyph">⌕</span>' +
          '<input id="jr-bookq" type="text" autocomplete="off" spellcheck="false" ' +
          'placeholder="Search books… (Enter opens the top one)" value=""></div>'
        : '') +
      '<div class="jr-pop-list">' + bookRowsHtml() + '</div>' +
      '<div class="jr-row" style="margin-top:8px">' +
      '<button class="jr-btn jr-btn-sm" id="jr-book-new" type="button">✚ New book</button>' +
      '<button class="jr-btn jr-btn-sm" id="jr-book-rename" type="button">✎ Rename</button></div>';
    el.appendChild(pop);
    const q = $('jr-bookq');
    if (q) {
      q.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const top = shownBooks()[0];
        if (top) pickBook(top.id);
      });
      q.focus();
    }
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    pop.style.left = Math.max(8, a.left - r.left) + 'px';
    pop.style.top = (a.bottom - r.top + 6) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', popAway, true); }, 0);
  }
  function popAway(e) {
    const pop = $('jr-pop');
    if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest('#jr-bookpick'))) closePop();
  }
  function closePop() {
    const pop = $('jr-pop');
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    document.removeEventListener('mousedown', popAway, true);
  }

  function pickBook(id) {
    if (!state.doc.books.some(function (b) { return b.id === id; })) return;
    state.doc.activeBook = id;
    ui.page = 0; ui.sel = ''; ui.q = '';
    /* Picking by hand retires a pending Omni jump: it is the same decision,
       made later, and re-applying the older one on the next read would take the
       shelf back to a book the player has already moved on from. */
    ui.want = null;
    docTouched();
    closePop();
    renderAll();
  }

  /* Landing here from Omni — on a book, or on a page inside one. Two things
     make this more than a pickBook(): the page can only be resolved once its
     book is the active one, and onShow re-reads the journal from disk, so the
     pick is ALSO remembered in ui.want and re-applied when that reply lands
     (see jrData) instead of being quietly undone by it. */
  function goTo(bookId, pageId) {
    ui.want = { book: bookId || '', page: pageId || '' };
    host.setTab('journal');
    applyWant();
    render();
  }

  function applyWant() {
    const w = ui.want;
    if (!w || !state.doc) return;
    if (w.book && w.book !== state.doc.activeBook &&
        state.doc.books.some(function (b) { return b.id === w.book; })) {
      state.doc.activeBook = w.book;
      ui.sel = ''; ui.q = '';
      /* Which book is open lives in the document, so the switch is a real edit
         — the shelf popover persists it the same way. */
      docTouched();
    }
    const idx = w.page ? pageIndexById(w.page) : -1;
    ui.page = idx >= 0 ? spreadStart(idx) : 0;
    clampPage();
  }

  function addBook() {
    if (state.doc.books.length >= 40) { toast('Forty books is the shelf full.'); return; }
    const b = normBook({ title: 'New book' });
    b.updatedAt = nowSec();
    state.doc.books.push(b);
    state.doc.activeBook = b.id;
    ui.page = 0; ui.sel = '';
    docTouched();
    closePop();
    renderAll();
    setTimeout(renameBook, 30);
  }

  function renameBook() {
    const b = book();
    if (!b) return;
    closePop();
    const el = pane();
    const head = el.querySelector('.jr-bookpick');
    if (!head) return;
    const input = document.createElement('input');
    input.className = 'jr-input';
    input.id = 'jr-book-name';
    input.value = b.title;
    input.style.maxWidth = '260px';
    head.parentNode.replaceChild(input, head);
    input.focus();
    input.select();
    const done = function (commit) {
      if (commit) {
        const v = input.value.trim();
        b.title = v || b.title;
        b.updatedAt = nowSec();
        docTouched();
      }
      renderAll();
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', function () { done(true); });
  }

  /* ============================================================== drag == */

  /* mousedown/mousemove/mouseup on document — the idiom every other draggable
     surface in this view uses (pointer events are not proven in Ultralight). */
  function onMouseDown(e) {
    if (!ui.edit || e.button !== 0) return;
    const handle = e.target.closest ? e.target.closest('[data-jr-h]') : null;
    const node = e.target.closest ? e.target.closest('.jr-img') : null;
    if (!node) return;
    const id = node.getAttribute('data-jr-img');
    const p = pageOfImage(id);
    const im = p ? p.images.filter(function (x) { return x.id === id; })[0] : null;
    if (!im) return;
    const pageEl = node.closest('.jr-page');
    if (!pageEl) return;

    e.preventDefault();
    if (ui.sel !== id) { ui.sel = id; renderAll(); }

    const kind = handle ? handle.getAttribute('data-jr-h') : 'move';
    const rect = pageEl.getBoundingClientRect();
    ui.drag = {
      kind: kind, id: id, page: p, im: im, pageEl: pageEl,
      pw: rect.width, ph: rect.height, left: rect.left, top: rect.top,
      x0: e.clientX, y0: e.clientY,
      ix: im.x, iy: im.y, iw: im.w, irot: im.rot,
      moved: false,
    };
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onDragUp, true);
  }

  function onDragMove(e) {
    const d = ui.drag;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    if (d.kind === 'move') {
      d.im.x = num(d.ix + dx / d.pw, d.ix, -0.5, 1.5);
      d.im.y = num(d.iy + dy / d.ph, d.iy, -0.5, 2.5);
    } else if (d.kind === 'size') {
      // width follows the pointer's distance from the picture's left edge
      const leftPx = d.im.x * d.pw;
      const wPx = (e.clientX - d.left) - leftPx;
      d.im.w = num(wPx / d.pw, d.iw, 0.04, 1.6);
    } else if (d.kind === 'rot') {
      const cx = d.left + (d.im.x + d.im.w / 2) * d.pw;
      const cy = d.top + (d.im.y * d.ph) + (d.im.w * d.pw * d.im.ar) / 2;
      const ang = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI + 90;
      d.im.rot = num(e.shiftKey ? ang : Math.round(ang / 2) * 2, d.irot, -180, 180);
    }
    layoutPage(d.pageEl, d.page);
  }

  function onDragUp() {
    const d = ui.drag;
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onDragUp, true);
    ui.drag = null;
    if (!d) return;
    if (d.moved) {
      touchPage(d.page);
      saveSoon();
      /* The tools rail shows the numbers that just changed, so it is repainted
         once at the END of the drag — never during it. */
      renderAll();
    }
  }

  /* ============================================================= keys === */

  function onKeyDown(e) {
    if (!ui.visible) return false;
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT');
    if (typing) return false;

    if (e.key === 'ArrowLeft' && !ui.sel) { turn(-1); return true; }
    if (e.key === 'ArrowRight' && !ui.sel) { turn(1); return true; }

    const im = selImg();
    if (im && ui.edit) {
      const step = e.shiftKey ? 0.04 : 0.008;
      let moved = true;
      if (e.key === 'ArrowLeft') im.x = num(im.x - step, im.x, -0.5, 1.5);
      else if (e.key === 'ArrowRight') im.x = num(im.x + step, im.x, -0.5, 1.5);
      else if (e.key === 'ArrowUp') im.y = num(im.y - step, im.y, -0.5, 2.5);
      else if (e.key === 'ArrowDown') im.y = num(im.y + step, im.y, -0.5, 2.5);
      else if (e.key === 'Delete' || e.key === 'Backspace') { imgAction('remove'); return true; }
      else moved = false;
      if (moved) {
        touchPage(curPage());
        saveSoon();
        layoutAll();   // owns the placement — nothing else writes left/top
        return true;
      }
    }
    return false;
  }

  /* ============================================================ toast === */

  function toast(msg) {
    const el = pane();
    if (!el) return;
    let t = el.querySelector('.jr-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'jr-toast';
      el.appendChild(t);
    }
    t.textContent = msg;
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () {
      if (t && t.parentNode) t.parentNode.removeChild(t);
      ui.toastT = null;
    }, 3200);
  }

  /* ====================================================== host contract == */

  function init() {
    document.addEventListener('keydown', function (e) {
      if (onKeyDown(e)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    window.addEventListener('resize', function () { if (ui.visible) layoutAll(); });

    /* THE PALETTE CAN CLOSE WITHOUT A TAB SWITCH. onHide() only runs when you
       leave the tab, so F7-with-the-Journal-open would have dropped whatever
       the 900 ms debounce had not written yet — a sentence, typically. Chain
       the close push (the deck idiom: capture the previous handler, call it) and
       flush first. */
    const prevClosed = window.hdClosed;
    window.hdClosed = function () {
      try { saveNow(); } catch (e) { /* a failed save must not eat the close */ }
      ui.visible = false;
      stopPoll();
      if (typeof prevClosed === 'function') prevClosed.apply(this, arguments);
    };
  }

  function onShow() {
    ui.visible = true;
    /* Always re-ask: the phone may have written a page since the last look, and
       the sweep on the C++ side is what pulls in pictures dropped into the
       folder. Cheap — it is one file read plus a directory listing. */
    toGame('jrOpen', '');
    render();
  }

  function onHide() {
    ui.visible = false;
    stopPoll();
    closePop();
    /* Never leave the page unsaved behind a tab switch — the deck can be closed
       from anywhere, and a debounce that never fires is lost writing. */
    saveNow();
  }

  function toggleEdit() { ui.edit = !ui.edit; ui.sel = ''; renderAll(); }
  function wantsPause() { return true; }
  function setFilter(q) { ui.q = String(q == null ? '' : q); if (ui.visible) renderSide(); }

  /* Omni: pages are findable by their heading AND their prose, which is the
     whole reason to keep a journal you can search. Enter opens the page.
     The BOOKS are indexed in their own right too — a page row carries its
     book's title only as detail, and a book that is new or still empty has no
     page rows at all, so without these the only way to reach one is to know it
     is there and click the shelf. */
  if (window.HDOmni) HDOmni.register({
    id: 'journal', label: 'Journal', tab: 'journal',
    setFilter: setFilter,
    index: function () {
      const out = [{ label: 'Journal', detail: 'Write pages by hand, with pictures anywhere on them',
        kind: 'journal', keywords: 'journal diary notes write book log chronicle memoir pages' }];
      /* Taking a picture is a named button in the Pictures card and the only
         way to get a shot of the game itself onto a page, so it belongs in
         search under the words a player would actually type for it. */
      out.push({
        label: '📷 Take a picture',
        detail: 'Close the deck, line up a shot, and paste it into the journal',
        kind: 'journal',
        keywords: 'journal photo photograph screenshot picture camera shot capture image snap',
        run: function () { host.setTab('journal'); takePhoto(); return true; },
      });
      if (!state.doc) return out;
      state.doc.books.forEach(function (b) {
        out.push({
          label: b.title,
          detail: b.pages.length + ' page' + (b.pages.length === 1 ? '' : 's') +
            (b.id === state.doc.activeBook ? ' · open now' : ''),
          kind: 'journal',
          keywords: 'journal book volume shelf diary open switch ' + b.title,
          pin: 'jrb:' + b.id,
          run: function () { goTo(b.id, ''); return true; },
        });
        b.pages.forEach(function (p, i) {
          const body = p.text.replace(/\s+/g, ' ').trim();
          if (!body && !p.title.trim()) return;
          out.push({
            label: pageLabel(p, i),
            detail: b.title + ' · page ' + (i + 1) + (body ? ' — ' + body.slice(0, 90) : ''),
            kind: 'journal',
            keywords: 'journal page ' + b.title + ' ' + p.title + ' ' + body.slice(0, 400),
            pin: 'jr:' + b.id + ':' + p.id,
            run: function () { goTo(b.id, p.id); return true; },
          });
        });
      });
      return out;
    },
  });

  /* ============================================================== dev === */

  function devOpen() {
    window.jrData({
      ok: true,
      doc: {
        version: 1, activeBook: 'b1', updatedAt: 1,
        style: { paper: 'parchment', font: 'imfell', ink: 'sepia', size: 19, spread: true },
        books: [{ id: 'b1', title: 'Travels', updatedAt: 1, pages: [
          { id: 'p1', title: 'Riverwood, 17th of Last Seed',
            text: '# The road south\n\nThe **rain** did not stop until Helgen. I write this by a poor fire.\n\n> They say the Jarl will not see me.\n\n- one\n- two\n\n---\n\n{{script}}Signed, the Dragonborn{{/script}}',
            images: [{ id: 'i1', src: 'demo.png', x: 0.55, y: 0.3, w: 0.36, ar: 0.7, mode: 'wrap', side: 'right' }],
            updatedAt: 1 },
          { id: 'p2', title: '', text: 'A second page, still mostly empty.', images: [], updatedAt: 1 },
        ] }],
        trash: [],
      },
      images: [{ f: 'demo.png', mt: 1, sz: 1000 }],
      inbox: 'C:\\Users\\you\\Desktop\\SkyManager Journal Images',
    });
  }

  function devSave(arg) {
    let doc = null;
    try { doc = JSON.parse(arg).doc; } catch (e) { /* dev stub */ }
    window.jrSaved({ ok: true, doc: doc, merged: false });
  }

  return {
    init: init, onShow: onShow, onHide: onHide, toggleEdit: toggleEdit,
    wantsPause: wantsPause, setFilter: setFilter, hookInto: hookInto,
    /* the harness reaches in for these — see journal-pane.test.html */
    _state: state, _ui: ui, _render: render, _renderMarkup: renderMarkup,
    _layoutPage: layoutPage, _normDoc: normDoc, _pages: pages, _addPage: addPage,
    _placePicture: placePicture, _pageAction: pageAction, _turn: turn,
    _FONTS: FONTS, _PAPERS: PAPERS, _INKS: INKS, _MODES: MODES,
  };
})();

/* Self-init, the items-pane idiom: this file is in the deferred boot set, so by
   the time it parses the DOM is usually already up. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.JournalPane.init(); });
} else {
  window.JournalPane.init();
}
