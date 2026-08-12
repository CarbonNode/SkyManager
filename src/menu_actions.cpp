#include "menu_actions.h"

// pch (force-included) pulls in RE::/SKSE::/logger and, via RE/Skyrim.h,
// <Windows.h> — the same source of INPUT/SendInput/KEYEVENTF that main.cpp uses.

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

namespace MenuActions
{
	namespace
	{
		// --------------------------------------------------- input synthesis
		// Byte-identical to main.cpp's SendScan: DIK scancode, high codes are
		// the extended set (End/Home/… and the F13+ range).
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

		void Tap(std::uint32_t dik, std::uint32_t combo)
		{
			using namespace std::chrono;
			if (combo) {
				SendScan(combo, true);
				std::this_thread::sleep_for(milliseconds(15));
			}
			SendScan(dik, true);
			std::this_thread::sleep_for(milliseconds(45));
			SendScan(dik, false);
			if (combo) {
				std::this_thread::sleep_for(milliseconds(15));
				SendScan(combo, false);
			}
		}

		// Hold every key but the last (the modifiers), tap the last, then release
		// the modifiers in reverse. keys.back() is the main key; anything before it
		// is a chord/combo. Byte-compatible with Tap() for the single-key case.
		void TapChord(const std::vector<std::uint32_t>& keys)
		{
			using namespace std::chrono;
			if (keys.empty())
				return;
			for (std::size_t i = 0; i + 1 < keys.size(); ++i) {
				SendScan(keys[i], true);
				std::this_thread::sleep_for(milliseconds(15));
			}
			SendScan(keys.back(), true);
			std::this_thread::sleep_for(milliseconds(45));
			SendScan(keys.back(), false);
			for (std::size_t i = keys.size() - 1; i-- > 0;) {
				std::this_thread::sleep_for(milliseconds(15));
				SendScan(keys[i], false);
			}
		}

		void Notify(const std::string& msg) { RE::DebugNotification(msg.c_str()); }

		// --------------------------------------------------- tiny ini reader
		// Reads a small text file relative to the game root; MO2's VFS resolves
		// the path to whichever mod owns it (same relative paths the mods
		// themselves use). Empty on failure.
		std::string ReadText(const char* path)
		{
			std::ifstream f(path, std::ios::binary);
			if (!f)
				return {};
			return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
		}

		std::string Trim(std::string s)
		{
			auto notspace = [](unsigned char c) { return !std::isspace(c); };
			s.erase(s.begin(), std::find_if(s.begin(), s.end(), notspace));
			s.erase(std::find_if(s.rbegin(), s.rend(), notspace).base(), s.end());
			return s;
		}

		// First "key = value" whose key matches (case-insensitive), ignoring
		// ';'/'#' comment lines. Value is trimmed; false if not found.
		bool IniGet(const std::string& text, const std::string& key, std::string& out)
		{
			std::string lkey = key;
			std::transform(lkey.begin(), lkey.end(), lkey.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			std::size_t pos = 0;
			while (pos < text.size()) {
				std::size_t eol = text.find('\n', pos);
				std::string line = Trim(text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos));
				pos = (eol == std::string::npos) ? text.size() : eol + 1;
				if (line.empty() || line[0] == ';' || line[0] == '#' || line[0] == '[')
					continue;
				auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				std::string k = Trim(line.substr(0, eq));
				std::transform(k.begin(), k.end(), k.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				if (k == lkey) {
					out = Trim(line.substr(eq + 1));
					return true;
				}
			}
			return false;
		}

		// Parse a "0x1D+0x37"-style list of DIK scancodes (as IED writes ToggleKeys)
		// into a vector. Each token is base-auto so 0x-prefixed hex and plain
		// decimal both work; zero/garbage tokens are dropped. Last token = main key.
		std::vector<std::uint32_t> ParseDikList(const std::string& s)
		{
			std::vector<std::uint32_t> out;
			std::size_t pos = 0;
			while (pos <= s.size()) {
				std::size_t plus = s.find('+', pos);
				std::string tok = Trim(s.substr(pos, plus == std::string::npos ? std::string::npos : plus - pos));
				if (!tok.empty()) {
					try {
						unsigned long v = std::stoul(tok, nullptr, 0);
						if (v)
							out.push_back(static_cast<std::uint32_t>(v));
					} catch (...) {}
				}
				if (plus == std::string::npos)
					break;
				pos = plus + 1;
			}
			return out;
		}

		// Loose scan for the first integer value of a JSON field, e.g. the
		// "ToggleKey": 207 that Community Shaders writes into CommunityShaders.json.
		// Dependency-free on purpose (this file has no json include). Only accepts a
		// plausible single-byte scancode; 0 means "not found / not plausible".
		std::uint32_t JsonFindDik(const std::string& js, const std::string& field)
		{
			const std::string needle = "\"" + field + "\"";
			std::size_t p = js.find(needle);
			if (p == std::string::npos)
				return 0;
			p = js.find(':', p + needle.size());
			if (p == std::string::npos)
				return 0;
			++p;
			while (p < js.size() && (js[p] == ' ' || js[p] == '\t'))
				++p;
			std::size_t start = p;
			auto ishex = [](char c) {
				return std::isdigit(static_cast<unsigned char>(c)) || c == 'x' || c == 'X' ||
				       (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
			};
			while (p < js.size() && ishex(js[p]))
				++p;
			if (p == start)
				return 0;
			try {
				unsigned long v = std::stoul(js.substr(start, p - start), nullptr, 0);
				if (v >= 1 && v <= 0xFF)
					return static_cast<std::uint32_t>(v);
			} catch (...) {}
			return 0;
		}

		// Curated key-NAME -> DIK map for SKSE Menu Framework's ToggleKey (it
		// stores a name, not a code). Covers the plausible rebinds; anything
		// unknown returns 0 so the caller can fall back to its default.
		std::uint32_t KeyNameToDik(std::string name)
		{
			std::transform(name.begin(), name.end(), name.begin(),
				[](unsigned char c) { return static_cast<char>(std::toupper(c)); });
			name = Trim(name);
			// Function keys
			static const std::pair<const char*, std::uint32_t> kMap[] = {
				{ "F1", 0x3B }, { "F2", 0x3C }, { "F3", 0x3D }, { "F4", 0x3E },
				{ "F5", 0x3F }, { "F6", 0x40 }, { "F7", 0x41 }, { "F8", 0x42 },
				{ "F9", 0x43 }, { "F10", 0x44 }, { "F11", 0x57 }, { "F12", 0x58 },
				{ "A", 0x1E }, { "B", 0x30 }, { "C", 0x2E }, { "D", 0x20 }, { "E", 0x12 },
				{ "F", 0x21 }, { "G", 0x22 }, { "H", 0x23 }, { "I", 0x17 }, { "J", 0x24 },
				{ "K", 0x25 }, { "L", 0x26 }, { "M", 0x32 }, { "N", 0x31 }, { "O", 0x18 },
				{ "P", 0x19 }, { "Q", 0x10 }, { "R", 0x13 }, { "S", 0x1F }, { "T", 0x14 },
				{ "U", 0x16 }, { "V", 0x2F }, { "W", 0x11 }, { "X", 0x2D }, { "Y", 0x15 },
				{ "Z", 0x2C },
				{ "0", 0x0B }, { "1", 0x02 }, { "2", 0x03 }, { "3", 0x04 }, { "4", 0x05 },
				{ "5", 0x06 }, { "6", 0x07 }, { "7", 0x08 }, { "8", 0x09 }, { "9", 0x0A },
				{ "END", 0xCF }, { "HOME", 0xC7 }, { "INSERT", 0xD2 }, { "DELETE", 0xD3 },
				{ "PAGEUP", 0xC9 }, { "PRIOR", 0xC9 }, { "PAGEDOWN", 0xD1 }, { "NEXT", 0xD1 },
				{ "TAB", 0x0F }, { "CAPSLOCK", 0x3A }, { "GRAVE", 0x29 }, { "TILDE", 0x29 },
				{ "BACKSLASH", 0x2B }, { "LEFTBRACKET", 0x1A }, { "RIGHTBRACKET", 0x1B },
				{ "SEMICOLON", 0x27 }, { "APOSTROPHE", 0x28 }, { "COMMA", 0x33 },
				{ "PERIOD", 0x34 }, { "SLASH", 0x35 }, { "MINUS", 0x0C }, { "EQUALS", 0x0D },
			};
			for (const auto& [n, dik] : kMap)
				if (name == n)
					return dik;
			return 0;
		}

		// --------------------------------------------------- per-menu openers

		// Prisma MCM Redux — synthesize the DIK its input handler listens for.
		// PrismaCore.ini stores raw DIK ints, so no name mapping is needed.
		void OpenPrismaMcm()
		{
			std::uint32_t key = 0x2B, combo = 0;  // default '\'
			const std::string ini = ReadText("Data/PrismaMCMRedux/PrismaCore.ini");
			std::string v;
			if (!ini.empty()) {
				if (IniGet(ini, "Hotkey", v)) { try { key = static_cast<std::uint32_t>(std::stoul(v)); } catch (...) {} }
				if (IniGet(ini, "ComboKey", v)) { try { combo = static_cast<std::uint32_t>(std::stoul(v)); } catch (...) {} }
			}
			if (key == 0) {
				Notify("Prisma MCM has no open key set (PrismaCore.ini Hotkey = 0).");
				return;
			}
			logger::info("menu-open: prisma-mcm scan {:#x} combo {:#x}", key, combo);
			std::thread([key, combo]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(90));
				Tap(key, combo);
			}).detach();
		}

		// SKSE Menu Framework — read ToggleKey (a NAME) + ToggleMode from its ini
		// and synthesize exactly that. Default F1 / DoublePress. Hold mode can't be
		// latched open by a momentary tap, so it degrades to a single tap.
		void OpenSmf()
		{
			std::uint32_t key = 0x3B;  // F1
			int taps = 2;              // DoublePress
			const std::string ini = ReadText("Data/SKSE/Plugins/SKSEMenuFramework.ini");
			std::string v;
			if (!ini.empty()) {
				if (IniGet(ini, "ToggleKey", v)) {
					auto dik = KeyNameToDik(v);
					if (dik)
						key = dik;
					else {
						// Refuse rather than press F1: the user REBOUND the key, and
						// F1 is whatever their setup makes of F1 — a wrong keypress
						// is worse than an honest sentence (2026-08-12 audit).
						logger::warn("menu-open: smf ToggleKey '{}' unmapped — refusing", v);
						Notify("SKSE Menu Framework uses a key this deck can't name — open it with its own key, or rebind it to a standard one.");
						return;
					}
				}
				if (IniGet(ini, "ToggleMode", v)) {
					std::string m = v;
					std::transform(m.begin(), m.end(), m.begin(),
						[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
					if (m == "singlepress" || m == "hold")
						taps = 1;
					else if (m == "off") {
						Notify("SKSE Menu Framework's toggle key is turned OFF in its ini.");
						return;
					} else
						taps = 2;  // doublepress (default)
				}
			}
			logger::info("menu-open: smf scan {:#x} x{}", key, taps);
			std::thread([key, taps]() {
				using namespace std::chrono;
				std::this_thread::sleep_for(milliseconds(90));
				Tap(key, 0);
				if (taps >= 2) {
					std::this_thread::sleep_for(milliseconds(140));
					Tap(key, 0);
				}
			}).detach();
		}

		// Community Shaders — its menu toggle key is saved into CommunityShaders.json
		// once you open the CS menu and rebind it; until then CS uses its built-in
		// default (End). Read that file when present so a rebind is honored, and fall
		// back to End when there is no config yet — no longer a bare hardcoded default.
		// NOTE: CS is a not-yet-installed trial on this rig, so no config exists to
		// confirm the field name/type against. When CS stores a VK code rather than a
		// DIK scancode this synthesis would be off; JsonFindDik stays conservative
		// (plausible single-byte only) and this path is inert until a file exists.
		void OpenCommunityShaders()
		{
			std::uint32_t key = 0xCF;  // End — CS default
			bool fromCfg = false;
			const std::string js = ReadText("Data/SKSE/Plugins/CommunityShaders.json");
			if (!js.empty()) {
				std::uint32_t k = JsonFindDik(js, "ToggleKey");
				if (k) {
					key = k;
					fromCfg = true;
				}
			}
			logger::info("menu-open: community-shaders scan {:#x} ({})",
				key, fromCfg ? "from CommunityShaders.json" : "default End");
			std::thread([key]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(90));
				Tap(key, 0);
			}).detach();
		}

		// Immersive Equipment Displays — its UI open key lives in
		// ImmersiveEquipmentDisplays.ini as ToggleKeys (hex DIK, '+'-joined for a
		// chord) with OverrideToggleKeys deciding whether the ini value or a key set
		// in IED's own UI wins. Read it live so an ini rebind is honored. When
		// OverrideToggleKeys is false the UI-set key is authoritative and is NOT
		// stored where we can read it, so we fall back to the ini value and log it.
		void OpenIed()
		{
			std::vector<std::uint32_t> keys;
			bool override_ = true;
			const std::string ini = ReadText("Data/SKSE/Plugins/ImmersiveEquipmentDisplays.ini");
			std::string v;
			if (!ini.empty()) {
				if (IniGet(ini, "OverrideToggleKeys", v)) {
					std::string lv = v;
					std::transform(lv.begin(), lv.end(), lv.begin(),
						[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
					override_ = (lv == "true" || lv == "1");
				}
				if (IniGet(ini, "ToggleKeys", v))
					keys = ParseDikList(v);
			}
			if (keys.empty()) {
				keys = { 0x37 };  // Numpad * — IED's shipped default
				if (ini.empty())
					Notify("IED config not found - opening with the default Num * key.");
			}
			if (!override_)
				logger::warn("menu-open: IED OverrideToggleKeys=false - a key set in IED's own UI may differ from the ini; using the ini ToggleKeys");
			std::string keystr;
			for (auto k : keys) {
				char b[12];
				std::snprintf(b, sizeof b, "%#x ", k);
				keystr += b;
			}
			logger::info("menu-open: ied scan {}", keystr);
			std::thread([keys]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(90));
				TapChord(keys);
			}).detach();
		}
	}

	bool IsAction(const std::string& a)
	{
		return a == "open-prisma-mcm" || a == "open-smf" ||
		       a == "open-community-shaders" || a == "open-ied";
	}

	void Fire(const std::string& a)
	{
		if (a == "open-prisma-mcm")
			OpenPrismaMcm();
		else if (a == "open-smf")
			OpenSmf();
		else if (a == "open-community-shaders")
			OpenCommunityShaders();
		else if (a == "open-ied")
			OpenIed();
	}
}
