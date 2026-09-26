# Third-party notices — Hotkey Deck

Hotkey Deck itself is licensed **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)).
This file lists everything third-party that is **compiled into**, **shipped
alongside**, or **hooked by** the mod, with the licence for each and exactly
what we do with it.

This inventory distinguishes the public source tree from packaged downloads.
The source includes third-party API headers, a PNG encoder and licensed fonts.
Optional runtime mods are normally resolved from the user's installation;
separately offered components and local shader build inputs are described below.
A source sync is not a new binary release or a completed release licence audit.

> **How to read the confidence markers**
> **VERIFIED** — the claim was checked against a file in this repository, and the
> file + line is named.
> **VERIFY** — the component is *not* present in this repository (it is fetched
> at build time, or lives on the build machine), so its licence could **not** be
> confirmed from here. The check to run before publishing is spelled out.
> Resolve these entries against the exact dependencies before the next binary release.

---

## 1 · Compiled into `SkyManager.dll`

### nlohmann/json — **MIT** — VERIFIED

| | |
|---|---|
| Where | `src/json.hpp` (vendored, single header, 919 KB) |
| Version | 3.11.3 |
| Upstream | https://github.com/nlohmann/json |
| Evidence | `src/json.hpp` line 6–7: `SPDX-FileCopyrightText: 2013-2023 Niels Lohmann <https://nlohmann.me>` / `SPDX-License-Identifier: MIT` |
| What we do | `#include`d by nearly every C++ module; compiled into the DLL. The header source itself is **not** shipped in the release archive — only the compiled result. |

MIT requires the copyright notice and permission notice to accompany the
distribution, which is what this section is. The header carries only the SPDX
identifier; the canonical text that identifier denotes, as published with
nlohmann/json v3.11.3, is:

```
MIT License

Copyright (c) 2013-2023 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

### PrismaUI API header — **explicit copy-permission, no SPDX licence** — VERIFIED (grant) / **VERIFY** (runtime)

| | |
|---|---|
| Where | `src/PrismaUI_API.h` (vendored, 6 KB) |
| Upstream | the **PrismaUI** SKSE mod (Ultralight-backed web-view framework for Skyrim SE/AE) |
| Evidence | `src/PrismaUI_API.h` lines 1–3, verbatim: `/*` / ` * For modders: Copy this file into your own project if you wish to use this API.` / ` */` — the file carries **no** copyright line, no SPDX identifier and no other licence text (`grep -niE 'licen\|copyright\|permission\|MIT\|GPL' src/PrismaUI_API.h` returns nothing else). |
| What we do | Compiled into the DLL to talk to PrismaUI over its documented interface. Nothing more. |

The header's own sentence is the grant we rely on, and it covers exactly what we
do with it. Two things are deliberately **not** claimed here:

- **The PrismaUI runtime itself is NOT redistributed.** `PrismaUI.dll`,
  Ultralight, and every file of that mod stay the user's own download. PrismaUI
  is a **hard requirement** on the Nexus page.
- **VERIFY before publishing:** PrismaUI's own distribution terms (its Nexus
  permissions block / any `LICENSE` in its archive). We are not distributing it,
  so its terms do not bind our archive — but confirm the API header's
  copy-permission is still the author's stated position, and credit the author
  by name on the Nexus page. → *Owner action: read the PrismaUI Nexus
  permissions tab and record the author's handle here.*

---

### CommonLibSSE-NG — **VERIFY** (not present in this repository)

| | |
|---|---|
| Where | **Not in this repo.** `xmake.lua` line 4: `includes("lib/commonlibsse-ng")`, resolved inside the Windows build workspace, and `add_deps("commonlibsse-ng")` on the target. |
| Upstream | https://github.com/CharmedBaryon/CommonLibSSE-NG (an NG fork of Ryan-rsm-McKenzie's CommonLibSSE) |
| What we do | **Statically linked** into `SkyManager.dll`. This is the largest third-party component in the shipped binary. |

Widely distributed as **MIT**, but that could **not** be verified from this
repository because the library is not checked in here.

**Check to run before publishing** (on the build machine):

```
type   lib\commonlibsse-ng\LICENSE
type   lib\commonlibsse-ng\xmake.lua        :: set_license(...)
dir /s lib\commonlibsse-ng\*LICENSE*        :: its own vendored deps
```

Then replace this block with the verified licence text and delete the VERIFY.

**Transitively linked, also VERIFY:** CommonLibSSE-NG pulls its own
dependencies through xmake (typically **spdlog**, **fmt**, **xbyak**,
**binary_io**, **rsm-mmio**, **Boost.STLInterfaces** and similar). Each is
statically linked into our DLL and therefore *distributed by us*, so each needs
its notice reproduced. Enumerate them from the resolved lockfile on the build
machine:

```
type build\.packages\*\*\*\install.txt      :: or
xmake require --info                        :: lists every resolved package + version
dir /s /b build\.packages\**\LICENSE*
```

> ⚠ **GPL-3.0 compatibility.** MIT/BSD/Apache-2.0 dependencies are all
> one-way-compatible into a GPL-3.0 work, so linking them is fine. If the
> enumeration above turns up anything under a *non*-permissive or
> GPL-incompatible licence, that must be resolved before publishing — say so
> here rather than shipping quietly.

---

### stb_image_write — **MIT** — VERIFIED

`src/vendor/stb_image_write.h` is Sean Barrett's PNG writer. Its header offers
MIT or public-domain terms; this distribution uses the MIT grant reproduced
below. No `bcdec.h` is vendored in this source snapshot.

```
Copyright (c) 2017 Sean Barrett
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Walk With Me interface — **GPL-3.0-or-later** — VERIFIED

`src/third_party/walk-with-me/WayfarerAPI.h` is the unmodified public interface
from [fatalCMD/walk-with-me](https://github.com/fatalCMD/walk-with-me), revision
`45227954342a56bee99ff7c9ddf1648bd148b445` (0.2.2). Its accompanying `LICENSE`
and `README.md` are included in that directory. SkyManager resolves the loaded
mod's `Wayfarer_GetInterface(1)`; no Walk With Me binary is bundled.

---

## 2 · Generated assets and scripts

> The Spell Hotbar icons are **not in this archive at all** — they ship as a
> **separate optional-file mod** (`SkyManager-SpellHotbarIcons-v*.zip`), bundled
> with the author's express permission. See §4.


| Asset | Provenance | Licence |
|---|---|---|
| `PrismaUI/views/HotkeyDeck/icons/custom/*.png` (gold glyphs such as `cat-*`, `hk-*`, `hm-*`, `sc-*`, `hd-*`) | Generated for this mod by the author (image model + `tools/icon_knockout.js` knockout pass; style recipe in `modding/guides/deck_icon_style.md`). Verified original — none is extracted from another mod. | GPL-3.0-or-later, with the mod |
| `PrismaUI/views/HotkeyDeck/icons/skymanager.png` | Author-generated brand glyph. VERIFIED from repo history: commit `16aa420` — *"A generated gold dragon-head glyph brand icon top-left … (Forge imagen)"*. | GPL-3.0-or-later, with the mod |
| `PrismaUI/views/*/*.js`, `*.css`, `index.html`, `hud.*` | Written for this mod. No bundled JS/CSS library — `grep -icE 'jquery\|lodash\|d3\.js'` over `app.js` returns 0. The **only** `@font-face` block is `journal-pane.css`'s, which points at the OFL faces in §2a (added 2026-08-16 with the Journal); every other surface uses system/emoji fonts. | GPL-3.0-or-later, with the mod |
| `HotkeyDeckWardrobe.esp` | Generated byte-for-byte by `tools/make_deck_esp.py`. It **masters** `Skyrim.esm`; it contains our quests, aliases, packages and faction, plus the ten locally supplied ShiningTreasure shaders described below. | Our generated records: GPL-3.0-or-later. Donor shaders retain their own terms. |
| `HD_WardrobeExec.psc` / `HD_NPCControl.psc` / `HD_MhiyhRemote.psc` (+ their `.pex`) | Written for this mod (`modding/OutfitCycler/Scripts/Source/`). | GPL-3.0-or-later, with the mod |

`preview-art/*.svg` exists only for the browser harness and is **excluded** from
the release archive by the packager.

---

## 2a · Typefaces the Journal writes in — **SIL Open Font Licence 1.1** — VERIFIED

Added 2026-08-16 with the Journal tab. These eight font families are published
under the SIL OFL 1.1, which allows
redistribution — bundled with software or not — provided the licence travels
with them and the Reserved Font Names are not used for a modified version. We
ship them **unmodified**; only the file names were changed (permitted: the OFL
restricts the FONT NAME, which lives inside the file and is untouched).

| Family | File(s) in the archive | Upstream | Licence file shipped beside them |
|---|---|---|---|
| IM Fell English | `fonts/IMFellEnglish-{Regular,Italic}.ttf` | `google/fonts` `ofl/imfellenglish` | `fonts/OFL-imfellenglish.txt` |
| Cardo | `fonts/Cardo-{Regular,Italic,Bold}.ttf` | `google/fonts` `ofl/cardo` | `fonts/OFL-cardo.txt` |
| Sorts Mill Goudy | `fonts/SortsMillGoudy-{Regular,Italic}.ttf` | `google/fonts` `ofl/sortsmillgoudy` | `fonts/OFL-sortsmillgoudy.txt` |
| Tangerine | `fonts/Tangerine-{Regular,Bold}.ttf` | `google/fonts` `ofl/tangerine` | `fonts/OFL-tangerine.txt` |
| Kalam | `fonts/Kalam-{Regular,Bold}.ttf` | `google/fonts` `ofl/kalam` | `fonts/OFL-kalam.txt` |
| MedievalSharp | `fonts/MedievalSharp-Regular.ttf` | `google/fonts` `ofl/medievalsharp` | `fonts/OFL-medievalsharp.txt` |
| Pirata One | `fonts/PirataOne-Regular.ttf` | `google/fonts` `ofl/pirataone` | `fonts/OFL-pirataone.txt` |
| UnifrakturMaguntia | `fonts/UnifrakturMaguntia-Regular.ttf` | `google/fonts` `ofl/unifrakturmaguntia` | `fonts/OFL-unifrakturmaguntia.txt` |

Everything lives in `PrismaUI/views/HotkeyDeck/fonts/`, and the packager ships
that folder wholesale (`VIEW_ASSET_DIRS` in `tools/make-release.py`) so a licence
file can never be separated from the font it covers.

**Not a hard dependency.** `journal-pane.css` declares every family as a stack
ending in a system face of the same character, because `@font-face` support in
Ultralight was unproven when the Journal shipped. If a face does not load the
Journal still renders — in Palatino/Georgia/Segoe Script instead — and the style
picker shows each name drawn in its own face so the player can see which ones
took.

---

## 3 · Required, never redistributed

The Nexus page lists these as requirements. The user downloads each from its own
author; not one byte of them is in our archive.

| Requirement | Why | Notes |
|---|---|---|
| **Skyrim Script Extender (SKSE64)** | the plugin is an SKSE plugin | — |
| **Address Library for SKSE Plugins** | version-independent offsets via CommonLibSSE-NG | — |
| **PrismaUI** | both views are PrismaUI web views; without it the mod has no UI at all | hard dependency, see §1 |
| **The Elder Scrolls V: Skyrim Special Edition** (Bethesda) | host game | We reference vanilla FormIDs (`XMarker 0x3B`, `Gold001`, barrier `MSTT` records, `RELA` records) **by ID**. No Bethesda asset is copied, extracted or shipped. |

---

## 4 · Optional integrations — hooked, never shipped

Every row is a soft binding. If the mod is absent, the feature hides itself or
says so on screen. Sources for each are named so any claim here can be checked.

| Mod | How we touch it | Files of theirs we ship |
|---|---|---|
| **PrismaUI** | the whole UI layer (§1) | none |
| **Follower Organizer** | Followers tab reads/writes through a C API on `FollowerOrganizer.dll` (`follower_deck.cpp`) | **none — and note the fork caveat below** |
| **Nether's Follower Framework (NFF)** | property reads via the Papyrus VM + `DispatchStaticCall` into NFF's own controller (`nff_bridge.cpp`, `nff_control.cpp`, `nff_outfits.cpp`) | none |
| **My Home is Your Home (MHiYH NG)** | linked-ref/keyword reads + `DispatchStaticCall` into `MHiYHController` (`mhiyh_control.cpp`) | none |
| **Skyrim Outfit Equipment System NG (SOES-NG)** | never called natively — SKSE **mod event** → our own `HD_WardrobeExec.psc` calls SOES's Papyrus API (`wardrobe.cpp`) | none |
| **Object Manipulation Overhaul (OMO)** | `StartDraggingObject` via `GetProcAddress`; OMO owns the carry UX (`npc_actions.cpp`) | none |
| **Mesh Rendering Framework (MRF)** | `IMesh_CreateByNifPath` / `…PathSet` / `…Delete` to render *the user's own* item meshes and NPC faces to icons, on their machine (`item_icons.cpp`) | **`src/mrf_api.h`** — a trimmed copy of MRF's own public API header (see below). No MRF runtime binary is bundled. |
| **MARAS** | read-only faction-rank mirror (`maras.cpp`) | none |
| **Fertility Mode v3** | read-only script-property reads (`fertility_bridge.cpp`) | none |
| **AddItemMenu SE** | self-casts its own lesser powers so its shipped flow runs (`aim_actions.cpp`) | none |
| **CommandNPC** | fires its own `CS_FurnQuest` Papyrus script for sit/bed (`npc_actions.cpp`) | none |
| **OStim / OStim NG** | its own thread C-ABI (`ostim_deck.cpp`, `ostim_thread_api.h`) | none |
| **SPID (Spell Perk Item Distributor)** | writes *new* `.ini` files the user asked for (`spid_gear.cpp`) | none |
| **Follower Wander Framework**, **Better FaceLight**, **Quick Light**, **Tailor**, **LOTD / TCC** (loot glow gate) | records/keys read at runtime, or the mod's own menu key synthesized | none |
| **Spell Hotbar 2** | **see below — icon art, redistributed WITH PERMISSION** | **none in THIS archive — separate optional-file mod** |

### Mesh Rendering Framework — `src/mrf_api.h`, their header, GPL to GPL

`src/mrf_api.h` is Mesh Rendering Framework's own public API header
(`include/MeshRenderingFrameworkAPI.h`, github.com/QTR-Modding/Mesh-Rendering-Framework,
**GPL-3.0**), mechanically trimmed by `modding/tools/gen_mrf_header.py`: the
`ENABLE_MENU_FRAMEWORK` / SKSEMenuFramework (ImGui) sections are dropped so it
compiles in a plugin with no ImGui, and `--core-only` additionally drops MRF's
NPC-composition helper layer, which we do not call. Every line that remains is
upstream's, unmodified apart from naming `GetModuleHandleW` explicitly. The file
carries a generated-by banner saying so.

It is here because it is the CORRECT way to call the framework: it is what
defines `IMesh` and every `IMesh_*` export signature. Before 2026-08-20 this
plugin hand-mirrored that struct and hand-typed those signatures, and the mirror
had silently fallen two fields behind upstream.

SkyManager is GPL-3.0 and MRF is GPL-3.0, so including their header is exactly
what the licence contemplates. **No MRF binary is redistributed** — the DLL is
resolved at runtime with `GetProcAddress` and the whole feature hides itself when
the framework is absent. The trimmed API header is part of the compiled
SkyManager code.

### Body Change NG — the skin-override technique, GPL to GPL

`src/skin_actions.cpp` calls RaceMenu's public Override interface to write skin
and node texture overrides. Three things in it are **adopted from Body Change
NG** (github.com/compilecraftworks/Body-Change-NG, **GPL-3.0**), which solved
the same problem first and solved it properly:

* the **`IOverrideInterfaceV2` declaration** — the complete virtual surface of
  RaceMenu's Override interface, in upstream order. It has to be complete:
  omitting any earlier entry silently shifts `AddSkinOverride` /
  `AddNodeOverride` onto the wrong vtable slot. (The interface itself originates
  in skee's own `SKEE.h`.)
* the **route table** — interface version 0 and 1 have no native vtable and must
  go through NiOverride's Papyrus natives; version 2 is native; anything else
  fails closed rather than guessing at an unaudited vtable
  (their `RaceMenuOverrideRouting.h`).
* the **ownership rule** — RaceMenu stores no owner beside an override key, so
  the only durable proof that a value is ours is that the value lives in our own
  texture namespace; a channel somebody else owns is left alone and logged
  (their `SkinOverrideOwnership.h`).

Their pack-folder convention (`BodySkin\<pack>\Textures\…`) is also read, so a
skin pack a user already installed for Body Change NG works here unchanged.

SkyManager is GPL-3.0 and Body Change NG is GPL-3.0, so this is exactly what the
licence contemplates. **No Body Change NG file is redistributed** — nothing of
theirs is in the archive, the mod is not required, and it is not called at
runtime.

### ShiningTreasure — local shader input, not in the public repository

`tools/make_deck_esp.py` needs ten bright `ST_*` EFSH record bodies originally
from [ShiningTreasure](https://www.nexusmods.com/skyrimspecialedition/mods/21228)
by Hellbeast (uploaded by smilebuddha). Supply an existing local plugin with
`--shader-source` or local JSON with `--shader-data`. Neither the extracted
`st_efsh.json` nor donor plugin bytes are published in this source repository.

The upstream Nexus permissions checked on 2026-09-26 require author permission
for asset reuse and modification. No permission receipt was established in this
audit. The generated ESP includes the supplied shader bodies: the repo's GPL
grant does not relicense them, and the extraction option grants no additional
rights. Resolve permission or replace these records with independently authored
shaders before distributing a new ESP containing them.

### Spell Hotbar 2 — the icon library, redistributed WITH PERMISSION

Spell Hotbar 2's atlases are the source of the ~1,913 spell / potion / power
icons. **The author, pWn3d1337, granted express permission to bundle the icons**
(Nexus mod [188059](https://www.nexusmods.com/skyrimspecialedition/mods/188059),
mod-page comment thread, 2026-08-12 — asked "bundling some of your icons in my
own mod? Just the icons, nothing else", answered *"Yeah, that's ok."*). The
grant is **icon ART ONLY** — no Spell Hotbar code, ESP, atlas or config.

How it ships, and the obligations that follow — not optional:

- The pre-made icons are a **separate, standalone optional-file mod**
  (`SkyManager-SpellHotbarIcons-v*.zip`), uploaded on its own and installed after
  SkyManager. They are **never** part of the main SkyManager archive. The main
  mod always ships `icons/sh/` **empty** (plus a `.gitkeep` explaining itself);
  the icon bridge fills it at runtime from the user's own installed spell mods.
  So a user who never installs the pack, or has no spell mods, gets the built-in
  SVG/emoji fallback — a supported, tested state.
- The empty folder must exist **at install time** because Mod Organizer 2
  snapshots its virtual file system when the game launches: a directory created
  mid-session is invisible to the running game.
- **Credit and thank pWn3d1337** wherever the pack is offered: the Nexus page's
  credits AND permissions sections, this file, and the FOMOD option's own text.
- **Keep the receipt.** The screenshot of the permission grant is saved with the
  release; a permission claim on a public page must be documentable.
- Icon art only — do **not** extend this to any other Spell Hotbar asset.

### Follower Organizer — redistribution PERMITTED, credit required

The Followers tab talks to a **fork** of Follower Organizer
(`FollowerOrganizer.dll` ≥ 0.2.0, adding two exported C functions) — a
derivative of somebody else's mod.

**The author, MaskedRPGFan, granted permission to redistribute it, on condition
that they are credited** (reported by the mod author 2026-08-11). The fork and
the Spell Hotbar icon pack above
are separately offered components, each requiring its own credit and recorded
permission. Other incorporated source and font licences are listed above.

Obligations that follow, and they are not optional:

- **Credit MaskedRPGFan** wherever the fork is offered: the Nexus page's credits
  AND permissions sections, this file, and the fork's own README.
- **Say it is a modified build**, so nobody mistakes it for the upstream mod, and
  link the upstream page so users can find the original.
- **Keep the receipt.** Save the message granting permission (screenshot or
  saved PM) alongside the release; a permission claim on a public page should be
  documentable if it is ever questioned.
- The fork ships as a **separate optional file**, never merged into the main
  archive, so a user can decline it and the Followers tab degrades honestly.
- If upstream ever adopts the two exported functions, drop the fork and depend
  on the real mod instead — that is strictly better for everyone.

⚠ **This is the one statement on the mod page that must not overreach.** The
description must identify the components actually included in that download
and preserve their applicable notices and credits.

---

## 5 · Build-time tools — not distributed

| Tool | Licence | Note |
|---|---|---|
| **xmake** | Apache-2.0 | build driver; no xmake code in the binary |
| **MSVC / Windows SDK** | Microsoft EULA | the CRT is linked per the redistribution terms Microsoft grants for compiled output |
| **Champollion** (Papyrus decompiler) | its own | used only to *read* other mods' scripts while researching integration signatures — no decompiled output ships |
| `tools/*.py`, `tools/*.ps1` (ours) | GPL-3.0-or-later | repo-side tooling; not in the archive |

---

## 6 · Pre-publish checklist

- [ ] Every **VERIFY** above resolved, and the marker deleted.
- [ ] CommonLibSSE-NG licence text pasted in, plus each transitive dependency.
- [ ] PNG encoder and API-header notices included with the binary distribution.
- [ ] ShiningTreasure shader permission documented, or donor shaders replaced before distributing a generated ESP.
- [ ] PrismaUI author credited by name on the Nexus page.
- [ ] **pWn3d1337 (Spell Hotbar 2) credited** on the Nexus page (credits AND
      permissions), for the optional icon pack.
- [ ] `python3 tools/make-release.py --scan-only` exits **0**.
- [ ] Main archive reviewed — **no** path under `…/icons/sh/` other than
      `.gitkeep`. The Spell Hotbar icons ship ONLY in the separate
      `SkyManager-SpellHotbarIcons-v*.zip`, uploaded as its own optional file.
