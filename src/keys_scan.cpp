// Keys tab scan engine. See keys_scan.h for the source-by-source overview.
//
// Threading: Start() spawns one detached scan thread. The filesystem sources
// (helper/chord) and the ControlMap read are synchronous on that thread; the
// MCM sweep dispatches GetCustomControl through the Papyrus VM one config at a
// time (windowed calls in flight), with the string results delivered on the VM
// thread into a mutex-guarded vector. A config that never answers (a broken
// script) times out after 3s and the sweep moves on -- one bad MCM must not
// hang the whole scan, and it is remembered as dead so it is skipped until the
// next FORCED rescan.
//
// Cache: the classic MCM sweep is the only slow source (~28k VM calls on a
// 107-MCM order), so each config's answer is persisted to a disk sidecar keyed
// by mod name + script-class identity. A non-forced Start() publishes cached
// rows instantly (phase "done"), then re-sweeps in the background ("refreshing")
// and swaps a config's rows in place when the fresh answer differs -- so an
// in-game rebind (stored in the SAVE, invisible to a disk key) self-heals within
// one pass while the tab stays useful from the first frame.

#include "keys_scan.h"

#include "keys_pex.h"
#include "keys_sources.h"
#include "pch.h"
#include <SKSE/InputMap.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "json.hpp"

#include <Windows.h>

// Something in this TU's include graph pulls <Windows.h> without NOMINMAX:
// `min` breaks std::min and `GetObject` renames Variable::GetObject to
// GetObjectA. Neutralize both -- file scope, nothing here wants the macros.
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

using json = nlohmann::json;

namespace KeysScan
{
	namespace
	{
		// ------------------------------------------------------------ state --

		struct Binding
		{
			std::string src;      // vanilla | deck | chord | helper | mcm | plugin | enb | reshade | shaders
			std::string mod;      // display name of the owner
			std::string control;  // display name of the function on the key
			std::uint32_t code;   // SKSE macro: keyboard 1..255, mouse 256..265, pad 266..281
			std::string modsText; // "" or "Shift+Alt" (deck triggers / chords)
			// Set only by the generic plugin-config source, where the file states
			// no code space and DIK is an assumption (keys_sources.h). The pane
			// shows such a row as assumed and never lets it alone raise a hard
			// conflict -- two codes that may not be in the same space cannot be
			// honestly called a collision.
			bool        guessed = false;
			std::string detail;   // provenance (file + setting), shown as a title
		};

		std::mutex               g_mutex;
		// idle | scanning | refreshing | done | error.
		// "scanning"   = blocking sweep, no usable rows yet (cold / forced).
		// "refreshing" = cached rows are already shown; a background re-sweep is
		//                catching up. The view treats this as usable-but-updating.
		std::string              g_phase = "idle";
		std::string              g_note;            // currentMod while sweeping, error text on error
		int                      g_modsDone = 0;
		int                      g_modsTotal = 0;
		std::vector<Binding>     g_bindings;        // usable whenever phase is done/refreshing
		std::atomic<bool>        g_running{ false };
		std::uint64_t            g_scanSeq = 0;     // bumps whenever g_bindings changes; view uses it for staleness

		std::function<std::vector<OwnBinding>()> g_ownProvider;
		std::atomic<bool>                        g_forceScan{ false };  // set by a "Rescan all"

		// --------------------------------------------------------- cache ------
		// One entry per classic MCM config, keyed by mod name. `ident` is the
		// script-class identity (the config's Papyrus class name) so a mod
		// swapped for a different one under the same display name re-sweeps; a
		// bare rename keeps the same class and its cache carries over. `codes`
		// holds only the keyboard/mouse codes the config claimed (small); `dead`
		// records a config that timed out, so it is skipped until a forced rescan.
		struct CacheEntry
		{
			std::string                                        ident;
			bool                                               dead = false;
			std::vector<std::pair<std::uint32_t, std::string>> codes;  // code -> control label
		};
		std::unordered_map<std::string, CacheEntry> g_cache;  // mod name -> entry
		bool                                        g_cacheLoaded = false;

		// ---------------------------------------------------------- text -----
		// Every string in the census goes to the view as JSON, and nlohmann's
		// dump() THROWS (type_error 316) on a byte that is not UTF-8. That is a
		// CTD, not an error: the dump runs inside a PrismaUI listener and nothing
		// above it catches (Nexus report, 2026-10-06, Chinese-localized order:
		// "invalid UTF-8 byte at index 1: 0x07"). The labels come from places we
		// do not control -- Papyrus strings (MCM names, GetCustomControl answers,
		// .pex string tables) and plugin ini files, which a localized order often
		// writes in the ANSI code page (GBK on a Chinese system) -- so every one
		// is repaired here before it reaches JSON:
		//   valid UTF-8      -> unchanged (the ASCII fast path is nearly all rows)
		//   valid in CP_ACP  -> converted, so a GBK label shows as real Chinese
		//   neither          -> bad bytes become U+FFFD, never a throw
		std::string Utf8Of(std::string_view s, bool& repaired)
		{
			repaired = false;
			if (std::all_of(s.begin(), s.end(), [](char c) { return static_cast<unsigned char>(c) < 0x80; })) {
				return std::string(s);
			}
			const int len = static_cast<int>(s.size());
			if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), len, nullptr, 0) > 0) {
				return std::string(s);
			}
			repaired = true;
			// ACP first; failing that, CP_UTF8 without MB_ERR_INVALID_CHARS
			// substitutes U+FFFD for each bad sequence.
			UINT cp = CP_ACP;
			int  wn = MultiByteToWideChar(cp, MB_ERR_INVALID_CHARS, s.data(), len, nullptr, 0);
			if (wn <= 0) {
				cp = CP_UTF8;
				wn = MultiByteToWideChar(cp, 0, s.data(), len, nullptr, 0);
			}
			if (wn <= 0) {
				return std::string(s.size(), '?');
			}
			std::wstring w(static_cast<std::size_t>(wn), L'\0');
			MultiByteToWideChar(cp, cp == CP_UTF8 ? 0 : MB_ERR_INVALID_CHARS, s.data(), len, w.data(), wn);
			const int un = WideCharToMultiByte(CP_UTF8, 0, w.data(), wn, nullptr, 0, nullptr, nullptr);
			std::string out(static_cast<std::size_t>((std::max)(un, 0)), '\0');
			if (un > 0) {
				WideCharToMultiByte(CP_UTF8, 0, w.data(), wn, out.data(), un, nullptr, nullptr);
			}
			return out;
		}

		std::string Utf8Of(std::string_view s)
		{
			bool repaired = false;
			return Utf8Of(s, repaired);
		}

		// UTF-16LE (no BOM) -> UTF-8. Lone surrogates come out as U+FFFD.
		std::string Utf8OfWide(std::wstring_view w)
		{
			if (w.empty()) {
				return {};
			}
			const int wn = static_cast<int>(w.size());
			const int un = WideCharToMultiByte(CP_UTF8, 0, w.data(), wn, nullptr, 0, nullptr, nullptr);
			if (un <= 0) {
				return {};
			}
			std::string out(static_cast<std::size_t>(un), '\0');
			WideCharToMultiByte(CP_UTF8, 0, w.data(), wn, out.data(), un, nullptr, nullptr);
			return out;
		}

		// Each repaired row is logged ONCE per session (StateJson runs on every
		// poll), naming the row and its raw bytes, so the source can be found.
		std::unordered_set<std::string> g_repairLogged;  // guarded by g_mutex

		void SetPhase(const std::string& phase, const std::string& note = "")
		{
			std::lock_guard l(g_mutex);
			g_phase = phase;
			g_note = note;
		}

		// Publish a new binding set and bump the seq so the view knows to pull it.
		// Caller must NOT hold g_mutex.
		void PublishBindings(std::vector<Binding> v)
		{
			std::lock_guard l(g_mutex);
			g_bindings = std::move(v);
			++g_scanSeq;
		}

		// ----------------------------------------------------- cache i/o ------

		std::filesystem::path CachePath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "keys-cache.json";
		}

		// Load the sidecar once per session. Best-effort: a missing/garbled cache
		// is simply an empty cache, never an error -- the first scan rebuilds it.
		void LoadCache()
		{
			if (g_cacheLoaded) {
				return;
			}
			g_cacheLoaded = true;
			std::ifstream in(CachePath(), std::ios::binary);
			if (!in) {
				return;
			}
			const auto doc = json::parse(in, nullptr, false);
			if (doc.is_discarded() || !doc.is_object() || !doc.contains("configs") || !doc["configs"].is_object()) {
				return;
			}
			for (const auto& [name, e] : doc["configs"].items()) {
				if (!e.is_object()) {
					continue;
				}
				CacheEntry ce;
				ce.ident = e.value("ident", "");
				ce.dead = e.value("dead", false);
				if (e.contains("codes") && e["codes"].is_array()) {
					for (const auto& row : e["codes"]) {
						if (!row.is_array() || row.size() < 2 || !row[0].is_number_integer()) {
							continue;
						}
						const auto code = row[0].get<std::int64_t>();
						if (code <= 0 || code > 265) {
							continue;  // untrusted file: same bounds the sweep enforces
						}
						ce.codes.emplace_back(static_cast<std::uint32_t>(code),
							row[1].is_string() ? row[1].get<std::string>() : std::string());
					}
				}
				g_cache[name] = std::move(ce);
			}
			logger::info("keys-cache loaded: {} config(s) from disk", g_cache.size());
		}

		// Atomic write, mirroring main.cpp's config save: serialise first, write a
		// sibling .tmp, flush, then NTFS-atomic rename over the real file so a torn
		// write can never leave a zero-length or half-JSON cache. Best-effort:
		// failing to persist the cache must never fail a scan.
		void SaveCache()
		{
			try {
				json configs = json::object();
				{
					std::lock_guard l(g_mutex);
					for (const auto& [name, ce] : g_cache) {
						json codes = json::array();
						for (const auto& [code, label] : ce.codes) {
							codes.push_back(json::array({ code, Utf8Of(label) }));
						}
						configs[Utf8Of(name)] = json{
							{ "ident", ce.ident },
							{ "dead", ce.dead },
							{ "codes", std::move(codes) },
						};
					}
				}
				json j{ { "version", 1 }, { "configs", std::move(configs) } };
				const std::string text = j.dump(-1, ' ', false, json::error_handler_t::replace);

				const auto path = CachePath();
				std::error_code ec;
				std::filesystem::create_directories(path.parent_path(), ec);
				auto tmp = path;
				tmp += ".tmp";
				{
					std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
					if (!out.is_open()) {
						logger::warn("keys-cache: could not open {} for writing", PathU8(tmp));
						return;
					}
					out << text;
					out.flush();
					if (!out.good()) {
						logger::warn("keys-cache: write to {} failed mid-stream", PathU8(tmp));
						return;
					}
				}
				std::filesystem::rename(tmp, path, ec);
				if (ec) {
					logger::warn("keys-cache: atomic swap failed: {}", ec.message());
				}
			} catch (const std::exception& e) {
				logger::warn("keys-cache: save error: {}", e.what());
			}
		}

		// -------------------------------------------------------- vm idioms --
		// Local copies of the house idioms (nff_bases.cpp) -- each deck module
		// carries its own so none grows a dependency on another's internals.

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		RE::BSTSmartPointer<RE::BSScript::Object> BindScript(RE::TESForm* form, const char* cls)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			auto*                                     vm = Vm();
			if (!form || !cls || !vm)
				return obj;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return obj;
			const auto handle = policy->GetHandleForObject(form->GetFormType(), form);
			if (handle == policy->EmptyHandle())
				return obj;
			if (vm->FindBoundObject(handle, cls, obj) && obj)
				return obj;
			obj.reset();
			const auto lower = Lower(cls);
			if (lower != cls && vm->FindBoundObject(handle, lower.c_str(), obj) && obj)
				return obj;
			obj.reset();
			return obj;
		}

		RE::BSScript::Variable* ScriptVar(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (auto* v = obj->GetProperty(name))
				return v;
			return obj->GetVariable(name);
		}

		// The string a GetCustomControl call returns, delivered on the VM
		// thread. No main-thread hop: the consumer is our own scan thread's
		// counter + results vector, both designed for cross-thread writes.
		class StringResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			StringResult(std::function<void(std::string)> then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				std::string s;
				if (a_result.IsString())
					s = std::string(a_result.GetString());
				if (_then)
					_then(std::move(s));
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(std::string)> _then;
		};

		// -------------------------------------------------------- vanilla ----

		void ScanControlMap(std::vector<Binding>& out)
		{
			auto* cm = RE::ControlMap::GetSingleton();
			if (!cm) {
				return;
			}
			// Gameplay context only: menu contexts rebind the whole keyboard and
			// would drown the list in engine-internal rows nobody asked about.
			const auto* ctx = cm->controlMap[RE::UserEvents::INPUT_CONTEXT_ID::kGameplay];
			if (!ctx) {
				return;
			}
			const auto add = [&out](const RE::ControlMap::UserEventMapping& m, std::uint32_t codeBase) {
				if (m.inputKey == 0xFF || m.inputKey == 0xFFFF) {
					return;  // unbound
				}
				if (!m.eventID.c_str() || !*m.eventID.c_str()) {
					return;
				}
				out.push_back(Binding{ "vanilla", "Skyrim", m.eventID.c_str(),
					codeBase + m.inputKey, "" });
			};
			for (const auto& m : ctx->deviceMappings[RE::INPUT_DEVICE::kKeyboard]) {
				add(m, 0);
			}
			for (const auto& m : ctx->deviceMappings[RE::INPUT_DEVICE::kMouse]) {
				add(m, 256);  // SkyUI/MCM convention: mouse = 256 + button
			}
			// HotkeyAtlas's visual controller map consumes the SAME census as the
			// keyboard. Convert engine masks to SKSE macro codes, never mix raw
			// XInput bits with keyboard DIKs. Analog axes and unbound masks are
			// not buttons; CommonLib returns kMaxMacros for unsupported masks.
			std::size_t padCount = 0;
			for (const auto& m : ctx->deviceMappings[RE::INPUT_DEVICE::kGamepad]) {
				if (m.inputKey == 0xFF || m.inputKey == 0xFFFF || m.eventID.empty()) continue;
				const auto code = SKSE::InputMap::GamepadMaskToKeycode(m.inputKey);
				if (code < SKSE::InputMap::kMacro_GamepadOffset || code >= SKSE::InputMap::kMaxMacros) continue;
				out.push_back(Binding{ "vanilla", "Skyrim", m.eventID.c_str(), code, "", false,
					"Live ControlMap / Gameplay / Controller" });
				++padCount;
			}
			logger::info("keys-atlas-gamepad: {} gameplay button bindings", padCount);
		}

		// ---------------------------------------------------------- chords ---

		void ScanChordKeys(std::vector<Binding>& out)
		{
			std::ifstream in("Data/SKSE/Plugins/ChordKeys/chords.json");
			if (!in) {
				return;  // Chord Keys not installed -- not an error
			}
			const auto doc = json::parse(in, nullptr, false);
			if (doc.is_discarded() || !doc.contains("chords") || !doc["chords"].is_array()) {
				return;
			}
			for (const auto& c : doc["chords"]) {
				const auto base = c.value("base", 0);
				const auto mask = c.value("mask", 0);
				const auto virt = c.value("virt", 0);
				if (base <= 0 || virt <= 0) {
					continue;
				}
				std::string mods;
				if (mask & 1) mods += "Shift+";
				if (mask & 2) mods += "Ctrl+";
				if (mask & 4) mods += "Alt+";
				if (!mods.empty()) {
					mods.pop_back();
				}
				out.push_back(Binding{ "chord", "Chord Keys",
					std::format("chord -> output 0x{:02X}", virt),
					static_cast<std::uint32_t>(base), mods });
				// The OUTPUT key is claimed too -- that is the whole point of the
				// pool, and a mod bound to it shows up as sharing this row.
				out.push_back(Binding{ "chord", "Chord Keys",
					"chord output", static_cast<std::uint32_t>(virt), "" });
			}
		}

		// ------------------------------------------------------ mcm helper ---

		// "$Key" -> translated text via the mod's ENGLISH translation file.
		// UTF-16LE with BOM, tab-separated. Missing file / key: prettified key.
		using Translations = std::unordered_map<std::string, std::string>;

		Translations LoadTranslations(const std::string& modName)
		{
			Translations t;
			const auto path = std::format("Data/Interface/Translations/{}_ENGLISH.txt", modName);
			std::ifstream in(path, std::ios::binary);
			if (!in) {
				return t;
			}
			std::string raw((std::istreambuf_iterator<char>(in)), {});
			if (raw.size() < 2 || static_cast<unsigned char>(raw[0]) != 0xFF || static_cast<unsigned char>(raw[1]) != 0xFE) {
				return t;  // not UTF-16LE -- unexpected, skip rather than mis-parse
			}
			// Decode the UTF-16 properly. This used to narrow by dropping each
			// unit's high byte ("labels are ASCII in practice") -- but localized
			// orders ship translated text in the _ENGLISH file (the game reads no
			// other one on an English install), and 切 (U+5207) narrowed that way
			// is a raw 0x07: the byte in the 2026-10-06 Nexus CTD.
			std::wstring wide;
			wide.reserve((raw.size() - 2) / 2);
			for (std::size_t i = 2; i + 1 < raw.size(); i += 2) {
				const auto unit = static_cast<wchar_t>(
					static_cast<unsigned char>(raw[i]) | (static_cast<unsigned char>(raw[i + 1]) << 8));
				if (unit != L'\r') {
					wide += unit;
				}
			}
			const std::string text = Utf8OfWide(wide);
			std::size_t pos = 0;
			while (pos < text.size()) {
				auto eol = text.find('\n', pos);
				if (eol == std::string::npos) {
					eol = text.size();
				}
				const auto line = text.substr(pos, eol - pos);
				pos = eol + 1;
				const auto tab = line.find('\t');
				if (tab == std::string::npos || line.empty() || line[0] != '$') {
					continue;
				}
				t[line.substr(0, tab)] = line.substr(tab + 1);
			}
			return t;
		}

		std::string Translate(const Translations& t, const std::string& s)
		{
			if (s.empty() || s[0] != '$') {
				return s;
			}
			if (const auto it = t.find(s); it != t.end()) {
				return it->second;
			}
			return s.substr(1);  // "$iEquip_cycleKey" -> "iEquip_cycleKey"
		}

		// A bare-bones ini reader: [Section] key=value, later files overlay.
		using IniMap = std::unordered_map<std::string, std::string>;  // "section:key" -> value

		void LoadIni(const std::filesystem::path& path, IniMap& into)
		{
			std::ifstream in(path);
			if (!in) {
				return;
			}
			std::string line, section;
			while (std::getline(in, line)) {
				while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) {
					line.pop_back();
				}
				std::size_t b = 0;
				while (b < line.size() && (line[b] == ' ' || line[b] == '\t')) {
					++b;
				}
				if (b) {
					line.erase(0, b);
				}
				if (line.empty() || line[0] == ';' || line[0] == '#') {
					continue;
				}
				if (line.front() == '[' && line.back() == ']') {
					section = Lower(line.substr(1, line.size() - 2));
					continue;
				}
				const auto eq = line.find('=');
				if (eq == std::string::npos) {
					continue;
				}
				auto key = Lower(line.substr(0, eq));
				while (!key.empty() && (key.back() == ' ' || key.back() == '\t')) {
					key.pop_back();
				}
				auto val = line.substr(eq + 1);
				std::size_t vb = 0;
				while (vb < val.size() && (val[vb] == ' ' || val[vb] == '\t')) {
					++vb;
				}
				into[section + ":" + key] = val.substr(vb);
			}
		}

		// Every {"type":"keymap"} object anywhere in the page tree.
		void FindKeymaps(const json& node, std::vector<const json*>& out)
		{
			if (node.is_object()) {
				if (node.value("type", "") == "keymap" && node.contains("id")) {
					out.push_back(&node);
				}
				for (const auto& [k, v] : node.items()) {
					(void)k;
					FindKeymaps(v, out);
				}
			} else if (node.is_array()) {
				for (const auto& v : node) {
					FindKeymaps(v, out);
				}
			}
		}

		void ScanMcmHelper(std::vector<Binding>& out)
		{
			namespace fs = std::filesystem;
			std::error_code ec;
			for (const auto& dir : fs::directory_iterator("Data/MCM/Config", ec)) {
				if (!dir.is_directory()) {
					continue;
				}
				const auto cfgPath = dir.path() / "config.json";
				std::ifstream in(cfgPath);
				if (!in) {
					continue;
				}
				const auto doc = json::parse(in, nullptr, false);
				if (doc.is_discarded() || !doc.is_object()) {
					continue;
				}
				const auto modName = doc.value("modName", PathU8(dir.path().filename()));

				std::vector<const json*> keymaps;
				FindKeymaps(doc, keymaps);
				if (keymaps.empty()) {
					continue;
				}

				const auto trans = LoadTranslations(modName);
				const auto display = Translate(trans, doc.value("displayName", modName));

				IniMap ini;
				LoadIni(dir.path() / "settings.ini", ini);          // mod defaults
				LoadIni("Data/MCM/Settings/" + modName + ".ini", ini);         // user values win

				for (const auto* km : keymaps) {
					const auto id = km->value("id", "");
					if (id.empty()) {
						continue;
					}
					// id = "keyName:Section"; MCM Helper defaults a colon-less id
					// to section [Main] (verified on the rig: 6 of 100 keymaps ship
					// colon-less -- Sunhelm, tent_pitcher, TCL).
					const auto  colon = id.find(':');
					std::string sect = colon == std::string::npos ? "main" : Lower(id.substr(colon + 1));
					std::string key = colon == std::string::npos ? Lower(id) : Lower(id.substr(0, colon));
					int         code = -1;
					if (const auto it = ini.find(sect + ":" + key); it != ini.end()) {
						try {
							code = std::stoi(it->second);
						} catch (...) {
						}
					}
					// > 265 rejects non-scancode encodings some mods stash in a
					// keymap slot (BowRapidCombo stores 888 there); 256..265 are the
					// SkyUI mouse buttons + wheel, everything below is keyboard.
					if (code <= 0 || code > 265) {
						continue;  // unbound, or not a key at all
					}
					auto label = Translate(trans, km->value("text", id));
					out.push_back(Binding{ "helper", display, std::move(label),
						static_cast<std::uint32_t>(code), "" });
				}
			}
		}

		// ------------------------------------------------------- mcm sweep ---

		struct McmConfig
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			std::string                               name;   // display name (cache key)
			std::string                               ident;  // Papyrus class name (cache identity)
		};

		// The config's Papyrus class name -- its cache identity. A mod renamed in
		// its display name keeps the same class (cache carries over); a display
		// name reused by a genuinely different script gets a fresh sweep because
		// the class differs. Empty if the VM can't name the type.
		std::string ClassOf(const RE::BSTSmartPointer<RE::BSScript::Object>& obj)
		{
			if (!obj) {
				return {};
			}
			// GetTypeInfo() returns a BSTSmartPointer<ObjectTypeInfo> (bind by
			// value/ref, not a raw pointer); GetName() is a const char*.
			const auto& type = obj->GetTypeInfo();
			if (type) {
				if (const char* nm = type->GetName(); nm && *nm) {
					return std::string(nm);
				}
			}
			return {};
		}

		// SKI_ConfigManager's registered configs. The manager quest is found by
		// its attached script, never by FormID -- SkyUI's plugin name varies
		// (SkyUI_SE.esp) and an EDID lookup needs no such knowledge.
		std::vector<McmConfig> RegisteredConfigs()
		{
			std::vector<McmConfig> out;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh) {
				return out;
			}
			RE::BSTSmartPointer<RE::BSScript::Object> mgr;
			for (auto* quest : dh->GetFormArray<RE::TESQuest>()) {
				if ((mgr = BindScript(quest, "SKI_ConfigManager"))) {
					break;
				}
			}
			if (!mgr) {
				logger::warn("keys-scan: SKI_ConfigManager not found (SkyUI missing?)");
				return out;
			}

			auto* configs = ScriptVar(mgr.get(), "_modConfigs");
			auto* names = ScriptVar(mgr.get(), "_modNames");
			if (!configs || !configs->IsArray() || !names || !names->IsArray()) {
				logger::warn("keys-scan: SKI_ConfigManager arrays missing -- SkyUI layout changed?");
				return out;
			}
			auto configArr = configs->GetArray();
			auto nameArr = names->GetArray();
			if (!configArr || !nameArr) {
				return out;
			}
			const auto n = (std::min)(configArr->size(), nameArr->size());
			for (std::uint32_t i = 0; i < n; ++i) {
				auto& slot = (*configArr)[i];
				if (!slot.IsObject() || slot.IsNoneObject()) {
					continue;  // the manager keeps None gaps in its fixed array
				}
				auto obj = slot.GetObject();
				if (!obj) {
					continue;
				}
				std::string nm;
				auto& nameVar = (*nameArr)[i];
				if (nameVar.IsString()) {
					nm = Utf8Of(nameVar.GetString());  // Papyrus text may be ANSI (see Utf8Of)
				}
				if (nm.empty()) {
					nm = "MCM #" + std::to_string(i);
				}
				auto ident = ClassOf(obj);
				out.push_back(McmConfig{ std::move(obj), std::move(nm), std::move(ident) });
			}
			return out;
		}

		// Ask ONE config about every key/mouse code and wait (bounded) for the
		// answers, returning the claimed (code -> label) pairs. Windowed at 32
		// calls in flight: a Papyrus function call is a whole VM stack, and 263 at
		// once per config is the kind of burst that trips the VM's suspended-stack
		// warnings on a loaded save. 32 keeps the sweep fast (~8 drain waits per
		// config) without leaning on the VM -- deliberately left at 32; raising it
		// buys little (the per-config cost is dominated by the VM's own scheduling
		// of the suspended stacks, not our drain waits) and risks the very warnings
		// the window exists to avoid. The real win is not sweeping at all when the
		// cache already has the answer.
		//
		// Timeout dropped 10s -> 3s: a broken script that will never answer costs
		// 3s instead of 10, so several dead configs no longer add half a minute to
		// a scan. `timedOut` is reported so the caller can remember it as dead and
		// skip it next time.
		std::vector<std::pair<std::uint32_t, std::string>> SweepConfig(const McmConfig& cfg, bool& timedOut)
		{
			constexpr std::uint32_t kFirst = 1, kLast = 263;  // keyboard + mouse
			constexpr int           kWindow = 32;
			constexpr auto          kTimeout = std::chrono::seconds(3);

			timedOut = false;
			std::vector<std::pair<std::uint32_t, std::string>> result;

			auto* vm = Vm();
			if (!vm) {
				return result;
			}

			struct Shared
			{
				std::mutex                                          m;
				std::condition_variable                             cv;
				int                                                 pending = 0;
				std::vector<std::pair<std::uint32_t, std::string>>  found;
			};
			auto shared = std::make_shared<Shared>();

			int dispatched = 0;
			for (std::uint32_t k = kFirst; k <= kLast && !timedOut; ++k) {
				RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
					new StringResult([shared, k](std::string s) {
						std::lock_guard l(shared->m);
						if (!s.empty()) {
							shared->found.emplace_back(k, Utf8Of(s));
						}
						--shared->pending;
						shared->cv.notify_one();
					}));
				auto args = RE::MakeFunctionArguments(std::move(static_cast<std::int32_t>(k)));
				{
					std::lock_guard l(shared->m);
					++shared->pending;
				}
				auto obj = cfg.obj;  // DispatchMethodCall1 takes a non-const ref
				if (!vm->DispatchMethodCall1(obj, "GetCustomControl", args, cb)) {
					std::lock_guard l(shared->m);
					--shared->pending;
				} else {
					++dispatched;
				}

				std::unique_lock l(shared->m);
				if (!shared->cv.wait_for(l, kTimeout,
						[&shared] { return shared->pending < kWindow; })) {
					timedOut = true;  // the VM stopped answering -- stop feeding it
				}
			}

			std::unique_lock l(shared->m);
			const bool complete = shared->cv.wait_for(l, kTimeout,
				[&shared] { return shared->pending == 0; });
			if (!complete || timedOut) {
				// Abandon the stragglers: the functors keep shared alive via the
				// shared_ptr, so a late answer lands harmlessly in the orphaned
				// struct instead of a freed one.
				timedOut = true;
				logger::warn("keys-scan: '{}' answered {}/{} -- timed out (3s), remembering as dead",
					cfg.name, dispatched - shared->pending, dispatched);
			}
			result = std::move(shared->found);
			return result;
		}

		// The complete non-MCM half of the census (ControlMap, MCM Helper, Chord,
		// deck, the renderer overlays and the generic plugin configs) -- the
		// "instant" sources. Rebuilt on every scan; cheap.
		std::vector<Binding> InstantSources()
		{
			std::vector<Binding> acc;
			ScanControlMap(acc);
			ScanChordKeys(acc);
			ScanMcmHelper(acc);
			if (g_ownProvider) {
				for (auto& b : g_ownProvider()) {
					acc.push_back(Binding{ "deck", "SkyManager", std::move(b.control), b.code, std::move(b.modsText) });
				}
			}
			// File-based sources (keys_sources.cpp): ENB / ReShade / Community
			// Shaders, then every hotkey setting under Data/SKSE/Plugins.
			const auto take = [&acc](std::vector<KeysSources::Row> rows) {
				for (auto& r : rows) {
					acc.push_back(Binding{ std::move(r.src), std::move(r.mod), std::move(r.control),
						r.code, std::move(r.modsText), r.guessed, std::move(r.detail) });
				}
			};
			take(KeysSources::ScanOverlays());
			take(KeysSources::ScanPluginConfigs());
			return acc;
		}

		// Turn a cache entry (or a fresh sweep result) into census rows. A dead
		// config with no cached codes gets one honest "didn't answer" row so it is
		// visible in the census instead of silently missing.
		void EmitConfigRows(const std::string& name, const CacheEntry& ce, std::vector<Binding>& out)
		{
			if (ce.dead && ce.codes.empty()) {
				out.push_back(Binding{ "mcm", name, "(didn't answer -- rescan to retry)", 0, "" });
				return;
			}
			for (const auto& [code, control] : ce.codes) {
				out.push_back(Binding{ "mcm", name, control, code, "" });
			}
		}

		// Rebuild the full binding set from the instant sources plus the current
		// cache, and publish it. Used after each background config refresh so the
		// changed rows swap in place. Row with code 0 (the "didn't answer"
		// sentinel) is carried through; the view groups by code and drops 0.
		void RepublishFromCache(const std::vector<Binding>& instant)
		{
			std::vector<Binding> acc = instant;
			std::lock_guard l(g_mutex);
			for (const auto& [name, ce] : g_cache) {
				EmitConfigRows(name, ce, acc);
			}
			g_bindings = std::move(acc);
			++g_scanSeq;
		}

		// ------------------------------------------------------ the thread ---

		void ScanThread()
		{
			const bool force = g_forceScan.exchange(false);

			try {
				LoadCache();
				logger::info("keys-cache: persistent MCM sweep cache active (force={})", force);

				// A forced "Rescan all" trusts nothing on disk: drop the in-memory
				// cache so partials during the sweep only ever show freshly-read
				// configs, never last session's rows. The disk file is overwritten
				// by SaveCache() at the end of this pass.
				if (force) {
					std::lock_guard l(g_mutex);
					g_cache.clear();
				}

				// The instant sources are always rebuilt fresh -- they are cheap
				// and reflect live state (user ControlMap remaps, MCM Helper .ini).
				SetPhase("scanning", "game controls & MCM Helper");
				std::vector<Binding> instant = InstantSources();

				// Compiled Papyrus is the one file source that is not instant on
				// a cold cache -- it walks every loose script in Data/Scripts --
				// so the cheap rows are painted FIRST and the walk runs under its
				// own progress note. An empty tab for its duration would read as
				// a hang. (A warm cache makes it near-free, and the publish below
				// happens again either way.)
				PublishBindings(instant);
				SetPhase("scanning", "reading compiled Papyrus");
				for (auto& r : KeysPex::Scan(force)) {
					instant.push_back(Binding{ "papyrus", std::move(r.script),
						std::move(r.control), r.code, "", false, std::move(r.detail) });
				}

				auto configs = RegisteredConfigs();
				{
					std::lock_guard l(g_mutex);
					g_modsTotal = static_cast<int>(configs.size());
					g_modsDone = 0;
				}

				// Does this config already have a usable cache answer (a live sweep
				// result or a remembered-dead marker under the SAME class)? Returns
				// a value copy of {usable, dead} taken under the lock, so no pointer
				// into g_cache leaks past the lock.
				struct CacheHit { bool usable = false; bool dead = false; };
				const auto cachedFresh = [&](const McmConfig& cfg) -> CacheHit {
					if (force) {
						return {};  // "Rescan all" ignores the cache entirely
					}
					std::lock_guard l(g_mutex);
					auto it = g_cache.find(cfg.name);
					if (it == g_cache.end()) {
						return {};
					}
					// A cached entry is only trusted if its class identity matches;
					// a class swapped under the same display name gets a fresh sweep.
					if (!it->second.ident.empty() && !cfg.ident.empty() && it->second.ident != cfg.ident) {
						return {};
					}
					return CacheHit{ true, it->second.dead };
				};

				int cachedCount = 0;
				for (const auto& cfg : configs) {
					if (cachedFresh(cfg).usable) {
						++cachedCount;
					}
				}

				// ---- Phase 1: first frame ---------------------------------------
				// Non-forced with any cache: show cached rows at once. If EVERY
				// config is already cached we are "done" from frame one and the
				// pass below is a pure background refresh; otherwise "refreshing"
				// (usable rows on screen, the rest filling in). Forced or fully
				// cold: show the instant half so the tab isn't blank, phase
				// "scanning" (no usable MCM rows yet).
				const int total = static_cast<int>(configs.size());
				const bool warmStart = !force && cachedCount > 0;
				if (warmStart) {
					RepublishFromCache(instant);
					SetPhase(cachedCount >= total ? "done" : "refreshing",
						cachedCount >= total ? "" : "catching up");
				} else {
					PublishBindings(instant);
					SetPhase("scanning", "starting MCM sweep");
				}
				{
					std::lock_guard l(g_mutex);
					g_modsDone = 0;  // configs PROCESSED this pass, 0..total
				}

				// ---- Phase 2: sweep, replacing rows in place -------------------
				// Every config is visited so an in-game rebind self-heals, but a
				// config is only republished when its answer DIFFERS from the
				// cache -- nothing jumps under the user for an unchanged mod. A
				// cached-dead config is skipped on a non-forced pass (that is the
				// point of remembering it) yet still counts as processed.
				bool anyChanged = false;
				for (const auto& cfg : configs) {
					const CacheHit cached = cachedFresh(cfg);

					if (cached.usable && cached.dead) {
						std::lock_guard l(g_mutex);
						++g_modsDone;
						continue;
					}

					SetPhase(warmStart ? "refreshing" : "scanning", cfg.name);

					bool timedOut = false;
					auto fresh = SweepConfig(cfg, timedOut);
					std::sort(fresh.begin(), fresh.end());  // sweep order is arrival order

					CacheEntry ne;
					ne.ident = cfg.ident;
					ne.dead = timedOut;
					ne.codes = fresh;

					bool changed = true;
					{
						std::lock_guard l(g_mutex);
						auto it = g_cache.find(cfg.name);
						if (it != g_cache.end()) {
							auto old = it->second.codes;
							std::sort(old.begin(), old.end());
							changed = (old != ne.codes) || (it->second.dead != ne.dead) ||
							          (it->second.ident != ne.ident);
						}
						g_cache[cfg.name] = std::move(ne);
						++g_modsDone;
					}

					if (changed) {
						anyChanged = true;
						RepublishFromCache(instant);
					}
				}

				// Rows for configs that vanished from the load order shouldn't
				// linger in the cache. Prune anything not seen this pass (forced
				// scans and full non-forced passes both visit every config).
				{
					std::lock_guard l(g_mutex);
					std::unordered_map<std::string, bool> seen;
					for (const auto& cfg : configs) {
						seen[cfg.name] = true;
					}
					for (auto it = g_cache.begin(); it != g_cache.end();) {
						it = seen.count(it->first) ? std::next(it) : g_cache.erase(it);
					}
				}

				// Final publish so the pruned set + any last change is reflected.
				RepublishFromCache(instant);
				SaveCache();

				{
					std::lock_guard l(g_mutex);
					g_modsDone = g_modsTotal;
					g_phase = "done";
					g_note.clear();
					logger::info("keys-scan complete: {} bindings across {} MCM mods "
						"(cache: {} reused, {} swept, changed={})",
						g_bindings.size(), g_modsTotal, cachedCount,
						g_modsTotal - cachedCount, anyChanged);
				}
			} catch (const std::exception& e) {
				logger::error("keys-scan failed: {}", e.what());
				SetPhase("error", e.what());
			} catch (...) {
				logger::error("keys-scan failed: unknown exception");
				SetPhase("error", "unknown error");
			}
			g_running.store(false);
		}
	}

	// ------------------------------------------------------------- public ----

	void SetOwnKeysProvider(std::function<std::vector<OwnBinding>()> provider)
	{
		g_ownProvider = std::move(provider);
	}

	bool Start(bool force)
	{
		bool expected = false;
		if (!g_running.compare_exchange_strong(expected, true)) {
			return false;
		}
		g_forceScan.store(force);
		{
			std::lock_guard l(g_mutex);
			g_phase = "scanning";
			g_note = "starting";
			g_modsDone = 0;
			g_modsTotal = 0;
		}
		std::thread(ScanThread).detach();
		logger::info("keys-scan started ({}, cache-backed mcm sweep + helper + controlmap)",
			force ? "forced rescan" : "cache-first");
		return true;
	}

	std::string Utf8Text(std::string_view s)
	{
		return Utf8Of(s);
	}

	std::string StateJson(bool includeBindings)
	{
		std::lock_guard l(g_mutex);
		json j{
			{ "phase", g_phase },
			{ "note", Utf8Of(g_note) },
			{ "modsDone", g_modsDone },
			{ "modsTotal", g_modsTotal },
			{ "count", g_bindings.size() },
			{ "seq", g_scanSeq },
			{ "gamepad", true },
		};
		if (includeBindings) {
			json arr = json::array();
			for (const auto& b : g_bindings) {
				// Repair each text field (Utf8Of) and name the row once in the
				// log, raw bytes in hex, so a localized label can be traced
				// back to the file or script that produced it.
				const auto clean = [&b](const char* field, const std::string& text) {
					bool repaired = false;
					auto out = Utf8Of(text, repaired);
					if (repaired && g_repairLogged.insert(b.src + '\x1f' + b.mod + '\x1f' + field + '\x1f' + text).second) {
						std::string hex;
						for (std::size_t i = 0; i < text.size() && i < 48; ++i) {
							hex += std::format("{:02X} ", static_cast<unsigned char>(text[i]));
						}
						logger::warn("keys-scan: {} row '{}' (code {}) {} was not UTF-8 -- shown as '{}'; raw bytes: {}",
							b.src, Utf8Of(b.mod), b.code, field, out, hex);
					}
					return out;
				};
				json e{
					{ "src", clean("src", b.src) },
					{ "mod", clean("mod", b.mod) },
					{ "control", clean("control", b.control) },
					{ "code", b.code },
				};
				if (!b.modsText.empty()) {
					e["mods"] = clean("mods", b.modsText);
				}
				if (b.guessed) {
					e["guess"] = true;
				}
				if (!b.detail.empty()) {
					e["detail"] = clean("detail", b.detail);
				}
				arr.push_back(std::move(e));
			}
			j["bindings"] = std::move(arr);
		}
		// replace, never strict: Utf8Of already repaired every field, and a
		// strict dump that throws here is a CTD (it runs inside a JS listener).
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}
}
