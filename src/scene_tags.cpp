#include "scene_tags.h"
#include "scene_tags_model.h"
#include "scene_icon_choices_model.h"

#include <exception>
#include <filesystem>
#include <fstream>

namespace SceneTags
{
    namespace
    {
        using json = nlohmann::json;
        namespace fs = std::filesystem;
        constexpr const char* kScenes = "Data/SKSE/Plugins/OStim/scenes";
        constexpr const char* kCache = "Data/SKSE/Plugins/HotkeyDeck/scene-icons.json";
        constexpr const char* kChoices = "Data/SKSE/Plugins/HotkeyDeck/scene-icon-choices.json";

        SceneIconChoicesModel::Store& Choices()
        {
            static SceneIconChoicesModel::Store store(kChoices,
                [](const fs::path& from, const fs::path& to, std::error_code& error) {
                    if (MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                        return true;
                    error = std::error_code(static_cast<int>(GetLastError()), std::system_category());
                    return false;
                });
            return store;
        }

        json ReadJson(const fs::path& path)
        {
            try {
                std::ifstream in(path, std::ios::binary);
                if (in) return json::parse(in, nullptr, false);
            } catch (const std::exception&) {
                // Bad content or an unreadable file must not terminate the
                // detached worker. A scene counts as invalid; a cache rescans.
            }
            return json();
        }

        std::string Dump(const json& value)
        {
            return value.dump(-1, ' ', false, json::error_handler_t::replace);
        }
    }

    std::string MapJson(bool rescan)
    {
        // Schema 3 rejects old mappings and any unrecognised asset key.
        if (!rescan) {
            auto cache = ReadJson(kCache);
            if (SceneTagsModel::ValidCache(cache)) {
                cache["cached"] = true;
                cache["ok"] = true;
                return Dump(cache);
            }
        }

        std::error_code ec;
        if (!fs::is_directory(kScenes, ec)) {
            auto out = SceneTagsModel::Index{}.Result();
            out["ok"] = false;
            out["msg"] = "No OStim scenes folder — is OStim installed?";
            return Dump(out);
        }

        SceneTagsModel::Index index;
        for (fs::recursive_directory_iterator it(kScenes, fs::directory_options::skip_permission_denied, ec), end;
             it != end && !ec; it.increment(ec)) {
            if (!it->is_regular_file(ec)) continue;
            if (SceneTagsModel::Lower(PathU8(it->path().extension())) != ".json") continue;
            index.Add(ReadJson(it->path()), PathU8(it->path().stem()));
        }

        auto out = index.Result();
        logger::info("scene-icons: scanned {} scene file(s), matched {}",
            out["scanned"].get<std::size_t>(), out["matched"].get<std::size_t>()); // marker: scene-icon-index
        logger::info("scene-icons: {} unique scenes, {} invalid files, {} duplicate records, {} conflicting IDs",
            out["uniqueScenes"].get<std::size_t>(), out["invalid"].get<std::size_t>(),
            out["duplicates"].get<std::size_t>(), out["conflicts"].get<std::size_t>());
        if (ec) {
            out["ok"] = false;
            out["msg"] = "The scene icon scan could not finish. Retry the scan.";
            return Dump(out); // Never cache an incomplete directory traversal.
        }

        std::error_code mk;
        fs::create_directories(fs::path(kCache).parent_path(), mk);
        std::ofstream cache(kCache, std::ios::binary | std::ios::trunc);
        if (cache) cache << Dump(out);
        return Dump(out);
    }

    std::string ChoicesJson()
    {
        try {
            return Dump({ { "ok", true }, { "choices", Choices().Read() } });
        } catch (const std::exception& error) {
            logger::warn("scene-icon-choices: read refused: {}", error.what());
            return Dump({ { "ok", false }, { "msg", error.what() } });
        }
    }

    std::string SetChoiceJson(const std::string& payload)
    {
        try {
            const auto request = json::parse(payload, nullptr, false);
            auto choices = Choices().Set(request);
            const auto icon = request["icon"].get<std::string>();
            logger::info("scene-icon-choices: saved {} override for {} -> {}",
                request["scope"].get<std::string>(), request["key"].get<std::string>(), icon.empty() ? "automatic" : icon);
            return Dump({ { "ok", true }, { "choices", std::move(choices) },
                { "msg", icon.empty() ? "Icon choice reset." : "Icon choice saved." } });
        } catch (const std::exception& error) {
            logger::warn("scene-icon-choices: write refused: {}", error.what());
            return Dump({ { "ok", false }, { "msg", error.what() } });
        }
    }
}
