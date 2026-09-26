# Deck Portal — SkyManager on your phone

The Deck Portal serves SkyManager's follower roster, wardrobe, hotkeys and
notes as a web page, so you can read and edit them from a phone or a second
monitor while the game runs.

It is **optional and off by default**. SkyManager works fully without it.

---

## What you need

* **Node.js** — <https://nodejs.org/en/download> (the LTS build is fine).
  This is the one extra thing the portal needs and the reason it is optional.
* SkyManager installed and working.

## Running it

The portal's files install to:

```
Data\SKSE\Plugins\HotkeyDeck\portal\
```

Open that folder and run:

```
node server.js
```

Then browse to <http://127.0.0.1:8090> on the same PC.

## Reaching it from a phone

By default the portal binds to **127.0.0.1** — the machine running it, and
nothing else. That is deliberate: a page that can rearrange your followers and
move your gold should not be answerable to anything on the network by default.

To reach it from a phone, bind wider **and set a password** — the server
refuses to start on a wide bind without one, rather than quietly exposing
itself:

```
set DECK_PORTAL_BIND=0.0.0.0
set DECK_PORTAL_PASSWORD=something-long
node server.js
```

Then open `http://<your-pc's-LAN-ip>:8090` on the phone, on the same network,
and log in.

Find your PC's LAN address with `ipconfig` (look for IPv4 Address, usually a 192.168 address).

## NPC icon packs — share your follower portraits

The **Followers** tab has a pack bar: **⇪ Share pack** downloads your portraits
as one `.zip` (each image named by its follower slug, plus a `manifest.json`);
**⇩ Import pack** opens someone else's zip and asks **face by face** what to
bring in — new faces default ON, replacements default OFF, so nothing you made
yourself is overwritten silently. A pack is a plain zip: you can also hand-make
one by renaming images to `<npc name>.png` and zipping them — no manifest needed.
Imported faces reach a running game within a second (the same live bridge as a
single upload) or appear at the next launch.

## Things worth knowing

* **The game does not need to be running.** With Skyrim closed you can still
  read everything and queue edits; they apply the next time the relevant tab
  opens in game. Portal edits are never written straight into the files the
  game owns while it owns them.
* **"Down" is normal.** Live state comes from the running game, so when Skyrim
  is closed the live panels say so rather than showing stale data as if it
  were current.
* **Do not port-forward it.** It is built for your own LAN. There is a password
  on wide binds, but it is not hardened for the open internet.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `DECK_PORTAL_BIND` | `127.0.0.1` | Interface to listen on. Anything wider requires a password. |
| `DECK_PORTAL_PASSWORD` | *(none)* | Required for a non-loopback bind. |
| `DECK_PORTAL_PORT` | `8090` | Port. |
| `DECK_PORTAL_PORTRAIT_DIR` | `<mod>\PrismaUI\views\HotkeyDeck\portraits` | Where portraits live, if you keep them in a separate mod from the deck's source (MO2 merges them in-game; the portal needs the real folder). |
| `DECK_PORTAL_CHIM_DISTRO` | `DwemerAI4Skyrim3` | WSL distro name, only used if you have CHIM installed. |
| `DECK_PORTAL_VIEW_ROOTS` | *(searched)* | `;`-separated mod roots that own a piece of `PrismaUI\views\{MagicDeck,HotkeyDeck}`, highest precedence first. Only needed if the search below gets it wrong: normally MO2's Overwrite, the personal-content mod, any mod found holding a view's `icons/` tree (an icon pack split out of the deck's mod), and the deck's own mod are all found automatically. Icon **reads** and the pool/library **listings** span every root; an **upload** lands in the highest-precedence mod folder that already holds the pool (never Overwrite), and a delete sweeps every root so no lower-priority copy resurfaces. |
| `DECK_PORTAL_HD_CONFIG_DIR` | *(searched)* | The folder holding the plugin's own sidecars — `hotkeys.json`, `combat-arts.json`, `journal.json`. Normally found on its own: MO2's Overwrite, then the deck's mod folder, then a split personal-content mod (derived from `DECK_PORTAL_PORTRAIT_DIR`, or found by sweeping the sibling mod folders for the one that really holds `hotkeys.json`). Set it to skip the search. |

If the Icons page says *"Spell Deck config unavailable — hotkeys.json not
found"*, open `/api/health`: `hkCfgDirs` lists every folder searched, `hkJson`
names the winner, and a non-empty `hkCfgSwept` means the configured folders
were all wrong and the startup sweep had to go find the config (the startup log
says so too). A moved config — e.g. splitting personal content into its own MO2
mod, after which the game keeps rewriting the file in place there — is the
usual cause.

Same page, same cause, different symptom: every spell row wearing a **"missing
art"** chip, or an icon library that counts far fewer icons than are installed,
means the portal is looking at only some of the mods that hold the view trees.
`/api/health` → `viewRoots` lists the roots it found (in precedence order),
`viewRootsSwept` the ones it had to go looking for, and `poolWriteDir` where an
upload would land. The deck itself never notices a split like this, because MO2
merges every enabled mod into one virtual `Data`.

## Formation controls

The Formation link next to Followers opens `/formation`, sharing the deployed
`hd-formation.js/css` with the game. Walk With Me 0.2.2 and a loaded game are
required. Commands are live-only; a receipt means queued, and the page polls for
the native result before declaring success. Save settings with Apply; SkyManager
closes its paused palette so the owner's Papyrus reload can execute. These
controls do not report whether an experimental hand grip physically connected.
