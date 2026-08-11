#include "anim_actions.h"

#include "follower_frameworks.h"
#include "npc_actions.h"

#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace AnimActions
{
	namespace
	{
		// The baked ZAP catalogue (tools/build_zap_catalog.py output), loaded once
		// from the view dir. Held as parsed json so OpenJson can splice the live
		// target block in without re-reading the file.
		json        g_catalog = json::object();
		std::mutex  g_catMutex;

		// Deck-owned faction the crawl OAR replacer is gated on
		// (HotkeyDeckWardrobe.esp | 0x900). Resolved at Init.
		RE::TESFaction* g_crawlFac = nullptr;

		std::filesystem::path CatalogFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "zap-catalog.json";
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (actor) {
				if (auto base = actor->GetActorBase()) {
					auto n = base->GetFullName();
					if (n && n[0])
						return n;
				}
			}
			return "you";
		}

		void Notify(const std::string& msg) { RE::DebugNotification(msg.c_str()); }

		// Whoever the deck snapshotted under the crosshair; the player when nothing
		// was targeted (so "look at nothing, apply" poses yourself).
		RE::Actor* Target()
		{
			if (auto id = NpcActions::TargetFormID()) {
				if (auto a = RE::TESForm::LookupByID<RE::Actor>(id))
					return a;
			}
			return RE::PlayerCharacter::GetSingleton();
		}

		bool IsPlayer(RE::Actor* a) { return a && a->IsPlayerRef(); }

		std::string ResultJson(bool ok, const std::string& msg)
		{
			return json{ { "ok", ok }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// Dispatch a one-arg Papyrus Actor method taking a Faction (RemoveFromFaction).
		void CallActorFaction(RE::Actor* actor, const char* fn, RE::TESFaction* fac)
		{
			auto vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !actor || !fac)
				return;
			auto policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(std::move(fac));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", fn, args, cb);
		}

		// Best-effort forced sneak. ⚠ UNVERIFIED IN-GAME: sneak on an NPC is
		// normally AI-driven, and a follower framework's alias package can clear it
		// on the next re-eval. For the player this is reliable. Kept honest in the
		// log so a play-test can prove or disprove it.
		void SetSneak(RE::Actor* actor, bool on)
		{
			if (!actor)
				return;
			if (auto st = actor->AsActorState())
				st->actorState1.sneaking = on ? 1 : 0;
			actor->NotifyAnimationGraph(on ? "SneakStart"sv : "SneakStop"sv);
			actor->EvaluatePackage();
		}

		bool CrawlOn(RE::Actor* actor)
		{
			return actor && g_crawlFac && actor->IsInFaction(g_crawlFac);
		}
	}

	void Init()
	{
		{
			std::lock_guard l(g_catMutex);
			g_catalog = json::object();
			std::error_code ec;
			const auto file = CatalogFile();
			if (std::filesystem::exists(file, ec)) {
				std::ifstream in(file, std::ios::binary);
				if (in) {
					std::stringstream ss;
					ss << in.rdbuf();
					try {
						g_catalog = json::parse(ss.str());
					} catch (const std::exception& e) {
						logger::error("anim: zap-catalog.json failed to parse: {}", e.what());
						g_catalog = json::object();
					}
				}
			} else {
				logger::warn("anim: zap-catalog.json not found at {}", file.string());
			}
		}
		const std::size_t n = g_catalog.contains("entries") && g_catalog["entries"].is_array()
			? g_catalog["entries"].size() : 0;

		g_crawlFac = nullptr;
		if (auto dh = RE::TESDataHandler::GetSingleton())
			g_crawlFac = dh->LookupForm<RE::TESFaction>(0x900, "HotkeyDeckWardrobe.esp");

		logger::info("anim: catalogue loaded ({} entries), crawl faction {}",
			n, g_crawlFac ? "resolved" : "MISSING (rebuild HotkeyDeckWardrobe.esp)");
	}

	void OnPostLoadGame()
	{
		// Faction membership persists in the save; the forced sneak does not.
		// Re-assert sneak on the player if they are still a crawl-faction member.
		// (NPC members are not swept here — re-evaluating every loaded actor's
		// faction on load is not worth it; look at her and re-toggle.)
		if (auto pc = RE::PlayerCharacter::GetSingleton(); CrawlOn(pc))
			SetSneak(pc, true);
	}

	std::string TargetJson()
	{
		auto a = Target();
		return json{
			{ "name", NameOf(a) },
			{ "player", IsPlayer(a) },
			{ "crawl", CrawlOn(a) },
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string OpenJson()
	{
		json out;
		{
			std::lock_guard l(g_catMutex);
			out = g_catalog;  // copy: source/count/categories/entries
		}
		if (!out.is_object())
			out = json::object();
		auto a = Target();
		out["target"] = json{
			{ "name", NameOf(a) },
			{ "player", IsPlayer(a) },
			{ "crawl", CrawlOn(a) },
		};
		out["crawlReady"] = (g_crawlFac != nullptr);
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Play(const std::string& event)
	{
		if (event.empty())
			return ResultJson(false, "no animation");
		auto a = Target();
		if (!a)
			return ResultJson(false, "no target");
		const bool ok = a->NotifyAnimationGraph(RE::BSFixedString(event.c_str()));
		logger::info("anim: play '{}' on \"{}\" -> {}", event, NameOf(a), ok ? "sent" : "graph refused");
		if (!ok)
			return ResultJson(false, NameOf(a) + " can't play that here");
		return ResultJson(true, NameOf(a) + " ▸ " + event);
	}

	std::string Reset()
	{
		auto a = Target();
		if (!a)
			return ResultJson(false, "no target");
		a->NotifyAnimationGraph("IdleForceDefaultState"sv);
		logger::info("anim: reset \"{}\"", NameOf(a));
		return ResultJson(true, NameOf(a) + " reset");
	}

	std::string ToggleCrawl()
	{
		auto a = Target();
		if (!a)
			return json{ { "ok", false }, { "msg", "no target" }, { "on", false } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (!g_crawlFac) {
			return json{ { "ok", false },
				{ "msg", "crawl faction missing — rebuild HotkeyDeckWardrobe.esp" },
				{ "on", false } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const bool wasOn = CrawlOn(a);
		if (wasOn) {
			CallActorFaction(a, "RemoveFromFaction", g_crawlFac);
			SetSneak(a, false);
			logger::info("anim: crawl toggled off for \"{}\"", NameOf(a));
			Notify(NameOf(a) + " stops crawling");
			return json{ { "ok", true }, { "msg", NameOf(a) + " up" }, { "on", false } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		a->AddToFaction(g_crawlFac, 1);
		SetSneak(a, true);
		// Honest about the follower caveat: an alias-driven companion may not hold
		// the sneak. Say so rather than a fake success (mirrors NpcActions freeze).
		std::string suffix;
		if (!IsPlayer(a)) {
			const auto det = FollowerFrameworks::Probe(a);
			if (det.FrameworkDriven())
				suffix = " (follower — may need her dialogue to stay down)";
		}
		logger::info("anim: crawl toggled on for \"{}\"{}", NameOf(a),
			suffix.empty() ? "" : " [framework-driven]");
		Notify(NameOf(a) + " crawls" + suffix);
		return json{ { "ok", true }, { "msg", NameOf(a) + " crawling" + suffix },
			{ "on", true } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	bool IsAction(const std::string& a) { return a == "crawl"; }

	bool Run(const std::string& a)
	{
		if (a != "crawl")
			return false;
		ToggleCrawl();
		return true;
	}
}
