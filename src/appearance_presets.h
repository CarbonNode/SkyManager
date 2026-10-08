#pragma once
#include "json.hpp"
#include <filesystem>
#include <functional>
#include <string>

// All entry points run on the main game thread. RaceMenu owns appearance
// serialization; this module owns the gallery and a per-operation progress
// checkpoint. A saved look NEVER contains player progress.
namespace AppearancePresets
{
    using json = nlohmann::json;
    using Done = std::function<void(const json&)>;
    void Init(const std::filesystem::path& viewDir, std::function<void(bool photo)> closeForGame);
    json State();
    void Handle(const json& request, Done done, std::function<void(bool photo)> closeForGame);
    // requestsPending = RequestsPending() taken on the caller's worker thread;
    // false skips the phone-queue directory walk on the game thread.
    void Tick(bool gameReady, bool requestsPending = true);
    // ANY THREAD (filesystem only): does appearance-requests/ hold a .json?
    // False until Init has run.
    bool RequestsPending();
    void ResetForLoad();
}
