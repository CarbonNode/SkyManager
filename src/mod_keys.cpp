#include "mod_keys.h"
#include "keys_sources.h"

// pch (force-included) provides RE::/SKSE::/json and the logger.

#include <string>
#include <vector>

using json = nlohmann::json;

namespace ModKeys
{
	namespace
	{
		constexpr std::size_t kMaxPath = 260;
		constexpr std::size_t kMaxName = 128;
		constexpr std::size_t kMaxText = 200;

		// The three real modifiers, as the DIK codes FireChord holds down
		// (the same set main.cpp's ChordLabel names).
		constexpr std::uint32_t kShift = 42;
		constexpr std::uint32_t kCtrl = 29;
		constexpr std::uint32_t kAlt = 56;

		bool Fits(const std::string& s, std::size_t cap) { return s.size() <= cap; }

		// The path rules KeysSources::ReadSetting enforces again at read time;
		// refusing here as well keeps a bad spec out of hotkeys.json entirely.
		bool SafeRel(const std::string& rel)
		{
			if (rel.empty() || rel.size() > kMaxPath)
				return false;
			if (rel.front() == '/' || rel.front() == '\\' || rel.find(':') != std::string::npos)
				return false;
			std::string norm = rel;
			for (auto& c : norm)
				if (c == '\\')
					c = '/';
			return norm.find("../") == std::string::npos && norm != ".." &&
			       !(norm.size() >= 3 && norm.compare(norm.size() - 3, 3, "/..") == 0);
		}

		std::string Str(const json& j, const char* k)
		{
			const auto it = j.find(k);
			return (it != j.end() && it->is_string()) ? it->get<std::string>() : std::string();
		}

		// "Walk With Me: Order wheel" -> the sentence's subject. A blank entry
		// name falls back to the mod, then to the setting.
		std::string Who(const Spec& s, const std::string& entryName)
		{
			if (!entryName.empty())
				return entryName;
			if (!s.mod.empty())
				return s.mod;
			return s.key;
		}

		std::string WhereToSet(const Spec& s)
		{
			if (!s.where.empty())
				return s.where;
			return (s.mod.empty() ? std::string("that mod") : s.mod) +
			       "'s own settings (Data\\SKSE\\Plugins\\" + s.file + ")";
		}
	}

	bool FromJsonText(const std::string& jsonText, Spec& out)
	{
		const auto j = json::parse(jsonText, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;
		Spec s;
		s.file = Str(j, "file");
		s.section = Str(j, "section");
		s.key = Str(j, "key");
		s.modsKey = Str(j, "modsKey");
		s.modsKind = Str(j, "modsKind");
		s.space = Str(j, "space");
		s.mod = Str(j, "mod");
		s.where = Str(j, "where");
		if (s.space.empty())
			s.space = "dik";
		if (!SafeRel(s.file) || s.key.empty() || !Fits(s.key, kMaxName) ||
			!Fits(s.section, kMaxName) || !Fits(s.modsKey, kMaxName) ||
			!Fits(s.mod, kMaxText) || !Fits(s.where, kMaxText))
			return false;
		if (s.space != "dik" && s.space != "vk")
			return false;  // never guess an alphabet (keys_sources.h)
		if (!s.modsKind.empty() && s.modsKind != "mask")
			return false;
		if (s.modsKind.empty())
			s.modsKey.clear();  // a modifier field with no known spelling is noise
		out = std::move(s);
		return true;
	}

	std::string ToJsonText(const Spec& s)
	{
		json j{
			{ "file", s.file },
			{ "section", s.section },
			{ "key", s.key },
			{ "space", s.space },
		};
		if (!s.modsKey.empty()) {
			j["modsKey"] = s.modsKey;
			j["modsKind"] = s.modsKind;
		}
		if (!s.mod.empty())
			j["mod"] = s.mod;
		if (!s.where.empty())
			j["where"] = s.where;
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	Press Resolve(const Spec& s, const std::string& entryName)
	{
		Press p;
		const auto who = Who(s, entryName);
		if (!s.Set()) {
			p.msg = who + ": this button has lost its key source. Delete it and add it again.";
			return p;
		}
		long raw = 0;
		bool twice = false;
		if (!KeysSources::ReadSetting(s.file, s.section, s.key, raw, &twice)) {
			p.msg = twice
				? who + ": " + s.file + " has " + s.key + " more than once, so the deck can't tell which " +
				      "one is the key and pressed nothing. Set it in " + WhereToSet(s) + "."
				: who + ": couldn't read " + s.key + " from " + s.file +
				      ". Set the key in " + WhereToSet(s) + ".";
			return p;
		}
		p.raw = raw;
		const auto code = KeysSources::CensusCode(raw, s.space, s.key);
		if (!code) {
			p.msg = who + " has no key bound. Set one in " + WhereToSet(s) + ".";
			return p;
		}
		if (code >= 256) {
			// FireChord only presses keyboard scancodes for a mod-key; a mouse
			// bind is real but pressing it here would be a click, not a key.
			p.msg = who + " is bound to a mouse button, which the deck can't press for it. "
			        "Bind a keyboard key in " + WhereToSet(s) + ".";
			return p;
		}
		p.dik = code;
		if (!s.modsKey.empty() && s.modsKind == "mask") {
			// Walk With Me's docs: "Missing or invalid masks become 0."
			long mask = 0;
			if (!KeysSources::ReadSetting(s.file, s.section, s.modsKey, mask) || mask < 0 || mask > 7)
				mask = 0;
			if (mask & 1)
				p.mods.push_back(kShift);
			if (mask & 2)
				p.mods.push_back(kCtrl);
			if (mask & 4)
				p.mods.push_back(kAlt);
		}
		// A modifier bound on its own ("A modifier by itself can also be
		// bound") must not also be held around itself.
		std::erase(p.mods, p.dik);
		p.ok = true;
		return p;
	}
}
