#include "skin_actions.h"

#include "skinshift_actions.h"

// pch (force-included) provides RE::/SKSE::, logger, Windows.h (via SKSE) and
// nlohmann json (<json.hpp>).

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;

namespace SkinActions
{
	namespace
	{
		// =====================================================================
		// 1. RaceMenu's PUBLIC interface — the whole point of this module
		// =====================================================================
		//
		// skee64.dll answers an SKSE messaging dispatch with a map of plugin
		// interfaces. This is documented, stable API: no address library, no
		// RVA, no byte signatures. Contrast skinshift_actions.cpp, which has to
		// verify five function prologues before it dares call anything.
		namespace skee
		{
			class IPluginInterface
			{
			public:
				virtual ~IPluginInterface() = default;
				virtual std::uint32_t GetVersion() = 0;
				virtual void          Revert() = 0;
			};

			class IInterfaceMap
			{
			public:
				virtual IPluginInterface* QueryInterface(const char* name) = 0;
				virtual bool              AddInterface(const char* name, IPluginInterface* iface) = 0;
				virtual IPluginInterface* RemoveInterface(const char* name) = 0;
			};

			struct InterfaceExchangeMessage
			{
				enum : std::uint32_t
				{
					kExchangeInterface = 0x9E3779B9
				};
				IInterfaceMap* interfaceMap{};
			};

			// RaceMenu's Override interface, version 2 — the COMPLETE virtual
			// surface in upstream order. Every entry must stay, including the
			// armour half we never call: dropping one shifts AddSkinOverride
			// and AddNodeOverride onto the wrong vtable slots, and calling the
			// wrong slot with these arguments is a crash, not a misbehaviour.
			class IOverrideInterfaceV2 : public IPluginInterface
			{
			public:
				class GetVariant
				{
				public:
					virtual void Int(std::int32_t) = 0;
					virtual void Float(float) = 0;
					virtual void String(const char*) = 0;
					virtual void Bool(bool) = 0;
					virtual void TextureSet(const RE::BGSTextureSet*) = 0;
				};

				class SetVariant
				{
				public:
					enum class Type
					{
						None,
						Int,
						Float,
						String,
						Bool,
						TextureSet
					};
					virtual Type               GetType() { return Type::None; }
					virtual std::int32_t       Int() { return 0; }
					virtual float              Float() { return 0.0f; }
					virtual const char*        String() { return nullptr; }
					virtual bool               Bool() { return false; }
					virtual RE::BGSTextureSet* TextureSet() { return nullptr; }
				};

				virtual bool HasArmorAddonNode(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, bool) = 0;
				virtual bool HasArmorOverride(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, std::uint16_t, std::uint8_t) = 0;
				virtual void AddArmorOverride(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, std::uint16_t, std::uint8_t, SetVariant&) = 0;
				virtual bool GetArmorOverride(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, std::uint16_t, std::uint8_t, GetVariant&) = 0;
				virtual void RemoveArmorOverride(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, std::uint16_t, std::uint8_t) = 0;
				virtual void SetArmorProperties(RE::TESObjectREFR*, bool) = 0;
				virtual void SetArmorProperty(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, std::uint16_t, std::uint8_t, SetVariant&, bool) = 0;
				virtual bool GetArmorProperty(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*, std::uint16_t, std::uint8_t, GetVariant&) = 0;
				virtual void ApplyArmorOverrides(RE::TESObjectREFR*, RE::TESObjectARMO*, RE::TESObjectARMA*, RE::NiAVObject*, bool) = 0;
				virtual void RemoveAllArmorOverrides() = 0;
				virtual void RemoveAllArmorOverridesByReference(RE::TESObjectREFR*) = 0;
				virtual void RemoveAllArmorOverridesByArmor(RE::TESObjectREFR*, bool, RE::TESObjectARMO*) = 0;
				virtual void RemoveAllArmorOverridesByAddon(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*) = 0;
				virtual void RemoveAllArmorOverridesByNode(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, const char*) = 0;
				virtual bool HasNodeOverride(RE::TESObjectREFR*, bool, const char*, std::uint16_t, std::uint8_t) = 0;
				virtual void AddNodeOverride(RE::TESObjectREFR*, bool, const char*, std::uint16_t, std::uint8_t, SetVariant&) = 0;
				virtual bool GetNodeOverride(RE::TESObjectREFR*, bool, const char*, std::uint16_t, std::uint8_t, GetVariant&) = 0;
				virtual void RemoveNodeOverride(RE::TESObjectREFR*, bool, const char*, std::uint16_t, std::uint8_t) = 0;
				virtual void SetNodeProperties(RE::TESObjectREFR*, bool) = 0;
				virtual void SetNodeProperty(RE::TESObjectREFR*, bool, const char*, std::uint16_t, std::uint8_t, SetVariant&, bool) = 0;
				virtual bool GetNodeProperty(RE::TESObjectREFR*, bool, const char*, std::uint16_t, std::uint8_t, GetVariant&) = 0;
				virtual void ApplyNodeOverrides(RE::TESObjectREFR*, RE::NiAVObject*, bool) = 0;
				virtual void RemoveAllNodeOverrides() = 0;
				virtual void RemoveAllNodeOverridesByReference(RE::TESObjectREFR*) = 0;
				virtual void RemoveAllNodeOverridesByNode(RE::TESObjectREFR*, bool, const char*) = 0;
				virtual bool HasSkinOverride(RE::TESObjectREFR*, bool, bool, std::uint32_t, std::uint16_t, std::uint8_t) = 0;
				virtual void AddSkinOverride(RE::TESObjectREFR*, bool, bool, std::uint32_t, std::uint16_t, std::uint8_t, SetVariant&) = 0;
				virtual bool GetSkinOverride(RE::TESObjectREFR*, bool, bool, std::uint32_t, std::uint16_t, std::uint8_t, GetVariant&) = 0;
				virtual void RemoveSkinOverride(RE::TESObjectREFR*, bool, bool, std::uint32_t, std::uint16_t, std::uint8_t) = 0;
				virtual void SetSkinProperties(RE::TESObjectREFR*, bool) = 0;
				virtual void SetSkinProperty(RE::TESObjectREFR*, bool, std::uint32_t, std::uint16_t, std::uint8_t, SetVariant&, bool) = 0;
				virtual bool GetSkinProperty(RE::TESObjectREFR*, bool, std::uint32_t, std::uint16_t, std::uint8_t, GetVariant&) = 0;
				virtual void ApplySkinOverrides(RE::TESObjectREFR*, bool, RE::TESObjectARMO*, RE::TESObjectARMA*, std::uint32_t, RE::NiAVObject*, bool) = 0;
				virtual void RemoveAllSkinOverrides() = 0;
				virtual void RemoveAllSkinOverridesByReference(RE::TESObjectREFR*) = 0;
				virtual void RemoveAllSkinOverridesBySlot(RE::TESObjectREFR*, bool, bool, std::uint32_t) = 0;
			};

			class StringVariant final : public IOverrideInterfaceV2::SetVariant
			{
			public:
				explicit StringVariant(std::string v) :
					_v(std::move(v))
				{}
				Type        GetType() override { return Type::String; }
				const char* String() override { return _v.c_str(); }

			private:
				std::string _v;
			};

			class StringVisitor final : public IOverrideInterfaceV2::GetVariant
			{
			public:
				void Int(std::int32_t) override {}
				void Float(float) override {}
				void String(const char* v) override { _v = v ? v : ""; }
				void Bool(bool) override {}
				void TextureSet(const RE::BGSTextureSet*) override {}

				const std::string& Value() const noexcept { return _v; }

			private:
				std::string _v;
			};
		}

		// ---- the route ------------------------------------------------------
		// Interface version 2 = the native vtable above. Versions 0 and 1 exist
		// on legacy-SE and AE-backport RaceMenu builds and do NOT have it — the
		// same operations are reached there through NiOverride's Papyrus
		// natives, which every RaceMenu has shipped. Anything else fails
		// closed: an unaudited vtable is not something to call blind.
		enum class Route
		{
			unsupported,
			papyrus,  // interface v0 / v1 -> NiOverride Papyrus natives
			nativeV2  // interface v2      -> the vtable, synchronously
		};

		std::mutex             g_bindLock;
		bool                   g_bindTried = false;
		Route                  g_route = Route::unsupported;
		std::uint32_t          g_ifaceVersion = 0;
		std::string            g_whyNot = "RaceMenu hasn't been asked yet";
		skee::IPluginInterface* g_override = nullptr;

		const char* RouteLabel(Route r)
		{
			switch (r) {
			case Route::papyrus:
				return "racemenu-v0-v1-papyrus";
			case Route::nativeV2:
				return "racemenu-v2-native";
			default:
				return "unsupported";
			}
		}

		// The handshake. Lazy on purpose: it needs skee to have registered its
		// listener, and doing it lazily keeps this module out of main.cpp
		// entirely (which carries other sessions' in-flight work — the same
		// reason the whole Skins feature hangs off the existing fxSet).
		void Bind()
		{
			std::scoped_lock lock(g_bindLock);
			if (g_bindTried)
				return;
			g_bindTried = true;

			if (!::GetModuleHandleW(L"skee64.dll")) {
				g_whyNot = "RaceMenu (skee64) isn't loaded";
				return;
			}
			const auto* messaging = SKSE::GetMessagingInterface();
			if (!messaging) {
				g_whyNot = "no SKSE messaging interface";
				return;
			}
			skee::InterfaceExchangeMessage msg{};
			if (!messaging->Dispatch(skee::InterfaceExchangeMessage::kExchangeInterface,
					&msg, sizeof(msg), "skee") ||
				!msg.interfaceMap) {
				g_whyNot = "RaceMenu didn't answer the interface exchange";
				return;
			}
			auto* iface = msg.interfaceMap->QueryInterface("Override");
			if (!iface) {
				g_whyNot = "RaceMenu has no Override interface";
				return;
			}
			const auto version = iface->GetVersion();
			g_ifaceVersion = version;
			if (version == 0 || version == 1) {
				g_route = Route::papyrus;
			} else if (version == 2) {
				g_route = Route::nativeV2;
			} else {
				g_whyNot = "RaceMenu's Override interface is version " +
					std::to_string(version) + ", which SkyManager hasn't audited";
				logger::error("skin-override: refusing unaudited Override interface version {}", version);
				return;
			}
			g_override = iface;
			// Build marker (hd-markers.json: "skin-override-route").
			logger::info("skin-override-route: RaceMenu Override interface v{} -> {}",
				version, RouteLabel(g_route));
		}

		bool Ready(std::string* whyNot)
		{
			Bind();
			if (g_route == Route::unsupported) {
				if (whyNot)
					*whyNot = g_whyNot;
				return false;
			}
			return true;
		}

		skee::IOverrideInterfaceV2* NativeV2()
		{
			return (g_route == Route::nativeV2) ?
				static_cast<skee::IOverrideInterfaceV2*>(g_override) :
				nullptr;
		}

		// The override key we write under. 9 is the shader TEXTURE property;
		// the index is the BSTextureSet slot beneath it.
		constexpr std::uint16_t kTextureKey = 9;

		constexpr std::uint8_t kTexDiffuse = 0;
		constexpr std::uint8_t kTexNormal = 1;
		constexpr std::uint8_t kTexSubsurface = 2;
		constexpr std::uint8_t kTexSpecular = 7;

		const char* TexName(std::uint8_t i)
		{
			switch (i) {
			case kTexDiffuse:
				return "diffuse";
			case kTexNormal:
				return "normal";
			case kTexSubsurface:
				return "subsurface";
			case kTexSpecular:
				return "specular";
			default:
				return "?";
			}
		}

		// =====================================================================
		// 2. Ownership — the answer to "a dark elf turned yellow"
		// =====================================================================
		//
		// RaceMenu stores no owner beside an override key, so the only durable
		// proof that a value is OURS is the value itself: every texture we
		// write lives under one private namespace. Anything else in that slot
		// belongs to somebody (Racial Skin Variance, an overlay mod, the
		// player's own RaceMenu session) and we leave it alone and say so,
		// rather than painting over it and producing a colour nobody chose.
		// Adopted from Body Change NG's SkinOverrideOwnership.h (GPL-3.0).
		constexpr std::string_view kOwnedNeedle = "skymanagerskins\\";

		char NormCh(char c)
		{
			if (c == '/')
				return '\\';
			return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
		}

		bool ContainsNorm(std::string_view hay, std::string_view needle)
		{
			if (needle.empty())
				return true;
			if (needle.size() > hay.size())
				return false;
			for (std::size_t off = 0; off + needle.size() <= hay.size(); ++off) {
				bool eq = true;
				for (std::size_t k = 0; k < needle.size(); ++k) {
					if (NormCh(hay[off + k]) != NormCh(needle[k])) {
						eq = false;
						break;
					}
				}
				if (eq)
					return true;
			}
			return false;
		}

		bool IsOurs(std::string_view value) { return ContainsNorm(value, kOwnedNeedle); }

		// Empty slot, or one we already own. Anything else is somebody's.
		bool MayReplace(const std::string& current) { return current.empty() || IsOurs(current); }

		// =====================================================================
		// 3. The catalogue — what a "skin pack" is on disk
		// =====================================================================
		//
		// Two roots, both read through the MO2 VFS exactly as the game reads
		// everything else (relative "Data\..." paths, the pubes_actions.cpp
		// idiom):
		//
		//   Data\Textures\SkyManagerSkins\<pack>\...   — native layout. The
		//       files already sit under Data\Textures, so the value we hand
		//       RaceMenu IS the path on disk. Nothing is copied, ever.
		//
		//   Data\BodySkin\<pack>\Textures\...          — the layout Body Change
		//       NG documents, so a pack someone already installed works here.
		//       Those files are NOT under Data\Textures, so the engine cannot
		//       load them by name; the channels we actually apply are copied
		//       once into Data\Textures\SkyManagerSkins\cache\<pack>\… (which
		//       lands in MO2's Overwrite, same as every other file we bake).
		constexpr const char* kNativeRoot = "Data\\Textures\\SkyManagerSkins";
		constexpr const char* kCompatRoot = "Data\\BodySkin";
		constexpr const char* kCacheLeaf = "cache";

		// A skin is described per (race, sex): the folder its textures live in
		// and the file stem of each part. Only these two things vary, which is
		// why one table covers humans and both beast races.
		struct PartDef
		{
			const char* part;  // "body" | "hands" | "feet" | "head"
			const char* stem;  // file stem inside the race folder
		};

		struct LayoutDef
		{
			const char* key;     // catalogue row suffix
			const char* label;   // human words for the row
			const char* race;    // "human" | "argonian" | "khajiit"
			const char* sex;     // "female" | "male"
			const char* folder;  // under textures\actors\character\…
			PartDef     parts[4];
		};

		// Vanilla file names, which is what every skin pack replaces. Male feet
		// have no separate texture in vanilla (the body atlas covers them), so
		// the male rows carry three parts and the fourth is a null stem.
		constexpr LayoutDef kLayouts[] = {
			{ "female", "Female", "human", "female", "female",
			  { { "body", "femalebody_1" }, { "hands", "femalehands_1" },
				{ "feet", "femalefeet_1" }, { "head", "femalehead" } } },
			{ "male", "Male", "human", "male", "male",
			  { { "body", "malebody_1" }, { "hands", "malehands_1" },
				{ "head", "malehead" }, { nullptr, nullptr } } },
			{ "argonian-female", "Argonian female", "argonian", "female", "argonianfemale",
			  { { "body", "argonianfemalebody" }, { "hands", "argonianfemalehands" },
				{ "head", "argonianfemalehead" }, { nullptr, nullptr } } },
			{ "argonian-male", "Argonian male", "argonian", "male", "argonianmale",
			  { { "body", "argonianmalebody" }, { "hands", "argonianmalehands" },
				{ "head", "argonianmalehead" }, { nullptr, nullptr } } },
			{ "khajiit-female", "Khajiit female", "khajiit", "female", "khajiitfemale",
			  { { "body", "femalebody" }, { "hands", "femalehands" },
				{ "head", "femalehead" }, { nullptr, nullptr } } },
			{ "khajiit-male", "Khajiit male", "khajiit", "male", "khajiitmale",
			  { { "body", "bodymale" }, { "hands", "handsmale" },
				{ "head", "headmale" }, { nullptr, nullptr } } },
		};

		// Channel suffix -> BSTextureSet slot. The empty suffix is the diffuse.
		struct ChannelDef
		{
			const char*   suffix;
			std::uint8_t  index;
		};

		constexpr ChannelDef kChannels[] = {
			{ "", kTexDiffuse },
			{ "_msn", kTexNormal },
			{ "_sk", kTexSubsurface },
			{ "_s", kTexSpecular },
		};

		// UBE 2.0 keeps its own UV namespace and its own suffix scheme, so it
		// is a layout of its own rather than a special case sprinkled through
		// the one above. Its body atlas covers hands and feet as well.
		struct UbeFile
		{
			const char*  rel;
			std::uint8_t index;
		};

		constexpr UbeFile kUbeBody[] = {
			{ "!UBE\\Body\\femalebody_1_d.dds", kTexDiffuse },
			{ "!UBE\\Body\\femalebody_1_n.dds", kTexNormal },
			{ "!UBE\\Body\\femalebody_1_sk.dds", kTexSubsurface },
		};
		constexpr UbeFile kUbeHead[] = {
			{ "!UBE\\Head\\femalehead_d.dds", kTexDiffuse },
			{ "!UBE\\Head\\femalehead_n.dds", kTexNormal },
			{ "!UBE\\Head\\femalehead_sk.dds", kTexSubsurface },
		};

		// One resolved texture: which slot of which part, and the value we hand
		// RaceMenu (a path relative to Data\Textures — that is what the engine
		// resolves a texture name against).
		struct Layer
		{
			std::string  part;      // body | hands | feet | head
			std::uint8_t index{};   // BSTextureSet slot
			std::string  value;     // "SkyManagerSkins\Pack\…\x.dds"
			std::string  source;    // absolute-ish disk path (compat root only)
		};

		struct Row
		{
			std::string        key;     // "<pack>::<layout>"
			std::string        pack;
			std::string        name;    // display
			std::string        layout;  // kLayouts[].key or "ube"
			std::string        race;
			std::string        sex;
			bool               compat{};  // needs the cache copy
			std::vector<Layer> layers;
		};

		std::mutex       g_catLock;
		bool             g_scanned = false;
		std::vector<Row> g_rows;
		int              g_nativePacks = 0;
		int              g_compatPacks = 0;

		std::string PathU8(const fs::path& p)
		{
			const auto s = p.u8string();
			return std::string(s.begin(), s.end());
		}

		bool FileThere(const fs::path& p)
		{
			std::error_code ec;
			return fs::is_regular_file(p, ec) && !ec;
		}

		// Build the value string for a file that already lives under
		// Data\Textures: everything after "Data\Textures\".
		std::string ValueUnderTextures(const std::string& packRelative)
		{
			return "SkyManagerSkins\\" + packRelative;
		}

		// Scan one pack folder for every layout it satisfies. `texRoot` is the
		// folder that plays the role of Data\Textures for this pack.
		void ScanPack(const std::string& pack, const fs::path& texRoot, bool compat,
			std::vector<Row>& out)
		{
			const fs::path charRoot = texRoot / "actors" / "character";

			for (const auto& lay : kLayouts) {
				Row row;
				for (const auto& pd : lay.parts) {
					if (!pd.part)
						break;
					for (const auto& ch : kChannels) {
						const std::string file =
							std::string(pd.stem) + ch.suffix + ".dds";
						const fs::path abs = charRoot / lay.folder / file;
						if (!FileThere(abs))
							continue;
						Layer l;
						l.part = pd.part;
						l.index = ch.index;
						l.value = ValueUnderTextures(
							(compat ? (std::string(kCacheLeaf) + "\\" + pack) : pack) +
							"\\actors\\character\\" + lay.folder + "\\" + file);
						l.source = PathU8(abs);
						row.layers.push_back(std::move(l));
					}
				}
				// A pack that ships no DIFFUSE for any part is not a skin for
				// this race/sex — a lone normal map is a patch, not a row you
				// can offer someone.
				const bool anyDiffuse =
					std::any_of(row.layers.begin(), row.layers.end(),
						[](const Layer& l) { return l.index == kTexDiffuse; });
				if (!anyDiffuse)
					continue;
				row.pack = pack;
				row.layout = lay.key;
				row.race = lay.race;
				row.sex = lay.sex;
				row.compat = compat;
				row.key = pack + "::" + lay.key;
				row.name = pack + " — " + lay.label;
				out.push_back(std::move(row));
			}

			// UBE: recognised by its own atlas folders. Female only, by
			// construction — UBE 2.0 ships no male namespace.
			Row ube;
			auto addUbe = [&](const UbeFile* files, std::size_t n, const char* part) {
				for (std::size_t i = 0; i < n; ++i) {
					const fs::path abs = texRoot / files[i].rel;
					if (!FileThere(abs))
						continue;
					Layer l;
					l.part = part;
					l.index = files[i].index;
					l.value = ValueUnderTextures(
						(compat ? (std::string(kCacheLeaf) + "\\" + pack) : pack) +
						"\\" + files[i].rel);
					l.source = PathU8(abs);
					ube.layers.push_back(std::move(l));
				}
			};
			addUbe(kUbeBody, std::size(kUbeBody), "body");
			addUbe(kUbeHead, std::size(kUbeHead), "head");
			if (!ube.layers.empty()) {
				ube.pack = pack;
				ube.layout = "ube";
				ube.race = "human";
				ube.sex = "female";
				ube.compat = compat;
				ube.key = pack + "::ube";
				ube.name = pack + " — UBE";
				out.push_back(std::move(ube));
			}
		}

		void ScanRoot(const char* root, bool compat, std::vector<Row>& out, int& packCount)
		{
			std::error_code ec;
			const fs::path  base(root);
			if (!fs::is_directory(base, ec) || ec)
				return;
			for (const auto& e : fs::directory_iterator(base, ec)) {
				if (ec)
					break;
				if (!e.is_directory())
					continue;
				const std::string pack = PathU8(e.path().filename());
				if (pack.empty() || pack[0] == '.')
					continue;
				// The cache we write ourselves is not a pack.
				if (!compat && pack == kCacheLeaf)
					continue;
				const fs::path texRoot = compat ? (e.path() / "Textures") : e.path();
				if (!fs::is_directory(texRoot, ec))
					continue;
				const auto before = out.size();
				ScanPack(pack, texRoot, compat, out);
				if (out.size() != before)
					++packCount;
			}
		}

		void EnsureScan(bool force)
		{
			std::scoped_lock lock(g_catLock);
			if (g_scanned && !force)
				return;
			g_scanned = true;
			g_rows.clear();
			g_nativePacks = g_compatPacks = 0;
			ScanRoot(kNativeRoot, false, g_rows, g_nativePacks);
			ScanRoot(kCompatRoot, true, g_rows, g_compatPacks);
			// Build marker (hd-markers.json: "skin-catalog").
			logger::info("skin-catalog: {} row(s) from {} native pack(s) + {} BodySkin pack(s)",
				g_rows.size(), g_nativePacks, g_compatPacks);
		}

		const Row* RowFor(const std::string& key)
		{
			for (const auto& r : g_rows)
				if (r.key == key)
					return &r;
			return nullptr;
		}

		// Copy a compat-layout file under Data\Textures once, so the engine can
		// load it by name. Cheap after the first time (existence check only).
		bool EnsureCached(const Layer& l, std::string& why)
		{
			if (l.source.empty())
				return true;
			const fs::path dst = fs::path("Data") / "Textures" / l.value;
			std::error_code ec;
			if (fs::is_regular_file(dst, ec) && !ec)
				return true;
			fs::create_directories(dst.parent_path(), ec);
			ec.clear();
			fs::copy_file(fs::path(l.source), dst, fs::copy_options::overwrite_existing, ec);
			if (ec) {
				why = "couldn't stage " + l.value + " (" + ec.message() + ")";
				return false;
			}
			logger::info("skin-cache: staged {}", l.value);
			return true;
		}

		// =====================================================================
		// 4. The actor: who she is, and where her face is
		// =====================================================================

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

		std::string Reply(bool ok, const std::string& msg, const std::string& id, bool on)
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["msg"] = msg;
			j["id"] = id;
			j["on"] = on;
			return Dump(j);
		}

		bool IsFemale(RE::Actor* a)
		{
			auto* base = a ? a->GetActorBase() : nullptr;
			return base && base->IsFemale();
		}

		std::string LowerOf(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// Beast races are their own texture namespace — a humanoid skin on an
		// Argonian is not a look, it is a bug. Identity comes from the race's
		// editor id, which is what every beast-aware mod keys on.
		std::string RaceKindOf(RE::Actor* a)
		{
			auto* base = a ? a->GetActorBase() : nullptr;
			auto* race = base ? base->GetRace() : nullptr;
			const char* edid = race ? race->GetFormEditorID() : nullptr;
			const std::string id = LowerOf(edid ? edid : "");
			if (id.find("argonian") != std::string::npos)
				return "argonian";
			if (id.find("khajiit") != std::string::npos)
				return "khajiit";
			return "human";
		}

		// The facegen head is a NODE override, not a skin-slot one, so we need
		// the name of the live geometry. Read it off the loaded 3D exactly the
		// way skinshift_actions.cpp's readback does: the engine types the head
		// with the kFaceGen material feature, so no name-guessing is involved.
		std::string FaceNodeOf(RE::Actor* a)
		{
			RE::NiAVObject* root = a ? a->Get3D() : nullptr;
			if (!root)
				return {};
			std::string found;
			RE::BSVisit::TraverseScenegraphGeometries(root,
				[&found](RE::BSGeometry* geom) -> RE::BSVisit::BSVisitControl {
					if (!geom)
						return RE::BSVisit::BSVisitControl::kContinue;
					auto* prop = geom->GetGeometryRuntimeData()
									 .properties[RE::BSGeometry::States::kEffect]
									 .get();
					auto* lsp = netimmerse_cast<RE::BSLightingShaderProperty*>(prop);
					auto* mat = lsp ?
						static_cast<RE::BSLightingShaderMaterialBase*>(lsp->material) :
						nullptr;
					if (!mat || mat->GetFeature() != RE::BSShaderMaterial::Feature::kFaceGen)
						return RE::BSVisit::BSVisitControl::kContinue;
					const char* nm = geom->name.c_str();
					if (nm && *nm) {
						found = nm;
						return RE::BSVisit::BSVisitControl::kStop;
					}
					return RE::BSVisit::BSVisitControl::kContinue;
				});
			return found;
		}

		// Biped slot masks. Body 32, hands 33, feet 37 — the slots a skin
		// ArmorAddon actually occupies, which is what a skin override is keyed
		// on.
		std::uint32_t MaskForPart(const std::string& part)
		{
			if (part == "body")
				return static_cast<std::uint32_t>(RE::BGSBipedObjectForm::BipedObjectSlot::kBody);
			if (part == "hands")
				return static_cast<std::uint32_t>(RE::BGSBipedObjectForm::BipedObjectSlot::kHands);
			if (part == "feet")
				return static_cast<std::uint32_t>(RE::BGSBipedObjectForm::BipedObjectSlot::kFeet);
			return 0;
		}

		// =====================================================================
		// 5. Writing an override — the two routes
		// =====================================================================

		// The house idiom (chim_control.cpp, trade_actions.cpp): the concrete
		// singleton, which IS the IVirtualMachine every dispatch takes.
		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		// The Papyrus route's ownership read: NiOverride hands the current
		// value back through a callback on the VM's thread, and the WRITE
		// happens inside it. That is the whole reason this route is async —
		// blocking the main thread on the VM is never an option.
		class StringResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit StringResult(std::function<void(std::string)> then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				std::string value;
				if (a_result.IsString())
					value = std::string(a_result.GetString());
				auto then = _then;
				if (!then)
					return;
				// Hop back to the main thread: the continuation talks to the VM
				// and to the actor's 3D.
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([then, value]() { then(value); });
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(std::string)> _then;
		};

		void PapyrusAddSkin(RE::Actor* a, bool female, bool firstPerson, std::uint32_t mask,
			std::uint8_t index, const std::string& value)
		{
			auto* vm = Vm();
			if (!vm)
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(female),
				std::move(firstPerson), static_cast<std::int32_t>(mask),
				static_cast<std::int32_t>(kTextureKey), static_cast<std::int32_t>(index),
				RE::BSFixedString(value), bool{ true });
			vm->DispatchStaticCall("NiOverride", "AddSkinOverrideString", args, cb);
		}

		void PapyrusAddNode(RE::Actor* a, bool female, const std::string& node,
			std::uint8_t index, const std::string& value)
		{
			auto* vm = Vm();
			if (!vm)
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(female),
				RE::BSFixedString(node), static_cast<std::int32_t>(kTextureKey),
				static_cast<std::int32_t>(index), RE::BSFixedString(value), bool{ true });
			vm->DispatchStaticCall("NiOverride", "AddNodeOverrideString", args, cb);
		}

		void PapyrusRemoveSkin(RE::Actor* a, bool female, bool firstPerson, std::uint32_t mask,
			std::uint8_t index)
		{
			auto* vm = Vm();
			if (!vm)
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(female),
				std::move(firstPerson), static_cast<std::int32_t>(mask),
				static_cast<std::int32_t>(kTextureKey), static_cast<std::int32_t>(index));
			vm->DispatchStaticCall("NiOverride", "RemoveSkinOverride", args, cb);
		}

		void PapyrusRemoveNode(RE::Actor* a, bool female, const std::string& node,
			std::uint8_t index)
		{
			auto* vm = Vm();
			if (!vm)
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(female),
				RE::BSFixedString(node), static_cast<std::int32_t>(kTextureKey),
				static_cast<std::int32_t>(index));
			vm->DispatchStaticCall("NiOverride", "RemoveNodeOverride", args, cb);
		}

		void PapyrusGetSkin(RE::Actor* a, bool female, bool firstPerson, std::uint32_t mask,
			std::uint8_t index, std::function<void(std::string)> then)
		{
			auto* vm = Vm();
			if (!vm) {
				then("");
				return;
			}
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> functor(
				new StringResult(std::move(then)));
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(female),
				std::move(firstPerson), static_cast<std::int32_t>(mask),
				static_cast<std::int32_t>(kTextureKey), static_cast<std::int32_t>(index));
			if (!vm->DispatchStaticCall("NiOverride", "GetSkinOverrideString", args, functor))
				logger::warn("skin-override: GetSkinOverrideString dispatch failed");
		}

		void PapyrusGetNode(RE::Actor* a, bool female, const std::string& node,
			std::uint8_t index, std::function<void(std::string)> then)
		{
			auto* vm = Vm();
			if (!vm) {
				then("");
				return;
			}
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> functor(
				new StringResult(std::move(then)));
			auto args = RE::MakeFunctionArguments(std::move(a), std::move(female),
				RE::BSFixedString(node), static_cast<std::int32_t>(kTextureKey),
				static_cast<std::int32_t>(index));
			if (!vm->DispatchStaticCall("NiOverride", "GetNodeOverrideString", args, functor))
				logger::warn("skin-override: GetNodeOverrideString dispatch failed");
		}

		// The refresh. Both routes use the Papyrus one because it is the same
		// call RaceMenu's own consumers make, and it is the one proven to make
		// an override visible without a cell reload.
		void QueueNiNodeUpdate(RE::Actor* a)
		{
			auto* vm = Vm();
			if (!vm || !a)
				return;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return;
			const auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, a);
			if (handle == policy->EmptyHandle())
				return;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(bool{ true });
			vm->DispatchMethodCall(handle, "Actor", "QueueNiNodeUpdate", args, cb);
		}

		// One channel write, ownership-checked, on whichever route is live.
		// `firstPerson` is only ever true for the player (nobody else has a
		// first-person skeleton to paint).
		void WriteSkinChannel(RE::Actor* a, bool female, bool firstPerson, std::uint32_t mask,
			std::uint8_t index, const std::string& value, const std::string& part)
		{
			if (auto* v2 = NativeV2()) {
				skee::StringVisitor cur;
				v2->GetSkinOverride(a, female, firstPerson, mask, kTextureKey, index, cur);
				if (!MayReplace(cur.Value())) {
					logger::warn("skin-override: skipped {:08X} {} {} — owned by '{}'",
						a->GetFormID(), part, TexName(index), cur.Value());
					return;
				}
				skee::StringVariant set(value);
				v2->AddSkinOverride(a, female, firstPerson, mask, kTextureKey, index, set);
				logger::info("skin-override: {:08X} {} {} <- {}", a->GetFormID(), part,
					TexName(index), value);
				return;
			}

			const auto formId = a->GetFormID();
			PapyrusGetSkin(a, female, firstPerson, mask, index,
				[formId, female, firstPerson, mask, index, value, part](std::string cur) {
					auto* live = ActorFor(formId);
					if (!live)
						return;
					if (!MayReplace(cur)) {
						logger::warn("skin-override: skipped {:08X} {} {} — owned by '{}'",
							formId, part, TexName(index), cur);
						return;
					}
					PapyrusAddSkin(live, female, firstPerson, mask, index, value);
					logger::info("skin-override: {:08X} {} {} <- {}", formId, part,
						TexName(index), value);
				});
		}

		void WriteNodeChannel(RE::Actor* a, bool female, const std::string& node,
			std::uint8_t index, const std::string& value)
		{
			if (auto* v2 = NativeV2()) {
				skee::StringVisitor cur;
				v2->GetNodeOverride(a, female, node.c_str(), kTextureKey, index, cur);
				if (!MayReplace(cur.Value())) {
					logger::warn("skin-override: skipped {:08X} face {} — owned by '{}'",
						a->GetFormID(), TexName(index), cur.Value());
					return;
				}
				skee::StringVariant set(value);
				v2->AddNodeOverride(a, female, node.c_str(), kTextureKey, index, set);
				logger::info("skin-override: {:08X} face {} <- {}", a->GetFormID(),
					TexName(index), value);
				return;
			}

			const auto formId = a->GetFormID();
			PapyrusGetNode(a, female, node, index,
				[formId, female, node, index, value](std::string cur) {
					auto* live = ActorFor(formId);
					if (!live)
						return;
					if (!MayReplace(cur)) {
						logger::warn("skin-override: skipped {:08X} face {} — owned by '{}'",
							formId, TexName(index), cur);
						return;
					}
					PapyrusAddNode(live, female, node, index, value);
					logger::info("skin-override: {:08X} face {} <- {}", formId,
						TexName(index), value);
				});
		}

		void ClearSkinChannel(RE::Actor* a, bool female, bool firstPerson, std::uint32_t mask,
			std::uint8_t index)
		{
			if (auto* v2 = NativeV2()) {
				skee::StringVisitor cur;
				v2->GetSkinOverride(a, female, firstPerson, mask, kTextureKey, index, cur);
				if (cur.Value().empty() || !IsOurs(cur.Value()))
					return;  // never remove what we did not put there
				v2->RemoveSkinOverride(a, female, firstPerson, mask, kTextureKey, index);
				return;
			}
			const auto formId = a->GetFormID();
			PapyrusGetSkin(a, female, firstPerson, mask, index,
				[formId, female, firstPerson, mask, index](std::string cur) {
					if (cur.empty() || !IsOurs(cur))
						return;
					if (auto* live = ActorFor(formId))
						PapyrusRemoveSkin(live, female, firstPerson, mask, index);
				});
		}

		void ClearNodeChannel(RE::Actor* a, bool female, const std::string& node,
			std::uint8_t index)
		{
			if (auto* v2 = NativeV2()) {
				skee::StringVisitor cur;
				v2->GetNodeOverride(a, female, node.c_str(), kTextureKey, index, cur);
				if (cur.Value().empty() || !IsOurs(cur.Value()))
					return;
				v2->RemoveNodeOverride(a, female, node.c_str(), kTextureKey, index);
				return;
			}
			const auto formId = a->GetFormID();
			PapyrusGetNode(a, female, node, index,
				[formId, female, node, index](std::string cur) {
					if (cur.empty() || !IsOurs(cur))
						return;
					if (auto* live = ActorFor(formId))
						PapyrusRemoveNode(live, female, node, index);
				});
		}

		// =====================================================================
		// 6. Who is wearing what — our own record
		// =====================================================================
		//
		// RaceMenu persists the overrides themselves (we write them persistent),
		// so a save/load keeps the look. What it cannot tell us is WHICH
		// catalogue row produced it, which is what the tab has to show. That
		// lives in this module's own sidecar — the item-explorer precedent, and
		// deliberately NOT a hotkeys.json slice, which the whole-config save
		// path has eaten twice.
		fs::path StorePath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "skins.json";
		}

		std::mutex                                   g_storeLock;
		bool                                         g_storeLoaded = false;
		std::unordered_map<std::uint32_t, std::string> g_worn;  // formId -> row key

		void LoadStore()
		{
			std::scoped_lock lock(g_storeLock);
			if (g_storeLoaded)
				return;
			g_storeLoaded = true;
			std::ifstream f(StorePath());
			if (!f.good())
				return;
			try {
				nlohmann::json j;
				f >> j;
				for (auto& [k, v] : j.value("actors", nlohmann::json::object()).items()) {
					const auto id = static_cast<std::uint32_t>(std::stoul(k, nullptr, 16));
					const auto key = v.value("row", std::string{});
					if (id && !key.empty())
						g_worn[id] = key;
				}
			} catch (const std::exception& e) {
				logger::warn("skin-store: unreadable ({}) — starting empty", e.what());
			}
		}

		void SaveStore()
		{
			std::scoped_lock lock(g_storeLock);
			nlohmann::json j;
			j["version"] = 1;
			auto actors = nlohmann::json::object();
			for (const auto& [id, key] : g_worn) {
				char hex[16]{};
				std::snprintf(hex, sizeof(hex), "%08X", id);
				actors[hex] = nlohmann::json{ { "row", key } };
			}
			j["actors"] = actors;
			std::error_code ec;
			fs::create_directories(StorePath().parent_path(), ec);
			std::ofstream f(StorePath(), std::ios::trunc);
			if (!f.good()) {
				logger::warn("skin-store: couldn't write {}", PathU8(StorePath()));
				return;
			}
			f << Dump(j);
		}

		std::string WornBy(std::uint32_t formId)
		{
			LoadStore();
			std::scoped_lock lock(g_storeLock);
			const auto it = g_worn.find(formId);
			return it == g_worn.end() ? std::string{} : it->second;
		}
	}

	// =========================================================================
	// Public surface
	// =========================================================================

	bool Available(std::string* whyNot) { return Ready(whyNot); }

	std::string Rescan()
	{
		EnsureScan(true);
		std::scoped_lock lock(g_catLock);
		return Reply(true,
			"Found " + std::to_string(g_rows.size()) + " skin(s) across " +
				std::to_string(g_nativePacks + g_compatPacks) + " pack(s)",
			"skin:rescan", true);
	}

	nlohmann::json SkinsJson(std::uint32_t formId)
	{
		nlohmann::json s;
		s["provider"] = "skymanager";
		s["idPrefix"] = "skin:";
		s["present"] = ::GetModuleHandleW(L"skee64.dll") != nullptr;
		s["unknown"] = false;

		// The readback instrument rides every state read, exactly as it does
		// for the SkinShift block: what her skin geometry is ACTUALLY wearing
		// right now is the only thing that settles "did the swap land".
		auto* a = ActorFor(formId);
		if (a)
			s["live"] = SkinShiftActions::LiveSkinJson(a);

		std::string why;
		const bool  ok = Ready(&why);
		s["available"] = ok;
		s["route"] = RouteLabel(g_route);
		s["interfaceVersion"] = g_ifaceVersion;
		if (!ok) {
			s["reason"] = why;
			return s;
		}

		EnsureScan(false);

		// The roots, always reported — an empty catalogue must say WHERE it
		// looked, or "no skins" reads as broken rather than as empty.
		auto roots = nlohmann::json::array();
		{
			std::scoped_lock lock(g_catLock);
			nlohmann::json nat;
			nat["path"] = "Data\\Textures\\SkyManagerSkins";
			nat["packs"] = g_nativePacks;
			nat["layout"] = "native";
			roots.push_back(std::move(nat));
			nlohmann::json compat;
			compat["path"] = "Data\\BodySkin";
			compat["packs"] = g_compatPacks;
			compat["layout"] = "bodyskin";
			roots.push_back(std::move(compat));
		}
		s["roots"] = roots;

		const bool        female = IsFemale(a);
		const std::string race = a ? RaceKindOf(a) : std::string("human");
		s["actorRace"] = race;
		s["actorSex"] = female ? "female" : "male";

		auto arr = nlohmann::json::array();
		{
			std::scoped_lock lock(g_catLock);
			for (const auto& r : g_rows) {
				nlohmann::json e;
				e["key"] = r.key;
				e["name"] = r.name;
				e["pack"] = r.pack;
				e["layout"] = r.layout;
				e["race"] = r.race;
				e["sex"] = r.sex;
				e["files"] = static_cast<int>(r.layers.size());
				// Which parts it actually covers — a partial pack is legal and
				// the row should say so rather than promise a whole body.
				auto parts = nlohmann::json::array();
				for (const char* p : { "body", "hands", "feet", "head" }) {
					const bool has = std::any_of(r.layers.begin(), r.layers.end(),
						[p](const Layer& l) { return l.part == p; });
					if (has)
						parts.push_back(p);
				}
				e["parts"] = parts;
				// UBE's atlas is a different UV space, so it is only offered
				// beside a UBE body; race/sex must match the actor or the row
				// is shown disabled with the honest reason.
				// With no actor resolved we know nothing about fit, and
				// claiming "doesn't fit" would grey out the whole catalogue on
				// a technicality. Unknown means enabled; Apply re-checks and
				// refuses honestly anyway.
				const bool fits = !a ||
					(r.race == race && r.sex == (female ? "female" : "male"));
				e["fits"] = fits;
				if (!fits)
					e["reason"] = "that pack is for a " + r.sex + " " + r.race;
				arr.push_back(std::move(e));
			}
		}
		s["presets"] = arr;

		const auto worn = WornBy(formId);
		s["current"] = worn.empty() ? nlohmann::json() : nlohmann::json(worn);
		if (!worn.empty()) {
			std::scoped_lock lock(g_catLock);
			const auto* r = RowFor(worn);
			s["currentName"] = r ? r->name : worn;
		}
		return s;
	}

	std::string Apply(std::uint32_t formId, const std::string& key)
	{
		const std::string id = "skin:" + key;

		std::string why;
		if (!Ready(&why))
			return Reply(false, why, id, true);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, true);
		if (!a->Get3D())
			return Reply(false, NameOf(a) + " has no 3D loaded — get closer to her", id, true);

		EnsureScan(false);

		// Copy the row out from under the catalogue lock: applying takes a
		// while (VM dispatch, file staging) and a rescan must not be able to
		// invalidate the pointer under us.
		Row row;
		{
			std::scoped_lock lock(g_catLock);
			const auto* found = RowFor(key);
			if (!found)
				return Reply(false, "that skin isn't in the catalogue any more — rescan?", id, true);
			row = *found;
		}

		const bool        female = IsFemale(a);
		const std::string race = RaceKindOf(a);
		if (row.race != race || row.sex != (female ? "female" : "male"))
			return Reply(false,
				NameOf(a) + " is a " + (female ? "female " : "male ") + race +
					" — that pack is for a " + row.sex + " " + row.race,
				id, true);

		// Stage the compat-layout files under Data\Textures once.
		if (row.compat) {
			std::string staged;
			for (const auto& l : row.layers) {
				if (!EnsureCached(l, staged))
					return Reply(false, staged, id, true);
			}
		}

		const std::string faceNode = FaceNodeOf(a);
		const bool        isPlayer = a->IsPlayerRef();

		int wrote = 0, skippedFace = 0;
		for (const auto& l : row.layers) {
			if (l.part == "head") {
				if (faceNode.empty()) {
					++skippedFace;
					continue;
				}
				WriteNodeChannel(a, female, faceNode, l.index, l.value);
				++wrote;
				continue;
			}
			const auto mask = MaskForPart(l.part);
			if (!mask)
				continue;
			WriteSkinChannel(a, female, false, mask, l.index, l.value, l.part);
			// Only the player has first-person geometry to paint; painting it
			// for anybody else writes a key nothing will ever read.
			if (isPlayer)
				WriteSkinChannel(a, female, true, mask, l.index, l.value, l.part);
			++wrote;
		}

		{
			LoadStore();
			std::scoped_lock lock(g_storeLock);
			g_worn[formId] = row.key;
		}
		SaveStore();

		QueueNiNodeUpdate(a);

		// Build marker (hd-markers.json: "skin-apply").
		logger::info("skin-apply: {:08X} <- '{}' ({} channel(s), route {})", formId, row.key,
			wrote, RouteLabel(g_route));

		std::string msg = row.name + " on " + NameOf(a);
		if (skippedFace)
			msg += " — her face was skipped (no facegen head on the loaded model)";
		else if (g_route == Route::papyrus)
			msg += " — applying";
		return Reply(true, msg, id, true);
	}

	std::string Clear(std::uint32_t formId)
	{
		const std::string id = "skin:clear";

		std::string why;
		if (!Ready(&why))
			return Reply(false, why, id, false);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, false);

		const bool        female = IsFemale(a);
		const bool        isPlayer = a->IsPlayerRef();
		const std::string faceNode = FaceNodeOf(a);

		// Sweep every channel we could ever have written, not just the ones
		// the remembered row covers: the record can be stale (a pack removed,
		// a save rolled back) and a leftover override is exactly the "she is
		// stuck yellow" report. Each removal is still ownership-checked, so a
		// channel somebody else owns is untouched.
		for (const char* part : { "body", "hands", "feet" }) {
			const auto mask = MaskForPart(part);
			for (const auto& ch : kChannels) {
				ClearSkinChannel(a, female, false, mask, ch.index);
				if (isPlayer)
					ClearSkinChannel(a, female, true, mask, ch.index);
			}
		}
		if (!faceNode.empty())
			for (const auto& ch : kChannels)
				ClearNodeChannel(a, female, faceNode, ch.index);

		{
			LoadStore();
			std::scoped_lock lock(g_storeLock);
			g_worn.erase(formId);
		}
		SaveStore();

		QueueNiNodeUpdate(a);

		// Build marker (hd-markers.json: "skin-clear").
		logger::info("skin-clear: {:08X} back to her own skin (route {})", formId,
			RouteLabel(g_route));
		return Reply(true, NameOf(a) + " is back to her own skin", id, false);
	}
}
