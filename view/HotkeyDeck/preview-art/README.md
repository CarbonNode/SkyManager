Stand-in art for `hd-wheel.preview.html` only — the browser preview of the
Wheel Menu, which must run with no rig files present.

It is here as FILES rather than data: URIs on purpose: the wheel's `safeIcon()`
accepts view-relative paths only (the same rule as C++'s ValidViewIconPath), so
a `data:` URI is correctly rejected and a preview built on one would show
glyphs where the real thing shows pictures — i.e. it would lie about the very
thing it exists to show.

Nothing in the shipped deck references this folder.
