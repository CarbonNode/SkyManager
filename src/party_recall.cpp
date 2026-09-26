#include "party_recall.h"
#include "party_recall_policy.h"
#include "actor_identity.h"
#include "follower_deck.h"
#include "follower_frameworks.h"
#include "npc_actions.h"
#include "ostim_deck.h"

#include <atomic>
#include <cstring>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <unordered_set>
#include <vector>

#ifdef GetObject
#undef GetObject
#endif

using json = nlohmann::json;
namespace PartyRecall
{
	namespace
	{
		using Object = RE::BSTSmartPointer<RE::BSScript::Object>;
		constexpr const char* kController = "nwsFollowerControllerScript";
		constexpr const char* kVars = "nwsFollowerVariableScript";
		constexpr const char* kKey = "nwsKeyPort";
		std::map<std::string, RE::FormID> g_quests;
		json g_settings;
		bool g_loaded = false;
		bool g_warned = false;
		std::uint64_t g_epoch = 0;
		std::atomic<std::uint32_t> g_hotkey{0};
		std::chrono::steady_clock::time_point g_lastRecall{};

		Object Bind(RE::TESForm* form, const char* script)
		{
			Object obj;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!form || !policy) return obj;
			const auto h = policy->GetHandleForObject(form->GetFormType(), form);
			if (h == policy->EmptyHandle()) return obj;
			if (!vm->FindBoundObject(h, script, obj)) {
				std::string lower(script);
				for (auto& ch : lower) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
				vm->FindBoundObject(h, lower.c_str(), obj);
			}
			return obj;
		}

		Object Script(const char* name)
		{
			const auto it = g_quests.find(name);
			if (it != g_quests.end()) return Bind(RE::TESForm::LookupByID(it->second), name);
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh) return {};
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				const auto* file = q ? q->GetFile(0) : nullptr;
				if (!file || _stricmp(std::string(file->GetFilename()).c_str(), "nwsFollowerFramework.esp") != 0) continue;
				if (auto obj = Bind(q, name)) {
					g_quests[name] = q->GetFormID();
					return obj;
				}
			}
			return {};
		}

		const RE::BSScript::Variable* Prop(const Object& obj, const char* key)
		{
			if (!obj) return nullptr;
			if (auto* v = obj->GetProperty(key)) return v;
			return obj->GetVariable("::"s + key + "_var");
		}
		template<class T> T* FormProp(const Object& obj, const char* key)
		{
			const auto* v = Prop(obj, key);
			return v && v->IsObject() ? v->Unpack<T*>() : nullptr;
		}
		bool BoolProp(const Object& obj, const char* key)
		{
			const auto* v = Prop(obj, key);
			return v && v->IsBool() && v->GetBool();
		}
		int NffKey()
		{
			const auto obj = Script(kController);
			const auto* v = Prop(obj, kKey);
			return v && v->IsInt() ? v->GetSInt() : -2;
		}
		bool SetNffKey(int expected, int key)
		{
			auto obj = Script(kController);
			const auto* old = Prop(obj, kKey);
			if (!old || !old->IsInt() || old->GetSInt() != expected) return false;
			RE::BSScript::Variable value;
			value.SetSInt(key);
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			return vm && vm->SetPropertyValue(obj, kKey, value) && NffKey() == key;
		}

		std::filesystem::path SettingsPath()
		{
			return "Data/SKSE/Plugins/HotkeyDeck/party-recall.json";
		}
		void Load()
		{
			if (g_loaded) return;
			g_loaded = true;
			std::ifstream in(SettingsPath(), std::ios::binary);
			g_settings = in ? json::parse(in, nullptr, false) : json::object();
			if (!g_settings.is_object()) g_settings = json::object();
			if (!g_settings.contains("enabled") || !g_settings["enabled"].is_boolean()) g_settings["enabled"] = false;
			if (!g_settings.contains("key") || !g_settings["key"].is_number_integer()) g_settings["key"] = 0;
		}
		bool Save(const json& settings)
		{
			try {
				const auto path = SettingsPath();
				std::filesystem::create_directories(path.parent_path());
				auto temp = path; temp += ".tmp";
				std::ofstream out(temp, std::ios::binary | std::ios::trunc);
				out << settings.dump(2); out.flush();
				if (!out) return false;
				out.close();
				if (!MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return false;
				g_settings = settings;
				return true;
			} catch (const std::exception& e) {
				logger::warn("party-recall: cannot save key backup: {}", e.what());
				return false;
			}
		}
		bool Claim(int key)
		{
			const int current = NffKey();
			if (!Policy::CanClaim(key, current)) return false;
			// The installed 2.8.6 MCM's unassign branch sets this exact Auto
			// property to -1. OnKeyDown compares it at execution time. Leaving
			// the old registration dormant avoids removing another NFF function
			// that happens to share its quest handle/key. No PEX replacement.
			if (current != -1 && !SetNffKey(current, -1)) return false;
			g_hotkey = static_cast<std::uint32_t>(key);
			return true;
		}
	}

	std::string TakeOverKey()
	{
		Load();
		const int current = NffKey();
		const int key = Policy::KeyValid(current) ? current : g_settings.value("key", 0);
		if (!Policy::CanClaim(key, current))
			return "Assign a keyboard summon key in NFF first, then use Take over NFF summon key.";
		auto next = g_settings;
		next["enabled"] = true; next["key"] = key;
		// Backup FIRST. No disk write failure can erase the player's only key.
		if (!Save(next)) return "Could not save the key backup; NFF still owns its summon key.";
		if (!Claim(key)) return "NFF's binding changed; summon key takeover was not applied. Try again.";
		g_warned = false;
		logger::info("party-recall: took over NFF summon key {} (active followers only)", key);
		return "SkyManager now owns NFF's summon key. Active followers only; waiting companions stay.";
	}

	std::string RestoreNffKey()
	{
		Load();
		const int key = g_settings.value("key", 0);
		const int current = NffKey();
		auto next = g_settings; next["enabled"] = false;
		if (!Save(next)) return "Could not save the change; the summon key is unchanged.";
		g_hotkey = 0;
		if (!Policy::CanClaim(key, current))
			return "SkyManager's transferred key is off. NFF is unavailable or has a different binding; that binding was left alone.";
		auto mcm = Script("nwsFollowerMCMScript");
		if (!mcm) return "SkyManager's transferred key is off. Restore the summon key in NFF's MCM.";
		if (current != key && !SetNffKey(current, key))
			return "SkyManager's key is off. NFF could not restore its key; assign it in NFF's MCM.";
		RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
		auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
		if (!vm || !vm->DispatchMethodCall(mcm, "RegisterForKey", RE::MakeFunctionArguments(int(key)), cb))
			return "SkyManager's key is off. Reassign the summon key in NFF's MCM to register it.";
		logger::info("party-recall: returned summon key {} to NFF", key);
		return "Summon key returned to NFF. Its usual summon behavior and waiting prompt apply.";
	}

	void Reset()
	{
		++g_epoch;
		g_hotkey = 0; g_quests.clear(); g_warned = false; g_lastRecall = {};
	}
	void Tick(bool ready, bool blocked)
	{
		if (!ready || blocked) return;
		Load();
		if (!g_settings.value("enabled", false)) return;
		const int key = g_settings.value("key", 0);
		if (!key) { // explicit rig/user opt-in, adopting the LIVE MCM key
			if (Policy::KeyValid(NffKey())) RE::DebugNotification(TakeOverKey().c_str());
			return;
		}
		if (g_hotkey.load()) {
			if (NffKey() == -1) return;
			g_hotkey = 0; // NFF was rebound: do not run two summon handlers
			g_warned = true;
			RE::DebugNotification("NFF's summon key changed. Use Take over NFF summon key again in SkyManager.");
			return;
		}
		if (g_warned) return;
		if (Claim(key)) logger::info("party-recall: restored key ownership after load, key={}", key);
		else if (NffKey() != -2) {
			g_warned = true;
			RE::DebugNotification("NFF has a different summon key. SkyManager left it alone; use Take over NFF summon key to switch.");
		}
	}
	std::uint32_t Hotkey() { return g_hotkey.load(); }
	bool OnKey(std::uint32_t key)
	{
		if (!key || key != g_hotkey.load()) return false;
		if (NffKey() != -1) {
			g_hotkey = 0; g_warned = true;
			RE::DebugNotification("NFF reclaimed its summon key. Use Take over NFF summon key again in SkyManager.");
			return false;
		}
		const auto epoch = g_epoch;
		SKSE::GetTaskInterface()->AddTask([epoch, key]() {
			if (epoch != g_epoch || key != g_hotkey.load() || NffKey() != -1) return;
			auto* ui = RE::UI::GetSingleton();
			if (!ui || ui->GameIsPaused() || ui->IsMenuOpen(RE::Console::MENU_NAME)) return;
			const auto result = json::parse(Recall(), nullptr, false);
			if (result.is_object()) RE::DebugNotification(result.value("msg", "").c_str());
		});
		return true;
	}

	namespace
	{
		struct Row
		{
			RE::ActorHandle handle;
			Policy::Evidence ev;
			Policy::Decision decision = Policy::Decision::Ignore;
			const char* registered = ""; // "always" / "never" / ""
			bool flaggedOnly = false;
		};
		struct SurveyResult
		{
			std::vector<Row> rows;
			json missing = json::array(); // register entries that resolve to nobody right now
		};

		// The register, as stored: [{formId (local hex), plugin, name, mode}].
		json& Registry()
		{
			Load();
			if (!g_settings.contains("roster") || !g_settings["roster"].is_array()) g_settings["roster"] = json::array();
			return g_settings["roster"];
		}
		std::string RegistryKeyOf(const RE::Actor* actor)
		{
			std::string fid, plugin;
			if (!actor || !ActorIdentity::DurableOf(actor, fid, plugin)) return {};
			return ActorIdentity::Key(fid, plugin);
		}
		const char* RegisteredMode(const std::string& key)
		{
			if (key.empty()) return "";
			for (const auto& e : Registry()) {
				if (!e.is_object()) continue;
				if (ActorIdentity::Key(e.value("formId", ""), e.value("plugin", "")) != key) continue;
				const auto mode = e.value("mode", "");
				return mode == "never" ? "never" : mode == "always" ? "always" : "";
			}
			return "";
		}

		// One pass over everyone who could conceivably be following; no
		// actor-state change. Recall() moves the Recall rows, Roster() lists
		// them — so what the page shows IS what the key would do.
		SurveyResult Survey(RE::PlayerCharacter* player)
		{
			SurveyResult out;
			std::vector<RE::ActorHandle> actors;
			std::unordered_set<RE::FormID> seen;
			std::unordered_set<RE::FormID> onAlias; // filled follower aliases: NFF/vanilla clear these on dismiss
			auto add = [&](RE::Actor* actor) {
				if (actor && actor != player && seen.insert(actor->GetFormID()).second) actors.push_back(actor->GetHandle());
			};
			// All four process tiers: distant/unloaded followers are not just the
			// high-process actors used to draw the nearby HUD.
			if (auto* lists = RE::ProcessLists::GetSingleton())
				lists->ForAllActors([&](RE::Actor* a) { add(a); return RE::BSContainer::ForEachResult::kContinue; });
			const auto vars = Script(kVars);
			auto aliases = [&](RE::TESQuest* quest) {
				if (!quest) return;
				for (auto* alias : quest->aliases)
					if (auto* ref = alias ? skyrim_cast<RE::BGSRefAlias*>(alias) : nullptr)
						if (auto* actor = ref->GetActorReference()) {
							add(actor);
							onAlias.insert(actor->GetFormID());
						}
			};
			aliases(FormProp<RE::TESQuest>(vars, "DialogueFollower"));
			// Same vanilla DialogueFollower identity already used by nff_control.
			aliases(RE::TESForm::LookupByID<RE::TESQuest>(0x000750BA));
			const auto fo = json::parse(FollowerDeck::StateJson(), nullptr, false);
			if (fo.is_object() && fo.contains("state") && fo["state"].is_object()) {
				const auto& state = fo["state"];
				if (state.contains("categories") && state["categories"].is_array())
					for (const auto& cat : state["categories"])
						if (cat.is_object() && cat.contains("members") && cat["members"].is_array())
							for (const auto& row : cat["members"])
								if (row.is_object() && row.contains("formId") && row["formId"].is_string())
									add(RE::TESForm::LookupByID<RE::Actor>(ActorIdentity::ParseHex(row["formId"].get<std::string>())));
			}
			// The register: a registered person is a candidate even when no
			// process list holds her; one that resolves to nobody is reported.
			for (const auto& e : Registry()) {
				if (!e.is_object()) continue;
				auto* actor = ActorIdentity::ResolveActor(e.value("formId", ""), e.value("plugin", ""));
				if (actor) add(actor);
				else out.missing.push_back({{"formId", e.value("formId", "")}, {"plugin", e.value("plugin", "")},
					{"name", e.value("name", "")}, {"registered", e.value("mode", "")}, {"missing", true}});
			}
			// NFF itself checks this special case before WaitingForPlayer: Serana
			// can wait in her mental-model quest without setting the actor value.
			auto* serana = FormProp<RE::Actor>(vars, "Serana");
			auto mental = Bind(FormProp<RE::TESQuest>(vars, "DLC1NPCMentalModel"), "DLC1_NPCMentalModelScript");
			const bool seranaWaiting = BoolProp(mental, "IsWaiting");
			auto* faction = RE::TESForm::LookupByID<RE::TESFaction>(0x0005C84E);
			for (auto& handle : actors) {
				auto actorPtr = handle.get();
				auto* actor = actorPtr.get();
				if (!actor) continue;
				Row row;
				row.handle = handle;
				auto& evidence = row.ev;
				evidence.unavailable = actor->IsDead() || actor->IsDisabled() || actor->IsDeleted();
				evidence.teammate = actor->IsPlayerTeammate();
				evidence.currentFaction = faction && actor->IsInFaction(faction);
				evidence.factionRank = evidence.currentFaction ? actor->GetFactionRank(faction, false) : -1;
				// Verified custom-framework recruitment adapter; never use merely
				// belonging to a companion plugin or having any follow package.
				evidence.frameworkFollowing = FollowerFrameworks::RecruitmentState(actor) == 1;
				evidence.alias = onAlias.count(actor->GetFormID()) != 0;
				// Custom follower systems: her mod's own follow package, in force
				// now (fix_actions.cpp diagnoses "following?" the same way).
				evidence.followPackage = FollowerFrameworks::IsFollowPackage(actor->GetCurrentPackage());
				row.registered = RegisteredMode(RegistryKeyOf(actor));
				evidence.registered = std::strcmp(row.registered, "always") == 0;
				evidence.blocked = std::strcmp(row.registered, "never") == 0;
				if (Policy::Decide(evidence) == Policy::Decision::Ignore) {
					// Vilja / Windy / Katana, 2026-09-26: a lone teammate flag or a
					// static faction rank is a mod's bookkeeping, not a recruit.
					row.flaggedOnly = Policy::FlaggedOnly(evidence);
					if (row.flaggedOnly || *row.registered) out.rows.push_back(row);
					continue;
				}
				auto* av = actor->AsActorValueOwner();
				evidence.waiting = (av && av->GetActorValue(RE::ActorValue::kWaitingForPlayer) != 0.0f) ||
					(actor == serana && seranaWaiting);
				evidence.busy = actor->IsOnMount() || actor->GetCurrentScene() ||
					NpcActions::HasPoseHold(actor->GetFormID()) || OstimDeck::ActorInScene(actor->GetFormID());
				row.decision = Policy::Decide(evidence);
				out.rows.push_back(row);
			}
			return out;
		}
	}

	std::string Recall()
	{
		json out{{"ok", false}, {"op", "allSummon"}, {"phase", "done"}, {"via", "active-followers"}};
		auto fail = [&](const char* message) { out["msg"] = message; return out.dump(); };
		auto* player = RE::PlayerCharacter::GetSingleton();
		// MoveTo is native and safe during the menu-closing frame, just like
		// FO's summon. Only the hotkey route requires unpaused gameplay; a
		// Prisma Unfocus may not have cleared the engine's pause count yet.
		if (!player || !player->GetParentCell()) return fail("Load a game before recalling your followers.");
		const auto now = std::chrono::steady_clock::now();
		if (now - g_lastRecall < std::chrono::milliseconds(800)) return fail("Follower recall is already in progress.");
		g_lastRecall = now;

		const auto survey = Survey(player);
		int recalled = 0, waiting = 0, busy = 0, flagged = 0;
		std::string flaggedNames; // the teammate-only / faction-only NPCs left alone, for the log
		json results = json::array();
		for (const auto& row : survey.rows) {
			auto actorPtr = row.handle.get();
			auto* actor = actorPtr.get();
			if (!actor) continue;
			if (row.flaggedOnly) {
				++flagged;
				if (flagged <= 12) {
					const char* n = actor->GetDisplayFullName();
					flaggedNames += (flagged > 1 ? ", " : "") + std::string(n && *n ? n : "?") +
						(row.ev.teammate ? "[teammate]" : "[faction]");
				}
				continue;
			}
			if (row.decision == Policy::Decision::Ignore) continue;
			const char* reason = row.decision == Policy::Decision::Waiting ? "waiting" :
				row.decision == Policy::Decision::Busy ? "busy" : "recalled";
			if (row.decision == Policy::Decision::Waiting) ++waiting;
			else if (row.decision == Policy::Decision::Busy) ++busy;
			else {
				// Same engine summon as FO's CallToMe and NPC Finder's Bring.
				// MoveTo performs cross-cell attachment; no SetPosition shortcut.
				actor->MoveTo(player);
				++recalled;
			}
			const char* name = actor->GetDisplayFullName();
			const char* basis = Policy::Basis(row.ev);
			results.push_back({{"formId", ActorIdentity::HexOf(actor->GetFormID())}, {"name", name ? name : "Follower"},
				{"result", reason}, {"via", basis ? basis : "?"}});
		}
		out["ok"] = true; out["recalled"] = recalled; out["waiting"] = waiting; out["busy"] = busy;
		out["flaggedOnly"] = flagged; out["actors"] = results;
		out["msg"] = "Recalled " + std::to_string(recalled) + " follower" + (recalled == 1 ? "" : "s") +
			(waiting ? "; " + std::to_string(waiting) + " waiting left in place" : "") +
			(busy ? "; " + std::to_string(busy) + " busy left in place" : "");
		logger::info("party-recall: roster-evidence gate left {} flagged-but-unrecruited actor(s) alone: {}", flagged, flaggedNames);
		logger::info("party-recall: active-only result {}", out.dump(-1, ' ', false, json::error_handler_t::replace));
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Roster()
	{
		json out{{"ok", false}, {"rows", json::array()}};
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player || !player->GetParentCell()) { out["msg"] = "Load a game to see who would answer the recall."; return out.dump(); }
		Load();
		const auto survey = Survey(player);
		json rows = json::array();
		int answer = 0, flagged = 0, registered = 0;
		const auto ppos = player->GetPosition();
		for (const auto& row : survey.rows) {
			auto actorPtr = row.handle.get();
			auto* actor = actorPtr.get();
			if (!actor) continue;
			const char* name = actor->GetDisplayFullName();
			const char* basis = Policy::Basis(row.ev);
			const char* decision = row.decision == Policy::Decision::Recall ? "recall" :
				row.decision == Policy::Decision::Waiting ? "waiting" :
				row.decision == Policy::Decision::Busy ? "busy" : "ignore";
			std::string fid, plugin;
			const bool durable = ActorIdentity::DurableOf(actor, fid, plugin);
			auto* cell = actor->GetParentCell();
			const char* cellName = cell ? cell->GetFullName() : nullptr;
			json r{
				{"formId", ActorIdentity::HexOf(actor->GetFormID())},
				{"name", name && *name ? name : "?"},
				{"base", actor->GetActorBase() && actor->GetActorBase()->GetFullName() ? actor->GetActorBase()->GetFullName() : ""},
				{"durable", durable ? fid + "~" + plugin : ""},
				{"plugin", durable ? plugin : ""},
				{"localId", durable ? fid : ""},
				{"cell", cellName && *cellName ? cellName : ""},
				{"loaded", actor->Is3DLoaded()},
				{"basis", basis ? basis : ""},
				{"decision", decision},
				{"teammate", row.ev.teammate},
				{"faction", Policy::FactionFollowing(row.ev)},
				{"factionRank", row.ev.factionRank},
				{"alias", row.ev.alias},
				{"followPackage", row.ev.followPackage},
				{"framework", row.ev.frameworkFollowing},
				{"waiting", row.ev.waiting},
				{"busy", row.ev.busy},
				{"dead", actor->IsDead()},
				{"disabled", actor->IsDisabled()},
				{"flaggedOnly", row.flaggedOnly},
				{"registered", row.registered},
			};
			if (actor->Is3DLoaded()) r["dist"] = static_cast<int>(actor->GetPosition().GetDistance(ppos) * 0.0142875f + 0.5f);
			if (basis) ++answer;
			if (row.flaggedOnly) ++flagged;
			if (*row.registered) ++registered;
			rows.push_back(r);
		}
		for (const auto& m : survey.missing) { rows.push_back(m); ++registered; }
		out["ok"] = true; out["rows"] = rows;
		out["answer"] = answer; out["flagged"] = flagged; out["registered"] = registered;
		out["key"] = json{{"enabled", g_settings.value("enabled", false)}, {"key", g_settings.value("key", 0)},
			{"owned", g_hotkey.load() != 0}};
		logger::info("party-recall: roster page {} answer / {} flagged / {} registered", answer, flagged, registered);
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string SetRegistry(const std::string& request)
	{
		const auto req = json::parse(request, nullptr, false);
		auto fail = [&](const std::string& message) {
			json out{{"ok", false}, {"msg", message}, {"rows", json::array()}};
			return out.dump(-1, ' ', false, json::error_handler_t::replace);
		};
		if (!req.is_object()) return fail("Unreadable register request.");
		const std::string mode = req.value("mode", "");
		if (mode != "always" && mode != "never" && mode != "clear") return fail("Register mode must be always, never or clear.");
		std::string fid = req.value("formId", ""), plugin = req.value("plugin", "");
		std::string name = req.value("name", "");
		// A live actor gives the durable pair; a missing register entry (only
		// ever cleared) is addressed by the pair it was stored under.
		if (auto* actor = ActorIdentity::ResolveActor(fid, plugin)) {
			std::string d, dp;
			if (ActorIdentity::DurableOf(actor, d, dp)) { fid = d; plugin = dp; }
			else if (mode != "clear") return fail("She was spawned this session and has no durable identity to register.");
			if (name.empty() && actor->GetDisplayFullName()) name = actor->GetDisplayFullName();
		} else if (mode != "clear") return fail("Couldn't find that person in the game right now.");
		const auto key = ActorIdentity::Key(fid, plugin);
		if (key.empty()) return fail("Nothing to register.");
		Load();
		json roster = json::array();
		for (const auto& e : Registry())
			if (e.is_object() && ActorIdentity::Key(e.value("formId", ""), e.value("plugin", "")) != key) roster.push_back(e);
		if (mode != "clear") roster.push_back({{"formId", fid}, {"plugin", plugin}, {"name", name}, {"mode", mode}});
		auto next = g_settings; next["roster"] = roster;
		if (!Save(next)) return fail("Could not write party-recall.json; nothing changed.");
		logger::info("party-recall: register {} {}~{} ({})", mode, fid, plugin, name);  // marker: party-recall-register
		return Roster();
	}
}
