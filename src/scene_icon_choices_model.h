#pragma once

#include "scene_tags_model.h"
#include "position_icon_ids.h"
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <mutex>
#include <stdexcept>

// Appearance-only preferences. The scene classifier and its rebuildable cache
// do not own this document, and no browser-supplied document replaces it.
namespace SceneIconChoicesModel
{
    using json = nlohmann::json;
    namespace fs = std::filesystem;
    inline constexpr std::size_t kMaxScenes = 4096;
    inline constexpr std::size_t kMaxSceneIdBytes = 256;
    inline constexpr std::size_t kMaxFileBytes = 4 * 1024 * 1024;

    inline void Need(bool condition, const char* message)
    {
        if (!condition) throw std::runtime_error(message);
    }

    inline bool Selectable(std::string_view icon)
    {
        const auto& ids = SceneTags::Model::kSelectableIconIds;
        return std::find(ids.begin(), ids.end(), icon) != ids.end();
    }

    inline bool SceneId(const std::string& id)
    {
        return id.size() <= kMaxSceneIdBytes && SceneTagsModel::SceneId(id);
    }

    inline json Empty()
    {
        return { { "v", 1 }, { "categories", json::object() }, { "scenes", json::object() } };
    }

    inline void Validate(const json& document)
    {
        Need(document.is_object(), "The icon choices file is malformed. It has not been changed.");
        Need(document.contains("v") && document["v"].is_number_integer(),
            "The icon choices file has no supported version. It has not been changed.");
        Need(document["v"] == 1, "The icon choices file uses a different version. It has not been changed.");
        for (const char* field : { "categories", "scenes" })
            Need(document.contains(field) && document[field].is_object(),
                "The icon choices file is malformed. It has not been changed.");
        Need(document["scenes"].size() <= kMaxScenes,
            "The icon choices file exceeds 4096 scene overrides. It has not been changed.");
        for (const auto& [category, icon] : document["categories"].items()) {
            Need(SceneTagsModel::KnownIcon(category),
                "The icon choices file contains an unsupported category. It has not been changed.");
            Need(icon.is_string() && Selectable(icon.get_ref<const std::string&>()),
                "The icon choices file contains an unsupported icon. It has not been changed.");
        }
        for (const auto& [scene, icon] : document["scenes"].items()) {
            Need(SceneId(scene), "The icon choices file contains an invalid scene ID. It has not been changed.");
            Need(icon.is_string() && Selectable(icon.get_ref<const std::string&>()),
                "The icon choices file contains an unsupported icon. It has not been changed.");
        }
    }

    inline json Parse(const std::string& text)
    {
        Need(text.size() <= kMaxFileBytes, "The icon choices file is too large. It has not been changed.");
        auto document = json::parse(text, nullptr, false);
        Validate(document);
        return document;
    }

    inline json Apply(const json& document, const json& request)
    {
        Validate(document);
        Need(request.is_object(), "Invalid icon choice request.");
        for (const char* field : { "scope", "key", "icon" })
            Need(request.contains(field) && request[field].is_string(), "Invalid icon choice request.");
        const auto& scope = request["scope"].get_ref<const std::string&>();
        const auto& key = request["key"].get_ref<const std::string&>();
        const auto& icon = request["icon"].get_ref<const std::string&>();
        Need(scope == "scene" || scope == "category", "Choose a scene or category to customize.");
        Need(scope == "category" ? SceneTagsModel::KnownIcon(key) : SceneId(key),
            "The scene or category ID is invalid.");
        Need(icon.empty() || Selectable(icon), "Choose an icon from the installed catalog.");
        auto next = document; // Keep every unknown root field verbatim.
        auto& choices = next[scope == "scene" ? "scenes" : "categories"];
        if (icon.empty()) choices.erase(key);
        else {
            Need(scope != "scene" || choices.contains(key) || choices.size() < kMaxScenes,
                "The library already has 4096 scene overrides. Reset one before adding another.");
            choices[key] = icon;
        }
        Validate(next);
        return next;
    }

    // The production adapter supplies MoveFileExW(REPLACE_EXISTING |
    // WRITE_THROUGH). Tests use same-directory rename, or an injected failure
    // at that one operating-system boundary; the actual file IO is shared.
    using Replace = std::function<bool(const fs::path&, const fs::path&, std::error_code&)>;

    class Store
    {
    public:
        explicit Store(fs::path path, Replace replace) : path_(std::move(path)), replace_(std::move(replace)) {}

        json Read() const
        {
            std::lock_guard<std::mutex> lock(mutex_);
            return ReadUnlocked();
        }

        json Set(const json& request)
        {
            std::lock_guard<std::mutex> lock(mutex_);
            const auto original = ReadUnlocked(); // Always merge the latest on-disk document.
            const auto next = Apply(original, request);
            if (next == original) return next;
            const auto text = next.dump(2);
            Need(text.size() <= kMaxFileBytes, "The updated icon choices file would be too large. Nothing was saved.");
            std::error_code ec;
            if (!path_.parent_path().empty()) fs::create_directories(path_.parent_path(), ec);
            Need(!ec, "The icon choices folder could not be created. Nothing was saved.");
            static std::atomic_uint64_t counter{ 0 };
            auto temporary = path_;
            temporary += ".tmp-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
                "-" + std::to_string(counter.fetch_add(1));
            try {
                std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
                Need(output.is_open(), "The icon choices file could not be prepared. Your previous choices are intact.");
                output.write(text.data(), static_cast<std::streamsize>(text.size()));
                output.flush();
                Need(output.good(), "The icon choices file could not be written. Your previous choices are intact.");
                output.close();
                Need(!output.fail(), "The icon choices file could not be closed. Your previous choices are intact.");
                Need(replace_ && replace_(temporary, path_, ec),
                    "The icon choices file could not be replaced. Your previous choices are intact.");
            } catch (...) {
                std::error_code cleanup;
                fs::remove(temporary, cleanup);
                throw;
            }
            return next;
        }

    private:
        json ReadUnlocked() const
        {
            std::error_code ec;
            const bool exists = fs::exists(path_, ec);
            Need(!ec, "The icon choices file could not be inspected. It has not been changed.");
            if (!exists) return Empty();
            Need(fs::is_regular_file(path_, ec) && !ec,
                "The icon choices path is not a readable file. It has not been changed.");
            const auto bytes = fs::file_size(path_, ec);
            Need(!ec && bytes <= kMaxFileBytes, "The icon choices file is unreadable or too large. It has not been changed.");
            std::ifstream input(path_, std::ios::binary);
            Need(input.is_open(), "The icon choices file could not be opened. It has not been changed.");
            const std::string text((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
            Need(!input.bad(), "The icon choices file could not be read. It has not been changed.");
            return Parse(text);
        }

        fs::path path_;
        Replace replace_;
        mutable std::mutex mutex_;
    };
} // namespace SceneIconChoicesModel
