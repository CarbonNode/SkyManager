#include "cast_anim.h"

#include <atomic>
#include <filesystem>
#include <mutex>
#include <string_view>

// pch (force-included) provides RE::/SKSE::, logger:: and nlohmann json.
#undef GetObject
#undef min
#undef max

namespace CastAnim
{
	namespace
	{
		using namespace std::literals;

		constexpr const char*   kPlugin    = "SpellHotbar.esp";
		constexpr std::uint32_t kAnimType  = 0x815;   // SpellHotbar_SpellAnimationType
		constexpr std::uint32_t kConcFlag  = 0x834;   // SpellHotbar_isCastingConcSpell
		constexpr std::uint32_t kSource    = 0x835;   // SpellHotbar_CastingSource
		constexpr std::uint32_t kTimer     = 0x838;   // SpellHotbar_Casttimer
		// One clip folder is proof enough that the OAR submods are installed.
		constexpr const char* kOarProbe =
			"Data/meshes/actors/character/OpenAnimationReplacer/SpellHotbar2/cast_1h_right/config.json";

		// Spell Hotbar 2's animation ids (spell_cast_data.cpp): the OAR
		// conditions compare the global against exactly these.
		constexpr std::uint16_t kAimed = 1, kSelf = 2, kAimedConc = 1001, kSelfConc = 1002, kWard = 1003;
		constexpr std::uint16_t kRitual = 10000, kRitualConc = 11001;
		constexpr std::uint16_t kDualAimed = 10016, kDualSelf = 10017, kDualAimedConc = 11003, kDualSelfConc = 11004;

		constexpr float kLoopEvery  = 0.5f;    // a channel re-sends ShoutStart this often (SH2's loop_timer)
		constexpr float kStartGrace = 0.35f;   // how long to wait for IsShouting before giving up on the clip
		constexpr float kResetAfter = 1.0f;    // leave the release clip alone before the globals go back to 0

		std::mutex        g_mutex;
		Status            g_status;
		std::atomic<bool> g_probed{ false };
		std::atomic<bool> g_enabled{ true };
		std::atomic<bool> g_busy{ false };

		RE::TESGlobal* g_animType = nullptr;
		RE::TESGlobal* g_conc     = nullptr;
		RE::TESGlobal* g_source   = nullptr;
		RE::TESGlobal* g_timer    = nullptr;

		struct Live
		{
			bool          on = false;
			bool          conc = false;
			bool          channeling = false;
			bool          seenShout = false;   // IsShouting went true at least once
			bool          gaveUp = false;
			float         age = 0.0f;
			float         sinceLoop = 0.0f;
			std::uint16_t anim = 0;
			std::string   name;
		};
		Live  g_live;
		float g_resetIn = -1.0f;   // > 0: a reset of the globals is pending

		RE::PlayerCharacter* Player() { return RE::PlayerCharacter::GetSingleton(); }

		void SyncBusy() { g_busy = g_live.on || g_resetIn > 0.0f; }

		bool IsWard(const RE::SpellItem* sp)
		{
			// SH2's is_ward_spell: the first effect carries the MagicWard keyword.
			if (!sp || sp->effects.empty() || !sp->effects[0] || !sp->effects[0]->baseEffect)
				return false;
			return sp->effects[0]->baseEffect->HasKeywordString("MagicWard");
		}

		std::uint16_t AnimFor(RE::MagicItem* item, bool dual, bool conc)
		{
			auto* sp = item ? item->As<RE::SpellItem>() : nullptr;
			if (!sp)
				return 0;
			const bool self = sp->GetDelivery() == RE::MagicSystem::Delivery::kSelf;
			const bool two  = sp->IsTwoHanded();
			if (conc) {
				if (two)
					return dual ? kDualAimedConc : kRitualConc;
				if (IsWard(sp))
					return kWard;
				return self ? (dual ? kDualSelfConc : kSelfConc) : (dual ? kDualAimedConc : kAimedConc);
			}
			if (two)
				return dual ? (self ? kDualSelf : kDualAimed) : kRitual;
			return self ? (dual ? kDualSelf : kSelf) : (dual ? kDualAimed : kAimed);
		}

		void SetGlobals(std::uint16_t anim, int source, bool conc)
		{
			if (g_animType) g_animType->value = static_cast<float>(anim);
			if (g_source)   g_source->value = static_cast<float>(source);
			if (g_conc)     g_conc->value = conc ? 1.0f : 0.0f;
			if (g_timer)    g_timer->value = 0.0f;
		}

		void ResetGlobals()
		{
			if (g_animType) g_animType->value = 0.0f;
			if (g_source)   g_source->value = 0.0f;
			if (g_conc)     g_conc->value = 0.0f;
			if (g_timer)    g_timer->value = 0.0f;
		}

		void Send(std::string_view ev)
		{
			if (auto* p = Player())
				p->NotifyAnimationGraph(RE::BSFixedString(ev));
		}

		bool Ready()
		{
			std::lock_guard l(g_mutex);
			return g_status.available;
		}
	}

	void Probe()
	{
		Status st;
		st.source = "Spell Hotbar 2";
		auto* dh = RE::TESDataHandler::GetSingleton();
		g_animType = g_conc = g_source = g_timer = nullptr;
		if (!dh || !dh->LookupLoadedModByName(kPlugin)) {
			st.why = "Spell Hotbar 2 is not installed (SpellHotbar.esp not loaded)";
		} else {
			g_animType = dh->LookupForm<RE::TESGlobal>(kAnimType, kPlugin);
			g_conc     = dh->LookupForm<RE::TESGlobal>(kConcFlag, kPlugin);
			g_source   = dh->LookupForm<RE::TESGlobal>(kSource, kPlugin);
			g_timer    = dh->LookupForm<RE::TESGlobal>(kTimer, kPlugin);
			if (!g_animType || !g_source || !g_conc) {
				st.why = "SpellHotbar.esp is loaded but its animation globals are missing (a different version?)";
			} else if (!GetModuleHandleA("OpenAnimationReplacer.dll")) {
				st.why = "Open Animation Replacer is not loaded";
			} else {
				std::error_code ec;
				if (!std::filesystem::exists(kOarProbe, ec))
					st.why = "Spell Hotbar 2's casting clips are not installed (its OpenAnimationReplacer folder is missing)";
				else
					st.available = true;
			}
		}
		{
			std::lock_guard l(g_mutex);
			g_status = st;
		}
		g_probed = true;
		// Build marker (hd-markers.json: "cast-anim-probe").
		logger::info("cast-anim: {} ({})", st.available ? "available" : "unavailable",
			st.available ? st.source : st.why);
	}

	bool Probed() { return g_probed.load(); }

	Status GetStatus()
	{
		std::lock_guard l(g_mutex);
		return g_status;
	}

	std::string StatusJson()
	{
		const Status st = GetStatus();
		return nlohmann::json{ { "available", st.available }, { "source", st.source }, { "why", st.why },
			{ "probed", g_probed.load() } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void SetEnabled(bool on) { g_enabled = on; }
	bool Enabled() { return g_enabled.load(); }

	bool Begin(RE::MagicItem* item, bool left, bool dual, bool conc)
	{
		if (!g_enabled.load() || !Ready() || !item || !Player())
			return false;
		if (g_live.on)
			End(true);
		const std::uint16_t anim = AnimFor(item, dual, conc);
		if (!anim)
			return false;
		// CastingSource as SH2 stores it: left 0, right 1; a dual cast counts
		// as the left hand (its own rule), and the dual clips ignore it anyway.
		const int source = (left || dual) ? 0 : 1;
		g_live = Live{};
		g_live.on = true;
		g_live.conc = conc;
		g_live.anim = anim;
		g_live.name = item->GetName() ? item->GetName() : "";
		g_resetIn = -1.0f;
		SetGlobals(anim, source, false);   // a channel starts on its _start clip (conc flag 0)
		Send("ShoutStart"sv);
		SyncBusy();
		// Build marker (hd-markers.json: "cast-anim-start").
		logger::info("cast-anim: start '{}' anim {} source {}{}", g_live.name, anim, source, conc ? " (channel)" : "");
		return true;
	}

	void Tick(float dt)
	{
		if (g_resetIn > 0.0f && !g_live.on) {
			g_resetIn -= dt;
			if (g_resetIn <= 0.0f) {
				g_resetIn = -1.0f;
				ResetGlobals();
			}
			SyncBusy();
			return;
		}
		if (!g_live.on)
			return;
		g_live.age += dt;
		if (g_timer)
			g_timer->value += dt;
		if (!g_live.seenShout && !g_live.gaveUp) {
			if (Playing()) {
				g_live.seenShout = true;
			} else if (g_live.age > kStartGrace) {
				g_live.gaveUp = true;
				logger::info("cast-anim: '{}' never entered the shout state after {:.2f}s — casting without a clip", g_live.name, g_live.age);
			}
		}
		if (g_live.channeling) {
			g_live.sinceLoop += dt;
			if (g_live.sinceLoop >= kLoopEvery) {
				g_live.sinceLoop = 0.0f;
				Send("ShoutStart"sv);   // re-loop the channel clip, as SH2 does
			}
		}
	}

	void Release()
	{
		if (!g_live.on)
			return;
		if (g_live.conc) {
			// SH2: flip to the loop clip (conc flag 1), then exhale + restart so
			// the graph leaves the _start clip now rather than at its end.
			if (g_conc) g_conc->value = 1.0f;
			Send("MT_BreathExhaleShort"sv);
			Send("ShoutStart"sv);
			g_live.channeling = true;
			g_live.sinceLoop = 0.0f;
			return;
		}
		Send("MT_BreathExhaleShort"sv);
	}

	void End(bool cancelled)
	{
		if (!g_live.on) {
			SyncBusy();
			return;
		}
		if (cancelled || g_live.channeling)
			Send("ShoutStop"sv);
		logger::info("cast-anim: end '{}' ({})", g_live.name, cancelled ? "cancelled" : g_live.channeling ? "channel stopped" : "released");
		g_live = Live{};
		if (cancelled) {
			ResetGlobals();
			g_resetIn = -1.0f;
		} else {
			g_resetIn = kResetAfter;
		}
		SyncBusy();
	}

	bool Playing()
	{
		auto* p = Player();
		bool   shouting = false;
		if (p && p->GetGraphVariableBool("IsShouting"sv, shouting))
			return shouting;
		return false;
	}

	bool Busy() { return g_busy.load(); }
}
