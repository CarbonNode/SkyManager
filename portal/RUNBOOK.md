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
| `DECK_PORTAL_CHIM_DISTRO` | `DwemerAI4Skyrim3` | WSL distro name, only used if you have CHIM installed. |
