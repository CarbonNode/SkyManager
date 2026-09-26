#include "time_actions.h"
#include "time_math.h"

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
		if (!std::isfinite(hours) || !(hours > 0.0f) || hours > TimeMath::maxHours) {
			err = "Choose a wait between one minute and one year.";
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
        if (!std::isfinite(before) || before < 0) {
            err = "The game clock is unavailable.";
            return false;
        }
        if (before >= 24) {
            err = "The previous wait is still settling. Returning to the game.";
            return false;
        }
		cal->gameHour->value = before + hours;

		logger::info("time-calendar-waits: accepted; resume the game to settle the calendar");
		logger::info("time: jumped {} game hour(s) (GameHour {:.2f} -> {:.2f})",
			hours, before, cal->gameHour->value);
		return true;
	}

    bool NeedsResume() {
        auto* cal = RE::Calendar::GetSingleton();
        return cal && cal->gameHour && cal->gameHour->value >= 24;
    }

    bool Request(const std::string& payload, float& hours, std::string& err) {
        auto request = nlohmann::json::parse(payload, nullptr, false);
        if (request.is_number()) {
            hours = request.get<float>();
        } else if (request.is_object()) {
            if (request.contains("resume") && request["resume"] == true) {
                err = NeedsResume() ? "Resuming the previous wait." : "The previous wait has finished. Reopen Time to refresh.";
                return false; // A resume request may never add time, even if its snapshot is stale.
            }
            auto* cal = RE::Calendar::GetSingleton();
            if (!cal || !cal->gameHour || !cal->gameDay || !cal->gameMonth || !cal->gameYear) {
                err = "The clock is unreachable.";
                return false;
            }
            TimeMath::Date d{cal->gameHour->value, static_cast<int>(cal->gameDay->value),
                static_cast<int>(cal->GetMonth()), static_cast<int>(cal->gameYear->value)};
            if (!TimeMath::Valid(d)) { err = "The game calendar is unavailable."; return false; }
            if (request.contains("until") && request["until"].is_number()) {
                double target = request["until"].get<double>();
                if (!std::isfinite(target) || target < 0 || target >= 24) { err = "Choose a time of day."; return false; }
                hours = static_cast<float>(TimeMath::Until(d.hour, target));
            } else {
                if (!request.contains("amount") || !request["amount"].is_number_integer() ||
                    !request.contains("unit") || !request["unit"].is_string()) {
                    err = "Choose a whole number and a time unit."; return false;
                }
                double amount = request["amount"].get<double>();
                auto unit = request["unit"].get<std::string>();
                int limit = unit == "hours" ? 168 : unit == "days" ? 365 : unit == "weeks" ? 52 : unit == "months" ? 12 : 0;
                if (amount < 1 || amount > limit) { err = "That duration is outside the allowed range."; return false; }
                hours = static_cast<float>(unit == "months" ? TimeMath::Months(d, static_cast<int>(amount)) :
                    amount * (unit == "weeks" ? 168 : unit == "days" ? 24 : 1));
            }
        } else { err = "Choose a valid duration."; return false; }
        return Jump(hours, err);
    }

	std::string InfoJson()
	{
		auto* cal = RE::Calendar::GetSingleton();
		if (!cal || !cal->gameHour || !cal->gameDay || !cal->gameMonth || !cal->gameYear || !cal->gameDaysPassed)
			return "null";
		char buf[192];
		// Calendar::GetMonth() is zero-based, as are both view month tables.
		std::snprintf(buf, sizeof(buf),
			"{\"hour\":%.4f,\"day\":%d,\"month\":%d,\"year\":%d,\"daysPassed\":%.4f,\"pending\":%s}",
			cal->gameHour->value,
			static_cast<int>(cal->gameDay->value),
			static_cast<int>(cal->GetMonth()),
			static_cast<int>(cal->gameYear->value),
			cal->gameDaysPassed->value, NeedsResume() ? "true" : "false");
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
