# Follower portraits — `followers-pane.js` patch

Four **minimal, anchored** edits to `view/HotkeyDeck/followers-pane.js`, plus one
new file to append to `app.css`. Nothing else in the pane changes: the FolPane
contract, the fd* bridge, drag-reorder, the context menu and the search are all
untouched.

Each edit below gives the **exact current text** (OLD) and what it becomes (NEW).
The OLD blocks are verbatim from the `hotkey-deck-quest-inspector` tip — search
for them literally.

| # | Where | What |
|---|---|---|
| 1 | `state` object, ~line 26 | one new field: `portraits: {}` |
| 2 | after `hueOf()`, ~line 111 | `slugOf()` / `portraitFor()` / `initialsMedal()` + rewritten `medalEl()` |
| 3 | after `window.fdTarget`, ~line 621 | new receiver `window.fdPortraits()` |
| 4 | `app.css` | append `followers-portraits.css.frag` |

Also ships: `view/HotkeyDeck/portraits/README.txt` (the folder + its slug rule).
The C++ side is in `src/portraits-wiring.md`.

---

## 1. `state` — remember the portrait listing

**OLD**

```js
  const state = {
    openKey: { device: 'keyboard', code: 101, label: 'F14' },  // F14 = extended F-key bridge
    cats: [],
    total: 0,
    target: null,
    foMissing: '',
    loaded: false,   // got at least one fdState this session
  };
```

**NEW**

```js
  const state = {
    openKey: { device: 'keyboard', code: 101, label: 'F14' },  // F14 = extended F-key bridge
    cats: [],
    total: 0,
    target: null,
    foMissing: '',
    loaded: false,   // got at least one fdState this session
    /* slug -> { ext, mtime } for every file in the view's portraits/ folder.
       Pushed by C++ (fdPortraits) at palette open and on every fdRefresh; we
       never ask for it, so a rig with no portraits folder simply leaves this
       empty and every row keeps its initials medallion. */
    portraits: {},
  };
```

---

## 2. `medalEl()` — render a portrait when one exists

The old `medalEl` is replaced, and three small helpers are added above it.
`initialsMedal()` is literally the old body, extracted so the image variant can
fall back to it.

**OLD**

```js
  function hueOf(catIndex) { return (catIndex * 47) % 360; }

  function medalEl(m, catIndex) {
    const el = h('span', { class: 'medal' + (m.following ? ' following' : '') + (m.dead ? ' dead' : '') }, initialsOf(m.name));
    el.style.setProperty('--medal-hue', String(hueOf(catIndex)));
    return el;
  }
```

**NEW**

```js
  function hueOf(catIndex) { return (catIndex * 47) % 360; }

  /* Portrait file slug. MUST stay identical to the two other implementations
     of this rule — portal/server.js slugOf() and the names in
     portraits/README.txt:
       lowercase -> strip diacritics -> each run of non [a-z0-9] becomes one
       '-' -> trim leading/trailing '-'.
     Always computed from the ORIGINAL name, never the display name: people
     get renamed in the deck constantly, and the file must keep matching. */
  function slugOf(name) {
    let s = String(name == null ? '' : name);
    // Ultralight's JS engine does have normalize(), but a missing normalize
    // must degrade to "no accent folding", never to a thrown render.
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep s */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function portraitFor(m) {
    const slug = slugOf(m.original || m.name);
    const p = slug ? state.portraits[slug] : null;
    return p ? { slug: slug, ext: p.ext, mtime: p.mtime } : null;
  }

  /* The original medallion, unchanged — now also the fallback for a portrait
     that fails to load. */
  function initialsMedal(m, hue) {
    const el = h('span', { class: 'medal' + (m.following ? ' following' : '') + (m.dead ? ' dead' : '') }, initialsOf(m.name));
    el.style.setProperty('--medal-hue', hue);
    return el;
  }

  function medalEl(m, catIndex) {
    const hue = String(hueOf(catIndex));
    const p = portraitFor(m);
    if (!p) return initialsMedal(m, hue);
    /* ?v=<mtime> is what makes "replace a portrait mid-session" actually
       show: Ultralight caches view-relative images by URL, so the same
       filename with new bytes would otherwise keep painting the old picture. */
    const img = h('img', {
      class: 'medal img' + (m.following ? ' following' : '') + (m.dead ? ' dead' : ''),
      src: 'portraits/' + p.slug + '.' + p.ext + '?v=' + p.mtime,
      alt: '',
      title: m.name,
      draggable: 'false',
    });
    img.style.setProperty('--medal-hue', hue);
    /* Deleted between the C++ scan and this render (or a corrupt file): swap
       the initials medallion in rather than leaving a broken-image glyph. */
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.replaceChild(initialsMedal(m, hue), img);
    });
    return img;
  }
```

**Why the classes are reused rather than replaced:** `medal following` and
`medal dead` keep working on the `<img>` because the ring is a `box-shadow` and
the dead state is a `filter` — both apply to a replaced element exactly as they
do to a `<span>`. That is deliberate: the two variants stay visually identical
in every state without a second set of rules.

---

## 3. `window.fdPortraits` — the receiver

Paste immediately **after** the existing `window.fdTarget` function (before
`window.fdSaved`).

**OLD** (anchor — leave as is, this is only to locate the spot)

```js
  window.fdTarget = function (t) {
    t = coerce(t);
    state.target = (t && t.name) ? { formId: t.formId >>> 0, name: String(t.name) } : null;
    if (isActive()) renderAdd();
  };
```

**NEW** (the same block, with the new receiver appended after it)

```js
  window.fdTarget = function (t) {
    t = coerce(t);
    state.target = (t && t.name) ? { formId: t.formId >>> 0, name: String(t.name) } : null;
    if (isActive()) renderAdd();
  };

  /* fdPortraits: the live portraits/ listing. Listener-free — C++ pushes it
     at palette open and again with every fdRefresh (which onShow() triggers),
     so we never have to ask. Payload is [{ slug, ext, mtime }]; an object
     carrying a .portraits array is accepted too, so C++ can grow the envelope
     later without breaking this. */
  window.fdPortraits = function (list) {
    list = coerce(list);
    const arr = Array.isArray(list) ? list
      : (list && Array.isArray(list.portraits) ? list.portraits : []);
    const map = {};
    arr.forEach(function (p) {
      if (!p || !p.slug) return;
      const mt = typeof p.mtime === 'number' ? p.mtime : parseInt(p.mtime, 10);
      map[String(p.slug).toLowerCase()] = {
        ext: String(p.ext || 'png').toLowerCase().replace(/^\./, ''),
        // Plain number, NOT `>>> 0`: the stamp can exceed 32 bits and a
        // wrapped value would collide across different files.
        mtime: (isFinite(mt) && mt > 0) ? mt : 0,
      };
    });
    state.portraits = map;
    if (isActive()) renderList();
  };
```

---

## 4. `app.css`

Append `view/HotkeyDeck/followers-portraits.css.frag` verbatim. It adds only
`.medal.img` and `.fd-member .medal` rules (row art to 40px for both variants)
and one `@keyframes fdPortraitIn`; it redefines nothing.

---

## Behaviour after the patch

* A follower with `portraits/<slug>.<ext>` shows the picture; everyone else
  keeps the coloured initials medallion. Mixed lists look intentional because
  both variants are the same 40px circle with the same category-hue border.
* The following-ring and the dead-grayscale still read the same on both.
* A portrait dropped in (or uploaded from the Deck Portal) while the game runs
  appears the next time the palette opens — `onShow()` sends `fdRefresh`, C++
  answers with a fresh `fdState` **and** a fresh `fdPortraits`.
* Replacing a portrait under the same filename updates too, because `mtime`
  changes and the `?v=` query busts Ultralight's image cache.
* Nothing here can fail loudly: no portraits folder → empty map → today's
  behaviour exactly; a bad file → `onerror` → initials.

## Interaction notes worth keeping

* **The same follower in two categories shares one portrait.** The slug comes
  from the person, not the row, which is what you want (Uthgerd is in both
  *Mercenaries* and *My Housecarls*).
* **Portraits are keyed on `original`, so `renameMember` never breaks one.**
  The rename op only writes the override.
* **Not verified in-game** (no rig access from this worktree): that Ultralight
  honours the `?v=` query on a view-relative `img src`. If it turns out to
  ignore the query string, the fallback is to have C++ hand the view a
  cache-busting *filename* instead. Everything else in this patch is plain DOM
  the pane already relies on.
