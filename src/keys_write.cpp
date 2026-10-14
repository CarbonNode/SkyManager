// Keys tab writer. See keys_write.h for the contract and keys_sources.h
// (WRITING) for which rows may be written at all.
//
// Threading: Rebind() returns at once. Everything that touches the disk runs
// on a detached worker (the threading law: pure file IO never on the main
// thread). The mod's own live re-read -- a Papyrus dispatch for Walk With Me,
// a synthesized key for PPA -- and the reply to the view run afterwards in an
// SKSE task on the main thread. The worker never waits on that task.

#include "keys_write.h"

#include "formation_wwm.h"
#include "keys_scan.h"
#include "keys_sources.h"
#include "ppa_config.h"
#include "pch.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <format>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace KeysWrite
{
	namespace
	{
		constexpr std::size_t kMaxFileBytes = 1u << 20;  // the census reads no bigger file

		// One rebind at a time: read, check, write, re-read is one unit.
		std::mutex g_writeLock;

		// Files backed up this session (keyed as the census spells them).
		std::mutex                      g_backupLock;
		std::unordered_set<std::string> g_backedUp;

		// ------------------------------------------------------------ text --

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		bool IsWs(char c)
		{
			return c == ' ' || c == '\t' || c == '\r' || c == '\n';
		}

		// keys_sources.cpp's Trim, byte for byte: whitespace off both ends, then
		// one pair of matching quotes. The line finder below must read a line
		// exactly the way the census did, or a field could name another line.
		std::string ScanTrim(std::string_view s)
		{
			std::size_t b = 0, e = s.size();
			while (b < e && IsWs(s[b])) {
				++b;
			}
			while (e > b && IsWs(s[e - 1])) {
				--e;
			}
			auto out = std::string(s.substr(b, e - b));
			if (out.size() >= 2 && ((out.front() == '"' && out.back() == '"') ||
									   (out.front() == '\'' && out.back() == '\''))) {
				out = out.substr(1, out.size() - 2);
			}
			return out;
		}

		std::string WsTrim(std::string_view s)
		{
			std::size_t b = 0, e = s.size();
			while (b < e && IsWs(s[b])) {
				++b;
			}
			while (e > b && IsWs(s[e - 1])) {
				--e;
			}
			return std::string(s.substr(b, e - b));
		}

		// keys_sources.cpp's StripInlineComment: ';', '#' or "//" from the
		// SECOND character on. Returns the cut position.
		std::size_t CommentCut(std::string_view v)
		{
			for (std::size_t i = 1; i < v.size(); ++i) {
				if (v[i] == ';' || v[i] == '#') {
					return i;
				}
				if (v[i] == '/' && i + 1 < v.size() && v[i + 1] == '/') {
					return i;
				}
			}
			return v.size();
		}

		fs::path PathFromU8(const std::string& s)
		{
			return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
		}

		// --------------------------------------------------------- numbers --
		// A value's spelling, so the new number is written the way the file
		// already writes it: quotes kept, 0x hex kept (with its case).

		struct Spelling
		{
			char        quote = 0;   // '"' or '\'' when the token was quoted
			std::string hexPrefix;   // "0x" / "0X" when it was hex
			bool        upper = false;
		};

		bool ReadNumber(const std::string& token, Spelling& sp, long& out)
		{
			std::string s = token;
			if (s.size() >= 2 && (s.front() == '"' || s.front() == '\'') && s.back() == s.front()) {
				sp.quote = s.front();
				s = s.substr(1, s.size() - 2);
			}
			s = WsTrim(s);
			if (s.empty()) {
				return false;
			}
			std::size_t i = 0;
			long        sign = 1;
			if (s[0] == '-' || s[0] == '+') {
				sign = s[0] == '-' ? -1 : 1;
				++i;
			}
			int base = 10;
			if (i + 1 < s.size() && s[i] == '0' && (s[i + 1] == 'x' || s[i + 1] == 'X')) {
				base = 16;
				sp.hexPrefix = s.substr(i, 2);
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
					if (std::isupper(c)) {
						sp.upper = true;
					}
				} else {
					return false;
				}
				value = value * base + digit;
				if (value > 1000000) {
					return false;
				}
			}
			out = sign * value;
			return true;
		}

		std::string Spell(const Spelling& sp, long v)
		{
			std::string body;
			if (!sp.hexPrefix.empty() && v >= 0) {
				body = sp.hexPrefix + (sp.upper ? std::format("{:X}", v) : std::format("{:x}", v));
			} else {
				body = std::to_string(v);
			}
			return sp.quote ? (std::string(1, sp.quote) + body + std::string(1, sp.quote)) : body;
		}

		// ----------------------------------------------------- ini / toml ----
		// Finds `name` in `[section]` the way keys_sources.cpp ParseAssignments
		// reads a file, and returns how many lines match. `b`/`e` bound the
		// value's token (quotes included) in the WHOLE text, so a write changes
		// those bytes and nothing else. A line the census read through its
		// whole-line quote stripping has no honest span: e = npos.
		int FindIniValue(const std::string& text, const std::string& sectionLower,
			const std::string& nameLower, std::size_t& b, std::size_t& e)
		{
			int         hits = 0;
			std::string section;
			std::size_t pos = 0;
			while (pos <= text.size()) {
				const auto nl = text.find('\n', pos);
				const auto end = nl == std::string::npos ? text.size() : nl;
				const std::string_view line(text.data() + pos, end - pos);
				const auto lineStart = pos;
				pos = end + 1;

				const auto trimmed = ScanTrim(line);
				if (!trimmed.empty() && !(trimmed[0] == ';' || trimmed[0] == '#' ||
											(trimmed.size() > 1 && trimmed[0] == '/' && trimmed[1] == '/'))) {
					if (trimmed.front() == '[' && trimmed.back() == ']') {
						section = Lower(trimmed.substr(1, trimmed.size() - 2));
					} else {
						auto sep = trimmed.find('=');
						if (sep == std::string::npos) {
							sep = trimmed.find(':');
						}
						if (sep != std::string::npos && sep != 0) {
							const auto name = ScanTrim(std::string_view(trimmed).substr(0, sep));
							const auto rest = std::string_view(trimmed).substr(sep + 1);
							const auto value = ScanTrim(rest.substr(0, CommentCut(rest)));
							if (!name.empty() && !value.empty() && section == sectionLower &&
								Lower(name) == nameLower) {
								++hits;
								b = e = std::string::npos;
								if (WsTrim(line) == trimmed) {
									// No whole-line quote stripping: the raw line's
									// first separator is the census's separator.
									auto rawSep = line.find('=');
									if (rawSep == std::string_view::npos) {
										rawSep = line.find(':');
									}
									const auto after = rawSep + 1;
									const auto v = line.substr(after);
									std::size_t tb = 0, te = CommentCut(v);
									while (tb < te && IsWs(v[tb])) {
										++tb;
									}
									while (te > tb && IsWs(v[te - 1])) {
										--te;
									}
									if (te > tb) {
										b = lineStart + after + tb;
										e = lineStart + after + te;
									}
								}
							}
						}
					}
				}
				if (nl == std::string::npos) {
					break;
				}
			}
			return hits;
		}

		bool SplitIniField(const std::string& field, std::string& sectionLower, std::string& nameLower)
		{
			const auto us = field.rfind('\x1f');
			if (us == std::string::npos) {
				return false;
			}
			sectionLower = Lower(field.substr(0, us));
			nameLower = Lower(field.substr(us + 1));
			return !nameLower.empty();
		}

		// --------------------------------------------------------------- json --
		// A tiny scanner over the TEXT (comments allowed, as the census parses)
		// that finds the token of the value at one JSON pointer. It never
		// rewrites anything itself; the caller replaces the token and then
		// proves the result with a full parse (VerifyJson).

		std::vector<std::string> PointerTokens(const std::string& ptr, bool& ok)
		{
			std::vector<std::string> out;
			ok = !ptr.empty() && ptr[0] == '/';
			if (!ok) {
				return out;
			}
			std::size_t pos = 1;
			while (true) {
				const auto slash = ptr.find('/', pos);
				const auto raw = ptr.substr(pos, slash == std::string::npos ? std::string::npos : slash - pos);
				std::string tok;
				for (std::size_t i = 0; i < raw.size(); ++i) {
					if (raw[i] == '~' && i + 1 < raw.size() && (raw[i + 1] == '0' || raw[i + 1] == '1')) {
						tok += raw[i + 1] == '0' ? '~' : '/';
						++i;
					} else {
						tok += raw[i];
					}
				}
				out.push_back(std::move(tok));
				if (slash == std::string::npos) {
					break;
				}
				pos = slash + 1;
			}
			return out;
		}

		class JsonFinder
		{
		public:
			JsonFinder(const std::string& text, const std::vector<std::string>& want) :
				_t(text), _want(want)
			{}

			// Number of values at the pointer (2+ = a duplicated key), or -1
			// when the text does not scan.
			int Run(std::size_t& b, std::size_t& e)
			{
				if (_t.size() >= 3 && _t.compare(0, 3, "\xEF\xBB\xBF") == 0) {
					_i = 3;  // a UTF-8 BOM, which the census's parser skips too
				}
				std::vector<std::string> path;
				if (!Value(path, 0)) {
					return -1;
				}
				Ws();
				if (_i != _t.size()) {
					return -1;
				}
				b = _b;
				e = _e;
				return _hits;
			}

		private:
			const std::string&              _t;
			const std::vector<std::string>& _want;
			std::size_t                     _i = 0;
			std::size_t                     _b = 0, _e = 0;
			int                             _hits = 0;

			void Ws()
			{
				while (_i < _t.size()) {
					const char c = _t[_i];
					if (IsWs(c)) {
						++_i;
					} else if (c == '/' && _i + 1 < _t.size() && _t[_i + 1] == '/') {
						while (_i < _t.size() && _t[_i] != '\n') {
							++_i;
						}
					} else if (c == '/' && _i + 1 < _t.size() && _t[_i + 1] == '*') {
						const auto close = _t.find("*/", _i + 2);
						_i = close == std::string::npos ? _t.size() : close + 2;
					} else {
						break;
					}
				}
			}

			// A string token starting at _i (on its quote). Decodes simple
			// escapes for key comparison; \u is decoded as one UTF-8 code point
			// (a surrogate pair would mismatch and simply never hit -- safe).
			bool String(std::string& out)
			{
				if (_i >= _t.size() || _t[_i] != '"') {
					return false;
				}
				++_i;
				while (_i < _t.size()) {
					const char c = _t[_i++];
					if (c == '"') {
						return true;
					}
					if (c != '\\') {
						out += c;
						continue;
					}
					if (_i >= _t.size()) {
						return false;
					}
					const char x = _t[_i++];
					switch (x) {
					case '"': out += '"'; break;
					case '\\': out += '\\'; break;
					case '/': out += '/'; break;
					case 'b': out += '\b'; break;
					case 'f': out += '\f'; break;
					case 'n': out += '\n'; break;
					case 'r': out += '\r'; break;
					case 't': out += '\t'; break;
					case 'u': {
						if (_i + 4 > _t.size()) {
							return false;
						}
						unsigned cp = 0;
						for (int k = 0; k < 4; ++k) {
							const auto h = static_cast<unsigned char>(_t[_i++]);
							if (!std::isxdigit(h)) {
								return false;
							}
							cp = cp * 16 + (std::isdigit(h) ? h - '0' : std::tolower(h) - 'a' + 10);
						}
						if (cp < 0x80) {
							out += static_cast<char>(cp);
						} else if (cp < 0x800) {
							out += static_cast<char>(0xC0 | (cp >> 6));
							out += static_cast<char>(0x80 | (cp & 0x3F));
						} else {
							out += static_cast<char>(0xE0 | (cp >> 12));
							out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
							out += static_cast<char>(0x80 | (cp & 0x3F));
						}
						break;
					}
					default: return false;
					}
				}
				return false;
			}

			void Hit(const std::vector<std::string>& path, std::size_t b, std::size_t e)
			{
				if (path == _want) {
					++_hits;
					_b = b;
					_e = e;
				}
			}

			bool Value(std::vector<std::string>& path, int depth)
			{
				if (depth > 64) {
					return false;
				}
				Ws();
				if (_i >= _t.size()) {
					return false;
				}
				const char c = _t[_i];
				if (c == '{') {
					++_i;
					Ws();
					if (_i < _t.size() && _t[_i] == '}') {
						++_i;
						return true;
					}
					while (true) {
						Ws();
						std::string key;
						if (!String(key)) {
							return false;
						}
						Ws();
						if (_i >= _t.size() || _t[_i] != ':') {
							return false;
						}
						++_i;
						path.push_back(std::move(key));
						if (!Value(path, depth + 1)) {
							return false;
						}
						path.pop_back();
						Ws();
						if (_i < _t.size() && _t[_i] == ',') {
							++_i;
							continue;
						}
						if (_i < _t.size() && _t[_i] == '}') {
							++_i;
							return true;
						}
						return false;
					}
				}
				if (c == '[') {
					++_i;
					Ws();
					if (_i < _t.size() && _t[_i] == ']') {
						++_i;
						return true;
					}
					std::size_t index = 0;
					while (true) {
						path.push_back(std::to_string(index++));
						if (!Value(path, depth + 1)) {
							return false;
						}
						path.pop_back();
						Ws();
						if (_i < _t.size() && _t[_i] == ',') {
							++_i;
							continue;
						}
						if (_i < _t.size() && _t[_i] == ']') {
							++_i;
							return true;
						}
						return false;
					}
				}
				const auto start = _i;
				if (c == '"') {
					std::string ignored;
					if (!String(ignored)) {
						return false;
					}
				} else {
					while (_i < _t.size()) {
						const auto x = static_cast<unsigned char>(_t[_i]);
						if (std::isalnum(x) || x == '-' || x == '+' || x == '.') {
							++_i;
						} else {
							break;
						}
					}
					if (_i == start) {
						return false;
					}
				}
				Hit(path, start, _i);
				return true;
			}
		};

		// --------------------------------------------------------- the edit --

		struct Edit
		{
			std::string field;  // as the census spells it
			long        value = 0;
		};

		// Replace one setting's token in `text`. On failure `why` says what.
		bool ApplyOne(std::string& text, const std::string& format, const Edit& ed, std::string& why)
		{
			std::size_t b = std::string::npos, e = std::string::npos;
			int         hits = 0;
			if (format == "ini") {
				std::string section, name;
				if (!SplitIniField(ed.field, section, name)) {
					why = "SkyManager lost track of which setting this is. Rescan and try again.";
					return false;
				}
				hits = FindIniValue(text, section, name, b, e);
			} else if (format == "json") {
				bool       ok = false;
				const auto tokens = PointerTokens(ed.field, ok);
				if (!ok) {
					why = "SkyManager lost track of which setting this is. Rescan and try again.";
					return false;
				}
				hits = JsonFinder(text, tokens).Run(b, e);
				if (hits < 0) {
					why = "The file no longer reads as JSON, so SkyManager will not touch it.";
					return false;
				}
			} else {
				why = "SkyManager does not write this kind of file.";
				return false;
			}
			if (hits != 1) {
				why = hits == 0 ? "The setting is no longer in the file. Rescan and try again."
				                : "The setting appears more than once in the file, so SkyManager will "
				                  "not guess which copy the mod reads.";
				return false;
			}
			if (b == std::string::npos || e == std::string::npos || e <= b) {
				why = "That line is written in a way SkyManager cannot edit safely.";
				return false;
			}
			Spelling   sp;
			long       old = 0;
			const auto token = text.substr(b, e - b);
			if (!ReadNumber(token, sp, old)) {
				why = "The setting does not hold a plain number any more. Rescan and try again.";
				return false;
			}
			text.replace(b, e - b, Spell(sp, ed.value));
			return true;
		}

		// Proof before a byte reaches the disk: every edited setting reads back
		// as its new value, and nothing else in the document moved.
		bool Verify(const std::string& before, const std::string& after, const std::string& format,
			const std::vector<Edit>& edits, std::string& why)
		{
			if (format == "ini") {
				for (const auto& ed : edits) {
					std::string section, name;
					std::size_t b = 0, e = 0;
					SplitIniField(ed.field, section, name);
					Spelling sp;
					long     v = 0;
					if (FindIniValue(after, section, name, b, e) != 1 || b == std::string::npos ||
						e == std::string::npos || !ReadNumber(after.substr(b, e - b), sp, v) || v != ed.value) {
						why = "The rewritten file did not read back as intended, so nothing was saved.";
						return false;
					}
				}
				return true;
			}
			try {
				const auto oldDoc = json::parse(before, nullptr, false, true);
				const auto newDoc = json::parse(after, nullptr, false, true);
				if (oldDoc.is_discarded() || newDoc.is_discarded()) {
					why = "The rewritten file would not parse as JSON, so nothing was saved.";
					return false;
				}
				json expect = oldDoc;
				for (const auto& ed : edits) {
					const json::json_pointer ptr(ed.field);
					const auto&              was = oldDoc.at(ptr);
					if (was.is_string()) {
						// The token kept its quotes; what it says is the number.
						expect[ptr] = newDoc.at(ptr).is_string() ? newDoc.at(ptr) : json(ed.value);
						long v = 0;
						Spelling sp;
						if (!newDoc.at(ptr).is_string() ||
							!ReadNumber(newDoc.at(ptr).get<std::string>(), sp, v) || v != ed.value) {
							why = "The rewritten file did not read back as intended, so nothing was saved.";
							return false;
						}
					} else {
						expect[ptr] = ed.value;
					}
				}
				if (expect != newDoc) {
					why = "The rewrite would have changed more than the key, so nothing was saved.";
					return false;
				}
				return true;
			} catch (const std::exception& ex) {
				why = std::string("The rewritten file could not be checked (") + ex.what() + "), so nothing was saved.";
				return false;
			}
		}

		bool ReadAll(const fs::path& p, std::string& out)
		{
			std::ifstream in(p, std::ios::binary);
			if (!in) {
				return false;
			}
			std::ostringstream ss;
			ss << in.rdbuf();
			out = ss.str();
			return true;
		}

		bool BackupOnce(const fs::path& p, const std::string& key, std::string& bakName)
		{
			auto bak = p;
			bak += ".skymanager-bak";
			bakName = PathU8(bak.filename());
			std::lock_guard l(g_backupLock);
			if (g_backedUp.count(key)) {
				return true;
			}
			std::error_code ec;
			fs::copy_file(p, bak, fs::copy_options::overwrite_existing, ec);
			if (ec) {
				logger::warn("keys-write: backup of {} failed: {}", key, ec.message());
				return false;
			}
			g_backedUp.insert(key);
			return true;
		}

		// ---------------------------------------------------------- the work --

		struct Result
		{
			json        out = json::object();
			std::string apply;      // the hook to run on the main thread when ok
			std::string mod;        // the owner's display name
			std::string fileName;   // "Wayfarer.ini"
		};

		// Takes `r` by reference ON PURPOSE: callers build `msg` out of r's own
		// fields, and a by-value parameter could be moved from before that
		// argument is evaluated (the order is unspecified).
		Result Fail(Result& r, const std::string& msg)
		{
			r.out["ok"] = false;
			r.out["msg"] = msg;
			logger::info("keys-write: refused -- {}", msg);
			return std::move(r);
		}

		std::uint32_t ModifierMask(const json& mods, bool& ok)
		{
			ok = true;
			std::uint32_t mask = 0;
			if (mods.is_null()) {
				return 0;
			}
			if (!mods.is_array()) {
				ok = false;
				return 0;
			}
			for (const auto& m : mods) {
				const auto s = m.is_string() ? m.get<std::string>() : std::string();
				if (s == "Shift") {
					mask |= 1;
				} else if (s == "Ctrl") {
					mask |= 2;
				} else if (s == "Alt") {
					mask |= 4;
				} else {
					ok = false;
				}
			}
			return mask;
		}

		Result Work(const std::string& request)
		{
			Result r;
			const auto req = json::parse(request, nullptr, false);
			if (req.is_discarded() || !req.is_object()) {
				return Fail(r, "SkyManager could not read the rebind request.");
			}
			const auto file = req.value("file", std::string());
			const auto field = req.value("field", std::string());
			const auto stamp = req.value("stamp", std::string());
			const bool clear = req.value("clear", false);
			r.out["file"] = file;
			r.out["field"] = field;
			r.out["cleared"] = clear;
			if (file.empty() || field.empty() || stamp.empty() || file.size() > 1024) {
				return Fail(r, "SkyManager could not read the rebind request.");
			}

			// The path comes off the wire: it must be a relative path under
			// Data/SKSE/Plugins with no climbing. ScanFile re-checks the rest
			// (extension, skipped folders, depth) by the census's own rules.
			const auto path = PathFromU8(file);
			{
				if (path.is_absolute() || path.has_root_name() || path.has_root_directory()) {
					return Fail(r, "That file is not a mod config SkyManager may write.");
				}
				static constexpr std::string_view kRoot[] = { "data", "skse", "plugins" };
				std::size_t i = 0;
				for (const auto& part : path) {
					const auto lower = Lower(PathU8(part));
					if (lower == ".." || lower == ".") {
						return Fail(r, "That file is not a mod config SkyManager may write.");
					}
					if (i < std::size(kRoot) && lower != kRoot[i]) {
						return Fail(r, "That file is not a mod config SkyManager may write.");
					}
					++i;
				}
				if (i <= std::size(kRoot)) {
					return Fail(r, "That file is not a mod config SkyManager may write.");
				}
			}
			r.fileName = PathU8(path.filename());

			std::lock_guard lock(g_writeLock);

			// Re-derive the row from the file as it is NOW. Nothing about what
			// may be written, or how, is taken from the request.
			auto rows = KeysSources::ScanFile(path);
			const KeysSources::Row* row = nullptr;
			for (const auto& candidate : rows) {
				if (candidate.write.file == file && candidate.write.field == field) {
					row = &candidate;
					break;
				}
			}
			if (!row) {
				KeysScan::ReplaceFileRows(file, std::move(rows));
				return Fail(r, "That setting is no longer in " + r.fileName + ". The row has been re-read.");
			}
			r.mod = row->mod;
			r.out["mod"] = row->mod;
			r.out["control"] = row->control;
			const auto w = row->write;
			if (!w.ok) {
				return Fail(r, w.why.empty() ? std::string("SkyManager may not write this setting.") : w.why);
			}

			std::string before;
			if (!ReadAll(path, before)) {
				return Fail(r, r.fileName + " could not be read.");
			}
			if (before.size() > kMaxFileBytes) {
				return Fail(r, r.fileName + " is too large for SkyManager to edit.");
			}
			if (KeysSources::Stamp(before) != stamp || w.stamp != stamp) {
				KeysScan::ReplaceFileRows(file, std::move(rows));
				return Fail(r, r.fileName + " changed on disk after the census read it (its own menu "
					"may have saved it). The row has been re-read: check it and try again.");
			}

			// What to write. Every value is re-derived from the row's spec.
			std::vector<Edit> edits;
			std::uint32_t     code = 0;
			std::uint32_t     mask = 0;
			if (clear) {
				if (w.clearValue.empty()) {
					return Fail(r, "This file never says how it spells \"no key\", so SkyManager "
						"cannot clear it. Bind another key instead.");
				}
				long none = 0;
				Spelling ignored;
				if (!ReadNumber(w.clearValue, ignored, none)) {
					return Fail(r, "SkyManager may not clear this setting.");
				}
				edits.push_back(Edit{ w.field, none });
				if (!w.modField.empty()) {
					edits.push_back(Edit{ w.modField, 0 });
				}
			} else {
				const auto c = req.contains("code") && req["code"].is_number_integer() ? req["code"].get<long>() : 0L;
				if (c < 1 || c > 0xFF) {
					return Fail(r, "Only keyboard keys can be bound here.");
				}
				code = static_cast<std::uint32_t>(c);
				bool modsOk = true;
				mask = ModifierMask(req.contains("mods") ? req["mods"] : json(), modsOk);
				if (!modsOk) {
					return Fail(r, "SkyManager could not read the modifier keys.");
				}
				long modValue = -1;  // -1 = leave the modifier setting alone
				if (w.modKind == "mask") {
					modValue = static_cast<long>(mask);
				} else if (w.modKind == "cm-enum") {
					// Custom Markers' modifier is an ENUM (custom_markers_bindings.h):
					// one modifier at most, and a modifier key is never its key.
					static constexpr std::uint32_t kModifierScans[] = { 0x1D, 0x9D, 0x2A, 0x36, 0x38, 0xB8 };
					if (std::find(std::begin(kModifierScans), std::end(kModifierScans), code) != std::end(kModifierScans)) {
						return Fail(r, "Custom Markers cannot use Shift, Ctrl or Alt as the key itself.");
					}
					if (mask != 0 && mask != 1 && mask != 2 && mask != 4) {
						return Fail(r, "Custom Markers takes one modifier at most (Shift, Ctrl or Alt).");
					}
					modValue = mask == 4 ? 1 : mask == 2 ? 2 : mask == 1 ? 3 : 0;  // Alt 1, Ctrl 2, Shift 3
				} else if (mask != 0) {
					return Fail(r, r.mod + " has no modifier setting SkyManager knows, so the key "
						"must be pressed on its own here.");
				}
				if (modValue >= 0 && w.modField.empty()) {
					if (modValue != 0) {
						return Fail(r, r.fileName + " has no modifier line for this key, so it "
							"can only be bound on its own.");
					}
					modValue = -1;
				}
				edits.push_back(Edit{ w.field, static_cast<long>(code) });
				if (modValue >= 0) {
					edits.push_back(Edit{ w.modField, modValue });
				}
			}

			std::string after = before;
			for (const auto& ed : edits) {
				std::string why;
				if (!ApplyOne(after, w.format, ed, why)) {
					return Fail(r, why);
				}
			}
			{
				std::string why;
				if (!Verify(before, after, w.format, edits, why)) {
					return Fail(r, why);
				}
			}

			if (after != before) {
				std::string bak;
				if (!BackupOnce(path, file, bak)) {
					return Fail(r, "SkyManager could not back up " + r.fileName +
						" first, so it did not change it.");
				}
				// In place, not temp-and-rename: the file lives in a mod folder
				// behind MO2's VFS (formation_wwm.cpp, Ini::Save).
				{
					std::ofstream out(path, std::ios::binary | std::ios::trunc);
					if (!out.is_open()) {
						return Fail(r, r.fileName + " could not be opened for writing (read-only?).");
					}
					out.write(after.data(), static_cast<std::streamsize>(after.size()));
					out.flush();
					if (!out.good()) {
						return Fail(r, "Writing " + r.fileName + " failed part-way. The backup is " + bak + ".");
					}
				}
				std::string check;
				if (!ReadAll(path, check) || check != after) {
					return Fail(r, r.fileName + " did not read back as written. The backup is " + bak + ".");
				}
				logger::info("keys-write: {} [{}] -> key {} mods {} (cleared {}, backup {})", file,
					KeysScan::Utf8Text(field), clear ? std::string("none") : std::to_string(code), mask, clear, bak);
			}

			KeysScan::ReplaceFileRows(file, KeysSources::ScanFile(path));
			r.apply = after == before ? std::string() : w.apply;
			r.out["unchanged"] = after == before;
			r.out["ok"] = true;
			r.out["code"] = code;
			r.out["apply"] = w.apply;
			json mods = json::array();
			if (mask & 1) mods.push_back("Shift");
			if (mask & 2) mods.push_back("Ctrl");
			if (mask & 4) mods.push_back("Alt");
			r.out["mods"] = std::move(mods);
			return r;
		}

		// MAIN THREAD: the mod's own re-read, then the sentence that says
		// exactly what happened -- never more than that.
		std::string Finish(Result& r)
		{
			if (!r.out.value("ok", false)) {
				return r.out.dump(-1, ' ', false, json::error_handler_t::replace);
			}
			bool        applied = false;
			std::string msg = "Saved to " + r.fileName + ". ";
			if (r.out.value("unchanged", false)) {
				r.out["applied"] = false;
				r.out["msg"] = r.fileName + " already says that, so nothing was changed.";
				return r.out.dump(-1, ' ', false, json::error_handler_t::replace);
			}
			if (r.apply == "wwm-reload") {
				applied = FormationWwm::ReloadSettings();
				msg += applied
					? "Walk With Me was asked to re-read it (its own ReloadSettings). Papyrus waits while the deck "
					  "is open, so that happens when you close the deck."
					: "Walk With Me could not be asked to reload, so the new key takes effect next launch. If you "
					  "change keys in its own menu before then, it may write its old key back.";
			} else if (r.apply == "ppa-reload") {
				const auto key = PpaConfig::ReloadNow();
				applied = !key.empty();
				msg += applied
					? "Tapped PPA's own reload key (" + key + ") so it re-reads the file. That tap is not "
					  "play-tested with the deck open: if the old key still answers, it applies next launch."
					: "PPA's reload key could not be pressed, so the new key takes effect next launch.";
			} else if (r.apply == "cm-next-launch") {
				msg += "Custom Markers has no reload SkyManager can trigger, so the new key takes effect next "
				       "launch. Until then SkyManager's own Custom Markers buttons press the NEW key, which "
				       "Custom Markers is not listening for yet. If you change keys in its own menu first, it "
				       "may write its old key back.";
			} else if (r.apply == "ppa-self") {
				// PPA's own Reload key was the one rebound: pressing it now would
				// press the NEW key, which PPA does not listen for until it reloads.
				msg += "PPA learns a new reload key only when it reloads, so SkyManager did not press it. "
				       "It takes effect next launch, or after one press of PPA's old reload key.";
			} else {
				msg += (r.mod.empty() ? std::string("This mod") : r.mod) +
					" has no reload SkyManager can trigger, so the new key takes effect next launch. If you "
					"change keys in its own menu before then, it may write its old key back.";
			}
			r.out["applied"] = applied;
			r.out["msg"] = msg;
			return r.out.dump(-1, ' ', false, json::error_handler_t::replace);
		}
	}

	void Rebind(std::string request, std::function<void(std::string)> done)
	{
		std::thread([request = std::move(request), done = std::move(done)]() mutable {
			Result r;
			try {
				r = Work(request);
			} catch (const std::exception& e) {
				Result failed;
				r = Fail(failed, std::string("The rebind failed: ") + e.what());
			} catch (...) {
				Result failed;
				r = Fail(failed, "The rebind failed.");
			}
			auto* tasks = SKSE::GetTaskInterface();
			if (!tasks) {
				return;
			}
			tasks->AddTask([r = std::move(r), done = std::move(done)]() mutable {
				std::string payload;
				try {
					payload = Finish(r);
				} catch (const std::exception& e) {
					logger::error("keys-write: finishing failed: {}", e.what());
					payload = json{ { "ok", false }, { "msg", "The key was saved, but SkyManager could not "
						"report how it applies. It takes effect next launch at the latest." } }.dump();
				}
				if (done) {
					done(std::move(payload));
				}
			});
		}).detach();
	}
}
