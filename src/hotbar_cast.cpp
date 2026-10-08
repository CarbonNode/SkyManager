#include "hotbar_cast.h"

#include "cast_anim.h"
#include "spell_cost.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and logger::.
//
// windows.h arrives without NOMINMAX/WIN32_LEAN_AND_MEAN, so its macros rename
// RE::PlaySound -> PlaySoundA, BGSDefaultObjectManager::GetObject -> GetObjectA
// and break std::max — the cross-module trap in CLAUDE.md (first build of this
// file failed on exactly these three).
#undef PlaySound
#undef GetObject
#undef min
#undef max
//
// Model: Spell Hotbar NG (github.com/W1terr/SpellHotbarNG, GPL-3) — its
// casting/Actions.cpp cast loop and casting/PlayerControl.cpp crosshair aim,
// read 2026-10-04. Ours drops the animation path (phase 2) and the Equip /
// Oblivion key modes, and is ticked from the hotbar poll thread instead of a
// PlayerCharacter::Update hook (see main.cpp: no new engine hook for this).

namespace HotbarCast
{
	namespace
	{
		using CastingType = RE::MagicSystem::CastingType;
		using Delivery    = RE::MagicSystem::Delivery;
		using Source      = RE::MagicSystem::CastingSource;
		using SoundID     = RE::MagicSystem::SoundID;
		using Clock       = std::chrono::steady_clock;

		struct Cast
		{
			Request           req;
			Source            source = Source::kRightHand;
			bool              dual = false;        // one dual cast (the perk)
			bool              bothHands = false;   // "both" without the perk: one cast per hand
			float             cost = 0.0f;         // total; per second for concentration
			float             charge = 0.0f;
			float             chargeTotal = 0.0f;
			bool              channeling = false;
			float             channelTime = 0.0f;
			RE::BSSoundHandle chargeSound{};
			RE::BSSoundHandle loopSound{};
			// The optional clip (cast_anim.h): true = CastAnim took this cast
			// and must be told about its release and its end.
			bool              anim = false;
			bool              released = false;
		};

		struct Queued
		{
			Request req;
			float   age = 0.0f;
			float   maxAge = 3.0f;
		};

		// Spell Hotbar NG's timings, kept.
		constexpr float kMinRecovery = 0.25f;      // shortest gap between two bar casts
		constexpr float kQueueMaxAge = 3.0f;       // a press while busy waits at most this long
		constexpr float kAirDebounce = 0.15f;      // midair this long = really jumping/falling (slopes flicker)
		constexpr float kClickChannelMax = 120.0f; // a toggled (no key to hold) channel's safety cap
		constexpr float kMaxStep = 0.25f;          // one tick never advances more than this
		constexpr float kAimRange = 10000.0f;      // game units the crosshair ray reaches

		std::optional<Cast>   g_cast;
		std::optional<Queued> g_queued;
		float                 g_gcd = 0.0f;
		float                 g_air = 0.0f;
		bool                  g_retrying = false;  // a queued press being retried: no second toast
		std::atomic<bool>     g_active{ false };
		Clock::time_point     g_last{};
		bool                  g_haveLast = false;
		std::function<void(const std::string&)> g_sink;

		RE::PlayerCharacter* Player() { return RE::PlayerCharacter::GetSingleton(); }

		// CastAnim::Busy keeps the tick alive for the clip's delayed reset
		// after the cast itself is gone.
		void SyncActive() { g_active = g_cast.has_value() || g_queued.has_value() || CastAnim::Busy(); }

		void Say(const std::string& msg)
		{
			if (!g_retrying && !msg.empty())
				RE::DebugNotification(msg.c_str());
		}

		void ToView(const Request& r, const char* phase, float dur = -1.0f)
		{
			// -1 = no button; -2/-3 are the Oblivion-style ready sockets (hotbar.h)
			if (!g_sink || r.slot == -1)
				return;
			nlohmann::json j{ { "page", r.page }, { "i", r.slot }, { "phase", phase } };
			if (dur >= 0.0f)
				j["dur"] = static_cast<double>(static_cast<int>(dur * 100)) / 100.0;
			g_sink(j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
		}

		const char* NameOf(const RE::TESForm* f)
		{
			const char* n = f ? f->GetName() : nullptr;
			return n && *n ? n : "that spell";
		}

		float Magicka()
		{
			auto* p = Player();
			return p ? p->AsActorValueOwner()->GetActorValue(RE::ActorValue::kMagicka) : 0.0f;
		}

		void FailSound() { RE::PlaySound("MAGFailSD"); }

		void NotEnoughMagicka()
		{
			RE::HUDMenu::FlashMeter(RE::ActorValue::kMagicka);
			FailSound();
		}

		float GameSetting(const char* name, float def)
		{
			auto* gs = RE::GameSettingCollection::GetSingleton();
			auto* s = gs ? gs->GetSetting(name) : nullptr;
			return s ? s->GetFloat() : def;
		}

		// Same definition as the bar's "known" ring (hotbar.cpp KnowsSpell):
		// actor-base spell list + everything learned at runtime.
		bool Knows(RE::SpellItem* sp)
		{
			auto* player = Player();
			if (!player || !sp)
				return false;
			if (auto* base = player->GetActorBase()) {
				if (auto* data = base->GetSpellList(); data && data->spells) {
					for (std::uint32_t i = 0; i < data->numSpells; ++i)
						if (data->spells[i] == sp)
							return true;
				}
			}
			for (auto* s : player->GetActorRuntimeData().addedSpells)
				if (s == sp)
					return true;
			return false;
		}

		int Carried(RE::TESBoundObject* obj)
		{
			auto* player = Player();
			auto* changes = player ? player->GetInventoryChanges() : nullptr;
			return changes && obj ? std::max<int>(0, changes->GetItemCount(obj)) : 0;
		}

		// Vanilla's "<school> Dual Casting" perks (Skyrim.esm), by the costliest
		// effect's school — Spell Hotbar NG's table.
		bool HasDualCastPerk(RE::MagicItem* item)
		{
			auto* eff = item ? item->GetCostliestEffectItem() : nullptr;
			auto* base = eff ? eff->baseEffect : nullptr;
			if (!base)
				return false;
			RE::FormID id = 0;
			switch (base->GetMagickSkill()) {
			case RE::ActorValue::kAlteration:  id = 0x000153CD; break;
			case RE::ActorValue::kConjuration: id = 0x000153CE; break;
			case RE::ActorValue::kDestruction: id = 0x000153CF; break;
			case RE::ActorValue::kIllusion:    id = 0x000153D0; break;
			case RE::ActorValue::kRestoration: id = 0x000153D1; break;
			default: return false;
			}
			auto* perk = RE::TESForm::LookupByID<RE::BGSPerk>(id);
			return perk && Player()->HasPerk(perk);
		}

		bool WantsDual(RE::MagicItem* item, const std::string& hand)
		{
			return hand == "both" && item && !item->GetNoDualCastModifications() &&
			       !item->IsTwoHanded() && HasDualCastPerk(item);
		}

		bool WantsBoth(RE::MagicItem* item, const std::string& hand)
		{
			return hand == "both" && item && !item->IsTwoHanded() && !WantsDual(item, hand);
		}

		bool InBeastForm()
		{
			auto* player = Player();
			auto* race = player ? player->GetRace() : nullptr;
			if (!race)
				return false;
			static RE::TESRace* werewolf = RE::TESForm::LookupByID<RE::TESRace>(0x000CDD84);  // WerewolfBeastRace
			static RE::TESRace* vampLord = [] {
				auto* dh = RE::TESDataHandler::GetSingleton();
				return dh ? dh->LookupForm<RE::TESRace>(0x00283A, "Dawnguard.esm") : nullptr;  // DLC1VampireBeastRace
			}();
			return race == werewolf || (vampLord && race == vampLord);
		}

		enum class Gate
		{
			kOk,
			kWait,     // a moment's state (drawing / sheathing, maybe a slope): retry shortly
			kRefuse,
		};

		Gate Blocker(const char*& why)
		{
			why = nullptr;
			auto* player = Player();
			if (!player || player->IsDead()) {
				why = "";
				return Gate::kRefuse;
			}
			if (InBeastForm()) {
				why = "You can't cast in beast form";
				return Gate::kRefuse;
			}
			const auto* st = player->AsActorState();
			if (st->IsSwimming()) {
				why = "You can't cast while swimming";
				return Gate::kRefuse;
			}
			if (st->GetAttackState() != RE::ATTACK_STATE_ENUM::kNone) {
				why = "";   // mid-swing: vanilla just ignores it too
				return Gate::kRefuse;
			}
			const auto ws = st->GetWeaponState();
			if (ws != RE::WEAPON_STATE::kSheathed && ws != RE::WEAPON_STATE::kDrawn) {
				why = "drawing / sheathing";
				return Gate::kWait;
			}
			if (player->IsInMidair()) {
				if (g_air >= kAirDebounce) {
					why = "";
					return Gate::kRefuse;
				}
				why = "midair";
				return Gate::kWait;
			}
			return Gate::kOk;
		}

		RE::BGSSoundDescriptorForm* EffectSound(RE::MagicItem* item, SoundID id)
		{
			auto* eff = item ? item->GetCostliestEffectItem() : nullptr;
			auto* base = eff ? eff->baseEffect : nullptr;
			if (!base)
				return nullptr;
			for (const auto& s : base->effectSounds)
				if (s.id == id)
					return s.sound;
			return nullptr;
		}

		void PlayEffectSound(RE::MagicItem* item, SoundID id, RE::BSSoundHandle* keep = nullptr)
		{
			auto* desc = EffectSound(item, id);
			auto* audio = RE::BSAudioManager::GetSingleton();
			auto* player = Player();
			if (!desc || !audio || !player)
				return;
			RE::BSSoundHandle local{};
			auto&             h = keep ? *keep : local;
			if (audio->BuildSoundDataFromDescriptor(h, desc)) {
				if (auto* root = player->Get3D())
					h.SetObjectToFollow(root);
				h.Play();
			}
		}

		void StopSound(RE::BSSoundHandle& h)
		{
			if (h.IsValid())
				h.FadeOutAndRelease(100);
		}

		// ---- player control (Spell Hotbar NG's PlayerControl) ----------------

		void StopSprinting()
		{
			auto* player = Player();
			if (!player || !player->AsActorState()->IsSprinting())
				return;
			auto* dobj = RE::BGSDefaultObjectManager::GetSingleton();
			auto* action = dobj ? dobj->GetObject<RE::BGSAction>(RE::DEFAULT_OBJECT::kActionSprintStop) : nullptr;
			auto* data = action ? RE::TESActionData::Create() : nullptr;
			if (!data)
				return;
			data->source = RE::NiPointer<RE::TESObjectREFR>(player);
			data->action = action;
			data->Process();
			data->~TESActionData();   // game-heap object: destroy, then the game's free
			RE::free(data);
		}

		RE::ThirdPersonState* ThirdPerson()
		{
			auto* cam = RE::PlayerCamera::GetSingleton();
			if (!cam || !cam->IsInThirdPerson())
				return nullptr;
			return static_cast<RE::ThirdPersonState*>(cam->currentState.get());
		}

		float NormalizeAngle(float a)
		{
			constexpr float kTwoPi = 6.2831853f;
			a = std::fmod(a, kTwoPi);
			return a < 0.0f ? a + kTwoPi : a;
		}

		// Third person with free rotation (sheathed): turn the body to where the
		// camera looks, so the spell does not leave sideways.
		void FaceCamera()
		{
			auto* third = ThirdPerson();
			auto* player = Player();
			if (!third || !player)
				return;
			const float off = third->freeRotation.x;
			if (std::abs(off) < 0.0001f)
				return;
			player->SetHeading(NormalizeAngle(player->GetAngleZ() + off));
			third->freeRotation.x = 0.0f;
		}

		// What the crosshair points at: the first thing the camera ray hits
		// (actors included — the ray uses the LOS layer with the player's own
		// group so it passes through the character), else a point far out.
		// Camera forward is the camera's own world rotation (the sic_em idiom),
		// so first person, third person and horseback all agree.
		std::optional<RE::NiPoint3> CrosshairPoint()
		{
			auto* cam = RE::PlayerCamera::GetSingleton();
			auto* player = Player();
			if (!cam || !cam->cameraRoot || !player)
				return std::nullopt;
			const auto&        wt = cam->cameraRoot->world;
			const RE::NiPoint3 from = wt.translate;
			const RE::NiPoint3 fwd{ -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };
			RE::NiPoint3       point = from + fwd * kAimRange;

			auto* cell = player->GetParentCell();
			auto* world = cell ? cell->GetbhkWorld() : nullptr;
			if (!world)
				return point;
			const float     s = RE::bhkWorld::GetWorldScale();
			RE::bhkPickData pick{};
			pick.rayInput.from = RE::hkVector4(from.x * s, from.y * s, from.z * s, 0.0f);
			pick.rayInput.to = RE::hkVector4(point.x * s, point.y * s, point.z * s, 0.0f);
			pick.ray = pick.rayInput.to - pick.rayInput.from;
			std::uint32_t info = 0;
			player->GetCollisionFilterInfo(info);
			pick.rayInput.filterInfo = (info & 0xFFFF0000u) | static_cast<std::uint32_t>(RE::COL_LAYER::kLOS);
			pick.rayOutput.Reset();
			if (world->PickObject(pick) && pick.rayOutput.HasHit()) {
				const float f = pick.rayOutput.hitFraction;
				if (std::isfinite(f) && f > 0.0f && f <= 1.0f) {
					const float dist = kAimRange * f;
					// third person: hits behind the character are the camera's own surroundings
					const float minimum = ThirdPerson() ? from.GetDistance(player->GetPosition()) * 0.5f : 0.0f;
					if (dist > minimum)
						point = from + fwd * dist;
				}
			}
			return point;
		}

		// While alive, the player's aim angles point from the casting hand to
		// the crosshair point, so the projectile leaves the hand and lands on
		// what the crosshair is on (no over-the-shoulder offset).
		class ScopedAim
		{
		public:
			explicit ScopedAim(RE::MagicCaster* caster)
			{
				auto* player = Player();
				const auto point = CrosshairPoint();
				if (!player || !point)
					return;
				RE::NiPoint3 origin = player->GetPosition();
				if (auto* node = caster ? caster->GetMagicNode() : nullptr)
					origin = node->world.translate;
				else
					origin.z += (player->GetBoundMax().z - player->GetBoundMin().z) * 0.7f;
				const auto  d = *point - origin;
				const float horiz = std::sqrt(d.x * d.x + d.y * d.y);
				if (horiz < 1.0f)
					return;
				saved_ = player->data.angle;
				player->data.angle.x = -std::atan2(d.z, horiz);
				player->data.angle.z = NormalizeAngle(std::atan2(d.x, d.y));
			}
			~ScopedAim()
			{
				if (auto* player = Player(); player && saved_) {
					player->data.angle.x = saved_->x;
					player->data.angle.z = saved_->z;
				}
			}
			ScopedAim(const ScopedAim&) = delete;
			ScopedAim& operator=(const ScopedAim&) = delete;

		private:
			std::optional<RE::NiPoint3> saved_;
		};

		// ---- the cast ---------------------------------------------------------

		std::vector<Source> Sources(const Cast& c)
		{
			if (c.bothHands)
				return { Source::kRightHand, Source::kLeftHand };
			return { c.source };
		}

		float CostOf(RE::MagicItem* item, bool dual, bool both)
		{
			auto* sp = item ? item->As<RE::SpellItem>() : nullptr;
			if (!sp)
				return 0.0f;   // scrolls are paid for by being consumed
			const auto base = SpellCost::Read(sp, Player());
			if (!base) {
				// No costliest effect: nothing for the perk evaluator to price
				// safely, and nothing much to cast either. Free, and said once.
				logger::warn("hotbar-cast: '{}' has no priceable effect; casting it at no cost", NameOf(sp));
				return 0.0f;
			}
			float cost = *base;
			if (dual)
				cost *= GameSetting("fMagicDualCastingCostMult", 2.8f);
			if (both)
				cost *= 2.0f;
			return cost;
		}

		void EndCast()
		{
			if (!g_cast)
				return;
			StopSound(g_cast->chargeSound);
			StopSound(g_cast->loopSound);
			ToView(g_cast->req, "end");
			// A clip that never released fizzled; a channel's loop must be cut.
			if (g_cast->anim)
				CastAnim::End(g_cast->channeling || !g_cast->released);
			g_cast.reset();
		}

		void StopChannel()
		{
			if (!g_cast)
				return;
			if (g_cast->channeling) {
				if (auto* player = Player()) {
					for (const auto src : Sources(*g_cast)) {
						if (auto* caster = player->GetMagicCaster(src)) {
							caster->InterruptCast(false);
							if (g_cast->dual)
								caster->SetDualCasting(false);
						}
					}
					// some concentration casts ignore the caster interrupt
					if (player->IsCasting(g_cast->req.item))
						player->InterruptCast(false);
				}
				logger::info("hotbar-cast: channel of '{}' ended after {:.1f}s", NameOf(g_cast->req.item), g_cast->channelTime);
				g_gcd = kMinRecovery;
			}
			EndCast();
		}

		// Fires the spell. false = it failed (no magicka, no valid spot).
		bool Release()
		{
			auto* player = Player();
			if (!player || !g_cast)
				return false;
			StopSound(g_cast->chargeSound);

			auto*      item = g_cast->req.item;
			const bool conc = item->GetCastingType() == CastingType::kConcentration;

			if (!g_cast->req.scroll) {
				const float m = Magicka();
				if (conc ? m <= 0.0f : m < g_cast->cost) {
					NotEnoughMagicka();
					return false;
				}
			}

			std::vector<RE::MagicCaster*> casters;
			for (const auto src : Sources(*g_cast))
				if (auto* c = player->GetMagicCaster(src))
					casters.push_back(c);
			if (casters.empty())
				return false;

			const auto delivery = item->GetDelivery();
			const bool self = delivery == Delivery::kSelf;
			const bool aim = g_cast->req.aimCrosshair &&
			                 (delivery == Delivery::kAimed || delivery == Delivery::kTargetLocation);
			RE::Actor* target = self ? player :
			                    aim  ? nullptr :
			                           player->GetActorRuntimeData().currentCombatTarget.get().get();

			if (conc) {
				for (auto* c : casters)
					c->currentSpellCost = g_cast->cost / static_cast<float>(casters.size());   // per second, drained by the caster
			} else if (!g_cast->req.scroll && g_cast->cost > 0.0f) {
				player->AsActorValueOwner()->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage,
					RE::ActorValue::kMagicka, -g_cast->cost);
			}

			if (aim)
				FaceCamera();
			if (g_cast->anim)
				CastAnim::Release();   // the exhale / the channel's loop clip
			for (auto* c : casters) {
				if (g_cast->dual)
					c->SetDualCasting(true);
				if (aim) {
					const ScopedAim a(c);
					c->CastSpellImmediate(item, false, target, 1.0f, false, 0.0f, player);
				} else {
					c->CastSpellImmediate(item, false, target, 1.0f, false, 0.0f, self ? nullptr : player);
				}
				if (g_cast->dual && !conc)
					c->SetDualCasting(false);
			}

			// A rune / summon that found no valid spot keeps "casting" forever:
			// interrupt it and give the magicka back, like vanilla's red "can't place".
			if (delivery == Delivery::kTargetLocation && !conc && player->IsCasting(item)) {
				player->InterruptCast(false);
				if (!g_cast->req.scroll && g_cast->cost > 0.0f)
					player->AsActorValueOwner()->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage,
						RE::ActorValue::kMagicka, g_cast->cost);
				FailSound();
				logger::info("hotbar-cast: '{}' found no valid spot; refunded", NameOf(item));
				return false;
			}

			g_cast->released = true;
			if (g_cast->req.scroll)
				player->RemoveItem(g_cast->req.scroll, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);

			PlayEffectSound(item, SoundID::kRelease);
			if (conc) {
				g_cast->channeling = true;
				PlayEffectSound(item, SoundID::kCastLoop, &g_cast->loopSound);
				ToView(g_cast->req, "channel");
			}
			// Build marker (hd-markers.json: "hotbar-cast-release").
			logger::info("hotbar-cast: released '{}' ({}{}{}, cost {:.0f}{})", NameOf(item),
				g_cast->req.scroll ? "scroll" : conc ? "channel" : "fire",
				g_cast->dual ? ", dual" : g_cast->bothHands ? ", both hands" : "",
				aim ? ", at crosshair" : self ? ", self" : "", g_cast->cost, conc ? "/s" : "");
			return true;
		}

		void Queue(const Request& r, float maxAge)
		{
			g_queued = Queued{ r, 0.0f, maxAge };
		}

		// Begin after every gate has passed. Mirrors SHNG's BeginInstantCast.
		Result Begin(Request req, std::string& msg)
		{
			Cast next{};
			auto* item = req.item;
			const bool conc = item->GetCastingType() == CastingType::kConcentration;
			next.source = req.hand == "left" ? Source::kLeftHand : Source::kRightHand;
			next.dual = !req.scroll && WantsDual(item, req.hand);
			next.bothHands = !req.scroll && WantsBoth(item, req.hand);
			next.cost = req.scroll ? 0.0f : CostOf(item, next.dual, next.bothHands);

			if (!req.scroll && (conc ? Magicka() <= 0.0f : Magicka() < next.cost)) {
				NotEnoughMagicka();
				msg = "Not enough magicka";
				return Result::kRefused;
			}

			StopSprinting();
			next.chargeTotal = conc ? 0.0f : std::max(0.0f, item->GetChargeTime());
			next.req = std::move(req);
			g_cast = std::move(next);
			// The optional clip rides the same press (no-op without Spell
			// Hotbar 2 installed, or with the setting off).
			g_cast->anim = CastAnim::Begin(item, g_cast->source == Source::kLeftHand,
				g_cast->dual || g_cast->bothHands, conc);

			if (g_cast->chargeTotal > 0.0f) {
				PlayEffectSound(item, SoundID::kCharge, &g_cast->chargeSound);
				ToView(g_cast->req, "charge", g_cast->chargeTotal);
				SyncActive();
				return Result::kStarted;
			}

			const bool ok = Release();
			if (!ok || !g_cast->channeling) {
				EndCast();
				if (ok)
					g_gcd = kMinRecovery;
			}
			SyncActive();
			if (!ok) {
				msg = "That didn't go off";
				return Result::kRefused;
			}
			return Result::kStarted;
		}
	}

	Result Start(Request req, std::string& msg)
	{
		msg.clear();
		auto* player = Player();
		auto* item = req.item;
		if (!player || !item || player->IsDead()) {
			msg = "No player";
			return Result::kRefused;
		}

		// The running channel's own button again = stop it (WoW's re-press).
		if (g_cast && g_cast->channeling && g_cast->req.page == req.page && g_cast->req.slot == req.slot) {
			StopChannel();
			SyncActive();
			return Result::kStopped;
		}

		if (auto* sp = item->As<RE::SpellItem>(); sp && !req.scroll && !Knows(sp)) {
			msg = std::string("You don't know ") + NameOf(sp) + " any more";
			Say(msg);
			FailSound();
			return Result::kRefused;
		}
		if (req.scroll && Carried(req.scroll) <= 0) {
			msg = std::string("No ") + NameOf(req.scroll) + " left";
			Say(msg);
			FailSound();
			return Result::kRefused;
		}

		const char* why = nullptr;
		switch (Blocker(why)) {
		case Gate::kWait:
			Queue(req, why && std::string_view(why) == "midair" ? kAirDebounce + 0.1f : kQueueMaxAge);
			SyncActive();
			msg = std::string("waits (") + (why ? why : "busy") + ")";
			return Result::kQueued;
		case Gate::kRefuse:
			if (why && *why)
				Say(why);
			FailSound();
			msg = why && *why ? why : "can't cast right now";
			return Result::kRefused;
		default:
			break;
		}

		// Another spell's button while channelling: the channel ends and this
		// one goes off after the recovery — a new spell interrupts, it does not
		// get swallowed. While a charge is still winding up, it waits its turn.
		if (g_cast) {
			if (g_cast->channeling)
				StopChannel();
			Queue(req, kQueueMaxAge);
			SyncActive();
			msg = "waits for the running cast";
			return Result::kQueued;
		}
		if (g_gcd > 0.0f) {
			Queue(req, kQueueMaxAge);
			SyncActive();
			msg = "waits (recovering)";
			return Result::kQueued;
		}
		return Begin(std::move(req), msg);
	}

	void Tick()
	{
		const auto now = Clock::now();
		float      dt = 0.0f;
		if (g_haveLast)
			dt = std::clamp(std::chrono::duration<float>(now - g_last).count(), 0.0f, kMaxStep);
		g_last = now;
		g_haveLast = true;

		// Paused (a menu): nothing advances, and the next real tick starts
		// fresh from here rather than catching up the pause.
		if (auto* ui = RE::UI::GetSingleton(); ui && ui->GameIsPaused())
			return;

		auto* player = Player();
		if (!player || player->IsDead()) {
			Reset();
			return;
		}

		CastAnim::Tick(dt);
		g_gcd = std::max(0.0f, g_gcd - dt);
		g_air = player->IsInMidair() ? g_air + dt : 0.0f;

		if (g_queued) {
			g_queued->age += dt;
			if (g_queued->age > g_queued->maxAge) {
				logger::info("hotbar-cast: queued press of '{}' dropped after {:.1f}s", NameOf(g_queued->req.item), g_queued->age);
				g_queued.reset();
			} else if (!g_cast && g_gcd <= 0.0f) {
				Queued q = std::move(*g_queued);
				g_queued.reset();
				g_retrying = true;
				std::string msg;
				const auto r = Start(q.req, msg);
				g_retrying = false;
				if (r == Result::kQueued && g_queued)
					g_queued->age = q.age;   // still waiting: keep the original press time
			}
		}

		if (!g_cast) {
			SyncActive();
			return;
		}

		StopSprinting();

		// Jumped, fell, went swimming, swung a weapon: a charge fizzles (nothing
		// was spent), a channel stops.
		const char* why = nullptr;
		if (Blocker(why) != Gate::kOk && !(why && std::string_view(why) == "midair")) {
			StopChannel();
			SyncActive();
			return;
		}

		auto*      item = g_cast->req.item;
		const bool conc = item->GetCastingType() == CastingType::kConcentration;
		const auto& held = g_cast->req.held;

		if (!g_cast->channeling) {
			g_cast->charge += dt;
			if (g_cast->charge >= g_cast->chargeTotal) {
				const bool ok = Release();
				if (!ok || !g_cast->channeling) {
					EndCast();
					if (ok)
						g_gcd = kMinRecovery;
				}
			}
			SyncActive();
			return;
		}

		g_cast->channelTime += dt;
		const bool keyGone = held ? !held() : g_cast->channelTime >= kClickChannelMax;
		if (conc && keyGone) {
			StopChannel();
		} else if (Magicka() <= 0.0f) {
			NotEnoughMagicka();
			StopChannel();
		}
		SyncActive();
	}

	bool Active() { return g_active.load(); }

	void Reset()
	{
		if (g_cast) {
			StopSound(g_cast->chargeSound);
			StopSound(g_cast->loopSound);
			ToView(g_cast->req, "end");
		}
		CastAnim::End(true);
		g_cast.reset();
		g_queued.reset();
		g_gcd = 0.0f;
		g_air = 0.0f;
		g_haveLast = false;
		SyncActive();
	}

	std::optional<float> PressCost(RE::SpellItem* spell, const std::string& hand)
	{
		if (!spell || spell->GetSpellType() != RE::MagicSystem::SpellType::kSpell)
			return std::nullopt;
		const auto base = SpellCost::Read(spell, Player());
		if (!base)
			return std::nullopt;
		float cost = *base;
		if (WantsDual(spell, hand))
			cost *= GameSetting("fMagicDualCastingCostMult", 2.8f);
		else if (WantsBoth(spell, hand))
			cost *= 2.0f;
		return cost;
	}

	void SetViewSink(std::function<void(const std::string&)> sink) { g_sink = std::move(sink); }
}
