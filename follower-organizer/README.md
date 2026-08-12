# Follower Organizer fork — our additions

This folder contains the files SkyManager adds to MaskedRPGFan's **Follower
Organizer** SKSE plugin. Apply them to a compatible upstream checkout and build
with xmake against CommonLibSSE-NG. Only the files authored for this integration
are tracked here:

| File | What it is |
|---|---|
| `src/DeckAPI.cpp` | The Follower Deck API: two `extern "C"` exports (`FollowerDeck_GetState`, `FollowerDeck_Apply`) that the Hotkey Deck plugin's Followers tab calls in-process via `GetProcAddress`. State reads + every mutation (rename / describe / fields / move / reorder / delete / add / summon / goto / sendback / track / category rename / magic-menu toggle) go through the organizer singleton's own functions, so FO's messagebox UI and the deck can never drift. Main-thread only. |
| `src/FollowerOrganizer/Member.hpp` / `Member.cpp` | Our edited copies of FO's Member (v0.3.0: adds the persisted `fields` map under `"Fields"`, plus the v0.1.x persistence/backfill fixes). Deployed over the rig copies at build time, same as DeckAPI.cpp. |
| `xmake.lua` | Build config (v0.3.0). Deployed over the rig copy at build time. |

## Patch history

- **v0.1.x (2026-07-24)** — persistent members (unresolved forms are kept, not dropped) +
  SendBack action + drag-along mitigation (`EvaluatePackage` after MoveTo). Rig-only edits.
- **v0.2.0 (2026-07-28)** — Follower Deck API (`src/DeckAPI.cpp`), consumed by
  Hotkey Deck ≥ 0.7.0. See `modding/hotkey-deck/README.md` ("Follower Deck").
- **v0.3.0 (2026-07-29)** — **NPC fields**: `Member::fields`
  (`std::map<std::string,std::string>`, persisted under `"Fields"`; Member.hpp/.cpp now
  repo-tracked) plus two Deck API ops — `setField` (cat/idx, from the Followers tab) and
  `setFieldByOriginal` (by name, from the Deck Portal sidecar; applies to every entry
  with that original name). Consumed by Hotkey Deck ≥ 0.10.0. ⚠ An FO DLL older than
  0.3.0 silently strips `"Fields"` on its next save — the DLLs ship as a matched set.
- **v0.3.1 (2026-07-31)** — **every free-text value is bounded.** `TrimField` (trim +
  clamp to `kFieldValueMax` = 300 bytes, cut on a UTF-8 boundary) already guarded the
  NPC fields, but `renameMember`, `setDesc` and `renameCategory` were exempt — despite
  taking the same road into the same JSON, written by the same serializer, and being the
  three ops the phone portal can drive remotely. All five free-text ops now go through
  it. `""` is untouched by the trim, so "blank restores the original name" still works
  for both the member and the category. **No export or format change**, so this is *not*
  a matched-set bump: Hotkey Deck needs no rebuild. The view side caps the same three
  boxes at 300 (`clampText` in `followers-pane.js`), but the portal does not go through
  the view, which is why the bound has to exist here.

## Build

```powershell
# From a compatible Follower Organizer source checkout, copy these integration
# files into the matching source paths, then build:
xmake -y      # output: build\windows\x64\release\FollowerOrganizer.dll
```

Install the resulting DLL under your mod manager's
`SKSE\Plugins\FollowerOrganizer.dll`. **Never replace it while SkyrimSE.exe is
running.**

The organizer's data file (`Data/SKSE/Plugins/FollowerOrganizer.json`) stays exclusively
FO-owned: the deck mutates through the singleton, FO saves with its own rotating backups.

## CategoryCount raised 25 → 40

The cap lives in the upstream fork's own sources (not fully vendored here; this
folder carries only the integration files). The compatible fork applies three
edits:

- `src/Constants.hpp`: `CategoryCount = 40` (was 25). `MaxTrackedMembers`
  deliberately unchanged.
- `src/FollowerOrganizer/FollowerOrganizer.cpp`, settings-load loop: the
  category-spell re-resolve now guards `CategorySpellRawID[i-1]` with
  `std::size(...)` (spell = nullptr past 25) and the master-category member
  write with `members.size()`.
- Same file, `CreateDefaultCategories`: the emplace uses a guarded
  `cat_spell` local, and the master-spell push is null-checked.

**What categories 26–40 are:** deck-only. FollowerOrganizer.esp defines
exactly 25 category SPELLs (0x901–0x919, the magic-menu toggles) and 25
tracking QUESTs — the new categories have neither, so no magic-menu toggle
and no map tracking for them. Everything else (filing, renames, notes,
fields, the deck/portal UI) works because storage is a dynamic vector and the
Deck API iterates `categories.size()`. Full parity later = adding SPEL+QUST
records to the ESP and extending `CategorySpellRawID`.

FO's own native Papyrus picker past 25 entries is untested; the deck is the
primary UI for the expanded category range.
