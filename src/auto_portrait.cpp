#include "auto_portrait.h"

#include "auto_portrait_policy.h"
#include "person_live.h"
#include "portrait_capture.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <ctime>
#include <cstdio>
#include <fstream>
#include <future>
#include <map>
#include <set>
#include <thread>
#include <vector>

#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace AutoPortrait
{
	namespace
	{
		using json = nlohmann::json;
		namespace P = AutoPortraitPolicy;

		Hooks g_hooks;

		struct Shot
		{
			RE::ActorHandle actor;
			std::uint32_t   formId = 0;
			std::string     slug, name, sig;
		};

		// Main thread owns these; the worker only reads its own copy of the list.
		bool                     g_busy = false;
		bool                     g_awaitingGo = false;
		std::vector<Shot>        g_shots;
		std::set<std::string>    g_tried;      // slug|sig attempted this session
		std::atomic<std::uint64_t> g_gen{ 0 }; // bumps on every start/abort
		std::chrono::steady_clock::time_point g_lastConsider{};

		std::filesystem::path SidecarPath() { return g_hooks.portraitDir / "auto-portraits.json"; }

		json ReadSidecar()
		{
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return json::object();
			auto j = json::parse(in, nullptr, false);
			return (j.is_discarded() || !j.is_object()) ? json::object() : j;
		}

		void WriteSidecar(const json& j)
		{
			std::error_code ec;
			std::filesystem::create_directories(g_hooks.portraitDir, ec);
			auto tmp = SidecarPath();
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
				out << j.dump(1, '\t', false, json::error_handler_t::replace);
			}
			std::filesystem::rename(tmp, SidecarPath(), ec);
			if (ec)
				logger::warn("auto-portrait: could not save {} ({})", PathU8(SidecarPath()), ec.message());
		}

		bool Enabled()
		{
			const auto j = ReadSidecar();
			return !j.contains("enabled") || j["enabled"].is_boolean() == false || j["enabled"].get<bool>();
		}

		std::string Hex(std::uint32_t v)
		{
			char b[16];
			std::snprintf(b, sizeof(b), "%08X", v);
			return b;
		}

		// The view's ids are runtime refs; an FO row can still hold a BASE id, so
		// a base resolves to the loaded actor wearing it.
		RE::Actor* ResolveActor(std::uint32_t id)
		{
			auto* form = id ? RE::TESForm::LookupByID(id) : nullptr;
			if (!form)
				return nullptr;
			if (auto* a = form->As<RE::Actor>())
				return a;
			auto* npc = form->As<RE::TESNPC>();
			auto* pl  = RE::ProcessLists::GetSingleton();
			if (!npc || !pl)
				return nullptr;
			for (auto& h : pl->highActorHandles) {
				auto  ptr = h.get();
				auto* a   = ptr.get();
				if (a && a->GetActorBase() == npc)
					return a;
			}
			return nullptr;
		}

		// What a FACE is made of. Worn head gear is deliberately left out: it is
		// hidden for the shot, so putting a helmet on must not cause a retake.
		std::string LookSignature(RE::Actor* a)
		{
			std::vector<std::string> parts;
			auto* npc = a->GetActorBase();
			parts.push_back(npc ? Hex(npc->GetFormID()) : "-");
			parts.push_back(a->GetRace() ? Hex(a->GetRace()->GetFormID()) : "-");
			if (npc) {
				for (std::int8_t i = 0; npc->headParts && i < npc->numHeadParts; ++i)
					parts.push_back(npc->headParts[i] ? Hex(npc->headParts[i]->GetFormID()) : "-");
				parts.push_back(npc->headRelatedData && npc->headRelatedData->hairColor
						? Hex(npc->headRelatedData->hairColor->GetFormID()) : "-");
			}
			// A worn WIG (hair-slot armour that is not head gear) is part of the face.
			if (auto* wig = a->GetWornArmor(RE::BGSBipedObjectForm::BipedObjectSlot::kHair)) {
				if (!wig->HasKeywordID(0x0006C0EE) && !wig->HasKeywordID(0x0010CD11))
					parts.push_back("wig:" + Hex(wig->GetFormID()));
			}
			return P::Signature(parts);
		}

		// slug -> the newest portrait file, exactly the winner FolPortraitsJson
		// hands the view (newest mtime, then the greater filename).
		std::map<std::string, std::string> NewestFiles()
		{
			std::map<std::string, std::string> out;
			const auto arr = json::parse(g_hooks.portraitsJson ? g_hooks.portraitsJson() : "[]", nullptr, false);
			if (!arr.is_array())
				return out;
			for (const auto& e : arr)
				if (e.is_object() && e.contains("slug") && e.contains("file") && e["slug"].is_string() && e["file"].is_string())
					out[e["slug"].get<std::string>()] = e["file"].get<std::string>();
			return out;
		}

		void Push(const char* fn, const json& j)
		{
			if (g_hooks.push)
				g_hooks.push(fn, j.dump(-1, ' ', false, json::error_handler_t::replace));
		}

		struct Result
		{
			std::string slug, name, file, why;
			std::uint32_t formId = 0;
			std::string sig;
			bool ok = false;
		};

		// Main thread. A photo that landed is ALWAYS recorded as ours — even when
		// the run was aborted around it — or the next open would read the file as
		// a MANUAL portrait and never refresh it again.
		void Record(const Result& r)
		{
			auto side = ReadSidecar();
			if (!side.contains("people") || !side["people"].is_object())
				side["people"] = json::object();
			// `files` keeps EVERY version we wrote (a retake keeps the old file:
			// Ultralight locks images it drew), so AutoFiles() can tell all of
			// them from a photo the player supplied. `file` stays the latest.
			json files = json::array();
			if (side["people"].contains(r.slug) && side["people"][r.slug].is_object()) {
				const auto& prev = side["people"][r.slug];
				if (prev.contains("files") && prev["files"].is_array())
					for (const auto& f : prev["files"])
						if (f.is_string())
							files.push_back(f);
				if (prev.contains("file") && prev["file"].is_string() &&
					std::find(files.begin(), files.end(), prev["file"]) == files.end())
					files.push_back(prev["file"]);
			}
			if (std::find(files.begin(), files.end(), json(r.file)) == files.end())
				files.push_back(r.file);
			side["people"][r.slug] = json{ { "file", r.file }, { "files", std::move(files) }, { "sig", r.sig },
				{ "formId", Hex(r.formId) }, { "at", static_cast<std::int64_t>(std::time(nullptr)) } };
			WriteSidecar(side);
		}

		// Main thread: put everything back, record what landed, tell the view.
		void Finish(const std::vector<Result>& results, const char* why)
		{
			PersonLive::Stop(why);
			PortraitCapture::HideHud(false);
			if (g_hooks.hudViewHidden)
				g_hooks.hudViewHidden(false);
			json taken = json::array(), failed = json::array();
			bool wrote = false;
			for (const auto& r : results) {
				g_tried.insert(r.slug + "|" + r.sig);
				if (r.ok) {
					Record(r);
					wrote = true;
					taken.push_back(json{ { "slug", r.slug }, { "name", r.name }, { "file", r.file } });
				} else {
					failed.push_back(json{ { "slug", r.slug }, { "name", r.name }, { "why", r.why } });
				}
			}
			g_shots.clear();
			g_busy = false;
			g_awaitingGo = false;
			if (wrote && g_hooks.portraitsJson && g_hooks.push)
				g_hooks.push("fdPortraits", g_hooks.portraitsJson());
			Push("fdAutoPhotoDone", json{ { "taken", taken }, { "failed", failed }, { "why", why ? why : "" } });
			logger::info("auto-portrait: done ({}) - {} taken, {} failed", why ? why : "", taken.size(), failed.size());   // marker: auto-portrait-done
		}

		// Runs a main-thread step from the worker and waits for its answer.
		bool OnMain(std::function<bool()> fn)
		{
			auto prom = std::make_shared<std::promise<bool>>();
			auto fut  = prom->get_future();
			SKSE::GetTaskInterface()->AddTask([fn = std::move(fn), prom]() {
				bool r = false;
				try { r = fn(); } catch (...) { r = false; }
				prom->set_value(r);
			});
			if (fut.wait_for(std::chrono::seconds(3)) != std::future_status::ready)
				return false;
			return fut.get();
		}

		void Worker(std::vector<Shot> shots, std::uint64_t gen)
		{
			using clock = std::chrono::steady_clock;
			std::vector<Result> results;
			const auto current = [gen]() { return g_gen.load() == gen; };
			for (std::size_t i = 0; i < shots.size(); ++i) {
				const auto& s = shots[i];
				Result r{ s.slug, s.name, "", "", s.formId, s.sig, false };
				if (!current())
					return;   // aborted: Abort() already restored and reported
				if (i > 0) {
					const auto h = s.actor;
					if (!OnMain([h]() { auto p = h.get(); return PersonLive::FaceRetarget(p.get()); })) {
						r.why = "she moved out of reach before her turn";
						results.push_back(r);
						continue;
					}
				}
				// Wait for a STEADY frame: probe the centre until two comparisons
				// in a row are still (frame generation and the temporal upscaler
				// smear the first frames after the cut), capped.
				P::Settle settle;
				std::vector<std::uint8_t> prev, cur;
				const auto t0 = clock::now();
				int probes = 0;
				for (;;) {
					std::this_thread::sleep_for(std::chrono::milliseconds(50));
					if (!current())
						return;
					const int ms = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count());
					if (!PortraitCapture::ProbeCenter(48, cur)) {
						if (ms >= settle.maxMs) break;
						continue;
					}
					++probes;
					const double diff = prev.empty() ? 255.0 : P::MeanAbsDiff(prev, cur);
					prev.swap(cur);
					if (settle.Step(ms, diff))
						break;
				}
				const int settledMs = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count());
				logger::info("auto-portrait: '{}' settled in {} ms over {} probe(s){}", s.name, settledMs, probes,
					settle.timedOut ? " - NEVER steady, shot at the cap" : "");   // marker: auto-portrait-settle
				if (!current())
					return;
				std::filesystem::path written;
				const auto err = PortraitCapture::CaptureAutoPortrait(g_hooks.portraitDir, s.slug, s.name, written);
				if (err) {
					r.why = "the frame could not be saved (error " + std::to_string(err) + ")";
				} else {
					r.ok = true;
					r.file = PathU8(written.filename());
					if (!current()) {
						// Aborted while the file was being written: keep the record.
						SKSE::GetTaskInterface()->AddTask([r]() { Record(r); });
						return;
					}
				}
				results.push_back(r);
			}
			SKSE::GetTaskInterface()->AddTask([results, gen]() {
				if (g_gen.load() != gen)
					return;
				Finish(results, "complete");
			});
		}

		void Consider(const json& j)
		{
			if (g_busy || !j.contains("people") || !j["people"].is_array())
				return;
			// One look per open is plenty; a view that re-sends on a refresh
			// burst must not start a second round.
			const auto now = std::chrono::steady_clock::now();
			if (g_lastConsider.time_since_epoch().count() && now - g_lastConsider < std::chrono::seconds(20))
				return;
			g_lastConsider = now;
			if (!Enabled())
				return;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || player->IsInCombat())
				return;

			const auto side   = ReadSidecar();
			const auto people = side.contains("people") && side["people"].is_object() ? side["people"] : json::object();
			const auto newest = NewestFiles();

			std::vector<P::Candidate> cands;
			std::vector<P::Verdict>   verdicts;
			std::vector<Shot>         shots;
			std::map<std::string, int> tally;
			std::set<std::string> seen;
			for (const auto& p : j["people"]) {
				if (!p.is_object())
					continue;
				const std::string slug = p.value("slug", std::string());
				if (slug.empty() || !seen.insert(slug).second)
					continue;
				const std::string idStr = p.value("id", std::string());
				const auto id = static_cast<std::uint32_t>(std::strtoul(idStr.c_str(), nullptr, 16));
				auto* a = ResolveActor(id);
				P::Candidate c;
				c.slug = slug;
				Shot s;
				s.slug = slug;
				s.name = p.value("name", slug);
				if (a && a != player) {
					c.loaded   = a->Is3DLoaded() && a->Get3D(false) != nullptr;
					c.alive    = !a->IsDead();
					c.distance = player->GetPosition().GetDistance(a->GetPosition());
					c.busy     = a->IsInCombat() || a->IsOnMount();
					c.sig      = LookSignature(a);
					s.actor    = a->GetHandle();
					s.formId   = a->GetFormID();
				}
				s.sig = c.sig;
				std::optional<P::Record> rec;
				if (people.contains(slug) && people[slug].is_object())
					rec = P::Record{ people[slug].value("file", std::string()), people[slug].value("sig", std::string()) };
				std::optional<std::string> nf;
				if (auto it = newest.find(slug); it != newest.end())
					nf = it->second;
				const auto v = P::Decide(c, rec, nf, g_tried.count(slug + "|" + c.sig) > 0);
				++tally[P::Name(v)];
				cands.push_back(c);
				verdicts.push_back(v);
				shots.push_back(s);
			}
			const auto pick = P::Pick(cands, verdicts);
			std::string summary;
			for (const auto& [k, n] : tally)
				summary += (summary.empty() ? "" : ", ") + std::to_string(n) + " " + k;
			logger::info("auto-portrait: considered {} - {}; shooting {}", cands.size(), summary, pick.size());   // marker: auto-portrait-consider
			if (pick.empty())
				return;

			g_shots.clear();
			json names = json::array();
			for (auto i : pick) {
				g_shots.push_back(shots[i]);
				names.push_back(shots[i].name);
			}
			g_busy = true;
			g_awaitingGo = true;
			const auto gen = ++g_gen;
			Push("fdAutoPhotoStart", json{ { "names", names } });
			// The view must answer "go" (deck hidden) promptly; if it never does,
			// stand down so the deck is not stuck refusing a second round.
			std::thread([gen]() {
				std::this_thread::sleep_for(std::chrono::seconds(4));
				SKSE::GetTaskInterface()->AddTask([gen]() {
					if (g_gen.load() == gen && g_awaitingGo) {
						logger::warn("auto-portrait: the view never said go - standing down");
						++g_gen;
						Finish({}, "view did not answer");
					}
				});
			}).detach();
		}

		void Go()
		{
			if (!g_busy || !g_awaitingGo || g_shots.empty())
				return;
			g_awaitingGo = false;
			const auto gen = g_gen.load();
			if (PersonLive::Active()) {
				// The person page's live view holds the camera; never take it over.
				++g_gen;
				Finish({}, "the live view is using the camera");
				return;
			}
			auto first = g_shots.front().actor.get();
			PersonLive::SetFocusHooks(g_hooks.enterLiveFocus, g_hooks.restoreFocus);
			PortraitCapture::HideHud(true);
			if (g_hooks.hudViewHidden)
				g_hooks.hudViewHidden(true);
			const auto reply = json::parse(PersonLive::StartFace(first.get()), nullptr, false);
			if (reply.is_discarded() || !reply.value("ok", false)) {
				const std::string why = reply.is_discarded() ? "the camera could not be taken" : reply.value("why", std::string("the camera could not be taken"));
				std::vector<Result> results;
				for (const auto& s : g_shots)
					results.push_back(Result{ s.slug, s.name, "", why, s.formId, s.sig, false });
				++g_gen;
				Finish(results, "refused");
				return;
			}
			std::thread(Worker, g_shots, gen).detach();
			// Hard ceiling: two subjects at the settle cap each is ~4 s; never
			// leave the camera taken longer than this, whatever happens.
			std::thread([gen]() {
				std::this_thread::sleep_for(std::chrono::seconds(10));
				SKSE::GetTaskInterface()->AddTask([gen]() {
					if (g_gen.load() == gen && g_busy) {
						logger::warn("auto-portrait: watchdog - restoring after 10 s");
						++g_gen;
						Finish({}, "timeout");
					}
				});
			}).detach();
		}
	}

	void Init(Hooks hooks) { g_hooks = std::move(hooks); }

	std::set<std::string> AutoFiles(const std::filesystem::path& dir)
	{
		// Marker: user-photo-beats-auto.
		std::set<std::string> out;
		std::ifstream in(dir / "auto-portraits.json", std::ios::binary);
		if (!in)
			return out;
		const auto side = json::parse(in, nullptr, false);
		if (side.is_discarded() || !side.is_object() || !side.contains("people") || !side["people"].is_object())
			return out;
		const auto lower = [](std::string v) {
			std::transform(v.begin(), v.end(), v.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return v;
		};
		for (const auto& [slug, p] : side["people"].items()) {
			if (!p.is_object())
				continue;
			if (p.contains("file") && p["file"].is_string())
				out.insert(lower(p["file"].get<std::string>()));
			if (p.contains("files") && p["files"].is_array())
				for (const auto& f : p["files"])
					if (f.is_string())
						out.insert(lower(f.get<std::string>()));
		}
		return out;
	}

	bool Busy() { return g_busy; }

	void Abort(const char* why)
	{
		if (!g_busy)
			return;
		++g_gen;   // the worker sees this and stops without touching anything
		Finish({}, why ? why : "aborted");
	}

	void OnMessage(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const std::string op = j.value("op", std::string());
		if (op == "consider") {
			Consider(j);
		} else if (op == "go") {
			Go();
		} else if (op == "set") {
			auto side = ReadSidecar();
			side["enabled"] = j.value("enabled", true);
			WriteSidecar(side);
			Push("fdAutoPhotoState", json{ { "enabled", side["enabled"] } });
			logger::info("auto-portrait: {}", side["enabled"].get<bool>() ? "enabled" : "disabled");
		} else if (op == "state") {
			Push("fdAutoPhotoState", json{ { "enabled", Enabled() } });
		}
	}
}
