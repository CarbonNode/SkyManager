#pragma once
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
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
	inline std::string Trim(const std::string& v) {
		const auto a = v.find_first_not_of(" \t\r\n"), b = v.find_last_not_of(" \t\r\n");
		return a == std::string::npos ? std::string() : v.substr(a, b - a + 1);
	}
	inline std::string Lower(std::string v) {
		std::transform(v.begin(), v.end(), v.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		return v;
	}
	// One accessory or wheel piece: a LOCAL FormID in its plugin, never a runtime id.
	inline json Piece(const json& p) {
		static const std::regex form(R"(^0x[0-9a-f]{1,6}$)", std::regex::icase);
		static const std::regex pluginPattern(R"(^.{1,120}\.(esm|esp|esl)$)", std::regex::icase);
		Need(p.is_object(), "An accessory needs its plugin and local FormID");
		const auto fid = p.value("formId", std::string()), plugin = p.value("plugin", std::string());
		Need(std::regex_match(fid, form) && std::stoul(fid, nullptr, 16) > 0 && std::regex_match(plugin, pluginPattern) && plugin.find_first_of("/\\|") == std::string::npos, "An accessory needs its plugin and local FormID");
		char hex[16]; std::snprintf(hex, sizeof hex, "0x%lX", std::stoul(fid, nullptr, 16));
		auto text = [&](const char* k, std::size_t max) { const auto v = p.value(k, std::string()); return v.size() <= max ? Trim(v) : std::string(); };
		return {{"formId", hex}, {"plugin", plugin}, {"name", text("name", 160)}, {"slot", text("slot", 40)}};
	}
	inline std::string PieceToken(const json& q) { return Lower(q.value("formId", std::string()) + "|" + q.value("plugin", std::string())); }
	inline json Flair(const json& doc) {
		auto f = doc.value("flair", json::object());
		if (!f.is_object()) f = json::object();
		if (!f.contains("sets") || !f["sets"].is_array()) f["sets"] = json::array();
		for (const char* key : {"links", "categoryIcons", "pools", "dock", "wheel"})
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
			for (const auto& p : e["items"]) {
				auto q = Piece(p);
				Need(seen.insert(PieceToken(q)).second, "The same accessory was selected twice");
				pieces.push_back(std::move(q));
			}
			const json value{{"id",id},{"name",name},{"icon",icon},{"items",pieces}};
			if (auto* set = find(f["sets"], "id", id)) *set = value;
			else { Need(f["sets"].size() < 100, "Maximum 100 Flair sets"); f["sets"].push_back(value); }
		} else if (type == "delete") {
			std::erase_if(f["sets"].get_ref<json::array_t&>(), [&](const json& s) { return s.value("id", std::string()) == id; });
			for (auto it = f["links"].begin(); it != f["links"].end();) { if (it.value() == id) it = f["links"].erase(it); else ++it; }
			if (f["wheel"].contains("slots") && f["wheel"]["slots"].is_array())
				for (auto& slot : f["wheel"]["slots"])
					if (slot.is_object() && slot.contains("flyout") && slot["flyout"].is_array())
						std::erase_if(slot["flyout"].get_ref<json::array_t&>(), [&](const json& x) { return x.is_object() && x.contains("set") && x["set"] == id; });
		} else if (type == "wheel") {
			// wardrobe-wheel: up to 8 looks, each with up to 8 flyout choices
			Need(e.contains("slots") && e["slots"].is_array() && e["slots"].size() <= 8, "The wheel holds up to 8 looks");
			json slots = json::array(); std::unordered_set<std::string> seenSlot;
			for (const auto& sl : e["slots"]) {
				Need(sl.is_object(), "Choose an outfit or wardrobe");
				const auto k = sl.value("kind", std::string()), sid = sl.value("id", std::string());
				Need((k == "outfit" || k == "wardrobe") && sid.size() <= 160 && !Trim(sid).empty(), "Choose an outfit or wardrobe");
				Need(seenSlot.insert(k + ":" + sid).second, "That look is already on the wheel");
				const json raw = sl.contains("flyout") ? sl["flyout"] : json::array();
				Need(raw.is_array() && raw.size() <= 8, "A flyout holds up to 8 choices");
				json flyout = json::array(); std::unordered_set<std::string> taken;
				for (const auto& x : raw) {
					Need(x.is_object() && x.contains("set") != x.contains("item"), "A flyout choice is a Flair set or one piece");
					json v; std::string token;
					if (x.contains("set")) {
						Need(x["set"].is_string() && Id(x["set"].get<std::string>()), "Choose a Flair set");
						v = {{"set", x["set"]}}; token = "set:" + x["set"].get<std::string>();
					} else {
						v = {{"item", Piece(x["item"])}}; token = "item:" + PieceToken(v["item"]);
					}
					Need(taken.insert(token).second, "That choice is already in this flyout");
					flyout.push_back(std::move(v));
				}
				if (k == "wardrobe") Need(find(doc["wardrobes"], "id", sid) != nullptr, "That wardrobe no longer exists");
				for (const auto& v : flyout)
					if (v.contains("set")) Need(find(f["sets"], "id", v["set"].get<std::string>()) != nullptr, "That Flair set no longer exists");
				slots.push_back({{"kind", k}, {"id", sid}, {"flyout", std::move(flyout)}});
			}
			f["wheel"]["slots"] = std::move(slots);
		} else if (type == "wheel-options") {
			Need(e.contains("slow") && e["slow"].is_number() && std::isfinite(e["slow"].get<double>()) && e.contains("size") && e["size"].is_number() && std::isfinite(e["size"].get<double>()), "Invalid wheel settings");
			f["wheel"]["slow"] = std::round(std::clamp(e["slow"].get<double>(), .05, 1.) * 100) / 100;
			f["wheel"]["size"] = static_cast<int>(std::round(std::clamp(e["size"].get<double>(), 40., 80.)));
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
