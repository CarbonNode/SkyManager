-- set minimum xmake version
set_xmakever("2.8.2")

includes("lib/commonlibsse-ng")

set_project("HotkeyDeck")
set_version("1.8.0")
set_license("GPL-3.0")

set_languages("c++23")
set_warnings("allextra")

set_policy("package.requires_lock", true)

add_rules("mode.release")

-- targets
-- The DLL, the SKSE plugin name and the mod's public name are all SkyManager
-- (2026-08-11). The in-game UI has said SkyManager for weeks; this makes the
-- file agree with it.
--
-- NOT renamed, on purpose: Data\\SKSE\\Plugins\\HotkeyDeck\\hotkeys.json and
-- PrismaUI\\views\\HotkeyDeck. Those are paths the running plugin resolves and
-- the config an existing install already owns; moving them orphans a live
-- setup for no user-visible gain. Users see the DLL and the title, never the
-- folder names.
target("SkyManager")
    add_deps("commonlibsse-ng")

    add_rules("commonlibsse-ng.plugin", {
       name = "SkyManager",
       author = "Rober",
       description = "In-game control panel for Skyrim: a paused, searchable palette of named hotkeys, plus followers, wardrobe, travel, quests and loot."
    })

    -- The sources are UTF-8 (em dashes, arrows and warning glyphs in string
    -- literals). Without this MSVC guesses Windows-1252 for BOM-less files and
    -- re-encodes every non-ASCII literal into mojibake — which is how a room
    -- claimed as "Traveller's Inn — room" was displayed (and PERSISTED) as
    -- "Traveller's Inn Ã¢â‚¬â€ room" (Rober's screenshot, 2026-08-04).
    -- hd-markers.json markers stay pure ASCII, so the anti-clobber check is
    -- unaffected.
    add_cxflags("/utf-8")

    add_files("src/**.cpp")
    add_headerfiles("src/**.h", "src/**.hpp")
    add_includedirs("src")
    set_pcxxheader("src/pch.h")
