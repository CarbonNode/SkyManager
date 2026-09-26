#pragma once
#include <algorithm>
#include <cctype>
#include <cmath>
#include "json.hpp"
#include <regex>
#include <stdexcept>
#include <string>
#include <unordered_set>

// Pure metadata operations, mirrored by wardrobe-flair-model.js. No game IO.
namespace WardrobeFlairModel
{
	using json = nlohmann::json;
	inline void Need(bool ok, const char* message) { if (!ok) throw std::invalid_argument(message); }
	inline bool Id(const std::string& s) {
		return !s.empty() && s.size() <= 80 && s != "__proto__" && s != "constructor" && s != "prototype" &&
			std::all_of(s.begin(), s.end(), [](unsigned char c) { return std::isalnum(c) || c == '_' || c == '-'; });
	}
	inline bool Image(const std::string& s) {
		static const std::regex pattern(R"(^icons/(custom|items)/[a-zA-Z0-9 _~().@+-]+\.(png|jpg|jpeg|webp)$)", std::regex::icase);
		return s.empty() || (s.size() < 260 && std::regex_match(s, pattern));
	}
	inline json Flair(const json& doc) {
		auto f = doc.value("flair", json::object());
		if (!f.is_object()) f = json::object();
		if (!f.contains("sets") || !f["sets"].is_array()) f["sets"] = json::array();
		for (const char* key : {"links", "categoryIcons", "pools", "dock"})
			if (!f.contains(key) || !f[key].is_object()) f[key] = json::object();
		if (!f.contains("keep") || !f["keep"].is_boolean()) f["keep"] = true;
		return f;
	}
	inline void Apply(json& doc, const json& e) {
		Need(e.is_object(), "Missing edit");
		auto f = Flair(doc);
		const auto type = e.value("type", std::string());
		const auto id = e.value("id", std::string());
		const auto name = e.value("name", std::string());
		const auto kind = e.value("kind", std::string());
		for (const char* key : {"categories", "outfitMeta", "wardrobes"})
			if (!doc.contains(key) || !doc[key].is_array()) doc[key] = json::array();
		auto find = [](json& rows, const char* key, const std::string& value) -> json* {
			for (auto& row : rows) if (row.is_object() && row.value(key, std::string()) == value) return &row;
			return nullptr;
		};
		auto meta = [&](const std::string& n) -> json& {
			Need(!n.empty() && n.size() <= 160, "Choose an outfit");
			if (auto* m = find(doc["outfitMeta"], "name", n)) return *m;
			doc["outfitMeta"].push_back({{"name", n}}); return doc["outfitMeta"].back();
		};
		auto pool = [&]() -> json& {
			Need(find(doc["wardrobes"], "id", id) != nullptr, "That wardrobe no longer exists");
			if (!f["pools"].contains(id) || !f["pools"][id].is_object()) f["pools"][id] = json::object();
			return f["pools"][id];
		};
		if (type == "set" || type == "delete" || type == "category" || type == "category-delete" || type == "category-icon" || type == "pool") Need(Id(id), "Invalid identifier");
		if (type == "set") {
			Need(!name.empty() && name.size() <= 100, "Give the Flair set a name");
			const auto icon = e.value("icon", std::string()); Need(Image(icon), "Choose an image from the icon library");
			Need(e.contains("items") && e["items"].is_array() && !e["items"].empty() && e["items"].size() <= 32, "Choose 1 to 32 accessories");
			json pieces = json::array(); std::unordered_set<std::string> seen;
			static const std::regex form(R"(^0x[0-9a-f]{1,6}$)", std::regex::icase);
			static const std::regex pluginPattern(R"(^.{1,120}\.(esm|esp|esl)$)", std::regex::icase);
			for (const auto& p : e["items"]) {
				Need(p.is_object(), "Invalid accessory");
				const auto fid = p.value("formId", std::string()), plugin = p.value("plugin", std::string());
				Need(std::regex_match(fid, form) && std::stoul(fid, nullptr, 16) > 0 && std::regex_match(plugin, pluginPattern) && plugin.find_first_of("/\\|") == std::string::npos, "An accessory needs its plugin and local FormID");
				std::string token = std::to_string(std::stoul(fid, nullptr, 16)) + "|" + plugin;
				std::transform(token.begin(), token.end(), token.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				Need(seen.insert(token).second, "The same accessory was selected twice");
				pieces.push_back({{"formId", fid}, {"plugin", plugin}, {"name", p.value("name", std::string()).substr(0,160)}, {"slot", p.value("slot", std::string()).substr(0,40)}});
			}
			const json value{{"id",id},{"name",name},{"icon",icon},{"items",pieces}};
			if (auto* set = find(f["sets"], "id", id)) *set = value;
			else { Need(f["sets"].size() < 100, "Maximum 100 Flair sets"); f["sets"].push_back(value); }
		} else if (type == "delete") {
			std::erase_if(f["sets"].get_ref<json::array_t&>(), [&](const json& s) { return s.value("id", std::string()) == id; });
			for (auto it = f["links"].begin(); it != f["links"].end();) { if (it.value() == id) it = f["links"].erase(it); else ++it; }
		} else if (type == "link") {
			Need((kind == "outfit" || kind == "wardrobe") && !id.empty() && id.size() <= 160, "Choose an outfit or wardrobe");
			const auto link = e.value("flairId", std::string());
			Need(link.empty() || (Id(link) && find(f["sets"], "id", link)), "That Flair set no longer exists");
			if (kind == "wardrobe") pool();
			if (link.empty()) f["links"].erase(kind + ":" + id); else f["links"][kind + ":" + id] = link;
		} else if (type == "favorite") {
			Need(e.contains("value") && e["value"].is_boolean(), "Invalid favorite"); meta(name)["fav"] = e["value"];
		} else if (type == "categories") {
			Need((kind == "outfit" || kind == "wardrobe") && e.contains("ids") && e["ids"].is_array() && e["ids"].size() <= 50, "Choose valid categories");
			for (const auto& cid : e["ids"]) Need(cid.is_string() && Id(cid.get<std::string>()) && find(doc["categories"], "id", cid.get<std::string>()), "A category no longer exists");
			(kind == "outfit" ? meta(id) : pool())["categoryIds"] = e["ids"];
		} else if (type == "category") {
			Need(!name.empty() && name.size() <= 64, "Name the category");
			if (auto* c = find(doc["categories"], "id", id)) (*c)["name"] = name;
			else { Need(doc["categories"].size() < 100, "Maximum 100 categories"); doc["categories"].push_back({{"id",id},{"name",name},{"hue",38}}); }
		} else if (type == "category-delete") {
			std::erase_if(doc["categories"].get_ref<json::array_t&>(), [&](const json& s) { return s.value("id", std::string()) == id; });
			f["categoryIcons"].erase(id);
			auto prune = [&](json& m) { if (m.contains("categoryIds") && m["categoryIds"].is_array()) std::erase(m["categoryIds"].get_ref<json::array_t&>(), json(id)); };
			for (auto& m : doc["outfitMeta"]) prune(m);
			for (auto& m : f["pools"]) prune(m);
		} else if (type == "category-icon") {
			const auto icon = e.value("icon", std::string()); Need(Image(icon) && find(doc["categories"], "id", id), "Choose a category and image"); f["categoryIcons"][id] = icon;
		} else if (type == "pool") {
			auto& p = pool();
			if (e.contains("fav")) { Need(e["fav"].is_boolean(), "Invalid favorite"); p["fav"] = e["fav"]; }
			if (e.contains("image")) { Need(e["image"].is_string() && Image(e["image"].get<std::string>()), "Invalid image"); p["image"] = e["image"]; }
		} else if (type == "keep") { Need(e.contains("value") && e["value"].is_boolean(), "Invalid keep setting"); f["keep"] = e["value"]; }
		else if (type == "dock-enabled") {
			Need(e.contains("value") && e["value"].is_boolean(), "Invalid dock enabled setting");
			f["dock"]["enabled"] = e["value"];
		} else if (type == "dock") {
			for (const char* k : {"x","y","scale"}) Need(e.contains(k) && e[k].is_number() && std::isfinite(e[k].get<double>()), "Invalid dock position");
			f["dock"].update(json{{"x",std::clamp(e["x"].get<double>(),0.,100.)},{"y",std::clamp(e["y"].get<double>(),0.,100.)},{"scale",std::clamp(e["scale"].get<double>(),.65,1.4)},{"motion",e.value("motion",std::string())=="reduced"?"reduced":"full"}});
			if (e.contains("orientation")) { Need(e["orientation"] == "vertical" || e["orientation"] == "horizontal", "Invalid dock layout"); f["dock"]["orientation"] = e["orientation"]; }
			if (e.contains("edgeX")) { Need(e["edgeX"] == "" || e["edgeX"] == "left" || e["edgeX"] == "right", "Invalid horizontal edge"); f["dock"]["edgeX"] = e["edgeX"]; }
			if (e.contains("edgeY")) { Need(e["edgeY"] == "" || e["edgeY"] == "top" || e["edgeY"] == "bottom", "Invalid vertical edge"); f["dock"]["edgeY"] = e["edgeY"]; }
		} else Need(false, "Unknown Flair edit");
		doc["flair"] = std::move(f);
	}
}
