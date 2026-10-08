#include "shout_cooldowns.h"

#include <algorithm>
#include <atomic>
#include <unordered_map>

// pch (force-included) provides RE::/SKSE:: and logger::.
// windows.h macro trap (CLAUDE.md): keep std::max / std::min callable.
#undef min
#undef max

namespace ShoutCooldowns
{
	namespace
	{
		struct Cooldown
		{
			float readyAt = 0.0f;   // game time (days) when it can be used again
			float total = 0.0f;     // seconds, for the bar's sweep
		};

		std::atomic<bool>                        g_on{ true };
		std::unordered_map<RE::FormID, Cooldown> g_stored;   // shouts NOT equipped right now
		RE::FormID                               g_equipped = 0;
		bool                                     g_tracking = false;   // g_equipped is known (not right after a load)
		bool                                     g_wasOn = true;
		float                                    g_lastTimer = 0.0f;
		float                                    g_equippedTotal = 0.0f;   // the equipped shout's running cooldown length

		RE::PlayerCharacter* Player() { return RE::PlayerCharacter::GetSingleton(); }

		bool UsesShoutTimer(const RE::TESForm* f)
		{
			if (!f)
				return false;
			if (f->Is(RE::FormType::Shout))
				return true;
			const auto* sp = f->As<RE::SpellItem>();
			return sp && sp->GetSpellType() == RE::MagicSystem::SpellType::kVoicePower;
		}

		float Now()
		{
			auto* cal = RE::Calendar::GetSingleton();
			return cal ? cal->GetCurrentGameTime() : 0.0f;
		}

		// real seconds per game day
		float DaySeconds()
		{
			auto* cal = RE::Calendar::GetSingleton();
			const float ts = cal ? cal->GetTimescale() : 20.0f;
			return 86400.0f / std::max(ts, 0.001f);
		}

		float Remaining(const Cooldown& c) { return std::max(0.0f, (c.readyAt - Now()) * DaySeconds()); }

		RE::HighProcessData* High()
		{
			auto* p = Player();
			auto* proc = p ? p->GetActorRuntimeData().currentProcess : nullptr;
			return proc ? proc->high : nullptr;
		}

		float Timer()
		{
			auto* h = High();
			return h ? h->voiceRecoveryTime : 0.0f;
		}

		void SetTimer(float seconds)
		{
			if (auto* h = High())
				h->voiceRecoveryTime = seconds;
		}

		RE::FormID SelectedShout()
		{
			auto* p = Player();
			auto* power = p ? p->GetActorRuntimeData().selectedPower : nullptr;
			return UsesShoutTimer(power) ? power->GetFormID() : 0;
		}

		void Store(RE::FormID shout, float seconds, float total)
		{
			if (shout && seconds > 0.0f)
				g_stored[shout] = Cooldown{ Now() + seconds / DaySeconds(), std::max(total, seconds) };
			else
				g_stored.erase(shout);
		}

		void Restore(RE::FormID shout)
		{
			float remaining = 0.0f;
			g_equippedTotal = 0.0f;
			if (auto it = g_stored.find(shout); it != g_stored.end()) {
				remaining = Remaining(it->second);
				g_equippedTotal = it->second.total;
				g_stored.erase(it);
			}
			SetTimer(remaining);
			g_lastTimer = remaining;
		}

		const char* NameOf(RE::FormID id)
		{
			auto* f = id ? RE::TESForm::LookupByID(id) : nullptr;
			const char* n = f ? f->GetName() : nullptr;
			return n && *n ? n : "nothing";
		}
	}

	void SetEnabled(bool on) { g_on = on; }
	bool Enabled() { return g_on.load(); }

	void Update()
	{
		if (!Player() || !High())
			return;
		const bool on = g_on.load();
		const float timer = Timer();
		const RE::FormID selected = SelectedShout();

		if (on != g_wasOn) {
			g_wasOn = on;
			if (!on)
				g_stored.clear();   // back to one timer: it keeps the equipped shout's time
			g_tracking = false;
		}

		// a shout went off: the timer jumped up, and that is its whole length
		if (timer > g_lastTimer + 0.05f)
			g_equippedTotal = timer;

		if (on && g_tracking && selected != g_equipped) {
			Store(g_equipped, timer, g_equippedTotal);
			Restore(selected);
			// Build marker (hd-markers.json: "shout-cooldowns-swap").
			logger::info("shout-cooldowns: '{}' -> '{}', {:.1f}s left on the new one ({} stored)",
				NameOf(g_equipped), NameOf(selected), Timer(), g_stored.size());
		} else {
			g_lastTimer = timer;
		}
		g_equipped = selected;
		g_tracking = true;

		std::erase_if(g_stored, [](const auto& e) { return Remaining(e.second) <= 0.0f; });
	}

	std::pair<float, float> Get(RE::TESForm* form)
	{
		if (!UsesShoutTimer(form))
			return { 0.0f, 0.0f };
		if (!g_on.load() || form->GetFormID() == SelectedShout()) {
			const float t = Timer();
			return { t, std::max({ t, g_equippedTotal, 1.0f }) };
		}
		if (auto it = g_stored.find(form->GetFormID()); it != g_stored.end()) {
			const float rem = Remaining(it->second);
			return { rem, std::max(it->second.total, rem) };
		}
		return { 0.0f, 0.0f };
	}

	void Reset()
	{
		g_tracking = false;
		g_lastTimer = Timer();
		g_equippedTotal = 0.0f;
	}

	void SaveCosave(SKSE::SerializationInterface* s)
	{
		if (!s || g_stored.empty())
			return;
		if (!s->OpenRecord(kRecord, kRecordVersion)) {
			logger::warn("shout-cooldowns: cosave OpenRecord failed");
			return;
		}
		const auto count = static_cast<std::uint32_t>(g_stored.size());
		s->WriteRecordData(&count, sizeof(count));
		for (const auto& [id, c] : g_stored) {
			s->WriteRecordData(&id, sizeof(id));
			s->WriteRecordData(&c.readyAt, sizeof(c.readyAt));
			s->WriteRecordData(&c.total, sizeof(c.total));
		}
	}

	bool LoadCosave(SKSE::SerializationInterface* s, std::uint32_t type, std::uint32_t version, std::uint32_t)
	{
		if (type != kRecord)
			return false;
		g_stored.clear();
		if (version != kRecordVersion)
			return true;
		std::uint32_t count = 0;
		if (s->ReadRecordData(&count, sizeof(count)) != sizeof(count))
			return true;
		for (std::uint32_t i = 0; i < count; ++i) {
			RE::FormID id = 0;
			Cooldown   c;
			if (s->ReadRecordData(&id, sizeof(id)) != sizeof(id) ||
				s->ReadRecordData(&c.readyAt, sizeof(c.readyAt)) != sizeof(c.readyAt) ||
				s->ReadRecordData(&c.total, sizeof(c.total)) != sizeof(c.total))
				break;
			if (RE::FormID resolved = 0; s->ResolveFormID(id, resolved))
				g_stored[resolved] = c;
		}
		logger::info("shout-cooldowns: loaded {} stored cooldown(s)", g_stored.size());
		return true;
	}

	void RevertCosave()
	{
		g_stored.clear();
		g_tracking = false;
		g_equippedTotal = 0.0f;
	}
}
