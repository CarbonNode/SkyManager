#pragma once
#include "json.hpp"
#include <filesystem>
#include <string>

// Metadata only: shared family links, page preferences and recorded history.
// Call on the game's main thread (identity resolution reads engine forms).
// Owns Data/SKSE/Plugins/HotkeyDeck/dossier.json; never writes hotkeys.json.
namespace DossierStore
{
    nlohmann::json Handle(const nlohmann::json& request);
    std::string Handle(const std::string& request);
    void ProcessPortalQueue(const std::filesystem::path& viewDir);
}
