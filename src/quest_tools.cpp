#include "quest_tools.h"

#include "npc_actions.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace QuestTools
{
	namespace
	{
		constexpr std::size_t kSearchLimit = 120;  // keep the view responsive at 4k plugins

		// NPC form (base or ref) -> quests naming it in static alias fill data.
		std::unordered_map<RE::FormID, std::vector<RE::FormID>> g_staticIndex;
		bool                                                    g_indexBuilt = false;

		// ------------------------------------------------------------- helpers

		std::string HexId(RE::FormID id)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%08X", static_cast<unsigned>(id));
			return buf;
		}

		std::string ToLower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// Originating plugin — GetFile(0) is the file that first defined the form,
		// which is what "whose quest is this" means. Handles ESL/ESM/ESP alike.
		std::string PluginOf(RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* file = form->GetFile(0)) {
				const auto name = file->GetFilename();
				return std::string(name);
			}
			return "";
		}

		std::string EditorIdOf(RE::TESQuest* q)
		{
			const auto* eid = q ? q->GetFormEditorID() : nullptr;
			return (eid && eid[0]) ? eid : "";
		}

		// Quests very often have no display name (system/handler quests). Fall back
		// so every row is still identifiable.
		std::string DisplayName(RE::TESQuest* q)
		{
			if (!q)
				return "";
			const auto* full = q->GetFullName();
			if (full && full[0])
				return full;
			const auto eid = EditorIdOf(q);
			if (!eid.empty())
				return eid;
			return "(unnamed " + HexId(q->GetFormID()) + ")";
		}

		const char* TypeName(RE::QUEST_DATA::Type t)
		{
			using T = RE::QUEST_DATA::Type;
			switch (t) {
			case T::kMainQuest:         return "Main";
			case T::kMagesGuild:        return "Mages Guild";
			case T::kThievesGuild:      return "Thieves Guild";
			case T::kDarkBrotherhood:   return "Dark Brotherhood";
			case T::kCompanionsQuest:   return "Companions";
			case T::kMiscellaneous:     return "Misc";
			case T::kDaedric:           return "Daedric";
			case T::kSideQuest:         return "Side";
			case T::kCivilWar:          return "Civil War";
			case T::kDLC01_Vampire:     return "Dawnguard";
			case T::kDLC02_Dragonborn:  return "Dragonborn";
			default:                    return "";
			}
		}

		const char* FillTypeName(RE::BGSBaseAlias::FILL_TYPE t)
		{
			using F = RE::BGSBaseAlias::FILL_TYPE;
			switch (t) {
			case F::kConditions:   return "conditions";
			case F::kForced:       return "forced ref";
			case F::kFromAlias:    return "from alias";
			case F::kFromEvent:    return "from event";
			case F::kCreated:      return "created";
			case F::kFromExternal: return "external quest";
			case F::kUniqueActor:  return "unique actor";
			case F::kNearAlias:    return "near alias";
			default:               return "?";
			}
		}

		const char* StatusOf(RE::TESQuest* q)
		{
			if (!q)
				return "";
			if (q->IsCompleted())
				return "completed";
			if (q->IsRunning())
				return "running";
			return "inactive";
		}

		// The quest's COMPLETE stage list. See the header for why this member.
		std::vector<std::uint16_t> StagesOf(RE::TESQuest* q)
		{
			std::vector<std::uint16_t> out;
			if (!q || !q->waitingStages)
				return out;
			for (auto* stage : *q->waitingStages) {
				if (!stage)
					continue;  // Bethesda lists can lead with an empty node
				out.push_back(stage->data.index);
			}
			std::sort(out.begin(), out.end());
			out.erase(std::unique(out.begin(), out.end()), out.end());
			return out;
		}

		// Count aliases that are supposed to hold something but currently do not.
		// An unfilled alias on a running quest is the single most common reason a
		// quest is "broken" — surfacing it is more diagnostic than the stage number.
		int UnfilledAliasCount(RE::TESQuest* q)
		{
			if (!q || !q->IsRunning())
				return 0;
			int n = 0;
			for (auto* base : q->aliases) {
				if (!base)
					continue;
				if (base->flags.any(RE::BGSBaseAlias::FLAGS::kOptional))
					continue;
				auto* refAlias = skyrim_cast<RE::BGSRefAlias*>(base);
				if (refAlias && !refAlias->GetReference())
					++n;
			}
			return n;
		}

		// ------------------------------------------------------- static index

		// Built once, lazily: walking every quest in a 4k-plugin load order is
		// cheap (~one pass over pointers) but has no business running at startup.
		void EnsureStaticIndex()
		{
			if (g_indexBuilt)
				return;
			g_indexBuilt = true;

			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh) {
				logger::error("quests: no TESDataHandler — static alias index unavailable");
				return;
			}

			const auto  t0 = std::chrono::steady_clock::now();
			std::size_t quests = 0, links = 0;

			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				++quests;
				for (auto* base : q->aliases) {
					auto* refAlias = skyrim_cast<RE::BGSRefAlias*>(base);
					if (!refAlias)
						continue;
					RE::FormID npcId = 0;
					switch (refAlias->fillType.get()) {
					case RE::BGSBaseAlias::FILL_TYPE::kUniqueActor:
						if (auto* npc = refAlias->fillData.uniqueActor.uniqueActor)
							npcId = npc->GetFormID();
						break;
					case RE::BGSBaseAlias::FILL_TYPE::kForced:
						if (auto ref = refAlias->fillData.forced.forcedRef.get())
							npcId = ref->GetFormID();
						break;
					default:
						break;
					}
					if (npcId) {
						g_staticIndex[npcId].push_back(q->GetFormID());
						++links;
					}
				}
			}

			for (auto& [id, list] : g_staticIndex) {
				std::sort(list.begin(), list.end());
				list.erase(std::unique(list.begin(), list.end()), list.end());
			}

			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			logger::info("quests: static alias index built — {} quests scanned, {} NPC links, {} NPCs, {} ms",
				quests, links, g_staticIndex.size(), ms);
		}

		// ------------------------------------------------------------ payloads

		// One row in the quest list.
		json QuestSummary(RE::TESQuest* q, const char* involvement, const std::string& aliasName)
		{
			const auto stages = StagesOf(q);
			return json{
				{ "formId", HexId(q->GetFormID()) },
				{ "name", DisplayName(q) },
				{ "editorId", EditorIdOf(q) },
				{ "plugin", PluginOf(q) },
				{ "type", TypeName(q->data.questType.get()) },
				{ "status", StatusOf(q) },
				{ "currentStage", q->currentStage },
				{ "stageCount", stages.size() },
				{ "unfilledAliases", UnfilledAliasCount(q) },
				{ "involvement", involvement },
				{ "aliasName", aliasName }
			};
		}

		RE::TESQuest* LookupQuest(std::uint32_t formID)
		{
			return RE::TESForm::LookupByID<RE::TESQuest>(static_cast<RE::FormID>(formID));
		}

		// Papyrus call on a quest — used for anything that must run the quest's own
		// script fragments (SetStage, CompleteQuest). Native writes would not.
		bool CallQuestPapyrus(RE::TESQuest* quest, const char* fn, const std::int32_t* intArg)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !quest)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			if (intArg) {
				std::int32_t v = *intArg;
				auto         args = RE::MakeFunctionArguments(std::move(v));
				vm->DispatchMethodCall(handle, "Quest", fn, args, cb);
			} else {
				auto args = RE::MakeFunctionArguments();
				vm->DispatchMethodCall(handle, "Quest", fn, args, cb);
			}
			return true;
		}
	}

	// ------------------------------------------------------------------- API

	void Init()
	{
		g_staticIndex.clear();
		g_indexBuilt = false;  // rebuilt lazily on first Quests-tab use
	}

	std::string QuestsForTarget()
	{
		// The crosshair snapshot is just one actor — the whole body lives in
		// QuestsForActor so the F7 card's 📜 Quests modal can name a DIFFERENT
		// one (its subject is a picked party member whenever you clicked a face
		// on the party strip, and asking about the crosshair there would answer
		// about the wrong person).
		return QuestsForActor(NpcActions::TargetFormID());
	}

	std::string QuestsForActor(std::uint32_t actorFormID)
	{
		json out;
		out["quests"] = json::array();

		const auto targetId = actorFormID;
		auto*      actor = targetId ? RE::TESForm::LookupByID<RE::Actor>(targetId) : nullptr;
		if (!actor) {
			out["hasTarget"] = false;
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		const auto* dispName = actor->GetDisplayFullName();
		RE::TESNPC* actorBase = actor->GetActorBase();
		out["hasTarget"] = true;
		out["npc"] = json{
			{ "name", (dispName && dispName[0]) ? dispName : "NPC" },
			{ "formId", HexId(actor->GetFormID()) },
			{ "baseId", actorBase ? HexId(actorBase->GetFormID()) : "" },
			{ "plugin", PluginOf(actorBase ? static_cast<RE::TESForm*>(actorBase) : actor) }
		};

		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		EnsureStaticIndex();

		std::unordered_set<RE::FormID> seen;

		// (a) live involvement — running quests whose alias resolves to this ref.
		//     No explicit alias lock: GetReference() does its own, and this runs on
		//     the main thread with the palette (and the game) paused.
		const auto refId = actor->GetFormID();
		for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
			if (!q || !q->IsRunning())
				continue;
			std::string aliasName;
			for (auto* base : q->aliases) {
				auto* refAlias = skyrim_cast<RE::BGSRefAlias*>(base);
				if (!refAlias)
					continue;
				auto* ref = refAlias->GetReference();
				if (ref && ref->GetFormID() == refId) {
					const auto* an = base->aliasName.c_str();
					aliasName = (an && an[0]) ? an : ("alias " + std::to_string(base->aliasID));
					break;
				}
			}
			if (!aliasName.empty() && seen.insert(q->GetFormID()).second)
				out["quests"].push_back(QuestSummary(q, "alias", aliasName));
		}

		// (b) static involvement — quests that NAME this NPC in alias fill data.
		//     Catches not-yet-started quests, and quests whose alias failed to fill.
		auto addStatic = [&](RE::FormID key) {
			const auto it = g_staticIndex.find(key);
			if (it == g_staticIndex.end())
				return;
			for (const auto qid : it->second) {
				if (!seen.insert(qid).second)
					continue;
				if (auto* q = LookupQuest(qid))
					out["quests"].push_back(QuestSummary(q, "static", ""));
			}
		};
		addStatic(refId);
		if (actorBase)
			addStatic(actorBase->GetFormID());

		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SearchQuests(const std::string& query)
	{
		json out;
		out["quests"] = json::array();
		out["truncated"] = false;

		const auto q = ToLower(query);
		if (q.size() < 2) {
			out["message"] = "Type at least 2 characters";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		std::vector<RE::TESQuest*> hits;
		for (auto* quest : dh->GetFormArray<RE::TESQuest>()) {
			if (!quest)
				continue;
			const auto name = ToLower(DisplayName(quest));
			const auto eid = ToLower(EditorIdOf(quest));
			const auto plugin = ToLower(PluginOf(quest));
			const auto fid = ToLower(HexId(quest->GetFormID()));
			if (name.find(q) != std::string::npos || eid.find(q) != std::string::npos ||
				plugin.find(q) != std::string::npos || fid.find(q) != std::string::npos)
				hits.push_back(quest);
			if (hits.size() >= kSearchLimit * 4)
				break;  // hard stop so a 1-char-ish query can't walk the whole load order
		}

		// running quests first (that's what you're repairing), then by name
		std::stable_sort(hits.begin(), hits.end(), [](RE::TESQuest* a, RE::TESQuest* b) {
			const int ra = a->IsRunning() ? 0 : 1;
			const int rb = b->IsRunning() ? 0 : 1;
			if (ra != rb)
				return ra < rb;
			return ToLower(DisplayName(a)) < ToLower(DisplayName(b));
		});

		if (hits.size() > kSearchLimit) {
			hits.resize(kSearchLimit);
			out["truncated"] = true;
		}
		for (auto* quest : hits)
			out["quests"].push_back(QuestSummary(quest, "search", ""));
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string QuestDetail(std::uint32_t formID)
	{
		json out;
		auto* q = LookupQuest(formID);
		if (!q) {
			out["ok"] = false;
			out["message"] = "Quest " + HexId(formID) + " not found";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		out["ok"] = true;
		out["formId"] = HexId(q->GetFormID());
		out["name"] = DisplayName(q);
		out["editorId"] = EditorIdOf(q);
		out["plugin"] = PluginOf(q);
		out["type"] = TypeName(q->data.questType.get());
		out["status"] = StatusOf(q);
		out["currentStage"] = q->currentStage;
		out["enabled"] = q->IsEnabled();
		out["active"] = q->IsActive();
		out["completed"] = q->IsCompleted();
		out["running"] = q->IsRunning();

		json stages = json::array();
		for (const auto s : StagesOf(q))
			stages.push_back(json{ { "index", s }, { "current", s == q->currentStage } });
		out["stages"] = stages;

		json objectives = json::array();
		for (auto* o : q->objectives) {
			if (!o)
				continue;
			const auto* text = o->displayText.c_str();
			objectives.push_back(json{
				{ "index", o->index },
				{ "text", (text && text[0]) ? text : "" },
				{ "state", static_cast<int>(o->state.get()) } });
		}
		out["objectives"] = objectives;

		json aliases = json::array();
		int  unfilled = 0;
		for (auto* base : q->aliases) {
			if (!base)
				continue;
			const auto* an = base->aliasName.c_str();
			json        a{
				{ "id", base->aliasID },
				{ "name", (an && an[0]) ? an : "" },
				{ "optional", base->flags.any(RE::BGSBaseAlias::FLAGS::kOptional) },
				{ "essential", base->IsEssential() },
				{ "questObject", base->IsQuestObject() },
				{ "kind", base->GetTypeString().c_str() ? base->GetTypeString().c_str() : "" }
			};
			auto* refAlias = skyrim_cast<RE::BGSRefAlias*>(base);
			if (refAlias) {
				a["fill"] = FillTypeName(refAlias->fillType.get());
				if (auto* ref = refAlias->GetReference()) {
					const auto* rn = ref->GetDisplayFullName();
					a["filled"] = true;
					a["refId"] = HexId(ref->GetFormID());
					a["refName"] = (rn && rn[0]) ? rn : "";
				} else {
					a["filled"] = false;
					if (!base->flags.any(RE::BGSBaseAlias::FLAGS::kOptional) && q->IsRunning())
						++unfilled;
					// what it WOULD point at, so an unfilled slot still names its NPC
					if (refAlias->fillType.get() == RE::BGSBaseAlias::FILL_TYPE::kUniqueActor) {
						if (auto* npc = refAlias->fillData.uniqueActor.uniqueActor) {
							const auto* nn = npc->GetFullName();
							a["wants"] = (nn && nn[0]) ? nn : HexId(npc->GetFormID());
						}
					}
				}
			} else {
				a["fill"] = "";
				a["filled"] = true;  // non-ref aliases (location etc.) aren't "unfilled"
			}
			aliases.push_back(a);
		}
		out["aliases"] = aliases;
		out["unfilledAliases"] = unfilled;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SetStage(std::uint32_t formID, std::uint32_t stage)
	{
		json  out;
		auto* q = LookupQuest(formID);
		if (!q) {
			out["ok"] = false;
			out["message"] = "Quest not found";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const std::int32_t s = static_cast<std::int32_t>(stage);
		if (!CallQuestPapyrus(q, "SetStage", &s)) {
			out["ok"] = false;
			out["message"] = "Papyrus VM unavailable";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		logger::info("quests: SetStage {} ({}) -> {}", DisplayName(q), HexId(q->GetFormID()), stage);
		out["ok"] = true;
		out["message"] = "Stage " + std::to_string(stage) + " fired";
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string RunAction(std::uint32_t formID, const std::string& verb)
	{
		json  out;
		auto* q = LookupQuest(formID);
		if (!q) {
			out["ok"] = false;
			out["message"] = "Quest not found";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		bool        ok = true;
		std::string msg;
		if (verb == "start") {
			ok = q->Start();
			msg = ok ? "Quest started" : "Start refused (conditions not met?)";
		} else if (verb == "stop") {
			q->Stop();
			msg = "Quest stopped";
		} else if (verb == "reset") {
			q->ResetAndUpdate();
			msg = "Quest reset";
		} else if (verb == "complete") {
			ok = CallQuestPapyrus(q, "CompleteQuest", nullptr);
			msg = ok ? "CompleteQuest fired" : "Papyrus VM unavailable";
		} else {
			ok = false;
			msg = "Unknown action '" + verb + "'";
		}

		logger::info("quests: action '{}' on {} ({}) -> {}", verb, DisplayName(q),
			HexId(q->GetFormID()), ok ? "ok" : "failed");
		out["ok"] = ok;
		out["message"] = msg;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string CheckQuestTarget(std::uint32_t formID)
	{
		json  out;
		out["ok"] = false;
		auto* q = LookupQuest(formID);
		if (!q) {
			out["message"] = "Quest " + HexId(formID) + " not found";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		if (!q->IsRunning()) {
			out["message"] = "Quest isn't running — nothing is targeted. Start it first.";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// movetoqt jumps to a DISPLAYED objective's target. Walk them the same way
		// the compass does: displayed objectives -> QSTA targets -> the alias each
		// target points at -> does that alias actually hold a reference right now?
		bool anyDisplayed = false, anyTarget = false, anyFilled = false;
		for (auto* o : q->objectives) {
			if (!o || o->state.get() != RE::QUEST_OBJECTIVE_STATE::kDisplayed)
				continue;
			anyDisplayed = true;
			if (!o->targets)
				continue;
			for (std::uint32_t i = 0; i < o->numTargets; ++i) {
				auto* t = o->targets[i];
				if (!t)
					continue;
				anyTarget = true;
				for (auto* base : q->aliases) {
					if (!base || base->aliasID != t->alias)
						continue;
					if (auto* ra = skyrim_cast<RE::BGSRefAlias*>(base); ra && ra->GetReference()) {
						anyFilled = true;
						break;
					}
				}
			}
		}

		if (!anyDisplayed) {
			out["message"] = "No active objective — the journal shows nothing to travel to";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		if (!anyTarget) {
			out["message"] = "The active objective has no map target";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		if (!anyFilled) {
			out["message"] = "Target alias is EMPTY — the marker points at nothing (that's the broken part)";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		out["ok"] = true;
		out["message"] = "Target is live";
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string MoveToQuestTarget(std::uint32_t formID)
	{
		json  out;
		out["ok"] = false;
		auto* q = LookupQuest(formID);
		if (!q) {
			out["message"] = "Quest not found";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const auto eid = EditorIdOf(q);
		if (eid.empty()) {
			// QUST is one of the form types that retains editor ids at runtime, so
			// this is a unicorn — but movetoqt has no formId spelling to fall back on.
			out["message"] = "Quest has no editor id — console movetoqt can't address it";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
		auto* script  = factory ? factory->Create() : nullptr;
		if (!script) {
			out["message"] = "Console script compiler unavailable";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const std::string cmd = "movetoqt " + eid;
		script->SetCommand(cmd);
		script->CompileAndRun(nullptr);
		delete script;
		logger::info("quests: {} ({} / {})", cmd, DisplayName(q), HexId(q->GetFormID()));
		RE::DebugNotification(("Traveling to target: " + DisplayName(q)).c_str());
		out["ok"] = true;
		out["message"] = cmd;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
