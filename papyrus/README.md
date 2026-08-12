# Papyrus sources

Source for the two compiled scripts (`.pex`) the release archive ships. Both are
plain Papyrus, compiled with Bethesda's own compiler from the Creation Kit.

| Shipped file | Source here | Hosted by |
|---|---|---|
| `Scripts/HD_WardrobeExec.pex` | `HD_WardrobeExec.psc` | quest 0x802 in `HotkeyDeckWardrobe.esp` — receives SKSE mod events from the DLL and calls the Papyrus APIs of SOES-NG / NFF on its behalf |
| `Scripts/HD_NPCControl.pex` | `HD_NPCControl.psc` | quest 0x803 in the same esp — a dumb ForceRefTo/Clear driver for the freeze/sit/sleep reference aliases |

## Compiling

```
PapyrusCompiler.exe papyrus\HD_NPCControl.psc  -f=TESV_Papyrus_Flags.flg -i=<imports> -o=<out>
PapyrusCompiler.exe papyrus\HD_WardrobeExec.psc -f=TESV_Papyrus_Flags.flg -i=<imports>;papyrus\stubs -o=<out>
```

`<imports>` is the usual assembled import path:

1. the vanilla Papyrus sources (Creation Kit's `Scripts.zip`, or your game's
   `Data\Scripts\Source`),
2. the [SKSE](https://skse.silverlock.org/) script sources,
3. for `HD_WardrobeExec` only: the Papyrus sources of the mods it integrates
   with — the SkyUI SDK and Skyrim Outfit Equipment System NG both publish
   theirs — plus the `stubs/` folder here.

`HD_NPCControl` needs vanilla types only.

## About `stubs/`

`HD_WardrobeExec` also drives Nether's Follower Framework, whose Papyrus
sources are not redistributable. `stubs/` therefore contains **signature-only
stub scripts written by this project** — they declare exactly the functions and
properties `HD_WardrobeExec` touches (signatures transcribed from NFF's
decompiled scripts) so the compiler can type-check the calls. The stubs are
compile-time only: they are never shipped and never run. At runtime,
`GetFormFromFile` resolves NFF's real quest carrying NFF's real script.
