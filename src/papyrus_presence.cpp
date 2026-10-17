#include "papyrus_presence.h"

#include <mutex>
#include <string>
#include <unordered_map>

// pch (force-included) provides RE::/SKSE:: and the logger.

namespace PapyrusPresence
{
	bool ScriptAvailable(const char* cls)
	{
		if (!cls || !*cls)
			return false;
		static std::mutex                             mutex;
		static std::unordered_map<std::string, bool>  cache;
		std::lock_guard<std::mutex>                   lock(mutex);
		if (auto it = cache.find(cls); it != cache.end())
			return it->second;

		// Same probe facegen_resolver and item_icons use for meshes: the game's
		// resource layer answers for loose files AND archives.
		const std::string path = std::string("Scripts\\") + cls + ".pex";
		bool              ok = false;
		try {
			RE::BSResourceNiBinaryStream probe(path.c_str());
			ok = probe.good();
		} catch (...) {
			ok = false;
		}
		if (!ok)
			logger::warn("papyrus-presence: {}.pex is not in this load order - calls into {} are skipped", cls, cls);   // marker: papyrus-presence
		cache.emplace(cls, ok);
		return ok;
	}
}
