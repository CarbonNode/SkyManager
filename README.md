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

## Building

Requires [xmake](https://xmake.io), MSVC (VS2022 Build Tools) and
CommonLibSSE-NG. The project expects CommonLibSSE-NG at `lib/commonlibsse-ng`
— the usual way to get it is to clone a PrismaUI plugin example, which vendors
it, and drop `src/` and `xmake.lua` over the top.

```
xmake -y
```

Output: `build/windows/x64/release/SkyManager.dll`.

## Layout

| Path | What |
|---|---|
| `src/` | The SKSE plugin. One `.cpp` per feature area; `main.cpp` owns the config, the bridge registration and the input sink. |
| `view/HotkeyDeck/` | The main interface — HTML/CSS/JS loaded by PrismaUI. |
| `view/MagicDeck/` | The spell palette, a second PrismaUI view. |
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
