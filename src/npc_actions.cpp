#include "npc_actions.h"

#include "follower_frameworks.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <thread>
#include <unordered_map>

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

using json = nlohmann::json;  // DebugJson's dossier

namespace NpcActions
{
	namespace
	{
		enum class NPCState { None, Frozen, Sitting, InBed };
		std::unordered_map<RE::FormID, NPCState> g_managed;

		// Who we put on hold through their OWN follower framework, and which
		// framework it was. Only actors in here are ever resumed — someone who
		// was already parked before we touched her must stay parked.
		std::unordered_map<RE::FormID, int> g_frameworkHeld;

		RE::TESObjectREFR* g_crosshairRef = nullptr;  // live crosshair target (main thread)
		RE::FormID         g_target = 0;               // snapshotted at palette-open
		RE::FormID         g_itemRef = 0;              // non-actor crosshair ref at palette-open

		// ---- crosshair tracking (SKSE CrosshairRefEvent, like CommandNPC) ----

		class CrosshairSink : public RE::BSTEventSink<SKSE::CrosshairRefEvent>
		{
		public:
			static CrosshairSink* GetSingleton()
			{
				static CrosshairSink s;
				return &s;
			}
			RE::BSEventNotifyControl ProcessEvent(const SKSE::CrosshairRefEvent* e,
				RE::BSTEventSource<SKSE::CrosshairRefEvent>*) override
			{
				g_crosshairRef = e ? e->crosshairRef.get() : nullptr;
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		RE::Actor* ResolveCrosshairActor()
		{
			// 1) SKSE crosshair ref, if it's an actor
			if (g_crosshairRef && g_crosshairRef->GetFormType() == RE::FormType::ActorCharacter)
				return static_cast<RE::Actor*>(g_crosshairRef);

			// 2) camera-forward raycast fallback (best actor near the look vector)
			auto player = RE::PlayerCharacter::GetSingleton();
			auto camera = RE::PlayerCamera::GetSingleton();
			auto lists = RE::ProcessLists::GetSingleton();
			if (!player || !camera || !camera->cameraRoot || !lists)
				return nullptr;

			auto& wt = camera->cameraRoot->world;
			RE::NiPoint3 fwd = { -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };

			RE::Actor* best = nullptr;
			float      bestScore = 0.0f;
			auto check = [&](RE::ActorHandle& handle) {
				auto ptr = handle.get();
				if (!ptr)
					return;
				auto actor = ptr.get();
				if (!actor || actor == player || actor->IsDead() || !actor->Is3DLoaded())
					return;
				RE::NiPoint3 to = {
					actor->GetPositionX() - wt.translate.x,
					actor->GetPositionY() - wt.translate.y,
					(actor->GetPositionZ() + 80.0f) - wt.translate.z
				};
				float dist = to.Length();
				if (dist > 600.0f || dist < 1.0f)
					return;
				to.x /= dist; to.y /= dist; to.z /= dist;
				float dot = fwd.x * to.x + fwd.y * to.y + fwd.z * to.z;
				if (dot < 0.97f)
					return;
				float score = dot + (1.0f - dist / 600.0f);
				if (score > bestScore) { bestScore = score; best = actor; }
			};
			for (auto& h : lists->highActorHandles) check(h);
			for (auto& h : lists->middleHighActorHandles) check(h);
			return best;
		}

		// ---- helpers ----

		void Notify(const std::string& msg) { RE::DebugNotification(msg.c_str()); }

		std::string NameOf(RE::Actor* actor)
		{
			if (auto base = actor->GetActorBase()) {
				auto n = base->GetFullName();
				if (n && n[0])
					return n;
			}
			return "NPC";
		}

		void CallActorBool(RE::Actor* actor, const char* fn, bool value)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return;
			auto policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(std::move(value));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", fn, args, cb);
		}

		// Actor.StartCombat(Actor akTarget) — Papyrus only (no clean C++ native),
		// so it dispatches through the VM like the rest of this file. Makes
		// `aggressor` immediately enter combat against `target`, bypassing the
		// detection lag that leaves a follower standing idle for a beat. Firing
		// it on a follower is exactly what EFF's old "assault" targeting spell did.
		void CallStartCombat(RE::Actor* aggressor, RE::Actor* target)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !aggressor || !target)
				return;
			auto policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, aggressor);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(target)));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", "StartCombat", args, cb);
		}

		void LockActor(RE::Actor* actor)
		{
			CallActorBool(actor, "SetRestrained", true);
			CallActorBool(actor, "SetDontMove", true);
			actor->AsActorValueOwner()->SetActorValue(RE::ActorValue::kSpeedMult, 0.0f);
			actor->StopMoving(1.0f);
		}

		void UnlockActor(RE::Actor* actor)
		{
			CallActorBool(actor, "SetRestrained", false);
			CallActorBool(actor, "SetDontMove", false);
			actor->AsActorValueOwner()->SetActorValue(RE::ActorValue::kSpeedMult, 100.0f);
			actor->EvaluatePackage();
		}

		// ---- follower frameworks -------------------------------------------
		//
		// SetRestrained / SetDontMove / SpeedMult act on the ACTOR, and a
		// package instanced on a quest ALIAS outranks all three. So on a
		// companion driven by her own follower mod the hold used to be a silent
		// no-op: the deck said "halted", she kept walking. Everything below
		// exists to make that either really work or really say so.

		// Route the hold through the actor's own follower framework when we
		// have one, and speak up when we do not. Returns a suffix to append to
		// the action's notification (empty when there is nothing to add).
		std::string HoldViaFramework(RE::Actor* actor)
		{
			if (!actor)
				return {};
			const auto det = FollowerFrameworks::Probe(actor);
			logger::info("NpcActions: framework probe for \"{}\" -> {}",
				NameOf(actor), FollowerFrameworks::Summarise(det));

			if (det.known) {
				// Already parked by her own framework — send nothing, and
				// record nothing, so a later release cannot un-park her.
				if (FollowerFrameworks::AlreadyWaiting(actor))
					return " (already waiting)";
				if (FollowerFrameworks::SendWait(actor, det)) {
					g_frameworkHeld[actor->GetFormID()] = det.spec;
					return " (" + det.label + ": wait)";
				}
				Notify("⚠ " + det.label + " refused the wait order — use " +
					NameOf(actor) + "'s dialogue");
				return {};
			}

			if (det.NeedsWarning()) {
				Notify("⚠ " + NameOf(actor) +
					" is run by her own follower mod — use her dialogue to make her wait");
				logger::warn("NpcActions: no native wait for {}'s framework ({}) — warned the player",
					NameOf(actor), det.plugin.empty() ? "unknown plugin" : det.plugin);
			}
			return {};
		}

		// Undo exactly what HoldViaFramework did, and only that.
		void ReleaseFramework(RE::Actor* actor)
		{
			if (!actor)
				return;
			const auto it = g_frameworkHeld.find(actor->GetFormID());
			if (it == g_frameworkHeld.end())
				return;
			FollowerFrameworks::SendResume(actor, it->second);
			g_frameworkHeld.erase(it);
		}

		// ---- the alias engine (HotkeyDeckWardrobe.esp / HD_NPCControl) --------
		//
		// freeze/sit/bed used to be actor-level state (SetRestrained) plus
		// CommandNPC's teleport-Activate-pin script, and both LOSE to any alias
		// package (CHIM follow, NFF, an inn's sandbox) — hence "she pops back
		// out and stands pinned next to the bed". The verbs now run on quest
		// ALIASES carrying vanilla-template packages (HoldPosition / SitTarget /
		// Sleep) at quest priority 90, so the engine itself walks her there and
		// KEEPS her there through every AI re-evaluation. The ESP records are
		// built by tools/make_deck_esp.py; HD_NPCControl.psc is the thin driver
		// (ForceRefTo has no SKSE-side native). Alias id map — the contract with
		// both of those files:
		//   10..17 Hold slots (package anchored on its own alias)
		//   20..23 Sit NPC   / 30..33 the chair
		//   40..43 Sleep NPC / 50..53 the bed

		constexpr int kHoldBase = 10, kHoldCount = 8;
		constexpr int kSitBase = 20, kSitChairBase = 30, kSitCount = 4;
		constexpr int kBedBase = 40, kBedAnchorBase = 50, kBedCount = 4;

		struct AliasHold
		{
			NPCState state = NPCState::None;
			int      npcAlias = -1;
			int      targetAlias = -1;
		};
		std::unordered_map<RE::FormID, AliasHold> g_aliasHeld;

		int TargetAliasFor(int npcAlias)
		{
			if (npcAlias >= kSitBase && npcAlias < kSitBase + kSitCount)
				return npcAlias - kSitBase + kSitChairBase;
			if (npcAlias >= kBedBase && npcAlias < kBedBase + kBedCount)
				return npcAlias - kBedBase + kBedAnchorBase;
			return -1;
		}

		RE::TESQuest* ControlQuest()
		{
			static RE::TESQuest* cached = nullptr;
			if (cached)
				return cached;
			if (auto q = RE::TESForm::LookupByEditorID<RE::TESQuest>("HDNPCControlQuest")) {
				cached = q;
				return cached;
			}
			if (auto dh = RE::TESDataHandler::GetSingleton()) {
				if (auto form = dh->LookupForm(0x803, "HotkeyDeckWardrobe.esp"))
					cached = form->As<RE::TESQuest>();
			}
			return cached;
		}

		bool EnsureControlRunning()
		{
			auto* q = ControlQuest();
			if (!q)
				return false;
			if (!q->IsRunning()) {
				const bool ok = q->Start();
				logger::info("NpcActions: HD_NPCControl quest start -> {} ({} aliases)",
					ok, q->aliases.size());
			}
			return q->IsRunning();
		}

		// Dispatch into HD_NPCControl.psc. Fire-and-forget like every other VM
		// call in this file; the script is total (bad args are a no-op).
		bool CallControl2(const char* fn, RE::Actor* npc, int npcAlias,
			RE::TESObjectREFR* target, int targetAlias, bool fourArgs)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* quest = ControlQuest();
			if (!vm || !quest)
				return false;
			auto policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			if (fourArgs) {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(npc)),
					std::move(static_cast<std::int32_t>(npcAlias)),
					std::move(static_cast<RE::TESObjectREFR*>(target)),
					std::move(static_cast<std::int32_t>(targetAlias)));
				vm->DispatchMethodCall(handle, "HD_NPCControl", fn, args, cb);
			} else {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(npc)),
					std::move(static_cast<std::int32_t>(npcAlias)),
					std::move(static_cast<std::int32_t>(targetAlias)));
				vm->DispatchMethodCall(handle, "HD_NPCControl", fn, args, cb);
			}
			return true;
		}

		bool ControlApply(RE::Actor* npc, int npcAlias, RE::TESObjectREFR* target, int targetAlias)
		{
			return CallControl2("HDApply", npc, npcAlias, target, targetAlias, true);
		}

		bool ControlDrop(RE::Actor* npc, int npcAlias, int targetAlias)
		{
			return CallControl2("HDDrop", npc, npcAlias, nullptr, targetAlias, false);
		}

		// Which of OUR alias ids this actor fills right now — ENGINE truth, so
		// it survives save loads that emptied our bookkeeping (the alias fill
		// itself persists in the save; the map does not).
		std::vector<int> OurAliasIdsOn(RE::Actor* actor)
		{
			std::vector<int> out;
			auto* cq = ControlQuest();
			if (!cq || !actor)
				return out;
			if (auto* arr = actor->extraList.GetByType<RE::ExtraAliasInstanceArray>()) {
				RE::BSReadLockGuard locker(arr->lock);
				for (auto* inst : arr->aliases) {
					if (inst && inst->quest == cq && inst->alias)
						out.push_back(static_cast<int>(inst->alias->aliasID));
				}
			}
			return out;
		}

		// Free every alias of ours she is in (bookkept or engine-found), so a
		// re-apply never leaks a slot and a stale-save hold is reusable.
		void DropAliasHold(RE::Actor* actor)
		{
			auto ids = OurAliasIdsOn(actor);
			const auto it = g_aliasHeld.find(actor->GetFormID());
			if (it != g_aliasHeld.end() &&
				std::find(ids.begin(), ids.end(), it->second.npcAlias) == ids.end() &&
				it->second.npcAlias >= 0)
				ids.push_back(it->second.npcAlias);
			for (int a : ids) {
				// Only npc-side aliases get dropped through the script (the drop
				// clears the paired target alias too); a chair/bed alias id in
				// the list means SHE is the furniture side of someone else's
				// pair, which cannot happen for an actor — skip defensively.
				if (TargetAliasFor(a) >= 0 || (a >= kHoldBase && a < kHoldBase + kHoldCount))
					ControlDrop(actor, a, TargetAliasFor(a));
			}
			g_aliasHeld.erase(actor->GetFormID());
		}

		int AllocSlot(int base, int count)
		{
			for (int i = 0; i < count; ++i) {
				const int id = base + i;
				bool used = false;
				for (const auto& [fid, h] : g_aliasHeld) {
					if (h.npcAlias == id) {
						used = true;
						break;
					}
				}
				if (!used)
					return id;
			}
			return -1;
		}

		// ---- furniture (CommandNPC.esp / CS_FurnQuest) ----

		RE::TESQuest* FindFurnQuest()
		{
			if (auto q = RE::TESForm::LookupByEditorID<RE::TESQuest>("CS_FurnQuest"))
				return q;
			if (auto dh = RE::TESDataHandler::GetSingleton()) {
				if (auto form = dh->LookupForm(0x800, "CommandNPC.esp"))
					return form->As<RE::TESQuest>();
				for (auto* q : dh->GetFormArray<RE::TESQuest>())
					if (q && q->GetFormEditorID() && std::string(q->GetFormEditorID()) == "CS_FurnQuest")
						return q;
			}
			return nullptr;
		}

		bool CallFurnQuest(const char* fn, RE::Actor* actor, RE::TESObjectREFR* furniture)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return false;
			auto quest = FindFurnQuest();
			if (!quest)
				return false;
			auto handle = vm->GetObjectHandlePolicy()->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == vm->GetObjectHandlePolicy()->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			if (furniture) {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)),
					std::move(static_cast<RE::TESObjectREFR*>(furniture)));
				vm->DispatchMethodCall(handle, "CS_FurnQuestScript", fn, args, cb);
			} else {
				auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(actor)));
				vm->DispatchMethodCall(handle, "CS_FurnQuestScript", fn, args, cb);
			}
			return true;
		}

		RE::TESObjectREFR* FindNearestFurniture(RE::Actor* actor, bool wantBed)
		{
			auto cell = actor->GetParentCell();
			if (!cell)
				return nullptr;
			RE::TESObjectREFR* best = nullptr;
			float              bestDist = 1000.0f;
			cell->ForEachReferenceInRange(actor->GetPosition(), bestDist,
				[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
					if (!ref || ref->IsDeleted() || ref->IsDisabled())
						return RE::BSContainer::ForEachResult::kContinue;
					auto base = ref->GetBaseObject();
					if (!base)
						return RE::BSContainer::ForEachResult::kContinue;
					auto furn = base->As<RE::TESFurniture>();
					if (!furn)
						return RE::BSContainer::ForEachResult::kContinue;
					if (furn->workBenchData.benchType != RE::TESFurniture::WorkBenchData::BenchType::kNone)
						return RE::BSContainer::ForEachResult::kContinue;
					if (furn->furnFlags.any(RE::TESFurniture::ActiveMarker::kCanLean))
						return RE::BSContainer::ForEachResult::kContinue;
					bool isBed = furn->furnFlags.any(RE::TESFurniture::ActiveMarker::kCanSleep);
					bool isChair = furn->furnFlags.any(RE::TESFurniture::ActiveMarker::kCanSit);
					if (wantBed ? !isBed : !isChair)
						return RE::BSContainer::ForEachResult::kContinue;
					float dx = ref->GetPositionX() - actor->GetPositionX();
					float dy = ref->GetPositionY() - actor->GetPositionY();
					float dz = ref->GetPositionZ() - actor->GetPositionZ();
					float dist = std::sqrt(dx * dx + dy * dy + dz * dz);
					if (dist < bestDist) { bestDist = dist; best = ref; }
					return RE::BSContainer::ForEachResult::kContinue;
				});
			return best;
		}

		// ---- action verbs ----

		void DoFreeze(RE::Actor* actor)
		{
			auto  id = actor->GetFormID();
			auto& state = g_managed[id];
			if (state == NPCState::Frozen) {
				DropAliasHold(actor);
				ReleaseFramework(actor);
				UnlockActor(actor);
				g_managed.erase(id);
				Notify(NameOf(actor) + " released");
				return;
			}
			if (state == NPCState::Sitting || state == NPCState::InBed)
				actor->NotifyAnimationGraph("IdleForceDefaultState"sv);
			// Framework first: an NFF/Niri wait makes the handover clean even
			// though our priority-90 alias would win the package war anyway.
			const std::string via = HoldViaFramework(actor);
			std::string held;
			if (EnsureControlRunning()) {
				DropAliasHold(actor);  // stale-save slot or a previous sit — reclaim, never leak
				const int slot = AllocSlot(kHoldBase, kHoldCount);
				if (slot >= 0 && ControlApply(actor, slot, nullptr, -1)) {
					g_aliasHeld[id] = { NPCState::Frozen, slot, -1 };
					logger::info("NpcActions: alias-hold \"{}\" ({:08X}) in Hold slot {}",
						NameOf(actor), static_cast<std::uint32_t>(id), slot);
				} else if (slot < 0) {
					held = " (all 8 hold slots busy — actor pin only)";
					logger::warn("NpcActions: no free Hold slot for \"{}\"", NameOf(actor));
				}
			} else {
				held = " (no HD_NPCControl quest — actor pin only)";
				logger::warn("NpcActions: HD_NPCControl quest missing — HotkeyDeckWardrobe.esp v2 not loaded?");
			}
			// The actor-level pin stays ON TOP of the alias hold: the alias wins
			// the AI war, the pin makes her a statue (no combat repositioning).
			LockActor(actor);
			state = NPCState::Frozen;
			Notify(NameOf(actor) + " halted" + via + held);
		}

		void DoFurniture(RE::Actor* actor, bool wantBed)
		{
			auto  id = actor->GetFormID();
			auto& state = g_managed[id];
			if (state == NPCState::Sitting || state == NPCState::InBed) {
				DropAliasHold(actor);
				// Pre-alias saves may still be pinned by CommandNPC's script —
				// send its release too so those actors don't stay restrained.
				CallFurnQuest("ReleaseFromFurniture", actor, nullptr);
				ReleaseFramework(actor);
				UnlockActor(actor);
				g_managed.erase(id);
				Notify(NameOf(actor) + " released");
				return;
			}
			RE::TESObjectREFR* furniture = FindNearestFurniture(actor, wantBed);
			// Same reason as freeze: a framework follow package fights the chair
			// unless the framework is told to stand down.
			const std::string via = HoldViaFramework(actor);
			if (furniture && EnsureControlRunning()) {
				if (state == NPCState::Frozen)
					UnlockActor(actor);  // a pinned actor cannot walk to the chair
				DropAliasHold(actor);
				const int slot = AllocSlot(wantBed ? kBedBase : kSitBase,
					wantBed ? kBedCount : kSitCount);
				if (slot >= 0 && ControlApply(actor, slot, furniture, TargetAliasFor(slot))) {
					g_aliasHeld[id] = { wantBed ? NPCState::InBed : NPCState::Sitting,
						slot, TargetAliasFor(slot) };
					state = wantBed ? NPCState::InBed : NPCState::Sitting;
					auto name = furniture->GetName();
					logger::info("NpcActions: alias-seat \"{}\" ({:08X}) slot {} -> \"{}\"",
						NameOf(actor), static_cast<std::uint32_t>(id), slot,
						(name && name[0]) ? name : "?");
					Notify(NameOf(actor) + " -> " +
						((name && name[0]) ? name : (wantBed ? "bed" : "seat")) +
						" (walking over)" + via);
					return;
				}
				Notify("⚠ all " + std::to_string(wantBed ? kBedCount : kSitCount) +
					(wantBed ? " bed" : " seat") + " slots busy — release someone first");
				return;
			}
			// No usable furniture in reach (or no control quest) — ground sit,
			// the honest fallback, exactly what it always was.
			actor->NotifyAnimationGraph("IdleForceDefaultState"sv);
			LockActor(actor);
			actor->NotifyAnimationGraph("IdleSitCrossLeggedEnter"sv);
			state = NPCState::Sitting;
			Notify(NameOf(actor) + (wantBed ? " lie (ground)" : " sit (ground)") + via);
		}

		void DoReleaseAll()
		{
			int count = 0;
			for (auto& [id, state] : g_managed) {
				auto actor = RE::TESForm::LookupByID<RE::Actor>(id);
				if (!actor)
					continue;
				if (state == NPCState::Sitting || state == NPCState::InBed)
					actor->NotifyAnimationGraph("IdleForceDefaultState"sv);
				DropAliasHold(actor);
				ReleaseFramework(actor);
				UnlockActor(actor);
				++count;
			}
			g_managed.clear();
			g_aliasHeld.clear();
			// Anyone we told to wait but whose actor-level entry is already
			// gone (released individually, or lost across a save load) still
			// has a framework order outstanding — clear those too, so
			// "release all" really means all.
			for (const auto& [id, spec] : g_frameworkHeld) {
				if (auto actor = RE::TESForm::LookupByID<RE::Actor>(id))
					FollowerFrameworks::SendResume(actor, spec);
			}
			g_frameworkHeld.clear();
			Notify(count > 0 ? ("Released " + std::to_string(count) + " NPCs") : "No held NPCs");
		}

		RE::Actor* TargetActor()
		{
			if (!g_target)
				return nullptr;
			return RE::TESForm::LookupByID<RE::Actor>(g_target);
		}

		// ---- "sic 'em" (attack-target) --------------------------------------
		//
		// EFF used to hand you a no-damage targeting spell: shoot it at an enemy
		// and every follower broke off to attack. This is the same idea off the
		// crosshair — look at the target, fire, and every loaded follower enters
		// combat against it NOW. The immediate StartCombat is the whole point:
		// it skips the detection/aggro delay that leaves followers standing
		// around for a beat before they notice the fight ("slow to engage").
		//
		// "Target + nearby enemies": we also wake any ALREADY-hostile actors
		// within a short radius of the target so the whole brawl lights up at
		// once and the followers have live targets to path toward. We never pull
		// in a neutral — only actors already hostile to the player or already in
		// combat — so this is "attack that group", never "start a massacre".
		void DoSicEm()
		{
			auto* target = TargetActor();
			if (!target) {
				Notify("Sic 'em: look at a target, then open the deck");
				return;
			}
			if (target->IsDead()) {
				Notify(NameOf(target) + " is already dead");
				return;
			}

			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* lists  = RE::ProcessLists::GetSingleton();
			if (!player || !lists) {
				Notify("Sic 'em: unavailable right now");
				return;
			}

			// Loaded followers (teammates), same predicate the rest of the deck
			// uses for "is this person following me".
			std::vector<RE::Actor*> followers;
			for (auto& h : lists->highActorHandles) {
				auto ptr = h.get();
				auto* a  = ptr ? ptr.get() : nullptr;
				if (!a || a->IsDisabled() || a->IsDead() || a->IsPlayerRef())
					continue;
				if (!a->IsPlayerTeammate())
					continue;
				followers.push_back(a);
			}
			if (followers.empty()) {
				Notify("Sic 'em: no followers nearby to command");
				return;
			}

			// Already-hostile actors near the target — wake these into the fight.
			constexpr float          kNearRadius = 1500.0f;  // ~a couple of rooms
			const RE::NiPoint3       tp = target->GetPosition();
			std::vector<RE::Actor*>  nearHostiles;
			for (auto& h : lists->highActorHandles) {
				auto ptr = h.get();
				auto* a  = ptr ? ptr.get() : nullptr;
				if (!a || a == target || a->IsDisabled() || a->IsDead() || a->IsPlayerRef())
					continue;
				if (a->IsPlayerTeammate())
					continue;
				if ((a->GetPosition() - tp).Length() > kNearRadius)
					continue;
				if (!a->IsHostileToActor(player) && !a->IsInCombat())
					continue;
				nearHostiles.push_back(a);
				if (nearHostiles.size() >= 10)
					break;
			}

			// Everyone rushes the one you pointed at first (kill order = focus
			// fire on the designated target)...
			for (auto* f : followers)
				CallStartCombat(f, target);

			// ...and the near hostiles get pulled active so the group is a real
			// fight by the time the followers arrive. Aggro toward the player,
			// the always-valid anchor; combat is shared, so followers retarget.
			for (auto* e : nearHostiles)
				CallStartCombat(e, player);

			logger::info("NpcActions: sic-em — {} follower(s) onto \"{}\" (+{} nearby hostile)",
				followers.size(), NameOf(target), nearHostiles.size());
			std::string msg = "⚔ " + std::to_string(static_cast<int>(followers.size())) +
				" on " + NameOf(target);
			if (!nearHostiles.empty())
				msg += " +" + std::to_string(static_cast<int>(nearHostiles.size()));
			Notify(msg);
		}

		// ---- grab drag ("grab") ---------------------------------------------
		//
		// Groovatron-style carry: the NPC is pinned to the camera's look vector
		// and follows the mouse until dropped. The visual move each tick is
		// SetPosition (engine MoveTo_Impl, same-cell) — cheap enough for 30 Hz —
		// and the DROP is a real MoveTo through our own XMarker, because a drag
		// can walk an exterior NPC across a cell border and only MoveTo runs the
		// engine's own cell attach (same law as the Domains recall).

		struct DragState
		{
			RE::FormID    id = 0;
			float         dist = 300.0f;
			bool          wasFrozen = false;  // frozen at grab time -> stays frozen at the drop
			std::uint32_t ticks = 0;          // tick counter — retarget cadence + first-ticks logging
		};
		DragState         g_drag;                      // main thread only
		std::atomic<bool> g_dragActive{ false };       // read by the poll thread + input sink
		std::atomic<bool> g_dragTickInFlight{ false };
		RE::FormID        g_dragMarker = 0;            // our own settle marker (room_guard pattern)

		constexpr RE::FormID kXMarker = 0x0000003B;    // vanilla XMarker static (Skyrim.esm)
		constexpr float      kDragMin = 90.0f;
		constexpr float      kDragMax = 1500.0f;

		// Camera world position + forward vector. False when no camera yet.
		bool CameraBasis(RE::NiPoint3& pos, RE::NiPoint3& fwd)
		{
			auto camera = RE::PlayerCamera::GetSingleton();
			if (!camera || !camera->cameraRoot)
				return false;
			auto& wt = camera->cameraRoot->world;
			pos = wt.translate;
			fwd = { -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };
			return true;
		}

		RE::TESObjectREFR* EnsureDragMarker(RE::PlayerCharacter* player)
		{
			if (g_dragMarker) {
				if (auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(g_dragMarker))
					return ref;
				g_dragMarker = 0;  // save reloaded under us — place a fresh one
			}
			auto* base = RE::TESForm::LookupByID<RE::TESBoundObject>(kXMarker);
			if (!base) {
				logger::error("NpcActions: XMarker {:08X} missing — Skyrim.esm not loaded?", kXMarker);
				return nullptr;
			}
			auto ptr = player->PlaceObjectAtMe(base, true);  // forcePersist: outlives cell unload
			if (!ptr) {
				logger::error("NpcActions: PlaceObjectAtMe(XMarker) returned null");
				return nullptr;
			}
			g_dragMarker = ptr->GetFormID();
			logger::info("NpcActions: drag settle marker placed ({:08X})", g_dragMarker);
			return ptr.get();
		}

		RE::TESObjectREFR* AimDragMarker(RE::PlayerCharacter* player, RE::TESObjectCELL* cell,
			const RE::NiPoint3& pos, float angleZ)
		{
			auto* marker = EnsureDragMarker(player);
			if (!marker)
				return nullptr;
			marker->SetParentCell(cell);
			marker->SetPosition(pos);
			marker->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, angleZ });
			marker->Update3DPosition(true);
			return marker;
		}

		// The carry is driven by Papyrus TranslateTo, not by per-tick
		// SetPosition. The first live follower play-test proved SetPosition is
		// CommonLib's MoveTo_Impl — the engine's full teleport machinery — and
		// invoking it 30x/second held her in a permanent mid-teleport detached
		// state: INVISIBLE for the whole 26 s drag, reappearing only at the
		// drop's real MoveTo settle. TranslateTo is the engine's own facility
		// for smooth VISIBLE motion through loaded space (dragon landings ride
		// it); we re-aim it every few ticks and the engine interpolates
		// between re-aims.
		void CallTranslateTo(RE::Actor* actor, const RE::NiPoint3& p, float speed)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return;
			auto policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return;
			float x = p.x, y = p.y, z = p.z;
			float ax = actor->GetAngleX(), ay = actor->GetAngleY(), az = actor->GetAngleZ();
			float sp = speed, rot = 0.0f;
			auto  args = RE::MakeFunctionArguments(
				std::move(x), std::move(y), std::move(z),
				std::move(ax), std::move(ay), std::move(az),
				std::move(sp), std::move(rot));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "ObjectReference", "TranslateTo", args, cb);
		}

		void CallStopTranslation(RE::Actor* actor)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return;
			auto policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments();
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "ObjectReference", "StopTranslation", args, cb);
		}

		// One carry tick, main thread (posted by the poll thread). Keeps the
		// NPC's FEET on the aim point, so pointing at the floor walks them
		// along the ground and pointing ahead dangles them — that IS the toy.
		void DragTick()
		{
			if (!g_dragActive.load())
				return;
			auto* actor = RE::TESForm::LookupByID<RE::Actor>(g_drag.id);
			if (!actor || !actor->Is3DLoaded()) {
				DropDrag(actor ? "target unloaded" : "target gone");
				return;
			}
			if (actor->IsDead()) {
				DropDrag("target died");
				return;
			}
			RE::NiPoint3 camPos, fwd;
			if (!CameraBasis(camPos, fwd))
				return;
			const RE::NiPoint3 target{
				camPos.x + fwd.x * g_drag.dist,
				camPos.y + fwd.y * g_drag.dist,
				camPos.z + fwd.z * g_drag.dist
			};

			// Re-aim every 4th tick (~130 ms) — the VM call has latency of a
			// frame or two anyway, and the engine interpolates between
			// re-aims, so a faster cadence buys nothing but VM load.
			if ((g_drag.ticks++ % 4) != 0)
				return;

			// Speed proportional to how far she is from the aim point: far →
			// she catches up fast; near → she glides. Floor keeps her from
			// crawling the last few units.
			const auto  apos = actor->GetPosition();
			const float dx = target.x - apos.x, dy = target.y - apos.y, dz = target.z - apos.z;
			const float gap = std::sqrt(dx * dx + dy * dy + dz * dz);
			const float speed = (std::max)(400.0f, gap * 6.0f);  // parens: Windows.h max macro
			CallTranslateTo(actor, target, speed);

			// First few re-aims tell the whole story in the log: where she is,
			// where we sent her, and whether her 3D stayed attached.
			if (g_drag.ticks <= 12)
				logger::info("NpcActions: grab retarget #{} -> {:.0f}/{:.0f}/{:.0f} "
					"(actor at {:.0f}/{:.0f}/{:.0f}, gap {:.0f}, 3d={})",
					g_drag.ticks / 4, target.x, target.y, target.z,
					apos.x, apos.y, apos.z, gap, actor->Is3DLoaded());
		}

		// ---- Object Manipulation Overhaul bridge ----------------------------
		//
		// Rober's call (2026-08-02), after two home-grown carries fought the
		// engine: don't reinvent the drag — hand the actor to the installed
		// decoration mod whose whole job is this exact UX. OMO tints the
		// scenegraph (the highlight), rides the object on the crosshair RAY so
		// it slides along real surfaces with your movement + mouse, left-click
		// places, right-click restores the original spot. Its DLL exports
		// StartDraggingObject(TESObjectREFR*) for other plugins, and calling
		// it directly BYPASSES its pick filter — so its config (which excludes
		// NPCs from normal decorating picks) needs no change. Verified in its
		// source: no actor rejection, the per-frame move is the ENGINE's own
		// SetPosition native (19363) — not CommonLib's teleporting wrapper —
		// and this rig's PLACE filter allows all, so the drop always commits.
		using OmoStartFn = void (*)(RE::TESObjectREFR*);

		// A grab we handed to OMO that no ending input has been seen for yet.
		// Deliberately just a flag: OMO exports no IsDragging, so the sink in
		// main.cpp watches for the clicks that end a drag and clears this.
		std::atomic<bool> g_omoGrab{ false };

		OmoStartFn OmoStartDrag()
		{
			// Cached after the first probe: SKSE plugins are all loaded long
			// before any deck action can fire.
			static OmoStartFn fn = []() -> OmoStartFn {
				const auto mod = GetModuleHandleA("ObjectManipulationOverhaul");
				if (!mod) {
					logger::warn("NpcActions: ObjectManipulationOverhaul not loaded — grab unavailable");
					return nullptr;
				}
				const auto f = reinterpret_cast<OmoStartFn>(GetProcAddress(mod, "StartDraggingObject"));
				if (!f)
					logger::warn("NpcActions: OMO loaded but exports no StartDraggingObject — too old?");
				return f;
			}();
			return fn;
		}

		void DoGrab()
		{
			auto* actor = TargetActor();
			if (!actor) {
				Notify("No NPC targeted — look at one, then open the deck");
				return;
			}
			if (!actor->Is3DLoaded()) {
				Notify(NameOf(actor) + " isn't loaded — can't grab");
				return;
			}
			// A corpse's 3D is ragdoll-driven — a positional drag wouldn't move
			// what you see, so refuse honestly instead of pretending.
			if (actor->IsDead()) {
				Notify(NameOf(actor) + " is dead — grab works on the living");
				return;
			}
			if (actor->IsInKillMove()) {
				Notify(NameOf(actor) + " is mid kill-move — not now");
				return;
			}
			const auto fn = OmoStartDrag();
			if (!fn) {
				Notify("⚠ Grab needs Object Manipulation Overhaul — its DLL isn't loaded");
				return;
			}

			const auto id = actor->GetFormID();

			// Sitting/sleeping via OUR sit/bed action: release the furniture
			// properly first, or it stays flagged occupied (same order rule as
			// Room Guard's eviction).
			if (const auto it = g_managed.find(id);
				it != g_managed.end() && (it->second == NPCState::Sitting || it->second == NPCState::InBed)) {
				CallFurnQuest("ReleaseFromFurniture", actor, nullptr);
				g_managed.erase(id);
			}
			// Sitting/sleeping for any OTHER reason (sandbox, their own idle):
			// the engine's own "abandon it and stand up".
			if (auto* state = actor->AsActorState();
				state && state->GetSitSleepState() != RE::SIT_SLEEP_STATE::kNormal)
				actor->NotifyAnimationGraph("IdleForceDefaultState"sv);

			fn(actor);
			g_omoGrab.store(true);
			logger::info("NpcActions: grab delegated to OMO for \"{}\" ({:08X})",
				NameOf(actor), static_cast<std::uint32_t>(id));
			Notify("✥ " + NameOf(actor) + " — left-click places, right-click or the deck key puts them back");
		}
	}

	void Init()
	{
		if (auto src = SKSE::GetCrosshairRefEventSource()) {
			src->AddEventSink(CrosshairSink::GetSingleton());
			logger::info("NpcActions: crosshair sink registered");
		} else {
			logger::warn("NpcActions: no crosshair event source");
		}

		// Drag ticker: our own thread posts SINGLE-SHOT main-thread tasks (a
		// task that re-adds itself traps skse's queue pump forever — see the
		// AddTask self-repost freeze). The in-flight flag stops a stalled main
		// thread from accumulating a backlog of ticks.
		std::thread([]() {
			using namespace std::chrono_literals;
			for (;;) {
				std::this_thread::sleep_for(33ms);
				if (!g_dragActive.load())
					continue;
				if (g_dragTickInFlight.exchange(true))
					continue;
				SKSE::GetTaskInterface()->AddTask([]() {
					DragTick();
					g_dragTickInFlight.store(false);
				});
			}
		}).detach();  // lives for the whole process
	}

	void SnapshotTarget()
	{
		auto actor = ResolveCrosshairActor();
		g_target = (actor && !actor->IsPlayerRef()) ? actor->GetFormID() : 0;

		// The item-source banner's snapshot: the crosshair ref verbatim, only
		// when it is NOT an actor (actors have their own flow above). No
		// raycast fallback here — naming the mod behind the wrong nearby
		// object would be worse than staying silent.
		g_itemRef = 0;
		if (!g_target && g_crosshairRef &&
			g_crosshairRef->GetFormType() != RE::FormType::ActorCharacter)
			g_itemRef = g_crosshairRef->GetFormID();
	}

	std::uint32_t TargetFormID()
	{
		return static_cast<std::uint32_t>(g_target);
	}

	std::uint32_t ItemRefFormID()
	{
		return static_cast<std::uint32_t>(g_itemRef);
	}

	bool IsAction(const std::string& a)
	{
		return a == "freeze" || a == "sit" || a == "bed" || a == "release-all" || a == "grab" ||
			a == "attack-target";
	}

	bool DragActive()
	{
		return g_dragActive.load();
	}

	void DropDrag(const char* reason)
	{
		if (!g_dragActive.exchange(false))
			return;
		const auto drag = g_drag;
		g_drag = DragState{};

		auto* actor = RE::TESForm::LookupByID<RE::Actor>(drag.id);
		if (!actor) {
			logger::info("NpcActions: grab drag ended ({}) — actor gone", reason);
			return;
		}

		// Kill any in-flight translation FIRST — a TranslateTo that outlives
		// the drag would keep pulling her toward the last aim point straight
		// through the settle.
		CallStopTranslation(actor);

		// Release the carry pin — unless they were frozen when grabbed, in
		// which case the freeze (and its g_managed entry) survives the ride
		// and they hold their pose at the new spot.
		if (!drag.wasFrozen)
			CallActorBool(actor, "SetDontMove", false);

		// Settle with a real MoveTo: SetPosition moved the 3D but a drag can
		// cross an exterior cell border without re-parenting, and only MoveTo
		// runs the engine's own cell attach. The player's cell is guaranteed
		// loaded and in the right worldspace (the carry range caps well under
		// a cell edge).
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* cell = player ? player->GetParentCell() : nullptr;
		if (player && cell && actor->Is3DLoaded()) {
			if (auto* marker = AimDragMarker(player, cell, actor->GetPosition(), actor->GetAngleZ()))
				actor->MoveTo(marker);
		}

		if (!drag.wasFrozen)
			actor->EvaluatePackage();

		const auto p = actor->GetPosition();
		logger::info("NpcActions: grab drag dropped \"{}\" ({:08X}) at {:.0f}/{:.0f}/{:.0f} ({}){}",
			NameOf(actor), static_cast<std::uint32_t>(drag.id), p.x, p.y, p.z, reason,
			drag.wasFrozen ? " — still frozen" : "");
		Notify(NameOf(actor) + (drag.wasFrozen ? " dropped (still frozen)" : " dropped"));
	}

	void NudgeDragDistance(bool closer)
	{
		if (!g_dragActive.load())
			return;
		g_drag.dist = std::clamp(g_drag.dist * (closer ? 1.0f / 1.15f : 1.15f), kDragMin, kDragMax);
	}

	void OnPostLoadGame()
	{
		// FormIDs may have been remapped by the load — touch no actor, just
		// forget the drag (and the marker, which is re-placed on demand).
		if (g_dragActive.exchange(false))
			logger::info("NpcActions: grab drag cancelled by save load");
		g_drag = DragState{};
		g_dragMarker = 0;
		g_omoGrab.store(false);

		// Alias holds PERSIST in the save (that is the point of the quest);
		// our slot map does not. Rebuild it from the loaded actors that fill
		// our aliases, so freeze-toggles keep working across a load and slot
		// allocation does not double-book. An actor held but not currently
		// loaded reconciles lazily the next time a verb touches her.
		g_aliasHeld.clear();
		if (ControlQuest()) {
			int rebuilt = 0;
			if (auto* lists = RE::ProcessLists::GetSingleton()) {
				auto scan = [&](RE::ActorHandle& h) {
					auto ptr = h.get();
					if (!ptr)
						return;
					auto* actor = ptr.get();
					for (int a : OurAliasIdsOn(actor)) {
						NPCState st = NPCState::None;
						if (a >= kHoldBase && a < kHoldBase + kHoldCount)
							st = NPCState::Frozen;
						else if (a >= kSitBase && a < kSitBase + kSitCount)
							st = NPCState::Sitting;
						else if (a >= kBedBase && a < kBedBase + kBedCount)
							st = NPCState::InBed;
						else
							continue;
						g_aliasHeld[actor->GetFormID()] = { st, a, TargetAliasFor(a) };
						g_managed[actor->GetFormID()] = st;
						++rebuilt;
					}
				};
				for (auto& h : lists->highActorHandles) scan(h);
				for (auto& h : lists->middleHighActorHandles) scan(h);
			}
			if (rebuilt)
				logger::info("NpcActions: alias engine reconciled {} held NPC(s) from the save", rebuilt);
		}
	}

	bool OmoGrabActive()
	{
		return g_omoGrab.load();
	}

	void OmoGrabEnded(const char* how)
	{
		if (g_omoGrab.exchange(false))
			logger::info("NpcActions: OMO grab ended ({})", how);
	}

	bool CancelOmoGrab()
	{
		if (!g_omoGrab.exchange(false))
			return false;
		logger::info("NpcActions: OMO grab cancelled by the deck key");
		Notify("✥ Grab cancelled — putting them back");
		return true;
	}

	bool Run(const std::string& action)
	{
		if (action == "release-all") {
			DoReleaseAll();
			return true;
		}
		if (action == "grab") {
			DoGrab();
			return true;
		}
		if (action == "attack-target") {
			DoSicEm();
			return true;
		}
		if (action != "freeze" && action != "sit" && action != "bed")
			return false;

		auto actor = TargetActor();
		if (!actor) {
			Notify("No NPC targeted — look at one, then open the deck");
			return true;
		}
		if (action == "freeze")
			DoFreeze(actor);
		else
			DoFurniture(actor, action == "bed");
		return true;
	}

	// ---------------------------------------------------------------- debug --

	std::string DebugJson(std::uint32_t formId)
	{
		auto dump = [](const json& j) {
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		};

		auto* form = formId ? RE::TESForm::LookupByID(static_cast<RE::FormID>(formId)) : nullptr;
		auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
		auto* actor = refr ? refr->As<RE::Actor>() : nullptr;
		if (!actor)
			return dump(json{ { "ok", false }, { "msg", "She isn't loaded right now." } });

		auto fileOf = [](const RE::TESForm* f) -> std::string {
			const auto* file = f ? f->GetFile(0) : nullptr;
			return file ? std::string(file->GetFilename()) : std::string();
		};
		auto hex = [](RE::FormID id) {
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%08X", id);
			return std::string(buf);
		};
		auto followish = [](const RE::TESPackage* pkg) {
			if (!pkg)
				return false;
			switch (pkg->packData.packType.get()) {
			case RE::PACKAGE_TYPE::kFollow:
			case RE::PACKAGE_TYPE::kEscort:
			case RE::PACKAGE_TYPE::kAccompany:
				return true;
			default:
				return false;
			}
		};

		json out{ { "ok", true } };
		const char* nm = actor->GetDisplayFullName();
		out["name"] = (nm && nm[0]) ? nm : "(unnamed)";
		out["refId"] = hex(actor->GetFormID());
		out["refPlugin"] = fileOf(actor);
		if (auto* base = actor->GetActorBase()) {
			out["baseId"] = hex(base->GetFormID());
			out["basePlugin"] = fileOf(base);
		}

		out["flags"] = json{
			{ "teammate", actor->IsPlayerTeammate() },
			{ "essential", actor->IsEssential() },
			{ "protected", actor->IsProtected() },
			{ "ghost", actor->IsGhost() },
			{ "dead", actor->IsDead() },
			{ "inCombat", actor->IsInCombat() },
			{ "commanded", actor->IsCommandedActor() },
		};

		// EVERY faction with its rank, base + runtime changes — the engine's
		// own walk, the same truth a console `getfactionrank` sees. The view
		// decides which rows deserve a warning colour; this side only reports.
		json facs = json::array();
		actor->VisitFactions([&](RE::TESFaction* fac, std::int8_t rank) {
			if (fac) {
				const char* fn = fac->GetFullName();
				facs.push_back(json{
					{ "name", (fn && fn[0]) ? fn : "" },
					{ "formId", hex(fac->GetFormID()) },
					{ "plugin", fileOf(fac) },
					{ "rank", static_cast<int>(rank) },
				});
			}
			return false;  // keep walking
		});
		out["factions"] = std::move(facs);

		const auto d = FollowerFrameworks::Probe(actor);
		out["framework"] = json{
			{ "aliasDriven", d.aliasDriven },
			{ "followPackage", d.followPackage },
			{ "known", d.known },
			{ "label", d.label },
			{ "plugin", d.plugin },
			{ "summary", FollowerFrameworks::Summarise(d) },
		};
		const int own = FollowerFrameworks::OwningCompanionSpec(actor);
		out["ownedBy"] = (own >= 0) ? FollowerFrameworks::Label(own) : "";

		// Every quest holding her in an alias right now, follow-ish flagged.
		json aliases = json::array();
		if (auto* arr = actor->extraList.GetByType<RE::ExtraAliasInstanceArray>()) {
			RE::BSReadLockGuard locker(arr->lock);
			for (auto* inst : arr->aliases) {
				if (!inst || !inst->quest)
					continue;
				const char* qe = inst->quest->GetFormEditorID();
				const char* qn = inst->quest->GetFullName();
				bool        fol = false;
				if (inst->instancedPackages)
					for (auto* pkg : *inst->instancedPackages)
						if (followish(pkg)) { fol = true; break; }
				aliases.push_back(json{
					{ "quest", (qe && qe[0]) ? qe : "" },
					{ "questName", (qn && qn[0]) ? qn : "" },
					{ "plugin", fileOf(inst->quest) },
					{ "follow", fol },
				});
			}
		}
		out["aliases"] = std::move(aliases);

		// The package actually in force, and who owns it.
		if (auto* cur = actor->GetCurrentPackage()) {
			json p{
				{ "formId", hex(cur->GetFormID()) },
				{ "plugin", fileOf(cur) },
				{ "type", static_cast<int>(cur->packData.packType.get()) },
				{ "follow", followish(cur) },
			};
			if (cur->ownerQuest) {
				const char* qe = cur->ownerQuest->GetFormEditorID();
				p["quest"] = (qe && qe[0]) ? qe : "";
				p["questPlugin"] = fileOf(cur->ownerQuest);
			}
			out["package"] = std::move(p);
		}

		logger::info("npc-debug: dossier for {} ({} factions)", out["name"].get<std::string>(),
			out["factions"].size());
		return dump(out);
	}
}
