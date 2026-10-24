#include "scene_camera.h"

#include "ostim_thread_api.h"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <format>
#include <fstream>
#include <thread>

// pch (force-included) provides RE::/SKSE::/json/logger.

using json = nlohmann::json;
namespace OT = OstimNG_API::Thread;

namespace SceneCamera
{
	namespace
	{
		using UEFlag = RE::UserEvents::USER_EVENT_FLAG;

		const std::filesystem::path kSidecar =
			std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "scene-camera.json";

		// Give a scene a moment to finish its own camera set-up before we judge it.
		constexpr auto kSettle = std::chrono::milliseconds(1500);

		struct Settings
		{
			bool unlock = true;
		};

		struct Snapshot
		{
			int         state = -1;
			bool        first = false, third = false, free = false;
			bool        povSwitch = true, wheelZoom = true, povScript = false;
			int         ostimCam = -1;   // OStim's Improved Camera global, -1 = not found
			int         sit = 0;
			bool        inScene = false;
		};

		Settings                              g_s;
		bool                                  g_loaded = false;
		bool                                  g_started = false;
		std::atomic<bool>                     g_alive{ true };
		OT::IThreadInterface*                 g_api = nullptr;
		bool                                  g_wasInScene = false;
		std::chrono::steady_clock::time_point g_sceneStart{};
		std::string                           g_lastSig;
		bool                                  g_unlockedThisScene = false;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		const char* StateName(int id)
		{
			switch (id) {
			case 0: return "FirstPerson";
			case 1: return "AutoVanity";
			case 2: return "VATS";
			case 3: return "Free";
			case 4: return "IronSights";
			case 5: return "Furniture";
			case 6: return "PCTransition";
			case 7: return "Tween";
			case 8: return "Animated";
			case 9: return "ThirdPerson";
			case 10: return "Mount";
			case 11: return "Bleedout";
			case 12: return "Dragon";
			default: return "?";
			}
		}

		void Save()
		{
			json j{ { "unlock", g_s.unlock } };
			std::error_code ec;
			std::filesystem::create_directories(kSidecar.parent_path(), ec);
			std::ofstream out(kSidecar, std::ios::binary | std::ios::trunc);
			if (out)
				out << Dump(j);
		}

		void Load()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(kSidecar, std::ios::binary);
			if (!in)
				return;
			const auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			g_s.unlock = j.value("unlock", true);
		}

		OT::IThreadInterface* Api()
		{
			if (!g_api)
				g_api = OT::GetAPI("SkyManagerCamera", REL::Version(1, 0, 0, 0));
			return g_api;
		}

		Snapshot Read()
		{
			Snapshot s;
			auto*    api = Api();
			s.inScene = api && api->IsThreadValid(0);   // the player's scene is thread 0

			if (auto* cam = RE::PlayerCamera::GetSingleton()) {
				s.state = cam->currentState ? static_cast<int>(cam->currentState->id) : -1;
				s.first = cam->IsInFirstPerson();
				s.third = cam->IsInThirdPerson();
				s.free = cam->IsInFreeCameraMode();
			}
			if (auto* cm = RE::ControlMap::GetSingleton()) {
				const auto bits = cm->GetRuntimeData().enabledControls.underlying();
				s.povSwitch = (bits & static_cast<std::uint32_t>(UEFlag::kPOVSwitch)) != 0;
				s.wheelZoom = (bits & static_cast<std::uint32_t>(UEFlag::kWheelZoom)) != 0;
			}
			if (auto* pcs = RE::PlayerControls::GetSingleton())
				s.povScript = pcs->data.povScriptMode;
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				if (auto* g = dh->LookupForm<RE::TESGlobal>(0xDE6, "OStim.esp"))
					s.ostimCam = static_cast<int>(g->value);
			if (auto* pc = RE::PlayerCharacter::GetSingleton())
				if (auto* st = pc->AsActorState())
					s.sit = static_cast<int>(st->GetSitSleepState());
			return s;
		}

		std::string Sig(const Snapshot& s)
		{
			return std::format("state={}({}) 1st={} 3rd={} free={} POVswitch={} wheelZoom={} povScriptMode={} ostimImprovedCam={} sitSleep={}",
				StateName(s.state), s.state, s.first ? 1 : 0, s.third ? 1 : 0, s.free ? 1 : 0, s.povSwitch ? 1 : 0,
				s.wheelZoom ? 1 : 0, s.povScript ? 1 : 0, s.ostimCam, s.sit);
		}

		// Give F and the wheel back. Returns true if anything was locked.
		bool Unlock(const Snapshot& s)
		{
			if (s.povSwitch && s.wheelZoom && !s.povScript)
				return false;
			if (auto* cm = RE::ControlMap::GetSingleton())
				cm->ToggleControls(static_cast<UEFlag>(static_cast<std::uint32_t>(UEFlag::kPOVSwitch) |
				                                       static_cast<std::uint32_t>(UEFlag::kWheelZoom)),
					true, true);
			if (auto* pcs = RE::PlayerControls::GetSingleton())
				pcs->data.povScriptMode = false;
			return true;
		}

		void Tick()
		{
			const Snapshot s = Read();
			if (!s.inScene) {
				if (g_wasInScene) {
					// Build marker (hd-markers.json: "scene-camera-end").
					logger::info("scene-camera: the scene ended - {}", Sig(s));
					g_wasInScene = false;
					g_lastSig.clear();
					g_unlockedThisScene = false;
				}
				return;
			}
			if (!g_wasInScene) {
				g_wasInScene = true;
				g_sceneStart = std::chrono::steady_clock::now();
				g_lastSig.clear();
				g_unlockedThisScene = false;
				// Build marker (hd-markers.json: "scene-camera-begin").
				logger::info("scene-camera: a player scene began (unlock {})", g_s.unlock ? "on" : "off");
			}
			const std::string sig = Sig(s);
			if (sig != g_lastSig) {
				// Build marker (hd-markers.json: "scene-camera-state").
				logger::info("scene-camera: {}", sig);
				g_lastSig = sig;
			}
			if (g_s.unlock && std::chrono::steady_clock::now() - g_sceneStart >= kSettle) {
				if (Unlock(s)) {
					// Build marker (hd-markers.json: "scene-camera-unlock").
					logger::info("scene-camera: gave F / wheel back (was POVswitch={} wheelZoom={} povScriptMode={})",
						s.povSwitch ? 1 : 0, s.wheelZoom ? 1 : 0, s.povScript ? 1 : 0);
					g_unlockedThisScene = true;
				}
			}
		}
	}

	void Init()
	{
		Load();
		if (g_started)
			return;
		g_started = true;
		std::thread([]() {
			while (g_alive.load()) {
				std::this_thread::sleep_for(std::chrono::milliseconds(1000));
				SKSE::GetTaskInterface()->AddTask([]() { Tick(); });
			}
		}).detach();
		logger::info("scene-camera: watching player scenes (unlock {})", g_s.unlock ? "on" : "off");
	}

	void OnPostLoadGame()
	{
		Load();
		g_wasInScene = false;
		g_lastSig.clear();
		g_unlockedThisScene = false;
	}

	std::string StateJson()
	{
		Load();
		const Snapshot s = Read();
		json           j{
			{ "unlock", g_s.unlock },
			{ "inScene", s.inScene },
			{ "state", StateName(s.state) },
			{ "firstPerson", s.first },
			{ "povSwitch", s.povSwitch },
			{ "wheelZoom", s.wheelZoom },
			{ "povScript", s.povScript },
			{ "ostimCam", s.ostimCam },
		};
		return Dump(j);
	}

	std::string SetJson(const std::string& req)
	{
		Load();
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.value("value", json()).is_boolean())
			return Dump(json{ { "ok", false }, { "msg", "bad request" } });
		if (j.value("key", std::string()) != "unlock")
			return Dump(json{ { "ok", false }, { "msg", "unknown setting" } });
		g_s.unlock = j["value"].get<bool>();
		Save();
		auto out = json::parse(StateJson(), nullptr, false);
		if (!out.is_object())
			out = json::object();
		out["ok"] = true;
		return Dump(out);
	}

	std::string ToggleViewJson()
	{
		auto* cam = RE::PlayerCamera::GetSingleton();
		auto* pc = RE::PlayerCharacter::GetSingleton();
		if (!cam || !pc || !pc->GetParentCell())
			return Dump(json{ { "ok", false }, { "msg", "No game loaded" } });

		const Snapshot before = Read();
		// Build marker (hd-markers.json: "scene-camera-toggle").
		logger::info("scene-camera: toggle view requested - {}", Sig(before));
		const bool toThird = before.first;
		const bool ok = toThird ? cam->ForceThirdPerson() : cam->ForceFirstPerson();

		// What the camera looks like once the engine and any camera mod have
		// had a moment to answer: that is the line that names a fighter.
		std::thread([toThird]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(400));
			SKSE::GetTaskInterface()->AddTask([toThird]() {
				logger::info("scene-camera: toggle to {} answered - {}", toThird ? "third" : "first", Sig(Read()));
			});
		}).detach();

		return Dump(json{ { "ok", ok }, { "msg", toThird ? "Third person" : "First person" } });
	}
}
