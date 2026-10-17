#include "ied_control.h"

#include "ostim_thread_api.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <thread>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json/logger.

using json = nlohmann::json;
namespace OT = OstimNG_API::Thread;

namespace IedControl
{
	namespace
	{
		// The block key: a loaded plugin of ours (see the header).
		constexpr const char* kPlugin = "HotkeyDeckWardrobe.esp";
		// IED's own script class, from its IED.psc.
		constexpr const char* kScript = "IED";

		const std::filesystem::path kSidecar =
			std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "ied-control.json";

		struct Settings
		{
			bool playerShown = true;   // the player's displays, as the player left them
			bool hideNpcs = true;      // auto-hide on NPCs while an OStim thread runs
			bool hidePlayer = false;   // ...and on the player too
		};

		Settings                                          g_s;
		bool                                              g_loaded = false;
		std::set<std::uint32_t>                           g_applied;   // refs WE have blocked
		std::map<std::uint32_t, std::vector<std::uint32_t>> g_threads; // OStim thread -> its actors
		OT::IThreadInterface*                             g_api = nullptr;
		bool                                              g_listening = false;

		bool PluginLoaded()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && dh->LookupModByName(kPlugin) != nullptr;
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::uint32_t PlayerRef()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			return pc ? pc->GetFormID() : 0x14;
		}

		// ---------------------------------------------------------------- sidecar
		void Save()
		{
			json j{
				{ "playerShown", g_s.playerShown },
				{ "hideNpcs", g_s.hideNpcs },
				{ "hidePlayer", g_s.hidePlayer },
				{ "applied", json::array() },
			};
			for (const auto id : g_applied)
				j["applied"].push_back(id);
			std::error_code ec;
			std::filesystem::create_directories(kSidecar.parent_path(), ec);
			std::ofstream out(kSidecar, std::ios::binary | std::ios::trunc);
			if (out)
				out << Dump(j);
		}

		// Reads the sidecar once. `applied` is whatever a previous session left
		// blocked: it seeds g_applied so the first reconcile releases it.
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
			g_s.playerShown = j.value("playerShown", true);
			g_s.hideNpcs = j.value("hideNpcs", true);
			g_s.hidePlayer = j.value("hidePlayer", false);
			if (j.contains("applied") && j["applied"].is_array())
				for (const auto& v : j["applied"])
					if (v.is_number_unsigned())
						g_applied.insert(v.get<std::uint32_t>());
		}

		// ------------------------------------------------------------- IED calls
		// IED.<fn>(actor, plugin) as a fire-and-forget static dispatch.
		bool CallBlock(RE::Actor* actor, bool add)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !actor)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto* args = RE::MakeFunctionArguments(static_cast<RE::Actor*>(actor), RE::BSFixedString(kPlugin));
			return vm->DispatchStaticCall(kScript, add ? "AddActorBlock" : "RemoveActorBlock", args, cb);
		}

		// Ask IED to redraw an actor's displays now (after a block is lifted).
		void Evaluate(RE::Actor* actor)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !actor)
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto* args = RE::MakeFunctionArguments(static_cast<RE::Actor*>(actor));
			vm->DispatchStaticCall(kScript, "Evaluate", args, cb);
		}

		// ------------------------------------------------------------ the policy
		// Who SHOULD be blocked right now, as raw reference ids.
		std::set<std::uint32_t> Desired()
		{
			std::set<std::uint32_t> d;
			const auto player = PlayerRef();
			if (!g_s.playerShown)
				d.insert(player);
			if (g_s.hideNpcs || g_s.hidePlayer) {
				for (const auto& [tid, ids] : g_threads) {
					for (const auto id : ids) {
						if (id == player ? g_s.hidePlayer : g_s.hideNpcs)
							d.insert(id);
					}
				}
			}
			return d;
		}

		// Make what is blocked equal what should be. Idempotent; an actor that is
		// not loaded right now (a block to lift on someone out of the cell) stays
		// on the books and is retried on the next pass.
		void Reconcile(const char* why)
		{
			if (!Present() || !PluginLoaded())
				return;
			const auto want = Desired();
			bool       changed = false;

			for (const auto id : want) {
				if (g_applied.count(id))
					continue;
				auto* actor = RE::TESForm::LookupByID<RE::Actor>(id);
				if (!actor)
					continue;
				if (CallBlock(actor, true)) {
					g_applied.insert(id);
					changed = true;
					logger::info("ied-control: hid displays on {:08X} ({})", id, why);
				}
			}
			for (auto it = g_applied.begin(); it != g_applied.end();) {
				if (want.count(*it)) {
					++it;
					continue;
				}
				auto* actor = RE::TESForm::LookupByID<RE::Actor>(*it);
				if (!actor) {
					++it;   // not loaded: keep the claim, retry later
					continue;
				}
				if (CallBlock(actor, false)) {
					Evaluate(actor);
					logger::info("ied-control: restored displays on {:08X} ({})", *it, why);
					it = g_applied.erase(it);
					changed = true;
				} else {
					++it;
				}
			}
			if (changed)
				Save();
		}

		// ----------------------------------------------------------------- OStim
		std::vector<std::uint32_t> ReadThread(std::uint32_t tid)
		{
			std::vector<std::uint32_t> out;
			if (!g_api || !g_api->IsThreadValid(tid))
				return out;
			const std::uint32_t n = g_api->GetActorCount(tid);
			if (!n)
				return out;
			std::vector<OT::ActorData> buf(n);
			const std::uint32_t        got = g_api->GetActors(tid, buf.data(), n);
			for (std::uint32_t i = 0; i < got; ++i)
				out.push_back(buf[i].formID);
			return out;
		}

		// A thread started, changed node (people can join and leave) or ended.
		void HandleEvent(OT::ThreadEvent ev, std::uint32_t tid)
		{
			if (ev == OT::ThreadEvent::ThreadEnded) {
				g_threads.erase(tid);
			} else {
				auto ids = ReadThread(tid);
				if (ids.empty())
					g_threads.erase(tid);
				else
					g_threads[tid] = std::move(ids);
			}
			logger::info("ied-control: scene {} thread {} ({} actors tracked)",
				ev == OT::ThreadEvent::ThreadEnded ? "ended" : "update", tid,
				g_threads.count(tid) ? g_threads[tid].size() : std::size_t{ 0 });
			Reconcile("scene");
		}

		void OnThreadEvent(OT::ThreadEvent ev, std::uint32_t tid, void*)
		{
			SKSE::GetTaskInterface()->AddTask([ev, tid]() { HandleEvent(ev, tid); });
			// OStim may announce a thread before its cast is seated: read once
			// more a moment later, the same way every poll of it re-reads.
			if (ev == OT::ThreadEvent::ThreadStarted) {
				std::thread([tid]() {
					std::this_thread::sleep_for(std::chrono::milliseconds(1500));
					SKSE::GetTaskInterface()->AddTask([tid]() { HandleEvent(OT::ThreadEvent::NodeChanged, tid); });
				}).detach();
			}
		}

		// OStim.dll may load after us, so this is retried until it takes.
		void EnsureListening()
		{
			if (g_listening)
				return;
			if (!g_api)
				g_api = OT::GetAPI("SkyManagerIed", REL::Version(1, 0, 0, 0));
			if (!g_api)
				return;
			g_api->RegisterEventCallback(&OnThreadEvent, nullptr);
			g_listening = true;
			logger::info("ied-control: listening for OStim scenes");
		}

		json Reply(bool ok, const std::string& msg)
		{
			json j = json::parse(StateJson(), nullptr, false);
			if (!j.is_object())
				j = json::object();
			j["ok"] = ok;
			j["msg"] = msg;
			return j;
		}
	}

	bool Present()
	{
		return GetModuleHandleA("ImmersiveEquipmentDisplays") != nullptr;
	}

	void Init()
	{
		Load();
		EnsureListening();
	}

	void OnPostLoadGame()
	{
		Load();
		EnsureListening();
		g_threads.clear();   // no scene survives a load
		if (!Present() || !PluginLoaded())
			return;
		// 1) release what a previous session (or crash) left blocked...
		Reconcile("load");
		// 2) ...then re-assert the player's own choice: IED's co-save is whatever
		//    it was when THIS save was made, which may predate the toggle.
		if (!g_s.playerShown) {
			if (auto* pc = RE::PlayerCharacter::GetSingleton())
				if (CallBlock(pc, true)) {
					g_applied.insert(pc->GetFormID());
					Save();
				}
		}
	}

	std::string StateJson()
	{
		json j{
			{ "present", Present() },
			{ "canBlock", Present() && PluginLoaded() },
			{ "playerShown", g_s.playerShown },
			{ "hideNpcs", g_s.hideNpcs },
			{ "hidePlayer", g_s.hidePlayer },
			{ "scenes", g_threads.size() },
			{ "hidden", g_applied.size() },
		};
		if (!Present())
			j["msg"] = "Immersive Equipment Displays is not loaded.";
		else if (!PluginLoaded())
			j["msg"] = std::string(kPlugin) + " is not loaded - IED needs a loaded plugin to file its blocks under.";
		return Dump(j);
	}

	std::string SetJson(const std::string& req)
	{
		Load();
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.value("value", json()).is_boolean())
			return Dump(Reply(false, "bad request"));
		const std::string key = j.value("key", std::string(""));
		const bool        on = j["value"].get<bool>();
		if (key == "playerShown")
			g_s.playerShown = on;
		else if (key == "hideNpcs")
			g_s.hideNpcs = on;
		else if (key == "hidePlayer")
			g_s.hidePlayer = on;
		else
			return Dump(Reply(false, "unknown setting"));
		Save();
		EnsureListening();
		// A scene that is already running is re-read, so turning the setting on
		// mid-scene hides at once and turning it off restores at once.
		for (auto& [tid, ids] : g_threads) {
			auto fresh = ReadThread(tid);
			if (!fresh.empty())
				ids = std::move(fresh);
		}
		Reconcile("setting");
		return Dump(Reply(true, ""));
	}

	std::string TogglePlayerJson()
	{
		Load();
		if (!Present())
			return Dump(Reply(false, "Immersive Equipment Displays is not loaded."));
		if (!PluginLoaded())
			return Dump(Reply(false, std::string(kPlugin) + " is not loaded - IED can't file the block."));
		g_s.playerShown = !g_s.playerShown;
		Save();
		Reconcile("toggle");
		auto out = Reply(true, g_s.playerShown ? "Gear displays are back on you." : "Your gear displays are hidden.");
		out["shown"] = g_s.playerShown;
		return Dump(out);
	}
}
