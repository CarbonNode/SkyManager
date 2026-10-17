#include "music_player.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp, the logger
// and Windows.h.

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <urlmon.h>
#pragma comment(lib, "urlmon.lib")

#undef GetObject
#undef min
#undef max

namespace MusicPlayer
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		// marker: music-player (Music tab: engine music + mpv/yt-dlp stream)

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// ================================================ small helpers ==

		std::wstring Widen(const std::string& s)
		{
			if (s.empty())
				return {};
			const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
			if (n <= 0)
				return {};
			std::wstring out(static_cast<size_t>(n), L'\0');
			MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), n);
			return out;
		}

		std::string Narrow(const std::wstring& s)
		{
			if (s.empty())
				return {};
			const int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
			if (n <= 0)
				return {};
			std::string out(static_cast<size_t>(n), '\0');
			WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr);
			return out;
		}

		bool FileExists(const std::wstring& p)
		{
			const DWORD a = GetFileAttributesW(p.c_str());
			return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
		}

		std::wstring EnvW(const wchar_t* name)
		{
			wchar_t buf[MAX_PATH]{};
			const DWORD n = GetEnvironmentVariableW(name, buf, MAX_PATH);
			return (n > 0 && n < MAX_PATH) ? std::wstring(buf, n) : std::wstring();
		}

		// SkyManager.ini, section-blind — the same probe journal.cpp uses.
		std::string ReadIniString(const char* wantKey)
		{
			std::ifstream in("Data/SKSE/Plugins/SkyManager.ini");
			if (!in)
				return {};
			std::string line;
			while (std::getline(in, line)) {
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				std::string key = line.substr(0, eq);
				key.erase(0, key.find_first_not_of(" \t"));
				const auto keyEnd = key.find_last_not_of(" \t");
				key.erase(keyEnd == std::string::npos ? 0 : keyEnd + 1);
				if (_stricmp(key.c_str(), wantKey) != 0)
					continue;
				std::string val = line.substr(eq + 1);
				val.erase(0, val.find_first_not_of(" \t"));
				const auto valEnd = val.find_last_not_of(" \t\r");
				val.erase(valEnd == std::string::npos ? 0 : valEnd + 1);
				return val;
			}
			return {};
		}

		// A YouTube video id is exactly 11 of [A-Za-z0-9_-]; nothing else is
		// ever put into a thumbnail URL or a file name.
		bool IsVideoId(const std::string& s)
		{
			if (s.size() != 11)
				return false;
			for (char c : s)
				if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-'))
					return false;
			return true;
		}

		bool IsHttpUrl(const std::string& s)
		{
			return s.rfind("https://", 0) == 0 || s.rfind("http://", 0) == 0;
		}

		// A command-line argument for CreateProcessW: quotes and control
		// characters are stripped (a title or query never needs them), the
		// rest is wrapped in quotes. A trailing backslash would escape the
		// closing quote, so it goes too.
		std::wstring Arg(const std::string& s)
		{
			std::string clean;
			clean.reserve(s.size());
			for (char c : s)
				if (c != '"' && static_cast<unsigned char>(c) >= 0x20)
					clean.push_back(c);
			while (!clean.empty() && clean.back() == '\\')
				clean.pop_back();
			return L"\"" + Widen(clean) + L"\"";
		}

		// ===================================================== the sidecar ==

		struct Video
		{
			std::string id;        // YouTube id, "" for another site
			std::string url;       // what mpv is handed
			std::string title;
			std::string channel;
			int         dur = 0;   // seconds, 0 = unknown / live
		};

		json VideoJson(const Video& v)
		{
			return json{ { "id", v.id }, { "url", v.url }, { "title", v.title }, { "channel", v.channel }, { "dur", v.dur } };
		}

		bool VideoFrom(const json& j, Video& v)
		{
			if (!j.is_object())
				return false;
			v.id = j.value("id", std::string());
			v.url = j.value("url", std::string());
			v.title = j.value("title", std::string());
			v.channel = j.value("channel", std::string());
			v.dur = j.contains("dur") && j["dur"].is_number() ? static_cast<int>(j["dur"].get<double>()) : 0;
			if (!IsVideoId(v.id))
				v.id.clear();
			if (v.url.empty() && !v.id.empty())
				v.url = "https://www.youtube.com/watch?v=" + v.id;
			if (!IsHttpUrl(v.url))
				return false;
			if (v.title.empty())
				v.title = v.url;
			return true;
		}

		std::string KeyOf(const Video& v) { return v.id.empty() ? v.url : v.id; }

		// Shared by the main thread (SetJson/StateJson) and the stream worker
		// (recents, volume); everything below is read and written under it.
		std::mutex            g_dataMx;
		std::set<std::string> g_favTypes;
		std::vector<Video>    g_favVideos;
		std::vector<Video>    g_recents;
		int                   g_vol = 60;
		bool                  g_mute = true;
		std::string           g_repeat = "off";   // off | one | all
		json                  g_extra = json::object();

		// Saved playlists: named lists of videos, kept in the sidecar. The
		// view holds a copy and asks again only when g_plSeq moves (the light
		// state carries the number, the lists ride along when it differs).
		struct Playlist
		{
			std::string        id;
			std::string        name;
			std::vector<Video> items;
		};
		std::vector<Playlist> g_playlists;
		int                   g_plSeq = 1;

		constexpr size_t kMaxRecents = 40;
		constexpr size_t kMaxPlaylists = 200;
		constexpr size_t kMaxPlItems = 2000;
		constexpr size_t kMaxPlName = 80;

		fs::path SidecarPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "music.json";
		}

		fs::path ThumbDir()
		{
			return fs::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "music-thumbs";
		}

		void LoadSidecar()
		{
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;
			json j = json::parse(in, nullptr, false);
			if (!j.is_object())
				return;
			std::lock_guard l(g_dataMx);
			g_extra = j;
			for (const char* k : { "favTypes", "favVideos", "recents", "vol", "mute", "repeat", "playlists" })
				g_extra.erase(k);
			if (j.contains("favTypes") && j["favTypes"].is_array())
				for (const auto& f : j["favTypes"])
					if (f.is_string())
						g_favTypes.insert(f.get<std::string>());
			auto loadList = [&](const char* key, std::vector<Video>& out) {
				if (!j.contains(key) || !j[key].is_array())
					return;
				for (const auto& e : j[key]) {
					Video v;
					if (VideoFrom(e, v))
						out.push_back(std::move(v));
				}
			};
			loadList("favVideos", g_favVideos);
			loadList("recents", g_recents);
			if (g_recents.size() > kMaxRecents)
				g_recents.resize(kMaxRecents);
			if (j.contains("playlists") && j["playlists"].is_array()) {
				for (const auto& e : j["playlists"]) {
					if (!e.is_object() || g_playlists.size() >= kMaxPlaylists)
						continue;
					Playlist p;
					p.id = e.value("id", std::string());
					p.name = e.value("name", std::string());
					if (p.id.empty() || p.name.empty())
						continue;
					if (e.contains("items") && e["items"].is_array())
						for (const auto& it : e["items"]) {
							Video v;
							if (p.items.size() < kMaxPlItems && VideoFrom(it, v))
								p.items.push_back(std::move(v));
						}
					g_playlists.push_back(std::move(p));
				}
			}
			if (j.contains("vol") && j["vol"].is_number())
				g_vol = std::clamp(static_cast<int>(j["vol"].get<double>()), 0, 100);
			if (j.contains("mute") && j["mute"].is_boolean())
				g_mute = j["mute"].get<bool>();
			const auto rep = j.value("repeat", std::string("off"));
			g_repeat = (rep == "one" || rep == "all") ? rep : "off";
		}

		// Caller holds g_dataMx.
		void SaveSidecarLocked()
		{
			json j = g_extra.is_object() ? g_extra : json::object();
			j["favTypes"] = json::array();
			for (const auto& f : g_favTypes)
				j["favTypes"].push_back(f);
			j["favVideos"] = json::array();
			for (const auto& v : g_favVideos)
				j["favVideos"].push_back(VideoJson(v));
			j["recents"] = json::array();
			for (const auto& v : g_recents)
				j["recents"].push_back(VideoJson(v));
			j["playlists"] = json::array();
			for (const auto& p : g_playlists) {
				json items = json::array();
				for (const auto& v : p.items)
					items.push_back(VideoJson(v));
				j["playlists"].push_back(json{ { "id", p.id }, { "name", p.name }, { "items", std::move(items) } });
			}
			j["vol"] = g_vol;
			j["mute"] = g_mute;
			j["repeat"] = g_repeat;
			std::error_code ec;
			fs::create_directories(SidecarPath().parent_path(), ec);
			std::ofstream out(SidecarPath(), std::ios::binary | std::ios::trunc);
			if (out)
				out << j.dump(2, ' ', false, json::error_handler_t::replace);
		}

		// ======================================================= the tools ==

		struct Tools
		{
			std::wstring dir;     // where mpv.exe was found ("" = PATH)
			std::wstring mpv;
			std::wstring ytdlp;
			std::wstring node;    // only used when deno is absent
			bool         deno = false;
		};

		std::wstring OnPath(const wchar_t* exe)
		{
			wchar_t found[MAX_PATH]{};
			return SearchPathW(nullptr, exe, nullptr, MAX_PATH, found, nullptr) ? std::wstring(found) : std::wstring();
		}

		std::wstring FindNode()
		{
			if (auto p = OnPath(L"node.exe"); !p.empty())
				return p;
			for (const auto& c : { EnvW(L"ProgramFiles") + L"\\nodejs\\node.exe", EnvW(L"ProgramW6432") + L"\\nodejs\\node.exe",
					 EnvW(L"LOCALAPPDATA") + L"\\Programs\\nodejs\\node.exe" })
				if (c.size() > 12 && FileExists(c))
					return c;
			return {};
		}

		// ini [Music] sToolsDir, then %LOCALAPPDATA%\SkyManager\music-tools,
		// then PATH. Cheap (a handful of attribute reads), so it is asked
		// again whenever it matters: a player who drops the files in while
		// the game runs does not have to restart.
		Tools FindTools()
		{
			Tools t;
			std::vector<std::wstring> dirs;
			if (auto ini = ReadIniString("sToolsDir"); !ini.empty())
				dirs.push_back(Widen(ini));
			if (auto la = EnvW(L"LOCALAPPDATA"); !la.empty())
				dirs.push_back(la + L"\\SkyManager\\music-tools");
			for (auto d : dirs) {
				while (!d.empty() && (d.back() == L'\\' || d.back() == L'/'))
					d.pop_back();
				if (t.mpv.empty() && FileExists(d + L"\\mpv.exe")) {
					t.mpv = d + L"\\mpv.exe";
					t.dir = d;
				}
				if (t.ytdlp.empty() && FileExists(d + L"\\yt-dlp.exe"))
					t.ytdlp = d + L"\\yt-dlp.exe";
				if (!t.deno && FileExists(d + L"\\deno.exe"))
					t.deno = true;
			}
			if (t.mpv.empty())
				t.mpv = OnPath(L"mpv.exe");
			if (t.ytdlp.empty())
				t.ytdlp = OnPath(L"yt-dlp.exe");
			if (!t.deno)
				t.deno = !OnPath(L"deno.exe").empty();
			if (!t.deno)
				t.node = FindNode();
			return t;
		}

		json ToolsJson(const Tools& t)
		{
			return json{ { "mpv", !t.mpv.empty() }, { "ytdlp", !t.ytdlp.empty() },
				{ "js", t.deno ? "deno" : (t.node.empty() ? "" : "node") },
				{ "dir", Narrow(t.dir.empty() ? EnvW(L"LOCALAPPDATA") + L"\\SkyManager\\music-tools" : t.dir) } };
		}

		// ====================================================== processes ==

		std::mutex g_jobMx;
		HANDLE     g_job = nullptr;   // KILL_ON_JOB_CLOSE: children die with the game

		HANDLE Job()
		{
			std::lock_guard l(g_jobMx);
			if (!g_job) {
				g_job = CreateJobObjectW(nullptr, nullptr);
				if (g_job) {
					JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
					li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
					SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &li, sizeof(li));
				}
			}
			return g_job;
		}

		// The child's environment: ours with the tools dir and node's dir put
		// in front of PATH, so mpv finds yt-dlp and yt-dlp finds its JS
		// runtime. Our OWN PATH is never touched — the tools dir holds DLLs
		// (d3dcompiler_43.dll) the game must not start resolving from.
		std::vector<wchar_t> ChildEnv(const Tools& t)
		{
			std::wstring front;
			if (!t.dir.empty())
				front += t.dir + L";";
			if (!t.node.empty()) {
				const auto slash = t.node.find_last_of(L"\\/");
				if (slash != std::wstring::npos)
					front += t.node.substr(0, slash) + L";";
			}
			std::vector<wchar_t> out;
			wchar_t*             env = GetEnvironmentStringsW();
			bool                 sawPath = false;
			for (const wchar_t* p = env; p && *p; p += wcslen(p) + 1) {
				std::wstring var(p);
				if (_wcsnicmp(var.c_str(), L"PATH=", 5) == 0) {
					var = L"PATH=" + front + var.substr(5);
					sawPath = true;
				}
				out.insert(out.end(), var.begin(), var.end());
				out.push_back(L'\0');
			}
			if (env)
				FreeEnvironmentStringsW(env);
			if (!sawPath) {
				const std::wstring var = L"PATH=" + front;
				out.insert(out.end(), var.begin(), var.end());
				out.push_back(L'\0');
			}
			out.push_back(L'\0');
			return out;
		}

		// Start a hidden child inside the job. CREATE_SUSPENDED so it is in
		// the job before it can start anything of its own (yt-dlp under mpv).
		bool Spawn(std::wstring cmd, const Tools& t, HANDLE out, HANDLE err, PROCESS_INFORMATION& pi)
		{
			auto                env = ChildEnv(t);
			STARTUPINFOW        si{};
			si.cb = sizeof(si);
			si.dwFlags = STARTF_USESHOWWINDOW;
			si.wShowWindow = SW_HIDE;
			const bool redirect = out || err;
			HANDLE     nul = INVALID_HANDLE_VALUE;
			if (redirect) {
				SECURITY_ATTRIBUTES sa{ sizeof(sa), nullptr, TRUE };
				nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
				si.dwFlags |= STARTF_USESTDHANDLES;
				si.hStdInput = nul;
				si.hStdOutput = out;
				si.hStdError = err;
			}
			const BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, redirect ? TRUE : FALSE,
				CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, env.data(), nullptr, &si, &pi);
			if (nul != INVALID_HANDLE_VALUE)
				CloseHandle(nul);
			if (!ok)
				return false;
			if (auto* job = Job())
				AssignProcessToJobObject(job, pi.hProcess);
			ResumeThread(pi.hThread);
			CloseHandle(pi.hThread);
			pi.hThread = nullptr;
			return true;
		}

		// Run to completion (or the timeout), collecting stdout and stderr.
		// Both pipes are drained by polling, so a chatty stderr can never
		// fill its buffer and stall the child while we wait on stdout.
		bool RunCapture(const std::wstring& cmd, const Tools& t, DWORD timeoutMs, std::string& out, std::string& err, DWORD& code)
		{
			SECURITY_ATTRIBUTES sa{ sizeof(sa), nullptr, TRUE };
			HANDLE              outR = nullptr, outW = nullptr, errR = nullptr, errW = nullptr;
			if (!CreatePipe(&outR, &outW, &sa, 1 << 16) || !CreatePipe(&errR, &errW, &sa, 1 << 16))
				return false;
			SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
			SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);
			PROCESS_INFORMATION pi{};
			const bool          started = Spawn(cmd, t, outW, errW, pi);
			CloseHandle(outW);
			CloseHandle(errW);
			if (!started) {
				CloseHandle(outR);
				CloseHandle(errR);
				return false;
			}
			auto drain = [](HANDLE h, std::string& into) {
				DWORD avail = 0;
				while (PeekNamedPipe(h, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
					char  buf[8192];
					DWORD got = 0;
					if (!ReadFile(h, buf, std::min<DWORD>(avail, sizeof(buf)), &got, nullptr) || got == 0)
						break;
					into.append(buf, got);
				}
			};
			const auto start = GetTickCount64();
			bool       timedOut = false;
			while (true) {
				drain(outR, out);
				drain(errR, err);
				if (WaitForSingleObject(pi.hProcess, 25) == WAIT_OBJECT_0)
					break;
				if (GetTickCount64() - start > timeoutMs) {
					TerminateProcess(pi.hProcess, 1);
					timedOut = true;
					break;
				}
			}
			drain(outR, out);
			drain(errR, err);
			code = 1;
			GetExitCodeProcess(pi.hProcess, &code);
			CloseHandle(pi.hProcess);
			CloseHandle(outR);
			CloseHandle(errR);
			if (timedOut)
				err += "\n(timed out)";
			return true;
		}

		// yt-dlp's stderr, in player words. YouTube's bot wall is the common
		// one, and only cookies from a signed-in browser get past it.
		std::string Friendly(const std::string& err)
		{
			if (err.find("confirm you") != std::string::npos && err.find("bot") != std::string::npos)
				return "YouTube asked to confirm you're not a bot. Set SkyManager.ini [Music] sCookiesFromBrowser=firefox (or edge/chrome) so yt-dlp uses a signed-in browser, or try again in a while.";
			if (err.find("timed out") != std::string::npos)
				return "yt-dlp took too long to answer. Check the connection and try again.";
			if (err.find("No supported JavaScript runtime") != std::string::npos || err.find("JS runtime") != std::string::npos)
				return "yt-dlp needs a JavaScript runtime for YouTube: put deno.exe beside yt-dlp.exe, or install Node.js.";
			if (err.find("Video unavailable") != std::string::npos)
				return "That video is unavailable.";
			if (err.find("Private video") != std::string::npos)
				return "That video is private.";
			const auto at = err.find("ERROR:");
			std::string line = at == std::string::npos ? err : err.substr(at + 6);
			if (const auto nl = line.find('\n'); nl != std::string::npos)
				line.resize(nl);
			line.erase(0, line.find_first_not_of(" \t"));
			if (line.size() > 220)
				line = line.substr(0, 220) + "...";
			return line.empty() ? "yt-dlp failed." : line;
		}

		// The yt-dlp options both the search and mpv's hook take.
		std::vector<std::string> YtdlOptions(const Tools& t)
		{
			std::vector<std::string> o;
			if (!t.deno && !t.node.empty())
				o.push_back("js-runtimes=node:" + Narrow(t.node));
			if (auto c = ReadIniString("sCookiesFromBrowser"); !c.empty()) {
				std::string clean;
				for (char ch : c)
					if (std::isalnum(static_cast<unsigned char>(ch)) || ch == '_' || ch == '-' || ch == ':')
						clean.push_back(ch);
				if (!clean.empty())
					o.push_back("cookies-from-browser=" + clean);
			}
			return o;
		}

		// ===================================================== thumbnails ==

		std::mutex            g_thumbMx;
		std::set<std::string> g_thumbs;       // ids whose jpg is on disk
		std::set<std::string> g_thumbAsked;   // ids a fetch was started for
		std::atomic<int>      g_thumbSeq{ 0 };

		// Off-thread: one small jpg per id (i.ytimg.com mqdefault, 320x180).
		void FetchThumbs(std::vector<std::string> ids)
		{
			std::vector<std::string> todo;
			{
				std::lock_guard l(g_thumbMx);
				for (auto& id : ids)
					if (IsVideoId(id) && !g_thumbs.count(id) && g_thumbAsked.insert(id).second)
						todo.push_back(id);
			}
			if (todo.empty())
				return;
			std::thread([todo = std::move(todo)]() {
				std::error_code ec;
				fs::create_directories(ThumbDir(), ec);
				for (const auto& id : todo) {
					const auto file = ThumbDir() / (id + ".jpg");
					bool       have = fs::exists(file, ec) && fs::file_size(file, ec) > 0;
					if (!have) {
						const std::wstring url = L"https://i.ytimg.com/vi/" + Widen(id) + L"/mqdefault.jpg";
						have = SUCCEEDED(URLDownloadToFileW(nullptr, url.c_str(), file.wstring().c_str(), 0, nullptr));
					}
					if (have) {
						std::lock_guard l(g_thumbMx);
						g_thumbs.insert(id);
						g_thumbSeq.fetch_add(1);
					}
				}
			}).detach();
		}

		bool HasThumb(const std::string& id)
		{
			std::lock_guard l(g_thumbMx);
			return g_thumbs.count(id) > 0;
		}

		json VideoOut(const Video& v)
		{
			auto j = VideoJson(v);
			j["thumb"] = !v.id.empty() && HasThumb(v.id);
			return j;
		}

		// ========================================================= search ==

		struct Search
		{
			int                seq = 0;
			std::string        q;
			bool               busy = false;
			std::vector<Video> results;
			std::string        error;
			std::string        title;   // a playlist's own name, when one was pasted
		};
		std::mutex g_searchMx;
		Search     g_search;

		void StartSearch(const std::string& q)
		{
			int seq;
			{
				std::lock_guard l(g_searchMx);
				seq = ++g_search.seq;
				g_search.q = q;
				g_search.busy = true;
				g_search.error.clear();
				g_search.title.clear();
			}
			std::thread([seq, q]() { try {
				const Tools        t = FindTools();
				std::vector<Video> found;
				std::string        error, title;
				if (t.ytdlp.empty()) {
					error = "yt-dlp.exe isn't installed. See the setup card.";
				} else {
					const bool   url = IsHttpUrl(q);
					std::wstring cmd = L"\"" + t.ytdlp + L"\" --flat-playlist -J --no-warnings --playlist-end 60";
					for (const auto& o : YtdlOptions(t)) {
						const auto eq = o.find('=');
						cmd += L" --" + Widen(o.substr(0, eq)) + L" " + Arg(o.substr(eq + 1));
					}
					cmd += L" -- " + Arg(url ? q : "ytsearch24:" + q);
					std::string out, err;
					DWORD       code = 1;
					const auto  t0 = GetTickCount64();
					if (!RunCapture(cmd, t, 45000, out, err, code)) {
						error = "Couldn't start yt-dlp.exe.";
					} else {
						json j = json::parse(out, nullptr, false);
						if (!j.is_object()) {
							error = Friendly(err);
						} else {
							auto take = [&](const json& e) {
								Video v;
								v.id = e.value("id", std::string());
								if (!IsVideoId(v.id))
									v.id.clear();
								v.url = e.value("webpage_url", e.value("url", std::string()));
								v.title = e.value("title", std::string());
								v.channel = e.value("channel", e.value("uploader", std::string()));
								v.dur = e.contains("duration") && e["duration"].is_number() ? static_cast<int>(e["duration"].get<double>()) : 0;
								if (!v.id.empty() && (v.url.empty() || v.url.find("youtube.com") != std::string::npos || v.url.find("youtu.be") != std::string::npos))
									v.url = "https://www.youtube.com/watch?v=" + v.id;
								if (IsHttpUrl(v.url) && !v.title.empty() && v.title != "[Private video]" && v.title != "[Deleted video]")
									found.push_back(std::move(v));
							};
							if (j.contains("entries") && j["entries"].is_array()) {
								for (const auto& e : j["entries"])
									if (e.is_object())
										take(e);
								if (url)
									title = j.value("title", std::string());
							} else {
								take(j);
							}
							if (found.empty())
								error = "Nothing found.";
						}
					}
					logger::info("music-player: search \"{}\" -> {} result(s) in {} ms (yt-dlp exit {})", q, found.size(), GetTickCount64() - t0, code);
				}
				std::vector<std::string> ids;
				for (const auto& v : found)
					if (!v.id.empty())
						ids.push_back(v.id);
				{
					std::lock_guard l(g_searchMx);
					if (seq != g_search.seq)
						return;   // a newer search owns the panel
					g_search.busy = false;
					g_search.results = std::move(found);
					g_search.error = error;
					g_search.title = title;
				}
				FetchThumbs(std::move(ids));
			} catch (const std::exception& e) {
				logger::error("music-player: search: {}", e.what());
				std::lock_guard l(g_searchMx);
				if (seq == g_search.seq) {
					g_search.busy = false;
					g_search.error = "The search failed - see HotkeyDeck.log.";
				}
			} }).detach();
		}

		// ===================================================== the stream ==

		struct Stream
		{
			bool        running = false;   // mpv process alive + pipe open
			bool        loading = false;   // a loadfile is resolving
			bool        playing = false;   // a file is loaded (paused or not)
			bool        paused = false;
			bool        buffering = false;
			double      pos = 0.0;
			double      dur = 0.0;
			std::string mediaTitle;
			std::string error;
		};

		std::mutex              g_sMx;   // g_s, g_queue, g_qi, g_cmds
		std::condition_variable g_cv;
		Stream                  g_s;
		std::vector<Video>      g_queue;
		int                     g_qi = -1;
		std::deque<json>        g_cmds;
		std::atomic<bool>       g_workerUp{ false };
		std::atomic<bool>       g_quit{ false };
		std::atomic<bool>       g_audible{ false };

		void ApplyMuteTask();   // main thread, below

		// --- worker-owned (never touched off the worker) ---
		HANDLE      w_proc = nullptr;
		HANDLE      w_pipe = INVALID_HANDLE_VALUE;
		std::string w_buf;
		std::string w_ytdlErr;   // the hook's last stderr, for the error line

		void PushAudible()
		{
			bool audible;
			{
				std::lock_guard l(g_sMx);
				audible = g_s.playing && !g_s.paused && !g_s.loading;
			}
			if (g_audible.exchange(audible) != audible)
				if (auto* ti = SKSE::GetTaskInterface())
					ti->AddTask([]() { ApplyMuteTask(); });
		}

		void ClosePipe()
		{
			if (w_pipe != INVALID_HANDLE_VALUE)
				CloseHandle(w_pipe);
			w_pipe = INVALID_HANDLE_VALUE;
			w_buf.clear();
		}

		void KillMpv()
		{
			ClosePipe();
			if (w_proc) {
				TerminateProcess(w_proc, 0);
				CloseHandle(w_proc);
				w_proc = nullptr;
			}
			std::lock_guard l(g_sMx);
			g_s.running = g_s.playing = g_s.loading = g_s.paused = g_s.buffering = false;
			g_s.pos = g_s.dur = 0.0;
		}

		bool MpvAlive()
		{
			return w_proc && WaitForSingleObject(w_proc, 0) == WAIT_TIMEOUT && w_pipe != INVALID_HANDLE_VALUE;
		}

		bool Send(const json& cmd)
		{
			if (w_pipe == INVALID_HANDLE_VALUE)
				return false;
			const std::string line = Dump(cmd) + "\n";
			DWORD             wrote = 0;
			return WriteFile(w_pipe, line.data(), static_cast<DWORD>(line.size()), &wrote, nullptr) && wrote == line.size();
		}

		std::wstring PipeName()
		{
			return L"\\\\.\\pipe\\skymanager-music-" + std::to_wstring(GetCurrentProcessId());
		}

		// Start mpv (idle, no window, no video) and connect to its pipe.
		bool EnsureMpv(std::string& why)
		{
			if (MpvAlive())
				return true;
			KillMpv();
			const Tools t = FindTools();
			if (t.mpv.empty()) {
				why = "mpv.exe isn't installed. See the setup card.";
				return false;
			}
			if (t.ytdlp.empty()) {
				why = "yt-dlp.exe isn't installed. See the setup card.";
				return false;
			}
			int vol;
			{
				std::lock_guard l(g_dataMx);
				vol = g_vol;
			}
			std::wstring cmd = L"\"" + t.mpv + L"\" --no-config --idle=yes --no-video --force-window=no --no-terminal"
							   L" --audio-display=no --volume-max=100 --volume=" + std::to_wstring(vol) +
							   L" --input-ipc-server=" + PipeName() +
							   L" --ytdl=yes --ytdl-format=bestaudio/best"
							   L" --script-opts=ytdl_hook-ytdl_path=" + Arg(Narrow(t.ytdlp));
			for (const auto& o : YtdlOptions(t))
				cmd += L" --ytdl-raw-options-append=" + Arg(o);
			PROCESS_INFORMATION pi{};
			if (!Spawn(cmd, t, nullptr, nullptr, pi)) {
				why = "Couldn't start mpv.exe.";
				logger::warn("music-player: mpv CreateProcess failed ({})", GetLastError());
				return false;
			}
			w_proc = pi.hProcess;
			const auto name = PipeName();
			for (int i = 0; i < 100 && w_pipe == INVALID_HANDLE_VALUE; ++i) {
				if (WaitForSingleObject(w_proc, 0) != WAIT_TIMEOUT)
					break;
				w_pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
				if (w_pipe == INVALID_HANDLE_VALUE)
					std::this_thread::sleep_for(std::chrono::milliseconds(50));
			}
			if (w_pipe == INVALID_HANDLE_VALUE) {
				why = "mpv started but its control pipe never opened.";
				logger::warn("music-player: mpv pipe did not open");
				KillMpv();
				return false;
			}
			// Everything the page shows arrives as property-change events.
			const char* props[] = { "time-pos", "duration", "pause", "idle-active", "media-title",
				"paused-for-cache", "user-data/mpv/ytdl/json-subprocess-result" };
			for (int i = 0; i < static_cast<int>(std::size(props)); ++i)
				Send(json{ { "command", json::array({ "observe_property", i + 1, props[i] }) } });
			{
				std::lock_guard l(g_sMx);
				g_s.running = true;
			}
			logger::info("music-player: mpv started (pid {}, tools {})", pi.dwProcessId, Narrow(t.dir));
			return true;
		}

		// Load g_queue[g_qi]. Worker thread.
		void LoadCurrent()
		{
			Video v;
			{
				std::lock_guard l(g_sMx);
				if (g_qi < 0 || g_qi >= static_cast<int>(g_queue.size()))
					return;
				v = g_queue[g_qi];
			}
			std::string why;
			if (!EnsureMpv(why)) {
				std::lock_guard l(g_sMx);
				g_s.error = why;
				g_s.loading = false;
				return;
			}
			w_ytdlErr.clear();
			{
				std::lock_guard l(g_sMx);
				g_s.loading = true;
				g_s.error.clear();
				g_s.pos = g_s.dur = 0.0;
				g_s.mediaTitle.clear();
			}
			Send(json{ { "command", json::array({ "loadfile", v.url, "replace" }) } });
			Send(json{ { "command", json::array({ "set_property", "pause", false }) } });
			logger::info("music-player: loading \"{}\" ({})", v.title, v.url);
		}

		// Next index after the current one finished, per the repeat mode;
		// -1 = the queue is done. Caller holds g_sMx.
		int NextIndexLocked(bool userSkip)
		{
			std::string rep;
			{
				std::lock_guard l(g_dataMx);
				rep = g_repeat;
			}
			const int n = static_cast<int>(g_queue.size());
			if (n == 0)
				return -1;
			if (rep == "one" && !userSkip)
				return g_qi;
			if (g_qi + 1 < n)
				return g_qi + 1;
			return rep == "all" ? 0 : -1;
		}

		void OnFileLoaded()
		{
			Video v;
			{
				std::lock_guard l(g_sMx);
				g_s.loading = false;
				g_s.playing = true;
				if (g_qi >= 0 && g_qi < static_cast<int>(g_queue.size()))
					v = g_queue[g_qi];
			}
			if (v.url.empty())
				return;
			std::lock_guard l(g_dataMx);
			const auto key = KeyOf(v);
			g_recents.erase(std::remove_if(g_recents.begin(), g_recents.end(), [&](const Video& r) { return KeyOf(r) == key; }), g_recents.end());
			g_recents.insert(g_recents.begin(), v);
			if (g_recents.size() > kMaxRecents)
				g_recents.resize(kMaxRecents);
			SaveSidecarLocked();
		}

		void OnEndFile(const json& ev)
		{
			const auto reason = ev.value("reason", std::string());
			if (reason == "stop" || reason == "redirect")
				return;   // we replaced it ourselves, or a playlist expanded
			bool next = false;
			{
				std::lock_guard l(g_sMx);
				g_s.playing = false;
				g_s.loading = false;
				g_s.pos = 0.0;
				if (reason == "error") {
					g_s.error = w_ytdlErr.empty() ? "That track wouldn't play (" + ev.value("file_error", std::string("unknown error")) + ")." : Friendly(w_ytdlErr);
					logger::warn("music-player: track failed: {}", g_s.error);
				}
				if (reason == "eof" || reason == "error") {
					// An error with repeat-one would spin on the same broken
					// item; step past it instead.
					const int ni = reason == "error" ? (g_qi + 1 < static_cast<int>(g_queue.size()) ? g_qi + 1 : -1) : NextIndexLocked(false);
					if (ni >= 0) {
						g_qi = ni;
						next = true;
					}
				}
			}
			if (next)
				LoadCurrent();
		}

		void OnMpvMessage(const json& m)
		{
			if (m.contains("event") && m["event"].is_string()) {
				const auto ev = m["event"].get<std::string>();
				if (ev == "file-loaded")
					OnFileLoaded();
				else if (ev == "end-file")
					OnEndFile(m);
				else if (ev == "start-file") {
					std::lock_guard l(g_sMx);
					g_s.loading = true;
				}
				if (ev == "property-change") {
					const auto  name = m.value("name", std::string());
					const auto& d = m.contains("data") ? m["data"] : json();
					std::lock_guard l(g_sMx);
					if (name == "time-pos")
						g_s.pos = d.is_number() ? d.get<double>() : 0.0;
					else if (name == "duration")
						g_s.dur = d.is_number() ? d.get<double>() : 0.0;
					else if (name == "pause")
						g_s.paused = d.is_boolean() && d.get<bool>();
					else if (name == "paused-for-cache")
						g_s.buffering = d.is_boolean() && d.get<bool>();
					else if (name == "media-title")
						g_s.mediaTitle = d.is_string() ? d.get<std::string>() : std::string();
					else if (name == "idle-active" && d.is_boolean() && d.get<bool>()) {
						g_s.playing = false;
						g_s.loading = false;
					} else if (name == "user-data/mpv/ytdl/json-subprocess-result" && d.is_string()) {
						const json r = json::parse(d.get<std::string>(), nullptr, false);
						if (r.is_object())
							w_ytdlErr = r.value("stderr", std::string());
					}
				}
			}
			PushAudible();
		}

		void ReadPipe()
		{
			if (w_pipe == INVALID_HANDLE_VALUE)
				return;
			DWORD avail = 0;
			if (!PeekNamedPipe(w_pipe, nullptr, 0, nullptr, &avail, nullptr)) {
				logger::warn("music-player: mpv pipe closed (mpv exited?)");
				KillMpv();
				PushAudible();
				return;
			}
			while (avail > 0) {
				char  buf[8192];
				DWORD got = 0;
				if (!ReadFile(w_pipe, buf, std::min<DWORD>(avail, sizeof(buf)), &got, nullptr) || got == 0)
					break;
				w_buf.append(buf, got);
				avail -= std::min(avail, got);
			}
			size_t nl;
			while ((nl = w_buf.find('\n')) != std::string::npos) {
				const std::string line = w_buf.substr(0, nl);
				w_buf.erase(0, nl + 1);
				const json m = json::parse(line, nullptr, false);
				if (m.is_object())
					OnMpvMessage(m);
			}
		}

		void HandleCmd(const json& c)
		{
			const auto op = c.value("op", std::string());
			if (op == "load") {
				LoadCurrent();
			} else if (op == "stop") {
				if (MpvAlive())
					Send(json{ { "command", json::array({ "stop" }) } });
				std::lock_guard l(g_sMx);
				g_s.playing = g_s.loading = g_s.paused = false;
				g_s.pos = 0.0;
			} else if (op == "toggle") {
				bool idle;
				{
					std::lock_guard l(g_sMx);
					idle = !g_s.playing && !g_s.loading;
				}
				if (idle)
					LoadCurrent();   // the queue's current item, from the top
				else
					Send(json{ { "command", json::array({ "cycle", "pause" }) } });
			} else if (op == "seek") {
				Send(json{ { "command", json::array({ "seek", c.value("sec", 0.0), "absolute" }) } });
			} else if (op == "vol") {
				Send(json{ { "command", json::array({ "set_property", "volume", c.value("v", 60) }) } });
			} else if (op == "quit") {
				KillMpv();
			}
			PushAudible();
		}

		void WorkerLoop()
		{
			logger::info("music-player: stream worker up");
			while (!g_quit.load()) {
				std::deque<json> cmds;
				{
					std::unique_lock l(g_sMx);
					g_cv.wait_for(l, std::chrono::milliseconds(60), [] { return !g_cmds.empty() || g_quit.load(); });
					cmds.swap(g_cmds);
				}
				try {
					for (const auto& c : cmds)
						HandleCmd(c);
					if (w_proc && WaitForSingleObject(w_proc, 0) != WAIT_TIMEOUT) {
						logger::warn("music-player: mpv exited on its own");
						KillMpv();
						PushAudible();
					}
					ReadPipe();
				} catch (const std::exception& e) {
					// A thread that throws takes the game with it.
					logger::error("music-player: worker: {}", e.what());
				}
			}
			KillMpv();
		}

		void Post(json cmd)
		{
			if (!g_workerUp.exchange(true))
				std::thread(WorkerLoop).detach();
			{
				std::lock_guard l(g_sMx);
				g_cmds.push_back(std::move(cmd));
			}
			g_cv.notify_one();
		}

		json StreamJson()
		{
			json j;
			std::lock_guard l(g_sMx);
			j["running"] = g_s.running;
			j["loading"] = g_s.loading;
			j["playing"] = g_s.playing;
			j["paused"] = g_s.paused;
			j["buffering"] = g_s.buffering;
			j["pos"] = g_s.pos;
			j["dur"] = g_s.dur;
			j["mediaTitle"] = g_s.mediaTitle;
			j["error"] = g_s.error;
			j["index"] = g_qi;
			j["queue"] = json::array();
			for (const auto& v : g_queue)
				j["queue"].push_back(VideoOut(v));
			j["audible"] = g_audible.load();
			return j;
		}

		// ===================================================== the engine ==

		// po3 Tweaks keeps the editor ids the engine throws away (MUST
		// records among them) behind an exported getter. Optional: without
		// it a track is named by its plugin and local id.
		const char* Po3EditorId(std::uint32_t formId)
		{
			using GetEditorID = const char* (*)(std::uint32_t);
			static const auto fn = []() -> GetEditorID {
				const auto tweaks = GetModuleHandleW(L"po3_Tweaks.dll");
				return tweaks ? reinterpret_cast<GetEditorID>(GetProcAddress(tweaks, "GetFormEditorID")) : nullptr;
			}();
			return fn ? fn(formId) : nullptr;
		}

		std::string IdOf(const RE::TESForm* form)
		{
			auto* file = form ? form->GetFile(0) : nullptr;
			if (!file)
				return {};
			const std::uint32_t local = form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char                buf[16];
			std::snprintf(buf, sizeof(buf), "%06X", local);
			return std::string(file->GetFilename()) + "|" + buf;
		}

		RE::BGSMusicType* ResolveType(const std::string& id)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0 || bar + 1 >= id.size())
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::BGSMusicType>(static_cast<std::uint32_t>(std::strtoul(id.c_str() + bar + 1, nullptr, 16)), id.substr(0, bar)) : nullptr;
		}

		std::string Plugin(const RE::TESForm* f, std::int32_t i)
		{
			auto* file = f ? f->GetFile(i) : nullptr;
			return file ? std::string(file->GetFilename()) : std::string();
		}

		// "MUSExploreForestPine" -> "Explore Forest Pine"; "_NONE" -> "NONE".
		std::string Pretty(std::string e)
		{
			while (!e.empty() && e.front() == '_')
				e.erase(0, 1);
			if (e.size() > 3 && (e.rfind("MUS", 0) == 0) && std::isupper(static_cast<unsigned char>(e[3])))
				e.erase(0, 3);
			std::string out;
			for (size_t i = 0; i < e.size(); ++i) {
				const char c = e[i];
				if (c == '_') {
					if (!out.empty() && out.back() != ' ')
						out.push_back(' ');
					continue;
				}
				if (i > 0 && !out.empty() && out.back() != ' ') {
					const char p = e[i - 1];
					const bool up = std::isupper(static_cast<unsigned char>(c));
					const bool nextLower = i + 1 < e.size() && std::islower(static_cast<unsigned char>(e[i + 1]));
					if ((up && std::islower(static_cast<unsigned char>(p))) ||
						(up && std::isupper(static_cast<unsigned char>(p)) && nextLower) ||
						(std::isdigit(static_cast<unsigned char>(c)) && !std::isdigit(static_cast<unsigned char>(p))))
						out.push_back(' ');
				}
				out.push_back(c);
			}
			return out;
		}

		const char* KindOf(const std::string& edidLower)
		{
			auto has = [&](const char* s) { return edidLower.find(s) != std::string::npos; };
			if (has("combat"))
				return "combat";
			if (has("explore"))
				return "explore";
			if (has("dungeon") || has("dread"))
				return "dungeon";
			if (has("tavern") || has("town") || has("city") || has("castle") || has("hallofvalor"))
				return "town";
			if (has("discovery") || has("reveal") || has("reward") || has("stinger") || has("success") || has("special") || has("death") || has("wordofpower"))
				return "moment";
			return "other";
		}

		std::string Lower(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		// The engine's own containers, read behind SEH: a pointer in the
		// music queue is the engine's, and a read must never be the CTD.
		struct RawQueue
		{
			RE::BSIMusicType* current = nullptr;
			RE::BSIMusicType* items[48]{};
			std::uint32_t     count = 0;
		};

		bool ReadQueueSEH(RE::BSMusicManager* mgr, RawQueue& out)
		{
			__try {
				out.current = mgr->current;
				const std::uint32_t n = mgr->musicQueue.size();
				out.count = n < 48 ? n : 48;
				for (std::uint32_t i = 0; i < out.count; ++i)
					out.items[i] = mgr->musicQueue[i];
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		RE::BGSMusicType* AsType(RE::BSIMusicType* t)
		{
			__try {
				return t ? skyrim_cast<RE::BGSMusicType*>(t) : nullptr;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return nullptr;
			}
		}

		RE::BGSMusicTrackFormWrapper* AsTrack(RE::BSIMusicTrack* t)
		{
			__try {
				return t ? skyrim_cast<RE::BGSMusicTrackFormWrapper*>(t) : nullptr;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return nullptr;
			}
		}

		const char* TrackKind(RE::BGSMusicTrackFormWrapper* w)
		{
			__try {
				if (!w || !w->track)
					return "track";
				switch (w->track->GetType()) {
				case RE::BSIMusicTrack::TrackType::kPalette:
					return "palette";
				case RE::BSIMusicTrack::TrackType::kSilentTrack:
					return "silence";
				default:
					return "track";
				}
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return "track";
			}
		}

		json TrackJson(RE::BSIMusicTrack* t, std::uint32_t index)
		{
			json  j{ { "index", index } };
			auto* w = AsTrack(t);
			if (!w) {
				j["label"] = "Track " + std::to_string(index + 1);
				j["kind"] = "track";
				return j;
			}
			const char* e = Po3EditorId(w->GetFormID());
			j["edid"] = e ? e : "";
			j["id"] = IdOf(w);
			j["plugin"] = Plugin(w, 0);
			j["kind"] = TrackKind(w);
			j["label"] = (e && *e) ? Pretty(e) : ("Track " + std::to_string(index + 1));
			return j;
		}

		const char* StatusName(RE::BSIMusicType* t)
		{
			using S = RE::BSIMusicType::MUSIC_STATUS;
			__try {
				switch (t->typeStatus.get()) {
				case S::kPlaying:
					return "playing";
				case S::kPaused:
					return "paused";
				case S::kFinishing:
					return "finishing";
				case S::kFinished:
					return "finished";
				default:
					return "waiting";
				}
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return "unknown";
			}
		}

		// Main-thread state.
		RE::BGSMusicType* g_held = nullptr;
		std::uint8_t      g_heldPrio = 0;
		bool              g_heldSeen = false;   // it reached the queue at least once
		std::uint64_t     g_heldAt = 0;

		json TypeBrief(RE::BGSMusicType* t)
		{
			const char*       e = t->formEditorID.c_str();
			const std::string edid = e ? e : "";
			json              j{ { "id", IdOf(t) }, { "edid", edid }, { "label", Pretty(edid) }, { "kind", KindOf(Lower(edid)) },
							 { "priority", t == g_held ? g_heldPrio : t->priority }, { "plugin", Plugin(t, 0) }, { "editedBy", Plugin(t, -1) },
							 { "tracks", t->tracks.size() } };
			return j;
		}

		bool CallMusicType(RE::BGSMusicType* t, const char* fn)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !t)
				return false;
			auto*      policy = vm->GetObjectHandlePolicy();
			const auto handle = policy ? policy->GetHandleForObject(RE::BGSMusicType::FORMTYPE, t) : 0;
			if (!policy || handle == policy->EmptyHandle())
				return false;
			auto                                                  args = RE::MakeFunctionArguments();
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			return vm->DispatchMethodCall(handle, "MusicType", fn, args, cb);
		}

		void ReleaseHeld(bool callRemove)
		{
			if (!g_held)
				return;
			if (callRemove)
				CallMusicType(g_held, "Remove");
			g_held->priority = g_heldPrio;
			logger::info("music-player: released {} (priority back to {})", g_held->formEditorID.c_str(), g_heldPrio);
			g_held = nullptr;
			g_heldSeen = false;
		}

		bool Hold(RE::BGSMusicType* t)
		{
			if (g_held && g_held != t)
				ReleaseHeld(true);
			if (!g_held) {
				g_heldPrio = t->priority;
				g_held = t;
			}
			t->priority = 1;   // lower wins; 1 is what the death and Word Wall types use
			g_heldSeen = false;
			g_heldAt = GetTickCount64();
			const bool ok = CallMusicType(t, "Add");
			logger::info("music-player: hold {} (was priority {}) dispatch {}", t->formEditorID.c_str(), g_heldPrio, ok);
			return ok;
		}

		json EngineJson()
		{
			json  j{ { "ok", false } };
			auto* mgr = RE::BSMusicManager::GetSingleton();
			if (!mgr)
				return j;
			RawQueue raw;
			if (!ReadQueueSEH(mgr, raw))
				return j;
			j["ok"] = true;
			bool heldPresent = false;
			if (auto* cur = AsType(raw.current)) {
				auto c = TypeBrief(cur);
				c["status"] = StatusName(cur);
				const std::uint32_t idx = cur->currentTrackIndex;
				if (idx < cur->tracks.size())
					c["track"] = TrackJson(cur->tracks[idx], idx);
				j["current"] = std::move(c);
				heldPresent = heldPresent || cur == g_held;
			}
			j["queue"] = json::array();
			for (std::uint32_t i = 0; i < raw.count; ++i)
				if (auto* t = AsType(raw.items[i])) {
					auto q = TypeBrief(t);
					q["status"] = StatusName(t);
					j["queue"].push_back(std::move(q));
					heldPresent = heldPresent || t == g_held;
				}
			// A held type that has played and then left the queue (a
			// plays-once type finished, or the game removed it) is no longer
			// held: put its priority back. Not before it was ever seen — the
			// Add waits for the deck to close.
			if (g_held) {
				if (heldPresent)
					g_heldSeen = true;
				else if (g_heldSeen || GetTickCount64() - g_heldAt > 10 * 60 * 1000)
					ReleaseHeld(false);
			}
			j["held"] = g_held ? TypeBrief(g_held) : json();
			return j;
		}

		json TypesJson()
		{
			json  out = json::array();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return out;
			for (auto* t : dh->GetFormArray<RE::BGSMusicType>()) {
				if (!t)
					continue;
				auto j = TypeBrief(t);
				j["list"] = json::array();
				const std::uint32_t n = t->tracks.size();
				for (std::uint32_t i = 0; i < n && i < 400; ++i)
					j["list"].push_back(TrackJson(t->tracks[i], i));
				out.push_back(std::move(j));
			}
			return out;
		}

		// ===================================================== the mute ==

		RE::BGSSoundCategory* MusicCategory()
		{
			// Skyrim.esm AudioCategoryMUS — read out of the plugin, 2026-10-14.
			static RE::BGSSoundCategory* cat = nullptr;
			if (!cat)
				if (auto* dh = RE::TESDataHandler::GetSingleton())
					cat = dh->LookupForm<RE::BGSSoundCategory>(0x071E64, "Skyrim.esm");
			return cat;
		}

		float g_savedMusVol = -1.0f;   // main thread; >= 0 while we hold it at 0

		void ApplyMuteTask()
		{
			bool mute;
			{
				std::lock_guard l(g_dataMx);
				mute = g_mute;
			}
			auto* cat = MusicCategory();
			if (!cat)
				return;
			const bool want = mute && g_audible.load();
			if (want && g_savedMusVol < 0.0f) {
				g_savedMusVol = cat->GetCategoryVolume();
				cat->SetCategoryVolume(0.0f);
				logger::info("music-player: game music muted for the stream (was {:.2f})", g_savedMusVol);
			} else if (!want && g_savedMusVol >= 0.0f) {
				cat->SetCategoryVolume(g_savedMusVol);
				logger::info("music-player: game music volume back to {:.2f}", g_savedMusVol);
				g_savedMusVol = -1.0f;
			}
		}

		// ================================================== the payload ==

		int PlSeqNow()
		{
			std::lock_guard l(g_dataMx);
			return g_plSeq;
		}

		// plKnown: the playlist generation the view already holds; the lists
		// are sent only when it differs (-1 = always).
		json StateObj(bool full, int plKnown)
		{
			json j;
			j["engine"] = EngineJson();
			j["stream"] = StreamJson();
			j["tools"] = ToolsJson(FindTools());
			{
				std::lock_guard l(g_searchMx);
				json s{ { "seq", g_search.seq }, { "q", g_search.q }, { "busy", g_search.busy }, { "error", g_search.error }, { "title", g_search.title } };
				s["results"] = json::array();
				for (const auto& v : g_search.results)
					s["results"].push_back(VideoOut(v));
				j["search"] = std::move(s);
			}
			{
				std::lock_guard l(g_dataMx);
				j["favTypes"] = json::array();
				for (const auto& f : g_favTypes)
					j["favTypes"].push_back(f);
				j["favVideos"] = json::array();
				for (const auto& v : g_favVideos)
					j["favVideos"].push_back(VideoOut(v));
				j["recents"] = json::array();
				for (const auto& v : g_recents)
					j["recents"].push_back(VideoOut(v));
				j["settings"] = json{ { "vol", g_vol }, { "mute", g_mute }, { "repeat", g_repeat } };
				j["plSeq"] = g_plSeq;
				if (full || plKnown != g_plSeq) {
					j["playlists"] = json::array();
					for (const auto& p : g_playlists) {
						json items = json::array();
						for (const auto& v : p.items)
							items.push_back(VideoOut(v));
						j["playlists"].push_back(json{ { "id", p.id }, { "name", p.name }, { "items", std::move(items) } });
					}
				}
			}
			j["muted"] = g_savedMusVol >= 0.0f;
			j["thumbSeq"] = g_thumbSeq.load();
			j["po3"] = GetModuleHandleW(L"po3_Tweaks.dll") != nullptr;
			if (full)
				j["types"] = TypesJson();
			return j;
		}

		// withPl: the action changed a playlist, so the lists ride along.
		json Reply(bool ok, const std::string& msg, json extra = json::object(), bool withPl = false)
		{
			json j = std::move(extra);
			j["ok"] = ok;
			j["msg"] = msg;
			j["state"] = StateObj(false, withPl ? -1 : PlSeqNow());
			return j;
		}

		// Caller holds g_dataMx.
		Playlist* FindPlaylistLocked(const std::string& id)
		{
			for (auto& p : g_playlists)
				if (p.id == id)
					return &p;
			return nullptr;
		}

		std::string CleanName(std::string n)
		{
			for (auto& c : n)
				if (c == '\r' || c == '\n' || c == '\t')
					c = ' ';
			n.erase(0, n.find_first_not_of(' '));
			if (const auto e = n.find_last_not_of(' '); e != std::string::npos)
				n.resize(e + 1);
			else
				n.clear();
			if (n.size() > kMaxPlName) {
				n.resize(kMaxPlName);
				// never leave half a UTF-8 sequence at the cut
				while (!n.empty() && (static_cast<unsigned char>(n.back()) & 0xC0) == 0x80)
					n.pop_back();
				if (!n.empty() && (static_cast<unsigned char>(n.back()) & 0x80))
					n.pop_back();
			}
			return n;
		}

		// Appends what is not already in the list; returns how many went in.
		int AddToPlaylistLocked(Playlist& p, const std::vector<Video>& items)
		{
			std::set<std::string> have;
			for (const auto& v : p.items)
				have.insert(KeyOf(v));
			int n = 0;
			for (const auto& v : items) {
				if (p.items.size() >= kMaxPlItems)
					break;
				if (have.insert(KeyOf(v)).second) {
					p.items.push_back(v);
					++n;
				}
			}
			return n;
		}

		std::vector<Video> VideosFrom(const json& arr)
		{
			std::vector<Video> out;
			if (!arr.is_array())
				return out;
			for (const auto& e : arr) {
				Video v;
				if (VideoFrom(e, v))
					out.push_back(std::move(v));
			}
			return out;
		}
	}

	void Init()
	{
		LoadSidecar();
		std::vector<std::string> ids;
		{
			std::lock_guard l(g_dataMx);
			for (const auto& v : g_favVideos)
				ids.push_back(v.id);
			for (const auto& v : g_recents)
				ids.push_back(v.id);
			for (const auto& p : g_playlists)
				for (const auto& v : p.items)
					ids.push_back(v.id);
		}
		FetchThumbs(std::move(ids));
		const Tools t = FindTools();
		logger::info("music-player: init (mpv {}, yt-dlp {}, js {}, po3 {})", t.mpv.empty() ? "missing" : "found",
			t.ytdlp.empty() ? "missing" : "found", t.deno ? "deno" : (t.node.empty() ? "none" : "node"),
			GetModuleHandleW(L"po3_Tweaks.dll") ? "yes" : "no");
	}

	void OnGameLoading()
	{
		ReleaseHeld(false);
	}

	void OnGameLoaded()
	{
		// The category is a form; a load does not reset it, but re-assert so
		// a stream that was audible across the load stays the only music.
		if (g_savedMusVol >= 0.0f)
			if (auto* cat = MusicCategory())
				cat->SetCategoryVolume(0.0f);
		ApplyMuteTask();
	}

	namespace
	{
		std::string StateJsonImpl(const std::string& req)
		{
			const json r = json::parse(req, nullptr, false);
			const bool full = r.is_object() && r.value("full", false);
			const int  plKnown = r.is_object() && r.contains("plSeq") && r["plSeq"].is_number_integer() ? r["plSeq"].get<int>() : -1;
			return Dump(StateObj(full, plKnown));
		}

		std::string SetJsonImpl(const std::string& req)
		{
			const json r = json::parse(req, nullptr, false);
			if (!r.is_object())
				return Dump(Reply(false, "Bad request."));
			const auto act = r.value("act", std::string());

			// ---- Skyrim's own music -------------------------------------------
			if (act == "sk-play") {
				auto* t = ResolveType(r.value("id", std::string()));
				if (!t)
					return Dump(Reply(false, "That music type isn't in the load order."));
				if (!Hold(t))
					return Dump(Reply(false, "Papyrus wouldn't take the call."));
				return Dump(Reply(true, Pretty(t->formEditorID.c_str()) + " plays as you close the deck, and stays until you release it."));
			}
			if (act == "sk-release") {
				if (!g_held)
					return Dump(Reply(true, "Nothing held."));
				ReleaseHeld(true);
				return Dump(Reply(true, "Released - Skyrim picks the music again as you close the deck."));
			}
			if (act == "sk-again") {
				// Another track from the held type: Remove then Add, both queued
				// in order, so the type starts over with a fresh pick.
				if (!g_held)
					return Dump(Reply(false, "Hold a music type first."));
				CallMusicType(g_held, "Remove");
				auto* t = g_held;
				g_heldSeen = false;
				g_heldAt = GetTickCount64();
				CallMusicType(t, "Add");
				return Dump(Reply(true, "A new track from " + Pretty(t->formEditorID.c_str()) + " as you close the deck."));
			}

			// ---- favourites, settings -----------------------------------------
			if (act == "fav") {
				const auto kind = r.value("kind", std::string());
				const bool on = r.value("on", true);
				const auto id = r.value("id", std::string());
				Video      v;
				if (kind == "type" ? id.find('|') == std::string::npos : (kind != "video" || !VideoFrom(r.contains("item") ? r["item"] : json(), v)))
					return Dump(Reply(false, "Bad favourite."));
				std::lock_guard l(g_dataMx);
				if (kind == "type") {
					if (on)
						g_favTypes.insert(id);
					else
						g_favTypes.erase(id);
				} else {
					const auto key = KeyOf(v);
					g_favVideos.erase(std::remove_if(g_favVideos.begin(), g_favVideos.end(), [&](const Video& f) { return KeyOf(f) == key; }), g_favVideos.end());
					if (on)
						g_favVideos.insert(g_favVideos.begin(), v);
				}
				SaveSidecarLocked();
			}
			if (act == "fav")   // outside the lock: Reply() takes g_dataMx itself
				return Dump(Reply(true, r.value("on", true) ? "Starred." : "Unstarred."));

			if (act == "mute") {
				{
					std::lock_guard l(g_dataMx);
					g_mute = r.value("on", true);
					SaveSidecarLocked();
				}
				ApplyMuteTask();
				return Dump(Reply(true, g_mute ? "Game music goes quiet while a stream plays." : "Game music keeps playing under the stream."));
			}
			if (act == "yt-repeat") {
				const auto m = r.value("mode", std::string("off"));
				{
					std::lock_guard l(g_dataMx);
					g_repeat = (m == "one" || m == "all") ? m : "off";
					SaveSidecarLocked();
				}
				return Dump(Reply(true, "Repeat: " + m + "."));
			}
			if (act == "yt-vol") {
				const int v = std::clamp(r.value("v", 60), 0, 100);
				{
					std::lock_guard l(g_dataMx);
					g_vol = v;
					SaveSidecarLocked();
				}
				if (g_workerUp.load())
					Post(json{ { "op", "vol" }, { "v", v } });
				return Dump(Reply(true, ""));
			}

			// ---- saved playlists ----------------------------------------------
			// Every branch edits under g_dataMx, then replies outside it
			// (Reply() takes the lock itself).
			if (act.rfind("pl-", 0) == 0) {
				auto items = VideosFrom(r.contains("items") ? r["items"] : json::array());
				if (Video v; VideoFrom(r.contains("item") ? r["item"] : json(), v))
					items.push_back(std::move(v));
				const auto id = r.value("id", std::string());
				std::string msg;
				json        extra = json::object();
				bool        ok = true;
				{
					std::lock_guard l(g_dataMx);
					Playlist*       p = act == "pl-new" ? nullptr : FindPlaylistLocked(id);
					if (act != "pl-new" && !p) {
						ok = false;
						msg = "That playlist is gone.";
					} else if (act == "pl-new") {
						const auto name = CleanName(r.value("name", std::string()));
						if (name.empty()) {
							ok = false;
							msg = "Give the playlist a name.";
						} else if (g_playlists.size() >= kMaxPlaylists) {
							ok = false;
							msg = "That's " + std::to_string(kMaxPlaylists) + " playlists - delete one first.";
						} else {
							Playlist np;
							// ms since the epoch, nudged past any id already taken
							auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
							do
								np.id = "pl" + std::to_string(ms++);
							while (FindPlaylistLocked(np.id));
							np.name = name;
							const int n = AddToPlaylistLocked(np, items);
							extra["id"] = np.id;
							msg = "Made \"" + name + "\"" + (n ? " with " + std::to_string(n) + (n == 1 ? " song." : " songs.") : ".");
							g_playlists.push_back(std::move(np));
						}
					} else if (act == "pl-rename") {
						const auto name = CleanName(r.value("name", std::string()));
						if (name.empty()) {
							ok = false;
							msg = "Give the playlist a name.";
						} else {
							p->name = name;
							msg = "Renamed.";
						}
					} else if (act == "pl-delete") {
						msg = "Deleted \"" + p->name + "\".";
						g_playlists.erase(g_playlists.begin() + (p - g_playlists.data()));
					} else if (act == "pl-add") {
						if (items.empty()) {
							ok = false;
							msg = "Nothing to add.";
						} else {
							const int n = AddToPlaylistLocked(*p, items);
							msg = n ? (n == 1 ? "Added to \"" + p->name + "\"." : std::to_string(n) + " songs added to \"" + p->name + "\".")
							        : (p->items.size() >= kMaxPlItems ? "\"" + p->name + "\" is full." : "Already in \"" + p->name + "\".");
						}
					} else if (act == "pl-drop") {
						const int i = r.value("index", -1);
						if (i < 0 || i >= static_cast<int>(p->items.size())) {
							ok = false;
							msg = "No such song.";
						} else
							p->items.erase(p->items.begin() + i);
					} else if (act == "pl-move") {
						const int n = static_cast<int>(p->items.size());
						const int from = r.value("from", -1), to = r.value("to", -1);
						if (from < 0 || from >= n || to < 0 || to >= n) {
							ok = false;
							msg = "Can't move that.";
						} else if (from != to) {
							Video v = std::move(p->items[from]);
							p->items.erase(p->items.begin() + from);
							p->items.insert(p->items.begin() + to, std::move(v));
						}
					} else {
						ok = false;
						msg = "Unknown action.";
					}
					if (ok) {
						++g_plSeq;
						SaveSidecarLocked();
						logger::info("music-player: playlist {} -> {}", act, extra.contains("id") ? extra["id"].get<std::string>() : id);
					}
				}
				if (ok && !items.empty()) {
					std::vector<std::string> ids;
					for (const auto& v : items)
						ids.push_back(v.id);
					FetchThumbs(std::move(ids));
				}
				return Dump(Reply(ok, msg, std::move(extra), true));
			}

			// ---- the stream ---------------------------------------------------
			if (act == "yt-search") {
				std::string q = r.value("q", std::string());
				q.erase(0, q.find_first_not_of(" \t"));
				if (const auto e = q.find_last_not_of(" \t\r\n"); e != std::string::npos)
					q.resize(e + 1);
				if (q.empty() || q.size() > 400)
					return Dump(Reply(false, "Type something to search for."));
				StartSearch(q);
				return Dump(Reply(true, "Searching..."));
			}
			if (act == "yt-play" || act == "yt-add") {
				auto items = VideosFrom(r.contains("items") ? r["items"] : json::array());
				if (items.empty()) {
					Video v;
					if (VideoFrom(r.contains("item") ? r["item"] : json(), v))
						items.push_back(std::move(v));
				}
				if (items.empty())
					return Dump(Reply(false, "Nothing to play."));
				std::vector<std::string> ids;
				for (const auto& v : items)
					ids.push_back(v.id);
				FetchThumbs(ids);
				bool load = false;
				{
					std::lock_guard l(g_sMx);
					if (act == "yt-play") {
						g_queue = std::move(items);
						g_qi = std::clamp(r.value("index", 0), 0, static_cast<int>(g_queue.size()) - 1);
						load = true;
					} else {
						const bool idle = !g_s.playing && !g_s.loading;
						for (auto& v : items)
							g_queue.push_back(std::move(v));
						if (idle) {
							g_qi = static_cast<int>(g_queue.size()) - 1;
							load = true;
						}
					}
				}
				if (load)
					Post(json{ { "op", "load" } });
				return Dump(Reply(true, act == "yt-play" ? "Loading..." : (load ? "Loading..." : "Added to the queue.")));
			}
			if (act == "yt-jump" || act == "yt-next" || act == "yt-prev") {
				bool load = false;
				{
					std::lock_guard l(g_sMx);
					const int n = static_cast<int>(g_queue.size());
					int       to = -1;
					if (act == "yt-jump")
						to = r.value("index", -1);
					else if (act == "yt-next")
						to = NextIndexLocked(true);
					else
						to = g_s.pos > 4.0 ? g_qi : g_qi - 1;   // like every player: back to the start first
					if (to >= 0 && to < n) {
						g_qi = to;
						load = true;
					}
				}
				if (!load)
					return Dump(Reply(false, act == "yt-prev" ? "Already at the start of the queue." : "That's the end of the queue."));
				Post(json{ { "op", "load" } });
				return Dump(Reply(true, ""));
			}
			if (act == "yt-drop") {
				const int i = r.value("index", -1);
				bool      stop = false, bad = false;
				{
					std::lock_guard l(g_sMx);
					bad = i < 0 || i >= static_cast<int>(g_queue.size());
					if (!bad) {
						g_queue.erase(g_queue.begin() + i);
						if (i < g_qi)
							--g_qi;
						else if (i == g_qi) {
							stop = true;
							if (g_qi >= static_cast<int>(g_queue.size()))
								g_qi = static_cast<int>(g_queue.size()) - 1;
						}
					}
				}
				if (bad)
					return Dump(Reply(false, "No such item."));
				if (stop)
					Post(json{ { "op", "stop" } });
				return Dump(Reply(true, ""));
			}
			if (act == "yt-clear") {
				{
					std::lock_guard l(g_sMx);
					g_queue.clear();
					g_qi = -1;
				}
				if (g_workerUp.load())
					Post(json{ { "op", "stop" } });
				return Dump(Reply(true, "Queue cleared."));
			}
			if (act == "yt-toggle") {
				bool empty;
				{
					std::lock_guard l(g_sMx);
					empty = g_queue.empty();
					if (!empty && g_qi < 0)
						g_qi = 0;
				}
				if (empty)
					return Dump(Reply(false, "Nothing queued - search for something first."));
				Post(json{ { "op", "toggle" } });
				return Dump(Reply(true, ""));
			}
			if (act == "yt-stop") {
				if (g_workerUp.load())
					Post(json{ { "op", "stop" } });
				return Dump(Reply(true, "Stopped."));
			}
			if (act == "yt-seek") {
				const double sec = std::max(0.0, r.value("sec", 0.0));
				if (g_workerUp.load())
					Post(json{ { "op", "seek" }, { "sec", sec } });
				return Dump(Reply(true, ""));
			}
			if (act == "tools-update") {
				const Tools t = FindTools();
				if (t.ytdlp.empty())
					return Dump(Reply(false, "yt-dlp.exe isn't installed."));
				std::thread([t]() {
					std::string out, err;
					DWORD       code = 1;
					RunCapture(L"\"" + t.ytdlp + L"\" -U", t, 120000, out, err, code);
					logger::info("music-player: yt-dlp -U exit {}: {}", code, out.substr(0, 300));
				}).detach();
				return Dump(Reply(true, "Updating yt-dlp in the background (a minute at most)."));
			}
			return Dump(Reply(false, "Unknown action."));
		}
	}

	// Both run on the SKSE task thread, where an escaping exception is a CTD.
	std::string StateJson(const std::string& req)
	{
		try {
			return StateJsonImpl(req);
		} catch (const std::exception& e) {
			logger::error("music-player: state failed: {}", e.what());
			return R"({"ok":false,"msg":"The music state failed - see HotkeyDeck.log."})";
		}
	}

	std::string SetJson(const std::string& req)
	{
		try {
			return SetJsonImpl(req);
		} catch (const std::exception& e) {
			logger::error("music-player: action failed: {}", e.what());
			return R"({"ok":false,"msg":"That failed - see HotkeyDeck.log."})";
		}
	}

	void Shutdown()
	{
		g_quit.store(true);
		g_cv.notify_all();
		std::lock_guard l(g_jobMx);
		if (g_job) {
			CloseHandle(g_job);   // KILL_ON_JOB_CLOSE takes mpv and any yt-dlp
			g_job = nullptr;
		}
	}
}
