#include "facegen_resolver.h"
#include "facegen_paths.h"
#include "actor_identity.h"

#include <Windows.h>
#include <unordered_set>

namespace FaceGenResolver
{
	std::string Resolve(const std::string& fid, const std::string& plugin)
	{
		const auto result = FaceGenPaths::Resolve(fid, plugin,
			[](const std::string& path) {
				RE::BSResourceNiBinaryStream probe(path.c_str());
				return probe.good();
			},
			[&]() -> std::string {
				auto* form = ActorIdentity::Resolve(fid, plugin);
				auto* npc = form ? form->As<RE::TESNPC>() : nullptr;
				auto* file = npc ? npc->GetFile(0) : nullptr;
				if (!file || FaceGenPaths::Lower(file->GetFilename()) != FaceGenPaths::Lower(plugin))
					return {};
				const auto local = npc->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				if (FaceGenPaths::LocalId(fid) != local)
					return {};   // reject a runtime/wrong-width id that Resolve would mask
				if (const auto* id = npc->GetFormEditorID(); id && *id)
					return id;

				// Modern po3 Tweaks caches discarded NPC EDIDs behind its exported
				// GetFormEditorID(uint32), rather than replacing the vanilla getter.
				// Optional, read-only ABI: without either source, do not guess.
				using GetEditorID = const char* (*)(std::uint32_t);
				static const auto getEditorID = []() -> GetEditorID {
					const auto tweaks = GetModuleHandleW(L"po3_Tweaks.dll");
					return tweaks ? reinterpret_cast<GetEditorID>(GetProcAddress(tweaks, "GetFormEditorID")) : nullptr;
				}();
				const auto* id = getEditorID ? getEditorID(npc->GetFormID()) : nullptr;
				return id ? id : "";
			});
		if (result.recovered) {
			static std::unordered_set<std::string> logged;
			if (logged.insert(FaceGenPaths::Lower(plugin) + "|" + fid).second)
				logger::info("facegen-autocorrect: {}|{} uses verified head {}", plugin, fid, result.mesh);
		}
		return result.mesh;
	}
}
