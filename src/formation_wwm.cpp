#include "formation_wwm.h"

#include "npc_actions.h"  // TargetFormID(): the palette-open crosshair snapshot

#include <algorithm>
#include <atomic>
#include <cctype>
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

// pch (force-included) provides RE::/SKSE::/json and the logger.

#ifdef GetObject
#	undef GetObject
#endif

using json = nlohmann::json;

namespace FormationWwm
{
	namespace
	{
		constexpr const char* kPlugin = "Wayfarer.esp";
		constexpr const char* kScript = "Wayfarer";  // its global-native script

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
				return true;
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
			Args&&... args)
		{
			auto* vm = Vm();
			if (!vm || !fn)
				return false;
			auto a = RE::MakeFunctionArguments(std::forward<Args>(args)...);
			return vm->DispatchStaticCall(kScript, fn, a, cb);
		}

		template <class... Args>
		bool Fire(const char* fn, Args&&... args)
		{
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			return CallStatic(fn, cb, std::forward<Args>(args)...);
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
			const auto fid = j.value("formId", std::string(""));
			if (!fid.empty()) {
				const auto local =
					static_cast<std::uint32_t>(std::strtoul(fid.c_str(), nullptr, 16));
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

		int ClampMode(int m) { return std::clamp(m, 0, kModeCount - 1); }
	}

	bool Installed()
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		return dh && dh->LookupModByName(kPlugin) != nullptr;
	}

	int ModeCount() { return kModeCount; }

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
		const char* section = kModes[mode].section;
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
				kModes[mode].hud, haveIni ? "read" : "missing");
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
