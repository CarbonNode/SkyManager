#include "skinshift_actions.h"

// pch (force-included) provides RE::/SKSE::, logger, Windows.h (via SKSE) and
// nlohmann json (<json.hpp>).

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <vector>

// ---------------------------------------------------------------------------
// How SkinShift is driven (reverse-engineered from the shipped DLL, v1.-6.2,
// 1,718,784 bytes): it keeps a per-actor skin assignment store (persisted in
// ITS OWN SKSE co-save, re-applied by its event-driven scan pipeline), and its
// preset registry is built from Data/textures/removenormals/presets/ at
// kDataLoaded. We call five of its internal functions by RVA:
//
//   SetTargetActor(Actor*)                 @ +0x54AC0  latch the target global
//   ApplyWholePresetToCurrentTarget(sv*)   @ +0x4CFB0  store + kick the apply
//   Remove(actorFormId)                    @ +0x36EF0  forget the assignment
//   QueueRescanReapply()                   @ +0x32B80  main-thread rescan
//   VisualRuleResetForCurrentTarget()      @ +0x47E10  per-geom rule reset
//
// All of that is valid ONLY for that exact build, so EVERY site's 24-byte
// prologue is byte-verified at base+RVA before anything is bound — one
// mismatch and the whole integration stands down with an honest reason
// instead of calling into the wrong bytes.
// ---------------------------------------------------------------------------

namespace SkinShiftActions
{
	namespace
	{
		// ---- the version gate --------------------------------------------
		struct SiteDef
		{
			const char*   name;
			std::uint32_t rva;
			unsigned char aob[24];
		};

		constexpr SiteDef kSites[] = {
			{ "SetTargetActor", 0x54AC0,
			  { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x55, 0x57,
				0x41, 0x56, 0x48, 0x8D, 0x6C, 0x24, 0xB9, 0x48, 0x81, 0xEC, 0xA0, 0x00 } },
			{ "ApplyWholePresetToCurrentTarget", 0x4CFB0,
			  { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x55, 0x57,
				0x41, 0x56, 0x48, 0x8D, 0xAC, 0x24, 0xE0, 0xFD, 0xFF, 0xFF, 0x48, 0x81 } },
			{ "Remove", 0x36EF0,
			  { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x48, 0x89,
				0x7C, 0x24, 0x20, 0x55, 0x41, 0x56, 0x41, 0x57, 0x48, 0x8D, 0x6C, 0x24 } },
			{ "QueueRescanReapply", 0x32B80,
			  { 0x48, 0x83, 0xEC, 0x68, 0x48, 0x8D, 0x0D, 0x95, 0xF8, 0x15, 0x00, 0xE8,
				0xBC, 0xEA, 0x0B, 0x00, 0x85, 0xC0, 0x0F, 0x85, 0x81, 0x00, 0x00, 0x00 } },
			{ "VisualRuleResetForCurrentTarget", 0x47E10,
			  { 0x48, 0x89, 0x74, 0x24, 0x18, 0x4C, 0x89, 0x74, 0x24, 0x20, 0x55, 0x48,
				0x8D, 0x6C, 0x24, 0xD0, 0x48, 0x81, 0xEC, 0x30, 0x01, 0x00, 0x00, 0x48 } },
		};

		// The assignment store: an MSVC std::unordered_map whose list-head
		// sentinel POINTER lives at this module global (null before first use).
		constexpr std::uint32_t kStoreHeadRva = 0x1AA2B8;

		// Explicit MSVC-x64 ABI for the string_view arg: rcx points at a
		// 16-byte { const char* data; size_t len } pair. Declared as a POD
		// struct (not std::string_view*) so the shape is unmistakable.
		struct SvPair
		{
			const char* data;
			std::size_t len;
		};

		using SetTargetFn = void(__fastcall*)(RE::Actor*);
		using ApplyFn = bool(__fastcall*)(SvPair*);
		using RemoveFn = bool(__fastcall*)(std::uint32_t);
		using QueueRescanFn = void(__fastcall*)();
		using VisualResetFn = void(__fastcall*)();

		bool                 g_gateTried = false;   // probe ran (verdict cached)
		bool                 g_gateOk = false;
		std::string          g_whyNot;
		const unsigned char* g_base = nullptr;
		SetTargetFn          g_setTarget = nullptr;
		ApplyFn              g_apply = nullptr;
		RemoveFn             g_remove = nullptr;
		QueueRescanFn        g_queueRescan = nullptr;
		VisualResetFn        g_visualReset = nullptr;

		// GetModuleHandle, never LoadLibrary: if SKSE didn't load SkinShift we
		// must not load a second copy behind its back — absent means absent.
		void Probe()
		{
			if (g_gateTried)
				return;
			g_gateTried = true;

			const HMODULE mod = ::GetModuleHandleW(L"SkinShift.dll");
			if (!mod) {
				g_whyNot = "SkinShift isn't loaded";
				return;
			}
			const auto* base = reinterpret_cast<const unsigned char*>(mod);

			// Image bounds, so a wildly-different build can't even be READ out
			// of range by the AOB checks below.
			std::uint32_t imageSize = 0;
			const auto*   dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
			if (dos->e_magic == IMAGE_DOS_SIGNATURE) {
				const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
				if (nt->Signature == IMAGE_NT_SIGNATURE)
					imageSize = nt->OptionalHeader.SizeOfImage;
			}

			for (const auto& site : kSites) {
				if (imageSize < site.rva + sizeof(site.aob) ||
					std::memcmp(base + site.rva, site.aob, sizeof(site.aob)) != 0) {
					logger::warn(
						"skinshift: prologue mismatch at {} (SkinShift.dll+{:#x}) — "
						"Skins integration disabled (image size {:#x})",
						site.name, site.rva, imageSize);
					g_whyNot =
						"SkinShift's version isn't the one SkyManager knows — "
						"the Skins tab needs an update";
					return;
				}
			}

			g_base = base;
			g_setTarget = reinterpret_cast<SetTargetFn>(const_cast<unsigned char*>(base) + kSites[0].rva);
			g_apply = reinterpret_cast<ApplyFn>(const_cast<unsigned char*>(base) + kSites[1].rva);
			g_remove = reinterpret_cast<RemoveFn>(const_cast<unsigned char*>(base) + kSites[2].rva);
			g_queueRescan = reinterpret_cast<QueueRescanFn>(const_cast<unsigned char*>(base) + kSites[3].rva);
			g_visualReset = reinterpret_cast<VisualResetFn>(const_cast<unsigned char*>(base) + kSites[4].rva);
			g_gateOk = true;
			// Marker (hd-markers.json: "skinshift-bridge").
			logger::info("skinshift: bridge bound — all 5 call sites verified at {}",
				static_cast<const void*>(base));
		}

		// ---- the assignment-store read (SEH-guarded) ---------------------
		// Walks SkinShift's own unordered_map node list for this actor's stored
		// base preset name. Node layout (MSVC): +0x00 next, +0x08 prev,
		// +0x10 uint32 actorFormId, +0x18 std::string base (SSO buffer or heap
		// pointer at +0x18, size +0x28, capacity +0x30; capacity >= 16 means
		// the qword at +0x18 is a char*). POD locals ONLY — SEH cannot coexist
		// with C++ unwinding in one function (the finance.cpp ReadGold
		// precedent), so this lives alone and any fault or absurd value maps
		// to "state unknown", never a CTD.
		// Returns 0 = walked clean (*outFound says whether she has one),
		//         1 = fault / absurd data -> report the state as unknown.
		__declspec(noinline) int WalkStoreRaw(
			const unsigned char* base, std::uint32_t wantId,
			char* outName, std::size_t outCap, int* outFound)
		{
			__try {
				*outFound = 0;
				outName[0] = 0;
				const unsigned char* head =
					*reinterpret_cast<const unsigned char* const*>(base + kStoreHeadRva);
				if (!head)
					return 0;  // map never constructed -> no assignments at all
				const unsigned char* node =
					*reinterpret_cast<const unsigned char* const*>(head);
				int guard = 0;
				while (node && node != head) {
					if (++guard > 4096)
						return 1;  // absurd list -> unknown
					const std::uint32_t actorId =
						*reinterpret_cast<const std::uint32_t*>(node + 0x10);
					const std::size_t size =
						*reinterpret_cast<const std::size_t*>(node + 0x28);
					const std::size_t cap =
						*reinterpret_cast<const std::size_t*>(node + 0x30);
					if (size > 128)
						return 1;  // absurd string -> unknown
					if (actorId == wantId) {
						const char* data = (cap >= 16) ?
						                       *reinterpret_cast<const char* const*>(node + 0x18) :
						                       reinterpret_cast<const char*>(node + 0x18);
						if (!data)
							return 1;
						std::size_t n = (size < outCap - 1) ? size : (outCap - 1);
						for (std::size_t i = 0; i < n; ++i)
							outName[i] = data[i];
						outName[n] = 0;
						*outFound = 1;
						return 0;
					}
					node = *reinterpret_cast<const unsigned char* const*>(node);
				}
				return 0;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return 1;
			}
		}

		// ---- the preset scan ---------------------------------------------
		// Data/textures/removenormals/presets/Preset01..Preset99 through the
		// MO2 VFS — plain std::filesystem works in-process (the anim scanner
		// walks Data/meshes the same way). Cheap (<= 99 dirs x ~13 stats) but
		// still lazy: first SkinsJson call, cached after, `force` rescans.
		struct Preset
		{
			std::string key;   // folder name, e.g. "Preset07"
			std::string name;  // name.txt first line, or the key
			int         files; // present texture files (of 12 possible)
		};

		std::vector<Preset> g_presets;
		bool                g_scanned = false;

		// ---- the deck's own applied-skin record --------------------------
		// First play-test (2026-08-15): the store walk above did NOT find the
		// assignments the applies had just stored (ok=true), so the clear row
		// wrongly disabled. Root truth for "what did the deck put on her" is
		// therefore OURS to keep: every successful apply/clear lands in a
		// sidecar (item-explorer.json precedent — writes go to MO2 Overwrite),
		// keyed by the BASE form's durable identity (plugin + file-width-
		// masked local id, the rooms ignore-list rule: the person, not one
		// reference). The walk stays as a bonus read; the sidecar decides.
		nlohmann::json g_applied;         // { "<plugin>|<localHex>": {key,name} }
		bool           g_appliedLoaded = false;

		std::filesystem::path AppliedPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" /
			       "skinshift-applied.json";
		}

		void LoadApplied()
		{
			if (g_appliedLoaded)
				return;
			g_appliedLoaded = true;
			g_applied = nlohmann::json::object();
			std::ifstream in(AppliedPath(), std::ios::binary);
			if (!in)
				return;
			try {
				auto j = nlohmann::json::parse(in, nullptr, true, true);
				if (j.is_object() && j.contains("applied") && j["applied"].is_object())
					g_applied = j["applied"];
			} catch (...) {
				logger::warn("skinshift: applied sidecar unreadable — starting empty");
			}
		}

		void SaveApplied()
		{
			const auto path = AppliedPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("skinshift: could not write {}", tmp.string());
					return;
				}
				nlohmann::json j;
				j["applied"] = g_applied;
				out << j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("skinshift: applied sidecar rename failed: {}", ec.message());
		}

		// Durable identity of the PERSON: base form's plugin + file-width-
		// masked local id. A dynamic base (0xFF…, no file) falls back to the
		// runtime id — only session-stable, but better than losing the chip.
		std::string IdentityOf(RE::Actor* a)
		{
			char buf[300];
			if (auto* base = a ? a->GetActorBase() : nullptr) {
				if (auto* file = base->GetFile(0)) {
					const auto local =
						base->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
					std::snprintf(buf, sizeof(buf), "%s|%06X",
						file->GetFilename().data(), local);
					return buf;
				}
			}
			std::snprintf(buf, sizeof(buf), "runtime|%08X",
				a ? a->GetFormID() : 0u);
			return buf;
		}

		std::string Trim(std::string s)
		{
			const auto sp = [](unsigned char c) { return std::isspace(c) != 0; };
			while (!s.empty() && sp(static_cast<unsigned char>(s.back())))
				s.pop_back();
			std::size_t i = 0;
			while (i < s.size() && sp(static_cast<unsigned char>(s[i])))
				++i;
			return s.substr(i);
		}

		void EnsureScan(bool force)
		{
			if (g_scanned && !force)
				return;
			g_scanned = true;
			g_presets.clear();

			static const char* kParts[] = { "Body", "Hands", "Feet", "Head" };
			static const char* kTex[] = { "diffuse.dds", "normal_msn.dds", "specular_s.dds" };

			const std::filesystem::path root =
				std::filesystem::path("Data") / "textures" / "removenormals" / "presets";
			std::error_code ec;
			if (!std::filesystem::exists(root, ec))
				return;

			for (int i = 1; i <= 99; ++i) {
				char key[16];
				std::snprintf(key, sizeof(key), "Preset%02d", i);
				const auto dir = root / key;
				if (!std::filesystem::is_directory(dir, ec))
					continue;

				int files = 0;
				for (const char* part : kParts)
					for (const char* tex : kTex)
						if (std::filesystem::exists(dir / part / tex, ec))
							++files;
				// SkinShift itself refuses a zero-file preset, so listing one
				// would only manufacture a doomed Apply — skip it entirely.
				if (files == 0)
					continue;

				// name.txt first line = display name; missing/empty falls back
				// to the folder key. Placeholder text (Preset01 ships "Name
				// Here" on this rig) is deliberately shown as-is.
				std::string name;
				if (std::ifstream in{ dir / "name.txt" }; in)
					std::getline(in, name);
				name = Trim(name);
				if (name.empty())
					name = key;

				g_presets.push_back(Preset{ key, name, files });
			}
			logger::info("skinshift: preset scan found {} usable preset(s)", g_presets.size());
		}

		bool SameName(const std::string& a, const std::string& b)
		{
			if (a.size() != b.size())
				return false;
			for (std::size_t i = 0; i < a.size(); ++i)
				if (std::tolower(static_cast<unsigned char>(a[i])) !=
					std::tolower(static_cast<unsigned char>(b[i])))
					return false;
			return true;
		}

		// Stored base name (key OR display name) -> the display name we show.
		std::string DisplayFor(const std::string& base)
		{
			for (const auto& p : g_presets)
				if (SameName(p.key, base) || SameName(p.name, base))
					return p.name;
			return base;
		}

		RE::Actor* ActorFor(std::uint32_t formId)
		{
			if (!formId)
				return nullptr;
			return RE::TESForm::LookupByID<RE::Actor>(formId);
		}

		std::string NameOf(RE::Actor* a)
		{
			const char* raw = a ? a->GetDisplayFullName() : nullptr;
			return (raw && *raw) ? raw : "them";
		}

		std::string Dump(const nlohmann::json& j)
		{
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// The effects reply shape (fxResult): { ok, msg, id, on }.
		std::string Reply(bool ok, const std::string& msg, const std::string& id, bool on)
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["msg"] = msg;
			j["id"] = id;
			j["on"] = on;
			return Dump(j);
		}
	}

	bool Available(std::string* whyNot)
	{
		Probe();
		if (!g_gateOk && whyNot)
			*whyNot = g_whyNot;
		return g_gateOk;
	}

	nlohmann::json SkinsJson(std::uint32_t formId)
	{
		nlohmann::json s;
		s["present"] = ::GetModuleHandleW(L"SkinShift.dll") != nullptr;

		std::string why;
		const bool avail = Available(&why);
		s["available"] = avail;
		if (!avail) {
			s["reason"] = why;
			return s;
		}

		EnsureScan(false);
		auto arr = nlohmann::json::array();
		for (const auto& p : g_presets) {
			nlohmann::json e;
			e["key"] = p.key;
			e["name"] = p.name;
			e["files"] = p.files;
			arr.push_back(e);
		}
		s["presets"] = arr;

		// Current assignment: the deck's OWN record decides (first play-test:
		// the store walk missed assignments the applies had just made, so it
		// is a bonus read only — used when the sidecar has nothing, never
		// trusted for "she has none").
		s["unknown"] = false;
		s["current"] = nullptr;
		s["currentName"] = nullptr;
		s["source"] = nullptr;

		LoadApplied();
		if (auto* a = ActorFor(formId)) {
			const auto ident = IdentityOf(a);
			if (auto it = g_applied.find(ident);
				it != g_applied.end() && it->is_object()) {
				const auto key = it->value("key", std::string(""));
				if (!key.empty()) {
					s["current"] = key;
					s["currentName"] = it->value("name", DisplayFor(key));
					s["source"] = "deck";
					return s;
				}
			}
		}

		char buf[160];
		int  found = 0;
		if (WalkStoreRaw(g_base, formId, buf, sizeof(buf), &found) != 0) {
			s["unknown"] = true;
		} else if (found) {
			s["current"] = std::string(buf);
			s["currentName"] = DisplayFor(buf);
			s["source"] = "store";
		}
		return s;
	}

	std::string Apply(std::uint32_t formId, const std::string& presetKey)
	{
		const std::string id = "skinshift:" + presetKey;
		std::string       why;
		if (!Available(&why))
			return Reply(false, why, id, true);
		if (presetKey.empty())
			return Reply(false, "no preset named", id, true);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, true);

		EnsureScan(false);
		const std::string display = DisplayFor(presetKey);

		// SetTargetActor immediately before the apply — it latches the
		// current-target FormID into SkinShift's global, which is what
		// ApplyWholePresetToCurrentTarget reads (no actor-arg overload).
		g_setTarget(a);
		SvPair     sv{ presetKey.c_str(), presetKey.size() };
		const bool ok = g_apply(&sv);
		// Marker (hd-markers.json: "skinshift-apply").
		logger::info("skinshift: apply '{}' -> {:08X} ok={}", presetKey, formId, ok);

		if (!ok)
			return Reply(false,
				"SkinShift couldn't apply '" + display +
					"' — no target, unknown preset, or its texture files are missing",
				id, true);

		// Record what WE put on her — this is what the current-skin chip and
		// the clear row's copy run on (the store walk proved unreliable live).
		LoadApplied();
		g_applied[IdentityOf(a)] = { { "key", presetKey }, { "name", display } };
		SaveApplied();

		// On success SkinShift stored the assignment AND kicked its own apply
		// pipeline (immediate attempt + self-queued retries) — fire once, no
		// polling. The save/area caveat is the mod's own documented behavior.
		return Reply(true,
			display + " applied — " + NameOf(a) +
				"'s skin will change in a moment (it settles fully after a save "
				"or area change if it doesn't show at once)",
			id, true);
	}

	std::string Clear(std::uint32_t formId)
	{
		std::string why;
		if (!Available(&why))
			return Reply(false, why, "skinshift:clear", false);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", "skinshift:clear", false);

		// SkinShift's own "Clear Target Setting" button does exactly this:
		// latch the target, Remove(formId), and on success queue the rescan +
		// reset the per-geom visual rules so the look reverts without a
		// reload. There is no synchronous revert in the mod — the old
		// textures can linger until the queued rescan (or an area reload)
		// catches the actor, and the message says so.
		g_setTarget(a);
		const bool had = g_remove(formId);

		// Drop OUR record either way — a stale sidecar entry (e.g. the store
		// forgot her across a load-order change) must not re-arm the chip.
		LoadApplied();
		const bool hadOurs = g_applied.contains(IdentityOf(a));
		if (hadOurs) {
			g_applied.erase(IdentityOf(a));
			SaveApplied();
		}

		if (!had && !hadOurs)
			return Reply(false, NameOf(a) + " has no SkinShift skin applied",
				"skinshift:clear", false);

		if (had) {
			g_queueRescan();
			g_visualReset();
		}
		logger::info("skinshift: cleared {:08X} (store had={} deck had={})",
			formId, had, hadOurs);
		return Reply(true,
			NameOf(a) + " is back to her own skin — the old textures may linger "
			            "until the area reloads",
			"skinshift:clear", false);
	}
}
