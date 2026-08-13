#include "anim_actions.h"

#include "follower_frameworks.h"
#include "npc_actions.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <unordered_set>
#include <vector>

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

		// The scanned layer (in-game load-order scan) + its per-pack enabled
		// flags, persisted in the sidecar. Shape mirrors the baked doc:
		//   { version:1, packs:[{name,file,count,enabled}], entries:[...] }
		// entries carries ALL scanned packs (disabled ones too) so a toggle is a
		// flag flip, never a rescan.
		json             g_scan = json::object();
		std::mutex       g_scanMutex;
		std::atomic_bool g_scanBusy{ false };

		std::filesystem::path CatalogFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "zap-catalog.json";
		}

		std::filesystem::path ScanRoot()
		{
			return std::filesystem::path("Data") / "meshes" / "actors" / "character" / "animations";
		}

		std::filesystem::path SidecarFile()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "anim-scan.json";
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

		// ------------------------------------------------ load-order scanner --
		// A C++ port of tools/build_zap_catalog.py's parser, minus the curated
		// per-pack prefix maps (the baked layer keeps those for ZaZ/Halo).

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		bool Contains(const std::string& hay, const char* needle)
		{
			return hay.find(needle) != std::string::npos;
		}

		// Windows path -> UTF-8. path::string() converts through the ANSI
		// codepage, so a non-ASCII pack filename would yield bytes that
		// json::dump refuses (type_error.316) — on the scan's worker thread an
		// uncaught throw is a CTD. u8string() is lossless.
		std::string PathUtf8(const std::filesystem::path& p)
		{
			const auto u8 = p.u8string();
			return std::string(reinterpret_cast<const char*>(u8.data()), u8.size());
		}

		// FNIS_<Name>_List.txt -> "Name" (underscores become spaces).
		// Empty string when the filename isn't that shape.
		std::string PackNameFromList(const std::string& filename)
		{
			const std::string low = Lower(filename);
			if (low.rfind("fnis_", 0) != 0 || low.size() <= 14)
				return "";
			if (low.substr(low.size() - 9) != "_list.txt")
				return "";
			std::string mid = filename.substr(5, filename.size() - 14);
			std::replace(mid.begin(), mid.end(), '_', ' ');
			return mid;
		}

		bool ValidEvent(const std::string& e)
		{
			if (e.empty() || !std::isalpha(static_cast<unsigned char>(e[0])))
				return false;
			for (unsigned char c : e)
				if (!std::isalnum(c) && c != '_')
					return false;
			return true;
		}

		// Leading alphabetic run of the event — the auto-category for a pack we
		// have no curated map for ("GSPose001" -> "GSPose"). Tiny runs are noise.
		std::string AutoCatBase(const std::string& event)
		{
			std::string run;
			for (unsigned char c : event) {
				if (!std::isalpha(c))
					break;
				run.push_back(static_cast<char>(c));
			}
			return run.size() >= 2 ? run : std::string("Misc");
		}

		// Camel/digit split for a readable row label ("ZapKneelPose01" ->
		// "Zap Kneel Pose 01"). The baked layer's labels are nicer; this is the
		// honest generic fallback for unknown packs.
		std::string AutoLabel(const std::string& event)
		{
			std::string out;
			for (std::size_t i = 0; i < event.size(); ++i) {
				const unsigned char c = event[i];
				if (i > 0) {
					const unsigned char p = event[i - 1];
					const bool boundary =
						(std::islower(p) && std::isupper(c)) ||
						(std::isalpha(p) && std::isdigit(c));
					if (boundary)
						out.push_back(' ');
				}
				out.push_back(c == '_' ? ' ' : static_cast<char>(c));
			}
			return out.empty() ? event : out;
		}

		// Parse one FNIS list into `out`. Same type rules as the baker:
		// b/o applyable idle, s/so applyable sequence, fu/fuo furniture (shown
		// disabled), ofa overlay, +/pa/km skipped (continuation / multi-actor).
		// `seen` dedupes by AnimEvent across every layer (first wins).
		void ParseFnisList(const std::filesystem::path& file, const std::string& pack,
			std::unordered_set<std::string>& seen, std::vector<json>& out)
		{
			std::ifstream in(file);
			if (!in)
				return;
			static const char* SEP = " \xc2\xb7 ";  // middot, matches the baker
			std::string raw;
			while (std::getline(in, raw)) {
				// strip \r and surrounding whitespace
				std::string line;
				line.reserve(raw.size());
				for (char c : raw)
					if (c != '\r')
						line.push_back(c);
				const auto b = line.find_first_not_of(" \t");
				if (b == std::string::npos)
					continue;
				const auto e = line.find_last_not_of(" \t");
				line = line.substr(b, e - b + 1);
				if (line.empty() || line[0] == '\'' || line.rfind("Version", 0) == 0)
					continue;

				std::istringstream ss(line);
				std::string typ, tok, event;
				ss >> typ;
				typ = Lower(typ);
				if (typ == "+" || typ == "pa" || typ == "km")
					continue;
				ss >> tok;
				if (!tok.empty() && tok[0] == '-')
					ss >> event;
				else
					event = tok;
				if (!ValidEvent(event) || seen.count(event))
					continue;

				std::string kind;
				bool needsFurn = false, needsObj = false, overlay = false;
				if (typ == "fu" || typ == "fuo") {
					kind = "furniture";
					needsFurn = true;
				} else if (typ == "ofa") {
					kind = "overlay";
					overlay = true;
				} else if (typ == "b" || typ == "o" || typ == "s" || typ == "so") {
					kind = (typ == "s" || typ == "so") ? "sequence" : "idle";
					needsObj = (typ == "o" || typ == "so");
				} else {
					continue;  // aa/AV/md/ch/... — behaviour plumbing, not applyable poses
				}

				seen.insert(event);
				const std::string catBase = needsFurn ? "Furniture" : AutoCatBase(event);
				out.push_back(json{
					{ "event", event },
					{ "source", pack },
					{ "type", typ },
					{ "kind", kind },
					{ "cat_base", catBase },
					{ "category", pack + SEP + catBase },
					{ "label", AutoLabel(event) },
					{ "needsFurniture", needsFurn },
					{ "needsObject", needsObj },
					{ "overlay", overlay },
					{ "multi", false },
					{ "pack", pack },
				});
			}
		}

		// Basenames + events the baked layer already owns — scanned duplicates
		// of those are skipped so ZaZ/Halo keep their curated categories.
		void BakedCoverage(std::unordered_set<std::string>& lists, std::unordered_set<std::string>& events)
		{
			std::lock_guard l(g_catMutex);
			if (g_catalog.contains("lists") && g_catalog["lists"].is_array())
				for (const auto& f : g_catalog["lists"])
					if (f.is_string())
						lists.insert(Lower(f.get<std::string>()));
			if (g_catalog.contains("entries") && g_catalog["entries"].is_array())
				for (const auto& en : g_catalog["entries"])
					if (en.contains("event") && en["event"].is_string())
						events.insert(en["event"].get<std::string>());
		}

		void SaveSidecarLocked()  // caller holds g_scanMutex
		{
			std::error_code ec;
			const auto file = SidecarFile();
			std::filesystem::create_directories(file.parent_path(), ec);
			std::ofstream outF(file, std::ios::binary | std::ios::trunc);
			if (outF)
				outF << g_scan.dump(1, ' ', false, nlohmann::json::error_handler_t::replace);
			else
				logger::error("anim: could not write {}", PathUtf8(file));
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

		// The persisted load-order scan (if one was ever run). Bad JSON is
		// treated as "never scanned" — the pane offers the scan button again.
		{
			std::lock_guard l(g_scanMutex);
			g_scan = json::object();
			std::error_code ec;
			const auto file = SidecarFile();
			if (std::filesystem::exists(file, ec)) {
				std::ifstream in(file, std::ios::binary);
				if (in) {
					std::stringstream ss;
					ss << in.rdbuf();
					try {
						g_scan = json::parse(ss.str());
						if (!g_scan.is_object())
							g_scan = json::object();
					} catch (const std::exception& e) {
						logger::error("anim: anim-scan.json failed to parse: {}", e.what());
						g_scan = json::object();
					}
				}
			}
			if (g_scan.contains("packs") && g_scan["packs"].is_array()) {
				logger::info("anim: scan sidecar loaded ({} pack(s), {} event(s))",
					g_scan["packs"].size(),
					g_scan.contains("entries") && g_scan["entries"].is_array() ? g_scan["entries"].size() : 0);
			}
		}

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
		if (!out.contains("entries") || !out["entries"].is_array())
			out["entries"] = json::array();

		// Merge the ENABLED scanned packs in, then recompute the category tally
		// over the merged set so the rail agrees with the rows.
		{
			std::lock_guard l(g_scanMutex);
			out["scanned"] = g_scan.contains("packs") && g_scan["packs"].is_array();
			out["packs"] = out["scanned"].get<bool>() ? g_scan["packs"] : json::array();
			if (out["scanned"].get<bool>()) {
				std::unordered_set<std::string> on;
				for (const auto& p : g_scan["packs"])
					if (p.value("enabled", true))
						on.insert(p.value("name", ""));
				if (g_scan.contains("entries") && g_scan["entries"].is_array())
					for (const auto& en : g_scan["entries"])
						if (on.count(en.value("pack", "")))
							out["entries"].push_back(en);
			}
		}
		{
			std::map<std::string, int> tally;  // ordered -> stable rail order
			for (const auto& en : out["entries"])
				++tally[en.value("category", "Misc")];
			json cats = json::array();
			for (const auto& [name, count] : tally)
				cats.push_back(json{ { "name", name }, { "count", count } });
			out["categories"] = std::move(cats);
			out["count"] = out["entries"].size();
		}

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

	// The fallible middle of Scan(); the public wrapper owns the busy flag and
	// the catch-all (this runs on a detached worker thread, where an uncaught
	// throw is not a failed scan but a CTD).
	static std::string ScanImpl()
	{
		std::unordered_set<std::string> bakedLists, seen;
		BakedCoverage(bakedLists, seen);

		// pack name -> entries, in directory order; parsed lists for the log.
		std::vector<std::pair<std::string, std::string>> lists;  // (packName, basename)
		std::vector<json> entries;
		std::error_code ec;
		const auto root = ScanRoot();
		if (!std::filesystem::exists(root, ec))
			return ResultJson(false, "no animations folder in this load order");

		// FNIS's contract puts the list at animations/<Pack>/FNIS_<Pack>_List.txt
		// — one level down. We also accept lists sitting directly in animations/.
		// No deep recursion: pack folders hold thousands of .hkx files and the
		// usvfs walk cost would be all noise.
		auto scanDir = [&](const std::filesystem::path& dir) {
			std::error_code dec;
			for (auto it = std::filesystem::directory_iterator(dir, dec);
			     !dec && it != std::filesystem::directory_iterator(); it.increment(dec)) {
				if (!it->is_regular_file(dec)) {
					dec.clear();  // one unreadable entry must not end the walk
					continue;
				}
				const std::string base = PathUtf8(it->path().filename());
				const std::string low = Lower(base);
				if (bakedLists.count(low))
					continue;  // ZaZ/Halo — the curated baked layer owns these
				if (Contains(low, "kopie") || Contains(low, "-md") || Contains(low, "downcompatible") ||
					Contains(low, "latest") || Contains(low, "particulary"))
					continue;  // the baker's backup/variant filters, mirrored
				const std::string pack = PackNameFromList(base);
				if (pack.empty())
					continue;
				const auto before = entries.size();
				ParseFnisList(it->path(), pack, seen, entries);
				if (entries.size() > before)
					lists.emplace_back(pack, base);
			}
		};
		scanDir(root);
		for (auto it = std::filesystem::directory_iterator(root, ec);
		     !ec && it != std::filesystem::directory_iterator(); it.increment(ec)) {
			if (!it->is_directory(ec)) {
				ec.clear();
				continue;
			}
			if (Contains(Lower(PathUtf8(it->path().filename())), "old lists"))
				continue;
			scanDir(it->path());
		}

		// Fold tiny auto-categories into "<Pack> · Misc" (the baker's rule).
		{
			static const char* SEP = " \xc2\xb7 ";
			std::map<std::string, int> tally;
			for (const auto& en : entries)
				++tally[en["category"].get<std::string>()];
			for (auto& en : entries)
				if (tally[en["category"].get<std::string>()] < 3)
					en["category"] = en["pack"].get<std::string>() + SEP + "Misc";
		}
		std::sort(entries.begin(), entries.end(), [](const json& a, const json& b) {
			const auto ka = std::tie(a["source"].get_ref<const std::string&>(),
				a["category"].get_ref<const std::string&>(), a["label"].get_ref<const std::string&>());
			const auto kb = std::tie(b["source"].get_ref<const std::string&>(),
				b["category"].get_ref<const std::string&>(), b["label"].get_ref<const std::string&>());
			return ka < kb;
		});

		// Per-pack rollup; a pack keeps its enabled flag across rescans.
		std::map<std::string, int> perPack;
		for (const auto& en : entries)
			++perPack[en["pack"].get<std::string>()];
		std::size_t nPacks = 0, nEvents = entries.size();
		{
			std::lock_guard l(g_scanMutex);
			std::unordered_set<std::string> wasOff;
			if (g_scan.contains("packs") && g_scan["packs"].is_array())
				for (const auto& p : g_scan["packs"])
					if (!p.value("enabled", true))
						wasOff.insert(p.value("name", ""));
			json packs = json::array();
			for (const auto& [pack, base] : lists) {
				if (!perPack.count(pack))
					continue;  // already rolled up under an earlier list of the same pack
				packs.push_back(json{
					{ "name", pack },
					{ "file", base },
					{ "count", perPack[pack] },
					{ "enabled", !wasOff.count(pack) },
				});
				perPack.erase(pack);
			}
			nPacks = packs.size();
			g_scan = json{
				{ "version", 1 },
				{ "packs", std::move(packs) },
				{ "entries", json(entries) },
			};
			SaveSidecarLocked();
		}
		logger::info("anim: load-order scan: {} pack(s), {} event(s)", nPacks, nEvents);
		return ResultJson(true, nPacks
			? std::to_string(nPacks) + " pack(s), " + std::to_string(nEvents) + " animations found"
			: "no other FNIS-format pose packs in this load order");
	}

	std::string Scan()
	{
		if (g_scanBusy.exchange(true))
			return ResultJson(false, "a scan is already running");
		std::string res;
		try {
			res = ScanImpl();
		} catch (const std::exception& e) {
			logger::error("anim: scan failed: {}", e.what());
			res = ResultJson(false, "scan failed — see HotkeyDeck.log");
		} catch (...) {
			logger::error("anim: scan failed: unknown exception");
			res = ResultJson(false, "scan failed — see HotkeyDeck.log");
		}
		g_scanBusy = false;
		return res;
	}

	std::string SetPack(const std::string& payloadJson)
	{
		std::string name;
		bool on = true;
		try {
			const auto j = json::parse(payloadJson);
			name = j.value("name", "");
			on = j.value("on", true);
		} catch (...) {
			return ResultJson(false, "bad pack payload");
		}
		if (name.empty())
			return ResultJson(false, "no pack named");
		{
			std::lock_guard l(g_scanMutex);
			bool found = false;
			if (g_scan.contains("packs") && g_scan["packs"].is_array())
				for (auto& p : g_scan["packs"])
					if (p.value("name", "") == name) {
						p["enabled"] = on;
						found = true;
					}
			if (!found)
				return ResultJson(false, "unknown pack: " + name);
			SaveSidecarLocked();
		}
		logger::info("anim: pack '{}' -> {}", name, on ? "on" : "off");
		return ResultJson(true, name + (on ? " shown" : " hidden"));
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
