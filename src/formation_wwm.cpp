#include "formation_wwm.h"
#include "formation_wwm_settings.h"
#include "third_party/walk-with-me/WayfarerAPI.h"

#include "npc_actions.h"  // TargetFormID(): the palette-open crosshair snapshot

#include <algorithm>
#include <atomic>
#include <cctype>
#include <charconv>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE::/json and the logger.

#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
# undef min
#endif
#ifdef max
# undef max
#endif

using json = nlohmann::json;

namespace FormationWwm
{
	namespace
	{
		constexpr const char* kPlugin = "Wayfarer.esp";
		constexpr const char* kScript = "Wayfarer";  // its global-native script

		bool Modern()
		{
			const auto module = GetModuleHandleA("Wayfarer.dll");
			if (!module) return false;
			const auto* version = reinterpret_cast<const SKSE::PluginVersionData*>(GetProcAddress(module, "SKSEPlugin_Version"));
			return version && version->dataVersion == 1 && version->GetPluginVersion() >= REL::Version{0, 2, 2, 0};
		}

		WayfarerAPI::IWayfarer* Api()
		{
			if (!Modern()) return nullptr;
			using Get = WayfarerAPI::IWayfarer* (*)(std::uint32_t);
			const auto get = reinterpret_cast<Get>(GetProcAddress(GetModuleHandleA("Wayfarer.dll"), "Wayfarer_GetInterface"));
			auto* api = get ? get(WayfarerAPI::INTERFACE_VERSION) : nullptr;
			return api && api->GetVersion() == WayfarerAPI::INTERFACE_VERSION ? api : nullptr;
		}

		// marker: formation-wwm (Walk With Me provider)

		// The mod's five orders, in its own enum order. `section` is the ini
		// block holding that order's ten Side/Forward slot offsets; Relax has
		// none (it anchors where you stopped), which the view must be told
		// rather than left to discover by finding an empty grid.
		struct Mode
		{
			const char* label;    // the order wheel's own wording
			const char* hud;      // the badge the mod paints for it
			const char* section;  // "" = this order has no slot table
		};

		const Mode kModes[] = {
			{ "Find your own pace", "Travelling together", "DynamicFormation" },
			{ "Take the road ahead", "Taking the lead", "LeadFormation" },
			{ "Stay by my side", "By your side", "CompanionFormation" },
			{ "Watch our backs", "Watching your back", "RearFormation" },
			{ "Make yourselves at home", "Resting here", "" },
		};
		constexpr int kModeCount = static_cast<int>(std::size(kModes));
		constexpr int kSlots = 10;  // the mod's own party cap

		// ---------------------------------------------------------- ini ----
		//
		// An in-place editor, NOT a parser + serializer: the file keeps its
		// comments, its section order and every key we have never heard of.
		// The mod is at 0.15 and the author is actively adding settings — a
		// rewrite would quietly drop whatever shipped after this build.

		std::filesystem::path IniPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "Wayfarer.ini";
		}

		std::string Trim(std::string s)
		{
			const auto ws = " \t\r\n";
			const auto b = s.find_first_not_of(ws);
			if (b == std::string::npos)
				return "";
			const auto e = s.find_last_not_of(ws);
			return s.substr(b, e - b + 1);
		}

		bool IEquals(const std::string& a, const std::string& b)
		{
			return a.size() == b.size() &&
			       std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
				       return std::tolower(static_cast<unsigned char>(x)) ==
				              std::tolower(static_cast<unsigned char>(y));
			       });
		}

		struct Ini
		{
			std::vector<std::string> lines;
			bool                     loaded = false;

			bool Load()
			{
				lines.clear();
				loaded = false;
				std::ifstream in(IniPath(), std::ios::binary);
				if (!in)
					return false;
				std::string l;
				while (std::getline(in, l)) {
					if (!l.empty() && l.back() == '\r')
						l.pop_back();
					lines.push_back(std::move(l));
				}
				loaded = true;
				return true;
			}

			// Index of the key line inside `section`, or npos.
			std::size_t Find(const std::string& section, const std::string& key) const
			{
				std::string cur;
				for (std::size_t i = 0; i < lines.size(); ++i) {
					const auto t = Trim(lines[i]);
					if (t.size() >= 2 && t.front() == '[' && t.back() == ']') {
						cur = t.substr(1, t.size() - 2);
						continue;
					}
					if (t.empty() || t[0] == ';' || t[0] == '#')
						continue;
					if (!IEquals(cur, section))
						continue;
					const auto eq = t.find('=');
					if (eq == std::string::npos)
						continue;
					if (IEquals(Trim(t.substr(0, eq)), key))
						return i;
				}
				return std::string::npos;
			}

			std::string Get(const std::string& section, const std::string& key,
				const std::string& fallback = "") const
			{
				const auto i = Find(section, key);
				if (i == std::string::npos)
					return fallback;
				const auto t = Trim(lines[i]);
				const auto eq = t.find('=');
				return eq == std::string::npos ? fallback : Trim(t.substr(eq + 1));
			}

			double GetNum(const std::string& s, const std::string& k, double fb) const
			{
				const auto v = Get(s, k);
				if (v.empty())
					return fb;
				try {
					return std::stod(v);
				} catch (...) {
					return fb;
				}
			}

			bool GetBool(const std::string& s, const std::string& k, bool fb) const
			{
				const auto v = Get(s, k);
				if (v.empty())
					return fb;
				if (IEquals(v, "true") || v == "1")
					return true;
				if (IEquals(v, "false") || v == "0")
					return false;
				return fb;
			}

			// Replaces the value in place. A key that isn't there is appended to
			// the END of its section (before the next header), so it lands where
			// a reader expects it; a section that isn't there is appended whole.
			void Set(const std::string& section, const std::string& key,
				const std::string& value)
			{
				const auto i = Find(section, key);
				if (i != std::string::npos) {
					// Keep whatever leading whitespace the file uses.
					const auto lead = lines[i].substr(0, lines[i].find_first_not_of(" \t"));
					lines[i] = lead + key + " = " + value;
					return;
				}
				std::string    cur;
				std::size_t    endOfSection = std::string::npos;
				bool           seen = false;
				for (std::size_t n = 0; n < lines.size(); ++n) {
					const auto t = Trim(lines[n]);
					if (t.size() >= 2 && t.front() == '[' && t.back() == ']') {
						if (seen) {
							endOfSection = n;
							break;
						}
						cur = t.substr(1, t.size() - 2);
						seen = IEquals(cur, section);
					}
				}
				if (!seen) {
					lines.push_back("");
					lines.push_back("[" + section + "]");
					lines.push_back(key + " = " + value);
					return;
				}
				const auto at = (endOfSection == std::string::npos) ? lines.size() : endOfSection;
				lines.insert(lines.begin() + static_cast<std::ptrdiff_t>(at),
					key + " = " + value);
			}

			bool Save() const
			{
				// One backup per session, made before the first write: the file
				// is the user's whole configuration and we are not its owner.
				static std::atomic<bool> s_backed{ false };
				bool                     expected = false;
				if (s_backed.compare_exchange_strong(expected, true)) {
					std::error_code ec;
					auto            bak = IniPath();
					bak += ".deckbak";
					std::filesystem::copy_file(IniPath(), bak,
						std::filesystem::copy_options::overwrite_existing, ec);
				}
				// Written in place rather than temp-and-rename: the file lives
				// inside a MOD folder, and a rename would be a cross-directory
				// move through MO2's VFS, whose destination is not ours to
				// assume. It is 4 KB — the truncate window is microseconds.
				std::ofstream out(IniPath(), std::ios::trunc | std::ios::binary);
				if (!out.is_open())
					return false;
				for (const auto& l : lines)
					out << l << "\r\n";
				out.flush();
				return out.good();
			}
		};

		std::mutex g_iniLock;

		std::string NumStr(double v)
		{
			char buf[32]{};
			std::snprintf(buf, sizeof(buf), "%.6f", v);
			return buf;
		}

		std::string IntStr(int v)
		{
			return std::to_string(v);
		}

		// ----------------------------------------------------- papyrus ----

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		// The value a Wayfarer getter returns, delivered on the VM thread. The
		// consumers are atomics, which is exactly what makes that safe — same
		// shape as keys_scan's StringResult.
		class VarResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit VarResult(std::function<void(const RE::BSScript::Variable&)> then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				if (_then)
					_then(a_result);
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(const RE::BSScript::Variable&)> _then;
		};

		template <class... Args>
		bool CallStatic(const char* fn, RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb,
			Args... args)
		{
			auto* vm = Vm();
			if (!vm || !fn)
				return false;
			auto a = RE::MakeFunctionArguments(std::move(args)...);
			return vm->DispatchStaticCall(kScript, fn, a, cb);
		}

		template <class... Args>
		bool Fire(const char* fn, Args... args)
		{
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			return CallStatic(fn, cb, std::move(args)...);
		}

		// ------------------------------------------------------- cache ----
		//
		// What only the engine knows. Refreshed by every StateJson and read by
		// the NEXT one — the modal already re-asks ~700ms after each mutation,
		// so a value is at most one round-trip stale and never invented.

		std::atomic<int>           g_enabled{ -1 };   // -1 unknown, 0/1
		std::atomic<int>           g_mode{ -1 };
		std::atomic<int>           g_count{ -1 };
		std::atomic<std::uint32_t> g_managedFor{ 0 };  // whom g_managed is about
		std::atomic<int>           g_managed{ -1 };
		std::atomic<bool>          g_answered{ false };
		std::atomic<bool>          g_logged{ false };

		void Refresh(RE::Actor* subject)
		{
			if (auto* api = Api()) {
				g_enabled.store(api->IsEnabled() ? 1 : 0);
				g_mode.store(static_cast<int>(api->GetFormationMode()));
				g_count.store(static_cast<int>(api->GetManagedCount()));
				g_managedFor.store(subject ? subject->GetFormID() : 0);
				g_managed.store(subject ? (api->IsManaged(subject->GetFormID()) ? 1 : 0) : -1);
				g_answered.store(true);
				return;
			}
			auto boolInto = [](std::atomic<int>* slot) {
				return RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>(
					new VarResult([slot](const RE::BSScript::Variable& v) {
						if (v.IsBool()) {
							slot->store(v.GetBool() ? 1 : 0);
							g_answered.store(true);
						}
					}));
			};
			auto intInto = [](std::atomic<int>* slot) {
				return RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor>(
					new VarResult([slot](const RE::BSScript::Variable& v) {
						if (v.IsInt()) {
							slot->store(static_cast<int>(v.GetSInt()));
							g_answered.store(true);
						}
					}));
			};

			CallStatic("GetEnabled", boolInto(&g_enabled));
			CallStatic("GetFormationMode", intInto(&g_mode));
			CallStatic("GetManagedCount", intInto(&g_count));
			if (subject) {
				const auto id = subject->GetFormID();
				// A different subject invalidates the answer immediately: showing
				// the last person's badge under this person's name is a lie the
				// modal would have no way to notice.
				if (g_managedFor.exchange(id) != id)
					g_managed.store(-1);
				CallStatic("IsManaged", boolInto(&g_managed), std::move(subject));
			} else {
				g_managedFor.store(0);
				g_managed.store(-1);
			}
		}

		// ----------------------------------------------------- helpers ----

		RE::Actor* ResolveSubject(const json& j)
		{
			if (j.contains("formId") && !j["formId"].is_string()) return nullptr;
			const auto fid = j.value("formId", std::string(""));
			if (!fid.empty()) {
				auto text = std::string_view(fid);
				if (text.starts_with("0x") || text.starts_with("0X")) text.remove_prefix(2);
				std::uint32_t local{};
				const auto parsed = std::from_chars(text.data(), text.data()+text.size(), local, 16);
				if (text.empty() || parsed.ec != std::errc{} || parsed.ptr != text.data()+text.size()) return nullptr;
				if (local) {
					const auto plugin = j.value("plugin", std::string(""));
					if (!plugin.empty()) {
						if (auto* dh = RE::TESDataHandler::GetSingleton())
							if (auto* f = dh->LookupForm(local, plugin))
								return f->As<RE::Actor>();
					}
					if (auto* f = RE::TESForm::LookupByID(local))
						return f->As<RE::Actor>();
				}
				return nullptr; // An explicit stale/invalid id must never target the crosshair.
			}
			if (const auto id = NpcActions::TargetFormID())
				return RE::TESForm::LookupByID<RE::Actor>(id);
			return nullptr;
		}

		std::string NameOf(RE::Actor* a)
		{
			if (!a)
				return "";
			const char* n = a->GetDisplayFullName();
			return n ? n : "";
		}

		std::string HexOf(std::uint32_t id)
		{
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "0x%08X", id);
			return buf;
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		json Ok(const std::string& msg) { return json{ { "ok", true }, { "msg", msg } }; }
		json Refuse(const std::string& msg) { return json{ { "ok", false }, { "msg", msg } }; }

		int ClampMode(int m) { return std::clamp(m, 0, Modern() ? 5 : kModeCount - 1); }

		// Same durable actor-reference key as upstream HandHolding::ReferenceKey.
		std::string ReferenceKey(RE::Actor* actor)
		{
			if (!actor || (actor->GetFormID() >> 24) == 0xFF) return {};
			const auto* file = actor->GetFile(0);
			if (!file) return {};
			char local[16]{};
			std::snprintf(local, sizeof(local), "%06X", actor->GetFormID() & (file->IsLight() ? 0xFFF : 0xFFFFFF));
			std::string key = std::string(file->GetFilename()) + "|" + local;
			std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return key;
		}

		std::vector<RE::Actor*> Candidates(RE::Actor* subject)
		{
			std::vector<RE::Actor*> actors;
			std::unordered_set<RE::FormID> seen;
			auto* api = Api();
			auto add = [&](RE::Actor* actor, bool targeted = false) {
				if (!actor || actor->IsPlayerRef() || actor->IsDead() || actor->IsDisabled()) return;
				if (!targeted && !actor->IsPlayerTeammate() && !(api && api->IsManaged(actor->GetFormID()))) return;
				if (seen.insert(actor->GetFormID()).second) actors.push_back(actor);
			};
			add(subject, true);
			if (auto* lists = RE::ProcessLists::GetSingleton()) {
				for (const auto& handle : lists->highActorHandles) { const auto actor = handle.get(); add(actor.get()); }
				for (const auto& handle : lists->middleHighActorHandles) { const auto actor = handle.get(); add(actor.get()); }
			}
			std::sort(actors.begin(), actors.end(), [](auto* a, auto* b) { return NameOf(a) < NameOf(b); });
			return actors;
		}

		// ------------------------------------------- who WE put in the party ----
		//
		// marker: formation-wwm-party-sidecar
		//
		// Walk With Me saves the companions IT enrolled (`dialogueRegistrations`
		// go into its co-save) but deliberately NOT the ones enrolled through its
		// public API: `manualRegistrations` is cleared by its revert callback and
		// written by no save callback. Since the API is the only door that takes a
		// follower WWM's own gate refuses (see formation-wwm-enroll-api), the
		// persistence has to be ours, or every load quietly empties the party.
		//
		// Own sidecar, not a hotkeys.json slice — OnJsSave replaces that wholesale.
		// Stored by DURABLE reference key (plugin + local id), never by runtime
		// FormID: the high byte is a load index and ESM-flagging anything
		// re-indexes it. A dynamic reference (0xFF…) has no such key and is
		// therefore session-only by nature; it is registered but not remembered.
		const char* kPartyFile = "Data/SKSE/Plugins/HotkeyDeck/formation-party.json";

		std::mutex g_partyLock;

		json PartyLoad()
		{
			std::ifstream in(kPartyFile, std::ios::binary);
			auto doc = in ? json::parse(in, nullptr, false) : json::object();
			if (!doc.is_object()) doc = json::object();
			if (!doc.contains("wwm") || !doc["wwm"].is_array()) doc["wwm"] = json::array();
			return doc;
		}

		bool PartyStore(const json& doc)
		{
			try {
				const std::filesystem::path path(kPartyFile);
				std::error_code ec;
				std::filesystem::create_directories(path.parent_path(), ec);
				auto temp = path; temp += ".tmp";
				{
					std::ofstream out(temp, std::ios::binary | std::ios::trunc);
					out << doc.dump(2);
					out.flush();
					if (!out) return false;
				}
				return MoveFileExW(temp.c_str(), path.c_str(),
					MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
			} catch (const std::exception& e) {
				logger::warn("formation-wwm: cannot save the walking party: {}", e.what());
				return false;
			}
		}

		void PartyRemember(RE::Actor* actor)
		{
			const auto key = ReferenceKey(actor);
			if (key.empty()) return;  // dynamic ref — nothing durable to write
			std::lock_guard<std::mutex> lock(g_partyLock);
			auto doc = PartyLoad();
			for (const auto& row : doc["wwm"])
				if (row.is_object() && row.value("key", std::string("")) == key) return;
			doc["wwm"].push_back({ { "key", key }, { "name", NameOf(actor) } });
			PartyStore(doc);
		}

		void PartyForget(RE::Actor* actor)
		{
			const auto key = ReferenceKey(actor);
			if (key.empty()) return;
			std::lock_guard<std::mutex> lock(g_partyLock);
			auto doc = PartyLoad();
			auto kept = json::array();
			for (const auto& row : doc["wwm"])
				if (row.is_object() && row.value("key", std::string("")) != key) kept.push_back(row);
			if (kept.size() == doc["wwm"].size()) return;
			doc["wwm"] = std::move(kept);
			PartyStore(doc);
		}

		RE::Actor* ActorForKey(const std::string& key)
		{
			const auto bar = key.find('|');
			if (bar == std::string::npos || bar + 1 >= key.size()) return nullptr;
			const auto plugin = key.substr(0, bar);
			const auto localText = key.substr(bar + 1);
			std::uint32_t local{};
			const auto parsed = std::from_chars(localText.data(), localText.data() + localText.size(), local, 16);
			if (parsed.ec != std::errc{} || parsed.ptr != localText.data() + localText.size()) return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* form = dh ? dh->LookupForm(local, plugin) : nullptr;
			return form ? form->As<RE::Actor>() : nullptr;
		}

		bool TetherAssets()
		{
			if (!GetModuleHandleA("OpenAnimationReplacer.dll")) return false;
			const std::filesystem::path root("Data/meshes/OpenAnimationReplacer/WWM Clasp");
			std::error_code ec;
			for (const char* side : {"Left", "Right"}) {
				if (!std::filesystem::is_regular_file(root / side / "config.json", ec)) return false;
				for (const char* gender : {"male", "female"})
					for (const char* clip : {"mt_idle.hkx", "mt_walkforward.hkx", "mt_runforward.hkx"})
						if (!std::filesystem::is_regular_file(root / side / "actors/character/animations" / gender / clip, ec)) return false;
			}
			return true; // Files + OAR only; never claim the owner has connected a grip.
		}

		void ModernState(json& out, const Ini& ini, RE::Actor* subject)
		{
			using namespace FormationWwmSettings;
			out["modern"] = true;
			out["apiReady"] = Api() != nullptr;
			out["settings"] = json::object();
			out["controls"] = json::array();
			for (const auto& f : Fields) {
				out["settings"][f.key] = f.kind == Kind::toggle ? json(ini.GetBool(f.section, f.iniKey, f.fallback != 0)) : json(ini.GetNum(f.section, f.iniKey, f.fallback));
				out["controls"].push_back({{"group",f.group},{"key",f.key},{"label",f.label},{"type",f.kind == Kind::toggle ? "toggle" : "number"},{"min",f.low},{"max",f.high},{"step",f.step}});
			}
			out["settings"]["mode"] = out["global"]["mode"];
			out["settings"]["preferredSide"] = ini.GetNum("General", "iPreferredSide", 1) < 0 ? -1 : 1;
			out["settings"]["method"] = IEquals(ini.Get("HandHolding", "sMethod", "classic"), "tether") ? "tether" : "classic";
			out["partner"] = {{"key",ini.Get("HandHolding","sPartner")},{"name",ini.Get("HandHolding","sPartnerName")}};
			out["finder"] = {{"key",ini.Get("Loot","sFinder")},{"name",ini.Get("Loot","sFinderName")}};
			out["tetherAssets"] = TetherAssets();
			out["roster"] = json::array();
			auto* api = Api();
			for (auto* actor : Candidates(subject)) {
				out["roster"].push_back({{"formId",HexOf(actor->GetFormID())},{"name",NameOf(actor)},
					{"key",ReferenceKey(actor)},{"teammate",actor->IsPlayerTeammate()},
					{"managed",api && api->IsManaged(actor->GetFormID())}});
			}
			out.erase("slots");
			out.erase("slotSection");
			for (auto& m : out["modes"]) m["slots"] = false;
			out["modes"].push_back({{"id",5},{"label","Follow normally"},{"hud","Their own follower AI"},{"slots",false}});
			out["running"] = out["global"].value("enabled",false) && out["global"].value("mode",0) != 5;
			static bool logged = false;
			if (!logged) { logged = true; logger::info("formation-wwm-022: public API, persistent companions and hand-holding controls"); }
		}

		json ApplyModern(const json& j, Ini& ini)
		{
			using namespace FormationWwmSettings;
			if (!Api()) return Refuse("Walk With Me 0.2.2's public API is unavailable. Check the installed DLL.");
			if (!j.contains("settings") || !j["settings"].is_object()) return Refuse("No formation settings supplied");
			const auto& changes = j["settings"];
			for (const auto& [key, value] : changes.items()) {
				if (const auto* f = Find(key)) {
					if (f->kind == Kind::toggle) {
						if (!value.is_boolean()) return Refuse("Invalid switch: " + key);
						ini.Set(f->section, f->iniKey, value.get<bool>() ? "true" : "false");
					} else {
						if (!value.is_number() || !ValidNumber(*f, value.get<double>())) return Refuse("Value outside the supported range: " + key);
						ini.Set(f->section, f->iniKey, NumStr(value.get<double>()));
					}
				} else if (key == "mode") {
					if (!value.is_number_integer() || value < 0 || value > 5) return Refuse("Unknown travel mode");
					ini.Set("General", "iFormationMode", IntStr(value.get<int>()));
				} else if (key == "preferredSide") {
					if (!value.is_number_integer() || (value != -1 && value != 1)) return Refuse("Choose a left or right walking side");
					ini.Set("General", "iPreferredSide", IntStr(value.get<int>()));
				} else if (key == "method") {
					if (!value.is_string() || (value != "classic" && value != "tether")) return Refuse("Unknown hand-holding method");
					if (value == "tether" && !TetherAssets()) return Refuse("TETHER needs Open Animation Replacer and the generated clasp animations. Choose Classic for now.");
					ini.Set("HandHolding", "sMethod", value.get<std::string>());
				} else return Refuse("Unsupported setting: " + key);
			}
			for (const auto& pair : {std::pair{"partnerId", "HandHolding"}, std::pair{"finderId", "Loot"}}) {
				if (!j.contains(pair.first)) continue;
				if (!j[pair.first].is_string()) return Refuse("Invalid companion selection");
				const auto id = j[pair.first].get<std::string>();
				std::string key, name;
				if (!id.empty()) {
					for (auto* actor : Candidates(ResolveSubject(j))) {
						if (HexOf(actor->GetFormID()) != id) continue;
						if (!Api()->IsManaged(actor->GetFormID())) return Refuse("Add this companion to the walking party first");
						key = ReferenceKey(actor); name = NameOf(actor); break;
					}
					if (key.empty()) return Refuse("This companion is unavailable or has no persistent reference. Refresh the party.");
				}
				const bool hands = std::string_view(pair.first) == "partnerId";
				ini.Set(pair.second, hands ? "sPartner" : "sFinder", key);
				name.erase(std::remove(name.begin(),name.end(),'\r'),name.end());
				name.erase(std::remove(name.begin(),name.end(),'\n'),name.end());
				ini.Set(pair.second, hands ? "sPartnerName" : "sFinderName", name);
				if (hands && key.empty()) ini.Set("HandHolding","bEnabled","false");
			}
			if (ini.GetBool("HandHolding","bEnabled",false) && ini.Get("HandHolding","sPartner").empty()) return Refuse("Choose a hand-holding companion first");
			if (ini.GetBool("HandHolding","bEnabled",false) && IEquals(ini.Get("HandHolding","sMethod","classic"),"tether") && !TetherAssets()) return Refuse("TETHER animations are missing. Choose Classic or turn hand-holding off.");
			if (ini.GetNum("HandHolding","fReleaseDistance",120) < ini.GetNum("HandHolding","fConnectDistance",90) + 10) return Refuse("Hand release distance must be at least 10 greater than connect distance");
			const auto reach = ini.GetNum("Safety","fReleaseDistance",2500) - 200;
			const auto start = ini.GetNum("Sandbox","fStartRadius",400);
			const auto limit = ini.GetNum("Sandbox","fMaxRadius",1600);
			if (start > reach || limit > reach || limit < start) return Refuse("Rest radii must stay inside the release distance, with maximum radius at least the starting radius");
			if (!ini.Save()) return Refuse("Could not save Wayfarer.ini");
			if (!Fire("ReloadSettings")) return Refuse("Settings saved, but the reload could not be queued. Restart Skyrim to apply them.");
			g_answered.store(false);
			auto result = Ok("Walk With Me settings saved — applying as the game resumes");
			result["closeGameMenu"] = true;
			return result;
		}
	}

	bool Installed()
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		return dh && dh->LookupModByName(kPlugin) != nullptr;
	}

	int ModeCount() { return Modern() ? 6 : kModeCount; }
	bool SupportsModern() { return Installed() && Api() != nullptr; }
	bool SetRuntimeEnabled(bool enabled)
	{
		auto* api = Api();
		if (!api) return false;
		api->SetEnabled(enabled);
		return api->IsEnabled() == enabled;
	}

	// marker: formation-wwm-party-restore
	//
	// MAIN THREAD, after a save has loaded. Walk With Me's revert callback wipes
	// the API registrations, so the party we put together has to be re-asserted
	// from our own sidecar or it silently empties on every load. A companion the
	// key no longer resolves to (her mod removed) is dropped from the file rather
	// than retried forever.
	int RestoreParty()
	{
		auto* api = Api();
		if (!api) return 0;
		std::lock_guard<std::mutex> lock(g_partyLock);
		auto doc = PartyLoad();
		auto kept = json::array();
		int restored = 0;
		for (const auto& row : doc["wwm"]) {
			if (!row.is_object()) continue;
			const auto key = row.value("key", std::string(""));
			auto* actor = ActorForKey(key);
			if (!actor) {
				logger::info("formation-wwm: walking-party member '{}' no longer resolves — dropped", key);
				continue;
			}
			kept.push_back(row);
			if (api->IsManaged(actor->GetFormID())) continue;  // WWM already has her
			if (api->RegisterFollower(actor->GetFormID(), -1)) ++restored;
		}
		if (kept.size() != doc["wwm"].size()) { doc["wwm"] = kept; PartyStore(doc); }
		if (restored)
			logger::info("formation-wwm: re-enrolled {} walking-party companion(s) after the load", restored);
		return restored;
	}

	// ------------------------------------------------------------- state ----

	std::string StateJson(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			j = json::object();

		json out{
			{ "id", "wwm" },
			{ "label", "Walk With Me" },
			{ "present", false },
			{ "installed", false },
			{ "wired", true },
		};

		if (!Installed()) {
			out["note"] = "Walk With Me (Wayfarer.esp) isn’t in the load order.";
			return Dump(out);
		}
		out["installed"] = true;

		Ini ini;
		std::unique_lock<std::mutex> lock(g_iniLock);
		const bool haveIni = ini.Load();
		if (!haveIni) {
			// The plugin is there but its settings file is not, which means the
			// mod has never run (it writes the ini itself). Say that, rather
			// than paint defaults that are not what the game will use.
			lock.unlock();
			out["note"] =
				"Walk With Me is installed but has never written its settings file — "
				"launch once so it creates Data\\SKSE\\Plugins\\Wayfarer.ini.";
			return Dump(out);
		}
		out["present"] = true;

		// The mod's own quest drives the aliases; without it nothing moves.
		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* subject = ResolveSubject(j);
		Refresh(subject);

		const int cachedMode = g_mode.load();
		const int iniMode = ClampMode(static_cast<int>(ini.GetNum("General", "iFormationMode", 0)));
		const int mode = (cachedMode >= 0) ? ClampMode(cachedMode) : iniMode;

		const int cachedEnabled = g_enabled.load();
		const bool enabled = (cachedEnabled >= 0) ? (cachedEnabled == 1)
		                                          : ini.GetBool("General", "bEnabled", true);

		// `running` mirrors the FWF provider's meaning — the mod is actually
		// driving followers — which is what the router's conflict test reads.
		out["running"] = enabled;
		out["warming"] = !g_answered.load();
		out["count"] = g_count.load();  // -1 until the VM answers
		out["max"] = static_cast<int>(ini.GetNum("General", "iMaxFollowers", kSlots));

		out["global"] = json{
			{ "enabled", enabled },
			{ "mode", mode },
			{ "maxFollowers", static_cast<int>(ini.GetNum("General", "iMaxFollowers", kSlots)) },
			{ "preferredSide", static_cast<int>(ini.GetNum("General", "iPreferredSide", 1)) },
			{ "autoDiscover", ini.GetBool("General", "bAutoDiscover", true) },
			{ "requireTeammate", ini.GetBool("General", "bRequirePlayerTeammate", true) },
			{ "spacing", ini.GetNum("Movement", "fSpacingScale", 1.0) },
			{ "catchUpBonus", ini.GetNum("Movement", "fCatchUpSpeedBonus", 150.0) },
			{ "arrivalRadius", ini.GetNum("Movement", "fArrivalRadius", 65.0) },
			{ "individuality", ini.GetNum("Movement", "fCompanionIndividuality", 1.0) },
			{ "showHud", ini.GetBool("Interface", "bShowOrderHUD", true) },
		};

		out["safety"] = json{
			{ "combat", ini.GetBool("Safety", "bReleaseInCombat", true) },
			{ "sneaking", ini.GetBool("Safety", "bReleaseWhenSneaking", true) },
			{ "weaponDrawn", ini.GetBool("Safety", "bReleaseWhenWeaponDrawn", true) },
			{ "controlsDisabled", ini.GetBool("Safety", "bReleaseWhenControlsDisabled", true) },
			{ "indoors", ini.GetBool("Safety", "bDisableIndoors", false) },
			{ "releaseDistance", ini.GetNum("Safety", "fReleaseDistance", 2500.0) },
			{ "enforceNff", ini.GetBool("Compatibility", "bEnforceNFF", true) },
		};

		// Every order, so the view never hardcodes the mod's wording, plus
		// whether that order even HAS a slot table (Relax anchors instead).
		json modes = json::array();
		for (int i = 0; i < kModeCount; ++i) {
			modes.push_back(json{
				{ "id", i },
				{ "label", kModes[i].label },
				{ "hud", kModes[i].hud },
				{ "slots", kModes[i].section[0] != '\0' },
			});
		}
		out["modes"] = modes;

		// The ten Side/Forward pairs of the CURRENT order — the thing the mod's
		// own menu cannot edit yet (its author said so on release day), which
		// is the whole reason this pane earns its place.
		const char* section = mode < kModeCount ? kModes[mode].section : "";
		if (section[0] != '\0') {
			json slots = json::array();
			for (int s = 0; s < kSlots; ++s) {
				const auto k = "fSlot" + std::to_string(s);
				slots.push_back(json{
					{ "slot", s },
					{ "side", ini.GetNum(section, k + "Side", 0.0) },
					{ "forward", ini.GetNum(section, k + "Forward", 0.0) },
				});
			}
			out["slots"] = slots;
			out["slotSection"] = section;
		}

		// The mod's own excluded-plugin list, so the pane can say "she is run
		// by her own follower mod and Walk With Me is already leaving her be"
		// instead of offering a register that will not stick.
		json excl = json::array();
		{
			std::stringstream ss(ini.Get("Compatibility", "sExcludedPlugins"));
			std::string       one;
			while (std::getline(ss, one, ',')) {
				one = Trim(one);
				if (!one.empty())
					excl.push_back(one);
			}
		}
		out["excludedPlugins"] = excl;

		out["hotkeys"] = json{
			{ "command", static_cast<int>(ini.GetNum("Hotkeys", "iCommandKey", -1)) },
			{ "toggle", static_cast<int>(ini.GetNum("Hotkeys", "iToggleKey", -1)) },
			{ "cycle", static_cast<int>(ini.GetNum("Hotkeys", "iCycleModeKey", -1)) },
			{ "reload", static_cast<int>(ini.GetNum("Hotkeys", "iReloadKey", -1)) },
		};

		if (Modern()) ModernState(out, ini, subject);
		lock.unlock();

		if (subject) {
			const int  man = g_managed.load();
			const auto id = subject->GetFormID();
			json       sub{
                { "formId", HexOf(id) },
                { "name", NameOf(subject) },
                { "teammate", subject->IsPlayerTeammate() },
			};
			// -1 = the engine has not answered yet. The view must show "asking"
			// rather than "not in the party", which is a different sentence.
			if (man >= 0 && g_managedFor.load() == id)
				sub["registered"] = (man == 1);
			// Which plugin she comes from, so the pane can match her against the
			// excluded list without a second bridge call.
			if (dh) {
				if (auto* base = subject->GetActorBase()) {
					if (const auto* file = base->GetFile(0))
						sub["plugin"] = file->GetFilename();
				}
			}
			out["subject"] = sub;
		}

		if (!g_logged.exchange(true)) {
			logger::info("Formation: {} bound (order '{}', ini {})", kPlugin,
				mode < kModeCount ? kModes[mode].hud : "Their own follower AI", haveIni ? "read" : "missing");
		}
		return Dump(out);
	}

	// ------------------------------------------------------------- apply ----

	std::string Apply(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));
		if (!Installed())
			return Dump(Refuse("Walk With Me isn’t loaded"));

		std::lock_guard<std::mutex> lock(g_iniLock);
		Ini                         ini;
		if (!ini.Load())
			return Dump(Refuse("Couldn’t read Wayfarer.ini"));
		if (Modern()) return Dump(ApplyModern(j, ini));

		bool touched = false;
		int  wantMode = -1;
		int  wantEnabled = -1;

		auto setBool = [&](const char* sec, const char* key, bool v) {
			ini.Set(sec, key, v ? "true" : "false");
			touched = true;
		};
		auto setNum = [&](const char* sec, const char* key, double v) {
			ini.Set(sec, key, NumStr(v));
			touched = true;
		};
		auto setInt = [&](const char* sec, const char* key, int v) {
			ini.Set(sec, key, IntStr(v));
			touched = true;
		};

		if (j.contains("global") && j["global"].is_object()) {
			const auto& g = j["global"];
			if (g.contains("enabled") && g["enabled"].is_boolean()) {
				wantEnabled = g["enabled"].get<bool>() ? 1 : 0;
				setBool("General", "bEnabled", wantEnabled == 1);
			}
			if (g.contains("mode") && g["mode"].is_number_integer()) {
				wantMode = ClampMode(g["mode"].get<int>());
				setInt("General", "iFormationMode", wantMode);
			}
			if (g.contains("maxFollowers"))
				setInt("General", "iMaxFollowers",
					std::clamp(g.value("maxFollowers", kSlots), 1, kSlots));
			if (g.contains("preferredSide"))
				setInt("General", "iPreferredSide",
					std::clamp(g.value("preferredSide", 1), 0, 2));
			if (g.contains("autoDiscover") && g["autoDiscover"].is_boolean())
				setBool("General", "bAutoDiscover", g["autoDiscover"].get<bool>());
			if (g.contains("requireTeammate") && g["requireTeammate"].is_boolean())
				setBool("General", "bRequirePlayerTeammate", g["requireTeammate"].get<bool>());
			// Ranges follow the mod's own menu, so the deck can never write a
			// value its configuration screen would refuse.
			if (g.contains("spacing"))
				setNum("Movement", "fSpacingScale",
					std::clamp(g.value("spacing", 1.0), 0.25, 3.0));
			if (g.contains("catchUpBonus"))
				setNum("Movement", "fCatchUpSpeedBonus",
					std::clamp(g.value("catchUpBonus", 150.0), 0.0, 600.0));
			if (g.contains("arrivalRadius"))
				setNum("Movement", "fArrivalRadius",
					std::clamp(g.value("arrivalRadius", 65.0), 16.0, 512.0));
			if (g.contains("individuality"))
				setNum("Movement", "fCompanionIndividuality",
					std::clamp(g.value("individuality", 1.0), 0.0, 2.0));
			if (g.contains("showHud") && g["showHud"].is_boolean())
				setBool("Interface", "bShowOrderHUD", g["showHud"].get<bool>());
		}

		if (j.contains("safety") && j["safety"].is_object()) {
			const auto& s = j["safety"];
			auto        sb = [&](const char* key, const char* iniKey, const char* sec) {
                if (s.contains(key) && s[key].is_boolean())
                    setBool(sec, iniKey, s[key].get<bool>());
			};
			sb("combat", "bReleaseInCombat", "Safety");
			sb("sneaking", "bReleaseWhenSneaking", "Safety");
			sb("weaponDrawn", "bReleaseWhenWeaponDrawn", "Safety");
			sb("controlsDisabled", "bReleaseWhenControlsDisabled", "Safety");
			sb("indoors", "bDisableIndoors", "Safety");
			sb("enforceNff", "bEnforceNFF", "Compatibility");
			if (s.contains("releaseDistance"))
				setNum("Safety", "fReleaseDistance",
					std::clamp(s.value("releaseDistance", 2500.0), 200.0, 10000.0));
		}

		// Per-slot offsets, against the order the request names (defaulting to
		// the one that is live). Relax has no table and says so instead of
		// writing a section the mod will never read.
		if (j.contains("slot") && j["slot"].is_object()) {
			const auto& s = j["slot"];
			const int   mode = ClampMode(s.contains("mode") && s["mode"].is_number_integer()
			          ? s["mode"].get<int>()
			          : static_cast<int>(ini.GetNum("General", "iFormationMode", 0)));
			const char* section = kModes[mode].section;
			if (section[0] == '\0')
				return Dump(Refuse(
					"“Make yourselves at home” has no formation to edit — it anchors "
					"wherever you stopped."));
			const int idx = std::clamp(s.value("slot", 0), 0, kSlots - 1);
			const auto key = "fSlot" + std::to_string(idx);
			if (s.contains("side"))
				setNum(section, (key + "Side").c_str(),
					std::clamp(s.value("side", 0.0), -1024.0, 1024.0));
			if (s.contains("forward"))
				setNum(section, (key + "Forward").c_str(),
					std::clamp(s.value("forward", 0.0), -1024.0, 1024.0));
		}

		if (!touched)
			return Dump(Ok("Nothing to change"));
		if (!ini.Save())
			return Dump(Refuse("Couldn’t write Wayfarer.ini — is it read-only?"));

		// The mod's own live-apply. Write first, THEN make it re-read: that way
		// the ini and what is running can never disagree.
		// marker: formation-wwm-apply
		const bool reloaded = Fire("ReloadSettings");
		if (wantEnabled >= 0) {
			Fire("SetEnabled", wantEnabled == 1);
			g_enabled.store(wantEnabled);
		}
		if (wantMode >= 0) {
			Fire("SetFormationMode", static_cast<std::int32_t>(wantMode));
			g_mode.store(wantMode);
		}
		if (!reloaded)
			return Dump(Ok("Saved — Walk With Me picks it up on the next launch "
			               "(its scripts aren’t answering right now)"));
		if (wantEnabled == 0)
			return Dump(Ok("Walk With Me stood down"));
		if (wantMode >= 0)
			return Dump(Ok(std::string(kModes[wantMode].hud)));
		return Dump(Ok("Walk With Me updated"));
	}

	// ---------------------------------------------------- register/clear ----

	std::string Reg(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));
		if (!Installed())
			return Dump(Refuse("Walk With Me isn’t loaded"));
		auto* subject = ResolveSubject(j);
		if (!subject)
			return Dump(Refuse("No one under the crosshair"));

		const auto op = j.value("op", std::string(""));
		const auto who = NameOf(subject);
		if (Modern()) {
			auto* api = Api();
			if (!api) return Dump(Refuse("Walk With Me's public API is unavailable"));
			// The subject of THIS request, not whoever the crosshair happens to
			// hold now: the modal is routinely opened from search or from a
			// roster row, and re-resolving the crosshair refused the very
			// person the button named. Liveness is asked of her directly.
			if (subject->IsDead() || subject->IsDisabled() || !subject->Is3DLoaded())
				return Dump(Refuse((who.empty() ? std::string("That companion") : who) +
					" isn’t here any more. Reopen the party list."));
			if (op == "register" || op == "unregister") {
				// marker: formation-wwm-enroll-api
				//
				// ⛔ NOT SetDialogueManagement. That native runs Walk With Me's
				// OWN recruitment gate first, and with NFF installed that gate
				// is `RecruitmentRejection`: anyone outside NFF's active roster
				// is refused outright — before the teammate check — unless her
				// plugin is in WWM's hardcoded seven-name independent list.
				// Vayne (CSV_Vayne.esp) is neither, so every press was refused,
				// and the refusal's HUD message was emitted while the deck still
				// owned the screen, so it read as a dead button (2026-09-28).
				//
				// The public API's RegisterFollower takes no such gate: it fills
				// `manualRegistrations`, and WWM's own scan treats a registered
				// follower as exempt (`IsRegisteredFollower(id) ? nullptr :
				// CandidateRejection(actor)`), so she gets a real formation slot.
				// It is synchronous, main-thread, and returns a real bool — no
				// queued Papyrus dispatch to mistake for success.
				const bool on = op == "register";
				const bool ok = on ? api->RegisterFollower(subject->GetFormID(), -1)
				                   : api->UnregisterFollower(subject->GetFormID());
				// Unregister answers false for someone WWM enrolled by itself
				// (she was never a manual registration) — it still dropped her,
				// so that is not a failure. Only a refused register is.
				if (on && !ok)
					return Dump(Refuse("Walk With Me would not take " +
						(who.empty() ? std::string("that companion") : who) + "."));
				if (on) PartyRemember(subject); else PartyForget(subject);
				logger::info("formation-wwm-enroll: {} {} ({:08X}) via the public API",
					on ? "enrolled" : "released", who.empty() ? "companion" : who,
					subject->GetFormID());
				// Her slot is assigned by WWM's next sweep, not by this call, so
				// the card must not claim she is already walking — the modal's
				// own re-read is what turns the badge on.
				auto result = Ok(who + (on ? " joins the walking party — she falls in on the next sweep"
				                           : " leaves the walking party"));
				result["closeGameMenu"] = true;
				return Dump(result);
			}
			if (op == "exclude" || op == "include") PartyForget(subject);
			const bool ok = op == "exclude" ? api->ExcludeFollower(subject->GetFormID()) : op == "include" ? api->IncludeFollower(subject->GetFormID()) : false;
			return Dump(ok ? Ok(who + ": walking-party preference updated") : Refuse("Walk With Me did not accept that party action"));
		}

		// marker: formation-wwm-reg
		if (op == "register") {
			// The mod's own gate, mirrored so a refusal is a sentence and not a
			// button that does nothing: bRequirePlayerTeammate is its default.
			{
				std::lock_guard<std::mutex> lock(g_iniLock);
				Ini                         ini;
				if (ini.Load() && ini.GetBool("General", "bRequirePlayerTeammate", true) &&
					!subject->IsPlayerTeammate())
					return Dump(Refuse(who +
						" isn’t following you — Walk With Me only takes teammates "
						"while “require teammate” is on."));
			}
			if (!Fire("RegisterFollower", std::move(subject), static_cast<std::int32_t>(-1)))
				return Dump(Refuse("Couldn’t reach Walk With Me’s scripts"));
			g_managed.store(-1);  // re-ask; do not assume it took
			return Dump(Ok(who + " joins the party"));
		}
		if (op == "unregister") {
			if (!Fire("UnregisterFollower", std::move(subject)))
				return Dump(Refuse("Couldn’t reach Walk With Me’s scripts"));
			g_managed.store(-1);
			return Dump(Ok(who + " leaves the party"));
		}
		// Exclude/include are the DURABLE pair — the mod remembers them across
		// saves ("Restored N companion exclusions"), which is what you want for
		// a companion run by her own follower mod.
		if (op == "exclude") {
			if (!Fire("ExcludeFollower", std::move(subject)))
				return Dump(Refuse("Couldn’t reach Walk With Me’s scripts"));
			g_managed.store(-1);
			return Dump(Ok(who + " is left to her own follower AI, for good"));
		}
		if (op == "include") {
			if (!Fire("IncludeFollower", std::move(subject)))
				return Dump(Refuse("Couldn’t reach Walk With Me’s scripts"));
			g_managed.store(-1);
			return Dump(Ok(who + " is allowed back into the party"));
		}
		return Dump(Refuse("Unknown op"));
	}

	// ------------------------------------------------------------ rescue ----

	std::string Rescue()
	{
		if (!Installed())
			return Dump(Refuse("Walk With Me isn’t loaded"));
		if (Modern()) return Apply(R"({"settings":{"enabled":false}})");

		// Its own stand-down: the wheel's sixth entry, "Return to follower AI".
		// The quest script clears every alias and calls ClearKeepOffsetFromActor
		// + EvaluatePackage per follower on the next 0.25s sync, so this really
		// does hand them back rather than just stopping the steering.
		// marker: formation-wwm-rescue
		const bool sent = Fire("SetEnabled", false);
		{
			std::lock_guard<std::mutex> lock(g_iniLock);
			Ini                         ini;
			if (ini.Load()) {
				ini.Set("General", "bEnabled", "false");
				ini.Save();
			}
		}
		if (!sent)
			return Dump(Refuse(
				"Couldn’t reach Walk With Me’s scripts — it is switched off in the ini "
				"and will stay down from the next launch."));
		g_enabled.store(0);
		return Dump(Ok("Walk With Me stood down — your followers have their own AI back"));
	}
}
