#include "ostim_deck.h"

#include "ostim_thread_api.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <vector>
#include <atomic>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;
namespace OT = OstimNG_API::Thread;

namespace OstimDeck
{
	namespace
	{
		// The OStim SA Thread API, acquired lazily — OStim.dll may load after us,
		// and it is legitimately absent if OStim isn't installed/enabled. Cached
		// once acquired (the pointer is stable for the session).
		OT::IThreadInterface* g_api = nullptr;
		bool                  g_triedThisBoot = false;
        std::atomic<std::uint64_t> g_sceneGeneration{0};
        void SceneEvent(OT::ThreadEvent event, std::uint32_t thread, void*) {
            if(thread==0 && event==OT::ThreadEvent::ThreadStarted)++g_sceneGeneration;
        }

		OT::IThreadInterface* Api()
		{
			if (g_api)
				return g_api;
			// Retry across calls (not just once) so a late OStim load still lights
			// us up, but don't hammer GetProcAddress every frame — only on demand.
			g_api = OT::GetAPI("HotkeyDeck", REL::Version(1, 0, 0, 0));
			if (g_api && !g_triedThisBoot) {
				logger::info("ostim: Thread API acquired (marker: ostim-scene-deck)");
				g_triedThisBoot = true;
                g_api->RegisterEventCallback(SceneEvent, nullptr);
			}
			return g_api;
		}

		std::string NameOfId(std::uint32_t formID)
		{
			if (auto a = RE::TESForm::LookupByID<RE::Actor>(formID)) {
				if (auto base = a->GetActorBase()) {
					if (auto n = base->GetFullName(); n && n[0])
						return n;
				}
			}
			return "actor";
		}

		std::string ResultJson(bool ok, const std::string& msg)
		{
			return json{ { "ok", ok }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// The player's live thread, or 0. Wrapped so every entry point agrees.
		// ⚠ OStim's GetPlayerThreadID() is an UNIMPLEMENTED STUB that always
		// returns 0 (OstimNG-API-Thread.cpp:62-65). The player's scene IS thread 0
		// in OStim SA, and IsThreadValid(0) is the real "in a scene?" signal
		// (ThreadManager::GetThread(0) is null when nothing runs). So we take the
		// stub's 0 and rely on IsThreadValid — NEVER gate on `tid != 0`, or the
		// panel says "Not in a scene" forever (the bug Rober hit 2026-08-08).
		std::uint32_t PlayerThread(OT::IThreadInterface* api)
		{
			return api ? api->GetPlayerThreadID() : 0u;
		}

		bool InScene(OT::IThreadInterface* api)
		{
			return api && api->IsThreadValid(PlayerThread(api));
		}

		std::string CStr(const char* s) { return s ? s : ""; }

		// ---- scene search by WORDS (2026-10-14) ---------------------------
		// OStim's SearchScenes is one case-insensitive substring over the scene
		// NAME, so "anub's doggy" (an apostrophe, two words) found nothing and an
		// id or a pack name was never searched. Rober: "i tried search anub and
		// anub's doggy and sorting wasnt super great in ostim menu".
		// So: ask OStim for EVERY scene that fits the thread (empty query) and
		// keep the ones where every query word is in name|id|pack, compared on
		// lower-case letters and digits only with apostrophes dropped; a word's
		// trailing s is optional ("anubs" ~ "Anub"). The view (ostim-pane.js
		// rankScenes) does the RANKING; this only has to keep every candidate,
		// which OStim's own first-300-A-Z cut did not ("doggy" alone has 460
		// fitting phases on the rig). Mirror: ostim-pane.checks.js ostimFakeNew.
		bool IsApostrophe(const std::string& s, std::size_t i, std::size_t& skip)
		{
			const auto c = static_cast<unsigned char>(s[i]);
			if (c == '\'' || c == '`') { skip = 1; return true; }
			// U+2018 / U+2019 (E2 80 98/99) and U+00B4 (C2 B4) in UTF-8
			if (c == 0xE2 && i + 2 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0x80 &&
				(static_cast<unsigned char>(s[i + 2]) == 0x98 || static_cast<unsigned char>(s[i + 2]) == 0x99)) { skip = 3; return true; }
			if (c == 0xC2 && i + 1 < s.size() && static_cast<unsigned char>(s[i + 1]) == 0xB4) { skip = 2; return true; }
			return false;
		}
		// Lower-case ASCII letters and digits (and any non-ASCII byte, kept as is);
		// apostrophes vanish, every other mark becomes `sep` (0 = dropped).
		std::string FoldForSearch(const std::string& s, char sep)
		{
			std::string out;
			out.reserve(s.size());
			for (std::size_t i = 0; i < s.size();) {
				std::size_t skip = 0;
				if (IsApostrophe(s, i, skip)) { i += skip; continue; }
				const auto c = static_cast<unsigned char>(s[i++]);
				if (c >= 0x80 || std::isalnum(c)) out.push_back(static_cast<char>(c >= 0x80 ? c : std::tolower(c)));
				else if (sep && (out.empty() || out.back() != sep)) out.push_back(sep);
			}
			return out;
		}
		std::vector<std::string> QueryWords(const std::string& query)
		{
			std::vector<std::string> words;
			std::string cur;
			for (char c : FoldForSearch(query, ' ') + ' ') {
				if (c != ' ') { cur.push_back(c); continue; }
				if (!cur.empty() && std::find(words.begin(), words.end(), cur) == words.end()) words.push_back(cur);
				cur.clear();
			}
			return words;
		}
		bool SceneMatchesAll(const std::vector<std::string>& words, const std::string& name, const std::string& id, const std::string& pack)
		{
			const std::string hay = FoldForSearch(name, 0) + '|' + FoldForSearch(id, 0) + '|' + FoldForSearch(pack, 0);
			for (const auto& w : words) {
				if (hay.find(w) != std::string::npos) continue;
				if (w.size() > 3 && w.back() == 's' && hay.find(w.substr(0, w.size() - 1)) != std::string::npos) continue;
				return false;
			}
			return true;
		}

		// Fill the live-state members shared by OpenJson and StateJson.
		void FillState(json& out, OT::IThreadInterface* api)
		{
			const bool haveApi = (api != nullptr);
			out["ok"] = true;
			out["ostim"] = haveApi;

			std::uint32_t tid = PlayerThread(api);
			const bool inScene = haveApi && api->IsThreadValid(tid);
			out["inScene"] = inScene;
			out["threadID"] = tid;

			if (!inScene) {
				out["scene"] = "";
				out["sceneName"] = "";
				out["actorCount"] = 0;
				out["actors"] = json::array();
				out["speed"] = 0;
				out["maxSpeed"] = 0;
				out["auto"] = false;
				out["furnitureType"] = "";
				out["canSwap"] = false;
				return;
			}

			out["scene"] = CStr(api->GetCurrentSceneID(tid));
			out["sceneName"] = CStr(api->GetCurrentNodeName(tid));

			const std::uint32_t n = api->GetActorCount(tid);
			out["actorCount"] = n;
			out["canSwap"] = (n >= 2);

			json actors = json::array();
			if (n > 0) {
				std::vector<OT::ActorData> buf(n);
				const std::uint32_t got = api->GetActors(tid, buf.data(), n);
				for (std::uint32_t i = 0; i < got; ++i) {
					actors.push_back(json{
						{ "name", NameOfId(buf[i].formID) },
						{ "female", buf[i].isFemale },
						{ "formId", buf[i].formID },
						// OStim's own excitement meter (0-100) and climax count, the
						// numbers its native bars draw - the Scene page's bar strip
						// reads them from the same poll as the cast (marker below).
						{ "excitement", std::round(std::clamp(buf[i].excitement, 0.0f, 100.0f) * 10.0f) / 10.0f },
						{ "climaxed", buf[i].timesClimaxed },
					});
				}
			}
			out["actors"] = actors;

			out["speed"] = api->GetCurrentSpeed(tid);
			out["maxSpeed"] = api->GetMaxSpeed(tid);
			out["auto"] = api->IsAutoMode(tid);
			// Furniture type isn't in the Thread API; the panel shows the current
			// scene's furniture only after a switch. Left blank here on purpose.
			out["furnitureType"] = "";
		}

		// Nearest usable furniture object to the player, for the furniture switch.
		// Deliberately C++-side (not OSANative.FindBed) so we never have to read a
		// Papyrus array return; beds are preferred but any furniture qualifies.
		RE::TESObjectREFR* NearbyFurniture(float radius)
		{
			auto pc = RE::PlayerCharacter::GetSingleton();
			auto tes = RE::TES::GetSingleton();
			if (!pc || !tes)
				return nullptr;

			RE::TESObjectREFR* best = nullptr;
			float bestDist = radius * radius + 1.0f;
			const RE::NiPoint3 origin = pc->GetPosition();

			tes->ForEachReferenceInRange(pc, radius,
				[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
					if (!ref || ref == pc || ref->IsDisabled() || ref->IsDeleted())
						return RE::BSContainer::ForEachResult::kContinue;
					auto base = ref->GetBaseObject();
					if (!base || !base->Is(RE::FormType::Furniture))
						return RE::BSContainer::ForEachResult::kContinue;
					const float d = origin.GetSquaredDistance(ref->GetPosition());
					if (d < bestDist) {
						bestDist = d;
						best = ref;
					}
					return RE::BSContainer::ForEachResult::kContinue;
				});
			return best;
		}

		// Dispatch the OStim Papyrus global native OThread.ChangeFurniture. This is
		// the ONLY Papyrus path in the module — the Thread API has no furniture
		// switch — hence its own honest log line.
		bool DispatchChangeFurniture(std::int32_t threadID, RE::TESObjectREFR* furn, const std::string& sceneId)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return false;
			auto args = RE::MakeFunctionArguments(
				std::move(threadID),
				std::move(furn),
				RE::BSFixedString(sceneId.c_str()));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			const bool ok = vm->DispatchStaticCall("OThread", "ChangeFurniture", args, cb);
			logger::info("ostim: [papyrus] OThread.ChangeFurniture(tid={}, furn={}, scene='{}') -> {}",
				threadID, furn ? "ref" : "None", sceneId, ok ? "dispatched" : "refused");
			return ok;
		}
	}

	void Init()
	{
		LoadMetadata();
		LoadExpressions();
		g_api = nullptr;
		g_triedThisBoot = false;
		// Don't force-acquire here: OStim.dll may not be loaded yet at kDataLoaded.
		// Api() lazily grabs it the first time the panel opens.
		logger::info("ostim: npc-scene-status ready");
		logger::info("ostim: deck segment ready (marker ostim-scene-deck)");
		logger::info("ostim: scene search matches words in name, id and pack (marker ostim-scene-search-words)");
	}

	std::string OpenJson()
	{
		auto api = Api();
		json out = json::object();
		FillState(out, api);

		// Seed with an initial scene list (empty query = everything, capped). The
		// pane narrows live via osSearch.
		//
		// ⚠ ONLY when a scene is running. OStim's own SearchScenes derefs
		// UIState::currentThread WITHOUT a null check (OstimNG-API-Thread.cpp:446,
		// `thread->getActorCount()`), so calling it with no active thread is a hard
		// CTD inside OStim.dll — which is exactly what opening this tab out of a
		// scene did. Out of a scene there is nothing to change anyway.
		json scenes = json::array();
		if (api && out.value("inScene", false)) {
			const std::uint32_t inCount = out.value("actorCount", 0u);
			constexpr std::uint32_t kCap = 200;
			std::vector<OT::SceneSearchResult> buf(kCap);
			const std::uint32_t got = api->SearchScenes("", buf.data(), kCap);
			for (std::uint32_t i = 0; i < got; ++i) {
				const std::uint32_t ac = buf[i].actorCount;
				scenes.push_back(json{
					{ "sceneId", CStr(buf[i].sceneId) },
					{ "name", CStr(buf[i].name) },
					{ "actorCount", ac },
					{ "compatible", (ac == inCount) },
				});
			}
		}
		for(auto& scene:scenes)DecorateScene(scene);
		out["scenes"] = scenes;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string StateJson()
	{
		json out = json::object();
		FillState(out, Api());
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// The F7 landing question, answered without building any JSON.
    std::uint64_t PlayerSceneGeneration() { Api(); return g_sceneGeneration.load(); }

	bool PlayerInScene()
	{
		return InScene(Api());
	}

	// NPC-specific scene presence, including background threads. Never infer it
	// from the player having a scene; every request is run on the main thread.
	bool ActorInScene(std::uint32_t formId)
	{
		auto* api = Api();
		return api && api->IsActorInAnyThread(formId);
	}

	std::string ActorStateJson(std::uint32_t formId)
	{
		auto api = Api();
		json out;
		FillState(out, api);
		const bool actor = RE::TESForm::LookupByID<RE::Actor>(formId) != nullptr;
		out["formId"] = formId;
		out["active"] = actor && api && api->IsActorInAnyThread(formId);
		bool inPlayerScene = false;
		for (const auto& a : out["actors"])
			if (a.value("formId", 0u) == formId) inPlayerScene = true;
		out["inPlayerScene"] = inPlayerScene;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SearchJson(const std::string& query)
	{
		auto api = Api();
		json results = json::array();
		std::uint32_t inCount = 0;
		// ⚠ Guard as in OpenJson: OStim's SearchScenes null-derefs currentThread
		// when no scene is running. Only search while in a scene.
		const std::uint32_t tid = api ? PlayerThread(api) : 0u;
		const bool inScene = InScene(api);
		const auto words = QueryWords(query);
		if (inScene) {
			inCount = api->GetActorCount(tid);
			// No words: the old browse list (OStim's first 300 A-Z). Words: every
			// fitting scene is a candidate, and up to kKeep matches go to the view,
			// which ranks them (see "scene search by WORDS" above).
			constexpr std::uint32_t kCap = 300, kPool = 16384, kKeep = 1500;
			const std::uint32_t pool = words.empty() ? kCap : kPool;
			std::vector<OT::SceneSearchResult> buf(pool);
			const std::uint32_t got = api->SearchScenes(words.empty() ? query.c_str() : "", buf.data(), pool);
			for (std::uint32_t i = 0; i < got; ++i) {
				const std::uint32_t ac = buf[i].actorCount;
				json row{
					{ "sceneId", CStr(buf[i].sceneId) },
					{ "name", CStr(buf[i].name) },
					{ "actorCount", ac },
					{ "compatible", (ac == inCount) },
				};
				DecorateScene(row);
				if (!words.empty()) {
					const std::string pack = row.contains("pack") && row["pack"].is_string() ? row["pack"].get<std::string>() : std::string();
					if (!SceneMatchesAll(words, row["name"].get<std::string>(), row["sceneId"].get<std::string>(), pack)) continue;
				}
				results.push_back(std::move(row));
				if (results.size() >= kKeep) break;
			}
		}
		json out{ { "query", query }, { "results", results } };
		if (!words.empty()) out["matcher"] = "tokens";   // the view's plan stops at this answer
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string ChangeScene(const std::string& sceneId)
	{
		auto api = Api();
		if (!api)
			return ResultJson(false, "OStim not loaded");
		const std::uint32_t tid = PlayerThread(api);
		if (!api->IsThreadValid(tid))
			return ResultJson(false, "Not in a scene — starting one is coming soon");
		if (sceneId.empty())
			return ResultJson(false, "no scene");

		const auto r = api->NavigateToSearchResult(tid, sceneId.c_str());
		if (r == OT::APIResult::OK) {
			logger::info("ostim: changed scene -> '{}'", sceneId);
			const char* nm = api->GetCurrentNodeName(tid);
			return ResultJson(true, std::string("▸ ") + (nm && nm[0] ? nm : sceneId.c_str()));
		}
		logger::info("ostim: NavigateToSearchResult('{}') refused ({})", sceneId, static_cast<int>(r));
		return ResultJson(false, "That scene doesn't fit the current actors");
	}

	std::string Speed(const std::string& delta)
	{
		auto api = Api();
		if (!api)
			return ResultJson(false, "OStim not loaded");
		const std::uint32_t tid = PlayerThread(api);
		if (!api->IsThreadValid(tid))
			return ResultJson(false, "Not in a scene");

		const std::int32_t cur = api->GetCurrentSpeed(tid);
		const std::int32_t max = api->GetMaxSpeed(tid);
		std::int32_t want = cur;
		if (delta == "+")
			want = cur + 1;
		else if (delta == "-")
			want = cur - 1;
		else {
			try {
				want = std::stoi(delta);
			} catch (...) {
				want = cur;
			}
		}
		want = std::clamp(want, 0, max > 0 ? max : cur);
		api->SetSpeed(tid, want);
		return json{ { "ok", true }, { "msg", "speed " + std::to_string(want) },
			{ "speed", want }, { "maxSpeed", max } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string ToggleAuto() { return SetAutoMode(); }

	std::string SwitchFurniture(const std::string& mode)
	{
		auto api = Api();
		if (!api)
			return ResultJson(false, "OStim not loaded");
		const std::uint32_t tid = PlayerThread(api);
		if (!api->IsThreadValid(tid))
			return ResultJson(false, "Not in a scene");

		if (mode == "floor") {
			// None furniture = OStim re-picks a non-furniture (floor) scene.
			if (DispatchChangeFurniture(static_cast<std::int32_t>(tid), nullptr, ""))
				return ResultJson(true, "→ floor");
			return ResultJson(false, "OStim refused the furniture change");
		}

		// "nearby" (default): nearest furniture object to the player.
		RE::TESObjectREFR* furn = NearbyFurniture(512.0f);
		if (!furn)
			return ResultJson(false, "No furniture nearby");
		if (DispatchChangeFurniture(static_cast<std::int32_t>(tid), furn, "")) {
			std::string what = "furniture";
			if (auto b = furn->GetBaseObject())
				if (auto n = b->GetName(); n && n[0])
					what = n;
			return ResultJson(true, std::string("→ ") + what);
		}
		return ResultJson(false, "OStim refused the furniture change");
	}

	std::string SwapRoles()
	{
		auto api = Api();
		if (!api)
			return ResultJson(false, "OStim not loaded");
		const std::uint32_t tid = PlayerThread(api);
		if (!api->IsThreadValid(tid))
			return ResultJson(false, "Not in a scene");

		const std::uint32_t n = api->GetActorCount(tid);
		if (n < 2)
			return ResultJson(false, "Need at least two actors to swap");

		std::vector<OT::ActorData> buf(n);
		const std::uint32_t got = api->GetActors(tid, buf.data(), n);
		if (got < 2)
			return ResultJson(false, "Couldn't read the scene's actors");

		std::vector<std::uint32_t> ids;
		ids.reserve(got);
		for (std::uint32_t i = 0; i < got; ++i)
			ids.push_back(buf[i].formID);
		std::reverse(ids.begin(), ids.end());

		// Callback form returns immediately (0 scheduled / -1 immediate fail) so we
		// don't block the main thread for the migration's start delay; the pane
		// re-polls osState shortly after to show the swapped roles.
		const std::int32_t r = api->MigrateThread(tid, ids.data(), got, nullptr, nullptr, 0);
		if (r < 0)
			return ResultJson(false, "OStim couldn't swap the roles here");
		logger::info("ostim: DOM/SUB swap scheduled for thread {} ({} actors)", tid, got);
		return ResultJson(true, "Swapping roles…");
	}
}
