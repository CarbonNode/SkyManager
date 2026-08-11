#include "ostim_deck.h"

#include "ostim_thread_api.h"

#include <algorithm>
#include <vector>

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
		g_api = nullptr;
		g_triedThisBoot = false;
		// Don't force-acquire here: OStim.dll may not be loaded yet at kDataLoaded.
		// Api() lazily grabs it the first time the panel opens.
		logger::info("ostim: deck segment ready (marker ostim-scene-deck)");
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
		out["scenes"] = scenes;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string StateJson()
	{
		json out = json::object();
		FillState(out, Api());
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
		if (inScene) {
			inCount = api->GetActorCount(tid);
			constexpr std::uint32_t kCap = 300;
			std::vector<OT::SceneSearchResult> buf(kCap);
			const std::uint32_t got = api->SearchScenes(query.c_str(), buf.data(), kCap);
			for (std::uint32_t i = 0; i < got; ++i) {
				const std::uint32_t ac = buf[i].actorCount;
				results.push_back(json{
					{ "sceneId", CStr(buf[i].sceneId) },
					{ "name", CStr(buf[i].name) },
					{ "actorCount", ac },
					{ "compatible", (ac == inCount) },
				});
			}
		}
		return json{ { "query", query }, { "results", results } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
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

	std::string ToggleAuto()
	{
		auto api = Api();
		if (!api)
			return ResultJson(false, "OStim not loaded");
		const std::uint32_t tid = PlayerThread(api);
		if (!api->IsThreadValid(tid))
			return ResultJson(false, "Not in a scene");
		// The Thread API is read-only for auto-mode; toggling is OStim's own key.
		// We report the current state honestly rather than fake a write. (A real
		// toggle lives in the Scene API — folded in with the start-scene work.)
		const bool on = api->IsAutoMode(tid);
		return json{ { "ok", true },
			{ "msg", on ? "Auto mode is ON" : "Auto mode is OFF" },
			{ "auto", on } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

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
