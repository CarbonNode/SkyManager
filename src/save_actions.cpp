#include "save_actions.h"

#include <chrono>
#include <cstdio>
#include <ctime>
#include <string>
#include <thread>

// pch (force-included) provides RE::/SKSE:: and the logger.

namespace SaveActions
{
	namespace
	{
		// Characters Windows refuses in a filename, plus the ones Skyrim's own
		// save handling is happier without. Stripped rather than replaced: a
		// name full of underscores reads worse than a name with a word missing
		// a punctuation mark.
		bool Illegal(char c)
		{
			switch (c) {
			case '\\': case '/': case ':': case '*': case '?':
			case '"':  case '<': case '>': case '|':
				return true;
			default:
				// Control characters, and anything non-ASCII: a save name is
				// handed to the filesystem as bytes, and a stray high byte from
				// a mod-added location name is not worth the risk.
				return static_cast<unsigned char>(c) < 0x20 ||
				       static_cast<unsigned char>(c) > 0x7E;
			}
		}

		std::string Clean(std::string s, std::size_t cap)
		{
			std::string out;
			out.reserve(s.size());
			for (char c : s) {
				if (Illegal(c))
					continue;
				// Collapse runs of whitespace — mod-added names sometimes carry
				// double spaces, which look like a typo in a filename.
				if (c == ' ' && !out.empty() && out.back() == ' ')
					continue;
				out.push_back(c);
			}
			while (!out.empty() && out.back() == ' ')
				out.pop_back();
			if (out.size() > cap)
				out.resize(cap);
			return out;
		}

		// Where the player is, in the words the game would use: the LOCATION if
		// it has a name (Whiterun, Bleak Falls Barrow), else the cell, else
		// nothing. Never guesses — an unnamed place simply drops out of the
		// name rather than becoming "None".
		std::string PlaceName(RE::PlayerCharacter* player)
		{
			if (!player)
				return "";
			if (auto* loc = player->GetCurrentLocation()) {
				if (const char* n = loc->GetFullName(); n && *n)
					return Clean(n, 48);
			}
			if (auto* cell = player->GetParentCell()) {
				// GetFullName(), not GetName(): TESObjectCELL inherits
				// TESFullName and has no GetName at all.
				if (const char* n = cell->GetFullName(); n && *n)
					return Clean(n, 48);
			}
			return "";
		}

		std::string Stamp()
		{
			const auto t = std::time(nullptr);
			std::tm    tm{};
#ifdef _WIN32
			localtime_s(&tm, &t);
#else
			localtime_r(&t, &tm);
#endif
			char buf[32]{};
			// Dots, not colons: a colon is illegal in a Windows filename, and
			// this is the same shape vanilla uses for its play-time field.
			std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d.%02d.%02d",
				tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
				tm.tm_hour, tm.tm_min, tm.tm_sec);
			return buf;
		}
	}

	bool IsAction(const std::string& action)
	{
		return action == "full-save";
	}

	std::string BuildSaveName()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();

		std::string who;
		if (player) {
			if (const char* n = player->GetDisplayFullName(); n && *n)
				who = Clean(n, 40);
		}

		std::string name = "Save " + Stamp();
		if (!who.empty())
			name += " - " + who;
		const auto place = PlaceName(player);
		if (!place.empty())
			name += " - " + place;
		return name;
	}

	void Fire()
	{
		if (!RE::PlayerCharacter::GetSingleton()) {
			RE::DebugNotification("No game to save");
			return;
		}

		// Let the world render without the deck over it before the engine grabs
		// the save thumbnail. See the header for why this is not optional.
		std::thread([]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(350));
			auto* task = SKSE::GetTaskInterface();
			if (!task)
				return;
			task->AddTask([]() {
				auto* mgr = RE::BGSSaveLoadManager::GetSingleton();
				if (!mgr) {
					logger::warn("full-save: no BGSSaveLoadManager");
					RE::DebugNotification("Could not save");
					return;
				}
				const auto name = BuildSaveName();
				logger::info("full-save: saving as \"{}\"", name);
				mgr->Save(name.c_str());
				// The engine prints its own "Saving..." toast; ours would only
				// be a second one saying the same thing a moment earlier.
			});
		}).detach();
	}
}
