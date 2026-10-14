#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace CellTravelHandoff
{
	// Shared by all deck travel that moves the PLAYER (Cell Finder, NPC Finder
	// goto, Places, Domains...). NPC-only moves skip it: main.cpp RunNpcMove.
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

	// Console entries, Omni's console runner, and its Test button take the
	// same handoff as native travel WHEN THE PLAYER MOVES. Inspect command
	// verbs (not substrings in arguments/comments); Bethesda batches have one
	// command per line. An NPC moved to the player (`<npc>.moveto player`, or
	// a bare moveto aimed at the crosshair NPC) loads no cell of the player's
	// and runs at once (Rober, 2026-10-11).
	inline bool IsPlayerRef(std::string_view ref)
	{
		if (ref == "player")
			return true;
		// The player's FormID, 14, in any zero-padded spelling.
		const auto first = ref.find_first_not_of('0');
		return first != std::string_view::npos && ref.substr(first) == "14";
	}

	inline bool IsTravelCommand(std::string_view commands, bool crosshairTarget = false)
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
			std::string ref;
			if (const auto dot = verb.rfind('.'); dot != std::string::npos) {
				ref = verb.substr(0, dot);
				verb.erase(0, dot + 1);
			}
			// These only ever move the player, whatever ref is named.
			if (verb == "coc" || verb == "centeroncell" || verb == "cow" ||
				verb == "centeronworld" || verb == "movetoqt" || verb == "movetoquesttarget")
				return true;
			// These move their reference: the named one, else the console's
			// selection. A bare one with no crosshair NPC behind it could be
			// the player, and delaying an NPC is safer than missing the player.
			if (verb == "moveto" || verb == "movetomarker" || verb == "positioncell") {
				if (ref.empty() ? !crosshairTarget : IsPlayerRef(ref))
					return true;
			}
		}
		return false;
	}
}
