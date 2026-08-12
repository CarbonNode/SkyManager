# SkyManager

An in-game control panel for Skyrim Special Edition, built as an SKSE plugin
with a [PrismaUI](https://www.nexusmods.com/skyrimspecialedition/mods/148718)
web interface.

It started as a paused, searchable palette of *named* hotkeys — press a key,
see every hotkey you own with a name and an icon, click one, and the mod fires
a real OS-level keypress so any other mod reacts exactly as if you had pressed
it yourself. Then it grew: followers, wardrobe, permanent gear grants, travel
marks, claimed rooms, remote containers, loot highlighting, quests, spells,
poses, finances.

**Mod page:** *(add the Nexus link here)*

## Licence

GPL-3.0. In plain words: do what you like with it, redistribute it, build on
it — but if you use this code, your thing has to be open source too.

## Building from source

The release archive contains five kinds of artefact. Every one of them is
built from this repository plus named public dependencies — nothing is
obfuscated, and each step is reproducible on a clean Windows machine.

| Release artefact | Source | Build step |
|---|---|---|
| `SKSE/Plugins/SkyManager.dll` | `src/` + `xmake.lua` | § 1 below |
| `PrismaUI/views/**` (the interface) | `view/` | none — plain HTML/CSS/JS, copied verbatim |
| `HotkeyDeckWardrobe.esp` | `tools/make_deck_esp.py` | § 2 below |
| `Scripts/*.pex` | `papyrus/*.psc` | § 3 below |
| `FollowerOrganizer.dll` (optional FOMOD component) | `follower-organizer/` | § 4 below |

### 1. The SKSE plugin (`SkyManager.dll`)

Prerequisites:

- **Visual Studio 2022 Build Tools** with the *Desktop development with C++*
  workload (MSVC v143 + a Windows 10/11 SDK)
- **[xmake](https://xmake.io)** ≥ 2.8.2
- **git**

Steps:

```
git clone https://github.com/CarbonNode/SkyManager
cd SkyManager

:: CommonLibSSE-NG is expected at lib/commonlibsse-ng. Either clone it
:: directly:
git clone https://github.com/CharmedBaryon/CommonLibSSE-NG lib/commonlibsse-ng

:: ...or take the lib/ folder from the PrismaUI example plugin, which vendors
:: the revision this project is developed against:
::   https://github.com/PrismaUI-SKSE/example-skse-plugin

xmake f -m release -y
xmake -y
```

Output: `build/windows/x64/release/SkyManager.dll`. xmake resolves
CommonLibSSE-NG's own dependencies (spdlog etc.) from xmake-repo on first
configure.

### 2. The plugin file (`HotkeyDeckWardrobe.esp`)

The esp is **generated, byte for byte, by a Python script** — no Creation Kit
involved, nothing hand-edited:

```
python tools/make_deck_esp.py HotkeyDeckWardrobe.esp
```

Pure standard library. It writes the two quests + alias/package records and
then re-parses its own output, printing a record-level dump so the result can
be inspected (or diffed against the shipped esp) directly.

### 3. The Papyrus scripts (`*.pex`)

Sources in [`papyrus/`](papyrus/), compiled with Bethesda's own
`PapyrusCompiler.exe` from the Creation Kit — see
[`papyrus/README.md`](papyrus/README.md) for the exact command lines and
import paths, including the compile-time-only signature stubs used for the
one integrated mod whose sources aren't redistributable (NFF).

### 4. The Follower Organizer fork (optional component)

The optional Followers component bundles a fork of MaskedRPGFan's Follower
Organizer (redistribution permitted with credit — see
`THIRD-PARTY-NOTICES.md`). [`follower-organizer/`](follower-organizer/)
contains every file this project authors (the Deck API and the patched
`Member` persistence), applied over the upstream source and built with the
same xmake + CommonLibSSE-NG toolchain as § 1. Its README documents the patch
history.

### Notes for security reviewers

Things in the DLL a scan will (correctly) notice, and why they are there:

- **`SendInput` / `GetAsyncKeyState`** — the mod's core mechanic: palette
  entries fire *real* OS-level keypresses so other mods react as if the user
  pressed the key, and extended F13–F24 keys are re-emitted from a poll loop.
  Input is *synthesized*, never logged or transmitted; there is no keylogging.
- **An embedded loopback HTTP client (WinHTTP)** — `ask.cpp`, `sharmat.cpp`,
  `live_api.h` and `portal_host.cpp` talk to two *optional, user-installed,
  local* services: a CHIM/Herika AI server (the Ask feature) and the mod's own
  phone portal (`portal/`). Requests go to addresses the user configures
  (loopback/LAN); the DLL contains no telemetry, no update check, and no
  hardcoded external host.
- **`GetProcAddress` on `FollowerOrganizer.dll`** — the in-process Deck API
  (§ 4); on other mods' plugin DLLs (Object Manipulation Overhaul et al.) for
  the same reason. Fails soft when the mod isn't installed.
- **A D3D11 back-buffer read** (`portrait_capture.cpp`) — the follower
  portrait feature grabs one frame when the user fires "Capture Portrait" and
  writes it as a local PNG into the mod's own view folder. Nothing leaves the
  machine.
- **No code patches**: the DLL installs no branch hooks and modifies no engine
  code — integration is SKSE event sinks, the Papyrus VM, and public plugin
  APIs throughout.

The interface is plain HTML/CSS/JS rendered by
[PrismaUI](https://www.nexusmods.com/skyrimspecialedition/mods/148718)
(Ultralight) — no remote content, everything ships in `view/`.

## Layout

| Path | What |
|---|---|
| `src/` | The SKSE plugin. One `.cpp` per feature area; `main.cpp` owns the config, the bridge registration and the input sink. |
| `view/HotkeyDeck/` | The main interface — HTML/CSS/JS loaded by PrismaUI. |
| `view/MagicDeck/` | The spell palette, a second PrismaUI view. |
| `papyrus/` | Papyrus sources for the shipped `.pex` files, with compile instructions. |
| `follower-organizer/` | Our patches to the bundled Follower Organizer fork (Deck API + persistence). |
| `chim/` | Optional server-side endpoint for the Ask feature, if you use CHIM. |
| `portal/` | Optional Node server that puts the same data on a phone. |
| `fomod/` | Installer definition. |
| `tools/` | Plugin generation, icon processing, view fragment merging. |

## How the two halves talk

C++ registers named JS listeners; the view calls them and receives replies
through named globals. **One name per direction** — the same name used both
ways silently unplugs one side. Bridge names are grouped by feature (`fd*`
followers, `wd*` wardrobe, `rg*` rooms, `sg*` SPID gear, and so on).

Most view panes ship a standalone test harness (`*.test.html`) that runs in a
browser with stubbed bridges — those are excluded from release archives but
are the fastest way to work on a pane without launching Skyrim.

## Credits

Built on [PrismaUI](https://www.nexusmods.com/skyrimspecialedition/mods/148718),
CommonLibSSE-NG and SKSE. Integrates with a lot of other people's work — see
`THIRD-PARTY-NOTICES.md`, which records what is used, how, and what (if
anything) is redistributed.
