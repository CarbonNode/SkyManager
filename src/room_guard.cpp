#include "room_guard.h"

#include "actor_identity.h"
#include "follower_frameworks.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <unordered_map>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace RoomGuard
{
	namespace
	{
		// Same vanilla XMarker the Domains recall uses (Skyrim.esm 0x0000003B): an
		// inert static that MoveTo can aim at. Room Guard keeps its OWN instance
		// rather than sharing PlaceActions' — both re-aim their marker immediately
		// before every MoveTo, and one marker shared between a travel and an
		// eviction firing in the same frame would send somebody to the wrong place.
		constexpr RE::FormID kXMarker = 0x0000003B;

		RE::FormID g_marker = 0;

		using clock = std::chrono::steady_clock;

		// Per-actor grace state, session-scoped. An actor first seen inside the
		// volume while you are LOOKING at them gets until `deadline` to walk out on
		// their own; after that they are moved regardless. Actors you cannot see
		// are moved on the first tick and never enter this map.
		struct Grace
		{
			clock::time_point deadline;
			clock::time_point touched;  // for pruning actors that left
		};
		std::unordered_map<RE::FormID, Grace> g_grace;

		clock::time_point g_lastTick{};

		// ------------------------------------------------------------ small helpers

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string NameOfForm(RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* full = form->As<RE::TESFullName>()) {
				const auto* n = full->GetFullName();
				if (n && n[0])
					return n;
			}
			const auto* eid = form->GetFormEditorID();
			return (eid && eid[0]) ? eid : "";
		}

		RE::TESObjectCELL* ResolveCell(std::uint32_t cellId, const std::string& editorId)
		{
			if (cellId) {
				if (auto* cell = RE::TESForm::LookupByID<RE::TESObjectCELL>(cellId))
					return cell;
			}
			if (!editorId.empty()) {
				if (auto* cell = RE::TESForm::LookupByEditorID<RE::TESObjectCELL>(editorId))
					return cell;
			}
			return nullptr;
		}

		void Notify(const Config& cfg, const std::string& msg)
		{
			if (cfg.notify)
				RE::DebugNotification(msg.c_str());
		}

		std::string DisplayName(RE::Actor* actor)
		{
			const char* dn = actor ? actor->GetDisplayFullName() : nullptr;
			return (dn && dn[0]) ? dn : "Someone";
		}

		// ---- durable NPC identity (plugin + local id of the BASE form) ----

		NpcRef MakeNpcRef(RE::Actor* actor)
		{
			NpcRef r;
			if (!actor)
				return r;
			auto* base = actor->GetActorBase();
			if (!base)
				return r;
			// GetFilename() returns a string_view that is NOT guaranteed to be
			// null-terminated — construct a std::string from it rather than
			// reading .data() as a C string.
			if (auto* file = base->GetFile(0))
				r.plugin = std::string(file->GetFilename());
			// ⛔ NOT base->GetLocalFormID(): CommonLib's version dereferences
			// GetFile(0) unchecked, and a SPAWNED npc's base (0xFF……) has no
			// source file — which is exactly the CTD of 2026-08-03, a "Traveling
			// Pilgrim" who wandered into a guarded inn room. The guard directly
			// above proves the file can be null; the line below used to ignore it.
			// 0 = no durable identity, and valid() already reads that as "not on
			// any list", so a spawned stranger is simply guarded by position like
			// anybody else — she just can't be put on the ignore/allow list, which
			// is honest: she won't exist next session.
			r.localId = ActorIdentity::LocalIdOf(base);
			r.name = DisplayName(actor);
			return r;
		}

		bool SameNpc(const NpcRef& a, const NpcRef& b)
		{
			return a.localId == b.localId && _stricmp(a.plugin.c_str(), b.plugin.c_str()) == 0;
		}

		bool ListHas(const std::vector<NpcRef>& list, const NpcRef& want)
		{
			return std::any_of(list.begin(), list.end(),
				[&](const NpcRef& x) { return SameNpc(x, want); });
		}

		// Should the watchdog act on this room at all? Normally that means an
		// enabled room that isn't a home — but a PRIVACY LOCKDOWN overrides both,
		// because the button's promise is "nobody in here right now" and it would
		// be a lie in a paused room or in the bedroom of your own house.
		bool RoomActive(const Room& r)
		{
			return r.lockdown || (r.enabled && r.kind != "home");
		}

		// Is this actor a FOLLOWER this room is keeping out? Lockdown keeps
		// everyone out, so it counts here too — which matters because a follower
		// must be PARKED (told to wait through her own follower mod) before she is
		// moved, or her follow package warps her straight back in.
		bool FollowerKeptOut(const Room& rm, RE::Actor* a)
		{
			if (!a || !a->IsPlayerTeammate())
				return false;
			return rm.lockdown || rm.evictFollowers || ListHas(rm.deny, MakeNpcRef(a));
		}

		json NpcRefToJson(const NpcRef& r)
		{
			char key[24];
			std::snprintf(key, sizeof(key), "%08X", static_cast<std::uint32_t>(r.localId));
			return json{ { "plugin", r.plugin }, { "localId", r.localId }, { "name", r.name },
				{ "key", r.plugin + "|" + key } };
		}

		bool NpcRefFromJson(const json& j, NpcRef& out)
		{
			if (!j.is_object())
				return false;
			NpcRef r;
			r.plugin = j.value("plugin", std::string(""));
			r.localId = j.value("localId", 0u);
			r.name = j.value("name", std::string(""));
			if (!r.valid())
				return false;
			out = std::move(r);
			return true;
		}

		// ---- geometry ----

		// Inside the claimed volume? Vertical is a half-height either way; the
		// footprint is a circle, or a box rotated by the yaw captured at claim
		// time. Skyrim heading convention: facing vector = (sin yaw, cos yaw),
		// so local "depth" is the projection onto facing and local "width" onto
		// its right-hand perpendicular.
		bool InsideVolume(const Room& room, const RE::NiPoint3& p, float slack = 0.0f)
		{
			const float dz = std::fabs(p.z - room.z);
			if (dz > room.height + slack)
				return false;
			const float dx = p.x - room.x, dy = p.y - room.y;
			if (room.shape == "box") {
				const float sa = std::sin(room.yaw), ca = std::cos(room.yaw);
				const float lx = dx * ca - dy * sa;  // right
				const float ly = dx * sa + dy * ca;  // forward
				return std::fabs(lx) <= room.halfX + slack &&
					   std::fabs(ly) <= room.halfY + slack;
			}
			const float r = room.radius + slack;
			return (dx * dx + dy * dy) <= (r * r);
		}

		// Forward declaration — ActorInRoom is defined further down but first used
		// above in the room-lookup loop; MSVC needs the signature before that use.
		bool ActorInRoom(const Room& room, const RE::NiPoint3& p);

		// Largest horizontal reach — the spherical-prefilter radius for
		// ForEachReferenceInRange and the radial-eviction push distance.
		float FootprintReach(const Room& room)
		{
			if (room.shape == "box")
				return std::sqrt(room.halfX * room.halfX + room.halfY * room.halfY);
			return room.radius;
		}

		// Is the player looking at this actor? Cheap dot-product cone against the
		// camera's forward vector — the same technique npc_actions.cpp already uses
		// for its crosshair fallback. Deliberately generous (~50 degrees): a false
		// "you can see them" only costs a grace window, while a false "you can't"
		// teleports somebody in front of you, which is the ugly failure.
		bool PlayerCanSee(RE::Actor* actor)
		{
			auto* camera = RE::PlayerCamera::GetSingleton();
			if (!camera || !camera->cameraRoot || !actor)
				return true;  // unknown -> assume seen, i.e. be polite

			auto&        wt = camera->cameraRoot->world;
			RE::NiPoint3 fwd = { -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };

			const auto   apos = actor->GetPosition();
			RE::NiPoint3 to = { apos.x - wt.translate.x, apos.y - wt.translate.y,
				(apos.z + 80.0f) - wt.translate.z };
			const float  dist = to.Length();
			if (dist < 1.0f)
				return true;
			if (dist > 4000.0f)
				return false;
			to.x /= dist; to.y /= dist; to.z /= dist;
			const float dot = fwd.x * to.x + fwd.y * to.y + fwd.z * to.z;
			return dot > 0.64f;  // ~50 degrees off-centre
		}

		// ---- rented-room detection ----
		// There is no "room" entity in the engine, but a RENTED room has two
		// engine-visible fingerprints that together are unambiguous:
		//   1. the cell's LOCATION carries the LocTypeInn keyword (vanilla and
		//      nearly all mod inns set it — the innkeeper/rumour systems need it);
		//   2. the vanilla rental script sets exactly ONE bed's ownership to the
		//      player for the rental period.
		// So "the bed in this inn that you own" IS the rented room's id. The inn
		// gate matters: in a player HOME everything is player-owned, so without
		// it this would light up on every piece of furniture you actually own.
		bool CellIsInn(RE::TESObjectCELL* cell)
		{
			auto* loc = cell ? cell->GetLocation() : nullptr;
			return loc && loc->HasKeywordString("LocTypeInn");
		}

		// Finds the player-owned furniture ref in an inn cell. Returns nullptr
		// when there is none (nothing rented, or the 24h rental lapsed and the
		// script took the ownership back — which is exactly when the offer
		// should disappear).
		RE::TESObjectREFR* FindRentedBed(RE::TESObjectCELL* cell)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* playerBase = player ? player->GetActorBase() : nullptr;
			if (!playerBase || !CellIsInn(cell))
				return nullptr;
			RE::TESObjectREFR* found = nullptr;
			// POINTER, and an explicit return type — matching ForEachReferenceInRange
			// below and npc_actions.cpp. CommonLib takes
			// std::function<ForEachResult(TESObjectREFR*)>; a by-reference lambda
			// does not convert, which is why this file has never compiled and why
			// the live DLL carries room-guard-claim/evict/own but not the
			// inn-detect or auto-claim markers.
			cell->ForEachReference([&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
				if (!ref)
					return RE::BSContainer::ForEachResult::kContinue;
				auto* base = ref->GetBaseObject();
				if (!base || base->GetFormType() != RE::FormType::Furniture)
					return RE::BSContainer::ForEachResult::kContinue;
				if (ref->IsDisabled() || ref->IsDeleted())
					return RE::BSContainer::ForEachResult::kContinue;
				if (ref->GetOwner() != playerBase)
					return RE::BSContainer::ForEachResult::kContinue;
				found = ref;
				return RE::BSContainer::ForEachResult::kStop;
			});
			return found;
		}

		// ---- Papyrus dispatch (the proven route for ref ops) ----
		// npc_actions.cpp already drives Actor.SetRestrained / SetDontMove this way.
		// Going through the VM rather than hunting native addresses is the reason
		// those calls have never needed a re-verify across runtimes.

		// Ownership setters, dispatched through the VM like the bool calls above.
		// SetActorOwner(None) is the documented Papyrus way to CLEAR ownership, so
		// a null npc here is deliberate and meaningful.
		void SetRefActorOwner(RE::TESObjectREFR* ref, RE::TESNPC* npc)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !ref)
				return;
			auto* policy = vm->GetObjectHandlePolicy();
			auto  handle = policy->GetHandleForObject(RE::TESObjectREFR::FORMTYPE, ref);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(std::move(npc));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "ObjectReference", "SetActorOwner", args, cb);
		}

		void SetRefFactionOwner(RE::TESObjectREFR* ref, RE::TESFaction* faction)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !ref || !faction)
				return;
			auto* policy = vm->GetObjectHandlePolicy();
			auto  handle = policy->GetHandleForObject(RE::TESObjectREFR::FORMTYPE, ref);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(std::move(faction));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "ObjectReference", "SetFactionOwner", args, cb);
		}

		// ---- the recall marker ----

		RE::TESObjectREFR* EnsureMarker(RE::PlayerCharacter* player)
		{
			if (g_marker) {
				if (auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(g_marker))
					return ref;
				g_marker = 0;  // save reloaded under us — place a fresh one
			}
			auto* base = RE::TESForm::LookupByID<RE::TESBoundObject>(kXMarker);
			if (!base) {
				logger::error("rooms: XMarker {:08X} missing — Skyrim.esm not loaded?", kXMarker);
				return nullptr;
			}
			auto ptr = player->PlaceObjectAtMe(base, true);  // forcePersist: outlives cell unload
			if (!ptr) {
				logger::error("rooms: PlaceObjectAtMe(XMarker) returned null");
				return nullptr;
			}
			g_marker = ptr->GetFormID();
			logger::info("rooms: eviction marker placed ({:08X})", g_marker);
			return ptr.get();
		}

		RE::TESObjectREFR* AimMarker(RE::PlayerCharacter* player, RE::TESObjectCELL* cell,
			const RE::NiPoint3& pos, float angleZ)
		{
			auto* marker = EnsureMarker(player);
			if (!marker)
				return nullptr;
			marker->SetParentCell(cell);
			marker->SetPosition(pos);
			marker->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, angleZ });
			marker->Update3DPosition(true);
			return marker;
		}

		// Where does this actor get put? The room's anchor when it has one. With no
		// anchor, push them radially outward past the volume edge — each actor
		// along their OWN outward vector, so a busy inn doesn't stack six people on
		// one tile. Their own Z is kept: the floor under them is known-good, and a
		// guessed Z is how you end up embedded in a staircase.
		RE::NiPoint3 EvictionPoint(const Room& room, const RE::NiPoint3& actorPos, float& angleOut)
		{
			if (room.hasAnchor) {
				angleOut = room.aangle;
				return RE::NiPoint3{ room.ax, room.ay, room.az };
			}
			float dx = actorPos.x - room.x, dy = actorPos.y - room.y;
			float len = std::sqrt(dx * dx + dy * dy);
			if (len < 1.0f) {  // dead centre — pick an arbitrary but stable direction
				dx = 1.0f; dy = 0.0f; len = 1.0f;
			}
			dx /= len; dy /= len;
			const float out = FootprintReach(room) + 160.0f;
			angleOut = std::atan2(dx, dy);  // face away from the room
			return RE::NiPoint3{ room.x + dx * out, room.y + dy * out, actorPos.z };
		}

		// Take an actor out of whatever they are sitting/sleeping in, then move them.
		// Order matters: MoveTo on a seated actor can leave the furniture flagged as
		// occupied and the actor stuck in the sit animation at the destination.
		bool EvictActor(RE::PlayerCharacter* player, const Room& room, RE::Actor* actor)
		{
			// IdleForceDefaultState is the engine's own "abandon whatever you're
			// doing and stand up" — the same notify the vanilla furniture-exit path
			// sends.
			actor->NotifyAnimationGraph("IdleForceDefaultState"sv);

			auto* cell = ResolveCell(room.cellId, room.cellEdid);
			if (!cell)
				cell = actor->GetParentCell();
			if (!cell)
				return false;

			float      angle = 0.0f;
			const auto dest = EvictionPoint(room, actor->GetPosition(), angle);

			auto* marker = AimMarker(player, cell, dest, angle);
			if (!marker) {
				logger::warn("rooms: no eviction marker — '{}' left in place", DisplayName(actor));
				return false;
			}
			actor->MoveTo(marker);

			// Re-evaluate so sandbox picks a fresh target instead of walking the
			// same path straight back to the chair it was just taken off.
			actor->EvaluatePackage();

			logger::info("rooms: evicted '{}' ({:08X}) from '{}' -> {:.0f}/{:.0f}/{:.0f}{}",
				DisplayName(actor), static_cast<std::uint32_t>(actor->GetFormID()), room.name,
				dest.x, dest.y, dest.z, room.hasAnchor ? " (anchor)" : " (radial)");
			return true;
		}

		// ---- who is exempt ----

		// Reasons an actor is never touched. Returned as a string so the pane can
		// SHOW why somebody in your room is being left alone — "why is he still
		// there" is the first question this feature will get asked.
		const char* ExemptReason(const Config& cfg, const Room& room, RE::Actor* actor,
			RE::PlayerCharacter* player)
		{
			if (!actor || actor == player || actor->IsPlayerRef())
				return "you";
			if (actor->IsDead())
				return "dead";
			if (!actor->Is3DLoaded())
				return "not loaded";

			// Never move somebody mid-conversation with you: yanking the speaker out
			// of dialogue is how a quest scene breaks. These safety exemptions sit
			// ABOVE the per-room blacklist on purpose — a ban must not break a scene
			// either; the watchdog simply gets them on a later tick.
			if (auto* mtm = RE::MenuTopicManager::GetSingleton()) {
				auto speaker = mtm->speaker.get();
				if (speaker && speaker.get() == static_cast<RE::TESObjectREFR*>(actor))
					return "talking to you";
			}
			// Combat and kill-moves are engine-driven animations; interrupting one
			// with a teleport is a reliable way to produce a stuck actor.
			if (actor->IsInKillMove())
				return "kill move";
			if (actor->IsInCombat())
				return "in combat";

			const auto ref = MakeNpcRef(actor);
			// The global ignore list is the explicit "never moved, anywhere"
			// promise and outranks even a per-room ban — and the privacy lockdown
			// below, which is a convenience toggle and must not quietly cancel a
			// promise made on a different screen. The pane shows these people as
			// still exempt WITH the reason, so a sealed room that still has
			// somebody in it explains itself instead of looking broken.
			if (ref.valid() && ListHas(cfg.ignore, ref))
				return "ignored";

			// PRIVACY LOCKDOWN: nobody at all, right now. Beats the follower
			// exemption and this room's allow list — which is the entire point of
			// the button, and why it is a temporary flag rather than an edit to
			// either list: flip it off and the normal welcome is back, untouched.
			if (room.lockdown)
				return nullptr;

			if (ref.valid()) {
				// Per-room BLACKLIST: banned here means shown out of THIS room even
				// when the follower exemption or a stale allow entry would welcome
				// them. A banned follower goes through the normal park-then-evict
				// path, so she waits outside instead of warping straight back.
				if (ListHas(room.deny, ref))
					return nullptr;
				// Followers walk in freely UNLESS this room opts to push them out
				// too. The global allowFollowers is the master (off = evicted
				// everywhere); room.evictFollowers is the per-room keep-out.
				if (cfg.allowFollowers && !room.evictFollowers && actor->IsPlayerTeammate())
					return "follower";
				if (ListHas(room.allow, ref))
					return "allowed here";
				return nullptr;
			}
			// No durable identity (a spawned 0xFF base) — no list can name her, so
			// only the follower exemption applies.
			if (cfg.allowFollowers && !room.evictFollowers && actor->IsPlayerTeammate())
				return "follower";
			return nullptr;
		}

		// The room the player is standing in: enabled, guarded, matching cell and
		// inside the volume. Returns nullptr when the player isn't in one — which
		// is the common case and the reason the whole tick is nearly free.
		// Which room should "here" mean? The one whose VOLUME contains the player
		// when there is one — otherwise any claimed room in the player's CELL.
		// The cell fallback is load-bearing: the Traveller's Inn play-test claimed
		// a volume too small to stand in, and every surface (occupant list, Clear
		// button, the watchdog itself) went silently inert because "here" required
		// being INSIDE the mis-sized volume. You must not have to stand inside a
		// wrong claim to see it, fix it, or have it work.
		const Room* GuardTargetConst(const Config& cfg, RE::PlayerCharacter* player, bool guardedOnly)
		{
			if (!player)
				return nullptr;
			auto* cell = player->GetParentCell();
			if (!cell)
				return nullptr;
			const auto cellId = static_cast<std::uint32_t>(cell->GetFormID());
			const auto ppos = player->GetPosition();

			const Room* inCell = nullptr;
			for (const auto& room : cfg.rooms) {
				// Guarded = anything not a "home", plus anything under a privacy
				// lockdown. "private" (a bedroom claimed inside a shared home/mod
				// cell) guards exactly like "inn" — the kind is a label for the
				// pane, not a different mechanism.
				if (guardedOnly && !RoomActive(room))
					continue;
				if (room.cellId != cellId)
					continue;
				if (ActorInRoom(room, ppos))
					return &room;
				if (!inCell)
					inCell = &room;
			}
			return inCell;
		}

		Room* GuardTarget(Config& cfg, RE::PlayerCharacter* player, bool guardedOnly)
		{
			return const_cast<Room*>(GuardTargetConst(cfg, player, guardedOnly));
		}

		// ---- boundary ring (the "how far does my room reach" visualizer) ----

		std::vector<RE::FormID> g_ring;          // session-scoped temporaries
		clock::time_point       g_ringHideAt{};  // auto-hide deadline
		RE::TESBoundObject*     g_ringBase = nullptr;
		bool                    g_ringTried = false;

		// First candidate editor id that resolves wins. Editor-id lookup works on
		// this load order because po3 Tweaks caches ids for every form type; a rig
		// without it just logs and the visualizer sits out.
		RE::TESBoundObject* RingBase(const Config& cfg)
		{
			if (g_ringBase || g_ringTried)
				return g_ringBase;
			g_ringTried = true;
			for (const auto& ed : cfg.ringEdids) {
				auto* form = RE::TESForm::LookupByEditorID(ed);
				// Only record types verified to place-and-render via PlaceObjectAtMe
				// (MSTT is what the mist was; STAT and ACTI are its siblings).
				// As<TESBoundObject>() alone is too loose — a SPELL passes it, and
				// one nearly shipped as a default candidate.
				const auto ft = form ? form->GetFormType() : RE::FormType::None;
				const bool placeable = ft == RE::FormType::Static ||
					ft == RE::FormType::MovableStatic || ft == RE::FormType::Activator;
				auto* obj = placeable ? form->As<RE::TESBoundObject>() : nullptr;
				if (obj) {
					g_ringBase = obj;
					logger::info("rooms: ring uses '{}' ({:08X})", ed,
						static_cast<std::uint32_t>(obj->GetFormID()));
					return g_ringBase;
				}
			}
			logger::warn("rooms: no ring form resolved ({} candidate editor ids) — "
				"visualizer off; edit rooms.ringEdids in hotkeys.json",
				cfg.ringEdids.size());
			return nullptr;
		}

		// Claim ownership of the furniture and idle markers inside the volume — the
		// engine's OWN mechanism for a rented room (the vanilla rental script does
		// exactly this to the bed): sandbox skips targets owned by someone else, so
		// the room's furniture stops being pickable and the patrons stop having a
		// reason to walk in. Idle markers (lean-here / stand-here spots) are
		// included because sandbox uses them as heavily as chairs. Beds are included
		// too — unlike the old BlockActivation approach, ownership never locks the
		// PLAYER out of anything. Every claimed ref is recorded with its original
		// owner; a ref that is ALREADY player-owned (the rental script's own bed) is
		// skipped entirely, so releasing a room can never un-own your rented bed.
		// Returns true if the recorded set changed.
		bool ClaimRoomFurniture(Room& room)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* playerBase = player ? player->GetActorBase() : nullptr;
			auto* cell = ResolveCell(room.cellId, room.cellEdid);
			if (!playerBase || !cell)
				return false;

			std::unordered_set<std::uint32_t> have;
			for (const auto& rec : room.owned)
				have.insert(rec.ref);

			bool changed = false;

			// Range prefilter, then the exact cylinder test. The engine's range walk
			// is spherical, so the radius has to be the cylinder's corner distance
			// or the tall/wide extremes get missed; InsideVolume then trims the
			// sphere back down to the actual claim.
			const RE::NiPoint3 centre{ room.x, room.y, room.z };
			const float reach = FootprintReach(room);
			const float span = std::sqrt(reach * reach + room.height * room.height);

			cell->ForEachReferenceInRange(centre, span,
				[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
					if (!ref)
						return RE::BSContainer::ForEachResult::kContinue;
					auto* base = ref->GetBaseObject();
					if (!base)
						return RE::BSContainer::ForEachResult::kContinue;
					const auto ft = base->GetFormType();
					if (ft != RE::FormType::Furniture && ft != RE::FormType::IdleMarker)
						return RE::BSContainer::ForEachResult::kContinue;
					if (ref->IsDisabled() || ref->IsDeleted())
						return RE::BSContainer::ForEachResult::kContinue;
					if (!InsideVolume(room, ref->GetPosition()))
						return RE::BSContainer::ForEachResult::kContinue;

					const auto id = static_cast<std::uint32_t>(ref->GetFormID());
					if (have.count(id))
						return RE::BSContainer::ForEachResult::kContinue;  // already ours

					auto* owner = ref->GetOwner();
					if (owner == playerBase)  // the rental script's own work — leave it alone
						return RE::BSContainer::ForEachResult::kContinue;

					Room::OwnedRef rec;
					rec.ref = id;
					rec.owner = owner ? static_cast<std::uint32_t>(owner->GetFormID()) : 0;
					SetRefActorOwner(ref, playerBase);
					room.owned.push_back(rec);
					have.insert(id);
					changed = true;
					return RE::BSContainer::ForEachResult::kContinue;
				});

			if (changed)
				logger::info("rooms: took ownership of {} ref(s) in '{}'", room.owned.size(), room.name);
			return changed;
		}

		// Restore the original owner of every recorded ref. Shared by room release
		// and the vanished-room path in MergeViewSlice, which has only raw recs.
		void RestoreOwnedRecs(const std::vector<Room::OwnedRef>& recs, const char* who)
		{
			for (const auto& rec : recs) {
				auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(rec.ref);
				if (!ref)
					continue;
				if (rec.owner == 0) {
					SetRefActorOwner(ref, nullptr);  // was unowned — clear
					continue;
				}
				auto* form = RE::TESForm::LookupByID(rec.owner);
				if (auto* npc = form ? form->As<RE::TESNPC>() : nullptr)
					SetRefActorOwner(ref, npc);
				else if (auto* fac = form ? form->As<RE::TESFaction>() : nullptr)
					SetRefFactionOwner(ref, fac);
				else {
					SetRefActorOwner(ref, nullptr);
					logger::warn("rooms: {} — original owner {:08X} of ref {:08X} no longer resolves; cleared",
						who, rec.owner, rec.ref);
				}
			}
		}

		bool RestoreRoomFurniture(Room& room)
		{
			if (room.owned.empty())
				return false;
			RestoreOwnedRecs(room.owned, room.name.c_str());
			logger::info("rooms: '{}' restored ownership of {} ref(s)", room.name, room.owned.size());
			room.owned.clear();
			return true;
		}

		// ---- followers: whole-cell test, parking and resuming ----

		// "Is this actor a target of THIS room?" A whole-cell claim ("mark the cell
		// private") ignores the volume — cell membership is checked by the caller,
		// so anyone in the cell is inside. Otherwise the usual cylinder/box test.
		bool ActorInRoom(const Room& room, const RE::NiPoint3& p)
		{
			return room.wholeCell || InsideVolume(room, p);
		}

		// Resolve a parked follower to a live Actor — runtime ref first (valid for
		// a follower who was loaded when we parked her, and stable across saves for
		// a unique persistent NPC), then the durable plugin+localId pair.
		RE::Actor* ResolveParked(const Room::ParkedRef& p)
		{
			if (p.ref) {
				if (auto* a = RE::TESForm::LookupByID<RE::Actor>(p.ref))
					return a;
			}
			if (p.localId && !p.plugin.empty()) {
				char hex[16];
				std::snprintf(hex, sizeof hex, "%X", p.localId);
				return ActorIdentity::ResolveActor(hex, p.plugin);
			}
			return nullptr;
		}

		// Tell every follower this room parked to follow again, then forget them.
		// Only specs we actually set (spec >= 0) are resumed; an unparkable entry
		// (unknown framework) was never made to wait, so there is nothing to undo.
		// cfg (optional) lets a real re-follow put a corner message on screen — "X
		// follows you again" — so leaving a private cell is visible, not silent.
		bool ResumeParked(std::vector<Room::ParkedRef>& parked, const char* who,
			const Config* cfg = nullptr)
		{
			if (parked.empty())
				return false;
			int         resumed = 0;
			std::string names;
			for (const auto& p : parked) {
				if (p.spec < 0)
					continue;
				if (auto* actor = ResolveParked(p)) {
					if (FollowerFrameworks::SendResume(actor, p.spec)) {
						++resumed;
						if (!names.empty())
							names += ", ";
						names += p.name.empty() ? std::string("Someone") : p.name;
					}
				}
			}
			logger::info("rooms: {} — resumed {} of {} parked follower(s)", who, resumed,
				parked.size());
			if (cfg && resumed > 0)
				Notify(*cfg, "🚶 " + names + (resumed == 1 ? " follows you again" : " follow you again"));
			parked.clear();
			return true;
		}

		// Park a follower before moving her out: send her framework's OWN "wait"
		// (the same door her dialogue uses) so she stops following and STAYS where
		// we drop her, instead of warping back on the next cell attach — the whole
		// reason pure eviction of a follower is a bouncer loop. Records her for a
		// later resume. Returns true when she was actually made to wait (a known
		// framework); false when her framework has no native wait — she is still
		// recorded (so we don't re-probe every tick) but only eviction applies, and
		// the caller says so out loud.
		bool ParkFollower(Room& room, RE::Actor* actor)
		{
			const auto id = static_cast<std::uint32_t>(actor->GetFormID());
			for (const auto& p : room.parked)
				if (p.ref == id)
					return p.spec >= 0;  // already handled this stay

			auto det = FollowerFrameworks::Probe(actor);
			int  spec = -1;
			if (det.known && det.FrameworkDriven() && !FollowerFrameworks::AlreadyWaiting(actor)) {
				if (FollowerFrameworks::SendWait(actor, det))
					spec = det.spec;
			}

			Room::ParkedRef rec;
			rec.ref = id;
			rec.spec = spec;
			rec.name = DisplayName(actor);
			const auto nref = MakeNpcRef(actor);
			rec.plugin = nref.plugin;
			rec.localId = nref.localId;
			room.parked.push_back(std::move(rec));

			if (spec >= 0)
				logger::info("rooms: parked '{}' via {} before eviction from '{}'",
					DisplayName(actor), FollowerFrameworks::Label(spec), room.name);
			else
				logger::info("rooms: '{}' has no native wait — evicting without park from '{}' "
					"(she may warp back; dismiss her manually)",
					DisplayName(actor), room.name);
			return spec >= 0;
		}

		json RoomToJson(const Room& r)
		{
			json allow = json::array();
			for (const auto& a : r.allow)
				allow.push_back(NpcRefToJson(a));
			json deny = json::array();
			for (const auto& d : r.deny)
				deny.push_back(NpcRefToJson(d));
			return json{
				{ "id", r.id }, { "name", r.name }, { "note", r.note }, { "kind", r.kind },
				{ "cellId", r.cellId }, { "cellEdid", r.cellEdid }, { "cellName", r.cellName },
				{ "x", r.x }, { "y", r.y }, { "z", r.z },
				{ "shape", r.shape },
				{ "radius", r.radius }, { "height", r.height },
				{ "halfX", r.halfX }, { "halfY", r.halfY }, { "yaw", r.yaw },
				{ "enabled", r.enabled },
				{ "lockdown", r.lockdown },
				{ "evictFollowers", r.evictFollowers },
				{ "wholeCell", r.wholeCell },
				{ "hasAnchor", r.hasAnchor },
				{ "ax", r.ax }, { "ay", r.ay }, { "az", r.az }, { "aangle", r.aangle },
				{ "repel", r.repel },
				{ "owned", [&] {
					json a = json::array();
					for (const auto& o : r.owned)
						a.push_back(json{ { "ref", o.ref }, { "owner", o.owner } });
					return a;
				}() },
				{ "parked", [&] {
					json a = json::array();
					for (const auto& p : r.parked)
						a.push_back(json{ { "ref", p.ref }, { "plugin", p.plugin },
							{ "localId", p.localId }, { "spec", p.spec }, { "name", p.name } });
					return a;
				}() },
				{ "allow", allow },
				{ "deny", deny } };
		}

		Room* FindRoom(Config& cfg, const std::string& id)
		{
			auto it = std::find_if(cfg.rooms.begin(), cfg.rooms.end(),
				[&](const Room& r) { return r.id == id; });
			return it == cfg.rooms.end() ? nullptr : &*it;
		}

		std::string NewRoomId(const Config& cfg)
		{
			std::size_t n = cfg.rooms.size() + 1;
			std::string id;
			do {
				id = "r" + std::to_string(n++);
			} while (std::any_of(cfg.rooms.begin(), cfg.rooms.end(),
				[&](const Room& x) { return x.id == id; }));
			return id;
		}

		RE::Actor* CrosshairActor()
		{
			// The crosshair ref the deck already tracks lives in npc_actions; rather
			// than reach across modules, resolve the same way from the process lists
			// using the camera cone — good enough for "look at her and press the
			// button" and with no cross-module state to keep in sync.
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* camera = RE::PlayerCamera::GetSingleton();
			auto* lists = RE::ProcessLists::GetSingleton();
			if (!player || !camera || !camera->cameraRoot || !lists)
				return nullptr;

			auto&        wt = camera->cameraRoot->world;
			RE::NiPoint3 fwd = { -wt.rotate.entry[0][2], -wt.rotate.entry[1][2], -wt.rotate.entry[2][2] };

			RE::Actor* best = nullptr;
			float      bestScore = 0.0f;
			for (auto& h : lists->highActorHandles) {
				auto ptr = h.get();
				auto* actor = ptr ? ptr.get() : nullptr;
				if (!actor || actor == player || actor->IsDead() || !actor->Is3DLoaded())
					continue;
				RE::NiPoint3 to = { actor->GetPositionX() - wt.translate.x,
					actor->GetPositionY() - wt.translate.y,
					(actor->GetPositionZ() + 80.0f) - wt.translate.z };
				const float dist = to.Length();
				if (dist > 800.0f || dist < 1.0f)
					continue;
				to.x /= dist; to.y /= dist; to.z /= dist;
				const float dot = fwd.x * to.x + fwd.y * to.y + fwd.z * to.z;
				if (dot < 0.95f)
					continue;
				const float score = dot + (1.0f - dist / 800.0f);
				if (score > bestScore) { bestScore = score; best = actor; }
			}
			return best;
		}
	}  // namespace

	// ------------------------------------------------------------------- lifecycle

	void Init()
	{
		g_marker = 0;
		g_grace.clear();
		g_lastTick = clock::time_point{};
		if (RE::TESForm::LookupByID(kXMarker))
			logger::info("RoomGuard: XMarker resolved — eviction available");
		else
			logger::warn("RoomGuard: XMarker {:08X} not found — eviction will refuse", kXMarker);
		// Build marker (see hd-markers.json): whole-cell private + follower park/evict.
		logger::info("RoomGuard: private-cell + follower-park ready");
		// Build marker: per-room blacklist + the rgNpcs picker candidate feed.
		logger::info("RoomGuard: room blacklist + npc picker ready");
		// Build marker: the privacy lockdown ("nobody in here right now") toggle.
		logger::info("RoomGuard: privacy lockdown ready");
	}

	// ----------------------------------------------------------------- persistence

	nlohmann::json ToJson(const Config& c)
	{
		json rooms = json::array();
		for (const auto& r : c.rooms)
			rooms.push_back(RoomToJson(r));
		json ignore = json::array();
		for (const auto& n : c.ignore)
			ignore.push_back(NpcRefToJson(n));

		return json{
			{ "rooms", rooms },
			{ "ignore", ignore },
			{ "enabled", c.enabled },
			{ "allowFollowers", c.allowFollowers },
			{ "notify", c.notify },
			{ "autoClaim", c.autoClaim },
			{ "autoClaimed", c.autoClaimed },
			{ "ringEdids", c.ringEdids },
			{ "ringBaseRadius", c.ringBaseRadius },
			{ "graceMs", c.graceMs },
			{ "tickMs", c.tickMs } };
	}

	void FromJson(const nlohmann::json& j, Config& out)
	{
		Config c;
		if (j.is_object()) {
			c.enabled = j.value("enabled", true);
			c.allowFollowers = j.value("allowFollowers", true);
			c.notify = j.value("notify", true);
			c.autoClaim = j.value("autoClaim", true);
			c.ringBaseRadius = std::clamp(j.value("ringBaseRadius", 60.0f), 1.0f, 2000.0f);
			if (j.contains("ringEdids") && j["ringEdids"].is_array()) {
				for (const auto& e : j["ringEdids"])
					if (e.is_string() && !e.get<std::string>().empty())
						c.ringEdids.push_back(e.get<std::string>());
			}
			if (j.contains("autoClaimed") && j["autoClaimed"].is_array()) {
				for (const auto& a : j["autoClaimed"])
					if (a.is_number_unsigned())
						c.autoClaimed.push_back(a.get<std::uint32_t>());
			}
			c.graceMs = std::clamp(j.value("graceMs", 4000u), 0u, 30000u);
			c.tickMs = std::clamp(j.value("tickMs", 1500u), 250u, 10000u);

			if (j.contains("ignore") && j["ignore"].is_array()) {
				for (const auto& jn : j["ignore"]) {
					NpcRef n;
					if (NpcRefFromJson(jn, n) && !ListHas(c.ignore, n))
						c.ignore.push_back(std::move(n));
				}
			}
		// Repair the em dash the OLD builds mangled into stored names. Until
		// 2026-08-04 the DLL compiled without /utf-8, so MSVC re-encoded the
		// literal " — room" suffix through Windows-1252 — once per build layer —
		// and the garbage was PERSISTED into hotkeys.json ("Traveller's Inn
		// Ã¢â‚¬â€ room" on screen). The flag fixes what new claims write; this
		// fixes what old claims already wrote. Both observed mangle depths, the
		// deeper first so its inner bytes are not half-eaten by the shallow one.
		// The old fix un-mangled two KNOWN mojibake depths back to a real em dash,
		// but a FRESH round-trip (e.g. the hotkey-icon patcher reading the file
		// with PowerShell 5.1's ANSI Get-Content, then rewriting UTF-8) just
		// re-corrupts it to a depth this doesn't know. Durable fix: after
		// un-mangling, force the name to plain ASCII — em dash -> " - ", curly
		// quotes -> straight, any remaining >0x7F byte dropped. Nothing
		// corruptible survives, so no future round-trip can mojibake it again.
		const auto fixDash = [](std::string s2) {
			static const std::string kDouble =
				"\xC3\x83\xC2\xA2\xC3\xA2\xE2\x80\x9A\xC2\xAC\xC3\xA2\xE2\x82\xAC\xC2\x9D";
			static const std::string kSingle = "\xC3\xA2\xE2\x82\xAC\xE2\x80\x9D";
			for (const auto* bad : { &kDouble, &kSingle }) {
				std::size_t at = 0;
				while ((at = s2.find(*bad, at)) != std::string::npos) {
					s2.replace(at, bad->size(), " - ");
					at += 3;
				}
			}
			auto sub = [&](const char* from, const char* to) {
				const std::string f(from), t(to);
				std::size_t       at = 0;
				while ((at = s2.find(f, at)) != std::string::npos) { s2.replace(at, f.size(), t); at += t.size(); }
			};
			sub("\xE2\x80\x94", " - "); sub("\xE2\x80\x93", " - ");   // em / en dash
			sub("\xE2\x80\x99", "'");  sub("\xE2\x80\x98", "'");      // curly single quotes
			sub("\xE2\x80\x9C", "\""); sub("\xE2\x80\x9D", "\"");     // curly double quotes
			std::string out;
			out.reserve(s2.size());
			bool prevSpace = false;
			for (unsigned char c : s2) {
				if (c >= 0x80)
					continue;                       // drop anything that could re-mojibake
				const bool sp = (c == ' ');
				if (sp && prevSpace)
					continue;                       // collapse doubled spaces the subs may leave
				out.push_back(static_cast<char>(c));
				prevSpace = sp;
			}
			while (!out.empty() && out.back() == ' ')
				out.pop_back();
			return out;
		};

			if (j.contains("rooms") && j["rooms"].is_array()) {
				for (const auto& jr : j["rooms"]) {
					if (!jr.is_object())
						continue;
					Room r;
					r.id = jr.value("id", std::string(""));
					r.name = fixDash(jr.value("name", std::string("Unnamed room")));
					r.note = jr.value("note", std::string(""));
					r.kind = jr.value("kind", std::string("inn"));
					if (r.kind != "inn" && r.kind != "home" && r.kind != "private")
						r.kind = "inn";
					r.cellId = jr.value("cellId", 0u);
					r.cellEdid = jr.value("cellEdid", std::string(""));
					r.cellName = jr.value("cellName", std::string(""));
					r.x = jr.value("x", 0.0f);
					r.y = jr.value("y", 0.0f);
					r.z = jr.value("z", 0.0f);
					r.shape = jr.value("shape", std::string("circle"));
					if (r.shape != "circle" && r.shape != "box")
						r.shape = "circle";
					r.radius = std::clamp(jr.value("radius", 200.0f), 80.0f, 4000.0f);
					r.halfX = std::clamp(jr.value("halfX", 200.0f), 60.0f, 4000.0f);
					r.halfY = std::clamp(jr.value("halfY", 260.0f), 60.0f, 4000.0f);
					r.yaw = jr.value("yaw", 0.0f);
					r.height = std::clamp(jr.value("height", 130.0f), 60.0f, 2000.0f);
					r.enabled = jr.value("enabled", true);
					// Lockdown persists deliberately: a seal you set before quitting
					// is still a seal when you load, and the pane shouts about it
					// (row chip + a banner) so it can never be a silent surprise.
					r.lockdown = jr.value("lockdown", false);
					r.evictFollowers = jr.value("evictFollowers", false);
					r.wholeCell = jr.value("wholeCell", false);
					r.hasAnchor = jr.value("hasAnchor", false);
					r.ax = jr.value("ax", 0.0f);
					r.ay = jr.value("ay", 0.0f);
					r.az = jr.value("az", 0.0f);
					r.aangle = jr.value("aangle", 0.0f);
					// repel defaults ON — ownership is the engine's own rented-room
					// mechanism and it never locks the player out. (The pre-ownership
					// "blockFurniture" key is ignored: that design never shipped enabled.)
					r.repel = jr.value("repel", true);
					if (jr.contains("owned") && jr["owned"].is_array()) {
						for (const auto& jo : jr["owned"]) {
							if (!jo.is_object())
								continue;
							Room::OwnedRef rec;
							rec.ref = jo.value("ref", 0u);
							rec.owner = jo.value("owner", 0u);
							if (rec.ref)
								r.owned.push_back(rec);
						}
					}
					if (jr.contains("parked") && jr["parked"].is_array()) {
						for (const auto& jp : jr["parked"]) {
							if (!jp.is_object())
								continue;
							Room::ParkedRef rec;
							rec.ref = jp.value("ref", 0u);
							rec.plugin = jp.value("plugin", std::string(""));
							rec.localId = jp.value("localId", 0u);
							rec.spec = jp.value("spec", -1);
							rec.name = jp.value("name", std::string(""));
							if (rec.ref || (rec.localId && !rec.plugin.empty()))
								r.parked.push_back(std::move(rec));
						}
					}
					if (jr.contains("allow") && jr["allow"].is_array()) {
						for (const auto& ja : jr["allow"]) {
							NpcRef a;
							if (NpcRefFromJson(ja, a) && !ListHas(r.allow, a))
								r.allow.push_back(std::move(a));
						}
					}
					if (jr.contains("deny") && jr["deny"].is_array()) {
						for (const auto& jd : jr["deny"]) {
							NpcRef d;
							if (NpcRefFromJson(jd, d) && !ListHas(r.deny, d))
								r.deny.push_back(std::move(d));
						}
					}
					// A room that can no longer address a cell is unusable — drop it
					// rather than keep a claim that can never match.
					if (!r.id.empty() && (r.cellId != 0 || !r.cellEdid.empty()))
						c.rooms.push_back(std::move(r));
				}
			}
		}
		// Real editor ids, verified against Skyrim.esm's raw bytes — never
		// invented (the original "FXGlowFillSphere" did not exist and everything
		// rendered as mist). Walls first: FXDA16Barrier / FXDA16BarrierDoor are
		// the Vaermina-quest translucent magic wall panels, MGEyeBarrierLarge the
		// Eye of Magnus shield; placed tangent to the circle they enclose the
		// room like the crisp box Rober actually asked for. Kilkreath light
		// beams remain as fallback. RingBase() only accepts placeable forms, so
		// a candidate that turns out to be a spell/sound is skipped, not fatal.
		static const std::vector<std::string> kRingDefaults = {
			"FXDA16Barrier", "FXDA16BarrierDoor", "MGEyeBarrierLarge", "FXMistLow01"
		};
		const bool oldDefaultPair = c.ringEdids.size() == 2 &&
			c.ringEdids[0] == "FXGlowFillSphere" && c.ringEdids[1] == "FXMistLow01";
		// "dunKilkreathLightBeam" shipped in two earlier DEFAULT lists and turned
		// out to be a SPELL record (ESM byte-check), not a placeable — any list
		// still carrying it is one of ours, not a user edit.
		const bool carriesBadBeam = std::any_of(c.ringEdids.begin(), c.ringEdids.end(),
			[](const std::string& e) { return e == "dunKilkreathLightBeam"; });
		if (c.ringEdids.empty() || oldDefaultPair || carriesBadBeam)
			c.ringEdids = kRingDefaults;
		out = std::move(c);
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg)
	{
		const auto j = json::parse(viewJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;

		// Room::owned is C++-owned bookkeeping the view never sees; carry it across
		// the merge keyed by room id, or a save from the pane would forget which
		// refs this room owns and strand player ownership in the save forever.
		std::unordered_map<std::string, std::vector<Room::OwnedRef>> keep;
		for (const auto& r : cfg.rooms)
			if (!r.owned.empty())
				keep.emplace(r.id, r.owned);

		// Room::parked is likewise C++-owned (the view never sends it) — carry it
		// across or a pane save would forget which followers this room parked and
		// they would never be resumed.
		std::unordered_map<std::string, std::vector<Room::ParkedRef>> keepParked;
		for (const auto& r : cfg.rooms)
			if (!r.parked.empty())
				keepParked.emplace(r.id, r.parked);

		Config merged;
		FromJson(j, merged);
		// autoClaimed is C++-owned "once per inn, ever" memory — the view never
		// sends it, so carry it across or every pane save would reset it and the
		// next tick would re-claim inns whose auto-claim the player deleted.
		merged.autoClaimed = cfg.autoClaimed;
		merged.ringEdids = cfg.ringEdids;
		merged.ringBaseRadius = cfg.ringBaseRadius;
		for (auto& r : merged.rooms) {
			auto it = keep.find(r.id);
			if (it != keep.end() && r.owned.empty())
				r.owned = it->second;
			auto pit = keepParked.find(r.id);
			if (pit != keepParked.end() && r.parked.empty())
				r.parked = pit->second;
		}
		// Rooms that vanished in this save still hold claimed ownership — give it
		// back now, while their recorded original owners are still known.
		for (auto& [id, recs] : keep) {
			const bool survives = std::any_of(merged.rooms.begin(), merged.rooms.end(),
				[&](const Room& x) { return x.id == id; });
			if (survives)
				continue;
			RestoreOwnedRecs(recs, id.c_str());
			logger::info("rooms: room '{}' removed — restored ownership of {} ref(s)", id, recs.size());
		}
		// A vanished room's parked followers must be released too, or a deleted
		// private room would leave your retinue waiting forever.
		for (auto& [id, recs] : keepParked) {
			const bool survives = std::any_of(merged.rooms.begin(), merged.rooms.end(),
				[&](const Room& x) { return x.id == id; });
			if (survives)
				continue;
			ResumeParked(recs, id.c_str(), &cfg);
		}

		cfg = std::move(merged);
		return true;
	}

	// --------------------------------------------------------------- view payloads

	std::string OpenJson(const Config& c)
	{
		json out = ToJson(c);

		// Live context so the pane can offer "Claim this room" with a sensible
		// suggested name and show whether you are standing in a claim already.
		auto* player = RE::PlayerCharacter::GetSingleton();
		json  here = json::object();
		here["ok"] = false;
		if (player) {
			if (auto* cell = player->GetParentCell()) {
				const auto pos = player->GetPosition();
				here["ok"] = true;
				here["cellId"] = static_cast<std::uint32_t>(cell->GetFormID());
				here["cellName"] = NameOfForm(cell);
				here["interior"] = player->GetWorldspace() == nullptr;
				here["x"] = pos.x;
				here["y"] = pos.y;
				here["z"] = pos.z;
				const auto cn = NameOfForm(cell);
				here["suggested"] = cn.empty() ? std::string("Rented room") : (cn + " — room");
				here["isInn"] = CellIsInn(cell);
				json bed = json::object();
				bed["found"] = false;
				if (auto* bref = FindRentedBed(cell)) {
					const auto bpos = bref->GetPosition();
					bed["found"] = true;
					bed["x"] = bpos.x;
					bed["y"] = bpos.y;
					bed["z"] = bpos.z;
					logger::info("rooms: rented bed detected in '{}' ({:08X})", cn,
						static_cast<std::uint32_t>(bref->GetFormID()));
				}
				here["rentedBed"] = bed;
			}
		}
		out["here"] = here;
		return Dump(out);
	}

	std::string StateJson(const Config& c)
	{
		json out;
		out["ok"] = true;

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* lists = RE::ProcessLists::GetSingleton();
		const Room* room = GuardTargetConst(c, player, /*guardedOnly=*/false);

		out["roomId"] = room ? room->id : "";
		out["roomName"] = room ? room->name : "";
		out["roomKind"] = room ? room->kind : "";
		out["roomEvictFollowers"] = room ? room->evictFollowers : false;
		out["roomWholeCell"] = room ? room->wholeCell : false;
		out["roomLockdown"] = room ? room->lockdown : false;
		// Followers this room is currently holding outside (parked & waiting), so
		// the pane can show "2 followers waiting outside" and reassure that they'll
		// rejoin on the way out.
		json parked = json::array();
		if (room) {
			for (const auto& p : room->parked)
				parked.push_back(json{ { "name", p.name }, { "waiting", p.spec >= 0 } });
		}
		out["parked"] = parked;

		json occ = json::array();
		if (room && player && lists) {
			for (auto& h : lists->highActorHandles) {
				auto  ptr = h.get();
				auto* actor = ptr ? ptr.get() : nullptr;
				if (!actor || actor == player)
					continue;
				if (!actor->Is3DLoaded() || !ActorInRoom(*room, actor->GetPosition()))
					continue;
				const char* why = ExemptReason(c, *room, actor, player);
				// Identity travels with the row so the pane can put this person on the
				// room's allow list in one click — the whole point of a PRIVATE bedroom
				// in a shared cell is choosing who may stay, and the people who matter
				// are by definition standing in it right now.
				const auto nref = MakeNpcRef(actor);
				occ.push_back(json{
					{ "name", DisplayName(actor) },
					{ "exempt", why != nullptr },
					{ "reason", why ? why : "" },
					{ "plugin", nref.plugin },
					{ "localId", nref.localId },
					// Banned-from-this-room, so the pane can label the row and offer
					// a one-click "lift the ban" instead of a misleading allow ✋.
					{ "denied", nref.valid() && ListHas(room->deny, nref) } });
			}
		}
		out["occupants"] = occ;
		return Dump(out);
	}

	std::string NpcsJson(const Config&, const std::string& reqJson)
	{
		json out;
		out["ok"] = true;
		json rows = json::array();

		auto* player = RE::PlayerCharacter::GetSingleton();

		// De-dup by durable identity — the same person can be a loaded actor AND
		// a roster extra, and must appear once.
		std::unordered_set<std::string> seen;
		auto push = [&](RE::Actor* actor) {
			if (!actor || actor == player || actor->IsPlayerRef() || actor->IsDead())
				return;
			const auto nref = MakeNpcRef(actor);
			// No durable identity (spawned 0xFF base) = no list can name her —
			// leaving her out is honest, not a gap.
			if (!nref.valid() || nref.name.empty())
				return;
			char key[300];
			std::snprintf(key, sizeof(key), "%s|%08X", nref.plugin.c_str(),
				static_cast<std::uint32_t>(nref.localId));
			for (char* p = key; *p; ++p)
				*p = static_cast<char>(std::tolower(static_cast<unsigned char>(*p)));
			if (!seen.insert(key).second)
				return;
			rows.push_back(json{
				{ "name", nref.name },
				{ "plugin", nref.plugin },
				{ "localId", nref.localId },
				{ "refId", static_cast<std::uint32_t>(actor->GetFormID()) },
				{ "follower", actor->IsPlayerTeammate() },
				{ "loaded", actor->Is3DLoaded() } });
		};

		// Everyone LOADED around the player — this is what makes "F7 on a
		// stranger who is in no system" work: if she is close enough to ban,
		// she is in the high-actor list.
		if (auto* lists = RE::ProcessLists::GetSingleton()) {
			for (auto& h : lists->highActorHandles) {
				auto ptr = h.get();
				push(ptr ? ptr.get() : nullptr);
			}
		}

		// Roster extras: runtime formIds the view collected from the Follower
		// Organizer roster. Persistent refs resolve even when the actor is not
		// loaded, so the picker can list the whole retinue from anywhere.
		const auto jr = json::parse(reqJson, nullptr, false);
		if (!jr.is_discarded() && jr.is_object() && jr.contains("extra") && jr["extra"].is_array()) {
			std::size_t taken = 0;
			for (const auto& je : jr["extra"]) {
				if (taken >= 512)  // runaway payload guard; FO tops out far below this
					break;
				if (!je.is_object())
					continue;
				const auto fid = je.value("formId", 0u);
				if (!fid)
					continue;
				push(RE::TESForm::LookupByID<RE::Actor>(static_cast<RE::FormID>(fid)));
				++taken;
			}
		}

		out["npcs"] = rows;
		logger::info("rooms: npc picker fed {} candidate(s)", rows.size());
		return Dump(out);
	}

	// ------------------------------------------------------------------ operations

	std::string ClaimHere(Config& cfg, const std::string& reqJson)
	{
		json out;
		out["ok"] = false;

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["msg"] = "No player reference";
			return Dump(out);
		}
		auto* cell = player->GetParentCell();
		if (!cell) {
			out["msg"] = "You aren't in a loaded cell yet";
			return Dump(out);
		}

		const auto jr = json::parse(reqJson, nullptr, false);
		const bool haveReq = !jr.is_discarded() && jr.is_object();
		const auto pos = player->GetPosition();

		Room r;
		r.id = NewRoomId(cfg);
		r.cellId = static_cast<std::uint32_t>(cell->GetFormID());
		const auto* eid = cell->GetFormEditorID();
		r.cellEdid = (eid && eid[0]) ? eid : "";
		r.cellName = NameOfForm(cell);
		r.x = pos.x;
		r.y = pos.y;
		r.z = pos.z;
		// useBed: centre the volume on the DETECTED rented bed instead of on the
		// player's feet. Re-detected here rather than trusted from the payload —
		// the pane's snapshot may be minutes old and the rental may have lapsed.
		// The player's Z is kept when the two are close: bed frames sit above the
		// floor and the vertical extent should hang from where you STAND.
		bool bedCentred = false;
		if (haveReq && jr.value("useBed", false)) {
			if (auto* bref = FindRentedBed(cell)) {
				const auto bpos = bref->GetPosition();
				r.x = bpos.x;
				r.y = bpos.y;
				if (std::fabs(bpos.z - pos.z) < 160.0f)
					r.z = pos.z;
				else
					r.z = bpos.z;
				bedCentred = true;
				logger::info("rooms: claim centred on rented bed ({:.0f}/{:.0f}/{:.0f})",
					r.x, r.y, r.z);
			}
		}
		r.name = haveReq ? jr.value("name", std::string("")) : std::string("");
		if (r.name.empty()) {
			const char* suffix = bedCentred ? " — my room" : " — room";
			r.name = r.cellName.empty() ? "Rented room" : (r.cellName + suffix);
		}
		r.kind = haveReq ? jr.value("kind", std::string("inn")) : std::string("inn");
		if (r.kind != "inn" && r.kind != "home" && r.kind != "private")
			r.kind = "inn";
		r.evictFollowers = haveReq && jr.value("evictFollowers", false);
		r.wholeCell = haveReq && jr.value("wholeCell", false);
		if (haveReq) {
			r.shape = jr.value("shape", std::string("circle"));
			if (r.shape != "circle" && r.shape != "box")
				r.shape = "circle";
			r.radius = std::clamp(jr.value("radius", 200.0f), 80.0f, 4000.0f);
			r.halfX = std::clamp(jr.value("halfX", r.radius), 60.0f, 4000.0f);
			r.halfY = std::clamp(jr.value("halfY", r.radius * 1.3f), 60.0f, 4000.0f);
			r.height = std::clamp(jr.value("height", 130.0f), 60.0f, 2000.0f);
		}
		// A box aligns to the direction the claimer FACES — stand facing the bed
		// wall and the rectangle sits square to the room, whatever the cell's
		// world orientation happens to be.
		r.yaw = player->GetAngleZ();

		logger::info("rooms: claimed '{}' as {} (cell {:08X} '{}', r={:.0f} h={:.0f})", r.name,
			r.kind, r.cellId, r.cellName, r.radius, r.height);

		out["ok"] = true;
		out["msg"] = (r.kind == "home" ? "🏠 Marked as home: "
			: r.wholeCell ? "🚪 Private cell: "
			: "🔒 Claimed: ") + r.name;
		out["room"] = RoomToJson(r);
		Notify(cfg, out["msg"].get<std::string>());
		cfg.rooms.insert(cfg.rooms.begin(), std::move(r));
		return Dump(out);
	}

	std::string SetAnchorHere(Config& cfg, const std::string& roomId)
	{
		json out;
		out["ok"] = false;

		auto* room = FindRoom(cfg, roomId);
		if (!room) {
			out["msg"] = "That room is gone";
			return Dump(out);
		}
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player || !player->GetParentCell()) {
			out["msg"] = "No player reference";
			return Dump(out);
		}
		// The anchor has to be in the room's OWN cell — MoveTo would happily send
		// somebody to another cell, which for an inn means the patron vanishes from
		// the building entirely.
		const auto cellId = static_cast<std::uint32_t>(player->GetParentCell()->GetFormID());
		if (cellId != room->cellId) {
			out["msg"] = "Stand in the same cell as the room — you're somewhere else";
			return Dump(out);
		}
		const auto pos = player->GetPosition();
		if (InsideVolume(*room, pos)) {
			out["msg"] = "That's inside the room — stand where you want them put";
			return Dump(out);
		}

		room->ax = pos.x;
		room->ay = pos.y;
		room->az = pos.z;
		room->aangle = player->GetAngleZ();
		room->hasAnchor = true;

		logger::info("rooms: '{}' drop point set to {:.0f}/{:.0f}/{:.0f}", room->name, pos.x, pos.y, pos.z);
		out["ok"] = true;
		out["msg"] = "📍 Drop point set for " + room->name;
		out["room"] = json{ { "id", room->id }, { "hasAnchor", true },
			{ "ax", room->ax }, { "ay", room->ay }, { "az", room->az }, { "aangle", room->aangle } };
		Notify(cfg, out["msg"].get<std::string>());
		return Dump(out);
	}

	std::string EvictNow(Config& cfg, const std::string& roomId)
	{
		json out;
		out["ok"] = false;

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* lists = RE::ProcessLists::GetSingleton();
		if (!player || !lists) {
			out["msg"] = "No player reference";
			return Dump(out);
		}

		Room* room = roomId.empty() ? GuardTarget(cfg, player, /*guardedOnly=*/false)
								    : FindRoom(cfg, roomId);
		if (!room) {
			out["msg"] = roomId.empty() ? "You aren't standing in a claimed room" : "That room is gone";
			return Dump(out);
		}
		if (room->cellId != (player->GetParentCell()
					? static_cast<std::uint32_t>(player->GetParentCell()->GetFormID())
					: 0u)) {
			out["msg"] = "You have to be in " + room->name + " to clear it";
			return Dump(out);
		}

		int moved = 0, exempt = 0;
		for (auto& h : lists->highActorHandles) {
			auto  ptr = h.get();
			auto* actor = ptr ? ptr.get() : nullptr;
			if (!actor || actor == player)
				continue;
			if (!actor->Is3DLoaded() || !InsideVolume(*room, actor->GetPosition()))
				continue;
			if (ExemptReason(cfg, *room, actor, player)) {
				++exempt;
				continue;
			}
			// A follower this room keeps out (blacklisted, followers-out, or a
			// privacy lockdown) is PARKED first — the watchdog has always done
			// this and the manual clear must too, or she is moved out and her
			// follow package walks her straight back in.
			if (FollowerKeptOut(*room, actor))
				ParkFollower(*room, actor);
			if (EvictActor(player, *room, actor)) {
				g_grace.erase(actor->GetFormID());
				++moved;
			}
		}

		out["ok"] = true;
		out["msg"] = moved == 0
			? (exempt > 0 ? "Nobody to move — everyone in there is allowed"
						  : "Room's already empty")
			: ("Cleared " + std::to_string(moved) + (moved == 1 ? " person" : " people") +
				  " out of " + room->name);
		out["moved"] = moved;
		out["exempt"] = exempt;
		Notify(cfg, out["msg"].get<std::string>());
		return Dump(out);
	}

	std::string ToggleLockdown(Config& cfg, const std::string& roomId)
	{
		json out;
		out["ok"] = false;

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["msg"] = "No player reference";
			return Dump(out);
		}

		// Empty id = "the room I'm standing in", so the bindable action works with
		// the deck shut. guardedOnly=false on purpose: a paused room and a home
		// are exactly the rooms you may want to seal, and lockdown overrides both.
		Room* room = roomId.empty() ? GuardTarget(cfg, player, /*guardedOnly=*/false)
								    : FindRoom(cfg, roomId);
		if (!room) {
			out["msg"] = roomId.empty()
				? "You aren't in a claimed room - claim it first, then seal it"
				: "That room is gone";
			return Dump(out);
		}

		room->lockdown = !room->lockdown;
		out["ok"] = true;
		out["id"] = room->id;
		out["lockdown"] = room->lockdown;

		auto*      pcell = player->GetParentCell();
		const bool sameCell = pcell && static_cast<std::uint32_t>(pcell->GetFormID()) == room->cellId;

		if (room->lockdown) {
			// Clear it NOW rather than waiting up to a tick — "right now" is the
			// whole promise of the button, and a seal that takes a second and a
			// half to do anything reads as a seal that didn't work. Only in the
			// room's own cell: MoveTo across cells would post someone into another
			// building, so from elsewhere the flag simply arms and says so.
			int   moved = 0;
			auto* lists = RE::ProcessLists::GetSingleton();
			if (lists && sameCell) {
				for (auto& h : lists->highActorHandles) {
					auto  ptr = h.get();
					auto* actor = ptr ? ptr.get() : nullptr;
					if (!actor || actor == player || !actor->Is3DLoaded())
						continue;
					if (!ActorInRoom(*room, actor->GetPosition()))
						continue;
					if (ExemptReason(cfg, *room, actor, player))
						continue;
					if (FollowerKeptOut(*room, actor))
						ParkFollower(*room, actor);
					if (EvictActor(player, *room, actor)) {
						g_grace.erase(actor->GetFormID());
						++moved;
					}
				}
			}
			out["moved"] = moved;
			std::string msg = "\xF0\x9F\x94\x92 " + room->name;
			if (!sameCell) {
				msg += " sealed - takes hold when you're there";
			} else {
				msg += " sealed - nobody comes in";
				if (moved)
					msg += " (" + std::to_string(moved) + " shown out)";
			}
			out["msg"] = msg;
		} else {
			// Off restores nothing because nothing was destroyed: the allow list,
			// the bans and the follower setting were never touched to get here.
			// Followers the seal parked are released by the watchdog's next pass
			// (the one place that decides who is still being kept out) — deciding
			// it twice is how the two rules drift apart.
			out["moved"] = 0;
			out["msg"] = "\xF0\x9F\x94\x93 " + room->name + " unsealed - your usual people may come in";
		}

		logger::info("rooms: lockdown {} for '{}' (kind {}, {}in cell, moved {})",
			room->lockdown ? "ON" : "OFF", room->name, room->kind, sameCell ? "" : "not ",
			out.value("moved", 0));
		Notify(cfg, out["msg"].get<std::string>());
		return Dump(out);
	}

	std::string ToggleIgnoreCrosshair(Config& cfg)
	{
		json out;
		out["ok"] = false;

		auto* actor = CrosshairActor();
		if (!actor) {
			out["msg"] = "Look at someone first";
			return Dump(out);
		}
		const auto ref = MakeNpcRef(actor);
		if (!ref.valid()) {
			out["msg"] = "Can't identify that one (no base form)";
			return Dump(out);
		}

		auto it = std::find_if(cfg.ignore.begin(), cfg.ignore.end(),
			[&](const NpcRef& x) { return SameNpc(x, ref); });
		if (it != cfg.ignore.end()) {
			cfg.ignore.erase(it);
			out["msg"] = ref.name + " is no longer ignored";
			out["ignored"] = false;
		} else {
			cfg.ignore.push_back(ref);
			out["msg"] = "🚫 " + ref.name + " will be left alone";
			out["ignored"] = true;
		}
		out["ok"] = true;
		out["ignore"] = ToJson(cfg)["ignore"];
		logger::info("rooms: ignore toggled for '{}' ({}|{:08X}) -> {}", ref.name, ref.plugin,
			ref.localId, out["ignored"].get<bool>());
		Notify(cfg, out["msg"].get<std::string>());
		return Dump(out);
	}

	std::string ReleaseRoom(Config& cfg, const std::string& roomId)
	{
		json out;
		out["ok"] = false;
		auto* room = FindRoom(cfg, roomId);
		if (!room) {
			out["msg"] = "That room is gone";
			return Dump(out);
		}
		RestoreRoomFurniture(*room);
		ResumeParked(room->parked, room->name.c_str(), &cfg);  // let its retinue follow again
		room->enabled = false;
		out["ok"] = true;
		out["msg"] = "Released " + room->name;
		return Dump(out);
	}

	// ------------------------------------------------------------ boundary ring

	void HideRing()
	{
		// NO Papyrus here. The first version dispatched ObjectReference.Disable/
		// Delete — both LATENT functions, and a fire-and-forget dispatch of a
		// latent (with the game often paused under the palette on top) simply
		// never ran: play-tested as "if I turn off the drawing I still see the
		// red effect". Hide with the same direct engine calls that provably MOVE
		// the markers — park them far below the world — then mark them deleted
		// so the engine reaps them; they are non-persistent temporaries either
		// way, so a reload also clears them.
		for (const auto id : g_ring) {
			if (auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(id)) {
				ref->SetPosition(RE::NiPoint3{ 0.0f, 0.0f, -30000.0f });
				ref->Update3DPosition(true);
				ref->SetDelete(true);
			}
		}
		if (!g_ring.empty())
			logger::info("rooms: ring hidden ({} markers)", g_ring.size());
		g_ring.clear();
	}

	std::string ShowRing(Config& cfg, const std::string& reqJson)
	{
		json out;
		out["ok"] = false;

		const auto jr = json::parse(reqJson, nullptr, false);
		const auto roomId = (!jr.is_discarded() && jr.is_object())
			? jr.value("id", std::string(""))
			: std::string("");
		if (roomId.empty()) {  // {} = hide
			HideRing();
			out["ok"] = true;
			return Dump(out);
		}

		auto* room = FindRoom(cfg, roomId);
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!room || !player || !player->GetParentCell()) {
			out["msg"] = "That room is gone";
			return Dump(out);
		}
		if (static_cast<std::uint32_t>(player->GetParentCell()->GetFormID()) != room->cellId) {
			out["msg"] = "Go to " + room->name + " to see its boundary";
			return Dump(out);
		}
		auto* base = RingBase(cfg);
		if (!base) {
			out["msg"] = "No ring form in this load order — see HotkeyDeck.log";
			return Dump(out);
		}

		// "align": re-capture the box's yaw from where the player faces NOW —
		// the tune panel's fix for a box claimed while facing the wrong wall.
		if (jr.value("align", false) && room->shape == "box") {
			room->yaw = player->GetAngleZ();
			logger::info("rooms: '{}' box re-aligned to yaw {:.2f}", room->name, room->yaw);
		}

		// Slider overrides preview the drag BEFORE the debounced save lands.
		const float radius = jr.value("radius", room->radius);
		const float halfX = jr.value("halfX", room->halfX);
		const float halfY = jr.value("halfY", room->halfY);

		// Build the boundary in LOCAL 2D coordinates first — a circle of 16
		// points, or a box outline with panels spaced ~every 110u per side —
		// then rotate/translate into the world. Each point carries its outward
		// normal; the barrier panels' plane is perpendicular to their forward
		// axis (proven by the play-tested circle), so facing = the normal.
		struct P { float lx, ly, nx, ny; };
		std::vector<P> pts;
		if (room->shape == "box") {
			auto side = [&pts](float ax, float ay, float bx, float by, float nx, float ny) {
				const float len = std::hypot(bx - ax, by - ay);
				// no std::max: the Windows max MACRO (leaked through the SKSE
				// headers) mangles it into a syntax error — C2589 on '::'
				int n = static_cast<int>(len / 110.0f) + 1;
				if (n < 2)
					n = 2;
				for (int i = 0; i < n; ++i) {
					const float t = (i + 0.5f) / n;
					pts.push_back(P{ ax + (bx - ax) * t, ay + (by - ay) * t, nx, ny });
				}
			};
			side(-halfX, +halfY, +halfX, +halfY, 0.0f, +1.0f);   // front
			side(+halfX, +halfY, +halfX, -halfY, +1.0f, 0.0f);   // right
			side(+halfX, -halfY, -halfX, -halfY, 0.0f, -1.0f);   // back
			side(-halfX, -halfY, -halfX, +halfY, -1.0f, 0.0f);   // left
		} else {
			constexpr int kEdge = 16;
			for (int i = 0; i < kEdge; ++i) {
				const float a = (2.0f * 3.14159265f * i) / kEdge;
				pts.push_back(P{ radius * std::cos(a), radius * std::sin(a),
					std::cos(a), std::sin(a) });
			}
		}

		const int wanted = 1 + static_cast<int>(pts.size());
		if (static_cast<int>(g_ring.size()) != wanted) {
			HideRing();
			for (int i = 0; i < wanted; ++i) {
				auto ptr = player->PlaceObjectAtMe(base, false);  // temporary, dies with the session
				if (ptr)
					g_ring.push_back(ptr->GetFormID());
			}
			logger::info("rooms: ring shown for '{}' ({} markers)", room->name, g_ring.size());
		}

		// The ring sits at the player's feet when they're on the room's storey —
		// the volume centre can be waist height (claimed standing) and a ring at
		// the centre's Z floats. Falls back to the centre when on another floor.
		const auto  ppos = player->GetPosition();
		const float ringZ = (std::fabs(ppos.z - room->z) <= room->height) ? ppos.z : room->z;

		// Local -> world: rotate by yaw (identity for circles, whose yaw is 0 in
		// local space already), then translate to the room centre.
		const float sy = (room->shape == "box") ? std::sin(room->yaw) : 0.0f;
		const float cy = (room->shape == "box") ? std::cos(room->yaw) : 1.0f;
		auto toWorldX = [&](float lx, float ly) { return room->x + lx * cy + ly * sy; };
		auto toWorldY = [&](float lx, float ly) { return room->y - lx * sy + ly * cy; };

		int idx = 0;
		for (const auto id : g_ring) {
			auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(id);
			if (!ref) {
				++idx;
				continue;
			}
			if (idx == 0) {
				ref->SetPosition(RE::NiPoint3{ room->x, room->y, ringZ + 8.0f });
			} else {
				const P& p = pts[idx - 1];
				ref->SetPosition(RE::NiPoint3{
					toWorldX(p.lx, p.ly), toWorldY(p.lx, p.ly), ringZ + 8.0f });
				// facing = the outward normal, rotated into the world; the yaw
				// convention matches the Domains marker's (forward = sin/cos).
				const float wnx = p.nx * cy + p.ny * sy;
				const float wny = -p.nx * sy + p.ny * cy;
				ref->SetAngle(RE::NiPoint3{ 0.0f, 0.0f, std::atan2(wnx, wny) });
			}
			ref->Update3DPosition(true);
			++idx;
		}
		g_ringHideAt = std::chrono::steady_clock::now() + std::chrono::seconds(20);

		out["ok"] = true;
		out["msg"] = "⭘ Boundary shown — fades in 20 s";
		return Dump(out);
	}

	// ------------------------------------------------------------------- watchdog

	bool Tick(Config& cfg)
	{
		// NB: no early-out on rooms.empty() — auto-claim is precisely the case
		// where there is no room yet.
		if (!cfg.enabled)
			return false;

		const auto now = clock::now();
		if (g_lastTick != clock::time_point{} &&
			now - g_lastTick < std::chrono::milliseconds(cfg.tickMs))
			return false;
		g_lastTick = now;

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return false;

		bool autoDirty = false;

		// ---- auto-claim: rent a room, it guards itself ----
		// Every ~10 s (not every tick — this walks the cell's refs), and only in
		// an inn cell with no claim of ours: if the rental system's fingerprint is
		// there (LocTypeInn + a player-owned bed, see FindRentedBed), claim around
		// the bed unprompted. autoClaimed makes it once per inn, EVER — deleting
		// the auto-claim is a decision, not an invitation to re-fight the tick.
		// The scan runs mid-stay on purpose: you rent from the innkeeper while
		// already standing in the inn, so waiting for a cell change would miss it.
		static clock::time_point s_lastAutoScan{};
		if (cfg.autoClaim &&
			(s_lastAutoScan == clock::time_point{} ||
				now - s_lastAutoScan > std::chrono::seconds(10))) {
			s_lastAutoScan = now;
			if (auto* cell = player->GetParentCell()) {
				const auto cellId = static_cast<std::uint32_t>(cell->GetFormID());
				const bool known =
					std::any_of(cfg.rooms.begin(), cfg.rooms.end(),
						[&](const Room& r) { return r.cellId == cellId; }) ||
					std::find(cfg.autoClaimed.begin(), cfg.autoClaimed.end(), cellId) !=
						cfg.autoClaimed.end();
				if (!known) {
					if (auto* bref = FindRentedBed(cell)) {
						const auto bpos = bref->GetPosition();
						const auto ppos = player->GetPosition();
						Room r;
						r.id = NewRoomId(cfg);
						r.cellId = cellId;
						const auto* eid = cell->GetFormEditorID();
						r.cellEdid = (eid && eid[0]) ? eid : "";
						r.cellName = NameOfForm(cell);
						r.name = r.cellName.empty() ? "Rented room" : (r.cellName + " — my room");
						r.x = bpos.x;
						r.y = bpos.y;
						r.z = (std::fabs(bpos.z - ppos.z) < 160.0f) ? ppos.z : bpos.z;
						cfg.autoClaimed.push_back(cellId);
						logger::info("rooms: auto-claimed rented room '{}' (cell {:08X}, bed {:08X})",
							r.name, cellId, static_cast<std::uint32_t>(bref->GetFormID()));
						Notify(cfg, "🔒 " + r.name + " is yours — Rooms tab to adjust");
						cfg.rooms.insert(cfg.rooms.begin(), std::move(r));
						autoDirty = true;
					}
				}
			}
		}

		// Ring temporaries expire on their own schedule, wherever the player is.
		if (!g_ring.empty() && now >= g_ringHideAt)
			HideRing();

		if (cfg.rooms.empty())
			return autoDirty;

		// The early-out that makes this near-free: unless the player's CELL holds
		// an enabled guarded room, the tick does nothing but cell-id compares.
		// Guarding by CELL and not by "is the player inside the volume" is the
		// Traveller's Inn lesson: a mis-sized volume used to disable its own
		// watchdog whenever you stood outside it — watching the peasant sit in
		// your room from the doorway, with the guard silently off.
		auto* pcell = player->GetParentCell();
		if (!pcell)
			return autoDirty;
		const auto pcellId = static_cast<std::uint32_t>(pcell->GetFormID());

		bool dirty = autoDirty;

		// Resume any followers a room parked once the player is no longer guarding
		// followers there — left the cell, or the room was disabled / set back to
		// letting followers in / made a home. THIS is what releases a private
		// cell's retinue: cross the threshold out and your followers rejoin.
		for (auto& r : cfg.rooms) {
			if (r.parked.empty())
				continue;
			// A room with a BLACKLIST can park a teammate too (a banned follower is
			// parked so she stops warping back), and so can a PRIVACY LOCKDOWN —
			// so the parked list must survive while the player is still in that
			// cell and any of those is in force, not just when evictFollowers is
			// on. Lifting the seal therefore releases the retinue on the next tick,
			// with no separate rule to keep in sync.
			const bool guardingFollowersHere = RoomActive(r) && r.cellId == pcellId &&
				(r.lockdown || r.evictFollowers || !r.deny.empty());
			if (!guardingFollowersHere)
				dirty = ResumeParked(r.parked, r.name.c_str(), &cfg) || dirty;
		}

		std::vector<Room*> active;
		for (auto& r : cfg.rooms)
			if (RoomActive(r) && r.cellId == pcellId)
				active.push_back(&r);
		if (active.empty()) {
			if (!g_grace.empty())
				g_grace.clear();
			return dirty;
		}

		for (auto* r : active) {
			// Whole-cell claims take NO furniture ownership: owning every chair in
			// an entire cell is heavy and the point of a private cell is eviction,
			// not decoy-removal. Volume claims repel as before. A HOME room is only
			// ever here because a privacy lockdown pulled it in — it must not start
			// re-owning your own house's furniture over a temporary seal, so it is
			// excluded too (and, having never claimed any, has nothing to restore).
			if (r->repel && !r->wholeCell && r->kind != "home")
				dirty = ClaimRoomFurniture(*r) || dirty;
			else if (!r->owned.empty())
				dirty = RestoreRoomFurniture(*r) || dirty;
		}

		auto* lists = RE::ProcessLists::GetSingleton();
		if (!lists)
			return dirty;

		// Park-then-evict: for a room that pushes followers out — or a teammate
		// who is BLACKLISTED from this room — she is first sent her framework's
		// own "wait" so she stops following and stays put, instead of warping
		// back on the next cell attach.
		auto followerKeptOut = [](Room& rm, RE::Actor* a) -> bool {
			return FollowerKeptOut(rm, a);
		};
		auto evict = [&](Room& rm, RE::Actor* a) -> bool {
			if (followerKeptOut(rm, a)) {
				const auto before = rm.parked.size();
				ParkFollower(rm, a);
				if (rm.parked.size() != before)
					dirty = true;
			}
			return EvictActor(player, rm, a);
		};
		// The corner message for a move. A parked follower reads as "waits outside"
		// (she'll rejoin when you leave); one we couldn't park says so honestly, so
		// a follower who keeps warping back isn't a mystery; anyone else is the
		// plain eviction line.
		auto movedMsg = [&](Room& rm, RE::Actor* a, bool shownOut) -> std::string {
			if (followerKeptOut(rm, a)) {
				const auto fid = static_cast<std::uint32_t>(a->GetFormID());
				int        spec = -2;
				for (const auto& p : rm.parked)
					if (p.ref == fid) { spec = p.spec; break; }
				if (spec >= 0)
					return "🚶 " + DisplayName(a) + " waits outside";
				return DisplayName(a) + " won't stay out — dismiss her manually";
			}
			return DisplayName(a) + (shownOut ? " is shown out" : " leaves your room");
		};

		for (auto& h : lists->highActorHandles) {
			auto  ptr = h.get();
			auto* actor = ptr ? ptr.get() : nullptr;
			if (!actor || actor == player)
				continue;
			const auto id = actor->GetFormID();

			// Judge against the room whose volume actually holds the actor —
			// several rooms can share one cell (two Private bedrooms at home).
			Room* room = nullptr;
			if (actor->Is3DLoaded()) {
				const auto apos = actor->GetPosition();
				for (auto* r : active)
					if (ActorInRoom(*r, apos)) { room = r; break; }
			}
			if (!room) {
				g_grace.erase(id);  // outside every claim — forget the timer
				continue;
			}
			if (ExemptReason(cfg, *room, actor, player))
				continue;

			// Out of sight: move them now, which is the whole point — the eviction
			// you never witness is the one that feels like the room was just empty.
			if (!PlayerCanSee(actor)) {
				if (evict(*room, actor)) {
					g_grace.erase(id);
					Notify(cfg, movedMsg(*room, actor, false));
				}
				continue;
			}

			// In view: give them a window to walk out on their own. Standing them up
			// and re-evaluating usually sends them off to another sandbox target.
			// A SEALED room shortens that window rather than dropping it: walking
			// out still looks better than a teleport in your face, but "right now"
			// can't mean four seconds of someone standing in your locked bedroom.
			const auto graceMs = (room->lockdown && cfg.graceMs > 1200u) ? 1200u : cfg.graceMs;
			auto [it, inserted] = g_grace.try_emplace(id,
				Grace{ now + std::chrono::milliseconds(graceMs), now });
			it->second.touched = now;
			if (inserted) {
				actor->NotifyAnimationGraph("IdleForceDefaultState"sv);
				actor->EvaluatePackage();
				logger::info("rooms: '{}' is in '{}' and in view — {} ms to leave",
					DisplayName(actor), room->name, graceMs);
				continue;
			}
			if (now >= it->second.deadline) {
				if (evict(*room, actor)) {
					g_grace.erase(id);
					Notify(cfg, movedMsg(*room, actor, true));
				}
			}
		}

		// Prune timers for actors that stopped being seen this pass.
		for (auto it = g_grace.begin(); it != g_grace.end();)
			it = (it->second.touched != now) ? g_grace.erase(it) : std::next(it);

		return dirty;
	}

	bool UnblockAll(Config& cfg)
	{
		bool changed = false;
		for (auto& r : cfg.rooms)
			changed = RestoreRoomFurniture(r) || changed;
		return changed;
	}
}
