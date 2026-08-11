#include "time_actions.h"

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

namespace TimeActions
{
	namespace
	{
		int HoursOf(const std::string& a)
		{
			if (a == "wait-1") return 1;
			if (a == "wait-6") return 6;
			if (a == "wait-12") return 12;
			if (a == "wait-24") return 24;
			return 0;
		}
	}

	bool IsAction(const std::string& a)
	{
		return HoursOf(a) > 0;
	}

	bool Jump(float hours, std::string& err)
	{
		if (!(hours > 0.0f) || hours > 168.0f) {
			err = "That wait makes no sense.";
			return false;
		}

		// Mirror the vanilla wait's own refusals — jumping the clock mid-combat
		// would "work" but leaves the world catching up around a fight in ways
		// nothing playtests.
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (player && player->IsInCombat()) {
			err = "You can't wait while in combat.";
			return false;
		}

		auto* cal = RE::Calendar::GetSingleton();
		if (!cal || !cal->gameHour) {
			logger::error("time: Calendar/GameHour unavailable — no jump");
			err = "The clock is unreachable.";
			return false;
		}

		// One-step jump, Super Fast Wait Menu's proven mechanism (Papyrus
		// GameHour.Mod): add to the GameHour global and let the ENGINE wrap
		// hour->day/date and advance GameDaysPassed — game-time-registered
		// mod updates then catch up in a single hitch instead of ticking
		// hour-by-hour at (frame-generation-throttled) frame rate.
		const float before = cal->gameHour->value;
		cal->gameHour->value = before + hours;

		logger::info("time: jumped {} game hour(s) (GameHour {:.2f} -> {:.2f})",
			hours, before, cal->gameHour->value);
		return true;
	}

	std::string InfoJson()
	{
		auto* cal = RE::Calendar::GetSingleton();
		if (!cal || !cal->gameHour || !cal->gameDay || !cal->gameMonth || !cal->gameYear || !cal->gameDaysPassed)
			return "null";
		char buf[160];
		// The engine's month global is 1-based (Morning Star = 1); the pane's
		// month table is 0-based, so shift here where the convention is known.
		std::snprintf(buf, sizeof(buf),
			"{\"hour\":%.4f,\"day\":%d,\"month\":%d,\"year\":%d,\"daysPassed\":%.4f}",
			cal->gameHour->value,
			static_cast<int>(cal->gameDay->value),
			static_cast<int>(cal->gameMonth->value) - 1,
			static_cast<int>(cal->gameYear->value),
			cal->gameDaysPassed->value);
		return buf;
	}

	void Fire(const std::string& a)
	{
		const int hours = HoursOf(a);
		if (hours <= 0)
			return;
		std::string err;
		if (!Jump(static_cast<float>(hours), err)) {
			if (!err.empty())
				RE::DebugNotification(err.c_str());
			return;
		}
		char msg[64];
		std::snprintf(msg, sizeof(msg), "\xE2\x8F\xA9 Waited %d hour%s", hours, hours == 1 ? "" : "s");
		RE::DebugNotification(msg);
	}
}
