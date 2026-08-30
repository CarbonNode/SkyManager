// Keys tab, file-based sources. See keys_sources.h for the two sources and for
// the code-space rule that shapes every decision in here.
//
// Threading: called from the Keys scan thread (keys_scan.cpp's InstantSources).
// Pure filesystem + parsing, no engine or VM access, so it needs no main-thread
// hop -- but it DOES run against the MO2 VFS, i.e. the merged virtual Data of a
// 4,780-mod instance, which is why every walk is bounded and every parse is
// best-effort. One unreadable or malformed config must never fail a census.

#include "keys_sources.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include <Windows.h>

// Windows.h drags in the min/max macros, which break std::min/std::max below.
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace KeysSources
{
	namespace
	{
		// ------------------------------------------------------------- caps --
		// The walk is over the VFS of a very large load order. These bounds exist
		// so a pathological install cannot turn a census into a stall; whenever
		// one bites we LOG it, because a silently truncated list reads as "we
		// looked everywhere and this is all there is".
		constexpr int            kMaxDepth = 4;
		// 20,000, not the 3,000 this shipped with: a dry-run against the rig's
		// real mod tree on 2026-08-28 found 10,045 config files under
		// SKSE\Plugins. The old cap would have stopped at under a third of them
		// and called the census complete.
		constexpr int            kMaxFiles = 20000;
		constexpr std::size_t    kMaxRows = 600;
		constexpr std::uintmax_t kMaxFileBytes = 1u << 20;  // 1 MiB

		constexpr std::uint32_t kMouseBase = 256;  // SkyUI/ControlMap convention

		// -------------------------------------------------------- text bits --

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// Name comparison form: lowercased with the separators people sprinkle
		// through setting names removed, so "Toggle_Key", "toggle-key" and
		// "ToggleKey" are one thing.
		std::string Squash(std::string_view s)
		{
			std::string out;
			out.reserve(s.size());
			for (const char c : s) {
				const auto u = static_cast<unsigned char>(c);
				if (c == '_' || c == '-' || c == '.' || c == ' ' || c == '\t') {
					continue;
				}
				out += static_cast<char>(std::tolower(u));
			}
			return out;
		}

		bool Has(const std::string& hay, std::string_view needle)
		{
			return hay.find(needle) != std::string::npos;
		}

		bool EndsWith(const std::string& s, std::string_view suffix)
		{
			return s.size() >= suffix.size() &&
			       s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
		}

		bool StartsWith(const std::string& s, std::string_view prefix)
		{
			return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
		}

		std::string Trim(std::string_view s)
		{
			std::size_t b = 0, e = s.size();
			const auto space = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
			while (b < e && space(s[b])) {
				++b;
			}
			while (e > b && space(s[e - 1])) {
				--e;
			}
			auto out = std::string(s.substr(b, e - b));
			// Values are frequently quoted in json-ish and toml configs.
			if (out.size() >= 2 && ((out.front() == '"' && out.back() == '"') ||
			                        (out.front() == '\'' && out.back() == '\''))) {
				out = out.substr(1, out.size() - 2);
			}
			return out;
		}

		// Cut an inline comment. Deliberately conservative: only ';' and '#'
		// (and '//') START a comment, and only when they are not the first
		// character of the value, so a value like "#42" is left alone.
		std::string StripInlineComment(std::string_view v)
		{
			for (std::size_t i = 1; i < v.size(); ++i) {
				if (v[i] == ';' || v[i] == '#') {
					return std::string(v.substr(0, i));
				}
				if (v[i] == '/' && i + 1 < v.size() && v[i + 1] == '/') {
					return std::string(v.substr(0, i));
				}
			}
			return std::string(v);
		}

		// "Skip_CompilationKey" -> "Skip compilation". Splits camelCase and
		// separators into words, drops a trailing "key"/"code"/"button" word when
		// something else is left to name the action.
		std::string Prettify(std::string_view raw)
		{
			std::vector<std::string> words;
			std::string cur;
			for (std::size_t i = 0; i < raw.size(); ++i) {
				const char c = raw[i];
				if (c == '_' || c == '-' || c == '.' || c == ' ') {
					if (!cur.empty()) {
						words.push_back(cur);
						cur.clear();
					}
					continue;
				}
				const bool upper = std::isupper(static_cast<unsigned char>(c)) != 0;
				const bool prevLower = !cur.empty() &&
				                       std::islower(static_cast<unsigned char>(cur.back())) != 0;
				if (upper && prevLower) {
					words.push_back(cur);
					cur.clear();
				}
				cur += c;
			}
			if (!cur.empty()) {
				words.push_back(cur);
			}
			if (words.size() > 1) {
				const auto last = Lower(words.back());
				if (last == "key" || last == "code" || last == "keycode" || last == "button") {
					words.pop_back();
				}
			}
			std::string out;
			for (std::size_t i = 0; i < words.size(); ++i) {
				auto w = words[i];
				if (i == 0) {
					if (!w.empty()) {
						w[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(w[0])));
					}
				} else {
					w = Lower(w);
				}
				out += (i ? " " : "") + w;
			}
			return out.empty() ? std::string(raw) : out;
		}

		// Decimal or 0x-hex, tolerating surrounding junk. Returns false unless the
		// WHOLE trimmed token is a number -- "F10" must not read as 10.
		bool ParseInt(std::string_view raw, long& out)
		{
			const auto s = Trim(StripInlineComment(raw));
			if (s.empty()) {
				return false;
			}
			std::size_t i = 0;
			int         sign = 1;
			if (s[i] == '+' || s[i] == '-') {
				sign = s[i] == '-' ? -1 : 1;
				++i;
			}
			int  base = 10;
			if (i + 1 < s.size() && s[i] == '0' && (s[i + 1] == 'x' || s[i + 1] == 'X')) {
				base = 16;
				i += 2;
			}
			if (i >= s.size()) {
				return false;
			}
			long value = 0;
			for (; i < s.size(); ++i) {
				const auto c = static_cast<unsigned char>(s[i]);
				int        digit;
				if (std::isdigit(c)) {
					digit = c - '0';
				} else if (base == 16 && std::isxdigit(c)) {
					digit = std::tolower(c) - 'a' + 10;
				} else {
					return false;  // trailing text -- not a plain number
				}
				value = value * base + digit;
				if (value > 1000000) {
					return false;  // nothing key-shaped is this big
				}
			}
			out = sign * value;
			return true;
		}

		// ------------------------------------------------------- code space --

		// Windows virtual-key -> the census space (DirectInput scancode, mouse as
		// 256+button). Returns 0 when the VK has no scancode on this layout, which
		// is an honest "cannot place this key" rather than a guess.
		std::uint32_t VkToCensus(long vk)
		{
			switch (vk) {
			case VK_LBUTTON:  return kMouseBase + 0;
			case VK_RBUTTON:  return kMouseBase + 1;
			case VK_MBUTTON:  return kMouseBase + 2;
			case VK_XBUTTON1: return kMouseBase + 3;
			case VK_XBUTTON2: return kMouseBase + 4;
			default: break;
			}
			if (vk <= 0 || vk > 0xFE) {
				return 0;
			}
			// MAPVK_VK_TO_VSC_EX returns the E0-prefixed scancode for the extended
			// keys (Home, arrows, numpad Enter, right Ctrl/Alt...). DirectInput
			// spells those as 0x80 | scancode, which is the census space -- plain
			// MAPVK_VK_TO_VSC would collapse Home onto Numpad 7.
			const UINT sc = MapVirtualKeyW(static_cast<UINT>(vk), MAPVK_VK_TO_VSC_EX);
			if (!sc) {
				return 0;
			}
			if ((sc & 0xFF00u) == 0xE000u) {
				return 0x80u | (sc & 0xFFu);
			}
			return sc & 0xFFu;
		}

		std::string ModifierName(long vk)
		{
			switch (vk) {
			case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT:       return "Shift";
			case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL: return "Ctrl";
			case VK_MENU: case VK_LMENU: case VK_RMENU:          return "Alt";
			case VK_LWIN: case VK_RWIN:                          return "Win";
			default: return {};
			}
		}

		std::string JoinMods(const std::vector<std::string>& mods)
		{
			std::string out;
			for (const auto& m : mods) {
				if (m.empty()) {
					continue;
				}
				if (!out.empty()) {
					out += "+";
				}
				out += m;
			}
			return out;
		}

		// ------------------------------------------------------ ini reading --

		struct Assignment
		{
			std::string section;  // lowercased, "" outside any section
			std::string name;     // as written
			std::string value;    // trimmed, comment-stripped, unquoted
		};

		// A deliberately small line reader that covers ini/toml/cfg/yaml alike:
		// "[section]" headers plus "name = value" / "name: value". It is not a
		// full parser for any of those formats and does not pretend to be -- a
		// hotkey setting is a scalar on one line in every one of them.
		// Read a file as text, bounded. Used for both the assignment parse and
		// the code-space documentation scan, so a config is opened once.
		std::string ReadTextCapped(const fs::path& path, std::size_t maxBytes)
		{
			std::ifstream in(path, std::ios::binary);
			if (!in) {
				return {};
			}
			std::string text;
			text.resize(maxBytes);
			in.read(text.data(), static_cast<std::streamsize>(maxBytes));
			text.resize(static_cast<std::size_t>(in.gcount()));
			return text;
		}

		std::vector<Assignment> ParseAssignments(const std::string& text)
		{
			std::vector<Assignment> out;
			std::istringstream      in(text);
			std::string             line, section;
			while (std::getline(in, line)) {
				auto trimmed = Trim(line);
				if (trimmed.empty() || trimmed[0] == ';' || trimmed[0] == '#' ||
				    (trimmed.size() > 1 && trimmed[0] == '/' && trimmed[1] == '/')) {
					continue;  // comment, or a commented-out assignment
				}
				if (trimmed.front() == '[' && trimmed.back() == ']') {
					section = Lower(trimmed.substr(1, trimmed.size() - 2));
					continue;
				}
				auto sep = trimmed.find('=');
				if (sep == std::string::npos) {
					sep = trimmed.find(':');
				}
				if (sep == std::string::npos || sep == 0) {
					continue;
				}
				auto name = Trim(std::string_view(trimmed).substr(0, sep));
				auto value = Trim(StripInlineComment(std::string_view(trimmed).substr(sep + 1)));
				if (name.empty() || value.empty()) {
					continue;
				}
				out.push_back(Assignment{ section, std::move(name), std::move(value) });
			}
			return out;
		}

		std::vector<Assignment> ReadAssignments(const fs::path& path)
		{
			return ParseAssignments(ReadTextCapped(path, kMaxFileBytes));
		}

		std::string FindValue(const std::vector<Assignment>& all, std::string_view section,
			std::string_view name)
		{
			const auto sect = Lower(std::string(section));
			const auto want = Squash(name);
			for (const auto& a : all) {
				if (a.section == sect && Squash(a.name) == want) {
					return a.value;
				}
			}
			return {};
		}

		// --------------------------------------------------- field matching --

		// Does this setting name mean "a key is bound here"? Written as a small
		// allow/deny pair rather than a regex so every decision is greppable.
		bool IsKeyField(std::string_view rawName)
		{
			const auto n = Squash(rawName);
			if (n.empty()) {
				return false;
			}
			// Names that contain "key" but mean something else entirely. Without
			// these, every SPID/keyword-driven mod's config floods the census.
			static constexpr std::string_view kDeny[] = {
				"keyword", "keychance", "keycount", "keyamount", "keyweight",
				"keyframe", "keyring", "keyname", "keylist", "keyvalue",
				// Modifiers are real, but they are the OTHER half of a bind, not a
				// bind: listing Shift as a claimed key is pure noise.
				"modifierkey", "modifierbutton", "combokey", "modkey",
				// The census is keyboard + mouse only. A gamepad button index
				// would be read as a scancode (button 1 == Esc), so it must not
				// enter until the census grows a gamepad space of its own.
				"gamepad", "gpad", "controller", "xinput", "joystick", "joy",
			};
			for (const auto d : kDeny) {
				if (Has(n, d)) {
					return false;
				}
			}
			static constexpr std::string_view kExact[] = {
				"key", "ikey", "ukey", "keycode", "scancode", "hotkey", "hotkeycode",
				"button", "togglekey", "openkey", "menukey", "dikcode", "vkcode",
				"virtualkey", "keyboardkey",
			};
			for (const auto e : kExact) {
				if (n == e) {
					return true;
				}
			}
			static constexpr std::string_view kContains[] = {
				"hotkey", "keybind", "keycode", "scancode", "keymap", "inputkey",
				"virtualkey", "shortcutkey", "togglekey", "openkey", "menukey",
			};
			for (const auto c : kContains) {
				if (Has(n, c)) {
					return true;
				}
			}
			return EndsWith(n, "key") || EndsWith(n, "keys") || EndsWith(n, "button");
		}

		// A value that means "nothing is bound here".
		bool IsUnbound(long v)
		{
			return v <= 0 || v == 0xFF;  // 0 / -1 / 255 are the three conventions
		}

		enum class Space
		{
			Dik,  // DirectInput scancode -- the census space
			Vk,   // Windows virtual-key
		};

		struct SpaceCall
		{
			Space space = Space::Dik;
			bool  certain = false;
		};

		// ⚠ Per-file overrides. ONLY entries confirmed by reading the real file,
		// because an unverified one turns a row the pane would have shown as an
		// assumption into a confident claim -- the exact failure this design
		// exists to avoid. Matched on the lowercased file name.
		bool FileSpaceHint(const std::string& fileNameLower, Space& out)
		{
			// Improved Camera says so in its own comment: "Key modifier to open
			// the menu, 0x24 is Home. F1-F12 keys range from 0x70 to 0x7B" --
			// those are Windows virtual-keys (VK_HOME is 0x24; the DirectInput
			// Home is 0xC7). Read on the rig 2026-08-28. Without this, MenuKey
			// reads as DIK 36, which is the J key.
			if (fileNameLower == "improvedcamerase.ini") {
				out = Space::Vk;
				return true;
			}
			return false;
		}

		// ---- the file's OWN documentation ------------------------------------
		// Most SKSE plugin configs say which alphabet they speak, in a comment
		// next to the setting: "DXScanCode", "DIK key code", or a link to the CK
		// Input_Script page. On the rig's real load order, 7 of 11 sampled files
		// documented themselves this way -- so reading the comments turns most
		// rows from an assumption into a fact, and it works on anyone's install
		// rather than only on the files we happened to look at.
		//
		// Scanned once per file, over the whole text: these phrases appear only
		// in prose, so there is no need to isolate comment lines, and a config
		// that mentions BOTH alphabets is left undecided rather than guessed.
		bool DocumentedSpace(const std::string& text, Space& out)
		{
			const auto t = Lower(text);
			static constexpr std::string_view kDik[] = {
				"dxscancode", "dx scan code", "dxscan code", "scancode", "scan code",
				"dik ", "input_script", "directinput",
			};
			static constexpr std::string_view kVk[] = {
				"virtual-key", "virtual key", "virtualkey", "vk_", "getasynckeystate",
			};
			bool dik = false, vk = false;
			for (const auto d : kDik) {
				if (Has(t, d)) {
					dik = true;
					break;
				}
			}
			for (const auto v : kVk) {
				if (Has(t, v)) {
					vk = true;
					break;
				}
			}
			if (dik == vk) {
				return false;  // neither, or both -- no honest answer
			}
			out = dik ? Space::Dik : Space::Vk;
			return true;
		}

		// Precedence: what the SETTING NAME says, then a verified per-file
		// override, then what the FILE's prose says, then the default. The
		// verified table outranks the prose deliberately -- a file can mention
		// scancodes in passing while its keys are virtual-keys.
		SpaceCall SpaceFor(std::string_view rawName, const std::string& fileNameLower,
			const SpaceCall& fileLevel)
		{
			const auto n = Squash(rawName);
			if (Has(n, "virtualkey") || Has(n, "vkcode") || Has(n, "asynckey") || StartsWith(n, "vk")) {
				return { Space::Vk, true };
			}
			if (Has(n, "scancode") || Has(n, "dikcode") || Has(n, "directinput") || Has(n, "dxsc")) {
				return { Space::Dik, true };
			}
			if (Space hinted = Space::Dik; FileSpaceHint(fileNameLower, hinted)) {
				return { hinted, true };
			}
			if (fileLevel.certain) {
				return fileLevel;
			}
			// The default. Most SKSE plugins read CommonLib ButtonEvents, whose
			// idCode IS a DirectInput scancode, so DIK is the better bet -- but a
			// bet is what it is, hence certain=false.
			return { Space::Dik, false };
		}

		// Turn a raw setting value into a census code. Returns 0 to reject.
		std::uint32_t CodeFrom(long value, const SpaceCall& call, std::string_view rawName)
		{
			if (IsUnbound(value)) {
				return 0;
			}
			// "MouseButton = 1" is an index into the mouse buttons, not a key code.
			const auto n = Squash(rawName);
			if (Has(n, "mouse") && value >= 0 && value <= 7) {
				return kMouseBase + static_cast<std::uint32_t>(value);
			}
			if (value > 0xFE) {
				return 0;  // out of both spaces -- not a key
			}
			if (call.space == Space::Vk) {
				return VkToCensus(value);
			}
			return static_cast<std::uint32_t>(value);
		}

		// ------------------------------------------------------- row buffer --

		struct Sink
		{
			std::vector<Row>                out;
			std::unordered_set<std::string> seen;
			bool                            capped = false;

			void Add(Row r)
			{
				if (!r.code) {
					return;
				}
				if (out.size() >= kMaxRows) {
					capped = true;
					return;
				}
				auto key = r.mod + "|" + std::to_string(r.code) + "|" + r.control;
				if (!seen.insert(std::move(key)).second) {
					return;
				}
				out.push_back(std::move(r));
			}
		};

		// ========================================================== overlays ==

		// ENB. Both inis live beside SkyrimSE.exe (the process CWD), outside the
		// mod list entirely -- which is precisely why nothing else in the census
		// can see them.
		void ScanEnb(Sink& sink)
		{
			static constexpr std::pair<std::string_view, std::string_view> kKeys[] = {
				{ "KeyReadConfig", "Reload ENB config" },
				{ "KeyUseEffect", "Toggle ENB" },
				{ "KeyFPSLimit", "Toggle FPS limit" },
				{ "KeyShowFPS", "Show FPS" },
				{ "KeyScreenshot", "Screenshot" },
				{ "KeyEditor", "ENB editor" },
				{ "KeyFreeVRAM", "Free VRAM" },
				{ "KeyBruteForce", "Brute force" },
				{ "KeyDepthOfField", "Depth of field" },
				{ "KeyDof", "Depth of field" },
				{ "KeyBloom", "Bloom" },
				{ "KeyOcclusion", "Ambient occlusion" },
				{ "KeyReflection", "Reflection" },
				{ "KeyShadow", "Shadows" },
				{ "KeyWater", "Water" },
			};

			for (const auto* file : { "enblocal.ini", "enbseries.ini" }) {
				const fs::path path(file);
				std::error_code ec;
				if (!fs::exists(path, ec)) {
					continue;  // no ENB -- not an error
				}
				const auto all = ReadAssignments(path);
				if (all.empty()) {
					continue;
				}

				// KeyCombination is ENB's "hold this as well" modifier for its
				// other hotkeys, so it is shown as a modifier on every ENB row
				// rather than as a key claim of its own.
				std::string combo;
				long        comboVk = 0;
				if (const auto raw = FindValue(all, "input", "KeyCombination");
					!raw.empty() && ParseInt(raw, comboVk) && !IsUnbound(comboVk)) {
					combo = ModifierName(comboVk);
					if (combo.empty()) {
						combo = "ENB combo";
					}
				}

				for (const auto& [name, label] : kKeys) {
					const auto raw = FindValue(all, "input", name);
					long       vk = 0;
					if (raw.empty() || !ParseInt(raw, vk) || IsUnbound(vk)) {
						continue;
					}
					const auto code = VkToCensus(vk);
					if (!code) {
						continue;
					}
					sink.Add(Row{ "enb", "ENB", std::string(label), code, combo, false,
						std::string(file) + " [INPUT] " + std::string(name) + " = " + raw });
				}
			}
		}

		// ReShade. One tuple per binding: "vk,ctrl,shift,alt".
		void ScanReShade(Sink& sink)
		{
			static constexpr std::pair<std::string_view, std::string_view> kKeys[] = {
				{ "KeyOverlay", "Open the ReShade overlay" },
				{ "KeyEffects", "Toggle effects" },
				{ "KeyPerformanceMode", "Performance mode" },
				{ "KeyPreviousPreset", "Previous preset" },
				{ "KeyNextPreset", "Next preset" },
				{ "KeyScreenshot", "Screenshot" },
				{ "KeyReload", "Reload shaders" },
				{ "KeyFPS", "Show FPS" },
				{ "KeyFrameTime", "Show frame time" },
			};

			const fs::path path("ReShade.ini");
			std::error_code ec;
			if (!fs::exists(path, ec)) {
				return;
			}
			const auto all = ReadAssignments(path);
			for (const auto& [name, label] : kKeys) {
				const auto raw = FindValue(all, "input", name);
				if (raw.empty()) {
					continue;
				}
				// Split on commas: vk, ctrl, shift, alt. A tuple that is only a
				// bare number is still honoured -- older ReShade wrote those.
				std::vector<long> parts;
				std::size_t       pos = 0;
				while (pos <= raw.size() && parts.size() < 4) {
					const auto comma = raw.find(',', pos);
					const auto piece = raw.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
					long       v = 0;
					parts.push_back(ParseInt(piece, v) ? v : 0);
					if (comma == std::string::npos) {
						break;
					}
					pos = comma + 1;
				}
				if (parts.empty() || IsUnbound(parts[0])) {
					continue;
				}
				const auto code = VkToCensus(parts[0]);
				if (!code) {
					continue;
				}
				std::vector<std::string> mods;
				if (parts.size() > 1 && parts[1]) {
					mods.push_back("Ctrl");
				}
				if (parts.size() > 2 && parts[2]) {
					mods.push_back("Shift");
				}
				if (parts.size() > 3 && parts[3]) {
					mods.push_back("Alt");
				}
				sink.Add(Row{ "reshade", "ReShade", std::string(label), code, JoinMods(mods), false,
					"ReShade.ini [INPUT] " + std::string(name) + " = " + raw });
			}
		}

		// Community Shaders keeps its settings in an SKSE json; its key fields are
		// virtual-key codes, singly or as [key, modifier...] combos.
		void ScanCommunityShaders(Sink& sink)
		{
			static constexpr std::string_view kCandidates[] = {
				"Data/SKSE/Plugins/CommunityShaders.json",
				"Data/SKSE/Plugins/CommunityShaders/Settings.json",
			};

			for (const auto candidate : kCandidates) {
				const fs::path path{ std::string(candidate) };
				std::error_code ec;
				if (!fs::exists(path, ec)) {
					continue;
				}
				std::ifstream in(path, std::ios::binary);
				if (!in) {
					continue;
				}
				const auto doc = json::parse(in, nullptr, false, true);
				if (doc.is_discarded()) {
					logger::warn("keys-scan: {} did not parse as json", PathU8(path));
					continue;
				}

				// Walk the whole document: CS nests its key fields under feature
				// objects, and the shape has changed between releases.
				const auto walk = [&sink, &path](const json& node, const std::string& trail,
									  const auto& self) -> void {
					if (node.is_object()) {
						for (const auto& [name, value] : node.items()) {
							// Bound to a NAMED json reference on purpose: inside a
							// generic lambda a structured-binding name is dependent,
							// so `value.get<long>()` needs a `template` keyword to
							// compile anywhere but MSVC. Naming the type sidesteps it.
							const json& val = value;
							const auto  label = trail.empty() ? name : trail + " · " + name;
							if (IsKeyField(name)) {
								long vk = 0;
								if (val.is_number_integer()) {
									vk = val.get<long>();
								} else if (val.is_string()) {
									if (!ParseInt(val.get<std::string>(), vk)) {
										vk = 0;
									}
								} else if (val.is_array() && !val.empty() &&
										   val[0].is_number_integer()) {
									vk = val[0].get<long>();
								}
								if (!IsUnbound(vk)) {
									std::vector<std::string> mods;
									if (val.is_array()) {
										for (std::size_t i = 1; i < val.size(); ++i) {
											if (val[i].is_number_integer()) {
												auto m = ModifierName(val[i].get<long>());
												if (!m.empty()) {
													mods.push_back(std::move(m));
												}
											}
										}
									}
									if (const auto code = VkToCensus(vk)) {
										sink.Add(Row{ "shaders", "Community Shaders",
											Prettify(name), code, JoinMods(mods), false,
											PathU8(path) + " · " + label + " = " + std::to_string(vk) });
									}
								}
							}
							self(value, label, self);
						}
					} else if (node.is_array()) {
						for (const auto& v : node) {
							self(v, trail, self);
						}
					}
				};
				walk(doc, "", walk);
			}
		}

		// ==================================================== plugin configs ==

		bool IsConfigExtension(const std::string& extLower)
		{
			static constexpr std::string_view kExts[] = {
				".ini", ".json", ".jsonc", ".toml", ".yaml", ".yml", ".cfg", ".conf",
			};
			for (const auto e : kExts) {
				if (extLower == e) {
					return true;
				}
			}
			return false;
		}

		// Directories that never hold a live binding. Skipping them is the
		// difference between reading a few hundred files and reading thousands.
		bool SkipDirectory(const std::string& nameLower)
		{
			static constexpr std::string_view kSkip[] = {
				"translations", "translation", "language", "lang", "presets", "preset",
				"backup", "backups", "logs", "log", "docs", "documentation", "cache",
				"screenshots", "examples", "example", "samples", "sample", "themes",
				"fonts", "textures", "meshes",
				// Ours: the deck reports its own keys through the `deck` source,
				// and Chord Keys through `chord` -- reading their files here would
				// double-report every one of them as a second, nameless owner.
				"hotkeydeck", "chordkeys",
			};
			for (const auto s : kSkip) {
				if (nameLower == s) {
					return true;
				}
			}
			return false;
		}

		bool SkipFile(const std::string& stemLower, const std::string& nameLower)
		{
			// Handled by their own scanner above; reading them again here would
			// report each overlay twice, once with an assumed code space.
			if (stemLower == "communityshaders") {
				return true;
			}
			static constexpr std::string_view kMarks[] = {
				"default", "example", "sample", "template", "backup", "readme",
			};
			for (const auto m : kMarks) {
				if (Has(stemLower, m)) {
					return true;
				}
			}
			return nameLower == "keys-cache.json";
		}

		// Which mod does this config belong to? The folder wins over the file
		// name when there is one, because "Data/SKSE/Plugins/<Mod>/settings.ini"
		// names the mod in the folder and says nothing in the file.
		std::string OwnerFor(const fs::path& file, const fs::path& root)
		{
			static constexpr std::string_view kGeneric[] = {
				"config", "configs", "settings", "setting", "data", "ini", "json",
				"user", "userconfig", "usersettings",
			};
			const auto isGeneric = [](const std::string& s) {
				for (const auto g : kGeneric) {
					if (s == g) {
						return true;
					}
				}
				return false;
			};

			const auto stem = PathU8(file.stem());
			std::error_code ec;
			const auto rel = fs::relative(file, root, ec);
			std::string folder;
			if (!ec) {
				const auto parent = rel.parent_path();
				if (!parent.empty()) {
					folder = PathU8(*parent.begin());  // first component under the root
				}
			}
			if (!folder.empty() && !isGeneric(Lower(folder))) {
				return folder;
			}
			if (!isGeneric(Lower(stem))) {
				return stem;
			}
			return folder.empty() ? stem : folder;
		}

		// A file's own documentation, read once: "DXScanCode", "DIK key code",
		// the CK Input_Script link. See DocumentedSpace.
		SpaceCall FileLevelSpace(const std::string& text)
		{
			SpaceCall call;
			if (Space s = Space::Dik; DocumentedSpace(text, s)) {
				call.space = s;
				call.certain = true;
			}
			return call;
		}

		void ScanIniLike(const fs::path& path, const std::string& owner, Sink& sink)
		{
			const auto fileName = Lower(PathU8(path.filename()));
			const auto text = ReadTextCapped(path, kMaxFileBytes);
			const auto fileLevel = FileLevelSpace(text);
			for (const auto& a : ParseAssignments(text)) {
				if (!IsKeyField(a.name)) {
					continue;
				}
				long value = 0;
				if (!ParseInt(a.value, value)) {
					continue;
				}
				const auto call = SpaceFor(a.name, fileName, fileLevel);
				const auto code = CodeFrom(value, call, a.name);
				if (!code) {
					continue;
				}
				const auto label = a.section.empty()
					? Prettify(a.name)
					: Prettify(a.name) + " (" + Prettify(a.section) + ")";
				sink.Add(Row{ "plugin", owner, label, code, "", !call.certain,
					PathU8(path) + " · " + a.name + " = " + a.value });
			}
		}

		void ScanJsonLike(const fs::path& path, const std::string& owner, Sink& sink)
		{
			const auto text = ReadTextCapped(path, kMaxFileBytes);
			if (text.empty()) {
				return;
			}
			const auto doc = json::parse(text, nullptr, false, true);  // comments allowed
			if (doc.is_discarded()) {
				return;  // not our file to fix
			}
			const auto fileName = Lower(PathU8(path.filename()));
			const auto fileLevel = FileLevelSpace(text);

			const auto walk = [&](const json& node, const std::string& trail, const auto& self) -> void {
				if (node.is_object()) {
					for (const auto& [name, value] : node.items()) {
						const json& val = value;  // see the note in ScanCommunityShaders
						const auto  label = trail.empty() ? name : trail + " · " + name;
						if (IsKeyField(name)) {
							long v = 0;
							bool have = false;
							if (val.is_number_integer()) {
								v = val.get<long>();
								have = true;
							} else if (val.is_string()) {
								have = ParseInt(val.get<std::string>(), v);
							} else if (val.is_array() && !val.empty() && val[0].is_number_integer()) {
								// [key, modifier...] or a list of binds. Only the
								// first entry is claimed: guessing which of the
								// rest are modifiers and which are keys would put
								// invented rows in a conflict list.
								v = val[0].get<long>();
								have = true;
							}
							if (have) {
								const auto call = SpaceFor(name, fileName, fileLevel);
								if (const auto code = CodeFrom(v, call, name)) {
									// The leaf names the action; the full trail is
									// provenance, so it belongs in the detail line
									// rather than in a row label nobody can read.
									sink.Add(Row{ "plugin", owner, Prettify(name), code, "",
										!call.certain,
										PathU8(path) + " · " + label + " = " + std::to_string(v) });
								}
							}
						}
						self(value, label, self);
					}
				} else if (node.is_array()) {
					for (const auto& v : node) {
						self(v, trail, self);
					}
				}
			};
			walk(doc, "", walk);
		}

		void WalkPluginDir(const fs::path& dir, const fs::path& root, int depth, int& files, Sink& sink)
		{
			if (depth > kMaxDepth || files >= kMaxFiles) {
				return;
			}
			std::error_code ec;
			for (const auto& entry : fs::directory_iterator(dir,
					 fs::directory_options::skip_permission_denied, ec)) {
				if (files >= kMaxFiles) {
					return;
				}
				std::error_code sub;
				if (entry.is_directory(sub)) {
					if (!SkipDirectory(Lower(PathU8(entry.path().filename())))) {
						WalkPluginDir(entry.path(), root, depth + 1, files, sink);
					}
					continue;
				}
				if (!entry.is_regular_file(sub)) {
					continue;
				}
				const auto ext = Lower(PathU8(entry.path().extension()));
				if (!IsConfigExtension(ext)) {
					continue;
				}
				const auto name = Lower(PathU8(entry.path().filename()));
				if (SkipFile(Lower(PathU8(entry.path().stem())), name)) {
					continue;
				}
				const auto size = entry.file_size(sub);
				if (!sub && size > kMaxFileBytes) {
					continue;  // a megabyte of config is data, not bindings
				}
				++files;
				const auto owner = OwnerFor(entry.path(), root);
				if (ext == ".json" || ext == ".jsonc") {
					ScanJsonLike(entry.path(), owner, sink);
				} else {
					ScanIniLike(entry.path(), owner, sink);
				}
			}
		}
	}

	// ------------------------------------------------------------- public ----

	std::vector<Row> ScanOverlays()
	{
		Sink sink;
		try {
			ScanEnb(sink);
			ScanReShade(sink);
			ScanCommunityShaders(sink);
		} catch (const std::exception& e) {
			logger::warn("keys-scan: overlay sweep aborted: {}", e.what());
		}
		return std::move(sink.out);
	}

	std::vector<Row> ScanPluginConfigs()
	{
		Sink sink;
		int  files = 0;
		try {
			const fs::path root("Data/SKSE/Plugins");
			std::error_code ec;
			if (fs::exists(root, ec)) {
				WalkPluginDir(root, root, 0, files, sink);
			}
		} catch (const std::exception& e) {
			logger::warn("keys-scan: plugin config sweep aborted: {}", e.what());
		}
		if (sink.capped) {
			logger::warn("keys-scan: plugin config sweep hit the {}-row cap -- "
						 "later bindings were NOT read", kMaxRows);
		}
		if (files >= kMaxFiles) {
			logger::warn("keys-scan: plugin config sweep hit the {}-file cap -- "
						 "part of Data/SKSE/Plugins was NOT read", kMaxFiles);
		}
		logger::info("keys-scan: file sources -- {} plugin config row(s) from {} file(s)",
			sink.out.size(), files);
		return std::move(sink.out);
	}
}
