# CHIM support — installing the Ask endpoint

SkyManager's **Ask** mode (the second tab of universal search, Ctrl+F) answers
questions about your NPCs from [CHIM](https://www.nexusmods.com/skyrimspecialedition/mods/126330)'s
own database — personality, relationships, what someone said, who is following
you, what happened recently.

The in-game half ships with SkyManager and needs no setup. The half that reads
CHIM's database is one PHP file that has to live **inside your CHIM install**,
because that is where the database and the web server are.

**If you do not use CHIM, ignore this entirely.** The Ask tab will say it
cannot reach CHIM, and nothing else is affected.

---

## Install

Copy `deck_ask.php` into your CHIM distro at:

```
/var/www/html/HerikaServer/ext/deck_ask/ask.php
```

From Windows, with CHIM's WSL distro running:

```
wsl -d DwemerAI4Skyrim3 -- mkdir -p /var/www/html/HerikaServer/ext/deck_ask
wsl -d DwemerAI4Skyrim3 -- cp /mnt/c/path/to/deck_ask.php /var/www/html/HerikaServer/ext/deck_ask/ask.php
```

**The person page (Memories, Bonds & Life) needs a second file beside it** —
`person.php`, a CLI helper `ask.php` calls (same pattern as `dynprof.php`):

```
wsl -d DwemerAI4Skyrim3 -- cp /mnt/c/path/to/person.php /var/www/html/HerikaServer/ext/deck_ask/person.php
```

It runs CHIM's OWN relationship system and Background Life — the deck shows
and drives what CHIM already tracks, it does not keep a parallel copy.

**Bio Blocks (the dossier's CHIM page) is its own CHIM ext** — three files in
`ext/bioblocks/` (source: `roleplay/chim-prompts/ext/bioblocks/`). `ask.php`
reaches `bio.php` there; `context_pre.php` is what puts the blocks into an
NPC's prompt. Without the folder the section says Bio Blocks is not installed.

```
wsl -d DwemerAI4Skyrim3 -- mkdir -p /var/www/html/HerikaServer/ext/bioblocks
wsl -d DwemerAI4Skyrim3 -- cp /mnt/c/path/to/bioblocks/bio_lib.php /mnt/c/path/to/bioblocks/bio.php /mnt/c/path/to/bioblocks/context_pre.php /var/www/html/HerikaServer/ext/bioblocks/
```

Replace the distro name if yours differs. That is the whole install — no
service to restart, no configuration required.

## What it uses, and what it does not

* **It reads CHIM's database** — the NPC profiles, dialogue history, diaries
  and event log that CHIM already keeps. Read-only.
* **"Think about it"** sends one question through **CHIM's own configured LLM
  connector** — the same provider, key and model your NPCs already talk
  through. That is deliberate: it means nothing extra to sign up for, no
  second API key, and no key stored by this mod. It reads that connector out
  of CHIM's own tables exactly as CHIM does, and sends nothing anywhere else.
* **It never writes to CHIM.** No profile edits, no schema changes.

## Optional: answer from your own notes

Ask can also answer from documents you write yourself — a campaign journal, a
character sheet, notes a mod's data could never contain. Point it at a folder
of markdown files:

```
DECK_ASK_DOCS=/path/to/your/notes
```

Unset, which is the default, the feature is skipped entirely.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "cannot reach CHIM" | CHIM is not running. It only runs while the game does. |
| Ask answers, "Think about it" fails | No LLM connector configured in CHIM, or its key is empty. |
| A question about spouses returns nobody | SkyManager asks CHIM who your character is; if it cannot tell, it matches any spouse rather than none. Check your player name is set in CHIM. |

## dynprof.php (2026-09-21)

The CHIM flyout's **Refresh dynamic profile** row needs a second file next to
`ask.php`: `dynprof.php`, a CLI twin of CHIM's own service bootstrap that runs the
dynamic-profile scheduler for ONE NPC. Copy it to
`/var/www/html/HerikaServer/ext/deck_ask/dynprof.php` the same way. `ask.php`'s
`chim_state` / `diary` / `dynprof_set` modes work without it; only
`dynprof_refresh` shells out to it.
