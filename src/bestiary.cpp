#include "bestiary.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp and logger.

#include "actor_identity.h"
#include "container_actions.h"
#include "npc_actions.h"
#include "item_icons.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <exception>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <thread>
#include <type_traits>
#include <unordered_map>
#include <vector>

#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")
#undef GetObject
#undef PlaySound
#undef min
#undef max

namespace Bestiary
{
	namespace
	{
		using json = nlohmann::json;

		std::mutex g_m;
		bool       g_loaded = false;
		json       g_db     = json::object();   // {version, scribe, entries:{id:{…}}, latest}
		PushFn     g_push;
		std::set<std::string> g_loreAsked;      // ids with a request queued or out right now

		// rev: bumped on every write to g_db (kill, study, edit, lore, a render
		// landing) and when the player's own fighting state changes, so the view
		// can skip redrawing a book that did not change. Under g_m.
		std::int64_t g_rev = 1;
		// The debounced save (2026-10-10: a kill wrote the whole file at once on
		// the main thread). Under g_m.
		bool         g_dirty     = false;
		bool         g_saveArmed = false;
		bool         g_bakDone   = false;   // the .bak is the file as the session FOUND it
		std::uint64_t g_saveSeq  = 0;
		std::mutex    g_writeM;              // the file writer (a worker), never with g_m held
		std::uint64_t g_writtenSeq = 0;

		constexpr const char* kIni      = "Data/SKSE/Plugins/SkyManager.ini";
		constexpr const char* kIniSect  = "Bestiary";
		constexpr const char* kIniKey   = "sOpenRouterKey";
		constexpr std::size_t kLogCap   = 12;

		std::filesystem::path FilePath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "bestiary.json";
		}

		void Push(const char* fn, const std::string& payload)
		{
			if (g_push)
				g_push(fn, payload);
		}

		/* ------------------------------------------------------ robustness -- */
		// Every entry point the view or an engine event can reach runs inside
		// Guarded: a malformed bestiary.json, a hand-edited value of the wrong
		// type or a json type_error must cost one answer and a log line, never
		// the game (the 2026-10-09 CTD was a json::value() on a null slot).
		// "bestiary: guarded" is the hd-markers.json fingerprint (logged by Install).
		template <class F>
		auto Guarded(const char* what, F&& f) -> decltype(f())
		{
			using R = decltype(f());
			try {
				return f();
			} catch (const std::exception& ex) {
				logger::error("bestiary: {} failed: {}", what, ex.what());
			} catch (...) {
				logger::error("bestiary: {} failed: unknown exception", what);
			}
			if constexpr (std::is_void_v<R>)
				return;
			else
				return R{};
		}

		// Typed reads that never throw: the file and the view are both outside
		// our control, and json::value() throws on a present-but-wrong type.
		int NumOr(const json& j, const char* k, int def)
		{
			if (!j.is_object())
				return def;
			const auto it = j.find(k);
			if (it == j.end())
				return def;
			if (it->is_number_integer())
				return static_cast<int>(std::clamp<std::int64_t>(it->get<std::int64_t>(), -2147483647LL, 2147483647LL));
			if (it->is_number_float()) {
				const double d = it->get<double>();
				if (std::isfinite(d))
					return static_cast<int>(std::clamp(d, -2.0e9, 2.0e9));
			}
			return def;
		}
		double DblOr(const json& j, const char* k, double def)
		{
			if (!j.is_object())
				return def;
			const auto it = j.find(k);
			if (it == j.end() || !it->is_number())
				return def;
			const double d = it->get<double>();
			return std::isfinite(d) ? d : def;
		}
		bool BoolOr(const json& j, const char* k, bool def)
		{
			if (!j.is_object())
				return def;
			const auto it = j.find(k);
			return (it != j.end() && it->is_boolean()) ? it->get<bool>() : def;
		}
		std::string StrOr(const json& j, const char* k, const std::string& def = {})
		{
			if (!j.is_object())
				return def;
			const auto it = j.find(k);
			return (it != j.end() && it->is_string()) ? it->get<std::string>() : def;
		}
		const json& ObjOr(const json& j, const char* k)
		{
			static const json kEmpty = json::object();
			if (!j.is_object())
				return kEmpty;
			const auto it = j.find(k);
			return (it != j.end() && it->is_object()) ? *it : kEmpty;
		}
		const json& ArrOr(const json& j, const char* k)
		{
			static const json kEmpty = json::array();
			if (!j.is_object())
				return kEmpty;
			const auto it = j.find(k);
			return (it != j.end() && it->is_array()) ? *it : kEmpty;
		}

		/* ------------------------------------------------------------ store -- */
		void LoadLocked()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(FilePath(), std::ios::binary);
			if (in.is_open()) {
				auto j = json::parse(in, nullptr, false);
				if (!j.is_discarded() && j.is_object())
					g_db = std::move(j);
				else
					logger::warn("bestiary: bestiary.json did not parse - starting an empty book (the file is left as it was until the next kill)");
			}
			if (!g_db.contains("entries") || !g_db["entries"].is_object())
				g_db["entries"] = json::object();
			if (!g_db.contains("scribe") || !g_db["scribe"].is_object())
				g_db["scribe"] = json::object();
			if (g_db.contains("lessons") && !g_db["lessons"].is_array())
				g_db.erase("lessons");
			g_db["version"] = 1;
			// Quarantine: a page that is not an object cannot be drawn, and every
			// reader below assumes one. Log it and leave it out of this session
			// (the file keeps it until the next save writes the book back).
			auto& all = g_db["entries"];
			std::vector<std::string> bad;
			for (auto it = all.begin(); it != all.end(); ++it)
				if (!it.value().is_object())
					bad.push_back(it.key());
			for (const auto& k : bad) {
				logger::warn("bestiary: page '{}' is not an object ({}) - quarantined", k, all[k].type_name());
				all.erase(k);
			}
			// A Scribe request does not survive a restart: a page saved mid-write
			// goes back to what it was, never stays "writing" forever.
			for (auto it = all.begin(); it != all.end(); ++it) {
				auto& e = it.value();
				if (!e.contains("lore") || !e["lore"].is_object())
					continue;
				auto& lo = e["lore"];
				const bool hasText = lo.contains("text") && lo["text"].is_array() && !lo["text"].empty();
				if (StrOr(lo, "state") == "writing" || lo.contains("pending")) {
					lo.erase("pending");
					if (hasText)
						lo["state"] = "done";
					else {
						lo["state"]     = "none";
						lo["lastError"] = "interrupted when the game closed";
					}
				}
			}
			logger::info("bestiary: book loaded, {} kind(s)", all.size());
		}

		// Serialise under g_m (cheap), write on a worker (the disk is not the
		// game frame's business). Each write carries a sequence number so an
		// older snapshot can never land over a newer one.
		void WriteNowLocked()
		{
			std::string text;
			try {
				text = g_db.dump(-1, ' ', false, json::error_handler_t::replace);
			} catch (...) {
				logger::error("bestiary: serialise failed - bestiary.json NOT written");
				return;
			}
			g_dirty          = false;
			const auto seq   = ++g_saveSeq;
			const bool bak   = !g_bakDone;
			g_bakDone        = true;
			std::thread([text = std::move(text), seq, bak]() {
				std::lock_guard w(g_writeM);
				if (seq < g_writtenSeq)
					return;
				const auto      path = FilePath();
				std::error_code ec;
				std::filesystem::create_directories(path.parent_path(), ec);
				if (bak && std::filesystem::exists(path, ec)) {
					auto b = path;
					b.replace_extension(".bak");
					std::filesystem::copy_file(path, b, std::filesystem::copy_options::overwrite_existing, ec);
				}
				auto tmp = path;
				tmp += ".tmp";
				{
					std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
					if (!out.is_open()) {
						logger::error("bestiary: could not open {} for write", PathU8(tmp));
						return;
					}
					out << text;
				}
				std::filesystem::rename(tmp, path, ec);
				if (ec)
					logger::error("bestiary: atomic replace failed: {}", ec.message());
				g_writtenSeq = seq;
			}).detach();
		}

		void SaveIfDirty()
		{
			std::lock_guard l(g_m);
			g_saveArmed = false;
			if (g_dirty)
				WriteNowLocked();
		}

		// Every write to the book: bump rev, mark dirty, and arm ONE timer that
		// writes the file two seconds later (a fight that kills five wolves is
		// one write, not five). kSaveGame and the deck's close flush at once.
		void SaveLocked()
		{
			++g_rev;
			g_dirty = true;
			if (g_saveArmed)
				return;
			g_saveArmed = true;
			std::thread([]() {
				std::this_thread::sleep_for(std::chrono::seconds(2));
				if (auto* ti = SKSE::GetTaskInterface())
					ti->AddTask([]() { Guarded("save", []() { SaveIfDirty(); }); });
			}).detach();
		}
		// A picture the reader picked (a chapter's icon, a page's own art): only a
		// view-relative path inside the view's own icons/ tree - never "..", an
		// absolute path, a drive, a scheme or a query - the same rule app.js
		// hkIconSrc applies to hotkey icons. Anything else is dropped.
		bool SafePicture(const std::string& p)
		{
			if (p.empty() || p.size() > 300 || p.rfind("icons/", 0) != 0)
				return false;
			if (p.find("..") != std::string::npos || p.find(':') != std::string::npos || p.find('?') != std::string::npos ||
				p.find('\\') != std::string::npos || p.find('"') != std::string::npos || p.find('<') != std::string::npos)
				return false;
			return true;
		}

		/* -------------------------------------------------------- ini (key) -- */
		// The key lives only in SkyManager.ini [Bestiary] sOpenRouterKey. Section-
		// aware read and an in-place rewrite that keeps every other line as it was.
		std::string Trim(std::string s)
		{
			const auto a = s.find_first_not_of(" \t\r\n");
			if (a == std::string::npos)
				return {};
			const auto b = s.find_last_not_of(" \t\r\n");
			return s.substr(a, b - a + 1);
		}
		// At most n BYTES, never splitting a UTF-8 sequence: a cut through an em
		// dash leaves an invalid byte that a strict json::dump() throws on.
		std::string Utf8Cut(const std::string& s, std::size_t n)
		{
			if (s.size() <= n)
				return s;
			while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80)
				--n;
			return s.substr(0, n);
		}
		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string ReadKey()
		{
			std::ifstream in(kIni, std::ios::binary);
			if (!in.is_open())
				return {};
			std::string line, sect;
			while (std::getline(in, line)) {
				auto t = Trim(line);
				if (t.empty() || t[0] == ';' || t[0] == '#')
					continue;
				if (t.front() == '[' && t.back() == ']') {
					sect = Lower(Trim(t.substr(1, t.size() - 2)));
					continue;
				}
				if (sect != Lower(kIniSect))
					continue;
				const auto eq = t.find('=');
				if (eq == std::string::npos)
					continue;
				if (Lower(Trim(t.substr(0, eq))) == Lower(kIniKey))
					return Trim(t.substr(eq + 1));
			}
			return {};
		}

		bool WriteKey(const std::string& key)   // "" removes the line
		{
			std::vector<std::string> lines;
			{
				std::ifstream in(kIni, std::ios::binary);
				std::string   line;
				while (in.is_open() && std::getline(in, line)) {
					if (!line.empty() && line.back() == '\r')
						line.pop_back();
					lines.push_back(line);
				}
			}
			std::string sect;
			int         sectAt = -1, keyAt = -1;
			for (int i = 0; i < static_cast<int>(lines.size()); ++i) {
				auto t = Trim(lines[i]);
				if (!t.empty() && t.front() == '[' && t.back() == ']') {
					sect = Lower(Trim(t.substr(1, t.size() - 2)));
					if (sect == Lower(kIniSect))
						sectAt = i;
					continue;
				}
				if (sect == Lower(kIniSect)) {
					const auto eq = t.find('=');
					if (eq != std::string::npos && Lower(Trim(t.substr(0, eq))) == Lower(kIniKey))
						keyAt = i;
				}
			}
			const std::string kv = std::string(kIniKey) + "=" + key;
			if (keyAt >= 0) {
				if (key.empty())
					lines.erase(lines.begin() + keyAt);
				else
					lines[keyAt] = kv;
			} else if (!key.empty()) {
				if (sectAt < 0) {
					if (!lines.empty() && !Trim(lines.back()).empty())
						lines.push_back("");
					lines.push_back(std::string("[") + kIniSect + "]");
					lines.push_back("; The Bestiary's Scribe: your OpenRouter key, set from the book's Scribe page. Sent only to openrouter.ai.");
					lines.push_back(kv);
				} else
					lines.insert(lines.begin() + sectAt + 1, kv);
			}
			std::error_code       ec;
			std::filesystem::path path(kIni), tmp(kIni);
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
				if (!out.is_open())
					return false;
				for (const auto& l : lines)
					out << l << "\r\n";
			}
			std::filesystem::rename(tmp, path, ec);
			return !ec;
		}

		std::string Masked(const std::string& key)
		{
			if (key.size() < 12)
				return key.empty() ? "" : "\xE2\x80\xA6";
			return key.substr(0, 9) + "\xE2\x80\xA6" + key.substr(key.size() - 4);
		}

		/* ------------------------------------------------------------ https -- */
		struct HttpResult
		{
			bool        ok = false;
			DWORD       status = 0;
			std::string body;
			std::string error;
		};
		struct Handle
		{
			HINTERNET h = nullptr;
			explicit Handle(HINTERNET x) : h(x) {}
			~Handle()
			{
				if (h)
					WinHttpCloseHandle(h);
			}
		};
		std::wstring Widen(const std::string& s)
		{
			if (s.empty())
				return {};
			const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
			std::wstring w(static_cast<std::size_t>(n), L'\0');
			MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
			return w;
		}

		// One HTTPS round trip to openrouter.ai. Worker threads only (it blocks).
		HttpResult OpenRouter(const wchar_t* method, const std::wstring& path, const std::string& key,
			const std::string& body, int timeoutMs)
		{
			HttpResult r;
			Handle     session(WinHttpOpen(L"SkyManager-Bestiary/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
					WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
			if (!session.h) {
				r.error = "Could not start a web session.";
				return r;
			}
			WinHttpSetTimeouts(session.h, 8000, 8000, timeoutMs, timeoutMs);
			Handle conn(WinHttpConnect(session.h, L"openrouter.ai", INTERNET_DEFAULT_HTTPS_PORT, 0));
			if (!conn.h) {
				r.error = "Could not reach openrouter.ai.";
				return r;
			}
			Handle req(WinHttpOpenRequest(conn.h, method, path.c_str(), nullptr, WINHTTP_NO_REFERER,
				WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
			if (!req.h) {
				r.error = "Could not open the request.";
				return r;
			}
			std::wstring headers = L"Authorization: Bearer " + Widen(key) +
			                       L"\r\nHTTP-Referer: https://www.nexusmods.com/skyrimspecialedition\r\nX-Title: SkyManager Bestiary\r\n";
			if (!body.empty())
				headers += L"Content-Type: application/json\r\n";
			const BOOL sent = WinHttpSendRequest(req.h, headers.c_str(), static_cast<DWORD>(-1L),
				body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
				static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0);
			if (!sent || !WinHttpReceiveResponse(req.h, nullptr)) {
				r.error = "No answer from openrouter.ai (" + std::to_string(GetLastError()) + ").";
				return r;
			}
			DWORD status = 0, len = sizeof(status);
			WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
				WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
			r.status = status;
			for (;;) {
				DWORD avail = 0;
				if (!WinHttpQueryDataAvailable(req.h, &avail) || avail == 0)
					break;
				std::string chunk(avail, '\0');
				DWORD       read = 0;
				if (!WinHttpReadData(req.h, chunk.data(), avail, &read) || read == 0)
					break;
				r.body.append(chunk.data(), read);
				if (r.body.size() > (2u << 20))
					break;
			}
			r.ok = status >= 200 && status < 300;
			if (!r.ok) {
				if (status == 401)
					r.error = "OpenRouter refused the key (401). Check it at openrouter.ai/keys.";
				else if (status == 402)
					r.error = "OpenRouter answered 402: the account is out of credit. Nothing was spent.";
				else if (status == 429)
					r.error = "OpenRouter is rate-limiting this key (429). Try again in a minute.";
				else {
					auto j = json::parse(r.body, nullptr, false);
					std::string msg;
					if (!j.is_discarded() && j.contains("error") && j["error"].is_object())
						msg = StrOr(j["error"], "message");
					r.error = "OpenRouter answered " + std::to_string(status) + (msg.empty() ? "." : ": " + msg);
				}
			}
			return r;
		}

		/* -------------------------------------------------------- measuring -- */
		std::string Name(const RE::TESForm* f)
		{
			if (!f)
				return {};
			if (const auto* fn = f->As<RE::TESFullName>(); fn) {
				if (const char* n = fn->GetFullName(); n && *n)
					return n;
			}
			return {};
		}
		std::string EditorId(const RE::TESForm* f)
		{
			if (!f)
				return {};
			const char* e = f->GetFormEditorID();
			return (e && *e) ? e : std::string();
		}
		std::string PluginOf(const RE::TESForm* f)
		{
			if (!f)
				return {};
			if (const auto* file = f->GetFile(0); file)
				return std::string(file->GetFilename());
			return {};
		}
		std::string Slug(const std::string& s)
		{
			std::string o;
			for (unsigned char c : s) {
				if (std::isalnum(c))
					o += static_cast<char>(std::tolower(c));
				else if (!o.empty() && o.back() != '-')
					o += '-';
			}
			while (!o.empty() && o.back() == '-')
				o.pop_back();
			return o.empty() ? "kind" : o;
		}
		std::string Hash6(const std::string& s)
		{
			std::uint32_t h = 2166136261u;
			for (unsigned char c : s) {
				h ^= c;
				h *= 16777619u;
			}
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%06x", h & 0xFFFFFF);
			return buf;
		}

		// The chapter, off the engine's own actor-type keywords (the same table
		// npc_inspect.cpp reads), most specific first. A keyword a load order does
		// not define simply never matches.
		template <class T>
		std::string ChapterOf(T* f)
		{
			if (!f)
				return "unknown";
			if (f->HasKeywordString("ActorTypeDragon"))  return "dragon";
			if (f->HasKeywordString("ActorTypeDaedra"))  return "daedra";
			if (f->HasKeywordString("ActorTypeUndead"))  return "undead";
			if (f->HasKeywordString("ActorTypeDwarven")) return "dwarven";
			if (f->HasKeywordString("ActorTypeGiant"))   return "giant";
			if (f->HasKeywordString("ActorTypeFalmer"))  return "falmer";
			if (f->HasKeywordString("ActorTypeAnimal"))  return "beast";
			if (f->HasKeywordString("ActorTypeNPC"))     return "folk";
			if (f->HasKeywordString("ActorTypeCreature")) return "monster";
			return "unknown";
		}

		// The body mesh MRF renders — the same walk as mounts.cpp BodyNifOf
		// (npc skin, then race skin, then far skin), and the SKIN record it came
		// from, whose durable identity keys the render file (a leveled spawn's
		// base is a dynamic form; its skin is a real record).
		bool SkinOf(RE::TESNPC* npc, RE::TESRace* race, std::string& nif, const RE::TESObjectARMO*& skin)
		{
			if (!npc || !race)
				return false;
			const int sex = npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kFemale) ? 1 : 0;
			auto fromArmor = [&](RE::TESObjectARMO* armo) -> std::string {
				if (!armo)
					return {};
				if (auto* arma = armo->GetArmorAddon(race)) {
					if (const char* m = arma->bipedModels[sex].GetModel(); m && *m)
						return m;
					if (const char* m = arma->bipedModels[sex ? 0 : 1].GetModel(); m && *m)
						return m;
				}
				for (auto* ad : armo->armorAddons) {
					if (!ad)
						continue;
					for (const auto& bm : ad->bipedModels)
						if (const char* m = bm.GetModel(); m && *m)
							return m;
				}
				return {};
			};
			for (auto* armo : { npc->skin, race->skin, npc->farSkin }) {
				if (auto s = fromArmor(armo); !s.empty()) {
					nif  = s;
					skin = armo;
					return true;
				}
			}
			return false;
		}

		std::string Today()
		{
			auto* cal = RE::Calendar::GetSingleton();
			if (!cal)
				return {};
			const int day = static_cast<int>(cal->GetDay());
			return std::to_string(day) + " " + cal->GetMonthName() + " 4E " + std::to_string(cal->GetYear());
		}

		// Where it fell: the hold (a location carrying LocTypeHold, walked up the
		// parents) and the place's own name. Holds are matched by their names.
		void PlaceOf(RE::Actor* a, std::string& holdId, std::string& holdName, std::string& place)
		{
			holdId = "other";
			auto* loc = a->GetCurrentLocation();
			if (loc)
				place = Name(loc);
			for (auto* l = loc; l; l = l->parentLoc) {
				if (l->HasKeywordString("LocTypeHold")) {
					holdName = Name(l);
					break;
				}
			}
			std::string where = holdName;
			if (where.empty()) {
				if (auto* ws = a->GetWorldspace())
					where = Name(ws);
				holdName = where;
			}
			const auto w = Lower(where);
			static const std::pair<const char*, const char*> kHolds[] = {
				{ "whiterun", "whiterun" }, { "eastmarch", "eastmarch" }, { "haafingar", "haafingar" },
				{ "rift", "rift" }, { "reach", "reach" }, { "falkreath", "falkreath" },
				{ "hjaalmarch", "hjaalmarch" }, { "pale", "pale" }, { "winterhold", "winterhold" },
				{ "solstheim", "solstheim" }
			};
			for (const auto& [needle, id] : kHolds)
				if (w.find(needle) != std::string::npos) {
					holdId = id;
					break;
				}
			if (holdName.empty())
				holdName = "Unknown lands";
			if (place.empty()) {
				if (auto* cell = a->GetParentCell())
					place = Name(cell);
			}
		}

		std::string WieldedBy(RE::Actor* who)
		{
			if (!who)
				return {};
			for (bool left : { false, true }) {
				if (auto* obj = who->GetEquippedObject(left)) {
					if (auto n = Name(obj); !n.empty())
						return n;
				}
			}
			return "bare hands";
		}


		// The page id for an actor, exactly as the book files it: the display
		// name (else the race's), and the race EditorID (else its durable id).
		// Pure - no g_db - so the F7 peek and the fight tracker share it.
		std::string KindIdOf(RE::Actor* a, std::string* outName = nullptr, std::string* outRaceKey = nullptr)
		{
			auto* race = a ? a->GetRace() : nullptr;
			if (!race)
				return {};
			std::string name = a->GetDisplayFullName() ? a->GetDisplayFullName() : "";
			if (name.empty())
				name = Name(race);
			if (name.empty())
				return {};
			const std::string raceEid = EditorId(race);
			std::string       rfid, rplug;
			ActorIdentity::DurableOf(race, rfid, rplug);
			const std::string raceKey = raceEid.empty() ? rfid + "|" + rplug : raceEid;
			if (outName)
				*outName = name;
			if (outRaceKey)
				*outRaceKey = raceKey;
			return Slug(name) + "-" + Hash6(raceKey);
		}

		// The record the creature was MADE from. A leveled spawn's base is a
		// dynamic form (0xFF……) with no plugin; the leveled-creature extra names
		// the real NPC_ it was rolled from, and a templated NPC_ chain ends at
		// one. That root owns the plugin, the skin and the Unique flag.
		RE::TESNPC* RootBase(RE::Actor* a)
		{
			auto* npc = a ? a->GetActorBase() : nullptr;
			auto  real = [](RE::TESActorBase* b) -> RE::TESNPC* {
                auto* n = b ? b->As<RE::TESNPC>() : nullptr;
                return (n && !n->IsDynamicForm()) ? n : nullptr;
			};
			if (a) {
				if (auto* xl = a->extraList.GetByType<RE::ExtraLeveledCreature>()) {
					if (auto* n = real(xl->templateBase))
						return n;
					if (auto* n = real(xl->originalBase))
						return n;
				}
			}
			auto* cur = npc;
			for (int hop = 0; cur && cur->IsDynamicForm() && hop < 16; ++hop) {
				auto* next = cur->baseTemplateForm ? cur->baseTemplateForm->As<RE::TESNPC>() : nullptr;
				if (!next || next == cur)
					break;
				cur = next;
			}
			return cur ? cur : npc;
		}

		// The family: the folder its skeleton lives in (Actors\Troll\…,
		// Actors\DLC01\…), so a Frost Troll and an Armored Troll share one even
		// though they are separate races. Humanoids live in Actors\Character and
		// get no family (the view falls back to the race).
		std::string Prettify(const std::string& raw)
		{
			static const std::pair<const char*, const char*> kKnown[] = {
				{ "frostbitespider", "Frostbite Spider" }, { "dwarvenspider", "Dwarven Spider" },
				{ "dwarvensteamcenturion", "Dwarven Centurion" }, { "dwarvensphere", "Dwarven Sphere" },
				{ "dwarvenspherecenturion", "Dwarven Sphere" }, { "dwarvenballistacenturion", "Dwarven Ballista" },
				{ "sabrecat", "Sabre Cat" }, { "mudcrab", "Mudcrab" }, { "icewraith", "Ice Wraith" },
				{ "chaurusflyer", "Chaurus Hunter" }, { "dragonpriest", "Dragon Priest" }, { "wisp", "Wispmother" },
				{ "witchlight", "Witchlight" }, { "atronachfrost", "Frost Atronach" }, { "atronachflame", "Flame Atronach" },
				{ "atronachstorm", "Storm Atronach" }, { "werewolfbeast", "Werewolf" }, { "vampirelord", "Vampire Lord" },
				{ "slaughterfish", "Slaughterfish" }, { "hagraven", "Hagraven" }, { "spriggan", "Spriggan" },
				{ "skeever", "Skeever" }, { "horker", "Horker" }, { "mammoth", "Mammoth" }, { "chaurus", "Chaurus" },
				{ "draugr", "Draugr" }, { "canine", "Canine" }, { "netch", "Netch" }, { "riekling", "Riekling" },
				{ "benthiclurker", "Lurker" }, { "seeker", "Seeker" }, { "ashhopper", "Ash Hopper" },
				{ "scrib", "Scrib" }, { "burntspriggan", "Burnt Spriggan" }, { "boarriekling", "Bristleback" },
				{ "gargoyle", "Gargoyle" }, { "deathhound", "Death Hound" }, { "chaurushunter", "Chaurus Hunter" },
				{ "falmer", "Falmer" }, { "giant", "Giant" }, { "troll", "Troll" }, { "dragon", "Dragon" },
				{ "bear", "Bear" }, { "deer", "Deer" }, { "elk", "Elk" }, { "goat", "Goat" }, { "cow", "Cow" },
				{ "horse", "Horse" }, { "wolf", "Wolf" }, { "fox", "Fox" }, { "hare", "Hare" }, { "mudcrab01", "Mudcrab" },
			};
			const auto low = Lower(raw);
			for (const auto& [k, v] : kKnown)
				if (low == k)
					return v;
			// split on underscores and case: "AshSpawn" / "ash_spawn" -> "Ash Spawn"
			std::string out;
			bool        up = true;
			for (std::size_t i = 0; i < raw.size(); ++i) {
				const unsigned char c = static_cast<unsigned char>(raw[i]);
				if (c == '_' || c == '-' || c == ' ') {
					if (!out.empty() && out.back() != ' ')
						out += ' ';
					up = true;
					continue;
				}
				if (i > 0 && std::isupper(c) && std::islower(static_cast<unsigned char>(raw[i - 1])) && !out.empty() && out.back() != ' ')
					out += ' ';
				out += up ? static_cast<char>(std::toupper(c)) : static_cast<char>(c);
				up = false;
			}
			while (!out.empty() && out.back() == ' ')
				out.pop_back();
			return out;
		}
		std::string FamilyOf(RE::TESRace* race)
		{
			if (!race)
				return {};
			std::string path;
			for (int sex = 0; sex < 2 && path.empty(); ++sex)
				if (const char* m = race->skeletonModels[sex].GetModel(); m && *m)
					path = m;
			for (int sex = 0; sex < 2 && path.empty(); ++sex)
				if (const char* m = race->behaviorGraphs[sex].GetModel(); m && *m)
					path = m;
			if (path.empty())
				return {};
			std::vector<std::string> segs;
			{
				std::string cur;
				for (char c : path) {
					if (c == '\\' || c == '/') {
						if (!cur.empty())
							segs.push_back(cur);
						cur.clear();
					} else
						cur += c;
				}
				if (!cur.empty())
					segs.push_back(cur);
			}
			for (std::size_t i = 0; i + 1 < segs.size(); ++i) {
				if (Lower(segs[i]) != "actors")
					continue;
				std::size_t j = i + 1;
				// DLC and ambient folders are containers, not families
				while (j + 1 < segs.size()) {
					const auto l = Lower(segs[j]);
					if (l == "dlc01" || l == "dlc02" || l == "ambient" || l == "dlc1" || l == "dlc2")
						++j;
					else
						break;
				}
				if (j + 1 >= segs.size())   // the next segment is the file itself
					return {};
				const auto fam = Lower(segs[j]);
				if (fam == "character" || fam == "characters")
					return {};
				return Prettify(segs[j]);
			}
			return {};
		}

		// The race's own movement record: the forward run speed of its Run type
		// (the Walk type when a race has no Run), times its SpeedMult.
		float RunSpeed(RE::Actor* a, bool sprint)
		{
			auto* race = a ? a->GetRace() : nullptr;
			if (!race)
				return 0.0f;
			using MT = RE::TESRace::MovementTypes;
			using MS = RE::Movement::MaxSpeeds;
			RE::BGSMovementType* mt = sprint ? race->baseMoveTypes[MT::kSprint] : nullptr;
			if (!mt)
				mt = race->baseMoveTypes[MT::kRun];
			if (!mt)
				mt = race->baseMoveTypes[MT::kWalk];
			if (!mt)
				return 0.0f;
			const float base = mt->movementTypeData.defaultData.speeds[RE::Movement::SPEED_DIRECTIONS::kForward][MS::kRun];
			const float mult = a->AsActorValueOwner()->GetPermanentActorValue(RE::ActorValue::kSpeedMult);
			return base * (mult > 0.0f ? mult : 100.0f) / 100.0f;
		}

		const char* ElementOf(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kResistFire:    return "fire";
			case AV::kResistFrost:   return "frost";
			case AV::kResistShock:   return "shock";
			case AV::kPoisonResist:  return "poison";
			case AV::kResistMagic:   return "magic";
			case AV::kResistDisease: return "disease";
			default:                 return "";
			}
		}

		bool Shown(const RE::EffectSetting* b)
		{
			return b && !b->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI);
		}

		// A spell aimed at YOU: at least one effect the game shows and marks hostile.
		const RE::EffectSetting* HostileEffect(const RE::MagicItem* sp)
		{
			if (!sp)
				return nullptr;
			for (auto* fx : sp->effects)
				if (fx && fx->baseEffect && Shown(fx->baseEffect) && fx->baseEffect->IsHostile())
					return fx->baseEffect;
			return nullptr;
		}

		// "attackPowerStartForward" -> "Power Forward"; "bashStart" -> "Bash".
		std::string AttackName(const std::string& ev)
		{
			std::string s = ev;
			for (const char* cut : { "attack", "Attack", "Start", "start" }) {
				for (auto p = s.find(cut); p != std::string::npos; p = s.find(cut))
					s.erase(p, std::strlen(cut));
			}
			auto n = Prettify(s);
			return n.empty() ? std::string("Strike") : n;
		}

		bool WordUsable(const RE::TESWordOfPower* w)
		{
			using RF = RE::TESForm::RecordFlags;
			return w && (w->GetFormFlags() & RF::kKnown) && (w->GetFormFlags() & RF::kUnlocked);
		}

		float GameSetting(const char* name, float def)
		{
			auto* gs = RE::GameSettingCollection::GetSingleton();
			auto* s  = gs ? gs->GetSetting(name) : nullptr;
			return s ? s->GetFloat() : def;
		}

		/* ------------------------------------------- what works on it -- */
		// Promised item 9 (Rober, 2026-10-10: five tiles said "Not read yet").
		// Nothing here is a vanilla table: for each family the book finds a REAL
		// spell by archetype - the player's own first, else the strongest one the
		// load order has - and asks the ENGINE the two questions that decide it:
		// do its effect conditions pass on this creature (subject = the creature,
		// target = the caster, which is how a magic effect's CTDA runs), and how
		// big is it once the player's perks have had their say (kModSpellMagnitude
		// through BGSEntryPoint, so Animage, Kindred Mage and any modded perk are
		// the engine's arithmetic, never ours).
		struct AffAnswer
		{
			std::string s, spell, plugin, perk, why;
			int         cap = -1, dual = -1, lvl = -1, pct = -1;
			bool        known = false;

			json ToJson() const
			{
				json o{ { "s", s } };
				if (cap >= 0)
					o["cap"] = cap;
				if (dual >= 0)
					o["dual"] = dual;
				if (lvl >= 0)
					o["lvl"] = lvl;
				if (pct >= 0)
					o["pct"] = pct;
				if (!spell.empty())
					o["spell"] = spell;
				if (!plugin.empty())
					o["plugin"] = plugin;
				if (known)
					o["known"] = true;
				if (!perk.empty())
					o["perk"] = perk;
				if (!why.empty())
					o["why"] = why;
				return o;
			}
		};

		using Arch = RE::EffectArchetype;

		struct SpellRead
		{
			bool         any  = false;   // the spell has an effect of this archetype
			bool         pass = false;   // ...and its conditions take this creature
			float        raw  = 0.0f;    // magnitude as authored
			float        mag  = 0.0f;    // after the player's perks
			RE::BGSPerk* needPerk = nullptr;   // a failing effect gated on a perk you lack
		};

		// A condition item that requires the caster (or subject) to HAVE a perk.
		RE::BGSPerk* PerkGate(const RE::TESCondition& c, RE::PlayerCharacter* pc)
		{
			for (auto* it = c.head; it; it = it->next) {
				const auto& d = it->data;
				if (d.functionData.function.get() != RE::FUNCTION_DATA::FunctionID::kHasPerk || d.flags.global)
					continue;
				auto*       perk = static_cast<RE::BGSPerk*>(d.functionData.params[0]);
				const float v    = d.comparisonValue.f;
				using Op         = RE::CONDITION_ITEM_DATA::OpCode;
				const auto  op   = d.flags.opCode;
				const bool  wantsIt = (op == Op::kEqualTo && v >= 1.0f) || (op == Op::kNotEqualTo && v == 0.0f) ||
				                     (op == Op::kGreaterThanOrEqualTo && v >= 1.0f) || (op == Op::kGreaterThan && v < 1.0f && v >= 0.0f);
				if (perk && wantsIt && !pc->HasPerk(perk))
					return perk;
			}
			return nullptr;
		}

		SpellRead ReadSpell(RE::SpellItem* sp, Arch arch, RE::Actor* a, RE::PlayerCharacter* pc)
		{
			SpellRead r;
			if (!sp)
				return r;
			for (auto* fx : sp->effects) {
				if (!fx || !fx->baseEffect || fx->baseEffect->GetArchetype() != arch)
					continue;
				r.any         = true;
				const bool ok = fx->conditions.IsTrue(a, pc) && fx->baseEffect->conditions.IsTrue(a, pc);
				const float raw = fx->GetMagnitude();
				float       mag = raw;
				RE::BGSEntryPoint::HandleEntryPoint(RE::BGSEntryPoint::ENTRY_POINT::kModSpellMagnitude, pc, sp, a, &mag);
				if (ok && (!r.pass || mag > r.mag)) {
					r.pass = true;
					r.raw  = raw;
					r.mag  = mag;
				} else if (!r.pass && mag > r.mag) {
					r.raw = raw;
					r.mag = mag;
				}
				if (!ok && !r.needPerk) {
					r.needPerk = PerkGate(fx->conditions, pc);
					if (!r.needPerk)
						r.needPerk = PerkGate(fx->baseEffect->conditions, pc);
				}
			}
			return r;
		}

		// Everything the player can cast or shout right now: the base list, what
		// they learned, their race's powers, and each shout's strongest UNLOCKED
		// word (hotbar_cast Knows + spell_actions' HasShout walk).
		std::vector<RE::SpellItem*> PlayerSpells(RE::PlayerCharacter* pc)
		{
			std::vector<RE::SpellItem*> out;
			std::set<RE::SpellItem*>    seen;
			auto add = [&](RE::SpellItem* s) {
				if (s && seen.insert(s).second)
					out.push_back(s);
			};
			auto fromList = [&](RE::TESSpellList::SpellData* d) {
				if (d && d->spells)
					for (std::uint32_t i = 0; i < d->numSpells; ++i)
						add(d->spells[i]);
			};
			if (auto* base = pc->GetActorBase())
				fromList(base->GetSpellList());
			if (auto* race = pc->GetRace())
				fromList(race->actorEffects);
			for (auto* s : pc->GetActorRuntimeData().addedSpells)
				add(s);
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				for (auto* sh : dh->GetFormArray<RE::TESShout>()) {
					if (!sh || !pc->HasShout(sh))
						continue;
					for (int v = 2; v >= 0; --v)
						if (WordUsable(sh->variations[v].word) && sh->variations[v].spell) {
							add(sh->variations[v].spell);
							break;
						}
				}
			}
			return out;
		}

		// The strongest spell of each archetype in the whole load order, built
		// once: a castable spell (or a shout word for the shout families), shown
		// in the UI, ranked by authored magnitude.
		std::map<Arch, RE::SpellItem*> g_bestOf;
		bool                           g_bestBuilt = false;
		RE::SpellItem* StrongestOf(Arch arch)
		{
			if (!g_bestBuilt) {
				g_bestBuilt = true;
				std::map<Arch, float> best;
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					using T = RE::MagicSystem::SpellType;
					for (auto* sp : dh->GetFormArray<RE::SpellItem>()) {
						if (!sp || Name(sp).empty())
							continue;
						const auto t = sp->GetSpellType();
						if (t != T::kSpell && t != T::kVoicePower)
							continue;
						for (auto* fx : sp->effects) {
							if (!fx || !fx->baseEffect || !Shown(fx->baseEffect))
								continue;
							const auto  ar  = fx->baseEffect->GetArchetype();
							const bool  shoutFam = ar == Arch::kStagger || ar == Arch::kDisarm;
							if (t == T::kVoicePower && !shoutFam)
								continue;
							const float m = fx->GetMagnitude();
							auto        it = best.find(ar);
							if (it == best.end() || m > it->second) {
								best[ar]     = m;
								g_bestOf[ar] = sp;
							}
						}
					}
				}
			}
			const auto it = g_bestOf.find(arch);
			return it == g_bestOf.end() ? nullptr : it->second;
		}

		// The player's perks that carry a Mod Spell Magnitude entry point and
		// whose conditions name this effect's school or one of its keywords -
		// the honest way to say WHICH perk moved a cap without hardcoding one.
		std::string MagnitudePerkFor(RE::PlayerCharacter* pc, const RE::EffectSetting* base)
		{
			if (!pc || !base)
				return {};
			std::string any;
			for (auto* rd : pc->GetPlayerRuntimeData().addedPerks) {
				auto* perk = rd ? rd->perk : nullptr;
				if (!perk)
					continue;
				for (auto* pe : perk->perkEntries) {
					if (!pe || pe->GetType() != RE::PERK_ENTRY_TYPE::kEntryPoint)
						continue;
					auto* ep = static_cast<RE::BGSEntryPointPerkEntry*>(pe);
					if (!ep->IsEntryPoint(RE::BGSEntryPoint::ENTRY_POINT::kModSpellMagnitude))
						continue;
					if (any.empty())
						any = Name(perk);
					for (auto& cond : ep->conditions)
						for (auto* it = cond.head; it; it = it->next) {
							const auto f = it->data.functionData.function.get();
							using FID    = RE::FUNCTION_DATA::FunctionID;
							if (f == FID::kEPMagic_SpellHasKeyword) {
								auto* kw = static_cast<RE::BGSKeyword*>(it->data.functionData.params[0]);
								if (kw && base->HasKeyword(kw))
									return Name(perk);
							} else if (f == FID::kEPMagic_SpellHasSkill) {
								const auto av = static_cast<RE::ActorValue>(reinterpret_cast<std::uintptr_t>(it->data.functionData.params[0]));
								if (av == base->GetMagickSkill())
									return Name(perk);
							}
						}
				}
			}
			return any;
		}

		// Dual-casting raises a cap only for a player who has the school's dual
		// perk: a Mod Spell Magnitude entry gated on IsDualCasting, or vanilla's
		// "<school> Dual Casting" perk (the table hotbar_cast.cpp already uses).
		bool CanDualFor(RE::PlayerCharacter* pc, RE::SpellItem* sp)
		{
			if (!pc || !sp || sp->GetNoDualCastModifications() || sp->GetSpellType() != RE::MagicSystem::SpellType::kSpell)
				return false;
			for (auto* rd : pc->GetPlayerRuntimeData().addedPerks) {
				auto* perk = rd ? rd->perk : nullptr;
				if (!perk)
					continue;
				for (auto* pe : perk->perkEntries) {
					if (!pe || pe->GetType() != RE::PERK_ENTRY_TYPE::kEntryPoint)
						continue;
					auto* ep = static_cast<RE::BGSEntryPointPerkEntry*>(pe);
					if (!ep->IsEntryPoint(RE::BGSEntryPoint::ENTRY_POINT::kModSpellMagnitude))
						continue;
					for (auto& cond : ep->conditions)
						for (auto* it = cond.head; it; it = it->next)
							if (it->data.functionData.function.get() == RE::FUNCTION_DATA::FunctionID::kIsDualCasting)
								return true;
				}
			}
			auto* eff  = sp->GetCostliestEffectItem();
			auto* base = eff ? eff->baseEffect : nullptr;
			if (!base)
				return false;
			RE::FormID id = 0;
			switch (base->GetMagickSkill()) {
			case RE::ActorValue::kAlteration:  id = 0x000153CD; break;
			case RE::ActorValue::kConjuration: id = 0x000153CE; break;
			case RE::ActorValue::kDestruction: id = 0x000153CF; break;
			case RE::ActorValue::kIllusion:    id = 0x000153D0; break;
			case RE::ActorValue::kRestoration: id = 0x000153D1; break;
			default: return false;
			}
			auto* perk = RE::TESForm::LookupByID<RE::BGSPerk>(id);
			return perk && pc->HasPerk(perk);
		}

		std::uint32_t PerkHash(RE::PlayerCharacter* pc)
		{
			std::uint32_t h = 2166136261u;
			for (auto* rd : pc->GetPlayerRuntimeData().addedPerks)
				if (rd && rd->perk) {
					h ^= rd->perk->GetFormID();
					h *= 16777619u;
				}
			return h;
		}

		std::unordered_map<std::string, json> g_affCache;   // cleared on load (OnPreLoad)

		json ReadAffects(RE::Actor* a, RE::PlayerCharacter* pc, const std::string& raceKey, const std::string& soul,
			bool summoned, bool undead, const std::string& mass)
		{
			if (!a || !pc)
				return json::object();
			auto* race = a->GetRace();
			const int lvl = a->GetLevel();
			const auto mine = PlayerSpells(pc);
			const std::string key = raceKey + "|" + std::to_string(lvl) + "|" + std::to_string(pc->GetLevel()) + "|" +
			                        std::to_string(PerkHash(pc)) + "|" + std::to_string(mine.size()) + "|" + (a->IsDead() ? "d" : "l");
			if (const auto it = g_affCache.find(key); it != g_affCache.end())
				return it->second;

			// The spell that answers for an archetype: the player's own that WORKS
			// on this creature (largest cap), else their own strongest, else the
			// load order's strongest.
			struct Pick
			{
				RE::SpellItem* sp = nullptr;
				SpellRead      r;
				bool           known = false;
			};
			auto pick = [&](Arch arch) {
				Pick best;
				for (auto* sp : mine) {
					const auto r = ReadSpell(sp, arch, a, pc);
					if (!r.any)
						continue;
					const bool better = !best.sp || (r.pass && !best.r.pass) || (r.pass == best.r.pass && r.mag > best.r.mag);
					if (better) {
						best.sp    = sp;
						best.r     = r;
						best.known = true;
					}
				}
				if (!best.sp)
					if (auto* sp = StrongestOf(arch)) {
						best.sp = sp;
						best.r  = ReadSpell(sp, arch, a, pc);
					}
				return best;
			};
			auto credit = [](AffAnswer& ans, const Pick& p) {
				if (!p.sp)
					return;
				ans.spell = Name(p.sp);
				std::string f, plug;
				ans.plugin = ActorIdentity::DurableOf(p.sp, f, plug) ? plug : PluginOf(p.sp);
				ans.known  = p.known;
			};
			const float dualMult = GameSetting("fMagicDualCastingEffectivenessBase", 2.2f);

			// a level-capped family: the effect's magnitude IS the highest level it takes
			auto capped = [&](Arch arch, const char* noun) {
				AffAnswer ans;
				ans.lvl      = lvl;
				const auto p = pick(arch);
				credit(ans, p);
				if (!p.sp) {
					ans.s   = "unknown";
					ans.why = std::string("No ") + noun + " spell in this load order";
					return ans;
				}
				if (!p.r.pass) {
					if (p.r.needPerk) {
						ans.s    = "perk";
						ans.perk = Name(p.r.needPerk);
						ans.why  = "Its kind answers only to " + ans.perk;
					} else {
						ans.s   = "no";
						ans.why = "Its kind is immune";
					}
					return ans;
				}
				const int cap = static_cast<int>(std::floor(p.r.mag + 0.001f));
				ans.cap       = cap;
				ans.s         = lvl <= cap ? "yes" : "no";
				if (CanDualFor(pc, p.sp) && p.known)
					ans.dual = static_cast<int>(std::floor(p.r.mag * dualMult + 0.001f));
				if (p.r.mag != p.r.raw && ((lvl <= cap) != (lvl <= static_cast<int>(std::floor(p.r.raw + 0.001f))))) {
					auto* pe0 = p.sp->GetCostliestEffectItem();
					ans.perk  = MagnitudePerkFor(pc, pe0 ? pe0->baseEffect : nullptr);
					if (!ans.perk.empty())
						ans.why = "Your " + ans.perk + " moves it to level " + std::to_string(cap);
				}
				if (ans.why.empty()) {
					if (ans.s == "no" && ans.dual >= lvl)
						ans.why = "Dual-cast it: works up to level " + std::to_string(ans.dual);
					else if (ans.s == "no")
						ans.why = "Too strong for " + ans.spell;
					else
						ans.why = ans.spell + " takes it";
				}
				if (!p.known)
					ans.why += " (you do not know it)";
				return ans;
			};

			json out = json::object();
			out["calm"]   = capped(Arch::kCalm, "calm").ToJson();
			out["fear"]   = capped(Arch::kDemoralize, "fear").ToJson();
			out["frenzy"] = capped(Arch::kFrenzy, "frenzy").ToJson();

			// Turn, banish and command only mean anything for their own kind.
			if (!undead)
				out["turn"] = AffAnswer{ "na", "", "", "", "Not undead" }.ToJson();
			else
				out["turn"] = capped(Arch::kTurnUndead, "turn undead").ToJson();
			if (!summoned) {
				out["banish"]  = AffAnswer{ "na", "", "", "", "Not summoned" }.ToJson();
				out["command"] = AffAnswer{ "na", "", "", "", "Not a summoned creature" }.ToJson();
			} else {
				// Banish Daedra is capped by level the same way when it carries a magnitude
				auto b = capped(Arch::kBanish, "banish");
				if (b.cap == 0) {
					b.cap = -1;
					b.s   = "yes";
					b.why = "Sent back to Oblivion";
				}
				out["banish"]  = b.ToJson();
				out["command"] = capped(Arch::kCommandSummoned, "command").ToJson();
			}

			// Reanimate reads a body: on a living study the conditions (which can
			// ask "is it dead?") would lie, so only the level answers.
			{
				AffAnswer ans;
				if (a->IsDead())
					ans = capped(Arch::kReanimate, "reanimate");
				else {
					ans.lvl      = lvl;
					const auto p = pick(Arch::kReanimate);
					credit(ans, p);
					if (!p.sp)
						ans.s = "unknown";
					else {
						ans.cap = static_cast<int>(std::floor(p.r.mag + 0.001f));
						ans.s   = lvl <= ans.cap ? "yes" : "no";
						ans.why = "Level only - read again on its body";
					}
				}
				out["reanimate"] = ans.ToJson();
			}

			// Paralysis has no level cap: it is the conditions, then its magic resistance.
			{
				AffAnswer ans;
				ans.lvl      = lvl;
				const auto p = pick(Arch::kParalysis);
				credit(ans, p);
				if (!p.sp) {
					ans.s = "unknown";
				} else if (!p.r.pass) {
					ans.s   = p.r.needPerk ? "perk" : "no";
					ans.perk = p.r.needPerk ? Name(p.r.needPerk) : "";
					ans.why = p.r.needPerk ? "Its kind answers only to " + ans.perk : "Its kind is never held";
				} else {
					const int mr = static_cast<int>(std::lround(a->AsActorValueOwner()->GetPermanentActorValue(RE::ActorValue::kResistMagic)));
					if (mr > 0) {
						ans.s   = "part";
						ans.pct = std::min(mr, 100);
						ans.why = "Its magic resistance shrugs off " + std::to_string(ans.pct) + "%";
					} else {
						ans.s   = "yes";
						ans.why = ans.spell + " holds it";
					}
				}
				out["paralysis"] = ans.ToJson();
			}

			// Soul trap keeps the soul reading; the spell is the one you would use.
			{
				AffAnswer ans;
				const auto p = pick(Arch::kSoulTrap);
				credit(ans, p);
				if (soul == "none") {
					ans.s   = "no";
					ans.why = summoned ? "A summon leaves no soul" : "No soul to take";
				} else if (soul == "dragon") {
					ans.s   = "na";
					ans.why = "You absorb its soul";
				} else {
					ans.s   = "yes";
					ans.why = (soul == "black" ? std::string("Black") : soul) + " soul";
				}
				out["soultrap"] = ans.ToJson();
			}

			// Disarm: nothing to take from empty hands.
			{
				AffAnswer ans;
				ans.lvl         = lvl;
				const bool held = a->GetEquippedObject(false) || a->GetEquippedObject(true);
				const auto p    = pick(Arch::kDisarm);
				credit(ans, p);
				if (!held) {
					ans.s   = "na";
					ans.why = "Nothing in its hands";
				} else if (!p.sp) {
					ans.s = "unknown";
				} else if (!p.r.pass) {
					ans.s   = "no";
					ans.why = "Its grip cannot be broken";
				} else {
					ans.s   = "yes";
					ans.why = ans.spell + " tears it loose";
				}
				out["disarm"] = ans.ToJson();
			}

			// Unrelenting Force / stagger: the race's own flags, then its mass.
			{
				AffAnswer ans;
				const auto p = pick(Arch::kStagger);
				credit(ans, p);
				using F = RE::RACE_DATA::Flag;
				if (race && race->data.flags.any(F::kNoKnockdowns)) {
					ans.s   = "no";
					ans.why = "Never knocked down";
				} else if (race && race->data.flags.any(F::kImmobile)) {
					ans.s   = "no";
					ans.why = "Rooted where it stands";
				} else {
					ans.s   = "yes";
					ans.why = mass == "Massive" || mass == "Immovable" ? "Staggers, but its bulk holds it up" :
					          mass == "Heavy"                           ? "Staggers; full force knocks it down" :
					                                                      "Light enough to send flying";
				}
				out["force"] = ans.ToJson();
			}

			// Silver: ask the engine what a silver weapon does to it (the vanilla
			// silver bonus is a perk entry, Mod Attack Damage, on the player).
			{
				static RE::TESObjectWEAP* silver = []() -> RE::TESObjectWEAP* {
					auto* kw = RE::TESForm::LookupByEditorID<RE::BGSKeyword>("WeapMaterialSilver");
					auto* dh = RE::TESDataHandler::GetSingleton();
					if (!kw || !dh)
						return nullptr;
					for (auto* w : dh->GetFormArray<RE::TESObjectWEAP>())
						if (w && w->HasKeyword(kw) && !Name(w).empty())
							return w;
					return nullptr;
				}();
				if (silver) {
					float mult = 1.0f;
					RE::BGSEntryPoint::HandleEntryPoint(RE::BGSEntryPoint::ENTRY_POINT::kModAttackDamage, pc, silver, a, &mult);
					AffAnswer ans;
					ans.spell  = Name(silver);
					std::string f, plug;
					ans.plugin = ActorIdentity::DurableOf(silver, f, plug) ? plug : PluginOf(silver);
					if (mult > 1.001f) {
						ans.s   = "weak";
						ans.why = "Silver bites deeper";
					} else {
						ans.s   = "normal";
						ans.why = "Silver does nothing extra";
					}
					out["silver"] = ans.ToJson();
				}
			}

			// Sun: Dawnguard's Sun Fire (its EditorID as the load order spells it,
			// read from the plugin by the elden-gate tooling). An effect of it that
			// carries conditions and still takes this creature is the sun's extra
			// harm. EditorIDs of spells are only loaded with po3's Tweaks; without
			// the record the key is left out.
			{
				static RE::SpellItem* sun = RE::TESForm::LookupByEditorID<RE::SpellItem>("DLC1SunFire");
				if (sun) {
					bool conditioned = false, takes = false;
					for (auto* fx : sun->effects) {
						if (!fx || !fx->baseEffect || !fx->conditions.head)
							continue;
						conditioned = true;
						if (fx->conditions.IsTrue(a, pc) && fx->baseEffect->conditions.IsTrue(a, pc))
							takes = true;
					}
					AffAnswer ans;
					ans.spell  = Name(sun);
					std::string f, plug;
					ans.plugin = ActorIdentity::DurableOf(sun, f, plug) ? plug : PluginOf(sun);
					ans.s      = takes ? "weak" : "normal";
					ans.why    = takes ? "Sun magic burns it the more" : (conditioned ? "Sun magic does nothing extra" : "Sun magic, plain fire");
					out["sun"] = ans.ToJson();
				}
			}

			// One vanilla Calm case per session, so the argument order of the
			// condition check can be confirmed against the game in the log.
			{
				static bool said = false;
				const auto& c    = out["calm"];
				if (!said && StrOr(c, "plugin") == "Skyrim.esm") {
					said = true;
					logger::info("bestiary: calm test '{}' on '{}' (level {}): subject=creature target=caster -> {} cap {}",
						StrOr(c, "spell"), a->GetDisplayFullName() ? a->GetDisplayFullName() : "?", lvl, StrOr(c, "s"), NumOr(c, "cap", -1));
				}
			}

			logger::info("bestiary: affects read for '{}' (level {}, {} answers, {} of your spells)",
				a->GetDisplayFullName() ? a->GetDisplayFullName() : "?", lvl, out.size(), mine.size());
			if (g_affCache.size() > 256)
				g_affCache.clear();
			g_affCache[key] = out;
			return out;
		}

		// Temporary magic on it right now (not abilities, not inactive): a
		// reading taken under someone's Fire Cloak or Weakness to Frost is not
		// its true nature.
		int EffectsUnder(RE::Actor* a)
		{
			auto* mt   = a ? a->AsMagicTarget() : nullptr;
			auto* list = mt ? mt->GetActiveEffectList() : nullptr;
			if (!list)
				return 0;
			int n = 0;
			for (auto* ae : *list) {
				if (!ae || !ae->spell || ae->flags.any(RE::ActiveEffect::Flag::kInactive))
					continue;
				if (ae->spell->GetSpellType() == RE::MagicSystem::SpellType::kAbility)
					continue;
				++n;
			}
			return n;
		}

		// Read the dying (or studied) actor into its page. Main thread.
		//
		// TRUE NATURE (2026-10-10): resistances, armour and the AI temper are
		// the creature's PERMANENT values and its record's AI data - never the
		// live ones, which carry whatever was cast on it this fight. A reading
		// taken while temporary magic was on it (measured.under > 0) never
		// overwrites one taken clean, and a weakness is only claimed from the
		// smallest resistance ever read (one debuffed kill cannot invent one).
		std::string MeasureLocked(RE::Actor* a, const char* how, RE::Actor* killer)
		{
			auto* race = a->GetRace();
			auto* npc  = a->GetActorBase();
			if (!race || !npc)
				return {};
			std::string name, raceKey;
			const std::string id = KindIdOf(a, &name, &raceKey);
			if (id.empty())
				return {};
			const std::string raceEid = EditorId(race);
			std::string       rfid, rplug;
			ActorIdentity::DurableOf(race, rfid, rplug);
			auto* root = RootBase(a);
			if (!root)
				root = npc;

			auto& e = g_db["entries"][id];
			if (!e.is_object())
				e = json::object();
			const bool fresh = !e.contains("name");
			e["name"]     = name;
			e["raceKey"]  = raceKey;
			e["raceName"] = Name(race).empty() ? raceEid : Name(race);
			e["chapter"]  = ChapterOf(a);
			{
				std::string bf, bp;
				e["plugin"] = ActorIdentity::DurableOf(root, bf, bp) ? bp : (rplug.empty() ? PluginOf(race) : rplug);
			}
			if (const auto fam = FamilyOf(race); !fam.empty())
				e["family"] = fam;
			if (root->IsUnique())
				e["unique"] = true;
			else
				e.erase("unique");

			const int under      = EffectsUnder(a);
			const json& prevMeas = ObjOr(e, "measured");
			const bool cleanBefore = prevMeas.contains("under") && NumOr(prevMeas, "under", 1) == 0;
			const bool keepStats   = under > 0 && cleanBefore && e.contains("health");

			auto* avo = a->AsActorValueOwner();
			using AV  = RE::ActorValue;
			const int lvl = a->GetLevel();
			e["level"]    = lvl;
			e["levelMin"] = e.contains("levelMin") ? std::min(NumOr(e, "levelMin", lvl), lvl) : lvl;
			e["levelMax"] = e.contains("levelMax") ? std::max(NumOr(e, "levelMax", lvl), lvl) : lvl;
			if (!keepStats) {
				e["health"]  = std::lround(avo->GetPermanentActorValue(AV::kHealth));
				e["stamina"] = std::lround(avo->GetPermanentActorValue(AV::kStamina));
				e["magicka"] = std::lround(avo->GetPermanentActorValue(AV::kMagicka));
				e["armor"]   = std::lround(avo->GetPermanentActorValue(AV::kDamageResist));
				json resist{
					{ "fire", std::lround(avo->GetPermanentActorValue(AV::kResistFire)) },
					{ "frost", std::lround(avo->GetPermanentActorValue(AV::kResistFrost)) },
					{ "shock", std::lround(avo->GetPermanentActorValue(AV::kResistShock)) },
					{ "magic", std::lround(avo->GetPermanentActorValue(AV::kResistMagic)) },
					{ "poison", std::lround(avo->GetPermanentActorValue(AV::kPoisonResist)) },
					{ "disease", std::lround(avo->GetPermanentActorValue(AV::kResistDisease)) },
				};
				// The range of every element across readings. A weakness is claimed
				// only when EVERY reading had it (the max is below zero), so one
				// debuffed kill cannot invent one; a clean reading resets a range
				// that only readings under magic had seeded.
				auto& rmin = e["resistMin"];
				auto& rmax = e["resistMax"];
				const bool reset = under == 0 && !BoolOr(e, "resistClean", false);
				if (!rmin.is_object() || reset)
					rmin = json::object();
				if (!rmax.is_object() || reset)
					rmax = json::object();
				if (under == 0)
					e["resistClean"] = true;
				for (auto it = resist.begin(); it != resist.end(); ++it) {
					const int  v    = it.value().get<int>();
					const auto* k   = it.key().c_str();
					const bool seen = rmin.contains(it.key()) && rmax.contains(it.key());
					if (under == 0 || !seen) {
						rmin[it.key()] = seen ? std::min(NumOr(rmin, k, v), v) : v;
						rmax[it.key()] = seen ? std::max(NumOr(rmax, k, v), v) : v;
					}
				}
				e["resist"] = std::move(resist);
				e["regen"]  = avo->GetPermanentActorValue(AV::kHealRate);
			}
			e["measured"] = json{ { "how", std::string(how) }, { "under", keepStats ? 0 : under } };
			if (keepStats)
				logger::info("bestiary: '{}' read under {} temporary effect(s) - the clean reading is kept", name, under);
			// temper and courage are the RECORD's AI data, not the live AVs a
			// Calm or a Frenzy has just rewritten
			e["aggression"] = std::clamp(static_cast<int>(npc->GetAggressionLevel()), 0, 3);
			e["confidence"] = std::clamp(static_cast<int>(npc->GetConfidenceLevel()), 0, 4);
			bool rangedWeapon = false;
			{
				int dmg = 0;
				if (auto* obj = a->GetEquippedObject(false); obj)
					if (auto* w = obj->As<RE::TESObjectWEAP>()) {
						dmg = static_cast<int>(w->GetAttackDamage());
						const auto wt = w->GetWeaponType();
						rangedWeapon  = wt == RE::WEAPON_TYPE::kBow || wt == RE::WEAPON_TYPE::kCrossbow;
					}
				if (dmg <= 0)
					dmg = static_cast<int>(std::lround(race->data.unarmedDamage));
				e["dmg"] = dmg;
			}
			e["heightM"] = std::round(a->GetHeight() * 0.01428f * 10.0f) / 10.0f;
			e["reachM"]  = std::round(race->data.unarmedReach * 0.01428f * 10.0f) / 10.0f;
			std::string soul;
			const bool  summoned = a->IsCommandedActor();
			{
				if (a->HasKeywordString("ActorTypeDragon"))
					soul = "dragon";
				else if (summoned)
					soul = "none";
				else if (a->HasKeywordString("ActorTypeNPC") && !a->HasKeywordString("ActorTypeUndead"))
					soul = "black";
				else {
					switch (a->GetSoulSize()) {
					case RE::SOUL_LEVEL::kPetty:   soul = "Petty"; break;
					case RE::SOUL_LEVEL::kLesser:  soul = "Lesser"; break;
					case RE::SOUL_LEVEL::kCommon:  soul = "Common"; break;
					case RE::SOUL_LEVEL::kGreater: soul = "Greater"; break;
					case RE::SOUL_LEVEL::kGrand:   soul = "Grand"; break;
					default:                       soul = "none"; break;
					}
				}
				e["soul"]     = soul;
				e["summoned"] = summoned;
			}
			const bool undead = a->HasKeywordString("ActorTypeUndead");
			e["undead"]    = undead;
			e["werebeast"] = Lower(raceEid).find("werewolf") != std::string::npos || Lower(raceEid).find("werebear") != std::string::npos;

			// what the race record says plainly about its body
			{
				using F = RE::RACE_DATA::Flag;
				static const std::pair<F, const char*> kFlags[] = {
					{ F::kNoKnockdowns, "noKnockdown" }, { F::kImmobile, "immobile" }, { F::kFlies, "flies" },
					{ F::kSwims, "swims" }, { F::kCantOpenDoors, "cantOpenDoors" }, { F::kNotPushable, "notPushable" },
					{ F::kRegenHPInCombat, "regenInCombat" }, { F::kNoCombatInWater, "noCombatInWater" }
				};
				auto flags = json::array();
				for (const auto& [f, word] : kFlags)
					if (race->data.flags.any(f))
						flags.push_back(word);
				e["flags"] = flags;
			}
			std::string massWord;
			{
				const float m = race->data.baseMass;
				massWord      = race->data.flags.any(RE::RACE_DATA::Flag::kNotPushable) ? "Immovable" :
				                m < 0.75f                                                ? "Light" :
				                m < 1.5f                                                 ? "Middling" :
				                m < 3.0f                                                 ? "Heavy" :
				                m < 8.0f                                                 ? "Massive" :
				                                                                           "Immovable";
				e["mass"] = massWord;
				auto* pc  = RE::PlayerCharacter::GetSingleton();
				const float it = RunSpeed(a, false), run = RunSpeed(pc, false), sprint = RunSpeed(pc, true);
				if (it > 0.0f && run > 0.0f) {
					const float r = it / run;
					e["speed"]    = r < 0.9f ? "You can outrun it" : r <= 1.1f ? "Runs as fast as you" :
					                (sprint <= 0.0f || it < sprint) ? "Outruns you" : "Faster than your sprint";
				}
			}

			// its attacks, off the NPC's own attack data first, then the race's
			bool attackSpell = false;
			{
				struct Atk
				{
					std::string    name;
					float          mult = 1.0f;
					bool           power = false, bash = false, charge = false, knock = false;
					RE::SpellItem* spell = nullptr;
				};
				std::vector<Atk> atks;
				auto fromMap = [&](RE::BGSAttackDataMap* m) {
					if (!m)
						return;
					for (auto& kv : m->attackDataMap) {
						auto* ad = kv.second.get();
						if (!ad)
							continue;
						using AF = RE::AttackData::AttackFlag;
						Atk k;
						k.name   = AttackName(ad->event.c_str());
						k.mult   = ad->data.damageMult;
						k.power  = ad->data.flags.any(AF::kPowerAttack);
						k.bash   = ad->data.flags.any(AF::kBashAttack);
						k.charge = ad->data.flags.any(AF::kChargeAttack);
						k.knock  = ad->data.knockDown > 0.0f;
						k.spell  = ad->data.attackSpell;
						auto same = std::find_if(atks.begin(), atks.end(), [&](const Atk& x) { return x.name == k.name; });
						if (same == atks.end())
							atks.push_back(k);
						else {
							same->mult = std::max(same->mult, k.mult);
							same->power |= k.power;
							same->bash |= k.bash;
							same->charge |= k.charge;
							same->knock |= k.knock;
							if (!same->spell)
								same->spell = k.spell;
						}
					}
				};
				fromMap(npc->attackDataMap.get());
				fromMap(race->attackDataMap.get());
				std::stable_sort(atks.begin(), atks.end(), [](const Atk& x, const Atk& y) { return x.mult > y.mult; });
				int   powers = 0;
				float maxMult = 1.0f, maxPower = 0.0f;
				bool  knocks = false;
				auto  arr = json::array();
				for (const auto& k : atks) {
					maxMult = std::max(maxMult, k.mult);
					if (k.power) {
						++powers;
						maxPower = std::max(maxPower, k.mult);
					}
					knocks |= k.knock;
					attackSpell |= k.spell != nullptr;
					if (arr.size() >= 8)
						continue;
					json o{ { "name", k.name }, { "mult", std::round(k.mult * 100.0f) / 100.0f }, { "power", k.power },
						{ "bash", k.bash }, { "charge", k.charge }, { "knock", k.knock } };
					if (k.spell) {
						o["spell"] = Name(k.spell);
						std::string f, plug;
						o["plugin"] = ActorIdentity::DurableOf(k.spell, f, plug) ? plug : PluginOf(k.spell);
					}
					arr.push_back(std::move(o));
				}
				if (!arr.empty())
					e["attacks"] = arr;
				else
					e.erase("attacks");
				if (powers > 0) {
					char buf[96];
					std::snprintf(buf, sizeof(buf), "%d power attack%s, up to \xC3\x97%.1f", powers, powers == 1 ? "" : "s", maxPower);
					e["power"] = std::string(buf) + (knocks ? ", knocks you down" : "");
				} else
					e["power"] = knocks ? "None, but its blows knock you down" : "None";
				e["dmgPower"] = static_cast<int>(std::lround(NumOr(e, "dmg", 0) * maxMult));
			}

			// its arsenal: the hostile magic it turns on you
			bool castsSpells = false;
			{
				auto arr = json::array();
				std::set<const RE::TESForm*> seen;
				auto add = [&](const RE::TESForm* f, const RE::MagicItem* sp, const char* kind) {
					if (!f || !sp || arr.size() >= 8 || !seen.insert(f).second)
						return;
					const auto* hostile = HostileEffect(sp);
					const auto  nm      = Name(f);
					if (!hostile || nm.empty())
						return;
					json o{ { "name", nm }, { "kind", kind } };
					if (const char* el = ElementOf(hostile->data.resistVariable); *el)
						o["element"] = el;
					std::string fid, plug;
					o["plugin"] = ActorIdentity::DurableOf(f, fid, plug) ? plug : PluginOf(f);
					if (std::string(kind) == "spell")
						castsSpells = true;
					arr.push_back(std::move(o));
				};
				auto fromList = [&](RE::TESSpellList::SpellData* sd) {
					if (!sd)
						return;
					using T = RE::MagicSystem::SpellType;
					for (std::uint32_t i = 0; i < sd->numSpells; ++i) {
						auto* sp = sd->spells ? sd->spells[i] : nullptr;
						if (!sp)
							continue;
						const auto t = sp->GetSpellType();
						if (t == T::kSpell)
							add(sp, sp, "spell");
						else if (t == T::kPower || t == T::kLesserPower || t == T::kVoicePower)
							add(sp, sp, "power");
					}
					for (std::uint32_t i = 0; i < sd->numShouts; ++i) {
						auto* sh = sd->shouts ? sd->shouts[i] : nullptr;
						if (!sh)
							continue;
						for (const auto& var : sh->variations)
							if (var.spell && HostileEffect(var.spell)) {
								add(sh, var.spell, "shout");
								break;
							}
					}
				};
				fromList(race->actorEffects);
				fromList(npc->actorEffects);
				if (e.contains("attacks"))
					for (const auto& kv : { npc->attackDataMap.get(), race->attackDataMap.get() })
						if (kv)
							for (auto& at : kv->attackDataMap)
								if (at.second && at.second->data.attackSpell)
									add(at.second->data.attackSpell, at.second->data.attackSpell, "attack");
				if (!arr.empty())
					e["arsenal"] = arr;
				else
					e.erase("arsenal");
			}

			// how it fights: the combat style's weights, but only for what it CAN
			// do - a wolf with a CSTY that likes magic still casts nothing
			{
				const bool shouts = (race->actorEffects && race->actorEffects->numShouts > 0) ||
				                    (npc->actorEffects && npc->actorEffects->numShouts > 0);
				const bool ranged = rangedWeapon || attackSpell;
				json st;
				auto* cs = npc->combatStyle;
				bool  flat = !cs;
				if (cs) {
					const auto& g = cs->generalData;
					flat = g.meleeScoreMult == g.magicScoreMult && g.magicScoreMult == g.rangedScoreMult && g.rangedScoreMult == g.shoutScoreMult;
				}
				if (!flat) {
					const auto& g = cs->generalData;
					st = json{ { "melee", g.meleeScoreMult + g.unarmedScoreMult },
						{ "magic", castsSpells ? g.magicScoreMult + g.staffScoreMult : 0.0f },
						{ "ranged", ranged ? g.rangedScoreMult : 0.0f }, { "shout", shouts ? g.shoutScoreMult : 0.0f }, { "basis", "csty" } };
				} else
					st = json{ { "melee", 1.0f }, { "magic", castsSpells ? 1.0f : 0.0f }, { "ranged", ranged ? 1.0f : 0.0f },
						{ "shout", shouts ? 1.0f : 0.0f }, { "basis", "default" } };
				std::string offense;
				if (cs) {
					const auto& g = cs->generalData;
					offense = g.offensiveMult > g.defensiveMult ? "presses" : g.offensiveMult < g.defensiveMult ? "holds" : "";
				}
				st["offense"] = offense;
				e["style"]    = st;
			}
			{
				auto traits = json::array();
				std::set<std::string> seen;
				auto add = [&](const std::string& t) {
					if (!t.empty() && traits.size() < 6 && seen.insert(t).second)
						traits.push_back(t);
				};
				// What a PLAYER would call an ability: never a spell whose every
				// effect the game itself hides from the UI (detection cloaks, stagger
				// controllers, killmove fixes), and never a bare editor-style id
				// ("madDetectionCloak": no space, camel case) or a script helper
				// (Rober, 2026-10-10: the Ground Sloth listed five of them).
				auto playerFacing = [](RE::SpellItem* sp, const std::string& nm) {
					if (nm.empty())
						return false;
					bool shown = false;
					for (auto* fx : sp->effects)
						if (fx && fx->baseEffect && !fx->baseEffect->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI)) {
							shown = true;
							break;
						}
					if (!shown)
						return false;
					if (nm.find(' ') == std::string::npos) {
						for (std::size_t i = 1; i < nm.size(); ++i)
							if (std::isupper(static_cast<unsigned char>(nm[i])) && std::islower(static_cast<unsigned char>(nm[i - 1])))
								return false;
					}
					static const char* kJunk[] = { "controller", "monitor", "dummy", "script", "manager", "tracker", " fix", "debug", "killmove", "cloak", "placeholder" };
					const auto low = Lower(nm);
					for (const char* j : kJunk)
						if (low.find(j) != std::string::npos)
							return false;
					return true;
				};
				auto fromList = [&](RE::TESSpellList::SpellData* sd) {
					if (!sd)
						return;
					for (std::uint32_t i = 0; i < sd->numShouts; ++i)
						if (sd->shouts && sd->shouts[i])
							add("Shouts: " + Name(sd->shouts[i]));
					for (std::uint32_t i = 0; i < sd->numSpells; ++i) {
						auto* sp = sd->spells ? sd->spells[i] : nullptr;
						if (!sp)
							continue;
						using T = RE::MagicSystem::SpellType;
						const auto t = sp->GetSpellType();
						const auto nm = Name(sp);
						if (!playerFacing(sp, nm))
							continue;
						if (t == T::kSpell)
							add("Casts " + nm);
						else if (t == T::kAbility || t == T::kPower || t == T::kLesserPower)
							add(nm);
					}
				};
				fromList(race->actorEffects);
				fromList(npc->actorEffects);
				e["traits"] = traits;
			}
			if (auto* li = npc->deathItem) {
				auto carries = json::array();
				const int none   = li->chanceNone;
				const auto n     = li->entries.size();
				const bool all   = (li->llFlags & RE::TESLeveledList::Flag::kUseAll) != 0;   // a plain uint8 enum, not an EnumSet
				for (const auto& le : li->entries) {
					if (carries.size() >= 4 || !le.form)
						continue;
					auto nm = Name(le.form);
					if (nm.empty())
						continue;
					const char* chance = (none == 0 && (all || n == 1)) ? "always" : (none < 50 ? "often" : "rare");
					carries.push_back(json{ { "name", nm }, { "chance", chance } });
				}
				if (!carries.empty())
					e["carries"] = carries;
			}
			{
				std::string nif;
				const RE::TESObjectARMO* skin = nullptr;
				std::string sf, sp;
				if ((SkinOf(root, race, nif, skin) || SkinOf(npc, race, nif, skin)) && ActorIdentity::DurableOf(skin, sf, sp))
					e["skin"] = json{ { "fid", sf }, { "plugin", sp }, { "nif", nif } };
			}

			// what works on it, read off the live actor against the player as
			// they stand now
			if (auto* pc = RE::PlayerCharacter::GetSingleton()) {
				e["aff"]    = ReadAffects(a, pc, raceKey, soul, summoned, undead, massWord);
				e["affLvl"] = lvl;
			}

			// the record of this meeting
			std::string holdId, holdName, place;
			PlaceOf(a, holdId, holdName, place);
			const auto today = Today();
			const bool you   = killer && killer->IsPlayerRef();
			std::string what;
			if (std::string(how) == "study")
				what = "Studied";
			else if (you)
				what = WieldedBy(killer);
			else
				what = std::string(killer && killer->GetDisplayFullName() ? killer->GetDisplayFullName() : "A companion") + " struck the killing blow";
			if (std::string(how) == "kill") {
				if (you) {
					e["slain"] = NumOr(e, "slain", 0) + 1;
					auto& w = e["weapons"];
					if (!w.is_object())
						w = json::object();
					w[what] = NumOr(w, what.c_str(), 0) + 1;
				} else
					e["companions"] = NumOr(e, "companions", 0) + 1;
				auto& r = e["regions"];
				if (!r.is_object())
					r = json::object();
				auto& rh   = r[holdId == "other" ? "other:" + holdName : holdId];
				if (!rh.is_object())
					rh = json::object();
				rh["id"]   = holdId;
				rh["name"] = holdName;
				rh["n"]    = NumOr(rh, "n", 0) + 1;
				const json meet{ { "when", today }, { "where", place.empty() ? holdName : place } };
				if (!e.contains("first"))
					e["first"] = meet;
				e["last"] = meet;
				if (lvl >= NumOr(e, "biggestLevel", 0)) {
					e["biggestLevel"] = lvl;
					e["biggest"]      = "Lvl " + std::to_string(lvl) + " " + name;
				}
				g_db["latest"] = json{ { "id", id }, { "when", today } };
			} else
				e["studied"] = NumOr(e, "studied", 0) + 1;
			auto& log = e["log"];
			if (!log.is_array())
				log = json::array();
			log.insert(log.begin(), json{ { "when", today }, { "what", what }, { "where", place.empty() ? holdName : place } });
			while (log.size() > kLogCap)
				log.erase(log.end() - 1);
			logger::info("bestiary: {} '{}' ({}, {}) at {}", how, name, StrOr(e, "chapter"), raceKey, place);
			if (fresh)
				e["new"] = true;
			return id;
		}

		/* ------------------------------------------------------- the view --- */
		const char* kTier[] = { "", "Trivial", "Fair", "Fierce", "Deadly", "Dire" };

		// The player as the duel sees them: the ENGINE's damage for the weapon
		// in hand (GetDamage folds in skill, perks, tempering - char_sheet.cpp's
		// idiom), or the costliest effect of the spell in hand; the armour
		// formula's own game settings; and the difficulty multipliers.
		struct PlayerCtx
		{
			double health = 100, dmg = 0, reduce = 0, scale = 0.12, maxArmor = 80, byPC = 1, toPC = 1;
			int    level = 1, diffIdx = 2;
			bool   spell = false;
			std::string weapon, name, elem, difficulty = "Adept";
			json   resist = json::object();
			std::uint32_t sig = 0;
		};
		PlayerCtx Player()
		{
			PlayerCtx p;
			auto* pc = RE::PlayerCharacter::GetSingleton();
			if (!pc)
				return p;
			auto* avo  = pc->AsActorValueOwner();
			p.health   = std::max(1.0f, avo->GetPermanentActorValue(RE::ActorValue::kHealth));
			p.level    = pc->GetLevel();
			p.scale    = GameSetting("fArmorScalingFactor", 0.12f);
			p.maxArmor = GameSetting("fMaxArmorRating", 80.0f);
			const double armor = avo->GetActorValue(RE::ActorValue::kDamageResist);
			p.reduce   = std::min(p.maxArmor, armor * p.scale) / 100.0;
			p.name     = pc->GetDisplayFullName() ? pc->GetDisplayFullName() : "";
			{
				static const char* kSfx[]  = { "VE", "E", "N", "H", "VH", "L" };
				static const char* kName[] = { "Novice", "Apprentice", "Adept", "Expert", "Master", "Legendary" };
				p.diffIdx    = std::clamp(static_cast<int>(pc->GetGameStatsData().difficulty), 0, 5);
				p.difficulty = kName[p.diffIdx];
				p.byPC       = GameSetting((std::string("fDiffMultHPByPC") + kSfx[p.diffIdx]).c_str(), 1.0f);
				p.toPC       = GameSetting((std::string("fDiffMultHPToPC") + kSfx[p.diffIdx]).c_str(), 1.0f);
			}
			if (auto* obj = pc->GetEquippedObject(false); obj) {
				if (auto* w = obj->As<RE::TESObjectWEAP>()) {
					p.weapon = Name(w);
					if (auto* entry = pc->GetEquippedEntryData(false))
						p.dmg = pc->GetDamage(entry);
					else
						p.dmg = w->GetAttackDamage();
				} else if (auto* sp = obj->As<RE::SpellItem>()) {
					if (auto* fx = sp->GetCostliestEffectItem(); fx && fx->baseEffect && fx->baseEffect->IsHostile()) {
						p.weapon = Name(sp);
						p.spell  = true;
						p.dmg    = fx->GetMagnitude();
						p.elem   = ElementOf(fx->baseEffect->data.resistVariable);
					}
				}
			}
			p.dmg = std::max(0.0, p.dmg);
			using AV = RE::ActorValue;
			const long long rFire = std::lround(avo->GetActorValue(AV::kResistFire)), rFrost = std::lround(avo->GetActorValue(AV::kResistFrost)),
							rShock = std::lround(avo->GetActorValue(AV::kResistShock)), rPoison = std::lround(avo->GetActorValue(AV::kPoisonResist)),
							rMagic = std::lround(avo->GetActorValue(AV::kResistMagic));
			p.resist = json{ { "fire", rFire }, { "frost", rFrost }, { "shock", rShock }, { "poison", rPoison }, { "magic", rMagic } };
			// what the duel AND the counsel depend on, folded into one number
			// (StateJson bumps rev when it moves, so the view redraws a duel that
			// changed; the five resists are in it because the arsenal advice reads
			// them: a resist ring or potion must not leave stale counsel up)
			std::uint32_t h = 2166136261u;
			for (const long long v : { static_cast<long long>(p.level), static_cast<long long>(p.health), static_cast<long long>(p.dmg * 10),
					 static_cast<long long>(armor), static_cast<long long>(p.diffIdx), rFire, rFrost, rShock, rPoison, rMagic }) {
				h ^= static_cast<std::uint32_t>(v);
				h *= 16777619u;
			}
			for (char c : p.weapon) {
				h ^= static_cast<unsigned char>(c);
				h *= 16777619u;
			}
			p.sig = h;
			return p;
		}

		int Bucket(double v, std::initializer_list<double> edges)
		{
			int i = 1;
			for (double e : edges) {
				if (v < e)
					return i;
				++i;
			}
			return i;
		}

		// Body renders: one existence check per skin per session, not a
		// FileExists per page per state build. Cleared when a render lands.
		// img = the book's own 1024 render (icons/bestiary/) once it exists, else
		// the Mounts 512; thumb = the 512 (medals and rows are ~100px, and a
		// 1024 would be scaled down on every paint), else img. hi = img is 1024.
		struct Art
		{
			std::string img, thumb;
			bool        hi = false;
		};
		std::unordered_map<std::string, Art> g_imgCache;
		Art ArtFor(const json& skin)
		{
			const auto fid = StrOr(skin, "fid"), plug = StrOr(skin, "plugin");
			if (fid.empty())
				return {};
			const auto key = fid + "|" + plug;
			if (const auto it = g_imgCache.find(key); it != g_imgCache.end())
				return it->second;
			Art a;
			a.thumb      = ItemIcons::BodyPathFor(fid, plug);
			const auto h = ItemIcons::BeastPathFor(fid, plug);
			a.hi         = !h.empty();
			a.img        = a.hi ? h : a.thumb;
			if (a.thumb.empty())
				a.thumb = a.img;
			g_imgCache[key] = a;
			return a;
		}
		std::string ImgFor(const json& skin) { return ArtFor(skin).img; }

		// The family a page is filed under for its variants: the skeleton family,
		// else the race. Built ONCE per state (it was an O(N^2) scan per page).
		using Groups = std::unordered_map<std::string, std::vector<std::string>>;
		std::string GroupKey(const json& s)
		{
			const auto fam = StrOr(s, "family");
			return fam.empty() ? "r|" + StrOr(s, "raceKey", "-") : "f|" + Lower(fam);
		}
		Groups BuildGroups(const json& all)
		{
			Groups g;
			for (auto it = all.begin(); it != all.end(); ++it)
				if (it.value().is_object())
					g[GroupKey(it.value())].push_back(it.key());
			return g;
		}

		std::string Duration(int secs)
		{
			if (secs < 60)
				return std::to_string(std::max(secs, 1)) + " s";
			const int m = secs / 60, s = secs % 60;
			return std::to_string(m) + " min" + (s ? " " + std::to_string(s) + " s" : std::string());
		}

		json EntryView(const std::string& id, const json& s, const PlayerCtx& p, const Groups* groups)
		{
			json v;
			v["id"]      = id;
			v["name"]    = StrOr(s, "name", id);
			v["chapter"] = StrOr(s, "chapter", "unknown");
			v["race"]    = StrOr(s, "raceName");
			v["family"]  = StrOr(s, "family", StrOr(s, "raceName"));
			v["plugin"]  = StrOr(s, "plugin");
			if (BoolOr(s, "unique", false))
				v["unique"] = true;
			if (const auto& sk = ObjOr(s, "skin"); !sk.empty())
				if (const auto art = ArtFor(sk); !art.img.empty()) {
					v["img"] = art.img;
					if (art.thumb != art.img)
						v["thumb"] = art.thumb;
				}
			// variants: every page of the same family (else the same race)
			if (groups) {
				if (const auto it = groups->find(GroupKey(s)); it != groups->end() && it->second.size() > 1)
					v["variants"] = it->second;
			}
			{
				const int lo = NumOr(s, "levelMin", -1), hi = NumOr(s, "levelMax", -1);
				if (lo >= 0 && hi > lo)
					v["levelRange"] = "Lvl " + std::to_string(lo) + "\xE2\x80\x93" + std::to_string(hi);
			}
			if (const auto& m = ObjOr(s, "measured"); !m.empty())
				v["measured"] = json{ { "how", StrOr(m, "how", "kill") }, { "under", NumOr(m, "under", 0) } };

			const bool measured = s.contains("health");
			if (measured) {
				const int    level  = NumOr(s, "level", 0);
				const double hp     = std::max(1, NumOr(s, "health", 1));
				const double dmg    = NumOr(s, "dmg", 0);
				const double dmgPow = std::max(dmg, static_cast<double>(NumOr(s, "dmgPower", 0)));
				const auto&  resist = ObjOr(s, "resist");
				v["level"]   = level;
				v["health"]  = NumOr(s, "health", 0);
				v["stamina"] = NumOr(s, "stamina", 0);
				v["magicka"] = NumOr(s, "magicka", 0);
				v["armor"]   = NumOr(s, "armor", 0);
				v["dmg"]     = std::to_string(static_cast<int>(dmg));
				v["resist"]  = resist;
				const double phys = std::min(p.maxArmor, NumOr(s, "armor", 0) * p.scale);
				v["physical"] = static_cast<int>(std::lround(phys));
				v["traits"]   = ArrOr(s, "traits");
				if (const auto& fl = ArrOr(s, "flags"); !fl.empty())
					v["flags"] = fl;
				if (const auto& at = ArrOr(s, "attacks"); !at.empty())
					v["attacks"] = at;
				if (const auto& ar = ArrOr(s, "arsenal"); !ar.empty())
					v["arsenal"] = ar;
				auto hasFlag = [&](const char* f) {
					for (const auto& x : ArrOr(s, "flags"))
						if (x.is_string() && x.get<std::string>() == f)
							return true;
					return false;
				};

				// the duel, against the player as they stand NOW: their engine
				// damage through its armour (or its resistance, for a spell in
				// hand), its blow through yours, both at this difficulty
				const double itsHit = std::max(1.0, dmg * (1.0 - p.reduce) * p.toPC);
				const int itsBlows  = static_cast<int>(std::ceil(p.health / itsHit));
				int tier = 0, yourBlows = 0;
				if (p.dmg > 0) {
					double hit = p.dmg;
					if (p.spell) {
						const double r = p.elem.empty() ? 0.0 : std::min(85, NumOr(resist, p.elem.c_str(), 0));
						hit *= 1.0 - r / 100.0;
					} else
						hit *= 1.0 - phys / 100.0;
					hit       = std::max(1.0, hit * p.byPC);
					yourBlows = static_cast<int>(std::ceil(hp / hit));
					v["vs"]   = json{ { "yourBlows", yourBlows }, { "itsBlows", itsBlows },
                        { "strike", static_cast<int>(std::lround(100.0 * itsHit / p.health)) },
                        { "hardest", static_cast<int>(std::lround(100.0 * std::max(1.0, dmgPow * (1.0 - p.reduce) * p.toPC) / p.health)) },
                        { "difficulty", p.difficulty } };
					const double ratio = static_cast<double>(itsBlows) / std::max(1, yourBlows);
					tier = ratio >= 8 ? 1 : ratio >= 4 ? 2 : ratio >= 2 ? 3 : ratio >= 1 ? 4 : 5;
				} else {
					// no weapon in hand: weigh by its health against yours only
					const double r = hp / p.health;
					tier = r < 0.5 ? 1 : r < 1 ? 2 : r < 2 ? 3 : r < 4 ? 4 : 5;
				}
				// a weakness is claimed only when every reading had it
				const auto& rmax = ObjOr(s, "resistMax").empty() ? resist : ObjOr(s, "resistMax");
				std::string weak;
				int lo = 0;
				for (const char* k : { "fire", "frost", "shock", "poison" }) {
					const int r = NumOr(rmax, k, 0);
					if (r < lo) {
						lo   = r;
						weak = k;
					}
				}
				static const char* kWords[] = { "", "no danger", "a fight you should win", "a real fight", "a hard fight", "more than a match" };
				std::string note = "At your level (" + std::to_string(p.level) + ") it is <b>" + kWords[tier] + "</b>.";
				if (!weak.empty())
					note += " It takes " + std::to_string(-lo) + "% more from <b>" + weak + "</b>.";
				if (hasFlag("regenInCombat"))
					note += " Its wounds close even mid-fight \xE2\x80\x94 do not let it rest.";
				v["threat"] = json{ { "tier", tier }, { "word", kTier[tier] }, { "note", note } };

				const double tough = hp * (1.0 + phys / 100.0) / p.health;
				const int    t     = Bucket(tough, { 0.5, 1.0, 2.0, 4.0 });
				const int    f     = Bucket(100.0 * dmg / p.health, { 3, 6, 10, 16 });
				const int    m     = Bucket(NumOr(s, "magicka", 0), { 1, 100, 250, 500 });
				static const char* kT[] = { "", "Frail", "Light", "Sturdy", "Hardy", "Ironclad" };
				static const char* kF[] = { "", "Timid", "Nips", "Bites hard", "Mauls", "Crushing" };
				static const char* kM[] = { "", "None to speak of", "Faint", "Some", "Strong", "Mighty" };
				static const char* kR[] = { "", "Common", "Familiar", "Uncommon", "Rare", "Seen once" };
				json ratings{ { "tough", json::array({ t, kT[t] }) }, { "fero", json::array({ f, kF[f] }) },
					{ "arcane", json::array({ m, kM[m] }) } };
				// a unique creature is not "rare", it is one of one: no rarity rating
				if (!BoolOr(s, "unique", false)) {
					const int seen = NumOr(s, "slain", 0) + NumOr(s, "companions", 0) + NumOr(s, "studied", 0);
					const int rar  = seen >= 30 ? 1 : seen >= 10 ? 2 : seen >= 4 ? 3 : seen >= 2 ? 4 : 5;
					ratings["rarity"] = json::array({ rar, kR[rar] });
				}
				v["ratings"] = ratings;

				// body & soul
				json body;
				if (const double h = DblOr(s, "heightM", 0.0); h > 0.05) {
					char buf[32];
					std::snprintf(buf, sizeof(buf), "%.1f m", h);
					body["height"] = buf;
					const int inches = static_cast<int>(std::lround(h * 39.37));
					body["heightFt"] = std::to_string(inches / 12) + " ft" + (inches % 12 ? " " + std::to_string(inches % 12) : "");
				}
				{
					const double rg = DblOr(s, "regen", 0.0);
					char buf[32];
					std::snprintf(buf, sizeof(buf), "%.1f%% health/s", rg);
					body["regen"] = rg > 0.05 ? std::string(buf) : std::string("Barely");
				}
				const auto soul = StrOr(s, "soul");
				body["soul"] = soul == "black" ? "Black" : soul == "dragon" ? "Dragon" : soul == "none" ? "None" : soul;
				if (const auto ms = StrOr(s, "mass"); !ms.empty())
					body["mass"] = ms;
				if (const auto sp = StrOr(s, "speed"); !sp.empty())
					body["speed"] = sp;
				v["body"] = body;

				// what works on it: the engine's answers, read when it was met
				if (const auto& aff = ObjOr(s, "aff"); !aff.empty()) {
					json out      = aff;
					const int was = NumOr(s, "affLvl", level);
					if (was != level)
						for (auto it = out.begin(); it != out.end(); ++it)
							if (it.value().is_object() && it.value().contains("cap"))
								it.value()["why"] = "read when last met (level " + std::to_string(was) + ")";
					v["affects"] = out;
				} else {
					// an older capture: the flags the engine states plainly, the rest
					// "not read yet" until the creature is met again
					json aff2;
					const bool undead = BoolOr(s, "undead", false), summoned = BoolOr(s, "summoned", false);
					aff2["turn"]   = undead ? json::array({ "yes", "Flees or burns" }) : json::array({ "na", "Not undead" });
					aff2["banish"] = summoned ? json::array({ "yes", "Sent back to Oblivion" }) : json::array({ "na", "Not summoned" });
					aff2["silver"] = (undead || BoolOr(s, "werebeast", false)) ? json::array({ "weak", "Extra damage" }) : json::array({ "no", "No extra harm" });
					aff2["sun"]    = undead ? json::array({ "weak", "Sun spells do more" }) : json::array({ "no", "No extra harm" });
					if (soul == "none")
						aff2["soultrap"] = json::array({ "no", summoned ? "A summon leaves no soul" : "No soul to take" });
					else if (soul == "dragon")
						aff2["soultrap"] = json::array({ "na", "You absorb its soul" });
					else
						aff2["soultrap"] = json::array({ "yes", (soul == "black" ? std::string("Black") : soul) + " soul" });
					v["affects"] = aff2;
				}

				if (const auto& st = ObjOr(s, "style"); !st.empty()) {
					const double a = DblOr(st, "melee", 0.0), b = DblOr(st, "ranged", 0.0), c = DblOr(st, "magic", 0.0), d = DblOr(st, "shout", 0.0);
					const double sum = a + b + c + d;
					if (sum > 0.01) {
						auto pc = [&](double x) { return static_cast<int>(std::lround(100.0 * x / sum)); };
						json sv{ { "melee", pc(a) }, { "ranged", pc(b) }, { "magic", pc(c) }, { "shout", pc(d) }, { "other", 0 } };
						if (st.contains("basis"))
							sv["basis"] = StrOr(st, "basis", "csty");
						if (st.contains("offense"))
							sv["offense"] = StrOr(st, "offense");
						v["style"] = sv;
					}
				}
				static const char* kAgg[]  = { "Unaggressive", "Aggressive", "Very aggressive", "Frenzied" };
				static const char* kConf[] = { "Flees at once", "Flees when hurt", "Flees when badly hurt", "Rarely flees", "Never flees" };
				json fights;
				if (const double r = DblOr(s, "reachM", 0.0); r > 0.05) {
					char buf[16];
					std::snprintf(buf, sizeof(buf), "%.1f m", r);
					fights["reach"] = buf;
				}
				fights["temper"]  = kAgg[std::clamp(NumOr(s, "aggression", 0), 0, 3)];
				fights["courage"] = kConf[std::clamp(NumOr(s, "confidence", 2), 0, 4)];
				if (const auto pw = StrOr(s, "power"); !pw.empty())
					fights["power"] = pw;
				v["fights"] = fights;
				if (s.contains("carries"))
					v["carries"] = s["carries"];
			} else
				v["threat"] = json{ { "tier", 0 } };

			// your fights with it
			{
				json rec;
				const auto& fr = ObjOr(s, "fight");
				const int   nF = NumOr(fr, "n", 0);
				if (nF > 0) {
					if (const int x = NumOr(fr, "fastestS", -1); x >= 0)
						rec["fastest"] = Duration(x);
					if (const int x = NumOr(fr, "longestS", -1); x >= 0 && nF > 1)
						rec["longest"] = Duration(x);
					if (const int x = NumOr(fr, "closestPct", 100); x < 100)
						rec["closest"] = "Down to " + std::to_string(std::max(x, 0)) + "% health";
					rec["ambushed"] = std::to_string(NumOr(fr, "ambushedN", 0)) + " of " + std::to_string(nF) + " fight" + (nF == 1 ? "" : "s");
				}
				const int deaths = NumOr(s, "deaths", 0);
				if (!rec.empty() || deaths > 0) {
					std::map<std::string, int> perDay;
					for (const auto& row : ArrOr(s, "log"))
						if (row.is_object() && StrOr(row, "what") != "Studied")
							++perDay[StrOr(row, "when")];
					std::string bestDay;
					int         bestN = 1;
					for (const auto& [day, n] : perDay)
						if (n > bestN && !day.empty()) {
							bestN   = n;
							bestDay = day;
						}
					if (!bestDay.empty())
						rec["bestDay"] = std::to_string(bestN) + " in one day \xC2\xB7 " + bestDay;
					rec["deaths"] = deaths;
					v["records"]  = rec;
				}
			}

			// tally + regions + log
			json ty;
			ty["slain"]      = NumOr(s, "slain", 0);
			ty["companions"] = NumOr(s, "companions", 0);
			auto meet = [](const json& m) { return StrOr(m, "when") + " \xC2\xB7 " + StrOr(m, "where"); };
			if (s.contains("first"))
				ty["first"] = meet(s["first"]);
			if (s.contains("last"))
				ty["last"] = meet(s["last"]);
			if (s.contains("biggest"))
				ty["biggest"] = s["biggest"];
			if (const auto& ws = ObjOr(s, "weapons"); !ws.empty()) {
				std::string best;
				int         bn = 0;
				for (auto it = ws.begin(); it != ws.end(); ++it)
					if (it.value().is_number_integer() && it.value().get<int>() > bn) {
						bn   = it.value().get<int>();
						best = it.key();
					}
				if (bn > 0)
					ty["weapon"] = best + ", " + std::to_string(bn) + " of " + std::to_string(NumOr(s, "slain", 0));
			}
			v["tally"] = ty;
			auto regs = json::array();
			if (const auto& rg = ObjOr(s, "regions"); !rg.empty())
				for (auto it = rg.begin(); it != rg.end(); ++it)
					regs.push_back(json{ { "id", StrOr(it.value(), "id", "other") }, { "name", StrOr(it.value(), "name") }, { "n", NumOr(it.value(), "n", 0) } });
			std::sort(regs.begin(), regs.end(), [](const json& x, const json& y) { return NumOr(x, "n", 0) > NumOr(y, "n", 0); });
			if (regs.size() > 4)
				regs.erase(regs.begin() + 4, regs.end());
			v["regions"] = regs;
			if (s.contains("log"))
				v["log"] = s["log"];
			{
				json lore = ObjOr(s, "lore").empty() ? json{ { "state", "none" } } : ObjOr(s, "lore");
				// an older view reads `error`; keep it in step with lastError
				if (StrOr(lore, "state") == "error" && !lore.contains("error"))
					lore["error"] = StrOr(lore, "lastError", "The Scribe could not write this page.");
				v["lore"] = lore;
			}
			if (const auto n = StrOr(s, "notes"); !n.empty())
				v["notes"] = n;

			// The reader's edits win over anything measured or written: each
			// edited field replaces (or, for an object, patches) what the engine
			// said, and the view is told which fields are the reader's own.
			if (const auto& ed = ObjOr(s, "edits"); !ed.empty()) {
				auto edited = json::array();
				for (auto it = ed.begin(); it != ed.end(); ++it) {
					if (it.value().is_object() && v.contains(it.key()) && v[it.key()].is_object())
						v[it.key()].merge_patch(it.value());
					else
						v[it.key()] = it.value();
					edited.push_back(it.key());
				}
				v["edited"] = edited;
			}
			return v;
		}

		// Chapters as the LOAD ORDER defines them: races carrying each chapter's
		// keyword, and the plugins of the ones the book has not met. Cached: the
		// race list does not change while the game runs.
		json g_chaptersCache;
		json Chapters(const json& entries)
		{
			if (g_chaptersCache.is_null()) {
				json c = json::object();
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					for (auto* race : dh->GetFormArray<RE::TESRace>()) {
						if (!race || !race->skin)
							continue;
						const auto ch = ChapterOf(race);
						const auto eid = EditorId(race);
						std::string f, p;
						ActorIdentity::DurableOf(race, f, p);
						auto& slot = c[ch];
						// c[ch] is NULL the first time a chapter is seen, and value() on a null json
						// throws type_error.306 - the 2026-10-09 CTD on the first load with the Bestiary
						if (!slot.is_object())
							slot = json::object();
						slot["known"] = NumOr(slot, "known", 0) + 1;
						if (!slot.contains("races"))
							slot["races"] = json::array();
						slot["races"].push_back(json{ { "key", eid.empty() ? f + "|" + p : eid }, { "plugin", p.empty() ? PluginOf(race) : p } });
					}
				}
				g_chaptersCache = c;
			}
			std::set<std::string> met;
			for (auto it = entries.begin(); it != entries.end(); ++it)
				met.insert(StrOr(it.value(), "raceKey"));
			json out = json::object();
			for (auto it = g_chaptersCache.begin(); it != g_chaptersCache.end(); ++it) {
				auto unseen   = json::array();
				json byPlugin = json::object();
				for (const auto& r : ArrOr(it.value(), "races")) {
					const auto key  = StrOr(r, "key");
					const auto plug = StrOr(r, "plugin");
					const bool was  = met.count(key) > 0;
					if (!was && unseen.size() < 12)
						unseen.push_back(plug);
					auto& bp = byPlugin[plug.empty() ? "?" : plug];
					if (!bp.is_object())
						bp = json{ { "known", 0 }, { "met", 0 } };
					bp["known"] = NumOr(bp, "known", 0) + 1;
					if (was)
						bp["met"] = NumOr(bp, "met", 0) + 1;
				}
				out[it.key()] = json{ { "known", NumOr(it.value(), "known", 0) }, { "unseen", unseen }, { "byPlugin", byPlugin } };
			}
			return out;
		}

		json ScribeView()
		{
			const auto key = ReadKey();
			const json& s  = ObjOr(g_db, "scribe");
			json v         = { { "keyState", key.empty() ? "none" : "saved" }, { "key", Masked(key) },
                { "model", StrOr(s, "model", "deepseek/deepseek-v3.1-terminus") },
                { "voice", StrOr(s, "voice", "scholar") }, { "length", StrOr(s, "length", "standard") },
                { "codex", false }, { "chim", false }, { "auto", BoolOr(s, "auto", true) }, { "spoilers", BoolOr(s, "spoilers", false) } };
			if (s.contains("credit"))
				v["credit"] = s["credit"];
			v["lessons"] = ArrOr(g_db, "lessons");
			return v;
		}

		void EnsureRendersLocked()
		{
			if (!ItemIcons::Available())
				return;
			auto items = json::array();
			for (auto it = g_db["entries"].begin(); it != g_db["entries"].end(); ++it) {
				const auto& s = it.value();
				if (!s.is_object() || !s.contains("skin") || StrOr(s, "chapter") == "folk")
					continue;
				const auto& sk = ObjOr(s, "skin");
				if (sk.empty())
					continue;
				const auto art = ArtFor(sk);
				// the 512 first (fast, and the medals' size), then the page's 1024
				if (art.img.empty())
					items.push_back(json{ { "formId", StrOr(sk, "fid") }, { "plugin", StrOr(sk, "plugin") },
						{ "name", StrOr(s, "name") }, { "nif", StrOr(sk, "nif") } });
				if (!art.hi)
					ItemIcons::EnsureBeastBody(StrOr(sk, "fid"), StrOr(sk, "plugin"), StrOr(s, "name"), StrOr(sk, "nif"));
			}
			if (!items.empty())
				ItemIcons::EnsureBodyIcons(json{ { "items", items } }.dump(-1, ' ', false, json::error_handler_t::replace));
		}

		std::string EntryJsonLocked(const std::string& id)
		{
			const auto& all = g_db["entries"];
			if (!all.contains(id))
				return {};
			const auto groups = BuildGroups(all);
			return EntryView(id, all[id], Player(), &groups).dump(-1, ' ', false, json::error_handler_t::replace);
		}

		/* ------------------------------------------------------------ lore --- */
		// The Scribe, made durable (2026-10-10): a rewrite keeps the old page up
		// until the new one lands (lore.pending), a failure keeps it too and says
		// why (lastError + errorKind), requests queue instead of being refused,
		// and a 429/5xx/timeout is retried once.
		struct LoreJob
		{
			std::string id, key, payload, model;
		};
		std::deque<LoreJob> g_loreQueue;     // under g_m
		int                 g_loreWorkers = 0;   // under g_m; at most 2

		const char* ErrorKind(DWORD status)
		{
			if (status == 401)
				return "key";
			if (status == 402)
				return "credit";
			if (status == 429)
				return "rate";
			if (status == 0 || status >= 500)
				return "net";
			return "other";
		}

		// What the model sends back is not always a page: reasoning blocks,
		// "Here is the entry:" preambles, markdown, a plugin name it was told
		// not to repeat. Strip all of it; cut a page the token limit truncated
		// back to its last whole sentence.
		std::string CleanLore(std::string t, bool truncated)
		{
			for (;;) {
				const auto a = t.find("<think>");
				if (a == std::string::npos)
					break;
				const auto b = t.find("</think>", a);
				t.erase(a, b == std::string::npos ? std::string::npos : b + 8 - a);
			}
			std::stringstream ss(t);
			std::string       line, out;
			bool              any = false;
			while (std::getline(ss, line)) {
				if (!line.empty() && line.back() == '\r')
					line.pop_back();
				const auto tr  = Trim(line);
				const auto low = Lower(tr);
				if (!tr.empty() && tr[0] == '#')
					continue;
				if (low.find(".esp") != std::string::npos || low.find(".esm") != std::string::npos || low.find(".esl") != std::string::npos)
					continue;
				if (!tr.empty() && tr.find_first_not_of("-*=_ ") == std::string::npos)
					continue;
				if (!any && !tr.empty() && tr.back() == ':' &&
					(low.rfind("here is", 0) == 0 || low.rfind("here's", 0) == 0 || low.rfind("sure", 0) == 0 || low.rfind("certainly", 0) == 0))
					continue;
				std::string clean;
				for (std::size_t i = 0; i < line.size(); ++i) {
					if (line[i] == '*')
						continue;
					if (line[i] == '_' && i + 1 < line.size() && line[i + 1] == '_') {
						++i;
						continue;
					}
					clean += line[i];
				}
				if (!Trim(clean).empty())
					any = true;
				out += clean + "\n";
			}
			if (truncated) {
				const auto end = out.find_last_of(".!?");
				if (end != std::string::npos) {
					std::size_t cut = end + 1;
					while (cut < out.size() && (out[cut] == '"' || out[cut] == '\'' || out[cut] == ')'))
						++cut;
					out.erase(cut);
				}
			}
			return out;
		}

		void FinishLore(const std::string& id, bool ok, const std::string& textOrErr, const std::string& model, DWORD status, bool truncated)
		{
			std::string payload;
			{
				std::lock_guard l(g_m);
				g_loreAsked.erase(id);
				auto& all = g_db["entries"];
				if (!all.contains(id) || !all[id].is_object())
					return;
				auto& e   = all[id];
				json  old = ObjOr(e, "lore");
				const bool hadText = old.contains("text") && old["text"].is_array() && !old["text"].empty();
				auto paras = json::array();
				if (ok) {
					std::stringstream ss(CleanLore(textOrErr, truncated));
					std::string line, cur;
					auto flush = [&]() {
						auto t = Trim(cur);
						if (!t.empty())
							paras.push_back(t);
						cur.clear();
					};
					while (std::getline(ss, line)) {
						if (Trim(line).empty())
							flush();
						else
							cur += (cur.empty() ? "" : " ") + Trim(line);
					}
					flush();
				}
				if (!paras.empty()) {
					json lo{ { "state", "done" }, { "text", paras }, { "by", "Written by the Scribe \xC2\xB7 " + model } };
					if (truncated)
						lo["truncated"] = true;
					e["lore"] = lo;
					// a rewrite the reader asked for replaces their hand-written page;
					// what they corrected stays on as lessons and in their other edits
					if (e.contains("edits") && e["edits"].is_object())
						e["edits"].erase("lore");
				} else {
					const std::string why = ok ? "The Scribe returned an empty page." : textOrErr;
					old.erase("pending");
					old["lastError"] = why;
					old["errorKind"] = ok ? "other" : ErrorKind(status);
					if (hadText)
						old["state"] = "done";   // the old page stays readable
					else {
						old["state"] = "error";
						old["error"] = why;      // the older view's field
					}
					e["lore"] = old;
				}
				SaveLocked();
				payload = EntryJsonLocked(id);
			}
			if (!payload.empty())
				Push("bxEntry", payload);
		}

		// One worker drains the queue; at most two run at once.
		void LoreWorker()
		{
			for (;;) {
				LoreJob job;
				{
					std::lock_guard l(g_m);
					if (g_loreQueue.empty()) {
						--g_loreWorkers;
						return;
					}
					job = std::move(g_loreQueue.front());
					g_loreQueue.pop_front();
				}
				// a throw inside one request must not strand the worker count or
				// leave the page "writing" for the rest of the session
				const bool done = Guarded("lore request", [&]() -> bool {
					std::string text, err, finish;
					DWORD       status = 0;
					for (int attempt = 0; attempt < 2; ++attempt) {
						auto r = OpenRouter(L"POST", L"/api/v1/chat/completions", job.key, job.payload, 60000);
						status = r.status;
						err    = r.error;
						text.clear();
						if (r.ok) {
							auto j = json::parse(r.body, nullptr, false);
							if (j.is_discarded() || !j.is_object())
								err = "OpenRouter answered with something that is not JSON.";
							else if (j.contains("error") && j["error"].is_object()) {
								// a 200 can still carry an error (the upstream provider failed)
								const auto& er = j["error"];
								err    = "OpenRouter: " + StrOr(er, "message", "the model failed");
								status = static_cast<DWORD>(NumOr(er, "code", 0));
							} else if (j.contains("choices") && j["choices"].is_array() && !j["choices"].empty() && j["choices"][0].is_object()) {
								const auto& ch = j["choices"][0];
								if (ch.contains("error") && ch["error"].is_object()) {
									err    = "OpenRouter: " + StrOr(ch["error"], "message", "the model failed");
									status = static_cast<DWORD>(NumOr(ch["error"], "code", 0));
								} else {
									text   = StrOr(ObjOr(ch, "message"), "content");
									finish = StrOr(ch, "finish_reason");
									if (text.empty())
										err = "OpenRouter answered, but with no text.";
								}
							} else
								err = "OpenRouter answered, but with no text.";
						}
						const bool retry = text.empty() && (status == 429 || status == 0 || status >= 500) && attempt == 0;
						if (!retry)
							break;
						logger::info("bestiary: lore for '{}' answered {} - one retry in 4 s", job.id, status);
						std::this_thread::sleep_for(std::chrono::seconds(4));
					}
					const bool truncated = finish == "length";
					logger::info("bestiary: lore for '{}' {} ({})", job.id, text.empty() ? "failed" : "written", text.empty() ? err : job.model);
					if (auto* ti = SKSE::GetTaskInterface())
						ti->AddTask([id = job.id, ok = !text.empty(), out = text.empty() ? err : text, model = job.model, status, truncated]() {
							Guarded("lore finish", [&]() { FinishLore(id, ok, out, model, status, truncated); });
						});
					return true;
				});
				if (!done)
					if (auto* ti = SKSE::GetTaskInterface())
						ti->AddTask([id = job.id, model = job.model]() {
							Guarded("lore finish", [&]() { FinishLore(id, false, "The Scribe's request failed (see the log).", model, 0, false); });
						});
			}
		}

		// The facts block, in WORDS: what the page says, never its numbers (the
		// model is told to keep numbers out, and a number it is shown it repeats).
		std::string DossierLocked(const std::string& id, const json& s)
		{
			const auto groups = BuildGroups(g_db["entries"]);
			const json v      = EntryView(id, s, Player(), &groups);
			std::string d;
			auto line = [&](const std::string& k, const std::string& val) {
				if (!val.empty())
					d += "- " + k + ": " + val + "\n";
			};
			line("Name", StrOr(v, "name"));
			line("Family", StrOr(v, "family"));
			if (StrOr(v, "race") != StrOr(v, "family"))
				line("Race", StrOr(v, "race"));
			line("Kind", StrOr(v, "chapter"));
			if (BoolOr(v, "unique", false))
				line("Unique", "there is only one of it");
			line("Threat to the reader", StrOr(ObjOr(v, "threat"), "word"));
			{
				const auto& b = ObjOr(v, "body");
				line("Build", StrOr(b, "mass"));
				line("Speed", StrOr(b, "speed"));
				line("Soul", StrOr(b, "soul"));
			}
			{
				const auto& f = ObjOr(v, "fights");
				line("Temper", StrOr(f, "temper"));
				line("Courage", StrOr(f, "courage"));
				line("Power attacks", StrOr(f, "power"));
			}
			{
				std::string t;
				for (const auto& x : ArrOr(v, "traits"))
					if (x.is_string())
						t += (t.empty() ? "" : "; ") + x.get<std::string>();
				line("Abilities", t);
				std::string a;
				for (const auto& x : ArrOr(v, "arsenal"))
					a += (a.empty() ? "" : "; ") + StrOr(x, "name") + (StrOr(x, "element").empty() ? "" : " (" + StrOr(x, "element") + ")");
				line("Turns on you", a);
				std::string at;
				for (const auto& x : ArrOr(v, "attacks"))
					at += (at.empty() ? "" : "; ") + StrOr(x, "name");
				line("Attacks", at);
			}
			{
				std::string more, less;
				for (auto it = ObjOr(v, "resist").begin(); it != ObjOr(v, "resist").end(); ++it) {
					const int r = it.value().is_number() ? it.value().get<int>() : 0;
					if (r < 0)
						more += (more.empty() ? "" : ", ") + it.key();
					else if (r >= 50)
						less += (less.empty() ? "" : ", ") + it.key();
				}
				line("Takes more harm from", more);
				line("Shrugs off", less);
			}
			{
				const auto& ty = ObjOr(v, "tally");
				const int slain = NumOr(ty, "slain", 0), comp = NumOr(ty, "companions", 0);
				line("The reader has killed", slain == 0 ? "none yet" : slain == 1 ? "one" : slain < 5 ? "a few" : slain < 20 ? "many" : "a great many");
				if (comp > 0)
					line("Companions have killed", comp == 1 ? "one" : "several");
				line("First met", StrOr(ty, "first"));
			}
			{
				std::string lg;
				int         n = 0;
				for (const auto& row : ArrOr(v, "log")) {
					if (!row.is_object() || n >= 5)
						break;
					lg += "\n  - " + StrOr(row, "when") + ": " + StrOr(row, "what") + " at " + StrOr(row, "where");
					++n;
				}
				if (!lg.empty())
					d += "- Latest meetings (in-game dates):" + lg + "\n";
			}
			// MEASURED: what the engine said works on it, in words
			{
				static const std::pair<const char*, const char*> kFam[] = {
					{ "calm", "Calm" }, { "fear", "Fear" }, { "frenzy", "Frenzy" }, { "paralysis", "Paralysis" },
					{ "soultrap", "Soul Trap" }, { "turn", "Turn Undead" }, { "banish", "Banishing" }, { "silver", "Silver" },
					{ "sun", "Sun magic" }, { "force", "Unrelenting Force" }, { "disarm", "Disarm" }, { "command", "Command" }, { "reanimate", "Raising its corpse" }
				};
				std::string m;
				const auto& aff = ObjOr(v, "affects");
				for (const auto& [k, label] : kFam) {
					const auto it = aff.find(k);
					if (it == aff.end())
						continue;
					std::string st = it->is_object() ? StrOr(*it, "s") : (it->is_array() && !it->empty() && (*it)[0].is_string() ? (*it)[0].get<std::string>() : "");
					std::string word = st == "yes" ? "works on it" : st == "no" ? "does not work on it" : st == "part" ? "works, but it resists" :
					                   st == "perk" ? "works only for a master of the art" : st == "weak" ? "harms it more than most" :
					                   st == "normal" ? "harms it no more than anything else" : "";
					if (!word.empty())
						m += "\n  - " + std::string(label) + ": " + word;
				}
				if (!m.empty())
					d += "- MEASURED (what works on it):" + m + "\n";
			}
			if (auto notes = StrOr(s, "notes"); !notes.empty()) {
				if (notes.size() > 800)
					notes = Utf8Cut(notes, 800);
				d += "- The reader's own notes (TRUE - keep to them):\n" + notes + "\n";
			}
			return d;
		}

		void RequestLoreLocked(const std::string& id, bool /*rewrite*/)
		{
			auto& all = g_db["entries"];
			if (!all.contains(id) || !all[id].is_object() || g_loreAsked.count(id))
				return;
			auto&      e   = all[id];
			const auto key = ReadKey();
			if (key.empty()) {
				if (!ObjOr(e, "lore").contains("text"))
					e["lore"] = json{ { "state", "none" } };
				return;
			}
			const auto& s     = e;
			const auto  sc    = ScribeView();
			const auto  model = StrOr(sc, "model");
			const auto  voice = StrOr(sc, "voice", "scholar");
			const auto  len   = StrOr(sc, "length", "standard");
			const bool  spoil = BoolOr(sc, "spoilers", false);

			std::string voiceLine = voice == "hunter" ? "a terse, practical hunter's field notes" :
			                        voice == "tavern" ? "a tall tale told in a Skyrim tavern, colourful but still about this creature" :
			                                            "a scholar of the College of Winterhold writing a measured bestiary entry";
			std::string lenLine = len == "short" ? "one paragraph of about 60 words" :
			                      len == "long"  ? "three paragraphs of about 80 words each: what it is, where and how it lives, and how to hunt it" :
			                                       "two paragraphs of about 70 words each";
			// the reader's own corrections to this page are facts, and outrank the measurement
			json readerFacts = json::object();
			for (auto it = ObjOr(s, "edits").begin(); it != ObjOr(s, "edits").end(); ++it)
				if (it.key() != "lore")
					readerFacts[it.key()] = it.value();
			std::string learned;
			{
				const auto& ls = ArrOr(g_db, "lessons");
				const std::size_t from = ls.size() > 25 ? ls.size() - 25 : 0;
				for (std::size_t i = from; i < ls.size(); ++i)
					if (ls[i].is_object() && StrOr(ls[i], "scope", "all") == "all")
						learned += "\n- " + StrOr(ls[i], "text");
				for (const auto& c : ArrOr(s, "corrections"))
					if (c.is_string())
						learned += "\n- (about this creature) " + c.get<std::string>();
			}
			std::string readerPage;
			for (const auto& para : ArrOr(ObjOr(ObjOr(s, "edits"), "lore"), "text"))
				if (para.is_string())
					readerPage += para.get<std::string>() + "\n\n";
			std::string places;
			for (auto it = ObjOr(s, "regions").begin(); it != ObjOr(s, "regions").end(); ++it)
				places += (places.empty() ? "" : ", ") + StrOr(it.value(), "name");
			std::string dossier = DossierLocked(id, s);
			if (!places.empty())
				dossier += "- Where the reader met it: " + places + "\n";

			json body{ { "model", model }, { "max_tokens", 1100 }, { "temperature", 0.8 }, { "reasoning", json{ { "exclude", true } } },
				{ "messages", json::array({
					json{ { "role", "system" }, { "content",
						"You write entries for a bestiary inside The Elder Scrolls V: Skyrim, read by the player in-game. "
						"Write as " + voiceLine + ". Write " + lenLine + ". Plain prose only: no title, no headings, no lists, no markdown, no preamble. "
						"Stay inside Tamriel: no modern words, no game mechanics, no numbers, no file or plugin names. "
						"Use Elder Scrolls lore you are sure of. If the creature is not from the base game or you do not know it, "
						"describe it only from the facts given and do not invent named history. "
						"Claims about what harms, resists or works on it come ONLY from MEASURED; never invent a weakness. " +
						std::string(spoil ? "Quest lore may be mentioned." : "Do not reveal quest plots or name quest-specific characters.") +
						(learned.empty() ? std::string() : "\nThe reader has corrected this book before. Always follow these corrections:" + learned) } },
					json{ { "role", "user" }, { "content", "Write the entry for this creature.\nFacts:\n" + dossier +
						(readerFacts.empty() ? std::string() : "\nThe reader set these facts by hand; they are correct and outrank the facts above: " + readerFacts.dump()) +
						(readerPage.empty() ? std::string() : "\nThe reader's own version of this page, whose facts you must keep:\n" + readerPage) } } }) } };

			// the old page stays up while the new one is written
			json lo = ObjOr(e, "lore");
			const bool hasText = lo.contains("text") && lo["text"].is_array() && !lo["text"].empty();
			lo["state"]   = hasText ? "done" : "writing";
			lo["pending"] = json{ { "model", model }, { "at", Today() } };
			lo.erase("lastError");
			lo.erase("errorKind");
			lo.erase("error");
			e["lore"] = lo;
			g_loreAsked.insert(id);
			g_loreQueue.push_back(LoreJob{ id, key, body.dump(-1, ' ', false, json::error_handler_t::replace), model });
			logger::info("bestiary: lore queued for '{}' ({} waiting, {} writing)", id, g_loreQueue.size(), g_loreWorkers);
			if (g_loreWorkers < 2) {
				++g_loreWorkers;
				std::thread([]() { LoreWorker(); }).detach();
			}
		}

		/* ---------------------------------------------- your fights with it -- */
		// Combat opens a fight when a creature turns on the player; hits on the
		// player keep the lowest health each open fight saw; the death closes it
		// into the page's records. Real seconds (GetTickCount64), not game time.
		struct FightRec
		{
			std::string   kindId;
			std::uint64_t startTick = 0;
			bool          ambushed  = false;
			int           lowHpPct  = 100;
		};
		std::mutex                                      g_fm;   // the two maps below; may be taken inside g_m, never the reverse
		std::unordered_map<std::uint32_t, FightRec>      g_fights;          // by the creature's ref id, at most 32
		std::unordered_map<std::uint32_t, std::uint64_t> g_lastPlayerHit;   // ref id -> tick the player last struck it

		void OpenFight(RE::Actor* a)
		{
			const auto kind = KindIdOf(a);
			if (kind.empty())
				return;
			const auto now = GetTickCount64();
			std::lock_guard l(g_fm);
			const auto fid = a->GetFormID();
			if (g_fights.count(fid))
				return;
			if (g_fights.size() >= 32) {
				auto oldest = g_fights.begin();
				for (auto it = g_fights.begin(); it != g_fights.end(); ++it)
					if (it->second.startTick < oldest->second.startTick)
						oldest = it;
				g_fights.erase(oldest);
			}
			// it engaged first unless the player struck it in the last three seconds
			const auto hit  = g_lastPlayerHit.find(fid);
			const bool ours = hit != g_lastPlayerHit.end() && now - hit->second < 3000;
			g_fights[fid]   = FightRec{ kind, now, !ours, 100 };
		}

		// Close the fight for a creature that just died into its page. g_m held.
		void CloseFightLocked(RE::Actor* a, json& e)
		{
			FightRec rec;
			{
				std::lock_guard l(g_fm);
				const auto it = g_fights.find(a->GetFormID());
				if (it == g_fights.end())
					return;
				rec = it->second;
				g_fights.erase(it);
				g_lastPlayerHit.erase(a->GetFormID());
			}
			const int secs = static_cast<int>((GetTickCount64() - rec.startTick) / 1000);
			auto&     f    = e["fight"];
			if (!f.is_object())
				f = json::object();
			const int n = NumOr(f, "n", 0) + 1;
			f["n"]        = n;
			f["fastestS"] = f.contains("fastestS") ? std::min(NumOr(f, "fastestS", secs), secs) : secs;
			f["longestS"] = f.contains("longestS") ? std::max(NumOr(f, "longestS", secs), secs) : secs;
			f["closestPct"] = std::min(NumOr(f, "closestPct", 100), rec.lowHpPct);
			f["ambushedN"]  = NumOr(f, "ambushedN", 0) + (rec.ambushed ? 1 : 0);
			logger::info("bestiary: fight closed with '{}' after {} s (lowest {}%, {})", rec.kindId, secs, rec.lowHpPct,
				rec.ambushed ? "it struck first" : "you struck first");
		}

		class CombatSink final : public RE::BSTEventSink<RE::TESCombatEvent>
		{
		public:
			static CombatSink* GetSingleton()
			{
				static CombatSink s;
				return &s;
			}
			RE::BSEventNotifyControl ProcessEvent(const RE::TESCombatEvent* ev, RE::BSTEventSource<RE::TESCombatEvent>*) override
			{
				if (!ev || !ev->actor)
					return RE::BSEventNotifyControl::kContinue;
				const auto state = ev->newState.get();
				RE::NiPointer<RE::TESObjectREFR> who = ev->actor;
				if (state == RE::ACTOR_COMBAT_STATE::kCombat) {
					if (!ev->targetActor || !ev->targetActor->IsPlayerRef() || who->IsPlayerRef())
						return RE::BSEventNotifyControl::kContinue;
					SKSE::GetTaskInterface()->AddTask([who]() {
						Guarded("combat", [&]() {
							if (auto* a = who ? who->As<RE::Actor>() : nullptr; a && !a->IsDead())
								OpenFight(a);
						});
					});
				} else if (state == RE::ACTOR_COMBAT_STATE::kNone) {
					// it left combat ALIVE: no fight to record. A creature that dies
					// leaves combat too, and the engine says so before the death
					// event's task runs, so a dead or dying one keeps its fight for
					// DeathSink -> CloseFightLocked to close (and to write the
					// page's records). Decided a frame later, on the main thread,
					// where IsDead() is settled; a fight that outlives it all is
					// bounded by the 32-fight cap and the next death sweep.
					if (auto* a = who->As<RE::Actor>(); a && a->IsDead())
						return RE::BSEventNotifyControl::kContinue;
					SKSE::GetTaskInterface()->AddTask([who]() {
						Guarded("combat-end", [&]() {
							auto* a = who ? who->As<RE::Actor>() : nullptr;
							if (!a || a->IsDead())
								return;
							std::lock_guard l(g_fm);
							g_fights.erase(a->GetFormID());
						});
					});
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		class HitSink final : public RE::BSTEventSink<RE::TESHitEvent>
		{
		public:
			static HitSink* GetSingleton()
			{
				static HitSink s;
				return &s;
			}
			RE::BSEventNotifyControl ProcessEvent(const RE::TESHitEvent* ev, RE::BSTEventSource<RE::TESHitEvent>*) override
			{
				if (!ev || !ev->target)
					return RE::BSEventNotifyControl::kContinue;
				if (ev->cause && ev->cause->IsPlayerRef() && !ev->target->IsPlayerRef()) {
					std::lock_guard l(g_fm);
					const auto now = GetTickCount64();
					if (g_lastPlayerHit.size() > 64)
						for (auto it = g_lastPlayerHit.begin(); it != g_lastPlayerHit.end();)
							it = now - it->second > 10000 ? g_lastPlayerHit.erase(it) : std::next(it);
					g_lastPlayerHit[ev->target->GetFormID()] = now;
					return RE::BSEventNotifyControl::kContinue;
				}
				if (ev->target->IsPlayerRef()) {
					{
						std::lock_guard l(g_fm);
						if (g_fights.empty())
							return RE::BSEventNotifyControl::kContinue;
					}
					// the damage lands after the event; read the bar a frame later
					SKSE::GetTaskInterface()->AddTask([]() {
						Guarded("hit", []() {
							auto* pc = RE::PlayerCharacter::GetSingleton();
							if (!pc)
								return;
							auto*       avo = pc->AsActorValueOwner();
							const float max = avo->GetPermanentActorValue(RE::ActorValue::kHealth);
							if (max <= 0.0f)
								return;
							const int pct = std::clamp(static_cast<int>(std::lround(100.0f * avo->GetActorValue(RE::ActorValue::kHealth) / max)), 0, 100);
							std::lock_guard l(g_fm);
							for (auto& [id, f] : g_fights)
								f.lowHpPct = std::min(f.lowHpPct, pct);
						});
					});
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		/* ------------------------------------------------------- the sink --- */
		class DeathSink final : public RE::BSTEventSink<RE::TESDeathEvent>
		{
		public:
			static DeathSink* GetSingleton()
			{
				static DeathSink s;
				return &s;
			}
			RE::BSEventNotifyControl ProcessEvent(const RE::TESDeathEvent* ev, RE::BSTEventSource<RE::TESDeathEvent>*) override
			{
				if (!ev || !ev->dead || !ev->actorDying || !ev->actorKiller)
					return RE::BSEventNotifyControl::kContinue;
				RE::NiPointer<RE::TESObjectREFR> dying  = ev->actorDying;
				RE::NiPointer<RE::TESObjectREFR> killer = ev->actorKiller;
				SKSE::GetTaskInterface()->AddTask([dying, killer]() {
					Guarded("death", [&]() {
						auto* a = dying ? dying->As<RE::Actor>() : nullptr;
						auto* k = killer ? killer->As<RE::Actor>() : nullptr;
						if (!a || !k)
							return;
						// the player fell: a book kind that did it counts a death
						if (a->IsPlayerRef()) {
							if (k->IsPlayerRef())
								return;
							const auto kid = KindIdOf(k);
							{
								std::lock_guard f(g_fm);
								g_fights.clear();
							}
							if (kid.empty())
								return;
							std::lock_guard l(g_m);
							LoadLocked();
							auto& all = g_db["entries"];
							if (!all.contains(kid) || !all[kid].is_object())
								return;
							all[kid]["deaths"] = NumOr(all[kid], "deaths", 0) + 1;
							logger::info("bestiary: '{}' killed you ({} time(s) now)", kid, NumOr(all[kid], "deaths", 0));
							SaveLocked();
							return;
						}
						// credit: the player, or someone fighting at the player's side
						if (!k->IsPlayerRef() && !k->IsPlayerTeammate()) {
							std::lock_guard f(g_fm);
							g_fights.erase(a->GetFormID());
							return;
						}
						std::string id, payload;
						bool        autoLore = false;
						{
							std::lock_guard l(g_m);
							LoadLocked();
							id = MeasureLocked(a, "kill", k);
							if (id.empty())
								return;
							auto& e = g_db["entries"][id];
							CloseFightLocked(a, e);
							if (BoolOr(e, "new", false)) {
								e.erase("new");
								autoLore = BoolOr(ObjOr(g_db, "scribe"), "auto", true) && !ReadKey().empty();
							}
							if (autoLore)
								RequestLoreLocked(id, false);
							SaveLocked();
							EnsureRendersLocked();
							payload = EntryJsonLocked(id);
						}
						Push("bxEntry", payload);
					});
				});
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		/* ------------------------------------------------------ spin state -- */
		// Turntables being baked: id -> {fid, plugin, asked}. A render landing
		// re-reads the disk and answers bxSpinState again; 90 s without all eight
		// frames gives up honestly (baking:false) so the view stops waiting.
		struct SpinWait
		{
			std::string   fid, plugin;
			std::uint64_t since = 0;
			bool          hi    = false;   // the 1024 frames in icons/bestiary/
		};
		std::vector<std::uint32_t> AnglesOnDisk(const std::string& fid, const std::string& plugin, bool hi)
		{
			return hi ? ItemIcons::BeastAnglesOnDisk(fid, plugin) : ItemIcons::BodyAnglesOnDisk(fid, plugin);
		}
		std::map<std::string, SpinWait> g_spinWait;   // under g_m

		std::string SpinStateJson(const std::string& id, const std::vector<std::uint32_t>& frames, bool baking)
		{
			return json{ { "id", id }, { "frames", frames }, { "total", ItemIcons::kBodySpinFrames }, { "baking", baking } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// The public bodies, each run through Guarded by the namespace-level
		// wrappers below.
		std::string StateJsonImpl()
		{
			std::string text;
			{
				std::lock_guard l(g_m);
				LoadLocked();
				const auto p = Player();
				static std::uint32_t lastSig = 0;
				if (p.sig != lastSig) {
					lastSig = p.sig;
					++g_rev;
				}
				const auto& all    = g_db["entries"];
				const auto  groups = BuildGroups(all);
				json out;
				out["rev"]    = g_rev;
				out["player"] = json{ { "name", p.name }, { "level", p.level }, { "health", static_cast<int>(p.health) }, { "weapon", p.weapon },
					{ "resist", p.resist }, { "difficulty", p.difficulty }, { "dmg", static_cast<int>(std::lround(p.dmg)) } };
				out["scribe"] = ScribeView();
				auto arr = json::array();
				std::map<std::string, int> weapons, holds;
				std::map<std::string, std::string> holdNames;
				for (auto it = all.begin(); it != all.end(); ++it) {
					if (!it.value().is_object())
						continue;
					arr.push_back(EntryView(it.key(), it.value(), p, &groups));
					for (auto w = ObjOr(it.value(), "weapons").begin(); w != ObjOr(it.value(), "weapons").end(); ++w)
						if (w.value().is_number_integer())
							weapons[w.key()] += w.value().get<int>();
					for (auto r = ObjOr(it.value(), "regions").begin(); r != ObjOr(it.value(), "regions").end(); ++r) {
						holds[r.key()] += NumOr(r.value(), "n", 0);
						holdNames[r.key()] = StrOr(r.value(), "name");
					}
				}
				out["entries"]  = arr;
				out["chapters"] = Chapters(all);
				// the reader's own chapters (bxShelf), drawn after the built-in eleven
				out["shelves"] = g_db.contains("shelves") && g_db["shelves"].is_array() ? g_db["shelves"] : json::array();
				json totals     = json::object();
				auto top        = [](const std::map<std::string, int>& m) {
                    std::string k;
                    int         n = 0;
                    for (const auto& [kk, vv] : m)
                        if (vv > n) {
                            n = vv;
                            k = kk;
                        }
                    return k;
				};
				if (auto w = top(weapons); !w.empty())
					totals["weapon"] = w;
				if (auto h = top(holds); !h.empty())
					totals["hold"] = holdNames[h];
				out["totals"] = totals;
				if (const auto& latest = ObjOr(g_db, "latest"); !latest.empty() && all.contains(StrOr(latest, "id")))
					out["latest"] = latest;
				EnsureRendersLocked();
				text = out.dump(-1, ' ', false, json::error_handler_t::replace);
			}
			logger::info("bestiary: state {} bytes", text.size());
			return text;
		}
	}

	void SetPush(PushFn fn) { g_push = std::move(fn); }

	void Install()
	{
		if (auto* holder = RE::ScriptEventSourceHolder::GetSingleton()) {
			holder->AddEventSink<RE::TESDeathEvent>(DeathSink::GetSingleton());
			holder->AddEventSink<RE::TESCombatEvent>(CombatSink::GetSingleton());
			holder->AddEventSink<RE::TESHitEvent>(HitSink::GetSingleton());
			logger::info("bestiary: death sink installed");
			logger::info("bestiary: guarded readers armed (combat + hit sinks for fight records)");
		}
	}

	void OnPreLoad()
	{
		{
			std::lock_guard l(g_m);
			g_affCache.clear();   // another save: another player, other perks
		}
		std::lock_guard f(g_fm);
		g_fights.clear();
		g_lastPlayerHit.clear();
	}

	void Flush()
	{
		Guarded("flush", []() {
			std::lock_guard l(g_m);
			if (g_dirty)
				WriteNowLocked();
		});
	}

	// A render batch landed (main.cpp's ItemIcons batch-done hook): pages may
	// have a picture now, and a turntable being baked may have more frames.
	void OnRendersLanded()
	{
		Guarded("renders landed", []() {
			std::vector<std::pair<std::string, std::string>> pushes;
			{
				std::lock_guard l(g_m);
				// only a page that was still waiting for its picture can change
				// (item and face batches land here too, and must not bump rev)
				bool waiting = false;
				for (const auto& [k, art] : g_imgCache)
					if (art.img.empty() || !art.hi) {
						waiting = true;
						break;
					}
				g_imgCache.clear();
				if (waiting)
					++g_rev;
				const auto now = GetTickCount64();
				for (auto it = g_spinWait.begin(); it != g_spinWait.end();) {
					const auto frames = AnglesOnDisk(it->second.fid, it->second.plugin, it->second.hi);
					const bool done   = frames.size() >= ItemIcons::kBodySpinFrames;
					const bool stale  = now - it->second.since > 90000;
					pushes.emplace_back(it->first, SpinStateJson(it->first, frames, !done && !stale));
					it = (done || stale) ? g_spinWait.erase(it) : std::next(it);
				}
			}
			for (const auto& [id, payload] : pushes)
				Push("bxSpinState", payload);
		});
	}

	std::string StateJson()
	{
		return Guarded("StateJson", []() { return StateJsonImpl(); });
	}

	std::string StudyCrosshair(std::string& why)
	{
		return Guarded("StudyCrosshair", [&]() -> std::string {
			// the crosshair right now; failing that, the palette's open-time snapshot
			// (a corpse is only in it when the crosshair itself was on the body)
			auto fid = ContainerActions::CrosshairRef();
			if (!fid)
				fid = NpcActions::TargetFormID();
			auto* ref = fid ? RE::TESForm::LookupByID<RE::TESObjectREFR>(fid) : nullptr;
			auto* a   = ref ? ref->As<RE::Actor>() : nullptr;
			if (!a) {
				why = "Look at a creature first \xE2\x80\x94 the crosshair is not on one.";
				return {};
			}
			if (a->IsPlayerRef()) {
				why = "That is you.";
				return {};
			}
			std::lock_guard l(g_m);
			LoadLocked();
			auto id = MeasureLocked(a, "study", nullptr);
			if (id.empty()) {
				why = "That one has no race or name the book can file it under.";
				return {};
			}
			g_db["entries"][id].erase("new");
			SaveLocked();
			EnsureRendersLocked();
			return id;
		});
	}

	// bxStudy {formId} — the F7 card's "Add to the Bestiary": measure THIS actor
	// (the card's target, so no crosshair race), mark it studied, and if the
	// Scribe has a key and the page has no lore yet, start writing it at once.
	// Answers {ok, id, fresh, writing, why}. Main thread.
	std::string Study(const std::string& jsonText)
	{
		auto r = Guarded("Study", [&]() -> std::string {
			auto j = json::parse(jsonText, nullptr, false);
			std::uint32_t fid = 0;
			if (!j.is_discarded() && j.is_object() && j.contains("formId")) {
				const auto& f = j["formId"];
				if (f.is_number_unsigned() || f.is_number_integer())
					fid = static_cast<std::uint32_t>(f.get<std::int64_t>() & 0xFFFFFFFF);
				else if (f.is_string())
					fid = static_cast<std::uint32_t>(std::strtoul(f.get<std::string>().c_str(), nullptr, 0));
			}
			if (!fid)
				fid = NpcActions::TargetFormID();
			auto* ref = fid ? RE::TESForm::LookupByID<RE::TESObjectREFR>(fid) : nullptr;
			auto* a   = ref ? ref->As<RE::Actor>() : nullptr;
			if (!a || a->IsPlayerRef())
				return json{ { "ok", false }, { "why", a ? "That is you." : "That one is gone \xE2\x80\x94 look at it again and reopen the deck." } }.dump();
			std::lock_guard l(g_m);
			LoadLocked();
			auto id = MeasureLocked(a, "study", nullptr);
			if (id.empty())
				return json{ { "ok", false }, { "why", "That one has no race or name the book can file it under." } }.dump();
			auto& e          = g_db["entries"][id];
			const bool fresh = BoolOr(e, "new", false);
			e.erase("new");
			const auto& lo  = ObjOr(e, "lore");
			const auto  ls  = StrOr(lo, "state", "none");
			bool writing    = lo.contains("pending");
			if (ls != "done" && ls != "writing" && !writing && !ReadKey().empty()) {
				RequestLoreLocked(id, false);
				writing = ObjOr(g_db["entries"][id], "lore").contains("pending");
			}
			SaveLocked();
			EnsureRendersLocked();
			logger::info("bestiary: studied from the F7 card '{}' (fresh {}, writing {})", id, fresh, writing);
			return json{ { "ok", true }, { "id", id }, { "fresh", fresh }, { "writing", writing } }.dump();
		});
		if (r.empty())
			r = json{ { "ok", false }, { "why", "The book could not read that one (the log says why)." } }.dump();
		return r;
	}

	// The actor the player is aiming at for Study: the crosshair now, else the
	// palette's open-time snapshot. 0 with a reason when there is none.
	std::uint32_t AimedActor(std::string& name, std::string& why)
	{
		auto fid = ContainerActions::CrosshairRef();
		if (!fid)
			fid = NpcActions::TargetFormID();
		auto* ref = fid ? RE::TESForm::LookupByID<RE::TESObjectREFR>(fid) : nullptr;
		auto* a   = ref ? ref->As<RE::Actor>() : nullptr;
		if (!a) {
			why = "Look at a creature first \xE2\x80\x94 the crosshair is not on one.";
			return 0;
		}
		if (a->IsPlayerRef()) {
			why = "That is you.";
			return 0;
		}
		name = a->GetDisplayFullName() ? a->GetDisplayFullName() : "";
		return a->GetFormID();
	}

	// bxSpin {id} — bake this page's turntable (45-degree frames, the Mounts
	// contract: <render>-aNNN.png) from the same skin mesh frame 0 used. Answers
	// bxSpinState at once, and again as frames land (OnRendersLanded).
	void Spin(const std::string& jsonText)
	{
		Guarded("Spin", [&]() {
			auto j = json::parse(jsonText, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			const auto  id = StrOr(j, "id");
			std::string fid, plugin, nif;
			{
				std::lock_guard l(g_m);
				LoadLocked();
				const auto& all = g_db["entries"];
				if (all.contains(id) && all[id].is_object()) {
					const auto& sk = ObjOr(all[id], "skin");
					fid    = StrOr(sk, "fid");
					plugin = StrOr(sk, "plugin");
					nif    = StrOr(sk, "nif");
				}
			}
			// no page, or a page with no skin record (an older capture, folk):
			// nothing will bake, and the view is told so at once (baking:false)
			// so it cancels its Image() probe instead of waiting out its give-up
			if (fid.empty()) {
				if (!id.empty())
					Push("bxSpinState", SpinStateJson(id, {}, false));
				return;
			}
			// the frames beside whichever frame 0 the page shows: the 1024 once it
			// exists (the view's img is then icons/bestiary/), else the Mounts 512
			const bool hi     = !ItemIcons::BeastPathFor(fid, plugin).empty();
			auto       frames = AnglesOnDisk(fid, plugin, hi);
			bool       baking = false;
			if (frames.size() < ItemIcons::kBodySpinFrames && !nif.empty() && ItemIcons::Available()) {
				if (hi)
					ItemIcons::CaptureBeastAngles(fid, plugin, nif);
				else
					ItemIcons::CaptureBodyAngles(fid, plugin, nif);
				baking = true;
				std::lock_guard l(g_m);
				g_spinWait[id] = SpinWait{ fid, plugin, GetTickCount64(), hi };
			}
			Push("bxSpinState", SpinStateJson(id, frames, baking));
		});
	}

	void EnsureRenders()
	{
		Guarded("EnsureRenders", []() {
			std::lock_guard l(g_m);
			LoadLocked();
			EnsureRendersLocked();
		});
	}

	// The F7 card's page lookup: KindIdOf is the same id MeasureLocked files
	// the page under. {id, name, slain, studied, tier, img?} or "".
	std::string PeekJson(std::uint32_t actorFormId)
	{
		return Guarded("PeekJson", [&]() -> std::string {
			auto* ref = actorFormId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(actorFormId) : nullptr;
			auto* a   = ref ? ref->As<RE::Actor>() : nullptr;
			if (!a || a->IsPlayerRef())
				return {};
			std::string name;
			const auto  id = KindIdOf(a, &name);
			if (id.empty())
				return {};
			std::lock_guard l(g_m);
			LoadLocked();
			const auto& all = g_db["entries"];
			if (!all.is_object() || !all.contains(id) || !all[id].is_object())
				return {};
			const auto& s = all[id];
			const json  v = EntryView(id, s, Player(), nullptr);
			json o{ { "id", id }, { "name", StrOr(v, "name", name) }, { "slain", NumOr(s, "slain", 0) }, { "studied", NumOr(s, "studied", 0) },
				{ "tier", NumOr(ObjOr(v, "threat"), "tier", 0) } };
			if (v.contains("thumb"))
				o["img"] = v["thumb"];   // the F7 door's medal: the 512 is plenty
			else if (v.contains("img"))
				o["img"] = v["img"];
			return o.dump(-1, ' ', false, json::error_handler_t::replace);
		});
	}

	// bxSound {name} — the book's sounds are the game's OWN descriptors from
	// Skyrim.esm (read with dump_records.py, never invented): a quill on paper is
	// the Thieves Guild charcoal rubbing. Anything else is refused.
	void Sound(const std::string& name)
	{
		static const std::pair<const char*, const char*> kSounds[] = {
			{ "open", "ITMBookOpenSD" }, { "close", "ITMBookCloseSD" },
			{ "page", "ITMBookPageTurnForwardSD" }, { "pageback", "ITMBookPageTurnBackwardSD" },
			{ "write", "QSTTG06CharcoalRubSD" }, { "new", "UISkillsPerkSelectASD" }
		};
		for (const auto& [k, edid] : kSounds)
			if (name == k) {
				RE::PlaySound(edid);
				return;
			}
	}

	std::string Lore(const std::string& jsonText)
	{
		return Guarded("Lore", [&]() -> std::string {
			auto j = json::parse(jsonText, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return {};
			const auto id = StrOr(j, "id");
			std::lock_guard l(g_m);
			LoadLocked();
			RequestLoreLocked(id, BoolOr(j, "rewrite", false));
			SaveLocked();
			return EntryJsonLocked(id);
		});
	}

	std::string ScribeOp(const std::string& jsonText)
	{
		return Guarded("ScribeOp", [&]() -> std::string {
			auto j = json::parse(jsonText, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return json{ { "ok", false }, { "msg", "Bad request." } }.dump(-1, ' ', false, json::error_handler_t::replace);
			const auto op = StrOr(j, "op");
			std::lock_guard l(g_m);
			LoadLocked();
			auto& s = g_db["scribe"];
			if (!s.is_object())
				s = json::object();
			if (op == "save") {
				for (const char* k : { "model", "voice", "length" })
					if (j.contains(k) && j[k].is_string())
						s[k] = j[k];
				for (const char* k : { "auto", "spoilers" })
					if (j.contains(k) && j[k].is_boolean())
						s[k] = j[k];
				bool keyOk = true;
				if (j.contains("key") && j["key"].is_string()) {
					const auto key = Trim(j["key"].get<std::string>());
					keyOk          = WriteKey(key);
					s.erase("credit");
					logger::info("bestiary: scribe key {}", keyOk ? "saved to SkyManager.ini" : "NOT saved (ini write failed)");
				}
				SaveLocked();
				return json{ { "ok", keyOk }, { "msg", keyOk ? "Saved." : "Could not write SkyManager.ini." }, { "scribe", ScribeView() } }.dump(-1, ' ', false, json::error_handler_t::replace);
			}
			if (op == "remove") {
				const bool ok = WriteKey("");
				s.erase("credit");
				SaveLocked();
				return json{ { "ok", ok }, { "msg", ok ? "Key removed from this PC." : "Could not write SkyManager.ini." }, { "scribe", ScribeView() } }.dump(-1, ' ', false, json::error_handler_t::replace);
			}
			if (op == "test") {
				const auto key   = ReadKey();
				const auto model = StrOr(j, "model", StrOr(s, "model", "deepseek/deepseek-v3.1-terminus"));
				if (key.empty())
					return json{ { "ok", false }, { "msg", "No key saved yet." }, { "scribe", ScribeView() } }.dump(-1, ' ', false, json::error_handler_t::replace);
				std::thread([key, model]() {
					auto r = OpenRouter(L"GET", L"/api/v1/credits", key, "", 15000);
					std::string msg, credit;
					if (r.ok) {
						auto c = json::parse(r.body, nullptr, false);
						if (!c.is_discarded() && c.is_object() && c.contains("data") && c["data"].is_object()) {
							const double left = DblOr(c["data"], "total_credits", 0.0) - DblOr(c["data"], "total_usage", 0.0);
							char buf[32];
							std::snprintf(buf, sizeof(buf), "$%.2f", left);
							credit = buf;
						}
						msg = "Connected to OpenRouter" + (credit.empty() ? std::string() : " \xC2\xB7 " + credit + " credit left") + " \xC2\xB7 the Scribe will use " + model + ".";
					} else
						msg = r.error;
					SKSE::GetTaskInterface()->AddTask([ok = r.ok, msg, credit]() {
						Guarded("scribe test", [&]() {
							std::string out;
							{
								std::lock_guard l2(g_m);
								if (!credit.empty())
									g_db["scribe"]["credit"] = credit;
								SaveLocked();
								out = json{ { "ok", ok }, { "msg", msg }, { "scribe", ScribeView() } }.dump(-1, ' ', false, json::error_handler_t::replace);
							}
							Push("bxScribeResult", out);
						});
					});
				}).detach();
				return {};   // the answer comes later through bxScribeResult
			}
			return json{ { "ok", false }, { "msg", "Unknown request." } }.dump(-1, ' ', false, json::error_handler_t::replace);
		});
	}

	std::string Edit(const std::string& jsonText)
	{
		return Guarded("Edit", [&]() -> std::string {
			auto j = json::parse(jsonText, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return {};
			const auto id = StrOr(j, "id");
			std::lock_guard l(g_m);
			LoadLocked();
			auto& all = g_db["entries"];
			if (!all.contains(id) || !all[id].is_object())
				return {};
			auto& e = all[id];
			// every field the page draws may be edited; anything else is refused
			static const std::set<std::string> kEditable = {
				"name", "chapter", "family", "race", "plugin", "level", "health", "stamina", "magicka", "armor", "dmg",
				"physical", "resist", "traits", "threat", "ratings", "body", "affects", "fights", "style", "carries",
				"lore", "codex", "regions", "tally", "attacks", "arsenal", "records", "art"
			};
			auto& edits = e["edits"];
			if (!edits.is_object())
				edits = json::object();
			if (j.contains("set") && j["set"].is_object())
				for (auto it = j["set"].begin(); it != j["set"].end(); ++it) {
					if (!kEditable.count(it.key()))
						continue;
					if (it.value().is_string() && it.value().get<std::string>().size() > 8000)
						continue;
					// the page's own picture: a path into the view's icons/ tree, nothing else
					if (it.key() == "art" && (!it.value().is_string() || !SafePicture(it.value().get<std::string>())))
						continue;
					edits[it.key()] = it.value();
				}
			if (j.contains("unset") && j["unset"].is_array())
				for (const auto& k : j["unset"])
					if (k.is_string())
						edits.erase(k.get<std::string>());
			if (j.contains("notes") && j["notes"].is_string())
				e["notes"] = Utf8Cut(j["notes"].get<std::string>(), 8000);
			// a correction the Scribe should learn from: on this page, or for every page
			if (j.contains("lesson") && j["lesson"].is_string()) {
				const auto text = Utf8Cut(Trim(j["lesson"].get<std::string>()), 600);
				if (!text.empty()) {
					if (BoolOr(j, "everywhere", false)) {
						auto& ls = g_db["lessons"];
						if (!ls.is_array())
							ls = json::array();
						ls.push_back(json{ { "text", StrOr(e, "name", id) + ": " + text }, { "scope", "all" }, { "at", Today() } });
					} else {
						auto& cs = e["corrections"];
						if (!cs.is_array())
							cs = json::array();
						cs.push_back(text);
					}
				}
			}
			if (edits.empty())
				e.erase("edits");
			logger::info("bestiary: page '{}' edited by the reader", id);
			SaveLocked();
			return EntryJsonLocked(id);
		});
	}

	std::string Shelf(const std::string& jsonText)
	{
		return Guarded("Shelf", [&]() -> std::string {
			auto j = json::parse(jsonText, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return {};
			const auto op = StrOr(j, "op");
			{
				std::lock_guard l(g_m);
				LoadLocked();
				auto& sh = g_db["shelves"];
				if (!sh.is_array())
					sh = json::array();
				if (op == "save" && j.contains("chapter") && j["chapter"].is_object()) {
					const auto& c    = j["chapter"];
					const auto  name = Utf8Cut(Trim(StrOr(c, "name")), 60);
					auto        icon = StrOr(c, "icon");
					if (!SafePicture(icon))
						icon.clear();
					const auto blurb = Utf8Cut(Trim(StrOr(c, "blurb")), 300);
					auto       id    = StrOr(c, "id");
					bool       found = false;
					if (!name.empty()) {
						for (auto& one : sh)
							if (one.is_object() && !id.empty() && StrOr(one, "id") == id) {
								one["name"]  = name;
								one["icon"]  = icon;
								one["blurb"] = blurb;
								found        = true;
							}
						if (!found && sh.size() < 40) {
							// "my-<n>": never one of the built-in ids, never reused
							int n = 1;
							for (const auto& one : sh)
								if (one.is_object() && StrOr(one, "id").rfind("my-", 0) == 0)
									n = (std::max)(n, std::atoi(StrOr(one, "id").c_str() + 3) + 1);
							id = "my-" + std::to_string(n);
							sh.push_back(json{ { "id", id }, { "name", name }, { "icon", icon }, { "blurb", blurb } });
						}
						// Build marker (hd-markers.json: "bestiary-shelves").
						logger::info("bestiary: shelf '{}' saved as {}", name, id);
					}
				} else if (op == "delete") {
					const auto id = StrOr(j, "id");
					std::size_t back = 0;
					for (auto it = sh.begin(); it != sh.end();)
						it = (it->is_object() && StrOr(*it, "id") == id) ? sh.erase(it) : it + 1;
					// its pages go back to the kind the engine gave them
					auto& all = g_db["entries"];
					for (auto it = all.begin(); it != all.end(); ++it) {
						if (!it.value().is_object() || !it.value().contains("edits") || !it.value()["edits"].is_object())
							continue;
						auto& ed = it.value()["edits"];
						if (ed.contains("chapter") && ed["chapter"].is_string() && ed["chapter"].get<std::string>() == id) {
							ed.erase("chapter");
							if (ed.empty())
								it.value().erase("edits");
							++back;
						}
					}
					logger::info("bestiary: shelf {} removed, {} page(s) back to their kind", id, back);
				}
				SaveLocked();
			}
			return StateJsonImpl();
		});
	}

	std::string Lesson(const std::string& jsonText)
	{
		return Guarded("Lesson", [&]() -> std::string {
			auto j = json::parse(jsonText, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return {};
			const auto op = StrOr(j, "op");
			std::lock_guard l(g_m);
			LoadLocked();
			auto& ls = g_db["lessons"];
			if (!ls.is_array())
				ls = json::array();
			const int  i    = NumOr(j, "index", -1);
			const auto text = Utf8Cut(Trim(StrOr(j, "text")), 600);
			if (op == "add" && !text.empty())
				ls.push_back(json{ { "text", text }, { "scope", "all" }, { "at", Today() } });
			else if (op == "edit" && i >= 0 && i < static_cast<int>(ls.size()) && !text.empty() && ls[i].is_object())
				ls[i]["text"] = text;
			else if (op == "remove" && i >= 0 && i < static_cast<int>(ls.size()))
				ls.erase(ls.begin() + i);
			SaveLocked();
			return json{ { "ok", true }, { "msg", "" }, { "scribe", ScribeView() } }.dump(-1, ' ', false, json::error_handler_t::replace);
		});
	}

	bool IsAction(const std::string& action)
	{
		return action == "bestiary-open" || action == "bestiary-study";
	}
}
