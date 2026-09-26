#include "sic_em_feedback.h"

#include "loot_highlight.h"
#include "sic_em_trajectory.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <thread>

// pch (force-included) provides RE::/SKSE::.

namespace SicEmFeedback
{
	namespace
	{
		constexpr float kAimRange = 8000.0f;  // the longshot ray's reach (npc_actions.cpp)

		// ---- the bolt in flight ------------------------------------------
		// Written on launch (main thread), stamped by the AddImpact thunk
		// (havok reports collisions off the main thread), consumed by the
		// waiter's single-shot main-thread polls — hence the lock.
		std::mutex        g_lock;
		std::uint64_t     g_serial = 0;   // bumps per shot; a stale waiter sees it and quits
		RE::FormID        g_boltId = 0;   // the live bolt, 0 = nothing pending
		RE::ProjectileHandle g_bolt;
		bool              g_hit = false;
		Impact            g_impact{};
		float             g_flightBudget = 0.0f;  // seconds of livingTime before it is a miss
		std::chrono::steady_clock::time_point g_wallDeadline;
		std::function<void(std::optional<Impact>)> g_onDone;
		std::atomic<bool> g_pollInFlight{ false };

		struct AddImpactHook
		{
			static void Thunk(RE::Projectile* self, RE::TESObjectREFR* ref, const RE::NiPoint3& loc,
				const RE::NiPoint3& vel, RE::hkpCollidable* col, std::int32_t a6, std::uint32_t a7)
			{
				g_orig(self, ref, loc, vel, col, a6, a7);
				if (!self)
					return;
				const auto id = self->GetFormID();
				std::lock_guard l(g_lock);
				if (!g_boltId || id != g_boltId || g_hit)
					return;
				g_hit = true;
				g_impact.collidee = ref ? ref->GetFormID() : 0;
				const auto p = self->GetPosition();
				g_impact.x = p.x;
				g_impact.y = p.y;
				g_impact.z = p.z;
			}
			static inline REL::Relocation<decltype(Thunk)> g_orig;
		};
		bool g_hooked = false;

		// Verified from the rig's Skyrim.esm with tools/dump_records.py:
		// Illusion01Projectile [PROJ:0007331D], Magic\IllusionProjectile01.nif,
		// missile, gravity 0, speed 2000 u/s, range 10000. Borrow ONLY its
		// projectile art, never Calm/Courage's spell effects.
		RE::BGSProjectile* SafeBolt()
		{
			auto* data = RE::TESDataHandler::GetSingleton();
			auto* base = data ? data->LookupForm<RE::BGSProjectile>(0x7331D, "Skyrim.esm") : nullptr;
			using Flags = RE::BGSProjectileData::BGSProjectileFlags;
			if (!base || !base->IsMissile() || base->data.explosionType ||
				base->data.flags.any(Flags::kExplosion, Flags::kExplosionAltTrigger, Flags::kHitScan) ||
				base->data.defaultWeaponSource || base->data.gravity != 0.0f ||
				!std::isfinite(base->data.speed) || base->data.speed <= 0.0f)
				return nullptr;
			return base;
		}

		// Where the crosshair ray meets the world (scenery only — the pathing
		// pick layer tests geometry without selecting bodies, same as
		// npc_clearance.cpp). Falls back to the far end of the ray.
		RE::NiPoint3 CrosshairPoint(const RE::NiPoint3& camPos, const RE::NiPoint3& fwd, float& outDist)
		{
			outDist = kAimRange;
			const RE::NiPoint3 farPoint = camPos + fwd * kAimRange;  // not `far`: a windows.h macro
			auto* tes = RE::TES::GetSingleton();
			if (!tes)
				return farPoint;
			RE::bhkPickData pick{};
			const float s = RE::bhkWorld::GetWorldScale();
			pick.rayInput.from = RE::hkVector4(camPos.x * s, camPos.y * s, camPos.z * s, 0.0f);
			pick.rayInput.to   = RE::hkVector4(farPoint.x * s, farPoint.y * s, farPoint.z * s, 0.0f);
			pick.rayInput.filterInfo = static_cast<std::uint32_t>(RE::COL_LAYER::kPathingPick);
			pick.rayInput.enableShapeCollectionFilter = true;
			pick.ray = pick.rayInput.to - pick.rayInput.from;
			pick.rayOutput.Reset();
			tes->Pick(pick);
			if (!pick.rayOutput.HasHit())
				return farPoint;
			const float f = pick.rayOutput.hitFraction;
			if (!std::isfinite(f) || f <= 0.0f || f > 1.0f)
				return farPoint;
			outDist = kAimRange * f;
			return camPos + fwd * outDist;
		}

		// One poll, on the main thread. Finishes the shot when the bolt has
		// landed (hook), vanished, flown its range, or the wall clock gave up.
		void PollOnce(std::uint64_t serial)
		{
			std::function<void(std::optional<Impact>)> done;
			std::optional<Impact> result;
			const char* why = nullptr;
			{
				std::lock_guard l(g_lock);
				if (serial != g_serial || !g_boltId)
					return;
				if (g_hit) {
					result = g_impact;
					why = "landed";
				} else {
					auto ptr = g_bolt.get();
					auto* p = ptr ? ptr.get() : nullptr;
					if (!p || p->IsDeleted())
						why = "gone";
					else if (p->GetProjectileRuntimeData().livingTime > g_flightBudget)
						why = "flew its range";
					else if (std::chrono::steady_clock::now() > g_wallDeadline)
						why = "timed out";
				}
				if (!why)
					return;
				done = std::move(g_onDone);
				g_onDone = nullptr;
				g_boltId = 0;
				g_bolt = {};
			}
			// Build marker (hd-markers.json: "npc-sic-em-bolt-answer").
			logger::info("NpcActions: sic-em bolt answer: {} (collidee {:08X} at {:.0f},{:.0f},{:.0f})",
				why, result ? result->collidee : 0u,
				result ? result->x : 0.0f, result ? result->y : 0.0f, result ? result->z : 0.0f);
			if (done)
				done(result);
		}
	}

	void InstallHooks()
	{
		if (g_hooked)
			return;
		g_hooked = true;
		// MissileProjectile::AddImpact — slot 0xBD (SE/AE; the deck does not
		// target VR). Same write_vfunc idiom as container_sort's redirect hooks.
		REL::Relocation<std::uintptr_t> vt{ RE::MissileProjectile::VTABLE[0] };
		AddImpactHook::g_orig = vt.write_vfunc(0xBD, AddImpactHook::Thunk);
		// Build marker (hd-markers.json: "npc-sic-em-bolt-hook").
		logger::info("NpcActions: sic-em AddImpact hook installed (MissileProjectile vtable slot 0xBD)");
	}

	bool FireAlongAim()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* camera = RE::PlayerCamera::GetSingleton();
		if (!player || !camera || !camera->cameraRoot || !player->Is3DLoaded() || !player->GetParentCell())
			return false;
		auto* base = SafeBolt();
		if (!base) {
			logger::warn("NpcActions: sic-em bolt skipped — projectile art missing or unsafe");
			return false;
		}

		auto&              wt     = camera->cameraRoot->world;
		const RE::NiPoint3 camPos = wt.translate;
		const RE::NiPoint3 fwd    = { -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };
		float              aimDist = 0.0f;
		const RE::NiPoint3 aimAt  = CrosshairPoint(camPos, fwd, aimDist);

		// The bolt leaves the player's head (follows the real body, first or
		// third person) and CONVERGES on the crosshair point — the camera's
		// offset would otherwise put a head-parallel bolt a body-width off a
		// close target.
		const auto head = player->GetLookingAtLocation();
		const auto aim  = Aim({ head.x, head.y, head.z }, { aimAt.x, aimAt.y, aimAt.z });
		if (!aim)
			return false;

		RE::Projectile::LaunchData launch(base, player,
			{ aim->origin.x, aim->origin.y, aim->origin.z }, { aim->pitch, aim->yaw });
		launch.desiredTarget = nullptr;  // never homes — the impact IS the answer
		launch.useOrigin = true;
		launch.autoAim = false;
		launch.noDamageOutsideCombat = true;
		launch.scale = 1.5f;
		// LaunchData(BGSProjectile, ...) initializes spell/weapon/ammo/poison/
		// enchantment to nullptr and area to 0. Keep them empty. power is NOT
		// damage: the engine also uses it for travel speed, so leave it at 1.
		RE::ProjectileHandle handle;
		RE::Projectile::Launch(&handle, launch);
		auto ptr = handle.get();
		auto* projectile = ptr ? ptr.get() : nullptr;
		if (!projectile) {
			logger::warn("NpcActions: sic-em bolt did not launch");
			return false;
		}
		auto& runtime = projectile->GetProjectileRuntimeData();
		runtime.weaponDamage = 0.0f;
		runtime.flags.set(RE::Projectile::Flags::kNotAddThreat);

		const float speed = base->data.speed;
		const float range = base->data.range > 0.0f ? (std::min)(base->data.range, kAimRange) : kAimRange;
		{
			std::lock_guard l(g_lock);
			++g_serial;
			g_boltId = projectile->GetFormID();
			g_bolt   = handle;
			g_hit    = false;
			g_impact = {};
			g_flightBudget = range / speed + 0.5f;
			g_wallDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(12);
			g_onDone = nullptr;  // an earlier waiter is superseded, silently
		}
		// Build marker (hd-markers.json: "npc-sic-em-bolt").
		logger::info("NpcActions: sic-em bolt fired {:08X} speed={:.0f} range={:.0f} crosshair at {:.0f} units",
			projectile->GetFormID(), speed, range, aimDist);
		return true;
	}

	void AwaitImpact(std::function<void(std::optional<Impact>)> onDone)
	{
		std::uint64_t serial = 0;
		bool          pending = false;
		{
			std::lock_guard l(g_lock);
			pending = g_boltId != 0;
			if (pending) {
				serial = g_serial;
				g_onDone = std::move(onDone);
			}
		}
		if (!pending) {
			// Nothing in the air (FireAlongAim refused) — answer at once.
			onDone(std::nullopt);
			return;
		}
		// Poller: a thread posting SINGLE-SHOT main-thread tasks with an
		// in-flight flag (the drag ticker's shape) — a task that re-adds
		// itself traps SKSE's queue pump forever.
		std::thread([serial]() {
			using namespace std::chrono_literals;
			for (;;) {
				std::this_thread::sleep_for(16ms);
				{
					std::lock_guard l(g_lock);
					if (serial != g_serial || !g_boltId)
						return;  // finished, or a newer shot owns the waiter
				}
				if (g_pollInFlight.exchange(true))
					continue;
				SKSE::GetTaskInterface()->AddTask([serial]() {
					PollOnce(serial);
					g_pollInFlight.store(false);
				});
			}
		}).detach();
	}

	void Ping(RE::Actor* target)
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player || !target || target == player || target->IsDead() ||
			target->IsDisabled() || !target->Is3DLoaded())
			return;
		// The existing eight-second gold ping marks the actual order target.
		LootHighlight::Ping(target->GetFormID());
	}
}
