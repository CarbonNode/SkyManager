#include "ward_actions.h"

#include <atomic>
#include <chrono>
#include <cmath>

// pch (force-included) provides RE::/SKSE:: and logger::.

namespace WardActions
{
	namespace
	{
		// Armed state + the ward being maintained. All main-thread except the
		// atomic, which the ticker reads to decide whether to AddTask a beat.
		std::atomic<bool> g_on{ false };
		RE::SpellItem*    g_ward = nullptr;   // the spell we are maintaining
		double            g_sinceCast = 1e9;  // seconds since our last cast (huge = cast now)
		std::chrono::steady_clock::time_point g_lastTick{};
		bool              g_haveLastTick = false;

		// Upstream WardAnytime's shipped default: solid VFX, no fight with
		// attack/sprint/jump animations.
		constexpr double kRecastSec = 0.6;

		// A ward effect is one that feeds the WardPower actor value — every
		// vanilla ward, Mysticism's, and any modded ward that actually wards.
		// Returns the ward effect's magnitude (its shield strength), or a
		// negative when the spell is no ward at all.
		float WardMagnitude(RE::SpellItem* s)
		{
			if (!s || s->GetSpellType() != RE::MagicSystem::SpellType::kSpell)
				return -1.0f;
			float best = -1.0f;
			for (auto* eff : s->effects) {
				auto* base = eff ? eff->baseEffect : nullptr;
				if (!base || base->data.primaryAV != RE::ActorValue::kWardPower)
					continue;
				const float mag = eff->effectItem.magnitude;
				if (mag > best)
					best = mag;
			}
			return best;
		}

		// Kill OUR ward effect now. Letting it time out leaves a ~2 s ghost
		// shield after the "off" notification — upstream dispels, so do we.
		void DispelWard(RE::Actor* actor, RE::SpellItem* ward)
		{
			auto* mt = actor && ward ? actor->AsMagicTarget() : nullptr;
			auto* list = mt ? mt->GetActiveEffectList() : nullptr;
			if (!list)
				return;
			for (auto* fx : *list) {
				if (fx && fx->spell == ward)
					fx->Dispel(true);
			}
		}

		void CastWard(RE::PlayerCharacter* player, RE::SpellItem* ward)
		{
			auto* caster = player->GetMagicCaster(RE::MagicSystem::CastingSource::kInstant);
			if (caster)
				caster->CastSpellImmediate(ward, false, player, 1.0f, false, 0.0f, player);
		}

		const char* NameOf(RE::SpellItem* s)
		{
			const char* n = s ? s->GetFullName() : nullptr;
			return (n && *n) ? n : "Ward";
		}

		// Lower the ward from inside a main-thread pass. `why` may be null
		// for the silent (load-reset) path.
		void Lower(const char* why)
		{
			g_on = false;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (player && g_ward)
				DispelWard(player, g_ward);
			if (why && *why)
				RE::DebugNotification(why);
			g_ward = nullptr;
			g_haveLastTick = false;
			g_sinceCast = 1e9;
		}
	}

	RE::SpellItem* BestKnownWard(RE::Actor* actor)
	{
		if (!actor)
			return nullptr;
		RE::SpellItem* best = nullptr;
		float          bestMag = -1.0f;
		auto consider = [&](RE::SpellItem* s) {
			const float mag = WardMagnitude(s);
			if (mag > bestMag) {
				bestMag = mag;
				best = s;
			}
		};
		// The same two-source walk KnownSpellsJson uses: spells baked into the
		// actor base plus everything learned at runtime.
		if (auto* base = actor->GetActorBase()) {
			if (auto* data = base->GetSpellList()) {
				if (data->spells) {
					for (std::uint32_t i = 0; i < data->numSpells; ++i)
						consider(data->spells[i]);
				}
			}
		}
		for (auto* s : actor->GetActorRuntimeData().addedSpells)
			consider(s);
		return best;
	}

	bool Enabled()
	{
		return g_on.load();
	}

	void Toggle()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return;
		if (g_on.load()) {
			const std::string msg = std::string(NameOf(g_ward)) + " lowered";
			Lower(msg.c_str());
			logger::info("ward: lowered by toggle");
			return;
		}
		auto* ward = BestKnownWard(player);
		if (!ward) {
			// Honest refusal — an armed drain with nothing to cast would just
			// be a dead key.
			RE::DebugNotification("You know no ward spell");
			logger::info("ward: toggle refused - no ward spell known");
			return;
		}
		g_ward = ward;
		g_sinceCast = 1e9;  // first Tick casts immediately
		g_haveLastTick = false;
		g_on = true;
		RE::DebugNotification((std::string(NameOf(ward)) + " raised").c_str());
		// Build marker (hd-markers.json: "ward-anytime").
		logger::info("ward: raised '{}' (magnitude {})", NameOf(ward), WardMagnitude(ward));
	}

	void Tick()
	{
		if (!g_on.load())
			return;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			Lower(nullptr);
			return;
		}
		if (player->IsDead()) {
			Lower(nullptr);
			return;
		}
		const auto now = std::chrono::steady_clock::now();
		// Paused (any menu, the deck, console): freeze the clock — no drain,
		// no cast, and the elapsed pause never bills as ward time.
		if (auto* ui = RE::UI::GetSingleton(); ui && ui->GameIsPaused()) {
			g_haveLastTick = false;
			return;
		}
		double dt = 0.0;
		if (g_haveLastTick)
			dt = std::chrono::duration<double>(now - g_lastTick).count();
		g_lastTick = now;
		g_haveLastTick = true;
		// A hitch or an un-paused stretch we did not see must not bill a huge
		// magicka slug in one go.
		if (dt < 0.0 || dt > 0.5)
			dt = 0.0;

		// Pick up a better ward the moment it is learned (cheap: two array
		// walks, ~every beat is fine, but once a second is plenty).
		static double s_sinceRescan = 0.0;
		s_sinceRescan += dt;
		if (!g_ward || s_sinceRescan >= 1.0) {
			s_sinceRescan = 0.0;
			auto* best = BestKnownWard(player);
			if (!best) {
				Lower("Ward lowered");
				return;
			}
			if (best != g_ward) {
				DispelWard(player, g_ward);
				g_ward = best;
				g_sinceCast = 1e9;
			}
		}

		auto* avo = player->AsActorValueOwner();
		if (!avo) {
			Lower(nullptr);
			return;
		}
		// The vanilla drain: concentration spells price themselves per second.
		const double costPerSec = static_cast<double>(g_ward->CalculateMagickaCost(player));
		const double cost = costPerSec * dt;
		const double magicka = static_cast<double>(avo->GetActorValue(RE::ActorValue::kMagicka));
		if (magicka < cost || magicka < costPerSec * 0.1) {
			Lower("Ward down - out of magicka");
			logger::info("ward: auto-lowered, out of magicka");
			return;
		}
		if (cost > 0.0)
			avo->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage,
				RE::ActorValue::kMagicka, static_cast<float>(-cost));

		g_sinceCast += dt;
		if (g_sinceCast >= kRecastSec) {
			g_sinceCast = 0.0;
			CastWard(player, g_ward);
		}
	}

	void Reset()
	{
		// Another save's session — no dispel (those effects belong to the
		// incoming save), no notification, just stand down.
		g_on = false;
		g_ward = nullptr;
		g_haveLastTick = false;
		g_sinceCast = 1e9;
	}
}
