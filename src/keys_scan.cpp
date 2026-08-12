// Keys tab scan engine. See keys_scan.h for the source-by-source overview.
//
// Threading: Start() spawns one detached scan thread. The filesystem sources
// (helper/chord) and the ControlMap read are synchronous on that thread; the
// MCM sweep dispatches GetCustomControl through the Papyrus VM one config at a
// time (all key codes in flight at once), with the string results delivered on
// the VM thread into a mutex-guarded vector. A config that never answers (a
// broken script) times out after 10s and the sweep moves on -- one bad MCM must
// not hang the whole scan.

#include "keys_scan.h"

#include "pch.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

#include "json.hpp"

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
			std::string src;      // vanilla | deck | chord | helper | mcm
			std::string mod;      // display name of the owner
			std::string control;  // display name of the function on the key
			std::uint32_t code;   // DXScanCode (keyboard 1..255, mouse 256..263)
			std::string modsText; // "" or "Shift+Alt" (deck triggers / chords)
		};

		std::mutex               g_mutex;
		std::string              g_phase = "idle";  // idle | scanning | done | error
		std::string              g_note;            // currentMod while sweeping, error text on error
		int                      g_modsDone = 0;
		int                      g_modsTotal = 0;
		std::vector<Binding>     g_bindings;        // complete only when phase == done
		std::atomic<bool>        g_running{ false };
		std::uint64_t            g_scanSeq = 0;     // bumps per finished scan; view uses it for staleness

		std::function<std::vector<OwnBinding>()> g_ownProvider;

		void SetPhase(const std::string& phase, const std::string& note = "")
		{
			std::lock_guard l(g_mutex);
			g_phase = phase;
			g_note = note;
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
			// Narrow by dropping high bytes: translation keys/labels are ASCII
			// in practice, and a lossy label beats no label.
			std::string text;
			for (std::size_t i = 2; i + 1 < raw.size(); i += 2) {
				const char lo = raw[i];
				if (lo != '\r') {
					text += lo;
				}
			}
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

		void LoadIni(const std::string& path, IniMap& into)
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
				const auto modName = doc.value("modName", dir.path().filename().string());

				std::vector<const json*> keymaps;
				FindKeymaps(doc, keymaps);
				if (keymaps.empty()) {
					continue;
				}

				const auto trans = LoadTranslations(modName);
				const auto display = Translate(trans, doc.value("displayName", modName));

				IniMap ini;
				LoadIni((dir.path() / "settings.ini").string(), ini);          // mod defaults
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
			std::string                               name;
		};

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
					nm = std::string(nameVar.GetString());
				}
				if (nm.empty()) {
					nm = "MCM #" + std::to_string(i);
				}
				out.push_back(McmConfig{ std::move(obj), std::move(nm) });
			}
			return out;
		}

		// Ask ONE config about every key/mouse code and wait (bounded) for the
		// answers. Windowed at 32 calls in flight: a Papyrus function call is a
		// whole VM stack, and 263 at once per config is the kind of burst that
		// trips the VM's suspended-stack warnings on a loaded save. 32 keeps the
		// sweep fast (~8 drain waits per config) without leaning on the VM.
		void SweepConfig(const McmConfig& cfg, std::vector<Binding>& out)
		{
			constexpr std::uint32_t kFirst = 1, kLast = 263;  // keyboard + mouse
			constexpr int           kWindow = 32;

			auto* vm = Vm();
			if (!vm) {
				return;
			}

			struct Shared
			{
				std::mutex                                          m;
				std::condition_variable                             cv;
				int                                                 pending = 0;
				std::vector<std::pair<std::uint32_t, std::string>>  found;
			};
			auto shared = std::make_shared<Shared>();

			int  dispatched = 0;
			bool timedOut = false;
			for (std::uint32_t k = kFirst; k <= kLast && !timedOut; ++k) {
				RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
					new StringResult([shared, k](std::string s) {
						std::lock_guard l(shared->m);
						if (!s.empty()) {
							shared->found.emplace_back(k, std::move(s));
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
				if (!shared->cv.wait_for(l, std::chrono::seconds(10),
						[&shared] { return shared->pending < kWindow; })) {
					timedOut = true;  // the VM stopped answering -- stop feeding it
				}
			}

			std::unique_lock l(shared->m);
			const bool complete = shared->cv.wait_for(l, std::chrono::seconds(10),
				[&shared] { return shared->pending == 0; });
			if (!complete || timedOut) {
				// Abandon the stragglers: the functors keep shared alive via the
				// shared_ptr, so a late answer lands harmlessly in the orphaned
				// struct instead of a freed one.
				logger::warn("keys-scan: '{}' answered {}/{} -- timed out, moving on",
					cfg.name, dispatched - shared->pending, dispatched);
			}
			for (auto& [code, control] : shared->found) {
				out.push_back(Binding{ "mcm", cfg.name, std::move(control), code, "" });
			}
		}

		// ------------------------------------------------------ the thread ---

		void ScanThread()
		{
			std::vector<Binding> acc;

			try {
				SetPhase("scanning", "game controls");
				ScanControlMap(acc);
				ScanChordKeys(acc);

				SetPhase("scanning", "MCM Helper configs");
				ScanMcmHelper(acc);

				if (g_ownProvider) {
					for (auto& b : g_ownProvider()) {
						acc.push_back(Binding{ "deck", "SkyManager", std::move(b.control), b.code, std::move(b.modsText) });
					}
				}

				// Publish the file-backed half immediately: the view has real
				// rows to show while the (slower) live sweep runs.
				{
					std::lock_guard l(g_mutex);
					g_bindings = acc;
				}

				auto configs = RegisteredConfigs();
				{
					std::lock_guard l(g_mutex);
					g_modsTotal = static_cast<int>(configs.size());
					g_modsDone = 0;
				}
				for (const auto& cfg : configs) {
					SetPhase("scanning", cfg.name);
					SweepConfig(cfg, acc);
					{
						std::lock_guard l(g_mutex);
						++g_modsDone;
						g_bindings = acc;  // keep partials visible
					}
				}

				{
					std::lock_guard l(g_mutex);
					g_bindings = std::move(acc);
					g_phase = "done";
					g_note.clear();
					++g_scanSeq;
					logger::info("keys-scan complete: {} bindings across {} MCM mods",
						g_bindings.size(), g_modsTotal);
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

	bool Start()
	{
		bool expected = false;
		if (!g_running.compare_exchange_strong(expected, true)) {
			return false;
		}
		{
			std::lock_guard l(g_mutex);
			g_phase = "scanning";
			g_note = "starting";
			g_modsDone = 0;
			g_modsTotal = 0;
		}
		std::thread(ScanThread).detach();
		logger::info("keys-scan started (mcm sweep + helper + controlmap)");
		return true;
	}

	std::string StateJson(bool includeBindings)
	{
		std::lock_guard l(g_mutex);
		json j{
			{ "phase", g_phase },
			{ "note", g_note },
			{ "modsDone", g_modsDone },
			{ "modsTotal", g_modsTotal },
			{ "count", g_bindings.size() },
			{ "seq", g_scanSeq },
		};
		if (includeBindings) {
			json arr = json::array();
			for (const auto& b : g_bindings) {
				json e{
					{ "src", b.src },
					{ "mod", b.mod },
					{ "control", b.control },
					{ "code", b.code },
				};
				if (!b.modsText.empty()) {
					e["mods"] = b.modsText;
				}
				arr.push_back(std::move(e));
			}
			j["bindings"] = std::move(arr);
		}
		return j.dump();
	}
}
