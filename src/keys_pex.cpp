// Keys tab, Papyrus source. See keys_pex.h for what this is for and what it
// deliberately does not do.
//
// PEX FORMAT (Skyrim SE, big-endian, magic FA57C0DE). There is no offset table
// anywhere in the file: every section is read sequentially, which is what makes
// a single forward walk possible -- and what makes one wrong field length
// desynchronise everything after it. The layout below was verified by parsing
// the nineteen real .pex in this repo (three different authors, three different
// compiler stamps) and confirming each walk lands EXACTLY on EOF:
//
//   u32 magic · u8 major · u8 minor · u16 gameId · u64 compileTime
//   wstring srcFileName · wstring username · wstring machineName
//   u16 stringCount · stringCount * wstring          <- the string table
//   u8 hasDebugInfo
//     if set: u64 modTime · u16 funcCount · per function
//             { u16 object, u16 state, u16 name, u8 type, u16 lineCount,
//               lineCount * u16 }
//   u16 userFlagCount · each { u16 name, u8 index }
//   u16 objectCount · each object:
//     u16 name · u32 size · u16 parentClass · u16 docString · u32 userFlags
//     u16 autoState
//     u16 varCount   · each { u16 name, u16 type, u32 userFlags, VALUE }
//     u16 propCount  · each { u16 name, u16 type, u16 doc, u32 flags, u8 kind,
//                             kind&4 ? u16 autoVarName : [get][set] FUNCTION }
//     u16 stateCount · each { u16 name, u16 funcCount, funcCount * (u16 name,
//                             FUNCTION) }
//
//   ⚠ `size` COUNTS ITSELF: it is measured from the first byte of the size
//   field. Reading it as "bytes that follow" leaves every object 4 bytes short.
//   That is the one trap in the format and it is silent -- the walk still
//   "works", it just ends in the wrong place.
//
//   FUNCTION: u16 returnType · u16 doc · u32 userFlags · u8 flags
//             u16 paramCount · each { u16 name, u16 type }
//             u16 localCount · each { u16 name, u16 type }
//             u16 instructionCount · each { u8 opcode, N * VALUE }
//   VALUE:    u8 type -- 0 none · 1 identifier(u16) · 2 string(u16)
//             · 3 int(i32) · 4 float(f32) · 5 bool(u8)
//
// The three call opcodes are variadic: their fixed arguments are followed by an
// integer VALUE holding the argument count, then that many VALUEs.

#include "keys_pex.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace KeysPex
{
	namespace
	{
		constexpr std::uint32_t kMagic = 0xFA57C0DEu;
		constexpr std::uintmax_t kMaxFileBytes = 4u << 20;  // 4 MiB
		// 60,000: the rig's real mod tree holds 31,146 compiled scripts, and the
		// VFS presents one winner per path. A cap below that silently truncates.
		constexpr std::size_t   kMaxFiles = 60000;
		constexpr std::size_t   kMaxRows = 400;

		// The census accepts keyboard scancodes plus SkyUI's mouse encoding.
		constexpr long kMinCode = 1, kMaxCode = 265;

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// --------------------------------------------------------- reader ----

		// Every read is bounds-checked and throws; the caller treats a throw as
		// "this script is not readable" and moves on. A .pex comes from a mod we
		// did not write, so a truncated or hand-edited one is expected, not
		// exceptional.
		class Reader
		{
		public:
			Reader(const std::uint8_t* data, std::size_t size) :
				_d(data), _n(size)
			{}

			std::size_t pos() const { return _i; }
			bool        done() const { return _i >= _n; }

			void Skip(std::size_t n) { Take(n); }

			std::uint8_t U8()
			{
				const auto* p = Take(1);
				return p[0];
			}

			std::uint16_t U16()
			{
				const auto* p = Take(2);
				return static_cast<std::uint16_t>((p[0] << 8) | p[1]);
			}

			std::uint32_t U32()
			{
				const auto* p = Take(4);
				return (static_cast<std::uint32_t>(p[0]) << 24) |
				       (static_cast<std::uint32_t>(p[1]) << 16) |
				       (static_cast<std::uint32_t>(p[2]) << 8) |
				       static_cast<std::uint32_t>(p[3]);
			}

			std::int32_t I32() { return static_cast<std::int32_t>(U32()); }

			std::string WString()
			{
				const auto len = U16();
				const auto* p = Take(len);
				return std::string(reinterpret_cast<const char*>(p), len);
			}

		private:
			const std::uint8_t* Take(std::size_t n)
			{
				if (_i + n > _n) {
					throw std::runtime_error("pex: read past end");
				}
				const auto* p = _d + _i;
				_i += n;
				return p;
			}

			const std::uint8_t* _d;
			std::size_t         _n;
			std::size_t         _i = 0;
		};

		// Opcode -> fixed argument count. Anything outside this table means the
		// walk has desynchronised, so parsing stops rather than inventing rows.
		int ArgCount(std::uint8_t op)
		{
			switch (op) {
			case 0x00: return 0;                                    // nop
			case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x0E:  // not..cast
			case 0x15: case 0x16:                                   // jmpt jmpf
			case 0x1E: case 0x1F:                                   // array create/length
				return 2;
			case 0x14: case 0x1A: return 1;                         // jmp, return
			case 0x22: case 0x23: return 4;                         // array find/rfind
			case 0x18: return 2;                                    // callparent (+varargs)
			case 0x01: case 0x02: case 0x03: case 0x04: case 0x05:
			case 0x06: case 0x07: case 0x08: case 0x09:
			case 0x0F: case 0x10: case 0x11: case 0x12: case 0x13:
			case 0x17: case 0x19:                                   // callmethod, callstatic
			case 0x1B: case 0x1C: case 0x1D:
			case 0x20: case 0x21:
				return 3;
			default: return -1;
			}
		}

		bool IsVariadic(std::uint8_t op) { return op == 0x17 || op == 0x18 || op == 0x19; }

		// One decoded instruction argument. Only the two shapes that can name a
		// key are kept: an integer literal, or an identifier we may be able to
		// resolve to one.
		struct Value
		{
			enum class Kind { Other, Int, Ident } kind = Kind::Other;
			long        num = 0;
			std::string ident;
		};

		Value ReadValue(Reader& r, const std::vector<std::string>& strings)
		{
			Value v;
			const auto type = r.U8();
			switch (type) {
			case 0: break;                       // none
			case 1: {                            // identifier
				const auto idx = r.U16();
				v.kind = Value::Kind::Ident;
				v.ident = idx < strings.size() ? strings[idx] : std::string();
				break;
			}
			case 2: r.U16(); break;              // string
			case 3:
				v.kind = Value::Kind::Int;
				v.num = r.I32();
				break;
			case 4: r.Skip(4); break;            // float
			case 5: r.Skip(1); break;            // bool
			default:
				throw std::runtime_error("pex: unknown value type");
			}
			return v;
		}

		// ------------------------------------------------------- the parse ---

		struct ParseOut
		{
			std::vector<Row> rows;
			bool             skippedAsMcm = false;
		};

		// Names whose presence in the string table means "worth a full parse".
		bool TableMentionsKeys(const std::vector<std::string>& strings, bool& looksLikeMcm)
		{
			bool wanted = false;
			for (const auto& s : strings) {
				const auto l = Lower(s);
				if (l == "registerforkey") {
					wanted = true;
				} else if (l == "ski_configbase" || l.rfind("addkeymapoption", 0) == 0) {
					looksLikeMcm = true;
				}
			}
			return wanted;
		}

		void ParseFunction(Reader& r, const std::vector<std::string>& strings,
			const std::string& objectName, const std::string& funcName,
			const std::unordered_map<std::string, long>& objectVars, ParseOut& out,
			const std::string& fileLabel)
		{
			r.U16();  // return type
			r.U16();  // doc string
			r.U32();  // user flags
			r.U8();   // flags
			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
				r.U16();
				r.U16();
			}
			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
				r.U16();
				r.U16();
			}

			// Constant propagation, deliberately the simplest thing that covers
			// the real shapes: a local assigned an integer literal earlier in
			// THIS function. No branch analysis -- if the same local is assigned
			// twice the later value wins, exactly as a straight-line reader
			// would see it.
			std::unordered_map<std::string, long> locals;

			const auto resolve = [&](const Value& v, std::string& how) -> long {
				if (v.kind == Value::Kind::Int) {
					how = "literal";
					return v.num;
				}
				if (v.kind == Value::Kind::Ident) {
					if (const auto it = locals.find(v.ident); it != locals.end()) {
						how = "local " + v.ident;
						return it->second;
					}
					if (const auto it = objectVars.find(v.ident); it != objectVars.end()) {
						how = "property default " + v.ident;
						return it->second;
					}
				}
				return 0;  // unresolved -- the caller drops it
			};

			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
				const auto op = r.U8();
				const int  fixed = ArgCount(op);
				if (fixed < 0) {
					throw std::runtime_error("pex: unknown opcode");
				}
				std::vector<Value> args;
				args.reserve(static_cast<std::size_t>(fixed));
				for (int a = 0; a < fixed; ++a) {
					args.push_back(ReadValue(r, strings));
				}
				if (IsVariadic(op)) {
					const auto count = ReadValue(r, strings);
					if (count.kind != Value::Kind::Int || count.num < 0 || count.num > 4096) {
						throw std::runtime_error("pex: bad vararg count");
					}
					for (long a = 0; a < count.num; ++a) {
						args.push_back(ReadValue(r, strings));
					}
				}

				if (op == 0x0D && args.size() == 2 && args[0].kind == Value::Kind::Ident &&
					args[1].kind == Value::Kind::Int) {
					locals[args[0].ident] = args[1].num;  // assign <local> <literal>
					continue;
				}

				// callmethod: args[0] is the method name, then object, dest, args.
				if (op != 0x17 || args.size() < 4 || args[0].kind != Value::Kind::Ident) {
					continue;
				}
				if (Lower(args[0].ident) != "registerforkey") {
					continue;
				}
				std::string how;
				const long  code = resolve(args[3], how);
				if (code < kMinCode || code > kMaxCode) {
					continue;  // unresolved, or not a key -- say nothing
				}
				if (out.rows.size() >= kMaxRows) {
					continue;
				}
				out.rows.push_back(Row{
					objectName,
					"Registered in " + funcName,
					static_cast<std::uint32_t>(code),
					fileLabel + " · " + objectName + "." + funcName +
						" · RegisterForKey (" + how + ")",
				});
			}
		}

		void ParseObject(Reader& r, const std::vector<std::string>& strings, ParseOut& out,
			const std::string& fileLabel)
		{
			const auto nameIdx = r.U16();
			const auto size = r.U32();
			// The size counts itself -- see the header comment. Kept as a
			// consistency check only; the walk never seeks.
			const auto end = r.pos() - 4 + size;
			const std::string objectName =
				nameIdx < strings.size() ? strings[nameIdx] : std::string("?");

			const auto parentIdx = r.U16();
			const std::string parent =
				parentIdx < strings.size() ? Lower(strings[parentIdx]) : std::string();
			r.U16();  // doc string
			r.U32();  // user flags
			r.U16();  // auto state

			if (parent == "ski_configbase") {
				out.skippedAsMcm = true;
			}

			// Variables first: a property's compiled default lives in the object
			// variable that backs it, which is why this map is built before any
			// function is read.
			std::unordered_map<std::string, long> objectVars;
			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
				const auto vNameIdx = r.U16();
				r.U16();  // type
				r.U32();  // user flags
				const auto v = ReadValue(r, strings);
				if (v.kind == Value::Kind::Int && vNameIdx < strings.size()) {
					objectVars[strings[vNameIdx]] = v.num;
				}
			}

			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
				r.U16();  // name
				r.U16();  // type
				r.U16();  // doc string
				r.U32();  // user flags
				const auto kind = r.U8();
				if (kind & 4) {
					r.U16();  // auto var name
				} else {
					if (kind & 1) {
						ParseFunction(r, strings, objectName, "get", objectVars, out, fileLabel);
					}
					if (kind & 2) {
						ParseFunction(r, strings, objectName, "set", objectVars, out, fileLabel);
					}
				}
			}

			for (std::uint16_t s = 0, sn = r.U16(); s < sn; ++s) {
				r.U16();  // state name
				for (std::uint16_t f = 0, fn = r.U16(); f < fn; ++f) {
					const auto fNameIdx = r.U16();
					const std::string funcName =
						fNameIdx < strings.size() ? strings[fNameIdx] : std::string("?");
					ParseFunction(r, strings, objectName, funcName, objectVars, out, fileLabel);
				}
			}

			if (r.pos() != end) {
				throw std::runtime_error("pex: object size mismatch");
			}
		}

		// alwaysWalk=true is the selftest/diagnostic path: it disables the
		// string-table early-out so the object walk is exercised against scripts
		// that never call RegisterForKey -- which is nearly all of them, and
		// therefore where a format mistake would otherwise hide.
		ParseOut ParseScript(const std::vector<std::uint8_t>& bytes, const std::string& fileLabel,
			bool alwaysWalk = false)
		{
			ParseOut out;
			Reader   r(bytes.data(), bytes.size());

			if (r.U32() != kMagic) {
				return out;  // not a Skyrim .pex
			}
			r.U8();   // major
			r.U8();   // minor
			r.U16();  // game id
			r.Skip(8);
			r.WString();  // source file name
			r.WString();  // username    -- see tools/pex_scrub.py
			r.WString();  // machine name

			std::vector<std::string> strings;
			const auto               stringCount = r.U16();
			strings.reserve(stringCount);
			for (std::uint16_t i = 0; i < stringCount; ++i) {
				strings.push_back(r.WString());
			}

			// The early-out that makes this affordable across thousands of
			// scripts: no RegisterForKey in the string table, no object walk.
			bool looksLikeMcm = false;
			const bool wanted = TableMentionsKeys(strings, looksLikeMcm);
			if (!wanted && !alwaysWalk) {
				return out;
			}
			if (looksLikeMcm) {
				out.skippedAsMcm = true;
				return out;  // the live MCM sweep owns this script's keys
			}

			if (r.U8()) {  // debug info
				r.Skip(8);
				for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
					r.Skip(6);  // object, state, function
					r.U8();     // function type
					for (std::uint16_t l = 0, ln = r.U16(); l < ln; ++l) {
						r.U16();
					}
				}
			}

			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {  // user flags
				r.U16();
				r.U8();
			}

			for (std::uint16_t i = 0, n = r.U16(); i < n; ++i) {
				ParseObject(r, strings, out, fileLabel);
				if (out.skippedAsMcm) {
					out.rows.clear();
					return out;
				}
			}
			return out;
		}

		// ---------------------------------------------------------- cache ----

		struct CacheEntry
		{
			std::uintmax_t size = 0;
			std::int64_t   mtime = 0;
			std::vector<Row> rows;
		};

		fs::path CachePath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "keys-pex-cache.json";
		}

		std::unordered_map<std::string, CacheEntry> LoadCache()
		{
			std::unordered_map<std::string, CacheEntry> cache;
			std::ifstream in(CachePath(), std::ios::binary);
			if (!in) {
				return cache;
			}
			const auto doc = json::parse(in, nullptr, false);
			if (doc.is_discarded() || !doc.is_object() || !doc.contains("scripts") ||
				!doc["scripts"].is_object()) {
				return cache;
			}
			for (const auto& [path, e] : doc["scripts"].items()) {
				if (!e.is_object()) {
					continue;
				}
				CacheEntry ce;
				ce.size = e.value("size", 0ull);
				ce.mtime = e.value("mtime", std::int64_t{ 0 });
				if (e.contains("rows") && e["rows"].is_array()) {
					for (const auto& row : e["rows"]) {
						if (!row.is_object()) {
							continue;
						}
						const auto code = row.value("code", 0);
						if (code < kMinCode || code > kMaxCode) {
							continue;  // untrusted file: same bounds the parse enforces
						}
						ce.rows.push_back(Row{ row.value("script", ""), row.value("control", ""),
							static_cast<std::uint32_t>(code), row.value("detail", "") });
					}
				}
				cache[path] = std::move(ce);
			}
			return cache;
		}

		void SaveCache(const std::unordered_map<std::string, CacheEntry>& cache)
		{
			try {
				json scripts = json::object();
				for (const auto& [path, ce] : cache) {
					json rows = json::array();
					for (const auto& r : ce.rows) {
						rows.push_back(json{ { "script", r.script }, { "control", r.control },
							{ "code", r.code }, { "detail", r.detail } });
					}
					scripts[path] = json{ { "size", ce.size }, { "mtime", ce.mtime },
						{ "rows", std::move(rows) } };
				}
				json j{ { "version", 1 }, { "scripts", std::move(scripts) } };

				const auto      path = CachePath();
				std::error_code ec;
				fs::create_directories(path.parent_path(), ec);
				auto tmp = path;
				tmp += ".tmp";
				{
					std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
					if (!out.is_open()) {
						return;
					}
					out << j.dump();
					out.flush();
					if (!out.good()) {
						return;
					}
				}
				fs::rename(tmp, path, ec);
			} catch (const std::exception& e) {
				logger::warn("keys-pex: cache save failed: {}", e.what());
			}
		}
	}

	// ------------------------------------------------------------- public ----

	std::vector<Row> Scan(bool force)
	{
		std::vector<Row> out;
		auto             cache = force ? std::unordered_map<std::string, CacheEntry>{} : LoadCache();
		std::unordered_map<std::string, CacheEntry> fresh;

		std::size_t files = 0, parsed = 0, reused = 0, mcmSkipped = 0, unreadable = 0;

		try {
			const fs::path dir("Data/Scripts");
			std::error_code ec;
			if (!fs::exists(dir, ec)) {
				logger::info("keys-pex: no Data/Scripts folder -- nothing to read");
				return out;
			}
			for (const auto& entry :
				fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
				if (files >= kMaxFiles) {
					logger::warn("keys-pex: stopped at the {}-file cap -- part of "
								 "Data/Scripts was NOT read", kMaxFiles);
					break;
				}
				std::error_code sub;
				if (!entry.is_regular_file(sub)) {
					continue;
				}
				const auto ext = Lower(PathU8(entry.path().extension()));
				if (ext != ".pex") {
					continue;
				}
				++files;

				const auto key = Lower(PathU8(entry.path().filename()));
				const auto size = entry.file_size(sub);
				if (sub || size > kMaxFileBytes) {
					continue;
				}
				std::int64_t mtime = 0;
				if (const auto t = entry.last_write_time(sub); !sub) {
					mtime = static_cast<std::int64_t>(t.time_since_epoch().count());
				}

				// Cache hit: same file, same size, same write time.
				if (const auto it = cache.find(key);
					it != cache.end() && it->second.size == size && it->second.mtime == mtime) {
					++reused;
					for (const auto& r : it->second.rows) {
						out.push_back(r);
					}
					fresh[key] = it->second;
					continue;
				}

				std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
				{
					std::ifstream in(entry.path(), std::ios::binary);
					if (!in) {
						++unreadable;
						continue;
					}
					in.read(reinterpret_cast<char*>(bytes.data()),
						static_cast<std::streamsize>(bytes.size()));
					if (!in) {
						++unreadable;
						continue;
					}
				}

				ParseOut po;
				try {
					po = ParseScript(bytes, "Scripts/" + PathU8(entry.path().filename()));
				} catch (const std::exception&) {
					// A script we cannot read is a script we say nothing about.
					++unreadable;
					continue;
				}
				++parsed;
				if (po.skippedAsMcm) {
					++mcmSkipped;
				}

				CacheEntry ce;
				ce.size = size;
				ce.mtime = mtime;
				ce.rows = po.rows;
				for (const auto& r : po.rows) {
					out.push_back(r);
				}
				fresh[key] = std::move(ce);
			}
		} catch (const std::exception& e) {
			logger::warn("keys-pex: scan aborted: {}", e.what());
		}

		SaveCache(fresh);
		logger::info("keys-pex: papyrus scan -- {} row(s) from {} script(s) "
					 "({} parsed, {} cached, {} MCM-owned, {} unreadable)",
			out.size(), files, parsed, reused, mcmSkipped, unreadable);
		return out;
	}

	Probe ProbeFile(const std::string& path)
	{
		Probe p;
		try {
			const fs::path        f{ path };
			std::error_code       ec;
			const auto            size = fs::file_size(f, ec);
			if (ec || size > kMaxFileBytes) {
				p.error = ec ? ec.message() : "file too large";
				return p;
			}
			std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
			std::ifstream             in(f, std::ios::binary);
			if (!in) {
				p.error = "cannot open";
				return p;
			}
			in.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
			if (!in) {
				p.error = "short read";
				return p;
			}
			const auto po = ParseScript(bytes, PathU8(f.filename()), true);
			p.ok = true;
			p.mcmOwned = po.skippedAsMcm;
			p.rows = po.rows;
		} catch (const std::exception& e) {
			p.error = e.what();
		}
		return p;
	}
}
