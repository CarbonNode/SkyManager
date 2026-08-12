set_xmakever("2.8.2")

includes("../HotkeyDeck/lib/commonlibsse-ng")

set_project("FollowerOrganizer")
set_version("0.3.1")
set_license("GPL-3.0")

set_languages("c++23")
set_warnings("allextra")

add_rules("mode.release")

target("FollowerOrganizer")
    add_deps("commonlibsse-ng")

    add_rules("commonlibsse-ng.plugin", {
        name = "FollowerOrganizer",
        author = "MaskedRPGFan",
        description = "Manage your followers (patched: persistent members + SendBack + Follower Deck API)"
    })

    add_files("src/**.cpp")
    add_headerfiles("src/**.h", "src/**.hpp")
    add_includedirs("src", "extern")
    add_defines("UNICODE", "_UNICODE")
    set_pcxxheader("src/PCH.hpp")
    add_cxflags("/utf-8", "/Zc:__cplusplus", {force = true})

-- Strip the build machine's absolute paths out of __FILE__ (assert text,
-- exception messages). Undocumented MSVC flag, but the supported way to stop a
-- redistributed DLL from carrying the folder it happened to be built in — the
-- release scanner found three such strings in the shipped build.
add_cxflags([[/d1trimfile:C:\Dev\FollowerOrganizer\]], {force = true})

