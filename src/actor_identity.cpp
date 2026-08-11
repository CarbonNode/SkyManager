#include "actor_identity.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <mutex>
#include <unordered_map>

// pch (force-included) provides RE::/SKSE:: and the logger.

namespace ActorIdentity
{
	namespace
	{
		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// TESDataHandler::LookupModByName is a LINEAR scan with a _strnicmp per
		// entry, and this rig loads 4,239 plugins. Key() now runs on every "is it
		// the same person?" test — several hundred per tab open — so memoise it.
		// The file list is fixed once data has loaded, and a name that is absent
		// stays absent, so a null is worth caching too.
		std::mutex                                              g_fileMx;
		std::unordered_map<std::string, const RE::TESFile*>      g_fileCache;

		const RE::TESFile* FileFor(const std::string& plugin)
		{
			const auto      key = Lower(plugin);
			std::lock_guard l(g_fileMx);
			if (const auto it = g_fileCache.find(key); it != g_fileCache.end())
				return it->second;
			const RE::TESFile* file = nullptr;
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				file = dh->LookupModByName(plugin);
			g_fileCache.emplace(key, file);
			return file;
		}
	}

	std::string HexOf(std::uint32_t v)
	{
		char buf[16]{};
		std::snprintf(buf, sizeof(buf), "0x%X", v);
		return buf;
	}

	std::uint32_t ParseHex(const std::string& s)
	{
		if (s.empty())
			return 0;
		try {
			return static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
		} catch (...) {
			return 0;
		}
	}

	namespace
	{
		// The null check CommonLibSSE-NG's TESForm::GetLocalFormID() is missing.
		// Returns false when the form has no source file, which is every dynamic
		// (0xFF……) form. See the ⛔ block in actor_identity.h — reading through
		// that null file is the 2026-08-03 CTD.
		bool LocalIdIfDurable(const RE::TESForm* form, std::uint32_t& out)
		{
			if (!form)
				return false;
			auto* file = form->GetFile(0);
			if (!file) {
				// Name the culprit, but not once per tick: RoomGuard asks this for
				// every occupant of a guarded room, twice a second. One line per
				// distinct form is enough to identify it and cheap enough to leave
				// on. (exchange() is a single atomic op — no lock on the hot path.)
				static std::atomic<std::uint32_t> lastLogged{ 0 };
				const auto                        id = form->GetFormID();
				if (lastLogged.exchange(id) != id)
					logger::info("actor-identity: form 0x{:08X} has no source file (dynamic); no local id", id);
				return false;
			}
			// Mask to the file's OWN local width, exactly as GetLocalFormID would.
			out = form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			return true;
		}
	}

	std::uint32_t LocalIdOf(const RE::TESForm* form)
	{
		std::uint32_t local = 0;
		return LocalIdIfDurable(form, local) ? local : 0u;
	}

	std::uint32_t BestIdOf(const RE::TESForm* form)
	{
		std::uint32_t local = 0;
		if (LocalIdIfDurable(form, local))
			return local;
		// No durable identity: the runtime id at least addresses her THIS session.
		return form ? static_cast<std::uint32_t>(form->GetFormID()) : 0u;
	}

	RE::TESForm* Resolve(const std::string& formId, const std::string& plugin)
	{
		const std::uint32_t raw = ParseHex(formId);
		if (!raw)
			return nullptr;

		if (!plugin.empty()) {
			// The FILE first, not LookupForm directly: we need to know how wide
			// its local ids are before we mask. See the trap note in the header —
			// LookupFormID ADDS the file's prefix, so an unmasked full runtime id
			// addresses nothing at all.
			if (const auto* file = FileFor(plugin)) {
				const std::uint32_t local = raw & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					if (auto* f = dh->LookupForm(local, plugin))
						return f;
				}
			}
		}

		// No plugin recorded: the id is all we have. Load-order dependent by
		// construction — the legacy path Canonicalise()/RepairByName() exist to
		// retire.
		//
		// But when a plugin WAS recorded and is simply absent from this load
		// order, the raw id must NOT fall through here. A stored pair like
		// (SomeFollower.esp, 0x81A) would resolve as bare 0x81A — i.e.
		// Skyrim.esm|0000081A, an unrelated vanilla form — and callers act on
		// what they get: perks and essential flags onto a stranger
		// (follower_tune), items into a stranger's inventory (wardrobe). An
		// honest null is the only correct answer for "her mod isn't installed".
		if (!plugin.empty())
			return nullptr;
		return RE::TESForm::LookupByID(raw);
	}

	RE::Actor* ResolveActor(const std::string& formId, const std::string& plugin)
	{
		auto* f = Resolve(formId, plugin);
		return f ? f->As<RE::Actor>() : nullptr;
	}

	bool DurableOf(const RE::TESForm* form, std::string& outFormId, std::string& outPlugin)
	{
		if (!form)
			return false;
		// GetFile(0) is sourceFiles[0] — the file that DEFINES the form, not the
		// last one to override it, which is what makes the pair durable.
		auto* file = form->GetFile(0);
		if (!file)
			return false;   // dynamic form: no durable identity exists
		const auto name = file->GetFilename();
		if (name.empty())
			return false;
		const std::uint32_t mask = file->IsLight() ? 0xFFFu : 0xFFFFFFu;
		outFormId                = HexOf(form->GetFormID() & mask);
		outPlugin                = std::string(name);
		return true;
	}

	bool Canonicalise(std::string& formId, std::string& plugin)
	{
		auto* form = Resolve(formId, plugin);
		if (!form)
			return false;
		std::string id, plg;
		if (!DurableOf(form, id, plg))
			return false;
		if (id == formId && plg == plugin)
			return false;
		formId = std::move(id);
		plugin = std::move(plg);
		return true;
	}

	namespace
	{
		// Names round-trip through FO, the view and hotkeys.json, so compare them
		// the forgiving way: case-folded and edge-trimmed, nothing cleverer.
		bool SameName(std::string a, std::string b)
		{
			const auto trim = [](std::string& s) {
				const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
				s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
				s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
			};
			trim(a);
			trim(b);
			return !a.empty() && Lower(a) == Lower(b);
		}
	}

	bool CanonicaliseActor(std::string& formId, std::string& plugin,
		const std::string& expectedName)
	{
		auto* actor = ResolveActor(formId, plugin);
		if (!actor)
			return false;
		if (!expectedName.empty()) {
			const char* nm = actor->GetDisplayFullName();
			if (nm && *nm && !SameName(nm, expectedName))
				return false;   // it resolves — to someone else. Leave the row alone.
		}
		std::string id, plg;
		if (!DurableOf(actor, id, plg))
			return false;
		if (id == formId && plg == plugin)
			return false;
		formId = std::move(id);
		plugin = std::move(plg);
		return true;
	}

	bool ResolvesToStranger(const std::string& formId, const std::string& plugin,
		const std::string& expectedName)
	{
		if (expectedName.empty())
			return false;
		auto* actor = ResolveActor(formId, plugin);
		if (!actor)
			return false;
		const char* nm = actor->GetDisplayFullName();
		return nm && *nm && !SameName(nm, expectedName);
	}

	std::string Key(const std::string& formId, const std::string& plugin)
	{
		std::string id  = formId;
		std::string plg = plugin;
		Canonicalise(id, plg);   // no-op when it cannot resolve; that is fine
		// Re-spell the number even when nothing resolved: "0x0001A685" and
		// "0x1a685" are the same person, and hotkeys.json is hand-editable, so
		// leading zeros and case must never split one row into two.
		return Lower(HexOf(ParseHex(id))) + "|" + Lower(plg);
	}
}
