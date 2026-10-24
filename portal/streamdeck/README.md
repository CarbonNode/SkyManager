# SkyManager on a Stream Deck

Put your SkyManager hotkeys on physical Stream Deck keys. Press a key, the
hotkey fires in the running game — the deck does not open, the game does not
pause, and you never alt-tab.

It works for everything the deck can already fire: a keystroke entry, a chord,
a console command, or one of SkyManager's own actions (wait an hour, recall a
follower, open the wardrobe …). An action entry still aims at whatever is under
your crosshair at the moment you press the key, exactly as its keyboard trigger
does.

There is also an **Open SkyManager** key, if you would rather open the deck from
the Stream Deck than from F7.

---

## What you need

* **SkyManager**, with the **Deck Portal** option installed (the FOMOD's
  *Deck Portal* component). The portal is what the Stream Deck talks to.
* **Node.js** — <https://nodejs.org/en/download>. The portal needs it; this is
  the same requirement the portal has always had.
* The **Stream Deck app**, version 5 or newer, on the same PC as the game.

The portal starts by itself when you press **Portal** in the deck, and the game
shuts it down when it exits. You can also run it yourself: open
`Data\SKSE\Plugins\HotkeyDeck\portal\` and run `node server.js`.

## Install the plugin

1. Close the Stream Deck app (right-click its tray icon → Quit).
2. Copy the folder
   **`com.carbonnode.skymanager.sdPlugin`** (it sits next to this file) into

   ```
   %APPDATA%\Elgato\StreamDeck\Plugins\
   ```

   Paste that path into Explorer's address bar and it will take you there.
3. Start the Stream Deck app again. **SkyManager** appears in the actions list
   on the right.

There is no installer and nothing runs in the background: the plugin is a page
the Stream Deck app loads, and it only ever talks to `127.0.0.1`.

## Pair it (once)

The portal mints a 16-character code the first time it runs and writes it to:

```
Data\SKSE\Plugins\HotkeyDeck\portal\streamdeck-token.txt
```

Drag a **Deck entry** action onto a key, and paste that code into **Pairing
code** in the panel on the right. One code covers every key on every profile.

**Why a code at all?** The Stream Deck app is a browser under the skin, so the
portal has to answer it the way it answers a web page. Without the code, any
web page you happened to have open could press your hotkeys while you played.
With it, only your Stream Deck can.

> It is not your portal password, and it is not a secret worth guarding
> carefully — it unlocks three routes on your own PC and nothing else. If you
> ever want a new one, delete the file and restart the portal.

## Use it

**Deck entry** — pick a hotkey. The picker searches as you type (name, tab, key
cap or action), Enter takes the top hit, and each row shows the icon you gave
that hotkey in the deck. The key wears that icon, and its title is seeded with
the hotkey's name — after that the title is yours to edit in the normal Stream
Deck way.

**Open SkyManager** — Toggle, Open or Close. Toggle is the usual one.

A key shows the normal Stream Deck tick when the press lands, and a red cross
when it does not. A red dot in the corner of a key means the portal cannot see
a running game, so presses have nowhere to go yet.

## When it does not work

| What you see | What it means |
|---|---|
| **Nothing is answering at 127.0.0.1:8090** | The portal is not running. Launch the game and press Portal in the deck, or run `node server.js` yourself. |
| **The portal is there, but that pairing code is wrong** | Re-copy the code from `streamdeck-token.txt`. |
| **Red dot on the keys, presses refused** | The portal is up but Skyrim is not loaded into a save yet. |
| **"That hotkey is not in the deck any more"** | The entry was deleted or re-made in SkyManager. Pick it again in the panel. |
| The deck is open, or the console is up, and a press does nothing | A press is refused while a menu owns the screen — the same rule the keyboard trigger follows. |
| **The actions do not appear in Stream Deck** | The folder has to keep its exact name, `com.carbonnode.skymanager.sdPlugin`, and sit directly inside `Plugins\`. |

## Using it from another PC

Not supported by default, and not recommended: the portal binds to
`127.0.0.1`, so the Stream Deck app has to be on the same machine as the game.
If you have deliberately exposed the portal to your LAN
(`DECK_PORTAL_BIND` plus `DECK_PORTAL_PASSWORD`, see the portal's RUNBOOK), the
plugin can reach it by putting that PC's address in **Address** — the pairing
code travels in the request and the portal's password is not needed for these
three routes.

## What it is doing underneath

```
Stream Deck key
  → the plugin (HTTP, localhost)
  → the Deck Portal, /api/streamdeck/*
  → the pipe SkyManager already listens on
  → SkyManager fires the entry, exactly as its own key would
```

Nothing new happens in the game: the press runs the same code path as the
hotkey's keyboard trigger. If a hotkey behaves a certain way when you press its
key, it behaves that way from the Stream Deck.
