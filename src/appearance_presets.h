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
    void Tick(bool gameReady);
    void ResetForLoad();
}
