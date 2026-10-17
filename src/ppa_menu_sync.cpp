// PPA's SMF menu copy, kept in step with the toml. See ppa_menu_sync.h for the
// bug, the proof and PPA's layout. Pure: every byte of foreign memory goes
// through the caller's Read/Write callbacks (SEH-guarded on the rig, plain
// memcpy in tools/ppa_menu_sync_selftest.cpp).
#include "ppa_menu_sync.h"

#include <cstdint>
#include <cstring>

namespace PpaMenuSync
{
	namespace
	{
		constexpr std::size_t kMinEntries = 8;     // PPA ships ~60
		constexpr std::size_t kMaxEntries = 2000;

		// MSVC std::string: 16-byte buffer/pointer, size, capacity.
		struct RawString
		{
			std::uintptr_t buf[2];
			std::uint64_t  size;
			std::uint64_t  res;
		};
		static_assert(sizeof(RawString) == 32);

		struct RawVec
		{
			std::uintptr_t first, last, end;
		};

		bool Plausible(std::uintptr_t p)
		{
			return p >= 0x10000 && p < 0x00007FFFFFFF0000ull;
		}

		bool ReadString(const unsigned char* at, ReadFn read, std::string& out)
		{
			RawString s{};
			std::memcpy(&s, at, sizeof(s));
			if (s.res < 15 || s.size > s.res || s.size > 255)
				return false;
			char tmp[256];
			if (s.res == 15) {
				std::memcpy(tmp, s.buf, 16);
			} else if (!Plausible(s.buf[0]) || (s.buf[0] & 7) != 0 || !read(tmp, s.buf[0], s.size + 1)) {
				return false;
			}
			if (tmp[s.size] != '\0')
				return false;
			for (std::size_t i = 0; i < s.size; ++i) {
				const auto c = static_cast<unsigned char>(tmp[i]);
				if (c < 0x20 || c == 0x7F)
					return false;
			}
			out.assign(tmp, s.size);
			return true;
		}

		// A toml bare key: letters, digits, '_' and '-'. Anything else is not
		// one of PPA's keys, so the candidate is not PPA's list.
		bool BareKey(const std::string& k, bool allowEmpty)
		{
			if (k.empty())
				return allowEmpty;
			for (const char c : k) {
				const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
				if (!ok)
					return false;
			}
			return true;
		}

		bool Decode(const unsigned char* raw, ReadFn read, Entry& e)
		{
			std::string spare;
			if (!ReadString(raw + kOffSection, read, e.section) || !ReadString(raw + kOffSub, read, e.sub) ||
				!ReadString(raw + kOffKey, read, e.key) || !ReadString(raw + kOffLabel, read, e.label) ||
				!ReadString(raw + kOffSpare, read, spare))
				return false;
			if (!BareKey(e.section, false) || !BareKey(e.sub, true) || !BareKey(e.key, false))
				return false;
			const auto liveIdx = raw[kOffLiveIdx];
			const auto menuIdx = raw[kOffMenuIdx];
			if (liveIdx > 2 || menuIdx != liveIdx)
				return false;
			e.type = static_cast<Type>(liveIdx);
			std::memcpy(&e.liveAddr, raw + kOffLivePtr, sizeof(e.liveAddr));
			if (!Plausible(e.liveAddr) || (e.type != Type::Bool && (e.liveAddr & 3) != 0))
				return false;
			const std::size_t width = e.type == Type::Bool ? 1 : 4;
			e.liveBits = 0;
			if (!read(&e.liveBits, e.liveAddr, width))
				return false;
			e.menuBits = 0;
			std::memcpy(&e.menuBits, raw + kOffMenu, width);
			if (e.type == Type::Bool && (e.liveBits > 1 || e.menuBits > 1))
				return false;  // a C++ bool is 0 or 1
			return true;
		}

		bool Same(Type t, std::uint32_t a, std::uint32_t b)
		{
			if (t == Type::Float) {
				float fa = 0, fb = 0;
				std::memcpy(&fa, &a, 4);
				std::memcpy(&fb, &b, 4);
				return fa == fb;  // PPA's own test (ucomiss), so -0 == 0
			}
			return a == b;
		}
	}

	bool ReadEntries(std::uintptr_t slot, ReadFn read, std::vector<Entry>& out, std::string& why)
	{
		out.clear();
		RawVec v{};
		if (!slot || !read(&v, slot, sizeof(v))) {
			why = "the settings list's address no longer reads";
			return false;
		}
		if (!Plausible(v.first) || (v.first & 7) != 0 || v.last < v.first || v.end < v.last) {
			why = "the settings list is not a vector";
			return false;
		}
		const auto bytes = v.last - v.first;
		if (bytes % kEntrySize != 0 || (v.end - v.first) % kEntrySize != 0) {
			why = "the settings list's elements are not PPA's size";
			return false;
		}
		const auto n = bytes / kEntrySize;
		if (n < kMinEntries || n > kMaxEntries) {
			why = "the settings list has an implausible length";
			return false;
		}
		std::vector<unsigned char> raw(bytes);
		if (!read(raw.data(), v.first, bytes)) {
			why = "the settings list's elements do not read";
			return false;
		}
		bool sawLogging = false;
		out.reserve(n);
		for (std::size_t i = 0; i < n; ++i) {
			Entry e;
			if (!Decode(raw.data() + i * kEntrySize, read, e)) {
				why = "setting #" + std::to_string(i) + " does not decode";
				out.clear();
				return false;
			}
			e.menuAddr = v.first + i * kEntrySize + kOffMenu;
			if (e.section == "Debug" && e.sub.empty() && e.key == "Logging" && e.type == Type::Bool)
				sawLogging = true;
			out.push_back(std::move(e));
		}
		if (!sawLogging) {
			why = "no Debug.Logging switch in it";
			out.clear();
			return false;
		}
		return true;
	}

	std::uintptr_t Locate(const std::vector<Region>& regions, ReadFn read, std::string& why)
	{
		std::uintptr_t slot = 0, first = 0;
		int            distinct = 0;
		for (const auto& r : regions) {
			const auto size = r.size & ~std::size_t(7);
			if (!r.start || !size || size > 64u * 1024 * 1024)
				continue;
			std::vector<std::uint64_t> words(size / 8);
			if (!read(words.data(), r.start, size))
				continue;
			for (std::size_t i = 0; i + 2 < words.size(); ++i) {
				const auto a = static_cast<std::uintptr_t>(words[i]);
				const auto b = static_cast<std::uintptr_t>(words[i + 1]);
				const auto c = static_cast<std::uintptr_t>(words[i + 2]);
				// Cheap rejections first: ~10k words, almost none survive these.
				if (!Plausible(a) || (a & 7) != 0 || b < a || c < b || a == first)
					continue;
				if ((b - a) % kEntrySize != 0 || (c - a) % kEntrySize != 0)
					continue;
				const auto n = (b - a) / kEntrySize;
				if (n < kMinEntries || n > kMaxEntries)
					continue;
				std::vector<Entry> tmp;
				std::string        w;
				const auto         at = r.start + i * 8;
				if (!ReadEntries(at, read, tmp, w))
					continue;
				if (distinct++ == 0) {
					slot = at;
					first = a;
				}
			}
		}
		if (distinct == 0) {
			why = "could not find PPA's SKSE Menu Framework settings list (unknown PPA build)";
			return 0;
		}
		if (distinct > 1) {
			why = "found " + std::to_string(distinct) + " candidate PPA settings lists; refusing to guess";
			return 0;
		}
		return slot;
	}

	bool Encode(Type type, const std::string& text, std::uint32_t& bits)
	{
		bits = 0;
		if (type == Type::Bool) {
			if (text == "true")
				bits = 1;
			else if (text != "false")
				return false;
			return true;
		}
		if (text.empty())
			return false;
		std::size_t used = 0;
		try {
			if (type == Type::Int) {
				if (text.find_first_of(".eE") != std::string::npos)
					return false;
				const long v = std::stol(text, &used);
				if (used != text.size() || v < INT32_MIN || v > INT32_MAX)
					return false;
				const auto i = static_cast<std::int32_t>(v);
				std::memcpy(&bits, &i, 4);
				return true;
			}
			const float f = std::stof(text, &used);
			if (used != text.size())
				return false;
			std::memcpy(&bits, &f, 4);
			return true;
		} catch (...) {
			return false;
		}
	}

	std::vector<std::string> SyncFromFile(const std::vector<Entry>& entries,
		const std::map<std::string, std::string>& fileValues, WriteFn write, std::vector<std::string>* failed)
	{
		std::vector<std::string> done;
		for (const auto& e : entries) {
			const auto it = fileValues.find(e.Path());
			if (it == fileValues.end())
				continue;
			std::uint32_t bits = 0;
			if (!Encode(e.type, it->second, bits))
				continue;
			if (Same(e.type, e.menuBits, bits))
				continue;
			const std::size_t width = e.type == Type::Bool ? 1 : 4;
			if (write(e.menuAddr, &bits, width))
				done.push_back(e.Path());
			else if (failed)
				failed->push_back(e.Path());
		}
		return done;
	}
}
