# Third-party notices — Hotkey Deck

Hotkey Deck itself is licensed **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)).
This file lists everything third-party that is **compiled into**, **shipped
alongside**, or **hooked by** the mod, with the licence for each and exactly
what we do with it.

**The release rule, in one line: we redistribute nobody else's files.** Every
integration below is a *soft binding* to a mod the user has already installed —
resolved at runtime, absent = an honest on-screen message, never a crash. No
third-party mod's DLL, ESP, script, mesh, texture or icon is inside the Hotkey
Deck archive.

> **How to read the confidence markers**
> **VERIFIED** — the claim was checked against a file in this repository, and the
> file + line is named.
> **VERIFY** — the component is *not* present in this repository (it is fetched
> at build time, or lives on the build machine), so its licence could **not** be
> confirmed from here. The check to run before publishing is spelled out. Do not
> publish with a **VERIFY** left open.

---

## 1 · Compiled into `HotkeyDeck.dll`

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
| What we do | **Statically linked** into `HotkeyDeck.dll`. This is the largest third-party component in the shipped binary. |

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

### Single-header decoder / encoder slots — **UNFILLED**

The runtime spell-icon bridge (built in a parallel workstream) is expected to
vendor one or two public-domain single-header libraries so it can read the
user's own DDS atlases and write PNGs. Those files are **not in this repository
at the time of writing** (`find . -iname 'stb_image*' -o -iname 'bcdec*'`
returns nothing).

Fill these in the moment the header lands — an unfilled slot is a publishing
blocker, not a nice-to-have:

| Component | Expected where | Expected licence | Status |
|---|---|---|---|
| `stb_image_write.h` (Sean Barrett) | `src/stb_image_write.h` | Public domain (Unlicense) **or** MIT — the header offers a dual grant; quote the one chosen | **VERIFY — not yet vendored** |
| `bcdec.h` (Sergii Kudlai) | `src/bcdec.h` | MIT (check the header's own block) | **VERIFY — not yet vendored** |
| *(any other single-header helper)* | — | — | **VERIFY** |

For each: paste the header's own copyright + permission block verbatim into
this section, and confirm it is a permissive licence compatible with GPL-3.0.

---

## 2 · Assets in the archive — all first-party

| Asset | Provenance | Licence |
|---|---|---|
| `PrismaUI/views/HotkeyDeck/icons/custom/*.png` (~85 gold glyphs: `cat-*`, `hk-*`, `hm-*`, `sc-*`, `hd-*`) | Generated for this mod by the author (image model + `tools/icon_knockout.js` knockout pass; style recipe in `modding/guides/deck_icon_style.md`). Verified original — none is extracted from another mod. | GPL-3.0-or-later, with the mod |
| `PrismaUI/views/HotkeyDeck/icons/skymanager.png` | Author-generated brand glyph. VERIFIED from repo history: commit `16aa420` — *"A generated gold dragon-head glyph brand icon top-left … (Forge imagen)"*. | GPL-3.0-or-later, with the mod |
| `PrismaUI/views/*/*.js`, `*.css`, `index.html`, `hud.*` | Written for this mod. No bundled JS/CSS library — `grep -icE 'jquery\|lodash\|d3\.js'` over `app.js` returns 0, and there is no `@font-face` anywhere in `view/`. All UI type is system/emoji fonts. | GPL-3.0-or-later, with the mod |
| `HotkeyDeckWardrobe.esp` | Generated byte-for-byte by `tools/make_deck_esp.py`. It **masters** `Skyrim.esm` and models vanilla record layouts, but contains **no Bethesda assets** — only our own quest, aliases and script bindings. | GPL-3.0-or-later, with the mod |
| `HD_WardrobeExec.psc` / `HD_NPCControl.psc` (+ their `.pex`) | Written for this mod (`modding/OutfitCycler/Scripts/Source/`). | GPL-3.0-or-later, with the mod |

`preview-art/*.svg` exists only for the browser harness and is **excluded** from
the release archive by the packager.

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
| **Mesh Rendering Framework (MRF)** | `IMesh_CreateByNifPath` to render *the user's own* item meshes to icons, on their machine (`item_icons.cpp`) | none |
| **MARAS** | read-only faction-rank mirror (`maras.cpp`) | none |
| **Fertility Mode v3** | read-only script-property reads (`fertility_bridge.cpp`) | none |
| **AddItemMenu SE** | self-casts its own lesser powers so its shipped flow runs (`aim_actions.cpp`) | none |
| **CommandNPC** | fires its own `CS_FurnQuest` Papyrus script for sit/bed (`npc_actions.cpp`) | none |
| **OStim / OStim NG** | its own thread C-ABI (`ostim_deck.cpp`, `ostim_thread_api.h`) | none |
| **SPID (Spell Perk Item Distributor)** | writes *new* `.ini` files the user asked for (`spid_gear.cpp`) | none |
| **Follower Wander Framework**, **Better FaceLight**, **Quick Light**, **Tailor**, **LOTD / TCC** (loot glow gate) | records/keys read at runtime, or the mod's own menu key synthesized | none |
| **Spell Hotbar 2** | **see below — the one that needs care** | none |

### Spell Hotbar 2 — the icon library, explicitly

Spell Hotbar 2's DDS atlases are the source of ~1,900 spell icons. **We ship
none of them.** The release archive contains an **empty** `icons/sh/` folder
(plus a `.gitkeep` explaining itself); the library is generated **on the user's
own machine, from the user's own installed copy** of Spell Hotbar 2, and never
leaves it. If Spell Hotbar 2 is not installed, the folder stays empty and the
deck falls back to its built-in SVG/emoji glyphs — a supported, tested state.

The empty folder must exist **at install time** because Mod Organizer 2
snapshots its virtual file system when the game launches: a directory created
mid-session is invisible to the running game.

### Follower Organizer — redistribution PERMITTED, credit required

The Followers tab talks to a **fork** of Follower Organizer
(`FollowerOrganizer.dll` ≥ 0.2.0, adding two exported C functions) — a
derivative of somebody else's mod.

**The author, MaskedRPGFan, granted permission to redistribute it, on condition
that they are credited** (reported by the mod author 2026-08-11). This is the
only third-party code in the whole project that we redistribute at all.

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
description must not claim the download redistributes nothing; it must say that
one component is redistributed, with permission, with credit.

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
- [ ] Decoder/encoder header slots (§1) filled or confirmed unused.
- [ ] PrismaUI author credited by name on the Nexus page.
- [ ] `python3 tools/make-release.py --scan-only` exits **0**.
- [ ] Manifest reviewed — no path under `icons/sh/` other than `.gitkeep`.
