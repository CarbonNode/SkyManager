#pragma once

#include <filesystem>
#include <functional>
#include <string>

// ============================================================================
//  Runtime icon bridge — build the spell-icon library from the USER'S OWN copy
//  of Spell Hotbar 2, at runtime, instead of shipping someone else's art.
// ----------------------------------------------------------------------------
//  Until now the deck shipped 1,913 PNGs that had been sliced out of Spell
//  Hotbar 2's DDS atlases at build time. They render beautifully and they are
//  not ours to redistribute — which is a blocker for a public release and,
//  frankly, was never right for a private one either.
//
//  Spell Hotbar 2 already ships those atlases, and the UV tables that say where
//  every icon sits, to everyone who installs it:
//
//      Data/SKSE/Plugins/SpellHotbar/images/<atlas>.dds   (BC3 / DXT5)
//      Data/SKSE/Plugins/SpellHotbar/images/<atlas>.csv   (tab separated UVs)
//
//  So the deck now does the slicing itself, on first run, into exactly the same
//  files the extractor used to ship:
//
//      PrismaUI/views/HotkeyDeck/icons/sh/<atlas>/<key>.png  + icons/sh_index.json
//      PrismaUI/views/MagicDeck/icons/sh/<atlas>/<key>.png   + icons/sh_index.json
//
//  Nothing about the consumer side changes: `IconIndexJsonAt()` reads the same
//  index, the view's resolve chain matches the same `plugin|localidhex` keys,
//  and a per-spell override already saved in hotkeys.json still points at a
//  real file, because the paths are byte-identical to the ones the build-time
//  extractor produced.
//
//  ------------------------------------------------------------- the four laws
//
//  1. NO SPELL HOTBAR, NO CHANGE. If the images folder isn't there the bridge
//     does nothing at all and the deck keeps its inline SVG glyphs, exactly as
//     it does today with no library installed. It never creates an empty
//     index, so `IconIndexJsonAt` still answers "null" and the fallback path
//     is untouched.
//
//  2. IT RUNS ONCE. A stamp (source file count + newest mtime + total bytes +
//     a format version) is written beside the library; a launch whose stamp
//     matches does no work beyond one directory scan. Install a new spell mod
//     with its own Spell Hotbar sheet and the stamp changes, so the new icons
//     appear on the next launch without anyone asking for them.
//
//  3. IT NEVER BLOCKS THE GAME. Everything happens on one detached, below-
//     normal-priority thread started at kDataLoaded. No engine object is
//     touched from it — it is pure file I/O and pixel work — and the only
//     hand-back to the main thread is the "index is fresh, re-push it"
//     callback, delivered through SKSE's task interface.
//
//  4. IT WRITES TO THE MOD FOLDER, RESOLVED FROM OUR OWN MODULE. Not a
//     `Data\...` relative path. Under MO2 a relative write is redirected into
//     Overwrite, where the DLL can happily read its own file back while the
//     in-game view — which loads `<img src="icons/...">` against the mod
//     folder — sees nothing at all. That exact trap cost a debugging session
//     on Dragon Roost (586 portraits that existed, rendered on the phone, and
//     drew as fallback runes in game). READS still go through the relative
//     path, because reading is what MO2's VFS is for.
// ============================================================================

namespace IconBridge
{
	// Starts the background scan/build. Safe to call once, at kDataLoaded.
	// `onReady` is invoked on the MAIN thread (via SKSE's task interface) only
	// when the library actually changed — the caller uses it to drop its
	// "index already pushed" latch so the next palette open sends the new one.
	void Start(std::function<void()> onReady);

	// One line for the log/status: "1913 icons from 29 atlases" or why not.
	std::string StatusLine();

	// The REAL mod-folder root, resolved from our own module handle (law #4
	// above) — NOT a `Data\...` relative path. Use it as the destination for any
	// file we WRITE into a view tree that must ship (release packaging carries
	// the mod folder, not MO2's Overwrite). Empty on failure. Reads should still
	// go through the relative `Data\...` path so MO2's VFS answers.
	std::filesystem::path ModFolderRoot();
}
