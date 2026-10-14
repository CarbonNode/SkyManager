#include "custom_markers_runtime.h"
#include "custom_markers_contract.h"

#include <bcrypt.h>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>

namespace CustomMarkersRuntime
{
	namespace
	{
		namespace Contract = CustomMarkersContract;
		bool Region(const void* address, std::size_t size, bool writable = false)
		{
			MEMORY_BASIC_INFORMATION info{};
			if(!VirtualQuery(address, &info, sizeof(info)) || info.State != MEM_COMMIT ||
				(info.Protect & (PAGE_NOACCESS | PAGE_GUARD))) return false;
			if(writable && !(info.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY))) return false;
			const auto offset = reinterpret_cast<std::uintptr_t>(address) - reinterpret_cast<std::uintptr_t>(info.BaseAddress);
			return offset <= info.RegionSize && size <= info.RegionSize - offset;
		}
		std::string FileHash(HMODULE module, std::uint32_t fileSize)
		{
			std::array<wchar_t, 32768> path{};
			const auto len = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
			if(!len || len >= path.size()) return {};
			std::ifstream input(std::filesystem::path(path.data()), std::ios::binary | std::ios::ate);
			if(!input || input.tellg() != static_cast<std::streamoff>(fileSize)) return {};
			std::vector<unsigned char> bytes(fileSize);
			input.seekg(0);
			if(!input.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) return {};
			std::array<unsigned char, 32> digest{};
			struct HashHandles {
				BCRYPT_ALG_HANDLE algorithm{};
				BCRYPT_HASH_HANDLE hash{};
				~HashHandles() { if(hash) BCryptDestroyHash(hash); if(algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
			} handles;
			if(BCryptOpenAlgorithmProvider(&handles.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0 ||
				BCryptCreateHash(handles.algorithm, &handles.hash, nullptr, 0, nullptr, 0, 0) < 0 ||
				BCryptHashData(handles.hash, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0 ||
				BCryptFinishHash(handles.hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) return {};
			constexpr char hex[] = "0123456789abcdef";
			std::string out; out.reserve(64);
			for(auto b : digest) { out += hex[b >> 4]; out += hex[b & 15]; }
			return out;
		}
		// The verified build this loaded module is, or nullptr.
		const Contract::Build* Verified(HMODULE module)
		{
			if(!module) return nullptr;
			const auto* base = reinterpret_cast<const std::uint8_t*>(module);
			if(!Region(base, sizeof(IMAGE_DOS_HEADER))) return nullptr;
			const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
			if(dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 4096) return nullptr;
			const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
			if(!Region(nt, sizeof(*nt)) || nt->Signature != IMAGE_NT_SIGNATURE ||
				nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return nullptr;
			const auto* version = reinterpret_cast<const std::uint32_t*>(GetProcAddress(module, "SKSEPlugin_Version"));
			if(!version || !Region(version, 8) || version[0] != 1) return nullptr;
			const auto* build = Contract::Candidate(nt->OptionalHeader.SizeOfImage, nt->FileHeader.TimeDateStamp, version[1]);
			if(!build) return nullptr;
			for(const auto& f : build->fingerprints)
				if(!Region(base + f.rva, f.hex.size() / 2)) return nullptr;
			// Hash the loaded module's backing file once. Recheck in-memory code
			// on every use, including the load/save field access and renderer gate.
			static std::mutex mutex;
			static HMODULE checked = nullptr;
			static std::string hash;
			std::lock_guard lock(mutex);
			if(checked != module) {
				hash = FileHash(module, build->fileSize); checked = module;
				logger::info("custom-markers-combat: binary sha256={} supported={} ({})", hash, hash == build->sha256, build->name);
			}
			return Contract::Identify({base, build->imageSize}, version[1], nt->FileHeader.TimeDateStamp, hash);
		}
	}
	bool Supported()
	{
		try { return Verified(GetModuleHandleA("CustomMarkers.dll")) != nullptr; }
		catch(const std::exception& e) { logger::warn("custom-markers-combat: verification failed: {}", e.what()); return false; }
	}
	Result ToggleCombat()
	{
		const auto module = GetModuleHandleA("CustomMarkers.dll");
		const Contract::Build* build = nullptr;
		try { build = Verified(module); }
		catch(const std::exception& e) { logger::warn("custom-markers-combat: verification failed: {}", e.what()); }
		if(!build) return {Status::unsupported};
		auto* player = RE::PlayerCharacter::GetSingleton();
		if(!player || !player->GetParentCell()) return {Status::notReady};
		auto* base = reinterpret_cast<std::uint8_t*>(module);
		auto* epoch = reinterpret_cast<const std::int32_t*>(base + build->initialized);
		// 0 = uninitialized, -1 = initialization in progress. A completed
		// MSVC function-static guard contains a negative epoch below -1.
		if(!Region(epoch, sizeof(*epoch)) || *epoch >= -1 ||
			!Region(base + build->settings, build->hideInCombat + 1, true)) return {Status::notReady};
		using Getter = void*(*)();
		using Saver = void(*)(void*);
		auto* settings = reinterpret_cast<Getter>(base + build->getSettings)();
		if(settings != base + build->settings) return {Status::notReady};
		auto* hide = static_cast<std::uint8_t*>(settings) + build->hideInCombat;
		const auto visible = *(static_cast<std::uint8_t*>(settings) + build->beamsVisible);
		if(*hide > 1 || visible > 1) return {Status::notReady};
		const bool show = *hide != 0;
		*hide = show ? 0 : 1;
		logger::info("custom-markers-combat: show={} beams-enabled={} adapter={}", show, visible != 0, build->name);
		try {
			// Use precisely the function called by the native HUD/SMF Save
			// buttons. Never reload stale INI values over the mod's live state.
			reinterpret_cast<Saver>(base + build->saveSettings)(settings);
		} catch(const std::exception& e) {
			logger::warn("custom-markers-combat: owner save failed: {}", e.what());
			return {Status::saveFailed, show, visible != 0};
		}
		return {Status::changed, show, visible != 0};
	}
}
