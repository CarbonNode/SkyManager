#!/usr/bin/env python3
"""Re-integrate wardrobe-pane.{html,css}.frag into index.html / app.css.

The fragments are the SOURCE; index.html and app.css are integrated copies that
ship to the game. Editing a fragment and forgetting to re-integrate has now bitten
twice — once for CSS (new rules never reached the game) and once for HTML (the
picker and bulk-bar markup were missing, which would have thrown on render).
So: never hand-paste again, run this.

Idempotent. Replaces the existing wardrobe section if there is one, appends if not.

    python tools/sync_view_frags.py [--check]

--check exits non-zero if the integrated copies are stale, for use before deploy.
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VIEW = os.path.normpath(os.path.join(HERE, "..", "view", "HotkeyDeck"))

CSS_MARK = "/* ===================================================================== *\n *  Wardrobe tab"
HTML_OPEN = '<section id="wd-pane"'
HTML_CLOSE = "</section>"
HTML_LEAD = "<!-- ===================================================================== *\n     Wardrobe tab"


def read(name):
    return io.open(os.path.join(VIEW, name), encoding="utf-8").read()


def write(name, text):
    io.open(os.path.join(VIEW, name), "w", encoding="utf-8", newline="").write(text)


def build_css():
    """Replace ONLY the wardrobe section of app.css.

    It is NOT safe to assume the section runs to EOF: another session appended
    its own block after ours, and truncating from our banner to the end would
    have silently deleted their stylesheet. The fragment contains exactly one
    `/* ===...` banner (its own header), so the section ends at the NEXT banner
    — or at EOF if ours really is last.
    """
    base, frag = read("app.css"), read("wardrobe-pane.css.frag")
    start = base.find(CSS_MARK)
    if start == -1:
        return base.rstrip() + "\n\n" + frag

    nxt = re.search(r"\n/\* ={10,}", base[start + len(CSS_MARK):])
    end = (start + len(CSS_MARK) + nxt.start() + 1) if nxt else len(base)
    tail = base[end:]
    return base[:start] + frag.rstrip("\n") + ("\n\n" + tail.lstrip("\n") if tail.strip() else "\n")


def build_html():
    """Replace the whole <section id="wd-pane"> ... </section> block (and the
    comment above it) with the current fragment.

    Finding the end matters: a naive rfind("</section>") once matched the WRONG
    tag and produced a file with the entire document duplicated. Count nested
    <section> opens instead, so the close we take is genuinely ours.
    """
    base, frag = read("index.html"), read("wardrobe-pane.html.frag")

    start = base.find(HTML_LEAD)
    if start == -1:
        start = base.find(HTML_OPEN)
    if start == -1:
        anchor = base.index('      <footer id="hints">')
        return base[:anchor] + frag + "\n" + base[anchor:]

    open_at = base.index(HTML_OPEN, start)
    depth, i = 0, open_at
    end = -1
    for m in re.finditer(r"<section\b|</section>", base[open_at:]):
        if m.group(0) == "</section>":
            depth -= 1
            if depth == 0:
                end = open_at + m.end()
                break
        else:
            depth += 1
    if end == -1:
        raise SystemExit("could not find the pane's closing </section> — refusing to write")
    return base[:start] + frag.rstrip("\n") + base[end:]


def css_keeps_other_sections(before, after):
    """Every `/* ===` banner that was in the file must still be there. This is
    the check that would have caught the sync eating another session's block."""
    b = set(re.findall(r"/\* ={10,}[^\n]*\n[^\n]*", before))
    a = set(re.findall(r"/\* ={10,}[^\n]*\n[^\n]*", after))
    return sorted(b - a)


def validate(html, css):
    """A generated file that looks plausible but is doubled is worse than a
    stale one, so check the shape before anything is written."""
    # Comments are stripped first: the fragment carries a "paste this inside
    # <div id='panel'>" instruction that would otherwise count as real markup.
    live = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    real_pane = live.count('<section id="wd-pane"')
    real_panel = live.count('<div id="panel">')
    script = len(re.findall(r'<script src="wardrobe-pane\.js">', live))
    problems = []
    if real_pane != 1:
        problems.append("expected exactly 1 wd-pane section, found %d" % real_pane)
    if real_panel != 1:
        problems.append("expected exactly 1 #panel div, found %d" % real_panel)
    if script != 1:
        problems.append("expected exactly 1 wardrobe-pane.js script tag, found %d" % script)
    for label, present in (("picker markup", 'id="wd-picker-input"' in live),
                           ("bulk-bar markup", 'id="wd-selbar"' in live),
                           ("pane css", "#wd-pane " in css),
                           ("picker css", "#wd-picker-card" in css)):
        if not present:
            problems.append("missing " + label)
    return problems


def main():
    check = "--check" in sys.argv

    built_css, built_html = build_css(), build_html()
    problems = validate(built_html, built_css)
    if problems:
        print("REFUSING TO WRITE — the result would be malformed:")
        for p in problems:
            print("   " + p)
        return 2

    stale = []
    for name, built in (("app.css", built_css), ("index.html", built_html)):
        if read(name) == built:
            print("  %-12s up to date" % name)
            continue
        stale.append(name)
        if check:
            print("  %-12s STALE" % name)
        else:
            write(name, built)
            print("  %-12s re-integrated" % name)

    print()
    left = validate(read("index.html"), read("app.css"))
    if left:
        print("post-write check FAILED:")
        for p in left:
            print("   " + p)
        return 2
    print("  integrated copies are well-formed")
    return 1 if (check and stale) else 0


if __name__ == "__main__":
    sys.exit(main())
