#include "fix_actions.h"

#include "follower_frameworks.h"
#include "nff_bridge.h"
#include "npc_actions.h"

#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.
// It does NOT provide `json` — every module that speaks JSON to the view
// declares this alias itself (npc_actions.cpp, nff_control.cpp, …). Leaving it
// out compiles nowhere and fails loudly at the first `json{`, which is how it
// was found here.
using json = nlohmann::json;

namespace FixActions
{
	// This TU builds its replies with nlohmann::json but never named the type,
	// so every use below was "json: is not a class or namespace name" and the
	// whole branch stopped compiling. Same one-line alias nff_control.cpp and
	// faith.cpp carry; the pch supplies the library, not the shorthand.
	using json = nlohmann::json;

	// Run a console command, optionally targeting a reference. CompileAndRun's
	// target makes a ref-scoped command ("recycleactor", "resetai", …) act ON
	// that ref with no `prid` dance; a null target runs it globally ("tcl").
	static void RunConsole(const char* cmd, RE::TESObjectREFR* target)
	{
		auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
		auto* script  = factory ? factory->Create() : nullptr;
		if (!script)
			return;
		script->SetCommand(cmd);
		script->CompileAndRun(target);
		delete script;
	}

	static void Notify(const std::string& msg) { RE::DebugNotification(msg.c_str()); }

	// The crosshair NPC snapshotted at palette-open (or re-snapshotted for a
	// trigger) — the same target the NPC actions act on.
	static RE::Actor* Target()
	{
		return RE::TESForm::LookupByID<RE::Actor>(NpcActions::TargetFormID());
	}

	// Skyrim.esm's follower factions. Named exactly as nff_control.cpp names
	// them, because they are the same two records and a second spelling is how
	// two modules end up disagreeing about which is which.
	//   CurrentFollowerFaction  — "is following the player RIGHT NOW"
	//   PlayerFollowerFaction   — the wider "is one of the player's people"
	// Every follower dialogue condition in the game tests one of them, which is
	// why an actor left in either keeps behaving like a follower long after
	// whatever recruited her is gone.
	static constexpr RE::FormID kCurrentFollowerFac = 0x0005C84E;
	static constexpr RE::FormID kPlayerFollowerFac  = 0x00084D1B;

	static RE::TESFaction* FactionById(RE::FormID id)
	{
		auto* f = RE::TESForm::LookupByID(id);
		return f ? f->As<RE::TESFaction>() : nullptr;
	}
	static bool InFaction(RE::Actor* a, RE::FormID id)
	{
		auto* fac = a ? FactionById(id) : nullptr;
		return fac && a->IsInFaction(fac);
	}

	static RE::Actor* ActorFromRequest(const json& j, std::uint32_t* idOut)
	{
		std::uint32_t id = 0;
		if (j.is_object()) {
			// The view sends the formId as HEX (the card's own `hex`), matching
			// fdDebug. A decimal number is accepted too so a caller that has the
			// raw id does not have to format it first.
			if (j.contains("formId") && j["formId"].is_string()) {
				const auto s = j.value("formId", std::string(""));
				if (!s.empty()) {
					try {
						id = static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
					} catch (...) {}
				}
			} else if (j.contains("formId") && j["formId"].is_number()) {
				id = j.value("formId", 0u);
			}
		}
		if (!id)
			id = NpcActions::TargetFormID();
		if (idOut)
			*idOut = id;
		return id ? RE::TESForm::LookupByID<RE::Actor>(static_cast<RE::FormID>(id)) : nullptr;
	}

	static std::string Dump(const json& j)
	{
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// ------------------------------------------------------------ probe ----
	//
	// Read-only. Answers the four-way question the header describes, in the
	// order that decides what Apply is allowed to do.
	std::string Probe(const std::string& requestJson)
	{
		const auto j = json::parse(requestJson.empty() ? "{}" : requestJson, nullptr, false);
		std::uint32_t id = 0;
		auto*         a  = ActorFromRequest(j.is_discarded() ? json::object() : j, &id);
		if (!a)
			return Dump(json{ { "ok", false }, { "msg", "She isn't loaded right now — get closer and try again." } });

		const char* nm = a->GetDisplayFullName();
		json        out{ { "ok", true } };
		out["name"] = (nm && nm[0]) ? nm : "(unnamed)";
		out["dead"] = a->IsDead();

		const bool teammate = a->IsPlayerTeammate();
		const bool inCur    = InFaction(a, kCurrentFollowerFac);
		const bool inPlr    = InFaction(a, kPlayerFollowerFac);
		out["teammate"] = teammate;
		out["inCurrentFollowerFaction"] = inCur;
		out["inPlayerFollowerFaction"] = inPlr;

		// (c) owned by a framework we know, or driven by an alias we don't.
		const auto det = FollowerFrameworks::Probe(a);
		const int  own = FollowerFrameworks::OwningCompanionSpec(a);
		out["framework"] = json{
			{ "aliasDriven", det.aliasDriven },
			{ "followPackage", det.followPackage },
			{ "known", det.known },
			{ "label", det.label },
			{ "plugin", det.plugin },
			{ "ownedBy", (own >= 0) ? FollowerFrameworks::Label(own) : "" },
		};

		// (b) the quests holding her with a follow-ish package, by name. This
		// is the list that makes a refusal actionable instead of mysterious.
		// The framework module's test, not a local copy: the local one read
		// only the legacy package TYPE and missed every template-built follow
		// package (NFF's included) — half of why Ambrelie read as "nothing is
		// holding her" on 2026-09-23 while NFF walked her after the player.
		auto followish = [](const RE::TESPackage* pkg) { return FollowerFrameworks::IsFollowPackage(pkg); };
		auto fileOf = [](const RE::TESForm* f) -> std::string {
			const auto* file = f ? f->GetFile(0) : nullptr;
			return file ? std::string(file->GetFilename()) : std::string();
		};

		json holders = json::array();
		if (auto* arr = a->extraList.GetByType<RE::ExtraAliasInstanceArray>()) {
			RE::BSReadLockGuard locker(arr->lock);
			for (auto* inst : arr->aliases) {
				if (!inst || !inst->quest || !inst->instancedPackages)
					continue;
				bool fol = false;
				for (auto* pkg : *inst->instancedPackages)
					if (followish(pkg)) { fol = true; break; }
				if (!fol)
					continue;
				const char* qe = inst->quest->GetFormEditorID();
				const char* qn = inst->quest->GetFullName();
				holders.push_back(json{
					{ "quest", (qe && qe[0]) ? qe : "" },
					{ "questName", (qn && qn[0]) ? qn : "" },
					{ "plugin", fileOf(inst->quest) },
				});
			}
		}
		const bool aliasHolds = !holders.empty();
		out["holders"] = std::move(holders);

		// (d) the package actually in force.
		bool pkgFollows = false;
		if (auto* cur = a->GetCurrentPackage()) {
			pkgFollows = followish(cur);
			out["package"] = json{
				{ "follow", pkgFollows },
				{ "plugin", fileOf(cur) },
			};
		}

		// ---- the verdict -------------------------------------------------
		// `following` is what the player SEES: anything that would make her
		// walk after you. `why` is the evidence, in the words the card shows.
		json why = json::array();
		if (teammate)   why.push_back("She is flagged as your teammate.");
		if (inCur)      why.push_back("She is in CurrentFollowerFaction — the game treats her as following you right now.");
		if (inPlr)      why.push_back("She is in PlayerFollowerFaction — the game treats her as one of your people.");
		if (aliasHolds) why.push_back("A quest alias is running a follow package on her, which outranks anything set on the actor.");
		else if (pkgFollows) why.push_back("The package she is running right now is a follow/escort package.");

		// A framework we KNOW still holding her in its slot is the other half:
		// Probe() computed it above and the verdict used to ignore it, so the
		// card said "nothing is holding her" over an NFF follower whose
		// dismiss had been interrupted (2026-09-23, Ambrelie).
		const bool frameworkHolds = det.known && det.FrameworkDriven();
		const int  nffSlot = NffBridge::NffSlotOf(a);
		out["nffSlot"] = nffSlot;
		out["owner"] = frameworkHolds ? det.label : std::string();
		if (frameworkHolds) {
			if (nffSlot >= 0 && !NffBridge::IsNffFollower(a) && !inCur)
				why.push_back(det.label + " still has her in follower slot " + std::to_string(nffSlot) +
				              ", but she is marked dismissed — so its own dismiss skips her, and Teleport All "
				              "and its follow package still treat her as one of yours. Dismiss and repair "
				              "puts her back on its books for a moment so it can release her properly.");
			else
				why.push_back(det.label + " still counts her as one of your followers" +
				              (nffSlot >= 0 ? " (follower slot " + std::to_string(nffSlot) + ")." : "."));
		}

		const bool leaked = teammate || inCur || inPlr;
		out["following"] = leaked || aliasHolds || pkgFollows || frameworkHolds;
		out["why"] = std::move(why);

		// What Apply would do, decided HERE so the card and the write can
		// never disagree about it.
		std::string blocked;
		if (det.FrameworkDriven() && (det.known || own >= 0)) {
			const std::string who = det.label.empty()
				? ((own >= 0) ? std::string(FollowerFrameworks::Label(own)) : std::string("her own follower mod"))
				: det.label;
			blocked = who + " is driving her. Use Dismiss and repair — it goes through " + who +
			          ". Clearing the flags underneath it would leave it still holding her.";
		} else if (aliasHolds && !leaked) {
			blocked = "A quest alias is holding her, and there are no leftover flags to clear. "
			          "Clearing nothing would look like it worked. Try Reset AI first; if she still "
			          "follows, the quest named below is what has her.";
		}
		out["blocked"] = blocked;
		out["fixable"] = leaked && blocked.empty();
		// Nothing wrong at actor level and no alias: a stale package the engine
		// has not re-evaluated. Say the useful thing rather than "all clear".
		out["suggestResetAi"] = (!leaked && !aliasHolds && pkgFollows);
		return Dump(out);
	}

	// ------------------------------------------------------------ apply ----
	std::string Apply(const std::string& requestJson)
	{
		const auto j0 = json::parse(requestJson.empty() ? "{}" : requestJson, nullptr, false);
		const auto j  = j0.is_discarded() ? json::object() : j0;

		const std::string fix   = j.value("fix", std::string(""));
		const bool        force = j.value("force", false);

		// The player-only one needs no actor at all.
		if (fix == "noclip") {
			RunConsole("tcl", nullptr);
			return Dump(json{ { "ok", true }, { "msg", "Noclip toggled — run it again to put collision back." } });
		}

		std::uint32_t id = 0;
		auto*         a  = ActorFromRequest(j, &id);
		if (!a)
			return Dump(json{ { "ok", false }, { "msg", "She isn't loaded right now — get closer and try again." } });
		const char*       nm  = a->GetDisplayFullName();
		const std::string who = (nm && nm[0]) ? nm : "She";

		// The console-backed ones, now aimed at a NAMED actor instead of at
		// whatever the crosshair happened to be when the palette opened.
		if (fix == "recycle") {
			RunConsole("recycleactor", a);
			logger::info("fixes: recycle on {:08X}", a->GetFormID());   // marker: deck-fixes-card
			return Dump(json{ { "ok", true }, { "msg", who + "'s 3D and AI were rebuilt." } });
		}
		if (fix == "resetai") {
			RunConsole("resetai", a);
			a->EvaluatePackage();
			logger::info("fixes: resetai on {:08X}", a->GetFormID());
			return Dump(json{ { "ok", true }, { "msg", who + "'s AI was reset and her packages re-evaluated." } });
		}
		if (fix == "calm") {
			NpcActions::CancelOrder(a->GetFormID());  // a standing Sic 'em would re-issue the fight
			RunConsole("stopcombat", a);
			RunConsole("setav aggression 0", a);
			logger::info("fixes: calm on {:08X}", a->GetFormID());
			return Dump(json{ { "ok", true }, { "msg", who + " stopped fighting." } });
		}
		if (fix == "resurrect") {
			RunConsole("resurrect 1", a);
			logger::info("fixes: resurrect on {:08X}", a->GetFormID());
			return Dump(json{ { "ok", true }, { "msg", who + " is back on her feet, inventory intact." } });
		}

		if (fix != "unfollow")
			return Dump(json{ { "ok", false }, { "msg", "Unknown fix: " + fix } });

		// ---- unfollow: the one that has to refuse ------------------------
		// Re-probe rather than trusting what the card was shown: the flyout may
		// have been open for a minute and she may have been recruited since.
		const auto probe = json::parse(Probe(requestJson), nullptr, false);
		if (probe.is_discarded() || !probe.value("ok", false))
			return Dump(json{ { "ok", false }, { "msg", "Could not read her state." } });

		const std::string blocked = probe.value("blocked", std::string(""));
		const bool frameworkOwned = probe.contains("framework") &&
		                            probe["framework"].value("followPackage", false) &&
		                            (probe["framework"].value("known", false) ||
		                             !probe["framework"].value("ownedBy", std::string("")).empty());
		if (!blocked.empty() && !(force && frameworkOwned)) {
			// Refuse, with the reason. NOT a silent no-op and NOT a fake
			// success — the two failure modes this whole module exists to
			// avoid (see follower_frameworks.h).
			return Dump(json{ { "ok", false }, { "msg", blocked }, { "blocked", blocked } });
		}

		json changed = json::array();
		if (a->IsPlayerTeammate()) {
			// CommonLibSSE-NG exposes the READ (IsPlayerTeammate) on RE::Actor but
			// not the WRITE in this build — SetPlayerTeammate is a Papyrus native,
			// and a VM dispatch for one bool is more machinery than this deserves.
			// The console verb is ref-scoped by CompileAndRun's target and is what
			// the rest of this file already uses. (Found by the compiler, 2026-09-20:
			// `error C2039: 'SetPlayerTeammate': is not a member of 'RE::Actor'`.)
			RunConsole("setplayerteammate 0", a);
			changed.push_back("cleared the teammate flag");
		}
		if (auto* fac = FactionById(kCurrentFollowerFac)) {
			if (a->IsInFaction(fac)) {
				a->RemoveFromFaction(fac);
				changed.push_back("took her out of CurrentFollowerFaction");
			}
		}
		if (auto* fac = FactionById(kPlayerFollowerFac)) {
			if (a->IsInFaction(fac)) {
				a->RemoveFromFaction(fac);
				changed.push_back("took her out of PlayerFollowerFaction");
			}
		}
		// Always, even when nothing above moved: a stale package is (d), and
		// re-evaluating is the whole fix for it. resetai as well as
		// EvaluatePackage because the engine will otherwise keep running the
		// package it already picked until something else disturbs her.
		RunConsole("resetai", a);
		a->EvaluatePackage();
		changed.push_back("re-evaluated her AI packages");

		std::string msg;
		if (changed.size() == 1) {
			msg = "Nothing was flagged on " + who + " — her AI was re-evaluated. "
			      "If she still walks after you, a quest is holding her; the flyout names it.";
		} else {
			msg = who + " should stop following now.";
			if (force && frameworkOwned)
				msg += " Forced past her follower mod — if it recruits her again, dismiss her through it.";
		}
		logger::info("fixes: unfollow on {:08X} ({} change(s), force={})",
			a->GetFormID(), changed.size(), force);   // marker: deck-fix-unfollow
		return Dump(json{ { "ok", true }, { "msg", msg }, { "changed", std::move(changed) } });
	}

	// ------------------------------------------------------- palette door --
	bool IsAction(const std::string& a)
	{
		return a == "fix-recycle" || a == "fix-resetai" || a == "fix-resurrect" ||
		       a == "fix-calm" || a == "fix-noclip" || a == "fix-unfollow";
	}

	void Fire(const std::string& a)
	{
		logger::info("deck fixes-tab: fire {}", a);   // marker: deck-fixes-tab

		// Player-only: toggle collision so you can walk out of geometry, fire
		// again to turn it back on. No crosshair target needed.
		if (a == "fix-noclip") {
			RunConsole("tcl", nullptr);
			Notify("Fixes: noclip toggled (fire again to restore)");
			return;
		}

		auto* t = Target();
		if (!t) {
			Notify("Fixes: look at an NPC first, then fire this");
			return;
		}

		// The hotkey twin of the flyout's unstick. Same code, same refusals —
		// it just has a notification instead of a card to say them on.
		if (a == "fix-unfollow") {
			char buf[32];
			std::snprintf(buf, sizeof(buf), "%08X", t->GetFormID());
			const auto r = json::parse(
				Apply(json{ { "formId", std::string(buf) }, { "fix", "unfollow" } }.dump()),
				nullptr, false);
			const std::string msg = (!r.is_discarded() && r.contains("msg"))
				? r.value("msg", std::string("")) : std::string("");
			Notify(msg.empty() ? "Fixes: nothing to do" : ("Fixes: " + msg));
			return;
		}

		std::string done;
		if (a == "fix-recycle") {
			RunConsole("recycleactor", t);            // rebuild 3D + AI — T-pose/invisible/wedged
			done = "3D & AI refreshed";
		} else if (a == "fix-resetai") {
			RunConsole("resetai", t);                 // re-evaluate AI packages
			done = "AI reset";
		} else if (a == "fix-resurrect") {
			RunConsole("resurrect 1", t);             // 1 = keep inventory
			done = "resurrected";
		} else if (a == "fix-calm") {
			NpcActions::CancelOrder(t->GetFormID());
			RunConsole("stopcombat", t);
			RunConsole("setav aggression 0", t);
			done = "combat stopped";
		}
		Notify("Fixes: " + done);
		logger::info("fixes: {} on {:08X}", a, t->GetFormID());
	}
}
