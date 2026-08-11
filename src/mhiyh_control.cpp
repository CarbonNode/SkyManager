#include "mhiyh_control.h"

#include "follower_frameworks.h"  // never borrow a framework-owned companion
#include "nff_bridge.h"
#include "nff_control.h"   // borrow-recruit, so MarkHome's follower gate is not a dead end

#include <atomic>
#include <memory>

#include <thread>

#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and the logger.

using json = nlohmann::json;

namespace MhiyhControl
{
	namespace
	{
		// The mod's own hidden global-function script. Its .pex ships in
		// Data\Scripts and its own scheduler calls into it every batch, so in
		// any save where MHiYH has ever run the type is already loaded; the VM
		// loads it on demand otherwise.
		constexpr const char* kScript = "MHiYHController";

		constexpr int kKindCount = 8;
		constexpr int kHome = 0;
		constexpr int kGuardPassive = 7;

		// Kind labels, for messages only. MMTYHNative's numbering (the view's
		// ACTS spec owns the *presentation* labels; these are the fallback for
		// a message composed on this side).
		const char* KindLabel(int k)
		{
			switch (k) {
			case 0:  return "home";
			case 1:  return "sleeping spot";
			case 2:  return "work spot";
			case 3:  return "guard post";
			case 4:  return "breakfast spot";
			case 5:  return "lunch spot";
			case 6:  return "dinner spot";
			case 7:  return "watch post";
			default: return "spot";
			}
		}

		std::string Dump(const json& j)
		{
			// Engine strings can carry cp1252 bytes; dump() must never throw on
			// the way into a PrismaUI Invoke.
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// "0x0001A6A1" / "1A6A1" -> 0x0001A6A1. 0 on anything unusable.
		RE::FormID ParseFormId(const std::string& s)
		{
			if (s.empty())
				return 0;
			try {
				return static_cast<RE::FormID>(std::stoul(s, nullptr, 16));
			} catch (...) {
				return 0;
			}
		}

		json Refuse(const std::string& msg)
		{
			return json{ { "ok", false }, { "phase", "refused" }, { "msg", msg } };
		}

		// The actor a member row points at, or nullptr. FO stores the REFERENCE
		// id, so this is the same resolve nff_bridge does.
		RE::Actor* ResolveActor(RE::FormID id)
		{
			auto* form = id ? RE::TESForm::LookupByID(id) : nullptr;
			auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
			return refr ? refr->As<RE::Actor>() : nullptr;
		}

		// Does NG already hold a home marker for her? Read off the SAME keyword
		// table nff_bridge names places with, so the write side and the read
		// side can never disagree about who has a home.
		//
		// This mirrors `MMTYHNative.HasMarker(actor, 0)` — MHiYH keeps the two
		// in lockstep itself (SetMarkerLink writes both the database entry and
		// the linked ref; ClearMarkerLink clears both), and re-asking the DLL
		// would mean a second async Papyrus round trip just to decide which
		// synchronous message to show.
		bool HasMarker(RE::Actor* actor, int kind)
		{
			auto* kw = NffBridge::MhiyhMarkerKeyword(kind);
			return actor && kw && actor->GetLinkedRef(kw) != nullptr;
		}

		std::string NameOf(RE::Actor* actor, const std::string& fallback)
		{
			if (actor) {
				const auto* n = actor->GetDisplayFullName();
				if (n && n[0])
					return n;
			}
			return fallback.empty() ? std::string("She") : fallback;
		}

		// ------------------------------------------------------------ result --

		// The Bool a MHiYHController function returns, delivered on the VM's
		// own thread. Everything it hands on is hopped back to the main thread
		// first: `done` pushes into the PrismaUI view and re-reads live game
		// state, and neither is safe from a script thread.
		class BoolResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit BoolResult(std::function<void(bool)> then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				// IsBool() first: Variable::Get*() reinterprets a union, and a
				// function that errored out returns None, not False.
				const bool ok = a_result.IsBool() && a_result.GetBool();
				auto       then = _then;
				if (!then)
					return;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([then, ok]() { then(ok); });
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(bool)> _then;
		};

		// One static call into MHiYHController. `kind < 0` means "no Int arg".
		bool Dispatch(const char* fn, RE::Actor* actor, int kind, std::function<void(bool)> then)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !actor || !fn)
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new BoolResult(std::move(then)));
			if (kind >= 0) {
				auto arg = static_cast<std::int32_t>(kind);
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)), std::move(arg));
				return vm->DispatchStaticCall(kScript, fn, args, cb);
			}
			auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(actor)));
			return vm->DispatchStaticCall(kScript, fn, args, cb);
		}
	}

	namespace
	{
		/* ---- MarkHome's follower gate, handled instead of reported ---------
		 *
		 *  MHiYH will only take a home from someone CURRENTLY following you —
		 *  its rule, not ours. The deck used to state that and stop, which
		 *  meant a three-step dance for every settled NPC: recruit her, set
		 *  the home, dismiss her again. Rober asked for it to just happen.
		 *
		 *  So we BORROW her: recruit through NFF's own controller, mark the
		 *  home, then put her back exactly as she was. The restore is the part
		 *  that makes this honest — silently leaving someone in your party
		 *  (and eating one of NFF's follower slots) because you set her home
		 *  would be a worse surprise than the refusal ever was.
		 *
		 *  Every step is asynchronous and none of them can be assumed:
		 *    - NFF's RecruitFollower only sets doAction=2 and schedules its own
		 *      update, so "recruited" is not true when Apply() returns. We wait
		 *      and then CHECK IsPlayerTeammate rather than trusting a timer.
		 *    - If the recruit did not take (follower cap, her own mod owns her,
		 *      she is a guarded NPC), we say so and change nothing — we must
		 *      not leave a half-done borrow behind.
		 *    - The dismiss is only sent if WE did the recruiting. Someone who
		 *      was already following stays following.
		 */
		constexpr int kRecruitSettleMs = 900;   // NFF's own update is 0.2s; leave room
		constexpr int kRecruitRetryMs  = 1000;  // between the extra looks below
		constexpr int kRecruitChecks   = 4;     // total looks (~0.9s, 1.9s, 2.9s, 3.9s)
		constexpr int kDismissDelayMs  = 700;   // let MHiYH finish registering her first

		// One borrow at a time. Five Home-button presses on 2026-08-10 sent
		// five recruits at the same NPC before the first settle check ever ran;
		// the guard makes the extra presses a message instead of a pile-up.
		std::atomic<bool> g_borrowPending{ false };

		// Run `fn` on the main thread after `ms`. A detached thread is the same
		// shape RoomGuardTickLoop uses; the task hop is mandatory because
		// everything it touches is main-thread-only game state.
		void MainThreadAfter(int ms, std::function<void()> fn)
		{
			std::thread([ms, fn = std::move(fn)]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(ms));
				SKSE::GetTaskInterface()->AddTask([fn]() { fn(); });
			}).detach();
		}

		std::string NffCmd(const char* op, const std::string& idStr)
		{
			return json{ { "op", op }, { "formId", idStr } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	std::string Apply(const std::string& cmdJson, Done done)
	{
		const auto j = json::parse(cmdJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad MHiYH payload"));

		const auto op = j.value("op", std::string(""));
		const auto idStr = j.value("formId", std::string(""));
		const auto given = j.value("name", std::string(""));
		const int  kind = j.value("kind", -1);

		// ---- the mod itself ----
		if (!NffBridge::MhiyhMarkerKeyword(kHome))
			return Dump(Refuse("My Home is Your Home NG isn't in this load order."));

		// ---- the actor ----
		auto* actor = ResolveActor(ParseFormId(idStr));
		if (!actor)
			return Dump(Refuse(
				(given.empty() ? std::string("She") : given) +
				" isn't loaded right now — MHiYH can only be told about someone the game has in memory."));
		const auto who = NameOf(actor, given);

		// ---- the player, whose feet ARE the marker ----
		// Every one of these ops that creates a spot creates it with
		// PlaceAtMe at the player. No loaded cell, no marker.
		auto* player = RE::PlayerCharacter::GetSingleton();
		const bool needsSpot = (op == "setHome" || op == "setSpot");
		if (needsSpot && (!player || !player->GetParentCell()))
			return Dump(Refuse("You aren't standing anywhere the game can mark yet."));

		// ---- pick the call ----
		const char* fn = nullptr;
		int         arg = -1;          // Int argument, or -1 for none
		std::string sent;              // what to say the moment it is queued
		std::string ok;                // what to say when it comes back True
		std::string bad;               // …and False

		const bool hasHome = HasMarker(actor, kHome);

		if (op == "setHome") {
			if (hasHome) {
				// MoveHome, not MarkHome: MHiYH's own comment is explicit that
				// re-forcing the home alias while Sleep/Work/a meal has
				// priority would create a second active package behind the
				// scheduler's back. Moving the marker is enough — the linked
				// ref the running package points at is what changes.
				fn = "MoveHome";
				sent = "Moving " + who + "'s home here…";
				ok = "⌂ " + who + " lives here now";
				bad = "MHiYH would not move " + who + "'s home — see HotkeyDeck.log";
			} else {
				// MarkHome's own first gate. We no longer refuse it — we
				// satisfy it and put her back afterwards (see the borrow note
				// above). The whole sequence lives here rather than in the
				// generic dispatch below because only this branch has a gate
				// worth opening.
				if (!actor->IsPlayerTeammate()) {
					const std::string idCopy = idStr;
					const std::string whoCopy = who;

					// A companion who SHIPS with her own follower mod (Amaniri,
					// Vayne) is never borrowed: recruiting her into NFF gives
					// her a second, competing controller — on 2026-08-10 that
					// collision wedged NFF's import mid-flight and left Amaniri
					// dialogue-blocked in "Disallow Player Interaction". Try
					// MHiYH directly instead (her own framework may already
					// satisfy the gate), and let a False be an honest answer.
					const int ownSpec = FollowerFrameworks::OwningCompanionSpec(actor);
					if (ownSpec >= 0) {
						const std::string owner = FollowerFrameworks::Label(ownSpec);
						logger::info("mhiyh: {} is framework-owned ({}) - trying MarkHome directly, no borrow",
							whoCopy, owner);
						if (!Dispatch("MarkHome", actor, -1, [done, idCopy, whoCopy, owner](bool result) {
								logger::info("mhiyh: MarkHome({}) -> {} (framework-owned, direct)",
									whoCopy, result ? "true" : "false");
								if (done)
									done(Dump(json{
										{ "ok", result }, { "phase", "done" }, { "op", "setHome" },
										{ "kind", -1 }, { "formId", idCopy },
										{ "msg", result
											? ("⌂ " + whoCopy + " now lives here")
											: (whoCopy + " is run by " + owner + " and MHiYH does not see "
											   "her as a follower — have her follow you through her OWN "
											   "dialogue, then set the home again") },
									}));
							}))
							return Dump(Refuse("The Papyrus VM would not take MarkHome — see HotkeyDeck.log"));
						return Dump(json{
							{ "ok", true }, { "phase", "sent" }, { "op", "setHome" },
							{ "kind", -1 }, { "formId", idStr },
							{ "msg", "Giving " + who + " a home here…" },
						});
					}

					if (!NffControl::Available())
						return Dump(Refuse(
							whoCopy + " has to be following you, and Nether's Follower Framework "
							"isn't here to ask her for us."));

					if (g_borrowPending.exchange(true))
						return Dump(Refuse("Still asking " + who + " to follow — give it a moment."));

					// The recruit can be REFUSED synchronously (dead, guarded,
					// already following per NFF's own gates). The old code
					// ignored the reply and logged "recruit sent" regardless —
					// pass the refusal through instead of narrating a lie.
					const auto sentReply = json::parse(
						NffControl::Apply(NffCmd("recruit", idCopy), nullptr), nullptr, false);
					if (sentReply.is_discarded() || !sentReply.value("ok", false)) {
						g_borrowPending = false;
						return Dump(Refuse(sentReply.is_object()
							? sentReply.value("msg", std::string("NFF would not recruit ") + whoCopy)
							: std::string("NFF would not recruit ") + whoCopy));
					}
					logger::info("mhiyh: borrowing {} - recruit sent so MarkHome gate opens", whoCopy);

					// NFF's RecruitFollower only queues its own deferred action,
					// so "not a teammate yet" is ambiguous between REFUSED and
					// STILL PROCESSING. Look a few times before concluding — and
					// when the conclusion is "no", send a dismiss anyway: a
					// recruit that latches after our last look would otherwise
					// leave her silently conscripted (exactly what stranded
					// Amaniri in NFF on 2026-08-10).
					auto step = std::make_shared<std::function<void(int)>>();
					std::weak_ptr<std::function<void(int)>> wk = step;
					*step = [done, idCopy, whoCopy, wk](int attempt) {
						auto* a = ResolveActor(ParseFormId(idCopy));
						if (!a) {
							g_borrowPending = false;
							if (done)
								done(Dump(Refuse(whoCopy + " left before we could give her a home.")));
							return;
						}
						if (!a->IsPlayerTeammate()) {
							if (attempt < kRecruitChecks) {
								if (auto s = wk.lock())
									MainThreadAfter(kRecruitRetryMs,
										[s, attempt]() { (*s)(attempt + 1); });
								return;
							}
							g_borrowPending = false;
							NffControl::Apply(NffCmd("dismiss", idCopy), nullptr);
							logger::info("mhiyh: borrow of {} did not take after {} looks - "
										 "cancel dismiss sent", whoCopy, kRecruitChecks);
							if (done)
								done(Dump(Refuse(
									"Could not get " + whoCopy + " to follow you, so MHiYH will not take "
									"a home for her — recruit her yourself and try again.")));
							return;
						}

						g_borrowPending = false;
						const bool borrowed = true;   // she was not following when we started
						if (!Dispatch("MarkHome", a, -1, [done, idCopy, whoCopy, borrowed](bool result) {
								logger::info("mhiyh: MarkHome({}) -> {} (borrowed)", whoCopy,
									result ? "true" : "false");
								if (done)
									done(Dump(json{
										{ "ok", result }, { "phase", "done" }, { "op", "setHome" },
										{ "kind", -1 }, { "formId", idCopy },
										{ "msg", result
											? ("⌂ " + whoCopy + " now lives here — she followed you just "
											   "long enough for MHiYH to take it")
											: (whoCopy + " could not be given a home — see HotkeyDeck.log") },
									}));
								// Put her back either way. A failed MarkHome is no
								// reason to leave someone conscripted.
								if (borrowed) {
									MainThreadAfter(kDismissDelayMs, [idCopy, whoCopy]() {
										NffControl::Apply(NffCmd("dismiss", idCopy), nullptr);
										logger::info("mhiyh: returning {} - borrow complete", whoCopy);
									});
								}
							})) {
							if (done)
								done(Dump(Refuse("The Papyrus VM would not take MarkHome — see HotkeyDeck.log")));
							MainThreadAfter(kDismissDelayMs, [idCopy]() {
								NffControl::Apply(NffCmd("dismiss", idCopy), nullptr);
							});
						}
					};
					MainThreadAfter(kRecruitSettleMs, [step]() { (*step)(1); });

					return Dump(json{
						{ "ok", true }, { "phase", "sent" }, { "op", "setHome" },
						{ "kind", -1 }, { "formId", idStr },
						{ "msg", "Asking " + who + " to follow you for a moment…" },
					});
				}
				fn = "MarkHome";
				sent = "Giving " + who + " a home here…";
				ok = "⌂ " + who + " now lives here";
				bad = who + " could not be given a home — see HotkeyDeck.log";
			}
		} else if (op == "forgetHome") {
			if (!hasHome)
				return Dump(Refuse(who + " has no home to forget."));
			fn = "ForgetHome";
			sent = "Forgetting " + who + "'s home…";
			ok = who + " has no home any more";
			bad = "MHiYH would not forget " + who + "'s home — see HotkeyDeck.log";
		} else if (op == "repair") {
			fn = "RepairActor";
			sent = "Re-linking " + who + "'s day…";
			ok = who + "'s day was re-linked";
			bad = "Nothing to repair for " + who + " (MHiYH holds no home for her)";
		} else if (op == "setSpot" || op == "clearSpot") {
			if (kind == kHome)
				return Dump(Refuse("The home is set with its own action, not as a stop."));
			if (kind == kGuardPassive)
				return Dump(Refuse(
					"Watch has no place of its own — it shares the guard post. Set Guard instead."));
			if (kind < 1 || kind > 6 || kind >= kKindCount)
				return Dump(Refuse("That isn't a stop MHiYH can be told about."));
			// SetAreaMarker's own gate, and the one that matters most: every
			// other stop hangs off the home, because the home is what puts her
			// in the mod's database at all.
			if (!hasHome)
				return Dump(Refuse(
					"Give " + who + " a home first — every other stop in her day hangs off it."));

			arg = kind;
			const std::string label = KindLabel(kind);
			if (op == "setSpot") {
				fn = "SetAreaMarker";
				sent = "Marking " + who + "'s " + label + " here…";
				ok = "⌖ " + who + "'s " + label + " is here now";
				bad = "MHiYH would not take that " + label + " — see HotkeyDeck.log";
			} else {
				fn = "DisableArea";
				sent = "Clearing " + who + "'s " + label + "…";
				ok = who + "'s " + label + " is gone";
				bad = "MHiYH would not clear that " + label + " — see HotkeyDeck.log";
			}
		} else {
			return Dump(Refuse("Unknown MHiYH action '" + op + "'"));
		}

		// ---- fire ----
		const std::string opName = op;
		const int         replyKind = arg;
		const std::string replyId = idStr;

		auto then = [done, opName, replyKind, replyId, ok, bad, who, fn](bool result) {
			logger::info("mhiyh: {}({}{}) on {} -> {}", fn, who,
				replyKind >= 0 ? (", " + std::to_string(replyKind)) : "", replyId,
				result ? "true" : "false");
			if (!done)
				return;
			done(Dump(json{
				{ "ok", result },
				{ "phase", "done" },
				{ "op", opName },
				{ "kind", replyKind },
				{ "formId", replyId },
				{ "msg", result ? ok : bad },
			}));
		};

		if (!Dispatch(fn, actor, arg, then)) {
			logger::warn("mhiyh: DispatchStaticCall {}.{} refused (no VM, or {} not loaded)",
				kScript, fn, kScript);
			return Dump(Refuse("The Papyrus VM would not take that call — see HotkeyDeck.log"));
		}

		logger::info("mhiyh: dispatched {}.{}({}{}) for {}", kScript, fn, who,
			arg >= 0 ? (", " + std::to_string(arg)) : "", idStr);

		return Dump(json{
			{ "ok", true },
			{ "phase", "sent" },
			{ "op", opName },
			{ "kind", replyKind },
			{ "formId", replyId },
			{ "msg", sent },
		});
	}

	// ===================================================== the Deck Portal ===
	// See the header for the contract; the two functions below are the read and
	// the write half of it. Everything they need is already computed by the
	// Followers tab, so neither builds any state of its own.

	namespace
	{
		// The roster, flattened. FO files the same person under several
		// categories; the phone wants one row per person, so the FIRST entry
		// wins and later duplicates only fill in blanks.
		struct RosterRow
		{
			std::string original;   // FO's OriginalName — the portal's join key
			std::string name;       // display name (override applied)
			std::string formId;     // "0x0001A6A1", the runtime ref id
			bool        following = false;
			bool        inWorld = false;
			bool        dead = false;
		};

		std::string LowerOf(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		// FollowerDeck::StateJson() is either the envelope { ok, state:{…} } or
		// the state itself, depending on which entry point built it — the same
		// tolerance nff_bridge.cpp's MemberIds() applies, for the same reason.
		std::vector<RosterRow> RosterOf(const std::string& foStateJson)
		{
			std::vector<RosterRow> rows;
			const auto             env = json::parse(foStateJson, nullptr, false);
			if (env.is_discarded() || !env.is_object())
				return rows;
			const json& state = env.contains("state") && env["state"].is_object() ? env["state"] : env;
			if (!state.contains("categories") || !state["categories"].is_array())
				return rows;

			std::unordered_map<std::string, std::size_t> at;  // lowercased original -> index
			for (const auto& cat : state["categories"]) {
				if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
					continue;
				for (const auto& m : cat["members"]) {
					if (!m.is_object())
						continue;
					RosterRow r;
					r.original = m.value("original", std::string(""));
					r.name = m.value("name", std::string(""));
					if (r.original.empty())
						r.original = r.name;
					if (r.original.empty())
						continue;  // nothing the phone could ever address her by
					r.formId = m.value("formId", std::string(""));
					r.following = m.value("following", false);
					r.inWorld = m.value("inWorld", false);
					r.dead = m.value("dead", false);

					const auto key = LowerOf(r.original);
					const auto it = at.find(key);
					if (it == at.end()) {
						at[key] = rows.size();
						rows.push_back(std::move(r));
						continue;
					}
					// Same person, second filing. Only fill in what the first
					// copy lacked — an unresolved duplicate must never erase a
					// resolved one.
					auto& have = rows[it->second];
					if (have.formId.empty())
						have.formId = r.formId;
					if (have.name.empty())
						have.name = r.name;
					have.following = have.following || r.following;
					have.inWorld = have.inWorld || r.inWorld;
				}
			}
			return rows;
		}

		long long NowMs()
		{
			return std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::system_clock::now().time_since_epoch())
				.count();
		}

		// Write via temp + rename, so a reader can never see half a file —
		// the same idiom every other export in this plugin uses.
		bool WriteAtomic(const std::filesystem::path& file, const std::string& body)
		{
			std::error_code ec;
			std::filesystem::create_directories(file.parent_path(), ec);
			auto tmp = file;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc);
				if (!out.is_open())
					return false;
				out << body;
			}
			std::filesystem::rename(tmp, file, ec);
			return !ec;
		}
	}

	void WriteStatusJson(const std::filesystem::path& deckViewDir,
		const std::string& foStateJson, const std::string& nffStateJson)
	{
		try {
			const auto nff = json::parse(nffStateJson, nullptr, false);
			const bool installed = !nff.is_discarded() && nff.is_object() && nff.value("mhiyh", false);

			// The MHiYH slice, keyed by the runtime formId C++ speaks in. We
			// lowercase the key the same way followers-pane.js does, so a
			// casing change on either side cannot quietly empty the payload.
			std::unordered_map<std::string, const json*> byId;
			if (!nff.is_discarded() && nff.is_object() && nff.contains("members") && nff["members"].is_object()) {
				for (const auto& [k, v] : nff["members"].items()) {
					if (v.is_object() && v.contains("mhiyh") && v["mhiyh"].is_object())
						byId[LowerOf(k)] = &v["mhiyh"];
				}
			}

			json npcs = json::array();
			std::size_t withHome = 0;
			for (const auto& r : RosterOf(foStateJson)) {
				json row{
					{ "original", r.original },
					{ "name", r.name.empty() ? r.original : r.name },
					{ "formId", r.formId },
					{ "following", r.following },
					{ "inWorld", r.inWorld },
					{ "dead", r.dead },
					{ "home", "" },
					{ "flagged", false },
					{ "acts", json::array() },
				};
				const auto it = r.formId.empty() ? byId.end() : byId.find(LowerOf(r.formId));
				if (it != byId.end()) {
					const json& mh = *it->second;
					if (mh.contains("home") && mh["home"].is_object()) {
						row["home"] = mh["home"].value("name", std::string(""));
						++withHome;
					}
					row["flagged"] = mh.value("flagged", false);
					if (mh.contains("acts") && mh["acts"].is_array()) {
						json acts = json::array();
						for (const auto& a : mh["acts"]) {
							if (!a.is_object())
								continue;
							acts.push_back(json{
								{ "k", a.value("k", -1) },
								{ "place", a.value("place", std::string("")) },
								{ "now", a.value("now", false) },
							});
						}
						row["acts"] = std::move(acts);
					}
				}
				npcs.push_back(std::move(row));
			}

			const json out{
				{ "version", 1 },
				{ "mhiyh", installed },
				{ "at", NowMs() },
				{ "ttlMs", static_cast<long long>(kPositionalTtlMs) },
				{ "npcs", std::move(npcs) },
			};

			if (WriteAtomic(deckViewDir / "mhiyh-status.json", Dump(out))) {
				// Once at INFO so the line is there to grep for in a fresh log
				// (and so hd-markers.json's fingerprint is a string this build
				// demonstrably reaches), then DEBUG — this runs on every
				// Followers refresh and would otherwise be the noisiest line in
				// the file.
				static bool said = false;
				if (!said) {
					said = true;
					logger::info("mhiyh: day exported for the portal ({} rows, {} homes)",
						out["npcs"].size(), withHome);
				} else {
					logger::debug("mhiyh: day exported for the portal ({} homes)", withHome);
				}
			}
		} catch (...) {
			// Best-effort, exactly like the NFF export: the tab push that runs
			// alongside this has already given the in-game view its data.
		}
	}

	bool ApplyPortal(const std::filesystem::path& deckViewDir, const std::string& foStateJson, Done done)
	{
		const auto      file = deckViewDir / "portal-mhiyh.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, next tick gets it.
				logger::warn("portal mhiyh ops present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		std::size_t sent = 0;
		const auto  j = json::parse(text, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("ops") || !j["ops"].is_array()) {
			logger::error("portal mhiyh ops file is malformed — discarding it");
		} else {
			// The roster is what turns the portal's durable handle (the ORIGINAL
			// name) into the runtime formId Apply() needs. The formId the portal
			// stored alongside it is only a fallback: it was read off an export
			// that may predate a reload, and a stale ref id resolves to nothing
			// (or, worse, to somebody else).
			std::unordered_map<std::string, std::string> idByName;
			for (const auto& r : RosterOf(foStateJson)) {
				if (!r.formId.empty())
					idByName[LowerOf(r.original)] = r.formId;
			}

			const long long now = NowMs();
			std::size_t     skipped = 0, expired = 0;
			for (const auto& e : j["ops"]) {
				if (!e.is_object())
					continue;
				const auto op = e.value("op", std::string(""));
				const auto original = e.value("original", std::string(""));
				if (op.empty() || original.empty())
					continue;

				// ⚠ The positional guard. See the header: these two mark the
				// PLAYER'S FEET at apply time, so a stale one is a wrong answer,
				// not a late one. Dropped, loudly, rather than acted on.
				const bool positional = (op == "setHome" || op == "setSpot");
				if (positional) {
					const long long at = e.value("at", 0LL);
					const long long age = at > 0 ? (now - at) : kPositionalTtlMs + 1;
					if (age > kPositionalTtlMs || age < -kPositionalTtlMs) {
						++expired;
						logger::warn("portal mhiyh: dropped a stale {} for '{}' ({} s old) — it would have "
									 "marked wherever you are standing NOW",
							op, original, age / 1000);
						continue;
					}
				}

				auto       formId = e.value("formId", std::string(""));
				const auto known = idByName.find(LowerOf(original));
				if (known != idByName.end())
					formId = known->second;
				if (formId.empty()) {
					++skipped;
					logger::info("portal mhiyh: '{}' is not in the roster any more — skipped", original);
					continue;
				}

				json cmd{
					{ "op", op },
					{ "formId", formId },
					{ "name", e.value("name", original) },
				};
				if (e.contains("kind") && e["kind"].is_number_integer())
					cmd["kind"] = e["kind"].get<int>();

				const auto pre = json::parse(Apply(cmd.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace), [original, op, done](const std::string& res) {
					const auto r = json::parse(res, nullptr, false);
					logger::info("portal mhiyh: {} for '{}' -> {}", op, original,
						r.is_discarded() ? std::string("?") : r.value("msg", std::string("?")));
					if (done)
						done(res);
				}),
					nullptr, false);

				if (!pre.is_discarded() && pre.value("ok", false)) {
					++sent;
				} else {
					++skipped;
					logger::info("portal mhiyh: {} for '{}' refused: {}", op, original,
						pre.is_discarded() ? std::string("bad reply") : pre.value("msg", std::string("?")));
				}
			}
			if (sent || skipped || expired)
				logger::info("portal mhiyh ops: {} sent, {} refused, {} expired", sent, skipped, expired);
		}

		// Consume it either way — a file we could not apply must not be retried
		// forever. Blank it if the delete is refused, so the phone stops showing
		// the change as still pending.
		std::filesystem::remove(file, ec);
		if (ec) {
			logger::warn("could not delete portal mhiyh ops ({}) — blanking instead", ec.message());
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"ops":[]})";
		}
		return sent > 0;
	}
}
