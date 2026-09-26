#pragma once
#include "json.hpp"
#include <algorithm>
#include <cctype>
#include <set>
#include <string>

// Domain photos are independent shots, not revisions to prune after capture.
// Preserve unknown per-photo metadata so newer clients survive an older writer.
namespace DomainPhotos {
using Json = nlohmann::json;
inline constexpr std::size_t Limit = 128;
inline std::string Text(const Json& value, std::size_t limit = 80) {
    if (!value.is_string()) return {};
    std::string out;
    bool space = false;
    for (unsigned char c : value.get<std::string>()) {
        if (std::isspace(c)) { space = !out.empty(); continue; }
        if (c < 32) continue;
        if (space) out += ' ';
        space = false;
        out += static_cast<char>(c);
        if (out.size() >= limit) break;
    }
    return out;
}
inline std::string Fold(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
    return s;
}
inline bool ValidImage(const std::string& image) {
    const std::string prefix = "domain-images/";
    if (image.rfind(prefix, 0) != 0 || image.size() > 240) return false;
    const auto file = image.substr(prefix.size());
    if (file.empty() || file.find("..") != std::string::npos || file.find_first_of("/\\:?#") != std::string::npos) return false;
    const auto ext = Fold(file.substr(file.find_last_of('.') == std::string::npos ? file.size() : file.find_last_of('.')));
    return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp";
}
inline Json Tags(const Json& values) {
    Json out = Json::array(); std::set<std::string> seen;
    if (values.is_array()) for (const auto& value : values) {
        auto tag = Text(value, 32);
        if (!tag.empty() && seen.insert(Fold(tag)).second) out.push_back(tag);
        if (out.size() >= 12) break;
    }
    return out;
}
inline Json Normalize(const Json& values, const std::string& cover = {}) {
    Json out = Json::array(); std::set<std::string> seen;
    if (values.is_array()) for (const auto& value : values) {
        if (!value.is_object() || !value.contains("image") || !value["image"].is_string()) continue;
        const auto image = value["image"].get<std::string>();
        if (!ValidImage(image) || !seen.insert(Fold(image)).second) continue;
        auto photo = value;
        photo["label"] = Text(value.value("label", Json()));
        photo["tags"] = Tags(value.value("tags", Json()));
        out.push_back(std::move(photo));
        if (out.size() >= Limit) break;
    }
    if (ValidImage(cover) && !seen.count(Fold(cover))) {
        // Retain a legacy cover even when a malformed/full list omitted it.
        if (out.size() >= Limit) out.erase(out.end() - 1);
        out.insert(out.begin(), Json{{"image", cover}, {"label", "Original photo"}, {"tags", Json::array()}});
    }
    return out;
}
inline void Append(Json& photos, std::string& cover, Json shot, bool makeCover) {
    photos = Normalize(photos, cover);
    const auto image = shot.value("image", std::string());
    if (!ValidImage(image) || photos.size() >= Limit) return;
    photos.push_back(std::move(shot));
    photos = Normalize(photos);
    if (cover.empty() || makeCover) cover = image;
}
inline bool Edit(Json& photos, std::string& cover, const Json& edit) {
    if (!edit.is_object() || !edit.contains("image") || !edit["image"].is_string() ||
        !edit.contains("op") || !edit["op"].is_string()) return false;
    auto normalized = Normalize(photos, cover);
    const auto image = edit["image"].get<std::string>();
    auto it = std::find_if(normalized.begin(), normalized.end(), [&](const auto& p){ return p["image"] == image; });
    if (it == normalized.end()) return false; // only edit images owned by this domain
    const auto op = edit["op"].get<std::string>();
    if (op == "cover") cover = image;
    else if (op == "details") { (*it)["label"] = Text(edit.value("label", Json())); (*it)["tags"] = Tags(edit.value("tags", Json())); }
    else if (op == "remove") {
        normalized.erase(it);
        if (cover == image) cover = normalized.empty() ? "" : normalized[0]["image"].get<std::string>();
    } else return false;
    photos = std::move(normalized);
    return true;
}
}
