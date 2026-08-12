#include "nff_control.h"

#include "actor_identity.h"
#include "nff_bridge.h"   // HomeRefFor: where MHiYH / NFF actually think she lives
#include "npc_actions.h"
#include "follower_frameworks.h"   // OwningCompanionSpec: whose mod runs her
#include "maras.h"          // is she married to you? (M.A.R.A.S)
#include "relationship.h"   // the player's rank with her, for the card's dossier

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <functional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// pch (force-included) provides RE::/SKSE::, nlohmann/json and
// `using namespace std::literals` — same as mhiyh_control.cpp / nff_bridge.cpp,
// which likewise do not include the json header themselves.

using json = nlohmann::json;

namespace NffControl
{
	namespace
	{
		// ------------------------------------------------------------ ids ----

		// NFF's controller quest. The number is not a guess: NFF's own override
		// of DialogueFollowerScript resolves it as
		// `Game.GetFormFromFile(17231, "nwsFollowerFramework.esp")`
		// (DialogueFollowerScript.psc:32) — 17231 decimal == 0x434F.
		constexpr RE::FormID  kNffQuestId = 0x434F;
		constexpr const char* kNffPlugin  = "nwsFollowerFramework.esp";
		constexpr const char* kNffScript  = "nwsFollowerControllerScript";

		// Vanilla's DialogueFollower quest, used only when NFF is absent.
		constexpr RE::FormID  kVanillaQuestId = 0x000750BA;
		constexpr const char* kVanillaScript  = "DialogueFollowerScript";

		// ---- item removal: PROVE it is safe, never catch it mid-flight -----
		//
		// History, because the wrong fix here is very tempting:
		//   2026-08-01  Rober froze the game hitting the equipped-list ✕ on a
		//               "<Missing Name>" leftover — an item stranded on a
		//               long-lived follower by an uninstalled mod. The engine
		//               faults inside Actor::RemoveItem.
		//   2026-08-02  We "fixed" it by SEH-wrapping the RemoveItem call. The
		//               guard WORKED — it caught the access violation and logged
		//               a clean refusal — and the game hung anyway, forever, with
		//               one thread spinning. Editing Amaniri's inventory.
		//
		// Why the SEH belt was worse than the bug: the fault happens PART-WAY
		// THROUGH RemoveItem's mutation of the inventory (entry list, extra data,
		// changed-form bookkeeping). __except unwinds our C++ frame but cannot
		// roll back the engine's half-finished edit, so the container is left
		// inconsistent and the next traversal loops forever. We turned a crash —
		// loud, logged, autosave intact — into a silent hang with no crash log.
		//
		// ⛔ RULE: never __try/__except around an engine call that MUTATES state.
		// Validate first and refuse, so the dangerous call is never entered.
		// (SEH around a READ-ONLY walk is fine — see ScanInventory below — because
		// aborting a read leaves nothing half-written.)

		// A pointer we are about to hand to the engine has to be readable first.
		// VirtualQuery only asks the kernel about the page tables, so it cannot
		// itself fault — safe to call on a pointer that is complete garbage.
		static bool PageIsReadable(const void* a_ptr, std::size_t a_size)
		{
			const auto addr = reinterpret_cast<std::uintptr_t>(a_ptr);
			// Below the 64 KB null-guard region, or misaligned, is not an object.
			if (addr < 0x10000 || (addr & 7) != 0)
				return false;

			MEMORY_BASIC_INFORMATION mbi{};
			if (::VirtualQuery(a_ptr, &mbi, sizeof(mbi)) != sizeof(mbi))
				return false;
			if (mbi.State != MEM_COMMIT)
				return false;
			if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))
				return false;
			constexpr DWORD kReadable =
				PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
				PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
			if (!(mbi.Protect & kReadable))
				return false;
			// The object must fit INSIDE this committed region: a struct whose
			// tail straddles into an unmapped page still faults on the last byte.
			const auto regionEnd =
				reinterpret_cast<std::uintptr_t>(mbi.BaseAddress) + mbi.RegionSize;
			return addr + a_size <= regionEnd;
		}

		// Readable is not the same as LIVE. The round-trip is the real test:
		// every form the engine knows about is in its form table under its own
		// id, so LookupByID must hand back the SAME pointer. A leftover whose
		// plugin is gone fails this — which is exactly the "<Missing Name>" case.
		static bool FormIsLive(const RE::TESForm* a_form)
		{
			if (!PageIsReadable(a_form, sizeof(RE::TESForm)))
				return false;
			const auto id = a_form->GetFormID();   // safe: page proven readable
			if (!id || id == 0xFFFFFFFF)
				return false;
			return RE::TESForm::LookupByID(id) == a_form;
		}

		// RemoveItem iterates the actor's WHOLE inventory-changes list, so our
		// own target being live is not enough — one dead entry anywhere in that
		// list faults the call. Count the bad ones up front.
		static void ScanInventoryInner(RE::Actor* a_actor, std::uint32_t* a_bad)
		{
			auto* changes = a_actor->GetInventoryChanges();
			if (!changes || !changes->entryList)
				return;
			for (auto* entry : *changes->entryList) {
				if (!PageIsReadable(entry, sizeof(RE::InventoryEntryData)) ||
					!FormIsLive(entry->object))
					++*a_bad;
			}
		}

		// The walk is read-only, so the SEH belt here is legitimate: if the list
		// itself is corrupt enough to fault we simply report "cannot verify" and
		// refuse, having changed nothing. Body lives in the leaf above so this
		// frame stays object-free (C2712 under /EHsc).
		static bool ScanInventory(RE::Actor* a_actor, std::uint32_t* a_bad)
		{
			__try {
				ScanInventoryInner(a_actor, a_bad);
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// An NPC whose OWN mod runs her following must not also be handed to
		// NFF: two controllers on one companion fight each other, and the
		// vanilla follower factions + relationship rank this writes are not
		// something the deck can take back.
		//
		// This used to be a hardcoded list of two companions matched on
		// DISPLAY NAME — the author's own. Useless to everyone else, and worse
		// than useless, because a stranger's NPC whose name merely contained
		// one of those letter-sequences got a spurious confirm.
		// FollowerFrameworks::OwningCompanionSpec answers the same question
		// universally, from the actor's DEFINING PLUGIN: does she ship inside
		// a one-companion follower mod that runs her itself? True for
		// anybody's custom companion, on any load order, no names involved.
		//
		// A guard, not a ban: the view arms a confirm and re-sends with
		// force:true, so it cannot happen by accident and is never a lock.
		bool IsGuardedActor(RE::Actor* actor, const std::string&)
		{
			return actor && FollowerFrameworks::OwningCompanionSpec(actor) >= 0;
		}

		// ------------------------------------------------------- resolving ----

		std::uint32_t ParseHex(const std::string& s)
		{
			if (s.empty())
				return 0;
			try {
				return static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
			} catch (...) {
				return 0;
			}
		}

		// Same convention as wardrobe.cpp: local id + plugin is the durable
		// identity, a bare id is a last resort (and the only thing a dynamic
		// 0xFF…… ref has).
		RE::Actor* ResolveActor(const std::string& formId, const std::string& plugin)
		{
			const std::uint32_t local = ParseHex(formId);
			if (!local)
				return nullptr;
			if (!plugin.empty()) {
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					if (auto* f = dh->LookupForm(local, plugin))
						return f->As<RE::Actor>();
				}
			}
			if (auto* f = RE::TESForm::LookupByID(local))
				return f->As<RE::Actor>();
			return nullptr;
		}

		// One implementation, in ActorIdentity — three byte-identical private
		// copies of this used to exist, and none of them were the one the crash
		// sites called. Same contract as before: the durable local id, falling
		// back to the runtime id for a dynamic form. Now also null-form-safe.
		std::uint32_t LocalIdOf(const RE::TESForm* form)
		{
			return ActorIdentity::BestIdOf(form);
		}

		std::string PluginOf(const RE::TESForm* form)
		{
			if (auto* file = form->GetFile(0))
				return std::string(file->GetFilename());
			return "";
		}

		std::string HexOf(std::uint32_t id)
		{
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "0x%06X", id);
			return buf;
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (!actor)
				return "They";
			if (const char* n = actor->GetDisplayFullName(); n && *n)
				return n;
			return "They";
		}

		// The actor an op acts on: an explicit formId when the roster sent one,
		// otherwise whoever was under the crosshair when the palette opened.
		RE::Actor* TargetOf(const json& j)
		{
			const auto fid = j.value("formId", std::string(""));
			if (!fid.empty())
				return ResolveActor(fid, j.value("plugin", std::string("")));
			if (const auto id = NpcActions::TargetFormID())
				return RE::TESForm::LookupByID<RE::Actor>(id);
			return nullptr;
		}

		RE::TESQuest* NffQuest()
		{
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				if (auto* f = dh->LookupForm(kNffQuestId, kNffPlugin))
					return f->As<RE::TESQuest>();
			}
			return nullptr;
		}

		// nwsFF_ImportFac — the faction ImportAction adds and ExportAction
		// removes, so it IS the durable "is she in the framework" bit. Local id
		// read out of nwsFollowerFramework.esp's bytes (FACT 0x016EB1), not
		// guessed: the runtime FormID moves with load order, so it must be
		// looked up through the data handler like every other NFF form here.
		constexpr RE::FormID kNffImportFacId = 0x016EB1;

		RE::TESFaction* NffFaction(RE::FormID localId)
		{
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				if (auto* f = dh->LookupForm(localId, kNffPlugin))
					return f->As<RE::TESFaction>();
			}
			return nullptr;
		}

		RE::TESQuest* VanillaFollowerQuest()
		{
			if (auto* f = RE::TESForm::LookupByID(kVanillaQuestId))
				return f->As<RE::TESQuest>();
			return nullptr;
		}

		// --------------------------------------------------------- calling ----

		// One Papyrus method call on a quest's script, with the result delivered
		// back on the main thread. Mirrors MhiyhControl's dispatch: the VM runs
		// the stack whenever it likes, so `done` is the only truthful reply.
		class Callback : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit Callback(std::function<void(bool)> fn) : _fn(std::move(fn)) {}

			void operator()(RE::BSScript::Variable a_result) override
			{
				// Unlike MHiYHController's Bool functions, every entry point
				// this file calls — RecruitFollower, RemoveFollower,
				// OpenInventory — is a plain `Function` returning None. So
				// there is no Bool to read: reaching the callback at all IS the
				// success signal, and inspecting the Variable would only
				// reinterpret an empty union. Accept a Bool if one ever shows
				// up (a future NFF could change a signature), else treat the
				// stack having run as ok.
				const bool ok = a_result.IsBool() ? a_result.GetBool() : true;
				auto       fn = _fn;
				if (!fn)
					return;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([fn, ok]() { fn(ok); });
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(bool)> _fn;
		};

		bool CallQuestActor(RE::TESQuest* quest, const char* cls, const char* fn,
			RE::Actor* actor, std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;

			auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(actor)));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new Callback(std::move(done)));
			return vm->DispatchMethodCall(handle, cls, fn, args, cb);
		}

		// One call with TWO trailing ints. NFF's dismiss/wait entry points all
		// take them, and every value we pass is the one its OWN dialogue passes:
		//   RemoveFollower(actor, 1, 1)      dismiss: show the notice, let her speak
		//   FollowerWaitHere(actor, 1, 0)    wait:    notify, not a permanent post
		// (DialogueFollowerScript.psc:50/78 — decompiled, not guessed.)
		bool CallQuestActorInts(RE::TESQuest* quest, const char* fn, RE::Actor* actor,
			std::int32_t a, std::int32_t b, bool twoInts, std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new Callback(std::move(done)));
			if (twoInts) {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)),
					std::move(a), std::move(b));
				return vm->DispatchMethodCall(handle, kNffScript, fn, args, cb);
			}
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(actor)), std::move(a));
			return vm->DispatchMethodCall(handle, kNffScript, fn, args, cb);
		}

		/* ---------------- the WHOLE PARTY, via NFF's own group script --------
		 *
		 *  nwsFollowerSandboxScript is NFF's group brain: it owns the relax
		 *  state (nwsGroupRelax) and DoTaskAll, the loop it runs over its own
		 *  alias array. Three of its functions are exactly the party orders
		 *  Rober asked for, so we call THEM rather than reimplementing a loop:
		 *
		 *    DoTaskAll(2, 1)     task 2 is MoveFollower; onDemand 1 skips the
		 *                        distance test and warps in front of the
		 *                        player. This is "teleport everyone to me",
		 *                        and because it walks NFF's ALIASES rather
		 *                        than the loaded-actor list it reaches the
		 *                        ones standing in another hold.
		 *    StartSandbox(1)     primes relaxTime to the threshold, so the
		 *                        next 1s tick relaxes the group. There is no
		 *                        per-follower sandbox order in NFF at all —
		 *                        relaxing is group-wide and normally automatic
		 *                        after you stand still; this is the "now".
		 *    ResetSandboxVars()  ends it: disables the marker and
		 *                        EvaluatePackages everyone back to you.
		 *
		 *  The quest is found by SCRIPT NAME, never by FormID — same reason
		 *  and same shape as nff_bridge's home/sets/vars scan. Cached, with a
		 *  rescan allowed once a save is loaded (before that, quests exist but
		 *  binding fails).
		 */
		/* NFF's SPARE INVENTORY — the per-follower storage chest its dialogue
		 * calls "extra storage", distinct from both her own inventory (the
		 * container menu) and her three outfit chests (nff_outfits).
		 *
		 * Entry point taken from NFF's own topic fragment verbatim
		 * (nwsFollower_OpenXStorage.psc:9):
		 *
		 *     (GetOwningQuest() as nwsfollowerxstorescript).OpenStorage(akSpeaker, False)
		 *
		 * `findOnly` False means OPEN it; True would only return the ref. It
		 * returns an ObjectReference rather than a Bool, which the Callback
		 * above already copes with — reaching the callback is the success
		 * signal and it does not try to read a Bool that is not there. */
		constexpr const char* kNffXStoreScript = "nwsFollowerXStoreScript";
		RE::TESQuest*         g_xstoreQuest = nullptr;
		bool                  g_xstoreScanned = false;

		constexpr const char* kNffSandboxScript = "nwsFollowerSandboxScript";
		RE::TESQuest*         g_sandboxQuest = nullptr;
		bool                  g_sandboxScanned = false;

		/* ---- NFF's PLAYER CHEST ---------------------------------------------
		 * The shared, portable container at the centre of NFF's storage: it is
		 * where a cleared outfit set goes, where a dismissed follower's spare
		 * inventory is emptied, and where NFF puts anything it has to take off
		 * somebody. Until now the deck could reach a follower's satchel and her
		 * spare inventory but not the chest all of it drains INTO — a hole you
		 * only notice once something has moved and you cannot find it.
		 *
		 * Two entry points on nwsFollowerStorageScript, both zero-argument and
		 * both taken verbatim from that decompiled script:
		 *
		 *     RemoteOpen()   activate the chest wherever it is standing
		 *     PlaceChest()   move it to a spot beside the player
		 *
		 * PlaceChest polices ITSELF and we deliberately do not second-guess it:
		 * it refuses inside a LocTypeDungeon, and outside a city/town/player
		 * house (or within 4096 units of one of NFF's own home markers) it
		 * charges a ~4-game-hour cooldown, telling the player how long is left.
		 * Duplicating those rules here would mean two implementations of one
		 * policy, and ours would be the one that goes stale. */
		constexpr const char* kNffStorageScript = "nwsFollowerStorageScript";
		RE::TESQuest*         g_storageQuest = nullptr;
		bool                  g_storageScanned = false;

		// Same by-script-name scan as SandboxQuest: never a FormID, because the
		// quest that carries a script is the mod's business and can move.
		RE::TESQuest* XStoreQuest()
		{
			if (g_xstoreScanned)
				return g_xstoreQuest;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!vm || !dh)
				return nullptr;
			auto* policy = vm->GetObjectHandlePolicy();
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, q);
				if (handle == policy->EmptyHandle())
					continue;
				RE::BSTSmartPointer<RE::BSScript::Object> obj;
				if (vm->FindBoundObject(handle, kNffXStoreScript, obj) && obj) {
					g_xstoreQuest = q;
					break;
				}
			}
			g_xstoreScanned = true;
			if (g_xstoreQuest)
				logger::info("nff: spare-inventory script resolved ({:08X})", g_xstoreQuest->GetFormID());
			else
				logger::info("nff: {} not bound on any quest - spare inventory unavailable",
					kNffXStoreScript);
			return g_xstoreQuest;
		}

		// OpenStorage(Actor, Bool). One actor + one bool, which none of the
		// existing helpers take, so this is its own small dispatch.
		bool CallOpenStorage(RE::TESQuest* quest, RE::Actor* actor, std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Callback(std::move(done)));
			bool findOnly = false;   // False = actually open it, as the dialogue does
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(actor)), std::move(findOnly));
			return vm->DispatchMethodCall(handle, kNffXStoreScript, "OpenStorage", args, cb);
		}

		// Same by-script-name scan as XStoreQuest, same reason: NFF is free to
		// move which quest carries the script, and a FormID would rot.
		RE::TESQuest* StorageQuest()
		{
			if (g_storageScanned)
				return g_storageQuest;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!vm || !dh)
				return nullptr;
			auto* policy = vm->GetObjectHandlePolicy();
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, q);
				if (handle == policy->EmptyHandle())
					continue;
				RE::BSTSmartPointer<RE::BSScript::Object> obj;
				if (vm->FindBoundObject(handle, kNffStorageScript, obj) && obj) {
					g_storageQuest = q;
					break;
				}
			}
			g_storageScanned = true;
			if (g_storageQuest)
				logger::info("nff: player-chest script resolved ({:08X})", g_storageQuest->GetFormID());
			else
				logger::info("nff: {} not bound on any quest - player chest unavailable",
					kNffStorageScript);
			return g_storageQuest;
		}

		// A zero-argument method on a quest script. The two player-chest entry
		// points are exactly that, and CallGroupInts's argc-0 branch already
		// proves the shape works — this is its named twin so the call site reads
		// as what it is rather than as "the ints call with no ints".
		bool CallQuestVoid(RE::TESQuest* quest, const char* script, const char* fn,
			std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest || !fn)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Callback(std::move(done)));
			auto args = RE::MakeFunctionArguments();
			return vm->DispatchMethodCall(handle, script, fn, args, cb);
		}

		RE::TESQuest* SandboxQuest()
		{
			if (g_sandboxScanned)
				return g_sandboxQuest;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!vm || !dh)
				return nullptr;
			auto* policy = vm->GetObjectHandlePolicy();
			std::size_t seen = 0;
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				++seen;
				const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, q);
				if (handle == policy->EmptyHandle())
					continue;
				RE::BSTSmartPointer<RE::BSScript::Object> obj;
				if (vm->FindBoundObject(handle, kNffSandboxScript, obj) && obj) {
					g_sandboxQuest = q;
					break;
				}
			}
			g_sandboxScanned = true;
			if (!g_sandboxQuest)
				logger::info("nff: {} not bound on any of {} quests - party orders "
							 "(teleport all / relax all) stay unavailable",
					kNffSandboxScript, seen);
			else
				logger::info("nff: party group script resolved ({:08X})", g_sandboxQuest->GetFormID());
			return g_sandboxQuest;
		}

		// Same dispatch as CallQuestActorInts, minus the actor: these are group
		// functions and take ints only. `two` picks the 2-arg overload, because
		// StartSandbox takes one Int and DoTaskAll takes two.
		bool CallGroupInts(RE::TESQuest* quest, const char* fn,
			std::int32_t a, std::int32_t b, int argc, std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new Callback(std::move(done)));
			if (argc == 2) {
				auto args = RE::MakeFunctionArguments(std::move(a), std::move(b));
				return vm->DispatchMethodCall(handle, kNffSandboxScript, fn, args, cb);
			}
			if (argc == 1) {
				auto args = RE::MakeFunctionArguments(std::move(a));
				return vm->DispatchMethodCall(handle, kNffSandboxScript, fn, args, cb);
			}
			auto args = RE::MakeFunctionArguments();
			return vm->DispatchMethodCall(handle, kNffSandboxScript, fn, args, cb);
		}

		// Name a destination for the toast. nff_bridge has a richer version of
		// this, but it is file-local there and a second copy of a two-line
		// cell-name read is cheaper than widening that header for a toast.
		// Empty is fine and expected — the caller just says less.
		std::string PlaceNameOf(RE::TESObjectREFR* ref)
		{
			if (!ref)
				return {};
			if (auto* cell = ref->GetParentCell()) {
				if (const char* n = cell->GetFullName(); n && *n)
					return n;
			}
			if (auto* loc = ref->GetCurrentLocation()) {
				if (const char* n = loc->GetFullName(); n && *n)
					return n;
			}
			return {};
		}

		// Every loaded follower. NFF's per-actor orders (FollowerFollowMe /
		// FollowerWaitHere) only mean anything for someone in the high process,
		// so this is the honest set for those two - unlike the warp above, which
		// goes through NFF's aliases and reaches the unloaded.
		std::vector<RE::Actor*> LoadedTeammates()
		{
			std::vector<RE::Actor*> out;
			auto* lists = RE::ProcessLists::GetSingleton();
			if (!lists)
				return out;
			for (auto& h : lists->highActorHandles) {
				auto a = h.get();
				if (!a || a->IsDisabled() || a->IsDead() || a->IsPlayerRef())
					continue;
				if (!a->IsPlayerTeammate())
					continue;
				out.push_back(a.get());
			}
			return out;
		}

		// NFF's RemoveFollower takes (Actor, Int iMessage, Int iSayLine) — the
		// same two trailing arguments its own dismiss dialogue passes.
		bool CallDismiss(RE::TESQuest* quest, RE::Actor* actor, std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;

			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(actor)),
				std::move(static_cast<std::int32_t>(1)),   // iMessage: show the notice
				std::move(static_cast<std::int32_t>(1)));  // iSayLine: let her say it
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new Callback(std::move(done)));
			return vm->DispatchMethodCall(handle, kNffScript, "RemoveFollower", args, cb);
		}

		// Actor.OpenInventory(abForceOpen) has no C++ native — it is Papyrus
		// only, so it dispatches on the ACTOR rather than on a quest.
		bool CallOpenInventory(RE::Actor* actor, bool force, std::function<void(bool)> done)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return false;

			auto args = RE::MakeFunctionArguments(std::move(force));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new Callback(std::move(done)));
			return vm->DispatchMethodCall(handle, "Actor", "OpenInventory", args, cb);
		}

		// --------------------------------------------------------- helpers ----

		json Refuse(const std::string& msg, bool guarded = false, bool following = false)
		{
			return json{
				{ "ok", false }, { "phase", "refused" }, { "msg", msg },
				{ "guarded", guarded }, { "following", following }
			};
		}

		// NFF's own test for "is this person already following me". RecruitAction
		// decides with SearchAlias, which we cannot call; IsPlayerTeammate is the
		// observable half of what RecruitAction sets and is what the roster's own
		// `following` badge already uses.
		bool IsFollowing(RE::Actor* actor)
		{
			return actor && actor->IsPlayerTeammate();
		}

		// ------------------------------------------------- the half-recruit --
		// Skyrim.esm's follower factions. These are the records every follower
		// dialogue condition in the game (and in NFF, and in every companion
		// mod that wants vanilla compatibility) actually tests — see the long
		// note in nff_control.h for why an actor can end up in them without
		// being a teammate, and what that does to her dialogue.
		constexpr RE::FormID kCurrentFollowerFac = 0x0005C84E;
		constexpr RE::FormID kPlayerFollowerFac  = 0x00084D1B;

		// A ref-targeted console command, the same shape fix_actions.cpp uses.
		// CompileAndRun's target makes `removefromfaction` act ON that ref with
		// no `prid` dance.
		void RunConsole(const char* cmd, RE::TESObjectREFR* target)
		{
			auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
			auto* script = factory ? factory->Create() : nullptr;
			if (!script)
				return;
			script->SetCommand(cmd);
			script->CompileAndRun(target);
			delete script;
		}

		RE::TESFaction* FactionById(RE::FormID id)
		{
			auto* f = RE::TESForm::LookupByID(id);
			return f ? f->As<RE::TESFaction>() : nullptr;
		}

		// Her rank in a faction, or -1 when the record is missing or she is not
		// in it. GetFactionRank's second argument is "is this the player", which
		// is always false here.
		int RankIn(RE::Actor* actor, RE::FormID facId)
		{
			auto* fac = actor ? FactionById(facId) : nullptr;
			if (!fac || !actor->IsInFaction(fac))
				return -1;
			return actor->GetFactionRank(fac, false);
		}

		// ------------------------------------------------ make her recruitable --
		//
		// NFF's MCM "Force Follower" (Rober, 2026-08-11: "nff also had a force
		// follower option in mcm"). A THIRD verb, distinct from both the ones
		// above: Recruit makes her follow NOW, Import lends her NFF's features,
		// and this makes an NPC who is not normally a follower ELIGIBLE to be
		// recruited at all — it puts her in PotentialFollowerFaction, which is
		// the record every "follow me" dialogue condition tests.
		// $FF_ForceFollowerDS says it plainly: "ONLY use this on NPCs that are
		// not normally available as followers… This is NOT follower Import."
		//
		// Reimplemented here rather than dispatched to NFF's own ForceFollower()
		// for one concrete reason: that function takes NO argument and reads
		// Game.GetCurrentCrosshairRef() itself, which is not the actor the deck
		// resolved (the palette is open and owns input). Calling it would aim at
		// whatever the engine thinks the crosshair is — or at None, faulting on
		// GetVoiceType(). The body is three faction writes, mirrored exactly
		// from the decompiled nwsFollowerControllerExScript.
		constexpr RE::FormID kPotentialFollowerFac = 0x0005C84D;   // Skyrim.esm

		// The VOICE gate, which is the whole reason this can refuse. A voice type
		// with no follower dialogue would leave her flagged recruitable but with
		// nothing to say, so NFF checks a formlist first and so do we.
		// RDO replaces that list when it is installed, exactly as NFF does
		// (varScript.rdoActive) — its own list wins, else NFF's ships as default.
		constexpr RE::FormID  kNffVoicesFollowerId = 0x28E719;     // nwsFFvoicesFollower
		constexpr const char* kRdoPlugin           = "Relationship Dialogue Overhaul.esp";
		constexpr RE::FormID  kRdoVoicesFollowerId = 0x11767C;     // GetFormFromFile(1144444, …)

		RE::BGSListForm* FollowerVoiceList()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			if (auto* rdo = dh->LookupForm(kRdoVoicesFollowerId, kRdoPlugin))
				if (auto* l = rdo->As<RE::BGSListForm>())
					return l;
			if (auto* f = dh->LookupForm(kNffVoicesFollowerId, kNffPlugin))
				return f->As<RE::BGSListForm>();
			return nullptr;
		}

		// Does her voice type carry follower dialogue? Unknown (no list resolved)
		// is reported separately by the caller — refusing on a missing formlist
		// would block the feature outright if NFF ever renames the record.
		bool VoiceCanFollow(RE::Actor* actor, bool* listMissing)
		{
			auto* list = FollowerVoiceList();
			if (listMissing)
				*listMissing = (list == nullptr);
			if (!list || !actor)
				return false;
			auto* base = actor->GetActorBase();
			auto* voice = base ? base->GetVoiceType() : nullptr;
			return voice && list->HasForm(voice);
		}

		bool IsPotentialFollower(RE::Actor* actor)
		{
			auto* fac = actor ? FactionById(kPotentialFollowerFac) : nullptr;
			return fac && actor->IsInFaction(fac);
		}

		// The fingerprint ForceFollower leaves: potential follower, PLUS
		// CurrentFollowerFaction at rank -1, PLUS not actually following.
		//
		// This exists so the undo cannot fire on a NATURAL follower. Lydia is a
		// potential follower too, and stripping that from her would quietly
		// break a vanilla companion — "is she a potential follower" is not
		// enough to tell "someone I forced" from "someone who always was".
		// Rank -1 is the tell: the vanilla game does not put an un-recruited
		// follower in CurrentFollowerFaction at all, while both NFF's
		// ForceFollower and ours add it at exactly -1.
		//
		// ⚠ RankIn() cannot answer this — it returns -1 both for "not in the
		// faction" and "in it at rank -1". Ask IsInFaction and GetFactionRank
		// separately or the two states collapse into one.
		bool LooksForceFollowed(RE::Actor* actor)
		{
			if (!actor || !IsPotentialFollower(actor) || actor->IsPlayerTeammate())
				return false;
			auto* cur = FactionById(kCurrentFollowerFac);
			return cur && actor->IsInFaction(cur) && actor->GetFactionRank(cur, false) == -1;
		}

		const char* KindOf(RE::TESBoundObject* obj)
		{
			if (!obj)
				return "other";
			if (obj->IsArmor())
				return "armor";
			if (obj->IsWeapon())
				return "weapon";
			if (obj->IsAmmo())
				return "ammo";
			// NOT TESForm::IsLight() — no such predicate exists (the IsX family
			// stops at SoulGem/Weapon), and the name would read as "is an ESL"
			// anyway. A torch is FormType::Light.
			if (obj->Is(RE::FormType::Light))
				return "light";
			return "other";
		}

		// The body slot an armour piece occupies, as a short tag the card turns
		// into a little icon (head / body / hands / feet / …). Weapons, ammo and
		// torches carry no biped slot, so this returns "" for them and the row
		// keeps its KIND icon. A piece can claim several slots (a cuirass often
		// flags forearms and calves too); we report the most telling one, in the
		// priority below — "body" reads better than the arms it also occupies.
		const char* SlotOf(RE::TESBoundObject* obj)
		{
			static const bool marker = [] { logger::info("nff: equipped slot icons armed"); return true; }();
			(void)marker;
			auto* armo = obj ? obj->As<RE::TESObjectARMO>() : nullptr;
			if (!armo)
				return "";
			const auto mask = static_cast<std::uint32_t>(armo->GetSlotMask());
			if (!mask)
				return "";
			using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
			struct Map { Slot bit; const char* tag; };
			static const Map order[] = {
				{ Slot::kBody, "body" },
				{ Slot::kHead, "head" },
				{ Slot::kHair, "head" },
				{ Slot::kCirclet, "circlet" },
				{ Slot::kHands, "hands" },
				{ Slot::kForearms, "hands" },
				{ Slot::kFeet, "feet" },
				{ Slot::kCalves, "feet" },
				{ Slot::kShield, "shield" },
				{ Slot::kAmulet, "amulet" },
				{ Slot::kRing, "ring" },
			};
			for (const auto& m : order)
				if (mask & static_cast<std::uint32_t>(m.bit))
					return m.tag;
			return "";  // a mod-only slot we don't name — fall back to the armour icon
		}
	}

	bool Available()
	{
		return NffQuest() != nullptr;
	}

	bool IsWedgedFollower(RE::Actor* actor)
	{
		if (!actor || actor->IsPlayerTeammate() || actor->IsDead())
			return false;
		return RankIn(actor, kCurrentFollowerFac) >= 0;
	}

	bool IsImported(RE::Actor* actor)
	{
		auto* fac = actor ? NffFaction(kNffImportFacId) : nullptr;
		return fac && actor->IsInFaction(fac);
	}

	bool CanBeFollower(RE::Actor* actor) { return IsPotentialFollower(actor); }

	bool WasForcedFollower(RE::Actor* actor) { return LooksForceFollowed(actor); }

	// ----------------------------------------------------------------- ops ----

	std::string Apply(const std::string& cmdJson, Done done)
	{
		const auto j = json::parse(cmdJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("Bad command").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const auto op = j.value("op", std::string(""));

		/* ---- party orders: no target, no actor to resolve --------------------
		   Handled BEFORE TargetOf() precisely because their whole reason to
		   exist is the case where the crosshair is empty. Rober asked for these
		   on the card's idle state (2026-08-02): "teleport all, sandbox all,
		   follow all, wait all". */
		/* ---- NFF's player chest: open it, or bring it here -------------------
		   Target-free like the party orders, and for the same reason: the chest
		   is the party's, not one follower's. See StorageQuest() above for why
		   PlaceChest's refusals are left to PlaceChest. */
		if (op == "chestOpen" || op == "chestPlace") {
			auto* q = StorageQuest();
			if (!q)
				return Refuse("The player chest needs Nether's Follower Framework").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const bool  place = (op == "chestPlace");
			const char* fn    = place ? "PlaceChest" : "RemoteOpen";
			// PlaceChest can decline (dungeon, or the move cooldown) and says so
			// itself on screen. Reaching the callback only proves the call RAN,
			// so the reply promises the ASK, never the outcome.
			const std::string said = place ? "Asking for the chest here"
										   : "Opening the player chest";
			const bool sent = CallQuestVoid(q, kNffStorageScript, fn,
				[done, op, place](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", op }, { "via", "nff" },
							{ "msg", ok ? (place ? "Chest moved, if NFF allowed it here"
												 : "Player chest open")
										: "NFF did not answer about the chest" } }
								 .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (!sent)
				return Refuse("NFF would not reach the player chest").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			logger::info("nff: player chest {}", fn);
			return json{ { "ok", true }, { "phase", "sent" }, { "op", op }, { "via", "nff" },
				{ "msg", said + "\xE2\x80\xA6" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		if (op == "allSummon" || op == "allRelax" || op == "allUnrelax") {
			auto* sq = SandboxQuest();
			if (!sq)
				return Refuse("Party orders need Nether's Follower Framework").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			const char* fn   = (op == "allSummon") ? "DoTaskAll"
							 : (op == "allRelax")  ? "StartSandbox" : "ResetSandboxVars";
			const int   argc = (op == "allSummon") ? 2 : (op == "allRelax" ? 1 : 0);
			// DoTaskAll(task 2 = MoveFollower, onDemand 1); StartSandbox(1).
			const std::int32_t a = (op == "allSummon") ? 2 : 1;
			const std::int32_t b = 1;
			const std::string  said = (op == "allSummon") ? "Everyone, to me"
									: (op == "allRelax")  ? "Everyone, at ease"
														  : "Everyone, back to me";

			const bool sent = CallGroupInts(sq, fn, a, b, argc,
				[done, said, op](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", op }, { "via", "nff" },
							{ "msg", ok ? said : "NFF did not take that order" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (!sent)
				return Refuse("NFF did not accept the order").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{ { "ok", true }, { "phase", "sent" }, { "op", op }, { "via", "nff" },
				{ "msg", said + "…" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// Turn NFF's sandboxing on or off outright — its own MCM switch, not a
		// "relax now". Writing a GlobalVariable, so it takes effect on NFF's
		// very next tick with no Papyrus call and nothing to fail asynchronously.
		if (op == "allSandboxSet") {
			const int cur = NffBridge::SandboxLevel();
			if (cur < 0)
				return Refuse("Nether's Follower Framework is not answering").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// `level` when the caller is explicit (NFF has 4 modes, not 2),
			// otherwise flip: off -> 1, anything on -> 0.
			const int want = j.contains("level") && j["level"].is_number_integer()
				? j["level"].get<int>()
				: (cur > 0 ? 0 : 1);
			if (!NffBridge::SetSandboxLevel(want))
				return Refuse("Could not reach NFF's sandbox setting").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", op }, { "via", "nff" },
				{ "level", want },
				{ "msg", want > 0 ? "Sandboxing on — they'll settle when you stand still"
								  : "Sandboxing off — they'll stay in formation" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		if (op == "allFollow" || op == "allWait") {
			const bool wait = (op == "allWait");
			auto* q = NffQuest();
			if (!q)
				return Refuse("Party orders need Nether's Follower Framework").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const auto crew = LoadedTeammates();
			if (crew.empty())
				return Refuse("Nobody is following you right now").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			// One dispatch per follower, same call the single-person Wait/Follow
			// buttons make. No aggregate callback: NFF answers per actor and a
			// combined "3 of 4 worked" would need a barrier for no real gain —
			// the reply below states what was ORDERED, which is the honest claim.
			int fired = 0;
			for (auto* a : crew) {
				if (CallQuestActorInts(q, wait ? "FollowerWaitHere" : "FollowerFollowMe",
						a, /*notify*/ 0, /*doPerm*/ 0, /*twoInts*/ wait, nullptr))
					++fired;
			}
			if (!fired)
				return Refuse("NFF did not accept the order").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const std::string what = wait ? " told to wait here" : " following again";
			return json{ { "ok", true }, { "phase", "done" }, { "op", op }, { "via", "nff" },
				{ "msg", std::to_string(fired) + (fired == 1 ? " follower" : " followers") + what } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		if (op != "recruit" && op != "import" && op != "export" && op != "forceFollower" && op != "unforceFollower"
			&& op != "dismiss" && op != "inventory"
			&& op != "wait" && op != "follow" && op != "removeItem" && op != "sendHome" && op != "sandboxActor"
			&& op != "placeHere" && op != "storage" && op != "unequipItem" && op != "unwedge")
			return Refuse("Unknown follower action \"" + op + "\"").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* actor = TargetOf(j);
		if (!actor)
			return Refuse(j.value("formId", std::string("")).empty()
					? "No NPC targeted — look at someone, then open the deck"
					: "They aren't loaded right now").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (actor->IsPlayerRef())
			return Refuse("That's you").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const std::string name    = NameOf(actor);
		const std::string idHex   = HexOf(LocalIdOf(actor));
		const bool        follows = IsFollowing(actor);

		// ---- repair the half-recruit ----------------------------------------
		// Give her back to nobody: NFF's own dismiss first (it unwinds the alias
		// slot, the tweaks and the history entry — things we cannot see, let
		// alone undo), then the vanilla follower factions cleared directly for
		// whatever the dismiss did not reach. The order matters: clearing the
		// factions first would make NFF's RemoveFollower decide she was never
		// its follower and skip its own cleanup.
		//
		// The faction clear runs through the console (RE::Script), the same
		// proven path the Fixes tab uses — `removefromfaction` is the exact
		// inverse of what a recruit added, and unlike SetFactionRank(-1) it
		// leaves her looking like someone who was simply never recruited.
		if (op == "unwedge") {
			if (follows)
				return Refuse(name + " really is following you — use Dismiss, not Repair.",
					false, true).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const int curRank = RankIn(actor, kCurrentFollowerFac);
			if (curRank < 0)
				return Refuse(name + "'s follower state is already clean — this is not what "
					"is wrong with her.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			logger::info("NffControl: unwedge \"{}\" ({}) - CurrentFollower rank {}, teammate false",
				name, idHex, curRank);   // marker: follower-unwedge

			// NFF first, if it thinks it holds her at all.
			bool viaNff = false;
			if (auto* q = NffQuest())
				viaNff = CallDismiss(q, actor, nullptr);

			// Then the factions, after a beat so NFF's own pass lands first.
			const auto id = actor->GetFormID();
			std::thread([id, name, done, viaNff]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(viaNff ? 900 : 60));
				SKSE::GetTaskInterface()->AddTask([id, name, done, viaNff]() {
					auto* a = RE::TESForm::LookupByID<RE::Actor>(id);
					if (!a) {
						if (done)
							done(Refuse(name + " left before the repair finished").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
						return;
					}
					int cleared = 0;
					for (const RE::FormID fid : { kCurrentFollowerFac, kPlayerFollowerFac }) {
						if (RankIn(a, fid) < 0)
							continue;
						char cmd[64];
						std::snprintf(cmd, sizeof(cmd), "removefromfaction %08X", fid);
						RunConsole(cmd, a);
						++cleared;
					}
					// Re-read rather than assume: the console call is the engine's,
					// but reporting a repair we did not witness is the failure mode
					// this whole file is written against.
					const bool ok = RankIn(a, kCurrentFollowerFac) < 0;
					logger::info("NffControl: unwedge of {} -> {} ({} faction(s) cleared, nff dismiss {})",
						name, ok ? "clean" : "STILL WEDGED", cleared, viaNff ? "sent" : "skipped");
					if (done)
						done(json{
							{ "ok", ok }, { "phase", "done" }, { "op", "unwedge" },
							{ "via", viaNff ? "nff+factions" : "factions" },
							{ "msg", ok
								? (name + " is nobody's follower again — her Follow me line "
								   "should be back. Ask her in her OWN dialogue.")
								: (name + " is still flagged as a current follower — see HotkeyDeck.log") },
						}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			}).detach();

			return json{
				{ "ok", true }, { "phase", "sent" }, { "op", "unwedge" },
				{ "via", viaNff ? "nff+factions" : "factions" },
				{ "formId", idHex }, { "name", name },
				{ "msg", "Repairing " + name + "'s follower state…" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- open inventory -------------------------------------------------
		if (op == "inventory") {
			if (actor->IsDead())
				return Refuse(name + " is dead — loot them in the world").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// Broken-inventory guard for ANY follower (not just NFF-managed ones —
			// Amaniri runs her own follower mod). A dead entry left by an
			// uninstalled mod faults the engine's RemoveItem when you take
			// ANYTHING out in the native menu — a hard freeze (Rober, 2026-08-08,
			// removing a cloak off Amaniri). ScanInventory is a SEH-guarded
			// read-only walk, safe even on a damaged bag; if it finds junk we
			// refuse to OPEN rather than let a remove wedge the game.
			std::uint32_t bad = 0;
			if (!ScanInventory(actor, &bad)) {
				logger::warn("NffControl: inventory refused — {}'s inventory could not be read safely", name);
				return Refuse(name + "'s inventory looks damaged and can't be read safely — "
					"opening it risks a freeze. Clear the broken entries with ReSaver or the "
					"console first.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			if (bad) {
				logger::warn("NffControl: inventory refused — {} broken entr{} in \"{}\"'s bag would fault RemoveItem",
					bad, bad == 1 ? "y" : "ies", name);
				return Refuse(name + " has " + std::to_string(bad) + " broken item"
					+ (bad == 1 ? "" : "s") + " from an uninstalled mod. Taking anything out of "
					"her inventory would FREEZE the game, so it was not opened — clear "
					+ (bad == 1 ? "it" : "them") + " with the console (removeitem) or ReSaver first.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			const bool sent = CallOpenInventory(actor, /*force*/ true,
				[done, name](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", "inventory" },
							{ "msg", ok ? ("Opened " + name + "'s inventory") : "Inventory did not open" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (!sent)
				return Refuse("Could not reach the inventory — no save loaded?").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{
				{ "ok", true }, { "phase", "sent" }, { "op", "inventory" },
				{ "via", "engine" }, { "formId", idHex }, { "name", name },
				{ "msg", "Opening " + name + "'s inventory" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- her NFF spare inventory ----------------------------------------
		// A third, separate container: not her own inventory (above) and not
		// her outfit chests (nff_outfits). NFF calls it extra storage and its
		// dialogue opens it with OpenStorage(actor, False).
		if (op == "storage") {
			if (actor->IsDead())
				return Refuse(name + " is dead — loot them in the world").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			auto* q = XStoreQuest();
			if (!q)
				return Refuse("Spare inventory needs Nether's Follower Framework").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const bool sent = CallOpenStorage(q, actor,
				[done, name](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", "storage" },
							{ "msg", ok ? ("Opened " + name + "'s spare inventory")
										: "NFF did not open the spare inventory" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (!sent)
				return Refuse("NFF would not open the spare inventory").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{
				{ "ok", true }, { "phase", "sent" }, { "op", "storage" },
				{ "via", "nff" }, { "formId", idHex }, { "name", name },
				{ "msg", "Opening " + name + "'s spare inventory" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- remove one carried item ----------------------------------------
		// For the junk that accumulates on a long-running follower: a leftover
		// from an uninstalled mod shows up as "<Missing Name>" and there is no
		// way to get rid of it from the container menu, because the game will
		// not show you a name to click.
		//
		// DESTROYS it (kRemove with no destination) rather than handing it to
		// the player — moving broken junk into your own pack is not solving the
		// problem, it is relocating it. The view arms this behind a second
		// click, which is where the safety belongs.
		if (op == "removeItem") {
			const auto itemId  = j.value("item", std::string(""));
			const auto itemPlg = j.value("itemPlugin", std::string(""));
			const auto count   = j.value("count", 1);
			if (itemId.empty())
				return Refuse("No item to remove").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			RE::TESBoundObject* obj = nullptr;
			const std::uint32_t local = ParseHex(itemId);
			if (local) {
				if (!itemPlg.empty()) {
					if (auto* dh = RE::TESDataHandler::GetSingleton())
						if (auto* f = dh->LookupForm(local, itemPlg))
							obj = f->As<RE::TESBoundObject>();
				}
				if (!obj)
					if (auto* f = RE::TESForm::LookupByID(local))
						obj = f->As<RE::TESBoundObject>();
			}
			if (!obj)
				return Refuse("That item no longer resolves — its plugin may be gone").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			// Gate 1: is the TARGET itself a live, registered form? A readable
			// pointer is not enough — see FormIsLive.
			if (!FormIsLive(obj)) {
				logger::warn("NffControl: removeItem refused — target form {:08X} is not live (plugin gone?)", local);
				return Refuse("That item's form is broken — its plugin is gone. "
					"Removing it would wedge the game, so nothing was touched.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// The name BEFORE removing it: afterwards the form may be the only
			// thing that knew what it was called.
			std::string what;
			if (const char* n = obj->GetName(); n && *n)
				what = n;
			if (what.empty())
				what = "that item";

			// Gate 2: RemoveItem walks the WHOLE inventory, so a dead entry
			// anywhere in it faults the call even when our target is fine.
			std::uint32_t bad = 0;
			if (!ScanInventory(actor, &bad)) {
				logger::warn("NffControl: removeItem refused — inventory of \"{}\" could not be verified", name);
				return Refuse(name + "'s inventory can't be read safely — it looks damaged. "
					"Nothing was changed; clear it from the console (removeitem) instead.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			if (bad) {
				logger::warn("NffControl: removeItem refused — {} broken entr{} in \"{}\"'s inventory would fault RemoveItem",
					bad, bad == 1 ? "y" : "ies", name);
				return Refuse(name + " has " + std::to_string(bad) + " broken item"
					+ (bad == 1 ? "" : "s") + " left by an uninstalled mod. Touching the "
					"inventory would freeze the game, so nothing was removed — clear "
					+ (bad == 1 ? "it" : "them") + " from the console first.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Proven safe — call the engine DIRECTLY. Deliberately NOT wrapped in
			// SEH: catching a fault mid-mutation is what caused the hang.
			actor->RemoveItem(obj, count > 0 ? count : 1,
				RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
			logger::info("NffControl: removed \"{}\" x{} from \"{}\"", what, count, name);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", "removeItem" },
				{ "via", "engine" }, { "formId", idHex }, { "name", name },
				{ "msg", "Removed " + what + " from " + name }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- take a worn item OFF (unequip, any slot) -----------------------
		// The safe "strip" for a stuck/broken-mesh worn item (Rober, 2026-08-08):
		// UnequipObject is SLOT-TARGETED — it does NOT walk the whole inventory
		// the way RemoveItem does, so a dead entry elsewhere in the bag can't
		// fault it (that is what froze a removal). It only frees the slot (stops
		// the 3D) and leaves the item in her bag, so it is reversible. Works for
		// any biped slot. We still validate the TARGET form is live before the
		// engine call (never SEH around a mutation — see the rule up top).
		if (op == "unequipItem") {
			const auto itemId  = j.value("item", std::string(""));
			const auto itemPlg = j.value("itemPlugin", std::string(""));
			if (itemId.empty())
				return Refuse("No item to take off").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			RE::TESBoundObject* obj = nullptr;
			const std::uint32_t local = ParseHex(itemId);
			if (local) {
				if (!itemPlg.empty())
					if (auto* dh = RE::TESDataHandler::GetSingleton())
						if (auto* f = dh->LookupForm(local, itemPlg))
							obj = f->As<RE::TESBoundObject>();
				if (!obj)
					if (auto* f = RE::TESForm::LookupByID(local))
						obj = f->As<RE::TESBoundObject>();
			}
			if (!obj)
				return Refuse("That item no longer resolves — its plugin may be gone. "
					"Clear it with ReSaver instead.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (!FormIsLive(obj)) {
				logger::warn("NffControl: unequipItem refused — target form {:08X} is not live", local);
				return Refuse("That item's form is broken (its plugin is gone), so it can't be "
					"taken off safely — clear it with ReSaver.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			std::string what;
			if (const char* n = obj->GetName(); n && *n)
				what = n;
			if (what.empty())
				what = "that item";

			auto* eqm = RE::ActorEquipManager::GetSingleton();
			if (!eqm)
				return Refuse("The equip manager isn't available right now").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			eqm->UnequipObject(actor, obj);
			logger::info("NffControl: unequipped \"{}\" from \"{}\" (strip)", what, name);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", "unequipItem" },
				{ "via", "engine" }, { "formId", idHex }, { "name", name },
				{ "msg", "Took " + what + " off " + name }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- wait here / follow me ------------------------------------------
		// Both are NFF's own, and both are only meaningful for someone already
		// following: FollowerWaitHere on a stranger notifies "$FF_WarnInvalid"
		// and does nothing, which is a worse answer than refusing in words.
		if (op == "wait" || op == "follow") {
			const bool wait = (op == "wait");
			if (actor->IsDead())
				return Refuse(name + " is dead").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (!follows)
				return Refuse(name + " isn't following you", false, false).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			auto* q = NffQuest();
			if (!q)
				return Refuse(std::string(wait ? "Wait" : "Follow")
					+ " needs Nether's Follower Framework — use her dialogue").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			const bool sent = CallQuestActorInts(q,
				wait ? "FollowerWaitHere" : "FollowerFollowMe",
				actor, /*notify*/ 1, /*doPerm*/ 0, /*twoInts*/ wait,
				[done, name, wait](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" },
							{ "op", wait ? "wait" : "follow" }, { "via", "nff" },
							{ "msg", ok ? (name + (wait ? " will wait here" : " is following again"))
										: (std::string("NFF did not take that order for ") + name) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (!sent)
				return Refuse("NFF did not accept the order").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{
				{ "ok", true }, { "phase", "sent" }, { "op", op }, { "via", "nff" },
				{ "formId", idHex }, { "name", name },
				{ "msg", wait ? (name + ", wait here") : (name + ", follow me") }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- assign her NFF home base ---------------------------------------
		// The read side (her base name, and "Send back -> her NFF base") has been
		// here for a while; there was no way to CHANGE it, so the base was a fact
		// you had to go and set through NFF's dialogue. NffBridge::SetBase writes
		// the same faction rank NFF's own script writes, so this is the same
		// operation, not a parallel one. index < 0 means "no base".
		if (op == "setBase") {
			const int  index = j.value("index", -1);
			std::string err;
			if (!NffBridge::SetBase(actor, index, err))
				return Refuse(err.empty() ? std::string("Could not set her home base") : err).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const auto label = j.value("baseName", std::string(""));
			const std::string msg = (index < 0)
				? (name + " has no home base now")
				: (name + "'s home base is " + (label.empty() ? std::string("set") : label));
			// No toast: the card shows `msg` in its own status line, which is
			// where you are already looking, and this file has no Notify helper.
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", "setBase" }, { "via", "nff" },
				{ "formId", idHex }, { "name", name }, { "index", index },
				{ "msg", msg }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- her own sandbox checkbox ---------------------------------------
		// Per-follower, unlike allSandboxSet (the global) and the party relax
		// orders (timing). A faction rank write, so it takes effect on NFF's
		// next tick with nothing async to fail.
		if (op == "sandboxActor") {
			const bool cur = NffBridge::SandboxAllowedFor(actor);
			const bool want = j.contains("on") && j["on"].is_boolean() ? j["on"].get<bool>() : !cur;
			if (!NffBridge::SetSandboxAllowedFor(actor, want))
				return Refuse("Nether\'s Follower Framework is not answering").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", op }, { "via", "nff" },
				{ "formId", idHex }, { "name", name }, { "on", want },
				{ "msg", want ? (name + " will settle with the others")
							  : (name + " will stay put in formation") }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- send her home --------------------------------------------------
		// "Send back" used to mean only Follower Organizer's snapshot-undo:
		// wherever she stood before you summoned her. Rober asked for the
		// destinations he actually thinks in (2026-08-02) — her MHiYH home, her
		// NFF base, or any marked Domain. Domains already had a route
		// (PlaceActions::MoveNpcTo via pdNpcTo); the two HOMES are here, because
		// only nff_bridge can say where they are.
		//
		// One engine MoveTo onto the mod's own marker — the same call the
		// Domains recall makes, and no attempt to re-derive a position from it.
		// If MHiYH later moves her home, this follows automatically, because we
		// resolve the ref at press time rather than storing coordinates.
		/* ---- she has gone missing: put her in front of you ------------------
		 *  "sometimes npc has despawned or something that ive added maybe an
		 *  option to place them at you?" (Rober, 2026-08-02).
		 *
		 *  Summon (fdWorld) is gated on her being IN THE WORLD, which is
		 *  exactly the state this is for — so it is a separate op rather than
		 *  a relaxed Summon. Three things can be wrong and they need different
		 *  handling, in this order:
		 *
		 *    disabled   an Enable() first, or MoveTo puts an invisible actor at
		 *               your feet and the deck looks like it did nothing.
		 *    dead       refused. Hauling a corpse to you is almost never what
		 *               "she despawned" means, and resurrecting is a decision
		 *               the deck has no business taking on its own.
		 *    unloaded   nothing special: MoveTo works on a persistent ref that
		 *               is not in the high process, which is the whole reason
		 *               this can rescue someone in another hold.
		 *
		 *  EvaluatePackage afterwards so she picks up her AI where she stands
		 *  instead of idling until something else nudges her.
		 */
		if (op == "placeHere") {
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !player->GetParentCell())
				return Refuse("You aren't standing anywhere she can be put yet").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (actor->IsDead())
				return Refuse(name + " is dead — this brings back the missing, not the fallen").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			const bool wasDisabled = actor->IsDisabled();
			if (wasDisabled)
				actor->Enable(false);

			actor->MoveTo(player);
			actor->EvaluatePackage();

			logger::info("nff: placed {} at the player{}", name,
				wasDisabled ? " (was disabled - re-enabled)" : "");
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", op }, { "via", "engine" },
				{ "formId", idHex }, { "name", name },
				{ "msg", name + (wasDisabled ? " was gone — re-enabled and brought here"
											 : " brought here") }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		if (op == "sendHome") {
			const auto dest = j.value("dest", std::string(""));
			if (dest != "mhiyh" && dest != "nff")
				return Refuse("Unknown destination \"" + dest + "\"").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (actor->IsDead())
				return Refuse(name + " is dead").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			auto* home = NffBridge::HomeRefFor(actor, dest);
			if (!home)
				return Refuse(name + (dest == "mhiyh"
						? " has no My Home is Your Home home yet"
						: " has no Nether's Follower Framework base")).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (home->IsDisabled() || home->IsDeleted())
				return Refuse("Her home marker is not in the world any more").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			actor->MoveTo(home);
			const std::string where = PlaceNameOf(home);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", op }, { "via", dest },
				{ "formId", idHex }, { "name", name },
				{ "msg", name + " sent home" + (where.empty() ? "" : " — " + where) }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- dismiss --------------------------------------------------------
		if (op == "dismiss") {
			if (!follows)
				return Refuse(name + " isn't following you").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			auto* q = NffQuest();
			if (!q)
				return Refuse("Dismiss needs Nether's Follower Framework — use her dialogue").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const bool sent = CallDismiss(q, actor, [done, name](bool ok) {
				if (done)
					done(json{ { "ok", ok }, { "phase", "done" }, { "op", "dismiss" },
						{ "via", "nff" },
						{ "msg", ok ? (name + " was dismissed") : ("NFF did not dismiss " + name) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			});
			if (!sent)
				return Refuse("NFF did not accept the dismissal").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return json{
				{ "ok", true }, { "phase", "sent" }, { "op", "dismiss" }, { "via", "nff" },
				{ "formId", idHex }, { "name", name },
				{ "msg", "Dismissing " + name + "…" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- add to / remove from the framework (NFF Import / Export) -------
		//
		// NFF's own "[Add to Framework (Import)]" dialogue verb ($FF_SayImport),
		// offered here on ANY NPC — that is the whole point. NFF only shows that
		// dialogue when its own checks pass ("Import generally only checks if a
		// follower is in the game's follower faction and if they are a player
		// teammate" — $FF_DlgAllowImportDS), so someone it will not offer it for
		// is unreachable without this button.
		//
		// ⚠ IMPORT IS NOT RECRUITMENT. Read the decompiled controller before
		// changing a word of this (2026-08-11): RecruitAction sets
		// SetPlayerTeammate(true), the relationship rank, CurrentFollowerFaction
		// and PlayerFollowerFaction; ImportAction sets NONE of them. It parks her
		// in a follower alias and adds nwsFF_ImportFac / box / stealth factions,
		// so she "borrows features of NFF" — gear, tweaks, storage, sandbox —
		// while HER OWN follow package keeps running ($FF_ToggleBaseFollowDS:
		// "for imported Followers, this is the follow package that comes with
		// them"). That is exactly why it suits a companion with her own follower
		// mod, and why Dismiss is NOT the way back: NFF "cannot affect their
		// recruitment or dismissal" ($FF_HireCostDS). Export is the way back,
		// which is why both verbs live here as a reversible pair.
		if (op == "import" || op == "export") {
			const bool imported = IsImported(actor);
			auto*      q        = NffQuest();
			if (!q)
				return Refuse(std::string(op == "import" ? "Adding to" : "Removing from")
					+ " the framework needs Nether's Follower Framework").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			if (op == "import") {
				if (actor->IsDead())
					return Refuse(name + " is dead").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				// NFF's own answer for this case is a notification we would
				// never see ("is already in your group..."), so say it here.
				if (imported)
					return Refuse(name + " is already in the framework — use Remove to take her out.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				// Deliberately NO guarded-name gate. Recruit warns that a
				// companion with her own follower mod would get two controllers;
				// import is the opposite — it is the supported way to let
				// exactly that companion use NFF's features without touching
				// who she follows. Warning here would steer Rober away from the
				// one verb that is correct for Amaniri and Vayne.
				const bool sent = CallQuestActor(q, kNffScript, "ImportFollower", actor,
					[done, name](bool ok) {
						if (done)
							done(json{ { "ok", ok }, { "phase", "done" }, { "op", "import" },
								{ "via", "nff" }, { "imported", ok },
								{ "msg", ok ? (name + " added to the framework")
											: ("NFF did not add " + name + " — no free follower slot?") } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
					});
				if (!sent)
					return Refuse("NFF did not accept the import — is a save loaded?").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				logger::info("NffControl: add-to-framework \"{}\" ({}) via NFF ImportFollower", name, idHex);
				return json{
					{ "ok", true }, { "phase", "sent" }, { "op", "import" }, { "via", "nff" },
					{ "formId", idHex }, { "name", name },
					{ "msg", "Adding " + name + " to the framework…" }
				}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			if (!imported)
				return Refuse(name + " is not in the framework").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// ExportFollower(actor, doCount) -> ExportAction(actor, doCount, 1).
			// doCount 1 = refresh the follower count, which is what NFF's own
			// export dialogue passes.
			const bool sent = CallQuestActorInts(q, "ExportFollower", actor,
				/*doCount*/ 1, /*unused*/ 0, /*twoInts*/ false,
				[done, name](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", "export" },
							{ "via", "nff" }, { "imported", !ok },
							{ "msg", ok ? (name + " removed from the framework")
										: ("NFF did not remove " + name) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (!sent)
				return Refuse("NFF did not accept the export").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			logger::info("NffControl: remove-from-framework \"{}\" ({}) via NFF ExportFollower", name, idHex);
			return json{
				{ "ok", true }, { "phase", "sent" }, { "op", "export" }, { "via", "nff" },
				{ "formId", idHex }, { "name", name },
				{ "msg", "Removing " + name + " from the framework…" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- make her recruitable (NFF's MCM "Force Follower") --------------
		// Mirrors nwsFollowerControllerExScript::ForceFollower on the actor the
		// deck resolved. See the note beside kPotentialFollowerFac for why this
		// is reimplemented rather than dispatched.
		if (op == "forceFollower") {
			if (actor->IsDead())
				return Refuse(name + " is dead").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (IsPotentialFollower(actor))
				return Refuse(name + " can already be asked to follow — this is for NPCs who cannot.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// SAME GUARD AS RECRUIT, and for a stronger reason. Recruit warns
			// that a companion with her own follower mod would get two
			// controllers; this writes the vanilla follower factions and the
			// relationship rank onto her permanently, which is that same
			// collision made durable. It was unguarded until Rober asked
			// whether the merged button was a good idea (2026-08-11) — the
			// merge had put it in the slot where Recruit used to be, so
			// muscle memory could meddle with Amaniri or Vayne in one click.
			if (!j.value("force", false) && IsGuardedActor(actor, name))
				return Refuse(name + " runs her own follower system — forcing her into the "
					"vanilla follower factions can fight it, and the deck cannot undo the "
					"relationship change. Click again to do it anyway.", true).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			bool listMissing = false;
			if (!VoiceCanFollow(actor, &listMissing)) {
				if (listMissing)
					return Refuse("Could not read NFF's follower-voice list, so whether "
						+ name + " has follower dialogue is unknown — not risking a mute follower.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				// NFF's own refusal ($FF_CantFollower), said in words that
				// explain it instead of a notification you have to interpret.
				return Refuse(name + "'s voice type has no follower dialogue, so she cannot "
					"be a follower — flagging her would leave her recruitable but with "
					"nothing to say. (NFF refuses this too.)").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			auto* pot = FactionById(kPotentialFollowerFac);
			if (!pot)
				return Refuse("PotentialFollowerFaction is missing — is a save loaded?").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// AddToFaction(faction, rank) is the whole operation in CommonLibSSE
			// — there is no Actor::SetFactionRank, and it is add-or-update on
			// someone already in the faction (see nff_bridge.cpp).
			actor->AddToFaction(pot, 0);
			// CurrentFollowerFaction at rank -1: NFF adds it so its own checks
			// see her, and -1 deliberately means "not currently following". It
			// also keeps IsWedgedFollower (rank >= 0) from reading her as the
			// half-recruit state the Repair button exists for.
			if (auto* cur = FactionById(kCurrentFollowerFac); cur && !actor->IsInFaction(cur))
				actor->AddToFaction(cur, -1);
			// Rank 3 ("Friend") is what the follow dialogue expects. Written
			// through the Papyrus native like every other rank change in this
			// codebase (relationship.cpp): SetRelationshipRank writes the RELA
			// record both ways and fires the events mod content listens for,
			// which a direct poke would not. Asynchronous by nature — the
			// message below claims only what was ORDERED.
			if (Relationship::Of(actor).rank < 3) {
				if (auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton()) {
					auto* policy = vm->GetObjectHandlePolicy();
					const auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
					if (handle != policy->EmptyHandle()) {
						auto args = RE::MakeFunctionArguments(
							std::move(static_cast<RE::Actor*>(RE::PlayerCharacter::GetSingleton())),
							std::move(static_cast<std::int32_t>(3)));
						RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
						vm->DispatchMethodCall(handle, "Actor", "SetRelationshipRank", args, cb);
					}
				}
			}
			logger::info("NffControl: force-follower \"{}\" ({}) - PotentialFollowerFaction added", name, idHex);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", "forceFollower" }, { "via", "nff" },
				{ "formId", idHex }, { "name", name }, { "canFollow", true }, { "forced", true },
				{ "msg", name + " can now be asked to follow — use Recruit, or her own dialogue" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- undo it (put her back out of the follower pool) ----------------
		// The counterpart the merged button was missing: every other verb in
		// that slot undoes (Dismiss undoes Recruit, Export undoes Import), and
		// this one did not, which is what made it risky to sit where Recruit
		// used to be.
		//
		// HONEST LIMIT, stated in the reply rather than papered over: the
		// relationship rank is NOT reverted. ForceFollower raises it to 3 only
		// when it was lower, and the previous value is not recorded anywhere,
		// so "restoring" it would mean inventing a number. Removing the two
		// factions is the part that actually decides whether she can be asked
		// to follow; the rank is just how much she likes you.
		if (op == "unforceFollower") {
			if (!IsPotentialFollower(actor))
				return Refuse(name + " is not in the follower pool").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (actor->IsPlayerTeammate())
				return Refuse(name + " is following you right now — dismiss her first").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (!LooksForceFollowed(actor))
				return Refuse(name + " is a follower in her own right, not one you forced — "
					"taking that away would break her.").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

			auto* pot = FactionById(kPotentialFollowerFac);
			if (!pot)
				return Refuse("PotentialFollowerFaction is missing — is a save loaded?").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			actor->RemoveFromFaction(pot);
			// Only the rank -1 marker we (or NFF) added; a real follower rank
			// is never touched, and LooksForceFollowed already proved it is -1.
			if (auto* cur = FactionById(kCurrentFollowerFac); cur && actor->IsInFaction(cur))
				actor->RemoveFromFaction(cur);
			logger::info("NffControl: un-force-follower \"{}\" ({}) - removed from the follower pool", name, idHex);
			return json{
				{ "ok", true }, { "phase", "done" }, { "op", "unforceFollower" }, { "via", "nff" },
				{ "formId", idHex }, { "name", name }, { "canFollow", false }, { "forced", false },
				{ "msg", name + " can no longer be asked to follow (her opinion of you is unchanged)" }
			}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// ---- recruit --------------------------------------------------------
		// Every gate below is reproduced from NFF's own RecruitFollower /
		// RecruitAction so the deck can refuse in WORDS instead of dispatching a
		// call that returns silently.
		if (actor->IsDead())
			return Refuse(name + " is dead").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (follows)
			return Refuse(name + " is already following you", false, true).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (!j.value("force", false) && IsGuardedActor(actor, name))
			return Refuse(name + " has her own follower system — recruiting her into NFF gives her two. Click again to do it anyway.",
				true).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		// NFF first, always; vanilla only when the framework is not installed.
		if (auto* q = NffQuest()) {
			const bool sent = CallQuestActor(q, kNffScript, "RecruitFollower", actor,
				[done, name](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", "recruit" },
							{ "via", "nff" },
							{ "msg", ok ? (name + " joined you") : ("NFF did not recruit " + name) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (sent) {
				logger::info("NffControl: recruit \"{}\" ({}) via NFF", name, idHex);
				return json{
					{ "ok", true }, { "phase", "sent" }, { "op", "recruit" }, { "via", "nff" },
					{ "formId", idHex }, { "name", name },
					{ "msg", "Asking " + name + " to follow…" }
				}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
		}

		if (auto* q = VanillaFollowerQuest()) {
			const bool sent = CallQuestActor(q, kVanillaScript, "SetFollower", actor,
				[done, name](bool ok) {
					if (done)
						done(json{ { "ok", ok }, { "phase", "done" }, { "op", "recruit" },
							{ "via", "vanilla" },
							{ "msg", ok ? (name + " joined you") : ("Could not recruit " + name) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				});
			if (sent) {
				logger::info("NffControl: recruit \"{}\" ({}) via vanilla DialogueFollower "
							 "(NFF not installed)", name, idHex);
				return json{
					{ "ok", true }, { "phase", "sent" }, { "op", "recruit" }, { "via", "vanilla" },
					{ "formId", idHex }, { "name", name },
					{ "msg", "Asking " + name + " to follow…" }
				}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
		}

		return Refuse("No follower framework answered — is a save loaded?").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ----------------------------------------------------------- equipped ----

	std::string EquippedJson(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return json{ { "ok", false }, { "msg", "Bad request" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* actor = TargetOf(j);
		if (!actor)
			return json{ { "ok", false }, { "msg", "They aren't loaded right now" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		// Which forms belong to the actor's default outfit — the set the
		// ContainerMenu is entitled to hide or lock. Collected once, up front.
		std::vector<RE::FormID> outfitIds;
		std::string             outfitName;
		if (auto* base = actor->GetActorBase()) {
			if (auto* out = base->defaultOutfit) {
				if (const char* on = out->GetFormEditorID(); on && *on)
					outfitName = on;
				for (auto* form : out->outfitItems)
					if (form)
						outfitIds.push_back(form->GetFormID());
			}
		}
		const auto isOutfitItem = [&outfitIds](RE::FormID id) {
			return std::find(outfitIds.begin(), outfitIds.end(), id) != outfitIds.end();
		};

		// IsWorn() over the whole inventory, NOT the biped slots: a sword, a
		// quiver and a torch are equipped and occupy no biped slot at all, and
		// "all equipped items" has to mean all of them.
		json items = json::array();
		auto inv   = actor->GetInventory();
		for (auto& [obj, data] : inv) {
			if (!obj || data.first <= 0)
				continue;
			auto* entry = data.second.get();
			if (!entry || !entry->IsWorn())
				continue;

			std::string nm;
			if (const char* dn = entry->GetDisplayName(); dn && *dn)
				nm = dn;                              // carries temper / enchant naming
			else if (const char* fn = obj->GetName(); fn && *fn)
				nm = fn;
			if (nm.empty())
				continue;                             // unnamed / FakeItem rows

			items.push_back(json{
				{ "formId", HexOf(LocalIdOf(obj)) },
				{ "plugin", PluginOf(obj) },
				{ "name", nm },
				{ "kind", KindOf(obj) },
				{ "slot", SlotOf(obj) },
				{ "count", data.first },
				{ "outfit", isOutfitItem(obj->GetFormID()) } });
		}

		// Stable, scannable order: armour, then weapons, then the rest; name
		// within each. Sorted here rather than in the view so the portal and the
		// deck agree without duplicating the rule.
		const auto rank = [](const std::string& k) {
			if (k == "armor") return 0;
			if (k == "weapon") return 1;
			if (k == "ammo") return 2;
			if (k == "light") return 3;
			return 4;
		};
		std::sort(items.begin(), items.end(), [&rank](const json& a, const json& b) {
			const auto ra = rank(a.value("kind", std::string("other")));
			const auto rb = rank(b.value("kind", std::string("other")));
			if (ra != rb)
				return ra < rb;
			return Lower(a.value("name", std::string(""))) < Lower(b.value("name", std::string("")));
		});

		/* A small dossier alongside the worn set. Same call, because the card
		 * wants both at the same moment and a second round trip to the same
		 * actor would only be a second chance to disagree with itself.
		 * Everything here is a plain engine read — no Papyrus, nothing that can
		 * fail slowly. */
		auto* base = actor->GetActorBase();
		json  who  = json::object();
		who["level"] = static_cast<int>(actor->GetLevel());
		who["essential"] = actor->IsEssential();
		who["protected"] = actor->IsProtected();
		who["ghost"]     = actor->IsGhost();
		if (base) {
			who["female"] = base->IsFemale();
			who["unique"] = base->IsUnique();
		}
		if (auto* race = actor->GetRace()) {
			if (const char* rn = race->GetFullName(); rn && *rn)
				who["race"] = std::string(rn);
		}
		if (auto* avo = actor->AsActorValueOwner()) {
			// Current vs permanent, so a wounded follower reads as wounded
			// rather than as someone with a small health pool.
			const float cur = avo->GetActorValue(RE::ActorValue::kHealth);
			const float max = avo->GetPermanentActorValue(RE::ActorValue::kHealth);
			who["health"]    = static_cast<int>(cur < 0.0f ? 0.0f : cur);
			who["healthMax"] = static_cast<int>(max < 0.0f ? 0.0f : max);
		}

		/* What she is to the PLAYER, engine-side: the RELA rank the whole game
		 * branches on. It rides here rather than on its own bridge because the
		 * card wants it at the same instant as the rest of the dossier, and the
		 * read is a synchronous array walk — no Papyrus, nothing that can fail
		 * slowly. `relHas` distinguishes a real Acquaintance record from having
		 * no record at all; the slider needs that to say "unset" honestly
		 * instead of parking itself at 0 and implying an opinion. */
		{
			const auto rel = Relationship::Of(actor);
			who["relHas"]    = rel.has;
			who["rank"]      = rel.rank;
			who["rankLabel"] = Relationship::LabelOf(rel.rank);
		}

		/* Married? M.A.R.A.S's answer, which is NOT derivable from the rank
		 * above — the mod will keep you wed to someone the engine calls a Foe.
		 * Emitted only when the mod is installed, so the view can tell "not
		 * married" apart from "nobody asked", and an absent key is never read
		 * as a no. Faction-rank reads only; see maras.h for why not Papyrus. */
		if (auto ms = Maras::Json(Maras::Of(actor)); !ms.empty()) {
			auto mj = json::parse(ms, nullptr, false);
			if (!mj.is_discarded())
				who["maras"] = std::move(mj);
		}

		return json{
			{ "ok", true },
			{ "who", NameOf(actor) },
			{ "formId", HexOf(LocalIdOf(actor)) },
			{ "following", IsFollowing(actor) },
			{ "dead", actor->IsDead() },
			{ "about", who },
			{ "outfit", outfitName.empty() ? json(nullptr) : json(outfitName) },
			{ "items", items }
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
