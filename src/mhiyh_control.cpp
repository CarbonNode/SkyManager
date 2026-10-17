#include "mhiyh_control.h"

#include "nff_bridge.h"
#include "residents.h"   // HD_MhiyhRemote.SetHomeAt: a home for someone not following you

#include <memory>


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
				// MarkHome's own first gate: MHiYH's DIALOGUE only offers the
				// home topic to someone following you, and MHiYHController.MarkHome
				// checks IsPlayerTeammate() to match. Nothing in the native side
				// needs it, so someone who is not following goes through the
				// Residents door instead - HD_MhiyhRemote.SetHomeAt, the same
				// transaction minus that gate, with the marker placed at the
				// player's feet exactly as MarkHome would place it.
				//
				// This replaced a "borrow": recruit her through NFF, MarkHome,
				// dismiss her again. It could not work for anyone NFF already
				// holds in a slot without her following - an NFF IMPORT ("Add to
				// framework") is exactly that, and NFF's RecruitAction answers
				// "already in your group" and does nothing - and its cancel
				// dismiss then marked the imported NPC a current follower that
				// NFF's RemoveAction skips (Kella Vestia, 2026-10-15). Changing
				// someone's follower state to give her a home was the wrong shape
				// even when it worked.
				if (!actor->IsPlayerTeammate()) {
					logger::info("mhiyh: {} is not following - home via HD_MhiyhRemote.SetHomeAt, "
						"no recruit", who);   // marker: mhiyh-home-remote
					const std::string idCopy = idStr;
					const auto reply = json::parse(Residents::Apply(
						Dump(json{ { "op", "setAt" }, { "formId", idStr }, { "kind", kHome }, { "here", true } }),
						[done, idCopy](const std::string& result) {
							if (!done)
								return;
							// Residents answers as op "setAt"; every caller of
							// this verb (the Followers tab, the command ring, the
							// portal replay) waits for "setHome".
							auto r = json::parse(result, nullptr, false);
							if (!r.is_object()) {
								done(result);
								return;
							}
							r["op"] = "setHome";
							r["kind"] = -1;
							r["formId"] = idCopy;
							done(Dump(r));
						}),
						nullptr, false);
					if (!reply.is_object())
						return Dump(Refuse("The Residents door gave no answer for " + who + " - see HotkeyDeck.log"));
					auto out = reply;
					if (out.value("phase", std::string()) != "refused") {
						out["op"] = "setHome";
						out["kind"] = -1;
						out["formId"] = idStr;
						out["msg"] = "Giving " + who + " a home here…";
					}
					return Dump(out);
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
			std::string formId;     // "0x0001A6A1", the runtime ref id to ACT on
			// Non-empty when that id came from FO's `liveFormId` rather than the
			// form it stored — i.e. the row is a follower spawned at runtime,
			// whose stored form is her BASE record. Kept as a separate fact so
			// the duplicate merge below can prefer a row that has one.
			std::string liveId;
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
					/* `liveFormId` first. Apply() resolves formId -> REFR -> Actor,
					   and Follower Organizer stores a BASE record for a follower
					   spawned at runtime (it cannot name a 0xFF reference), which
					   resolves to a form but never an actor — so every phone-queued
					   home op for her was refused. The in-game deck already sends
					   the crosshair's reference; this is the portal's half of the
					   same fix (FO DeckAPI.cpp, LoadedActorForBase). */
					r.liveId = m.value("liveFormId", std::string(""));
					r.formId = r.liveId.empty() ? m.value("formId", std::string("")) : r.liveId;
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
					// A row that found a live reference outranks one that only has
					// the stored base: same person, and only one of the two spellings
					// can actually be handed to MHiYH.
					if (!r.liveId.empty() && have.liveId.empty()) {
						have.liveId = r.liveId;
						have.formId = r.formId;
					}
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
