/* ===================================================================== *
 *  Follower portraits — CSS additions for the Followers tab.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css. Additions only: no existing
 *  rule is edited and no token is redefined. The base `.medal` rule (round
 *  mask, --medal-hue border/glow, .following ring, .dead grayscale) is
 *  reused as-is — the image variant just adds `.img` alongside it, so the
 *  following-ring and dead-grayscale semantics come along for free.
 *
 *  Colours are the deck's own literals (#0c0c10 well, hsla --medal-hue).
 * ===================================================================== */

/* Portrait variant of the medallion. `.medal` already supplies the circle,
   the hue border and the state classes; this only teaches it to hold an
   image without letting the image square off the corners. */
.medal.img {
  padding: 0;
  overflow: hidden;
  object-fit: cover;
  /* Faces sit high in a screenshot far more often than dead-centre, so bias
     the crop upward instead of taking the middle band. */
  object-position: 50% 22%;
  background: #0c0c10;
}

/* Row art at ~40px for BOTH variants (initials and image alike).
   `.fd-member .medal` (0,2,0) outranks the base `.medal` (0,1,0), so this
   wins wherever it sits in the file — no need to touch the original rule. */
.fd-member .medal {
  width: 40px;
  height: 40px;
  font-size: 13.5px;
  letter-spacing: .4px;
}

/* A dead follower's portrait desaturates exactly like the initials medallion
   does; spelled out because a filter on an <img> is worth being explicit
   about, and it keeps the two variants visually identical in that state. */
.fd-member .medal.img.dead { filter: grayscale(1) brightness(.8); }

/* Portraits are decoded as the tab renders; a subtle fade keeps a long list
   from flashing as images land, and matches the deck's 140ms rhythm. */
.medal.img { animation: fdPortraitIn 140ms ease; }
@keyframes fdPortraitIn { from { opacity: 0; } to { opacity: 1; } }

/* Never let a dragged row rip the image out as a browser drag payload —
   the row itself is draggable (member reorder) and the image must not
   compete with it. */
.medal.img { -webkit-user-drag: none; user-select: none; pointer-events: none; }

/* ===================================================================== *
 *  Portrait CROP (v0.14.3) — the WYSIWYG display crop.
 *
 *  APPEND VERBATIM to view/HotkeyDeck/app.css, immediately after the
 *  portraits block above. Additions only; the two edits to existing rules
 *  are called out where they happen and are both in `.medal.img`.
 *
 *  WHY A WRAPPER. The crop is a CSS transform, and a transform on an <img>
 *  scales the element's OWN rounded clip with it — a zoomed face would grow
 *  a bigger circle and push the row apart. So `.medal.img` is now a <span>
 *  that owns the circle, and `.medal-face` is the <img> inside it that owns
 *  the cover fit and the transform, clipped by the wrapper's overflow.
 * ===================================================================== */

/* The wrapper: same circle as before, but it must now CLIP a child that can
   be four times its size, and it must be clickable. Both differ from the
   old image-as-medallion rule and are the only behavioural changes here. */
.medal.img {
  padding: 0;
  overflow: hidden;
  background: #0c0c10;
  /* Was `none` while the medallion WAS the image: the row is draggable and
     the photo must not compete for the gesture. The wrapper can take the
     click safely — mousedown still bubbles to the row, so PDrag is
     unaffected — and without this the "click a face to enlarge it" path
     never fired at all, because every click landed on the row instead. */
  pointer-events: auto;
}

.medal-face {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  /* Faces sit high in a screenshot far more often than dead-centre, so bias
     the crop upward instead of taking the middle band. A saved crop
     overrides this inline (applyCropTo) — the user has said where the face
     is and the guess must get out of the way. */
  object-position: 50% 22%;
  border-radius: 50%;
  /* The photo is scenery inside the wrapper: no drag payload, no hit test. */
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}

/* ---- lightbox: square frame, so the big view IS the row's view ---- */
.fd-lb-frame {
  position: relative;
  overflow: hidden;
  flex: none;
  border-radius: 10px;
  border: 1px solid #3a3a44;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .6);
  background: #0c0c10;
  /* Sized in px by JS (lbFrameSize) — the editor divides pointer travel by
     this number, and a size that came from a CSS function Ultralight
     computes its own way would make the pan gain wrong in game and right in
     the harness. */
}
.fd-lb-frame.editing { cursor: grab; box-shadow: 0 0 0 2px #c9a24b, 0 18px 48px rgba(0, 0, 0, .6); }
.fd-lb-frame.dragging { cursor: grabbing; }

/* Overrides the free-aspect .fd-lb-img above: inside the frame the photo is
   cover-fitted exactly as the roster medallion fits it, which is the whole
   basis of the editor's promise. */
.fd-lb-frame .fd-lb-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: cover;
  object-position: 50% 22%;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}

/* The circle guide, on only while editing. It is inscribed in the frame
   because that is EXACTLY what the roster medallion shows — everything
   outside it is trimmed by the circular mask on the row. Drawn on the FRAME
   so it stays put while the photo moves under it. */
.fd-lb-frame.editing::after {
  content: '';
  position: absolute;
  inset: 1px;
  border: 1px dashed rgba(201, 162, 75, .42);
  border-radius: 50%;
  pointer-events: none;
}

/* ---- lightbox footer / editor controls ----
   Its OWN well, not bare text on the backdrop. The overlay is only 74%
   opaque, so an unbacked hint line lands legibly on top of whatever roster
   row happens to be behind it — which at 1280x800 is the "click a follower"
   help text, and the two read as one garbled sentence. */
.fd-lb-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  max-width: 100%;
  padding: 8px 10px;
  border: 1px solid #2e2e38;
  border-radius: 10px;
  background: rgba(12, 12, 16, .94);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .5);
}

.fd-lb-btn {
  appearance: none;
  min-width: 30px;
  padding: 5px 10px;
  font: 600 12.5px/1 "Segoe UI", sans-serif;
  color: #d8d4c8;
  background: #1a1a22;
  border: 1px solid #3a3a44;
  border-radius: 6px;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.fd-lb-btn:hover:not(:disabled) { background: #23232e; border-color: #55555f; color: #f0ece0; }
.fd-lb-btn:focus-visible { outline: none; border-color: #c9a24b; box-shadow: 0 0 0 2px rgba(201, 162, 75, .25); }
.fd-lb-btn:active:not(:disabled) { background: #2a2a36; }
.fd-lb-btn:disabled { opacity: .38; cursor: default; }
.fd-lb-btn.ok { color: #8fd19e; border-color: #3d6b4a; }
.fd-lb-btn.ok:hover:not(:disabled) { background: #1c2a20; border-color: #4f8560; }

/* The six nudge keys as one block, so they read as a d-pad rather than as
   six more buttons in the row. */
.fd-lb-pad {
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid #2e2e38;
  border-radius: 8px;
  background: rgba(0, 0, 0, .35);
}
.fd-lb-pad .fd-lb-btn { min-width: 26px; padding: 5px 7px; }

.fd-lb-val {
  font: 12px/1 Consolas, monospace;
  letter-spacing: .3px;
  color: #9d968a;
  padding: 0 4px;
  white-space: nowrap;
}

/* Full-width line under the controls; `flex-basis: 100%` rather than a
   block, so it wraps to its own row however many buttons precede it. */
.fd-lb-hint {
  flex: 0 0 100%;
  text-align: center;
  font: 11.5px/1.5 "Segoe UI", sans-serif;
  color: #6f6a5e;
}

/* ---- Party card polish (2026-08-03: "needs better padding / separation") --
   The no-target card was two label rows jammed together inside one flat box.
   Each half (Current party / Everyone) becomes its own inset card, the faces
   and eyebrows grow to the standing no-small-text bar, and the card gets real
   air before the roster's first group header. */
.fq.empty.party { padding: 16px 16px 15px; }
.fq.empty.party .fq-party {
  background: #14141b; border: 1px solid #2a2a33; border-radius: 10px;
  padding: 12px 14px 13px; margin-top: 0;
}
.fq.empty.party .fq-party + .fq-party { margin-top: 10px; }
.fq.empty.party .fq-eyebrow {
  font-size: 12.5px; letter-spacing: .8px; margin-bottom: 10px; color: #8f8a7c;
}
.fq.empty.party .fq-crew-row { gap: 8px 16px; }
.fq.empty.party .fq-crew-face { width: 34px; height: 34px; }
.fq.empty.party .fq-crew-name { font-size: 14px; }
.fq.empty.party .fq-acts { gap: 8px; }
/* The crosshair hint reads as an aside, not a stray sentence in the void. */
.fq.empty.party .fq-empty {
  margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(255,255,255,.05);
  font-size: 12.5px;
}
/* Air between the whole card and the first roster group underneath it. */
.fq.empty.party { margin-bottom: 12px; }
