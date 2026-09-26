#include "maras.h"

#include <string>

// pch (force-included) provides RE::/SKSE::, nlohmann/json and the logger.

using json = nlohmann::json;

namespace Maras
{
	namespace
	{
		constexpr const char* kPlugin = "TT_MARAS.esp";

		// Local FormIDs inside TT_MARAS.esp. The plugin is ESL-flagged, so these
		// are ONLY ever valid through TESDataHandler::LookupForm — see maras.h.
		// The tracking id is not a guess: MARAS.dll hardcodes exactly this pair
		// itself (`mov edx,7` + the "TT_MARAS.esp" literal at .rdata 0xF95C0)
		// on the path that mirrors a status change into the faction.
		constexpr RE::FormID kFacTracked   = 0x000007;  // TTM_TrackedNpcs   rank = status
		constexpr RE::FormID kFacHierarchy = 0x000111;  // TTM_SpouseHierarchy
		constexpr RE::FormID kFacAffection = 0x000119;  // TTM_SpouseAffection 0-100

		// Resolved once and cached — form pointers are stable for the session.
		// A FAILED resolve is deliberately NOT cached: this can be called before
		// data load (the roster builds early), and remembering "absent" then
		// would disable the whole feature for the rest of the session.
		struct Forms
		{
			RE::TESFaction* tracked = nullptr;
			RE::TESFaction* hierarchy = nullptr;
			RE::TESFaction* affection = nullptr;
			bool            checked = false;   // the identity assert has run
		};

		RE::TESFaction* LookupFaction(RE::TESDataHandler* dh, RE::FormID local)
		{
			auto* form = dh->LookupForm(local, kPlugin);
			return form ? form->As<RE::TESFaction>() : nullptr;
		}

		const Forms& Resolve()
		{
			static Forms f;
			if (f.tracked)
				return f;

			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return f;

			auto* tracked = LookupFaction(dh, kFacTracked);
			if (!tracked)
				return f;   // mod absent, or data not loaded yet — ask again later

			f.tracked = tracked;
			f.hierarchy = LookupFaction(dh, kFacHierarchy);
			f.affection = LookupFaction(dh, kFacAffection);

			// Belt and braces on the one assumption that could rot: that local
			// 0x7 is still TTM_TrackedNpcs after a MARAS update. po3's Tweaks is
			// installed on this rig, so GetFormEditorID() really answers at
			// runtime; where it does not it returns empty and we say nothing
			// rather than cry wolf. Getting this wrong would read some OTHER
			// faction's rank as a marriage, so it is worth one log line.
			if (!f.checked) {
				f.checked = true;
				const char* eid = tracked->GetFormEditorID();
				if (eid && *eid && std::string(eid) != "TTM_TrackedNpcs") {
					logger::error("maras: TT_MARAS.esp|0x7 is \"{}\", not TTM_TrackedNpcs — "
						"the marriage read is pointed at the wrong faction",
						eid);
				} else {
					logger::info("maras: tracking faction resolved (TT_MARAS.esp|0x7{})",
						(eid && *eid) ? ", editor id confirmed" : "");
				}
			}
			return f;
		}
	}

	bool Installed() { return Resolve().tracked != nullptr; }

	State Of(RE::Actor* actor)
	{
		State st;
		const auto& f = Resolve();
		if (!f.tracked)
			return st;
		st.installed = true;
		if (!actor)
			return st;

		// Membership is only the gate. The ANSWER is the rank — an ex-wife is
		// still a member, at rank 3. See the trap note in maras.h.
		if (!actor->IsInFaction(f.tracked))
			return st;

		st.status = actor->GetFactionRank(f.tracked, false);
		st.spouse = (st.status == kMarried);

		// Only meaningful for someone actually married; MARAS does not maintain
		// them for a candidate, and reporting a stale hierarchy on an ex would
		// be worse than reporting nothing.
		if (st.spouse) {
			if (f.hierarchy && actor->IsInFaction(f.hierarchy))
				st.hierarchy = actor->GetFactionRank(f.hierarchy, false);
			if (f.affection && actor->IsInFaction(f.affection))
				st.affection = actor->GetFactionRank(f.affection, false);
		}
		return st;
	}

	const char* AffectionWord(int affection)
	{
		if (affection < 0)
			return "";
		// MARAS's own thresholds, read out of its affection-level function.
		if (affection >= 75) return "happy";
		if (affection >= 50) return "content";
		if (affection >= 25) return "troubled";
		return "estranged";
	}

	std::string Json(const State& st)
	{
		if (!st.installed)
			return {};

		const char* text =
			st.status == kCandidate ? "Candidate" :
			st.status == kEngaged   ? "Engaged" :
			st.status == kMarried   ? "Married" :
			st.status == kDivorced  ? "Divorced" :
			st.status == kJilted    ? "Jilted" :
			st.status == kDeceased  ? "Deceased" : "";

		json j{
			{ "on", true },
			{ "spouse", st.spouse },
			{ "status", st.status },
			{ "statusText", text },
		};
		if (st.hierarchy >= 0)
			j["hierarchy"] = st.hierarchy;
		if (st.affection >= 0) {
			j["affection"] = st.affection;
			j["mood"] = AffectionWord(st.affection);
		}
		return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}

// Installed MARAS.psc / TTM_Debug_ToggleSpouseEffect.psc use this native
// for the same status transition. MARAS owns its co-save map and events.
namespace Maras {
namespace {
class MarriageReply final : public RE::BSScript::IStackCallbackFunctor {
    std::uint32_t id;
    std::function<void(bool,std::string)> reply;
public:
    MarriageReply(std::uint32_t actorId, std::function<void(bool,std::string)> cb):id(actorId),reply(std::move(cb)){}
    void operator()(RE::BSScript::Variable v) override {
        const bool accepted = v.IsBool() && v.GetBool();
        auto cb = reply; const auto fid = id;
        SKSE::GetTaskInterface()->AddTask([accepted,cb,fid]() {
            const auto st = Of(RE::TESForm::LookupByID<RE::Actor>(fid));
            cb(accepted && st.spouse, accepted && st.spouse ? "Married through M.A.R.A.S" : "M.A.R.A.S did not confirm the marriage");
        });
    }
    bool CanSave() const override { return false; }
    void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}
};
}
void Marry(std::uint32_t id, std::function<void(bool,std::string)> reply) {
    auto* actor = RE::TESForm::LookupByID<RE::Actor>(id);
    if (!Installed() || !GetModuleHandleW(L"MARAS.dll")) { reply(false,"M.A.R.A.S is not available"); return; }
    if (!actor || actor->IsPlayerRef() || actor->IsDead() || actor->IsDeleted() || actor->IsDisabled()) { reply(false,"That NPC is unavailable"); return; }
    if (Of(actor).spouse) { reply(false,"Already married through M.A.R.A.S"); return; }
    auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
    if (!vm) { reply(false,"The script engine is unavailable"); return; }
    RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new MarriageReply(id,reply));
    logger::info("dossier-maras: requesting native marriage for {:08X}",id);
    if (!vm->DispatchStaticCall("MARAS","PromoteNPCToStatusByEnum",
        RE::MakeFunctionArguments(std::move(actor),std::int32_t(2)),cb)) reply(false,"M.A.R.A.S marriage native is unavailable");
}
}
