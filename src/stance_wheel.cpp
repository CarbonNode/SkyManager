#include "stance_wheel.h"

#include "icon_bridge.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// pch (force-included) provides RE::/SKSE::/logger and, via RE/Skyrim.h,
// <Windows.h> — the same source of INPUT/SendInput/KEYEVENTF main.cpp uses.
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace StanceWheel
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		// Stances NG's own identities, read out of its source (Styyx1/
		// StancesSKSE, src/mod-data.h + stance-manager.h) — never invented.
		constexpr const char*   kPlugin = "StancesNG.esp";
		constexpr RE::FormID    kCurrentGlobal = 0x917;   // 0 Neutral 1 Bear 2 Wolf 3 Hawk
		constexpr const char*   kTomlMain = "Data/SKSE/Plugins/StancesNG.toml";
		constexpr const char*   kTomlCustom = "Data/SKSE/Plugins/StancesNG_custom.toml";
		constexpr const char*   kExpansionPlugin = "Stances NG - Combat Expansion.esp";
		constexpr const char*   kExpansionIcons = "Data/SKSE/Plugins/StancesNGCombatExpansion/Icons/";
		// Stances NG's stance ABILITIES (mod-data.h BEAR/WOLF/HAWK_STANCE_ID) and
		// its previous-stance global — the forms its UpdateStance(kNeutral) touches.
		constexpr std::array<RE::FormID, 3> kStanceSpells{ 0x800, 0x801, 0x802 };
		constexpr RE::FormID    kPreviousGlobal = 0x916;

		// The FOURTH stance, Tarnished (Rober, 2026-10-07: "what about a new stance?
		// With elden ring as an icon"). Stances NG has three stances baked into its
		// DLL, so Tarnished is its own ESL in the same shape a Stances NG stance is
		// (stance-manager.cpp: ApplyStance = RemoveAllStances + an ABILITY on the
		// player): TarnishedStance.esp 0x801 is the ability, 0x800 its effect,
		// which the "Stances NG - Tarnished" OAR submods test together with "no
		// Stances NG stance effect". Being IN Tarnished = Stances NG at Neutral AND
		// the player holding that ability. modding/tarnished-stance/plugin writes it.
		constexpr int           kTarnished = 4;
		constexpr const char*   kTarnishedPlugin = "TarnishedStance.esp";
		constexpr RE::FormID    kTarnishedAbility = 0x801;
		constexpr const char*   kTarnishedIcon = "Data/SKSE/Plugins/TarnishedStance/tarnished.png";

		struct StanceDef
		{
			int         id;
			const char* name;
			const char* slug;
			const char* tomlKey;
			const char* shippedDefault;   // Settings.h — used only when no toml says otherwise
		};
		constexpr std::array<StanceDef, 5> kStances{ {
			{ 0, "Neutral", "neutral", "sNeutralStanceKey", "alt+v" },
			{ 1, "Bear", "bear", "sBearStanceKey", "shift+x" },
			{ 2, "Wolf", "wolf", "sWolfStanceKey", "x" },
			{ 3, "Hawk", "hawk", "sHawkStanceKey", "control+x" },
			{ kTarnished, "Tarnished", "tarnished", nullptr, nullptr },   // no Stances NG key: the wheel IS its switch
		} };

		const StanceDef* Def(int id)
		{
			for (const auto& d : kStances)
				if (d.id == id)
					return &d;
			return nullptr;
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// ------------------------------------------------------------ toml
		// A flat key=value read is enough: every key Stances NG uses is unique
		// across its sections. Main file first, then the custom file on top —
		// the order its REX::TOML store loads them in.
		void ReadToml(const char* path, std::map<std::string, std::string>& out)
		{
			std::ifstream in(path);
			std::string   line;
			while (in && std::getline(in, line)) {
				const auto hash = line.find('#');
				if (hash != std::string::npos) {
					// a '#' inside quotes is a value character, not a comment
					const auto q = line.find('"');
					if (q == std::string::npos || hash < q)
						line.erase(hash);
				}
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				auto trim = [](std::string s) {
					const auto a = s.find_first_not_of(" \t\r\n");
					const auto b = s.find_last_not_of(" \t\r\n");
					return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
				};
				std::string k = trim(line.substr(0, eq));
				std::string v = trim(line.substr(eq + 1));
				if (k.empty() || k.front() == '[')
					continue;
				if (v.size() >= 2 && (v.front() == '"' || v.front() == '\'') && v.back() == v.front())
					v = v.substr(1, v.size() - 2);
				out[k] = v;
			}
		}

		struct Toml
		{
			std::map<std::string, std::string> kv;
			bool                               found = false;
		};
		Toml LoadToml()
		{
			Toml t;
			std::ifstream probe(kTomlMain);
			t.found = probe.good();
			probe.close();
			ReadToml(kTomlMain, t.kv);
			ReadToml(kTomlCustom, t.kv);
			return t;
		}

		std::string Pattern(const Toml& t, const StanceDef& d)
		{
			if (!d.tomlKey)
				return {};
			const auto it = t.kv.find(d.tomlKey);
			return it != t.kv.end() ? it->second : (t.found ? std::string() : std::string(d.shippedDefault));
		}

		bool Cycling(const Toml& t)
		{
			const auto it = t.kv.find("bUseCycling");
			return it != t.kv.end() && Lower(it->second) == "true";
		}

		// ------------------------------------------------------------ keys
		// clib_util::hotkeys' name table (Styyx1/CLibUtil hotkeys.hpp), which
		// is what Stances NG's KeyCombination::SetPattern parses. Keyboard
		// names map to DirectInput scancodes; 256+ are SKSE's mouse codes.
		// Only what SendInput can genuinely produce is listed — F13-F24 and the
		// gamepad live on codes no scancode reaches, and Pick() says so.
		const std::map<std::string, std::uint32_t>& KeyMap()
		{
			static const std::map<std::string, std::uint32_t> m = {
				{ "esc", 1 }, { "1", 2 }, { "2", 3 }, { "3", 4 }, { "4", 5 }, { "5", 6 }, { "6", 7 },
				{ "7", 8 }, { "8", 9 }, { "9", 10 }, { "0", 11 }, { "-", 12 }, { "=", 13 },
				{ "backspace", 14 }, { "tab", 15 }, { "q", 16 }, { "w", 17 }, { "e", 18 }, { "r", 19 },
				{ "t", 20 }, { "y", 21 }, { "u", 22 }, { "i", 23 }, { "o", 24 }, { "p", 25 }, { "[", 26 },
				{ "]", 27 }, { "enter", 28 }, { "ctrl", 29 }, { "control", 29 }, { "a", 30 }, { "s", 31 },
				{ "d", 32 }, { "f", 33 }, { "g", 34 }, { "h", 35 }, { "j", 36 }, { "k", 37 }, { "l", 38 },
				{ ";", 39 }, { "'", 40 }, { "`", 41 }, { "shift", 42 }, { "\\", 43 }, { "z", 44 },
				{ "x", 45 }, { "c", 46 }, { "v", 47 }, { "b", 48 }, { "n", 49 }, { "m", 50 }, { ",", 51 },
				{ ".", 52 }, { "/", 53 }, { "rshift", 54 }, { "rightshift", 54 }, { "num*", 55 },
				{ "alt", 56 }, { "space", 57 }, { "capslock", 58 }, { "f1", 59 }, { "f2", 60 },
				{ "f3", 61 }, { "f4", 62 }, { "f5", 63 }, { "f6", 64 }, { "f7", 65 }, { "f8", 66 },
				{ "f9", 67 }, { "f10", 68 }, { "numlock", 69 }, { "scrolllock", 70 }, { "num7", 71 },
				{ "num8", 72 }, { "num9", 73 }, { "num-", 74 }, { "num4", 75 }, { "num5", 76 },
				{ "num6", 77 }, { "num+", 78 }, { "numplus", 78 }, { "num1", 79 }, { "num2", 80 },
				{ "num3", 81 }, { "num0", 82 }, { "numdel", 83 }, { "f11", 87 }, { "f12", 88 },
				{ "numenter", 156 }, { "rctrl", 157 }, { "rightctrl", 157 }, { "rightcontrol", 157 },
				{ "rcontrol", 157 }, { "num/", 181 }, { "ralt", 184 }, { "rightalt", 184 },
				{ "home", 199 }, { "up", 200 }, { "pageup", 201 }, { "left", 203 }, { "right", 205 },
				{ "end", 207 }, { "down", 208 }, { "pagedown", 209 }, { "insert", 210 }, { "ins", 210 },
				{ "del", 211 }, { "delete", 211 },
				{ "leftmousebutton", 256 }, { "lmb", 256 }, { "rightmousebutton", 257 }, { "rmb", 257 },
				{ "middlemousebutton", 258 }, { "mmb", 258 }, { "mouse3", 259 }, { "mouse4", 260 },
			};
			return m;
		}

		bool IsModifier(std::uint32_t k)
		{
			return k == 29 || k == 42 || k == 54 || k == 56 || k == 157 || k == 184;
		}

		// "Shift + X" — how the wheel prints a binding.
		std::string Pretty(const std::string& pattern)
		{
			std::string s = Lower(pattern), out, part;
			s.erase(std::remove(s.begin(), s.end(), ' '), s.end());
			std::stringstream ss(s);
			std::vector<std::string> parts;
			while (std::getline(ss, part, '+'))
				if (!part.empty())
					parts.push_back(part);
			// modifiers first, like the game prints chords
			std::stable_sort(parts.begin(), parts.end(), [](const std::string& a, const std::string& b) {
				auto rank = [](const std::string& p) {
					return (p == "shift" || p == "rshift" || p == "control" || p == "ctrl" || p == "alt") ? 0 : 1;
				};
				return rank(a) < rank(b);
			});
			for (auto& p : parts) {
				std::string nice = p == "control" ? "Ctrl" : p;
				if (nice.size() == 1)
					nice[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(nice[0])));
				else if (nice != "Ctrl") {
					nice[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(nice[0])));
				}
				if (!out.empty())
					out += " + ";
				out += nice;
			}
			return out;
		}

		// Parse a pattern into modifiers + one main key. false + `why` when the
		// wheel cannot press it.
		bool ParseChord(const std::string& pattern, std::vector<std::uint32_t>& mods, std::uint32_t& key, std::string& why)
		{
			mods.clear();
			key = 0;
			std::string s = Lower(pattern);
			s.erase(std::remove(s.begin(), s.end(), ' '), s.end());
			// clib_util rewrites "num+" before splitting on '+'; do the same
			for (std::size_t p; (p = s.find("num+")) != std::string::npos;)
				s.replace(p, 4, "numplus");
			std::stringstream ss(s);
			std::string       part;
			std::vector<std::uint32_t> keys;
			while (std::getline(ss, part, '+')) {
				if (part.empty())
					continue;
				const auto it = KeyMap().find(part);
				if (it == KeyMap().end()) {
					why = "'" + part + "' is not a key the wheel can press";
					return false;
				}
				keys.push_back(it->second);
			}
			if (keys.empty()) {
				why = "no key bound";
				return false;
			}
			// the main key is the one non-modifier; a lone modifier is itself
			for (auto k : keys) {
				if (!IsModifier(k) && !key)
					key = k;
				else
					mods.push_back(k);
			}
			if (!key) {
				key = mods.back();
				mods.pop_back();
			}
			if (key >= 256 && !mods.empty()) {
				why = "a modifier + mouse button chord";
				return false;
			}
			return true;
		}

		// ------------------------------------------------- input synthesis --
		// Byte-identical to main.cpp / sos_actions.cpp SendScan.
		void SendScan(std::uint32_t dik, bool down)
		{
			INPUT in{};
			in.type = INPUT_KEYBOARD;
			in.ki.wScan = static_cast<WORD>(dik & 0x7F);
			in.ki.dwFlags = KEYEVENTF_SCANCODE;
			if (dik > 0x7F)
				in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
			if (!down)
				in.ki.dwFlags |= KEYEVENTF_KEYUP;
			SendInput(1, &in, sizeof(INPUT));
		}

		void SendMouse(std::uint32_t code, bool down)
		{
			INPUT in{};
			in.type = INPUT_MOUSE;
			switch (code) {
			case 256: in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
			case 257: in.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
			case 258: in.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
			case 259:
				in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
				in.mi.mouseData = XBUTTON1;
				break;
			case 260:
				in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
				in.mi.mouseData = XBUTTON2;
				break;
			default: return;
			}
			SendInput(1, &in, sizeof(INPUT));
		}

		// Stances NG matches a chord only when the EXACT key set is pressed in
		// one input batch (clib_util KeyCombination::Process: pressed == keys),
		// and the engine reports held keys every frame. So: modifiers down,
		// a beat longer than one frame (frame generation halves real frames),
		// the key down long enough to be seen held, then everything up.
		// Detached worker thread.
		void TapChord(const std::vector<std::uint32_t>& mods, std::uint32_t key)
		{
			using namespace std::chrono;
			for (auto m : mods)
				SendScan(m, true);
			if (!mods.empty())
				std::this_thread::sleep_for(milliseconds(45));
			if (key >= 256)
				SendMouse(key, true);
			else
				SendScan(key, true);
			std::this_thread::sleep_for(milliseconds(70));
			if (key >= 256)
				SendMouse(key, false);
			else
				SendScan(key, false);
			if (!mods.empty())
				std::this_thread::sleep_for(milliseconds(25));
			for (auto it = mods.rbegin(); it != mods.rend(); ++it)
				SendScan(*it, false);
		}

		// ---------------------------------------------------- game state --
		RE::TESGlobal* CurrentGlobal()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::TESGlobal>(kCurrentGlobal, kPlugin) : nullptr;
		}

		int CurrentStance()
		{
			auto* g = CurrentGlobal();
			if (!g)
				return -1;
			const int v = static_cast<int>(g->value + 0.5f);
			return (v >= 0 && v <= 3) ? v : -1;
		}

		RE::TESGlobal* PreviousGlobal()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::TESGlobal>(kPreviousGlobal, kPlugin) : nullptr;
		}

		// ---------------------------------------------------- Tarnished --
		RE::SpellItem* TarnishedAbility()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::SpellItem>(kTarnishedAbility, kTarnishedPlugin) : nullptr;
		}

		bool TarnishedOn()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			auto* sp = TarnishedAbility();
			return pc && sp && pc->HasSpell(sp);
		}

		void SetTarnished(bool on)
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			auto* sp = TarnishedAbility();
			if (!pc || !sp || pc->HasSpell(sp) == on)
				return;
			if (on)
				pc->AddSpell(sp);
			else
				pc->RemoveSpell(sp);
		}

		// The stance the player is actually IN, Tarnished included: 0-3 from
		// Stances NG's global, 4 when it sits at Neutral under the Tarnished
		// ability. A Stances NG stance pressed by its own key while Tarnished was
		// up wins (the OAR submods require "no Stances NG stance effect"), and the
		// leftover ability is dropped here so it cannot resurface on a later
		// Neutral. MAIN THREAD.
		int EffectiveStance()
		{
			const int cur = CurrentStance();
			if (!TarnishedOn())
				return cur;
			if (cur == 0)
				return kTarnished;
			if (cur > 0) {
				SetTarnished(false);
				logger::info("stance-wheel: Tarnished dropped - Stances NG switched to {}", Def(cur)->name);   // marker: stance-wheel-tarnished-yield
			}
			return cur;
		}

		// Stances NG's own UpdateStance(kNeutral), step for step (stance-manager
		// .cpp): remember the stance, remove its three stance abilities, set the
		// current global to 0. Used only when its Neutral key is unbound; when it
		// is bound the wheel presses that key instead, like every other pick.
		void MirrorNeutral()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* cur = CurrentGlobal();
			if (!pc || !dh || !cur)
				return;
			if (auto* prev = PreviousGlobal())
				prev->value = cur->value;
			for (auto id : kStanceSpells)
				if (auto* sp = dh->LookupForm<RE::SpellItem>(id, kPlugin); sp && pc->HasSpell(sp))
					pc->RemoveSpell(sp);
			cur->value = 0.f;
		}

		bool ExpansionLoaded()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedLightModByName(kExpansionPlugin) != nullptr ||
							 dh->LookupLoadedModByName(kExpansionPlugin) != nullptr);
		}

		// What is in the player's hands, in Combat Expansion's own terms
		// ("Revert Stance: drop to Neutral while a bow, a crossbow or only
		// spells and staves are in hand"). "melee" covers fists and shields.
		const char* HandKind()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			if (!pc)
				return "melee";
			bool melee = false, ranged = false, magic = false, empty = true;
			for (bool left : { false, true }) {
				RE::TESForm* f = pc->GetEquippedObject(left);
				if (!f)
					continue;
				empty = false;
				if (auto* w = f->As<RE::TESObjectWEAP>()) {
					if (w->IsBow() || w->IsCrossbow())
						ranged = true;
					else if (w->IsStaff())
						magic = true;
					else
						melee = true;
				} else if (f->As<RE::TESObjectARMO>()) {
					melee = true;   // a shield
				} else if (f->As<RE::SpellItem>() || f->As<RE::ScrollItem>()) {
					magic = true;
				}
			}
			if (empty || melee)
				return ranged ? "ranged" : "melee";
			return ranged ? "ranged" : (magic ? "magic" : "melee");
		}

		// ------------------------------------------------------- icons ---
		// Combat Expansion's glyphs mirror as stance-ngce-<slug>.png; Tarnished's
		// own glyph (shipped inside its mod) as stance-tarnished.png.
		std::string IconName(const char* slug)
		{
			return std::string(slug) == "tarnished" ? std::string("stance-tarnished.png")
			                                         : std::string("stance-ngce-") + slug + ".png";
		}

		fs::path IconSource(const char* slug)
		{
			if (std::string(slug) == "tarnished")
				return fs::path(kTarnishedIcon);
			return fs::path(kExpansionIcons) / (std::string(slug) + ".png");
		}

		fs::path IconDest(const char* slug)
		{
			const auto root = IconBridge::ModFolderRoot();
			if (root.empty())
				return {};
			return root / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "sh" / IconName(slug);
		}
	}

	bool Available(std::string& why)
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		const bool loaded = dh && (dh->LookupLoadedLightModByName(kPlugin) != nullptr ||
									  dh->LookupLoadedModByName(kPlugin) != nullptr);
		if (!loaded) {
			why = "Stances NG is not installed (StancesNG.esp is not loaded)";
			return false;
		}
		if (!CurrentGlobal()) {
			why = "Stances NG's stance global is missing - is StancesNG.esp the 2.x plugin?";
			return false;
		}
		return true;
	}

	bool TarnishedAvailable()
	{
		return TarnishedAbility() != nullptr;
	}

	namespace
	{
		void EnterTarnishedNow(int from)
		{
			SetTarnished(true);
			if (TarnishedOn()) {
				logger::info("stance-wheel: switched to Tarnished (from {})", from);   // marker: stance-wheel-tarnished
			} else {
				logger::warn("stance-wheel: Tarnished ability did not stick");
				RE::DebugNotification("Stance Wheel: the Tarnished stance did not take");
			}
		}

		// MAIN THREAD. Into the fourth stance: Stances NG to Neutral first (its own
		// Neutral key when bound — the same press-and-verify every other pick uses;
		// its own three Neutral steps mirrored when unbound), then the ability.
		std::string PickTarnished(int cur)
		{
			if (!TarnishedAvailable()) {
				RE::DebugNotification("Stance Wheel: TarnishedStance.esp is not loaded");
				return "stance-wheel: refused - TarnishedStance.esp is not loaded";
			}
			if (cur <= 0) {
				EnterTarnishedNow(cur);
				return "stance-wheel: pick Tarnished (already Neutral)";
			}
			const Toml        t = LoadToml();
			const std::string pat = Pattern(t, *Def(0));
			std::vector<std::uint32_t> mods;
			std::uint32_t     key = 0;
			std::string       w;
			if (pat.empty() || !ParseChord(pat, mods, key, w)) {
				MirrorNeutral();
				EnterTarnishedNow(cur);
				return "stance-wheel: pick Tarnished (Neutral mirrored - " + (pat.empty() ? std::string("no Neutral key") : w) + ")";
			}
			std::thread([mods, key, cur]() {
				using namespace std::chrono;
				std::this_thread::sleep_for(milliseconds(60));
				TapChord(mods, key);
				std::this_thread::sleep_for(milliseconds(400));
				SKSE::GetTaskInterface()->AddTask([cur]() {
					if (CurrentStance() != 0) {
						logger::info("stance-wheel: no switch to Tarnished - Stances NG stayed at {}", CurrentStance());
						RE::DebugNotification("Stances NG did not drop to Neutral, so Tarnished was not applied");
						return;
					}
					EnterTarnishedNow(cur);
				});
			}).detach();
			return "stance-wheel: pick Tarnished (Neutral key, then the ability)";
		}
	}

	std::string StateJson()
	{
		json        j;
		std::string why;
		j["ok"] = Available(why);
		if (!j["ok"].get<bool>()) {
			j["msg"] = why;
			return j.dump();
		}
		const Toml t = LoadToml();
		const bool tarnished = TarnishedAvailable();
		const Options opt = GetOptions();   // stance-wheel.json
		j["size"] = opt.sizeVh;             // the wheel's diameter, vh
		j["slow"] = opt.slow;               // the time multiplier while it is up (1 = not slowed)
		j["current"] = EffectiveStance();
		j["tarnished"] = tarnished;
		j["cycling"] = Cycling(t);
		j["expansion"] = ExpansionLoaded();
		j["hand"] = HandKind();
		json list = json::array();
		for (const auto& d : kStances) {
			if (d.id == kTarnished && !tarnished)
				continue;
			const std::string p = Pattern(t, d);
			list.push_back({ { "id", d.id }, { "name", d.name }, { "key", p.empty() ? "" : Pretty(p) } });
		}
		j["stances"] = list;
		json icons = json::object();
		for (const char* slug : { "bear", "wolf", "hawk", "tarnished" }) {
			std::error_code ec;
			const auto      dest = IconDest(slug);
			if (!dest.empty() && fs::exists(dest, ec))
				icons[slug] = "icons/sh/" + IconName(slug);
		}
		j["icons"] = icons;
		std::string msg;
		if (!t.found)
			msg = "StancesNG.toml not found - using Stances NG's default keys";
		else if (j["expansion"].get<bool>() && std::string(j["hand"].get<std::string>()) != "melee" &&
				 j["current"].get<int>() == 0)
			msg = "Bow or spells in hand: Combat Expansion holds Neutral until a melee weapon is out";
		else if (j["current"].get<int>() == kTarnished && std::string(j["hand"].get<std::string>()) != "melee")
			msg = "Tarnished has no Elden Ring set for a bow or spells - your usual animations play";
		j["msg"] = msg;
		return j.dump();
	}

	// ---- settings sidecar ----------------------------------------------------
	namespace
	{
		constexpr float kDefSlow = 0.2f, kMinSlow = 0.05f, kMaxSlow = 1.0f;
		constexpr int   kDefSize = 64, kMinSize = 40, kMaxSize = 80;

		std::mutex g_optMutex;
		Options    g_opt;
		bool       g_optLoaded = false;

		fs::path OptionsPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "stance-wheel.json";
		}

		Options Clamped(Options o)
		{
			if (!(o.slow >= kMinSlow))   // also catches NaN
				o.slow = kMinSlow;
			if (o.slow > kMaxSlow)
				o.slow = kMaxSlow;
			o.sizeVh = (std::max)(kMinSize, (std::min)(kMaxSize, o.sizeVh));
			return o;
		}

		// Caller holds g_optMutex.
		void LoadOptionsLocked()
		{
			if (g_optLoaded)
				return;
			g_optLoaded = true;
			std::ifstream in(OptionsPath(), std::ios::binary);
			if (!in)
				return;
			const auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			Options o;
			if (j.contains("slow") && j["slow"].is_number())
				o.slow = j["slow"].get<float>();
			if (j.contains("size") && j["size"].is_number())
				o.sizeVh = static_cast<int>(j["size"].get<double>() + 0.5);
			g_opt = Clamped(o);
			logger::info("stance-wheel: options loaded (time x{}, size {}vh)", g_opt.slow, g_opt.sizeVh);   // marker: stance-wheel-options
		}
	}

	Options GetOptions()
	{
		std::lock_guard l(g_optMutex);
		LoadOptionsLocked();
		return g_opt;
	}

	std::string OptionsJson()
	{
		const Options o = GetOptions();
		return json{
			{ "slow", o.slow }, { "size", o.sizeVh },
			{ "defSlow", kDefSlow }, { "defSize", kDefSize },
			{ "minSlow", kMinSlow }, { "maxSlow", kMaxSlow },
			{ "minSize", kMinSize }, { "maxSize", kMaxSize },
		}.dump();
	}

	std::string SetOptions(const std::string& requestJson)
	{
		const auto j = json::parse(requestJson, nullptr, false);
		if (!j.is_discarded() && j.is_object()) {
			std::lock_guard l(g_optMutex);
			LoadOptionsLocked();
			Options o = g_opt;
			if (j.value("reset", false))
				o = Options{};
			if (j.contains("slow") && j["slow"].is_number())
				o.slow = j["slow"].get<float>();
			if (j.contains("size") && j["size"].is_number())
				o.sizeVh = static_cast<int>(j["size"].get<double>() + 0.5);
			g_opt = Clamped(o);
			std::error_code ec;
			fs::create_directories(OptionsPath().parent_path(), ec);
			std::ofstream out(OptionsPath(), std::ios::binary | std::ios::trunc);
			if (out)
				out << json{ { "slow", g_opt.slow }, { "size", g_opt.sizeVh } }.dump(2);
			else
				logger::warn("stance-wheel: could not write stance-wheel.json");
			logger::info("stance-wheel: options saved (time x{}, size {}vh)", g_opt.slow, g_opt.sizeVh);
		}
		return OptionsJson();
	}

	std::string Pick(int stance)
	{
		const StanceDef* target = Def(stance);
		if (!target)
			return "stance-wheel: bad stance id " + std::to_string(stance);
		std::string why;
		if (!Available(why)) {
			RE::DebugNotification(why.c_str());
			return "stance-wheel: " + why;
		}
		const int cur = CurrentStance();
		const int eff = EffectiveStance();
		if (eff == stance)
			return std::string("stance-wheel: already in ") + target->name;

		if (stance == kTarnished)
			return PickTarnished(cur);

		// Leaving Tarnished: drop its ability first, so the Stances NG stance the
		// key brings is the only one on. Tarnished -> Neutral needs no key at all.
		if (eff == kTarnished) {
			SetTarnished(false);
			if (stance == 0 && cur == 0) {
				logger::info("stance-wheel: switched to Neutral (left Tarnished)");   // marker: stance-wheel-tarnished-off
				return "stance-wheel: left Tarnished for Neutral";
			}
		}

		const Toml t = LoadToml();

		// The presses, in order. Direct keys for everything Stances NG binds
		// directly; with bUseCycling on, its Wolf key CYCLES 1->2->3->1 instead
		// (StanceManager::CycleStancesPlayer), so Wolf is reached through it.
		struct Press { std::vector<std::uint32_t> mods; std::uint32_t key; };
		std::vector<Press> plan;
		auto add = [&](const StanceDef& d) -> bool {
			Press p{};
			std::string w;
			const std::string pat = Pattern(t, d);
			if (pat.empty()) {
				why = std::string(d.name) + " has no key in StancesNG.toml";
				return false;
			}
			if (!ParseChord(pat, p.mods, p.key, w)) {
				why = std::string(d.name) + "'s key (" + pat + ") can't be pressed: " + w;
				return false;
			}
			plan.push_back(std::move(p));
			return true;
		};
		const StanceDef& wolf = *Def(2);
		bool ok = true;
		if (Cycling(t) && stance == 2) {
			// Bear's key (direct) then one cycle lands on Wolf; without a Bear
			// key, cycle from wherever we are.
			if (!Pattern(t, *Def(1)).empty()) {
				ok = add(*Def(1)) && add(wolf);
			} else {
				int c = cur < 0 ? 0 : cur;
				for (int i = 0; i < 3 && c != 2 && ok; ++i) {
					ok = add(wolf);
					c = c + 1 > 3 ? 1 : c + 1;
				}
			}
		} else if (Cycling(t) && stance != 0 && Pattern(t, *target).empty()) {
			// Bear/Hawk unbound in cycling mode: walk the cycle with Wolf's key.
			int c = cur < 0 ? 0 : cur;
			for (int i = 0; i < 3 && c != stance && ok; ++i) {
				ok = add(wolf);
				c = c + 1 > 3 ? 1 : c + 1;
			}
		} else {
			ok = add(*target);
		}
		if (!ok) {
			const std::string msg = "Stance Wheel: " + why;
			RE::DebugNotification(msg.c_str());
			return "stance-wheel: refused - " + why;
		}

		const bool        expansion = ExpansionLoaded();
		const std::string hand = HandKind();
		const std::string name = target->name;
		std::thread([plan, stance, name, expansion, hand]() {
			using namespace std::chrono;
			// let the wheel's focus release and the world's time restore land
			std::this_thread::sleep_for(milliseconds(60));
			for (std::size_t i = 0; i < plan.size(); ++i) {
				if (i)
					std::this_thread::sleep_for(milliseconds(140));
				TapChord(plan[i].mods, plan[i].key);
			}
			std::this_thread::sleep_for(milliseconds(400));
			// Verify on the MAIN thread — never block this worker on it.
			SKSE::GetTaskInterface()->AddTask([stance, name, expansion, hand]() {
				const int now = CurrentStance();
				if (now == stance) {
					logger::info("stance-wheel: switched to {}", name);   // marker: stance-wheel-switched
					return;
				}
				std::string msg;
				if (expansion && hand != "melee" && now == 0)
					msg = name + " queued - Combat Expansion keeps Neutral until a melee weapon is in hand";
				else
					msg = "Stances NG did not switch to " + name;
				logger::info("stance-wheel: no switch to {} (now {}, hand {})", name, now, hand);
				RE::DebugNotification(msg.c_str());
			});
		}).detach();
		return "stance-wheel: pick " + name + " (" + std::to_string(plan.size()) + " press(es))";
	}

	void MirrorIconsAsync()
	{
		std::thread([]() {
			std::size_t copied = 0, have = 0;
			for (const char* slug : { "bear", "wolf", "hawk", "tarnished" }) {
				std::error_code ec;
				const fs::path  src = IconSource(slug);
				if (!fs::exists(src, ec))
					continue;   // its mod not installed: the wheel draws the stance's initial
				const fs::path dest = IconDest(slug);
				if (dest.empty() || !fs::exists(dest.parent_path(), ec))
					continue;   // never CREATE the folder mid-session (the MO2 VFS law)
				const auto ssz = fs::file_size(src, ec);
				if (!ec && fs::exists(dest, ec) && fs::file_size(dest, ec) == ssz) {
					++have;
					continue;
				}
				fs::copy_file(src, dest, fs::copy_options::overwrite_existing, ec);
				if (ec)
					logger::warn("stance-wheel: icon {} not mirrored: {}", slug, ec.message());
				else
					++copied;
			}
			logger::info("stance-wheel: icons mirrored {} new, {} current", copied, have);   // marker: stance-wheel-icons
		}).detach();
	}
}
