#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace CellTravelHandoff
{
	// Shared by ALL deck travel, including Cell Finder and NPC Finder.
	// Main-thread observations, with time supplied by the caller so the actual
	// close/timeout policy can be exercised without Skyrim or a renderer.
	enum class Result { Wait, Ready, Cancelled, TimedOut };

	class Gate
	{
	public:
		static constexpr std::uint64_t SettleMs = 2000;
		static constexpr std::uint64_t TimeoutMs = 10000;

		explicit Gate(std::uint64_t startedAt) : startedAt_(startedAt) {}

		Result Poll(std::uint64_t now, bool sameContext, bool released)
		{
			if (finished_)
				return Result::Cancelled;  // A request can authorize travel only once.
			if (!sameContext) {
				finished_ = true;
				return Result::Cancelled;
			}
			if (now - startedAt_ >= TimeoutMs) {
				finished_ = true;
				return Result::TimedOut;
			}
			if (!released) {
				clearSince_.reset();
				return Result::Wait;
			}
			if (!clearSince_)
				clearSince_ = now;
			if (now - *clearSince_ < SettleMs)
				return Result::Wait;
			finished_ = true;
			return Result::Ready;
		}

	private:
		std::uint64_t startedAt_;
		std::optional<std::uint64_t> clearSince_;
		bool finished_ = false;
	};

	// Console entries, Omni's console runner, and its Test button must take
	// the same handoff as native travel. Inspect command verbs (not substrings
	// in arguments/comments); Bethesda batches have one command per line.
	inline bool IsTravelCommand(std::string_view commands)
	{
		while (!commands.empty()) {
			const auto end = commands.find('\n');
			auto line = commands.substr(0, end);
			commands = end == std::string_view::npos ? std::string_view{} : commands.substr(end + 1);
			const auto start = line.find_first_not_of(" \t\r");
			if (start == std::string_view::npos || line[start] == ';' || line[start] == '#')
				continue;
			line.remove_prefix(start);
			std::string verb(line.substr(0, line.find_first_of(" \t\r;")));
			for (auto& c : verb)
				if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
			// Ref-qualified MoveTo can move the player (player / numeric id),
			// and delaying NPC moves too is safer than missing a spelling.
			if (const auto dot = verb.rfind('.'); dot != std::string::npos)
				verb.erase(0, dot + 1);
			if (verb == "coc" || verb == "centeroncell" || verb == "cow" ||
				verb == "centeronworld" || verb == "moveto" || verb == "movetoqt" ||
				verb == "movetoquesttarget" || verb == "movetomarker" || verb == "positioncell")
				return true;
		}
		return false;
	}
}
