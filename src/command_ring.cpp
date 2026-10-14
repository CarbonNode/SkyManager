#include "command_ring.h"

#include "combat_tools.h"
#include "keys_sources.h"
#include "nff_control.h"
#include "party_recall.h"
#include "place_actions.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>

// pch (force-included) provides RE::/SKSE::/logger and, via RE/Skyrim.h,
// <Windows.h> (GetModuleHandleW / GetKeyNameTextW). The cross-module trap:
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace FightWithMeAPI
{
	// Mirrored from Fight With Me's include/FightWithMeAPI.h
	// (github.com/fatalCMD/fight-with-me), INTERFACE_VERSION 1 — the class only.
	// Its header also declares the exports __declspec(dllimport), which would
	// need FightWithMe's import library at link time; we resolve
	// FightWithMe_GetInterface with GetProcAddress instead, so a missing DLL is
	// a "not installed" line rather than a load failure. The vtable order below
	// MUST match the header's: destructor, GetVersion, OpenBattlePlan,
	// IsBattlePlanOpen, GetRole.
	inline constexpr std::uint32_t INTERFACE_VERSION = 1;

	enum class Role : std::int32_t
	{
		kNone = -1,
		kFighter = 0,
		kTank = 1,
		kHealer = 2,
		kBruiser = 3,
		kArcher = 4,
		kMage = 5
	};

	class IFightWithMe
	{
	public:
		virtual ~IFightWithMe() = default;
		[[nodiscard]] virtual std::uint32_t GetVersion() const noexcept = 0;
		virtual void                        OpenBattlePlan() = 0;
		[[nodiscard]] virtual bool          IsBattlePlanOpen() const = 0;
		[[nodiscard]] virtual Role          GetRole(std::uint32_t a_actorFormID) const = 0;
	};
}

namespace CommandRing
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		std::string Dump(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }

		// ---- the table ------------------------------------------------------
		// Words are Warband's where Warband had the order ("Home is here",
		// "Everyone wait at camp"); `full` is the line the hub shows for the
		// slot under the cursor.
		struct Cmd
		{
			const char* id;
			const char* label;
			const char* full;
			bool        confirm;
		};

		constexpr Cmd kCmds[] = {
			// Orders
			{ "cr-follow", "Follow me", "Everyone follow me", false },
			{ "cr-wait", "Wait here", "Everyone wait here", false },
			{ "cr-regroup", "Regroup", "Everyone to me, now - stragglers too", false },
			{ "cr-relax", "Relax", "Ease off and wander nearby", false },
			{ "cr-attack", "Attack target", "Everyone attack what I aim at", false },
			{ "cr-chest", "Party chest", "Open the band's shared chest", false },
			{ "cr-nff-menu", "NFF menu", "Nether's own command menu", false },
			{ "cr-wwm-menu", "Walk With Me", "Formation, travel and rest", false },
			// Camp
			{ "cr-camp-make", "Make camp", "Pitch camp right here", false },
			{ "cr-camp-settle", "Settle in", "Everyone rest around the camp", false },
			{ "cr-camp-wait", "Wait at camp", "Everyone wait at camp", false },
			{ "cr-camp-break", "Break camp", "Strike camp - everyone with me", false },
			{ "cr-camp-chest", "Chest by the fire", "Set the band's chest down here", false },
			{ "cr-camp-return", "Back to camp", "Travel back to the camp", false },
			{ "cr-camp-wood", "Gather wood", "Harvest firewood for the fire", false },
			{ "cr-camp-craft", "Camp gear", "Craft a tent, bedroll or fire", false },
			// Homes
			{ "cr-home-here", "Home is here", "Make this everyone's home", true },
			{ "cr-home-go", "All go home", "Everyone go home and wait there", false },
			{ "cr-home-back", "All come back", "Everyone come back to me", false },
			// Battle
			{ "cr-fwm-attack", "Attack!", "Everyone goes all out for your target", false },
			{ "cr-fwm-tome", "To me!", "Everyone to your side - fight there", false },
			{ "cr-fwm-hold", "Hold back", "Everyone stays back, meets what comes", false },
			{ "cr-fwm-asyouwere", "As you were", "Everyone back to their own orders", false },
			{ "cr-battle-plan", "Battle plan", "Roles, focus and places in the fight", false },
		};

		const Cmd* Find(const std::string& id)
		{
			for (const auto& c : kCmds)
				if (id == c.id)
					return &c;
			return nullptr;
		}

		struct Page
		{
			const char* id;
			const char* name;
			const char* full;
			const char* slots[8];   // Warband's slot order: 0-3 left top->bottom, 4-7 right
		};

		constexpr Page kPages[] = {
			{ "orders", "Orders", "Your band, at a word",
				{ "cr-follow", "cr-wait", "cr-regroup", "cr-relax", "cr-attack", "cr-chest", "cr-nff-menu", "cr-wwm-menu" } },
			{ "camp", "Camp", "Make camp, rest, move on",
				{ "cr-camp-make", "cr-camp-settle", "cr-camp-wait", "cr-camp-break", "cr-camp-chest", "cr-camp-return", "cr-camp-wood", "cr-camp-craft" } },
			{ "homes", "Homes", "Where your people live",
				{ "cr-home-here", "cr-home-go", "cr-camp-wait", "cr-home-back", "cr-wait", nullptr, nullptr, nullptr } },
			{ "battle", "Battle", "Fight With Me's orders",
				{ "cr-fwm-attack", "cr-fwm-tome", "cr-fwm-hold", "cr-fwm-asyouwere", "cr-battle-plan", "cr-attack", nullptr, nullptr } },
		};

		// ---- what each command needs ----------------------------------------
		bool PluginLoaded(const char* name)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return false;
			return dh->LookupModByName(name) || dh->LookupLoadedLightModByName(name);
		}

		bool MhiyhLoaded() { return PluginLoaded("MHiYH.esl") || PluginLoaded("MHiYH.esp"); }
		bool CampfireLoaded() { return PluginLoaded("Campfire.esm"); }

		struct Band
		{
			int count = 0, waiting = 0, loaded = 0, busy = 0;
		};

		// Set by StateJson for the length of ONE draw: PartyRecall's Survey is a
		// full Follower Organizer state build, and a draw asks CanRun ~20 times.
		int g_bandCountForDraw = -1;

		Band BandNow()
		{
			Band b;
			if (g_bandCountForDraw >= 0) {
				b.count = g_bandCountForDraw;
				return b;
			}
			for (const auto& m : PartyRecall::Members()) {
				++b.count;
				b.waiting += m.waiting ? 1 : 0;
				b.loaded += m.loaded ? 1 : 0;
				b.busy += m.busy ? 1 : 0;
			}
			return b;
		}

		// ---- the camp ---------------------------------------------------------
		std::mutex g_campMutex;
		std::string g_campMark;   // a PlaceActions mark object as text; "" = no camp

		// ---- Fight With Me ----------------------------------------------------
		using GetInterfaceFn = FightWithMeAPI::IFightWithMe* (*)(std::uint32_t);

		FightWithMeAPI::IFightWithMe* Fwm()
		{
			const HMODULE module = GetModuleHandleW(L"FightWithMe.dll");
			if (!module)
				return nullptr;
			const auto get = reinterpret_cast<GetInterfaceFn>(GetProcAddress(module, "FightWithMe_GetInterface"));
			return get ? get(FightWithMeAPI::INTERFACE_VERSION) : nullptr;
		}

		constexpr const char* kRoleNames[] = { "Fighter", "Tank", "Healer", "Bruiser", "Archer", "Mage" };

		// DIK scancode -> the key's printed name ("Num 8"), from Windows itself.
		std::string DikName(std::uint32_t dik)
		{
			if (!dik || dik >= 256)
				return {};
			LONG lparam = static_cast<LONG>((dik & 0x7F) << 16);
			if (dik & 0x80)
				lparam |= 1 << 24;   // extended key (DIK_NUMPADENTER, arrows, …)
			wchar_t buf[64]{};
			const int n = GetKeyNameTextW(lparam, buf, 64);
			if (n <= 0)
				return "key " + std::to_string(dik);
			std::string out;
			for (int i = 0; i < n; ++i)
				out.push_back(buf[i] < 128 ? static_cast<char>(buf[i]) : '?');
			return out;
		}

		// FightWithMe.ini [Orders], as last read by RefreshFwmKeys() on a
		// worker (KeysSources::ReadSetting is file IO and must stay off the
		// main thread). Only for DRAWING the ring: the press itself re-reads
		// the file at fire time through ModKeys::Resolve.
		// 0 = unbound; -1 = file or setting not readable; -2 = not read yet.
		std::mutex                  g_fwmMutex;
		std::map<std::string, long> g_fwmKeys;
		bool                        g_fwmRead = false;

		long FwmIniKey(const std::string& setting)
		{
			std::lock_guard l(g_fwmMutex);
			if (!g_fwmRead)
				return -2;
			const auto it = g_fwmKeys.find(setting);
			return it == g_fwmKeys.end() ? -1 : it->second;
		}

		// ---- settings ---------------------------------------------------------
		constexpr float kDefSlow = 0.25f, kMinSlow = 0.05f, kMaxSlow = 1.0f;
		constexpr int   kDefSize = 100, kMinSize = 70, kMaxSize = 140;
		std::mutex      g_optMutex;
		Options         g_opt;
		bool            g_optLoaded = false;

		fs::path OptionsPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "command-ring.json";
		}

		Options Clamped(Options o)
		{
			if (!(o.slow >= kMinSlow))   // also catches NaN
				o.slow = kMinSlow;
			if (o.slow > kMaxSlow)
				o.slow = kMaxSlow;
			o.size = std::max(kMinSize, std::min(kMaxSize, o.size));
			return o;
		}

		void LoadOptionsLocked()
		{
			if (g_optLoaded)
				return;
			g_optLoaded = true;
			std::ifstream in(OptionsPath(), std::ios::binary);
			if (!in)
				return;
			const auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			Options o;
			if (j.contains("slow") && j["slow"].is_number())
				o.slow = j["slow"].get<float>();
			if (j.contains("size") && j["size"].is_number())
				o.size = static_cast<int>(j["size"].get<double>() + 0.5);
			g_opt = Clamped(o);
		}
	}

	// ======================================================================
	const std::vector<std::string>& PageIds()
	{
		static const std::vector<std::string> ids{ "orders", "camp", "homes", "battle" };
		return ids;
	}

	bool IsCommand(const std::string& id) { return Find(id) != nullptr; }

	bool NeedsConfirm(const std::string& id)
	{
		const Cmd* c = Find(id);
		return c && c->confirm;
	}

	bool FwmLoaded() { return GetModuleHandleW(L"FightWithMe.dll") != nullptr; }

	std::string FwmOrderKey(const std::string& id)
	{
		if (id == "cr-fwm-attack") return "iAttack";
		if (id == "cr-fwm-tome") return "iToMe";
		if (id == "cr-fwm-hold") return "iHoldBack";
		if (id == "cr-fwm-asyouwere") return "iAsYouWere";
		return {};
	}

	void RefreshFwmKeys()
	{
		std::map<std::string, long> keys;
		if (FwmLoaded())
			for (const char* k : { "iAttack", "iToMe", "iHoldBack", "iAsYouWere" }) {
				long raw = 0;
				if (KeysSources::ReadSetting("FightWithMe.ini", "Orders", k, raw, nullptr))
					keys[k] = raw;
			}
		std::lock_guard l(g_fwmMutex);
		g_fwmKeys = std::move(keys);
		g_fwmRead = true;
	}

	std::string FwmRole(std::uint32_t actorFormId)
	{
		auto* api = Fwm();
		if (!api)
			return {};
		const auto r = static_cast<int>(api->GetRole(actorFormId));
		return r >= 0 && r < 6 ? kRoleNames[r] : std::string();
	}

	// One reason per command, checked on open AND again at the press.
	bool CanRun(const std::string& id, std::string& why)
	{
		why.clear();
		auto needBand = [&]() {
			if (BandNow().count > 0)
				return true;
			why = "Nobody is following you";
			return false;
		};
		auto needNff = [&]() {
			if (NffControl::Available())
				return true;
			why = "Needs Nether's Follower Framework";
			return false;
		};
		auto needCamp = [&]() {
			if (CampUp())
				return true;
			why = "No camp yet - Make camp first";
			return false;
		};

		if (id == "cr-follow" || id == "cr-wait" || id == "cr-regroup" || id == "cr-home-back")
			return needNff() && needBand();
		if (id == "cr-relax" || id == "cr-camp-settle")
			return needNff() && needBand();
		if (id == "cr-attack")
			return true;   // Sic 'em needs no mod; it says so itself when nothing is aimed at
		if (id == "cr-chest" || id == "cr-camp-chest")
			return needNff();
		if (id == "cr-nff-menu")
			return CombatTools::NffMenuAvailable(why);
		if (id == "cr-wwm-menu")
			return CombatTools::WwmMenuAvailable(why);
		if (id == "cr-camp-make") {
			auto* pc = RE::PlayerCharacter::GetSingleton();
			if (pc && pc->GetParentCell())
				return true;
			why = "Load a game first";
			return false;
		}
		if (id == "cr-camp-wait")
			return needCamp() && needNff() && needBand();
		if (id == "cr-camp-break")
			return needCamp();
		if (id == "cr-camp-return") {
			if (!needCamp())
				return false;
			const float d = CampDistance();
			if (d >= 0.0f && d < 1500.0f) {
				why = "You are at the camp";
				return false;
			}
			return true;
		}
		if (id == "cr-camp-wood" || id == "cr-camp-craft") {
			if (CampfireLoaded())
				return true;
			why = "Needs Campfire";
			return false;
		}
		if (id == "cr-home-here" || id == "cr-home-go") {
			if (id == "cr-home-here" && !MhiyhLoaded()) {
				why = "Needs My Home is Your Home";
				return false;
			}
			return needNff() && needBand();
		}
		if (!FwmOrderKey(id).empty()) {
			if (!FwmLoaded()) {
				why = "Needs Fight With Me";
				return false;
			}
			const long raw = FwmIniKey(FwmOrderKey(id));
			if (raw == -2)
				return true;   // not read yet: the press reads the file itself and refuses in words
			if (raw < 0) {
				why = "FightWithMe.ini has no " + FwmOrderKey(id);
				return false;
			}
			if (raw == 0) {
				why = "No key for it in FightWithMe.ini [Orders]";
				return false;
			}
			return true;
		}
		if (id == "cr-battle-plan")
			return CombatTools::BattlePlanAvailable(why);
		why = "Unknown command";
		return false;
	}

	std::string StateJson(const std::vector<std::pair<std::string, std::string>>& deckKeys)
	{
		std::map<std::string, std::string> keys(deckKeys.begin(), deckKeys.end());
		const auto members = PartyRecall::Members();
		// One survey per draw (see g_bandCountForDraw); cleared on every exit.
		g_bandCountForDraw = static_cast<int>(members.size());
		struct ClearDraw
		{
			~ClearDraw() { g_bandCountForDraw = -1; }
		} clearDraw;
		const Options opt = GetOptions();

		json out{ { "ok", true }, { "slow", opt.slow }, { "size", opt.size } };

		// The band, and Fight With Me's read of it.
		json         names = json::array();
		int          waiting = 0, loaded = 0;
		std::map<std::string, int> roles;
		const bool   fwm = FwmLoaded();
		for (const auto& m : members) {
			waiting += m.waiting ? 1 : 0;
			loaded += m.loaded ? 1 : 0;
			auto* actor = RE::TESForm::LookupByID<RE::Actor>(m.formId);
			const char* n = actor ? actor->GetDisplayFullName() : nullptr;
			if (names.size() < 12)
				names.push_back(n && *n ? n : "?");
			if (fwm) {
				const auto r = FwmRole(m.formId);
				if (!r.empty())
					++roles[r];
			}
		}
		out["band"] = { { "count", members.size() }, { "waiting", waiting }, { "loaded", loaded }, { "names", names } };

		std::string roleLine;
		for (const char* r : kRoleNames) {
			const auto it = roles.find(r);
			if (it == roles.end())
				continue;
			if (!roleLine.empty())
				roleLine += " \xC2\xB7 ";   // middle dot, UTF-8
			roleLine += std::to_string(it->second) + " " + r + (it->second == 1 ? "" : "s");
		}
		out["fwm"] = { { "ok", fwm }, { "roles", roles }, { "line", roleLine } };

		// The camp.
		const bool  up = CampUp();
		const float dist = CampDistance();
		std::string campName;
		if (up) {
			const auto mark = json::parse(CampMark(), nullptr, false);
			if (mark.is_object())
				campName = mark.value("suggested", mark.value("cellName", std::string()));
		}
		out["camp"] = { { "up", up }, { "name", campName }, { "dist", dist }, { "here", up && dist >= 0.0f && dist < 1500.0f } };

		// The pages.
		json pages = json::array();
		for (const auto& p : kPages) {
			json slots = json::array();
			for (int s = 0; s < 8; ++s) {
				const char* id = p.slots[s];
				if (!id)
					continue;
				const Cmd* c = Find(id);
				if (!c)
					continue;
				std::string why;
				const bool  ok = CanRun(id, why);
				std::string label = c->label, full = c->full;
				if (std::strcmp(id, "cr-camp-make") == 0 && up) {
					label = "Move camp";
					full = "Move the camp to where I stand";
				}
				if (std::strcmp(id, "cr-home-here") == 0 && !members.empty())
					full = "Make this everyone's home (" + std::to_string(members.size()) +
					       (members.size() == 1 ? " follower)" : " followers)");
				if (std::strcmp(id, "cr-battle-plan") == 0 && !roleLine.empty())
					full = roleLine;
				// The key that runs it: the deck trigger on its seeded entry; for a
				// Fight With Me order with none, FWM's own key from its ini.
				std::string key;
				if (const auto it = keys.find(id); it != keys.end())
					key = it->second;
				if (key.empty() && !FwmOrderKey(id).empty() && ok) {
					const long raw = FwmIniKey(FwmOrderKey(id));
					if (raw > 0)
						key = DikName(static_cast<std::uint32_t>(raw));
				}
				slots.push_back({ { "slot", s }, { "id", id }, { "label", label }, { "full", full },
					{ "ok", ok }, { "why", why }, { "confirm", c->confirm }, { "key", key } });
			}
			pages.push_back({ { "id", p.id }, { "name", p.name }, { "full", p.full }, { "slots", slots } });
		}
		out["pages"] = pages;
		return Dump(out);
	}

	// ---- the camp ----------------------------------------------------------
	bool MakeCampHere(std::string& why)
	{
		auto mark = json::parse(PlaceActions::CurrentLocationJson(), nullptr, false);
		if (mark.is_discarded() || !mark.is_object() || !mark.value("ok", false)) {
			why = mark.is_object() ? mark.value("msg", std::string("You aren't in a loaded cell yet")) : "No location";
			return false;
		}
		mark["name"] = "Camp";
		{
			std::lock_guard l(g_campMutex);
			g_campMark = Dump(mark);
		}
		logger::info("command-ring: camp made at {} ({:.0f}, {:.0f}, {:.0f})",   // marker: command-ring-camp-made
			mark.value("suggested", std::string()), mark.value("x", 0.0), mark.value("y", 0.0), mark.value("z", 0.0));
		return true;
	}

	bool CampUp()
	{
		std::lock_guard l(g_campMutex);
		return !g_campMark.empty();
	}

	void BreakCamp()
	{
		std::lock_guard l(g_campMutex);
		g_campMark.clear();
		logger::info("command-ring: camp broken");   // marker: command-ring-camp-broken
	}

	std::string CampMark()
	{
		std::lock_guard l(g_campMutex);
		return g_campMark;
	}

	std::string CampMarkAround(float angleDeg, float radius)
	{
		auto mark = json::parse(CampMark(), nullptr, false);
		if (mark.is_discarded() || !mark.is_object())
			return {};
		const double a = angleDeg * 3.14159265358979 / 180.0;
		mark["x"] = mark.value("x", 0.0) + radius * std::sin(a);
		mark["y"] = mark.value("y", 0.0) + radius * std::cos(a);
		// Face the middle of the camp.
		double face = a + 3.14159265358979;
		while (face > 2 * 3.14159265358979)
			face -= 2 * 3.14159265358979;
		mark["angleZ"] = face;
		return Dump(mark);
	}

	float CampDistance()
	{
		const auto mark = json::parse(CampMark(), nullptr, false);
		auto* pc = RE::PlayerCharacter::GetSingleton();
		if (mark.is_discarded() || !mark.is_object() || !pc || !pc->GetParentCell())
			return -1.0f;
		const bool interior = mark.value("interior", false);
		if (interior) {
			const auto* cell = pc->GetParentCell();
			const auto  edid = mark.value("cellEdid", std::string());
			const bool  same = cell->GetFormID() == mark.value("cellId", 0u) ||
			                   (!edid.empty() && cell->GetFormEditorID() && _stricmp(cell->GetFormEditorID(), edid.c_str()) == 0);
			if (!same)
				return -1.0f;
		} else {
			auto* ws = pc->GetWorldspace();
			if (!ws || ws->GetFormID() != mark.value("worldspaceId", 0u))
				return -1.0f;
		}
		const auto  p = pc->GetPosition();
		const float dx = p.x - mark.value("x", 0.0f), dy = p.y - mark.value("y", 0.0f), dz = p.z - mark.value("z", 0.0f);
		return std::sqrt(dx * dx + dy * dy + dz * dz);
	}

	void SaveCosave(SKSE::SerializationInterface* s)
	{
		const auto mark = CampMark();
		if (!s || mark.empty())
			return;
		if (!s->OpenRecord(kRecord, kRecordVersion)) {
			logger::warn("command-ring: cosave OpenRecord failed");
			return;
		}
		const auto len = static_cast<std::uint32_t>(mark.size());
		s->WriteRecordData(&len, sizeof(len));
		s->WriteRecordData(mark.data(), len);
	}

	bool LoadCosave(SKSE::SerializationInterface* s, std::uint32_t type, std::uint32_t version, std::uint32_t)
	{
		if (type != kRecord)
			return false;
		RevertCosave();
		if (version != kRecordVersion)
			return true;
		std::uint32_t len = 0;
		if (s->ReadRecordData(&len, sizeof(len)) != sizeof(len) || len == 0 || len > 64 * 1024)
			return true;
		std::string text(len, '\0');
		if (s->ReadRecordData(text.data(), len) != len)
			return true;
		auto mark = json::parse(text, nullptr, false);
		if (mark.is_discarded() || !mark.is_object())
			return true;
		// A runtime FormID dies when the load order is re-indexed: re-resolve
		// the cell and worldspace ids; PlaceActions' ResolveCell still prefers
		// the saved EditorID when the two disagree.
		for (const char* k : { "cellId", "worldspaceId" }) {
			const auto id = mark.value(k, 0u);
			RE::FormID resolved = 0;
			if (id && s->ResolveFormID(id, resolved))
				mark[k] = resolved;
		}
		{
			std::lock_guard l(g_campMutex);
			g_campMark = Dump(mark);
		}
		logger::info("command-ring: camp restored from the save ({})", mark.value("suggested", std::string()));
		return true;
	}

	void RevertCosave()
	{
		std::lock_guard l(g_campMutex);
		g_campMark.clear();
	}

	// ---- settings ----------------------------------------------------------
	Options GetOptions()
	{
		std::lock_guard l(g_optMutex);
		LoadOptionsLocked();
		return g_opt;
	}

	std::string OptionsJson()
	{
		const Options o = GetOptions();
		return Dump({ { "slow", o.slow }, { "size", o.size }, { "defSlow", kDefSlow }, { "defSize", kDefSize },
			{ "minSlow", kMinSlow }, { "maxSlow", kMaxSlow }, { "minSize", kMinSize }, { "maxSize", kMaxSize } });
	}

	std::string SetOptions(const std::string& requestJson)
	{
		const auto j = json::parse(requestJson, nullptr, false);
		if (!j.is_discarded() && j.is_object()) {
			std::lock_guard l(g_optMutex);
			LoadOptionsLocked();
			Options o = j.value("reset", false) ? Options{} : g_opt;
			if (j.contains("slow") && j["slow"].is_number())
				o.slow = j["slow"].get<float>();
			if (j.contains("size") && j["size"].is_number())
				o.size = static_cast<int>(j["size"].get<double>() + 0.5);
			g_opt = Clamped(o);
			std::error_code ec;
			fs::create_directories(OptionsPath().parent_path(), ec);
			std::ofstream out(OptionsPath(), std::ios::binary | std::ios::trunc);
			if (out)
				out << json{ { "slow", g_opt.slow }, { "size", g_opt.size } }.dump(2);
			else
				logger::warn("command-ring: could not write command-ring.json");
			logger::info("command-ring: options saved (time x{}, size {}%)", g_opt.slow, g_opt.size);
		}
		return OptionsJson();
	}
}
