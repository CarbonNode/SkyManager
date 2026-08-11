Category-icon fixtures (and starter glyphs)
===========================================

Five tiny 64x64 white-glyph PNGs: shield, skull, crown, heart, sword. They are
here for TWO reasons:

1. followers-pane.test.html renders them. The rail's category icons and the
   icon picker are only worth verifying against real decoded pixels — a
   fixture pointing at a path that 404s exercises the ERROR path, not the
   feature, and a screenshot of it proves nothing.

2. They are usable starter icons that match Rober's mock (shield = Housecarls,
   skull = Thralls, crown = Nobles).

WHAT SHIPS TO THE GAME, AND WHAT DOES NOT
-----------------------------------------
hd-build-deploy.ps1 deploys only the FILES at the top of view/HotkeyDeck --
`Get-ChildItem -File` does not recurse -- so this folder is NOT copied to the
mod by a normal deploy. In the game the picker reads the deck's OWN icon tree
inside the mod folder:

    …\Hotkey Deck (PrismaUI)\PrismaUI\views\HotkeyDeck\icons\
        custom\   <- your own PNGs (C++ mirrors MagicDeck's custom icons here)
        sh\       <- the ~1,900 Spell Hotbar glyphs + sh_index.json

To make these five available in-game, copy them into that `icons\custom\`
folder (or drop any PNGs of your own there) and hit the picker's Refresh.

The stored value is always view-relative with forward slashes and starts with
"icons/" -- "icons/custom/hd-shield.png". Both main.cpp (ValidViewIconPath) and
followers-pane.js (iconSrc) refuse anything that could escape the view root.
