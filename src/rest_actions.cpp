#include "rest_actions.h"
#include "time_actions.h"
#include "widgets.h"

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

namespace RestActions
{
	namespace
	{
		using json = nlohmann::json;

		// One SunHelm need system: its quest and the script bound to it.
		struct System
		{
			const char* quest;
			const char* script;
		};
		constexpr System kHunger{ "_SHHungerQuest", "_SHHungerSystem" };
		constexpr System kThirst{ "_SHThirstQuest", "_SHThirstSystem" };
		constexpr System kFatigue{ "_SHFatigueQuest", "_SHFatigueSystem" };

		// Large enough to empty any need: SunHelm clamps the level to 0 itself.
		constexpr float kFill = 100000.0f;

		// One rest at a time. Cleared when the chain ends, however it ends.
		std::atomic<bool> g_busy{ false };

		RE::TESGlobal* Global(const char* edid)
		{
			return RE::TESForm::LookupByEditorID<RE::TESGlobal>(edid);
		}

		float GlobalValue(const char* edid, float fallback)
		{
			auto* g = Global(edid);
			return g ? g->value : fallback;
		}

		bool SunHelmOn()
		{
			auto* g = Global("_SHEnabled");
			return g && g->value != 0.0f;
		}

		bool NeedOff(const char* disabledEdid)
		{
			auto* g = Global(disabledEdid);
			return g && g->value != 0.0f;
		}

		// The handle of the quest IF SunHelm's script is bound to it right now
		// (no save loaded, the mod absent or stopped all read as unbound).
		RE::VMHandle BoundHandle(const System& sys)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* quest = RE::TESForm::LookupByEditorID<RE::TESQuest>(sys.quest);
			if (!vm || !quest)
				return 0;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return 0;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return 0;
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			if (!vm->FindBoundObject(handle, sys.script, obj) || !obj)
				return 0;
			return handle;
		}

		bool Bound(const System& sys) { return BoundHandle(sys) != 0; }

		// Runs `then` on the main thread once the Papyrus call has returned.
		class Then final : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit Then(std::function<void()> fn) : then_(std::move(fn)) {}
			void operator()(RE::BSScript::Variable) override
			{
				if (then_)
					SKSE::GetTaskInterface()->AddTask(then_);
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void()> then_;
		};

		// Call one of SunHelm's functions on its own quest script. Calls on one
		// script object run one at a time, in the order they are dispatched.
		template <class... Args>
		bool Call(const System& sys, const char* fn, std::function<void()> then, Args... args)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			const auto handle = BoundHandle(sys);
			if (!vm || !handle)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			if (then)
				cb.reset(new Then(std::move(then)));
			auto fargs = RE::MakeFunctionArguments(std::move(args)...);
			const bool ok = vm->DispatchMethodCall(handle, sys.script, fn, fargs, cb);
			if (!ok)
				logger::warn("rest: {}.{} was not dispatched", sys.script, fn);
			return ok;
		}

		// Sleep restore per hour exactly as SunHelm applies it after a bed:
		// _SHFatigueSleepRestoreAmount, plus the Slumber perk's 10 / 15 %.
		float RestorePerHour()
		{
			const float base = GlobalValue("_SHFatigueSleepRestoreAmount", 0.0f);
			const float rank = GlobalValue("_SH_PerkRank_Slumber", 0.0f);
			const float perk = rank == 1.0f ? 0.10f : rank == 2.0f ? 0.15f : 0.0f;
			return base * (1.0f + perk);
		}

		int HoursToRested()
		{
			const float level = GlobalValue("_SHCurrentFatigueLevel", -1.0f);
			const float per = RestorePerHour();
			if (level < 0.0f || per <= 0.0f)
				return -1;   // unknown: the view offers no "until rested" chip
			if (level <= 0.0f)
				return 0;
			return std::clamp(static_cast<int>(std::ceil(level / per)), 1, 24);
		}

		json HomeJson()
		{
			json out{ { "inHome", false } };
			auto* pc = RE::PlayerCharacter::GetSingleton();
			if (!pc)
				return out;
			auto* loc = pc->GetCurrentLocation();
			if (loc) {
				out["inHome"] = loc->HasKeywordString("LocTypePlayerHouse");
				if (const char* n = loc->GetName(); n && *n)
					out["place"] = n;
			}
			if (!out.contains("place")) {
				if (auto* cell = pc->GetParentCell()) {
					if (const char* n = cell->GetName(); n && *n)
						out["place"] = n;
				}
			}
			return out;
		}

		// Run `fn` on the main thread after `delay`, without holding any thread
		// the game needs.
		void After(std::chrono::milliseconds delay, std::function<void()> fn)
		{
			std::thread([delay, fn = std::move(fn)]() {
				std::this_thread::sleep_for(delay);
				SKSE::GetTaskInterface()->AddTask(fn);
			}).detach();
		}

		// The jump is only an accepted GameHour until the game runs a frame:
		// wait for an unpaused, settled clock (two minutes at most — a menu the
		// player opened in between keeps it paused), then give SunHelm's own
		// game-time update a moment to land first.
		void WhenSettled(int triesLeft, std::function<void(bool)> fn)
		{
			After(250ms, [triesLeft, fn = std::move(fn)]() mutable {
				auto* ui = RE::UI::GetSingleton();
				const bool paused = !ui || ui->GameIsPaused();
				if (!TimeActions::NeedsResume() && !paused) {
					After(1500ms, [fn]() { fn(true); });
				} else if (triesLeft <= 0) {
					fn(false);
				} else {
					WhenSettled(triesLeft - 1, std::move(fn));
				}
			});
		}

		void RestorePools()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			auto* avo = pc ? pc->AsActorValueOwner() : nullptr;
			if (!avo)
				return;
			for (auto av : { RE::ActorValue::kHealth, RE::ActorValue::kMagicka, RE::ActorValue::kStamina })
				avo->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage, av, kFill);
		}

		std::string Summary(const Plan& p, bool slept)
		{
			std::vector<std::string> parts;
			if (p.eat)
				parts.emplace_back("ate your fill");
			if (p.drink)
				parts.emplace_back("drank your fill");
			if (p.sleep && slept)
				parts.emplace_back("slept " + std::to_string(p.hours) + (p.hours == 1 ? " hour" : " hours"));
			if (parts.empty())
				return {};
			std::string s = "You " + parts[0];
			for (std::size_t i = 1; i < parts.size(); ++i)
				s += (i + 1 == parts.size() ? " and " : ", ") + parts[i];
			return s + ".";
		}

		// Eat / drink through SunHelm, after the sleep if there was one, so you
		// rise to breakfast instead of waking up hungry from a supper.
		void Finish(const Plan& p, bool slept, bool sunhelmSlept)
		{
			if (p.sleep && slept) {
				RestorePools();
				if (sunhelmSlept) {
					const float amount = static_cast<float>(p.hours) * GlobalValue("_SHFatigueSleepRestoreAmount", 0.0f);
					// DecreaseFatigueLevel adds the Slumber perk itself.
					Call(kFatigue, "DecreaseFatigueLevel", nullptr, amount);
				}
			}
			if (p.eat) {
				Call(kHunger, "SetTimeStamps", nullptr);
				Call(kHunger, "DecreaseHungerLevel", nullptr, kFill);
			}
			if (p.drink) {
				Call(kThirst, "SetTimeStamps", nullptr);
				Call(kThirst, "DecreaseThirstLevel", nullptr, kFill);
			}
			const std::string msg = Summary(p, slept);
			if (!msg.empty())
				RE::DebugNotification(msg.c_str());
			// Build marker (hd-markers.json: "rest-at-home: done").
			logger::info("rest-at-home: done (eat {}, drink {}, slept {} h, SunHelm sleep {})",
				p.eat, p.drink, slept ? p.hours : 0, sunhelmSlept);
			g_busy = false;
		}

		void JumpThenFinish(const Plan& p, bool sunhelmSlept)
		{
			std::string err;
			if (!TimeActions::Jump(static_cast<float>(p.hours), err)) {
				// SunHelm was told you lay down; nothing passed, so it restores
				// nothing, and the meal is not served without the night.
				RE::DebugNotification(err.empty() ? "You could not sleep here." : err.c_str());
				logger::warn("rest-at-home: the clock refused the jump ({})", err);
				g_busy = false;
				return;
			}
			WhenSettled(480, [p, sunhelmSlept](bool settled) {
				if (!settled) {
					RE::DebugNotification("The night never settled - SunHelm was not told you slept.");
					logger::warn("rest-at-home: clock still unsettled after 2 min; needs untouched");
					g_busy = false;
					return;
				}
				Finish(p, true, sunhelmSlept);
			});
		}
	}

	std::string StateJson()
	{
		json out{
			{ "on", SunHelmOn() },
			{ "bound", { { "hunger", Bound(kHunger) }, { "thirst", Bound(kThirst) }, { "fatigue", Bound(kFatigue) } } },
			{ "sleep", { { "restorePerHour", RestorePerHour() }, { "hoursToRested", HoursToRested() } } },
			{ "home", HomeJson() },
			{ "busy", g_busy.load() },
		};
		const auto needs = json::parse(Widgets::SunHelmNeedsJson(), nullptr, false);
		out["sunhelm"] = needs.is_discarded() ? json(nullptr) : needs;
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	bool Check(const std::string& req, Plan& plan, std::string& err)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			err = "Choose what to do first.";
			return false;
		}
		plan.eat = j.value("eat", false);
		plan.drink = j.value("drink", false);
		plan.sleep = j.value("sleep", false);
		plan.hours = plan.sleep ? j.value("hours", 0) : 0;
		if (!plan.eat && !plan.drink && !plan.sleep) {
			err = "Choose at least one: eat, drink or sleep.";
			return false;
		}
		if (plan.sleep && (plan.hours < 1 || plan.hours > 24)) {
			err = "Sleep between 1 and 24 hours.";
			return false;
		}
		if (g_busy.load()) {
			err = "You are still resting.";
			return false;
		}
		auto* pc = RE::PlayerCharacter::GetSingleton();
		if (pc && pc->IsInCombat()) {
			err = "You can't rest while in combat.";
			return false;
		}
		if (plan.sleep && TimeActions::NeedsResume()) {
			err = "The previous wait is still settling. Return to the game first.";
			return false;
		}
		if (plan.eat || plan.drink) {
			if (!Global("_SHEnabled")) {
				err = "Eating and drinking here need SunHelm Survival.";
				return false;
			}
			if (!SunHelmOn()) {
				err = "SunHelm is switched off in its MCM.";
				return false;
			}
			if (plan.eat && NeedOff("_SHHungerShouldBeDisabled")) {
				err = "Hunger is switched off in SunHelm's MCM.";
				return false;
			}
			if (plan.drink && NeedOff("_SHThirstShouldBeDisabled")) {
				err = "Thirst is switched off in SunHelm's MCM.";
				return false;
			}
			if ((plan.eat && !Bound(kHunger)) || (plan.drink && !Bound(kThirst))) {
				err = "SunHelm's needs are not running in this save.";
				return false;
			}
		}
		return true;
	}

	void Run(const Plan& plan)
	{
		g_busy = true;
		// Build marker (hd-markers.json: "rest-at-home: start").
		logger::info("rest-at-home: start (eat {}, drink {}, sleep {} h)", plan.eat, plan.drink, plan.sleep ? plan.hours : 0);

		if (!plan.sleep) {
			Finish(plan, false, false);
			return;
		}

		// SunHelm tracks the sleep only when its fatigue system is live and on;
		// otherwise the night is still a night, just one SunHelm does not see.
		const bool tellSunHelm = SunHelmOn() && !NeedOff("_SHFatigueShouldBeDisabled") && Bound(kFatigue);
		if (tellSunHelm) {
			auto* cal = RE::Calendar::GetSingleton();
			const float now = cal && cal->gameDaysPassed ? cal->gameDaysPassed->value : 0.0f;
			const Plan p = plan;
			if (Call(kFatigue, "DetectSleepStart", [p]() { JumpThenFinish(p, true); }, now))
				return;
		}
		JumpThenFinish(plan, false);
	}
}
